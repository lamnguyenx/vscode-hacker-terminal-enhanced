/**
 * Workbench helpers: connect Playwright to the running CDP browser and drive
 * the extension through the REST Control API.
 *
 * Division of labour (meta repo `how-to-test-all.md` §3):
 *   REST  → arrange + act  (create a terminal, run a command, invoke the
 *                            extension commands, poll host readiness)
 *   CDP   → assert only     (webview popup DOM, status-bar text, clipboard)
 *
 * The history popup is a webview panel. Under code-server a webview is NOT a
 * separate CDP target — it is nested in same-origin iframes inside the
 * workbench page, so a two-level Playwright `frameLocator` reaches it:
 *
 *   workbench page → iframe[src*=extensionId]  (webview bootstrap)
 *                  → <iframe>                   (the extension's own document)
 */
import { chromium, expect, type Browser, type FrameLocator, type Locator, type Page } from '@playwright/test';
import { restAvailable, restCmd, restEval, restRaw } from './rest';

export const CDP_PORT = process.env.CDP_PORT || '9024';
export const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;
export const CODE_SERVER_URL =
	process.env.CODE_SERVER_URL || 'https://localhost:9620/?folder=/home/lamnt45/git/vscode-hacker-meta';

/** The extension under test (override for a dev host / a fork). */
export const EXT_ID = process.env.HACKER_TERMINAL_EXT_ID || 'lamnguyenx.hacker-terminal-enhanced';
export const EXT_FRAME_SEL = `iframe[src*="extensionId=${EXT_ID}"]`;

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

type ClipboardHook = { __hteClipboard?: string[] };

/**
 * Hook the renderer's `navigator.clipboard.writeText` so the test can capture
 * the payload the extension writes.
 *
 * The browser runs on another machine and cannot be OS-focused from the test
 * runner, so both `writeText` and `readText` reject with "Document is not
 * focused". The extension host's `vscode.env.clipboard.writeText` is delivered
 * through the renderer's `navigator.clipboard` (verified), so replacing it
 * records the exact copied text without needing focus. Resetting the buffer
 * also gives a clean sentinel per test.
 */
export async function installClipboardSpy(page: Page): Promise<void> {
	await page.evaluate(() => {
		const w = window as unknown as ClipboardHook;
		w.__hteClipboard = [];
		const clip = navigator.clipboard as unknown as { writeText: (text: string) => Promise<void> };
		clip.writeText = async (text: string) => {
			w.__hteClipboard!.push(text);
		};
	});
}

/** The most recent text the extension copied (requires {@link installClipboardSpy}). */
export function readClipboard(page: Page): Promise<string> {
	return page.evaluate(() => {
		const w = window as unknown as ClipboardHook;
		const buffer = w.__hteClipboard ?? [];
		return buffer.length > 0 ? buffer[buffer.length - 1] : '';
	});
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
export function runInTerminal(command: string): Promise<any> {
	return restRaw('custom.runInTerminal', [command]);
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

// ---------------------------------------------------------------------------
// History popup
// ---------------------------------------------------------------------------

/** Invoke the popup command the same way a user would (via the workbench). */
export function showHistory(): Promise<any> {
	return restRaw('terminalEnhanced.showHistory', []);
}

/** Close the popup if open. */
export function hideHistory(): Promise<any> {
	return restRaw('terminalEnhanced.hideHistory', []);
}

/** Delete every retained command. */
export function clearHistory(): Promise<any> {
	return restRaw('terminalEnhanced.clearHistory', []);
}

/** The extension document inside the code-server webview (two frame levels). */
export function historyUi(page: Page): FrameLocator {
	return page.frameLocator(EXT_FRAME_SEL).frameLocator('iframe');
}

/** Open the popup and wait for its webview document to render. */
export async function openHistory(page: Page): Promise<FrameLocator> {
	await showHistory();
	const ui = historyUi(page);
	await ui.locator('.popup').waitFor({ state: 'visible', timeout: 20000 });
	return ui;
}

/** Every command row in the popup's left pane, newest first. */
export function historyRows(ui: FrameLocator): Locator {
	return ui.locator('.history-row');
}

/** Read the popup's right-pane full-command preview. */
export function previewCommand(ui: FrameLocator): Locator {
	return ui.locator('#preview-command');
}

/** Remove leftover notification toasts. */
export function clearNotifications(): Promise<any> {
	return restCmd('notifications.clearAll').catch(() => undefined);
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
