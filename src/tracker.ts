import * as vscode from 'vscode';
import { stripNonPrintable } from './ansi';
import { CapturedExecution } from './format';
import { HistoryStore } from './store';

interface PendingCapture {
	startTime: number;
	cwd: string | undefined;
	commandLine: string;
	outputPromise: Promise<string>;
}

const pendingMap = new Map<vscode.Terminal, PendingCapture>();

/**
 * Track terminal executions and persist each finished one to the history
 * store. The store is global (across terminals and windows) and persisted to
 * disk, so the popup can browse commands from earlier sessions too.
 */
export function activateTracker(
	context: vscode.ExtensionContext,
	store: HistoryStore,
	getMaxOutputLength: () => number
): void {
	context.subscriptions.push(
		vscode.window.onDidStartTerminalShellExecution(event => {
			onStart(event, getMaxOutputLength());
		}),
		vscode.window.onDidEndTerminalShellExecution(event => {
			onEnd(event, store);
		}),
		vscode.window.onDidCloseTerminal(onClose)
	);
}

function onStart(event: vscode.TerminalShellExecutionStartEvent, maxOutputLength: number): void {
	const { terminal, execution } = event;
	pendingMap.set(terminal, {
		startTime: Date.now(),
		cwd: execution.cwd?.fsPath,
		commandLine: execution.commandLine.value,
		outputPromise: collectOutput(execution, maxOutputLength),
	});
}

/**
 * Drain the execution's output stream.
 *
 * Note: VS Code's shell-integration data stream drops output that arrives
 * before the consumer registers (a race in `ShellExecutionDataStream`), which
 * can leave the very fastest shell builtins (e.g. `echo`) with no output. This
 * is a platform limitation; external commands are captured normally.
 */
async function collectOutput(
	execution: vscode.TerminalShellExecution,
	maxOutputLength: number
): Promise<string> {
	let buffer = '';
	try {
		for await (const chunk of execution.read()) {
			buffer += chunk;
			if (buffer.length > maxOutputLength) {
				buffer = buffer.slice(0, maxOutputLength) + '\n[output truncated]';
				break;
			}
		}
	} catch {
		// stream may be cancelled
	}
	return stripNonPrintable(buffer);
}

function onEnd(event: vscode.TerminalShellExecutionEndEvent, store: HistoryStore): void {
	const { terminal, exitCode } = event;
	const pending = pendingMap.get(terminal);
	if (!pending) {
		return;
	}
	pendingMap.delete(terminal);

	void pending.outputPromise.then(output => {
		const captured: CapturedExecution = {
			commandLine: pending.commandLine,
			cwd: pending.cwd,
			exitCode,
			output,
			startTime: pending.startTime,
			endTime: Date.now(),
		};
		try {
			store.add(captured);
		} catch (error) {
			console.error('[hacker-terminal-enhanced] failed to persist command', error);
		}
	});
}

function onClose(terminal: vscode.Terminal): void {
	pendingMap.delete(terminal);
}
