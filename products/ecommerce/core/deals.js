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
 *   `free_delivery` waives the delivery fee while it applies to a line of the cart. A line of an item sold by length,
 *   weight or volume is one piece (`core/measure.js` `piecesOf`: minimum quantities, rounding): a percent comes off
 *   what it comes to, a fixed amount off each of its units (worked out for its measured quantity).
 *
 * A line takes one deal: the largest saving, then the higher priority, then the smaller id — or the deal the shopper
 * picked among its eligible ones (`shopperChoice`); the `deals` settings choose the first deal instead, put one
 * checkout-level deal after the item deals and round once per order (`DealRules`, D4). Discounts round down to whole
 * units with Format's `wholeUnits` (E25). Also the checks of a deal the merchant writes (an edit takes a new banner
 * only from the deal's own folder; a banner key it already holds stays valid whatever its folder, CA-5) and the views
 * of a deal. No I/O.
 * @module
 */
import { isObject } from './json.js';
import { publicPhoto } from './catalog-content.js';
import { MAX_QUANTITY, lineGross, perMeasure, piecesOf } from './measure.js';
import { DEAL_TYPES } from './model.js';
import { exactPercentOf, percentOf, roundDown, roundHalfUp } from './money.js';
import { isMethodKey } from './payment-methods.js';
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
	isoOrNull,
} from './promotions-rules.js';

/** @typedef {import('./model.js').DealRecord} DealRecord */
/** @typedef {import('./model.js').DealConditions} DealConditions */
/** @typedef {import('./promotions-rules.js').Checked} Checked */

/** Deal types. */
/** Rule fields of conditions. */
const RULE_FIELDS = Object.freeze(/** @type {const} */ (['products', 'categories', 'brands', 'grades', 'attribute']));
/** A condition names at most this many payment methods (the website's `payment_methods` keys). */
const MAX_METHODS = 20;
/** Most rules per list, groups, values per rule. */
const MAX_RULES = 20;
const MAX_GROUPS = 10;
const MAX_VALUES = 200;
/** A deal slug. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** HH:MM. */
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** A CSS color (a name, `#rgb`, `#rrggbb`, `rgb(…)` …). */
const COLOR = /^[#A-Za-z0-9(),.%\s-]{0,40}$/;

/**
 * What deals see of a cart line.
 * @typedef {object} DealLine
 * @property {string} productId
 * @property {string[]} categoryIds with their ancestors
 * @property {string | null} brandId
 * @property {string | null} [grade]
 * @property {Record<string, string[]>} [attributes] attribute id → values (the product's and the variant's)
 * @property {number} unitPrice per piece, or per unit of a measured item
 * @property {number} [quantity] pieces, or thousandths of the unit of a measured item
 * @property {unknown} [measure] set for an item sold in a unit of its own (`core/measure.js`)
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
	if (conditions.minQuantity > 0 && piecesOf({ quantity: line.quantity ?? 1, measure: line.measure }) < conditions.minQuantity)
		return false;
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
	const days = deal.days;
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
 * The UTC weekday and minutes of an instant (the business time when none is given).
 * @param {number} now epoch ms
 */
export const utcClock = (now) => {
	const at = new Date(now);
	return { weekday: at.getUTCDay(), minutes: at.getUTCHours() * 60 + at.getUTCMinutes() };
};

/**
 * Whether a deal holds all day on every day of its dates (no weekdays or hours of its own): its price can be given with
 * its dates to search engines and shopping catalogs (G4).
 * @param {Pick<DealRecord, 'days' | 'timeFrom' | 'timeTo'>} deal
 */
export const holdsAllDay = (deal) => deal.days.length === 0 && !deal.timeFrom && !deal.timeTo;

/**
 * Whether a deal is checkout-level: off the cart (`target: 'cart'`) or free delivery (`cartOffer`, D4).
 * @param {Pick<DealRecord, 'type' | 'target'>} deal
 */
export const checkoutLevel = (deal) => deal.target === 'cart' || deal.type === 'free_delivery';

/**
 * Whether a deal covers a line (scope and conditions; not its dates).
 * @param {DealRecord} deal
 * @param {DealLine} line
 * @param {DealCart} cart
 */
export const dealCovers = (deal, line, cart) => inScope(line, deal.scope) && conditionsHold(deal.conditions, line, cart);

/**
 * Whether a deal is live for a line now: the one check behind every shop read that shows a deal (deal lists, `?deal=`
 * listings, cards, product quotes, Chat) and the cart (K-15, PR-6, SF-4) — switched on, within its dates, under its use
 * limit, inside its weekdays and hours at the business time (`cart.weekday`, `cart.minutes`), and covering the line by
 * scope and conditions on the cart's facts.
 * @param {DealRecord} deal
 * @param {DealLine} line
 * @param {DealCart} cart
 * @param {number} now epoch ms
 */
const dealLiveFor = (deal, line, cart, now) => dealLive(deal, now, cart) && dealCovers(deal, line, cart);

/**
 * A deal's conditions as a card judges them (E18): the minimum quantity, cart total and payment methods are left to
 * the cart.
 * @param {DealRecord} deal
 * @returns {DealRecord}
 */
const cardDeal = (deal) =>
	deal.conditions ? { ...deal, conditions: { ...deal.conditions, minQuantity: 0, cartTotal: 0, paymentMethods: [] } } : deal;

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
	const cart = { goods: 0, paymentMethod: null, weekday: clock.weekday, minutes: clock.minutes };
	const lines = product.variants
		.filter((variant) => variant.active)
		.map((variant) => ({
			productId: product.id,
			categoryIds,
			brandId: product.brandId,
			grade: variant.grade ?? null,
			attributes: attributes(variant),
			unitPrice: variant.price,
			quantity: 1,
		}));
	return deals.filter((deal) => lines.some((line) => dealLiveFor(cardDeal(deal), line, cart, now))).sort(byShowOrder);
};

/** An attribute id a field path may name. */
const FIELD_ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * One rule of conditions as a MongoDB expression over a product and one of its variants (`$$v`).
 * @param {DealConditions['rules'][number]} rule
 * @param {(categoryId: string) => string[]} withDescendants a category with the categories under it
 */
const ruleExpr = (rule, withDescendants) => {
	const values = rule.values;
	/** @param {unknown} list an expression giving an array @returns {Record<string, unknown>} */
	const meets = (list) => ({ $gt: [{ $size: { $setIntersection: [list, values] } }, 0] });
	const id = rule.attributeId ?? '';
	const raw = { $ifNull: [`$$v.attributes.${id}`, `$specs.${id}`] };
	/** @type {unknown} */
	const hit =
		rule.field === 'products'
			? { $in: ['$id', values] }
			: rule.field === 'categories'
				? {
						$gt: [
							{
								$size: {
									$setIntersection: [{ $ifNull: ['$categoryIds', []] }, [...new Set(values.flatMap(withDescendants))]],
								},
							},
							0,
						],
					}
				: rule.field === 'brands'
					? { $in: [{ $ifNull: ['$brandId', null] }, values] }
					: rule.field === 'grades'
						? { $in: [{ $ifNull: ['$$v.grade', null] }, values.filter((value) => value !== '')] }
						: FIELD_ID.test(id)
							? meets({ $map: { input: { $cond: [{ $isArray: raw }, raw, [raw]] }, in: { $toString: '$$this' } } })
							: false;
	return rule.op === 'not_in' ? { $not: [hit] } : hit;
};

/**
 * The products a card shows a deal on, as a MongoDB filter (`?deal=` listings, SF-4): an active variant the deal's
 * conditions hold for as `productDeals` judges them (the cart-only ones left to the cart). The deal's scope and whether
 * it is live are the caller's.
 * @param {DealConditions | null | undefined} conditions
 * @param {(categoryId: string) => string[]} withDescendants a category with the categories under it (a line's
 *   categories include their ancestors)
 * @returns {Record<string, unknown>}
 */
export const dealProductsFilter = (conditions, withDescendants) => {
	/** @param {DealConditions['rules']} rules */
	const each = (rules) => rules.map((rule) => ruleExpr(rule, withDescendants));
	const parts = conditions
		? [
				...each(conditions.rules),
				...conditions.groups.map((group) =>
					group.rules.length === 0 ? true : { [group.match === 'any' ? '$or' : '$and']: each(group.rules) },
				),
			]
		: [];
	/** @type {unknown[]} */
	const holds = [{ $eq: ['$$v.active', true] }];
	if (parts.length > 0) holds.push(conditions?.match === 'any' ? { $or: parts } : { $and: parts });
	const range = conditions?.priceRange;
	if (range?.min !== null && range?.min !== undefined) holds.push({ $gte: ['$$v.price', range.min] });
	if (range?.max !== null && range?.max !== undefined) holds.push({ $lte: ['$$v.price', range.max] });
	return {
		$expr: { $anyElementTrue: [{ $map: { input: { $ifNull: ['$variants', []] }, as: 'v', in: { $and: holds } } }] },
	};
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
 * the caller rounds the order's deal discounts once). A measured line (`measure`, its quantity in thousandths of its
 * unit) is one piece: a percent of what it comes to, or the fixed amount for each of its units, rounded once.
 * @param {DealRecord} deal
 * @param {{ unitPrice: number, quantity: number, measure?: unknown }} line
 * @param {{ unit?: number, share?: number, rounding?: DealRules['rounding'] }} [options] `share`: this line's part of a
 *   cart deal's fixed amount
 */
export const dealLineDiscount = (deal, line, { unit = 1, share = 0, rounding = 'per_unit_down' } = {}) => {
	if (deal.type === 'free_delivery') return 0;
	const measured = Boolean(line.measure);
	// pieces as they are (a leftover amount may have a fraction with `total_half_up`), a measured line's `lineGross`
	const amount = measured ? lineGross(line.unitPrice, line.quantity, true, unit) : line.unitPrice * line.quantity;
	const exact = rounding === 'total_half_up';
	if (deal.target === 'cart') {
		const off = deal.type === 'percent' ? (exact ? exactPercentOf(amount, deal.value) : percentOf(amount, deal.value)) : share;
		return Math.max(0, Math.min(amount, exact ? off : roundDown(off, unit)));
	}
	if (measured) {
		if (deal.type === 'percent') return exact ? exactPercentOf(amount, deal.value) : dealUnitDiscount(deal, amount, unit);
		const off = exact
			? (Math.max(0, deal.value) * line.quantity) / 1000
			: roundDown(perMeasure(deal.value, line.quantity), unit);
		return Math.max(0, Math.min(amount, off));
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
 * are left out. With `total_half_up` one unit's saving rounds half up. Each deal is judged by `dealLiveFor`, its
 * weekdays and hours included.
 * @param {DealLine} line
 * @param {DealRecord[]} deals
 * @param {number} now
 * @param {{ cart?: DealCart, unit?: number, rules?: DealRules }} [options] `cart`: the business time and cart facts
 *   (default: the line alone, no payment method, the UTC time of `now`)
 * @returns {{ deal: DealRecord, perUnit: number } | null}
 */
export const bestDeal = (line, deals, now, { cart, unit = 1, rules = DEAL_RULES } = {}) => {
	const facts = cart ?? { goods: line.unitPrice * (line.quantity ?? 1), paymentMethod: null, ...utcClock(now) };
	/** @type {{ deal: DealRecord, perUnit: number } | null} */
	let best = null;
	const first = rules.lineChoice === 'first';
	for (const deal of first ? [...deals].sort(byShowOrder) : deals) {
		if (deal.target !== 'items' || deal.type === 'free_delivery') continue;
		if (!dealLiveFor(deal, line, facts, now)) continue;
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
const checkConditions = (value) => {
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
	const minQuantity = checkWhole(value.minQuantity, 'conditions/minQuantity', { min: 0, max: MAX_QUANTITY, fallback: 0 });
	if (!minQuantity.ok) return minQuantity;
	const cartTotal = checkWhole(value.cartTotal, 'conditions/cartTotal', { min: 0, max: 1_000_000_000_000, fallback: 0 });
	if (!cartTotal.ok) return cartTotal;
	const methods = value.paymentMethods ?? [];
	if (!Array.isArray(methods) || methods.length > MAX_METHODS || !methods.every(isMethodKey))
		return fail('conditions/paymentMethods', `paymentMethods lists at most ${MAX_METHODS} payment method keys.`);
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
 * Which banner keys a deal may hold besides new uploads: `folder` is where those must be (an edit: the deal's own
 * folder `ecommerce/deals/<id>/`, as its banner upload gives; else anywhere under `ecommerce/deals/`); the key it
 * already holds stays valid whatever its folder (CA-5), and an import moves in any key without `..` (Migration
 * "Storage").
 * @typedef {{ held?: string | null, folder?: string | null, importing?: boolean }} BannerKeys
 */

/** Banner keys of any folder: at most 500 characters, no control characters. */
// eslint-disable-next-line no-control-regex
const ANY_KEY = /^[^\u0000-\u001f\u007f]{1,500}$/;

/** New uploads for deals: under `ecommerce/deals/`, plain path characters only. */
const UPLOAD_KEY = /^ecommerce\/deals\/[A-Za-z0-9_./-]{1,300}$/;

/**
 * A banner photo: an upload key with its alternative text, or null.
 * @param {unknown} value
 * @param {BannerKeys} [keys]
 * @returns {Checked}
 */
const checkBanner = (value, { held = null, folder = null, importing = false } = {}) => {
	if (value === undefined || value === null) return { ok: true, value: null };
	const refused = fail('banner', `banner is { key, alt } of a photo uploaded for ${folder ? 'this deal' : 'deals'}, or null.`);
	if (!isObject(value) || typeof value.key !== 'string') return refused;
	const key = value.key;
	const kept = importing || key === held;
	const fresh = UPLOAD_KEY.test(key) && (!folder || (key.startsWith(folder) && key.length > folder.length));
	if (!(kept ? ANY_KEY.test(key) : fresh) || key.includes('..') || !publicPhoto(key, value.type)) return refused;
	const alt = checkText(value.alt, 'banner/alt', { min: 0, max: 200, fallback: '' });
	if (!alt.ok) return alt;
	return {
		ok: true,
		value: {
			key,
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
	if (typeof color !== 'string' || !COLOR.test(color)) return fail('color', 'color is a CSS color of at most 40 characters.');
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
 * The display fields every deal view carries (E18).
 * @param {DealRecord} deal
 */
const displayOf = (deal) => ({
	slug: deal.slug,
	badgeLabel: deal.badgeLabel,
	discountLabel: deal.discountLabel,
	color: deal.color,
	banner: deal.banner,
	content: deal.content,
	seo: deal.seo,
	sort: deal.sort,
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
	target: deal.target,
	value: deal.value,
	scope: deal.scope,
	conditions: deal.conditions,
	days: deal.days,
	timeFrom: deal.timeFrom,
	timeTo: deal.timeTo,
	allowPoints: deal.allowPoints,
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
	target: deal.target,
	value: deal.value,
	...displayOf(deal),
	banner: deal.banner ? { url: bannerUrl, alt: deal.banner.alt ?? '' } : null,
	minQuantity: deal.conditions?.minQuantity ?? 0,
	cartTotal: deal.conditions?.cartTotal ?? 0,
	paymentMethods: deal.conditions?.paymentMethods ?? [],
	days: deal.days,
	timeFrom: deal.timeFrom,
	timeTo: deal.timeTo,
	allowPoints: deal.allowPoints,
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
