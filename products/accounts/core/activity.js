/**
 * Activity-log copies (PLAN 0.4.11, 0.8.10 K9), pure: the filters of `GET /v1/activity-copies` and its counts, the
 * same as every product's `GET /v1/activity` (`actor`, `action`, `target`, `q`, `from`, `to`) plus `productId`, and the
 * label and detail of Accounts' own entries (never addresses, secrets or message contents).
 *
 * - `actor`: an actor id; `action`: one action or several separated by commas; `target`: a target id.
 * - `q`: case-insensitive text in the label, the detail, the actor's name or the target.
 * - `from` / `to`: an ISO-8601 time, or a day (`YYYY-MM-DD`) in the business time zone (`to` includes that day).
 * @module
 */
import { zonedDayStart } from '@ss/contracts';

const PRODUCT_ID = /^[a-z][a-z0-9-]{1,30}$/;
const ACTION = /^[a-z][a-z0-9_.]{0,63}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ID = 256;
const MAX_ACTIONS = 20;
const MAX_QUERY = 100;
/** Longest label and detail of an entry (the activity-copy shape). */
export const MAX_LABEL = 200;
export const MAX_DETAIL = 2000;

/** @param {string} text */
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A time bound: an ISO-8601 instant, or a day in the business time zone (`end`: the start of the next day).
 * @param {unknown} value
 * @param {string} timeZone
 * @param {boolean} end
 * @returns {Date | null | undefined} undefined when absent, null when invalid
 */
const boundOf = (value, timeZone, end) => {
	if (value === undefined || value === '') return undefined;
	const text = String(value);
	if (DAY.test(text)) {
		const start = zonedDayStart(text, timeZone);
		if (Number.isNaN(start)) return null;
		if (!end) return new Date(start);
		const next = new Date(Date.parse(`${text}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
		return new Date(zonedDayStart(next, timeZone));
	}
	const at = Date.parse(text);
	return Number.isNaN(at) || !/^\d{4}-\d{2}-\d{2}T/.test(text) ? null : new Date(at);
};

/** @param {unknown} value */
const given = (value) => typeof value === 'string' && value !== '';

/**
 * The database filter of the copies list and its counts (without the website, which the store adds).
 * @param {Record<string, unknown>} query the request's query
 * @param {string} timeZone the business.json time zone (days are business days, PLAN 0.8.10 K8)
 * @returns {{ ok: true, filter: Record<string, unknown> } | { ok: false, field: string, message: string }}
 */
export const copyFilter = (query, timeZone) => {
	/** @type {Record<string, unknown>} */
	const filter = {};
	const { productId, actor, action, target, q, from, to } = query;
	if (given(productId)) {
		if (!PRODUCT_ID.test(String(productId))) return { ok: false, field: 'productId', message: 'productId is a product id.' };
		filter.productId = productId;
	}
	if (given(actor)) {
		if (String(actor).length > MAX_ID) return { ok: false, field: 'actor', message: 'actor is an actor id.' };
		filter['actor.id'] = actor;
	}
	if (given(action)) {
		const actions = String(action)
			.split(',')
			.map((one) => one.trim());
		if (actions.length > MAX_ACTIONS || actions.some((one) => !ACTION.test(one)))
			return { ok: false, field: 'action', message: 'action is one action, or several separated by commas.' };
		filter.action = actions.length === 1 ? actions[0] : { $in: actions };
	}
	if (given(target)) {
		if (String(target).length > MAX_ID) return { ok: false, field: 'target', message: 'target is a target id.' };
		filter.target = target;
	}
	if (typeof q === 'string' && q.trim() !== '') {
		const pattern = { $regex: escapeRegex(q.trim().slice(0, MAX_QUERY)), $options: 'i' };
		filter.$or = [{ label: pattern }, { detail: pattern }, { 'actor.name': pattern }, { target: pattern }];
	}
	const start = boundOf(from, timeZone, false);
	const end = boundOf(to, timeZone, true);
	if (start === null) return { ok: false, field: 'from', message: 'from is an ISO-8601 time or a day (YYYY-MM-DD).' };
	if (end === null) return { ok: false, field: 'to', message: 'to is an ISO-8601 time or a day (YYYY-MM-DD).' };
	if (start || end) filter.at = { ...(start ? { $gte: start } : {}), ...(end ? { $lt: end } : {}) };
	return { ok: true, filter };
};

/**
 * The plain-text detail of an entry, cut to its longest length; undefined when empty.
 * @param {ReadonlyArray<string | null | undefined | false>} parts joined with '; '
 * @returns {string | undefined}
 */
export const detailOf = (parts) => {
	const text = parts.filter((part) => typeof part === 'string' && part.trim() !== '').join('; ');
	return text === '' ? undefined : text.slice(0, MAX_DETAIL);
};

/**
 * The label of an entry (a user's name, a role's name …), cut to its longest length; undefined when empty.
 * @param {unknown} value
 * @returns {string | undefined}
 */
export const labelOf = (value) =>
	typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, MAX_LABEL) : undefined;
