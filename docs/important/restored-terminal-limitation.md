# Restored terminals cannot be read

## Summary

VS Code exposes **no** stable or proposed API that lets an extension read a
restored terminal's command history or output. The data exists inside VS Code
(it is replayed into the shell-integration capability) but never crosses the
extension-host boundary.

**The impact on this extension is now largely mitigated.** Hacker Terminal
Enhanced keeps its own **global, persisted** command history in SQLite
(`globalStorage`), independent of VS Code's terminal buffers. After a force-quit
or crash, the popup still lists the last commands that ran before the restart —
they come from the extension's own store, not from the restored terminal.

What remains impossible is reading a restored terminal's own scrollback/command
data directly. The rest of this document explains why, so the boundary is clear.

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
| Persist our own command log | **Implemented** | A global SQLite history in `globalStorage` (see below); after a restore the popup lists the last commands without reading the terminal. |
| Ship inside VS Code core / propose a new API | **Not applicable** | Would require exposing `TerminalShellIntegration.lastCommand`/`commands` backed by `CommandDetectionCapability.commands`. |

### The persistence workaround (implemented)

The extension persists each finished command to `globalStorage`
(`history.sqlite`, via the built-in `node:sqlite`). Because the history is
**global** rather than keyed per terminal, there is no fuzzy
`(cwd, terminal name)` matching problem — the popup simply shows the last
`terminalEnhanced.historySize` commands from the store, regardless of which
terminal (or session) produced them. A restored terminal therefore does not need
to be identified or read: its pre-restart commands are already in the store.

The one thing this does **not** recover is the following edge: a command that ran
*before the extension ever started* (e.g. the extension was activated after the
command), or output lost to the shell-integration streaming race (see
[`how-to-test.md`](how-to-test.md) §deterministic commands). In normal use every
command run while the extension host is alive is recorded.

---

## What this means in practice

| Scenario | In the popup? |
|---|---|
| Command runs in a terminal this session | Yes |
| VS Code reloads window, terminal restored | Yes — the pre-reload commands are still in the extension's store |
| VS Code force-quit, restored terminal, popup opened immediately | Yes — from the persisted store |
| Command ran before the extension host was ever listening | No (never observed) |

There is no longer a "run a no-op to prime the extension" step: the extension
records commands forward from `onStartupFinished` and keeps them in its own
database.

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
