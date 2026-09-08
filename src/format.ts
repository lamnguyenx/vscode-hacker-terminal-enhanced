export interface CapturedExecution {
	commandLine: string;
	cwd?: string;
	exitCode: number | undefined;
	output: string;
	startTime: number;
	endTime: number;
}

export function formatExecution(data: CapturedExecution): string {
	const started = formatTimestamp(data.startTime);
	const ended = formatTimestamp(data.endTime);
	const duration = formatDuration(data.startTime, data.endTime);
	const exitCode = data.exitCode !== undefined ? String(data.exitCode) : 'unknown';
	const cwdStr = data.cwd ?? '(unknown)';

	const parts: string[] = [
		'# ----------------- TERMINAL EXECUTION: SUMMARY -----------------',
		`- Working Directory: ${cwdStr}`,
		`- Exit Code: ${exitCode}`,
		`- Started: ${started}`,
		`- Ended: ${ended}`,
		`- Duration: ${duration}`,
		'', '', '',
		'# ----------------- TERMINAL EXECUTION: COMMAND -----------------',
		data.commandLine,
		'', '', '',
		'# ----------------- TERMINAL EXECUTION: STDERR + STDOUT -----------------',
		data.output || '(no output)',
		'', '', '', '',
	];

	return parts.join('\n');
}

function formatTimestamp(ms: number): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	const d = new Date(ms);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatDuration(startMs: number, endMs: number): string {
	const ms = endMs - startMs;
	if (ms < 1000) {
		return `${ms}ms`;
	}
	const s = (ms / 1000).toFixed(2);
	return `${s}s`;
}