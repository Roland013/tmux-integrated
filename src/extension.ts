/**
 * Extension entry point for tmux-integrated.
 *
 * On activation the extension:
 *   1. Verifies that tmux ≥ 2.0 is installed.
 *   2. Connects to a per-workspace tmux session using control mode (-CC).
 *   3. Updates the session environment with the current VS Code IPC variables
 *      so that `code <file>` works in new tmux windows.
 *   4. Registers a "tmux" terminal profile and two commands.
 *
 * Each VS Code terminal tab maps 1:1 to a tmux window (like iTerm2's tmux
 * integration).  Closing a tab kills the corresponding window.  When VS Code
 * exits, the session persists so windows can be re-adopted on next launch.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { execFileSync } from 'child_process';

import { TmuxControlClient, CommandFlags } from './tmuxControlClient';
import { TmuxTerminal } from './tmuxTerminalProvider';
import { pickTerminalTabTitle } from './windowTitle';

interface AttachWindowItem extends vscode.QuickPickItem {
    windowId: string;
    paneId: string;
    windowIndex: number;
    name: string;
    automaticRename: boolean;
}

let client: TmuxControlClient | null = null;
let statusBar: vscode.StatusBarItem | null = null;
let outputChannel: vscode.OutputChannel | null = null;
let tmuxVersion: string | null = null;
let currentSessionName = 'vscode';
let tmuxBinaryPath: string | null = null;
let extensionRootPath = process.cwd();
let globalStoragePath: string | undefined;
let defaultStartDirectory = process.cwd();
interface AdoptableWindow {
    windowId: string;
    paneId: string;
    windowIndex: number;
    name?: string;
    automaticRename?: boolean;
}
let bootstrapWindow: AdoptableWindow | null = null;
let windowsToAdopt: AdoptableWindow[] = [];
let disposing = false;
/**
 * In-flight ensureClientConnected promise.
 *
 * Multiple call-sites (autoConnect on activation, provideTerminalProfile on
 * VS Code restoring tabs, the user opening a terminal) can race to connect
 * during a high-latency reattach. Without serialisation a second caller
 * would see _connected=false (the handshake has not finished) and execute
 * `client = new TmuxControlClient(...)`, orphaning the in-flight PTY and
 * spawning a duplicate tmux process. Memoising the promise makes every
 * concurrent caller wait for the same attempt.
 */
let inFlightConnect: Promise<boolean> | null = null;
const attachedWindowIds = new Set<string>();
const terminalPtyByTerminal = new Map<vscode.Terminal, TmuxTerminal>();
const pendingTerminalPtys: TmuxTerminal[] = [];
let activeTmuxWindowId: string | null = null;
let pendingUserTerminalFocus: boolean = false;


/**
 * The tab label this extension last saw, per terminal.
 *
 * VS Code updates `Terminal.name` from `onDidChangeName` only after a renderer
 * round trip, so this records the last label observed on the terminal while
 * emitted titles are tracked separately. See syncTerminalName.
 */
const lastKnownTabName = new WeakMap<vscode.Terminal, string>();

/** Per-terminal subscription recording titles this extension emits. */
const emittedNameSubscriptions = new Map<vscode.Terminal, vscode.Disposable>();

/**
 * Titles emitted for a terminal that the tab has not reported back yet.
 *
 * A title we emit reaches `Terminal.name` only after a round trip through the
 * renderer, so it cannot be recorded as the tab's label at the moment we send
 * it: until the trip completes `terminal.name` still holds the *previous*
 * label, and treating that as a rename pushes the stale name back to tmux with
 * `automatic-rename off`. Instead the title is parked here and matched when it
 * arrives, so a tab label that is neither the last known one nor a title we
 * sent is what identifies a rename the user made.
 */
const pendingEmittedNames = new WeakMap<vscode.Terminal, string[]>();

/** Cap on parked titles, so a busy terminal cannot grow the list without end. */
const MAX_PENDING_EMITTED_NAMES = 32;

// ---------------------------------------------------------------------------
// Activation / deactivation
// ---------------------------------------------------------------------------

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    outputChannel = vscode.window.createOutputChannel('tmux-integrated');
    context.subscriptions.push(outputChannel);

    extensionRootPath = context.extensionPath;
    globalStoragePath = context.globalStorageUri.fsPath;
    defaultStartDirectory = resolveStartDirectory(context.extensionPath);
    currentSessionName = resolveSessionName();

    log(`Activating: extensionPath=${extensionRootPath}, appRoot=${vscode.env.appRoot}, startDir=${defaultStartDirectory}`);

    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.command = 'tmux-integrated.attachWindow';
    statusBar.show();
    context.subscriptions.push(statusBar);
    setStatus('$(terminal) tmux-integrated: idle', 'Connects when you open or attach a tmux terminal');

    registerTerminalRenameSync(context);
    registerTerminalProfile(context);
    registerCommands(context);

    // --- Clean up when the extension host shuts down ----------------------
    // Note: we do NOT disconnect from tmux — we want sessions to outlive VS Code.
    context.subscriptions.push({
        dispose: () => {
            disposing = true;
            terminalPtyByTerminal.clear();
            pendingTerminalPtys.length = 0;
            activeTmuxWindowId = null;
            inFlightConnect = null;
            client?.disconnect();
            client = null;
        },
    });

    // The workbench can spawn an OS-default shell terminal (`/bin/zsh -il`
    // on macOS, etc.) before any extension is activated, even when
    // `terminal.integrated.defaultProfile.<os>` resolves to a
    // contributed profile like `tmux-integrated`. The window between
    // workbench-launch and our `registerTerminalProfileProvider` call
    // is wider on Cursor than on stock VS Code but exists on both —
    // see upstream microsoft/vscode#123188 / #263504. There is no
    // activation event that fires *before* the workbench starts
    // populating the terminal panel, so the only remedy from inside
    // an extension is to detect and dispose the stray.
    //
    // Gated on:
    //   - `tmux-integrated.closeStrayShellsOnActivation` (default true)
    //   - `terminal.integrated.defaultProfile.<os>` === `tmux-integrated`
    //     (so users who deliberately mix profiles are never affected)
    //
    // A stray is a terminal the workbench spawned from a shell profile, so
    // the test is whether anything owns a Pseudoterminal for it — never what
    // the tab is called. Titles follow the tmux window name, so a tab reading
    // "zsh" or "deploy watch" is routine; treating those as strays would
    // dispose them, and TmuxTerminal.close() answers that with kill-window.
    const stray = vscode.window.terminals.filter((t) => !isExtensionOwnedTerminal(t));
    if (stray.length > 0) {
        const cfgRoot = vscode.workspace.getConfiguration('tmux-integrated');
        const closeStray = cfgRoot.get<boolean>('closeStrayShellsOnActivation', true);
        const names = stray.map((t) => t.name).join(', ');
        if (closeStray && isTmuxIntegratedDefaultProfile()) {
            log(`Disposing ${stray.length} stray non-tmux terminal(s) at activation: [${names}] ` +
                `(defaultProfile.<os>=tmux-integrated, closeStrayShellsOnActivation=true). ` +
                `See README "Stray default-shell tab on launch" for context.`);
            for (const t of stray) {
                try { t.dispose(); } catch (err) { log(`stray dispose warning: ${err}`); }
            }
        } else {
            log(`Non-tmux terminals already present at activation: [${names}]. ` +
                `Auto-close skipped (closeStrayShellsOnActivation=${closeStray}, ` +
                `defaultProfile.<os>=${currentPlatformDefaultProfile() ?? '<unset>'}). ` +
                `See README "Stray default-shell tab on launch" for context.`);
        }
    }

    // --- Auto-connect to existing tmux session on workspace open ----------
    //
    // Defer the synchronous tmux probe (execFileSync of `tmux -V` and
    // `has-session`) so that eager activation doesn't briefly block the
    // workbench during startup. Whether this runs before or after panel
    // restore doesn't matter for correctness — autoConnectExistingSession
    // already yields a grace period to provideTerminalProfile (see
    // AUTO_CONNECT_GRACE_MS) and adoptNextWindow is race-safe.
    const cfg = vscode.workspace.getConfiguration('tmux-integrated');
    if (cfg.get<boolean>('autoConnect', true)) {
        setImmediate(() => {
            const sessionName = resolveSessionName();
            const tmuxPath = resolveTmuxBinaryPathSafe();
            if (tmuxPath && tmuxSessionExists(tmuxPath, sessionName)) {
                autoConnectExistingSession();
            }
        });
    }
}

export async function deactivate(): Promise<void> {
    // A window reload is exactly when an unsynced built-in rename would be
    // lost, so push pending names to tmux before the control client closes.
    await flushRenames();
    disposing = true;
    terminalPtyByTerminal.clear();
    pendingTerminalPtys.length = 0;
    activeTmuxWindowId = null;
    inFlightConnect = null;
    client?.disconnect();
    client = null;
}

function registerTerminalRenameSync(context: vscode.ExtensionContext): void {
    const trackTerminal = (terminal: vscode.Terminal): TmuxTerminal | null => {
        let pty = terminalPtyByTerminal.get(terminal) ?? getTmuxPtyFromTerminal(terminal);
        if (!pty && isExtensionOwnedTerminal(terminal)) {
            // creationOptions did not carry the pty through; fall back to the
            // one we queued when this terminal's options were built.
            pty = takeNextPendingTerminalPty();
        }
        if (!pty) {
            return null;
        }

        terminalPtyByTerminal.set(terminal, pty);
        if (!lastKnownTabName.has(terminal)) {
            lastKnownTabName.set(terminal, terminal.name);
        }
        if (!emittedNameSubscriptions.has(terminal)) {
            // VS Code assigns Terminal.name from every pty title change, but
            // only after a round trip through the renderer. Record the value
            // as we emit it, so the one that comes back is not mistaken for a
            // rename the user made — which would otherwise turn tmux's
            // automatic-rename off on the first title the window reports.
            emittedNameSubscriptions.set(terminal, pty.onDidChangeName((name) => {
                const pending = pendingEmittedNames.get(terminal) ?? [];
                pending.push(name);
                if (pending.length > MAX_PENDING_EMITTED_NAMES) {
                    pending.splice(0, pending.length - MAX_PENDING_EMITTED_NAMES);
                }
                pendingEmittedNames.set(terminal, pending);
            }));
        }
        // Detect built-in "Rename…" the instant the user types in this terminal.
        pty.setOnInputCallback(() => {
            void syncTerminalName(terminal);
        });
        return pty;
    };

    const untrackTerminal = (terminal: vscode.Terminal): void => {
        terminalPtyByTerminal.delete(terminal);
        emittedNameSubscriptions.get(terminal)?.dispose();
        emittedNameSubscriptions.delete(terminal);
    };

    const syncActiveTerminalToTmuxWindow = async (terminal: vscode.Terminal | undefined): Promise<void> => {
        if (!terminal || !client?.isConnected()) {
            return;
        }

        const pty = trackTerminal(terminal);
        if (!pty) {
            return;
        }

        const windowId = pty.getAttachedTmuxWindowId();
        if (!windowId || windowId === activeTmuxWindowId) {
            return;
        }

        await client.sendCommand(`select-window -t ${windowId}`, CommandFlags.TolerateErrors).catch((err) => {
            log(`window sync warning (non-fatal): ${err}`);
        });
    };

    // Track already-open terminals on reload before listening for new ones.
    for (const terminal of vscode.window.terminals) {
        trackTerminal(terminal);
    }

    context.subscriptions.push(
        vscode.window.onDidOpenTerminal((terminal) => {
            trackTerminal(terminal);
            // VS Code may not focus terminal when it is opened
            if (pendingUserTerminalFocus && isTmuxTerminal(terminal)) {
                terminal.show();
                pendingUserTerminalFocus = false;
            }
        }),
        vscode.window.onDidCloseTerminal((terminal) => {
            // Catch a rename made just before the tab was closed.
            void syncTerminalName(terminal);
            untrackTerminal(terminal);
        }),
        vscode.window.onDidChangeActiveTerminal((terminal) => {
            void flushRenames();
            void syncActiveTerminalToTmuxWindow(terminal);
        }),
        // Losing window focus is the last reliable moment before a reload.
        vscode.window.onDidChangeWindowState(() => {
            void flushRenames();
        }),
    );
}

/**
 * Push a built-in "Rename…" to tmux.
 *
 * VS Code has no terminal-rename event — `@types/vscode` offers only
 * `onDidChangeTerminalState` and `onDidChangeTerminalShellIntegration` — so a
 * rename has to be spotted by watching `terminal.name`.
 *
 * The comparison is against the label this extension last observed on the tab,
 * while titles emitted by the pty are parked until VS Code applies them after
 * its renderer round trip. Treating an emitted title as immediately applied
 * makes the still-stale `Terminal.name` look like a user rename and writes it
 * over the tmux window's real name — which is how windows ended up called
 * `tmux:<index>`.
 */
async function syncTerminalName(terminal: vscode.Terminal): Promise<void> {
    const pty = terminalPtyByTerminal.get(terminal);
    if (!pty) {
        return;
    }
    const lastKnown = lastKnownTabName.get(terminal);
    if (lastKnown === undefined) {
        lastKnownTabName.set(terminal, terminal.name);
        return;
    }
    if (terminal.name === lastKnown) {
        // Unchanged. This is also the state during the round trip for a title
        // we just emitted: the tab still shows the previous label, and syncing
        // it would push a stale name back over the one tmux just set.
        return;
    }

    const pending = pendingEmittedNames.get(terminal);
    const arrived = pending ? pending.indexOf(terminal.name) : -1;
    if (arrived !== -1) {
        // The tab is reporting a title this extension emitted, not a rename.
        // Drop it and anything older the workbench coalesced past.
        pending!.splice(0, arrived + 1);
        lastKnownTabName.set(terminal, terminal.name);
        return;
    }

    // The label changed to something never emitted here — a built-in "Rename…".
    pendingEmittedNames.delete(terminal);
    lastKnownTabName.set(terminal, terminal.name);
    if (isPlaceholderTabName(terminal.name)) {
        // `tmux` / `tmux:<n>` is only ever this extension's own placeholder,
        // never a name a user chose, so it must never reach tmux.
        return;
    }
    await pty.syncNameToTmux(terminal.name);
}

/** A tab label this extension invented, as opposed to one the user chose. */
function isPlaceholderTabName(name: string): boolean {
    return /^tmux(:\d+)?$/.test(name.trim());
}

async function flushRenames(): Promise<void> {
    await Promise.all([...terminalPtyByTerminal.keys()].map((t) => syncTerminalName(t)));
}

function getTmuxPtyFromTerminal(terminal: vscode.Terminal): TmuxTerminal | null {
    const options = terminal.creationOptions as vscode.TerminalOptions | vscode.ExtensionTerminalOptions;
    if (!options || !('pty' in options)) {
        return null;
    }
    const pty = (options as vscode.ExtensionTerminalOptions).pty;
    return pty instanceof TmuxTerminal ? pty : null;
}

/**
 * True when the terminal is driven by a `Pseudoterminal` rather than a process
 * the workbench spawned. Deliberately not `instanceof TmuxTerminal`: for the
 * stray-shell sweep the question is only "did an extension create this", and
 * disposing another extension's terminal would be just as wrong as disposing
 * one of ours.
 */
function isExtensionOwnedTerminal(terminal: vscode.Terminal): boolean {
    const options = terminal.creationOptions as vscode.TerminalOptions | vscode.ExtensionTerminalOptions;
    return !!options && 'pty' in options;
}

/** True when this terminal is backed by one of our tmux ptys. */
function isTmuxTerminal(terminal: vscode.Terminal): boolean {
    return terminalPtyByTerminal.has(terminal) || getTmuxPtyFromTerminal(terminal) !== null;
}

function registerPendingTerminalPty(pty: TmuxTerminal): void {
    pendingTerminalPtys.push(pty);
}

function takeNextPendingTerminalPty(): TmuxTerminal | null {
    while (pendingTerminalPtys.length > 0) {
        const candidate = pendingTerminalPtys.shift()!;
        if (![...terminalPtyByTerminal.values()].includes(candidate)) {
            return candidate;
        }
    }
    return null;
}

function registerTerminalProfile(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.window.registerTerminalProfileProvider('tmux-integrated.terminal', {
            async provideTerminalProfile(): Promise<vscode.TerminalProfile> {
                try {
                    log('provideTerminalProfile called');
                    pendingUserTerminalFocus = true;

                    let startDirectory: string | undefined;
                    if (shouldPickStartDirectoryBeforeConnecting()) {
                        startDirectory = await pickStartDirectory(extensionRootPath);
                        if (!startDirectory) {
                            throw new vscode.CancellationError();
                        }
                    }

                    const connected = await ensureClientConnected(startDirectory);
                    if (!connected) {
                        throw new Error('tmux-integrated: Could not connect to tmux. See Output > tmux-integrated for details.');
                    }

                    // Reuse the bootstrap window from a freshly-created session.
                    const bootstrap = takeBootstrapWindow();
                    if (bootstrap) {
                        log(`provideTerminalProfile: using bootstrap window ${bootstrap.windowId}`);
                        return buildTerminalProfile(bootstrap, startDirectory);
                    }

                    // On reconnection, adopt one pre-existing window for this tab
                    // and schedule the rest to appear as additional tabs.
                    const adopted = adoptNextWindow();
                    if (adopted) {
                        log(`provideTerminalProfile: adopting window ${adopted.windowId}`);
                        return buildTerminalProfile(adopted);
                    }

                    // VS Code does not expose its multi-root terminal-location
                    // selection to custom PTY profile providers, so ask here
                    // before creating a genuinely new tmux window.
                    startDirectory ??= await pickStartDirectory(extensionRootPath);
                    if (!startDirectory) {
                        throw new vscode.CancellationError();
                    }

                    log(`provideTerminalProfile: creating new terminal in ${startDirectory} (no bootstrap/adopt)`);
                    return buildTerminalProfile(undefined, startDirectory);
                } catch (err) {
                    pendingUserTerminalFocus = false;
                    if (!(err instanceof vscode.CancellationError)) {
                        log(`provideTerminalProfile error: ${err}`);
                    }
                    throw err;
                }
            },
        }),
    );
}

function registerCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('tmux-integrated.newTerminal', async () => {
            const startDirectory = await pickStartDirectory(extensionRootPath);
            if (!startDirectory) { return; }
            const connected = await ensureClientConnected(startDirectory);
            if (!connected) { return; }
            const terminal = vscode.window.createTerminal(
                buildTerminalOptions(undefined, startDirectory),
            );
            terminal.show();
        }),

        vscode.commands.registerCommand('tmux-integrated.attachWindow', async () => {
            const connected = await ensureClientConnected();
            if (!connected) { return; }
            await showAttachWindowPicker(currentSessionName);
        }),

        vscode.commands.registerCommand('tmux-integrated.renameTerminal', async () => {
            const terminal = vscode.window.activeTerminal;
            if (!terminal) { return; }
            const pty = terminalPtyByTerminal.get(terminal) ?? getTmuxPtyFromTerminal(terminal);
            if (!pty) {
                vscode.window.showWarningMessage('tmux-integrated: active terminal is not a tmux window.');
                return;
            }
            const newName = await vscode.window.showInputBox({
                prompt: 'New tmux window / VS Code tab name',
                value: terminal.name,
                validateInput: (v) => v.trim() ? null : 'Name cannot be empty',
            });
            if (newName === undefined) { return; }
            await pty.renameWindow(newName);
        }),
    );
}

async function ensureClientConnected(startDirectory = defaultStartDirectory): Promise<boolean> {
    if (inFlightConnect) {
        return inFlightConnect;
    }
    inFlightConnect = ensureClientConnectedImpl(startDirectory);
    try {
        return await inFlightConnect;
    } finally {
        inFlightConnect = null;
    }
}

async function ensureClientConnectedImpl(startDirectory: string): Promise<boolean> {
    if (client?.isConnected()) {
        // Verify the control-mode connection is actually alive.
        try {
            const probe = await Promise.race([
                client.sendCommand('display-message -p "__ping__"'),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('health-check timeout')), 5_000),
                ),
            ]);
            if (probe[0]?.trim() === '__ping__') {
                return true;
            }
            log(`Health check unexpected response: ${JSON.stringify(probe)}`);
        } catch (err) {
            log(`Health check failed (${err}), reconnecting…`);
        }
        // Connection is stale — tear it down and reconnect below.
        client.disconnect();
        client = null;
    }

    setStatus('$(sync~spin) tmux-integrated: connecting…');

    // --- Check tmux is available ------------------------------------------
    try {
        tmuxBinaryPath = resolveTmuxBinaryPath();
        tmuxVersion = execFileSync(tmuxBinaryPath, ['-V'], { encoding: 'utf8' }).trim();
        log(`tmux found: ${tmuxBinaryPath} (${tmuxVersion})`);
    } catch (err) {
        log(`tmux not found: ${err}`);
        setStatus('$(error) tmux-integrated: dependency missing');
        const choice = await vscode.window.showErrorMessage(
            'tmux-integrated: tmux is not installed or not in PATH.',
            'Show tmux install instructions',
        );
        if (choice) {
            vscode.env.openExternal(
                vscode.Uri.parse('https://github.com/tmux/tmux/wiki/Installing'),
            );
        }
        return false;
    }

    // --- Determine session name and connect ---------------------------------
    currentSessionName = resolveSessionName();
    const sessionAlreadyExists = tmuxSessionExists(tmuxBinaryPath!, currentSessionName);
    log(`Connecting to session "${currentSessionName}" (exists=${sessionAlreadyExists}, appRoot=${vscode.env.appRoot})`);
    client = new TmuxControlClient(
        currentSessionName,
        tmuxBinaryPath!,
        vscode.env.appRoot,
        globalStoragePath,
    );

    // Feed the version string so the client can gate features accordingly
    // (e.g. the -e flag on new-window requires tmux ≥ 3.0).
    client.setVersion(tmuxVersion!);

    if (!client.versionAtLeast(2, 1)) {
        setStatus('$(warning) tmux-integrated: unsupported version');
        vscode.window.showWarningMessage(
            `tmux-integrated: tmux ${tmuxVersion} may not work correctly. Version 2.1 or later is recommended.`,
        );
    }

    client.on('tmux-exit', () => setStatus('$(error) tmux-integrated: disconnected'));
    client.on('session-window-changed', (ev: { sessionId: string; windowId: string } | null) => {
        if (ev?.windowId) {
            activeTmuxWindowId = ev.windowId;
        }
    });

    try {
        await client.connect({ startDirectory });
        log('Connected to tmux successfully');
    } catch (err) {
        log(`Connection failed: ${err}`);
        setStatus('$(error) tmux-integrated: failed');
        vscode.window.showErrorMessage(`tmux-integrated: Could not connect to tmux: ${err}`);
        return false;
    }

    bootstrapWindow = null;
    windowsToAdopt = [];
    if (!sessionAlreadyExists) {
        try {
            const windows = await client.listWindows();
            log(`New session — found ${windows.length} bootstrap window(s)`);
            if (windows.length === 1) {
                bootstrapWindow = {
                    windowId: windows[0].id,
                    paneId: windows[0].paneId,
                    windowIndex: windows[0].index,
                    name: windows[0].name,
                    // In a new session always set the name
                    automaticRename: true,
                };
            }
        } catch (err) {
            log(`bootstrap window lookup failed: ${err}`);
        }
    } else {
        try {
            const windows = await client.listWindows();
            log(`Existing session — found ${windows.length} window(s) to adopt`);
            // Carry name + automaticRename through so TmuxTerminal.open()
            // does not need fresh round-trips on a high-latency link.
            // list-windows returns windows in index order, and tabs are
            // created in that same order, so tmux window order is the tab
            // order. newWindow() keeps it that way by appending.
            windowsToAdopt = windows.map(w => ({
                windowId: w.id,
                paneId: w.paneId,
                windowIndex: w.index,
                name: w.name,
                automaticRename: w.automaticRename,
            }));
        } catch (err) {
            log(`window enumeration failed: ${err}`);
        }
    }
    setStatus(`$(terminal) tmux-integrated: ${currentSessionName}`, tmuxVersion);

    // Tell tmux to use xterm-256color inside panes so that programs (less,
    // vim, etc.) query the same terminfo as a normal VS Code terminal.  The
    // default (screen-256color / tmux-256color) advertises a different
    // capability set that can cause subtle rendering differences.
    await client.sendCommand(
        'set-option -s default-terminal xterm-256color',
        CommandFlags.TolerateErrors,
    ).catch(() => {});

    // Push the current VS Code IPC variables into the session environment so
    // that `code <file>` and git credential helpers work in tmux windows.
    const envSnapshot = collectVscodeEnvVars();
    if (Object.keys(envSnapshot).length) {
        await client.updateEnvironment(envSnapshot).catch(
            (err) => console.error(`tmux-integrated: set-environment error: ${err}`),
        );
    }
    return true;
}

// ---------------------------------------------------------------------------
// Helpers — terminal creation
// ---------------------------------------------------------------------------

function buildTerminalOptions(
    existingWindow?: AdoptableWindow,
    startDirectory = defaultStartDirectory,
): vscode.ExtensionTerminalOptions {
    const cfg = vscode.workspace.getConfiguration('tmux-integrated');
    const shell = (cfg.get<string>('shell') || process.env.SHELL || '/bin/bash') || undefined;

    const pty = new TmuxTerminal(
        client!,
        startDirectory,
        collectVscodeEnvVars(),
        shell || undefined,
        existingWindow,
        {
            onWindowAttached: (windowId) => {
                attachedWindowIds.add(windowId);
            },
            onWindowDetached: (windowId) => {
                attachedWindowIds.delete(windowId);
            },
        },
        () => disposing,
        log,
    );
    registerPendingTerminalPty(pty);

    return {
        // Whatever label the tab is created with is the label it keeps, so name
        // it after the tmux window rather than an index-derived placeholder.
        name: pickTerminalTabTitle(existingWindow?.name, existingWindow?.windowIndex),
        pty,
    };
}

function buildTerminalProfile(
    existingWindow?: AdoptableWindow,
    startDirectory = defaultStartDirectory,
): vscode.TerminalProfile {
    return new vscode.TerminalProfile(buildTerminalOptions(existingWindow, startDirectory));
}

function takeBootstrapWindow(): AdoptableWindow | undefined {
    const bw = bootstrapWindow;
    bootstrapWindow = null;
    return bw ?? undefined;
}

/**
 * Pop one pre-existing window off the adoption queue, skipping any entries
 * already claimed by a concurrent caller.
 *
 * Each call hands back a single window so that N concurrent
 * provideTerminalProfile invocations (e.g. when VS Code restores N tabs at
 * once on a Remote-SSH reconnect) each adopt one window instead of the
 * first call clearing the tail and forcing the rest into "create a fresh
 * tmux window" fallback. autoConnectExistingSession() mops up whatever is
 * left after a short grace period.
 */
function adoptNextWindow(): AdoptableWindow | undefined {
    while (windowsToAdopt.length > 0) {
        const next = windowsToAdopt.shift()!;
        if (!attachedWindowIds.has(next.windowId)) {
            return next;
        }
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Helpers — attach window picker
// ---------------------------------------------------------------------------

async function showAttachWindowPicker(sessionName: string): Promise<void> {
    let windows;
    try {
        windows = await client!.listWindows();
    } catch (err) {
        vscode.window.showErrorMessage(`tmux-integrated: Failed to list tmux windows: ${err}`);
        return;
    }

    const unattached = windows.filter(w => !attachedWindowIds.has(w.id));
    if (!unattached.length) {
        vscode.window.showInformationMessage(
            windows.length
                ? 'tmux-integrated: All windows are already open in VS Code tabs.'
                : `tmux-integrated: No windows found in session "${sessionName}".`,
        );
        return;
    }

    const items: AttachWindowItem[] = unattached.map((w) => ({
        label: `$(terminal) ${w.name}`,
        description: w.active ? '(active)' : '',
        detail: `Window ${w.id} • Active pane ${w.paneId}`,
        windowId: w.id,
        paneId: w.paneId,
        windowIndex: w.index,
        name: w.name,
        automaticRename: w.automaticRename,
    }));

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a tmux window to open in VS Code',
        title: `tmux-integrated session: ${sessionName}`,
    });

    if (picked) {
        const terminal = vscode.window.createTerminal(buildTerminalOptions({
            windowId: picked.windowId,
            paneId: picked.paneId,
            windowIndex: picked.windowIndex,
            name: picked.name,
            automaticRename: picked.automaticRename,
        }));
        terminal.show();
    }
}

// ---------------------------------------------------------------------------
// Helpers — misc
// ---------------------------------------------------------------------------

function setStatus(text: string, tooltip?: string): void {
    if (!statusBar) { return; }
    statusBar.text = text;
    if (tooltip) { statusBar.tooltip = tooltip; }
}

/**
 * Derive a deterministic tmux session name from the workspace folder or the
 * setting override.  tmux session names may not contain periods or colons.
 */
function resolveSessionName(): string {
    const cfg = vscode.workspace.getConfiguration('tmux-integrated');
    const override = cfg.get<string>('sessionName');
    if (override) { return sanitizeName(override); }

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) {
        return sanitizeName(path.basename(folder.uri.fsPath)) || 'vscode';
    }
    return sanitizeName(path.basename(defaultStartDirectory)) || 'vscode';
}

function resolveStartDirectory(
    extensionPath: string,
    folder = vscode.workspace.workspaceFolders?.[0],
): string {
    const workspaceFolder = folder?.uri.fsPath;

    // 1. tmux-integrated.cwd
    const cfg = vscode.workspace.getConfiguration('tmux-integrated', folder?.uri);
    const cwdSetting = cfg.get<string>('cwd');
    if (cwdSetting) {
        return resolveVariables(cwdSetting, workspaceFolder, extensionPath);
    }

    // 2. terminal.integrated.cwd
    const termCwd = vscode.workspace
        .getConfiguration('terminal.integrated', folder?.uri)
        .get<string>('cwd');
    if (termCwd) {
        return resolveVariables(termCwd, workspaceFolder, extensionPath);
    }

    // 3. Workspace folder
    return workspaceFolder || extensionPath;
}

async function pickStartDirectory(extensionPath: string): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length <= 1) {
        return resolveStartDirectory(extensionPath, folders?.[0]);
    }

    const picked = await vscode.window.showQuickPick(
        folders.map((workspaceFolder) => ({
            label: workspaceFolder.name,
            description: workspaceFolder.uri.fsPath,
            workspaceFolder,
        })),
        { placeHolder: 'Select current working directory for new tmux terminal' },
    );
    return picked
        ? resolveStartDirectory(extensionPath, picked.workspaceFolder)
        : undefined;
}

function shouldPickStartDirectoryBeforeConnecting(): boolean {
    if (client?.isConnected() || inFlightConnect) {
        return false;
    }

    const binaryPath = tmuxBinaryPath ?? resolveTmuxBinaryPathSafe();
    return binaryPath !== null && !tmuxSessionExists(binaryPath, resolveSessionName());
}

/**
 * Resolve common VS Code predefined variables in a string value.
 * See https://code.visualstudio.com/docs/editor/variables-reference
 */
function resolveVariables(value: string, workspaceFolder: string | undefined, fallbackDir: string): string {
    const vars: Record<string, string | undefined> = {
        workspaceFolder,
        workspaceFolderBasename: workspaceFolder ? path.basename(workspaceFolder) : undefined,
        userHome: process.env.HOME ?? process.env.USERPROFILE,
        pathSeparator: path.sep,
    };
    return value.replace(/\$\{(\w+)\}/g, (_match, name: string) => {
        return vars[name] ?? fallbackDir;
    });
}

function sanitizeName(name: string): string {
    // tmux session names: no spaces, periods, colons, or leading dashes.
    return name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^-+/, '').substring(0, 32);
}

function resolveTmuxBinaryPath(): string {
    // Just use 'tmux' and let the OS resolve it from PATH.
    // Verify it's actually callable.
    execFileSync('tmux', ['-V'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    return 'tmux';
}

function log(message: string): void {
    outputChannel?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

/**
 * Read `terminal.integrated.defaultProfile.<os>` for the current platform.
 * Returns `null` if unset. Used to gate the stray-shell auto-close so we
 * never dispose user-opened terminals when the default profile isn't ours.
 */
function currentPlatformDefaultProfile(): string | null {
    const key = process.platform === 'darwin' ? 'osx'
        : process.platform === 'win32' ? 'windows'
        : 'linux';
    const v = vscode.workspace
        .getConfiguration('terminal.integrated')
        .get<string>(`defaultProfile.${key}`);
    return v && v.length > 0 ? v : null;
}

function isTmuxIntegratedDefaultProfile(): boolean {
    return currentPlatformDefaultProfile() === 'tmux-integrated';
}

/**
 * Like resolveTmuxBinaryPath but returns null instead of throwing
 * when tmux is not found.
 */
function resolveTmuxBinaryPathSafe(): string | null {
    try {
        return resolveTmuxBinaryPath();
    } catch {
        return null;
    }
}

/**
 * Auto-connect to the existing tmux session for this workspace and
 * open each existing tmux window as a VS Code terminal tab.
 *
 * VS Code may also restore previously-open `tmux-integrated` profile tabs
 * by calling provideTerminalProfile during/after activation. To avoid
 * double-creating tabs (which would spawn fresh tmux windows alongside
 * the adopted ones), we yield to those restore calls before mopping up
 * whatever windows are still un-claimed.
 *
 * Two timing knobs:
 *
 * - `AUTO_CONNECT_INITIAL_GRACE_MS` is the worst-case wait we'll tolerate
 *   if VS Code never starts restoring (e.g. fresh launch with no prior
 *   tabs, or `terminal.integrated.enablePersistentSessions=false`). With
 *   eager activation (`activationEvents: ["*"]`) workbench restore can
 *   start well after autoConnect, especially on Reload Window — see
 *   commit history for the regression that introduced this longer wait.
 *
 * - `AUTO_CONNECT_QUIET_GRACE_MS` is the wait between successive restore
 *   events. Each tmux-named terminal opening resets the timer, so a
 *   restore that drains windows one at a time keeps the wait alive until
 *   it's done. Quiet expiry means "VS Code has stopped restoring",
 *   adopt the rest.
 */
const AUTO_CONNECT_INITIAL_GRACE_MS = 3000;
const AUTO_CONNECT_QUIET_GRACE_MS = 750;
async function autoConnectExistingSession(): Promise<void> {
    log('Auto-connect: existing tmux session detected, connecting…');
    const connected = await ensureClientConnected();
    if (!connected) {
        log('Auto-connect: connection failed');
        return;
    }

    if (windowsToAdopt.length === 0) {
        log('Auto-connect: connected but no windows to adopt');
        return;
    }

    log(`Auto-connect: ${windowsToAdopt.length} window(s) to adopt — waiting up to ${AUTO_CONNECT_INITIAL_GRACE_MS}ms for VS Code restore`);

    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let disposable: vscode.Disposable | null = null;

    const finalize = (reason: string) => {
        graceTimer = null;
        disposable?.dispose();
        disposable = null;
        const remaining = windowsToAdopt.splice(0);
        if (remaining.length === 0) {
            log(`Auto-connect: ${reason} — queue drained by VS Code restore, no extra tabs needed`);
            return;
        }
        log(`Auto-connect: ${reason} — creating tabs for ${remaining.length} unclaimed window(s)`);
        for (const w of remaining) {
            if (!attachedWindowIds.has(w.windowId)) {
                vscode.window.createTerminal(buildTerminalOptions(w));
            }
        }
    };

    const armTimer = (ms: number, reason: string) => {
        if (graceTimer) { clearTimeout(graceTimer); }
        graceTimer = setTimeout(() => finalize(reason), ms);
    };

    // Each restore-triggered tmux terminal open resets the timer to the
    // shorter quiet grace, so a slow drip-feed of restores keeps the
    // wait alive until the workbench is done. We only reset while there
    // is still something to adopt — otherwise the listener does nothing
    // and we exit on the initial grace.
    disposable = vscode.window.onDidOpenTerminal((terminal) => {
        if (windowsToAdopt.length > 0 && isTmuxTerminal(terminal)) {
            armTimer(AUTO_CONNECT_QUIET_GRACE_MS, 'quiet grace expired after VS Code restore');
        }
    });

    armTimer(AUTO_CONNECT_INITIAL_GRACE_MS, 'initial grace expired with no VS Code restore');
}

function tmuxSessionExists(binaryPath: string, sessionName: string): boolean {
    try {
        execFileSync(binaryPath, ['has-session', '-t', sessionName], {
            stdio: ['ignore', 'ignore', 'ignore'],
        });
        return true;
    } catch {
        return false;
    }
}

/**
 * Collect the VS Code environment variables that should be forwarded into
 * every new tmux window so that editor-integration commands keep working.
 *
 * • VSCODE_IPC_HOOK_CLI  — lets `code <file>` talk to the running VS Code.
 * • GIT_ASKPASS / VSCODE_GIT_* — git credential and signing helpers.
 */
function collectVscodeEnvVars(): Record<string, string> {
    const keys = [
        'VSCODE_IPC_HOOK_CLI',
        'GIT_ASKPASS',
        'VSCODE_GIT_ASKPASS_NODE',
        'VSCODE_GIT_ASKPASS_MAIN',
        'VSCODE_GIT_ASKPASS_EXTRA_ARGS',
        'VSCODE_GIT_IPC_HANDLE',
    ];

    const vars: Record<string, string> = {};
    for (const k of keys) {
        const v = process.env[k];
        if (v) { vars[k] = v; }
    }
    return vars;
}
