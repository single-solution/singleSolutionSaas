'use client';
/**
 * What a list-and-detail screen showed last, kept in the browser only (never on the server) so the loading skeleton
 * of the next page of the same screen can keep the list in place: picking another item, the list stays where it was
 * (same rows, same scroll position, the picked row marked at once) while only the detail shows its skeleton. Section
 * changes with no list kept show a list skeleton; the real list then fades in.
 * @module
 */
import { createContext, useContext, useSyncExternalStore } from 'react';

/**
 * @typedef {object} ScreenMemory
 * @property {import('react').ReactNode} list the list pane as last rendered
 */

/** @type {Map<string, ScreenMemory>} */
const screens = new Map();
/** @type {Map<string, number>} */
const scrolls = new Map();
/** @type {Map<string, boolean>} */
const skeletons = new Map();
/** @type {Map<string, boolean>} */
const strips = new Map();
/** @type {Set<() => void>} */
const listeners = new Set();

/**
 * Keep the list pane a screen rendered (call from an effect: browser only).
 * @param {string} section
 * @param {import('react').ReactNode} list
 */
export const rememberList = (section, list) => {
	screens.set(section, { list });
	for (const listener of listeners) listener();
};

/** @param {() => void} listener */
const subscribe = (listener) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};

/**
 * The list pane a screen rendered last (null on the server and before any).
 * @param {string | null} section
 * @returns {ScreenMemory | null}
 */
export const useRememberedList = (section) =>
	useSyncExternalStore(
		subscribe,
		() => (section === null ? null : (screens.get(section) ?? null)),
		() => null,
	);

/**
 * The scroll position of a list pane (restored when it renders again).
 * @param {string} section
 * @param {number} [top] the new position
 * @returns {number}
 */
export const listScroll = (section, top) => {
	if (top !== undefined) scrolls.set(section, top);
	return scrolls.get(section) ?? 0;
};

/**
 * Whether the loading skeleton of a section showed a placeholder list (so the real list fades in) or the kept one (so
 * it stays still). Set by the skeleton (browser only), read by the list pane.
 * @param {string} section
 * @param {boolean} [placeholder]
 * @returns {boolean}
 */
export const listWasPlaceholder = (section, placeholder) => {
	if (placeholder !== undefined) skeletons.set(section, placeholder);
	return skeletons.get(section) ?? false;
};

/**
 * Whether the list of a screen is open where it is a strip above the detail (1024–1279 px): the person's last choice
 * on that screen (browser only), closed by default.
 * @param {string} section
 * @param {boolean} [open] the new choice
 * @returns {boolean}
 */
export const stripOpen = (section, open) => {
	if (open !== undefined) strips.set(section, open);
	return strips.get(section) ?? false;
};

/**
 * The list strip of a screen whose detail is shown: open or closed, and how to change it.
 * @typedef {{ open: boolean, toggle: () => void, picked: () => void }} Strip
 */

/**
 * The screen a list pane belongs to, in a loading skeleton the path the click is going to (its row shows as
 * selected), and its list strip (null while no detail is shown, where the list is always open).
 * @typedef {{ section: string | null, going: string | null, strip: Strip | null }} Screen
 * @type {import('react').Context<Screen>}
 */
export const ScreenContext = createContext(/** @type {Screen} */ ({ section: null, going: null, strip: null }));

/** The screen a list pane belongs to. */
export const useScreen = () => useContext(ScreenContext);

/** Forget everything (tests). */
export const forgetScreens = () => {
	screens.clear();
	scrolls.clear();
	skeletons.clear();
	strips.clear();
};
