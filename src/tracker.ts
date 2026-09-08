import * as vscode from 'vscode';
import { stripNonPrintable } from './ansi';
import { CapturedExecution } from './format';

const MAX_OUTPUT_LENGTH = 100_000;

interface PendingCapture {
	startTime: number;
	cwd: string | undefined;
	commandLine: string;
	outputPromise: Promise<string>;
}

const pendingMap = new Map<vscode.Terminal, PendingCapture>();
const capturedMap = new Map<vscode.Terminal, CapturedExecution>();

export function activateTracker(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.window.onDidStartTerminalShellExecution(onStart),
		vscode.window.onDidEndTerminalShellExecution(onEnd),
		vscode.window.onDidCloseTerminal(onClose),
	);
}

function onStart(event: vscode.TerminalShellExecutionStartEvent): void {
	const { terminal, execution } = event;
	const startTime = Date.now();
	const cwd = execution.cwd?.fsPath;
	const commandLine = execution.commandLine.value;

	const outputPromise = collectOutput(execution);

	pendingMap.set(terminal, { startTime, cwd, commandLine, outputPromise });
}

async function collectOutput(execution: vscode.TerminalShellExecution): Promise<string> {
	let buffer = '';
	try {
		for await (const chunk of execution.read()) {
			buffer += chunk;
			if (buffer.length > MAX_OUTPUT_LENGTH) {
				buffer = buffer.slice(0, MAX_OUTPUT_LENGTH) + '\n[output truncated]';
				break;
			}
		}
	} catch {
		// stream may be cancelled
	}
	return stripNonPrintable(buffer);
}

function onEnd(event: vscode.TerminalShellExecutionEndEvent): void {
	const { terminal, exitCode } = event;
	const pending = pendingMap.get(terminal);
	if (!pending) {
		return;
	}

	pendingMap.delete(terminal);

	pending.outputPromise.then(output => {
		const captured: CapturedExecution = {
			commandLine: pending.commandLine,
			cwd: pending.cwd,
			exitCode,
			output,
			startTime: pending.startTime,
			endTime: Date.now(),
		};
		capturedMap.set(terminal, captured);
	});
}

function onClose(terminal: vscode.Terminal): void {
	pendingMap.delete(terminal);
	capturedMap.delete(terminal);
}

export function getCaptured(terminal: vscode.Terminal): CapturedExecution | undefined {
	return capturedMap.get(terminal);
}