/**
 * REST Control client for the E2E tests.
 *
 * The `vscode-hacker-rest-control` extension runs an HTTP server inside the
 * extension host and executes arbitrary `vscode.commands.executeCommand` /
 * `custom.eval` requests. This is the deterministic "control channel" for
 * arranging and acting on the workbench — no command-palette automation, no
 * browser-reserved shortcut problems. See `docs/important/how-to-test-all.md`
 * §3 in the meta repo.
 *
 * The port is pinned by `HACKER_REST_CONTROL_PORT` in the meta repo's
 * `docker-compose.yml` (40620 by default).
 */

const REST_PORT = Number(process.env.HACKER_REST_CONTROL_PORT) || 40620;
export const REST_URL = `http://127.0.0.1:${REST_PORT}/`;

/** Low-level: POST `{ command, args }` to the REST Control endpoint. */
export async function restRaw(command: string, args: unknown[] = [], timeoutMs = 30000): Promise<any> {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), timeoutMs);
	try {
		const res = await fetch(REST_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ command, args }),
			signal: ac.signal,
		});
		const text = await res.text();
		return text ? JSON.parse(text) : null;
	} finally {
		clearTimeout(timer);
	}
}

/** Run a VS Code command via `vscode.commands.executeCommand`. */
export function restCmd(command: string, ...args: unknown[]): Promise<any> {
	return restRaw(command, args);
}

/** Evaluate arbitrary JS in the extension host (`vscode` is in scope). */
export async function restEval<T = unknown>(code: string, timeoutMs = 30000): Promise<T> {
	const result = await restRaw('custom.eval', [code], timeoutMs);
	if (result && typeof result === 'object' && (result as { name?: string }).name === 'Error') {
		throw new Error(`restEval failed: ${(result as { message?: string }).message}`);
	}
	return result as T;
}

/** True when the REST Control endpoint is reachable. */
export async function restAvailable(): Promise<boolean> {
	try {
		return (await restEval<number>('1 + 1')) === 2;
	} catch {
		return false;
	}
}
