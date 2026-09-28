# Restored terminals cannot be read

## Summary

After VS Code is force-quit (or crashes) and session persistence restores the
previously open terminals, **Hacker Terminal Enhanced cannot copy the last command that
ran before the restart**. The next command run in the restored terminal is
captured normally.

This is a hard limitation of the VS Code extension API, not a bug in this
extension. There is **no stable or proposed API** that exposes a restored
terminal's command history or output to extensions.

---

## What actually happens on restore

When VS Code restores a persisted terminal, the full command history *does*
exist inside VS Code's internal layers:

1. **ptyHost serializes everything** during the session, including the
   shell-integration state:
   - `src/vs/platform/terminal/node/ptyService.ts` `generateReplayEvent()`
     includes `commands: this._shellIntegrationAddon.serialize()`.

2. **Renderer pty fires `_onRestoreCommands`** during replay:
   - `src/vs/workbench/contrib/terminal/common/basePty.ts` `handleReplay()`
     writes the buffer, then fires `_onRestoreCommands.fire(e.commands)`.

3. **Terminal instance deserializes** into the xterm shell-integration addon:
   - `src/vs/workbench/contrib/terminal/browser/terminalInstance.ts`:
     `this._processManager.onRestoreCommands(e => this.xterm?.shellIntegration.deserialize(e))`.

4. **`CommandDetectionCapability.deserialize()`** rebuilds the full history and
   fires `onCommandFinished` for every past command:
   - `src/vs/platform/terminal/common/capabilities/commandDetectionCapability.ts`:
     `this._commands.push(newCommand)` then `this._onCommandFinished.fire(newCommand)`.

The reconstructed command objects contain everything we need:
- `ITerminalCommand.command` — the command line
- `ITerminalCommand.getOutput()` — the command's output
- `ITerminalCommand.exitCode`, `.cwd`, `.timestamp`, `.duration`

So the data is there. The problem is that extensions can't reach it.

---

## Why the extension API can't see it

### The events are forward-only

The stable events we listen to are wired through a forward-only multiplexer:

- `src/vs/workbench/contrib/terminal/browser/terminalEvents.ts`
  `createInstanceCapabilityEventMultiplexer`:
  - Attaches to existing instances' capabilities (line ~32), **but only
    subscribes to future `onCommandFinished` events**.
  - It does **not** iterate `capability.commands` to emit past commands.

- `src/vs/workbench/api/browser/mainThreadTerminalShellIntegration.ts`
  bridges the multiplexer's events to the extension host
  (`onDidStartTerminalShellExecution` / `onDidEndTerminalShellExecution`).

Because deserialization's burst of `onCommandFinished` fires **synchronously
during capability rebuild at startup** — before any lazily-activated extension
has subscribed — the events go into the void. Our `onCommandFinished`-equivalent
never fires for restored commands.

### The capability layer is internal-only

The full command history lives on `ICommandDetectionCapability`:

- `src/vs/platform/terminal/common/capabilities/capabilities.ts`:
  - `ICommandDetectionCapability.commands: readonly ITerminalCommand[]` (line 216)
  - `ITerminalCommand.getOutput()` (line 327)

To read it, you'd need `ITerminalInstance.capabilities.get(TerminalCapability.CommandDetection)`.
But `ITerminalInstance` and the entire `capabilities/*` layer are **renderer-internal**
and never cross the extension-host boundary. The extension-side `vscode.Terminal`
is a thin wrapper (`extHostTerminalService.ts`) with no bridge to the renderer's
capability store. There is no import path that exposes
`TerminalCapability.CommandDetection` or `ITerminalCommand`.

### Proposed APIs don't help either

| Proposed API | File | Why it fails |
|---|---|---|
| `onDidExecuteTerminalCommand` (+`output` field) | `vscode.proposed.terminalExecuteCommandEvent.d.ts` | Deprecated. Same forward-only multiplexer wiring as the stable event (`mainThreadTerminalService.ts:240-256`). The replay-time burst is missed by listeners. |
| `onDidWriteTerminalData` | `vscode.proposed.terminalDataWriteEvent.d.ts` | Live raw VT stream only. No replay. Stated as will-not-stabilize for perf reasons. |
| `Terminal.selection` | `vscode.proposed.terminalSelection.d.ts` | Currently-selected text only. No way to programmatically set the selection, so you can't "select all and read". |

VS Code's own internal components even mark replayed commands explicitly:
`src/vs/workbench/contrib/terminalContrib/quickFix/browser/quickFixAddon.ts`
checks `if (...command.wasReplayed) return;` — internal code knows these fired
events are replayed and routinely suppresses them.

---

## The `Terminal.shellIntegration` surface (stable)

After shell integration activates on a restored terminal (which it does, once
the replay completes), the only thing exposed is:

- `terminal.shellIntegration.cwd: Uri | undefined`
- `terminal.shellIntegration.executeCommand(...)` — runs a *new* command

There is no `lastCommand`, no `commands`, no `history`, no `getOutput()` on the
public `TerminalShellIntegration` interface
(`src/vscode-dts/vscode.d.ts:7828-7939`). Past finished commands are discarded
on the extension-host side
(`src/vs/workbench/api/common/extHostTerminalShellIntegration.ts` retains only
`_cwd`, `_env`, and in-flight executions).

---

## Options considered and their verdicts

| Option | Verdict | Notes |
|---|---|---|
| Read restored terminal directly via API | **Impossible** | No stable/proposed API exposes the internal capability data. |
| Eagerly activate (`onStartupFinished`) + listen for replayed events | **Unreliable** | Events fire during synchronous deserialize before listeners attach; `wasReplayed` is suppressed internally. |
| Persist our own per-terminal command log (`globalState`) | **Partial workaround** | Records forward; on reload, read our log. Won't recover the very first post-crash command, and matching a restored terminal to its log has no stable id to key on. |
| Ship inside VS Code core / propose a new API | **Not applicable** | Would require exposing `TerminalShellIntegration.lastCommand`/`commands` backed by `CommandDetectionCapability.commands`. |

### The persistence workaround (rejected for now)

One could persist each captured command to `globalState`, keyed by `(cwd, terminal name)`.
On activation, load the log. A restored terminal would be matched when
shell-integration reports its `cwd`. This covers reloads/restarts where the
extension was already running, but:

1. **No stable terminal id exists** — the stable `Terminal` API has no stable
   unique identifier, so `(cwd, name)` is a fuzzy key that can collide or drift.
2. **The first post-crash command is always lost** — the extension wasn't
   listening when it ran.
3. **Adds complexity** for a narrow gain, with fragile matching.

Given the fuzzy-key problem and the incomplete coverage, this extension
currently documents the limitation rather than ship an unreliable workaround.

---

## What this means in practice

| Scenario | Last command captured? |
|---|---|
| Command runs in a terminal this session | Yes |
| VS Code reloads window, terminal restored, new command runs | Yes (the new one) |
| VS Code force-quit, restored terminal, "copy last" immediately | **No** — nothing captured yet |
| VS Code force-quit, restored terminal, run a new command, then copy | Yes (the new one) |

**Workaround for the user:** after a restore, just re-run the command (or any
no-op like `true`) in the terminal and the extension will capture the next one
normally.

---

## References (VS Code source, `_refs/vscode/`)

| Path | What |
|---|---|
| `src/vscode-dts/vscode.d.ts:7828-7939` | `TerminalShellIntegration` stable surface (cwd + executeCommand only) |
| `src/vscode-dts/vscode.d.ts:11202-11209` | `onDidStart/EndTerminalShellExecution` events |
| `src/vscode-dts/vscode.proposed.terminalExecuteCommandEvent.d.ts` | Deprecated `onDidExecuteTerminalCommand` + `TerminalExecutedCommand.output` |
| `src/vs/workbench/contrib/terminal/browser/terminalEvents.ts:11-71` | Forward-only capability event multiplexer |
| `src/vs/workbench/api/browser/mainThreadTerminalShellIntegration.ts:74-105` | Bridge to ext-host (forward-only) |
| `src/vs/workbench/api/common/extHostTerminalShellIntegration.ts:161-374` | Ext-host keeps no command history |
| `src/vs/platform/terminal/common/capabilities/capabilities.ts:213-332` | Internal `ICommandDetectionCapability` + `ITerminalCommand` (the data we want) |
| `src/vs/platform/terminal/common/capabilities/commandDetectionCapability.ts:471-509` | `deserialize()` — replays commands + fires `onCommandFinished` |
| `src/vs/workbench/contrib/terminal/browser/terminalInstance.ts:924` | `onRestoreCommands` -> `deserialize` |
| `src/vs/platform/terminal/node/ptyService.ts:1082-1108` | `generateReplayEvent` serializes command history |
| `src/vs/workbench/contrib/terminalContrib/quickFix/browser/quickFixAddon.ts:196` | Internal code suppresses replayed commands (`wasReplayed`) |
