/**
 * Building blocks of the admin widgets (PLAN 0.6): status badges and dots, a grid of labeled values, the
 * list-and-detail layout, the More menu (⋯) with a destructive action last in danger text, and dialogs for secondary
 * forms with an optional typed confirmation. They set these classes for the product CSS: `badge <tone>`,
 * `dot <tone>`, `facts`, `split` (`data-view="list" | "detail"`) with `pane list-pane` / `pane detail-pane` and
 * `link back`, `more` with `secondary icon` and `menu` (`danger` on a destructive item), and `overlay` with
 * `dialog` (`wide`), `field`, `status` (`error` while it shows a problem), `actions`, `danger` and `secondary`.
 * Text is always set as text, never as HTML.
 * @module
 */
import { element } from './dom.js';

/** @typedef {'success' | 'warning' | 'danger' | 'neutral'} Tone green, amber and red only for status (PLAN 0.6) */
/** @typedef {{ label: string, onSelect: () => unknown, danger?: boolean }} MenuItem */
/** @typedef {Node | string | null | undefined | false} Child left out when null, undefined or false */

/**
 * A status badge.
 * @param {Document} doc @param {string} text @param {Tone} [tone]
 */
export const badge = (doc, text, tone = 'neutral') => element(doc, 'span', { class: `badge ${tone}` }, text);

/**
 * A status dot for a list row; its label is for screen readers.
 * @param {Document} doc @param {Tone} tone @param {string} label
 */
export const dot = (doc, tone, label) => element(doc, 'span', { class: `dot ${tone}`, role: 'img', 'aria-label': label });

/**
 * A grid of labeled values (`<dl class="facts">`); empty values ('', null, undefined, false) are left out.
 * @param {Document} doc
 * @param {Array<[string, Child]>} rows
 */
export const fieldGrid = (doc, rows) => {
	const list = element(doc, 'dl', { class: 'facts' });
	for (const [label, value] of rows) {
		if (value === '' || value === null || value === undefined || value === false) continue;
		const cell = element(doc, 'div');
		const data = element(doc, 'dd');
		data.append(value);
		cell.append(element(doc, 'dt', {}, label), data);
		list.append(cell);
	}
	return list;
};

/**
 * The list-and-detail layout: the product CSS shows the list beside the picked item on a wide widget, and on a narrow
 * one the list, then the item alone (`show('detail')`) with Back. The detail can take focus.
 * @param {Document} doc @param {string} backLabel
 */
export const splitView = (doc, backLabel) => {
	const root = element(doc, 'div', { class: 'split', 'data-view': 'list' });
	const list = element(doc, 'div', { class: 'pane list-pane' });
	const detail = element(doc, 'div', { class: 'pane detail-pane', tabindex: '-1' });
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
 * The More menu (⋯): a button that opens a short list of actions, destructive ones last in danger text. Escape or a
 * press outside closes it; it is hidden when it has no actions.
 * @param {Document} doc
 * @param {string} label the button's accessible name
 * @param {Array<MenuItem | null | undefined | false>} entries left out when null, undefined or false
 */
export const moreMenu = (doc, label, entries) => {
	const items = /** @type {MenuItem[]} */ (entries.filter(Boolean));
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
	for (const item of [...items.filter((each) => !each.danger), ...items.filter((each) => each.danger)]) {
		const entry = element(
			doc,
			'button',
			{ type: 'button', role: 'menuitem', ...(item.danger ? { class: 'danger' } : {}) },
			item.label,
		);
		entry.addEventListener('click', () => {
			close();
			void item.onSelect();
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
	if (items.length === 0) wrap.setAttribute('hidden', '');
	return wrap;
};

/** Ids of the typed-confirmation inputs, unique on the page. */
let confirmIds = 0;

/**
 * @typedef {object} DialogInput
 * @property {string} title
 * @property {Child[]} body
 * @property {string} closeLabel the Close button of a dialog that only shows `body`, the Cancel button of a form
 * @property {string} [submitLabel] with `onSubmit`
 * @property {() => Promise<string | null | undefined | void> | string | null | undefined | void} [onSubmit] makes the
 *   dialog a form: it answers a problem text to show (the dialog stays open), or nothing to close it
 * @property {boolean} [danger] the submit button in danger style
 * @property {boolean} [wide]
 * @property {{ text: string, label: string }} [confirm] typed confirmation (PLAN 0.6): the submit button works only
 *   while the field labeled `label` holds exactly `text`
 */

/**
 * A dialog over the widget (the product CSS makes it a full-screen sheet on phones). With `onSubmit` it is a form with
 * a submit and a Cancel button; without, it shows `body` with a Close button and a press beside it closes it too.
 * Escape closes either, and focus goes back to where it was.
 * @param {HTMLElement | ShadowRoot} root the widget's root
 * @param {DialogInput} input
 * @returns {{ close: () => void, dialog: HTMLElement, submit: HTMLButtonElement | null, status: HTMLElement }}
 */
export const openDialog = (
	root,
	{ title, body, closeLabel, submitLabel = '', onSubmit, danger = false, wide = false, confirm },
) => {
	const doc = /** @type {Document} */ (root.ownerDocument);
	const place = /** @type {Document | ShadowRoot} */ (root.getRootNode());
	const opener = /** @type {HTMLElement | null} */ (place.activeElement);
	const overlay = element(doc, 'div', { class: 'overlay' });
	const dialog = element(doc, onSubmit ? 'form' : 'div', {
		class: wide ? 'dialog wide' : 'dialog',
		role: 'dialog',
		'aria-modal': 'true',
		'aria-label': title,
	});
	const status = element(doc, 'p', { class: 'status', role: 'status' });
	const actions = element(doc, 'div', { class: 'actions' });
	let open = true;
	const close = () => {
		if (!open) return;
		open = false;
		overlay.remove();
		if (opener?.isConnected) opener.focus();
	};
	const dismiss = element(doc, 'button', { type: 'button', ...(onSubmit ? { class: 'secondary' } : {}) }, closeLabel);
	dismiss.addEventListener('click', close);
	/** @type {Node[]} */
	const extra = [];
	/** @type {HTMLButtonElement | null} */
	let submit = null;
	if (onSubmit) {
		const button = /** @type {HTMLButtonElement} */ (
			element(doc, 'button', { type: 'submit', ...(danger ? { class: 'danger' } : {}) }, submitLabel)
		);
		submit = button;
		actions.append(button);
		/** Whether the typed confirmation, if any, is done. @type {() => boolean} */
		let confirmed = () => true;
		if (confirm) {
			confirmIds += 1;
			const id = `ss-confirm-${confirmIds}`;
			const typed = /** @type {HTMLInputElement} */ (element(doc, 'input', { id, autocomplete: 'off' }));
			const wrap = element(doc, 'div', { class: 'field' });
			wrap.append(element(doc, 'label', { for: id }, confirm.label), typed);
			extra.push(wrap);
			confirmed = () => typed.value.trim() === confirm.text;
			typed.addEventListener('input', () => {
				button.disabled = !confirmed();
			});
		}
		button.disabled = !confirmed();
		dialog.addEventListener('submit', async (event) => {
			event.preventDefault();
			// Enter in a field submits too: never while a submit runs or before the confirmation is typed
			if (button.disabled) return;
			button.disabled = true;
			const problem = await onSubmit();
			button.disabled = !confirmed();
			if (!problem) return close();
			status.textContent = problem;
			status.classList.add('error');
		});
	} else
		overlay.addEventListener('pointerdown', (event) => {
			if (event.target === overlay) close();
		});
	actions.append(dismiss);
	dialog.append(
		element(doc, 'h3', {}, title),
		.../** @type {Array<Node | string>} */ (body.filter((child) => child !== null && child !== undefined && child !== false)),
		...extra,
		status,
		actions,
	);
	overlay.append(dialog);
	overlay.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') close();
	});
	root.append(overlay);
	/** @type {HTMLElement | null} */ (dialog.querySelector('input, textarea, select, button'))?.focus();
	return { close, dialog, submit, status };
};
