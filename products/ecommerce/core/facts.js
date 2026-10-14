/**
 * An order's facts (PLAN 0.8.10 "Ecommerce dynamic model", design §3.2): what the order holds or gave back, whatever
 * its status is called. Only the order engine writes them (`core/transitions.js` plans, `server/transitions.js` runs);
 * the write that changes them is guarded by them, so nothing is given back or taken twice.
 *
 * - `stock`: `held` (its stock and booked slots are held), `sold` (delivered: its units are sold), `back` (given back),
 *   `none` (a package that came back kept out of stock: its move's `restock` no);
 * - `offers`: its offer uses are `counted` or `released`;
 * - `redeemed`: the points it redeemed are `spent` or `given_back`;
 * - `earned`: the points it earns are `none` yet, `credited` or `reversed`;
 * - `units`: serial numbers are `captured` for it, or `none`.
 *
 * Orders written before the facts existed get them from their flags (`derivedFacts`: `stockHeld`, `returnRestocked`,
 * `promotions.released`, `pointsCredited`, `pointsReversed`, the lines' serials and the history's return reasons), the
 * same flags today's give-backs check, and keep them from their first transition on (an upgrade on use, no timer).
 * Pure functions, no I/O.
 * @module
 */

/** @typedef {import('./model.js').OrderRecord} OrderRecord */
/** @typedef {import('./model.js').StatusRole} StatusRole */

/**
 * @typedef {{ stock: 'held' | 'sold' | 'back' | 'none', offers: 'counted' | 'released', redeemed: 'spent' | 'given_back',
 *   earned: 'none' | 'credited' | 'reversed', units: 'none' | 'captured' }} OrderFacts
 */

/** The facts and their values, in the order they are written. */
export const FACT_VALUES = Object.freeze({
	stock: Object.freeze(['held', 'sold', 'back', 'none']),
	offers: Object.freeze(['counted', 'released']),
	redeemed: Object.freeze(['spent', 'given_back']),
	earned: Object.freeze(['none', 'credited', 'reversed']),
	units: Object.freeze(['none', 'captured']),
});

/** @type {ReadonlyArray<keyof OrderFacts>} */
export const FACT_KEYS = Object.freeze(/** @type {Array<keyof OrderFacts>} */ (Object.keys(FACT_VALUES)));

/** The facts of an order just placed: it holds its stock, counts its offer uses and spent its points. @type {Readonly<OrderFacts>} */
export const PLACED_FACTS = Object.freeze({
	stock: 'held',
	offers: 'counted',
	redeemed: 'spent',
	earned: 'none',
	units: 'none',
});

/**
 * What the facts are derived from: an order record, or one an import checked.
 * @typedef {{ role: StatusRole, stockHeld: boolean, lines: ReadonlyArray<{ serials?: string[] }>,
 *   promotions?: { released?: boolean, pointsCredited?: boolean } | null, deliveredAt?: Date | null,
 *   returnRestocked?: boolean, history?: ReadonlyArray<{ reason?: string }>, facts?: unknown }} FactSource
 */

/** Roles of an order that was delivered (or came back after delivery). */
const AFTER_DELIVERY = Object.freeze(/** @type {StatusRole[]} */ (['delivered', 'returned']));
/** Roles whose orders may hold earned points from before (an order whose flag was never written). */
const SETTLED = Object.freeze(/** @type {StatusRole[]} */ (['delivered', 'returned_to_origin', 'returned', 'refunded']));
/** Why a package came back (a move into a returned_to_origin or returned status keeps it in the history). */
const CAME_BACK = Object.freeze(['rto', 'customer_return']);

/**
 * Whether a value is a whole set of facts.
 * @param {unknown} value
 * @returns {value is OrderFacts}
 */
export const isFacts = (value) =>
	typeof value === 'object' &&
	value !== null &&
	FACT_KEYS.every((key) => /** @type {ReadonlyArray<string>} */ (FACT_VALUES[key]).includes(/** @type {any} */ (value)[key]));

/**
 * The facts of an order written before they existed, from the flags today's give-backs check: stock from `stockHeld`
 * (sold once delivered), `returnRestocked` and whether a package came back; offer uses released and redeemed points
 * given back by `promotions.released` (a return gives the points back but keeps the offers counted); earned points
 * credited by `pointsCredited` (an order that never wrote it counts as credited once settled, as the reversal reads
 * it), reversed when a return or a refund after delivery gave them back; serial numbers captured while its lines list
 * some and it still holds or sold its units.
 * @param {FactSource} order
 * @returns {OrderFacts}
 */
export const derivedFacts = (order) => {
	const { role } = order;
	const promotions = order.promotions ?? {};
	const released = promotions.released === true;
	const delivered = AFTER_DELIVERY.includes(role) || (role === 'refunded' && Boolean(order.deliveredAt));
	const cameBack =
		role === 'returned_to_origin' ||
		role === 'returned' ||
		(order.history ?? []).some((entry) => CAME_BACK.includes(String(entry.reason ?? '')));
	/** @type {OrderFacts['stock']} */
	const stock = order.stockHeld ? (delivered ? 'sold' : 'held') : order.returnRestocked === true || !cameBack ? 'back' : 'none';
	const credited = promotions.pointsCredited === true || (promotions.pointsCredited === undefined && SETTLED.includes(role));
	return {
		stock,
		offers: released && !cameBack && !delivered ? 'released' : 'counted',
		redeemed: released ? 'given_back' : 'spent',
		earned: !credited ? 'none' : released && (cameBack || (delivered && role !== 'delivered')) ? 'reversed' : 'credited',
		units:
			(stock === 'held' || stock === 'sold') && order.lines.some((line) => (line.serials ?? []).length > 0)
				? 'captured'
				: 'none',
	};
};

/**
 * An order's facts: as written, else derived from its flags.
 * @param {FactSource} order
 * @returns {OrderFacts}
 */
export const factsOf = (order) =>
	isFacts(order.facts)
		? {
				stock: order.facts.stock,
				offers: order.facts.offers,
				redeemed: order.facts.redeemed,
				earned: order.facts.earned,
				units: order.facts.units,
			}
		: derivedFacts(order);

/**
 * The part of a compare-and-set that the facts guard: each fact as read, or none written yet.
 * @param {{ facts?: unknown }} order as read
 * @returns {Record<string, unknown>}
 */
export const factsGuard = (order) =>
	isFacts(order.facts)
		? Object.fromEntries(FACT_KEYS.map((key) => [`facts.${key}`, /** @type {OrderFacts} */ (order.facts)[key]]))
		: { facts: { $exists: false } };
