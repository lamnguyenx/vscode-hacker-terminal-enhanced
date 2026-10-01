/**
 * Wire types shared by the extension host and the webview (and the browser dev
 * harness). Pure declarations only — no `vscode`, no DOM — so both sides import
 * the same shapes and they cannot drift.
 */

/** One row in the popup's left pane. `output` is intentionally absent. */
export interface DisplayItem {
	id: number;
	firstLine: string;
	command: string;
	cwd: string | undefined;
	exitCode: number | undefined;
	startedAt: number;
	running: boolean;
	/** Character length of the stored output, for cache-freshness checks. */
	outputLength: number;
}

/** Host → webview: the current history list (metadata only). */
export interface ItemsMessage {
	type: 'items';
	items: DisplayItem[];
}

/** Host → webview: one command's full output, sent on demand. */
export interface OutputMessage {
	type: 'output';
	id: number;
	output: string;
	length: number;
}

/** Host → webview: a copy succeeded (drives the confirmation cue). */
export interface CopiedMessage {
	type: 'copied';
	id: number;
}
