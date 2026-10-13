/**
 * Deals (PLAN 0.8.8 Promotions: automatic deals; PLAN 0.8.10 E18): a percent or a fixed amount off, or free
 * delivery, within dates, weekdays and hours (the business time zone, judged on read) and a use limit, for the items
 * its scope and conditions cover:
 *
 * - **conditions**: list rules (products, categories, brands, grades or an attribute's values, `in` or `not_in`) and
 *   one level of groups, joined by `match` (`all` | `any`); besides them, always all of: the variant's price range,
 *   a minimum quantity per line, a cart total (the goods before offers; for checkout-level deals, after the item
 *   deals with `cartThresholdBase`) and the payment methods;
 * - **actions**: `percent` or `fixed` off each unit of the lines it covers (`target: 'items'`, the default), or off
 *   the covered lines together (`target: 'cart'`: a percent of their amount, or one fixed amount spread over them);
 *   `free_delivery` waives the delivery fee while it applies to a line of the cart.
 *
 * A line takes one deal: the largest saving, then the higher priority, then the smaller id — or the deal the shopper
 * picked among its eligible ones (`shopperChoice`); the `deals` settings choose the first deal instead, put one
 * checkout-level deal after the item deals and round once per order (`DealRules`, D4). Discounts round down to whole
 * units with Format's `wholeUnits` (E25). Also the checks of a deal the merchant writes (a banner key it already holds
 * stays valid whatever its folder, CA-5) and the views of a deal. No I/O.
 * @module
 */
import { exactPercentOf, percentOf, roundDown, roundHalfUp } from './money.js';
import {
	checkAmount,
	checkBoolean,
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
/** @typedef {import('./model.js').DealConditions} DealConditions */
/** @typedef {import('./promotions-rules.js').Checked} Checked */

/** Deal types. */
export const DEAL_TYPES = Object.freeze(/** @type {const} */ (['percent', 'fixed', 'free_delivery']));
/** Rule fields of conditions. */
const RULE_FIELDS = Object.freeze(/** @type {const} */ (['products', 'categories', 'brands', 'grades', 'attribute']));
/** Payment methods a condition may name. */
const METHODS = Object.freeze(['cod', 'online', 'bank_transfer', 'pickup']);
/** Most rules per list, groups, values per rule. */
const MAX_RULES = 20;
const MAX_GROUPS = 10;
const MAX_VALUES = 200;
/** A deal slug. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** HH:MM. */
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** A CSS colour (a name, `#rgb`, `#rrggbb`, `rgb(…)` …). */
const COLOUR = /^[#A-Za-z0-9(),.%\s-]{0,40}$/;

/**
 * What deals see of a cart line.
 * @typedef {object} DealLine
 * @property {string} productId
 * @property {string[]} categoryIds with their ancestors
 * @property {string | null} brandId
 * @property {string | null} [grade]
 * @property {Record<string, string[]>} [attributes] attribute id → values (the product's and the variant's)
 * @property {number} unitPrice
 * @property {number} [quantity]
 */

/**
 * What deals see of the cart: the goods before offers, the payment method and the business time.
 * @typedef {{ goods: number, paymentMethod: string | null, weekday: number, minutes: number }} DealCart
 */

/**
 * How deals choose, combine and round (the `deals` settings, D4): `rounding` — `per_unit_down` rounds each deal down
 * per unit (item deals) or per line (cart deals); `total_half_up` works each deal out on the line or cart amount and
 * rounds the order's deal discounts once, half up. `lineChoice` — a line takes the `best` saving (then the higher
 * priority, then the smaller id) or the `first` deal in the shoppers' order that saves something. `cartOffer` — how
 * checkout-level deals (`target: 'cart'` and free delivery) combine with item deals: `per_line_best` (each line takes
 * the best of its item and cart deals; the best free delivery is added), `one_after_items` (at most one checkout-level
 * deal, the first live one in the shoppers' order that applies, on what the item deals left) or `one_exclusive` (the
 * same, only when no item deal applied). `cartThresholdBase` — a checkout-level deal's cart total is judged on the
 * `goods` before offers or on the goods less what the lines' item deals take off (`after_item_deals`).
 * `pointsBlockedBy` — redeeming points is blocked by any applied deal that allows no points (`any_deal`) or only by
 * such a checkout-level deal (`cart_offer`).
 * @typedef {{ rounding: 'per_unit_down' | 'total_half_up', lineChoice: 'best' | 'first',
 *   cartOffer: 'per_line_best' | 'one_after_items' | 'one_exclusive', cartThresholdBase: 'goods' | 'after_item_deals',
 *   pointsBlockedBy: 'any_deal' | 'cart_offer' }} DealRules
 */

/** The values of each rule; the first is the default (today's arithmetic, E18 and E25). */
const RULE_VALUES = Object.freeze({
	rounding: Object.freeze(['per_unit_down', 'total_half_up']),
	lineChoice: Object.freeze(['best', 'first']),
	cartOffer: Object.freeze(['per_line_best', 'one_after_items', 'one_exclusive']),
	cartThresholdBase: Object.freeze(['goods', 'after_item_deals']),
	pointsBlockedBy: Object.freeze(['any_deal', 'cart_offer']),
});

/**
 * The rules of the `deals` settings; a missing or unknown value is the default.
 * @param {Record<string, unknown>} settings
 * @returns {DealRules}
 */
export const dealRulesOf = (settings) =>
	/** @type {DealRules} */ (
		Object.fromEntries(
			Object.entries(RULE_VALUES).map(([key, values]) => [
				key,
				values.includes(String(settings[key])) ? settings[key] : values[0],
			]),
		)
	);

/** The default rules. */
export const DEAL_RULES = Object.freeze(dealRulesOf({}));

/** No conditions. @type {DealConditions} */
export const NO_CONDITIONS = Object.freeze({
	match: /** @type {'all'} */ ('all'),
	rules: [],
	groups: [],
	priceRange: null,
	minQuantity: 0,
	cartTotal: 0,
	paymentMethods: [],
});

/**
 * Whether one rule holds for a line.
 * @param {DealConditions['rules'][number]} rule
 * @param {DealLine} line
 */
const ruleHolds = (rule, line) => {
	const values = rule.values;
	const hit =
		rule.field === 'products'
			? values.includes(line.productId)
			: rule.field === 'categories'
				? line.categoryIds.some((id) => values.includes(id))
				: rule.field === 'brands'
					? line.brandId !== null && values.includes(line.brandId)
					: rule.field === 'grades'
						? Boolean(line.grade) && values.includes(String(line.grade))
						: (line.attributes?.[rule.attributeId ?? ''] ?? []).some((value) => values.includes(value));
	return rule.op === 'not_in' ? !hit : hit;
};

/**
 * Whether a deal's conditions hold for a line of a cart (no conditions: always).
 * @param {DealConditions | null | undefined} conditions
 * @param {DealLine} line
 * @param {DealCart} cart
 */
export const conditionsHold = (conditions, line, cart) => {
	if (!conditions) return true;
	const parts = [
		...conditions.rules.map((rule) => ruleHolds(rule, line)),
		...conditions.groups.map((group) =>
			group.rules.length === 0
				? true
				: group.match === 'any'
					? group.rules.some((rule) => ruleHolds(rule, line))
					: group.rules.every((rule) => ruleHolds(rule, line)),
		),
	];
	if (parts.length > 0 && !(conditions.match === 'any' ? parts.some(Boolean) : parts.every(Boolean))) return false;
	const range = conditions.priceRange;
	if (range && ((range.min !== null && line.unitPrice < range.min) || (range.max !== null && line.unitPrice > range.max)))
		return false;
	if (conditions.minQuantity > 0 && (line.quantity ?? 1) < conditions.minQuantity) return false;
	if (conditions.cartTotal > 0 && cart.goods < conditions.cartTotal) return false;
	if (conditions.paymentMethods.length > 0 && !conditions.paymentMethods.includes(cart.paymentMethod ?? '')) return false;
	return true;
};

/**
 * Minutes since midnight of `HH:MM`.
 * @param {string} time
 */
const minutesOf = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/**
 * Whether a deal's weekdays and hours hold at the business time (E18; `timeTo` before `timeFrom` runs past midnight).
 * @param {Pick<DealRecord, 'days' | 'timeFrom' | 'timeTo'>} deal
 * @param {{ weekday: number, minutes: number }} at the business time zone's weekday (0 = Sunday) and minutes
 */
export const inWindow = (deal, { weekday, minutes }) => {
	const days = deal.days ?? [];
	const from = deal.timeFrom ? minutesOf(deal.timeFrom) : null;
	const to = deal.timeTo ? minutesOf(deal.timeTo) : null;
	if (from !== null && to !== null && to < from) {
		// past midnight: the evening part belongs to its own day, the morning part to the day before
		if (minutes >= from) return days.length === 0 || days.includes(weekday);
		if (minutes < to) return days.length === 0 || days.includes((weekday + 6) % 7);
		return false;
	}
	if (days.length > 0 && !days.includes(weekday)) return false;
	if (from !== null && minutes < from) return false;
	if (to !== null && minutes >= to) return false;
	return true;
};

/**
 * Whether a deal may apply now: switched on, within its dates, under its use limit and inside its weekdays and hours.
 * @param {DealRecord} deal
 * @param {number} now epoch ms
 * @param {{ weekday: number, minutes: number }} at the business time
 */
export const dealLive = (deal, now, at) => isLive(deal, now) && inWindow(deal, at);

/**
 * Whether a deal is checkout-level: off the cart (`target: 'cart'`) or free delivery (`cartOffer`, D4).
 * @param {Pick<DealRecord, 'type' | 'target'>} deal
 */
export const checkoutLevel = (deal) => (deal.target ?? 'items') === 'cart' || deal.type === 'free_delivery';

/**
 * Whether a deal covers a line (scope and conditions; not its dates).
 * @param {DealRecord} deal
 * @param {DealLine} line
 * @param {DealCart} cart
 */
export const dealCovers = (deal, line, cart) => inScope(line, deal.scope) && conditionsHold(deal.conditions, line, cart);

/**
 * The live deals that cover a product on a card or page (E18): its scope, and the conditions one of its active
 * variants meets on its own (the minimum quantity, cart total and payment methods are judged in the cart), in the
 * shoppers' order.
 * @param {import('./model.js').ProductRecord} product
 * @param {DealRecord[]} deals
 * @param {{ categoryIds: string[], now: number, clock: { weekday: number, minutes: number },
 *   attributes: (variant: import('./model.js').VariantRecord) => Record<string, string[]> }} context `categoryIds`: the
 *   product's categories with their ancestors
 * @returns {DealRecord[]}
 */
export const productDeals = (product, deals, { categoryIds, now, clock, attributes }) => {
	const variants = product.variants.filter((variant) => variant.active);
	const cart = { goods: 0, paymentMethod: null, ...clock };
	return deals
		.filter((deal) => {
			if (!dealLive(deal, now, clock)) return false;
			const conditions = deal.conditions ? { ...deal.conditions, minQuantity: 0, cartTotal: 0, paymentMethods: [] } : null;
			return variants.some((variant) => {
				const line = {
					productId: product.id,
					categoryIds,
					brandId: product.brandId,
					grade: variant.grade ?? null,
					attributes: attributes(variant),
					unitPrice: variant.price,
					quantity: 1,
				};
				return inScope(line, deal.scope) && conditionsHold(conditions, line, cart);
			});
		})
		.sort(byShowOrder);
};

/**
 * What a per-unit deal takes off one unit (never more than the unit's price), rounded down to whole units.
 * @param {DealRecord} deal
 * @param {number} unitPrice minor units
 * @param {number} [unit] whole units (E25)
 */
export const dealUnitDiscount = (deal, unitPrice, unit = 1) => {
	if (deal.type === 'free_delivery') return 0;
	const raw = deal.type === 'percent' ? percentOf(unitPrice, deal.value) : deal.value;
	return Math.max(0, Math.min(unitPrice, roundDown(raw, unit)));
};

/**
 * What a deal would take off a whole line: per unit for item deals; a percent of the line, or the line's share of the
 * fixed amount (`share`), for cart deals. Rounded down to whole units (`per_unit_down`), or exact (`total_half_up`:
 * the caller rounds the order's deal discounts once).
 * @param {DealRecord} deal
 * @param {{ unitPrice: number, quantity: number }} line
 * @param {{ unit?: number, share?: number, rounding?: DealRules['rounding'] }} [options] `share`: this line's part of a
 *   cart deal's fixed amount
 */
export const dealLineDiscount = (deal, line, { unit = 1, share = 0, rounding = 'per_unit_down' } = {}) => {
	if (deal.type === 'free_delivery') return 0;
	const amount = line.unitPrice * line.quantity;
	const exact = rounding === 'total_half_up';
	if ((deal.target ?? 'items') === 'cart') {
		const off = deal.type === 'percent' ? (exact ? exactPercentOf(amount, deal.value) : percentOf(amount, deal.value)) : share;
		return Math.max(0, Math.min(amount, exact ? off : roundDown(off, unit)));
	}
	if (exact)
		return Math.max(
			0,
			deal.type === 'percent' ? exactPercentOf(amount, deal.value) : Math.min(line.unitPrice, deal.value) * line.quantity,
		);
	return dealUnitDiscount(deal, line.unitPrice, unit) * line.quantity;
};

/**
 * The best live per-unit deal for a line (Chat and product quotes): the largest saving per unit, then the higher
 * priority, then the smaller id (`lineChoice: first`: the first in the shoppers' order). Cart deals and free delivery
 * are left out. With `total_half_up` one unit's saving rounds half up.
 * @param {DealLine} line
 * @param {DealRecord[]} deals
 * @param {number} now
 * @param {{ cart?: DealCart, unit?: number, rules?: DealRules }} [options] `cart`: the business time and cart facts
 *   (default: none and every time of day)
 * @returns {{ deal: DealRecord, perUnit: number } | null}
 */
export const bestDeal = (line, deals, now, { cart, unit = 1, rules = DEAL_RULES } = {}) => {
	const facts = cart ?? { goods: line.unitPrice * (line.quantity ?? 1), paymentMethod: null, weekday: -1, minutes: -1 };
	/** @type {{ deal: DealRecord, perUnit: number } | null} */
	let best = null;
	const first = rules.lineChoice === 'first';
	for (const deal of first ? [...deals].sort(byShowOrder) : deals) {
		if ((deal.target ?? 'items') !== 'items' || deal.type === 'free_delivery') continue;
		if (!isLive(deal, now) || (cart && !inWindow(deal, cart)) || !dealCovers(deal, line, facts)) continue;
		const perUnit =
			rules.rounding === 'total_half_up'
				? Math.min(
						line.unitPrice,
						roundHalfUp(
							dealLineDiscount(deal, { unitPrice: line.unitPrice, quantity: 1 }, { rounding: rules.rounding }),
							unit,
						),
					)
				: dealUnitDiscount(deal, line.unitPrice, unit);
		if (perUnit <= 0) continue;
		if (first ? best === null : better({ deal, saving: perUnit }, best ? { deal: best.deal, saving: best.perUnit } : null))
			best = { deal, perUnit };
	}
	return best;
};

/**
 * Whether a candidate beats the best so far: a larger saving, then the higher priority, then the smaller id.
 * @param {{ deal: DealRecord, saving: number }} candidate
 * @param {{ deal: DealRecord, saving: number } | null} best
 */
export const better = (candidate, best) =>
	!best ||
	candidate.saving > best.saving ||
	(candidate.saving === best.saving &&
		(candidate.deal.priority > best.deal.priority ||
			(candidate.deal.priority === best.deal.priority && candidate.deal.id < best.deal.id)));

// ----------------------------------------------------------------------------------------------- merchant input

/**
 * One rule of conditions.
 * @param {unknown} value
 * @param {string} field
 * @returns {Checked}
 */
const checkRule = (value, field) => {
	if (!isObject(value)) return fail(field, 'A rule is { field, op, values }.');
	if (!RULE_FIELDS.includes(value.field)) return fail(`${field}/field`, `field is one of ${RULE_FIELDS.join(', ')}.`);
	const op = value.op ?? 'in';
	if (op !== 'in' && op !== 'not_in') return fail(`${field}/op`, 'op is in or not_in.');
	const values = value.values;
	if (
		!Array.isArray(values) ||
		values.length === 0 ||
		values.length > MAX_VALUES ||
		!values.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 120)
	)
		return fail(`${field}/values`, `values lists 1–${MAX_VALUES} texts of at most 120 characters.`);
	if (value.field === 'attribute' && (typeof value.attributeId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.attributeId)))
		return fail(`${field}/attributeId`, 'An attribute rule names its attributeId.');
	return {
		ok: true,
		value: {
			field: value.field,
			op,
			values: [...new Set(/** @type {string[]} */ (values))],
			...(value.field === 'attribute' ? { attributeId: value.attributeId } : {}),
		},
	};
};

/**
 * A list of rules.
 * @param {unknown} value
 * @param {string} field
 * @returns {Checked}
 */
const checkRules = (value, field) => {
	if (value === undefined || value === null) return { ok: true, value: [] };
	if (!Array.isArray(value) || value.length > MAX_RULES) return fail(field, `${field} lists at most ${MAX_RULES} rules.`);
	/** @type {unknown[]} */
	const out = [];
	for (const [index, raw] of value.entries()) {
		const rule = checkRule(raw, `${field}/${index}`);
		if (!rule.ok) return rule;
		out.push(rule.value);
	}
	return { ok: true, value: out };
};

/**
 * A deal's conditions (E18), or null for none.
 * @param {unknown} value
 * @returns {Checked}
 */
export const checkConditions = (value) => {
	if (value === undefined || value === null) return { ok: true, value: null };
	if (!isObject(value)) return fail('conditions', 'conditions is an object.');
	const match = value.match ?? 'all';
	if (match !== 'all' && match !== 'any') return fail('conditions/match', 'match is all or any.');
	const rules = checkRules(value.rules, 'conditions/rules');
	if (!rules.ok) return rules;
	const groupsIn = value.groups ?? [];
	if (!Array.isArray(groupsIn) || groupsIn.length > MAX_GROUPS)
		return fail('conditions/groups', `groups lists at most ${MAX_GROUPS} groups.`);
	/** @type {unknown[]} */
	const groups = [];
	for (const [index, raw] of groupsIn.entries()) {
		if (!isObject(raw)) return fail(`conditions/groups/${index}`, 'A group is { match, rules }.');
		const groupMatch = raw.match ?? 'all';
		if (groupMatch !== 'all' && groupMatch !== 'any') return fail(`conditions/groups/${index}/match`, 'match is all or any.');
		const groupRules = checkRules(raw.rules, `conditions/groups/${index}/rules`);
		if (!groupRules.ok) return groupRules;
		groups.push({ match: groupMatch, rules: groupRules.value });
	}
	/** @type {{ min: number | null, max: number | null } | null} */
	let priceRange = null;
	if (value.priceRange !== undefined && value.priceRange !== null) {
		if (!isObject(value.priceRange)) return fail('conditions/priceRange', 'priceRange is { min, max }.');
		const min = checkWhole(value.priceRange.min, 'conditions/priceRange/min', {
			min: 0,
			max: 1_000_000_000_000,
			nullable: true,
			fallback: null,
		});
		if (!min.ok) return min;
		const max = checkWhole(value.priceRange.max, 'conditions/priceRange/max', {
			min: 0,
			max: 1_000_000_000_000,
			nullable: true,
			fallback: null,
		});
		if (!max.ok) return max;
		if (min.value !== null && max.value !== null && max.value < min.value)
			return fail('conditions/priceRange/max', 'max is at least min.');
		priceRange = min.value === null && max.value === null ? null : { min: min.value, max: max.value };
	}
	const minQuantity = checkWhole(value.minQuantity, 'conditions/minQuantity', { min: 0, max: 99, fallback: 0 });
	if (!minQuantity.ok) return minQuantity;
	const cartTotal = checkWhole(value.cartTotal, 'conditions/cartTotal', { min: 0, max: 1_000_000_000_000, fallback: 0 });
	if (!cartTotal.ok) return cartTotal;
	const methods = value.paymentMethods ?? [];
	if (!Array.isArray(methods) || !methods.every((method) => METHODS.includes(method)))
		return fail('conditions/paymentMethods', `paymentMethods lists some of ${METHODS.join(', ')}.`);
	return {
		ok: true,
		value: {
			match,
			rules: rules.value,
			groups,
			priceRange,
			minQuantity: minQuantity.value,
			cartTotal: cartTotal.value,
			paymentMethods: [...new Set(methods)],
		},
	};
};

/**
 * Which banner keys a deal may hold besides new uploads under `ecommerce/deals/`: the key it already holds whatever
 * its folder (CA-5), or any key without `..` when the deal is moved in by an import (Migration "Storage").
 * @typedef {{ held?: string | null, importing?: boolean }} BannerKeys
 */

/** Banner keys of any folder: at most 500 characters, no control characters. */
// eslint-disable-next-line no-control-regex
const ANY_KEY = /^[^\u0000-\u001f\u007f]{1,500}$/;

/**
 * A banner photo: an upload key with its alternative text, or null.
 * @param {unknown} value
 * @param {BannerKeys} [keys]
 * @returns {Checked}
 */
const checkBanner = (value, { held = null, importing = false } = {}) => {
	if (value === undefined || value === null) return { ok: true, value: null };
	const kept = isObject(value) && typeof value.key === 'string' && (importing || value.key === held);
	if (
		!isObject(value) ||
		typeof value.key !== 'string' ||
		!(kept ? ANY_KEY : /^ecommerce\/deals\/[A-Za-z0-9_./-]{1,300}$/).test(value.key)
	)
		return fail('banner', 'banner is { key, alt } of a photo uploaded for deals, or null.');
	if (value.key.includes('..')) return fail('banner', 'banner is { key, alt } of a photo uploaded for deals, or null.');
	const alt = checkText(value.alt, 'banner/alt', { min: 0, max: 200, fallback: '' });
	if (!alt.ok) return alt;
	return {
		ok: true,
		value: {
			key: value.key,
			type: typeof value.type === 'string' ? value.type.slice(0, 60) : '',
			size: Number.isSafeInteger(value.size) ? value.size : 0,
			alt: alt.value,
		},
	};
};

/**
 * The deal's weekdays (0 = Sunday … 6) and hours.
 * @param {Record<string, unknown>} input
 * @returns {Checked}
 */
const checkWindow = (input) => {
	const days = input.days ?? [];
	if (!Array.isArray(days) || days.length > 7 || !days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6))
		return fail('days', 'days lists weekdays from 0 (Sunday) to 6.');
	/** @type {Record<string, string>} */
	const times = {};
	for (const name of ['timeFrom', 'timeTo']) {
		const value = input[name] ?? '';
		if (typeof value !== 'string' || (value !== '' && !TIME.test(value)))
			return fail(name, `${name} is HH:MM (24 hours) or empty.`);
		times[name] = value;
	}
	if (times.timeFrom && times.timeTo && times.timeFrom === times.timeTo)
		return fail('timeTo', 'timeTo differs from timeFrom (leave both empty for all day).');
	return { ok: true, value: { days: [...new Set(/** @type {number[]} */ (days))].sort(), ...times } };
};

/**
 * The deal's display fields (E18).
 * @param {Record<string, any>} input
 * @param {BannerKeys} keys
 * @returns {Checked}
 */
const checkDisplay = (input, keys) => {
	const slug = input.slug ?? '';
	if (typeof slug !== 'string' || (slug !== '' && (!SLUG.test(slug) || slug.length > 80)))
		return fail('slug', 'slug is lowercase letters, digits and hyphens (at most 80), or empty.');
	const color = input.color ?? '';
	if (typeof color !== 'string' || !COLOUR.test(color)) return fail('color', 'color is a CSS colour of at most 40 characters.');
	const seoIn = input.seo ?? {};
	if (!isObject(seoIn)) return fail('seo', 'seo is { title, description }.');
	return gather([
		['badgeLabel', () => checkText(input.badgeLabel, 'badgeLabel', { min: 0, max: 40, fallback: '' })],
		['discountLabel', () => checkText(input.discountLabel, 'discountLabel', { min: 0, max: 80, fallback: '' })],
		['content', () => checkText(input.content, 'content', { min: 0, max: 5000, fallback: '' })],
		['sort', () => checkWhole(input.sort, 'sort', { min: -100_000, max: 100_000, fallback: 0 })],
		['banner', () => checkBanner(input.banner, keys)],
		[
			'seo',
			() =>
				gather([
					['title', () => checkText(seoIn.title, 'seo/title', { min: 0, max: 120, fallback: '' })],
					['description', () => checkText(seoIn.description, 'seo/description', { min: 0, max: 320, fallback: '' })],
				]),
		],
		['slug', () => ({ ok: true, value: slug })],
		['color', () => ({ ok: true, value: color.trim() })],
	]);
};

/**
 * A deal the merchant writes (create, or the merged record of an edit), or an import moves in.
 * @param {unknown} input
 * @param {BannerKeys} [keys] the banner key the deal already holds (an edit), or an import's
 * @returns {Checked}
 */
export const checkDealInput = (input, keys = {}) => {
	if (!isObject(input)) return fail('', 'Send a deal object.');
	if (!DEAL_TYPES.includes(input.type)) return fail('type', `type is one of ${DEAL_TYPES.join(', ')}.`);
	/** @type {'percent' | 'fixed' | 'free_delivery'} */
	const type = input.type;
	const target = input.target ?? 'items';
	if (target !== 'items' && target !== 'cart') return fail('target', 'target is items or cart.');
	const checked = gather([
		['name', () => checkText(input.name, 'name', { min: 1, max: 120 })],
		['description', () => checkText(input.description, 'description', { min: 0, max: 500, fallback: '' })],
		[
			'value',
			() =>
				type === 'free_delivery'
					? { ok: true, value: 0 }
					: type === 'percent'
						? checkPercent(input.value, 'value')
						: checkAmount(input.value, 'value'),
		],
		['priority', () => checkWhole(input.priority, 'priority', { min: -1000, max: 1000, fallback: 0 })],
		['conditions', () => checkConditions(input.conditions)],
		['allowPoints', () => checkBoolean(input.allowPoints, 'allowPoints', true)],
		['*', () => checkWindow(input)],
		['*', () => checkDisplay(input, keys)],
		...commonSteps(input),
	]);
	if (!checked.ok) return checked;
	return { ok: true, value: { type, target: type === 'free_delivery' ? 'items' : target, ...checked.value } };
};

/**
 * The display fields every deal view carries (E18), with defaults for deals written before them.
 * @param {DealRecord} deal
 */
const displayOf = (deal) => ({
	slug: deal.slug ?? '',
	badgeLabel: deal.badgeLabel ?? '',
	discountLabel: deal.discountLabel ?? '',
	color: deal.color ?? '',
	banner: deal.banner ?? null,
	content: deal.content ?? '',
	seo: deal.seo ?? { title: '', description: '' },
	sort: deal.sort ?? 0,
});

/**
 * A deal for the merchant.
 * @param {DealRecord & { createdAt?: Date, updatedAt?: Date }} deal
 */
export const dealView = (deal) => ({
	id: deal.id,
	name: deal.name,
	description: deal.description,
	type: deal.type,
	target: deal.target ?? 'items',
	value: deal.value,
	scope: deal.scope,
	conditions: deal.conditions ?? null,
	days: deal.days ?? [],
	timeFrom: deal.timeFrom ?? '',
	timeTo: deal.timeTo ?? '',
	allowPoints: deal.allowPoints !== false,
	...displayOf(deal),
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
 * @param {{ bannerUrl?: string | null }} [extras]
 */
export const publicDeal = (deal, { bannerUrl = null } = {}) => ({
	id: deal.id,
	name: deal.name,
	description: deal.description,
	type: deal.type,
	target: deal.target ?? 'items',
	value: deal.value,
	...displayOf(deal),
	banner: deal.banner ? { url: bannerUrl, alt: deal.banner.alt ?? '' } : null,
	minQuantity: deal.conditions?.minQuantity ?? 0,
	cartTotal: deal.conditions?.cartTotal ?? 0,
	paymentMethods: deal.conditions?.paymentMethods ?? [],
	days: deal.days ?? [],
	timeFrom: deal.timeFrom ?? '',
	timeTo: deal.timeTo ?? '',
	allowPoints: deal.allowPoints !== false,
	startsAt: isoOrNull(deal.startsAt),
	endsAt: isoOrNull(deal.endsAt),
	scope: {
		everything: coversAll(deal.scope),
		productIds: deal.scope.productIds,
		categoryIds: deal.scope.categoryIds,
		brandIds: deal.scope.brandIds,
	},
});

/**
 * Order deals for shoppers: their `sort`, then higher priority first, then the soonest ending, then by id.
 * @param {DealRecord} a @param {DealRecord} b
 */
export const byShowOrder = (a, b) => {
	const ea = a.endsAt === null ? Infinity : new Date(a.endsAt).getTime();
	const eb = b.endsAt === null ? Infinity : new Date(b.endsAt).getTime();
	return (a.sort ?? 0) - (b.sort ?? 0) || b.priority - a.priority || ea - eb || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
};
