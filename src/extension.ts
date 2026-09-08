import * as vscode from 'vscode';
import { activateTracker, getCaptured } from './tracker';
import { formatExecution } from './format';

export function activate(context: vscode.ExtensionContext): void {
	activateTracker(context);

	context.subscriptions.push(
		vscode.commands.registerCommand('terminalEnhanced.copyLast', copyLast)
	);
}

function copyLast(): void {
	const terminal = vscode.window.activeTerminal;
	if (!terminal) {
		void vscode.window.showWarningMessage('No active terminal.');
		return;
	}

	const captured = getCaptured(terminal);
	if (!captured) {
		void vscode.window.showWarningMessage(
			'No command captured for the active terminal. ' +
			'Make sure shell integration is enabled and a command has been run.'
		);
		return;
	}

	const text = formatExecution(captured);
	void vscode.env.clipboard.writeText(text).then(() => {
		void vscode.window.setStatusBarMessage(
			'$(check) Terminal Enhanced: copied last command + output',
			3000
		);
	});
}

export function deactivate(): void {
	// nothing to clean up
}