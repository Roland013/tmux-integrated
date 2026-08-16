/**
 * VS Code terminal tab titles from tmux `#{window_name}`.
 *
 * tmux owns the window name, so the tab simply shows it. While
 * **automatic-rename** is on that name tracks the foreground process
 * (`zsh` → `nvim` → `git`) and the tab follows along; once the user renames
 * a window — from VS Code or with `rename-window` inside tmux — tmux turns
 * automatic-rename off and the chosen name sticks.
 *
 * The extension never renames a window on the user's behalf, so no
 * extension-invented label is ever persisted into the tmux session.
 * `tmux:<n>` remains only as a VS Code-side placeholder for the rare window
 * that has no name at all.
 */

/** Interpret `#{automatic-rename}` / `list-windows` field (version-dependent values). */
export function tmuxAutomaticRenameIsOn(value: string | undefined): boolean {
    const v = (value ?? '').trim().toLowerCase();
    return v === '1' || v === 'on' || v === 'yes' || v === 'true';
}

/**
 * @param windowName current `#{window_name}`
 * @param windowIndex zero-based `#{window_index}`
 */
export function pickTerminalTabTitle(
    windowName: string | undefined,
    windowIndex: number | undefined,
): string {
    const raw = windowName?.trim();
    if (raw) {
        return raw;
    }
    return windowIndex !== undefined ? `tmux:${windowIndex}` : 'tmux';
}
