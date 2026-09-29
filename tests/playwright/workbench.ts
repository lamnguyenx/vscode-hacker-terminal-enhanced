/**
 * Workbench helpers: connect Playwright to the running CDP browser and drive
 * the extension through the REST Control API.
 *
 * Division of labour (meta repo `how-to-test-all.md` §3):
 *   REST  → arrange + act  (create a terminal, run a command, invoke the
 *                            extension command, poll host readiness)
 *   CDP   → assert only     (status-bar text, clipboard contents, notifications)
 */
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import { restAvailable, restCmd, restEval, restRaw } from './rest';

export const CDP_PORT = process.env.CDP_PORT || '9024';
export const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;
export const CODE_SERVER_URL =
	process.env.CODE_SERVER_URL || 'https://localhost:9620/?folder=/home/lamnt45/git/vscode-hacker-meta';

export interface Workbench {
	browser: Browser;
	page: Page;
}

/** Connect to the already-running CDP browser and return the code-server tab. */
export async function connectWorkbench(): Promise<Workbench> {
	const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
	const context = browser.contexts()[0];
	if (!context) throw new Error(`no browser context on ${CDP_ENDPOINT}`);

	const page =
		context.pages().find((p) => p.url().includes('localhost:9620')) ?? (await context.newPage());
	if (!page.url().includes('localhost:9620')) {
		await page.goto(CODE_SERVER_URL, { waitUntil: 'domcontentloaded' });
	}
	await page.locator('.monaco-workbench').waitFor({ timeout: 30000 });
	return { browser, page };
}

/** Reload the workbench (restarts the extension host) and wait until it is back. */
export async function reloadWorkbench(page: Page): Promise<void> {
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.locator('.monaco-workbench').waitFor({ timeout: 30000 });
	await waitForRest();
}

/** Poll until the REST Control endpoint answers again (e.g. after a reload). */
export async function waitForRest(timeoutMs = 30000): Promise<void> {
	await expect
		.poll(() => restAvailable().catch(() => false), { timeout: timeoutMs, intervals: [500, 1000, 2000] })
		.toBe(true);
}

/** Allow the test to read back the real browser clipboard. */
export async function grantClipboard(page: Page): Promise<void> {
	const origin = new URL(page.url()).origin;
	await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
}

/** Open a fresh terminal and wait until shell integration is live for it. */
export async function openTerminal(page: Page): Promise<void> {
	await restCmd('workbench.action.terminal.killAll');
	await restCmd('workbench.action.terminal.new');
	await expect
		.poll(
			() =>
				restEval<boolean>(
					'!!(vscode.window.activeTerminal && vscode.window.activeTerminal.shellIntegration)'
				).catch(() => false),
			{ timeout: 20000, intervals: [300, 500, 1000] }
		)
		.toBe(true);
	await page.locator('.xterm-screen:visible').last().waitFor({ state: 'visible', timeout: 15000 });
}

/** Type a command into the active terminal. */
export async function runInTerminal(command: string): Promise<void> {
	await restRaw('custom.runInTerminal', [command]);
}

/**
 * Wait until the terminal DOM shows `pattern`.
 *
 * Use a pattern that only the *output* can produce (e.g. `PW-OUT-\d+` for the
 * command `echo PW-OUT-$RANDOM`), so the assertion cannot be satisfied by the
 * echoed command line itself.
 */
export async function waitForTerminalOutput(
	page: Page,
	pattern: string | RegExp,
	timeoutMs = 10000
): Promise<void> {
	const re = typeof pattern === 'string' ? new RegExp(escapeRegExp(pattern)) : pattern;
	await expect
		.poll(
			async () => {
				const texts = await page.locator('.xterm-rows').allTextContents();
				return texts.some((t) => re.test(t));
			},
			{ timeout: timeoutMs, intervals: [200, 300, 500] }
		)
		.toBe(true);
}

/** Invoke the extension command the same way a user would (via the workbench). */
export async function copyLastCommand(): Promise<void> {
	await restRaw('terminalEnhanced.copyLast', []);
}

/**
 * Invoke the copy command until the clipboard matches `matches`, or time out.
 *
 * The terminal DOM shows a command's output as soon as the pty writes it, but
 * the extension only stores the capture once shell integration reports the
 * execution ended and `execution.read()` drains — a few ms later. Re-invoking
 * copy is cheaper and more reliable than guessing a fixed settle delay.
 */
export async function copyUntilClipboard(
	page: Page,
	matches: (clip: string) => boolean,
	timeoutMs = 10000
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let last = '';
	while (Date.now() < deadline) {
		await copyLastCommand();
		await page.waitForTimeout(300);
		last = await readClipboard(page);
		if (matches(last)) return last;
	}
	return last;
}

/** Read the real browser clipboard (requires {@link grantClipboard}). */
export function readClipboard(page: Page): Promise<string> {
	return page.evaluate(() => navigator.clipboard.readText());
}

/** Remove leftover notification toasts. */
export function clearNotifications(): Promise<any> {
	return restCmd('notifications.clearAll').catch(() => undefined);
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
