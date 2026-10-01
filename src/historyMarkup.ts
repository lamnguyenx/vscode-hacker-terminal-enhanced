/**
 * The webview document, shared by the real extension host
 * (`historyWebview.ts`) and the browser dev harness (`scripts/dev-webview.ts`).
 * Pure string building — no `vscode`, no DOM — so there is a single source of
 * truth for the popup markup.
 */

export interface HistoryDocumentOptions {
	/** Webview-usable URI for `media/popup.css`. */
	cssUri: string;
	/** Webview-usable URI for `media/popup.js`. */
	jsUri: string;
	/** Optional nonce; enables the strict CSP when combined with `cspSource`. */
	nonce?: string;
	/** `webview.cspSource`; enables the strict CSP when combined with `nonce`. */
	cspSource?: string;
	/** Extra `<head>` markup (the dev harness injects its theme + host shim). */
	headExtra?: string;
}

/** The `<main class="popup">…</main>` body, identical in every presentation. */
const HISTORY_BODY = /* html */ `
	<main class="popup" role="dialog" aria-label="Command history">
		<header class="popup-header">
			<span class="popup-title">Hacker Terminal Enhanced</span>
			<span class="popup-count" id="history-count"></span>
		</header>
		<div class="popup-body">
			<section class="list-pane" aria-label="Command history">
				<div class="pane-label">Command</div>
				<div class="history-list" id="history-list" role="listbox" tabindex="0"></div>
			</section>
			<section class="preview-pane" aria-label="Command and output">
				<div class="pane-label">Command &amp; output</div>
				<div class="preview" id="history-preview">
					<div class="preview-header">
						<pre class="preview-command" id="preview-command"></pre>
						<dl class="preview-meta" id="preview-meta"></dl>
						<div class="preview-section-label">
							Output <span class="preview-output-size" id="preview-output-size"></span>
						</div>
					</div>
					<div class="preview-output-scroll" id="preview-output-scroll">
						<pre class="preview-output" id="preview-output"></pre>
					</div>
				</div>
			</section>
		</div>
		<footer class="popup-footer">
			<span><kbd>↑</kbd><kbd>↓</kbd> browse</span>
			<span><kbd>⏎</kbd> copy full block</span>
			<span><kbd>Alt</kbd><kbd>Z</kbd> wrap</span>
			<span><kbd>Esc</kbd> close</span>
		</footer>
		<div class="empty" id="history-empty" hidden>
			No commands captured yet. Run a command in a terminal, then open this again.
		</div>
		<div class="copied-toast" id="copied-toast" role="status" aria-live="polite">
			<span class="copied-check" aria-hidden="true">&#10003;</span>
			<span>Copied command + output</span>
		</div>
	</main>`;

/** Build the full popup document from the shared body plus the given URIs. */
export function buildHistoryDocument(options: HistoryDocumentOptions): string {
	const { cssUri, jsUri, nonce, cspSource, headExtra } = options;
	const csp =
		nonce && cspSource
			? `\n\t<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; style-src ${cspSource}; script-src 'nonce-${nonce}';">`
			: '';
	const nonceAttr = nonce ? ` nonce="${nonce}"` : '';
	const extra = headExtra ? `\n${headExtra}` : '';

	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">${csp}
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${cssUri}">${extra}
	<title>Hacker Terminal History</title>
</head>
<body>
${HISTORY_BODY}
	<script${nonceAttr} src="${jsUri}"></script>
</body>
</html>`;
}
