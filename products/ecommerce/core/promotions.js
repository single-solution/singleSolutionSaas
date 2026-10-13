/**
 * Promotions pricing (PLAN 0.8.8; PLAN 0.8.10 E18): which deals, bundles and coupon apply to a cart and how much each
 * takes off each line. Checkout calls `applyPromotions` when it prices a cart and again when it places the order (the
 * ledger then counts the uses in the order transaction); the Chat lookups and the product page quote one product with
 * `quoteProduct`. The order:
 * 1. deals: each line takes one deal — the best saving among the live deals covering it (scope, conditions, weekdays
 *    and hours in the business time zone) or, with `lineChoice: first`, the first of them in the shoppers' order that
 *    saves something; the deal the shopper picked among them (`shopperChoice`); or the deal its signed lock keeps
 *    (`lockMinutes`) when that saves more than today's deals (`core/deals.js`); cart deals take a percent of the lines
 *    they cover, or one fixed amount spread over them; a live free-delivery deal covering a line waives delivery. With
 *    `cartOffer: one_after_items` lines take item deals only, and then at most one checkout-level deal (a cart deal or
 *    free delivery: the first live one in the shoppers' order that applies) comes off what they left; with
 *    `one_exclusive` only when no item deal applied;
 * 2. bundles: sets form on the cart's units; a unit a bundle discounts takes no deal, and a set forms only when it saves
 *    more than those deals (`core/bundles.js`);
 * 3. the coupon, on what is left of the lines in its scope (`core/coupons.js`); its minimum subtotal is measured after
 *    deals and bundles.
 * Every amount is integer minor units, rounded down to whole units with Format's `wholeUnits` (E25); with the `deals`
 * setting `rounding: total_half_up` the deals are worked out exactly and their total is rounded once, half up, then
 * spread back over the lines (D4); no line ever goes below 0. No I/O.
 * @module
 */
import { formBundles } from './bundles.js';
import { couponBlocked, couponDiscount, couponProblem, normaliseCode } from './coupons.js';
import { bestDeal, better, byShowOrder, checkoutLevel, DEAL_RULES, dealCovers, dealLineDiscount, dealLive } from './deals.js';
import { allocateUnits, roundHalfUp } from './money.js';

/** @typedef {import('./model.js').DealRecord} DealRecord */

/**
 * A cart line as promotions see it.
 * @typedef {object} PricingLine
 * @property {string} key unique per cart (`<productId>|<variantId>`, plus `|<slot start>` for bookings)
 * @property {string} productId
 * @property {string} variantId
 * @property {string[]} categoryIds the product's categories and all their ancestors
 * @property {string | null} brandId
 * @property {number} unitPrice minor units
 * @property {number} quantity
 * @property {string | null} [grade] the variant's grade (deal conditions)
 * @property {Record<string, string[]>} [attributes] attribute id → values (deal conditions)
 * @property {string | null} [dealId] the deal the shopper picked (`shopperChoice`, E18)
 * @property {{ dealId: string, perUnit: number } | null} [lock] a verified lock: the deal and what it took off each unit
 */

/**
 * What promotions take off.
 * @typedef {object} PromotionsResult
 * @property {Array<{ key: string, dealId: string | null, dealDiscount: number, bundleDiscount: number, couponDiscount: number,
 *   eligibleDealIds?: string[], locked?: boolean, perUnit?: number }>} lines one per input line, in the same order;
 *   discounts in minor units, never more than the line; `dealId`: the line's own deal, else the checkout-level deal;
 *   `dealDiscount`: both (`cartOffer`); `eligibleDealIds`: the deals the shopper may pick for it; `locked`: its deal
 *   comes from its lock; `perUnit`: what its item deal took off each unit (locks keep it)
 * @property {string[]} dealIds deals that took something off (or waived delivery)
 * @property {string[]} bundleIds bundles that took something off
 * @property {string | null} couponId the coupon, when it applies
 * @property {string} couponCode the code entered, trimmed and upper case ('' = none)
 * @property {boolean} freeDelivery a free-delivery coupon or deal applies
 * @property {{ code: string, message: string } | null} couponProblem why the code given does not apply
 * @property {Array<{ id: string, name: string, kind: 'deal' | 'bundle' | 'coupon', amount: number }>} applied for receipts
 *   (deals and bundles by name, the coupon by its code; free delivery has amount 0: checkout knows the fee)
 * @property {boolean} [pointsBlocked] a deal that allows no points applies (E18 `allowPoints`; with `pointsBlockedBy:
 *   cart_offer` only a checkout-level one counts)
 */

/**
 * The business time of an instant in UTC (when the caller gives none).
 * @param {number} now
 */
const utcClock = (now) => {
	const at = new Date(now);
	return { weekday: at.getUTCDay(), minutes: at.getUTCHours() * 60 + at.getUTCMinutes() };
};

/**
 * @param {object} input
 * @param {PricingLine[]} input.lines
 * @param {DealRecord[]} input.deals active deals (switched off: []); deals kept by locks may be ended
 * @param {import('./model.js').BundleRecord[]} input.bundles active bundles (switched off: [])
 * @param {import('./model.js').CouponRecord | null} input.coupon the coupon of the code entered (null: none or unknown)
 * @param {string} input.couponCode the code as entered ('' = none)
 * @param {{ orderCount: number, couponUses: number }} input.customer the shopper's past orders and uses of this coupon
 * @param {number} input.now epoch ms
 * @param {{ paymentMethod?: string | null, weekday?: number, minutes?: number }} [input.cart] the payment method and the
 *   business time (weekday 0 = Sunday, minutes since midnight; default: UTC)
 * @param {number} [input.unit] whole units (E25)
 * @param {boolean} [input.shopperChoice] lines may name one of their eligible deals (E18)
 * @param {import('./deals.js').DealRules} [input.rules] how deals choose, combine and round (the `deals` settings, D4)
 * @returns {PromotionsResult}
 */
export const applyPromotions = ({
	lines,
	deals,
	bundles,
	coupon,
	couponCode,
	customer,
	now,
	cart = {},
	unit = 1,
	shopperChoice = false,
	rules = DEAL_RULES,
}) => {
	const clock = { ...utcClock(now), ...(cart.weekday === undefined ? {} : { weekday: cart.weekday }) };
	if (cart.minutes !== undefined) clock.minutes = cart.minutes;
	const facts = {
		goods: lines.reduce((sum, line) => sum + Math.max(0, line.unitPrice) * Math.max(0, line.quantity), 0),
		paymentMethod: cart.paymentMethod ?? null,
		...clock,
	};
	const live = deals.filter((deal) => dealLive(deal, now, clock));
	const priceable = lines.map((line) => line.quantity > 0 && line.unitPrice > 0);
	const { rounding } = rules;
	const exact = rounding === 'total_half_up';
	const first = rules.lineChoice === 'first';
	// `cartOffer`: checkout-level deals (off the cart, or free delivery) compete with item deals for each line, or at
	// most one of them comes after the item deals
	const stacked = rules.cartOffer !== 'per_line_best';
	// which lines each live deal covers (cart deals spread their fixed amount over them); item deals first
	/** @type {Map<string, number[]>} */
	const covered = new Map();
	/** @param {DealRecord[]} list @param {import('./deals.js').DealCart} on the cart facts they are judged on */
	const cover = (list, on) => {
		for (const deal of list)
			covered.set(
				deal.id,
				lines.flatMap((line, index) => (priceable[index] && dealCovers(deal, line, on) ? [index] : [])),
			);
	};
	cover(
		live.filter((deal) => !checkoutLevel(deal)),
		facts,
	);
	/** @param {DealRecord} deal @param {number} index */
	const estimate = (deal, index) => {
		const line = /** @type {PricingLine} */ (lines[index]);
		if ((deal.target ?? 'items') !== 'cart' || deal.type !== 'fixed') return dealLineDiscount(deal, line, { unit, rounding });
		const indexes = covered.get(deal.id) ?? [];
		const total = indexes.reduce(
			(sum, i) => sum + /** @type {PricingLine} */ (lines[i]).unitPrice * /** @type {PricingLine} */ (lines[i]).quantity,
			0,
		);
		const share = total > 0 ? (deal.value * line.unitPrice * line.quantity) / total : 0;
		return dealLineDiscount(deal, line, { unit, share, rounding });
	};
	/**
	 * A fixed amount spread over amounts in proportion: in whole units (the part below a unit is dropped), or exactly
	 * with `total_half_up`.
	 * @param {number} total @param {number[]} amounts
	 */
	const spread = (total, amounts) => {
		const sum = amounts.reduce((a, b) => a + b, 0);
		return exact
			? amounts.map((amount) => (sum > 0 ? (total * amount) / sum : 0))
			: allocateUnits(total - (unit > 1 ? total % unit : 0), amounts, unit);
	};

	/**
	 * A line's deal among the live deals covering it (with cart deals or not): the shopper's pick, the first or the best
	 * saving (`lineChoice`), or the deal its lock keeps when that saves more.
	 * @param {number} index
	 * @param {boolean} withCart
	 */
	const choose = (index, withCart) => {
		const line = /** @type {PricingLine} */ (lines[index]);
		if (!priceable[index]) return { deal: null, saving: 0, eligible: /** @type {string[]} */ ([]), locked: false };
		const eligible = live.filter(
			(deal) =>
				deal.type !== 'free_delivery' && (withCart || !checkoutLevel(deal)) && (covered.get(deal.id) ?? []).includes(index),
		);
		/** @type {{ deal: DealRecord, saving: number } | null} */
		let best = null;
		const picked = shopperChoice && line.dealId ? eligible.find((deal) => deal.id === line.dealId) : undefined;
		if (picked) best = { deal: picked, saving: estimate(picked, index) };
		else
			for (const deal of first ? [...eligible].sort(byShowOrder) : eligible) {
				const saving = estimate(deal, index);
				// `lineChoice`: the first deal in the shoppers' order that saves something, or the best saving
				if (saving > 0 && (first ? best === null : better({ deal, saving }, best))) best = { deal, saving };
			}
		let locked = false;
		if (line.lock) {
			const kept = deals.find((deal) => deal.id === line.lock?.dealId);
			const saving = Math.min(line.unitPrice, Math.max(0, line.lock.perUnit)) * line.quantity;
			if (kept && saving > (best?.saving ?? 0)) {
				best = { deal: kept, saving };
				locked = true;
			}
		}
		return {
			deal: best && best.saving > 0 ? best.deal : null,
			saving: best?.saving ?? 0,
			eligible: eligible.map((deal) => deal.id),
			locked,
		};
	};

	// the item deals alone: what each line takes while the checkout-level deal comes after them, and what is left of
	// the goods for the checkout-level deals' cart total (`cartThresholdBase: after_item_deals`)
	const afterItems = rules.cartThresholdBase === 'after_item_deals';
	const items = stacked || afterItems ? lines.map((_, index) => choose(index, false)) : [];
	cover(
		live.filter(checkoutLevel),
		afterItems ? { ...facts, goods: facts.goods - items.reduce((sum, pick) => sum + pick.saving, 0) } : facts,
	);

	// 1. each line's deal (a cart deal never replaces an item deal while the checkout-level deal comes after them)
	const chosen = stacked ? items : lines.map((_, index) => choose(index, true));

	// 2. bundles, against what the chosen deals save per unit
	const formed = formBundles(
		bundles,
		lines.map((line, index) => ({
			productId: line.productId,
			categoryIds: line.categoryIds,
			brandId: line.brandId,
			unitPrice: Math.max(0, line.unitPrice),
			quantity: Math.max(0, line.quantity),
			dealUnit: line.quantity > 0 ? Math.floor((chosen[index]?.saving ?? 0) / line.quantity) : 0,
		})),
		now,
		unit,
	);

	// the deals on the units bundles left: per unit, a percent of the cart lines, or a fixed amount spread over them
	const dealDiscounts = lines.map((line, index) => {
		const pick = /** @type {(typeof chosen)[number]} */ (chosen[index]);
		const { bundleUnits } = /** @type {{ bundleUnits: number }} */ (formed.lines[index]);
		const units = Math.max(0, line.quantity - bundleUnits);
		if (!pick.deal || units === 0) return 0;
		if (pick.locked) return Math.min(line.unitPrice, /** @type {{ perUnit: number }} */ (line.lock).perUnit) * units;
		if ((pick.deal.target ?? 'items') === 'cart' && pick.deal.type === 'fixed') return -1;
		return dealLineDiscount(pick.deal, { unitPrice: line.unitPrice, quantity: units }, { unit, rounding });
	});
	for (const deal of live) {
		if ((deal.target ?? 'items') !== 'cart' || deal.type !== 'fixed') continue;
		const takers = lines.flatMap((_, index) =>
			chosen[index]?.deal?.id === deal.id && dealDiscounts[index] === -1 ? [index] : [],
		);
		if (takers.length === 0) continue;
		const amounts = takers.map((index) => {
			const line = /** @type {PricingLine} */ (lines[index]);
			return (
				line.unitPrice * Math.max(0, line.quantity - /** @type {{ bundleUnits: number }} */ (formed.lines[index]).bundleUnits)
			);
		});
		const parts = spread(
			Math.min(
				deal.value,
				amounts.reduce((sum, amount) => sum + amount, 0),
			),
			amounts,
		);
		takers.forEach((index, i) => {
			dealDiscounts[index] = Math.min(amounts[i] ?? 0, parts[i] ?? 0);
		});
	}
	/** @param {number} index what is left of a line after its bundles */
	const room = (index) =>
		/** @type {PricingLine} */ (lines[index]).unitPrice * /** @type {PricingLine} */ (lines[index]).quantity -
		/** @type {{ bundleDiscount: number }} */ (formed.lines[index]).bundleDiscount;

	// the checkout-level deal after the item deals (`cartOffer`; with `one_exclusive` only while no item deal applied):
	// the first live one in the shoppers' order that covers a line and takes something off what is left of the lines it
	// covers (free delivery always counts)
	const offer =
		stacked && !(rules.cartOffer === 'one_exclusive' && dealDiscounts.some((amount) => amount > 0))
			? live
					.filter((deal) => checkoutLevel(deal) && (covered.get(deal.id) ?? []).length > 0)
					.sort(byShowOrder)
					.map((deal) => {
						const indexes = covered.get(deal.id) ?? [];
						const rest = lines.map((_, index) =>
							indexes.includes(index) ? Math.max(0, room(index) - Math.max(0, dealDiscounts[index] ?? 0)) : 0,
						);
						const shares =
							deal.type === 'fixed'
								? spread(
										Math.min(
											deal.value,
											rest.reduce((sum, amount) => sum + amount, 0),
										),
										rest,
									)
								: [];
						return {
							deal,
							takes: rest.map((amount, index) =>
								dealLineDiscount(deal, { unitPrice: amount, quantity: 1 }, { unit, share: shares[index] ?? 0, rounding }),
							),
						};
					})
					.find(({ deal, takes }) => deal.type === 'free_delivery' || takes.some((take) => take > 0))
			: undefined;
	const extras = lines.map((_, index) => offer?.takes[index] ?? 0);

	// `total_half_up`: the exact deal discounts (not those locks keep) are rounded once, half up, and spread back
	if (exact) {
		const open = [...lines.map((_, index) => (chosen[index]?.locked ? 0 : Math.max(0, dealDiscounts[index] ?? 0))), ...extras];
		const parts = allocateUnits(
			roundHalfUp(
				open.reduce((sum, amount) => sum + amount, 0),
				unit,
			),
			open,
			unit,
		);
		lines.forEach((_, index) => {
			if ((open[index] ?? 0) > 0) dealDiscounts[index] = Math.min(room(index), parts[index] ?? 0);
			if ((extras[index] ?? 0) > 0)
				extras[index] = Math.min(room(index) - Math.max(0, dealDiscounts[index] ?? 0), parts[lines.length + index] ?? 0);
		});
	}
	const owns = lines.map((_, index) => Math.max(0, dealDiscounts[index] ?? 0));
	const priced = lines.map((line, index) => {
		const pick = /** @type {(typeof chosen)[number]} */ (chosen[index]);
		const { bundleDiscount } = /** @type {{ bundleDiscount: number }} */ (formed.lines[index]);
		const own = owns[index] ?? 0;
		const extra = extras[index] ?? 0;
		return {
			key: line.key,
			// the line's own deal, else the checkout-level deal when it took something off the line
			dealId: own > 0 && pick.deal ? pick.deal.id : extra > 0 && offer ? offer.deal.id : null,
			dealDiscount: own + extra,
			bundleDiscount,
			couponDiscount: 0,
			eligibleDealIds: pick.eligible,
			locked: own > 0 && pick.locked,
			perUnit:
				own > 0 && pick.deal && (pick.deal.target ?? 'items') === 'items'
					? Math.floor(
							own / Math.max(1, line.quantity - /** @type {{ bundleUnits: number }} */ (formed.lines[index]).bundleUnits),
						)
					: 0,
		};
	});

	/** @type {PromotionsResult['applied']} */
	const applied = [];
	/** @type {string[]} */
	const dealIds = [];
	/** @type {DealRecord[]} */
	const used = [];
	for (const [index, own] of owns.entries()) {
		if (own <= 0) continue;
		const deal = /** @type {DealRecord} */ (chosen[index]?.deal);
		const entry = applied.find((item) => item.kind === 'deal' && item.id === deal.id);
		if (entry) entry.amount += own;
		else {
			dealIds.push(deal.id);
			used.push(deal);
			applied.push({ id: deal.id, name: deal.name, kind: 'deal', amount: own });
		}
	}
	// the checkout-level deal after the item deals; else free delivery: the best live free-delivery deal covering a line
	const delivery = stacked
		? null
		: live
				.filter((deal) => deal.type === 'free_delivery' && (covered.get(deal.id) ?? []).length > 0)
				.reduce(
					(/** @type {DealRecord | null} */ best, deal) =>
						better({ deal, saving: 1 }, best ? { deal: best, saving: 1 } : null) ? deal : best,
					null,
				);
	const last = offer?.deal ?? delivery;
	if (last) {
		dealIds.push(last.id);
		used.push(last);
		applied.push({ id: last.id, name: last.name, kind: 'deal', amount: extras.reduce((sum, take) => sum + take, 0) });
	}
	const bundleIds = [...formed.savings.keys()];
	for (const [id, amount] of formed.savings) {
		const bundle = /** @type {import('./model.js').BundleRecord} */ (bundles.find((item) => item.id === id));
		applied.push({ id, name: bundle.name, kind: 'bundle', amount });
	}

	const code = normaliseCode(couponCode);
	/** @type {PromotionsResult} */
	const result = {
		lines: priced,
		dealIds,
		bundleIds,
		couponId: null,
		couponCode: code,
		freeDelivery: last?.type === 'free_delivery',
		couponProblem: null,
		applied,
		pointsBlocked: used.some(
			(deal) => deal.allowPoints === false && (rules.pointsBlockedBy === 'any_deal' || checkoutLevel(deal)),
		),
	};
	if (code === '') return result;
	const blocked = couponBlocked(coupon, { code, now, customer });
	if (blocked || !coupon) return { ...result, couponProblem: couponProblem(blocked ?? 'coupon_unknown') };
	const discount = couponDiscount(
		coupon,
		lines.map((line, index) => {
			const { dealDiscount, bundleDiscount } = /** @type {(typeof priced)[number]} */ (priced[index]);
			return {
				productId: line.productId,
				categoryIds: line.categoryIds,
				brandId: line.brandId,
				remaining: Math.max(0, line.unitPrice * line.quantity - dealDiscount - bundleDiscount),
			};
		}),
		unit,
	);
	if (!discount.ok) return { ...result, couponProblem: couponProblem(discount.code) };
	const amount = discount.amounts.reduce((sum, value) => sum + value, 0);
	return {
		...result,
		lines: priced.map((line, index) => ({ ...line, couponDiscount: discount.amounts[index] ?? 0 })),
		couponId: coupon.id,
		freeDelivery: result.freeDelivery || discount.freeDelivery,
		applied: [...applied, { id: coupon.id, name: coupon.code, kind: 'coupon', amount }],
	};
};

/**
 * What one product costs after deals: its lowest active variant (or the variant asked for), with the best live deal.
 * Used by the product page quote and the Chat lookups.
 * @param {object} input
 * @param {import('./model.js').ProductRecord} input.product
 * @param {string | null} [input.variantId] a variant of the product ('' or null: the lowest-priced active one)
 * @param {import('./model.js').DealRecord[]} input.deals live deals (switched off: [])
 * @param {number} input.now epoch ms
 * @param {string[]} [input.categoryIds] the product's categories with their ancestors (default: the product's own)
 * @param {string} [input.currency] the shop's currency
 * @param {{ weekday: number, minutes: number }} [input.clock] the business time (deal hours)
 * @param {number} [input.unit] whole units (E25)
 * @param {import('./deals.js').DealRules} [input.rules] how deals choose and round (the `deals` settings, D4)
 * @returns {{ productId: string, variantId: string, price: number, priceAfterDeals: number, savings: number, currency: string,
 *   deals: Array<{ id: string, name: string }> } | null} null when the product has no such active variant
 */
export const quoteProduct = ({
	product,
	variantId = null,
	deals,
	now,
	categoryIds,
	currency = '',
	clock,
	unit = 1,
	rules = DEAL_RULES,
}) => {
	const active = product.variants.filter((variant) => variant.active);
	const variant = variantId
		? active.find((item) => item.id === variantId)
		: active.reduce(
				(/** @type {import('./model.js').VariantRecord | undefined} */ low, item) =>
					!low || item.price < low.price ? item : low,
				undefined,
			);
	if (!variant) return null;
	const found = bestDeal(
		{
			productId: product.id,
			categoryIds: categoryIds ?? product.categoryIds,
			brandId: product.brandId,
			grade: variant.grade ?? null,
			attributes: attributeValues(product, variant),
			unitPrice: variant.price,
			quantity: 1,
		},
		deals,
		now,
		{ unit, rules, ...(clock ? { cart: { goods: variant.price, paymentMethod: null, ...clock } } : {}) },
	);
	const savings = found?.perUnit ?? 0;
	return {
		productId: product.id,
		variantId: variant.id,
		price: variant.price,
		priceAfterDeals: variant.price - savings,
		savings,
		currency,
		deals: found ? [{ id: found.deal.id, name: found.deal.name }] : [],
	};
};

/**
 * A variant's attribute values for deal conditions: the product's own attributes and the variant's (E7), as texts.
 * @param {Pick<import('./model.js').ProductRecord, 'specs'>} product
 * @param {Pick<import('./model.js').VariantRecord, 'attributes'>} variant
 * @returns {Record<string, string[]>}
 */
export const attributeValues = (product, variant) => {
	/** @type {Record<string, string[]>} */
	const out = {};
	for (const source of [product.specs ?? {}, variant.attributes ?? {}])
		for (const [id, value] of Object.entries(source))
			out[id] = (Array.isArray(value) ? value : [value]).map((item) => String(item));
	return out;
};
