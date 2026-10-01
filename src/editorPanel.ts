import * as vscode from 'vscode';
import { buildHistoryHtml, postHistoryItems, wireHistoryWebview } from './historyWebview';
import { getCloseOnCopy } from './settings';
import { HistoryStore } from './store';

const VIEW_TYPE = 'terminalEnhanced.history';

let panel: vscode.WebviewPanel | undefined;

/**
 * `editor` display: a two-pane webview in the editor area. Stays open until it
 * is closed, unless `terminalEnhanced.closeOnCopy` is enabled.
 */
export function showHistoryPanel(context: vscode.ExtensionContext, store: HistoryStore): void {
	if (panel) {
		panel.reveal(vscode.ViewColumn.Active);
		postHistoryItems(panel.webview, store);
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

	created.webview.html = buildHistoryHtml(context.extensionUri, created.webview);

	const subscriptions = wireHistoryWebview(
		{
			webview: created.webview,
			close: () => created.dispose(),
			shouldCloseOnCopy: getCloseOnCopy,
		},
		store
	);

	created.onDidDispose(() => {
		for (const disposable of subscriptions) {
			disposable.dispose();
		}
		panel = undefined;
	});
}

/** `window` display: open the editor panel, then move it into its own window. */
export async function showHistoryWindow(
	context: vscode.ExtensionContext,
	store: HistoryStore
): Promise<void> {
	showHistoryPanel(context, store);
	try {
		await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
	} catch {
		// If the command is unavailable the panel just stays in the editor area.
	}
}

/** Close the editor-area panel if it is open. */
export function hideHistoryPanel(): void {
	panel?.dispose();
}
