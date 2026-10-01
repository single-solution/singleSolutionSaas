/**
 * Price deltas (pure, integer money): the unit price of a configuration in integer minor units of its currency.
 *
 *   base            the combination's price, else `pricing.base`, else 0
 *   + options       `priceDelta` of every chosen option
 *   + units         `unitPrice` × value of every range group
 *   + amount rules  `pricing.rules[].amount` whose rules@1 `when` holds (per combination, quantity, anything)
 *   = subtotal
 *   + percent rules `percent` basis points of the subtotal (all on the same subtotal, rounded half away from zero)
 *   → clamped at 0, rounded (none / nearest / up / down to `increment`, then the optional `ending`), × quantity.
 *
 * All arithmetic is BigInt and the results must stay within safe integers; nothing is a float.
 * @module
 */
import { holds } from './rules.js';

/** @typedef {import('./compile.js').Compiled} Compiled */
/** @typedef {import('./schema.js').Rounding} Rounding */
/**
 * @typedef {object} Price
 * @property {string | null} currency
 * @property {number} quantity
 * @property {number} base
 * @property {Array<{ kind: 'option' | 'unit' | 'rule' | 'percent', group?: string, option?: string, rule?: string, amount: number }>} deltas
 * @property {number} subtotal before rounding
 * @property {number} unit unit price after rounding
 * @property {number} total unit × quantity
 * @property {Rounding} rounding
 */

export const NO_ROUNDING = Object.freeze({ mode: /** @type {const} */ ('none'), increment: 1, ending: 0 });
const MAX = BigInt(Number.MAX_SAFE_INTEGER);

/** @param {bigint} a @param {bigint} b b > 0: a / b rounded half away from zero */
const divRound = (a, b) => {
	const q = a / b;
	const r = a % b;
	if (r === 0n) return q;
	const twice = (r < 0n ? -r : r) * 2n;
	return twice >= b ? q + (a < 0n ? -1n : 1n) : q;
};

/**
 * Round a non-negative amount.
 * @param {bigint} value
 * @param {Rounding} rounding
 * @returns {bigint}
 */
const roundAmount = (value, rounding) => {
	if (rounding.mode === 'none') return value;
	const increment = BigInt(Math.max(1, rounding.increment));
	const down = (value / increment) * increment;
	const rest = value - down;
	/** @type {bigint} */
	let rounded = down;
	if (rounding.mode === 'up' && rest > 0n) rounded = down + increment;
	if (rounding.mode === 'nearest' && rest * 2n >= increment) rounded = down + increment;
	if (rounding.ending > 0 && rounding.ending < rounding.increment) rounded = rounded - increment + BigInt(rounding.ending);
	return rounded < 0n ? 0n : rounded;
};

/**
 * Round an amount of minor units (exported for previews in the dashboard).
 * @param {number} value integer ≥ 0
 * @param {Rounding} rounding
 */
export const roundPrice = (value, rounding) => Number(roundAmount(BigInt(Math.max(0, Math.trunc(value))), rounding));

/**
 * @param {Compiled} compiled
 * @param {{ selection: Record<string, unknown>, combination: { id: string } | null, quantity?: number }} input
 *   a resolution (or a checked selection): public values and the combination
 * @param {{ rounding?: Rounding | null, currency?: string | null, now?: number, timeZone?: string }} [options]
 *   `rounding`: the element default (the configurator's own wins); `currency`: fallback (item / website)
 * @returns {{ ok: true, price: Price | null } | { ok: false, code: 'price_out_of_range' }}
 */
export const priceOf = (compiled, input, options = {}) => {
	const quantity =
		Number.isSafeInteger(input.quantity) && /** @type {number} */ (input.quantity) > 0
			? /** @type {number} */ (input.quantity)
			: 1;
	const wanted = input.combination?.id;
	const combination = wanted === undefined ? null : (compiled.combinations?.find((c) => c.id === wanted) ?? null);
	const pricing = compiled.pricing;
	/** @type {Price['deltas']} */
	const deltas = [];
	for (const group of compiled.groups) {
		const value = input.selection[group.key];
		if (group.type === 'single' || group.type === 'multi') {
			for (const key of Array.isArray(value) ? value : typeof value === 'string' ? [value] : []) {
				const option = group.optionByKey.get(key);
				if (option && option.priceDelta !== 0)
					deltas.push({ kind: 'option', group: group.key, option: key, amount: option.priceDelta });
			}
		} else if (group.type === 'range' && typeof value === 'number' && group.unitPrice !== null && group.unitPrice !== 0) {
			deltas.push({ kind: 'unit', group: group.key, amount: group.unitPrice * value });
		}
	}
	const hasBase = (combination !== null && combination.price !== null) || (pricing !== null && pricing.base !== null);
	if (!hasBase && deltas.length === 0 && (pricing === null || pricing.rules.length === 0)) return { ok: true, price: null };

	const context = {
		selection: Object.fromEntries(compiled.groups.map((group) => [group.key, input.selection[group.key] ?? null])),
		quantity,
	};
	const evalOptions = { now: options.now ?? 0, timeZone: options.timeZone ?? 'UTC' };
	const applies = (/** @type {import('./rules.js').Condition | null} */ when) =>
		when === null || holds(when, context, evalOptions);
	const base = BigInt(combination?.price ?? pricing?.base ?? 0);
	for (const rule of pricing?.rules ?? [])
		if (rule.amount !== 0 && applies(rule.when)) deltas.push({ kind: 'rule', rule: rule.id, amount: rule.amount });
	const subtotal = deltas.reduce((sum, delta) => sum + BigInt(delta.amount), base);
	/** @type {Price['deltas']} */
	const percents = [];
	for (const rule of pricing?.rules ?? [])
		if (rule.percent !== 0 && applies(rule.when))
			percents.push({ kind: 'percent', rule: rule.id, amount: Number(divRound(subtotal * BigInt(rule.percent), 10_000n)) });
	const adjusted = percents.reduce((sum, delta) => sum + BigInt(delta.amount), subtotal);
	const rounding = pricing?.rounding ?? options.rounding ?? NO_ROUNDING;
	const unit = roundAmount(adjusted < 0n ? 0n : adjusted, rounding);
	const total = unit * BigInt(quantity);
	const values = [base, subtotal, adjusted, unit, total, ...deltas.map((d) => BigInt(d.amount))];
	if (values.some((value) => value > MAX || value < -MAX)) return { ok: false, code: 'price_out_of_range' };
	return {
		ok: true,
		price: {
			currency: pricing?.currency ?? options.currency ?? null,
			quantity,
			base: Number(base),
			deltas: [...deltas, ...percents],
			subtotal: Number(adjusted),
			unit: Number(unit),
			total: Number(total),
			rounding: { mode: rounding.mode, increment: rounding.increment, ending: rounding.ending },
		},
	};
};
