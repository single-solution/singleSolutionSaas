/**
 * Tables and drawers of the dashboard as a test reads them: a table's rows by name, a row's menu and the open drawer.
 * @module
 */
/* global document */
import { act } from 'react';
import { click } from '@ss/ui/testing';

/** The open drawer: a drawer is drawn on the page body, outside the container a test renders into. */
export const drawerOf = () => /** @type {HTMLElement} */ (document.querySelector('[role="dialog"]'));

/**
 * The names of a table's rows (its first cell).
 * @param {HTMLElement} root
 */
export const rowNames = (root) =>
	[...root.querySelectorAll('tbody tr')].map((row) => row.querySelector('th, td')?.textContent ?? '');

/**
 * A table's row by its name.
 * @param {HTMLElement} root
 * @param {string} name
 */
export const rowOf = (root, name) => {
	const row = [...root.querySelectorAll('tbody tr')].find((one) => one.querySelector('th, td')?.textContent === name);
	if (!row) throw new Error(`no row “${name}”`);
	return /** @type {HTMLElement} */ (row);
};

/**
 * Open a row's record in the drawer, as a click on the row does.
 * @param {HTMLElement} root
 * @param {string} name
 */
export const openRow = async (root, name) => {
	await act(async () => click(/** @type {HTMLElement} */ (rowOf(root, name).querySelector('th, td'))));
	return drawerOf();
};

/**
 * The items of a row's menu, open (the button is the row's last one with a pop-up).
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

/**
 * A button of the open drawer by its words.
 * @param {string} words
 */
export const drawerButton = (words) => {
	const button = [...drawerOf().querySelectorAll('button')].find((one) => one.textContent === words);
	if (!button) throw new Error(`no button “${words}” in the drawer`);
	return /** @type {HTMLButtonElement} */ (button);
};
