// @vitest-environment jsdom
/* global document, KeyboardEvent */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	badge,
	dot,
	element,
	emptyState,
	errorState,
	fieldGrid,
	loadingState,
	moreMenu,
	openDialog,
	splitView,
	stateSlot,
} from '../src/widget.js';

afterEach(() => document.body.replaceChildren());

/** A widget root inside an open shadow root, as `mountWidget` makes it. */
const widgetRoot = () => {
	const host = document.createElement('div');
	document.body.append(host);
	const shadow = host.attachShadow({ mode: 'open' });
	const root = document.createElement('div');
	shadow.append(root);
	return { host, shadow, root };
};

/** @param {Element} node @param {string} key */
const press = (node, key) => node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true }));

/** @param {Element} node */
const pointerDown = (node) => node.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));

/** @param {Element} form */
const submitForm = (form) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('element', () => {
	it('sets attributes and text, never HTML', () => {
		const node = element(document, 'p', { class: 'note', 'data-id': 'a1' }, '<b>hi</b>');
		expect(node.outerHTML).toBe('<p class="note" data-id="a1">&lt;b&gt;hi&lt;/b&gt;</p>');
		expect(element(document, 'div').outerHTML).toBe('<div></div>');
	});
});

describe('badge and dot', () => {
	it('show a status with its tone', () => {
		expect(badge(document, 'Paid', 'success').outerHTML).toBe('<span class="badge success">Paid</span>');
		expect(badge(document, 'Draft').className).toBe('badge neutral');
		expect(dot(document, 'danger', 'Failed').outerHTML).toBe('<span class="dot danger" role="img" aria-label="Failed"></span>');
	});
});

describe('fieldGrid', () => {
	it('lists labeled values as text or nodes and leaves empty ones out', () => {
		const link = element(document, 'a', { href: 'https://example.com' }, 'Open');
		const grid = fieldGrid(document, [
			['Name', '<i>Ann</i>'],
			['Email', ''],
			['Phone', null],
			['Note', undefined],
			['Flag', false],
			['Page', link],
		]);
		expect(grid.outerHTML).toBe(
			'<dl class="facts"><div><dt>Name</dt><dd>&lt;i&gt;Ann&lt;/i&gt;</dd></div>' +
				'<div><dt>Page</dt><dd><a href="https://example.com">Open</a></dd></div></dl>',
		);
	});
});

describe('splitView', () => {
	it('shows the detail alone on a narrow widget and goes back to the list', () => {
		const view = splitView(document, 'Back');
		expect(view.root.getAttribute('data-view')).toBe('list');
		expect([...view.root.children]).toEqual([view.list, view.detail]);
		expect(view.detail.getAttribute('tabindex')).toBe('-1');
		view.show('detail');
		expect(view.root.getAttribute('data-view')).toBe('detail');
		expect(view.back.textContent).toBe('Back');
		view.back.click();
		expect(view.root.getAttribute('data-view')).toBe('list');
	});
});

describe('moreMenu', () => {
	it('opens its actions with destructive ones last, runs one and closes', () => {
		const { root } = widgetRoot();
		const remove = vi.fn();
		const copy = vi.fn().mockResolvedValue(undefined);
		const menu = moreMenu(document, 'More actions', [
			{ label: 'Delete', onSelect: remove, danger: true },
			null,
			false,
			{ label: 'Copy link', onSelect: copy },
		]);
		root.append(menu);
		const [toggle, list] = /** @type {[HTMLElement, HTMLElement]} */ ([...menu.children]);
		expect(toggle.getAttribute('aria-label')).toBe('More actions');
		expect(toggle.className).toBe('secondary icon');
		expect(list.hasAttribute('hidden')).toBe(true);
		expect([...list.children].map((item) => [item.textContent, item.className])).toEqual([
			['Copy link', ''],
			['Delete', 'danger'],
		]);
		toggle.click();
		expect(list.hasAttribute('hidden')).toBe(false);
		expect(toggle.getAttribute('aria-expanded')).toBe('true');
		expect(root.getRootNode()).not.toBe(document);
		expect(/** @type {ShadowRoot} */ (root.getRootNode()).activeElement).toBe(list.children[0]);
		/** @type {HTMLElement} */ (list.children[1]).click();
		expect(remove).toHaveBeenCalledOnce();
		expect(list.hasAttribute('hidden')).toBe(true);
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		expect(copy).not.toHaveBeenCalled();
	});

	it('closes on a second press, on Escape and on a press outside, not on a press inside', () => {
		const { root } = widgetRoot();
		const menu = moreMenu(document, 'More', [{ label: 'Edit', onSelect: () => {} }]);
		root.append(menu);
		const [toggle, list] = /** @type {[HTMLElement, HTMLElement]} */ ([...menu.children]);
		toggle.click();
		toggle.click();
		expect(list.hasAttribute('hidden')).toBe(true);
		toggle.click();
		press(list, 'Enter');
		expect(list.hasAttribute('hidden')).toBe(false);
		press(list, 'Escape');
		expect(list.hasAttribute('hidden')).toBe(true);
		expect(/** @type {ShadowRoot} */ (root.getRootNode()).activeElement).toBe(toggle);
		toggle.click();
		pointerDown(/** @type {HTMLElement} */ (list.children[0]));
		expect(list.hasAttribute('hidden')).toBe(false);
		pointerDown(document.body);
		expect(list.hasAttribute('hidden')).toBe(true);
	});

	it('is hidden without actions', () => {
		expect(moreMenu(document, 'More', [null, false, undefined]).hasAttribute('hidden')).toBe(true);
	});
});

describe('openDialog', () => {
	it('shows a dialog with a Close button; a press beside it or Escape closes it and focus goes back', () => {
		const { root, shadow } = widgetRoot();
		const opener = element(document, 'button', { type: 'button' }, 'Usage');
		root.append(opener);
		opener.focus();
		const opened = openDialog(root, {
			title: 'Usage',
			body: [element(document, 'p', {}, 'Calls this month'), 'Plain text', null, false, undefined],
			closeLabel: 'Close',
		});
		const overlay = /** @type {HTMLElement} */ (root.querySelector('.overlay'));
		expect(opened.dialog.tagName).toBe('DIV');
		expect(opened.dialog.className).toBe('dialog');
		expect(opened.dialog.getAttribute('role')).toBe('dialog');
		expect(opened.dialog.getAttribute('aria-modal')).toBe('true');
		expect(opened.dialog.getAttribute('aria-label')).toBe('Usage');
		expect(opened.submit).toBeNull();
		expect(opened.dialog.textContent).toBe('UsageCalls this monthPlain textClose');
		const close = /** @type {HTMLButtonElement} */ (opened.dialog.querySelector('.actions button'));
		expect(close.hasAttribute('class')).toBe(false);
		expect(shadow.activeElement).toBe(close);
		pointerDown(opened.dialog);
		expect(overlay.isConnected).toBe(true);
		pointerDown(overlay);
		expect(overlay.isConnected).toBe(false);
		expect(shadow.activeElement).toBe(opener);
		opened.close();

		const again = openDialog(root, { title: 'Usage', body: [], closeLabel: 'Close', wide: true });
		expect(again.dialog.className).toBe('dialog wide');
		press(again.dialog, 'Enter');
		expect(again.dialog.isConnected).toBe(true);
		press(again.dialog, 'Escape');
		expect(again.dialog.isConnected).toBe(false);
		const last = openDialog(root, { title: 'Usage', body: [], closeLabel: 'Close' });
		/** @type {HTMLButtonElement} */ (last.dialog.querySelector('button')).click();
		expect(last.dialog.isConnected).toBe(false);
	});

	it('is a form: a problem keeps it open with the text, nothing closes it', async () => {
		const { root, shadow } = widgetRoot();
		const name = element(document, 'input', { name: 'name' });
		/** @type {Array<string | null>} */
		const answers = ['Name is taken', null];
		const onSubmit = vi.fn(async () => answers.shift());
		const opened = openDialog(root, { title: 'Add item', body: [name], submitLabel: 'Add', closeLabel: 'Cancel', onSubmit });
		expect(opened.dialog.tagName).toBe('FORM');
		expect(shadow.activeElement).toBe(name);
		const submit = /** @type {HTMLButtonElement} */ (opened.submit);
		expect(
			[...opened.dialog.querySelectorAll('.actions button')].map((button) => [button.textContent, button.className]),
		).toEqual([
			['Cancel', 'secondary'],
			['Add', ''],
		]);
		submitForm(opened.dialog);
		expect(submit.disabled).toBe(true);
		submitForm(opened.dialog);
		await settle();
		expect(onSubmit).toHaveBeenCalledOnce();
		expect(submit.disabled).toBe(false);
		expect(opened.status.textContent).toBe('Name is taken');
		expect(opened.status.className).toBe('status error');
		const overlay = /** @type {HTMLElement} */ (root.querySelector('.overlay'));
		pointerDown(overlay);
		expect(overlay.isConnected).toBe(true);
		submitForm(opened.dialog);
		await settle();
		expect(overlay.isConnected).toBe(false);
	});

	it('takes a sync onSubmit, a danger submit and a Cancel that closes', () => {
		const { root } = widgetRoot();
		const opened = openDialog(root, {
			title: 'Delete item',
			body: [],
			submitLabel: 'Delete',
			closeLabel: 'Cancel',
			danger: true,
			onSubmit: () => undefined,
		});
		expect(opened.submit?.className).toBe('danger');
		/** @type {HTMLButtonElement} */ (opened.dialog.querySelector('button.secondary')).click();
		expect(opened.dialog.isConnected).toBe(false);
	});

	it('waits for the typed confirmation before it submits', async () => {
		const { root, shadow } = widgetRoot();
		const onSubmit = vi.fn().mockResolvedValueOnce('Try again').mockResolvedValueOnce(undefined);
		const opened = openDialog(root, {
			title: 'Delete website',
			body: [element(document, 'p', {}, 'This removes shop.example.com.')],
			submitLabel: 'Delete',
			closeLabel: 'Cancel',
			danger: true,
			confirm: { text: 'shop.example.com', label: 'Type shop.example.com to confirm' },
			onSubmit,
		});
		const typed = /** @type {HTMLInputElement} */ (opened.dialog.querySelector('.field input'));
		const label = /** @type {HTMLLabelElement} */ (opened.dialog.querySelector('.field label'));
		expect(label.textContent).toBe('Type shop.example.com to confirm');
		expect(label.htmlFor).toBe(typed.id);
		expect(typed.getAttribute('autocomplete')).toBe('off');
		expect(shadow.activeElement).toBe(typed);
		const submit = /** @type {HTMLButtonElement} */ (opened.submit);
		expect(submit.disabled).toBe(true);
		submitForm(opened.dialog);
		await settle();
		expect(onSubmit).not.toHaveBeenCalled();
		typed.value = 'shop.example';
		typed.dispatchEvent(new Event('input'));
		expect(submit.disabled).toBe(true);
		typed.value = ' shop.example.com ';
		typed.dispatchEvent(new Event('input'));
		expect(submit.disabled).toBe(false);
		submitForm(opened.dialog);
		typed.value = 'changed meanwhile';
		await settle();
		expect(opened.status.textContent).toBe('Try again');
		expect(submit.disabled).toBe(true);
		typed.value = 'shop.example.com';
		typed.dispatchEvent(new Event('input'));
		submitForm(opened.dialog);
		await settle();
		expect(onSubmit).toHaveBeenCalledTimes(2);
		expect(opened.dialog.isConnected).toBe(false);
		const next = openDialog(root, {
			title: 'Delete',
			body: [],
			submitLabel: 'Delete',
			closeLabel: 'Cancel',
			confirm: { text: 'x', label: 'Type x' },
			onSubmit,
		});
		expect(/** @type {HTMLInputElement} */ (next.dialog.querySelector('.field input')).id).not.toBe(typed.id);
	});

	it('works on a root in the page itself, and leaves focus alone when the opener is gone', () => {
		const root = element(document, 'div');
		document.body.append(root);
		const opener = element(document, 'button', {}, 'Open');
		root.append(opener);
		opener.focus();
		const opened = openDialog(root, { title: 'Info', body: [], closeLabel: 'Close' });
		opener.remove();
		opened.close();
		expect(document.activeElement).toBe(document.body);
	});
});

describe('moreMenu keyboard', () => {
	it('moves with the arrow keys, Home and End; Tab closes; choosing returns focus to the button first', () => {
		const { root, shadow } = widgetRoot();
		const picked = vi.fn(() => shadow.activeElement);
		const menu = moreMenu(document, 'More', [
			{ label: 'Edit', onSelect: () => {} },
			{ label: 'Copy', onSelect: picked },
			{ label: 'Delete', onSelect: () => {}, danger: true },
		]);
		root.append(menu);
		const [toggle, list] = /** @type {[HTMLElement, HTMLElement]} */ ([...menu.children]);
		const [edit, copy, remove] = /** @type {[HTMLElement, HTMLElement, HTMLElement]} */ ([...list.children]);
		toggle.focus();
		press(toggle, 'ArrowDown');
		expect(list.hasAttribute('hidden')).toBe(false);
		expect(shadow.activeElement).toBe(edit);
		press(edit, 'ArrowDown');
		expect(shadow.activeElement).toBe(copy);
		press(copy, 'ArrowDown');
		expect(shadow.activeElement).toBe(remove);
		press(remove, 'ArrowDown');
		expect(shadow.activeElement).toBe(edit);
		press(edit, 'ArrowUp');
		expect(shadow.activeElement).toBe(remove);
		press(remove, 'Home');
		expect(shadow.activeElement).toBe(edit);
		press(edit, 'End');
		expect(shadow.activeElement).toBe(remove);
		press(remove, 'Tab');
		expect(list.hasAttribute('hidden')).toBe(true);
		toggle.click();
		copy.click();
		// the action ran with focus already back on the button, so a dialog it opens returns focus there
		expect(picked).toHaveReturnedWith(toggle);
	});

	it('does nothing for the arrow keys while closed, except ArrowDown on the button', () => {
		const { root, shadow } = widgetRoot();
		const menu = moreMenu(document, 'More', [{ label: 'Edit', onSelect: () => {} }]);
		root.append(menu);
		const [toggle, list] = /** @type {[HTMLElement, HTMLElement]} */ ([...menu.children]);
		press(toggle, 'ArrowUp');
		expect(list.hasAttribute('hidden')).toBe(true);
		press(toggle, 'ArrowDown');
		expect(shadow.activeElement).toBe(list.children[0]);
	});
});

describe('openDialog focus', () => {
	it('keeps Tab and Shift+Tab inside the dialog', () => {
		const { root, shadow } = widgetRoot();
		const name = element(document, 'input', { name: 'name' });
		const opened = openDialog(root, {
			title: 'Add item',
			body: [name],
			submitLabel: 'Add',
			closeLabel: 'Cancel',
			onSubmit: () => undefined,
		});
		const [cancel, add] = /** @type {[HTMLElement, HTMLElement]} */ ([...opened.dialog.querySelectorAll('.actions button')]);
		const tab = (/** @type {boolean} */ shift) => {
			const event = new KeyboardEvent('keydown', {
				key: 'Tab',
				shiftKey: shift,
				bubbles: true,
				cancelable: true,
				composed: true,
			});
			(shadow.activeElement ?? document.body).dispatchEvent(event);
			return event.defaultPrevented;
		};
		expect(shadow.activeElement).toBe(name);
		expect(tab(true)).toBe(true);
		expect(shadow.activeElement).toBe(add);
		expect(tab(false)).toBe(true);
		expect(shadow.activeElement).toBe(name);
		// in between the browser moves focus itself
		cancel.focus();
		expect(tab(false)).toBe(false);
		expect(tab(true)).toBe(false);
	});

	it('starts on Cancel when the dialog has no field, so a destructive confirm is never one key away', () => {
		const { root, shadow } = widgetRoot();
		const opened = openDialog(root, {
			title: 'Delete rule',
			body: ['This cannot be undone.'],
			submitLabel: 'Delete',
			closeLabel: 'Cancel',
			danger: true,
			onSubmit: () => undefined,
		});
		expect(shadow.activeElement?.textContent).toBe('Cancel');
		opened.close();
	});
});

describe('list states', () => {
	it('shows loading as a status line', () => {
		const loading = loadingState(document, 'Loading payments');
		expect(loading.outerHTML).toBe('<p class="state loading" role="status">Loading payments</p>');
	});

	it('shows an empty list with its next step', () => {
		const add = element(document, 'button', { type: 'button' }, 'Add a link');
		const empty = emptyState(document, 'No links yet.', add);
		expect(empty.className).toBe('state empty');
		expect(empty.firstElementChild?.textContent).toBe('No links yet.');
		expect(empty.lastElementChild).toBe(add);
		expect(emptyState(document, 'Nothing here.').children).toHaveLength(1);
	});

	it('shows a problem as an alert with a Try again button that calls back', () => {
		const onRetry = vi.fn();
		const failed = errorState(document, 'The list did not load.', { label: 'Try again', onRetry });
		expect(failed.getAttribute('role')).toBe('alert');
		expect(failed.querySelector('p')?.textContent).toBe('The list did not load.');
		const again = /** @type {HTMLButtonElement} */ (failed.querySelector('button'));
		expect(again.type).toBe('button');
		expect(again.className).toBe('secondary');
		again.click();
		expect(onRetry).toHaveBeenCalledOnce();
		expect(errorState(document, 'No retry.').querySelector('button')).toBeNull();
	});
});

describe('stateSlot', () => {
	it('shows one state at a time and clears', () => {
		const slot = stateSlot(document);
		expect(slot.root.className).toBe('state-slot');
		slot.loading('Loading');
		expect(slot.root.querySelector('.state.loading')?.textContent).toBe('Loading');
		const retry = vi.fn();
		slot.failed('Not loaded', { label: 'Try again', onRetry: retry });
		expect(slot.root.children).toHaveLength(1);
		/** @type {HTMLButtonElement} */ (slot.root.querySelector('button')).click();
		expect(retry).toHaveBeenCalledOnce();
		slot.empty('Nothing yet.');
		expect(slot.root.querySelector('.state.empty p')?.textContent).toBe('Nothing yet.');
		slot.clear();
		expect(slot.root.childElementCount).toBe(0);
	});
});
