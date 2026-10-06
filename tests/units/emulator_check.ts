#!/usr/bin/env bun
/**
 * Pure-logic check of the headless terminal wrapper
 * (`src/terminalEmulator.ts`). Run with `bun tests/units/emulator_check.ts`.
 */
import assert from 'node:assert';
import { TerminalEmulator, scrollbackLinesFor } from '../../src/terminalEmulator';

const section = (name: string): void => console.log(`\n== ${name} ==`);

function emulator(columns = 20, rows = 4, scrollback = 100): TerminalEmulator {
	return new TerminalEmulator({ columns, rows, scrollback });
}

section('linear output is captured line by line');
{
	const term = emulator();
	term.write('alpha\r\nbravo\r\ncharlie\r\n');
	await term.whenIdle();
	assert.strictEqual(term.serializeBuffer(), 'alpha\nbravo\ncharlie');
	term.dispose();
	console.log('ok - three lines, no escape leakage');
}

section('soft-wrapped rows re-join into one logical line');
{
	const term = emulator(20, 4, 100);
	term.write(`${'x'.repeat(95)}\r\n`);
	await term.whenIdle();
	const lines = term.serializeBuffer().split('\n');
	assert.strictEqual(lines.length, 1, 'long line stays one logical line');
	assert.strictEqual(lines[0], 'x'.repeat(95));
	term.dispose();
	console.log('ok - 95-char line re-joined, not hard-wrapped at 20 cols');
}

section('carriage returns collapse to the final overwrite');
{
	const term = emulator();
	term.write('progress 10%\rprogress 100%\r\n');
	await term.whenIdle();
	assert.strictEqual(term.serializeBuffer(), 'progress 100%');
	term.dispose();
	console.log('ok - \\r overwrite resolved, not duplicated');
}

section('alternate screen is detected and snapshotted');
{
	const term = emulator(20, 4, 10);
	term.write('\x1b[?1049h\x1b[2J\x1b[HTUI-TOP\x1b[3;1HTUI-BOT');
	await term.whenIdle();
	assert.strictEqual(term.isAlternate, true);
	assert.strictEqual(term.serializeViewport(), 'TUI-TOP\n\nTUI-BOT');
	// Leaving the alternate screen restores a different, empty buffer.
	term.write('\x1b[?1049l');
	await term.whenIdle();
	assert.strictEqual(term.isAlternate, false);
	term.dispose();
	console.log('ok - alt screen snapshotted; buffer type follows ?1049h/l');
}

section('resize keeps absolute cursor addressing in range');
{
	const term = emulator(20, 4, 10);
	term.resize(40, 10);
	term.write('\x1b[10;1HBOTTOM-ROW');
	await term.whenIdle();
	assert.strictEqual(term.serializeViewport().split('\n').pop(), 'BOTTOM-ROW');
	term.dispose();
	console.log('ok - grew the grid; row 10 is addressable');
}

section('scrollback retains output beyond the viewport');
{
	const term = emulator(20, 3, 100);
	const lines = Array.from({ length: 30 }, (_, i) => `line-${i}`);
	term.write(`${lines.join('\r\n')}\r\n`);
	await term.whenIdle();
	const captured = term.serializeBuffer().split('\n');
	assert.strictEqual(captured.length, 30);
	assert.strictEqual(captured[0], 'line-0');
	assert.strictEqual(captured[29], 'line-29');
	assert.strictEqual(term.serializeViewport(), 'line-28\nline-29');
	term.dispose();
	console.log('ok - 30 lines retained; viewport still 3 rows');
}

section('scrollback line budget scales inversely with width');
{
	assert.strictEqual(scrollbackLinesFor(1000, 100), 11);
	assert.ok(scrollbackLinesFor(1_000_000, 80) < scrollbackLinesFor(1_000_000, 40));
	assert.strictEqual(scrollbackLinesFor(0, 80), 1);
	console.log('ok - bounded line counts');
}

console.log('\nall emulator checks passed');
