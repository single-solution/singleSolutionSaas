/**
 * Rows and drawers of the dashboard as a test reads them: a list's rows by name, a row's facts and menu, and the open
 * drawer.
 * @module
 */
/* global document */
import { act } from 'react';
import { click } from '@ss/ui/testing';

/** The open drawer: a drawer is drawn on the page body, outside the container a test renders into. */
export const drawerOf = () => /** @type {HTMLElement} */ (document.querySelector('[role="dialog"]'));

/**
 * The rows of a list, in order.
 * @param {HTMLElement} root
 */
export const rowsOf = (root) => /** @type {HTMLElement[]} */ ([...root.querySelectorAll('[data-ss-row]')]);

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
 * What a row says: its line of facts (or its warning), its value, and the state dot's words (empty without one).
 * @param {HTMLElement} row
 */
export const factsOf = (row) => ({
	meta: row.querySelector('p')?.textContent ?? '',
	value: row.querySelector('.tabular-nums')?.textContent ?? '',
	status: row.querySelector('.sr-only')?.textContent ?? '',
});

/**
 * Open a row's record in the drawer, as a click on the row does.
 * @param {HTMLElement} root
 * @param {string} name
 */
export const openRow = async (root, name) => {
	await act(async () => click(rowOf(root, name)));
	return drawerOf();
};

/**
 * The items of a row's menu, open (the button is the row's one with a pop-up).
 * @param {HTMLElement} row
 */
export const openMenuOf = async (row) => {
	await act(async () => click(/** @type {HTMLElement} */ (row.querySelector('button[aria-haspopup]'))));
	return /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll('[role="menuitem"]')]);
};

/**
 * Choose an item of a row's menu (Move up, Move down, Delete).
 * @param {HTMLElement} root
 * @param {string} name the row
 * @param {string} item
 */
export const rowMenu = async (root, name, item) => {
	const entry = (await openMenuOf(rowOf(root, name))).find((one) => one.textContent === item);
	if (!entry) throw new Error(`no menu item “${item}”`);
	await act(async () => click(entry));
};

/**
 * A button of the open drawer by its words.
 * @param {string} words
 */
export const drawerButton = (words) => {
	const button = [...drawerOf().querySelectorAll('button')].find((one) => one.textContent === words);
	if (!button) throw new Error(`no button “${words}” in the drawer`);
	return /** @type {HTMLButtonElement} */ (button);
};
