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
 * Send raw text to the active terminal (no trailing newline). Use this to type
 * a command without running it, then e.g. abort it with `\u0003` (Ctrl+C).
 */
export function sendSequence(text: string): Promise<any> {
	return restCmd('workbench.action.terminal.sendSequence', { text });
}

// ---------------------------------------------------------------------------
// Docker helpers (run through the extension host)
// ---------------------------------------------------------------------------

/**
 * Run `docker` inside the code-server container (the host docker socket is
 * mounted there), via `node:child_process` in the extension host. Returns
 * stdout; throws (parsed REST-side) when docker exits non-zero.
 */
export function dockerExec(args: string[], timeoutMs = 60000): Promise<string> {
	const code =
		`require('node:child_process').execFileSync('docker', ` +
		`${JSON.stringify(args)}, { encoding: 'utf8', ` +
		`stdio: ['ignore', 'pipe', 'ignore'] })`;
	return restEval<string>(code, timeoutMs);
}

/**
 * Start a detached log emitter whose `docker logs -f` reproduces the
 * data-stream bypass: the container logs two lines at boot (`HTE-BOOT` /
 * `HTE-QUIET` with the nonce), a design that keeps the terminal visibly
 * streaming while the shell-integration data stream stays empty.
 *
 * Returns the container name. Pair with {@link removeLogEmitter}.
 */
export async function startLogEmitter(id: string): Promise<string> {
	const name = `hte-e2e-logs-${id}`;
	// A leftover from an aborted run would collide with `--name`.
	await dockerExec(['rm', '-f', name]).catch(() => undefined);
	await dockerExec([
		'run', '-d', '--name', name, 'busybox', 'sh', '-c',
		`echo HTE-BOOT-${id}; echo HTE-QUIET-${id}; sleep 300`,
	]);
	// The container prints its tail only once it has started; wait for the
	// boot lines so the follow command in the terminal sees them immediately.
	await expect
		.poll(
			async () => {
				const logs = await dockerExec(['logs', name]).catch(() => '');
				return logs.includes(`HTE-BOOT-${id}`);
			},
			{ timeout: 15000, intervals: [250, 500, 1000] }
		)
		.toBe(true);
	return name;
}

/** Stop and remove a {@link startLogEmitter} container (idempotent). */
export function removeLogEmitter(name: string): Promise<any> {
	return dockerExec(['rm', '-f', name]).catch(() => undefined);
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

/** Set `terminalEnhanced.historyDisplay` (Global). */
export function setDisplayMode(
	mode: 'editor' | 'panel' | 'sidebar' | 'secondarySidebar' | 'window'
): Promise<any> {
	return restEval(
		`vscode.workspace.getConfiguration('terminalEnhanced')` +
			`.update('historyDisplay', ${JSON.stringify(mode)}, vscode.ConfigurationTarget.Global).then(() => true)`
	);
}

/** Remove the Global `historyDisplay` override (back to the default). */
export function resetDisplayMode(): Promise<any> {
	return restEval(
		`vscode.workspace.getConfiguration('terminalEnhanced')` +
			`.update('historyDisplay', undefined, vscode.ConfigurationTarget.Global).then(() => true)`
	);
}

/** Set `terminalEnhanced.closeOnCopy` (Global). */
export function setCloseOnCopy(value: boolean): Promise<any> {
	return restEval(
		`vscode.workspace.getConfiguration('terminalEnhanced')` +
			`.update('closeOnCopy', ${value}, vscode.ConfigurationTarget.Global).then(() => true)`
	);
}

/** Set (or clear, with `null`) `terminalEnhanced.emulatedCapture` (Global). */
export function setEmulatedCapture(value: boolean | null): Promise<any> {
	return restEval(
		`vscode.workspace.getConfiguration('terminalEnhanced')` +
			`.update('emulatedCapture', ${value === null ? 'undefined' : value}, vscode.ConfigurationTarget.Global).then(() => true)`
	);
}

/** Hide the bottom panel (its tabs, including the docked history view). */
export function closePanel(): Promise<any> {
	return restCmd('workbench.action.closePanel').catch(() => undefined);
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

/** Read the popup's right-pane output preview. */
export function previewOutput(ui: FrameLocator): Locator {
	return ui.locator('#preview-output');
}

/** Read the popup's right-pane output size label. */
export function previewOutputSize(ui: FrameLocator): Locator {
	return ui.locator('#preview-output-size');
}

/** The popup's "copied" confirmation toast. */
export function copiedToast(ui: FrameLocator): Locator {
	return ui.locator('#copied-toast');
}

/** The "running" badge on a row for an in-flight command. */
export function runningBadge(ui: FrameLocator): Locator {
	return ui.locator('.history-running');
}

/** Poll the clipboard hook until it matches (the copy is asynchronous). */
export async function waitForClipboard(
	page: Page,
	matches: (clip: string) => boolean,
	timeoutMs = 10000
): Promise<string> {
	let last = '';
	await expect
		.poll(
			async () => {
				last = await readClipboard(page);
				return matches(last);
			},
			{ timeout: timeoutMs, intervals: [200, 300, 500] }
		)
		.toBe(true);
	return last;
}

/** Remove leftover notification toasts. */
export function clearNotifications(): Promise<any> {
	return restCmd('notifications.clearAll').catch(() => undefined);
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
