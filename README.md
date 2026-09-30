# Hacker Terminal Enhanced

Browse and copy recent terminal commands and their output in an LLM-friendly
format — a popup history of your last commands, with a one-keystroke copy of the
selected command's full result.

The popup shows each command's first line on the left and the full command
(plus cwd / exit code / start time) on the right:

```text
COMMAND                       FULL COMMAND
▸ git status --short          git status --short && uname -a
  uname -a                    cwd:   /home/user/project
  docker ps                   exit:  0
                              start: 2026-09-30 17:29:23

↑↓ browse · ⏎ copy full block · Esc close
```

Pressing `Enter` copies the whole execution block:

```text
# ----------------- TERMINAL EXECUTION: SUMMARY -----------------
- Working Directory: /home/user/project
- Exit Code: 0
- Started: 2026-09-08 14:32:01
- Ended:   2026-09-08 14:32:02
- Duration: 1.23s



# ----------------- TERMINAL EXECUTION: COMMAND -----------------
git status

# ----------------- TERMINAL EXECUTION: STDERR + STDOUT -----------------
On branch main
nothing to commit, working tree clean

```

## Usage

1. Open a terminal (shell integration must be enabled — enabled by default for
   supported shells).
2. Press **`Ctrl+Alt+Shift+C`** (`Ctrl+Cmd+Shift+C` on macOS) while the terminal
   is focused, or run **Hacker Terminal Enhanced: Show Command History** from
   the Command Palette.
3. The popup opens with your recent commands.
   - `↑` / `↓` (or click) move the selection — the right pane follows.
   - `Enter` copies the selected command's full block to the clipboard.
   - `Esc` closes; clicking away also closes it.
4. Paste anywhere.

## History

- **Global** across terminals and **persisted to disk** (SQLite under the
  extension's `globalStorage`), so it survives window reloads and restarts.
- Retains the most recent **`terminalEnhanced.historySize`** commands
  (default **10**).
- Captures up to **`terminalEnhanced.maxOutputLength`** characters of output per
  command (default **1,000,000** ≈ 1 MB).

### Settings

| Setting | Default | Description |
| --- | --- | --- |
| `terminalEnhanced.historySize` | `10` | How many recent commands to keep. |
| `terminalEnhanced.maxOutputLength` | `1000000` | Max characters of output captured per command. |

## Commands

| Command | Description |
| --- | --- |
| `terminalEnhanced.showHistory` | Open the history popup (bound to `Ctrl+Alt+Shift+C` / `Ctrl+Cmd+Shift+C`, `when: terminalFocus`). |
| `terminalEnhanced.clearHistory` | Delete every retained command. |
| `terminalEnhanced.hideHistory` | Close the popup (hidden from the palette). |

## Limitations

- Requires [shell integration](https://code.visualstudio.com/docs/terminal/shell-integration)
  to be enabled in the terminal (default for bash, zsh, fish, pwsh).
- The popup is an **editor-area webview panel** — VS Code's stable API has no
  floating overlay webview. In a narrow editor column the two panes stack
  vertically; widen the column to get the side-by-side layout.
- **Very fast commands may have no captured output.** VS Code's shell-integration
  data stream drops output that arrives before the consumer has registered
  (`ShellExecutionDataStream`), which can affect instant shell builtins
  (`echo`, `printf`). Longer-running and external commands are captured
  normally.
- Commands running in the background (e.g. `sleep 10 &`) may not have their
  output fully captured when the next command starts.
- The history database uses the built-in **`node:sqlite`**, which requires an
  extension-host **Node ≥ 22.5**. The reference stack (code-server 4.x) runs
  Node 24; on an older host the extension shows an error and history is
  disabled. This is why the extension does not support Node 20-era desktop
  VS Code.
- **Restored terminals:** VS Code cannot expose a restored terminal's buffer to
  extensions, but the extension's own persisted history means your last
  commands are still available in the popup after a reload or crash. See
  [`docs/important/restored-terminal-limitation.md`](docs/important/restored-terminal-limitation.md).

## Development

```bash
make build      # npm install + compile (tsc + bun webview bundle) + package *.vsix
make install    # build + install into VS Code and code-server
```

Source layout:

| File | Role |
| --- | --- |
| `src/history.ts` | Pure display helpers (first line, webview item mapping). |
| `src/store.ts` | `node:sqlite` history store (path-in, no `vscode`). |
| `src/tracker.ts` | Shell-execution tracking; writes captures to the store. |
| `src/extension.ts` | Activation, settings, command registration. |
| `src/popup.ts` | Webview panel host (CSP, messages, copy, auto-dismiss). |
| `src/webview/popup.ts` | Webview UI (bundled to `media/popup.js`). |
| `media/popup.css` | Popup styling. |

## Testing

Three layers:

```bash
npm run test:units        # pure logic (bun): history helpers + SQLite store
npm run typecheck:webview # strict tsc over src/webview
npm run typecheck:tests   # strict tsc over the Playwright suite
npm run test:e2e          # Playwright E2E (REST Control arranges/acts, CDP asserts)
```

The end-to-end suite drives the **running code-server workbench** over CDP (no
browser is launched). Arrange/act goes through the
[REST Control](https://github.com/lamnguyenx/vscode-hacker-rest-control)
endpoint; Playwright asserts the popup webview DOM, the copied payload, and the
status-bar echo. See
[`docs/important/how-to-test.md`](docs/important/how-to-test.md) for the
topology, gotchas, and known limits, and the meta repo's
[`how-to-test-all.md`](../../../docs/important/how-to-test-all.md) for the
general model.

Environment overrides: `CDP_PORT` (browser CDP port, 9024), `HACKER_REST_CONTROL_PORT`
(REST Control, 40620), `CODE_SERVER_URL` (workspace URL the tests expect).

Background:
[`docs/plans/2026/09/30/2026-09-30-terminal-enhanced-history-popup.md`](docs/plans/2026/09/30/2026-09-30-terminal-enhanced-history-popup.md).
