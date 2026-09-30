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
}

interface OutputRow extends MetaRow {
	output: string;
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
	captured_at INTEGER NOT NULL
);
`;

const META_COLUMNS = `
	id,
	command_line AS commandLine,
	cwd,
	exit_code AS exitCode,
	start_time AS startTime,
	end_time AS endTime
`;

export class HistoryStore {
	private readonly db: DatabaseSync;
	private readonly listeners = new Set<() => void>();
	private limit: number;
	private closed = false;

	constructor(dbPath: string, limit: number) {
		this.limit = normalizeLimit(limit);
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		this.db = new DatabaseSync(dbPath);
		// WAL keeps writes durable and non-blocking; busy_timeout tolerates a
		// second window opening the same DB file.
		this.db.exec('PRAGMA journal_mode = WAL;');
		this.db.exec('PRAGMA busy_timeout = 3000;');
		this.db.exec(SCHEMA);
	}

	/** Insert a captured command and evict anything past the retention limit. */
	add(execution: CapturedExecution): void {
		if (this.closed) {
			return;
		}
		this.db
			.prepare(
				`INSERT INTO history (command_line, cwd, exit_code, output, start_time, end_time, captured_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`
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
		this.db
			.prepare(
				`DELETE FROM history WHERE id NOT IN (
					SELECT id FROM history ORDER BY id DESC LIMIT ?
				)`
			)
			.run(this.limit);
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
		if (this.closed) {
			return;
		}
		this.db.exec('DELETE FROM history;');
		this.emit();
	}

	/** Retention limit; changing it also evicts immediately. */
	setLimit(limit: number): void {
		const next = normalizeLimit(limit);
		if (next === this.limit || this.closed) {
			return;
		}
		this.limit = next;
		this.db
			.prepare(
				`DELETE FROM history WHERE id NOT IN (
					SELECT id FROM history ORDER BY id DESC LIMIT ?
				)`
			)
			.run(this.limit);
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
	};
}
