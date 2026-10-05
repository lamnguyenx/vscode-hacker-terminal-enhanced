# Terminal Enhanced: `docker logs -f` "(no output)" — supplemental terminal-data capture

**Date:** 2026-10-05
**Status:** DONE (units, 3× typechecks, E2E 15/15 pass; the new regression test
**fails on the pre-fix build with the exact reported symptom** — verified by
rebuilding `HEAD~1` and watching `(no output)` again; VSIX rebuilt and
installed on the reference stack)
**Files changed:** `src/tracker.ts`, `src/ansi.ts`,
`tests/playwright/workbench.ts`, `tests/playwright/terminal-enhanced.spec.ts`,
`README.md`, `docs/important/how-to-test.md`, this doc.

## 1. The symptom

A `docker-compose logs -f` (any `docker logs -f`) running in the terminal
showed up in the history popup as a `running…` row with **`(no output)`** —
and if the terminal was killed, the row finalized with **no output at all**.
Plain commands and even endless `bash -c 'while :; do echo …; done'` loops
streamed fine, which made it look random.

## 2. Investigation (all live, over REST + CDP)

Reproduction loop: REST (`workbench.action.terminal.new` + poll
`activeTerminal.shellIntegration`) → `custom.runInTerminal("docker logs -f …")`
→ poll the store's SQLite via `custom.eval` + `node:sqlite` (read-only).

Results matrix — everything captured **except** `docker logs -f`:

| Command | `execution.read()` |
| --- | --- |
| `bash -c 'sleep 0.3 && echo PW-TEST-$RANDOM'` | ✅ 14 B |
| `bash -c 'while :; do echo OUT-$RANDOM; sleep 0.5; done'` | ✅ streams (98 B @5 s → 233 B @8 s) |
| `docker run --rm busybox sh -c 'while :; do date; sleep 1; done'` | ✅ 1073 B |
| `timeout 5 docker logs --tail 20 -f …` (auto-terminating) | ✅ 1948 B |
| **`docker logs --tail 5 -f …`** (bare follow) | ❌ **0 B after 13 s** (and 0 B after kill) |

The decisive probe: hook `vscode.window.onDidWriteTerminalData` from
`custom.eval`, appending to a file. The follow command's output **does** arrive
as raw terminal data (`TERM[docker] DATA=[03:32:18] [unknown…`) and is painted
by the xterm DOM — `page.locator('.xterm-rows')` shows it — while
`execution.read()` (`ShellExecutionDataStream`) **never yields a single chunk**.

### Root cause

VS Code's shell-integration **data stream** is fed by the pty bytes *as the
shell-integration buffer parses them*. A bare `docker logs -f` is a foreground
process whose output renders in the pty but for which the data stream never
emits chunks (the stream is bound to the OSC 633 command/output bookkeeping;
this class of producer defeats it). Observation-only from our side: the bug is
inside VS Code, not the extension — but its consequence is that *bytes visible
in the terminal never reach the extension*, so the tracker sat on an empty
buffer and `(no output)` was correct-as-coded, broken-as-behaved.

Two aggravating extension-side bugs surfaced while fixing:

1. **Event-driven flush can't see burst-then-quiet producers.**
   `docker logs -f` emits its whole tail in the first ~100 ms and then goes
   silent. A data-event-driven throttle (≥250 ms between events) never fires:
   the first flush lands only on kill. (Not hypothetical — the first fix
   iteration had exactly this hole.)
2. **Concurrent writers can blank each other.** The primary
   (`execution.read()`) and supplemental (raw data) paths both write the row;
   an unconditional `updateOutput("")` from the drained primary stream wiped
   the supplemental output that had already been flushed.

## 3. The fix

### `src/tracker.ts` — a second capture path

`execution.read()` stays the primary path; a **supplemental** path buffers the
same bytes from the terminal's own event:

- **`onDidWriteTerminalData`** (present at runtime, absent from our
  `@types/vscode` — typed locally, bracket access) appends `event.data` to the
  pending capture's `supplementalData` while it is running.
- A **250 ms `setInterval` flush per running capture** (not event-driven!)
  pushes the cleaned buffer to the store. The timer is the point: it flushes
  during the quiet periods that data events can't.
- **`supplementalOutput(raw)`** slices the output region at the shell-
  integration markers — after `OSC 633;C` (command output start), before
  `633;D` (end) — and *then* strips ANSI. Slicing first is what keeps the
  echoed command line ("docker logs -f …") and the markers themselves out of
  the capture; the raw feed contains everything the terminal renders.
- **`writeOutput` (keep-longer guard):** both paths write concurrently; a
  writer only replaces the row when its candidate is at least as long. The
  empty primary drain can no longer wipe flushed supplemental bytes. (The
  eval-based `store.get` per write is fine: flushes are ≤4 Hz per running row.)
- `onEnd`/`onClose` clear the timer and do a final guarded write, so a killed
  follow command **finalizes with its output intact** instead of settling
  empty. The maybe-cancelled path uses whichever of the two outputs is longer.

### `src/ansi.ts` — OSC sequences must be cut at the terminator

The old single-character-class ANSI regex predates OSC-633 traffic; marker
payloads contain `$`, `'`, spaces and `\x3b`-escaped text that walk straight
out of the class (leaking `;docker logs —tail 3 —f …;8cb28f65-…`). Added
`oscRegex` (`ESC ] … (BEL | ESC \)`) applied *before* the CSI regex. The
`[-a-zA-Z…] → [-a-zA-Z… ]` space widening was an earlier attempt; the
terminator-based rule is the real fix (an interim build captured 460 B with a
`;bash -c '…';uuid` prefix baked in — the regression that motivated this).

### What is deliberately *not* done

No scraping of `.xterm-rows` DOM (the webview/renderer side is unreachable
from the extension host), and no parsing of the pty outside VS Code's events.
The supplemental path is the same authority the renderer itself trusts.

## 4. Verification

| Scenario | Before | After |
| --- | --- | --- |
| `docker logs -f` while running | `(no output)` forever | 460 B streaming at t=3 s |
| same, after `killAll` | finalized with 0 B | finalized, output intact, clean |
| quick builtin (`sleep 0.3 && echo`) | 14 B via primary (race-prone) | 15 B, exact, no echo noise |
| sparse loop (1 line/s) | streams | streams progressively, `exit 0` |
| units / typechecks / E2E | — | all pass |

Bonus: the ultra-fast-builtin gap (`echo` losing output to the
`ShellExecutionDataStream` registration race) is *also* compensated by the
supplemental path — the documented workaround ran the risk of the primary
stream dropping the output, which the raw feed survives.

## 5. The regression test

`streams output the shell-integration data stream never yields (docker logs -f)`
(`tests/playwright/terminal-enhanced.spec.ts`), with docker helpers in
`tests/playwright/workbench.ts` (`dockerExec` / `startLogEmitter` /
`removeLogEmitter` — docker runs **inside the code-server container**, over the
host socket, via `node:child_process` from `custom.eval`, so the runner needs
no docker):

1. `docker run -d busybox sh -c 'echo HTE-BOOT-$id; echo HTE-QUIET-$id; sleep 300'`
   — a burst of two lines, then silence: the maximally adversarial shape (the
   data-stream bypass *plus* nothing for an event-driven flush to hang on).
2. `docker logs -f <name>` in the workbench terminal; assert the xterm DOM
   shows `HTE-BOOT` (the terminal *is* painting it).
3. Popup: exactly one row, `running` badge visible, and `HTE-BOOT`/`HTE-QUIET`
   in the output pane **within 4 s — inside the silent window**, so a
   missing-timer-flush implementation cannot pass on the LATE follow-ups.
4. Output must not contain `docker logs` (the echoed command/OSC leakage).
5. `killAll`; badge gone, row finalized, output still intact.

Proven to catch the bug: on the `HEAD~1` (pre-fix) build the test fails with
`locator resolved to <pre id="preview-output" class="preview-output">(no output)</pre>`
— the literal user-visible symptom. On the fixed build it passes in ~6 s.
Suite: `15 passed (~2.6 m)`.

## 6. Notes for future sessions

- `workbench.action.restartExtensionHost` does not exist in this code-server;
  a **container restart + CDP tab re-navigate** is the reliable cold-host
  dance (`Page.navigate` on the tab's WS target keeps the pageId). REST is
  only up **after** a tab connects — poll it, don't sleep.
- `custom.eval` is a full Node sandbox in the ext host: `require('fs')`,
  `node:sqlite`, `node:child_process` all work — handy as an ad-hoc oracle
  (read-only DB queries never fight the writer if you open `{readOnly:true}`
  — reuse the pattern from the test helpers instead of `docker exec` +
  sqlite3, which the container lacks).
- Two code-servers run on this host (`:9620` meta container, `:9120` host
  install), each with its own `globalStorage` → its own `history.sqlite`. The
  ext host at `:9620` writes the DB inside the container FS, which the host
  sees at `exp/code-server/.local/share/code-server/…` via the compose volume.
