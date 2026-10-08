/**
 * What every offer shares (coupons, deals and bundles): whether it is live now (switched on, within its dates, under
 * its use limit), which cart lines its scope covers, and the checks of the fields every offer has (scope, dates, use
 * limit) when the merchant's staff or server write one. No I/O.
 * @module
 */
import { MAX_AMOUNT } from './money.js';

/** @typedef {import('./model.js').OfferScope} OfferScope */

/** Most ids in one scope list. */
export const MAX_SCOPE_IDS = 200;
/** The largest use limit. */
export const MAX_LIMIT = 1_000_000_000;

/** @param {Date | string | number | null | undefined} value */
const timeOf = (value) => (value === null || value === undefined ? null : new Date(value).getTime());

/**
 * Whether an offer has started and not ended at `now` (`startsAt` inclusive, `endsAt` exclusive).
 * @param {{ startsAt: Date | null, endsAt: Date | null }} offer
 * @param {number} now epoch ms
 * @returns {'live' | 'not_started' | 'ended'}
 */
export const phaseOf = (offer, now) => {
	const starts = timeOf(offer.startsAt);
	const ends = timeOf(offer.endsAt);
	if (starts !== null && now < starts) return 'not_started';
	if (ends !== null && now >= ends) return 'ended';
	return 'live';
};

/**
 * Whether an offer may apply now: switched on, within its dates and under its use limit.
 * @param {{ active: boolean, startsAt: Date | null, endsAt: Date | null, limit: number | null, used: number }} offer
 * @param {number} now
 */
export const isLive = (offer, now) =>
	offer.active === true && phaseOf(offer, now) === 'live' && (offer.limit === null || offer.used < offer.limit);

/**
 * Whether a scope covers everything (all three lists empty).
 * @param {OfferScope} scope
 */
export const coversAll = (scope) =>
	scope.productIds.length === 0 && scope.categoryIds.length === 0 && scope.brandIds.length === 0;

/**
 * Whether a cart line is in a scope: everything when the scope is empty, else the product, one of its categories (with
 * their ancestors) or its brand is listed.
 * @param {{ productId: string, categoryIds: string[], brandId: string | null }} line
 * @param {OfferScope} scope
 */
export const inScope = (line, scope) =>
	coversAll(scope) ||
	scope.productIds.includes(line.productId) ||
	line.categoryIds.some((id) => scope.categoryIds.includes(id)) ||
	(line.brandId !== null && scope.brandIds.includes(line.brandId));

// ----------------------------------------------------------------------------------------------- input checks

/** @typedef {{ ok: true, value: any } | { ok: false, field: string, message: string }} Checked */

/**
 * @param {string} field @param {string} message
 * @returns {{ ok: false, field: string, message: string }}
 */
export const fail = (field, message) => ({ ok: false, field, message });

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
export const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A scope from input (missing lists are empty).
 * @param {unknown} value
 * @param {string} field
 * @returns {Checked}
 */
export const checkScope = (value, field) => {
	if (value === undefined || value === null) return { ok: true, value: { productIds: [], categoryIds: [], brandIds: [] } };
	if (!isObject(value)) return fail(field, `${field} is an object with productIds, categoryIds and brandIds.`);
	/** @type {Record<string, string[]>} */
	const out = {};
	for (const key of ['productIds', 'categoryIds', 'brandIds']) {
		const list = value[key] ?? [];
		if (
			!Array.isArray(list) ||
			list.length > MAX_SCOPE_IDS ||
			!list.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 64)
		)
			return fail(`${field}/${key}`, `${key} is a list of at most ${MAX_SCOPE_IDS} ids.`);
		out[key] = [...new Set(/** @type {string[]} */ (list))];
	}
	return { ok: true, value: out };
};

/**
 * A date from input: an ISO-8601 text or null.
 * @param {unknown} value
 * @param {string} field
 * @returns {Checked}
 */
export const checkDate = (value, field) => {
	if (value === undefined || value === null || value === '') return { ok: true, value: null };
	if (typeof value !== 'string' && !(value instanceof Date)) return fail(field, `${field} is an ISO-8601 date or null.`);
	const time = new Date(value).getTime();
	if (!Number.isFinite(time)) return fail(field, `${field} is an ISO-8601 date or null.`);
	return { ok: true, value: new Date(time) };
};

/**
 * `startsAt` and `endsAt` from input; the end must come after the start.
 * @param {Record<string, unknown>} input
 * @returns {Checked}
 */
export const checkDates = (input) => {
	const starts = checkDate(input.startsAt, 'startsAt');
	if (!starts.ok) return starts;
	const ends = checkDate(input.endsAt, 'endsAt');
	if (!ends.ok) return ends;
	if (starts.value && ends.value && ends.value.getTime() <= starts.value.getTime())
		return fail('endsAt', 'endsAt must be after startsAt.');
	return { ok: true, value: { startsAt: starts.value, endsAt: ends.value } };
};

/**
 * A whole number in a range, or null when `nullable`.
 * @param {unknown} value
 * @param {string} field
 * @param {{ min: number, max: number, nullable?: boolean, fallback?: number | null }} bounds
 * @returns {Checked}
 */
export const checkWhole = (value, field, { min, max, nullable = false, fallback }) => {
	if (value === undefined && fallback !== undefined) return { ok: true, value: fallback };
	if (value === null && nullable) return { ok: true, value: null };
	if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
		return fail(field, `${field} is a whole number from ${min} to ${max}${nullable ? ' or null' : ''}.`);
	return { ok: true, value };
};

/**
 * A percentage above 0 and at most 100 (decimals allowed).
 * @param {unknown} value
 * @param {string} field
 * @returns {Checked}
 */
export const checkPercent = (value, field) =>
	typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100
		? { ok: true, value }
		: fail(field, `${field} is a percentage above 0 and at most 100.`);

/**
 * An amount in minor units from 1.
 * @param {unknown} value
 * @param {string} field
 */
export const checkAmount = (value, field) => checkWhole(value, field, { min: 1, max: MAX_AMOUNT });

/**
 * A plain text.
 * @param {unknown} value
 * @param {string} field
 * @param {{ min: number, max: number, fallback?: string }} bounds
 * @returns {Checked}
 */
export const checkText = (value, field, { min, max, fallback }) => {
	if (value === undefined && fallback !== undefined) return { ok: true, value: fallback };
	if (typeof value !== 'string') return fail(field, `${field} is a text.`);
	const text = value.trim();
	if (text.length < min || text.length > max) return fail(field, `${field} is ${min} to ${max} characters.`);
	return { ok: true, value: text };
};

/**
 * A boolean.
 * @param {unknown} value
 * @param {string} field
 * @param {boolean} fallback
 * @returns {Checked}
 */
export const checkBoolean = (value, field, fallback) => {
	if (value === undefined) return { ok: true, value: fallback };
	return typeof value === 'boolean' ? { ok: true, value } : fail(field, `${field} is true or false.`);
};

/**
 * Run checks in order and gather their values; the first failure wins.
 * @param {Array<[string, () => Checked]>} steps field name → check
 * @returns {Checked}
 */
export const gather = (steps) => {
	/** @type {Record<string, any>} */
	const out = {};
	for (const [name, check] of steps) {
		const checked = check();
		if (!checked.ok) return checked;
		if (name === '*') Object.assign(out, checked.value);
		else out[name] = checked.value;
	}
	return { ok: true, value: out };
};

/**
 * The fields every offer shares: scope, dates, use limit, switched on.
 * @param {Record<string, unknown>} input
 * @returns {Array<[string, () => Checked]>}
 */
export const commonSteps = (input) => [
	['scope', () => checkScope(input.scope, 'scope')],
	['*', () => checkDates(input)],
	['limit', () => checkWhole(input.limit, 'limit', { min: 1, max: MAX_LIMIT, nullable: true, fallback: null })],
	['active', () => checkBoolean(input.active, 'active', true)],
];

/**
 * Dates of an offer for the wire (ISO-8601 UTC or null).
 * @param {Date | string | null | undefined} value
 */
export const isoOrNull = (value) => (value === null || value === undefined ? null : new Date(value).toISOString());
