import * as vscode from 'vscode';
import { formatExecution } from './format';
import { HistoryStore } from './store';

/** Copy one stored execution as the full LLM block; returns false if it is gone. */
export async function copyExecution(store: HistoryStore, id: number): Promise<boolean> {
	const entry = store.get(id);
	if (!entry) {
		return false;
	}
	await vscode.env.clipboard.writeText(formatExecution(entry));
	void vscode.window.setStatusBarMessage(
		'$(check) Hacker Terminal Enhanced: copied command + output',
		3000
	);
	return true;
}
