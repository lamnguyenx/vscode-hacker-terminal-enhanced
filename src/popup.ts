import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { formatExecution } from './format';
import { toDisplayItem } from './history';
import { HistoryStore } from './store';

const VIEW_TYPE = 'terminalEnhanced.history';

let panel: vscode.WebviewPanel | undefined;

/**
 * The command-history popup: a compact, popup-like webview panel in the editor
 * area. `↑/↓` browse, `Enter` copies the selected command's full LLM block,
 * `Esc` closes; losing focus dismisses it like a popup.
 */
export function showHistory(context: vscode.ExtensionContext, store: HistoryStore): void {
	if (panel) {
		panel.reveal(vscode.ViewColumn.Active);
		postItems(store);
		return;
	}

	const created = vscode.window.createWebviewPanel(
		VIEW_TYPE,
		'Hacker Terminal History',
		vscode.ViewColumn.Active,
		{
			enableScripts: true,
			retainContextWhenHidden: false,
			localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
		}
	);
	panel = created;

	created.webview.html = buildHtml(context, created.webview);

	// Only dismiss once the UI has actually rendered, so a transient inactive
	// state during panel creation cannot close the popup immediately.
	let armed = false;
	const subscriptions: vscode.Disposable[] = [];
	subscriptions.push(
		created.webview.onDidReceiveMessage(message => {
			if ((message as { type?: unknown } | undefined)?.type === 'ready') {
				armed = true;
			}
			void handleMessage(message, store);
		}),
		store.onDidChange(() => postItems(store)),
		// Dismiss like a popup when the panel is no longer the active editor.
		created.onDidChangeViewState(event => {
			if (!event.webviewPanel.active && armed) {
				event.webviewPanel.dispose();
			}
		})
	);

	created.onDidDispose(() => {
		for (const disposable of subscriptions) {
			disposable.dispose();
		}
		panel = undefined;
	});
}

/** Close the popup if it is open. */
export function hideHistory(): void {
	panel?.dispose();
}

/** Remove every retained command; refreshes an open popup. */
export function clearHistory(store: HistoryStore): void {
	store.clear();
}

async function handleMessage(message: unknown, store: HistoryStore): Promise<void> {
	const type = (message as { type?: unknown } | undefined)?.type;
	switch (type) {
		case 'ready':
			postItems(store);
			return;
		case 'close':
			panel?.dispose();
			return;
		case 'copy': {
			const id = Number((message as { id?: unknown }).id);
			if (!Number.isFinite(id)) {
				return;
			}
			const entry = store.get(id);
			if (!entry) {
				return;
			}
			await vscode.env.clipboard.writeText(formatExecution(entry));
			void vscode.window.setStatusBarMessage(
				'$(check) Hacker Terminal Enhanced: copied command + output',
				3000
			);
			panel?.dispose();
			return;
		}
		default:
			return;
	}
}

function postItems(store: HistoryStore): void {
	if (!panel) {
		return;
	}
	const items = store.list().map(toDisplayItem);
	try {
		void panel.webview.postMessage({ type: 'items', items });
	} catch {
		// panel may have just been disposed
	}
}

function buildHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
	const nonce = getNonce();
	const cspSource = webview.cspSource;
	const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
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
