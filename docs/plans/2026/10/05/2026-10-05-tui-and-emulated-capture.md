# Terminal Enhanced: full-screen TUIs and an emulated capture engine

**Date:** 2026-10-05
**Status:** DONE (units + 3× typechecks + E2E 17/17 pass on the reference stack;
verified by hand: `gdu` 16 spaces → 1286-char screen, `tig` 612-char mush →
clean commit list; VSIX rebuilt and installed)
**Files changed:** `src/terminalEmulator.ts` (new), `src/tracker.ts`,
`src/settings.ts`, `src/extension.ts`, `package.json` (+ `@xterm/headless`,
new `emulatedCapture` setting, version), `tests/units/emulator_check.ts` (new),
`tests/playwright/workbench.ts`, `tests/playwright/terminal-enhanced.spec.ts`,
`Makefile`, `README.md`, `docs/important/how-to-test.md`, this doc.

## 1. The symptom

`tig` and `gdu` were added to the code-server container. Both are full-screen
TUIs, and both came out of the history popup as garbage:

| Command | Captured output |
| --- | --- |
| `gdu <dir>` | **16 spaces** |
| `tig` | **612 chars** of every frame mashed together (`2026-10-05 14:54 +0700 lamnguyenx o [m2026-10-05…`) |

The user's read was right: a TUI is not a stream of lines, it is a *screen*. The
linear model has no way to represent it.

## 2. Investigation (live, over REST + CDP)

Hooked `onDidWriteTerminalData` from `custom.eval` and drove `gdu`/`tig` in the
code-server terminal. The raw feed has this shape:

```
<ESC>]633;E;<cmd>;<uuid>        ← shell-integration command line
<ESC>]633;C                     ← output start
<ESC>[?1049h … cursor-addressed frames … <ESC>[?1049l
<ESC>]633;D;0                   ← output end / exit code
prompt
```

Alternate screen (`?1049h`/`?1049l`), SGR colors, `[<r>;<c>H` positioning, OSC-8
hyperlinks. Two decisive facts:

1. **`?1049l` (leave alt screen) arrives *before* `]633;D`.** VS Code's end
   event fires after the TUI screen has already been discarded, so serializing
   only at the end captures the restored, empty screen.
2. **Linear stripping cannot represent the screen.** Either the greedy
   `ansiRegex` eats nearly all of the cursor-addressed bytes (gdu → 16 spaces),
   or it leaves every frame concatenated (tig → 612 chars).

### Root cause

"Copy what the TUI is displaying" requires an interpreter that holds the grid,
cursor and alternate buffer. Regexes over raw bytes cannot do it, and VS Code
exposes no screen-buffer API to the extension host (the renderer is
unreachable — established in the history-popup log).

## 3. Why not just fix TUIs — the emulator for everything

The first idea was emulator-only-for-alt-screen. The user asked to make the
emulator the single engine. Measured on a normal command (long line + tab + `\r`
overwrite + 60 lines, terminal 38×33):

| Case | Linear strip | Emulator, full buffer |
| --- | --- | --- |
| 133-char line | 1 line, exact | 1 line — **only** with `isWrapped` re-join |
| `TB\|\t\|` | tab kept | tab → spaces |
| `CR1\rCR2` | two lines | one line (overwrite respected) |
| 60 lines, `scrollback:0` | all | **only the viewport** ❌ |
| 60 lines, big scrollback | all | all ✅ (memory cost) |

Conclusion: emulator-for-all is viable and *better* on `\r`, but it (a) needs a
scrollback sized to hold `maxOutputLength`, (b) expands tabs, (c) must re-join
wrapped rows, and (d) still has two serializers (whole buffer vs viewport).
Accepted, with a setting to roll back.

## 4. The fix

### `src/terminalEmulator.ts` (new) — one pure wrapper over `@xterm/headless`

- No `vscode` import (unit-checked with bun).
- `write(data)`, `whenIdle()` (an empty write's callback is queued behind the
  pending bytes — xterm parses asynchronously), `resize(cols, rows)`,
  `isAlternate`, `serializeViewport()`, `serializeBuffer()`, `dispose()`.
- Serialization right-trims each line and **re-joins soft-wrapped rows** via
  `IBufferLine.isWrapped`, so a long line stays one logical line instead of
  being hard-wrapped at the terminal width. Trailing blank lines are dropped.
- `scrollbackLinesFor(maxOutputLength, columns) = maxOutputLength / columns + 1`
  — xterm stores a full-width row of cells per line regardless of text, so
  bounding the *line count* is what bounds memory (~4 MB per running capture at
  80 cols / 1 MB, and only while a command runs).

### `src/tracker.ts` — the emulator owns capture

- `onDidWriteTerminalData` bytes are fed to a per-capture `TerminalEmulator`,
  but **only the output region**: nothing before `633;C` (the echoed command),
  nothing from `633;D` on (markers/prompt). Markers can be split across chunks,
  so a small tail (`OUTPUT_START_MARKER.length - 1` bytes) is held back until
  they resolve. This replaced the old "slice the whole buffer at the markers"
  with an incremental feed.
- A **250 ms `setInterval`** serializes the emulator and updates the row while a
  command runs. On each tick, an alternate screen is snapshotted as the
  viewport and remembered in `lastAltSnapshot`; normal buffers are serialized in
  full.
- On `onEnd`/`onClose`: `await emulator.whenIdle()`, then prefer
  `lastAltSnapshot` if the alternate screen was ever entered, else the full
  buffer; then `dispose()`. The row is finalized with that text, so a killed
  TUI keeps its last screen.
- Truncation: `maxOutputLength` is enforced on the serialized text, and an
  eviction counter (`fedLines > scrollback + rows`) appends `[output truncated]`.
- The primary `execution.read()` stream is retained as a fallback result and as
  the drain signal (passed `id: undefined` so it never writes in emulated mode).
- `terminalEnhanced.emulatedCapture=false` switches to the previous linear path
  (`execution.read()` + raw supplemental, keep-longer guard) unchanged.

### Runtime APIs that are not in the shipped types

`onDidWriteTerminalData` was already absent from `@types/vscode` (typed
locally). The same is true of **`Terminal.dimensions`** and
**`onDidChangeTerminalDimensions`** — verified present at runtime
(`typeof … === 'function'`, `t.dimensions === {columns:38,rows:34}`) and absent
from the 1.136 typings (and from the vendored VS Code `vscode-dts`, and from
the published API reference). Both are accessed through local types and feed
the emulator's grid; unknown → 80×24.

### What is deliberately *not* done

No scraping of `.xterm-rows` (renderer-unreachable), no per-frame history for
TUIs (the user wants the screen, not the replay), no auto-detection of
"non-alt full-screen" apps (alt screen covers tig/gdu/less/vim/htop).

## 5. Verification

| Scenario | Before | After |
| --- | --- | --- |
| `gdu <dir>` | 16 spaces | 1286-char screen (bars, sizes, `Total disk usage`) |
| `tig` | 612-char frame mush | clean commit list + `[main] Unstaged changes 100%` |
| `docker logs -f` live + kill | supplemental path | emulator path, still streams + survives kill |
| normal command | linear strip | identical (wrapped rows re-joined) |
| `\r` progress | duplicated lines | collapsed to final state |
| units / typechecks / E2E | 15 E2E | **17 passed (2.8m)** |

## 6. The regression tests

- `tests/units/emulator_check.ts` — linear capture, wrapped-line re-join, `\r`
  overwrite, alt-screen detection + viewport, resize, scrollback, line budget.
- `captures the screen a full-screen TUI is displaying (alternate screen)` —
  a synthetic alt-screen app
  (`bash -c 'printf "\033[?1049h\033[2J\033[1;1HTUI-ONE-$RANDOM\033[3;5HTUI-TWO-$RANDOM"; sleep 60'`)
  needs no external TUI. Asserts the painted screen is captured **live**, that
  no `?1049`/`[2J` leak, and that it **survives `killAll`** — which is only
  possible if the screen was snapshotted while the alt buffer was up.
- `linear capture still works when emulation is disabled` — flips
  `terminalEnhanced.emulatedCapture=false` and re-checks the fallback path.

`tig`/`gdu` were used for manual before/after confirmation but are **not**
required by the suite.

## 7. Notes for future sessions

- `Terminal.dimensions` and `onDidChangeTerminalDimensions` are runtime-present
  but untyped; access them via local interfaces, as with
  `onDidWriteTerminalData`.
- The earlier "container restart + tab re-navigate" cold-host dance still
  applies; after installing the VSIX, `Page.navigate({type:'reload'})` on the
  code-server tab boots the new extension host (REST returns within ~20 s).
- `@xterm/headless@6.0.0` is CommonJS (`main: lib-headless/xterm-headless.js`)
  and ships in the VSIX (`node_modules/@xterm/headless`, 5 files). The packaged
  VSIX is ~135 KB.
- A full-buffer `translateToString` every 250 ms is O(n) per tick. `flushEmulated`
  skips when nothing was written (`dirty`), but a very chatty long-running
  stream still re-serializes each tick; if that ever shows up, serialize only the
  viewport plus a dirty-line delta.
