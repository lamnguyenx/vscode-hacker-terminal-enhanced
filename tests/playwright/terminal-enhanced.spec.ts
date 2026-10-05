import { test, expect, type Page } from '@playwright/test';
import { restCmd, restEval } from './rest';
import {
	clearHistory,
	clearNotifications,
	closePanel,
	connectWorkbench,
	copiedToast,
	EXT_FRAME_SEL,
	historyRows,
	hideHistory,
	installClipboardSpy,
	openHistory,
	openTerminal,
	previewCommand,
	previewOutput,
	previewOutputSize,
	readClipboard,
	reloadWorkbench,
	removeLogEmitter,
	resetDisplayMode,
	runInTerminal,
	runningBadge,
	sendSequence,
	setCloseOnCopy,
	setDisplayMode,
	startLogEmitter,
	waitForClipboard,
	waitForTerminalOutput,
} from './workbench';

/**
 * Hacker Terminal Enhanced — code-server E2E (CDP browser on `CDP_PORT`).
 *
 * All arrange/act goes through the REST Control API; Playwright only asserts
 * the browser-visible result:
 *   - the popup webview DOM (two panes: command list + full-command preview)
 *   - the copied payload (via a renderer-side `navigator.clipboard.writeText`
 *     hook — the pp browser cannot be OS-focused from here, so a real
 *     `readText` is denied with "Document is not focused")
 *   - the status-bar copy echo
 *
 * Prereqs: code-server up with the extension installed and the CDP browser
 * reachable on 9024 — see docs/important/how-to-test.md.
 */

const STATUS_TEXT = 'Hacker Terminal Enhanced: copied command + output';
const SUMMARY = 'TERMINAL EXECUTION: SUMMARY';

type DisplayMode = 'editor' | 'panel' | 'sidebar' | 'secondarySidebar' | 'window';

let originalDisplay: string | null = null;
let originalCloseOnCopy: boolean | null = null;

test.beforeAll(async () => {
	originalDisplay = await restEval<string | null>(
		`vscode.workspace.getConfiguration('terminalEnhanced').inspect('historyDisplay')?.globalValue ?? null`
	);
	originalCloseOnCopy = await restEval<boolean | null>(
		`vscode.workspace.getConfiguration('terminalEnhanced').inspect('closeOnCopy')?.globalValue ?? null`
	);
});

test.afterAll(async () => {
	await (originalDisplay === null
		? resetDisplayMode()
		: setDisplayMode(originalDisplay as DisplayMode)
	).catch(() => undefined);
	if (originalCloseOnCopy === null) {
		await restEval(
			`vscode.workspace.getConfiguration('terminalEnhanced')` +
				`.update('closeOnCopy', undefined, vscode.ConfigurationTarget.Global)`
		).catch(() => undefined);
	} else {
		await setCloseOnCopy(originalCloseOnCopy).catch(() => undefined);
	}
});

/** Reset the clipboard oracle and pin the presentation for this test. */
async function prepare(page: Page, mode: DisplayMode = 'editor'): Promise<void> {
	await installClipboardSpy(page);
	await setDisplayMode(mode);
	await setCloseOnCopy(false);
}

test.afterEach(async () => {
	await hideHistory().catch(() => undefined);
	await closePanel();
	await clearHistory().catch(() => undefined);
	await restCmd('workbench.action.terminal.killAll').catch(() => undefined);
	await clearNotifications();
});

test.describe('Hacker Terminal Enhanced', () => {
	test('captures the first command after a fresh window (activation regression)', async () => {
		test.setTimeout(150000);
		const { browser, page } = await connectWorkbench();
		try {
			// A reload restarts the extension host. The extension must activate
			// on its own (`onStartupFinished`) so this first command is tracked.
			await reloadWorkbench(page);
			await prepare(page);
			await clearHistory();

			await openTerminal(page);
			await runInTerminal("bash -c 'sleep 0.3 && echo PW-FIRST-$RANDOM'");
			await waitForTerminalOutput(page, /PW-FIRST-\d+/);

			const ui = await openHistory(page);
			await expect(historyRows(ui)).toHaveCount(1, { timeout: 10000 });
			await expect(previewCommand(ui)).toHaveText("bash -c 'sleep 0.3 && echo PW-FIRST-$RANDOM'");
		} finally {
			await browser.close();
		}
	});

	test('lists recent commands newest-first and previews the full command', async () => {
		const { browser, page } = await connectWorkbench();
		try {
			await prepare(page);
			await clearHistory();
			await openTerminal(page);

			await runInTerminal("bash -c 'sleep 0.3 && echo PW-ONE-$RANDOM'");
			await waitForTerminalOutput(page, /PW-ONE-\d+/);
			await runInTerminal("bash -c 'sleep 0.3 && echo PW-TWO-$RANDOM'");
			await waitForTerminalOutput(page, /PW-TWO-\d+/);

			const ui = await openHistory(page);
			await expect(historyRows(ui)).toHaveCount(2, { timeout: 10000 });
			await expect(historyRows(ui).nth(0)).toContainText("bash -c 'sleep 0.3 && echo PW-TWO-$RANDOM'");
			await expect(historyRows(ui).nth(1)).toContainText("bash -c 'sleep 0.3 && echo PW-ONE-$RANDOM'");
			// Right pane previews the selected (newest) command in full.
			await expect(previewCommand(ui)).toHaveText("bash -c 'sleep 0.3 && echo PW-TWO-$RANDOM'");
			// ... and its captured output (fetched lazily on selection).
			await expect(previewOutput(ui)).toContainText(/PW-TWO-\d+/);
			// The output size is shown next to the "Output" label.
			await expect(previewOutputSize(ui)).toHaveText(/\d+ (B|KB|MB)/);
		} finally {
			await browser.close();
		}
	});

	test('selecting a row previews it; Enter copies that command’s full block', async () => {
		const { browser, page } = await connectWorkbench();
		try {
			await prepare(page);
			await clearHistory();
			await openTerminal(page);

			await runInTerminal("bash -c 'sleep 0.3 && echo PW-ONE-$RANDOM'");
			await waitForTerminalOutput(page, /PW-ONE-\d+/);
			await runInTerminal("bash -c 'sleep 0.3 && echo PW-TWO-$RANDOM'");
			await waitForTerminalOutput(page, /PW-TWO-\d+/);

			const ui = await openHistory(page);
			await expect(historyRows(ui)).toHaveCount(2, { timeout: 10000 });

			// Click the older command; the preview follows the selection.
			await historyRows(ui).nth(1).click();
			await expect(previewCommand(ui)).toHaveText("bash -c 'sleep 0.3 && echo PW-ONE-$RANDOM'");
			await expect(previewOutput(ui)).toContainText(/PW-ONE-\d+/);

			// Enter is handled by the webview.
			await ui.locator('body').press('Enter');

			// A prominent in-popup confirmation, not just the status-bar echo.
			await expect(copiedToast(ui)).toHaveClass(/visible/);
			await expect(page.locator('.statusbar-item', { hasText: STATUS_TEXT })).toBeVisible({
				timeout: 10000,
			});
			const clip = await readClipboard(page);
			expect(clip).toContain(SUMMARY);
			expect(clip).toContain("bash -c 'sleep 0.3 && echo PW-ONE-$RANDOM'");
			expect(clip).toMatch(/PW-ONE-\d+/);
			expect(clip).toContain('Exit Code: 0');
			expect(clip).not.toContain("bash -c 'sleep 0.3 && echo PW-TWO-$RANDOM'");
		} finally {
			await browser.close();
		}
	});

	test('arrow keys move the selection', async () => {
		const { browser, page } = await connectWorkbench();
		try {
			await prepare(page);
			await clearHistory();
			await openTerminal(page);

			await runInTerminal("bash -c 'sleep 0.3 && echo PW-ONE-$RANDOM'");
			await waitForTerminalOutput(page, /PW-ONE-\d+/);
			await runInTerminal("bash -c 'sleep 0.3 && echo PW-TWO-$RANDOM'");
			await waitForTerminalOutput(page, /PW-TWO-\d+/);

			const ui = await openHistory(page);
			await expect(historyRows(ui)).toHaveCount(2, { timeout: 10000 });
			await expect(historyRows(ui).nth(0)).toHaveClass(/selected/);

			await ui.locator('body').press('ArrowDown');
			await expect(historyRows(ui).nth(1)).toHaveClass(/selected/);
			await expect(previewCommand(ui)).toHaveText("bash -c 'sleep 0.3 && echo PW-ONE-$RANDOM'");
		} finally {
			await browser.close();
		}
	});

	test('shows a running command and streams its output', async () => {
		const { browser, page } = await connectWorkbench();
		try {
			await prepare(page);
			await clearHistory();
			await openTerminal(page);

			// Never "ends" until the terminal is killed — like `tail -f`.
			await runInTerminal("bash -c 'while :; do echo ONGOING-$RANDOM; sleep 0.4; done'");
			await waitForTerminalOutput(page, /ONGOING-\d+/);

			const ui = await openHistory(page);
			await expect(historyRows(ui)).toHaveCount(1, { timeout: 10000 });
			// The row is flagged as still running...
			await expect(runningBadge(ui)).toBeVisible();
			// ... and its output streams into the right pane as it arrives.
			await expect(previewOutput(ui)).toContainText(/ONGOING-\d+/, { timeout: 15000 });
		} finally {
			await restCmd('workbench.action.terminal.killAll').catch(() => undefined);
			await browser.close();
		}
	});

	test('streams output the shell-integration data stream never yields (docker logs -f)', async () => {
		const { browser, page } = await connectWorkbench();
		// A boot line, then silence: `docker logs -f` bursts its whole tail in
		// the first instant and then goes quiet, while staying in the foreground
		// — exactly the shape that used to leave a "running" row with
		// "(no output)": VS Code's ShellExecutionDataStream never yields these
		// chunks (the bytes render in the terminal, but `execution.read()` stays
		// empty), and an event-driven flush alone would miss a burst-then-quiet
		// producer. The supplemental capture path (raw terminal data + timer
		// flush, sliced at the OSC 633;C/D markers) must recover it.
		const id = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
		const name = await startLogEmitter(id);
		try {
			await prepare(page);
			await clearHistory();
			await openTerminal(page);

			await runInTerminal(`docker logs -f ${name}`);
			// The terminal itself shows the boot line immediately...
			await waitForTerminalOutput(page, new RegExp(`HTE-BOOT-${id}`));

			// ... and so must the popup, while the command is still running.
			const ui = await openHistory(page);
			await expect(historyRows(ui)).toHaveCount(1, { timeout: 10000 });
			await expect(runningBadge(ui)).toBeVisible();
			// Before the quiet stretch ends: this catches a missing timer flush
			// (an event-only flush would never fire during the silence).
			await expect(previewOutput(ui)).toContainText(new RegExp(`HTE-BOOT-${id}`), {
				timeout: 4000,
			});
			await expect(previewOutput(ui)).toContainText(new RegExp(`HTE-QUIET-${id}`));

			// Clean capture: the echoed command line / OSC markers must not leak.
			await expect(previewOutput(ui)).not.toContainText('docker logs');

			// Killing the terminal finalizes the row with its output intact
			// (the old code settled it with no output at all).
			await restCmd('workbench.action.terminal.killAll');
			await expect(runningBadge(ui)).toHaveCount(0, { timeout: 10000 });
			await expect(historyRows(ui)).toHaveCount(1);
			await expect(previewOutput(ui)).toContainText(new RegExp(`HTE-BOOT-${id}`), {
				timeout: 10000,
			});
		} finally {
			await removeLogEmitter(name);
			await restCmd('workbench.action.terminal.killAll').catch(() => undefined);
			await browser.close();
		}
	});

	test('ignores a line cancelled with Ctrl+C before it runs', async () => {
		const { browser, page } = await connectWorkbench();
		try {
			await prepare(page);
			await clearHistory();
			await openTerminal(page);

			// Type `tail -f` but abort it with Ctrl+C: it never executed, so it
			// must not be recorded (shell integration still emits an execution
			// whose command line contains the echoed `^C`).
			await sendSequence('tail -f');
			await page.waitForTimeout(400);
			await sendSequence('\u0003');
			await page.waitForTimeout(600);

			// A real command afterwards is recorded as usual.
			await runInTerminal("bash -c 'sleep 0.3 && echo REAL-$RANDOM'");
			await waitForTerminalOutput(page, /REAL-\d+/);

			const ui = await openHistory(page);
			await expect(historyRows(ui)).toHaveCount(1, { timeout: 10000 });
			await expect(historyRows(ui).nth(0)).toContainText('REAL-$RANDOM');
			await expect(historyRows(ui).nth(0)).not.toContainText('tail -f');
		} finally {
			await browser.close();
		}
	});

	test('history survives a window reload', async () => {
		test.setTimeout(150000);
		const { browser, page } = await connectWorkbench();
		try {
			await prepare(page);
			await clearHistory();
			await openTerminal(page);
			await runInTerminal("bash -c 'sleep 0.3 && echo PW-PERSIST-$RANDOM'");
			await waitForTerminalOutput(page, /PW-PERSIST-\d+/);

			let ui = await openHistory(page);
			await expect(historyRows(ui)).toHaveCount(1, { timeout: 10000 });
			await hideHistory();

			await reloadWorkbench(page);

			ui = await openHistory(page);
			await expect(historyRows(ui)).toHaveCount(1, { timeout: 15000 });
			await expect(historyRows(ui).nth(0)).toContainText("bash -c 'sleep 0.3 && echo PW-PERSIST-$RANDOM'");
		} finally {
			await browser.close();
		}
	});

	test('Esc closes the popup', async () => {
		const { browser, page } = await connectWorkbench();
		try {
			await prepare(page);
			await clearHistory();
			await openTerminal(page);
			await runInTerminal("bash -c 'sleep 0.3 && echo PW-ESC-$RANDOM'");
			await waitForTerminalOutput(page, /PW-ESC-\d+/);

			const ui = await openHistory(page);
			await expect(historyRows(ui)).toHaveCount(1, { timeout: 10000 });

			await ui.locator('body').press('Escape');
			await expect(page.locator(EXT_FRAME_SEL)).toHaveCount(0, { timeout: 10000 });
		} finally {
			await browser.close();
		}
	});

	test('shows an empty state when there is no history', async () => {
		const { browser, page } = await connectWorkbench();
		try {
			await prepare(page);
			await clearHistory();

			const ui = await openHistory(page);
			await expect(ui.locator('#history-empty')).toBeVisible();
			await expect(historyRows(ui)).toHaveCount(0);
		} finally {
			await browser.close();
		}
	});

	test('clearHistory empties an open popup', async () => {
		const { browser, page } = await connectWorkbench();
		try {
			await prepare(page);
			await clearHistory();
			await openTerminal(page);
			await runInTerminal("bash -c 'sleep 0.3 && echo PW-CLEAR-$RANDOM'");
			await waitForTerminalOutput(page, /PW-CLEAR-\d+/);

			const ui = await openHistory(page);
			await expect(historyRows(ui)).toHaveCount(1, { timeout: 10000 });

			await clearHistory();
			await expect(historyRows(ui)).toHaveCount(0, { timeout: 10000 });
			await expect(ui.locator('#history-empty')).toBeVisible();
		} finally {
			await browser.close();
		}
	});

	test('sidebar mode docks the view in the primary sidebar', async () => {
		const { browser, page } = await connectWorkbench();
		try {
			await prepare(page, 'sidebar');
			await clearHistory();
			await openTerminal(page);

			await runInTerminal("bash -c 'sleep 0.3 && echo PW-SIDE-$RANDOM'");
			await waitForTerminalOutput(page, /PW-SIDE-\d+/);

			const ui = await openHistory(page);
			await expect(historyRows(ui)).toHaveCount(1, { timeout: 15000 });
			await expect(previewCommand(ui)).toHaveText(
				"bash -c 'sleep 0.3 && echo PW-SIDE-$RANDOM'"
			);
			// Actually docked in the primary sidebar.
			await expect(page.locator('.part.sidebar .composite.title').first()).toContainText(
				'Hacker Terminal'
			);
		} finally {
			await browser.close();
		}
	});

	test('panel mode docks the two-pane view in the bottom panel', async () => {
		const { browser, page } = await connectWorkbench();
		try {
			await prepare(page, 'panel');
			await clearHistory();
			await openTerminal(page);

			await runInTerminal("bash -c 'sleep 0.3 && echo PW-PANEL-$RANDOM'");
			await waitForTerminalOutput(page, /PW-PANEL-\d+/);

			const ui = await openHistory(page);
			await expect(historyRows(ui)).toHaveCount(1, { timeout: 10000 });
			await expect(previewCommand(ui)).toHaveText(
				"bash -c 'sleep 0.3 && echo PW-PANEL-$RANDOM'"
			);
			// Actually docked in the bottom panel.
			await expect(page.locator('.part.panel .composite.title').first()).toContainText(
				'Hacker Terminal'
			);
		} finally {
			await browser.close();
		}
	});

	test('secondary sidebar mode docks the view in the auxiliary bar', async () => {
		const { browser, page } = await connectWorkbench();
		try {
			await prepare(page, 'secondarySidebar');
			await clearHistory();
			await openTerminal(page);

			await runInTerminal("bash -c 'sleep 0.3 && echo PW-AUX-$RANDOM'");
			await waitForTerminalOutput(page, /PW-AUX-\d+/);

			const ui = await openHistory(page);
			await expect(historyRows(ui)).toHaveCount(1, { timeout: 15000 });
			await expect(previewCommand(ui)).toHaveText(
				"bash -c 'sleep 0.3 && echo PW-AUX-$RANDOM'"
			);
			// Actually docked in the secondary sidebar.
			await expect(page.locator('.part.auxiliarybar .composite.title').first()).toContainText(
				'Hacker Terminal'
			);
		} finally {
			await browser.close();
		}
	});

	test('closeOnCopy closes the editor panel after copying', async () => {
		const { browser, page } = await connectWorkbench();
		try {
			await prepare(page, 'editor');
			await setCloseOnCopy(true);
			await clearHistory();
			await openTerminal(page);

			await runInTerminal("bash -c 'sleep 0.3 && echo PW-CLOSE-$RANDOM'");
			await waitForTerminalOutput(page, /PW-CLOSE-\d+/);

			const ui = await openHistory(page);
			await expect(historyRows(ui)).toHaveCount(1, { timeout: 10000 });

			await ui.locator('body').press('Enter');
			await waitForClipboard(page, c => c.includes('PW-CLOSE-$RANDOM'));
			// The panel dismissed itself on copy.
			await expect(page.locator(EXT_FRAME_SEL)).toHaveCount(0, { timeout: 10000 });
		} finally {
			await browser.close();
		}
	});
});
