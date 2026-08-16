# tmux-integrated — Architecture

This document describes how `tmux-integrated` is wired together so that future
contributors (and future-us) can navigate the codebase quickly. It is meant to
be read alongside the source files; the goal is to explain the *why* and the
control flow, not to duplicate code-level documentation.

## Big picture

`tmux-integrated` is a VS Code extension that gives every VS Code terminal tab
a persistent backing store via tmux **control mode** (`tmux -CC`).

```
                +-----------------------+
                |  VS Code Terminal Tab |  (xterm.js renderer)
                +----------+------------+
                           |
                  vscode.Pseudoterminal
                           |
                +----------v-------------+
                |     TmuxTerminal       |   src/tmuxTerminalProvider.ts
                |  (one per VS Code tab) |
                +----------+-------------+
                           |
                           |  emits/listens through:
                           v
                +------------------------+
                |   TmuxControlClient    |   src/tmuxControlClient.ts
                | (one per workspace)    |
                +----------+-------------+
                           |
                           |  ingest()/sendCommand()/events
                           v
                +------------------------+
                |      TmuxGateway       |   src/tmuxGateway.ts
                |  protocol parser/queue |
                +----------+-------------+
                           |
                       node-pty
                           |
                           v
                +------------------------+
                |   tmux server (-CC)    |
                | one session per WS dir |
                +------------------------+
```

* **One session per workspace folder.** Session name defaults to the basename
  of the workspace folder (sanitised) and may be overridden via
  `tmux-integrated.sessionName`.
* **One tmux window per VS Code terminal tab** (1:1 mapping, like iTerm2).
* **One tmux pane per window.** Splits are not supported — VS Code's terminal
  API has no split-pane abstraction.

## Source layout

| File | Role |
|---|---|
| `src/extension.ts` | Activation, lifecycle, terminal-profile + command registration, autoConnect, status bar, env-var forwarding, start-directory resolution (incl. the multi-root folder pick). |
| `src/tmuxTerminalProvider.ts` | The `vscode.Pseudoterminal` (`TmuxTerminal`). Forwards user input to a tmux pane, renders pane output back into xterm.js, and owns the tab name. |
| `src/windowTitle.ts` | Pure helpers that decide the VS Code tab title from tmux's `#{window_name}` and `#{automatic-rename}`. |
| `src/tmuxControlClient.ts` | High-level typed tmux operations (`newWindow`, `listWindows`, `resizeWindowForClient`, …), node-pty resolution (see *Loading node-pty*) and PTY lifecycle, version gating. Wraps `TmuxGateway`. |
| `src/tmuxGateway.ts` | Low-level control-mode protocol parser. Frames lines, handles `%begin/%end/%error`, manages the pending-command queue, defers writes until `%session-changed`, decodes `%output`/`%extended-output` payloads. |

## Activation flow

```
activate()
  |-- create OutputChannel + StatusBar
  |-- registerTerminalRenameSync()    // wire onDidOpen/Close/ChangeActive
  |-- registerTerminalProfile()       // contributes "tmux-integrated" profile
  |-- registerCommands()              // newTerminal / attachWindow / renameTerminal
  |-- if autoConnect && session exists:
        autoConnectExistingSession()  // fire-and-forget
```

`autoConnectExistingSession()` calls `ensureClientConnected()` (which may do a
full `tmux -CC` spawn + protocol handshake), then drains
`windowsToAdopt` and creates a VS Code terminal tab for every existing tmux
window so that prior work re-appears.

## `ensureClientConnected()` — the connection state machine

Every code path that needs a live tmux client funnels through here:

* `provideTerminalProfile` (when VS Code asks for a `tmux-integrated` terminal)
* `tmux-integrated.newTerminal` command
* `tmux-integrated.attachWindow` command
* `autoConnectExistingSession` on activation

Behaviour:

1. If `client.isConnected()` already returns true, perform a 5-second
   `display-message "__ping__"` health check. If it answers correctly, reuse
   the connection; otherwise tear it down and reconnect.
2. Resolve `tmux` binary, exec `tmux -V`, gate features by version.
3. `new TmuxControlClient(...)` and `client.connect({ startDirectory })`.
   Internally this spawns `tmux -CC new-session -A -s <name>` in a node-pty
   PTY (see *Loading node-pty* below), runs the protocol handshake, and
   resolves once the readiness probe round-trips.
4. Subscribe to `session-window-changed` and `tmux-exit` events.
5. Set `default-terminal xterm-256color` and forward `VSCODE_*` env vars via
   `set-environment -t <session>`.
6. Populate either:
   * `bootstrapWindow` — when the session was *just* created and tmux opened a
     single initial window, OR
   * `windowsToAdopt[]` — when the session already existed; one entry per
     pre-existing tmux window.

## Loading node-pty

`tmux -CC` must run inside a real PTY. Rather than shipping a native
dependency compiled per platform *and* per Electron ABI, the extension
borrows the `node-pty` build that VS Code itself ships — by construction it
matches the extension host's ABI. The catch is that *where* that build lives
has changed several times across VS Code releases, and VS Code 1.129
(re-)introduced ASAR packaging so the package is no longer loadable from a
single directory at all. `requireNodePty()` in `tmuxControlClient.ts`
resolves this in two stages:

1. **Direct require (zero-copy).** Probe `<appRoot>/<root>/<pkg>` for every
   combination of root × package name:
   * roots: `node_modules` (remote server, Cursor, desktop ≤ 1.128),
     `node_modules.asar` (desktop ≥ 1.129 and the older ASAR era: the JS
     lives inside the archive — the extension host is an Electron process,
     so requiring from inside the archive works and Electron transparently
     redirects the native `pty.node` load to `node_modules.asar.unpacked`),
     and `node_modules.asar.unpacked` (builds that unpacked the whole
     module).
   * packages: `node-pty` and `@vscode/node-pty`.
2. **Copy-shim fallback** (`materializeNodePtyShim()`), for layouts that
   ship *no* loadable JavaScript (none exist today; this guards against the
   direction hinted at by VS Code's Copilot extension, which uses the same
   technique). The extension bundles node-pty's JavaScript as a pinned
   dependency (only `package.json` + `lib/**` are packaged into the VSIX —
   see `.vscodeignore`), pairs it with the native files found under the
   installation (`build/Release`, `build/Debug`, or
   `prebuilds/<platform>-<arch>`), and materializes the combined package in
   the extension's **global storage** — not the extension install directory,
   which may be read-only and is replaced on every update. If the copy fails
   but a usable shim is already materialized (typically a second VS Code
   window's extension host holding the previously copied `pty.node` open on
   Windows, so the overwrite raises `EPERM`/`EBUSY`), the existing shim is
   reused.

If both stages fail, the thrown error lists every candidate with its
individual failure reason ("not found" vs. an actual load error such as an
ABI mismatch) so the output channel pinpoints the problem — this is how
issue #33 (VS Code 1.129) was diagnosed.

## Where new terminal tabs come from

There are three doorways into "create a VS Code terminal tab":

1. **Profile provider** (`provideTerminalProfile`). Called by VS Code when a
   user opens a terminal that uses the `tmux-integrated` profile (including
   the case where `terminal.integrated.defaultProfile.<os>` selects it). The
   provider prefers, in order:
   * `bootstrapWindow` (just-created session's first window)
   * the next entry from `windowsToAdopt`
   * `client.newWindow(...)` — i.e. *create a fresh tmux window*.
2. **`tmux-integrated.newTerminal` command**. Always calls `newWindow`.
3. **`tmux-integrated.attachWindow` command**. Pops a quick-pick over
   `listWindows()` minus already-attached windows, then creates a VS Code
   terminal that adopts the chosen window.
4. **`autoConnectExistingSession()`**. After connect, iterates the
   `windowsToAdopt` snapshot and creates one VS Code terminal per remaining
   window via `vscode.window.createTerminal(buildTerminalOptions(w))`.

**tmux window order is the tab order.** `list-windows` returns windows by
index, tabs are created in that same sequence, so a reload reproduces the
layout. To reorder deliberately, reorder in tmux (`swap-window`, `move-window`)
and the tabs follow on the next reload.

Keeping that true requires one thing of window creation: `newWindow()` creates
each window *after* the highest existing index. Left to itself tmux reuses the
lowest free index while VS Code appends the new tab on the right, so closing one
window and opening another silently reordered the tabs on the next reload.

There is deliberately no VS Code-side order store. VS Code exposes no API for
terminal tab position — no index on `Terminal`, no reorder event, and
`window.terminals` is creation-ordered rather than visually ordered — so an
extension cannot observe a tab the user drags, and therefore cannot restore one.
Persisting a VS Code-side order would only ever record creation order under a
second source of truth that tmux could contradict.

In a **multi-root workspace**, paths that create a *genuinely new* tmux
window (`provideTerminalProfile` falling through to `newWindow`, and the
`newTerminal` command) first show a quick-pick over the workspace folders
(`pickStartDirectory`) to decide the terminal's start directory — VS Code
does not expose its own folder selection to custom PTY profile providers.
When the connection itself is about to create a brand-new session, the pick
happens *before* connecting so the session starts in the chosen folder.
Adoption and bootstrap paths skip the pick: their windows already have a
working directory.

Whichever path runs, `buildTerminalOptions(existingWindow?, startDirectory?)`
constructs a fresh `TmuxTerminal` and returns it as a
`vscode.ExtensionTerminalOptions`.
The pty is also pushed onto `pendingTerminalPtys` so that
`registerTerminalRenameSync` can later associate the resulting
`vscode.Terminal` with its `TmuxTerminal` instance (used to detect built-in
"Rename…" actions and to align the tmux active window with the VS Code tab
focus).

## `TmuxTerminal.open()` — what happens when a tab is created

```
open(initialDimensions)
  |-- decide targetWindow:
  |     * existingWindow if provided   (adoption path)
  |     * else: client.newWindow(...)  (creation path)
  |-- record windowId, paneId, tabWindowIndex
  |-- subscribe: 'output' / 'window-close' / 'window-renamed' / 'tmux-exit'
  |-- emit initial tab name from #{window_name} (pickTerminalTabTitle)
  |-- resizeWindowForClient(initialDimensions)
  |-- if adoption: capture-pane snapshot + restore cursor position
```

`handleInput()` is implemented via `send-keys` using the same hybrid strategy
iTerm2 uses: hex-encode unknown ESC sequences atomically (so e.g. xterm.js's
auto cursor-position reply isn't fragmented on the way to the tmux pane),
named keys for known sequences, `send-keys -lt` for safe literal runs, and
`send-keys -l` for non-ASCII text.

`setDimensions()` debounces resize events (100 ms) and forwards via
`refresh-client -C <cols>,<rows>` (no per-pane resize — see
`resizeWindowForClient` for the rationale).

`close()` either lets tmux own the lifecycle (when it was tmux that closed
the window) or, after a 300 ms grace period, sends `kill-window` — but only
if the extension isn't deactivating. On VS Code shutdown the windows are
explicitly preserved so they can be re-adopted next launch.

## Tab title model (`windowTitle.ts`)

tmux owns the window name and the tab simply shows it:

```text
name non-empty → label = name
name empty     → label = "tmux:<window_index>"   (VS Code side only)
```

While `#{automatic-rename}` is on that name tracks the foreground process
(`zsh`, `nvim`, `git`, …) and `%window-renamed` keeps the tab in step. Once
the user renames a window — from VS Code, or with `rename-window` inside tmux —
tmux turns automatic-rename off and the chosen name sticks.

`open()` never renames the window. It used to disable automatic-rename and
write its own `tmux:<window_index>` placeholder back with `rename-window`,
which persisted an index-derived string as the window's permanent name; that
name then went stale as soon as tmux indices shifted.

The bidirectional rename sync works as follows:

* **VS Code → tmux**: a built-in "Rename…" mutates `terminal.name`, and VS Code
  raises no event for it — `@types/vscode` offers only
  `onDidChangeTerminalState` and `onDidChangeTerminalShellIntegration`. So
  `syncTerminalName()` in `extension.ts` spots it by watching `terminal.name`.
  It runs from the keystroke probe, the active-terminal, close and window-focus
  events, and `deactivate()` — the keystroke probe alone lost any rename that
  was not followed by typing.

  **The comparison is against the label this extension last saw on the tab
  (`lastKnownTabName`), never against the name the pty emitted.** VS Code does
  assign `Terminal.name` from a pty title change, but only after a round trip:
  `onDidChangeName` becomes a `title` property change, and
  `$acceptTerminalTitleChange` assigns it back on the extension-host side.
  Comparing against the emitted name reports a rename on every tab whose
  creation label differs from the window name, and writes that label over the
  tmux window's real name — which is how windows ended up called `tmux:<index>`.

  A title this extension emits is parked in `pendingEmittedNames` until the tab
  reports it back, and matched there when it arrives. It cannot simply be
  recorded as the tab's label at the moment it is sent: until the round trip
  completes `terminal.name` still holds the *previous* label, so a sync landing
  inside that gap would push the stale name back over the one tmux just set —
  with `automatic-rename off` attached, switching off exactly the tracking the
  tab is meant to follow. The three outcomes are therefore:

  * `terminal.name` equals the last known label — nothing changed, and this is
    also what the in-flight gap looks like.
  * `terminal.name` matches a parked title — the workbench applied something we
    emitted; drop it and anything older it coalesced past.
  * `terminal.name` is neither — the label became something this extension never
    emitted, which is a built-in "Rename…" and the only case that reaches tmux.

  That last case still fires while a title is in flight, so a rename made during
  the gap is not swallowed.

  One further guard backs it up: a name matching `^tmux(:\d+)?$` is never
  written to tmux, since that string is only ever this extension's own
  placeholder.

  `buildTerminalOptions` also names the tab after the tmux window rather than
  after its index, so an adopted tab reads `deploy watch` instead of `tmux:2`
  and there is usually no mismatch to resolve at all.

**A failed attach never kills the window.** `open()` records `windowId` before
it seeds scrollback, so a `capture-pane` or cursor-lookup failure leaves a fully
initialised id behind and closes the tab. For a window this tab *created* that
is correct cleanup — it holds nothing. For an adopted window it is destruction:
the window pre-existed the tab and is still running the user's work, so
`adoptionFailed` suppresses the `kill-window` that `close()` would otherwise
send.

**Terminal identity is never taken from the title.** Because titles follow the
tmux window name, a tmux-backed tab can be called anything. The stray-shell
sweep asks `isExtensionOwnedTerminal()` — does anything own a `Pseudoterminal`
for this tab — and focus and adoption-grace ask `isTmuxTerminal()`. Deciding
from the title would classify a tab called `zsh` as a stray shell and dispose
it, and `close()` answers a dispose with `kill-window`.

  This is also why `open()` may not rename the window. The old write-back was
  load bearing: renaming the tmux window to the tab's placeholder kept both
  sides in agreement, so a comparison against the emitted name could not fire.
  Removing it without fixing the comparison turns every adopted tab into a
  `rename-window -t <id> tmux:<index>` the moment anything triggers a sync.

* **tmux → VS Code**: `%window-renamed` notifications are processed by
  `windowRenamedListener` and emitted to VS Code via `onDidChangeName`.
* **Explicit command**: `tmux-integrated.renameTerminal` calls
  `pty.renameWindow(newName)` which atomically updates both sides.

`emitNameIfChanged` deduplicates emissions so the bidirectional loop doesn't
echo forever.

## Protocol layer (`tmuxGateway.ts`)

The gateway is byte-oriented (the PTY is opened with `encoding: null`) so
that:

* `%output` payloads can be octal-decoded as bytes and passed through a
  per-pane `StringDecoder` to preserve UTF-8 boundaries that span chunks.
* Bare `\r` injected by the PTY line driver is dropped, but **all other**
  control bytes (notably ESC = 0x1b) are preserved so that terminal protocol
  responses such as cursor-position reports are not truncated (see
  `decodeOutput` for the long-form rationale, and issue #26).

Write-queue invariants:

* `sendCommand(cmd)` returns a `Promise<string[]>` with the response lines.
* `sendCommandList(cmds)` joins commands with ` ; ` so they hit tmux as a
  single PTY write but produce one `%begin/%end` per command. The pending
  queue holds one entry per command and they are matched in order.
* All writes are buffered until `%session-changed` is received (or a
  `setImmediate` fallback fires after the first `%end` for tmux < 2.6).
* `CommandFlags.TolerateErrors` resolves with `[]` instead of rejecting on
  `%error` — used for fire-and-forget options like `set-option`.

## Connection lifecycle / reconnection

* Disconnect on extension dispose: `client.disconnect()` writes `detach\r`,
  kills the PTY. The tmux server keeps running and the session keeps its
  windows.
* `deactivate()` sets `disposing = true` so that `TmuxTerminal.close()` does
  not kill its window during shutdown.
* On the *next* activation, if `tmuxSessionExists()` returns true,
  `autoConnectExistingSession()` re-attaches to the same session and
  re-creates VS Code tabs from `listWindows()` output.
* For Remote-SSH/WSL: the extension declares `extensionKind: "workspace"` so
  tmux always runs on the same host as the user's processes.

## Latency hazards (and how we guard against them)

Two reported failure modes were traced to races that high-latency Remote-SSH
sessions amplify. Both are documented here so we don't regress them.

### "A fresh tmux window appears every time VS Code reconnects"

Three things compound:

1. **Concurrent `ensureClientConnected()` calls overwrote the in-flight
   client.** `autoConnectExistingSession()` is fire-and-forget from
   `activate()`. While `connect()` is mid-handshake, `client.isConnected()`
   returns `false` (the `_connected` flag is only set on `_ready`). Any
   second caller — typically `provideTerminalProfile` triggered by VS Code
   restoring a tab — would fall through and execute
   `client = new TmuxControlClient(...)`, orphaning the original PTY.
   *Mitigation:* `ensureClientConnected()` now memoises an in-flight promise
   so all callers await the same attempt.
2. **`windowsToAdopt` was a global queue that two paths raced to drain.**
   `autoConnect` snapshotted-and-cleared the queue, while
   `adoptNextWindow()` `shift()`-ed one and then cleared the rest. Whoever
   ran first won; the loser saw an empty queue and fell through to
   `client.newWindow(...)` — a fresh tmux window. *Mitigation:*
   `adoptNextWindow()` now only shifts a single entry and never clears the
   tail. `autoConnectExistingSession()` waits a short grace period after
   connect so that any `provideTerminalProfile` calls VS Code makes during
   restore get first dibs; only the leftover windows are then adopted by
   autoConnect.
3. **`adoptNextWindow()` cleared the queue after the first shift.** Even
   without autoConnect in the picture, if VS Code restored N profile-based
   tabs concurrently it would call `provideTerminalProfile` N times in
   quick succession; only the first found something to adopt. *Mitigation:*
   covered by the "shift one, never clear the tail" change above.

### "Tabs get renamed to 'zsh' or 'bash' on reconnect"

For a window the user never named this is now the intended behaviour: tmux's
automatic-rename owns the name and the tab follows it (see *Tab title model*).

The bug underneath was narrower. `TmuxTerminal.open()` registers
`windowRenamedListener` early — correct, we mustn't drop events — so a
`%window-renamed` arriving while `open()` was still settling could be applied
and then overwritten by the older name `open()` started with. That gap is
sub-millisecond locally but seconds wide over a laggy SSH tunnel.

*Mitigations:*

* An `initialNameCommitted` guard suppresses the listener until `open()`
  has settled the title. After commit the listener works normally, which is
  what keeps the tab in step with both automatic-rename and user renames.
* `name` and `automaticRename` are now propagated all the way from
  `listWindows()` into `existingWindow`, so on reconnect we don't need a
  fresh round-trip just to find out what the window is called.

## Things that are intentionally absent

* **Splits.** Mapping `split-window` onto `vscode.Pseudoterminal` is not
  workable; we accept the 1:1 limitation.
* **Per-window environment via `new-window -e`.** Disabled for tmux 2.x
  compatibility — environment is propagated through `set-environment -t`.
* **Reconciliation / capture-pane polling.** Removed in Phase 1 — we trust
  xterm.js to stay in sync with `%output` and only `capture-pane` once on
  adoption to populate scrollback.
* **Pause-mode / extended-output latency tracking.** Listed in
  `doc/plan-alignWithIterm2TmuxIntegration.prompt.md` as future work.
