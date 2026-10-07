/**
 * Bundles (pure): which units of a cart form bundle instances and what each instance saves.
 *
 * - `buy_together` — every component (`{ scope, quantity }`) must be present; an instance takes `quantity` units for
 *   each component, from the matching lines' most expensive remaining units (largest saving for the customer). A unit is
 *   never used twice, within an instance or across instances and bundles.
 * - `mix_and_match` — any `quantity` units from the scope form an instance ("any 3 for 20.00"), most expensive first.
 * - Pricing per instance: `percent` of the instance value, `amount_off` the instance, or `fixed_price` (the instance
 *   costs `amount`; never more than its value). `maxPerOrder` caps the instances.
 * Units are handled as counts per line (no expansion), so carts with large quantities stay cheap.
 * @module
 */
import { percentOf, roundAmount } from './money.js';

/** @typedef {{ lineId: string, unitPrice: number, available: number }} Pool one line's remaining units */
/** @typedef {{ lineId: string, units: number, value: number }} Take */
/** @typedef {{ takes: Take[], value: number }} Instance */

/**
 * Take `count` units from pools (most expensive first). Returns null when not enough units remain.
 * @param {Pool[]} pools mutable working copies
 * @param {number} count
 * @returns {Take[] | null}
 */
const take = (pools, count) => {
	const ordered = [...pools]
		.filter((p) => p.available > 0)
		.sort((a, b) => b.unitPrice - a.unitPrice || a.lineId.localeCompare(b.lineId));
	if (ordered.reduce((sum, p) => sum + p.available, 0) < count) return null;
	/** @type {Take[]} */
	const takes = [];
	let left = count;
	for (const pool of ordered) {
		if (left === 0) break;
		const units = Math.min(left, pool.available);
		pool.available -= units;
		left -= units;
		takes.push({ lineId: pool.lineId, units, value: units * pool.unitPrice });
	}
	return takes;
};

/**
 * Instances a bundle forms. `poolsFor(scope)` returns fresh pools (each matching line's remaining units) on every call;
 * units taken for one component are removed from every component's pools.
 * @param {Record<string, any>} bundle
 * @param {(scope: any) => Pool[]} poolsFor
 * @param {number} maxInstances
 * @returns {Instance[]}
 */
export const formInstances = (bundle, poolsFor, maxInstances) => {
	/** @type {Instance[]} */
	const instances = [];
	const cap = Math.min(maxInstances, Number.isSafeInteger(bundle.maxPerOrder) ? bundle.maxPerOrder : maxInstances);
	if (bundle.type === 'mix_and_match') {
		const pools = poolsFor(bundle.scope);
		while (instances.length < cap) {
			const takes = take(pools, bundle.quantity);
			if (!takes) break;
			instances.push({ takes, value: takes.reduce((sum, t) => sum + t.value, 0) });
		}
		return instances;
	}
	const components = /** @type {Array<{ scope: any, quantity: number }>} */ (bundle.components ?? []);
	const pools = components.map((component) => poolsFor(component.scope));
	while (instances.length < cap) {
		/** @type {Take[]} */
		const takes = [];
		// try on copies so a partial instance does not consume units
		const trial = pools.map((list) => list.map((p) => ({ ...p })));
		let complete = true;
		for (const [index, component] of components.entries()) {
			// units already taken by earlier components of this instance are unavailable to later ones
			const own = /** @type {Pool[]} */ (trial[index]);
			for (const p of own) {
				const usedHere = takes.filter((t) => t.lineId === p.lineId).reduce((sum, t) => sum + t.units, 0);
				p.available = Math.max(0, p.available - usedHere);
			}
			const got = take(own, component.quantity);
			if (!got) {
				complete = false;
				break;
			}
			takes.push(...got);
		}
		if (!complete) break;
		// commit: remove the taken units from every component's pools (lines can match several components)
		for (const list of pools)
			for (const p of list) {
				const used = takes.filter((t) => t.lineId === p.lineId).reduce((sum, t) => sum + t.units, 0);
				p.available = Math.max(0, p.available - used);
			}
		instances.push({ takes, value: takes.reduce((sum, t) => sum + t.value, 0) });
	}
	return instances;
};

/**
 * Saving of one instance.
 * @param {Record<string, any>} action
 * @param {number} value instance value (minor units, may be fractional)
 * @param {import('./money.js').Rounding} rounding
 */
export const instanceDiscount = (action, value, rounding) => {
	if (action.type === 'percent') return Math.min(roundAmount(percentOf(value, action.percent), rounding), Math.floor(value));
	if (action.type === 'amount_off') return Math.min(action.amount, Math.floor(value));
	if (action.type === 'fixed_price') return Math.max(0, roundAmount(value - action.amount, rounding));
	return 0;
};
