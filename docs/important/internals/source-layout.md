# Build and source layout

The build targets and the role of each source file.

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
| `scripts/dev-webview.ts` | Browser dev harness server (see [Browser dev harness](browser-dev-harness.md)). |
| `dev/` | Dev harness assets (theme variables + host shim). Not shipped. |
