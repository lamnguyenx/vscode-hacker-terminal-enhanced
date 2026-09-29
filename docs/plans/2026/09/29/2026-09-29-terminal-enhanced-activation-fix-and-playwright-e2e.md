# Terminal Enhanced: first-use capture fix + Playwright E2E suite

**Date:** 2026-09-29
**Status:** DONE (manual REST/CDP checks pass; Playwright E2E `4 passed`; `npm run typecheck:tests` clean)
**Files changed:** `package.json`, `Makefile`, `.gitignore`, `.vscodeignore`, `README.md`,
`playwright.config.ts` (new), `tsconfig.tests.json` (new),
`tests/playwright/rest.ts` (new), `tests/playwright/workbench.ts` (new),
`tests/playwright/terminal-enhanced.spec.ts` (new), `docs/important/how-to-test.md` (new),
this plan doc.

## Context

The extension was reported as "not working nicely". The environment is the meta
repo's code-server stack:

```
nuc: opencode + chrome-devtools MCP ──ssh LocalForward──▶ pp:9024 (Vivaldi CDP)
pp : browser opens https://localhost:9620 ──ssh RemoteForward──▶ nuc docker code-server
```

with the REST Control extension answering on `HACKER_REST_CONTROL_PORT=40620`.
Environment/topology: meta repo
`docs/important/dev-code-on-nuc-test-on-pp.md`; testing model:
meta repo `docs/important/how-to-test-all.md`.

The installed extension (`lamnguyenx.hacker-terminal-enhanced-2026.9.3`) was a
copy built on Sep 8 — but it was **byte-identical** to the current `out/`, so
this was not a stale-install problem. It was a real behavior bug.

## Root cause — the first command of every session was never captured

`package.json` declared only:

```json
"activationEvents": ["onCommand:terminalEnhanced.copyLast"]
```

The tracker registers `onDidStartTerminalShellExecution` /
`onDidEndTerminalShellExecution` inside `activate()`. With an on-command-only
activation the timeline was:

1. User runs a command in the terminal → extension **inactive** → nothing tracked.
2. User invokes *Copy Last Command and Output* → **this is what activates the
   extension** → `getCaptured()` is empty → warning toast, nothing copied.
3. Only *later* commands are captured, and every new window resets the cycle.

Reproduced over REST + CDP `9024` before the fix:

```
before invoke: {"extActive":false,"activeTerminal":"bash","shellIntegration":true}
after invoke : {"extActive":true,"captured":null}          ← warning path
next command : {"extActive":true,"captured":"…SUMMARY…"}   ← works only now
```

## Fix

`package.json` — activate the tracker at window startup:

```diff
 	"activationEvents": [
+		"onStartupFinished",
 		"onCommand:terminalEnhanced.copyLast"
 	],
```

The pre-existing limitation is unchanged: the stable API still has no
retroactive buffer read, so **restored terminals** have no history until a new
command runs (see
[`restored-terminal-limitation.md`](../../../../important/restored-terminal-limitation.md)).
`onStartupFinished` only removes the "first live command of the session is
missed" gap.

## Install (code-server, Docker)

The user chose the VSIX-install route (no `docker-compose.yml` change). Build
and force-install into the running container, matching the container's UID/GID:

```sh
make build    # npm install + tsc + vsce pack -> build/lamnguyenx.hacker-terminal-enhanced-2026.9.3.vsix

docker exec -u 1000:1000 vscode-hacker-meta-code-server-1 code-server \
  --install-extension /home/lamnt45/git/vscode-hacker-meta/_submodules/vscode-hacker-terminal-enhanced/build/lamnguyenx.hacker-terminal-enhanced-2026.9.3.vsix \
  --force \
  --user-data-dir /home/lamnt45/.local/share/code-server \
  --extensions-dir /home/lamnt45/.local/share/code-server/extensions
```

Then reload the browser tab over CDP so a fresh extension host picks up the new
`activationEvents`. A reload restarts the extension host (confirmed in
`docker logs`: `Extension Host Process exited … New connection … Launched
Extension Host Process`). Same-version force-install + reload was sufficient;
no `version` bump was needed for extension-host code (the Service-Worker cache
caveat applies to webview JS, which this extension does not ship).

## Manual verification (REST → act, CDP → assert)

A throwaway bun client (not committed; patterns reused by the committed suite)
drove the extension host over REST and read state back. After the fix:

```
startup      : {"extActive":true,…}                       ← auto-activated
first-use    : captured "…SUMMARY…\necho TE-FIRST-…"       ← first command captured
clipboard    : browser clipboard received the 404-char block
exit-code    : "Exit Code: 1" for `false`
status bar   : "Hacker Terminal Enhanced: copied last command + output"
```

`vscode.env.clipboard.writeText` works under code-server. `readText` is
**denied by the browser** (`NotAllowedError`) — that is a browser permission
policy, not an extension bug. The clipboard content was proven by hooking the
page's `navigator.clipboard.writeText`.

## Playwright E2E suite

Following the markdown repo's Playwright conventions (`playwright.config.ts` +
`tests/playwright/`), but with the meta playbook's split: **REST arranges/acts,
the browser only asserts** (there is no webview to click here).

```
playwright.config.ts                          testDir ./tests/playwright, workers 1, timeout 60s
tsconfig.tests.json                           strict noEmit typecheck for the suite (lib: DOM for clipboard)
tests/playwright/rest.ts                      REST Control client (restCmd / restEval / restAvailable)
tests/playwright/workbench.ts                 connectOverCDP + terminal helpers (all REST-driven)
tests/playwright/terminal-enhanced.spec.ts    the four specs
```

Helpers of note:

| Helper | Role |
| --- | --- |
| `connectWorkbench()` | `chromium.connectOverCDP('…:9024')`, find/create the `localhost:9620` page, wait for `.monaco-workbench` |
| `reloadWorkbench(page)` | `page.reload()` → wait workbench → `waitForRest()` (used by the activation test) |
| `openTerminal(page)` | REST `workbench.action.terminal.{killAll,new}`, then poll `activeTerminal.shellIntegration` |
| `runInTerminal(cmd)` | REST `custom.runInTerminal` |
| `waitForTerminalOutput(page, re)` | Playwright poll on `.xterm-rows` (output-only pattern) |
| `copyUntilClipboard(page, match)` | re-invoke `terminalEnhanced.copyLast` until the clipboard matches (capture lands just after output paints) |
| `grantClipboard(page)` | `context.grantPermissions(['clipboard-read','clipboard-write'])` so the test reads the real clipboard |

Tests and observed timings (after a warm run):

| Test | Assert |
| --- | --- |
| first command after a fresh window (activation regression) — 46s | reload forces a cold extension host; first command is captured; status echo; clipboard has summary/command/output/`Exit Code: 0` |
| captures a non-zero exit code — 17s | clipboard `Exit Code: 1` for `false` |
| warns when the terminal has no captured command yet — 5s | `.notifications-toasts` shows the no-capture warning |
| warns when there is no active terminal — 2s | no-terminal warning |

Full run: **`4 passed (1.2m)`**.

## Trials, errors and dead ends

These cost real time; recording them so the next person skips them.

1. **Command palette automation first (wrong tool).** The first Playwright
   prototype opened the terminal and invoked the extension through `F1` →
   quick-input. It worked, but it is exactly the anti-pattern the meta playbook
   warns about, and the user pushed back: the extension host is reachable over
   REST, so palette timing/fuzzy-matching is unnecessary risk. Rewrote all
   arrange/act through `rest.ts`. *Lesson: with a control API available, the
   palette is only for testing the palette.*

2. **The contributed keybinding didn't fire under CDP.** Pressing
   `Control+Alt+Shift+C` (the Linux binding, `when: terminalFocus`) while
   `page.locator('.xterm-screen')` was clicked produced no command, while the
   palette path immediately wrote the clipboard. Not pursued once REST was the
   chosen act path; the keybinding is therefore *not* covered by the suite. A
   dedicated test (key-troubleshooting log) is a possible follow-up.

3. **"Clipboard hangs" was a false alarm.** An early REST eval that did
   `writeText(marker); await readText()` never returned. The hang was the
   *read*, not the write: `navigator.clipboard.readText()` waits for a
   permission the renderer is never granted. Splitting the calls showed
   `writeText` resolves fine. *Lesson: time-box each clipboard call; a
   combined write+read dead-ends.*

4. **Cross-extension monkeypatching does not work.** Trying to instrument the
   extension from the REST extension's `custom.eval`:
   - `vscode.env.clipboard` is a **non-configurable getter** —
     `Object.defineProperty` throws ("Cannot redefine property").
   - Replacing `vscode.window.setStatusBarMessage` worked for *our* calls but the
     extension's callback still bypassed it (the patch did not cross the
     extension boundary), even though the status message *did* render.
   Assert the outside instead: the page DOM (`.statusbar-item`,
   `.notifications-toasts`) and the real clipboard. *Lesson: state inside
   another extension host is not patchable — treat the extension as a black box.*

5. **Output is painted before the capture is stored.** `waitForTerminalOutput`
   saw `PW-OUT-123`, but an immediate copy returned `(no output)`: xterm paints
   when the pty writes, while the extension stores the capture only after shell
   integration reports the execution ended and `execution.read()` drains.
   Fixed with `copyUntilClipboard()` polling instead of a guessed sleep.

6. **A full window reload is expensive (~25s REST-down).** The activation
   regression needs a cold extension host. `workbench.action.restartExtensionHost`
   does **not exist** in this build (only `workbench.action.reloadWindow`), so
   the test forces a fresh host with `page.reload()`: ~7s reload + ~15s until
   REST answers again. The test sets `test.setTimeout(150_000)`; when it
   previously hit the 60s cap it left the host busy and made the *following*
   tests 3× slower. Keep the generous per-test timeout.

7. **Force-closing a dirty untitled editor blocks REST.** A cleanup eval called
   `vscode.window.tabGroups.close(tabs, true)` on the leftover untitled buffer;
   code-server still raises the "Do you want to save?" dialog, and the awaited
   `close()` never resolves, so the REST request (and my shell command) hung
   until "Don't Save" was clicked. Use `workbench.action.revertAndCloseActiveEditor`
   for dirty editors, or dismiss the dialog first. (The meta playbook says this;
   it is easy to rediscover.)

8. **Never-resolving promise in the Code Mode tool.** A scratch `execute` block
   ended with `await new Promise(() => {})`; the MCP call was cancelled ("Tool
   execution interrupted") even though the workbench was fine. *Lesson: no
   `setTimeout`/never-settling promises in the Code Mode runtime — split probes
   into separate calls.*

9. **Found but not fixed:** `src/ansi.ts::stripNonPrintable` has
   `.replace(/\b/g, '')`. `\b` is a *word-boundary* assertion, not a backspace —
   the replace is a no-op. Probably intended `[\b]` / `\x08`. Left as-is (out of
   scope); worth a follow-up if terminal backspaces ever corrupt captured output.

## Verification

```sh
npm run typecheck:tests                          # clean
npm run test:e2e                                 # 4 passed (1.2m)
make test-e2e                                    # same, via Makefile (CDP_PORT=9024)
```

The four manual checks (first-use capture, clipboard content, exit code, status
echo) all passed before the Playwright port; the suite is their faithful
automation.

## Lessons

- **Activation events are behavior.** An on-command-only activation makes a
  listener-only extension silently miss everything that happens before first
  use. If the feature is "observe the terminal", it must be alive at
  `onStartupFinished`.
- **The bug was invisible in a warm host.** Because the extension stays active
  once invoked, it "works on the second try" — the only way to see it is a fresh
  window (or the reload the regression test now performs).
- **The terminal is a poor completion oracle.** The DOM shows output before the
  extension has stored the execution; poll the actual copied artifact, don't
  trust paint order.
- **The clipboard's read side is browser-gated.** `writeText` works headlessly;
  `readText` needs an explicit permission (grant it in Playwright) and hangs
  rather than rejecting cleanly when it doesn't have it.
- **REST > palette for act; DOM/clipboard for assert.** Deterministic commands
  removed an entire class of flake, and the only browser assertions left are the
  genuinely user-visible ones.
