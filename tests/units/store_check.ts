#!/usr/bin/env bun
/**
 * Pure-logic check of the SQLite history store (`src/store.ts`), using a
 * throwaway temp database. Run with `bun tests/units/store_check.ts`.
 */
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CapturedExecution } from '../../src/format';
import { HistoryStore } from '../../src/store';

const section = (name: string): void => console.log(`\n== ${name} ==`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hte-store-'));
const dbPath = path.join(dir, 'history.sqlite');

function execution(n: number): CapturedExecution {
	return {
		commandLine: `echo ${n}`,
		cwd: '/proj',
		exitCode: n % 2,
		output: `output-${n}`,
		startTime: 1000 + n,
		endTime: 1100 + n,
	};
}

try {
	const store = new HistoryStore(dbPath, 3);

	section('empty store');
	assert.deepStrictEqual(store.list(), []);
	assert.strictEqual(store.get(1), undefined);
	console.log('ok - nothing retained yet');

	section('inserts in newest-first order');
	for (const n of [1, 2, 3]) {
		store.add(execution(n));
	}
	const list = store.list();
	assert.strictEqual(list.length, 3);
	assert.deepStrictEqual(
		list.map(item => item.commandLine),
		['echo 3', 'echo 2', 'echo 1']
	);
	assert.deepStrictEqual(list[0].exitCode, 1);
	assert.strictEqual(list[0].cwd, '/proj');
	console.log('ok - newest first, metadata intact');

	section('retention limit evicts the oldest');
	store.add(execution(4));
	const trimmed = store.list();
	assert.strictEqual(trimmed.length, 3);
	assert.deepStrictEqual(
		trimmed.map(item => item.commandLine),
		['echo 4', 'echo 3', 'echo 2']
	);
	assert.strictEqual(store.get(1), undefined, 'evicted row is gone');
	console.log('ok - keeps only the newest N');

	section('list never returns output, but get() does');
	assert.ok(!('output' in (trimmed[0] as object)), 'list rows omit output');
	const byId = store.get(4);
	assert.ok(byId);
	assert.strictEqual(byId.output, 'output-4');
	assert.strictEqual(byId.commandLine, 'echo 4');
	console.log('ok - lazy output read');

	section('setLimit trims immediately');
	store.setLimit(1);
	const limited = store.list();
	assert.strictEqual(limited.length, 1);
	assert.strictEqual(limited[0].commandLine, 'echo 4');
	console.log('ok - retention changes take effect');

	section('onDidChange fires on add/clear');
	let changes = 0;
	const sub = store.onDidChange(() => {
		changes += 1;
	});
	store.add(execution(5));
	assert.strictEqual(changes, 1);
	store.clear();
	assert.strictEqual(changes, 2);
	assert.deepStrictEqual(store.list(), []);
	sub.dispose();
	console.log('ok - change notifications and clear');

	section('writes survive reopening');
	store.add(execution(6));
	store.dispose();
	const reopened = new HistoryStore(dbPath, 3);
	assert.deepStrictEqual(
		reopened.list().map(item => item.commandLine),
		['echo 6']
	);
	console.log('ok - persisted to disk');

	section('running rows stream output, then finish');
	const runningId = reopened.startRunning({
		commandLine: 'tail -f app.log',
		cwd: '/logs',
		startTime: 2000,
	});
	assert.ok(runningId > 0);
	const started = reopened.get(runningId);
	assert.ok(started);
	assert.strictEqual(started.running, true);
	assert.strictEqual(started.outputLength, 0);
	reopened.updateOutput(runningId, 'line one\n');
	reopened.updateOutput(runningId, 'line one\nline two\n');
	const streaming = reopened.get(runningId);
	assert.ok(streaming);
	assert.strictEqual(streaming.running, true);
	assert.strictEqual(streaming.output, 'line one\nline two\n');
	assert.strictEqual(streaming.outputLength, 'line one\nline two\n'.length);
	reopened.finish(runningId, 0, 2100);
	const finished = reopened.get(runningId);
	assert.ok(finished);
	assert.strictEqual(finished.running, false);
	assert.strictEqual(finished.exitCode, 0);
	console.log('ok - live output then finalized');

	section('stale running rows are settled on reopen');
	reopened.startRunning({ commandLine: 'tail -f other.log', startTime: 3000 });
	reopened.dispose();
	const recovered = new HistoryStore(dbPath, 3);
	const settled = recovered.list().find(item => item.commandLine === 'tail -f other.log');
	assert.ok(settled);
	assert.strictEqual(settled.running, false);
	recovered.dispose();
	console.log('ok - leftovers marked done');

	console.log('\nstore_check: all checks passed');
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}
