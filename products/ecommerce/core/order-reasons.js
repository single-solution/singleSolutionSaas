/**
 * Why an order was canceled or its package came back (fixed-choices E19): two merchant lists of the Checkout feature,
 * each reason `{ key, label, countsAgainst }`:
 *
 * - `cancel_reasons`: what staff pick when they cancel (seeded: the customer asked, items not available, the customer
 *   did not confirm); a cancel without one is allowed;
 * - `delivery_failure_reasons`: what staff pick when a shipped package comes back (a move into a returned-to-origin
 *   status; seeded with today's two: could not be delivered, which counts, and sent back by the customer, which does
 *   not); a move without one takes the first.
 *
 * `countsAgainst` adds one to the customer's returned-packages counter (`rtoCount`), which payment methods paid on
 * delivery or at pickup read (their `rtoThreshold`, `core/payment-methods.js`). The reason's key is kept on the order
 * (`closeReason`) and its history entry, so lists, counts and reports group by it. Checkout's own cancels keep who or
 * what canceled (`staff`, `shopper`, `expired`), which are reserved keys. Pure, no I/O.
 * @module
 */
import { boolField, checkNamedList } from './named-lists.js';

/** @typedef {{ key: string, label: string, countsAgainst: boolean }} OrderReason */

/** At most this many reasons in each list. */
export const REASON_LIMIT = 30;
/** Keys checkout's own cancels write (who or what canceled). */
export const CHECKOUT_CANCEL_REASONS = Object.freeze(/** @type {const} */ (['staff', 'shopper', 'expired']));

/** @type {ReadonlyArray<OrderReason>} */
export const DEFAULT_CANCEL_REASONS = Object.freeze([
	{ key: 'customer_request', label: 'The customer asked to cancel', countsAgainst: false },
	{ key: 'not_available', label: 'Items not available', countsAgainst: false },
	{ key: 'not_confirmed', label: 'The customer did not confirm', countsAgainst: false },
]);

/** @type {ReadonlyArray<OrderReason>} */
export const DEFAULT_DELIVERY_FAILURE_REASONS = Object.freeze([
	{ key: 'rto', label: 'Could not be delivered', countsAgainst: true },
	{ key: 'customer_return', label: 'Sent back by the customer', countsAgainst: false },
]);

/**
 * Check a reason list.
 * @param {unknown} value
 * @returns {{ ok: true, value: OrderReason[] } | { ok: false, errors: Array<{ path: string, message: string }> }}
 */
export const checkReasons = (value) =>
	/** @type {{ ok: true, value: OrderReason[] } | { ok: false, errors: Array<{ path: string, message: string }> }} */ (
		checkNamedList(value, {
			max: REASON_LIMIT,
			what: 'reasons',
			label: 120,
			reserved: CHECKOUT_CANCEL_REASONS,
			fields: (entry, fail) => ({ countsAgainst: boolField(entry, 'countsAgainst', false, fail) }),
		})
	);

/**
 * The reason a staff move gives: one of the list's keys (none given: none for a cancel, the first for a package that
 * came back), with whether it counts against the customer.
 * @param {unknown} given
 * @param {ReadonlyArray<OrderReason>} reasons
 * @param {{ fallbackFirst: boolean }} rules
 * @returns {{ ok: true, reason: OrderReason | null } | { ok: false }}
 */
export const reasonOf = (given, reasons, { fallbackFirst }) => {
	if (given === undefined || given === null || given === '')
		return { ok: true, reason: fallbackFirst ? (reasons[0] ?? null) : null };
	const found = reasons.find((reason) => reason.key === given);
	return found ? { ok: true, reason: found } : { ok: false };
};
