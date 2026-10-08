/**
 * The compare list, kept in the shopper's browser (localStorage `ss-ecommerce-compare`, PLAN 0.8.4): product ids in
 * the order added, at most the `compare` setting's largest number. The grid's and the product page's compare toggles
 * write it; the compare widget reads it. Every change is announced on the window (`ss-ecommerce:compare`) so widgets
 * on the same page follow, and other tabs follow through the `storage` event. A browser without storage keeps the
 * list for the page's life only.
 * @module
 */
import { STORAGE_KEYS } from '../core/widgets.js';

/** The window event of a change to the compare list (`detail`: the ids). */
export const COMPARE_EVENT = 'ss-ecommerce:compare';
/** More ids than this are never kept, whatever the setting says. */
const MAX_KEPT = 10;
const PRODUCT_ID = /^prd_[A-Za-z0-9]{1,64}$/;

/** The list per window when the browser keeps no storage. @type {WeakMap<object, string[]>} */
const memory = new WeakMap();

/** @param {Window & typeof globalThis} win @returns {Storage | null} */
const storageOf = (win) => {
	try {
		return win.localStorage ?? null;
	} catch {
		return null;
	}
};

/** @param {unknown} value @returns {string[]} */
const clean = (value) =>
	Array.isArray(value)
		? [...new Set(value.filter((id) => typeof id === 'string' && PRODUCT_ID.test(id)))].slice(0, MAX_KEPT)
		: [];

/**
 * The product ids to compare.
 * @param {Window & typeof globalThis} win
 * @returns {string[]}
 */
export const compareIds = (win) => {
	const storage = storageOf(win);
	if (!storage) return memory.get(win) ?? [];
	try {
		return clean(JSON.parse(storage.getItem(STORAGE_KEYS.compare) ?? '[]'));
	} catch {
		return [];
	}
};

/** @param {Window & typeof globalThis} win @param {string[]} ids */
const write = (win, ids) => {
	const storage = storageOf(win);
	if (storage) {
		try {
			storage.setItem(STORAGE_KEYS.compare, JSON.stringify(ids));
		} catch {
			memory.set(win, ids);
		}
	} else memory.set(win, ids);
	win.dispatchEvent(new win.CustomEvent(COMPARE_EVENT, { detail: ids }));
};

/**
 * Add a product to the list or take it off.
 * @param {Window & typeof globalThis} win
 * @param {string} productId
 * @param {number} max the `compare` setting's largest number
 * @returns {{ ok: boolean, ids: string[] }} `ok` false when the list is full (nothing changed)
 */
export const toggleCompare = (win, productId, max) => {
	const ids = compareIds(win);
	if (ids.includes(productId)) {
		const next = ids.filter((id) => id !== productId);
		write(win, next);
		return { ok: true, ids: next };
	}
	if (ids.length >= Math.min(max, MAX_KEPT) || !PRODUCT_ID.test(productId)) return { ok: false, ids };
	const next = [...ids, productId];
	write(win, next);
	return { ok: true, ids: next };
};

/** @param {Window & typeof globalThis} win @param {string} productId */
export const removeCompare = (win, productId) =>
	write(
		win,
		compareIds(win).filter((id) => id !== productId),
	);

/** @param {Window & typeof globalThis} win */
export const clearCompare = (win) => write(win, []);

/**
 * Follow changes made here or in another tab.
 * @param {Window & typeof globalThis} win
 * @param {(ids: string[]) => void} listener
 * @returns {() => void} stop
 */
export const onCompareChange = (win, listener) => {
	const local = () => listener(compareIds(win));
	/** @param {StorageEvent} event */
	const other = (event) => {
		if (event.key === STORAGE_KEYS.compare) listener(compareIds(win));
	};
	win.addEventListener(COMPARE_EVENT, local);
	win.addEventListener('storage', other);
	return () => {
		win.removeEventListener(COMPARE_EVENT, local);
		win.removeEventListener('storage', other);
	};
};
