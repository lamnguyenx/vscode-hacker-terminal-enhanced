#!/usr/bin/env bun
/**
 * Browser dev harness for the history panel.
 *
 * Serves the real `media/popup.css` + `media/popup.js` (rebuilt on save) against
 * a read-only mirror of the extension's SQLite history, and pushes live updates
 * over SSE. Open the printed URL.
 *
 *   bun scripts/dev-webview.ts
 *   # or, containerized:  docker compose up   (see docker-compose.yml)
 *
 * Env:
 *   WEBVIEW_DEV_PORT  port to listen on (default 5199)
 *   HTE_DB            path to history.sqlite (default: auto-discovered)
 *   HTE_META_ROOT     meta repo root used to locate the DB
 *                     (default ~/git/vscode-hacker-meta)
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { formatExecution } from '../src/format';
import { toDisplayItem } from '../src/history';
import { buildHistoryDocument } from '../src/historyMarkup';
import { HistoryStore } from '../src/store';

const ROOT = path.resolve(import.meta.dir, '..');
const PORT = Number(process.env.WEBVIEW_DEV_PORT) || 5199;
const DB_POLL_MS = 500;
const ROW_LIMIT = 30;

function findDatabase(): string | undefined {
	if (process.env.HTE_DB) {
		return fs.existsSync(process.env.HTE_DB) ? process.env.HTE_DB : undefined;
	}
	const metaRoot = process.env.HTE_META_ROOT ?? path.join(os.homedir(), 'git', 'vscode-hacker-meta');
	const rel = 'exp/code-server/.local/share/code-server/User/globalStorage/lamnguyenx.hacker-terminal-enhanced/history.sqlite';
	const candidates = [
		path.join(metaRoot, rel),
		path.join(
			os.homedir(),
			'.local/share/code-server/User/globalStorage/lamnguyenx.hacker-terminal-enhanced/history.sqlite'
		),
	];
	return candidates.find(candidate => fs.existsSync(candidate));
}

const dbPath = findDatabase();
const store = dbPath ? new HistoryStore(dbPath, ROW_LIMIT, { readOnly: true }) : undefined;
if (dbPath) {
	console.log(`[hte-dev] history DB : ${dbPath}`);
} else {
	console.warn(
		'[hte-dev] no history DB found (set HTE_DB); serving an empty list. ' +
			'Capture a command in the extension first.'
	);
}

// --- SSE hub ---------------------------------------------------------------
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const encoder = new TextEncoder();

function broadcast(payload: unknown): void {
	const frame = encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
	for (const client of clients) {
		try {
			client.enqueue(frame);
		} catch {
			clients.delete(client);
		}
	}
}

/** Comment frame that keeps the SSE stream alive during quiet periods. */
function keepAlive(): void {
	const frame = encoder.encode(': ping\n\n');
	for (const client of clients) {
		try {
			client.enqueue(frame);
		} catch {
			clients.delete(client);
		}
	}
}
setInterval(keepAlive, 20_000);

function currentItems() {
	return store ? store.list().map(toDisplayItem) : [];
}

// --- Live mirror: poll the DB, push `items` whenever it changes -------------
let lastSignature = '';
setInterval(() => {
	let items;
	try {
		items = currentItems();
	} catch {
		return;
	}
	const signature = JSON.stringify(
		items.map(item => [item.id, item.outputLength, item.running, item.exitCode])
	);
	if (signature !== lastSignature) {
		lastSignature = signature;
		broadcast({ type: 'items', items });
	}
}, DB_POLL_MS);

// --- Rebuild popup.js on save; reload the page when assets change ----------
const watcher = Bun.spawn(
	[
		process.execPath,
		'build',
		'src/webview/popup.ts',
		'--outfile',
		'media/popup.js',
		'--target',
		'browser',
		'--format',
		'iife',
		'--watch',
	],
	{ cwd: ROOT, stdout: 'inherit', stderr: 'inherit' }
);

let reloadTimer: ReturnType<typeof setTimeout> | undefined;
fs.watch(path.join(ROOT, 'media'), () => {
	clearTimeout(reloadTimer);
	reloadTimer = setTimeout(() => broadcast({ type: 'reload' }), 150);
});

// --- HTTP ------------------------------------------------------------------
const HEAD_EXTRA = [
	'<link rel="stylesheet" href="/dev/theme.css">',
	'<script src="/dev/client.js"></script>',
].join('\n');

/** Built per request, so edits to the shared markup module hot-apply on reload. */
function pageHtml(): string {
	return buildHistoryDocument({
		cssUri: '/media/popup.css',
		jsUri: '/media/popup.js',
		headExtra: HEAD_EXTRA,
	});
}

function fileResponse(relative: string, type: string): Response {
	const file = Bun.file(path.join(ROOT, relative));
	if (file.size === 0) {
		return new Response('not found', { status: 404 });
	}
	return new Response(file, { headers: { 'Content-Type': type, 'Cache-Control': 'no-store' } });
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
	});
}

function entryFor(idParam: string | null) {
	const id = Number(idParam);
	return store && Number.isFinite(id) ? store.get(id) : undefined;
}

function sseResponse(request: Request): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			clients.add(controller);
			controller.enqueue(encoder.encode(': connected\n\n'));
			// Resync immediately on (re)connect, so a page opened (or a dropped
			// connection re-established) after a change still shows current data.
			controller.enqueue(
				encoder.encode(`data: ${JSON.stringify({ type: 'items', items: currentItems() })}\n\n`)
			);
			request.signal.addEventListener('abort', () => {
				clients.delete(controller);
				try {
					controller.close();
				} catch {
					// already closed
				}
			});
		},
	});
	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-store',
			Connection: 'keep-alive',
			// Ask any intermediary proxy not to buffer the stream.
			'X-Accel-Buffering': 'no',
		},
	});
}

const server = Bun.serve({
	port: PORT,
	// SSE streams sit idle between DB changes; the default 10s idle timeout would
	// sever them (the heartbeat above keeps them warm regardless).
	idleTimeout: 255,
	fetch(request) {
		const url = new URL(request.url);
		switch (url.pathname) {
			case '/':
				return new Response(pageHtml(), {
					headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
				});
			case '/media/popup.css':
				return fileResponse('media/popup.css', 'text/css; charset=utf-8');
			case '/media/popup.js':
				return fileResponse('media/popup.js', 'text/javascript; charset=utf-8');
			case '/dev/theme.css':
				return fileResponse('dev/theme.css', 'text/css; charset=utf-8');
			case '/dev/client.js':
				return fileResponse('dev/client.js', 'text/javascript; charset=utf-8');
			case '/api/items':
				return json({ items: currentItems() });
			case '/api/output': {
				const entry = entryFor(url.searchParams.get('id'));
				if (!entry) return json({ error: 'not found' }, 404);
				return json({ output: entry.output, length: entry.outputLength });
			}
			case '/api/copied': {
				const entry = entryFor(url.searchParams.get('id'));
				if (!entry) return json({ error: 'not found' }, 404);
				return json({ text: formatExecution(entry) });
			}
			case '/events':
				return sseResponse(request);
			default:
				return new Response('not found', { status: 404 });
		}
	},
});

function shutdown(): void {
	watcher.kill();
	server.stop(true);
	store?.dispose();
	process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(`[hte-dev] history panel → http://localhost:${PORT}`);
console.log(
	`[hte-dev] rows: ${currentItems().length} (live-mirrored). ` +
		'If empty, make sure the code-server workbench tab is connected — its extension host must be running to capture commands.'
);
