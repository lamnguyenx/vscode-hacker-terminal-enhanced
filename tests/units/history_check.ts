#!/usr/bin/env bun
/**
 * Pure-logic check of the display helpers (`src/history.ts`).
 * Run with `bun tests/units/history_check.ts`.
 */
import assert from 'node:assert';
import { firstLine, toDisplayItem } from '../../src/history';

const section = (name: string): void => console.log(`\n== ${name} ==`);

section('firstLine keeps the first line, trimmed');
assert.strictEqual(firstLine('git status'), 'git status');
assert.strictEqual(firstLine('  echo hi  '), 'echo hi');
assert.strictEqual(firstLine('line one\nline two'), 'line one');
assert.strictEqual(firstLine('line one\r\nline two'), 'line one');
console.log('ok - single and multi-line commands');

section('firstLine falls back for empty commands');
assert.strictEqual(firstLine(''), '(empty command)');
assert.strictEqual(firstLine('   '), '(empty command)');
assert.strictEqual(firstLine('\nsecond'), '(empty command)');
console.log('ok - blank first lines');

section('toDisplayItem maps a stored row to the webview shape');
const item = toDisplayItem({
	id: 7,
	commandLine: 'npm test\n--watch',
	cwd: '/proj',
	exitCode: 1,
	startTime: 1000,
	endTime: 1200,
});
assert.deepStrictEqual(item, {
	id: 7,
	firstLine: 'npm test',
	command: 'npm test\n--watch',
	cwd: '/proj',
	exitCode: 1,
	startedAt: 1000,
});
console.log('ok - fields mapped');

section('toDisplayItem carries undefined metadata through');
const bare = toDisplayItem({
	id: 1,
	commandLine: 'true',
	cwd: undefined,
	exitCode: undefined,
	startTime: 5,
	endTime: 6,
});
assert.strictEqual(bare.cwd, undefined);
assert.strictEqual(bare.exitCode, undefined);
console.log('ok - undefined cwd/exitCode preserved');

console.log('\nhistory_check: all checks passed');
