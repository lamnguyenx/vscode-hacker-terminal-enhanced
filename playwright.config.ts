import { defineConfig } from '@playwright/test';

/**
 * Playwright E2E tests for Hacker Terminal Enhanced.
 *
 * These connect to the pp CDP browser (`chromium.connectOverCDP`) that is
 * already showing the code-server workbench, and assert the browser-visible
 * result of the extension (status-bar echo + clipboard). All arrange/act is
 * done over the REST Control API — see `tests/playwright/rest.ts` and
 * `docs/important/how-to-test-all.md` in the meta repo: "REST → arrange + act,
 * CDP → assert only".
 *
 * The tests do NOT launch a browser: point CDP_PORT at the running browser
 * (localhost:9024 by default, forwarded from pp). Topology and code-server
 * setup live in
 * `/home/lamnt45/git/vscode-hacker-meta/docs/important/dev-code-on-nuc-test-on-pp.md`.
 */
export default defineConfig({
	testDir: './tests/playwright',
	timeout: 60000,
	expect: { timeout: 10000 },
	workers: 1,
	fullyParallel: false,
	reporter: [['list']],
});
