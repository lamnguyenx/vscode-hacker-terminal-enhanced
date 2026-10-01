import * as vscode from 'vscode';
import { buildHistoryHtml, wireHistoryWebview } from './historyWebview';
import { getCloseOnCopy, getHistoryDisplay } from './settings';
import { HistoryStore } from './store';

/** The single docked history view; it is moved between containers on demand. */
export const HISTORY_VIEW_ID = 'terminalEnhanced.historyView';

/** Context key gating the view (only visible in a docked mode). */
export const HISTORY_DISPLAY_CONTEXT = 'terminalEnhanced.display';

/** Destination containers, one per docked location. Custom containers are
 *  registered under the `workbench.view.extension.` prefix. */
const CONTAINER_PREFIX = 'workbench.view.extension.';
const CONTAINER_BY_LOCATION = {
	panel: `${CONTAINER_PREFIX}terminalEnhanced-panel`,
	sidebar: `${CONTAINER_PREFIX}terminalEnhanced-sidebar`,
	secondarySidebar: `${CONTAINER_PREFIX}terminalEnhanced-auxiliary`,
} as const;

export type ViewLocation = keyof typeof CONTAINER_BY_LOCATION;

export class HistoryViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	private readonly extensionUri: vscode.Uri;
	private readonly store: HistoryStore;
	private viewDisposables: vscode.Disposable[] = [];

	constructor(extensionUri: vscode.Uri, store: HistoryStore) {
		this.extensionUri = extensionUri;
		this.store = store;
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.disposeView();

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
		};

		this.viewDisposables = [
			...wireHistoryWebview(
				{
					webview: webviewView.webview,
					close: hideHistoryContainer,
					shouldCloseOnCopy: getCloseOnCopy,
				},
				this.store
			),
			webviewView.onDidDispose(() => this.disposeView()),
		];

		webviewView.webview.html = buildHistoryHtml(this.extensionUri, webviewView.webview);
	}

	/** Move the view to the requested container and focus it. */
	async show(location: ViewLocation): Promise<void> {
		await syncDisplayContext();
		try {
			await vscode.commands.executeCommand('vscode.moveViews', {
				viewIds: [HISTORY_VIEW_ID],
				destinationId: CONTAINER_BY_LOCATION[location],
			});
		} catch {
			// Fall through to focus; it may already be in the right container.
		}
		try {
			await vscode.commands.executeCommand(`${HISTORY_VIEW_ID}.focus`);
		} catch {
			// container may be unavailable
		}
	}

	dispose(): void {
		this.disposeView();
	}

	private disposeView(): void {
		for (const disposable of this.viewDisposables) {
			try {
				disposable.dispose();
			} catch {
				// already disposed
			}
		}
		this.viewDisposables = [];
	}
}

/** Mirror the display setting into the context key gating the view. */
export function syncDisplayContext(): Thenable<unknown> {
	return vscode.commands.executeCommand(
		'setContext',
		HISTORY_DISPLAY_CONTEXT,
		getHistoryDisplay()
	);
}

/** Hide the container that currently hosts the history view. */
function hideHistoryContainer(): void {
	switch (getHistoryDisplay()) {
		case 'panel':
			void vscode.commands.executeCommand('workbench.action.closePanel');
			return;
		case 'sidebar':
			void vscode.commands.executeCommand('workbench.action.toggleSidebarVisibility');
			return;
		case 'secondarySidebar':
			void vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar');
			return;
		default:
			return;
	}
}
