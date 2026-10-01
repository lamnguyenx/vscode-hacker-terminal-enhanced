import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CapturedExecution } from './format';
import { StoredExecution, StoredMeta } from './history';

/**
 * SQLite-backed command history (built-in `node:sqlite`, no native deps).
 *
 * One row per command; only the newest `limit` rows are retained. The popup
 * lists metadata only, so the (up to `maxOutputLength` bytes) output column is
 * read lazily, by id, when a command is actually copied.
 *
 * The module deliberately avoids a `vscode` import: it takes a plain filesystem
 * path and is unit-checked with bun (`node:sqlite` is supported there too).
 */

interface MetaRow {
	id: number;
	commandLine: string;
	cwd: string | null;
	exitCode: number | null;
	startTime: number;
	endTime: number;
	running: number;
	outputLength: number;
}

interface OutputRow extends MetaRow {
	output: string;
}

export interface HistoryStoreOptions {
	/**
	 * Open the database read-only (used by the browser dev harness to mirror the
	 * real history without risking writes). Skips WAL setup, migration, and
	 * stale-row settling; all mutators become no-ops.
	 */
	readOnly?: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS history (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	command_line TEXT NOT NULL,
	cwd TEXT,
	exit_code INTEGER,
	output TEXT NOT NULL,
	start_time INTEGER NOT NULL,
	end_time INTEGER NOT NULL,
	captured_at INTEGER NOT NULL,
	running INTEGER NOT NULL DEFAULT 0
);
`;

const META_COLUMNS = `
	id,
	command_line AS commandLine,
	cwd,
	exit_code AS exitCode,
	start_time AS startTime,
	end_time AS endTime,
	running,
	length(output) AS outputLength
`;

export class HistoryStore {
	private readonly db: DatabaseSync;
	private readonly listeners = new Set<() => void>();
	private readonly readOnly: boolean;
	private limit: number;
	private closed = false;

	constructor(dbPath: string, limit: number, options: HistoryStoreOptions = {}) {
		this.limit = normalizeLimit(limit);
		this.readOnly = options.readOnly === true;
		if (!this.readOnly) {
			fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		}
		this.db = this.readOnly
			? new DatabaseSync(dbPath, { readOnly: true })
			: new DatabaseSync(dbPath);
		// busy_timeout tolerates a second connection (the extension host) on the
		// same DB file.
		this.db.exec('PRAGMA busy_timeout = 3000;');
		if (this.readOnly) {
			return;
		}
		// WAL keeps writes durable and non-blocking.
		this.db.exec('PRAGMA journal_mode = WAL;');
		this.db.exec(SCHEMA);
		this.migrate();
		// A restart cannot resume an in-flight execution, so any row still marked
		// running is a leftover from a crashed/closed host: settle it as "done".
		this.db.exec('UPDATE history SET running = 0 WHERE running = 1;');
	}

	/** Add the `running` column to databases created before live streaming. */
	private migrate(): void {
		const columns = this.db
			.prepare('PRAGMA table_info(history)')
			.all() as unknown as Array<{ name: string }>;
		if (!columns.some(column => column.name === 'running')) {
			this.db.exec('ALTER TABLE history ADD COLUMN running INTEGER NOT NULL DEFAULT 0;');
		}
	}

	/** Insert a finished command and evict anything past the retention limit. */
	add(execution: CapturedExecution): void {
		if (this.closed || this.readOnly) {
			return;
		}
		this.db
			.prepare(
				`INSERT INTO history (command_line, cwd, exit_code, output, start_time, end_time, captured_at, running)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
			)
			.run(
				execution.commandLine,
				execution.cwd ?? null,
				execution.exitCode ?? null,
				execution.output,
				execution.startTime,
				execution.endTime,
				Date.now()
			);
		this.evict();
		this.emit();
	}

	/**
	 * Insert a command that is still running (e.g. `tail -f`) and return its id,
	 * so output can be appended and the row finalized when it ends.
	 */
	startRunning(execution: { commandLine: string; cwd?: string; startTime: number }): number {
		if (this.closed || this.readOnly) {
			return -1;
		}
		const result = this.db
			.prepare(
				`INSERT INTO history (command_line, cwd, exit_code, output, start_time, end_time, captured_at, running)
				 VALUES (?, ?, NULL, '', ?, ?, ?, 1)`
			)
			.run(
				execution.commandLine,
				execution.cwd ?? null,
				execution.startTime,
				execution.startTime,
				Date.now()
			);
		this.evict();
		this.emit();
		return Number(result.lastInsertRowid);
	}

	/** Replace the captured output of a running row (called on a throttle). */
	updateOutput(id: number, output: string): void {
		if (this.closed || this.readOnly) {
			return;
		}
		this.db.prepare('UPDATE history SET output = ? WHERE id = ?').run(output, id);
		this.emit();
	}

	/** Mark a running row as finished with its exit code and end time. */
	finish(id: number, exitCode: number | undefined, endTime: number): void {
		if (this.closed || this.readOnly) {
			return;
		}
		this.db
			.prepare('UPDATE history SET running = 0, exit_code = ?, end_time = ? WHERE id = ?')
			.run(exitCode ?? null, endTime, id);
		this.emit();
	}

	/** Newest-first metadata for the popup list (no output). */
	list(): StoredMeta[] {
		if (this.closed) {
			return [];
		}
		const rows = this.db
			.prepare(
				`SELECT ${META_COLUMNS} FROM history ORDER BY id DESC LIMIT ?`
			)
			.all(this.limit) as unknown as MetaRow[];
		return rows.map(toMeta);
	}

	/** Full row, including output, for copying. */
	get(id: number): StoredExecution | undefined {
		if (this.closed) {
			return undefined;
		}
		const row = this.db
			.prepare(
				`SELECT ${META_COLUMNS}, output FROM history WHERE id = ?`
			)
			.get(id) as unknown as OutputRow | undefined;
		if (!row) {
			return undefined;
		}
		return { ...toMeta(row), output: row.output };
	}

	/** Drop every retained command. */
	clear(): void {
		if (this.closed || this.readOnly) {
			return;
		}
		this.db.exec('DELETE FROM history;');
		this.emit();
	}

	/** Retention limit; changing it also evicts immediately. */
	setLimit(limit: number): void {
		const next = normalizeLimit(limit);
		if (next === this.limit || this.closed || this.readOnly) {
			return;
		}
		this.limit = next;
		this.evict();
		this.emit();
	}

	/** Fires after a mutation, so an open popup can refresh. */
	onDidChange(listener: () => void): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	dispose(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.listeners.clear();
		this.db.close();
	}

	private emit(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// a bad listener must not break capture
			}
		}
	}

	/** Keep only the newest `limit` rows. */
	private evict(): void {
		this.db
			.prepare(
				`DELETE FROM history WHERE id NOT IN (
					SELECT id FROM history ORDER BY id DESC LIMIT ?
				)`
			)
			.run(this.limit);
	}
}

function normalizeLimit(limit: number): number {
	if (!Number.isFinite(limit)) {
		return 10;
	}
	return Math.max(1, Math.floor(limit));
}

function toMeta(row: MetaRow): StoredMeta {
	return {
		id: row.id,
		commandLine: row.commandLine,
		cwd: row.cwd ?? undefined,
		exitCode: row.exitCode ?? undefined,
		startTime: row.startTime,
		endTime: row.endTime,
		running: row.running === 1,
		outputLength: row.outputLength,
	};
}
