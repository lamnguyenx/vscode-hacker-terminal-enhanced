import { test, expect, type Page } from '@playwright/test';
import { restCmd, restEval } from './rest';
import {
	clearHistory,
	clearNotifications,
	closePanel,
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
	resetDisplayMode,
	runInTerminal,
	setCloseOnCopy,
	setDisplayMode,
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
