/**
 * The shopper's cart, kept in the browser (localStorage `ss-ecommerce-cart`, PLAN 0.8.4): lines of product, variant,
 * quantity and (bookings) the slot start, plus the coupon code entered. The server prices the cart every time it is
 * shown and again when the order is placed, so nothing kept here is trusted. Listeners hear every change (the cart
 * widget, the cart count). A browser without storage keeps the cart for the page's life only.
 * @module
 */
import { STORAGE_KEYS } from '../core/widgets.js';

/** At most this many lines, and this many of one line. */
export const MAX_LINES = 50;
export const MAX_QUANTITY = 99;

/** @typedef {{ productId: string, variantId: string | null, quantity: number, slot?: string }} CartLine */
/** @typedef {{ lines: CartLine[], coupon: string }} CartState */

/** @param {unknown} raw @returns {CartState} */
const parse = (raw) => {
	try {
		const value = JSON.parse(String(raw ?? ''));
		const lines = Array.isArray(value?.lines) ? value.lines : [];
		return {
			lines: lines
				.filter(
					(/** @type {any} */ line) =>
						typeof line?.productId === 'string' && Number.isSafeInteger(line.quantity) && line.quantity > 0,
				)
				.slice(0, MAX_LINES)
				.map((/** @type {any} */ line) => ({
					productId: line.productId,
					variantId: typeof line.variantId === 'string' ? line.variantId : null,
					quantity: Math.min(MAX_QUANTITY, line.quantity),
					...(typeof line.slot === 'string' ? { slot: line.slot } : {}),
				})),
			coupon: typeof value?.coupon === 'string' ? value.coupon.slice(0, 40) : '',
		};
	} catch {
		return { lines: [], coupon: '' };
	}
};

/** @param {CartLine} a @param {CartLine} b */
const same = (a, b) => a.productId === b.productId && a.variantId === b.variantId && a.slot === b.slot;

/**
 * @param {{ storage: Storage | null }} input the page's localStorage (null when the browser blocks it)
 */
export const createCartStore = ({ storage }) => {
	/** @type {CartState} */
	let state = { lines: [], coupon: '' };
	try {
		state = parse(storage?.getItem(STORAGE_KEYS.cart));
	} catch {
		state = { lines: [], coupon: '' };
	}
	/** @type {Set<(state: CartState) => void>} */
	const listeners = new Set();
	/** @param {CartState} next */
	const write = (next) => {
		state = next;
		try {
			storage?.setItem(STORAGE_KEYS.cart, JSON.stringify(state));
		} catch {
			// storage full or blocked: keep the cart in memory
		}
		for (const listener of listeners) listener(state);
	};
	return Object.freeze({
		/** @returns {CartState} */
		state: () => state,
		/** Number of items. */
		count: () => state.lines.reduce((sum, line) => sum + line.quantity, 0),
		/** @param {CartLine} line */
		add: (line) => {
			const quantity = Math.max(1, Math.min(MAX_QUANTITY, Math.floor(line.quantity || 1)));
			const found = state.lines.find((entry) => same(entry, line));
			const lines = found
				? state.lines.map((entry) =>
						entry === found ? { ...entry, quantity: Math.min(MAX_QUANTITY, entry.quantity + quantity) } : entry,
					)
				: [...state.lines, { ...line, quantity }].slice(0, MAX_LINES);
			write({ ...state, lines });
		},
		/** @param {CartLine} line @param {number} quantity 0 removes it */
		set: (line, quantity) =>
			write({
				...state,
				lines:
					quantity <= 0
						? state.lines.filter((entry) => !same(entry, line))
						: state.lines.map((entry) =>
								same(entry, line) ? { ...entry, quantity: Math.min(MAX_QUANTITY, quantity) } : entry,
							),
			}),
		/** @param {string} coupon */
		setCoupon: (coupon) => write({ ...state, coupon: coupon.trim().slice(0, 40) }),
		clear: () => write({ lines: [], coupon: '' }),
		/** @param {(state: CartState) => void} listener @returns {() => void} */
		onChange: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	});
};

/** @typedef {ReturnType<typeof createCartStore>} CartStore */
