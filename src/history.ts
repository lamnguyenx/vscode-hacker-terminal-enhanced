/**
 * Pure history helpers (no `vscode` import) so they can be unit-checked with
 * bun. The SQLite-backed {@link ./store.HistoryStore} stores rows; these
 * helpers turn them into the display model the webview renders.
 */

/** Metadata for a captured command, without its (potentially huge) output. */
export interface StoredMeta {
	id: number;
	commandLine: string;
	cwd: string | undefined;
	exitCode: number | undefined;
	startTime: number;
	endTime: number;
}

/** A captured command including its full output. */
export interface StoredExecution extends StoredMeta {
	output: string;
}

/** One row in the popup's left pane. `output` is intentionally absent. */
export interface DisplayItem {
	id: number;
	firstLine: string;
	command: string;
	cwd: string | undefined;
	exitCode: number | undefined;
	startedAt: number;
}

/** First non-empty line of a command, for the compact history list. */
export function firstLine(commandLine: string): string {
	const line = commandLine.split(/\r?\n/, 1)[0] ?? '';
	const trimmed = line.trim();
	return trimmed.length > 0 ? trimmed : '(empty command)';
}

/** Convert a stored row into the shape the webview consumes. */
export function toDisplayItem(meta: StoredMeta): DisplayItem {
	return {
		id: meta.id,
		firstLine: firstLine(meta.commandLine),
		command: meta.commandLine,
		cwd: meta.cwd,
		exitCode: meta.exitCode,
		startedAt: meta.startTime,
	};
}
