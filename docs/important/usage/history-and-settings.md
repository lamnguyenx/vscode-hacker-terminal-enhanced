# Usage, history and settings

Open the history, move through commands, copy an execution block, and tune where the view appears.

1. Open a terminal (shell integration must be enabled — enabled by default for
   supported shells).
2. Press **`Ctrl+Alt+Shift+C`** (`Ctrl+Cmd+Shift+C` on macOS) while the terminal
   is focused, or run **Hacker Terminal Enhanced: Show Command History** from
   the Command Palette.
3. The history view opens (see [`historyDisplay`](#settings)).
   - `↑` / `↓` (or click) move the selection — the right pane follows (full
     command, its captured output, and the output size). The command/meta
     header stays put while only the output scrolls, following the tail of a
     running command. The output has a line-number gutter (hidden for very
     long outputs), and the scrollbar appears only while the content actually
     overflows.
   - `Enter` copies the selected command's full block to the clipboard and
     flashes a **Copied** confirmation in the view.
   - `Alt+Z` toggles output line wrap; `Esc` closes it.
4. Paste anywhere.

## History

- **Global** across terminals and **persisted to disk** (SQLite under the
  extension's `globalStorage`), so it survives window reloads and restarts.
- **Long-running commands** (e.g. `tail -f`, `docker compose logs -f`, a dev
  server) are listed as soon as they start, flagged with a pulsing `running`
  badge; their output **streams** into the right pane until the command ends
  or its terminal closes.
- Output is captured by feeding the terminal's raw byte stream through a
  **headless terminal emulator**, so full-screen TUIs (`tig`, `gdu`, `less`,
  `vim`, `htop`, …) capture **the screen they are displaying** instead of a
  meaningless run of every repaint. It also re-joins soft-wrapped long lines
  into single logical lines and collapses `\r` progress redraws to their final
  state. Set `terminalEnhanced.emulatedCapture` to `false` for the previous
  linear ANSI-strip capture.
- The emulator path also recovers output VS Code's shell-integration data
  stream silently drops — most notably `docker logs -f`, whose bytes render in
  the terminal but never reach `execution.read()` — and the output of
  ultra-fast shell builtins.
- Retains the most recent **`historySize`** commands (default **10**).
- Captures up to **`maxOutputLength`** characters of output per command
  (default **1,000,000** ≈ 1 MB).

### Settings

| Setting | Default | Description |
| --- | --- | --- |
| `terminalEnhanced.historyDisplay` | `editor` | Where the history is shown: `editor` (tab), `panel` (bottom), `sidebar` (primary sidebar / Activity Bar), `secondarySidebar`, or `window` (separate OS window). |
| `terminalEnhanced.closeOnCopy` | `false` | Close the view/panel immediately after a command is copied. |
| `terminalEnhanced.historySize` | `10` | How many recent commands to keep. |
| `terminalEnhanced.maxOutputLength` | `1000000` | Max characters of output captured per command. |
| `terminalEnhanced.emulatedCapture` | `true` | Capture through a headless terminal emulator, so full-screen TUIs record the screen they are showing and long lines are re-joined. Off = previous linear ANSI-strip capture. |

The docked modes use a single view that is moved to the configured container;
only that container is shown, so the others stay out of the way.

## Commands

| Command | Description |
| --- | --- |
| `terminalEnhanced.showHistory` | Open the history (bound to `Ctrl+Alt+Shift+C` / `Ctrl+Cmd+Shift+C`, `when: terminalFocus`). |
| `terminalEnhanced.clearHistory` | Delete every retained command. |
| `terminalEnhanced.hideHistory` | Close the editor/window panel (hidden from the palette). |
