# Hacker Terminal Enhanced

Browse and copy recent terminal commands and their output in an LLM-friendly
format. A two-pane history view — command list on the left, the selected
command's full text and captured output on the right — that you can place
wherever you like: the editor, the panel, either sidebar, or a separate window.

Pressing `Enter` copies the whole execution block for the selected command:

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

## Limitations

- Requires [shell integration](https://code.visualstudio.com/docs/terminal/shell-integration)
  to be enabled in the terminal (default for bash, zsh, fish, pwsh).
- **`window` mode needs a desktop build.** Under code-server / a browser,
  VS Code cannot move an editor into its own OS window, so it falls back to the
  editor area.
- **Full-screen TUIs are captured as their visible screen, not their session
  history.** A TUI repaints in place on the alternate screen; the extension
  snapshots the last screen it displayed (e.g. tig's log view, gdu's summary)
  rather than reconstructing keystroke-by-keystroke navigation.
- **VS Code's shell-integration data stream silently drops some commands'
  output entirely** (inside VS Code itself — most notably `docker logs -f`).
  The emulator path captures these and the output of ultra-fast builtins.
  Commands running in the background (e.g. `sleep 10 &`) may still miss output
  once the next command starts.
- The history database uses the built-in **`node:sqlite`**, which requires an
  extension-host **Node ≥ 22.5**. The reference stack (code-server 4.x) runs
  Node 24; on an older host the extension shows an error and history is
  disabled. This is why the extension does not support Node 20-era desktop
  VS Code.
- **Restored terminals:** VS Code cannot expose a restored terminal's buffer to
  extensions, but the extension's own persisted history means your last
  commands are still available after a reload or crash. See
  [`docs/important/restored-terminal-limitation.md`](docs/important/restored-terminal-limitation.md).

## Development

```bash
make build      # npm install + compile (tsc + bun webview bundle) + package *.vsix
make install    # build + install into VS Code and code-server
make install-code-server-dev  # build + install into the docker-compose code-server
```

Source layout:

| File | Role |
| --- | --- |
| `src/history.ts` | Pure display helpers (first line, webview item mapping). |
| `src/historyMessages.ts` | Wire types shared by the host, the webview, and the dev harness. |
| `src/historyMarkup.ts` | The popup document/body markup, shared by host + dev harness. |
| `src/ansi.ts` | ANSI/OSC stripping for captured output (incl. shell-integration markers). |
| `src/format.ts` | The copied-block layout (`SUMMARY` / `COMMAND` / `OUTPUT`). |
| `src/store.ts` | `node:sqlite` history store (path-in, no `vscode`; read-only mode). |
| `src/tracker.ts` | Shell-execution tracking; writes captures to the store. |
| `src/terminalEmulator.ts` | Headless-xterm capture: TUI screen snapshots + buffer serialization (no `vscode`). |
| `src/settings.ts` | `historyDisplay` / `closeOnCopy` readers. |
| `src/extension.ts` | Activation, command + view registration. |
| `src/display.ts` | Routes `showHistory` to the configured presentation. |
| `src/editorPanel.ts` | Editor-area / separate-window webview panel. |
| `src/panelView.ts` | The docked view + `vscode.moveViews` placement. |
| `src/copy.ts` | Copy + status-bar echo. |
| `src/historyWebview.ts` | Shared webview HTML + message protocol. |
| `src/webview/popup.ts` | Webview UI (bundled to `media/popup.js`). |
| `media/popup.css` | The two-pane styling. |
| `scripts/dev-webview.ts` | Browser dev harness server (see below). |
| `dev/` | Dev harness assets (theme variables + host shim). Not shipped. |

### Browser dev harness

Iterate on the panel in a plain browser (normal devtools), hot-reloading on
save, against a **read-only mirror** of your real history DB:

```bash
make dev-webview            # or: npm run dev:webview  → http://localhost:5199
make dev-webview-docker     # same, in the pinned Bun container
```

The container service lives in the **meta repo's** `docker-compose.yml`
(alongside `code-server`) as `lamnguyenx.hacker-terminal-enhanced-webview-dev`:
run `docker compose up -d lamnguyenx.hacker-terminal-enhanced-webview-dev` from
the meta repo root.

It serves the real `media/popup.*` (rebuilt by `bun build --watch`) with the
same document markup and message protocol as the extension, so the browser page
cannot drift from the real webview. Editing `src/webview/**` or
`media/popup.css` reloads the page; running commands in code-server updates the
list/output live. Actions are fully interactive (`↑`/`↓`, `Enter` to copy); only
DB writes are disabled. Env overrides: `WEBVIEW_DEV_PORT`, `HTE_DB`,
`HTE_META_ROOT`.

It mirrors the SQLite file the extension writes, so the **code-server workbench
tab must be connected** — its extension host has to be running to capture
commands (reload the tab after a code-server restart). The page resyncs on
connect and the server polls the DB every 500 ms, so anything captured shows up
within a beat.

## Testing

Three layers:

```bash
npm run test:units        # pure logic (bun): history helpers + SQLite store + emulator
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
[`docs/plans/2026/09/30/2026-09-30-terminal-enhanced-history-popup.md`](docs/plans/2026/09/30/2026-09-30-terminal-enhanced-history-popup.md),
[`docs/plans/2026/10/01/2026-10-01-live-output-and-dev-harness.md`](docs/plans/2026/10/01/2026-10-01-live-output-and-dev-harness.md)
(live output + dev harness: trials, errors, and lessons),
[`docs/plans/2026/10/05/2026-10-05-terminal-data-supplemental-capture.md`](docs/plans/2026/10/05/2026-10-05-terminal-data-supplemental-capture.md)
(`docker logs -f` "(no output)": investigation, supplemental capture, and the
regression test that pins it),
[`docs/plans/2026/10/05/2026-10-05-tui-and-emulated-capture.md`](docs/plans/2026/10/05/2026-10-05-tui-and-emulated-capture.md)
(tig/gdu "(garbage)": capturing full-screen TUIs and all commands through a
headless xterm emulator),
[`docs/plans/2026/10/06/2026-10-06-emulated-capture-rollout.md`](docs/plans/2026/10/06/2026-10-06-emulated-capture-rollout.md)
(rollout retrospective: install target, fresh-install trials, and lessons).
