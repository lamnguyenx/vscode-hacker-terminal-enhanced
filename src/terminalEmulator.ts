import { Terminal } from '@xterm/headless';

/** Fallback grid when VS Code has not reported the terminal's dimensions yet. */
const FALLBACK_COLUMNS = 80;
const FALLBACK_ROWS = 24;

/**
 * Scrollback lines that hold roughly `maxOutputLength` characters at the given
 * width. xterm stores a full-width row of cells for every line regardless of
 * how much text is on it, so bounding the *line count* is what bounds memory.
 */
export function scrollbackLinesFor(maxOutputLength: number, columns: number): number {
	const cols = Math.max(1, columns);
	return Math.max(1, Math.ceil(maxOutputLength / cols) + 1);
}

/**
 * A headless xterm terminal that turns a terminal's raw byte stream into
 * capturable text.
 *
 * A linear ANSI strip cannot represent a full-screen TUI: it has no notion of
 * the cursor or the alternate screen, so `tig`/`gdu`/`less`/`vim`/`htop` come
 * out as a mashed-together run of every repaint. Feeding the same bytes through
 * a real terminal emulator yields the screen the user actually saw, and lets
 * ordinary output be serialized with soft-wrapped rows re-joined into logical
 * lines. See
 * `docs/plans/2026/10/05/2026-10-05-tui-and-emulated-capture.md`.
 *
 * This module deliberately avoids a `vscode` import so it is unit-checked with
 * bun.
 */
export class TerminalEmulator {
	private readonly term: Terminal;
	private columns: number;
	private rows: number;

	constructor(options: { columns: number; rows: number; scrollback: number }) {
		this.columns = normalizeDimension(options.columns, FALLBACK_COLUMNS);
		this.rows = normalizeDimension(options.rows, FALLBACK_ROWS);
		this.term = new Terminal({
			cols: this.columns,
			rows: this.rows,
			scrollback: Math.max(0, Math.floor(options.scrollback) || 0),
			allowProposedApi: true,
		});
	}

	/** Feed raw terminal bytes (already sliced to the command's output region). */
	write(data: string): void {
		if (data.length > 0) {
			this.term.write(data);
		}
	}

	/**
	 * Resolve once every byte written so far has been parsed. Because xterm
	 * parses asynchronously, serializing immediately after a write can miss the
	 * tail; an empty write's callback is queued behind the pending data.
	 */
	whenIdle(): Promise<void> {
		return new Promise(resolve => this.term.write('', () => resolve()));
	}

	/** Track the terminal's grid so absolute cursor addressing stays faithful. */
	resize(columns: number, rows: number): void {
		const cols = normalizeDimension(columns, this.columns);
		const next = normalizeDimension(rows, this.rows);
		if (cols === this.columns && next === this.rows) {
			return;
		}
		this.columns = cols;
		this.rows = next;
		this.term.resize(cols, next);
	}

	/** True while the alternate screen buffer is active (a full-screen TUI). */
	get isAlternate(): boolean {
		return this.term.buffer.active.type === 'alternate';
	}

	/** The visible screen only — what a full-screen TUI is displaying. */
	serializeViewport(): string {
		const buffer = this.term.buffer.active;
		const first = buffer.baseY;
		const last = Math.min(buffer.length, first + this.rows);
		return this.serializeRange(first, last);
	}

	/** The whole retained buffer, scrollback included. */
	serializeBuffer(): string {
		const buffer = this.term.buffer.active;
		return this.serializeRange(0, buffer.length);
	}

	dispose(): void {
		this.term.dispose();
	}

	/**
	 * Serialize a range of buffer lines into logical, right-trimmed lines.
	 * Soft-wrapped continuation rows (`isWrapped`) are appended to the previous
	 * line instead of starting a new one, so a long line stays one line rather
	 * than being hard-wrapped at the terminal width.
	 */
	private serializeRange(first: number, last: number): string {
		const buffer = this.term.buffer.active;
		const lines: string[] = [];
		for (let y = first; y < last; y++) {
			const line = buffer.getLine(y);
			const text = line ? line.translateToString(true) : '';
			if (line && line.isWrapped && lines.length > 0) {
				lines[lines.length - 1] += text;
			} else {
				lines.push(text);
			}
		}
		while (lines.length > 0 && lines[lines.length - 1] === '') {
			lines.pop();
		}
		return lines.join('\n');
	}
}

function normalizeDimension(value: number, fallback: number): number {
	const n = Math.floor(value);
	return Number.isFinite(n) && n >= 1 ? n : fallback;
}
