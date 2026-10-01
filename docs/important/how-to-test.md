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

This extension has nothing to click in the terminal; it observes the
integrated terminal, persists a command history, and shows it in a **webview
panel** (editor/window) or a **docked webview view** (panel/sidebars). The test
model is the playbook's clean split:

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
| first command after a fresh window (activation regression) | `page.reload()` forces a cold extension host; the **first** command of the session is tracked |
| lists recent commands newest-first and previews the full command | left pane order + right pane command, output, and output size |
| selecting a row previews it; Enter copies that command's full block | click → preview; `Enter` → clipboard has summary/command/output + the in-popup "copied" toast |
| arrow keys move the selection | `↑`/`↓` keyboard navigation |
| shows a running command and streams its output | an in-flight command is listed with a `running` badge and its output streams into the right pane |
| ignores a line cancelled with Ctrl+C before it runs | a `^C`-aborted line is not recorded |
| history survives a window reload | the SQLite store persists across an extension-host restart |
| Esc closes the popup | keyboard dismissal |
| shows an empty state when there is no history | in-popup empty state |
| clearHistory empties an open popup | `terminalEnhanced.clearHistory` + live refresh |
| sidebar mode docks the view in the primary sidebar | the view is actually moved into the Activity Bar container |
| panel mode docks the two-pane view in the bottom panel | the view is actually moved into the Panel container |
| secondary sidebar mode docks the view in the auxiliary bar | the view is actually moved into the Secondary Side Bar container |
| closeOnCopy closes the editor panel after copying | `terminalEnhanced.closeOnCopy` dismisses the panel |

Observed on the reference stack: `14 passed (2.7m)`. The two reload tests are
slow (~40s each); the rest are ~3–8s. A cold first run can transiently time
out on `connectOverCDP` — rerun before debugging.

## How the suite works

`playwright.config.ts` → `testDir: ./tests/playwright`, `workers: 1`,
`fullyParallel: false`, 60s default timeout.

| File | Purpose |
| --- | --- |
| `tests/units/history_check.ts` | `firstLine` / `toDisplayItem` (pure). |
| `tests/units/store_check.ts` | SQLite retention, ordering, lazy output, persistence (temp DB). |
| `tests/playwright/rest.ts` | REST Control client: `restCmd`, `restEval`, `restRaw`, `restAvailable`. |
| `tests/playwright/workbench.ts` | connect/CDP, terminal helpers, popup helpers, the clipboard hook. |
| `tests/playwright/terminal-enhanced.spec.ts` | the Playwright specs. |

### Reaching the popup webview (code-server)

Under code-server a webview panel is **not** a separate CDP target: it is nested
in same-origin iframes inside the workbench page. A two-level `frameLocator`
reaches the extension document:

```js
page.frameLocator('iframe[src*="extensionId=lamnguyenx.hacker-terminal-enhanced"]')
    .frameLocator('iframe')
```

Target inner elements: `.popup`, `.history-row`, `.history-running`,
`#preview-command`, `#preview-output`, `#preview-output-size`,
`#preview-output-scroll`, `#copied-toast`, `#history-empty`. Output lines:
`.output-line` > `.output-num` (gutter) + `.output-text`; state classes on
`#preview-output-scroll` — `nowrap` (Alt+Z off) and `scrollable` (content
overflows; absent ⇒ `overflow: hidden`).

### Live (running) commands

`tail -f`-style commands never fire `onDidEndTerminalShellExecution`, so the
tracker records a row on **start** (`store.startRunning`), appends output on a
~250 ms throttle (`store.updateOutput`), and finalizes it on end **or** terminal
close (`onDidCloseTerminal`). Leftover `running` rows from a crashed/closed host
are settled at store construction. The test drives an endless
`bash -c 'while :; do echo ONGOING-$RANDOM; sleep 0.4; done'` (a single
outer command — the `;`s live inside the quoted child script, so shell
integration still sees one execution).

### Ctrl+C-cancelled lines (shell-integration quirk)

Pressing Ctrl+C on a line that was typed but **not** run still emits a
`onDidStartTerminalShellExecution`/`onDidEndTerminalShellExecution` pair. It is
reported as **high confidence and trusted**, with no output and no exit code,
and the command line carries the terminal's echoed `^C` (`tail -f^C`, or just
`^C` at an empty prompt). The tracker must not persist these, so a line matching
`hasCancelMarker` is held back and only committed if it turns out to have run
(produced output or reported an exit code) — which keeps a genuine
`echo ^C` while dropping the aborted line. Reproduce with
`sendSequence('tail -f')` then `sendSequence('\u0003')`.

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

### Display modes

`terminalEnhanced.historyDisplay` selects the presentation. The suite pins it
per test (Global snapshot in `beforeAll`, restore in `afterAll`).

- **`editor` (default)** — a `WebviewPanel` in the editor area. It no longer
  auto-dismisses; `terminalEnhanced.closeOnCopy` controls closing on copy.
- **`panel` / `sidebar` / `secondarySidebar`** — one webview **view**, moved to
  the target container with the internal `vscode.moveViews` command and then
  focused. It is gated by a `setContext` key (`terminalEnhanced.display`) so it
  stays hidden in `editor`/`window` modes.
- **`window`** — the editor panel is moved with
  `workbench.action.moveEditorToNewWindow`; not covered by the suite (see
  known limits).

Placement is asserted on the workbench chrome, not just the webview DOM:
`.part.panel`, `.part.sidebar`, `.part.auxiliarybar` composite titles.

Two traps found building this:

- **View container ids are prefixed.** A `viewsContainers` id `foo` registers
  as `workbench.view.extension.foo`; `vscode.moveViews` needs the **prefixed**
  id or it silently no-ops. Container ids must also match `^[A-Za-z0-9_-]+$`
  (no dots), and the secondary-sidebar location key is `secondarySidebar`.
- **`when: config.<setting> == …` is not reactive** for view visibility (the
  view stayed visible after the setting changed). Use a `setContext` key and
  update it on config change instead.

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
- **Know which writer owns the DB.** More than one code-server can run on this
  host (the meta container on `:9620`, a host install on `:9120`), each with its
  own `globalStorage` → its own `history.sqlite`. If commands "don't show up",
  first ask which instance the terminal belongs to and which file it wrote —
  check `docker logs` + `ss -ltnp` + each `globalStorage` dir mtime.
- **After a code-server (re)start the extension host is not running** until a
  workbench tab connects — REST is down and nothing is captured. Reload the
  browser tab first, then wonder.

## Known limits

- **The contributed keybinding (`ctrl+alt+shift+c`, `when: terminalFocus`) is not
  covered** — under CDP the key press did not trigger the command while the
  palette/REST path did. The suite invokes `terminalEnhanced.showHistory` over
  REST. Follow-up.
- **`window` display mode is not covered.** code-server runs in a browser tab
  and cannot move an editor to a separate OS window, so the command falls back
  to the editor area. Verify `window` on a desktop VS Code build by hand.
- **The ultra-fast-builtin output race is not fixable from the extension** (it
  is inside VS Code's `ShellExecutionDataStream`). Covered by using delayed
  commands; real external commands are unaffected.
- **Desktop VS Code on old Electron/Node** lacks `node:sqlite`; the reference
  code-server is Node 24. The suite targets code-server.

## Browser dev harness (UI iteration)

For visual iteration use the harness instead of the VSIX loop — it serves the
**real** `media/popup.*` + shared document markup in a plain browser against a
read-only mirror of the history DB, with hot reload (`bun build --watch` + an
SSE `reload`/`items` push). See the README "Browser dev harness" section, the
meta repo `docker-compose.yml` service
(`lamnguyenx.hacker-terminal-enhanced-webview-dev`), and the plan doc
[`2026-10-01-live-output-and-dev-harness.md`](../plans/2026/10/01/2026-10-01-live-output-and-dev-harness.md).
Harness gotchas learned the hard way:

- **Bun's default 10 s `idleTimeout` silently severs SSE** — use a heartbeat
  frame + `idleTimeout: 255` (already in `scripts/dev-webview.ts`).
- **Build the HTML per request**, or markup edits won't hot-apply.
- `bun --watch` is content-based — `touch` doesn't trigger it; test with a real
  (revertible) edit.
- The shim's `/api/copied` returns the exact `formatExecution` block; clipboard
  writes need the page focused (localhost is a secure context).

## Quick reference

| Task | Command |
| --- | --- |
| Build the VSIX | `make build` |
| Install into code-server | `docker exec -u "$(id -u):$(id -g)" vscode-hacker-meta-code-server-1 code-server --install-extension … --force --user-data-dir … --extensions-dir …` + reload tab |
| Pure-logic checks | `npm run test:units` |
| Typecheck | `npm run typecheck:webview && npm run typecheck:tests` |
| Run the E2E suite | `npm run test:e2e` / `make test-e2e` |
| Harness (host) | `make dev-webview` → http://localhost:5199 |
| Harness (container) | `docker compose -f ../../docker-compose.yml up -d lamnguyenx.hacker-terminal-enhanced-webview-dev` |
| REST probe (ad-hoc) | `curl -s -X POST http://localhost:40620 -H 'Content-Type: application/json' -d '{"command":"custom.eval","args":["1+1"]}'` |
| List CDP targets | `curl -s http://localhost:9024/json/list` |
