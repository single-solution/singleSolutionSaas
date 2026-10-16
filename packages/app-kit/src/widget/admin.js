/**
 * Building blocks of the admin widgets (PLAN 0.6): status badges and dots, a grid of labeled values, the
 * list-and-detail layout, the More menu (⋯) with a destructive action last in danger text, and dialogs for secondary
 * forms with an optional typed confirmation, and the three states of a list: loading, empty (with a next step) and
 * failed (with Try again), and `stateSlot` to show them in one place. They set these classes, which `ADMIN_KIT_CSS` (admin-css.js) styles for every product:
 * `badge <tone>`, `dot <tone>`, `facts`, `split` (`data-view="list" | "detail"`) with `pane list-pane` /
 * `pane detail-pane` and `link back`, `more` with `secondary icon` and `menu` (`danger` on a destructive item),
 * `overlay` with `dialog` (`wide`), `field`, `status` (`error` while it shows a problem), `actions`, `danger` and
 * `secondary`, and `state` (`loading`, `empty`, `error`). A dialog and the More menu are keyboard complete: the dialog
 * traps Tab and closes on Escape, the menu moves with the arrow keys. Text is always set as text, never as HTML.
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
 * The loading state of a list or panel: one line of text (`role="status"`), with a small spinner from the product CSS.
 * @param {Document} doc @param {string} text
 */
export const loadingState = (doc, text) => element(doc, 'p', { class: 'state loading', role: 'status' }, text);

/**
 * The empty state of a list: what is missing and, when there is one, the next step (a button or link that adds the
 * first item, clears the filter, and so on).
 * @param {Document} doc @param {string} text @param {HTMLElement | null} [action]
 */
export const emptyState = (doc, text, action = null) => {
	const box = element(doc, 'div', { class: 'state empty' });
	box.append(element(doc, 'p', {}, text));
	if (action) box.append(action);
	return box;
};

/**
 * The error state of a list or panel: the problem text (`role="alert"`) and, with `retry`, a Try again button that
 * calls `onRetry`.
 * @param {Document} doc @param {string} text @param {{ label: string, onRetry: () => unknown }} [retry]
 */
export const errorState = (doc, text, retry) => {
	const box = element(doc, 'div', { class: 'state error', role: 'alert' });
	box.append(element(doc, 'p', {}, text));
	if (retry) {
		const again = element(doc, 'button', { type: 'button', class: 'secondary' }, retry.label);
		again.addEventListener('click', () => void retry.onRetry());
		box.append(again);
	}
	return box;
};

/**
 * The place under a list's heading where its state shows: loading, empty (with its next step), failed (with Try again),
 * or nothing. Each call replaces the one before.
 * @param {Document} doc
 */
export const stateSlot = (doc) => {
	const root = element(doc, 'div', { class: 'state-slot', 'aria-live': 'polite' });
	return {
		root,
		/** @param {string} text */
		loading: (text) => root.replaceChildren(loadingState(doc, text)),
		/** @param {string} text @param {HTMLElement | null} [action] */
		empty: (text, action = null) => root.replaceChildren(emptyState(doc, text, action)),
		/** @param {string} text @param {{ label: string, onRetry: () => unknown }} [retry] */
		failed: (text, retry) => root.replaceChildren(errorState(doc, text, retry)),
		clear: () => root.replaceChildren(),
	};
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
 * The More menu (⋯): a button that opens a short list of actions, destructive ones last in danger text. Opening focuses
 * the first action; Arrow keys, Home and End move between the actions (ArrowDown on the closed button opens it);
 * Escape returns focus to the button, Tab and a press outside close the menu. Choosing an action closes the menu and
 * puts focus back on the button first, so a dialog the action opens returns focus there. It is hidden when it has no
 * actions.
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
	/** @type {() => HTMLElement[]} */
	const entriesNow = () => /** @type {HTMLElement[]} */ ([...menu.querySelectorAll('[role="menuitem"]')]);
	const open = () => {
		menu.removeAttribute('hidden');
		button.setAttribute('aria-expanded', 'true');
		doc.addEventListener('pointerdown', outside, true);
		entriesNow()[0]?.focus();
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
			button.focus();
			void item.onSelect();
		});
		menu.append(entry);
	}
	button.addEventListener('click', () => {
		if (!menu.hasAttribute('hidden')) return close();
		open();
	});
	wrap.addEventListener('keydown', (event) => {
		const opened = !menu.hasAttribute('hidden');
		if (event.key === 'Escape') {
			if (!opened) return;
			close();
			button.focus();
			return;
		}
		if (!opened) {
			if (event.key === 'ArrowDown' && event.target === button) {
				event.preventDefault();
				open();
			}
			return;
		}
		if (event.key === 'Tab') return close();
		const list = entriesNow();
		const index = list.indexOf(/** @type {HTMLElement} */ (event.target));
		/** @type {number | null} */
		let next = null;
		if (event.key === 'ArrowDown') next = (index + 1) % list.length;
		else if (event.key === 'ArrowUp') next = (index - 1 + list.length) % list.length;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = list.length - 1;
		if (next === null) return;
		event.preventDefault();
		list[next]?.focus();
	});
	wrap.append(button, menu);
	if (items.length === 0) wrap.setAttribute('hidden', '');
	return wrap;
};

/** Ids of the typed-confirmation inputs, unique on the page. */
let confirmIds = 0;

/** What Tab can reach inside a dialog. */
const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
	'textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * Keep Tab inside a dialog: from the last control it goes to the first and Shift+Tab from the first to the last.
 * @param {HTMLElement} dialog
 * @param {KeyboardEvent} event
 */
const trapTab = (dialog, event) => {
	const controls = /** @type {HTMLElement[]} */ ([...dialog.querySelectorAll(FOCUSABLE)]).filter(
		(control) => !control.closest('[hidden]'),
	);
	const first = controls[0];
	const last = controls[controls.length - 1];
	if (!first || !last) {
		event.preventDefault();
		return;
	}
	const active = /** @type {Document | ShadowRoot} */ (dialog.getRootNode()).activeElement;
	if (event.shiftKey && (active === first || !dialog.contains(active))) {
		event.preventDefault();
		last.focus();
	} else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
		event.preventDefault();
		first.focus();
	}
};

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
 * a Cancel and a submit button (Cancel first, the main action last, as in the Portal); without, it shows `body` with a
 * Close button and a press beside it closes it too. Focus starts on the first field (the first button when there is
 * none, which is Cancel), Tab stays inside the dialog, Escape closes either, and focus goes back to where it was.
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
	if (submit) actions.append(submit);
	dialog.append(
		element(doc, 'h3', {}, title),
		.../** @type {Array<Node | string>} */ (body.filter((child) => child !== null && child !== undefined && child !== false)),
		...extra,
		status,
		actions,
	);
	overlay.append(dialog);
	overlay.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') {
			event.stopPropagation();
			close();
		} else if (event.key === 'Tab') trapTab(dialog, event);
	});
	root.append(overlay);
	/** @type {HTMLElement | null} */ (dialog.querySelector('input, textarea, select, button'))?.focus();
	return { close, dialog, submit, status };
};
