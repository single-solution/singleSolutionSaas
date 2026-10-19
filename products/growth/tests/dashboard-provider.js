/**
 * A dashboard piece inside the dashboard's provider (Growth's words and feature names), as the page renders it.
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

/** Close the open drawer with its Done button. */
export const closeDrawer = async () => {
	const done = [...drawerOf().querySelectorAll('button')].find((button) => button.textContent === 'Done');
	await act(async () => click(/** @type {HTMLElement} */ (done)));
};
