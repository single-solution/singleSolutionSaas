// @vitest-environment jsdom
/* global document, KeyboardEvent */
/**
 * Dialog forms of the admin widgets (KP-1b, 305 and 306): the submit button comes back even when saving throws; while
 * saving, Escape and Cancel wait; typed text is not thrown away without asking once; a save that ends after the dialog
 * closed does nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { element, openDialog } from '../src/widget.js';

afterEach(() => document.body.replaceChildren());

const widgetRoot = () => {
	const host = document.createElement('div');
	document.body.append(host);
	const root = document.createElement('div');
	host.attachShadow({ mode: 'open' }).append(root);
	return root;
};

/** @param {Element} node @param {string} key */
const press = (node, key) => node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true }));
/** @param {Element} form */
const submitForm = (form) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** @param {HTMLInputElement} field @param {string} value */
const typeInto = (field, value) => {
	field.value = value;
	field.dispatchEvent(new Event('input', { bubbles: true }));
};

/**
 * A form dialog with one field.
 * @param {() => Promise<string | null | undefined | void> | string | null | undefined | void} onSubmit
 */
const form = (onSubmit) => {
	const root = widgetRoot();
	const name = /** @type {HTMLInputElement} */ (element(document, 'input', { name: 'name' }));
	const opened = openDialog(root, { title: 'Add item', body: [name], submitLabel: 'Add', closeLabel: 'Cancel', onSubmit });
	const cancel = /** @type {HTMLButtonElement} */ (opened.dialog.querySelector('button.secondary'));
	return { opened, name, cancel, submit: /** @type {HTMLButtonElement} */ (opened.submit) };
};

describe('a save that throws (305)', () => {
	it('gives the Save button back, keeps the dialog open and says that saving failed', async () => {
		const { opened, name, submit } = form(async () => {
			throw new Error('network');
		});
		typeInto(name, 'Kept');
		submitForm(opened.dialog);
		expect(submit.disabled).toBe(true);
		await settle();
		expect(submit.disabled).toBe(false);
		expect(opened.dialog.isConnected).toBe(true);
		expect(opened.status.textContent).toBe('Saving failed. Try again.');
		expect(opened.status.className).toBe('status error');
		expect(name.value).toBe('Kept');
	});

	it('takes the failed words from the caller', async () => {
		const root = widgetRoot();
		const opened = openDialog(root, {
			title: 'Add',
			body: [],
			submitLabel: 'Add',
			closeLabel: 'Cancel',
			failedText: 'Could not save.',
			onSubmit: () => {
				throw new Error('sync');
			},
		});
		submitForm(opened.dialog);
		await settle();
		expect(opened.status.textContent).toBe('Could not save.');
		expect(opened.submit?.disabled).toBe(false);
	});
});

describe('Escape and Cancel while saving (306)', () => {
	it('wait for the save: neither closes the dialog, and the answer decides', async () => {
		/** @type {(value: string | null) => void} */
		let finish = () => undefined;
		const { opened, cancel } = form(() => new Promise((resolve) => (finish = resolve)));
		submitForm(opened.dialog);
		press(opened.dialog, 'Escape');
		cancel.click();
		expect(opened.dialog.isConnected).toBe(true);
		finish('Name is taken');
		await settle();
		expect(opened.dialog.isConnected).toBe(true);
		expect(opened.status.textContent).toBe('Name is taken');
		// the save is over: Escape works again
		press(opened.dialog, 'Escape');
		expect(opened.dialog.isConnected).toBe(false);
	});

	it('a save that works closes the dialog by itself', async () => {
		/** @type {(value: null) => void} */
		let finish = () => undefined;
		const { opened } = form(() => new Promise((resolve) => (finish = resolve)));
		submitForm(opened.dialog);
		press(opened.dialog, 'Escape');
		finish(null);
		await settle();
		expect(opened.dialog.isConnected).toBe(false);
	});

	it('a save that ends after the dialog was closed from outside does not throw', async () => {
		/** @type {(value: string) => void} */
		let finish = () => undefined;
		/** @type {(reason: Error) => void} */
		let fail = () => undefined;
		const first = form(() => new Promise((resolve) => (finish = resolve)));
		submitForm(first.opened.dialog);
		first.opened.close();
		finish('Too late');
		const second = form(() => new Promise((_resolve, reject) => (fail = reject)));
		submitForm(second.opened.dialog);
		second.opened.close();
		fail(new Error('too late'));
		await settle();
		expect(first.opened.status.textContent).toBe('');
		expect(second.opened.status.textContent).toBe('');
	});
});

describe('Escape and Cancel with typed text ask once (306)', () => {
	it('close at once when nothing was typed', () => {
		const { opened } = form(() => null);
		press(opened.dialog, 'Escape');
		expect(opened.dialog.isConnected).toBe(false);
		const next = form(() => null);
		next.cancel.click();
		expect(next.opened.dialog.isConnected).toBe(false);
	});

	it('Escape asks "Discard what you typed?" first and closes on the second press', () => {
		const { opened, name, cancel } = form(() => null);
		typeInto(name, 'Half a name');
		press(opened.dialog, 'Escape');
		expect(opened.dialog.isConnected).toBe(true);
		expect(opened.status.textContent).toBe('Discard what you typed?');
		expect(cancel.textContent).toBe('Discard');
		press(opened.dialog, 'Escape');
		expect(opened.dialog.isConnected).toBe(false);
	});

	it('Cancel asks the same way and closes on the second click', () => {
		const { opened, name, cancel } = form(() => null);
		typeInto(name, 'Half a name');
		cancel.click();
		expect(opened.dialog.isConnected).toBe(true);
		expect(opened.status.textContent).toBe('Discard what you typed?');
		cancel.click();
		expect(opened.dialog.isConnected).toBe(false);
	});

	it('asks again after more typing, and takes the question back', () => {
		const { opened, name, cancel } = form(() => null);
		typeInto(name, 'A');
		press(opened.dialog, 'Escape');
		typeInto(name, 'AB');
		expect(opened.status.textContent).toBe('');
		expect(cancel.textContent).toBe('Cancel');
		press(opened.dialog, 'Escape');
		expect(opened.dialog.isConnected).toBe(true);
		expect(opened.status.textContent).toBe('Discard what you typed?');
	});

	it("says the question in the caller's words", () => {
		const root = widgetRoot();
		const name = /** @type {HTMLInputElement} */ (element(document, 'input'));
		const opened = openDialog(root, {
			title: 'Add',
			body: [name],
			submitLabel: 'Add',
			closeLabel: 'Cancel',
			discardText: 'Throw it away?',
			discardLabel: 'Throw away',
			onSubmit: () => null,
		});
		typeInto(name, 'x');
		press(opened.dialog, 'Escape');
		expect(opened.status.textContent).toBe('Throw it away?');
		expect(opened.dialog.querySelector('button.secondary')?.textContent).toBe('Throw away');
	});

	it('does not count the typed confirmation as typed work', () => {
		const root = widgetRoot();
		const opened = openDialog(root, {
			title: 'Delete',
			body: [],
			submitLabel: 'Delete',
			closeLabel: 'Cancel',
			confirm: { text: 'shop', label: 'Type shop' },
			onSubmit: () => null,
		});
		typeInto(/** @type {HTMLInputElement} */ (opened.dialog.querySelector('.field input')), 'sho');
		press(opened.dialog, 'Escape');
		expect(opened.dialog.isConnected).toBe(false);
	});

	it('a dialog that only shows information still closes at once', () => {
		const root = widgetRoot();
		const opened = openDialog(root, { title: 'Usage', body: [element(document, 'input')], closeLabel: 'Close' });
		typeInto(/** @type {HTMLInputElement} */ (opened.dialog.querySelector('input')), 'x');
		press(opened.dialog, 'Escape');
		expect(opened.dialog.isConnected).toBe(false);
	});

	it('a failed save keeps the typed text and the next Escape still asks', async () => {
		const { opened, name } = form(() => 'Name is taken');
		typeInto(name, 'Dup');
		submitForm(opened.dialog);
		await settle();
		press(opened.dialog, 'Escape');
		expect(opened.dialog.isConnected).toBe(true);
		expect(opened.status.textContent).toBe('Discard what you typed?');
	});
});
