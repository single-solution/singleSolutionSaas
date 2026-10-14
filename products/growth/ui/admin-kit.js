/**
 * What the admin widgets share (PLAN 0.6): filter chips with counts, the More menu (⋯) of a header or a card, dialogs
 * for secondary forms and long lists (full-screen sheets on phones), ranked lists with share bars, and the texts of
 * refused calls. Text is always set as text, never as HTML.
 * @module
 */
import { element } from './dom.js';

/** @typedef {{ label: string, onSelect: () => void, danger?: boolean }} MenuItem */

/** The widget texts of the problem codes any admin widget may get. */
export const PROBLEM_TEXTS = Object.freeze({
	forbidden: 'problem.forbidden',
	feature_off: 'problem.feature_off',
	database_not_connected: 'problem.database_not_connected',
	product_unavailable: 'problem.product_unavailable',
	rate_limited: 'problem.rate_limited',
});

/**
 * The widget text of a refused call (PLAN 0.4.10: never the server's English detail, OT-4): the text of the field a
 * `validation_failed` problem names (`validation_failed:<field>`), else of its code, else `fallback`.
 * @param {{ data?: any }} answer
 * @param {Readonly<Record<string, string>>} keys text keys by problem code and by `validation_failed:<field>`
 * @param {string} fallback
 * @returns {string} a text key
 */
export const problemKey = (answer, keys, fallback) => {
	const type = typeof answer.data?.type === 'string' ? answer.data.type : '';
	const code = type.slice(type.lastIndexOf('/') + 1);
	const field = `${code}:${String(answer.data?.errors?.[0]?.path ?? '').slice(1)}`;
	const found = [field, code].find((name) => name !== '' && Object.hasOwn(keys, name));
	return found === undefined ? fallback : /** @type {string} */ (keys[found]);
};

/**
 * The More menu (⋯): a button that opens a short list of actions; Escape or a press outside closes it.
 * @param {Document} doc @param {string} label the button's accessible name @param {MenuItem[]} items
 */
export const moreMenu = (doc, label, items) => {
	const wrap = element(doc, 'div', { class: 'more' });
	const button = element(
		doc,
		'button',
		{ type: 'button', class: 'secondary icon', 'aria-label': label, 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
		'⋯',
	);
	const menu = element(doc, 'div', { role: 'menu', class: 'menu', 'aria-label': label, hidden: '' });
	/** @param {Event} event */
	const outside = (event) => {
		if (!event.composedPath().includes(wrap)) close();
	};
	const close = () => {
		menu.setAttribute('hidden', '');
		button.setAttribute('aria-expanded', 'false');
		doc.removeEventListener('pointerdown', outside, true);
	};
	for (const item of items) {
		const entry = element(
			doc,
			'button',
			{ type: 'button', role: 'menuitem', ...(item.danger ? { class: 'danger' } : {}) },
			item.label,
		);
		entry.addEventListener('click', () => {
			close();
			item.onSelect();
		});
		menu.append(entry);
	}
	button.addEventListener('click', () => {
		if (!menu.hasAttribute('hidden')) return close();
		menu.removeAttribute('hidden');
		button.setAttribute('aria-expanded', 'true');
		doc.addEventListener('pointerdown', outside, true);
		/** @type {HTMLElement | null} */ (menu.querySelector('button'))?.focus();
	});
	wrap.addEventListener('keydown', (event) => {
		if (event.key !== 'Escape') return;
		close();
		button.focus();
	});
	wrap.append(button, menu);
	return wrap;
};

/**
 * A dialog over the widget. With `onSubmit` it is a form (an error text to show, or nothing to close); without, it
 * only shows `body` with a Close button. Escape closes it.
 * @param {HTMLElement | ShadowRoot} root the widget's root
 * @param {{ title: string, body: Array<Node | null>, closeLabel: string, submitLabel?: string,
 *   onSubmit?: () => Promise<string | null | undefined>, wide?: boolean }} input
 */
export const openDialog = (root, { title, body, closeLabel, submitLabel, onSubmit, wide = false }) => {
	const doc = /** @type {Document} */ (root.ownerDocument);
	const overlay = element(doc, 'div', { class: 'overlay' });
	const form = element(doc, onSubmit ? 'form' : 'div', {
		class: wide ? 'dialog wide' : 'dialog',
		role: 'dialog',
		'aria-modal': 'true',
		'aria-label': title,
	});
	const status = element(doc, 'p', { class: 'status', role: 'status' });
	const actions = element(doc, 'div', { class: 'actions' });
	const close = () => overlay.remove();
	const dismiss = element(doc, 'button', { type: 'button', class: onSubmit ? 'secondary' : '' }, closeLabel);
	dismiss.addEventListener('click', close);
	if (onSubmit && submitLabel) {
		const submit = element(doc, 'button', { type: 'submit' }, submitLabel);
		actions.append(submit);
		form.addEventListener('submit', async (event) => {
			event.preventDefault();
			submit.setAttribute('disabled', '');
			const error = await onSubmit();
			submit.removeAttribute('disabled');
			if (error) status.textContent = error;
			else close();
		});
	}
	actions.append(dismiss);
	form.append(element(doc, 'h3', {}, title), ...body.filter((node) => node !== null), status, actions);
	overlay.append(form);
	overlay.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') close();
	});
	overlay.addEventListener('pointerdown', (event) => {
		if (event.target === overlay) close();
	});
	root.append(overlay);
	/** @type {HTMLElement | null} */ (form.querySelector('input, textarea, select, button'))?.focus();
	return { close, form, status };
};

/**
 * Filter chips: one pressed at a time, each with its count; `onPick` gets the chip's value.
 * @param {Document} doc @param {string} label the group's accessible name
 * @param {Array<{ value: string, label: string, count?: number | null }>} chips
 * @param {string} picked @param {(value: string) => void} onPick
 */
export const chipGroup = (doc, label, chips, picked, onPick) => {
	const group = element(doc, 'div', { class: 'chips', role: 'group', 'aria-label': label });
	for (const chip of chips) {
		const node = element(doc, 'button', {
			type: 'button',
			class: 'chip',
			'aria-pressed': String(chip.value === picked),
			'data-value': chip.value,
		});
		node.append(chip.label);
		if (chip.count !== undefined && chip.count !== null)
			node.append(element(doc, 'span', { class: 'count' }, String(chip.count)));
		node.addEventListener('click', () => {
			for (const other of group.querySelectorAll('.chip')) other.setAttribute('aria-pressed', String(other === node));
			onPick(chip.value);
		});
		group.append(node);
	}
	return group;
};

/**
 * A ranked list: each row's name and figure (its count unless given) with a bar of its share of the largest count.
 * @param {Document} doc
 * @param {Array<{ name: string, count: number, figure?: string, meta?: string }>} rows
 * @param {string} empty the text when there are no rows
 */
export const rankList = (doc, rows, empty) => {
	const list = element(doc, 'ul', { class: 'rank' });
	if (rows.length === 0) list.append(element(doc, 'li', { class: 'empty' }, empty));
	const most = Math.max(1, ...rows.map((row) => row.count));
	for (const row of rows) {
		const item = element(doc, 'li');
		const line = element(doc, 'div', { class: 'line' });
		line.append(
			element(doc, 'span', { class: 'name' }, row.name),
			element(doc, 'span', { class: 'figure' }, row.figure ?? String(row.count)),
		);
		const bar = element(doc, 'span', { class: 'share', 'aria-hidden': 'true' });
		bar.style.setProperty('--share', `${Math.max(2, Math.round((row.count / most) * 100))}%`);
		item.append(line, bar);
		if (row.meta) item.append(element(doc, 'span', { class: 'meta' }, row.meta));
		list.append(item);
	}
	return list;
};

/**
 * A grid of labeled values; empty values are left out.
 * @param {Document} doc @param {Array<[string, string | null | undefined]>} rows
 */
export const fieldGrid = (doc, rows) => {
	const list = element(doc, 'dl', { class: 'fields' });
	for (const [label, value] of rows) {
		if (value === '' || value === null || value === undefined) continue;
		const cell = element(doc, 'div');
		cell.append(element(doc, 'dt', {}, label), element(doc, 'dd', {}, value));
		list.append(cell);
	}
	return list;
};
