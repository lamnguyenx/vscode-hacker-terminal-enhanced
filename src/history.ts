/**
 * Pure history helpers (no `vscode` import) so they can be unit-checked with
 * bun. The SQLite-backed {@link ./store.HistoryStore} stores rows; these
 * helpers turn them into the display model the webview renders.
 */

import type { DisplayItem } from './historyMessages';

export type { DisplayItem };

/** Metadata for a captured command, without its (potentially huge) output. */
export interface StoredMeta {
	id: number;
	commandLine: string;
	cwd: string | undefined;
	exitCode: number | undefined;
	startTime: number;
	endTime: number;
	/** True while the command is still streaming (e.g. `tail -f`). */
	running: boolean;
	/** Character length of the stored output, for cache-freshness checks. */
	outputLength: number;
}

/** A captured command including its full output. */
export interface StoredExecution extends StoredMeta {
	output: string;
}

/** First non-empty line of a command, for the compact history list. */
export function firstLine(commandLine: string): string {
	const line = commandLine.split(/\r?\n/, 1)[0] ?? '';
	const trimmed = line.trim();
	return trimmed.length > 0 ? trimmed : '(empty command)';
}

/**
 * VS Code's shell integration reports a line aborted with Ctrl+C as an
 * execution whose command line contains the terminal's echoed `^C` marker
 * (e.g. `tail -f^C`, or just `^C` at an empty prompt). Such a line was never
 * actually executed. The marker is only a hint: a genuine command that happens
 * to contain `^C` produces output, so the tracker confirms before recording.
 */
export function hasCancelMarker(commandLine: string): boolean {
	return commandLine.includes('^C');
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
		running: meta.running,
		outputLength: meta.outputLength,
	};
}
