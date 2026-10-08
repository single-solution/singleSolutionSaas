/**
 * Promotions pricing (pure): deals, bundles and buy X get Y, how they stack, coupons after them, the product quote,
 * the loyalty rules and the checks of what the merchant writes.
 */
import { describe, expect, it } from 'vitest';
import { bundleView, checkBundleInput, formBundles, MAX_SETS, nextSet } from '../core/bundles.js';
import {
	BATCH_ALPHABET,
	checkBatchInput,
	checkCouponInput,
	couponBlocked,
	couponView,
	drawCode,
	normaliseCode,
} from '../core/coupons.js';
import { bestDeal, byShowOrder, checkDealInput, dealUnitDiscount, dealView, publicDeal } from '../core/deals.js';
import {
	expiringSoon,
	expiryFor,
	historyView,
	LOYALTY_DEFAULTS,
	loyaltyRules,
	maxRedeemable,
	pointsToEarn,
	pointsValue,
} from '../core/loyalty.js';
import { applyPromotions, quoteProduct } from '../core/promotions.js';
import { checkDate, checkScope, checkText, checkWhole, gather, inScope, isLive, phaseOf } from '../core/promotions-rules.js';

const NOW = Date.parse('2026-10-05T10:00:00Z');
const DAY = 86_400_000;
const empty = () => ({
	productIds: /** @type {string[]} */ ([]),
	categoryIds: /** @type {string[]} */ ([]),
	brandIds: /** @type {string[]} */ ([]),
});

/** @param {Partial<import('../core/promotions.js').PricingLine>} [o] @returns {import('../core/promotions.js').PricingLine} */
const line = (o = {}) => ({
	key: `${o.productId ?? 'p1'}|${o.variantId ?? 'v1'}`,
	productId: 'p1',
	variantId: 'v1',
	categoryIds: [],
	brandId: null,
	unitPrice: 1000,
	quantity: 1,
	...o,
});
/** @param {Partial<import('../core/model.js').DealRecord>} [o] @returns {import('../core/model.js').DealRecord} */
const deal = (o = {}) => ({
	id: 'deal_1',
	name: 'Deal',
	description: '',
	type: 'percent',
	value: 10,
	scope: empty(),
	startsAt: null,
	endsAt: null,
	limit: null,
	used: 0,
	priority: 0,
	active: true,
	...o,
});
/** @param {Partial<import('../core/model.js').BundleRecord>} [o] @returns {import('../core/model.js').BundleRecord} */
const bundle = (o = {}) => ({
	id: 'bnd_1',
	name: 'Bundle',
	type: 'bundle',
	items: [],
	price: null,
	buy: 0,
	get: 0,
	scope: empty(),
	getScope: empty(),
	value: 0,
	startsAt: null,
	endsAt: null,
	limit: null,
	used: 0,
	active: true,
	...o,
});
/** @param {Partial<import('../core/model.js').CouponRecord>} [o] @returns {import('../core/model.js').CouponRecord} */
const coupon = (o = {}) => ({
	id: 'cpn_1',
	code: 'SAVE10',
	type: 'percent',
	value: 10,
	maxDiscount: null,
	minSubtotal: 0,
	scope: empty(),
	startsAt: null,
	endsAt: null,
	limit: null,
	used: 0,
	perCustomer: null,
	firstOrderOnly: false,
	active: true,
	...o,
});
/** @param {Partial<Parameters<typeof applyPromotions>[0]>} o */
const run = (o) =>
	applyPromotions({
		lines: [],
		deals: [],
		bundles: [],
		coupon: null,
		couponCode: '',
		customer: { orderCount: 0, couponUses: 0 },
		now: NOW,
		...o,
	});

describe('offer rules', () => {
	it('knows the phase of an offer and whether it is live', () => {
		expect(phaseOf({ startsAt: new Date(NOW + 1), endsAt: null }, NOW)).toBe('not_started');
		expect(phaseOf({ startsAt: null, endsAt: new Date(NOW) }, NOW)).toBe('ended');
		expect(phaseOf({ startsAt: new Date(NOW), endsAt: new Date(NOW + 1) }, NOW)).toBe('live');
		expect(isLive(deal({ limit: 2, used: 2 }), NOW)).toBe(false);
		expect(isLive(deal({ limit: 2, used: 1 }), NOW)).toBe(true);
		expect(isLive(deal({ active: false }), NOW)).toBe(false);
	});

	it('matches scopes by product, category (with ancestors) or brand', () => {
		const item = { productId: 'p1', categoryIds: ['c1', 'c0'], brandId: 'b1' };
		expect(inScope(item, empty())).toBe(true);
		expect(inScope(item, { ...empty(), productIds: ['p1'] })).toBe(true);
		expect(inScope(item, { ...empty(), categoryIds: ['c0'] })).toBe(true);
		expect(inScope(item, { ...empty(), brandIds: ['b1'] })).toBe(true);
		expect(inScope({ ...item, brandId: null }, { ...empty(), brandIds: ['b1'] })).toBe(false);
		expect(inScope(item, { ...empty(), productIds: ['p2'] })).toBe(false);
	});

	it('checks the shared input fields', () => {
		expect(checkScope(null, 'scope')).toEqual({ ok: true, value: empty() });
		expect(checkScope('x', 'scope').ok).toBe(false);
		expect(checkScope({ productIds: [1] }, 'scope')).toMatchObject({ ok: false, field: 'scope/productIds' });
		expect(checkScope({ productIds: ['a', 'a'] }, 'scope')).toMatchObject({ ok: true, value: { productIds: ['a'] } });
		expect(checkDate('nope', 'startsAt').ok).toBe(false);
		expect(checkDate(5, 'startsAt').ok).toBe(false);
		expect(checkDate(new Date(NOW), 'startsAt')).toEqual({ ok: true, value: new Date(NOW) });
		expect(checkDate('', 'startsAt')).toEqual({ ok: true, value: null });
		expect(checkWhole(null, 'limit', { min: 1, max: 5, nullable: true })).toEqual({ ok: true, value: null });
		expect(checkWhole(9, 'limit', { min: 1, max: 5 }).ok).toBe(false);
		expect(checkText(3, 'name', { min: 1, max: 5 }).ok).toBe(false);
		expect(checkText('  ', 'name', { min: 1, max: 5 }).ok).toBe(false);
		expect(gather([['a', () => ({ ok: true, value: 1 })]])).toEqual({ ok: true, value: { a: 1 } });
	});
});

describe('deals', () => {
	it('takes a percent off each unit of a line', () => {
		const result = run({ lines: [line({ quantity: 2 })], deals: [deal()] });
		expect(result.lines).toEqual([{ key: 'p1|v1', dealId: 'deal_1', dealDiscount: 200, bundleDiscount: 0, couponDiscount: 0 }]);
		expect(result.dealIds).toEqual(['deal_1']);
		expect(result.applied).toEqual([{ id: 'deal_1', name: 'Deal', kind: 'deal', amount: 200 }]);
		expect(result.couponProblem).toBeNull();
		expect(result.couponCode).toBe('');
	});

	it('picks the best single deal per line: largest saving, then priority, then id', () => {
		const lines = [line()];
		expect(run({ lines, deals: [deal(), deal({ id: 'deal_2', type: 'fixed', value: 150 })] }).lines[0]?.dealId).toBe('deal_2');
		expect(run({ lines, deals: [deal({ priority: 1 }), deal({ id: 'deal_0', priority: 5 })] }).lines[0]?.dealId).toBe('deal_0');
		expect(run({ lines, deals: [deal({ id: 'deal_b' }), deal({ id: 'deal_a' })] }).lines[0]?.dealId).toBe('deal_a');
		expect(run({ lines, deals: [deal({ id: 'deal_a' }), deal({ id: 'deal_b' })] }).lines[0]?.dealId).toBe('deal_a');
		expect(
			run({ lines, deals: [deal({ id: 'deal_a', priority: 5 }), deal({ id: 'deal_b', priority: 1 })] }).lines[0]?.dealId,
		).toBe('deal_a');
	});

	it('never takes more than the price and skips deals that are not live or not in scope', () => {
		expect(run({ lines: [line()], deals: [deal({ type: 'fixed', value: 5000 })] }).lines[0]?.dealDiscount).toBe(1000);
		const off = [
			deal({ active: false }),
			deal({ startsAt: new Date(NOW + DAY) }),
			deal({ endsAt: new Date(NOW - 1) }),
			deal({ limit: 1, used: 1 }),
			deal({ scope: { ...empty(), productIds: ['p9'] } }),
			deal({ value: 0.01 }),
		];
		const result = run({
			lines: [line(), line({ productId: 'p2', unitPrice: 0 }), line({ productId: 'p3', quantity: 0 })],
			deals: off,
		});
		expect(result.lines.every((item) => item.dealDiscount === 0 && item.dealId === null)).toBe(true);
		expect(result.applied).toEqual([]);
	});

	it('adds up one deal used on several lines', () => {
		const result = run({ lines: [line(), line({ productId: 'p2', categoryIds: ['c1'] })], deals: [deal()] });
		expect(result.applied).toEqual([{ id: 'deal_1', name: 'Deal', kind: 'deal', amount: 200 }]);
	});

	it('has helpers for views and the best deal', () => {
		expect(dealUnitDiscount(deal({ type: 'fixed', value: 300 }), 200)).toBe(200);
		expect(bestDeal({ productId: 'p1', categoryIds: [], brandId: null, unitPrice: 1000 }, [], NOW)).toBeNull();
		const d = deal({ endsAt: new Date(NOW + DAY), scope: { ...empty(), brandIds: ['b1'] } });
		expect(publicDeal(d)).toEqual({
			id: 'deal_1',
			name: 'Deal',
			description: '',
			type: 'percent',
			value: 10,
			endsAt: new Date(NOW + DAY).toISOString(),
			scope: { everything: false, productIds: [], categoryIds: [], brandIds: ['b1'] },
		});
		expect(dealView({ ...d, createdAt: new Date(NOW) })).toMatchObject({
			used: 0,
			createdAt: new Date(NOW).toISOString(),
			updatedAt: null,
		});
		const sorted = [
			deal({ id: 'd3' }),
			deal({ id: 'd2', endsAt: new Date(NOW + DAY) }),
			deal({ id: 'd4', priority: 2 }),
			deal({ id: 'd1' }),
		].sort(byShowOrder);
		expect(sorted.map((item) => item.id)).toEqual(['d4', 'd2', 'd1', 'd3']);
	});
});

describe('bundles', () => {
	const pair = bundle({
		items: [
			{ productId: 'p1', quantity: 1 },
			{ productId: 'p2', quantity: 1 },
		],
		price: 1200,
	});
	const lines = [line(), line({ productId: 'p2', unitPrice: 500 })];

	it('sells a complete set for the bundle price, as many times as there are sets', () => {
		const one = run({ lines, bundles: [pair] });
		expect(one.lines.map((item) => item.bundleDiscount)).toEqual([200, 100]);
		expect(one.bundleIds).toEqual(['bnd_1']);
		expect(one.applied).toEqual([{ id: 'bnd_1', name: 'Bundle', kind: 'bundle', amount: 300 }]);
		const two = run({
			lines: [line({ quantity: 3 }), line({ productId: 'p2', unitPrice: 500, quantity: 2 })],
			bundles: [pair],
		});
		expect(two.lines.map((item) => item.bundleDiscount)).toEqual([400, 200]);
		expect(run({ lines: [line()], bundles: [pair] }).bundleIds).toEqual([]);
	});

	it('takes a percent off a set and uses the most expensive units first', () => {
		const percent = bundle({ items: [{ productId: 'p1', quantity: 1 }], value: 10 });
		const result = run({
			lines: [line({ variantId: 'cheap', unitPrice: 500 }), line({ variantId: 'dear', unitPrice: 2000 })],
			bundles: [percent],
		});
		expect(result.lines.map((item) => item.bundleDiscount)).toEqual([50, 200]);
	});

	it('forms a set only when it saves more than the deals of its units, which then take no deal', () => {
		const big = run({ lines, bundles: [pair], deals: [deal({ value: 50, scope: { ...empty(), productIds: ['p1'] } })] });
		expect(big.bundleIds).toEqual([]);
		expect(big.lines[0]).toMatchObject({ dealDiscount: 500, bundleDiscount: 0 });
		const small = run({
			lines: [line({ quantity: 2 }), line({ productId: 'p2', unitPrice: 500 })],
			bundles: [pair],
			deals: [deal({ value: 1, scope: { ...empty(), productIds: ['p1'] } })],
		});
		expect(small.lines[0]).toMatchObject({ dealId: 'deal_1', dealDiscount: 10, bundleDiscount: 200 });
		expect(small.lines[1]).toMatchObject({ dealId: null, bundleDiscount: 100 });
	});

	it('skips bundles that are not live, empty or save nothing', () => {
		const result = run({
			lines,
			bundles: [bundle({ ...pair, active: false }), bundle({ id: 'bnd_2' }), bundle({ ...pair, id: 'bnd_3', price: 5000 })],
		});
		expect(result.bundleIds).toEqual([]);
	});

	it('buy X get Y discounts the cheapest units', () => {
		const bogo = bundle({ type: 'buy_x_get_y', buy: 1, get: 1, value: 100 });
		const four = [1000, 800, 600, 400].map((unitPrice, i) => line({ productId: `p${i}`, unitPrice }));
		const result = run({ lines: four, bundles: [bogo] });
		expect(result.lines.map((item) => item.bundleDiscount)).toEqual([0, 0, 600, 400]);
		expect(result.applied).toEqual([{ id: 'bnd_1', name: 'Bundle', kind: 'bundle', amount: 1000 }]);
		const half = bundle({ type: 'buy_x_get_y', buy: 2, get: 1, value: 50 });
		expect(run({ lines: [line({ quantity: 3 })], bundles: [half] }).lines[0]?.bundleDiscount).toBe(500);
		expect(run({ lines: [line({ quantity: 2 })], bundles: [half] }).bundleIds).toEqual([]);
	});

	it('buy X get Y with separate scopes buys from units outside the get scope first', () => {
		const offer = bundle({
			type: 'buy_x_get_y',
			buy: 1,
			get: 1,
			value: 100,
			scope: { ...empty(), productIds: ['a'] },
			getScope: { ...empty(), productIds: ['a', 'b'] },
		});
		const result = run({
			lines: [line({ productId: 'a', unitPrice: 300 }), line({ productId: 'b', unitPrice: 500 })],
			bundles: [offer],
		});
		expect(result.lines.map((item) => item.bundleDiscount)).toEqual([0, 500]);
		const noGet = run({ lines: [line({ productId: 'a', unitPrice: 300 })], bundles: [offer] });
		expect(noGet.bundleIds).toEqual([]);
	});

	it('keeps the deals of the units a buy X get Y only counts', () => {
		const bogo = bundle({ type: 'buy_x_get_y', buy: 1, get: 1, value: 100 });
		const result = run({ lines: [line({ quantity: 2 })], bundles: [bogo], deals: [deal()] });
		expect(result.lines[0]).toMatchObject({ dealDiscount: 100, bundleDiscount: 1000 });
	});

	it('picks the bundle that saves most first and stops at the set cap', () => {
		const a = bundle({ id: 'bnd_a', items: [{ productId: 'p1', quantity: 1 }], value: 10 });
		const b = bundle({ id: 'bnd_b', items: [{ productId: 'p1', quantity: 1 }], value: 30 });
		expect(run({ lines: [line()], bundles: [a, b] }).bundleIds).toEqual(['bnd_b']);
		const bogo = bundle({ type: 'buy_x_get_y', buy: 1, get: 1, value: 100 });
		const many = formBundles(
			[bogo],
			[{ productId: 'p1', categoryIds: [], brandId: null, unitPrice: 10, quantity: 5000, dealUnit: 0 }],
			NOW,
		);
		expect(many.lines[0]?.bundleUnits).toBe(MAX_SETS);
		expect(nextSet(bundle({ items: [{ productId: 'p1', quantity: 2 }] }), [])).toBeNull();
	});
});

describe('coupons', () => {
	const lines = [line({ quantity: 2 }), line({ productId: 'p2', unitPrice: 500, brandId: 'b1' })];

	it('applies a percent coupon after deals, on what is left', () => {
		const result = run({
			lines,
			deals: [deal({ scope: { ...empty(), productIds: ['p1'] } })],
			coupon: coupon(),
			couponCode: ' save10 ',
		});
		expect(result.couponId).toBe('cpn_1');
		expect(result.couponCode).toBe('SAVE10');
		expect(result.lines.map((item) => item.couponDiscount)).toEqual([180, 50]);
		expect(result.applied.at(-1)).toEqual({ id: 'cpn_1', name: 'SAVE10', kind: 'coupon', amount: 230 });
	});

	it('caps a percent coupon and spreads a fixed one by value', () => {
		expect(
			run({ lines, coupon: coupon({ maxDiscount: 100 }), couponCode: 'SAVE10' }).lines.map((item) => item.couponDiscount),
		).toEqual([80, 20]);
		const fixed = run({ lines, coupon: coupon({ type: 'fixed', value: 500 }), couponCode: 'SAVE10' });
		expect(fixed.lines.map((item) => item.couponDiscount)).toEqual([400, 100]);
		const big = run({ lines, coupon: coupon({ type: 'fixed', value: 99_999 }), couponCode: 'SAVE10' });
		expect(big.lines.map((item) => item.couponDiscount)).toEqual([2000, 500]);
	});

	it('applies only to its scope and gives free delivery', () => {
		const scoped = run({ lines, coupon: coupon({ scope: { ...empty(), brandIds: ['b1'] } }), couponCode: 'SAVE10' });
		expect(scoped.lines.map((item) => item.couponDiscount)).toEqual([0, 50]);
		const free = run({ lines, coupon: coupon({ type: 'free_delivery', value: 0 }), couponCode: 'SAVE10' });
		expect(free.freeDelivery).toBe(true);
		expect(free.applied.at(-1)).toMatchObject({ kind: 'coupon', amount: 0 });
		const elsewhere = run({
			lines,
			coupon: coupon({ type: 'free_delivery', scope: { ...empty(), productIds: ['p9'] } }),
			couponCode: 'SAVE10',
		});
		expect(elsewhere.couponProblem?.code).toBe('coupon_not_applicable');
		expect(elsewhere.freeDelivery).toBe(false);
	});

	it('says why a code does not apply', () => {
		/** @param {Partial<import('../core/model.js').CouponRecord> | null} o @param {Partial<Parameters<typeof applyPromotions>[0]>} [extra] */
		const why = (o, extra = {}) =>
			run({ lines, coupon: o === null ? null : coupon(o), couponCode: 'SAVE10', ...extra }).couponProblem?.code;
		expect(why(null)).toBe('coupon_unknown');
		expect(why({ code: 'OTHER' })).toBe('coupon_unknown');
		expect(why({ active: false })).toBe('coupon_inactive');
		expect(why({ startsAt: new Date(NOW + DAY) })).toBe('coupon_not_started');
		expect(why({ endsAt: new Date(NOW) })).toBe('coupon_expired');
		expect(why({ limit: 3, used: 3 })).toBe('coupon_used_up');
		expect(why({ firstOrderOnly: true }, { customer: { orderCount: 1, couponUses: 0 } })).toBe('coupon_first_order');
		expect(why({ firstOrderOnly: true })).toBeUndefined();
		expect(why({ perCustomer: 1 }, { customer: { orderCount: 3, couponUses: 1 } })).toBe('coupon_per_customer');
		expect(why({ minSubtotal: 2501 })).toBe('coupon_min_subtotal');
		expect(why({ minSubtotal: 2500 })).toBeUndefined();
		expect(why({ minSubtotal: 2400 }, { deals: [deal()] })).toBe('coupon_min_subtotal');
		expect(why({ scope: { ...empty(), categoryIds: ['c9'] } })).toBe('coupon_not_applicable');
		expect(why({ value: 0.001 })).toBe('coupon_not_applicable');
		const problem = run({ lines, couponCode: 'X' }).couponProblem;
		expect(problem).toEqual({ code: 'coupon_unknown', message: 'This code is not valid.' });
		expect(couponBlocked(coupon(), { code: 'SAVE10', now: NOW, customer: { orderCount: 0, couponUses: 0 } })).toBeNull();
	});

	it('lets a coupon take what deals and bundles left, never below 0', () => {
		const result = run({
			lines: [line()],
			deals: [deal({ type: 'fixed', value: 1000 })],
			coupon: coupon(),
			couponCode: 'SAVE10',
		});
		expect(result.couponProblem?.code).toBe('coupon_not_applicable');
	});
});

describe('quoteProduct', () => {
	/** @type {import('../core/model.js').ProductRecord} */
	const product = /** @type {any} */ ({
		id: 'prd_1',
		categoryIds: ['c1'],
		brandId: 'b1',
		variants: [
			{ id: 'v1', price: 2000, active: true },
			{ id: 'v2', price: 1500, active: true },
			{ id: 'v3', price: 100, active: false },
		],
	});

	it('quotes the lowest active variant, or the one asked for', () => {
		const deals = [deal({ name: 'Brand week', scope: { ...empty(), brandIds: ['b1'] } })];
		expect(quoteProduct({ product, deals, now: NOW, currency: 'EUR' })).toEqual({
			productId: 'prd_1',
			variantId: 'v2',
			price: 1500,
			priceAfterDeals: 1350,
			savings: 150,
			currency: 'EUR',
			deals: [{ id: 'deal_1', name: 'Brand week' }],
		});
		expect(quoteProduct({ product, variantId: 'v1', deals: [], now: NOW })).toMatchObject({
			price: 2000,
			savings: 0,
			deals: [],
			currency: '',
		});
		expect(quoteProduct({ product, variantId: 'v3', deals: [], now: NOW })).toBeNull();
		const parent = [deal({ scope: { ...empty(), categoryIds: ['c0'] } })];
		expect(quoteProduct({ product, deals: parent, now: NOW })?.savings).toBe(0);
		expect(quoteProduct({ product, deals: parent, now: NOW, categoryIds: ['c1', 'c0'] })?.savings).toBe(150);
		expect(quoteProduct({ product: { ...product, variants: [] }, deals: [], now: NOW })).toBeNull();
	});
});

describe('loyalty rules', () => {
	const settings = { earnPercent: 1, pointValue: 100, minRedeem: 100, maxPercent: 20, expiryDays: 30 };

	it('reads the settings with defaults and bounds', () => {
		expect(loyaltyRules(undefined)).toEqual(LOYALTY_DEFAULTS);
		expect(loyaltyRules({ earnPercent: 500, pointValue: 0, minRedeem: 'x', maxPercent: -1, expiryDays: 2.7 })).toEqual({
			earnPercent: 100,
			pointValue: 1,
			minRedeem: 100,
			maxPercent: 0,
			expiryDays: 2,
		});
	});

	it('earns a percentage of the goods paid, in points', () => {
		expect(pointsToEarn({ total: 105_000, delivery: 5_000, tax: 0 }, settings)).toBe(10);
		expect(pointsToEarn({ total: 110_000, delivery: 5_000, tax: 5_000 }, { ...settings, earnPercent: 2.5 })).toBe(25);
		expect(pointsToEarn({ total: 1000, delivery: 2000, tax: 0 }, settings)).toBe(0);
		expect(pointsToEarn({ total: 9_999, delivery: 0, tax: 0 }, settings)).toBe(0);
	});

	it('values and caps redeemed points', () => {
		expect(pointsValue(250, settings)).toBe(25_000);
		expect(pointsValue(-1, settings)).toBe(0);
		expect(maxRedeemable({ balance: 500, payable: 100_000 }, settings)).toBe(200);
		expect(maxRedeemable({ balance: 150, payable: 100_000 }, settings)).toBe(150);
		expect(maxRedeemable({ balance: 99, payable: 100_000 }, settings)).toBe(0);
		expect(maxRedeemable({ balance: 5_000, payable: 10_000 }, settings)).toBe(0);
		expect(maxRedeemable({ balance: 5_000, payable: -5 }, settings)).toBe(0);
	});

	it('sets expiry, lists points expiring soon and the history', () => {
		expect(expiryFor(NOW, settings)).toEqual(new Date(NOW + 30 * DAY));
		expect(expiryFor(NOW, { ...settings, expiryDays: 0 })).toBeNull();
		const lot = (/** @type {number} */ left, /** @type {Date | null} */ expiresAt) => ({
			id: 'lot',
			points: left,
			left,
			earnedAt: new Date(NOW - DAY),
			expiresAt,
			orderId: null,
		});
		const soon = new Date(NOW + 5 * DAY);
		expect(
			expiringSoon(
				[
					lot(10, soon),
					lot(5, soon),
					lot(7, new Date(NOW + 60 * DAY)),
					lot(3, null),
					lot(0, soon),
					lot(4, new Date(NOW - 1)),
					lot(2, new Date(NOW + DAY)),
				],
				NOW,
			),
		).toEqual([
			{ points: 2, expiresAt: new Date(NOW + DAY).toISOString() },
			{ points: 15, expiresAt: soon.toISOString() },
		]);
		const history = [
			{ at: new Date(NOW - DAY), kind: /** @type {const} */ ('earn'), points: 10, orderId: 'ord_1', note: '' },
			{ at: new Date(NOW), kind: /** @type {const} */ ('redeem'), points: 5, orderId: 'ord_2', note: 'n' },
		];
		expect(historyView(history, 1)).toEqual([
			{ at: new Date(NOW).toISOString(), kind: 'redeem', points: 5, orderId: 'ord_2', note: 'n' },
		]);
		expect(historyView(history)).toHaveLength(2);
	});
});

describe('merchant input', () => {
	it('checks coupons', () => {
		const ok = checkCouponInput({
			code: ' spring-10 ',
			type: 'percent',
			value: 10,
			maxDiscount: 500,
			startsAt: '2026-10-01T00:00:00Z',
		});
		expect(ok).toEqual({
			ok: true,
			value: {
				code: 'SPRING-10',
				type: 'percent',
				value: 10,
				maxDiscount: 500,
				minSubtotal: 0,
				scope: empty(),
				startsAt: new Date('2026-10-01T00:00:00Z'),
				endsAt: null,
				limit: null,
				active: true,
				perCustomer: null,
				firstOrderOnly: false,
			},
		});
		expect(checkCouponInput({ code: 'FIXED', type: 'fixed', value: 500, maxDiscount: 9 })).toMatchObject({
			ok: true,
			value: { value: 500, maxDiscount: null },
		});
		expect(checkCouponInput({ code: 'SHIP', type: 'free_delivery', value: 9 })).toMatchObject({
			ok: true,
			value: { value: 0 },
		});
		/** @param {Record<string, unknown>} o */
		const field = (o) => {
			const checked = checkCouponInput({ code: 'GOOD', type: 'percent', value: 10, ...o });
			return checked.ok ? null : checked.field;
		};
		expect(checkCouponInput(null)).toMatchObject({ ok: false, field: '' });
		expect(field({ code: 'ab' })).toBe('code');
		expect(field({ code: 'bad code' })).toBe('code');
		expect(field({ type: 'gift' })).toBe('type');
		expect(field({ value: 0 })).toBe('value');
		expect(field({ value: 101 })).toBe('value');
		expect(field({ type: 'fixed', value: 1.5 })).toBe('value');
		expect(field({ maxDiscount: 0 })).toBe('maxDiscount');
		expect(field({ minSubtotal: -1 })).toBe('minSubtotal');
		expect(field({ scope: { brandIds: 'b' } })).toBe('scope/brandIds');
		expect(field({ startsAt: 'later' })).toBe('startsAt');
		expect(field({ endsAt: 'never' })).toBe('endsAt');
		expect(field({ startsAt: '2026-10-02T00:00:00Z', endsAt: '2026-10-01T00:00:00Z' })).toBe('endsAt');
		expect(field({ limit: 0 })).toBe('limit');
		expect(field({ active: 'yes' })).toBe('active');
		expect(field({ perCustomer: 0 })).toBe('perCustomer');
		expect(field({ firstOrderOnly: 1 })).toBe('firstOrderOnly');
		expect(normaliseCode(5)).toBe('');
		expect(couponView({ ...coupon(), startsAt: new Date(NOW) })).toMatchObject({
			code: 'SAVE10',
			startsAt: new Date(NOW).toISOString(),
		});
	});

	it('checks batches and draws codes', () => {
		expect(checkBatchInput({ prefix: 'fall-', count: 3, coupon: { type: 'fixed', value: 100 } })).toMatchObject({
			ok: true,
			value: { prefix: 'FALL-', count: 3, coupon: { type: 'fixed', value: 100 } },
		});
		expect(checkBatchInput({ count: 1, coupon: { type: 'fixed', value: 100 } })).toMatchObject({
			ok: true,
			value: { prefix: '' },
		});
		expect(checkBatchInput('x')).toMatchObject({ ok: false, field: '' });
		expect(checkBatchInput({ prefix: 'a b', count: 1 })).toMatchObject({ ok: false, field: 'prefix' });
		expect(checkBatchInput({ prefix: 'A', count: 501 })).toMatchObject({ ok: false, field: 'count' });
		expect(checkBatchInput({ prefix: 'A', count: 1 })).toMatchObject({ ok: false, field: 'coupon/type' });
		expect(checkBatchInput({ prefix: 'A', count: 1, coupon: 'x' })).toMatchObject({ ok: false, field: 'coupon/type' });
		let n = 0;
		const code = drawCode('X-', () => {
			n += 1;
			return n;
		});
		expect(code).toBe(`X-${BATCH_ALPHABET.slice(1, 9)}`);
	});

	it('checks deals', () => {
		expect(checkDealInput({ name: ' Week ', type: 'fixed', value: 300 })).toMatchObject({
			ok: true,
			value: { name: 'Week', description: '', type: 'fixed', value: 300, priority: 0, active: true, limit: null },
		});
		expect(checkDealInput([])).toMatchObject({ ok: false, field: '' });
		expect(checkDealInput({ name: 'x', type: 'bogus' })).toMatchObject({ ok: false, field: 'type' });
		expect(checkDealInput({ name: '', type: 'percent', value: 5 })).toMatchObject({ ok: false, field: 'name' });
		expect(checkDealInput({ name: 'x', type: 'percent', value: 500 })).toMatchObject({ ok: false, field: 'value' });
		expect(checkDealInput({ name: 'x', type: 'percent', value: 5, priority: 2000 })).toMatchObject({
			ok: false,
			field: 'priority',
		});
	});

	it('checks bundles', () => {
		expect(
			checkBundleInput({
				name: 'Pair',
				type: 'bundle',
				items: [{ productId: 'p1' }, { productId: 'p2', quantity: 2 }],
				price: 900,
			}),
		).toEqual({
			ok: true,
			value: {
				type: 'bundle',
				name: 'Pair',
				items: [
					{ productId: 'p1', quantity: 1 },
					{ productId: 'p2', quantity: 2 },
				],
				price: 900,
				value: 0,
				buy: 0,
				get: 0,
				getScope: empty(),
				scope: empty(),
				startsAt: null,
				endsAt: null,
				limit: null,
				active: true,
			},
		});
		expect(checkBundleInput({ name: 'Pct', type: 'bundle', items: [{ productId: 'p1' }], value: 15 })).toMatchObject({
			ok: true,
			value: { price: null, value: 15 },
		});
		expect(checkBundleInput({ name: 'Bogo', type: 'buy_x_get_y', buy: 2, get: 1 })).toMatchObject({
			ok: true,
			value: { items: [], price: null, buy: 2, get: 1, value: 100 },
		});
		/** @param {Record<string, unknown>} o */
		const field = (o) => {
			const checked = checkBundleInput({ name: 'B', type: 'bundle', items: [{ productId: 'p1' }], price: 100, ...o });
			return checked.ok ? null : checked.field;
		};
		expect(checkBundleInput(1)).toMatchObject({ ok: false, field: '' });
		expect(field({ type: 'combo' })).toBe('type');
		expect(field({ items: [] })).toBe('items');
		expect(field({ items: ['x'] })).toBe('items/0/productId');
		expect(field({ items: [{ productId: 'p1', quantity: 0 }] })).toBe('items/0/quantity');
		expect(field({ items: [{ productId: 'p1' }, { productId: 'p1' }] })).toBe('items/1/productId');
		expect(field({ price: 0 })).toBe('price');
		expect(field({ price: null, value: 0 })).toBe('value');
		expect(field({ name: '' })).toBe('name');
		expect(field({ type: 'buy_x_get_y', buy: 0, get: 1 })).toBe('buy');
		expect(field({ type: 'buy_x_get_y', buy: 1, get: 0 })).toBe('get');
		expect(field({ type: 'buy_x_get_y', buy: 1, get: 1, getScope: 'x' })).toBe('getScope');
		expect(field({ type: 'buy_x_get_y', buy: 1, get: 1, value: 0 })).toBe('value');
		expect(bundleView({ ...bundle(), updatedAt: new Date(NOW) })).toMatchObject({
			id: 'bnd_1',
			updatedAt: new Date(NOW).toISOString(),
		});
	});
});
