/**
 * Sisters Boutique's offers into Ecommerce deals (PLAN 0.8.10 Migration step 5, "Conversion rules" Offers, IMP-11,
 * IMP-12, IMP-18, IMP-34, PR-5, PR-12, PR-14, PR-16; owner decision D5), as SB's own code applies them
 * (`packages/shared/src/pricing/offerEvaluator.ts`, `offerMatching.ts`, `offerSchedule.ts`):
 *
 * - **item deals** (offers with item conditions, applied per line): SB's scenarios (an `or` group of `and` groups of
 *   categories, brands, products and one attribute) become condition groups (`match: any`), slugs and SB ids becoming
 *   the products' ids; an attribute or brand slug SB keeps in several categories names each of their records; an empty
 *   scenario matches nothing in SB and is dropped (an empty group would match everything); a minimum quantity stays;
 *   cart totals and payment methods do not count for item offers in SB and are left out. Points stay allowed (PR-5:
 *   only the checkout offer blocks them, `deals.pointsBlockedBy: cart_offer`).
 * - **checkout offers** (only cart-total and payment-method conditions): `target: cart`, the cart total in paisa, the
 *   payment methods mapped (`bank-transfer` → `bank_transfer`, `card` → `online`, IMP-32), the points flag kept.
 * - schedule: dates as they are; weekdays and hours with the end minute included (`timeTo` one minute later, PR-12);
 *   hours that end before they start never run in SB and come in switched off (D5, PR-16), and so do offers SB never
 *   applies (no conditions, or a checkout offer that does not target the cart); hours are shifted by
 *   {@link DEAL_HOURS_SHIFT_MINUTES} once SB's server clock is confirmed (PR-14).
 * - order: `sort` from `sortOrder` and `priority` from the creation day (newer first, as SB sorts
 *   `sortOrder` ascending then `createdAt` descending), so `deals.lineChoice: first` takes the same offer.
 * - uses: `usageLimit` ≤ 0 or missing is no limit (IMP-34); `used` is `usageCount`.
 *
 * Rules the products cannot hold (buy X get Y, which SB never applies; nested condition shapes the editor does not
 * write; more than 10 groups, IMP-12) leave the offer out: `ss-import read` counts it under "left out".
 * @module
 */
import { created, iso, isObject, paisa, photoOf, seoOf, text } from './common.js';
import { ATTRIBUTES, BRANDS, TABLES } from './catalog.js';

/** @typedef {import('../../mapping.js').MappingStep} MappingStep */
/** @typedef {import('../../mapping.js').MapContext} MapContext */
/** @typedef {{ type: string, operator: string, value: unknown }} Condition */
/** @typedef {{ field: string, op: string, values: string[], attributeId?: string }} Rule */

/**
 * Minutes to add to SB's offer hours so deals run at the same real time (PR-14, owner decision D5): SB judges hours on
 * its server's clock, Ecommerce in the business time zone (Asia/Karachi, UTC+5). 0 until SB's server clock is confirmed
 * as UTC; then 300.
 */
export const DEAL_HOURS_SHIFT_MINUTES = 0;

/** Condition types that only count at checkout, and those SB's item offers ignore (`offerMatching.ts`:13-19). */
const CHECKOUT_TYPES = Object.freeze(['cart_total', 'payment_method']);
const HINT_IGNORED = Object.freeze(['cart_total', 'payment_method', 'min_quantity']);
/** SB's checkout payment ids → Ecommerce's payment methods (IMP-32). */
const METHODS = Object.freeze(
	/** @type {Record<string, string>} */ ({ 'bank-transfer': 'bank_transfer', card: 'online', cod: 'cod' }),
);
/** Most condition groups of a deal, and rules per group (`products/ecommerce/core/deals.js`). */
const MAX_GROUPS = 10;
const MAX_RULES = 20;
/** The day `priority` counts from (SB's records start in 2026-08). */
const PRIORITY_EPOCH = Date.UTC(2026, 7, 1);
const DAY_MS = 86_400_000;

/** @param {unknown} value @returns {Condition | null} */
const conditionOf = (value) =>
	isObject(value) && typeof value.type === 'string'
		? { type: value.type, operator: text(value.operator), value: value.value }
		: null;

/** @param {unknown} value @returns {Condition[]} */
const conditionsOf = (value) => (Array.isArray(value) ? value.map(conditionOf).filter((c) => c !== null) : []);

/** @param {Condition} condition */
const isCheckoutOnly = (condition) =>
	condition.type === 'group'
		? conditionsOf(condition.value).length > 0 && conditionsOf(condition.value).every(isCheckoutOnly)
		: CHECKOUT_TYPES.includes(condition.type);

/**
 * A condition tree in disjunctive form: alternatives, each a list of plain conditions that must all hold. An empty
 * group matches nothing in SB (`offerMatching.ts` `matchesCondition`): no alternative.
 * @param {Condition} condition
 * @returns {Condition[][]}
 */
const alternativesOf = (condition) => {
	if (condition.type !== 'group') return [[condition]];
	const children = conditionsOf(condition.value);
	if (children.length === 0) return [];
	if (condition.operator === 'or') return children.flatMap(alternativesOf);
	return children.reduce(
		/** @param {Condition[][]} all @param {Condition} child */
		(all, child) => all.flatMap((left) => alternativesOf(child).map((right) => [...left, ...right])),
		[[]],
	);
};

/** The list a condition names (a value or a list). @param {Condition} condition */
const valuesOf = (condition) =>
	[condition.value]
		.flat()
		.map((value) => text(String(value ?? '')))
		.filter(Boolean);

/**
 * One alternative of an item offer as the rule lists it allows (an attribute or brand SB keeps in several categories
 * names each record: an attribute alternative splits into one per attribute record), or null when nothing can match.
 * @param {Condition[]} conditions @param {MapContext} ctx
 * @returns {{ rules: Rule[][], price: Condition[] } | null | 'unsupported'}
 */
const groupRules = (conditions, ctx) => {
	/** @type {Rule[][]} */
	let alternatives = [[]];
	/** @type {Condition[]} */
	const price = [];
	for (const condition of conditions) {
		const op = condition.operator === 'not_in' ? 'not_in' : 'in';
		/** @type {Rule[]} */
		let choices;
		if (condition.type === 'price_range') {
			price.push(condition);
			continue;
		}
		if (condition.type === 'categories' || condition.type === 'brands' || condition.type === 'products') {
			const values = valuesOf(condition);
			const ids =
				condition.type === 'categories'
					? values.map((slug) => ctx.lookup(TABLES.categorySlugs, slug)).filter((id) => id !== null)
					: condition.type === 'brands'
						? values.flatMap((slug) => BRANDS.all(`slug:${slug}`, ctx))
						: values.map((id) => ctx.id('prd', id));
			// nothing named exists: an `in` rule matches nothing, a `not_in` rule everything
			if (ids.length === 0) {
				if (op === 'in') return null;
				continue;
			}
			choices = [{ field: condition.type, op, values: [...new Set(ids)] }];
		} else if (condition.type === 'attributes' && isObject(condition.value)) {
			const slug = text(condition.value.slug);
			const value = text(String(condition.value.value ?? ''));
			const ids = ATTRIBUTES.all(`slug:${slug}`, ctx);
			if (ids.length === 0 || value === '') return null;
			choices = ids.map((attributeId) => ({ field: 'attribute', op: 'in', values: [value], attributeId }));
		} else return 'unsupported';
		alternatives = alternatives.flatMap((rules) => choices.map((rule) => [...rules, rule]));
	}
	return { rules: alternatives, price };
};

/**
 * A price-range condition as the deal's price range in paisa (`between [min, max]`, `gte`, `lte`), or null.
 * @param {Condition} condition
 * @returns {{ min: number | null, max: number | null } | null}
 */
const priceRangeOf = (condition) => {
	const values = [condition.value].flat().map(Number);
	if (condition.operator === 'between' && values.length === 2 && values.every(Number.isFinite))
		return { min: paisa(values[0]), max: paisa(values[1]) };
	if (condition.operator === 'gte' && Number.isFinite(values[0])) return { min: paisa(values[0]), max: null };
	if (condition.operator === 'lte' && Number.isFinite(values[0])) return { min: null, max: paisa(values[0]) };
	return null;
};

/**
 * The conditions of an item offer (SB applies them per line), or why it cannot come in.
 * @param {Condition[]} conditions @param {MapContext} ctx
 * @returns {Record<string, unknown> | 'never' | 'unsupported'}
 */
const itemConditions = (conditions, ctx) => {
	const or = conditions.find((condition) => condition.type === 'group' && condition.operator === 'or');
	/** @type {Condition[][]} */
	let alternatives;
	if (or) {
		const scenarios = conditionsOf(or.value).filter((child) => child.type === 'group' && child.operator === 'and');
		alternatives = scenarios.length > 0 ? scenarios.flatMap(alternativesOf) : alternativesOf(or);
	} else
		alternatives = alternativesOf({
			type: 'group',
			operator: 'and',
			value: conditions.filter((condition) => !HINT_IGNORED.includes(condition.type)),
		});
	/** @type {Rule[][]} */
	const groups = [];
	/** @type {Set<string>} each group's price range: one range for the whole deal */
	const ranges = new Set();
	for (const alternative of alternatives) {
		const checked = groupRules(alternative, ctx);
		if (checked === 'unsupported') return 'unsupported';
		if (checked === null) continue;
		if (checked.price.length > 1) return 'unsupported';
		const range = checked.price.length === 0 ? null : priceRangeOf(/** @type {Condition} */ (checked.price[0]));
		if (checked.price.length === 1 && range === null) return 'unsupported';
		groups.push(...checked.rules);
		ranges.add(JSON.stringify(range));
	}
	if (groups.length === 0) return 'never';
	if (ranges.size > 1) return 'unsupported';
	const range = /** @type {{ min: number | null, max: number | null } | null} */ (JSON.parse([...ranges][0] ?? 'null'));
	if (groups.length > MAX_GROUPS || groups.some((rules) => rules.length > MAX_RULES)) return 'unsupported';
	// SB's minimum line quantity (`offerEvaluator.ts` `resolveOfferMinQuantity`)
	const minimum = conditions.find((condition) => condition.type === 'min_quantity' && condition.operator === 'gte');
	const minQuantity = minimum ? Math.max(0, Math.floor(Number(minimum.value) || 0)) : 0;
	return {
		match: 'any',
		rules: [],
		groups: groups.map((rules) => ({ match: 'all', rules })),
		priceRange: range,
		minQuantity: minQuantity > 1 ? minQuantity : 0,
		cartTotal: 0,
		paymentMethods: [],
	};
};

/**
 * The conditions of a checkout offer (judged once on the cart), or why it cannot come in.
 * @param {Condition[]} conditions
 * @returns {Record<string, unknown> | 'unsupported'}
 */
const checkoutConditions = (conditions) => {
	const alternatives = alternativesOf({ type: 'group', operator: 'and', value: conditions });
	/** @param {Condition} condition */
	const methodsOf = (condition) => {
		const named = valuesOf(condition).map((id) => METHODS[id] ?? '');
		const all = Object.values(METHODS);
		return condition.operator === 'not_in' ? all.filter((method) => !named.includes(method)) : named.filter(Boolean);
	};
	/** @type {string[] | null} */
	let methods = null;
	let cartTotal = 0;
	if (alternatives.length > 1) {
		// either of several payment methods: their union
		if (!alternatives.every((all) => all.length === 1 && all[0]?.type === 'payment_method')) return 'unsupported';
		methods = [...new Set(alternatives.flatMap((all) => methodsOf(/** @type {Condition} */ (all[0]))))];
	} else
		for (const condition of alternatives[0] ?? []) {
			if (condition.type === 'cart_total' && condition.operator === 'gte' && Number.isFinite(Number(condition.value)))
				cartTotal = Math.max(cartTotal, paisa(condition.value));
			else if (condition.type === 'payment_method') {
				const named = methodsOf(condition);
				methods = methods === null ? named : methods.filter((method) => named.includes(method));
			} else return 'unsupported';
		}
	return {
		match: 'all',
		rules: [],
		groups: [],
		priceRange: null,
		minQuantity: 0,
		cartTotal,
		paymentMethods: methods ?? [],
	};
};

/** `H:MM` or `HH:MM` as minutes since midnight, or null. @param {unknown} value */
const minutesOf = (value) => {
	const match = /^(\d{1,2}):(\d{2})$/.exec(text(value));
	if (!match) return null;
	const minutes = Number(match[1]) * 60 + Number(match[2]);
	return Number(match[1]) < 24 && Number(match[2]) < 60 ? minutes : null;
};

/** Minutes since midnight as `HH:MM`. @param {number} minutes */
const clock = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/**
 * SB's weekdays and hours as the deal's window (`days`, `timeFrom`, `timeTo` exclusive), shifted by `shift` minutes:
 * SB's end minute counts (`offerSchedule.ts`:39-44), so `timeTo` is one minute later ('' at midnight). `overnight`:
 * the hours end before they start, which SB never runs.
 * @param {Record<string, any>} schedule
 * @param {number} [shift]
 * @returns {{ days: number[], timeFrom: string, timeTo: string, overnight: boolean }}
 */
export const windowOf = (schedule, shift = DEAL_HOURS_SHIFT_MINUTES) => {
	const days = [
		...new Set(
			(Array.isArray(schedule.daysOfWeek) ? schedule.daysOfWeek : []).filter(
				(/** @type {unknown} */ day) => Number.isInteger(day) && Number(day) >= 0 && Number(day) <= 6,
			),
		),
	].sort();
	const from = minutesOf(schedule.startTime);
	const end = minutesOf(schedule.endTime);
	const overnight = from !== null && end !== null && end < from;
	if (shift === 0 || (days.length === 0 && from === null && end === null))
		return {
			days,
			timeFrom: from === null ? '' : clock(from),
			timeTo: end === null || end === 1439 ? '' : clock(end + 1),
			overnight,
		};
	// the window's start and end move by `shift`; a start past midnight moves the weekdays too
	const start = (from ?? 0) + shift;
	const startDay = Math.floor(start / 1440);
	const startAt = ((start % 1440) + 1440) % 1440;
	const stopAt = ((((end ?? 1439) + 1 + shift) % 1440) + 1440) % 1440;
	return {
		days: days.map((day) => (((Number(day) + startDay) % 7) + 7) % 7).sort(),
		timeFrom: clock(startAt),
		// a whole day ends a minute before it starts again (Ecommerce takes no window of equal ends)
		timeTo: clock(stopAt === startAt ? (stopAt + 1439) % 1440 : stopAt),
		overnight,
	};
};

/** SB's structured copy as the deal's text: the summary, then each bullet on its own line. @param {unknown} content */
const contentText = (content) =>
	isObject(content)
		? [
				text(content.summary),
				...(Array.isArray(content.bullets) ? content.bullets : []).map((bullet) =>
					isObject(bullet) && text(bullet.text) ? `- ${text(bullet.text)}` : '',
				),
			]
				.filter(Boolean)
				.join('\n')
		: '';

/**
 * The offers as deals, in SB's order.
 * @type {MappingStep}
 */
export const dealStep = {
	product: 'ecommerce',
	collection: 'deals',
	source: 'offers',
	prefix: 'deal',
	map: (doc, ctx) => {
		const action = isObject(doc.action) ? doc.action : {};
		const conditions = conditionsOf(doc.conditions);
		const kind = conditions.length === 0 ? 'never' : conditions.every(isCheckoutOnly) ? 'checkout' : 'item';
		const type =
			action.type === 'percentage_discount'
				? 'percent'
				: action.type === 'fixed_amount_discount'
					? 'fixed'
					: action.type === 'free_shipping'
						? 'free_delivery'
						: null;
		if (type === null) return null;
		const ruled =
			kind === 'item' ? itemConditions(conditions, ctx) : kind === 'checkout' ? checkoutConditions(conditions) : 'never';
		if (ruled === 'unsupported') return null;
		const target = kind === 'checkout' && type !== 'free_delivery' ? 'cart' : 'items';
		// SB applies a checkout offer's percent or amount only to the cart total (`offerEvaluator.ts` `applyCartWideOffer`)
		const neverApplies =
			ruled === 'never' || (kind === 'checkout' && type !== 'free_delivery' && action.target !== 'cart_total');
		const schedule = isObject(doc.schedule) ? doc.schedule : {};
		const window = windowOf(schedule);
		const constraints = isObject(doc.constraints) ? doc.constraints : {};
		const limit = Number(constraints.usageLimit);
		const createdTime = Date.parse(iso(doc.createdAt) ?? '');
		const banner = photoOf(doc.bannerImage);
		const seo = seoOf(doc.seo);
		const content = contentText(doc.content);
		return {
			id: ctx.id('deal', doc._id),
			name: text(doc.title),
			description: text(doc.description),
			type,
			target,
			...(type === 'free_delivery' ? {} : { value: type === 'fixed' ? paisa(action.value) : Number(action.value) }),
			conditions: ruled === 'never' ? null : ruled,
			startsAt: iso(schedule.startDate),
			endsAt: iso(schedule.endDate),
			days: window.days,
			timeFrom: window.timeFrom,
			timeTo: window.timeTo,
			limit: Number.isSafeInteger(limit) && limit > 0 ? limit : null,
			used: Math.max(0, Math.floor(Number(constraints.usageCount) || 0)),
			priority: Number.isFinite(createdTime)
				? Math.max(-1000, Math.min(1000, Math.floor((createdTime - PRIORITY_EPOCH) / DAY_MS)))
				: 0,
			sort: Number.isSafeInteger(doc.sortOrder) ? doc.sortOrder : Math.round(Number(doc.sortOrder) || 0),
			// overnight hours never run in SB (D5, PR-16); nor do offers SB never applies
			active: doc.isActive !== false && !window.overnight && !neverApplies,
			allowPoints: kind === 'checkout' ? constraints.allowLoyaltyPoints === true : true,
			slug: text(doc.slug),
			...(text(doc.badgeLabel) ? { badgeLabel: text(doc.badgeLabel) } : {}),
			...(text(doc.discountLabel) ? { discountLabel: text(doc.discountLabel) } : {}),
			...(text(doc.color) ? { color: text(doc.color) } : {}),
			...(banner ? { banner: { key: banner.key, type: banner.type, size: 0, alt: banner.alt } } : {}),
			...(content ? { content } : {}),
			...(seo.title || seo.description ? { seo: { title: seo.title ?? '', description: seo.description ?? '' } } : {}),
			...created(doc.createdAt),
		};
	},
	sums: (record) => ({ 'deals.used': Number(record.used) }),
};
