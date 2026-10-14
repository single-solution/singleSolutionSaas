/**
 * What the admin widgets share (PLAN 0.6, 0.8.7): the list-and-detail layout (the list beside the selected item where
 * the widget is wide; on a narrow one the list, then the item alone with Back), dialogs for secondary forms, the More
 * menu (⋯) with a destructive action last in danger text, field grids, status dots and badges. Text is always set as
 * text, never as HTML.
 * @module
 */
import { element } from './dom.js';

/** @typedef {'success' | 'warning' | 'danger' | 'neutral'} Tone */
/** @typedef {{ label: string, onSelect: () => void, danger?: boolean }} MenuItem */

/**
 * A status badge (green, amber and red only for status, PLAN 0.6).
 * @param {Document} doc @param {string} text @param {Tone} [tone]
 */
export const badge = (doc, text, tone = 'neutral') => element(doc, 'span', { class: `badge ${tone}` }, text);

/**
 * A status dot for a list row.
 * @param {Document} doc @param {Tone} tone @param {string} label
 */
export const dot = (doc, tone, label) => element(doc, 'span', { class: `dot ${tone}`, role: 'img', 'aria-label': label });

/**
 * A grid of labeled values; empty values are left out.
 * @param {Document} doc
 * @param {Array<[string, string | Node | null | undefined]>} rows
 */
export const fieldGrid = (doc, rows) => {
	const list = element(doc, 'dl', { class: 'fields' });
	for (const [label, value] of rows) {
		if (value === '' || value === null || value === undefined) continue;
		const cell = element(doc, 'div');
		const data = element(doc, 'dd');
		if (typeof value === 'string') data.textContent = value;
		else data.append(value);
		cell.append(element(doc, 'dt', {}, label), data);
		list.append(cell);
	}
	return list;
};

/**
 * A labeled form control.
 * @param {Document} doc @param {string} label @param {HTMLElement} control
 */
export const field = (doc, label, control) => {
	const node = element(doc, 'label', {}, label);
	node.append(control);
	return node;
};

/**
 * A section of the detail: a small heading and its items (nothing when there are none).
 * @param {Document} doc @param {string} title @param {string[]} items
 */
export const listSection = (doc, title, items) => {
	if (items.length === 0) return null;
	const section = element(doc, 'section', { class: 'sub' });
	const list = element(doc, 'ul', { class: 'plain' });
	list.append(...items.map((text) => element(doc, 'li', {}, text)));
	section.append(element(doc, 'h4', {}, title), list);
	return section;
};

/**
 * The list-and-detail layout. `show('detail')` shows the item alone on a narrow widget (with Back); a wide one always
 * shows both.
 * @param {Document} doc @param {string} backLabel
 */
export const splitView = (doc, backLabel) => {
	const root = element(doc, 'div', { class: 'split', 'data-view': 'list' });
	const list = element(doc, 'div', { class: 'pane list-pane' });
	const detail = element(doc, 'div', { class: 'pane detail-pane' });
	const back = element(doc, 'button', { type: 'button', class: 'link back' }, backLabel);
	back.addEventListener('click', () => root.setAttribute('data-view', 'list'));
	root.append(list, detail);
	return {
		root,
		list,
		detail,
		back,
		/** @param {'list' | 'detail'} view */
		show: (view) => root.setAttribute('data-view', view),
	};
};

/**
 * The More menu (⋯): a button that opens a short list of actions; Escape closes it.
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
	/** A press anywhere outside the menu closes it. @param {Event} event */
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
 * A dialog for a secondary form, over the widget. `onSubmit` answers an error text to show, or nothing to close.
 * @param {HTMLElement} root the widget's root
 * @param {{ title: string, body: Array<Node | null>, submitLabel: string, cancelLabel: string, danger?: boolean,
 *   onSubmit: () => Promise<string | null | undefined> }} input
 */
export const openDialog = (root, { title, body, submitLabel, cancelLabel, danger = false, onSubmit }) => {
	const doc = root.ownerDocument;
	const overlay = element(doc, 'div', { class: 'overlay' });
	const form = element(doc, 'form', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
	const status = element(doc, 'p', { class: 'status', role: 'status' });
	const submit = element(doc, 'button', { type: 'submit', ...(danger ? { class: 'danger' } : {}) }, submitLabel);
	const cancel = element(doc, 'button', { type: 'button', class: 'secondary' }, cancelLabel);
	const actions = element(doc, 'div', { class: 'actions' });
	actions.append(submit, cancel);
	form.append(element(doc, 'h3', {}, title), ...body.filter((node) => node !== null), status, actions);
	overlay.append(form);
	const close = () => overlay.remove();
	cancel.addEventListener('click', close);
	overlay.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') close();
	});
	form.addEventListener('submit', async (event) => {
		event.preventDefault();
		submit.setAttribute('disabled', '');
		const error = await onSubmit();
		submit.removeAttribute('disabled');
		if (error) status.textContent = error;
		else close();
	});
	root.append(overlay);
	/** @type {HTMLElement | null} */ (form.querySelector('input, textarea, select, button'))?.focus();
	return { close, form };
};
