# How to test Hacker Terminal Enhanced

> **General rules live in the meta repo** —
> [`how-to-test-all.md`](../../../../docs/important/how-to-test-all.md):
> environment choice, the REST-vs-CDP test model, determinism, state hygiene,
> port/path pinning, cache-busting, and flakiness. **Read it first.**
> This document keeps only what is specific to *this* extension: the install,
> the scripts, the webview-popup topology, and the clipboard/terminal gotchas.
>
> Environment / topology (code-server in Docker on nuc, browser on pp, CDP
> 9024): meta repo
> [`dev-code-on-nuc-test-on-pp.md`](../../../../docs/important/dev-code-on-nuc-test-on-pp.md).

This extension has **no webview view** and nothing to click in the terminal; it
observes the integrated terminal, persists a command history, and shows it in a
**webview panel**. The test model is the playbook's clean split:

```
REST Control → arrange + act   (create terminal, run commands, open/clear the popup)
CDP/Playwright → assert only   (popup webview DOM, copied payload, status-bar echo)
```

Background and the earlier activation fix:
[`docs/plans/2026/09/29/2026-09-29-terminal-enhanced-activation-fix-and-playwright-e2e.md`](../plans/2026/09/29/2026-09-29-terminal-enhanced-activation-fix-and-playwright-e2e.md).
The history-popup feature log:
[`docs/plans/2026/09/30/2026-09-30-terminal-enhanced-history-popup.md`](../plans/2026/09/30/2026-09-30-terminal-enhanced-history-popup.md).

## Prerequisites

- [Bun](https://bun.sh) — pure-logic checks, and the webview bundle
  (`bun build` → `media/popup.js`).
- Node.js + `npm install` (Playwright + `@playwright/test`).
- **Option A (preferred):** code-server up with this extension installed, and
  the CDP browser reachable on `CDP_PORT` (9024 by default). REST Control pinned
  by `HACKER_REST_CONTROL_PORT` (40620).
- **Option B:** a local Extension Development Host on a CDP port. Point
  `CDP_PORT` at it. The popup is a webview panel: under a dev host it is an
  **OOPIF** and Playwright cannot reach it (raw CDP would be needed) — the
  committed suite targets code-server, where webviews are nested same-origin
  iframes.

### Install (code-server, Option A)

```sh
make build    # npm install + tsc + bun build webview + vsce pack

docker exec -u "$(id -u):$(id -g)" vscode-hacker-meta-code-server-1 code-server \
  --install-extension "$PWD/build/lamnguyenx.hacker-terminal-enhanced-<version>.vsix" \
  --force \
  --user-data-dir /home/lamnt45/.local/share/code-server \
  --extensions-dir /home/lamnt45/.local/share/code-server/extensions
```

Then **reload the browser tab** so a fresh extension host picks up the new
`out/`. Bump `package.json#version` for a guaranteed fresh extension folder.

### Run the suites

```sh
npm run test:units         # bun pure-logic checks (no host, no compile)
npm run typecheck:webview  # strict tsc over src/webview
npm run typecheck:tests    # strict tsc over tests/ + configs
npm run test:e2e           # or: make test-e2e
# overrides:
CDP_PORT=9024 HACKER_REST_CONTROL_PORT=40620 CODE_SERVER_URL='https://localhost:9620/?folder=/home/lamnt45/git/vscode-hacker-meta' npm run test:e2e
```

## What the tests cover

| Test | What it proves |
| --- | --- |
| first command after a fresh window (activation regression) | `page.reload()` forces a cold extension host; the **first** command of the session is tracked and shows in the popup |
| lists recent commands newest-first and previews the full command | left pane order + right pane preview |
| selecting a row previews it; Enter copies that command's full block | click → preview; `Enter` → clipboard has summary/command/output (and not the other command) |
| arrow keys move the selection | `↑`/`↓` keyboard navigation |
| history survives a window reload | the SQLite store persists across an extension-host restart |
| Esc closes the popup | keyboard dismissal |
| shows an empty state when there is no history | in-popup empty state |
| clearHistory empties an open popup | `terminalEnhanced.clearHistory` + live refresh |

Observed on the reference stack: `8 passed (1.7m)`. The two reload tests are
slow (~37s each); the rest are ~2–6s.

## How the suite works

`playwright.config.ts` → `testDir: ./tests/playwright`, `workers: 1`,
`fullyParallel: false`, 60s default timeout.

| File | Purpose |
| --- | --- |
| `tests/units/history_check.ts` | `firstLine` / `toDisplayItem` (pure). |
| `tests/units/store_check.ts` | SQLite retention, ordering, lazy output, persistence (temp DB). |
| `tests/playwright/rest.ts` | REST Control client: `restCmd`, `restEval`, `restRaw`, `restAvailable`. |
| `tests/playwright/workbench.ts` | connect/CDP, terminal helpers, popup helpers, the clipboard hook. |
| `tests/playwright/terminal-enhanced.spec.ts` | the eight specs. |

### Reaching the popup webview (code-server)

Under code-server a webview panel is **not** a separate CDP target: it is nested
in same-origin iframes inside the workbench page. A two-level `frameLocator`
reaches the extension document:

```js
page.frameLocator('iframe[src*="extensionId=lamnguyenx.hacker-terminal-enhanced"]')
    .frameLocator('iframe')
```

Target inner elements: `.popup`, `.history-row`, `#preview-command`,
`#history-empty`.

### The clipboard oracle is a renderer hook, not `readText`

The pp browser cannot be OS-focused from the test runner, so both
`navigator.clipboard.writeText` and `readText` reject with
**"Document is not focused"** (CDP focus emulation does not help). The
extension host's `vscode.env.clipboard.writeText` is delivered through the
renderer's `navigator.clipboard`, so the suite replaces `writeText` with a hook
that records the payload (`installClipboardSpy`) and asserts on that. The
status-bar echo (`copied command + output`) is the second, UI-level oracle.

### Deterministic commands (avoid the shell-integration race)

Two traps when driving the terminal over REST:

- **`;` splits commands.** Shell integration treats `sleep 0.3; echo X` as two
  executions, so the tracked command line becomes just `sleep 0.3`. Use one
  command.
- **Ultra-fast builtins lose output.** VS Code's `ShellExecutionDataStream`
  drops output that arrives before the consumer's microtask registers — `echo`
  and `printf` are unreliable. An external process, or a command whose output is
  delayed, is captured.

The suite therefore runs:

```sh
bash -c 'sleep 0.3 && echo PW-ONE-$RANDOM'
```

The outer command is a single `bash` invocation, and the 0.3 s delay guarantees
the output arrives after the consumer registers.

- **Output marker trick.** Use a pattern only the *output* can produce
  (`PW-ONE-\d+`) — the echoed command line contains the literal `$RANDOM`.
- **Poll the popup.** The capture is stored just after the terminal paints the
  output; `openHistory()` + `expect(...).toHaveCount(...)` retries, and an open
  popup refreshes automatically via the store's `onDidChange`.

### State hygiene

- Each test starts by `terminalEnhanced.clearHistory` so the persisted DB is
  deterministic; `afterEach` hides the popup, clears history, kills terminals,
  and clears notifications.
- The extension writes to `globalStorage`, which survives runs — always clear
  before asserting absolute counts.

## Gotchas

- **Clipboard reads are browser-gated.** See the hook above; do not use
  `navigator.clipboard.readText()` here.
- **Do not monkeypatch the extension from `custom.eval`.** Assert from outside
  the host — popup DOM + the copied payload.
- **`workbench.action.restartExtensionHost` does not exist** in this build;
  activation resets require `page.reload()` (~25s including REST downtime). Keep
  `test.setTimeout(150_000)` on reload tests.
- **Killing terminals does not close the popup**, and clicking the terminal
  **does** close it (focus-loss dismissal). Open the popup last in a flow.
- **A narrow editor column stacks the panes.** The popup is responsive
  (`@media (max-width: 560px)`); with several editor groups open, assert the DOM,
  not the geometry.

## Known limits

- **The contributed keybinding (`ctrl+alt+shift+c`, `when: terminalFocus`) is not
  covered** — under CDP the key press did not trigger the command while the
  palette/REST path did. The suite invokes `terminalEnhanced.showHistory` over
  REST. Follow-up.
- **The ultra-fast-builtin output race is not fixable from the extension** (it
  is inside VS Code's `ShellExecutionDataStream`). Covered by using delayed
  commands; real external commands are unaffected.
- **Desktop VS Code on old Electron/Node** lacks `node:sqlite`; the reference
  code-server is Node 24. The suite targets code-server.

## Quick reference

| Task | Command |
| --- | --- |
| Build the VSIX | `make build` |
| Install into code-server | `docker exec -u "$(id -u):$(id -g)" vscode-hacker-meta-code-server-1 code-server --install-extension … --force --user-data-dir … --extensions-dir …` + reload tab |
| Pure-logic checks | `npm run test:units` |
| Typecheck | `npm run typecheck:webview && npm run typecheck:tests` |
| Run the E2E suite | `npm run test:e2e` / `make test-e2e` |
| REST probe (ad-hoc) | `curl -s -X POST http://localhost:40620 -H 'Content-Type: application/json' -d '{"command":"custom.eval","args":["1+1"]}'` |
| List CDP targets | `curl -s http://localhost:9024/json/list` |
