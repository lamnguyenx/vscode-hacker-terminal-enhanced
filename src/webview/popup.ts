/**
 * Webview-side popup UI. Bundled by `bun build` into `media/popup.js`
 * (`npm run build:webview`). Keep this module free of Node/VSCode APIs — the
 * only bridge is `acquireVsCodeApi().postMessage`.
 */

interface DisplayItem {
	id: number;
	firstLine: string;
	command: string;
	cwd?: string;
	exitCode?: number;
	startedAt: number;
}

interface ItemsMessage {
	type: 'items';
	items: DisplayItem[];
}

const api = acquireVsCodeApi();

const countEl = el('history-count');
const listEl = el('history-list');
const previewEl = el('history-preview');
const previewCommandEl = el('preview-command');
const previewMetaEl = el('preview-meta');
const emptyEl = el('history-empty');

let items: DisplayItem[] = [];
let selected = 0;

window.addEventListener('message', event => {
	const message = event.data as ItemsMessage | undefined;
	if (message?.type === 'items') {
		items = Array.isArray(message.items) ? message.items : [];
		selected = 0;
		render();
	}
});

document.addEventListener('keydown', event => {
	if (items.length === 0) {
		if (event.key === 'Escape') {
			api.postMessage({ type: 'close' });
		}
		return;
	}
	switch (event.key) {
		case 'ArrowDown':
			event.preventDefault();
			move(1);
			break;
		case 'ArrowUp':
			event.preventDefault();
			move(-1);
			break;
		case 'Home':
			event.preventDefault();
			selected = 0;
			render();
			break;
		case 'End':
			event.preventDefault();
			selected = items.length - 1;
			render();
			break;
		case 'Enter':
			event.preventDefault();
			copySelected();
			break;
		case 'Escape':
			event.preventDefault();
			api.postMessage({ type: 'close' });
			break;
	}
});

function move(delta: number): void {
	const count = items.length;
	if (count === 0) {
		return;
	}
	selected = (selected + delta + count) % count;
	render();
}

function copySelected(): void {
	const item = items[selected];
	if (item) {
		api.postMessage({ type: 'copy', id: item.id });
	}
}

function render(): void {
	listEl.textContent = '';
	const hasItems = items.length > 0;
	emptyEl.hidden = hasItems;
	previewEl.hidden = !hasItems;
	countEl.textContent = hasItems
		? `${items.length} command${items.length === 1 ? '' : 's'}`
		: '';

	if (!hasItems) {
		return;
	}

	items.forEach((item, index) => {
		const row = document.createElement('div');
		row.className = 'history-row' + (index === selected ? ' selected' : '');
		row.setAttribute('role', 'option');
		row.setAttribute('aria-selected', index === selected ? 'true' : 'false');
		row.dataset.id = String(item.id);
		row.dataset.index = String(index);

		const line = document.createElement('span');
		line.className = 'history-first-line';
		line.textContent = item.firstLine;
		row.appendChild(line);

		if (item.exitCode !== undefined && item.exitCode !== 0) {
			const badge = document.createElement('span');
			badge.className = 'history-exit';
			badge.textContent = `\u2717 ${item.exitCode}`;
			row.appendChild(badge);
		}

		row.addEventListener('click', () => {
			selected = index;
			render();
		});
		row.addEventListener('dblclick', () => {
			selected = index;
			copySelected();
		});

		listEl.appendChild(row);
	});

	renderPreview(items[selected]);
}

function renderPreview(item: DisplayItem): void {
	previewCommandEl.textContent = item.command;
	previewMetaEl.textContent = '';

	const rows: Array<[string, string]> = [];
	if (item.cwd) {
		rows.push(['cwd', item.cwd]);
	}
	rows.push(['exit', item.exitCode === undefined ? 'unknown' : String(item.exitCode)]);
	rows.push(['started', formatTime(item.startedAt)]);

	for (const [key, value] of rows) {
		const dt = document.createElement('dt');
		dt.textContent = key;
		const dd = document.createElement('dd');
		dd.textContent = value;
		previewMetaEl.appendChild(dt);
		previewMetaEl.appendChild(dd);
	}

	listEl.querySelector('.history-row.selected')?.scrollIntoView({ block: 'nearest' });
}

function formatTime(ms: number): string {
	const date = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, '0');
	return (
		`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
		`${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
	);
}

function el(id: string): HTMLElement {
	const node = document.getElementById(id);
	if (!node) {
		throw new Error(`missing element #${id}`);
	}
	return node;
}

// Ask the host for the item list once the DOM is ready.
api.postMessage({ type: 'ready' });
