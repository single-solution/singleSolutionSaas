/**
 * A dashboard piece inside the dashboard's provider (Chat's words and feature names), as the page renders it, and the
 * rows and editor of a list as a test reads them.
 * @module
 */
/* global document */
import { act, createElement } from 'react';
import { click } from '@ss/ui/testing';
import { DashboardProvider } from '@ss/ui/dashboard';
import manifest from '../manifest.json' with { type: 'json' };
import { TEXTS } from '../app/dashboard/texts.js';

/** @param {import('react').ReactNode} node */
export const inDashboard = (node) => createElement(DashboardProvider, { manifest, texts: TEXTS }, node);

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
 * What a row says: its line of facts, its value, and the state dot's words (empty without one).
 * @param {HTMLElement} row
 */
export const factsOf = (row) => ({
	meta: row.querySelector('p')?.textContent ?? '',
	value: row.querySelector('.tabular-nums')?.textContent ?? '',
	status: row.querySelector('.sr-only')?.textContent ?? '',
});

/** The open editor of an entry: the drawer of a long one, or the fields in place under their row (null when none is open). */
export const editorOf = () => /** @type {HTMLElement} */ (drawerOf() ?? document.querySelector('[data-entry]'));

/**
 * Open a row's entry in its editor, as a click on the row does.
 * @param {HTMLElement} root
 * @param {string} name
 */
export const openRow = async (root, name) => {
	await act(async () => click(rowOf(root, name)));
	return editorOf();
};

/**
 * Choose an item of a row's menu (Move up, Move down, Remove).
 * @param {HTMLElement} root
 * @param {string} name the row
 * @param {string} item
 */
export const rowMenu = async (root, name, item) => {
	await act(async () => click(/** @type {HTMLElement} */ (rowOf(root, name).querySelector('button[aria-haspopup]'))));
	const entry = [...document.querySelectorAll('[role="menuitem"]')].find((one) => one.textContent === item);
	if (!entry) throw new Error(`no menu item “${item}”`);
	await act(async () => click(/** @type {HTMLElement} */ (entry)));
};

/** Close the open editor with its Done button. */
export const closeEditor = async () => {
	const done = [...editorOf().querySelectorAll('button')].find((button) => button.textContent === 'Done');
	await act(async () => click(/** @type {HTMLElement} */ (done)));
};
