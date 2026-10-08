/**
 * Bundles and buy X get Y (PLAN 0.8.8 Promotions), ported from the parked deals product's bundle engine:
 * - `bundle`: every listed product in its quantity is in the cart → the set costs `price` (never more than its value),
 *   or `value` percent off the set; applied as many times as there are complete sets, taking each product's most
 *   expensive units first (the largest saving);
 * - `buy_x_get_y`: for every `buy` units of `scope`, `get` units of `getScope` are `value` percent off (100 = free); the
 *   discounted units are the cheapest ones, so the shopper pays for the most valuable items.
 * A unit is used by one bundle once. A unit a bundle discounts takes no deal, so a set is formed only when it saves
 * more than the deals of the units it discounts would (the better offer per unit wins); sets are formed greedily, the
 * best saving first. Units are counted per line (never expanded), so large quantities stay cheap. No I/O.
 * @module
 */
import { allocate, percentOf } from './money.js';
import {
	checkAmount,
	checkPercent,
	checkText,
	checkWhole,
	commonSteps,
	checkScope,
	fail,
	gather,
	inScope,
	isLive,
	isObject,
	isoOrNull,
} from './promotions-rules.js';

/** @typedef {import('./model.js').BundleRecord} BundleRecord */
/** @typedef {import('./promotions-rules.js').Checked} Checked */

/** Bundle types. */
export const BUNDLE_TYPES = Object.freeze(/** @type {const} */ (['bundle', 'buy_x_get_y']));
/** Most sets formed for one cart (all bundles together). */
export const MAX_SETS = 1000;
/** Most products in one bundle. */
export const MAX_BUNDLE_ITEMS = 20;

/**
 * One cart line as bundles see it.
 * @typedef {object} Pool
 * @property {string} productId
 * @property {string[]} categoryIds
 * @property {string | null} brandId
 * @property {number} unitPrice
 * @property {number} available units not yet used by a bundle
 * @property {number} dealUnit what the line's best deal takes off one unit (0 = none)
 */

/** @typedef {{ index: number, units: number, discounted: boolean, amount: number }} Take */
/** @typedef {{ takes: Take[], discount: number, lost: number }} BundleSet */

/**
 * Take `count` units from candidate lines in the given order, minus what this set already took.
 * @param {Array<{ pool: Pool, index: number }>} candidates in order
 * @param {Map<number, number>} taken units this set already took per line
 * @param {number} count
 * @returns {Array<{ index: number, units: number }> | null} null when there are not enough units
 */
const takeUnits = (candidates, taken, count) => {
	/** @type {Array<{ index: number, units: number }>} */
	const out = [];
	let left = count;
	for (const { pool, index } of candidates) {
		if (left === 0) break;
		const free = pool.available - (taken.get(index) ?? 0);
		if (free <= 0) continue;
		const units = Math.min(free, left);
		out.push({ index, units });
		taken.set(index, (taken.get(index) ?? 0) + units);
		left -= units;
	}
	return left === 0 ? out : null;
};

/**
 * @param {Pool[]} pools
 * @param {(pool: Pool) => boolean} keep
 */
const candidatesOf = (pools, keep) =>
	pools.map((pool, index) => ({ pool, index })).filter(({ pool }) => pool.available > 0 && keep(pool));

/**
 * The next set a bundle forms from the units left, or null.
 * @param {BundleRecord} bundle
 * @param {Pool[]} pools
 * @returns {BundleSet | null}
 */
export const nextSet = (bundle, pools) => {
	/** @type {Map<number, number>} */
	const taken = new Map();
	/** @param {{ index: number, units: number }} take */
	const valueOf = (take) => take.units * /** @type {Pool} */ (pools[take.index]).unitPrice;
	if (bundle.type === 'bundle') {
		if (bundle.items.length === 0) return null;
		/** @type {Array<{ index: number, units: number }>} */
		const takes = [];
		for (const item of bundle.items) {
			const candidates = candidatesOf(pools, (pool) => pool.productId === item.productId).sort(
				(a, b) => b.pool.unitPrice - a.pool.unitPrice || a.index - b.index,
			);
			const got = takeUnits(candidates, taken, item.quantity);
			if (!got) return null;
			takes.push(...got);
		}
		const values = takes.map(valueOf);
		const value = values.reduce((sum, v) => sum + v, 0);
		const discount = bundle.price !== null ? Math.max(0, value - bundle.price) : percentOf(value, bundle.value);
		const amounts = allocate(discount, values);
		return {
			takes: takes.map((take, i) => ({ ...take, discounted: true, amount: amounts[i] ?? 0 })),
			discount,
			lost: takes.reduce((sum, take) => sum + take.units * /** @type {Pool} */ (pools[take.index]).dealUnit, 0),
		};
	}
	const buyCandidates = candidatesOf(pools, (pool) => inScope(pool, bundle.scope)).sort(
		(a, b) =>
			Number(inScope(a.pool, bundle.getScope)) - Number(inScope(b.pool, bundle.getScope)) ||
			b.pool.unitPrice - a.pool.unitPrice ||
			a.index - b.index,
	);
	const bought = takeUnits(buyCandidates, taken, bundle.buy);
	if (!bought) return null;
	const getCandidates = candidatesOf(pools, (pool) => inScope(pool, bundle.getScope)).sort(
		(a, b) => a.pool.unitPrice - b.pool.unitPrice || a.index - b.index,
	);
	const got = takeUnits(getCandidates, taken, bundle.get);
	if (!got) return null;
	const discounted = got.map((take) => ({ ...take, discounted: true, amount: percentOf(valueOf(take), bundle.value) }));
	return {
		takes: [...bought.map((take) => ({ ...take, discounted: false, amount: 0 })), ...discounted],
		discount: discounted.reduce((sum, take) => sum + take.amount, 0),
		lost: discounted.reduce((sum, take) => sum + take.units * /** @type {Pool} */ (pools[take.index]).dealUnit, 0),
	};
};

/**
 * Form the sets of the live bundles on a cart, the best net saving (bundle saving minus the deal savings it replaces)
 * first, while a set saves more than those deals.
 * @param {BundleRecord[]} bundles
 * @param {Array<Omit<Pool, 'available'> & { quantity: number }>} lines
 * @param {number} now
 * @returns {{ lines: Array<{ bundleDiscount: number, bundleUnits: number }>, savings: Map<string, number> }}
 *   per line: what bundles take off and how many of its units they discount; `savings`: bundle id → amount, in the order
 *   bundles first saved
 */
export const formBundles = (bundles, lines, now) => {
	const pools = lines.map(({ quantity, ...line }) => ({ ...line, available: quantity }));
	const out = lines.map(() => ({ bundleDiscount: 0, bundleUnits: 0 }));
	/** @type {Map<string, number>} */
	const savings = new Map();
	const live = bundles.filter((bundle) => isLive(bundle, now)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	for (let formed = 0; formed < MAX_SETS; formed += 1) {
		/** @type {{ bundle: BundleRecord, set: BundleSet } | null} */
		let best = null;
		for (const bundle of live) {
			const set = nextSet(bundle, pools);
			if (!set || set.discount - set.lost <= 0) continue;
			if (!best || set.discount - set.lost > best.set.discount - best.set.lost) best = { bundle, set };
		}
		if (!best) break;
		for (const take of best.set.takes) {
			const pool = /** @type {Pool} */ (pools[take.index]);
			const line = /** @type {{ bundleDiscount: number, bundleUnits: number }} */ (out[take.index]);
			pool.available -= take.units;
			line.bundleDiscount += take.amount;
			if (take.discounted) line.bundleUnits += take.units;
		}
		savings.set(best.bundle.id, (savings.get(best.bundle.id) ?? 0) + best.set.discount);
	}
	return { lines: out, savings };
};

// ----------------------------------------------------------------------------------------------- merchant input

/**
 * The products of a `bundle`.
 * @param {unknown} value
 * @returns {Checked}
 */
const checkItems = (value) => {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BUNDLE_ITEMS)
		return fail('items', `items is a list of 1 to ${MAX_BUNDLE_ITEMS} { productId, quantity }.`);
	/** @type {Array<{ productId: string, quantity: number }>} */
	const items = [];
	for (const [index, item] of value.entries()) {
		if (!isObject(item) || typeof item.productId !== 'string' || item.productId.length === 0 || item.productId.length > 64)
			return fail(`items/${index}/productId`, 'productId is a product id.');
		const quantity = checkWhole(item.quantity, `items/${index}/quantity`, { min: 1, max: 100, fallback: 1 });
		if (!quantity.ok) return quantity;
		if (items.some((other) => other.productId === item.productId))
			return fail(`items/${index}/productId`, 'Each product is listed once (use its quantity).');
		items.push({ productId: item.productId, quantity: quantity.value });
	}
	return { ok: true, value: items };
};

const EMPTY_SCOPE = Object.freeze({ productIds: [], categoryIds: [], brandIds: [] });

/**
 * A bundle the merchant writes (create, or the merged record of an edit). Fields the type does not use are stored
 * empty (`items` [], `price` null, `buy`/`get` 0, scopes empty).
 * @param {unknown} input
 * @returns {Checked}
 */
export const checkBundleInput = (input) => {
	if (!isObject(input)) return fail('', 'Send a bundle object.');
	if (!BUNDLE_TYPES.includes(input.type)) return fail('type', `type is one of ${BUNDLE_TYPES.join(', ')}.`);
	/** @type {'bundle' | 'buy_x_get_y'} */
	const type = input.type;
	/** @type {Array<[string, () => Checked]>} */
	const specific =
		type === 'bundle'
			? [
					['items', () => checkItems(input.items)],
					[
						'price',
						() =>
							input.price === null || input.price === undefined
								? { ok: true, value: null }
								: checkAmount(input.price, 'price'),
					],
					[
						'value',
						() =>
							input.price === null || input.price === undefined
								? checkPercent(input.value, 'value')
								: { ok: true, value: 0 },
					],
				]
			: [
					['buy', () => checkWhole(input.buy, 'buy', { min: 1, max: 100 })],
					['get', () => checkWhole(input.get, 'get', { min: 1, max: 100 })],
					['getScope', () => checkScope(input.getScope, 'getScope')],
					['value', () => (input.value === undefined ? { ok: true, value: 100 } : checkPercent(input.value, 'value'))],
				];
	const checked = gather([
		['name', () => checkText(input.name, 'name', { min: 1, max: 120 })],
		...specific,
		...commonSteps(input),
	]);
	if (!checked.ok) return checked;
	const value = checked.value;
	return {
		ok: true,
		value:
			type === 'bundle'
				? { type, buy: 0, get: 0, getScope: { ...EMPTY_SCOPE }, ...value, scope: { ...EMPTY_SCOPE } }
				: { type, items: [], price: null, ...value },
	};
};

/**
 * A bundle for the merchant.
 * @param {BundleRecord & { createdAt?: Date, updatedAt?: Date }} bundle
 */
export const bundleView = (bundle) => ({
	id: bundle.id,
	name: bundle.name,
	type: bundle.type,
	items: bundle.items,
	price: bundle.price,
	buy: bundle.buy,
	get: bundle.get,
	scope: bundle.scope,
	getScope: bundle.getScope,
	value: bundle.value,
	startsAt: isoOrNull(bundle.startsAt),
	endsAt: isoOrNull(bundle.endsAt),
	limit: bundle.limit,
	used: bundle.used,
	active: bundle.active,
	createdAt: isoOrNull(bundle.createdAt),
	updatedAt: isoOrNull(bundle.updatedAt),
});
