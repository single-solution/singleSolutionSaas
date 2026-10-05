/**
 * Server-side totals (pure). Prices come from the item records, discounts from the Deals and Coupons products' quotes,
 * the redeemed value from the Loyalty product — the client's numbers are never used. All amounts are integer minor units
 * of one currency, and every step is clamped so no total can go negative.
 *
 * Order of application: automatic deals on the list prices, then coupon codes on the prices after deals (each line's
 * unit price after deals is rounded down, in the shopper's favour never the reverse), then delivery (the fee follows the
 * subtotal after discounts; free-shipping offers waive it), the payment surcharge on the subtotal after discounts, and
 * last the loyalty value. When the products say their offers do not combine, the `precedence` setting decides.
 * @module
 */
import { deliveryFee } from './form.js';
import { applyBasisPoints, clampAmount } from './money.js';

/**
 * @typedef {object} DealsResult normalised Deals quote
 * @property {string | null} quoteId
 * @property {number} discount
 * @property {Record<string, number>} lineDiscounts by lineId
 * @property {number} shippingDiscount
 * @property {boolean} freeShipping
 * @property {boolean} couponsAllowed
 * @property {boolean} loyaltyAllowed
 * @property {Array<{ dealId: string, name: string, amount: number }>} deals
 */
/**
 * @typedef {object} CouponsResult normalised Coupons quote
 * @property {number} discount
 * @property {number} shippingDiscount
 * @property {boolean} freeShipping
 * @property {boolean} dealsAllowed
 * @property {boolean} loyaltyAllowed
 * @property {Array<{ code: string, name: string, discount: number }>} applied
 * @property {Array<{ code: string, reason: string }>} rejected
 */
/**
 * @typedef {object} Totals the snapshot stored on the order
 * @property {string} currency
 * @property {number} subtotal list prices × quantities
 * @property {number} itemDiscount automatic deals
 * @property {number} couponDiscount coupon codes
 * @property {number} shipping delivery fee before discounts
 * @property {number} shippingDiscount
 * @property {number} surcharge payment surcharge
 * @property {number} loyalty redeemed value
 * @property {number} tax always 0 in v1 (taxes are a later element)
 * @property {number} total
 */

/** @param {unknown} value */
const amount = (value) => (Number.isSafeInteger(value) && /** @type {number} */ (value) > 0 ? /** @type {number} */ (value) : 0);

/**
 * Normalise a Deals `POST /v1/quotes` response.
 * @param {any} raw
 * @returns {DealsResult}
 */
export const dealsFrom = (raw) => ({
	quoteId: typeof raw?.id === 'string' ? raw.id : null,
	discount: amount(raw?.discountTotal),
	lineDiscounts: Object.fromEntries(
		(Array.isArray(raw?.lines) ? raw.lines : [])
			.filter((/** @type {any} */ line) => typeof line?.lineId === 'string')
			.map((/** @type {any} */ line) => [line.lineId, amount(line.discount)]),
	),
	shippingDiscount: amount(raw?.shipping?.discount),
	freeShipping: raw?.shipping?.free === true,
	couponsAllowed: raw?.couponsAllowed !== false,
	loyaltyAllowed: raw?.loyaltyAllowed !== false,
	deals: (Array.isArray(raw?.deals) ? raw.deals : [])
		.filter((/** @type {any} */ deal) => typeof deal?.dealId === 'string')
		.slice(0, 50)
		.map((/** @type {any} */ deal) => ({
			dealId: deal.dealId,
			name: typeof deal.name === 'string' ? deal.name.slice(0, 200) : '',
			amount: amount(deal.amount),
		})),
});

/**
 * Normalise a Coupons `POST /v1/quotes` response.
 * @param {any} raw
 * @returns {CouponsResult}
 */
export const couponsFrom = (raw) => ({
	discount: amount(raw?.discount),
	shippingDiscount: amount(raw?.shippingDiscount),
	freeShipping: raw?.freeShipping === true,
	dealsAllowed: raw?.dealsAllowed !== false,
	loyaltyAllowed: raw?.loyaltyAllowed !== false,
	applied: (Array.isArray(raw?.applied) ? raw.applied : [])
		.filter((/** @type {any} */ entry) => typeof entry?.code === 'string')
		.slice(0, 10)
		.map((/** @type {any} */ entry) => ({
			code: entry.code,
			name: typeof entry.name === 'string' ? entry.name.slice(0, 200) : '',
			discount: amount(entry.discount) + amount(entry.shippingDiscount),
		})),
	rejected: (Array.isArray(raw?.rejected) ? raw.rejected : [])
		.filter((/** @type {any} */ entry) => typeof entry?.code === 'string')
		.slice(0, 10)
		.map((/** @type {any} */ entry) => ({
			code: entry.code,
			reason: typeof entry.reason === 'string' ? entry.reason : 'not_eligible',
		})),
});

/**
 * Lines priced after deals (what coupons are quoted on): unit price after the line's deal discount, rounded down.
 * @template {{ lineId: string, unitAmount: number, quantity: number }} L
 * @param {readonly L[]} lines
 * @param {DealsResult | null} deals
 * @returns {L[]}
 */
export const linesAfterDeals = (lines, deals) =>
	lines.map((line) => {
		const off = deals?.lineDiscounts[line.lineId] ?? 0;
		if (off <= 0) return line;
		const total = Math.max(0, line.unitAmount * line.quantity - off);
		return { ...line, unitAmount: Math.floor(total / line.quantity) };
	});

/** @param {DealsResult | CouponsResult | null} offer */
const worth = (offer) => (offer ? offer.discount + offer.shippingDiscount : 0);

/**
 * Settle deals and coupons that refuse to combine. `couponsOnList` is the coupons quote on list prices (used when the
 * deals are dropped); `couponsOnDeals` the quote after deals.
 * @param {{ deals: DealsResult | null, couponsOnDeals: CouponsResult | null, couponsOnList: CouponsResult | null,
 *   precedence: 'best' | 'deals_first' | 'coupons_first' }} input
 * @returns {{ deals: DealsResult | null, coupons: CouponsResult | null, dropped: 'deals' | 'coupons' | null }}
 */
export const chooseOffers = ({ deals, couponsOnDeals, couponsOnList, precedence }) => {
	const coupons = couponsOnDeals ?? couponsOnList;
	const live = coupons && coupons.applied.length > 0 ? coupons : null;
	if (!deals || !live) return { deals, coupons: live, dropped: null };
	const conflict = !deals.couponsAllowed || !live.dealsAllowed;
	if (!conflict) return { deals, coupons: couponsOnDeals ?? live, dropped: null };
	const alone = couponsOnList ?? live;
	if (precedence === 'deals_first') return { deals, coupons: null, dropped: 'coupons' };
	if (precedence === 'coupons_first') return { deals: null, coupons: alone, dropped: 'deals' };
	return worth(alone) > worth(deals)
		? { deals: null, coupons: alone, dropped: 'deals' }
		: { deals, coupons: null, dropped: 'coupons' };
};

/**
 * Compute the totals.
 * @param {{ currency: string, lines: ReadonlyArray<{ unitAmount: number, quantity: number }>,
 *   deals: DealsResult | null, coupons: CouponsResult | null,
 *   delivery: import('./form.js').DeliveryMethod | null,
 *   surchargeFor: (subtotalAfterDiscounts: number) => number,
 *   loyaltyValue: number, loyaltyMaxShareBp: number }} input
 * @returns {{ totals: Totals, loyaltyAllowed: boolean, loyaltyCap: number }}
 */
export const computeTotals = ({ currency, lines, deals, coupons, delivery, surchargeFor, loyaltyValue, loyaltyMaxShareBp }) => {
	const subtotal = lines.reduce((sum, line) => sum + line.unitAmount * line.quantity, 0);
	const itemDiscount = clampAmount(deals?.discount ?? 0, subtotal);
	const couponDiscount = clampAmount(coupons?.discount ?? 0, subtotal - itemDiscount);
	const merchandise = subtotal - itemDiscount - couponDiscount;
	const shipping = deliveryFee(delivery, merchandise);
	const freeShipping = Boolean(deals?.freeShipping || coupons?.freeShipping);
	const shippingDiscount = freeShipping
		? shipping
		: clampAmount((deals?.shippingDiscount ?? 0) + (coupons?.shippingDiscount ?? 0), shipping);
	const surcharge = Math.max(0, Math.floor(surchargeFor(merchandise)));
	const loyaltyAllowed = deals?.loyaltyAllowed !== false && coupons?.loyaltyAllowed !== false;
	const loyaltyCap = loyaltyAllowed ? applyBasisPoints(merchandise, Math.min(10_000, loyaltyMaxShareBp)) : 0;
	const loyalty = clampAmount(loyaltyValue, loyaltyCap);
	const total = Math.max(0, merchandise + shipping - shippingDiscount + surcharge - loyalty);
	return {
		totals: { currency, subtotal, itemDiscount, couponDiscount, shipping, shippingDiscount, surcharge, loyalty, tax: 0, total },
		loyaltyAllowed,
		loyaltyCap,
	};
};

/**
 * `amounts` of the standard order events (`order.placed@1`): discounts include the redeemed loyalty value; shipping is
 * net of its discount; the surcharge is part of the total.
 * @param {Totals} totals
 */
export const eventAmounts = (totals) => ({
	subtotal: totals.subtotal,
	discount: totals.itemDiscount + totals.couponDiscount + totals.loyalty,
	shipping: totals.shipping - totals.shippingDiscount,
	tax: totals.tax,
	total: totals.total,
});
