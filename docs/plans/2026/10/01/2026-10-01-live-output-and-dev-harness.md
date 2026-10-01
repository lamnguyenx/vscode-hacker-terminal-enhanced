# Terminal Enhanced: live output, output pane, dev harness, visual polish

**Date:** 2026-10-01
**Status:** DONE (units pass; `14 passed` E2E; typechecks clean; VSIX built and
installed on the reference stack; browser dev harness verified end-to-end via
CDP)
**Files added:** `src/historyMarkup.ts`, `src/historyMessages.ts`,
`scripts/dev-webview.ts`, `dev/theme.css`, `dev/client.js`, this doc.
**Files changed:** `src/format.ts`, `src/history.ts`, `src/historyWebview.ts`,
`src/store.ts`, `src/tracker.ts`, `src/webview/popup.ts`, `media/popup.css`,
`package.json`, `Makefile`, `.vscodeignore`, `tsconfig.webview.json`,
`tests/units/history_check.ts`, `tests/units/store_check.ts`,
`tests/playwright/workbench.ts`, `tests/playwright/terminal-enhanced.spec.ts`,
`README.md`, `docs/important/how-to-test.md`, the **meta repo's**
`docker-compose.yml` (harness service added).

Four work streams, in order: (1) show the output in the right pane, (2)
long-running/live commands, (3) a hot-reloadable browser dev harness, (4)
visual polish (copied cue, padding, output size, line numbers, wrap toggle,
smart scrollbar). One production bug (Ctrl+C-cancelled lines) was found by the
user and fixed along the way.

## 1. Output in the right pane

The list message carries metadata only (an output can be ~1 MB), so the pane
fetches on demand:

- Webview → host: `{type:'preview', id}` on selection change.
- Host → webview: `{type:'output', id, output, length}` via the lazy
  `store.get(id)`.
- Webview caches by id and shows `Loading output…` / `(no output)` states.
  A stale response is ignored by checking the id against the selection, so
  fast arrowing never renders the wrong output.

## 2. Live (running) commands — `tail -f` support

Previously a row was written only on `onDidEndTerminalShellExecution`, so
`tail -f` appeared only after it died (if ever). Now:

- `store.startRunning()` inserts a `running=1` row at execution **start**.
- `collectOutput()` flushes the stripped buffer to the row on a **250 ms
  throttle** while streaming.
- `onDidEnd` awaits the final drain, then `finish(id, exitCode, now)`.
- `onDidCloseTerminal` settles a row whose terminal vanished; leftover
  `running=1` rows are settled at store construction (a restart cannot resume
  an execution).
- `list()` exposes `running` and `length(output) AS outputLength` (cheap,
  never reads the blob), so the webview knows when to re-fetch.
- Webview: pulsing `● running` badge, `exit: running…` in the meta, and the
  **selection is preserved across live refreshes** (a store emit used to reset
  it to the top row — fatal while you watch a `tail -f` at position 5).
- Schema: `running INTEGER NOT NULL DEFAULT 0` + `ALTER TABLE` migration for
  old DBs, and `formatExecution` prints `Exit Code: running` for in-flight
  rows.

### Right pane layout

`preview` became a flex column: a **non-scrolling header** (command, meta
`dl`, the `OUTPUT <size>` label) over a **scrollable output** div with a thin
themed scrollbar. The output follows its tail (scroll to bottom on selection
change, and while the user is within 40 px of the bottom); scrolling up to
read stops the hijack.

### The Ctrl+C quirk (production bug, user-reported)

Typing `tail -f` and pressing **Ctrl+C without Enter** still emits a full
start+end execution pair. Inspection via a temporary REST hook showed the
aborted line arrives as **high confidence (`conf: 2`) and trusted** — the API
gives no signal that it never ran. The only tell is the terminal's echoed
`^C` marker in the command line (`tail -f^C`, or bare `^C` on an empty
prompt), with no output and no exit code.

Fix: `hasCancelMarker()` (pure, in `history.ts`). A marked line is **held
back** — not persisted at start, output buffered without DB writes — and only
committed on end **if it actually did something** (produced output or reported
an exit code). That keeps a genuine `echo ^C` (which prints) while dropping
the aborted line. Blank lines (bare Enter) are skipped outright.

## 3. Browser dev harness

Rebuilding + reinstalling + reloading the workbench for every CSS tweak is
too slow. The harness serves the **real** panel in a plain browser:

```
popup.js (real bundle) ←postMessage— dev/client.js shim —fetch/SSE— Bun server
                                                            │ read-only
                                                            ▼
                                                    history.sqlite (real)
```

Single source of truth (the point of the exercise):

| Shared piece | Where it lives |
| --- | --- |
| Wire types (`DisplayItem`, messages) | `src/historyMessages.ts` |
| Popup document/body markup | `src/historyMarkup.ts` (`buildHistoryDocument`) |
| Queries + lazy output + toDisplayItem + formatExecution | `src/store.ts`, `src/history.ts`, `src/format.ts` |
| `HistoryStore(..., {readOnly: true})` | same store class, writes become no-ops |

`scripts/dev-webview.ts` (bun, zero npm deps): serves `/`, `/media/*`,
`/dev/*`, `/api/items`, `/api/output?id=`, `/api/copied?id=` (the exact
`formatExecution` block), and SSE `/events`. It spawns `bun build --watch`,
watches `media/` and broadcasts `reload`; polls the DB every 500 ms and
broadcasts `items` on change. `dev/client.js` shims `acquireVsCodeApi()` and
bridges `copy` to `navigator.clipboard`. `dev/theme.css` supplies concrete
`--vscode-*` values (dark+/light) a bare browser doesn't have.

Containerized in the **meta repo's** `docker-compose.yml` (moved there from
the submodule at the user's request) as
`lamnguyenx.hacker-terminal-enhanced-webview-dev` — ws-scrcpy pattern: host
networking, host UID/GID, bind-mounted checkout, pinned `oven/bun:1.4.0`,
nothing built inside. The whole `globalStorage` extension dir is mounted
read-only so SQLite can see the WAL `-wal`/`-shm` sidecars.

## 4. Visual polish

- **Padding** tightened: `clamp(16px, 6vw, 64px)` → `clamp(8px, 1.5vw, 20px)`,
  `max-width` 1100→1400px.
- **Copied cue**: host confirms with `{type:'copied', id}`; the view shows a
  centered pill toast (✓ Copied command + output, 2.5 s) **and** flashes the
  row green (0.8 s). The status-bar echo remains as a second signal.
- **Output size** next to the `OUTPUT` label (byte-accurate via `Blob`, B/KB/MB).
- **Line numbers**: per-line rows with a right-aligned, non-selectable gutter
  (`--vscode-editorLineNumber-foreground`); wrapped continuation stays under
  its number. Single-line outputs and outputs over **5000 lines** render
  plain (per-line DOM would freeze on a 1 MB capture).
- **Alt+Z** toggles wrap (matched on `event.code === 'KeyZ'` — layout-safe —
  guarded against Ctrl/Cmd). Off ⇒ lines extend and the pane scrolls
  horizontally. Persisted via webview `setState`. Footer hint added.
- **Smart scrollbar**: `.scrollable` toggles `overflow: auto ↔ hidden`, so the
  scrollbar exists exactly while the content overflows and no gutter space is
  reserved otherwise. Re-checked on render, on toggle, and via
  `ResizeObserver`.

## Trials, errors, and lessons

### Trials that failed (and what they taught)

1. **`commandLine.confidence`/`isTrusted` to detect aborted lines** — dead
   end: the Ctrl+C'd line reports High confidence + trusted, same as a real
   command. Lesson: when the platform signal doesn't discriminate, mine the
   payload (the echoed `^C`) but treat it as a *hint* and confirm with a
   second signal (output/exit-code) before acting.
2. **`new DatabaseSync(path, undefined)`** — Bun throws
   `ERR_INVALID_ARG_TYPE` on an explicit `undefined` options object. Lesson:
   don't pass "optional" objects explicitly; branch the call.
3. **`pkill -f "bun scripts/dev-webview.ts"`** — killed the invoking shell
   too (the pattern matched the `bash -c` command line itself). Lesson:
   enumerate with `pgrep -x bun` + `/proc/<pid>/cmdline` filtering, or kill by
   exact PID.
4. **`touch src/webview/popup.ts` to test `bun --watch`** — no rebuild: the
   watcher is content-based, mtime-only changes don't fire it. Lesson:
   verify hot-reload with a real (revertible) content change.
5. **Playwright `connectOverCDP` from ad-hoc scripts** — hung/timed out
   outside the test runner (30 s), even though the same call passes in-suite;
   one E2E run also flaked on it once and passed on retry. Lesson: for
   one-off browser assertions prefer the CDP MCP
   (`evaluate_script`/`new_page`); treat first-run connect timeouts as
   transient and rerun before debugging.
6. **Bun's default 10 s `idleTimeout`** — found in the harness container logs:
   `Bun.serve() timed out a request after 10 seconds`. It was **silently
   severing the SSE stream** (`/events`), which would have looked like "live
   updates randomly stop". Fix: 20 s heartbeat frames + `idleTimeout: 255` +
   `X-Accel-Buffering: no`. Lesson: read the container logs when adding a
   long-lived connection; a quiet SSE drop is invisible from the client.
7. **Harness HTML built once at startup** — a markup edit didn't appear live
   because the document string was computed at boot. Fix: build the HTML per
   request. Lesson: in a hot-reload harness, nothing that embeds source should
   be cached at startup.

### The "my commands don't show up" mystery (twice)

Both times the harness was **correctly** mirroring the DB — the capture chain
was the issue:

- **Case 1 — extension host not running.** The code-server container had been
  restarted; the extension host only launches when a workbench tab connects.
  REST (`:40620`) was down and nothing was being captured until the tab was
  reloaded (`docker logs` showed `ExtensionHostConnection` starting ~2.5 min
  after container start). Lesson: after restarting code-server, reload the
  workbench tab; the harness now logs `rows: N` at boot with a hint.
- **Case 2 — two code-servers, two DBs.** A long-running host code-server
  (`~/Downloads/code-server-4.139.1`, `:9120`) coexists with the meta
  container (`:9620`). Each has its own `globalStorage` → two `history.sqlite`
  files. The user's `ls -ltr` landed in the **host** DB
  (`~/.local/share/code-server/...`) while the harness mirrors the
  **container** DB (`<meta>/exp/code-server/...`). Lesson: before debugging a
  mirror, ask *which writer* produced the data — check for sibling processes
  and per-instance data dirs. (Left as-is per user: pin with `HTE_DB` if the
  other DB is wanted.)

### Smaller notes

- SQLite string literals: `"unixepoch"` in double quotes is parsed as a
  column (Bun's better-sqlite3-compatible parser errors helpfully); keep
  double quotes for identifiers only, or format dates in JS.
- The E2E DB ends up with seed rows after live-verify sessions; tests always
  `clearHistory` first, but don't be surprised by leftover rows.
- `docker compose` project names come from the directory: after moving the
  compose file, the old container (`hte-webview-dev` from the submodule
  project) conflicts with the new one — remove stale containers after a move,
  and prefer `<extension-id>-webview-dev` names so ownership is obvious.
- `Enter`/`Escape` still mean copy/close everywhere; new keys must go through
  the same `keydown` switch with `preventDefault` to keep webview focus.

## Testing

- Units: `hasCancelMarker`, running-field mapping, `startRunning`/
  `updateOutput`/`finish`, stale-running settle. All pass (`bun tests/units`).
- E2E: 14 tests including the new *streams its output* (endless
  `while :; do echo …; done`) and *ignores a Ctrl+C-cancelled line*
  (`sendSequence('tail -f')` then `sendSequence('\u0003')`). Observed
  `14 passed (2.7m)` on the reference stack. `previewOutputSize` (regex
  `\d+ (B|KB|MB)`) and `copiedToast` assertions cover the new visuals.
- Harness verified over CDP: rows/command/output/size, copy toast, running
  badge + live streaming, Alt+Z horizontal overflow (2684 px on a 400-char
  line), `scrollable=false` on a short row, footer hint, hot reload (CSS and
  TS), SSE surviving idle.
