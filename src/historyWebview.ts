import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { copyExecution } from './copy';
import { toDisplayItem } from './history';
import { buildHistoryDocument } from './historyMarkup';
import { HistoryStore } from './store';

/**
 * Shared webview plumbing for the webview presentations of the history (the
 * editor-area panel, the separate window, and the three docked views). All
 * render the same `media/popup.*` assets and speak the same
 * `{ready|preview|copy|copied|close}` protocol.
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
			if (await copyExecution(store, id)) {
				try {
					void host.webview.postMessage({ type: 'copied', id });
				} catch {
					// the webview may have just been disposed
				}
				if (host.shouldCloseOnCopy()) {
					host.close();
				}
			}
			return;
		}
		case 'preview': {
			const id = Number((message as { id?: unknown }).id);
			if (!Number.isFinite(id)) {
				return;
			}
			const entry = store.get(id);
			if (!entry) {
				return;
			}
			try {
				void host.webview.postMessage({
					type: 'output',
					id,
					output: entry.output,
					length: entry.outputLength,
				});
			} catch {
				// the webview may have just been disposed
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
	const mediaRoot = vscode.Uri.joinPath(extensionUri, 'media');
	const cssUri = cacheBust(webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'popup.css')));
	const jsUri = cacheBust(webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'popup.js')));

	return buildHistoryDocument({ cssUri, jsUri, nonce, cspSource: webview.cspSource });
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
