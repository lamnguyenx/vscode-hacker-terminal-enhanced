# How to test Hacker Terminal Enhanced

> **General rules live in the meta repo** —
> [`how-to-test-all.md`](../../../../docs/important/how-to-test-all.md):
> environment choice, the REST-vs-CDP test model, determinism, state hygiene,
> port/path pinning, cache-busting, and flakiness guidance. **Read it first.**
> This document keeps only what is specific to *this* extension: the install,
> the scripts, and the clipboard/terminal gotchas.
>
> Environment / topology (code-server in Docker on nuc, browser on pp, CDP
> 9024): meta repo
> [`dev-code-on-nuc-test-on-pp.md`](../../../../docs/important/dev-code-on-nuc-test-on-pp.md).

Unlike a webview extension, this one has **no webview**: it observes the
integrated terminal and writes the clipboard. There is nothing to click, so the
test model is the playbook's clean split:

```
REST Control → arrange + act   (create terminal, run command, invoke command)
CDP/Playwright → assert only   (status-bar echo, real clipboard, warning toasts)
```

The full write-up (root cause of the activation bug, every dead end) is in
[`docs/plans/2026/09/29/2026-09-29-terminal-enhanced-activation-fix-and-playwright-e2e.md`](../plans/2026/09/29/2026-09-29-terminal-enhanced-activation-fix-and-playwright-e2e.md).

## Prerequisites

- [Bun](https://bun.sh) (used for ad-hoc REST probes; the committed suite runs
  under Playwright/Node)
- Node.js + `npm install` (Playwright + `@playwright/test`)
- **Option A (preferred):** code-server up with this extension installed, and
  the CDP browser reachable on `CDP_PORT` (9024 by default). Setup in the meta
  doc above; REST Control pinned by `HACKER_REST_CONTROL_PORT` (40620).
- **Option B:** a local Extension Development Host on a CDP port. Point
  `CDP_PORT` at it; the same suite works (there is no webview topology to
  detect — it only drives the workbench page and the extension host).

## Option A — code-server (preferred)

### Install

```sh
make build    # npm install + tsc + vsce pack -> build/lamnguyenx.hacker-terminal-enhanced-<version>.vsix

docker exec -u "$(id -u):$(id -g)" vscode-hacker-meta-code-server-1 code-server \
  --install-extension "$PWD/build/lamnguyenx.hacker-terminal-enhanced-<version>.vsix" \
  --force \
  --user-data-dir /home/lamnt45/.local/share/code-server \
  --extensions-dir /home/lamnt45/.local/share/code-server/extensions
```

Then **reload the browser tab** so a fresh extension host picks up
`package.json` (a reload restarts the extension host; the code-server logs show
`Extension Host Process exited … Launched Extension Host Process`). For
extension-host code a `--force` reinstall + reload is enough; the Service-Worker
cache caveat only bites webview JS, which this extension does not ship. Bump
`package.json#version` if you want a guaranteed fresh extension folder.

### Run the E2E suite

```sh
npm run typecheck:tests     # strict typecheck of tests/ + playwright.config.ts
npm run test:e2e            # or: make test-e2e
# overrides:
CDP_PORT=9024 HACKER_REST_CONTROL_PORT=40620 CODE_SERVER_URL='https://localhost:9620/?folder=/home/lamnt45/git/vscode-hacker-meta' npm run test:e2e
```

## What the tests cover

| Test | What it proves |
| --- | --- |
| first command after a fresh window (activation regression) | `page.reload()` forces a cold extension host; the **first** command of the session is captured, the status-bar echo appears, and the clipboard has the summary, command line, output and `Exit Code: 0` |
| captures a non-zero exit code | `false` yields `Exit Code: 1` in the copied block |
| warns when the terminal has no captured command yet | the no-capture warning toast |
| warns when there is no active terminal | the no-terminal warning toast |

Observed on the reference stack: `4 passed (1.2m)`. The first test is slow
(~46s) because of the reload; the rest are ~2–17s.

## How the suite works

`playwright.config.ts` → `testDir: ./tests/playwright`, `workers: 1`,
`fullyParallel: false`, 60s default timeout.

| File | Purpose |
| --- | --- |
| `tests/playwright/rest.ts` | REST Control client: `restCmd` (`executeCommand`), `restEval` (`custom.eval`), `restAvailable`; port from `HACKER_REST_CONTROL_PORT` (40620) |
| `tests/playwright/workbench.ts` | `connectWorkbench()` (`chromium.connectOverCDP`), `reloadWorkbench`, `openTerminal`, `runInTerminal`, `waitForTerminalOutput`, `copyUntilClipboard`, `grantClipboard`, `readClipboard`, `clearNotifications` |
| `tests/playwright/terminal-enhanced.spec.ts` | the four tests |

Key techniques:

- **REST for everything that arranges or acts** — `workbench.action.terminal.new`,
  `workbench.action.terminal.killAll`, `custom.runInTerminal`,
  `terminalEnhanced.copyLast`, `notifications.clearAll`. No command-palette
  automation (the playbook anti-pattern).
- **Terminal readiness** is polled through REST:
  `!!(vscode.window.activeTerminal && vscode.window.activeTerminal.shellIntegration)`.
- **Output marker trick.** Run `echo PW-OUT-$RANDOM`; wait for `/PW-OUT-\d+/`,
  which only the *output* can produce (the echoed command line contains the
  literal `$RANDOM`). This avoids asserting on the command echo.
- **`copyUntilClipboard()` instead of a sleep.** The terminal DOM paints output
  before the extension stores the capture (it stores on shell-integration end +
  `execution.read()` drain), so the helper re-invokes copy until the clipboard
  matches the expected content.
- **Real clipboard as the oracle.** `context.grantPermissions(['clipboard-read',
  'clipboard-write'], { origin })` then `navigator.clipboard.readText()`.

## Gotchas

- **The clipboard's read side is browser-gated.** `writeText` works without a
  gesture; `readText` throws `NotAllowedError` unless the Playwright context
  grants the permission. A combined `writeText(); await readText()` probe can
  *hang* (the read waits forever for permission) — time-box each call and grant
  the permission in tests.
- **Do not monkeypatch the extension from `custom.eval`.** `vscode.env.clipboard`
  is a non-configurable getter, and replacing `vscode.window.setStatusBarMessage`
  does not affect the extension's callback (its `vscode` facade differs). Assert
  from outside the host — page DOM + clipboard.
- **`workbench.action.restartExtensionHost` does not exist** in this build;
  activation resets require `page.reload()` (≈ 25s including REST downtime).
  Keep `test.setTimeout(150_000)` on that test.
- **Force-closing a dirty *untitled* editor prompts a save dialog that blocks the
  awaited REST eval.** Use `workbench.action.revertAndCloseActiveEditor`, or
  dismiss "Don't Save" first.
- **Reload restores terminals but they have no history** — for that reason the
  activation test creates a *new* terminal before running the command. See
  [`restored-terminal-limitation.md`](restored-terminal-limitation.md).
- **State hygiene.** The suite kills all terminals and clears notifications in
  `afterEach`; it does not close the user's editors. Re-running is safe.

## Known limits

- **The contributed keybinding (`ctrl+alt+shift+c`, `when: terminalFocus`) is not
  covered.** Under CDP the key press did not trigger the command while the
  palette/REST path did; detecting it needs `Developer: Toggle Keyboard
  Shortcuts Troubleshooting` and reading the renderer console. Follow-up.
- **Pure-logic checks are not written yet.** `src/format.ts` and `src/ansi.ts`
  have no `vscode` import and could be unit-checked with bun without a host
  (markdown-repo style). Tracked as a possible follow-up.
- **`src/ansi.ts::stripNonPrintable` has a no-op `/\\b/g` replace** (a word
  boundary, not a backspace) — noted, not fixed.

## Quick reference

| Task | Command |
| --- | --- |
| Build the VSIX | `make build` |
| Install into code-server | `docker exec -u "$(id -u):$(id -g)" vscode-hacker-meta-code-server-1 code-server --install-extension … --force --user-data-dir … --extensions-dir …` + reload tab |
| Typecheck the suite | `npm run typecheck:tests` |
| Run the E2E suite | `npm run test:e2e` / `make test-e2e` |
| REST probe (ad-hoc) | `curl -s -X POST http://localhost:40620 -H 'Content-Type: application/json' -d '{"command":"custom.eval","args":["1+1"]}'` |
| List CDP targets | `curl -s http://localhost:9024/json/list` |
| Code-server logs (extension-host restart) | `docker logs --tail 40 vscode-hacker-meta-code-server-1` |
