import { test, expect, type Page } from '@playwright/test';
import { restCmd } from './rest';
import {
	clearHistory,
	clearNotifications,
	connectWorkbench,
	EXT_FRAME_SEL,
	historyRows,
	hideHistory,
	installClipboardSpy,
	openHistory,
	openTerminal,
	previewCommand,
	readClipboard,
	reloadWorkbench,
	runInTerminal,
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

/** Reset the clipboard oracle so a stale value cannot satisfy an assertion. */
async function prepare(page: Page): Promise<void> {
	await installClipboardSpy(page);
}

test.afterEach(async () => {
	await hideHistory().catch(() => undefined);
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

			// Enter is handled by the webview.
			await ui.locator('body').press('Enter');

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
});
