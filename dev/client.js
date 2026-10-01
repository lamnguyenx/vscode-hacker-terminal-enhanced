/*
 * Browser shim for the webview host bridge, plus a live-reload client.
 *
 * Loaded in <head> *before* media/popup.js, so `acquireVsCodeApi` exists when
 * the bundle runs. It speaks the exact same protocol as the extension host
 * (`ready`/`preview`/`copy`/`close`) but talks to the dev server over HTTP, and
 * relays server pushes (SSE) back into the popup via `window.postMessage`.
 *
 * Not shipped — dev only.
 */
(() => {
	const post = data => window.postMessage(data, '*');

	async function readItems() {
		try {
			const res = await fetch('/api/items', { cache: 'no-store' });
			const body = await res.json();
			return { type: 'items', items: body.items || [] };
		} catch (error) {
			console.error('[hte-dev] /api/items failed', error);
			return { type: 'items', items: [] };
		}
	}

	async function handle(message) {
		if (!message || typeof message.type !== 'string') {
			return;
		}
		switch (message.type) {
			case 'ready':
				post(await readItems());
				break;
			case 'preview': {
				const res = await fetch(`/api/output?id=${encodeURIComponent(message.id)}`, {
					cache: 'no-store',
				});
				if (!res.ok) return;
				const body = await res.json();
				post({ type: 'output', id: message.id, output: body.output, length: body.length });
				break;
			}
			case 'copy': {
				const res = await fetch(`/api/copied?id=${encodeURIComponent(message.id)}`, {
					cache: 'no-store',
				});
				if (!res.ok) return;
				const body = await res.json();
				try {
					await navigator.clipboard.writeText(body.text);
				} catch (error) {
					// Clipboard needs a secure context + user gesture; log and still
					// confirm so the toast/preview flow is exercised.
					console.warn('[hte-dev] clipboard write failed', error);
				}
				post({ type: 'copied', id: message.id });
				break;
			}
			case 'close':
				console.log('[hte-dev] close requested (no-op in the browser)');
				break;
		}
	}

	window.acquireVsCodeApi = () => ({
		postMessage: message => void handle(message),
		getState: () => undefined,
		setState: () => {},
	});

	// Server pushes: `reload` (sources changed) and `items` (the DB changed).
	const events = new EventSource('/events');
	events.onmessage = event => {
		let data;
		try {
			data = JSON.parse(event.data);
		} catch {
			return;
		}
		if (data.type === 'reload') {
			location.reload();
		} else if (data.type === 'items') {
			post({ type: 'items', items: data.items || [] });
		}
	};

	console.log('[hte-dev] host shim ready');
})();
