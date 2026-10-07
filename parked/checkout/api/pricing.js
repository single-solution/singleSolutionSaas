/**
 * Checkout quote: the server's totals for priced lines, a delivery method, a payment method, coupon codes and loyalty
 * points. Deals, coupons and points come from those products' public APIs (server to server, the merchant's own key);
 * when one does not answer, checkout goes on without it and says so (`warnings`). The same function prices the
 * placement, so what the shopper saw and what the order stores cannot drift apart — and the client's numbers are
 * never used.
 */
import { resolveForm } from '../core/form.js';
import { codSurcharge, paymentOptions } from '../core/payments.js';
import { chooseOffers, computeTotals, couponsFrom, dealsFrom, linesAfterDeals } from '../core/pricing.js';

/** @typedef {import('./context.js').Site} Site */
/** @typedef {import('./context.js').Checkout} Checkout */
/**
 * @typedef {object} QuoteInput
 * @property {Array<import('../core/items.js').PricedLine & { lineId: string }>} lines
 * @property {string[]} codes
 * @property {number} loyaltyPoints
 * @property {string | null} deliveryMethod
 * @property {string | null} paymentMethod
 * @property {string | null} country
 * @property {string | null} subject identity subject
 * @property {string | null} [cartId]
 * @property {string} [idempotencyKey] stable key of a placement (the Deals quote is stored under it)
 */

/**
 * @param {Checkout} checkout
 */
export const createPricing = (checkout) => {
	const { app, integrations } = checkout;

	/**
	 * Points → value from a Loyalty quote (`pointValue: { points, value }`), checked against its min / max.
	 * @param {any} quote
	 * @param {number} points
	 * @returns {{ ok: true, value: number } | { ok: false, reason: string }}
	 */
	const pointsValue = (quote, points) => {
		if (!quote?.allowed) return { ok: false, reason: typeof quote?.reason === 'string' ? quote.reason : 'not_allowed' };
		const per = quote.pointValue;
		if (!Number.isSafeInteger(per?.points) || per.points <= 0 || !Number.isSafeInteger(per?.value))
			return { ok: false, reason: 'not_allowed' };
		if (points < (quote.minPoints ?? 0)) return { ok: false, reason: 'below_minimum' };
		if (points > (quote.maxPoints ?? 0)) return { ok: false, reason: 'above_maximum' };
		return { ok: true, value: Math.floor((points * per.value) / per.points) };
	};

	/**
	 * @param {Site} site
	 * @param {QuoteInput} input
	 */
	const quote = async (site, input) => {
		const { settings } = site;
		const currency = /** @type {string} */ (settings.currency);
		const t = checkout.translator(settings.language);
		const conns = await checkout.connectionsFor(site);
		/** @type {string[]} */
		const warnings = [];
		const form = resolveForm(settings.form, { country: input.country, t });
		const delivery = input.deliveryMethod ? (form.deliveryMethods.find((m) => m.key === input.deliveryMethod) ?? null) : null;
		const listSubtotal = input.lines.reduce((sum, line) => sum + line.unitAmount * line.quantity, 0);
		const fee =
			delivery && delivery.fee > 0 && !(delivery.free_over > 0 && listSubtotal >= delivery.free_over) ? delivery.fee : 0;
		const cartLines = (/** @type {typeof input.lines} */ lines) =>
			lines.map((line) => ({
				lineId: line.lineId,
				itemId: line.itemId,
				...(line.variantId ? { variantId: line.variantId } : {}),
				quantity: line.quantity,
				unitAmount: line.unitAmount,
				...(line.collections.length > 0 ? { collections: line.collections } : {}),
			}));

		// automatic deals on list prices
		/** @type {import('../core/pricing.js').DealsResult | null} */
		let deals = null;
		if (conns.deals) {
			const result = await integrations.deals.quote(
				conns.deals,
				{
					currency,
					...(input.cartId ? { cartId: input.cartId } : {}),
					lines: cartLines(input.lines),
					...(input.subject ? { customer: { id: input.subject.slice(0, 128) } } : {}),
					...(input.paymentMethod ? { paymentMethod: input.paymentMethod } : {}),
					...(delivery ? { deliveryMethod: delivery.key } : {}),
					shippingAmount: fee,
				},
				input.idempotencyKey ? `${input.idempotencyKey}:deals-quote` : app.randomId('idk'),
			);
			if (result.ok) deals = dealsFrom(result.json);
			else warnings.push('deals_unavailable');
		}

		// coupon codes on the prices after deals (and on list prices when the two may not combine)
		/** @type {import('../core/pricing.js').CouponsResult | null} */
		let couponsOnDeals = null;
		/** @type {import('../core/pricing.js').CouponsResult | null} */
		let couponsOnList = null;
		/** @type {Array<{ code: string, reason: string }>} */
		let rejected = [];
		if (input.codes.length > 0) {
			if (!conns.coupons) rejected = input.codes.map((code) => ({ code, reason: 'coupons_unavailable' }));
			else {
				/** @param {typeof input.lines} lines */
				const ask = async (lines) => {
					const result = await integrations.coupons.quote(conns.coupons, {
						codes: input.codes,
						cart: {
							currency,
							lines: cartLines(lines),
							shipping: fee,
							...(input.subject ? { customer: { id: input.subject.slice(0, 128) } } : {}),
							...(input.paymentMethod ? { paymentMethod: input.paymentMethod } : {}),
							...(delivery ? { deliveryMethod: delivery.key } : {}),
							...(input.country ? { context: { country: input.country } } : {}),
						},
					});
					if (result.ok) return couponsFrom(result.json);
					warnings.push('coupons_unavailable');
					return null;
				};
				couponsOnDeals = await ask(deals ? linesAfterDeals(input.lines, deals) : input.lines);
				if (deals && couponsOnDeals && (!deals.couponsAllowed || !couponsOnDeals.dealsAllowed))
					couponsOnList = await ask(input.lines);
				const reference = couponsOnDeals ?? couponsOnList;
				rejected = reference
					? [
							...reference.rejected,
							...input.codes
								.filter((code) => !reference.applied.some((a) => a.code.toUpperCase() === code.toUpperCase()))
								.filter((code) => !reference.rejected.some((r) => r.code.toUpperCase() === code.toUpperCase()))
								.map((code) => ({ code, reason: 'not_applied' })),
						]
					: input.codes.map((code) => ({ code, reason: 'coupons_unavailable' }));
			}
		}
		const chosen = chooseOffers({ deals, couponsOnDeals, couponsOnList, precedence: settings.offers.precedence });
		if (chosen.dropped === 'coupons' && chosen.deals)
			rejected = [...rejected, ...(couponsOnDeals?.applied ?? []).map((a) => ({ code: a.code, reason: 'not_combinable' }))];

		const manual = settings.enabled('payment_manual') ? settings.manual : null;
		const surchargeFor = (/** @type {number} */ merchandise) =>
			input.paymentMethod === 'cod' && manual ? codSurcharge(manual, merchandise) : 0;
		const base = computeTotals({
			currency,
			lines: input.lines,
			deals: chosen.deals,
			coupons: chosen.coupons,
			delivery,
			surchargeFor: () => 0,
			loyaltyValue: 0,
			loyaltyMaxShareBp: settings.loyalty.max_share_bp,
		});
		const merchandise = base.totals.subtotal - base.totals.itemDiscount - base.totals.couponDiscount;

		// loyalty points
		/** @type {{ points: number, value: number, refused: string | null, quote: any }} */
		const loyalty = { points: 0, value: 0, refused: null, quote: null };
		if (input.loyaltyPoints > 0) {
			if (!conns.loyalty) loyalty.refused = 'loyalty_unavailable';
			else if (!input.subject) loyalty.refused = 'identity_required';
			else if (!base.loyaltyAllowed) loyalty.refused = 'not_combinable';
			else {
				const result = await integrations.loyalty.quote(conns.loyalty, {
					customerId: input.subject.slice(0, 128),
					amount: merchandise,
					currency,
					discount: 0,
				});
				if (!result.ok) {
					loyalty.refused = 'loyalty_unavailable';
					warnings.push('loyalty_unavailable');
				} else {
					loyalty.quote = result.json;
					const checked = pointsValue(result.json, input.loyaltyPoints);
					if (checked.ok) {
						loyalty.points = input.loyaltyPoints;
						loyalty.value = Math.min(checked.value, base.loyaltyCap);
					} else loyalty.refused = checked.reason;
				}
			}
		}

		const priced = computeTotals({
			currency,
			lines: input.lines,
			deals: chosen.deals,
			coupons: chosen.coupons,
			delivery,
			surchargeFor,
			loyaltyValue: loyalty.value,
			loyaltyMaxShareBp: settings.loyalty.max_share_bp,
		});
		const options = paymentOptions(
			{ manual, gatewayEnabled: settings.enabled('payment_gateway') },
			{
				subtotal: merchandise,
				total: priced.totals.total - priced.totals.surcharge,
				currency,
				deliveryKind: delivery?.kind ?? null,
				deliveryMethod: delivery?.key ?? null,
				signedIn: Boolean(input.subject),
				country: form.country,
				quantity: input.lines.reduce((sum, line) => sum + line.quantity, 0),
			},
			{ now: app.now(), timeZone: settings.timeZone },
		);
		return {
			currency,
			totals: priced.totals,
			delivery,
			form,
			deals: chosen.deals,
			coupons: chosen.coupons,
			dropped: chosen.dropped,
			rejected,
			loyalty,
			options,
			warnings: [...new Set(warnings)],
		};
	};

	return Object.freeze({ quote, pointsValue });
};

/** @typedef {ReturnType<typeof createPricing>} Pricing */
/** @typedef {Awaited<ReturnType<Pricing['quote']>>} Quote */

/**
 * Public view of a quote.
 * @param {Quote} q
 */
export const quoteView = (q) => ({
	currency: q.currency,
	totals: q.totals,
	deliveryMethod: q.delivery ? { key: q.delivery.key, kind: q.delivery.kind, label: q.delivery.label } : null,
	deals: (q.deals?.deals ?? []).map((deal) => ({ name: deal.name, amount: deal.amount })),
	codes: {
		applied: (q.coupons?.applied ?? []).map((a) => ({ code: a.code, name: a.name, discount: a.discount })),
		rejected: q.rejected,
	},
	loyalty: { points: q.loyalty.points, value: q.loyalty.value, refused: q.loyalty.refused },
	paymentMethods: q.options,
	warnings: q.warnings,
});
