/**
 * Deals (PLAN 0.8.8 Promotions: automatic deals): a percent or a fixed amount off each unit of the items in scope,
 * within dates and a use limit. A line takes the single best deal (the largest saving per unit, then the higher
 * priority) — deals never stack on one another (one offer per line). Also the checks of a deal the merchant writes and the views of a deal. No I/O.
 * @module
 */
import { percentOf } from './money.js';
import {
	checkAmount,
	checkPercent,
	checkText,
	checkWhole,
	commonSteps,
	coversAll,
	fail,
	gather,
	inScope,
	isLive,
	isObject,
	isoOrNull,
} from './promotions-rules.js';

/** @typedef {import('./model.js').DealRecord} DealRecord */
/** @typedef {import('./promotions-rules.js').Checked} Checked */

/** Deal types. */
const DEAL_TYPES = Object.freeze(/** @type {const} */ (['percent', 'fixed']));

/**
 * What a deal takes off one unit (never more than the unit's price).
 * @param {DealRecord} deal
 * @param {number} unitPrice minor units
 */
export const dealUnitDiscount = (deal, unitPrice) =>
	Math.max(0, Math.min(unitPrice, deal.type === 'percent' ? percentOf(unitPrice, deal.value) : deal.value));

/**
 * The best live deal for a line: the largest saving per unit, then the higher priority, then the smaller id.
 * @param {{ productId: string, categoryIds: string[], brandId: string | null, unitPrice: number }} line
 * @param {DealRecord[]} deals
 * @param {number} now
 * @returns {{ deal: DealRecord, perUnit: number } | null}
 */
export const bestDeal = (line, deals, now) => {
	/** @type {{ deal: DealRecord, perUnit: number } | null} */
	let best = null;
	for (const deal of deals) {
		if (!isLive(deal, now) || !inScope(line, deal.scope)) continue;
		const perUnit = dealUnitDiscount(deal, line.unitPrice);
		if (perUnit <= 0) continue;
		if (
			!best ||
			perUnit > best.perUnit ||
			(perUnit === best.perUnit &&
				(deal.priority > best.deal.priority || (deal.priority === best.deal.priority && deal.id < best.deal.id)))
		)
			best = { deal, perUnit };
	}
	return best;
};

// ----------------------------------------------------------------------------------------------- merchant input

/**
 * A deal the merchant writes (create, or the merged record of an edit).
 * @param {unknown} input
 * @returns {Checked}
 */
export const checkDealInput = (input) => {
	if (!isObject(input)) return fail('', 'Send a deal object.');
	if (!DEAL_TYPES.includes(input.type)) return fail('type', `type is one of ${DEAL_TYPES.join(', ')}.`);
	/** @type {'percent' | 'fixed'} */
	const type = input.type;
	const checked = gather([
		['name', () => checkText(input.name, 'name', { min: 1, max: 120 })],
		['description', () => checkText(input.description, 'description', { min: 0, max: 500, fallback: '' })],
		['value', () => (type === 'percent' ? checkPercent(input.value, 'value') : checkAmount(input.value, 'value'))],
		['priority', () => checkWhole(input.priority, 'priority', { min: -1000, max: 1000, fallback: 0 })],
		...commonSteps(input),
	]);
	if (!checked.ok) return checked;
	return { ok: true, value: { type, ...checked.value } };
};

/**
 * A deal for the merchant.
 * @param {DealRecord & { createdAt?: Date, updatedAt?: Date }} deal
 */
export const dealView = (deal) => ({
	id: deal.id,
	name: deal.name,
	description: deal.description,
	type: deal.type,
	value: deal.value,
	scope: deal.scope,
	startsAt: isoOrNull(deal.startsAt),
	endsAt: isoOrNull(deal.endsAt),
	limit: deal.limit,
	used: deal.used,
	priority: deal.priority,
	active: deal.active,
	createdAt: isoOrNull(deal.createdAt),
	updatedAt: isoOrNull(deal.updatedAt),
});

/**
 * A deal for shoppers (and the Chat lookups): no use counts. `scope.everything` is true when it covers every product.
 * @param {DealRecord} deal
 */
export const publicDeal = (deal) => ({
	id: deal.id,
	name: deal.name,
	description: deal.description,
	type: deal.type,
	value: deal.value,
	endsAt: isoOrNull(deal.endsAt),
	scope: {
		everything: coversAll(deal.scope),
		productIds: deal.scope.productIds,
		categoryIds: deal.scope.categoryIds,
		brandIds: deal.scope.brandIds,
	},
});

/**
 * Order deals for shoppers: higher priority first, then the soonest ending, then by id.
 * @param {DealRecord} a @param {DealRecord} b
 */
export const byShowOrder = (a, b) => {
	const ea = a.endsAt === null ? Infinity : new Date(a.endsAt).getTime();
	const eb = b.endsAt === null ? Infinity : new Date(b.endsAt).getTime();
	return b.priority - a.priority || ea - eb || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
};
