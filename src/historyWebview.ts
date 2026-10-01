import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { copyExecution } from './copy';
import { toDisplayItem } from './history';
import { HistoryStore } from './store';

/**
 * Shared webview plumbing for the webview presentations of the history (the
 * editor-area panel, the separate window, and the three docked views). All
 * render the same `media/popup.*` assets and speak the same
 * `{ready|copy|close}` protocol.
 */
export interface HistoryWebviewHost {
	readonly webview: vscode.Webview;
	/** Close/hide the host on an explicit `close` message. */
	close(): void;
	/** Whether a successful copy should also close the host. */
	shouldCloseOnCopy(): boolean;
}

/** Register the message protocol and store-refresh wiring for a webview host. */
export function wireHistoryWebview(
	host: HistoryWebviewHost,
	store: HistoryStore
): vscode.Disposable[] {
	return [
		host.webview.onDidReceiveMessage(message => {
			void handleMessage(host, store, message);
		}),
		store.onDidChange(() => postHistoryItems(host.webview, store))
	];
}

/** Push the current history list to a webview (no output payloads). */
export function postHistoryItems(webview: vscode.Webview, store: HistoryStore): void {
	const items = store.list().map(toDisplayItem);
	try {
		void webview.postMessage({ type: 'items', items });
	} catch {
		// the webview may have just been disposed
	}
}

async function handleMessage(
	host: HistoryWebviewHost,
	store: HistoryStore,
	message: unknown
): Promise<void> {
	const type = (message as { type?: unknown } | undefined)?.type;
	switch (type) {
		case 'ready':
			postHistoryItems(host.webview, store);
			return;
		case 'close':
			host.close();
			return;
		case 'copy': {
			const id = Number((message as { id?: unknown }).id);
			if (!Number.isFinite(id)) {
				return;
			}
			if ((await copyExecution(store, id)) && host.shouldCloseOnCopy()) {
				host.close();
			}
			return;
		}
		default:
			return;
	}
}

/** The webview document shared by all webview presentations. */
export function buildHistoryHtml(extensionUri: vscode.Uri, webview: vscode.Webview): string {
	const nonce = getNonce();
	const cspSource = webview.cspSource;
	const mediaRoot = vscode.Uri.joinPath(extensionUri, 'media');
	const cssUri = cacheBust(webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'popup.css')));
	const jsUri = cacheBust(webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'popup.js')));

	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; style-src ${cspSource}; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${cssUri}">
	<title>Hacker Terminal History</title>
</head>
<body>
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
			<section class="preview-pane" aria-label="Full command">
				<div class="pane-label">Full command</div>
				<div class="preview" id="history-preview">
					<pre class="preview-command" id="preview-command"></pre>
					<dl class="preview-meta" id="preview-meta"></dl>
				</div>
			</section>
		</div>
		<footer class="popup-footer">
			<span><kbd>↑</kbd><kbd>↓</kbd> browse</span>
			<span><kbd>⏎</kbd> copy full block</span>
			<span><kbd>Esc</kbd> close</span>
		</footer>
		<div class="empty" id="history-empty" hidden>
			No commands captured yet. Run a command in a terminal, then open this again.
		</div>
	</main>
	<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

/** Append the file's mtime so the webview resource cache cannot serve stale assets. */
function cacheBust(uri: vscode.Uri): string {
	try {
		return `${uri.toString()}?v=${fs.statSync(uri.fsPath).mtimeMs}`;
	} catch {
		return uri.toString();
	}
}
