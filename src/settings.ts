import * as vscode from 'vscode';

export type HistoryDisplay = 'editor' | 'panel' | 'sidebar' | 'secondarySidebar' | 'window';

const DISPLAYS: readonly HistoryDisplay[] = [
	'editor',
	'panel',
	'sidebar',
	'secondarySidebar',
	'window',
];

/** The `terminalEnhanced.historyDisplay` setting (defaults to `editor`). */
export function getHistoryDisplay(): HistoryDisplay {
	const value = vscode.workspace
		.getConfiguration('terminalEnhanced')
		.get<string>('historyDisplay', 'editor');
	return (DISPLAYS as readonly string[]).includes(value) ? (value as HistoryDisplay) : 'editor';
}

/** The `terminalEnhanced.closeOnCopy` setting (defaults to `false`). */
export function getCloseOnCopy(): boolean {
	return vscode.workspace
		.getConfiguration('terminalEnhanced')
		.get<boolean>('closeOnCopy', false);
}

/** The `terminalEnhanced.emulatedCapture` setting (defaults to `true`). */
export function getEmulatedCapture(): boolean {
	return vscode.workspace
		.getConfiguration('terminalEnhanced')
		.get<boolean>('emulatedCapture', true);
}
