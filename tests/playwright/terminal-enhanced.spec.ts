import { test, expect } from '@playwright/test';
import { restCmd } from './rest';
import {
	clearNotifications,
	connectWorkbench,
	copyLastCommand,
	copyUntilClipboard,
	grantClipboard,
	openTerminal,
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
 *   - the status-bar echo (`Hacker Terminal Enhanced: copied last command…`)
 *   - the real clipboard contents (read via `navigator.clipboard.readText`,
 *     enabled with `context.grantPermissions`)
 *   - warning notification toasts for the empty paths
 *
 * Prereqs: code-server up with the extension installed (see README →
 * Development) and the CDP browser reachable on 9024.
 */

const STATUS_TEXT = 'Hacker Terminal Enhanced: copied last command + output';
const SUMMARY = 'TERMINAL EXECUTION: SUMMARY';

async function connectAndPrepare(page: import('@playwright/test').Page): Promise<void> {
	await grantClipboard(page);
	// Sentinel so a stale clipboard can never satisfy the assertions.
	await page.evaluate(() => navigator.clipboard.writeText('__NOT_COPIED__'));
}

test.afterEach(async () => {
	await restCmd('workbench.action.terminal.killAll').catch(() => undefined);
	await clearNotifications();
});

test.describe('Hacker Terminal Enhanced', () => {
	test('captures the first command after a fresh window (activation regression)', async () => {
		test.setTimeout(150000);
		const { browser, page } = await connectWorkbench();
		try {
			// A reload restarts the extension host. The extension must activate
			// on its own (`onStartupFinished`) so the *first* command of the
			// session is tracked — before the fix it only activated when its
			// command was invoked, so this capture came back empty.
			await reloadWorkbench(page);
			await connectAndPrepare(page);

			await openTerminal(page);
			await runInTerminal('echo PW-OUT-$RANDOM');
			await waitForTerminalOutput(page, /PW-OUT-\d+/);

			// Clipboard content (poll: the capture lands just after the output
			// is painted in the terminal).
			const clip = await copyUntilClipboard(page, (c) => /PW-OUT-\d+/.test(c));

			// UI echo
			await expect(page.locator('.statusbar-item', { hasText: STATUS_TEXT })).toBeVisible();

			expect(clip).toContain(SUMMARY);
			expect(clip).toContain('echo PW-OUT-$RANDOM');
			expect(clip).toMatch(/PW-OUT-\d+/);
			expect(clip).toContain('Exit Code: 0');
		} finally {
			await browser.close();
		}
	});

	test('captures a non-zero exit code', async () => {
		const { browser, page } = await connectWorkbench();
		try {
			await connectAndPrepare(page);
			await openTerminal(page);

			await runInTerminal('false');
			await copyUntilClipboard(page, (c) => c.includes('Exit Code: 1'));
			await expect(page.locator('.statusbar-item', { hasText: STATUS_TEXT })).toBeVisible();

			const clip = await readClipboard(page);
			expect(clip).toContain('Exit Code: 1');
			expect(clip).toContain('false');
		} finally {
			await browser.close();
		}
	});

	test('warns when the terminal has no captured command yet', async () => {
		const { browser, page } = await connectWorkbench();
		try {
			await connectAndPrepare(page);
			await openTerminal(page);

			await copyLastCommand();

			await expect(page.locator('.notifications-toasts')).toContainText(
				'No command captured for the active terminal'
			);
		} finally {
			await browser.close();
		}
	});

	test('warns when there is no active terminal', async () => {
		const { browser, page } = await connectWorkbench();
		try {
			await connectAndPrepare(page);
			await restCmd('workbench.action.terminal.killAll');

			await copyLastCommand();

			await expect(page.locator('.notifications-toasts')).toContainText('No active terminal.');
		} finally {
			await browser.close();
		}
	});
});
