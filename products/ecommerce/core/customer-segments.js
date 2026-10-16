/**
 * Customer and order tags and saved customer segments (E11). Tags are the merchant's own words on customers and orders
 * (trimmed, each once, at most {@link TAG_LIMITS}). Saved segments are the merchant's `customer_segments` list: each a
 * key, a name and rules over a customer's tags, orders, spend, last order, place (city, region, country), guest,
 * blocked and loyalty flags and customer fields, matched all together or any of them. The list starts as the three
 * segments customers always had (loyalty, active, guest); the loyalty rule is the member flag while the loyalty
 * setting `memberFlag` is on (E47), else who holds points. A segment's filter is a MongoDB filter on the customers
 * collection; rules that need other collections (loyalty points, spend) take what the caller read first
 * ({@link segmentNeeds}). No I/O.
 * @module
 */
import { escapeRegex } from './search.js';
import { DAY_MS } from './durations.js';

/** At most this many tags on one customer or order, each at most this long. */
export const TAG_LIMITS = Object.freeze({ tags: 30, tag: 40 });
/** At most this many saved segments, rules in one, and characters in a name. */
const MAX_SEGMENTS = 30;
const MAX_RULES = 10;
const MAX_NAME = 60;
/** Longest text a rule compares. */
const MAX_TEXT = 80;
/** A segment key. */
const KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/;
/** A customer field's id in a rule (`field:<id>`). */
const FIELD_RULE = /^field:[A-Za-z0-9_-]{1,64}$/;

/**
 * The fields a rule reads, by kind: `number` (orders placed, spend in minor units of the shop's currency), `days` (the
 * last order within or not within some days), `text` (a tag, a place), `flag` (true or false). A customer field is
 * `field:<id>` (kind `value`).
 */
export const SEGMENT_FIELDS = Object.freeze(
	/** @type {const} */ ({
		tag: 'text',
		orders: 'number',
		spent: 'number',
		last_order: 'days',
		city: 'text',
		region: 'text',
		country: 'text',
		guest: 'flag',
		blocked: 'flag',
		loyalty: 'flag',
	}),
);

/** The operators of each kind of field. */
const OPS = Object.freeze({
	text: ['is', 'is_not'],
	number: ['gte', 'lte'],
	days: ['within', 'not_within'],
	flag: ['is'],
	value: ['is', 'is_not', 'set', 'not_set'],
});

/**
 * @typedef {{ field: string, op: string, value: string | number | boolean | null }} SegmentRule
 * @typedef {{ key: string, name: string, match: 'all' | 'any', rules: SegmentRule[] }} Segment
 */

/** The segments a website starts with: the three the customer list always had. @type {ReadonlyArray<Segment>} */
export const DEFAULT_SEGMENTS = Object.freeze([
	{ key: 'loyalty', name: 'Loyalty members', match: 'all', rules: [{ field: 'loyalty', op: 'is', value: true }] },
	{ key: 'active', name: 'Active customers', match: 'all', rules: [{ field: 'orders', op: 'gte', value: 1 }] },
	{ key: 'guest', name: 'Guests', match: 'all', rules: [{ field: 'guest', op: 'is', value: true }] },
]);

/** @param {string} text */
const hasControl = (text) => [...text].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

/**
 * Check a list of tags: trimmed, each once (the first spelling kept), at most {@link TAG_LIMITS}.
 * @param {unknown} value
 * @returns {{ ok: true, value: string[] } | { ok: false, message: string }}
 */
export const checkTags = (value) => {
	const message = `Give at most ${TAG_LIMITS.tags} tags of 1 to ${TAG_LIMITS.tag} characters.`;
	if (!Array.isArray(value)) return { ok: false, message };
	/** @type {string[]} */
	const out = [];
	for (const raw of value) {
		const tag = typeof raw === 'string' ? raw.trim() : '';
		if (!tag || tag.length > TAG_LIMITS.tag || hasControl(tag)) return { ok: false, message };
		if (!out.includes(tag)) out.push(tag);
	}
	return out.length > TAG_LIMITS.tags ? { ok: false, message } : { ok: true, value: out };
};

/**
 * The kind of a rule's field (null: no such field).
 * @param {string} field
 * @returns {keyof typeof OPS | null}
 */
const kindOf = (field) =>
	Object.hasOwn(SEGMENT_FIELDS, field)
		? SEGMENT_FIELDS[/** @type {keyof typeof SEGMENT_FIELDS} */ (field)]
		: FIELD_RULE.test(field)
			? 'value'
			: null;

/**
 * Check one rule.
 * @param {unknown} raw
 * @returns {{ ok: true, rule: SegmentRule } | { ok: false, message: string }}
 */
const checkRule = (raw) => {
	const row = typeof raw === 'object' && raw !== null ? /** @type {Record<string, unknown>} */ (raw) : {};
	const field = typeof row.field === 'string' ? row.field : '';
	const kind = kindOf(field);
	if (!kind) return { ok: false, message: `there is no field ${field.slice(0, 40) || '(none)'}` };
	const op = typeof row.op === 'string' ? row.op : '';
	/** @type {readonly string[]} */
	const ops = OPS[kind];
	if (!ops.includes(op)) return { ok: false, message: `${field} takes ${ops.join(', ')}` };
	const value = row.value;
	if (kind === 'number' || kind === 'days') {
		const top = kind === 'days' ? 3650 : 1e12;
		if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 0 || /** @type {number} */ (value) > top)
			return { ok: false, message: `${field} is a whole number from 0 to ${top}` };
		return { ok: true, rule: { field, op, value: /** @type {number} */ (value) } };
	}
	if (kind === 'flag') {
		if (typeof value !== 'boolean') return { ok: false, message: `${field} is true or false` };
		return { ok: true, rule: { field, op, value } };
	}
	if (kind === 'value' && (op === 'set' || op === 'not_set')) return { ok: true, rule: { field, op, value: null } };
	if (kind === 'value' && (typeof value === 'number' || typeof value === 'boolean'))
		return Number.isFinite(value) || typeof value === 'boolean'
			? { ok: true, rule: { field, op, value } }
			: { ok: false, message: `${field} takes a value` };
	const text = typeof value === 'string' ? value.trim() : '';
	if (!text || text.length > MAX_TEXT || hasControl(text))
		return { ok: false, message: `${field} takes a text of 1 to ${MAX_TEXT} characters` };
	return { ok: true, rule: { field, op, value: field === 'country' ? text.toUpperCase() : text } };
};

/**
 * Check the `customer_segments` list the merchant saves.
 * @param {unknown} value
 * @returns {{ ok: true, value: Segment[] } | { ok: false, errors: string[] }}
 */
export const checkSegments = (value) => {
	if (!Array.isArray(value)) return { ok: false, errors: ['Segments are a list.'] };
	/** @type {string[]} */
	const errors = [];
	if (value.length > MAX_SEGMENTS) errors.push(`At most ${MAX_SEGMENTS} segments.`);
	/** @type {Segment[]} */
	const out = [];
	for (const [index, raw] of value.entries()) {
		const row = typeof raw === 'object' && raw !== null ? /** @type {Record<string, unknown>} */ (raw) : {};
		const at = `Segment ${index + 1}`;
		const key = typeof row.key === 'string' ? row.key.trim() : '';
		const name = typeof row.name === 'string' ? row.name.trim() : '';
		const match = row.match === undefined ? 'all' : row.match;
		if (!KEY.test(key)) errors.push(`${at}: the key is 1–40 lowercase letters, digits, - or _.`);
		else if (out.some((other) => other.key === key)) errors.push(`${at}: the key ${key} is used twice.`);
		if (!name || name.length > MAX_NAME || hasControl(name)) errors.push(`${at}: the name has 1 to ${MAX_NAME} characters.`);
		if (match !== 'all' && match !== 'any') errors.push(`${at}: match is all or any.`);
		const rules = Array.isArray(row.rules) ? row.rules : null;
		if (!rules || rules.length === 0 || rules.length > MAX_RULES) errors.push(`${at}: give 1 to ${MAX_RULES} rules.`);
		/** @type {SegmentRule[]} */
		const checked = [];
		for (const [ruleIndex, rule] of (rules ?? []).entries()) {
			const one = checkRule(rule);
			if (one.ok) checked.push(one.rule);
			else errors.push(`${at}, rule ${ruleIndex + 1}: ${one.message}.`);
		}
		out.push({ key, name, match: match === 'any' ? 'any' : 'all', rules: checked });
	}
	return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out };
};

/**
 * What a segment's rules need read from other collections first: the loyalty owners (a `loyalty` rule) and, for each
 * spend rule, the customers past its amount (`gte`: spent at least `value`; `lte`: spent more than `value`, left out).
 * @param {Segment} segment
 * @returns {{ loyalty: boolean, spent: Array<{ index: number, op: string, value: number }> }}
 */
export const segmentNeeds = (segment) => ({
	loyalty: segment.rules.some((rule) => rule.field === 'loyalty'),
	spent: segment.rules.flatMap((rule, index) =>
		rule.field === 'spent' ? [{ index, op: rule.op, value: Number(rule.value) }] : [],
	),
});

/**
 * @typedef {{ userIds: string[], customerIds: string[] }} Owners customers by Accounts user id or customer id
 * @typedef {{ now: number, loyalty?: 'flag' | Owners, spent?: ReadonlyMap<number, Owners> }} SegmentContext `loyalty`:
 *   'flag' while the member flag is on, else who holds points; `spent`: per spend rule (by its index), the customers
 *   {@link segmentNeeds} names
 */

/** @param {Owners | undefined} owners */
const ownedBy = (owners) => [{ userId: { $in: owners?.userIds ?? [] } }, { id: { $in: owners?.customerIds ?? [] } }];

/**
 * The filter of one rule.
 * @param {SegmentRule} rule @param {number} index @param {SegmentContext} context
 * @returns {Record<string, unknown>}
 */
const ruleFilter = (rule, index, context) => {
	const { field, op, value } = rule;
	const is = op === 'is';
	/** @param {string} path */
	const sameText = (path) => {
		const match = { $regex: `^${escapeRegex(String(value))}$`, $options: 'i' };
		return is ? { [path]: match } : { [path]: { $not: match } };
	};
	switch (field) {
		case 'tag':
			return is ? { tags: value } : { tags: { $ne: value } };
		case 'orders':
			return { orderCount: op === 'gte' ? { $gte: value } : { $lte: value } };
		case 'spent': {
			const owners = context.spent?.get(index);
			return op === 'gte' ? { $or: ownedBy(owners) } : { $nor: ownedBy(owners) };
		}
		case 'last_order': {
			const since = new Date(context.now - Number(value) * DAY_MS);
			return op === 'within' ? { lastOrderAt: { $gte: since } } : { $nor: [{ lastOrderAt: { $gte: since } }] };
		}
		case 'city':
			return is
				? { $or: [sameText('city'), sameText('addresses.city')] }
				: { $and: [sameText('city'), sameText('addresses.city')] };
		case 'region':
		case 'country':
			return sameText(`addresses.${field}`);
		case 'guest':
			return value ? { guest: true } : { guest: { $ne: true } };
		case 'blocked':
			return value ? { blocked: true } : { blocked: { $ne: true } };
		case 'loyalty': {
			const members = context.loyalty === 'flag' ? { loyaltyMember: true } : { $or: ownedBy(context.loyalty) };
			return value ? members : { $nor: [members] };
		}
		default: {
			const path = `fields.${field.slice('field:'.length)}`;
			if (op === 'set') return { [path]: { $exists: true } };
			if (op === 'not_set') return { [path]: { $exists: false } };
			return is ? { [path]: value } : { [path]: { $ne: value } };
		}
	}
};

/**
 * The customers filter of a saved segment (the caller adds `websiteId`).
 * @param {Segment} segment
 * @param {SegmentContext} context
 * @returns {Record<string, unknown>}
 */
export const segmentFilter = (segment, context) => {
	const each = segment.rules.map((rule, index) => ruleFilter(rule, index, context));
	return segment.match === 'any' ? { $or: each } : { $and: each };
};
