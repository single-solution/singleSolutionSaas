/* global window */
/**
 * Helpers of the list-and-detail admin widget tests (jsdom): the open dialog, More menu entries, filter chips, rows and
 * the detail pane inside a section panel.
 * @module
 */
import { click, flush } from './ui-admin-helpers.js';

/** The dialog on top (dialogs open over the widget, in its shadow root). @param {ShadowRoot} root */
export const dialogOf = (root) => {
	const found = [...root.querySelectorAll('form.dialog')].at(-1);
	if (!found) throw new Error('no dialog');
	return /** @type {HTMLFormElement} */ (found);
};
/** Whether a dialog is open. @param {ShadowRoot} root */
export const hasDialog = (root) => root.querySelector('form.dialog') !== null;

/** Submit the dialog on top. @param {ShadowRoot} root */
export const submitDialog = async (root) => {
	dialogOf(root).dispatchEvent(new window.Event('submit', { cancelable: true }));
	await flush();
};
/** Type the typed confirmation of the dialog on top. @param {ShadowRoot} root @param {string} text */
export const confirmDialog = async (root, text) => {
	const form = dialogOf(root);
	const input = /** @type {HTMLInputElement} */ ([...form.querySelectorAll('input[autocomplete="off"]')].at(-1));
	input.value = text;
	input.dispatchEvent(new window.Event('input'));
	await flush();
	return /** @type {HTMLButtonElement} */ (form.querySelector('button[type="submit"]'));
};
/** The status line of the dialog on top. @param {ShadowRoot} root */
export const dialogStatus = (root) => dialogOf(root).querySelector('[role="status"]')?.textContent ?? '';
/** Close the dialog on top with Cancel. @param {ShadowRoot} root */
export const cancelDialog = async (root) => {
	const cancel = [...dialogOf(root).querySelectorAll('button')].find((button) => button.textContent === 'Cancel');
	await click(/** @type {HTMLElement} */ (cancel));
};

/**
 * Open a More menu holding an entry and pick the entry.
 * @param {ParentNode} scope @param {string} label
 */
export const pickMenu = async (scope, label) => {
	const item = [...scope.querySelectorAll('button[role="menuitem"]')].find((button) => button.textContent === label);
	if (!item) throw new Error(`no menu entry ${label}`);
	const opener = /** @type {HTMLElement} */ (item.closest('.more')?.querySelector('button[aria-haspopup]'));
	opener.click();
	await click(/** @type {HTMLElement} */ (item));
};
/** The entries of the More menus in a scope. @param {ParentNode} scope */
export const menuEntries = (scope) =>
	[...scope.querySelectorAll('button[role="menuitem"]')].map((button) => button.textContent ?? '');

/** A filter chip by its value. @param {ParentNode} scope @param {string} value */
export const chipOf = (scope, value) =>
	/** @type {HTMLButtonElement} */ (scope.querySelector(`.chipbar button[data-value="${value}"]`));
/** The count badge of a chip ('' while unknown). @param {ParentNode} scope @param {string} value */
export const chipCount = (scope, value) => {
	const badge = chipOf(scope, value).querySelector('.count');
	return badge?.hasAttribute('hidden') ? '' : (badge?.textContent ?? '');
};
/** The list's count badge ('' while unknown). @param {ParentNode} scope */
export const listCount = (scope) => {
	const badge = scope.querySelector('.list-head .count');
	return badge?.hasAttribute('hidden') ? '' : (badge?.textContent ?? '');
};
/** The rows of the list. @param {ParentNode} scope */
export const rowsOf = (scope) => /** @type {HTMLElement[]} */ ([...scope.querySelectorAll('li.item')]);
/** A row by its id. @param {ParentNode} scope @param {string} id */
export const rowOf = (scope, id) => /** @type {HTMLElement} */ (scope.querySelector(`li.item[data-id="${id}"]`));
/** The detail pane. @param {ParentNode} scope */
export const detailOf = (scope) => /** @type {HTMLElement} */ (scope.querySelector('.detail-pane'));
/** Pick a row. @param {ParentNode} scope @param {string} id */
export const openRow = async (scope, id) => {
	await click(rowOf(scope, id));
};
