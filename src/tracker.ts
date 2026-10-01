import * as vscode from 'vscode';
import { stripNonPrintable } from './ansi';
import { hasCancelMarker } from './history';
import { HistoryStore } from './store';

interface PendingCapture {
	/** Row id, or `undefined` while a maybe-cancelled line has not been confirmed. */
	id: number | undefined;
	startTime: number;
	cwd: string | undefined;
	commandLine: string;
	/** Resolves with the final stripped output once the stream drains. */
	outputPromise: Promise<string>;
}

const pendingMap = new Map<vscode.Terminal, PendingCapture>();

/** How often a running command's growing output is written (and re-rendered). */
const FLUSH_INTERVAL_MS = 250;

/**
 * Track terminal executions and persist them to the history store. A command is
 * recorded the moment it starts, so a long-running one (e.g. `tail -f`) shows up
 * immediately and streams its output into the popup until it ends or its
 * terminal closes. The store is global (across terminals and windows) and
 * persisted to disk, so the popup can browse earlier sessions too.
 */
export function activateTracker(
	context: vscode.ExtensionContext,
	store: HistoryStore,
	getMaxOutputLength: () => number
): void {
	context.subscriptions.push(
		vscode.window.onDidStartTerminalShellExecution(event => {
			onStart(event, store, getMaxOutputLength());
		}),
		vscode.window.onDidEndTerminalShellExecution(event => {
			onEnd(event, store);
		}),
		vscode.window.onDidCloseTerminal(terminal => onClose(store, terminal))
	);
}

function onStart(
	event: vscode.TerminalShellExecutionStartEvent,
	store: HistoryStore,
	maxOutputLength: number
): void {
	const { terminal, execution } = event;
	const startTime = Date.now();
	const cwd = execution.cwd?.fsPath;
	const commandLine = execution.commandLine.value;

	// A blank line (e.g. Enter on an empty prompt) is nothing to record.
	if (commandLine.trim().length === 0) {
		return;
	}

	// A `^C` marker means the line *may* have been aborted before running. Hold
	// off persisting until the execution ends and confirm it actually did
	// something (see {@link onEnd}); otherwise a cancelled `tail -f` would show
	// up as a command.
	if (hasCancelMarker(commandLine)) {
		pendingMap.set(terminal, {
			id: undefined,
			startTime,
			cwd,
			commandLine,
			outputPromise: collectOutput(execution, store, undefined, maxOutputLength),
		});
		return;
	}

	let id: number;
	try {
		id = store.startRunning({ commandLine, cwd, startTime });
	} catch (error) {
		console.error('[hacker-terminal-enhanced] failed to start capture', error);
		return;
	}
	if (id < 0) {
		return;
	}

	pendingMap.set(terminal, {
		id,
		startTime,
		cwd,
		commandLine,
		outputPromise: collectOutput(execution, store, id, maxOutputLength),
	});
}

/**
 * Drain the execution's output stream. When `id` is set, output is written to
 * the running row on a throttle so a long-running command streams into the
 * popup; when it is not (a maybe-cancelled line) the output is only buffered and
 * returned for {@link onEnd} to decide. Always resolves with the final output.
 *
 * Note: VS Code's shell-integration data stream drops output that arrives
 * before the consumer registers (a race in `ShellExecutionDataStream`), which
 * can leave the very fastest shell builtins (e.g. `echo`) with no output. This
 * is a platform limitation; external commands are captured normally.
 */
async function collectOutput(
	execution: vscode.TerminalShellExecution,
	store: HistoryStore,
	id: number | undefined,
	maxOutputLength: number
): Promise<string> {
	let raw = '';
	let truncated = false;
	let lastFlush = Date.now();
	try {
		for await (const chunk of execution.read()) {
			raw += chunk;
			if (raw.length >= maxOutputLength) {
				raw = raw.slice(0, maxOutputLength);
				truncated = true;
				break;
			}
			if (id !== undefined) {
				const now = Date.now();
				if (now - lastFlush >= FLUSH_INTERVAL_MS) {
					store.updateOutput(id, stripNonPrintable(raw));
					lastFlush = now;
				}
			}
		}
	} catch {
		// stream may be cancelled
	}
	if (truncated) {
		raw += '\n[output truncated]';
	}
	const output = stripNonPrintable(raw);
	if (id !== undefined) {
		store.updateOutput(id, output);
	}
	return output;
}

function onEnd(event: vscode.TerminalShellExecutionEndEvent, store: HistoryStore): void {
	const { terminal, exitCode } = event;
	const pending = pendingMap.get(terminal);
	if (!pending) {
		return;
	}
	pendingMap.delete(terminal);

	// Wait for the stream to finish draining so trailing output is captured.
	void pending.outputPromise.then(output => {
		try {
			if (pending.id === undefined) {
				// Maybe-cancelled line: record it only if it actually ran.
				if (output.length > 0 || exitCode !== undefined) {
					store.add({
						commandLine: pending.commandLine,
						cwd: pending.cwd,
						exitCode,
						output,
						startTime: pending.startTime,
						endTime: Date.now(),
					});
				}
				return;
			}
			store.finish(pending.id, exitCode, Date.now());
		} catch (error) {
			console.error('[hacker-terminal-enhanced] failed to finalize command', error);
		}
	});
}

function onClose(store: HistoryStore, terminal: vscode.Terminal): void {
	const pending = pendingMap.get(terminal);
	if (!pending) {
		return;
	}
	pendingMap.delete(terminal);
	// A maybe-cancelled line was never persisted, so there is nothing to settle.
	if (pending.id === undefined) {
		return;
	}
	// The terminal went away before the shell reported an end: settle the row so
	// it stops showing as running.
	try {
		store.finish(pending.id, undefined, Date.now());
	} catch (error) {
		console.error('[hacker-terminal-enhanced] failed to finalize closed command', error);
	}
}
