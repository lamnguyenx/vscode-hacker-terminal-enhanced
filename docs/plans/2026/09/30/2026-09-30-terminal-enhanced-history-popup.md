# Terminal Enhanced: command-history popup

**Date:** 2026-09-30
**Status:** DONE (unit checks pass; `8 passed` E2E; typechecks clean; VSIX built
and installed on the reference stack)
**Files added:** `src/history.ts`, `src/store.ts`, `src/popup.ts`,
`src/webview/popup.ts`, `src/webview/vscode-api.d.ts`, `media/popup.css`,
`tsconfig.webview.json`, `tests/units/history_check.ts`,
`tests/units/store_check.ts`, this doc.
**Files changed:** `src/extension.ts`, `src/tracker.ts`, `package.json`,
`Makefile`, `.gitignore`, `.vscodeignore`, `tests/playwright/workbench.ts`,
`tests/playwright/terminal-enhanced.spec.ts`, `README.md`,
`docs/important/how-to-test.md`, `docs/important/restored-terminal-limitation.md`.

## Context

The extension previously copied only the *last* command + output on a
keybinding. The request: a neovim-style popup listing recent commands (first
line on the left, full command on the right), browsable with `↑`/`↓`, max 10,
and persisted across reloads.

## Decisions (from the planning Q&A)

| Question | Choice |
| --- | --- |
| Popup widget | **Custom two-pane webview**, not QuickPick |
| Copied content | The **full LLM block** for the selected entry |
| History scope | **Global** across terminals + **persisted** across reloads |
| Trigger | Shortcut opens the popup (replaces the old instant-copy) |
| `copyLast` | **Removed** |
| Storage | **`node:sqlite` only**, DB under `globalStorage` |
| Per-command cap | Configurable, default **1 MB** |
| History size | Configurable, default **10** |
| No-terminal | Popup **always** shows history (in-popup empty state) |
| Webview build | `bun build` → `media/popup.js`; `tsc -p tsconfig.webview.json` typecheck |

### The "popup" reality

VS Code's stable API has no floating overlay webview — only `WebviewPanel`
(editor area / separate window) and `WebviewView` (docked in a container). The
final design exposes `terminalEnhanced.historyDisplay` with `editor` (default),
`panel`, `sidebar`, `secondarySidebar`, and `window`, plus a separate
`terminalEnhanced.closeOnCopy` (default `false`) for dismissal. See
[Presentation rework](#presentation-rework-2026-10-01) below.

## Design

```
REST/commands ──▶ tracker.ts ──▶ store.ts (node:sqlite, globalStorage)
                                     │  onDidChange
                                     ▼
keybinding ──▶ popup.ts (WebviewPanel) ──postMessage(items)──▶ webview/popup.ts
                     ▲                                              │
                     └──────────{copy,id}───────────────────────────┘
```

- **`history.ts`** (pure) — `firstLine`, `toDisplayItem`.
- **`store.ts`** — `HistoryStore`: schema, insert + evict past `limit`, metadata
  `list()` (never the output column), lazy `get(id)`, `clear`, `setLimit`,
  `onDidChange`. Takes a plain DB path so bun can unit-check it.
- **`tracker.ts`** — subscribes to shell-execution start/end; drains
  `execution.read()` (bounded by `maxOutputLength`), then `store.add`.
- **`popup.ts`** — singleton `WebviewPanel`; CSP+nonce; posts display items on
  `ready` and on store change; handles `copy` (fetch full row, `formatExecution`,
  clipboard, status-bar echo, dispose) and `close`; disposes on focus loss once
  the webview has rendered.
- **`webview/popup.ts`** — renders the two panes, owns keyboard navigation
  (`↑/↓/Home/End/Enter/Esc`), posts `copy {id}`. Bundled to `media/popup.js`.

Settings: `terminalEnhanced.historySize` (10), `terminalEnhanced.maxOutputLength`
(1_000_000). Commands: `showHistory`, `clearHistory`, `hideHistory` (palette-hidden).

## Verification

```sh
npm run test:units          # history + store checks pass
npm run typecheck:webview   # clean
npm run typecheck:tests     # clean
make build                  # VSIX includes media/popup.js + popup.css
npm run test:e2e            # 8 passed (1.7m)
```

`node:sqlite` was probed live before building: the reference extension host is
**Node v24.18.1** with `DatabaseSync`, and bun 1.4 supports `node:sqlite`, so the
store is unit-testable without a host.

A visual check (CDP screenshot) confirmed both panes render, the selection
highlight, and the responsive stack in a narrow column.

## Trials, errors and dead ends

1. **"Popup" cannot float.** Stable VS Code has no overlay webview; the chosen
   webview panel is an editor tab with focus-loss dismissal. Documented.

2. **`navigator.clipboard.readText()` is unusable here.** The pp browser is not
   OS-focused from the runner, so reads/writes reject with *"Document is not
   focused"*; CDP `Emulation.setFocusEmulationEnabled` did **not** flip
   `document.hasFocus()`. Switched the oracle to a **renderer hook**: replace
   `navigator.clipboard.writeText` and record the payload. Verified that the
   extension host's `vscode.env.clipboard.writeText` routes through it.

3. **Shell integration splits on `;`.** The test command `sleep 0.3; echo X` was
   tracked as just `sleep 0.3`. `splitAndSanitizeCommandLine` only splits
   newlines — the split is done by shell-integration command detection. Use a
   single command.

4. **Ultra-fast builtins lose their output.** `echo`/`printf` were intermittently
   captured with empty output even via `/bin/echo` (2/6). Reading the VS Code
   source (`extHostTerminalShellIntegration.ts` → `ShellExecutionDataStream` +
   `AsyncIterableObject`) showed the cause: `emitData` forwards only to already
   registered emitters, and the emitter is registered in a `queueMicrotask`.
   Output that arrives before registration (fast commands, batched RPC) is
   dropped. This is a **platform race, not fixable from the extension**; the
   old code had it too and got lucky. Tests use
   `bash -c 'sleep 0.3 && echo …'` (single command, delayed output) and the
   README documents the limitation.

5. **Debug logging didn't reach the logs.** `console.log` from the extension host
   did not appear in `remoteexthost.log`; appendFile to a writable mount
   (`code-server/.local/share/code-server/…`) proved the capture path instead.

6. **Webview element screenshots mis-map under nested frames.** Full-page CDP
   screenshots were the reliable visual oracle; the E2E asserts the DOM.

## Lessons

- **Check the platform source before assuming an extension bug.** The output
  race was diagnosed in `ShellExecutionDataStream`, not guessed.
- **A focus-gated browser API needs a renderer hook** when the browser is remote;
  `grantPermissions` is not enough without OS focus.
- **One command per test line** avoids shell-integration sub-executions.
- **Pure modules stay pure**: `history.ts`/`store.ts` have no `vscode` import, so
  they run under bun with a temp SQLite file.

## Presentation rework (2026-10-01)

Follow-up after the first cut shipped an editor-area panel plus a QuickPick
option. The user rejected QuickPick and asked for a single setting choosing
*where* the history lives — editor / panel / primary sidebar / secondary sidebar
/ separate window — with auto-dismiss-after-copy optional and **off** by
default.

Final shape:

- `terminalEnhanced.historyDisplay`: `editor` (default), `panel`, `sidebar`,
  `secondarySidebar`, `window`.
- `terminalEnhanced.closeOnCopy`: boolean, default `false`.
- QuickPick removed (`src/quickPick.ts` deleted).
- One docked webview view (`terminalEnhanced.historyView`), contributed to a
  panel container and **moved** to the requested container with the internal
  `vscode.moveViews` command, then focused. A `setContext` key
  (`terminalEnhanced.display`) hides it in `editor`/`window` modes.
- `window`: create the editor panel, then
  `workbench.action.moveEditorToNewWindow`.

Traps (each cost a debug cycle):

1. **`config.*` in a view `when` is not reactive.** The view stayed visible
   after the setting changed; switched to a `setContext` key.
2. **Container ids are prefixed.** `viewsContainers` id `terminalEnhanced-panel`
   registers as `workbench.view.extension.terminalEnhanced-panel`; `moveViews`
   with the bare id silently no-ops.
3. **Container ids cannot contain dots** (`^[A-Za-z0-9_-]+$`). The first cut
   used `terminalEnhanced.panel`, so all three containers were rejected and the
   view silently fell back to a default container.
4. **The secondary-sidebar location key is `secondarySidebar`**, not
   `auxiliarybar`.
5. **`window` mode is a no-op under code-server** (a browser tab cannot open an
   OS window); it falls back to the editor area. Desktop-only.

Tests grew to 12 (placement assertions for panel/sidebar/auxiliary and a
`closeOnCopy` case). `window` mode is manual.

CDP checks used `chrome-devtools-9022` (bridged to the live browser on 9024);
container placement was confirmed via `.part.{panel,sidebar,auxiliarybar}`
composite titles.
