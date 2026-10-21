/**
 * Rows and in-place editors of the dashboard as a test reads them: a list's rows by name, a row's facts, state and
 * menu, and the editor that opens under a row.
 * @module
 */
/* global document */
import { act } from 'react';
import { click } from '@ss/ui/testing';

/**
 * The rows of a list.
 * @param {HTMLElement} root
 */
const rowsOf = (root) => /** @type {HTMLElement[]} */ ([...root.querySelectorAll('[data-ss-row]')]);

/** @param {Element} row the name of a row (its title) */
const titleOf = (row) => row.querySelector('span.truncate')?.textContent ?? '';

/**
 * The names of a list's rows (their titles).
 * @param {HTMLElement} root
 */
export const rowNames = (root) => rowsOf(root).map(titleOf);

/**
 * A list's row by its name.
 * @param {HTMLElement} root
 * @param {string} name
 */
export const rowOf = (root, name) => {
	const row = rowsOf(root).find((one) => titleOf(one) === name);
	if (!row) throw new Error(`no row “${name}”`);
	return row;
};

/**
 * What a row says: its line of facts, its value, and the state dot's words (empty without one).
 * @param {HTMLElement} row
 */
export const factsOf = (row) => ({
	meta: row.querySelector('p')?.textContent ?? '',
	value: row.querySelector('.tabular-nums')?.textContent ?? '',
	status: row.querySelector('.sr-only')?.textContent ?? '',
});

/** The open editor: the form that opens in place, under a row or at the top of the list. @param {HTMLElement} root */
export const editorOf = (root) => /** @type {HTMLFormElement} */ (root.querySelector('form'));

/**
 * Open a row's record in place, as a click on the row does.
 * @param {HTMLElement} root
 * @param {string} name
 */
export const openRow = async (root, name) => {
	await act(async () => click(rowOf(root, name)));
	return editorOf(root);
};

/**
 * A button of the open editor by its words.
 * @param {HTMLElement} root
 * @param {string} words
 */
export const editorButton = (root, words) => {
	const button = [...editorOf(root).querySelectorAll('button')].find((one) => one.textContent === words);
	if (!button) throw new Error(`no button “${words}” in the editor`);
	return /** @type {HTMLButtonElement} */ (button);
};

/**
 * The items of a row's menu, open (the button is the row's one with a pop-up).
 * @param {HTMLElement} root
 * @param {string} name the row
 */
export const openRowMenu = async (root, name) => {
	await act(async () => click(/** @type {HTMLElement} */ (rowOf(root, name).querySelector('button[aria-haspopup]'))));
	return /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll('[role="menuitem"]')]);
};

/**
 * Choose an item of a row's menu (Move up, Move down, Delete).
 * @param {HTMLElement} root
 * @param {string} name the row
 * @param {string} item
 */
export const rowMenu = async (root, name, item) => {
	const entry = (await openRowMenu(root, name)).find((one) => one.textContent === item);
	if (!entry) throw new Error(`no menu item “${item}”`);
	await act(async () => click(entry));
};
