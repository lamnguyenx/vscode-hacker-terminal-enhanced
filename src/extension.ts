import * as vscode from 'vscode';
import { hideHistory, showHistory } from './display';
import { HISTORY_VIEW_ID, HistoryViewProvider, syncDisplayContext } from './panelView';
import { getEmulatedCapture } from './settings';
import { HistoryStore } from './store';
import { activateTracker, type CaptureOptions } from './tracker';

interface TerminalEnhancedConfig {
	historySize: number;
	maxOutputLength: number;
}

let store: HistoryStore | undefined;

function getConfig(): TerminalEnhancedConfig {
	const cfg = vscode.workspace.getConfiguration('terminalEnhanced');
	return {
		historySize: cfg.get<number>('historySize', 10),
		// 1 MB per command: long logs are kept in full, up to the retention limit.
		maxOutputLength: cfg.get<number>('maxOutputLength', 1_000_000),
	};
}

/** Capture options for a command that is starting right now. */
function getCaptureOptions(): CaptureOptions {
	return {
		maxOutputLength: getConfig().maxOutputLength,
		emulated: getEmulatedCapture(),
	};
}

export function activate(context: vscode.ExtensionContext): void {
	const initial = getConfig();
	const dbPath = vscode.Uri.joinPath(context.globalStorageUri, 'history.sqlite').fsPath;

	let history: HistoryStore;
	try {
		history = new HistoryStore(dbPath, initial.historySize);
	} catch (error) {
		void vscode.window.showErrorMessage(
			`Hacker Terminal Enhanced: could not open the history database. ${String(error)}`
		);
		return;
	}
	store = history;

	const viewProvider = new HistoryViewProvider(context.extensionUri, history);
	void syncDisplayContext();

	context.subscriptions.push(
		history,
		viewProvider,
		vscode.window.registerWebviewViewProvider(HISTORY_VIEW_ID, viewProvider),
		vscode.commands.registerCommand('terminalEnhanced.showHistory', () =>
			showHistory(context, history, viewProvider)
		),
		vscode.commands.registerCommand('terminalEnhanced.hideHistory', () => hideHistory()),
		vscode.commands.registerCommand('terminalEnhanced.clearHistory', () => history.clear()),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('terminalEnhanced.historyDisplay')) {
				void syncDisplayContext();
			}
			if (event.affectsConfiguration('terminalEnhanced.historySize')) {
				history.setLimit(getConfig().historySize);
			}
		})
	);

	activateTracker(context, history, getCaptureOptions);
}

export function deactivate(): void {
	store?.dispose();
	store = undefined;
}
