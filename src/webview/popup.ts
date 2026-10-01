/**
 * Webview-side popup UI. Bundled by `bun build` into `media/popup.js`
 * (`npm run build:webview`). Keep this module free of Node/VSCode APIs — the
 * only bridge is `acquireVsCodeApi().postMessage`.
 */

import type {
	CopiedMessage,
	DisplayItem,
	ItemsMessage,
	OutputMessage,
} from '../historyMessages';

const api = acquireVsCodeApi();

const countEl = el('history-count');
const listEl = el('history-list');
const previewEl = el('history-preview');
const previewCommandEl = el('preview-command');
const previewMetaEl = el('preview-meta');
const outputEl = el('preview-output');
const outputScrollEl = el('preview-output-scroll');
const outputSizeEl = el('preview-output-size');
const copiedToastEl = el('copied-toast');
const emptyEl = el('history-empty');

/** Per-line rows (gutter numbers) are capped; beyond this, render plain text. */
const OUTPUT_LINE_LIMIT = 5000;

interface PopupState {
	wrap?: boolean;
}

const savedState = (api.getState() as PopupState | null | undefined) ?? {};

/** Whether long output lines wrap (toggled with `Alt+Z`). */
let wrapOutput = typeof savedState.wrap === 'boolean' ? savedState.wrap : true;

let items: DisplayItem[] = [];
let selected = 0;

/** Outputs fetched from the host, keyed by row id, so re-selecting is instant. */
const outputCache = new Map<number, { output: string; length: number }>();

/** Id whose output is currently rendered, to reset scroll when selection moves. */
let renderedOutputId: number | undefined;

window.addEventListener('message', event => {
	const message = event.data as ItemsMessage | OutputMessage | CopiedMessage | undefined;
	if (message?.type === 'items') {
		const previousId = items[selected]?.id;
		items = Array.isArray(message.items) ? message.items : [];
		// A live refresh (streaming output) must not steal the selection.
		const found = previousId === undefined ? -1 : items.findIndex(item => item.id === previousId);
		selected = found >= 0 ? found : 0;
		render();
	} else if (message?.type === 'output') {
		outputCache.set(message.id, { output: message.output, length: message.length });
		const current = items[selected];
		if (current && current.id === message.id) {
			showOutputText(message.id, message.output);
		}
	} else if (message?.type === 'copied') {
		showCopiedCue(message.id);
	}
});

document.addEventListener('keydown', event => {
	if (items.length === 0) {
		if (event.key === 'Escape') {
			api.postMessage({ type: 'close' });
		}
		return;
	}
	// `Alt+Z` toggles output line wrap (same chord as VS Code's editor toggle).
	if (event.code === 'KeyZ' && event.altKey && !event.ctrlKey && !event.metaKey) {
		event.preventDefault();
		setWrap(!wrapOutput);
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

		if (item.running) {
			const badge = document.createElement('span');
			badge.className = 'history-running';
			badge.textContent = '\u25CF running';
			row.appendChild(badge);
		} else if (item.exitCode !== undefined && item.exitCode !== 0) {
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
	rows.push(['exit', item.running ? 'running\u2026' : exitLabel(item.exitCode)]);
	rows.push(['started', formatTime(item.startedAt)]);

	for (const [key, value] of rows) {
		const dt = document.createElement('dt');
		dt.textContent = key;
		const dd = document.createElement('dd');
		dd.textContent = value;
		previewMetaEl.appendChild(dt);
		previewMetaEl.appendChild(dd);
	}

	showOutput(item);
	listEl.querySelector('.history-row.selected')?.scrollIntoView({ block: 'nearest' });
}

function exitLabel(exitCode: number | undefined): string {
	return exitCode === undefined ? 'unknown' : String(exitCode);
}

/**
 * Render `item`'s output, (re)fetching it whenever the stored copy changed.
 * A running command streams new output; a finishing command's final flush can
 * also land after the last list refresh.
 */
function showOutput(item: DisplayItem): void {
	const cached = outputCache.get(item.id);
	if (cached) {
		showOutputText(item.id, cached.output);
	} else {
		outputEl.classList.add('loading');
		outputEl.textContent = 'Loading output\u2026';
		outputSizeEl.textContent = '';
	}
	if (!cached || cached.length !== item.outputLength) {
		api.postMessage({ type: 'preview', id: item.id });
	}
}

function showOutputText(id: number, output: string): void {
	const isNewSelection = renderedOutputId !== id;
	renderedOutputId = id;
	// Follow the tail while the user is already at the bottom (or just switched).
	const stick = isNewSelection || isNearBottom();

	renderOutputLines(output || '(no output)');
	outputSizeEl.textContent = output.length > 0 ? formatSize(byteLength(output)) : '';

	if (stick) {
		outputScrollEl.scrollTop = outputScrollEl.scrollHeight;
	}
	updateScrollability();
}

/**
 * Render the output with a line-number gutter. Very long outputs (above
 * {@link OUTPUT_LINE_LIMIT} lines) fall back to plain text so the gutter rows
 * cannot freeze the view.
 */
function renderOutputLines(output: string): void {
	outputEl.classList.remove('loading');
	const lines = output.split('\n');
	if (lines.length > 1 && lines[lines.length - 1] === '') {
		lines.pop();
	}
	if (lines.length === 1 || lines.length > OUTPUT_LINE_LIMIT) {
		outputEl.classList.remove('numbered');
		outputEl.textContent = output;
		return;
	}

	outputEl.classList.add('numbered');
	outputEl.textContent = '';
	outputEl.style.setProperty('--output-digits', String(String(lines.length).length));

	const fragment = document.createDocumentFragment();
	lines.forEach((line, index) => {
		const row = document.createElement('div');
		row.className = 'output-line';

		const num = document.createElement('span');
		num.className = 'output-num';
		num.textContent = String(index + 1);

		const text = document.createElement('span');
		text.className = 'output-text';
		text.textContent = line;

		row.append(num, text);
		fragment.appendChild(row);
	});
	outputEl.appendChild(fragment);
}

function setWrap(wrap: boolean): void {
	wrapOutput = wrap;
	try {
		api.setState({ ...savedState, wrap });
	} catch {
		// state persistence is best-effort (the dev-harness shim no-ops it)
	}
	outputScrollEl.classList.toggle('nowrap', !wrap);
	updateScrollability();
}

/**
 * Show a scrollbar only while the content actually overflows; the space is not
 * reserved when everything fits.
 */
function updateScrollability(): void {
	const overflows =
		outputScrollEl.scrollHeight - outputScrollEl.clientHeight > 1 ||
		outputScrollEl.scrollWidth - outputScrollEl.clientWidth > 1;
	outputScrollEl.classList.toggle('scrollable', overflows);
}

function isNearBottom(): boolean {
	return outputScrollEl.scrollHeight - outputScrollEl.scrollTop - outputScrollEl.clientHeight < 40;
}

/** Byte-accurate size of the captured output, so the label matches the store. */
function byteLength(text: string): number {
	return new Blob([text]).size;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Flash the copied row and show a prominent confirmation toast. */
let copiedTimer: number | undefined;
function showCopiedCue(id: number): void {
	const row = listEl.querySelector<HTMLElement>(`.history-row[data-id="${id}"]`);
	if (row) {
		row.classList.add('copied');
		window.setTimeout(() => row.classList.remove('copied'), 800);
	}
	copiedToastEl.classList.add('visible');
	if (copiedTimer !== undefined) {
		window.clearTimeout(copiedTimer);
	}
	copiedTimer = window.setTimeout(() => copiedToastEl.classList.remove('visible'), 2500);
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

// Start with the persisted wrap mode, and re-check the scrollbar whenever the
// pane resizes (the overflow state can change without a re-render).
outputScrollEl.classList.toggle('nowrap', !wrapOutput);
new ResizeObserver(() => updateScrollability()).observe(outputScrollEl);

// Ask the host for the item list once the DOM is ready.
api.postMessage({ type: 'ready' });
