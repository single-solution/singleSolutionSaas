/**
 * The order keys of a guest's orders, kept in the browser (E21): a guest order's answer carries its key once, and the
 * widget runtime sends it in `SS-Order-Key` with every call about that order (reading it, paying, canceling, the
 * transfer proof, the invoice, downloads and the reviews of its items). The newest {@link MAX_ORDER_KEYS} are kept; a
 * browser without storage keeps them for the page's life only.
 * @module
 */
import { ORDER_ID } from '../core/orders.js';
import { STORAGE_KEYS } from '../core/widgets.js';

/** The most order keys kept, the newest first. */
const MAX_ORDER_KEYS = 20;
/** An order key as the server makes them (letters and digits). */
const ORDER_KEY = /^[A-Za-z0-9]{16,128}$/;

/** @typedef {{ id: string, key: string }} OrderKey */

/**
 * The kept keys of a stored text; anything else is left out.
 * @param {string | null | undefined} text
 * @returns {OrderKey[]}
 */
const parse = (text) => {
	/** @type {unknown} */
	let value = null;
	try {
		value = JSON.parse(text ?? '[]');
	} catch {
		return [];
	}
	return (Array.isArray(value) ? value : [])
		.filter((entry) => ORDER_ID.test(entry?.id) && ORDER_KEY.test(entry?.key))
		.map((entry) => ({ id: String(entry.id), key: String(entry.key) }))
		.slice(0, MAX_ORDER_KEYS);
};

/**
 * @param {{ storage: Storage | null }} input the page's localStorage (null when the browser blocks it)
 */
export const createOrderKeys = ({ storage }) => {
	/** @type {OrderKey[]} */
	let entries = [];
	try {
		entries = parse(storage?.getItem(STORAGE_KEYS.orderKeys));
	} catch {
		entries = [];
	}
	return Object.freeze({
		/**
		 * Keep a guest order's key (the newest first).
		 * @param {string} id @param {string} key
		 */
		keep: (id, key) => {
			if (!ORDER_ID.test(id) || !ORDER_KEY.test(key)) return;
			entries = [{ id, key }, ...entries.filter((entry) => entry.id !== id)].slice(0, MAX_ORDER_KEYS);
			try {
				storage?.setItem(STORAGE_KEYS.orderKeys, JSON.stringify(entries));
			} catch {
				// storage full or blocked: keep the keys in memory
			}
		},
		/** @param {string} id @returns {string | null} */
		keyOf: (id) => entries.find((entry) => entry.id === id)?.key ?? null,
		/** The ids of the guest orders kept, the newest first. */
		ids: () => entries.map((entry) => entry.id),
	});
};
