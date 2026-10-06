import * as vscode from 'vscode';
import { stripNonPrintable } from './ansi';
import { hasCancelMarker } from './history';
import { HistoryStore } from './store';
import { TerminalEmulator, scrollbackLinesFor } from './terminalEmulator';

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

/**
 * `onDidChangeTerminalDimensions` / `Terminal.dimensions` are likewise present
 * at runtime but absent from the shipped types, so they are typed locally too.
 */
interface TerminalDimensionsEvent {
	readonly terminal: vscode.Terminal;
	readonly dimensions: { readonly columns: number; readonly rows: number };
}
type TerminalDimensionsListener = (event: TerminalDimensionsEvent) => unknown;

/** Live capture options, re-read from settings whenever a command starts. */
export interface CaptureOptions {
	/** `terminalEnhanced.maxOutputLength` — the per-command character cap. */
	maxOutputLength: number;
	/** `terminalEnhanced.emulatedCapture` — capture through a headless terminal. */
	emulated: boolean;
}

interface PendingCapture {
	/** Row id, or `undefined` while a maybe-cancelled line has not been confirmed. */
	id: number | undefined;
	startTime: number;
	cwd: string | undefined;
	commandLine: string;
	/** Resolves with the final stripped output once the stream drains. */
	outputPromise: Promise<string>;
	/** Drives periodic flushes while captured output grows. */
	flushTimer: ReturnType<typeof setInterval> | undefined;
	/** Whether this capture runs through the emulator (setting captured at start). */
	emulated: boolean;
	// --- Emulated capture state (setting on) ---
	emulator: TerminalEmulator | undefined;
	/** True once the OSC 633;C output-start marker has been seen. */
	outputStarted: boolean;
	/** True once the OSC 633;D output-end marker has been seen. */
	outputEnded: boolean;
	/** Raw bytes held back while a marker may still be split across chunks. */
	carry: string;
	/** Set when new output was fed since the last flush. */
	dirty: boolean;
	/** True if the alternate screen was ever entered (a full-screen TUI). */
	everAlternate: boolean;
	/** Last serialized alternate-screen frame, kept because it is discarded on exit. */
	lastAltSnapshot: string | undefined;
	/** Newlines fed to the emulator, to detect scrollback eviction. */
	fedLines: number;
	/** True once the emulator's scrollback has dropped output. */
	truncated: boolean;
	/** Emulator line capacity (`scrollback + rows`). */
	lineCapacity: number;
	// --- Linear fallback state (setting off) ---
	/** Accumulated raw terminal data for the linear ANSI strip. */
	supplementalData: string;
	/** Raw supplemental length already flushed to the store. */
	flushedLength: number;
}

const pendingMap = new Map<vscode.Terminal, PendingCapture>();
const dimensionsMap = new Map<vscode.Terminal, { columns: number; rows: number }>();

/** How often a running command's growing output is written (and re-rendered). */
const FLUSH_INTERVAL_MS = 250;

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

const OUTPUT_START_MARKER = '\x1b]633;C';
const OUTPUT_END_MARKER = '\x1b]633;D';

/**
 * Track terminal executions and persist them to the history store. A command is
 * recorded the moment it starts, so a long-running one (e.g. `tail -f`) shows up
 * immediately and streams its output into the popup until it ends or its
 * terminal closes. The store is global (across terminals and windows) and
 * persisted to disk, so the popup can browse earlier sessions too.
 *
 * Output is captured by feeding the raw terminal byte stream through a headless
 * xterm ({@link TerminalEmulator}), which understands cursor addressing and the
 * alternate screen. This is what lets full-screen TUIs (`tig`, `gdu`, `less`,
 * `vim`, `htop`) capture the screen they were showing instead of a meaningless
 * run of every repaint, and it also recovers output VS Code's
 * shell-integration data stream silently drops (`docker logs -f`). Setting
 * `terminalEnhanced.emulatedCapture` to `false` restores the previous linear
 * ANSI-strip capture.
 */
export function activateTracker(
	context: vscode.ExtensionContext,
	store: HistoryStore,
	getOptions: () => CaptureOptions
): void {
	context.subscriptions.push(
		vscode.window.onDidStartTerminalShellExecution(event => {
			onStart(event, store, getOptions());
		}),
		vscode.window.onDidEndTerminalShellExecution(event => {
			onEnd(event, store, getOptions());
		}),
		// Cast through unknown: `onDidWriteTerminalData` is available at runtime
		// but absent from @types/vscode. Bracket access avoids the type error.
		((vscode.window as unknown as { onDidWriteTerminalData(listener: TerminalDataListener): vscode.Disposable }).onDidWriteTerminalData)(event => {
			onTerminalData(event, getOptions());
		}),
		vscode.window.onDidCloseTerminal(terminal => onClose(store, terminal, getOptions())),
		// Cast through unknown: present at runtime, absent from the shipped types.
		((vscode.window as unknown as { onDidChangeTerminalDimensions(listener: TerminalDimensionsListener): vscode.Disposable }).onDidChangeTerminalDimensions)(event => {
			dimensionsMap.set(event.terminal, {
				columns: event.dimensions.columns,
				rows: event.dimensions.rows,
			});
			pendingMap
				.get(event.terminal)
				?.emulator?.resize(event.dimensions.columns, event.dimensions.rows);
		})
	);
}

function onStart(
	event: vscode.TerminalShellExecutionStartEvent,
	store: HistoryStore,
	options: CaptureOptions
): void {
	const { terminal, execution } = event;
	const startTime = Date.now();
	const cwd = execution.cwd?.fsPath;
	const commandLine = execution.commandLine.value;

	// A blank line (e.g. Enter on an empty prompt) is nothing to record.
	if (commandLine.trim().length === 0) {
		return;
	}

	const pending: PendingCapture = {
		id: undefined,
		startTime,
		cwd,
		commandLine,
		outputPromise: Promise.resolve(''),
		flushTimer: undefined,
		emulated: options.emulated,
		emulator: undefined,
		outputStarted: false,
		outputEnded: false,
		carry: '',
		dirty: false,
		everAlternate: false,
		lastAltSnapshot: undefined,
		fedLines: 0,
		truncated: false,
		lineCapacity: 0,
		supplementalData: '',
		flushedLength: 0,
	};

	// A `^C` marker means the line *may* have been aborted before running. Hold
	// off persisting until the execution ends and confirm it actually did
	// something (see {@link onEnd}); otherwise a cancelled `tail -f` would show
	// up as a command.
	if (!hasCancelMarker(commandLine)) {
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
		pending.id = id;
	}

	// The primary stream is a fallback (and tells us when the command has
	// finished draining). In emulated mode it must not write: pass `undefined`
	// so `collectOutput` only buffers and returns.
	pending.outputPromise = collectOutput(
		execution,
		store,
		pending.emulated ? undefined : pending.id,
		options.maxOutputLength
	);

	pendingMap.set(terminal, pending);

	if (pending.emulated) {
		const dims = terminalDimensions(terminal);
		const scrollback = scrollbackLinesFor(options.maxOutputLength, dims.columns);
		pending.lineCapacity = scrollback + dims.rows;
		pending.emulator = new TerminalEmulator({
			columns: dims.columns,
			rows: dims.rows,
			scrollback,
		});
		pending.flushTimer = setInterval(() => {
			flushEmulated(store, pending, options.maxOutputLength);
		}, FLUSH_INTERVAL_MS);
		return;
	}

	const id = pending.id;
	if (id !== undefined) {
		// Sparse producers (e.g. `docker logs -f`) can go quiet after an initial
		// burst, so an event-driven flush would never fire: poll the buffer.
		pending.flushTimer = setInterval(() => {
			if (pending.supplementalData.length === pending.flushedLength) {
				return;
			}
			pending.flushedLength = pending.supplementalData.length;
			writeLongerOutput(store, id, supplementalOutput(pending.supplementalData));
		}, FLUSH_INTERVAL_MS);
	}
}

/**
 * Drain the execution's output stream. When `id` is set, output is written to
 * the running row on a throttle so a long-running command streams into the
 * popup; when it is not the output is only buffered and returned for
 * {@link onEnd} to decide. Always resolves with the final output.
 *
 * Note: VS Code's shell-integration data stream drops output that arrives
 * before the consumer registers (a race in `ShellExecutionDataStream`), and
 * silently drops whole classes of producers (`docker logs -f`). In emulated
 * mode the raw terminal-data path below supersedes this; here it remains the
 * fallback and the drain signal.
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
					writeLongerOutput(store, id, stripNonPrintable(raw));
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
		writeLongerOutput(store, id, output);
	}
	return output;
}

/**
 * Write `candidate` to a running row unless the row already holds something
 * longer. The linear fallback's primary (`execution.read()`) and supplemental
 * (terminal data) paths write concurrently and each may know only part of the
 * output, so whichever produced more wins; neither may blank the other out.
 * (Emulated mode has a single writer and updates directly.)
 */
function writeLongerOutput(store: HistoryStore, id: number, candidate: string): void {
	const entry = store.get(id);
	if (entry && entry.output.length > candidate.length) {
		return;
	}
	store.updateOutput(id, candidate);
}

/**
 * Recover the command's output region from raw terminal data. Raw data events
 * carry everything the terminal renders — the command echo, prompt, and the
 * shell-integration OSC 633 markers themselves — while the output proper is
 * delimited by the `633;C` (output start) and `633;D` (output end) markers.
 * Cutting at those markers yields the same text the shell-integration data
 * stream would have produced, had it not dropped the output.
 *
 * Only used by the linear fallback; the emulator is fed raw bytes and slices
 * incrementally in {@link feedEmulator}.
 */
function supplementalOutput(raw: string): string {
	return stripNonPrintable(outputRegion(raw));
}

/**
 * The raw bytes between the last `633;C` and the first following `633;D` —
 * the command's output region, with the echoed command, prompt, markers and
 * everything after the command excluded. Returns `''` until `633;C` is seen.
 */
function outputRegion(raw: string): string {
	const start = raw.lastIndexOf(OUTPUT_START_MARKER);
	if (start < 0) {
		return '';
	}
	let body = raw.slice(start + OUTPUT_START_MARKER.length);
	const end = body.indexOf(OUTPUT_END_MARKER);
	if (end >= 0) {
		body = body.slice(0, end);
	}
	return body;
}

/**
 * Supplemental capture via `onDidWriteTerminalData` (the linear fallback).
 * Only data for a terminal with a pending confirmed capture is collected.
 */
function onTerminalData(event: TerminalDataEvent, options: CaptureOptions): void {
	const pending = pendingMap.get(event.terminal);
	if (!pending) {
		return;
	}
	if (pending.emulated) {
		feedEmulator(pending, event.data);
		return;
	}
	if (pending.id === undefined) {
		return;
	}
	pending.supplementalData += event.data;
	if (pending.supplementalData.length > options.maxOutputLength) {
		pending.supplementalData = pending.supplementalData.slice(0, options.maxOutputLength);
	}
}

/**
 * Feed raw terminal bytes to the capture's emulator, but only the command's
 * output region: bytes before `633;C` (the echoed command) are dropped, and
 * everything from `633;D` on (markers, prompt) is ignored. Markers can be split
 * across data chunks, so a small tail is held back until they resolve.
 */
function feedEmulator(pending: PendingCapture, data: string): void {
	if (pending.outputEnded || !pending.emulator) {
		return;
	}
	pending.carry += data;
	if (!pending.outputStarted) {
		const start = pending.carry.indexOf(OUTPUT_START_MARKER);
		if (start < 0) {
			// Keep only enough tail to catch a marker split across chunks.
			const keep = OUTPUT_START_MARKER.length - 1;
			if (pending.carry.length > keep) {
				pending.carry = pending.carry.slice(-keep);
			}
			return;
		}
		pending.carry = pending.carry.slice(start + OUTPUT_START_MARKER.length);
		pending.outputStarted = true;
	}
	const end = pending.carry.indexOf(OUTPUT_END_MARKER);
	const chunk = end >= 0 ? pending.carry.slice(0, end) : pending.carry;
	if (chunk.length > 0) {
		pending.emulator.write(chunk);
		pending.fedLines += countNewlines(chunk);
		pending.dirty = true;
		if (pending.fedLines > pending.lineCapacity) {
			pending.truncated = true;
		}
	}
	pending.carry = '';
	if (end >= 0) {
		pending.outputEnded = true;
	}
}

/**
 * Serialize the emulator on a timer and push it to the running row. Alternate
 * screens are snapshotted as the visible viewport and remembered, because the
 * alt buffer is discarded (`?1049l`) before the command-end marker arrives —
 * serializing only at the end would capture the restored, empty screen.
 */
function flushEmulated(store: HistoryStore, pending: PendingCapture, maxOutputLength: number): void {
	const emulator = pending.emulator;
	if (!emulator || !pending.dirty) {
		return;
	}
	pending.dirty = false;

	if (emulator.isAlternate) {
		pending.everAlternate = true;
		const snapshot = truncate(emulator.serializeViewport(), maxOutputLength, false);
		pending.lastAltSnapshot = snapshot;
		if (pending.id !== undefined) {
			store.updateOutput(pending.id, snapshot);
		}
		return;
	}

	if (pending.id !== undefined) {
		store.updateOutput(
			pending.id,
			truncate(emulator.serializeBuffer(), maxOutputLength, pending.truncated)
		);
	}
}

/** The final text for an emulated capture, preferring the last TUI screen. */
function emulatedOutput(pending: PendingCapture, maxOutputLength: number): string {
	const emulator = pending.emulator;
	if (!emulator) {
		return '';
	}
	if (emulator.isAlternate) {
		pending.everAlternate = true;
		pending.lastAltSnapshot = truncate(emulator.serializeViewport(), maxOutputLength, false);
	}
	if (pending.everAlternate && pending.lastAltSnapshot !== undefined) {
		return pending.lastAltSnapshot;
	}
	return truncate(emulator.serializeBuffer(), maxOutputLength, pending.truncated);
}

function onEnd(
	event: vscode.TerminalShellExecutionEndEvent,
	store: HistoryStore,
	options: CaptureOptions
): void {
	const { terminal, exitCode } = event;
	const pending = pendingMap.get(terminal);
	if (!pending) {
		return;
	}
	pendingMap.delete(terminal);
	clearInterval(pending.flushTimer);

	// Wait for the stream to finish draining so trailing output is captured.
	void pending.outputPromise.then(async output => {
		try {
			if (pending.emulated) {
				// Let xterm finish parsing the buffered bytes before serializing.
				await pending.emulator?.whenIdle();
				const emulated = emulatedOutput(pending, options.maxOutputLength);
				try {
					if (pending.id === undefined) {
						// Maybe-cancelled line: record it only if it actually ran.
						const chosen = output.length >= emulated.length ? output : emulated;
						if (chosen.length > 0 || exitCode !== undefined) {
							store.add({
								commandLine: pending.commandLine,
								cwd: pending.cwd,
								exitCode,
								output: chosen,
								startTime: pending.startTime,
								endTime: Date.now(),
							});
						}
						return;
					}
					store.updateOutput(pending.id, emulated.length > 0 ? emulated : output);
					store.finish(pending.id, exitCode, Date.now());
				} finally {
					pending.emulator?.dispose();
				}
				return;
			}

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
			writeLongerOutput(store, pending.id, supplementalOutput(pending.supplementalData));
			store.finish(pending.id, exitCode, Date.now());
		} catch (error) {
			console.error('[hacker-terminal-enhanced] failed to finalize command', error);
		}
	});
}

function onClose(store: HistoryStore, terminal: vscode.Terminal, options: CaptureOptions): void {
	dimensionsMap.delete(terminal);
	const pending = pendingMap.get(terminal);
	if (!pending) {
		return;
	}
	pendingMap.delete(terminal);
	clearInterval(pending.flushTimer);
	try {
		if (pending.emulated) {
			const emulated = emulatedOutput(pending, options.maxOutputLength);
			if (pending.id !== undefined) {
				store.updateOutput(pending.id, emulated);
				store.finish(pending.id, undefined, Date.now());
			}
			pending.emulator?.dispose();
			return;
		}
		// A maybe-cancelled line was never persisted, so there is nothing to settle.
		if (pending.id === undefined) {
			return;
		}
		// The terminal went away before the shell reported an end: flush any
		// remaining supplemental data and settle the row.
		writeLongerOutput(store, pending.id, supplementalOutput(pending.supplementalData));
		store.finish(pending.id, undefined, Date.now());
	} catch (error) {
		console.error('[hacker-terminal-enhanced] failed to finalize closed command', error);
	}
}

/**
 * The terminal's current grid. `Terminal.dimensions` is present at runtime but
 * not in the shipped types; the resize event keeps {@link dimensionsMap} warm
 * as a fallback. An unknown size falls back to a conventional default.
 */
function terminalDimensions(terminal: vscode.Terminal): { columns: number; rows: number } {
	const dims =
		dimensionsMap.get(terminal) ??
		(terminal as unknown as { dimensions?: { columns: number; rows: number } }).dimensions;
	if (dims && dims.columns > 0 && dims.rows > 0) {
		return { columns: dims.columns, rows: dims.rows };
	}
	return { columns: DEFAULT_COLUMNS, rows: DEFAULT_ROWS };
}

/**
 * Cap output at `maxOutputLength` characters, appending a marker when anything
 * was dropped (either because the text overflowed, or because the emulator's
 * scrollback evicted older lines).
 */
function truncate(text: string, max: number, evicted: boolean): string {
	if (text.length > max) {
		return `${text.slice(0, max)}\n[output truncated]`;
	}
	return evicted ? `${text}\n[output truncated]` : text;
}

function countNewlines(text: string): number {
	let count = 0;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) {
			count++;
		}
	}
	return count;
}
