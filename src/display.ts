import * as vscode from 'vscode';
import { hideHistoryPanel, showHistoryPanel, showHistoryWindow } from './editorPanel';
import { HistoryViewProvider, syncDisplayContext } from './panelView';
import { getHistoryDisplay } from './settings';
import { HistoryStore } from './store';

/** Open the history using the configured presentation. */
export function showHistory(
	context: vscode.ExtensionContext,
	store: HistoryStore,
	viewProvider: HistoryViewProvider
): void {
	const display = getHistoryDisplay();
	void syncDisplayContext();
	switch (display) {
		case 'panel':
		case 'sidebar':
		case 'secondarySidebar':
			void viewProvider.show(display);
			return;
		case 'window':
			void showHistoryWindow(context, store);
			return;
		default:
			showHistoryPanel(context, store);
			return;
	}
}

/** Close the editor-area panel (docked views are hidden by the workbench). */
export function hideHistory(): void {
	hideHistoryPanel();
}
