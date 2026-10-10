/**
 * Building blocks the admin widgets share (PLAN 0.6, 0.8.10): dialogs over the widget (a sheet on narrow widgets),
 * the More (⋯) menu with a destructive action last, filter chips that carry counts, detail cards laid out as a
 * masonry, status dots and a copy button. Every text is set as text, never as HTML.
 * @module
 */
import { element } from './dom.js';

/**
 * A dialog over the widget: its title, its content and a Close button; Escape and a click beside it close it too.
 * @param {ShadowRoot | HTMLElement} root where the widget renders
 * @param {{ title: string, nodes: Node[], closeLabel: string, onClose?: () => void }} input
 */
export const openDialog = (root, { title, nodes, closeLabel, onClose }) => {
	const doc = /** @type {Document} */ (root.ownerDocument);
	const overlay = element(doc, 'div', { class: 'overlay' });
	const dialog = element(doc, 'div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
	const head = element(doc, 'div', { class: 'dialog-head' });
	const shut = element(doc, 'button', { type: 'button', class: 'secondary small', 'aria-label': closeLabel }, '×');
	head.append(element(doc, 'h3', {}, title), shut);
	dialog.append(head, ...nodes);
	overlay.append(dialog);
	root.append(overlay);
	let open = true;
	const close = () => {
		if (!open) return;
		open = false;
		overlay.remove();
		onClose?.();
	};
	shut.addEventListener('click', close);
	overlay.addEventListener('click', (event) => {
		if (event.target === overlay) close();
	});
	overlay.addEventListener('keydown', (event) => {
		if (/** @type {KeyboardEvent} */ (event).key === 'Escape') close();
	});
	/** @type {HTMLElement | null} */ (dialog.querySelector('input, select, textarea, button:not([aria-label])'))?.focus();
	return { close, dialog };
};

/**
 * @typedef {object} MenuItem
 * @property {string} label
 * @property {() => void | Promise<void>} run
 * @property {boolean} [danger] destructive: shown last, in danger text
 */

/**
 * The More (⋯) menu of a detail header: the actions beyond the one or two main buttons.
 * @param {Document} doc
 * @param {string} label the menu button's name (screen readers)
 * @param {MenuItem[]} items
 */
export const moreMenu = (doc, label, items) => {
	const wrap = element(doc, 'div', { class: 'more' });
	const toggle = element(
		doc,
		'button',
		{ type: 'button', class: 'secondary small', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': label },
		'⋯',
	);
	const menu = element(doc, 'div', { class: 'menu', role: 'menu', hidden: '' });
	/** @param {boolean} show */
	const show = (show) => {
		if (show) menu.removeAttribute('hidden');
		else menu.setAttribute('hidden', '');
		toggle.setAttribute('aria-expanded', String(show));
	};
	for (const item of [...items.filter((each) => !each.danger), ...items.filter((each) => each.danger)]) {
		const entry = element(
			doc,
			'button',
			{ type: 'button', role: 'menuitem', class: item.danger ? 'item danger-text' : 'item' },
			item.label,
		);
		entry.addEventListener('click', () => {
			show(false);
			void item.run();
		});
		menu.append(entry);
	}
	toggle.addEventListener('click', () => show(menu.hasAttribute('hidden')));
	wrap.append(toggle, menu);
	if (items.length === 0) wrap.setAttribute('hidden', '');
	return wrap;
};

/**
 * Filter chips, each with its count as a badge; the picked one is pressed.
 * @param {Document} doc
 * @param {Array<{ value: string, label: string }>} options
 * @param {(value: string) => void} onPick
 */
export const chips = (doc, options, onPick) => {
	const group = element(doc, 'div', { class: 'chips', role: 'group' });
	/** @type {Map<string, { button: HTMLElement, badge: HTMLElement }>} */
	const byValue = new Map();
	for (const option of options) {
		const button = element(doc, 'button', { type: 'button', class: 'chip', 'aria-pressed': 'false' }, option.label);
		const badge = element(doc, 'span', { class: 'badge' }, '');
		button.append(badge);
		button.addEventListener('click', () => onPick(option.value));
		byValue.set(option.value, { button, badge });
		group.append(button);
	}
	return {
		group,
		/** @param {string} value */
		pick: (value) => {
			for (const [key, { button }] of byValue) button.setAttribute('aria-pressed', String(key === value));
		},
		/** @param {Record<string, number | null>} counts */
		counts: (counts) => {
			for (const [key, { badge }] of byValue)
				badge.textContent = counts[key] === undefined || counts[key] === null ? '' : String(counts[key]);
		},
	};
};

/**
 * A detail card: a title and label–value rows (empty values are left out); cards sit in a masonry.
 * @param {Document} doc
 * @param {string} title
 * @param {Array<[string, string | Node]>} rows
 */
export const card = (doc, title, rows) => {
	const shown = rows.filter(([, value]) => value !== '');
	const section = element(doc, 'section', { class: 'card' });
	section.append(element(doc, 'h4', {}, title));
	const list = element(doc, 'dl');
	for (const [label, value] of shown) {
		const dd = element(doc, 'dd');
		dd.append(value);
		list.append(element(doc, 'dt', {}, label), dd);
	}
	section.append(list);
	return section;
};

/**
 * A status dot with its label (green, amber or red only for status; grey for neither).
 * @param {Document} doc
 * @param {'good' | 'wait' | 'bad' | 'none'} tone
 * @param {string} label
 */
export const dot = (doc, tone, label) => {
	const wrap = element(doc, 'span', { class: 'state' });
	wrap.append(element(doc, 'span', { class: `dot ${tone}`, 'aria-hidden': 'true' }), doc.createTextNode(label));
	return wrap;
};

/**
 * A value to hand over (a code or a link) with a Copy button.
 * @param {Document} doc
 * @param {string} value
 * @param {{ copy: string, copied: string }} texts
 * @param {{ clipboard?: { writeText(text: string): Promise<void> } } | undefined} navigator
 */
export const copyable = (doc, value, texts, navigator) => {
	const wrap = element(doc, 'div', { class: 'copy' });
	const shown = element(doc, 'p', { class: 'code big' }, value);
	const button = element(doc, 'button', { type: 'button', class: 'secondary small' }, texts.copy);
	button.addEventListener('click', async () => {
		try {
			await navigator?.clipboard?.writeText(value);
			button.textContent = texts.copied;
		} catch {
			button.textContent = texts.copy;
		}
	});
	wrap.append(shown, button);
	return wrap;
};
