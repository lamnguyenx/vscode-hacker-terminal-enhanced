import * as vscode from 'vscode';
import { stripNonPrintable } from './ansi';
import { hasCancelMarker } from './history';
import { HistoryStore } from './store';

/**
 * VS Code 1.100 types do not include `onDidWriteTerminalData` / `TerminalDataEvent`
 * (added post-1.100). The runtime API exists on the target code-server build,
 * so we type it locally.
 */
interface TerminalDataEvent {
	readonly terminal: vscode.Terminal;
	readonly data: string;
}
type TerminalDataListener = (event: TerminalDataEvent) => unknown;

interface PendingCapture {
	/** Row id, or `undefined` while a maybe-cancelled line has not been confirmed. */
	id: number | undefined;
	startTime: number;
	cwd: string | undefined;
	commandLine: string;
	/** Resolves with the final stripped output once the stream drains. */
	outputPromise: Promise<string>;
	/** Accumulated terminal data from the supplemental feed. */
	supplementalData: string;
	/** Raw supplemental length already flushed to the store. */
	flushedLength: number;
	/** Drives periodic flushes while supplemental data grows. */
	flushTimer: ReturnType<typeof setInterval> | undefined;
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
		// Cast through unknown: `onDidWriteTerminalData` is available at runtime
		// but absent from @types/vscode. Bracket access avoids the type error.
		((vscode.window as unknown as { onDidWriteTerminalData(listener: TerminalDataListener): vscode.Disposable }).onDidWriteTerminalData)(event => {
			onTerminalData(event, getMaxOutputLength());
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
			supplementalData: '',
			flushedLength: 0,
			flushTimer: undefined,
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

	const pending: PendingCapture = {
		id,
		startTime,
		cwd,
		commandLine,
		outputPromise: collectOutput(execution, store, id, maxOutputLength),
		supplementalData: '',
		flushedLength: 0,
		flushTimer: undefined,
	};
	pendingMap.set(terminal, pending);
	// Sparse producers (e.g. `docker logs -f`) can go quiet after an initial
	// burst, so an event-driven flush would never fire: poll the buffer.
	pending.flushTimer = setInterval(() => {
		if (pending.supplementalData.length === pending.flushedLength) {
			return;
		}
		pending.flushedLength = pending.supplementalData.length;
		writeOutput(store, id, supplementalOutput(pending.supplementalData));
	}, FLUSH_INTERVAL_MS);
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
					writeOutput(store, id, stripNonPrintable(raw));
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
		writeOutput(store, id, output);
	}
	return output;
}

/**
 * Write `candidate` to a running row unless the row already holds something
 * longer. The primary (`execution.read()`) and supplemental (terminal data)
 * capture paths write concurrently and each may know only part of the output,
 * so whichever produced more wins; neither may blank the other out.
 */
function writeOutput(store: HistoryStore, id: number, candidate: string): void {
	const entry = store.get(id);
	if (entry && entry.output.length > candidate.length) {
		return;
	}
	store.updateOutput(id, candidate);
}

const OUTPUT_START_MARKER = '\x1b]633;C';
const OUTPUT_END_MARKER = '\x1b]633;D';

/**
 * Recover the command's output region from raw terminal data. Raw data events
 * carry everything the terminal renders — the command echo, prompt, and the
 * shell-integration OSC 633 markers themselves — while the output proper is
 * delimited by the `633;C` (output start) and `633;D` (output end) markers.
 * Cutting at those markers yields the same text the shell-integration data
 * stream would have produced, had it not dropped the output.
 */
function supplementalOutput(raw: string): string {
	let body = raw;
	const start = body.lastIndexOf(OUTPUT_START_MARKER);
	if (start >= 0) {
		body = body.slice(start + OUTPUT_START_MARKER.length);
	}
	const end = body.indexOf(OUTPUT_END_MARKER);
	if (end >= 0) {
		body = body.slice(0, end);
	}
	return stripNonPrintable(body);
}

/**
 * Supplemental capture via `onDidWriteTerminalData`. The primary capture path
 * (`execution.read()`) uses VS Code's `ShellExecutionDataStream`, which can
 * miss output from commands such as `docker logs -f` that write to the pty
 * through paths the data stream does not intercept. Every byte the terminal
 * renders after the execution starts is buffered here and flushed to the store
 * on a timer (see {@link onStart}), so output is captured regardless of the
 * write path.
 *
 * Only data for a terminal with a pending confirmed capture is collected; the
 * rest is filtered out quickly.
 */
function onTerminalData(event: TerminalDataEvent, maxOutputLength: number): void {
	const pending = pendingMap.get(event.terminal);
	if (!pending || pending.id === undefined) {
		return;
	}
	pending.supplementalData += event.data;
	if (pending.supplementalData.length > maxOutputLength) {
		pending.supplementalData = pending.supplementalData.slice(0, maxOutputLength);
	}
}

function onEnd(event: vscode.TerminalShellExecutionEndEvent, store: HistoryStore): void {
	const { terminal, exitCode } = event;
	const pending = pendingMap.get(terminal);
	if (!pending) {
		return;
	}
	pendingMap.delete(terminal);
	clearInterval(pending.flushTimer);

	// Wait for the stream to finish draining so trailing output is captured.
	void pending.outputPromise.then(output => {
		try {
			if (pending.id === undefined) {
				// Maybe-cancelled line: record it only if it actually ran.
				const supplemental = supplementalOutput(pending.supplementalData);
				if (output.length > 0 || supplemental.length > 0 || exitCode !== undefined) {
					store.add({
						commandLine: pending.commandLine,
						cwd: pending.cwd,
						exitCode,
						output: output.length >= supplemental.length ? output : supplemental,
						startTime: pending.startTime,
						endTime: Date.now(),
					});
				}
				return;
			}
			// Flush any remaining supplemental data the primary stream missed.
			writeOutput(store, pending.id, supplementalOutput(pending.supplementalData));
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
	clearInterval(pending.flushTimer);
	// A maybe-cancelled line was never persisted, so there is nothing to settle.
	if (pending.id === undefined) {
		return;
	}
	// The terminal went away before the shell reported an end: flush any
	// remaining supplemental data and settle the row.
	try {
		writeOutput(store, pending.id, supplementalOutput(pending.supplementalData));
		store.finish(pending.id, undefined, Date.now());
	} catch (error) {
		console.error('[hacker-terminal-enhanced] failed to finalize closed command', error);
	}
}
