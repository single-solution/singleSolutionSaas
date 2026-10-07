/**
 * The offer engine ported from ibrahimMobiles (`offerEvaluator`, `offerMatching`, `offerScope` tests) on generic carts:
 * conditions, actions (percent bounds, fixed caps, free shipping, BXGY, tiered, gift), allocation, eligibility and the
 * stacking policy.
 */
import { describe, expect, it } from 'vitest';
import { actionUsesMoney, allocate, computeAction, percentFraction, roundMinor, tierFor } from '../core/actions.js';
import { cartSummary, normaliseCart } from '../core/cart.js';
import { countConditions, isCartOnly, isItemCondition, matchedLines, matchesCondition, usesMoney } from '../core/conditions.js';
import { evaluateCoupon } from '../core/evaluate.js';
import { applyStack, classesCombine, combinationRefusal, SINGLE_COUPON } from '../core/stacking.js';

const T = Date.parse('2026-10-01T10:00:00Z');
const BOUNDS = { rounding: 'round', maxPercent: 100, maxFixedAmount: 0 };

/** @param {Record<string, any>} [overrides] */
const cartOf = (overrides = {}) =>
	normaliseCart({
		currency: 'EUR',
		lines: [
			{
				lineId: 'phone',
				itemId: 'p1',
				variantId: 'v1',
				quantity: 1,
				unitAmount: 100_000,
				collections: ['phones'],
				attributes: { brand: 'apple', color: ['red', 'blue'] },
			},
			{ lineId: 'case', itemId: 'p2', quantity: 2, unitAmount: 2_000, collections: ['accessories'] },
		],
		shipping: 1_000,
		customer: { id: 'cus_1', orderCount: 0, segments: ['vip'] },
		paymentMethod: 'bank-transfer',
		deliveryMethod: 'courier',
		context: { country: 'PK', device: 'mobile', source: 'newsletter' },
		...overrides,
	});
/** @param {ReturnType<typeof cartOf>} cart */
const work = (cart) => cart.lines.map((line) => ({ ...line, remaining: line.amount }));

describe('cart', () => {
	it('normalises lines, totals, customer and context', () => {
		const cart = cartOf();
		expect(cart).toMatchObject({ subtotal: 104_000, quantity: 3, shipping: 1_000, paymentMethod: 'bank-transfer' });
		expect(cart.customer).toMatchObject({ id: 'cus_1', identified: true, orderCount: 0, segments: ['vip'] });
		expect(cartSummary(cart)).toEqual({ currency: 'EUR', subtotal: 104_000, quantity: 3, shipping: 1_000, lines: 2 });
		const anonymous = normaliseCart(
			{
				currency: 'EUR',
				lines: [{ itemId: 'x', quantity: 1, unitAmount: 5 }],
				customer: { id: 'cus_body', email: ' A@B.C ' },
			},
			{ customerId: null, identified: false },
		);
		expect(anonymous.customer).toMatchObject({ id: null, identified: false, email: 'a@b.c', orderCount: null });
		expect(anonymous.lines[0]).toMatchObject({ lineId: '1', variantId: null, attributes: {}, collections: [] });
		expect(normaliseCart({ currency: 'EUR', lines: [], customer: { country: 'DE' } }).context.country).toBe('DE');
	});
});

describe('conditions', () => {
	const cart = cartOf();
	const [phone, accessory] = cart.lines;
	it('matches line conditions (items, variants, collections, attributes, prices, quantities)', () => {
		expect(matchesCondition(phone ?? null, { type: 'items', operator: 'in', value: ['p1'] }, cart)).toBe(true);
		expect(matchesCondition(phone ?? null, { type: 'items', operator: 'not_in', value: ['p1'] }, cart)).toBe(false);
		expect(matchesCondition(phone ?? null, { type: 'variants', operator: 'in', value: ['v1'] }, cart)).toBe(true);
		expect(matchesCondition(accessory ?? null, { type: 'variants', operator: 'in', value: ['v1'] }, cart)).toBe(false);
		expect(matchesCondition(phone ?? null, { type: 'collections', operator: 'in', value: ['phones', 'x'] }, cart)).toBe(true);
		expect(
			matchesCondition(
				phone ?? null,
				{ type: 'attributes', operator: 'in', value: { key: 'brand', values: ['apple'] } },
				cart,
			),
		).toBe(true);
		expect(
			matchesCondition(phone ?? null, { type: 'attributes', operator: 'in', value: { key: 'color', values: ['blue'] } }, cart),
		).toBe(true);
		expect(
			matchesCondition(
				phone ?? null,
				{ type: 'attributes', operator: 'not_in', value: { key: 'color', values: ['red'] } },
				cart,
			),
		).toBe(false);
		expect(
			matchesCondition(phone ?? null, { type: 'attributes', operator: 'in', value: { key: 'size', values: ['m'] } }, cart),
		).toBe(false);
		expect(matchesCondition(phone ?? null, { type: 'attributes', operator: 'in', value: 'brand' }, cart)).toBe(false);
		expect(matchesCondition(phone ?? null, { type: 'unit_price', operator: 'between', value: [50_000, 100_000] }, cart)).toBe(
			true,
		);
		expect(matchesCondition(phone ?? null, { type: 'unit_price', operator: 'between', value: [1] }, cart)).toBe(false);
		expect(matchesCondition(accessory ?? null, { type: 'line_quantity', operator: 'gte', value: 2 }, cart)).toBe(true);
		expect(matchesCondition(accessory ?? null, { type: 'line_quantity', operator: 'lte', value: 1 }, cart)).toBe(false);
		expect(matchesCondition(accessory ?? null, { type: 'line_quantity', operator: 'eq', value: 2 }, cart)).toBe(false);
		expect(matchesCondition(null, { type: 'items', operator: 'in', value: ['p1'] }, cart)).toBe(false);
	});

	it('matches cart conditions (subtotal, payment, delivery, country, segments, first order, device, source)', () => {
		expect(matchesCondition(null, { type: 'subtotal', operator: 'gte', value: 104_000 }, cart)).toBe(true);
		expect(matchesCondition(null, { type: 'subtotal', operator: 'gte', value: 104_001 }, cart)).toBe(false);
		expect(matchesCondition(null, { type: 'cart_quantity', operator: 'gte', value: 3 }, cart)).toBe(true);
		expect(matchesCondition(null, { type: 'payment_method', operator: 'in', value: ['bank-transfer'] }, cart)).toBe(true);
		expect(matchesCondition(null, { type: 'payment_method', operator: 'in', value: ['cod'] }, cart)).toBe(false);
		expect(matchesCondition(null, { type: 'delivery_method', operator: 'not_in', value: ['pickup'] }, cart)).toBe(true);
		expect(matchesCondition(null, { type: 'country', operator: 'in', value: ['PK', 'AE'] }, cart)).toBe(true);
		expect(matchesCondition(null, { type: 'segments', operator: 'in', value: ['vip'] }, cart)).toBe(true);
		expect(matchesCondition(null, { type: 'segments', operator: 'not_in', value: ['wholesale'] }, cart)).toBe(true);
		expect(matchesCondition(null, { type: 'first_order', operator: 'eq', value: true }, cart)).toBe(true);
		expect(matchesCondition(null, { type: 'first_order', operator: 'eq', value: false }, cart)).toBe(false);
		expect(matchesCondition(null, { type: 'device', operator: 'in', value: ['mobile'] }, cart)).toBe(true);
		expect(matchesCondition(null, { type: 'source', operator: 'in', value: ['newsletter'] }, cart)).toBe(true);
		expect(matchesCondition(null, { type: 'unknown', operator: 'in', value: [] }, cart)).toBe(false);
		expect(matchesCondition(null, { type: 'subtotal', operator: 'gte', value: '5' }, cart)).toBe(false);
		expect(matchesCondition(null, { type: 'subtotal', operator: 'between', value: ['1', 2] }, cart)).toBe(false);
	});

	it('never matches missing data (ported: an unknown payment method fails in and not_in)', () => {
		const bare = cartOf({ paymentMethod: undefined, customer: {} });
		expect(matchesCondition(null, { type: 'payment_method', operator: 'in', value: ['cod'] }, bare)).toBe(false);
		expect(matchesCondition(null, { type: 'payment_method', operator: 'not_in', value: ['cod'] }, bare)).toBe(false);
		expect(matchesCondition(null, { type: 'first_order', operator: 'eq', value: true }, bare)).toBe(false);
		expect(matchesCondition(null, { type: 'payment_method', operator: 'between', value: ['cod'] }, cart)).toBe(false);
	});

	it('evaluates and/or groups recursively and classifies conditions', () => {
		const scenario = {
			type: 'group',
			operator: 'or',
			value: [
				{
					type: 'group',
					operator: 'and',
					value: [
						{ type: 'collections', operator: 'in', value: ['phones'] },
						{ type: 'unit_price', operator: 'gte', value: 50_000 },
					],
				},
				{ type: 'items', operator: 'in', value: ['p2'] },
			],
		};
		expect(matchesCondition(phone ?? null, scenario, cart)).toBe(true);
		expect(matchesCondition(accessory ?? null, scenario, cart)).toBe(true);
		expect(matchesCondition(phone ?? null, { type: 'group', operator: 'and', value: [] }, cart)).toBe(false);
		expect(matchesCondition(phone ?? null, { type: 'group', operator: 'xor', value: [scenario] }, cart)).toBe(false);
		expect(isItemCondition(scenario)).toBe(true);
		expect(isItemCondition({ type: 'group', operator: 'and', value: [{ type: 'subtotal', operator: 'gte', value: 1 }] })).toBe(
			false,
		);
		expect(isItemCondition({ type: 'group', operator: 'and', value: 'x' })).toBe(false);
		expect(isCartOnly([{ type: 'payment_method', operator: 'in', value: ['card'] }])).toBe(true);
		expect(countConditions([scenario, { type: 'subtotal', operator: 'gte', value: 1 }])).toBe(6);
		expect(usesMoney([scenario])).toBe(true);
		expect(usesMoney([{ type: 'group', operator: 'and', value: [{ type: 'items', operator: 'in', value: ['x'] }] }])).toBe(
			false,
		);
	});

	it('selects lines: item conditions per line, cart conditions on the whole cart (ported cartMatchesOffer)', () => {
		expect(matchedLines([], cart).map((line) => line.lineId)).toEqual(['phone', 'case']);
		expect(matchedLines([{ type: 'collections', operator: 'in', value: ['accessories'] }], cart).map((l) => l.lineId)).toEqual([
			'case',
		]);
		expect(matchedLines([{ type: 'subtotal', operator: 'gte', value: 50_000 }], cart)).toHaveLength(2);
		expect(matchedLines([{ type: 'subtotal', operator: 'gte', value: 500_000 }], cart)).toHaveLength(0);
		const mixed = [
			{ type: 'collections', operator: 'in', value: ['phones'] },
			{ type: 'payment_method', operator: 'in', value: ['bank-transfer'] },
		];
		expect(matchedLines(mixed, cart).map((line) => line.lineId)).toEqual(['phone']);
		expect(matchedLines(mixed, cartOf({ paymentMethod: 'card' }))).toEqual([]);
	});
});

describe('actions', () => {
	const cart = cartOf();
	const all = new Set(['phone', 'case']);
	const phoneOnly = new Set(['phone']);
	const input = (/** @type {Set<string>} */ matched, extra = {}) => ({
		lines: work(cart),
		matched,
		shipping: cart.shipping,
		bounds: BOUNDS,
		...extra,
	});

	it('clamps percentages to 0–100 % and rounds once', () => {
		expect(percentFraction(150)).toBe(1);
		expect(percentFraction(-5)).toBe(0);
		expect(percentFraction(Number.NaN)).toBe(0);
		expect(percentFraction('10')).toBe(0);
		expect(percentFraction(50, 20)).toBe(0.2);
		expect(roundMinor(74.925, 'round')).toBe(75);
		expect(roundMinor(74.925, 'floor')).toBe(74);
		expect(roundMinor(74.2, 'ceil')).toBe(75);
		expect(roundMinor(-3, 'round')).toBe(0);
		expect(computeAction({ type: 'percent', percent: 10, target: 'matched' }, input(phoneOnly))).toMatchObject({
			discount: 10_000,
			lines: [{ lineId: 'phone', amount: 10_000 }],
		});
		expect(computeAction({ type: 'percent', percent: 150, target: 'matched' }, input(phoneOnly)).discount).toBe(100_000);
		expect(computeAction({ type: 'percent', percent: 10, target: 'order' }, input(phoneOnly)).discount).toBe(10_400);
		expect(computeAction({ type: 'percent', percent: 10, target: 'order', max_discount: 5_000 }, input(all)).discount).toBe(
			5_000,
		);
		expect(
			computeAction({ type: 'percent', percent: 50 }, input(all, { bounds: { ...BOUNDS, maxPercent: 20 } })).discount,
		).toBe(20_800);
	});

	it('keeps fractional percentages exact until the one rounding (ported test)', () => {
		const small = normaliseCart({ currency: 'EUR', lines: [{ lineId: 'a', itemId: 'a', quantity: 1, unitAmount: 999 }] });
		const result = computeAction(
			{ type: 'percent', percent: 7.5 },
			{ lines: work(small), matched: new Set(['a']), shipping: 0, bounds: BOUNDS },
		);
		expect(result.discount).toBe(75);
		expect(
			computeAction(
				{ type: 'percent', percent: 7.5 },
				{ lines: work(small), matched: new Set(['a']), shipping: 0, bounds: { ...BOUNDS, rounding: 'floor' } },
			).discount,
		).toBe(74);
	});

	it('caps fixed amounts at what they apply to (per unit or once)', () => {
		expect(computeAction({ type: 'fixed', amount: 500, per_unit: true }, input(new Set(['case']))).lines).toEqual([
			{ lineId: 'case', amount: 1_000 },
		]);
		expect(computeAction({ type: 'fixed', amount: 3_000, per_unit: true }, input(new Set(['case']))).discount).toBe(4_000);
		expect(computeAction({ type: 'fixed', amount: 200_000, target: 'order' }, input(all)).discount).toBe(104_000);
		expect(computeAction({ type: 'fixed', amount: 1_000, target: 'order' }, input(all)).lines).toEqual([
			{ lineId: 'phone', amount: 962 },
			{ lineId: 'case', amount: 38 },
		]);
		expect(
			computeAction({ type: 'fixed', amount: 9_000 }, input(all, { bounds: { ...BOUNDS, maxFixedAmount: 1_000 } })).discount,
		).toBe(1_000);
		expect(
			computeAction(
				{ type: 'fixed', amount: 900, per_unit: true },
				input(new Set(['case']), { bounds: { ...BOUNDS, maxFixedAmount: 100 } }),
			).discount,
		).toBe(200);
	});

	it('flags free shipping (capped by max_amount) and gives nothing for unknown types', () => {
		expect(computeAction({ type: 'free_shipping' }, input(all))).toMatchObject({
			discount: 0,
			shippingDiscount: 1_000,
			freeShipping: true,
		});
		expect(computeAction({ type: 'free_shipping', max_amount: 300 }, input(all)).shippingDiscount).toBe(300);
		expect(computeAction({ type: 'mystery' }, input(all)).discount).toBe(0);
	});

	it('buy X get Y gives the cheapest units of each group', () => {
		const socks = normaliseCart({
			currency: 'EUR',
			lines: [
				{ lineId: 'a', itemId: 'a', quantity: 3, unitAmount: 1_000 },
				{ lineId: 'b', itemId: 'b', quantity: 2, unitAmount: 400 },
				{ lineId: 'c', itemId: 'c', quantity: 1, unitAmount: 9_999 },
			],
		});
		const run = (/** @type {Record<string, any>} */ action, matched = new Set(['a', 'b'])) =>
			computeAction(action, { lines: work(socks), matched, shipping: 0, bounds: BOUNDS });
		// 5 units (1000 ×3, 400 ×2): one group of 2+1 → the cheapest unit (400) free
		expect(run({ type: 'bxgy', buy: 2, get: 1 })).toMatchObject({ discount: 400, lines: [{ lineId: 'b', amount: 400 }] });
		expect(run({ type: 'bxgy', buy: 1, get: 1 }).discount).toBe(800);
		expect(run({ type: 'bxgy', buy: 1, get: 1, max_applications: 1 }).discount).toBe(400);
		expect(run({ type: 'bxgy', buy: 1, get: 1, percent: 50 }).discount).toBe(400);
		expect(run({ type: 'bxgy', buy: 5, get: 1 }).discount).toBe(0);
	});

	it('tiered discounts pick the highest tier reached by quantity or subtotal', () => {
		const tiers = {
			type: 'tiered',
			basis: 'quantity',
			target: 'order',
			tiers: [
				{ min: 2, percent: 5 },
				{ min: 3, percent: 10 },
				{ min: 10, percent: 50 },
			],
		};
		expect(tierFor(tiers, work(cart))).toEqual({ min: 3, percent: 10 });
		expect(computeAction(tiers, input(all)).discount).toBe(10_400);
		const bySubtotal = {
			type: 'tiered',
			basis: 'subtotal',
			target: 'matched',
			tiers: [
				{ min: 1_000, amount: 100 },
				{ min: 200_000, amount: 9_000 },
			],
		};
		expect(computeAction(bySubtotal, input(new Set(['case']))).discount).toBe(100);
		expect(computeAction({ ...bySubtotal, tiers: [{ min: 999_999, amount: 1 }] }, input(all)).discount).toBe(0);
		expect(tierFor({ tiers: 'x' }, work(cart))).toBeNull();
	});

	it('gift items: reported, and free when they are in the cart', () => {
		const gift = computeAction({ type: 'gift', item_id: 'p2', quantity: 1 }, input(all));
		expect(gift).toMatchObject({ discount: 2_000, gifts: [{ itemId: 'p2', variantId: null, quantity: 1 }] });
		expect(computeAction({ type: 'gift', item_id: 'p2', quantity: 5 }, input(all)).discount).toBe(4_000);
		expect(computeAction({ type: 'gift', item_id: 'p2', discount_in_cart: false }, input(all))).toMatchObject({
			discount: 0,
			gifts: [{ itemId: 'p2' }],
		});
		expect(computeAction({ type: 'gift', item_id: 'p1', variant_id: 'v9' }, input(all)).discount).toBe(0);
		expect(computeAction({ type: 'gift', item_id: 'zzz' }, input(all))).toMatchObject({
			discount: 0,
			gifts: [{ itemId: 'zzz', quantity: 1 }],
		});
	});

	it('allocates with the largest remainder and never over the remaining amounts', () => {
		const lines = [
			{ lineId: 'a', itemId: 'a', variantId: null, quantity: 1, unitAmount: 1, remaining: 1 },
			{ lineId: 'b', itemId: 'b', variantId: null, quantity: 1, unitAmount: 1, remaining: 1 },
			{ lineId: 'c', itemId: 'c', variantId: null, quantity: 1, unitAmount: 1, remaining: 1 },
		];
		expect(allocate(2, lines)).toEqual([
			{ lineId: 'a', amount: 1 },
			{ lineId: 'b', amount: 1 },
		]);
		expect(allocate(10, lines).reduce((sum, share) => sum + share.amount, 0)).toBe(3);
		expect(allocate(0, lines)).toEqual([]);
		expect(allocate(5, [])).toEqual([]);
	});

	it('knows which actions read money', () => {
		expect(actionUsesMoney({ type: 'fixed', amount: 1 })).toBe(true);
		expect(actionUsesMoney({ type: 'percent', percent: 1 })).toBe(false);
		expect(actionUsesMoney({ type: 'percent', percent: 1, max_discount: 5 })).toBe(true);
		expect(actionUsesMoney({ type: 'free_shipping', max_amount: 5 })).toBe(true);
		expect(actionUsesMoney({ type: 'tiered', basis: 'quantity', tiers: [{ min: 1, percent: 5 }] })).toBe(false);
		expect(actionUsesMoney({ type: 'tiered', basis: 'quantity', tiers: [{ min: 1, amount: 5 }] })).toBe(true);
		expect(actionUsesMoney({ type: 'tiered', basis: 'subtotal', tiers: [] })).toBe(true);
	});
});

describe('evaluateCoupon', () => {
	const settings = {
		timeZone: 'UTC',
		allowedTypes: ['percent', 'fixed', 'free_shipping', 'bxgy', 'tiered', 'gift'],
		requireIdentity: true,
		stackingDefaults: { class: 'order', withLoyalty: true, withDeals: true },
	};
	/** @param {Record<string, any>} [overrides] */
	const coupon = (overrides = {}) => ({
		id: 'cpn_1',
		name: 'Phones',
		status: 'active',
		currency: 'EUR',
		action: { type: 'percent', percent: 10 },
		eligibility: { when: '', conditions: [{ type: 'collections', operator: 'in', value: ['phones'] }] },
		limits: {},
		counters: { taken: 0 },
		...overrides,
	});
	const code = { code: 'PHONES', status: 'active', taken: 0, maxUses: null };
	const run = (/** @type {Record<string, any>} */ c, /** @type {Record<string, any>} */ k = code, cart = cartOf()) =>
		evaluateCoupon({ coupon: c, code: k, cart, now: T, settings });

	it('returns a candidate with the matched lines and stacking metadata', () => {
		const result = run(coupon({ stacking: { class: 'item', exclusive: true, priority: 3, with_loyalty: false } }));
		if (!result.ok) throw new Error(result.reason);
		expect([...result.candidate.matched]).toEqual(['phone']);
		expect(result.candidate).toMatchObject({
			class: 'item',
			exclusive: true,
			priority: 3,
			withLoyalty: false,
			withDeals: true,
		});
		const defaults = run(coupon());
		expect(defaults.ok && defaults.candidate).toMatchObject({
			class: 'order',
			exclusive: false,
			priority: 0,
			withLoyalty: true,
		});
	});

	it('refuses with stable reasons', () => {
		expect(run(coupon({ status: 'paused' }))).toEqual({ ok: false, reason: 'coupon_inactive' });
		expect(run(coupon(), { ...code, status: 'disabled' })).toEqual({ ok: false, reason: 'code_disabled' });
		expect(run(coupon(), { ...code, maxUses: 1, taken: 1 })).toEqual({ ok: false, reason: 'exhausted' });
		expect(run(coupon({ limits: { total: 5 }, counters: { taken: 5 } }))).toEqual({ ok: false, reason: 'exhausted' });
		expect(run(coupon({ validity: { ends_at: '2026-01-01T00:00:00Z' } }))).toEqual({ ok: false, reason: 'ended' });
		expect(run(coupon({ currency: 'USD', action: { type: 'fixed', amount: 10 } }))).toEqual({
			ok: false,
			reason: 'currency_mismatch',
		});
		expect(run(coupon({ currency: 'USD' })).ok).toBe(true); // percent of any currency
		const anonymous = cartOf({ customer: {} });
		expect(
			run(
				coupon({ limits: { per_customer: 1 } }),
				code,
				normaliseCart(
					{
						...cartOf(),
						lines: [{ lineId: 'phone', itemId: 'p1', quantity: 1, unitAmount: 1, collections: ['phones'] }],
						customer: {},
					},
					{ customerId: null, identified: false },
				),
			),
		).toEqual({ ok: false, reason: 'identity_required' });
		expect(anonymous.customer.identified).toBe(false);
		expect(run(coupon({ action: { type: 'gift', item_id: 'x' } }), code, cartOf()).ok).toBe(true);
		expect(
			evaluateCoupon({ coupon: coupon(), code, cart: cartOf(), now: T, settings: { ...settings, allowedTypes: ['fixed'] } }),
		).toEqual({ ok: false, reason: 'action_unavailable' });
		expect(run(coupon({ eligibility: { conditions: [{ type: 'collections', operator: 'in', value: ['tablets'] }] } }))).toEqual(
			{ ok: false, reason: 'not_eligible' },
		);
	});

	it('honours the rules@1 condition (an error means not eligible)', () => {
		expect(
			run(
				coupon({
					eligibility: { when: "cart.subtotal >= 100000 and inSegment('vip') and customer.orderCount == 0", conditions: [] },
				}),
			).ok,
		).toBe(true);
		expect(run(coupon({ eligibility: { when: 'paymentMethod == "cod"', conditions: [] } }))).toEqual({
			ok: false,
			reason: 'not_eligible',
		});
		expect(run(coupon({ eligibility: { when: 'cart.subtotal >=', conditions: [] } }))).toEqual({
			ok: false,
			reason: 'not_eligible',
		});
		expect(
			run(coupon({ eligibility: { when: "coupon.code == 'PHONES' and context.country == 'PK'", conditions: [] } })).ok,
		).toBe(true);
	});
});

describe('stacking', () => {
	const cart = cartOf();
	/**
	 * @param {Record<string, any>} overrides
	 * @returns {import('../core/evaluate.js').Candidate}
	 */
	const candidate = (overrides) => ({
		couponId: overrides.code,
		code: overrides.code,
		index: 0,
		action: { type: 'percent', percent: 10, target: 'order' },
		matched: new Set(['phone', 'case']),
		class: 'order',
		exclusive: false,
		priority: 0,
		withLoyalty: true,
		withDeals: true,
		name: overrides.code,
		...overrides,
	});
	const policy = {
		maxCoupons: 3,
		classes: [
			{ key: 'item', combines_with: ['order', 'shipping'] },
			{ key: 'order', combines_with: ['shipping'] },
			{ key: 'shipping', combines_with: [] },
		],
		allowSameClass: false,
		strategy: /** @type {const} */ ('in_order'),
	};

	it('combines classes either way and refuses exclusive, duplicate and excess coupons', () => {
		expect(classesCombine('order', 'item', policy)).toBe(true);
		expect(classesCombine('shipping', 'order', policy)).toBe(true);
		expect(classesCombine('order', 'order', policy)).toBe(false);
		expect(classesCombine('order', 'order', { ...policy, allowSameClass: true })).toBe(true);
		expect(classesCombine('custom', 'order', policy)).toBe(false);
		const a = candidate({ code: 'A' });
		expect(combinationRefusal(candidate({ code: 'A' }), [a], policy)).toBe('duplicate_coupon');
		expect(combinationRefusal(candidate({ code: 'B', exclusive: true }), [a], policy)).toBe('not_combinable');
		expect(
			combinationRefusal(candidate({ code: 'B', class: 'item' }), [candidate({ code: 'X', exclusive: true })], policy),
		).toBe('not_combinable');
		expect(combinationRefusal(candidate({ code: 'B' }), [a], SINGLE_COUPON)).toBe('too_many_coupons');
		expect(combinationRefusal(candidate({ code: 'B', class: 'item' }), [a], policy)).toBeNull();
	});

	it('applies item discounts before order discounts (the order coupon sees the post-item total)', () => {
		const result = applyStack({
			cart,
			candidates: [
				candidate({ code: 'ORDER10', index: 0 }),
				candidate({
					code: 'PHONE10',
					index: 1,
					class: 'item',
					action: { type: 'percent', percent: 10, target: 'matched' },
					matched: new Set(['phone']),
				}),
				candidate({ code: 'SHIP', index: 2, class: 'shipping', action: { type: 'free_shipping' }, withLoyalty: false }),
			],
			policy,
			bounds: BOUNDS,
		});
		expect(result.applied.map((c) => c.code)).toEqual(['PHONE10', 'ORDER10', 'SHIP']);
		expect(result).toMatchObject({
			discount: 10_000 + 9_400,
			shippingDiscount: 1_000,
			total: 104_000 - 19_400,
			freeShipping: true,
			loyaltyAllowed: false,
			dealsAllowed: true,
		});
		expect(result.lines).toEqual([
			{ lineId: 'phone', discount: 10_000 + 9_000 },
			{ lineId: 'case', discount: 400 },
		]);
	});

	it('best_discount ranks codes by their standalone value; zero-value coupons are dropped', () => {
		const result = applyStack({
			cart,
			candidates: [
				candidate({ code: 'SMALL', index: 0, action: { type: 'fixed', amount: 100, target: 'order' } }),
				candidate({ code: 'BIG', index: 1, action: { type: 'percent', percent: 20, target: 'order' } }),
				candidate({ code: 'NOTHING', index: 2, class: 'item', action: { type: 'bxgy', buy: 5, get: 1 } }),
			],
			policy: { ...policy, strategy: 'best_discount' },
			bounds: BOUNDS,
		});
		expect(result.applied.map((c) => c.code)).toEqual(['BIG']);
		expect(result.rejected).toEqual([
			{ code: 'SMALL', couponId: 'SMALL', reason: 'not_combinable' },
			{ code: 'NOTHING', couponId: 'NOTHING', reason: 'no_discount' },
		]);
	});
});
