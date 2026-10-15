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
import { bestDeal, byShowOrder, checkDealInput, DEAL_RULES, dealUnitDiscount, dealView, publicDeal } from '../core/deals.js';
import {
	earnsAsMember,
	expiringSoon,
	expiryFor,
	historyView,
	isLoyaltyMember,
	LOYALTY_DEFAULTS,
	loyaltyRules,
	maxRedeemable,
	pointsToEarn,
	pointsValue,
} from '../core/loyalty.js';
import { applyPromotions, quoteProduct } from '../core/promotions.js';
import { checkDate, checkScope, checkText, checkWhole, gather, inScope, isLive, phaseOf } from '../core/promotions-rules.js';

/** Deal conditions that hold for every line (each test adds the one it checks). @type {import('../core/model.js').DealConditions} */
const NO_CONDITIONS = Object.freeze({
	match: /** @type {'all'} */ ('all'),
	rules: [],
	groups: [],
	priceRange: null,
	minQuantity: 0,
	cartTotal: 0,
	paymentMethods: [],
});

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
	slug: '',
	badgeLabel: '',
	discountLabel: '',
	color: '',
	banner: null,
	content: '',
	seo: { title: '', description: '' },
	sort: 0,
	conditions: null,
	target: 'items',
	days: [],
	timeFrom: '',
	timeTo: '',
	allowPoints: true,
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
		expect(result.lines).toEqual([
			{
				key: 'p1|v1',
				dealId: 'deal_1',
				dealDiscount: 200,
				bundleDiscount: 0,
				couponDiscount: 0,
				eligibleDealIds: ['deal_1'],
				locked: false,
				perUnit: 100,
			},
		]);
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
			deal({ id: 'deal_a', active: false }),
			deal({ id: 'deal_b', startsAt: new Date(NOW + DAY) }),
			deal({ id: 'deal_c', endsAt: new Date(NOW - 1) }),
			deal({ id: 'deal_d', limit: 1, used: 1 }),
			deal({ id: 'deal_e', scope: { ...empty(), productIds: ['p9'] } }),
			deal({ id: 'deal_f', value: 0.01 }),
		];
		const result = run({
			lines: [line(), line({ productId: 'p2', unitPrice: 0 }), line({ productId: 'p3', quantity: 0 })],
			deals: off,
		});
		expect(result.lines.every((item) => item.dealDiscount === 0 && item.dealId === null)).toBe(true);
		expect(result.applied).toEqual([]);
	});

	it('takes the first deal in the shoppers’ order that saves something with lineChoice first (D4)', () => {
		const first = { ...DEAL_RULES, lineChoice: /** @type {const} */ ('first') };
		const lamp = [line({ unitPrice: 1_000_000 })];
		const deals = [
			deal({ id: 'deal_b', type: 'fixed', value: 80_000, sort: 2 }),
			deal({ id: 'deal_a', value: 5, sort: 1 }),
			deal({ id: 'deal_z', value: 0.000_01, sort: 0 }),
		];
		// a 10,000 lamp: the best saving is 800 off (B), the first in show order 5% (A); Z saves nothing
		expect(run({ lines: lamp, deals }).lines[0]).toMatchObject({ dealId: 'deal_b', dealDiscount: 80_000 });
		expect(run({ lines: lamp, deals, rules: first }).lines[0]).toMatchObject({
			dealId: 'deal_a',
			dealDiscount: 50_000,
			eligibleDealIds: ['deal_b', 'deal_a', 'deal_z'],
		});
		// the shopper's pick still wins
		const picked = [line({ unitPrice: 1_000_000, dealId: 'deal_b' })];
		expect(run({ lines: picked, deals, rules: first, shopperChoice: true }).lines[0]?.dealId).toBe('deal_b');
		// the product quote follows the same choice
		const product = /** @type {any} */ ({
			id: 'p1',
			categoryIds: [],
			brandId: null,
			specs: {},
			variants: [{ id: 'v1', price: 1_000_000, active: true, attributes: {} }],
		});
		expect(quoteProduct({ product, deals, now: NOW })?.deals).toEqual([{ id: 'deal_b', name: 'Deal' }]);
		expect(quoteProduct({ product, deals, now: NOW, rules: first })).toMatchObject({
			savings: 50_000,
			deals: [{ id: 'deal_a', name: 'Deal' }],
		});
	});

	it('rounds the deals once per order, half up, with rounding total_half_up (D4)', () => {
		const exact = { ...DEAL_RULES, rounding: /** @type {const} */ ('total_half_up') };
		const seven = deal({ value: 7 });
		// 7% off 4,999.00 in whole units: 349.93 rounds down per unit to 349, once half up to 350
		expect(run({ lines: [line({ unitPrice: 499_900 })], deals: [seven], unit: 100 }).lines[0]?.dealDiscount).toBe(34_900);
		expect(run({ lines: [line({ unitPrice: 499_900 })], deals: [seven], unit: 100, rules: exact }).lines[0]).toMatchObject({
			dealDiscount: 35_000,
			perUnit: 35_000,
		});
		// three units: 1,047 against 1,050 (the percent of the whole line)
		const three = line({ unitPrice: 499_900, quantity: 3 });
		expect(run({ lines: [three], deals: [seven], unit: 100 }).lines[0]?.dealDiscount).toBe(104_700);
		expect(run({ lines: [three], deals: [seven], unit: 100, rules: exact }).lines[0]?.dealDiscount).toBe(105_000);
		// two lines of 349.65: rounded together to 699, spread in whole units
		const pair = [line({ unitPrice: 499_500 }), line({ productId: 'p2', unitPrice: 499_500 })];
		const twice = run({ lines: pair, deals: [seven], unit: 100, rules: exact });
		expect(twice.lines.map((item) => item.dealDiscount)).toEqual([35_000, 34_900]);
		expect(twice.applied).toEqual([{ id: 'deal_1', name: 'Deal', kind: 'deal', amount: 69_900 }]);
		// a fixed cart deal of 1,000.50 is spread exactly, then rounded once: 1,001 (per_unit_down drops the 0.50)
		const fixed = deal({ target: 'cart', type: 'fixed', value: 100_050 });
		const spread = [line({ unitPrice: 300_000 }), line({ productId: 'p2', unitPrice: 100_000 })];
		expect(run({ lines: spread, deals: [fixed], unit: 100 }).lines.map((item) => item.dealDiscount)).toEqual([75_000, 25_000]);
		expect(run({ lines: spread, deals: [fixed], unit: 100, rules: exact }).lines.map((item) => item.dealDiscount)).toEqual([
			75_100, 25_000,
		]);
		// a lock keeps its own amount and stays out of the rounding
		const locked = run({
			lines: [
				line({ unitPrice: 499_900, lock: { dealId: 'deal_1', perUnit: 40_050 } }),
				line({ productId: 'p2', unitPrice: 499_900 }),
			],
			deals: [seven],
			unit: 100,
			rules: exact,
		});
		expect(locked.lines.map((item) => [item.dealDiscount, item.locked])).toEqual([
			[40_050, true],
			[35_000, false],
		]);
		// a fixed deal never takes more than the price
		expect(run({ lines: [line()], deals: [deal({ type: 'fixed', value: 5000 })], rules: exact }).lines[0]?.dealDiscount).toBe(
			1000,
		);
	});

	describe('checkout-level deals with item deals (cartOffer, D4)', () => {
		const after = { ...DEAL_RULES, cartOffer: /** @type {const} */ ('one_after_items') };
		const exclusive = { ...DEAL_RULES, cartOffer: /** @type {const} */ ('one_exclusive') };
		const tenOnP1 = deal({ id: 'deal_item', value: 10, scope: { ...empty(), productIds: ['p1'] } });
		/** 5% off the cart from 5,000 */
		const fiveOver = deal({
			id: 'deal_cart',
			target: 'cart',
			value: 5,
			conditions: { ...NO_CONDITIONS, cartTotal: 500_000 },
		});
		const mixed = [line({ unitPrice: 1_000_000 }), line({ productId: 'p2', unitPrice: 500_000 })];

		it('per_line_best: each line takes the best of its item and cart deals (today)', () => {
			const result = run({ lines: mixed, deals: [tenOnP1, fiveOver] });
			expect(result.lines.map((item) => [item.dealId, item.dealDiscount])).toEqual([
				['deal_item', 100_000],
				['deal_cart', 25_000],
			]);
			expect(result.lines[0]?.eligibleDealIds).toEqual(['deal_item', 'deal_cart']);
		});

		it('one_after_items: the checkout deal comes off what the item deals left', () => {
			// 10% of 10,000 on the first line, then 5% of the 14,000 left: 1,700 (per_line_best: 1,250)
			const result = run({ lines: mixed, deals: [tenOnP1, fiveOver], rules: after });
			expect(result.lines.map((item) => [item.dealId, item.dealDiscount, item.perUnit])).toEqual([
				['deal_item', 145_000, 100_000],
				['deal_cart', 25_000, 0],
			]);
			expect(result.lines[0]?.eligibleDealIds).toEqual(['deal_item']);
			expect(result.dealIds).toEqual(['deal_item', 'deal_cart']);
			expect(result.applied).toEqual([
				{ id: 'deal_item', name: 'Deal', kind: 'deal', amount: 100_000 },
				{ id: 'deal_cart', name: 'Deal', kind: 'deal', amount: 70_000 },
			]);
			// a 6,000 line with a 10% deal and 5% over 5,000: 600, then 5% of 5,400 (870)
			const one = run({ lines: [line({ unitPrice: 600_000 })], deals: [tenOnP1, fiveOver], rules: after });
			expect(one.lines[0]?.dealDiscount).toBe(87_000);
			expect(run({ lines: [line({ unitPrice: 600_000 })], deals: [tenOnP1, fiveOver] }).lines[0]?.dealDiscount).toBe(60_000);
		});

		it('one_exclusive: no checkout deal once an item deal applied', () => {
			const result = run({ lines: mixed, deals: [tenOnP1, fiveOver], rules: exclusive });
			expect(result.lines.map((item) => [item.dealId, item.dealDiscount])).toEqual([
				['deal_item', 100_000],
				[null, 0],
			]);
			expect(result.dealIds).toEqual(['deal_item']);
			// without an item deal the checkout deal applies to the whole cart
			const plain = run({
				lines: [line({ productId: 'p2', unitPrice: 600_000 })],
				deals: [tenOnP1, fiveOver],
				rules: exclusive,
			});
			expect(plain.lines[0]).toMatchObject({ dealId: 'deal_cart', dealDiscount: 30_000 });
		});

		it('takes at most one checkout deal, the first in show order that applies; free delivery counts', () => {
			const big = [line({ unitPrice: 10_500_000 })];
			const thousandOff = deal({ id: 'deal_fixed', target: 'cart', type: 'fixed', value: 100_000, sort: 0 });
			const percent = deal({ id: 'deal_pct', target: 'cart', value: 5, sort: 1 });
			const freeShip = deal({ id: 'deal_ship', type: 'free_delivery', sort: 0 });
			expect(run({ lines: big, deals: [percent, thousandOff] }).lines[0]?.dealDiscount).toBe(525_000);
			const first = run({ lines: big, deals: [percent, thousandOff], rules: after });
			expect(first.lines[0]).toMatchObject({ dealId: 'deal_fixed', dealDiscount: 100_000 });
			expect(first.freeDelivery).toBe(false);
			// free delivery first in show order: free delivery only; per_line_best adds both
			const shipped = run({ lines: big, deals: [percent, freeShip], rules: after });
			expect(shipped).toMatchObject({ freeDelivery: true, dealIds: ['deal_ship'] });
			expect(shipped.lines[0]?.dealDiscount).toBe(0);
			expect(shipped.applied).toEqual([{ id: 'deal_ship', name: 'Deal', kind: 'deal', amount: 0 }]);
			const both = run({ lines: big, deals: [percent, freeShip] });
			expect(both).toMatchObject({ freeDelivery: true, dealIds: ['deal_pct', 'deal_ship'] });
			// a checkout deal that takes nothing is passed over
			const nothing = deal({ id: 'deal_zero', target: 'cart', value: 0, sort: -1 });
			expect(run({ lines: big, deals: [nothing, percent], rules: after }).dealIds).toEqual(['deal_pct']);
			// a fixed checkout deal is spread over what the lines have left
			const spread = run({ lines: mixed, deals: [tenOnP1, thousandOff], rules: after });
			expect(spread.lines.map((item) => item.dealDiscount)).toEqual([100_000 + 64_286, 35_714]);
		});

		it('judges a checkout deal’s cart total on the goods, or after the item deals (cartThresholdBase)', () => {
			const lines = [line({ unitPrice: 300_000 }), line({ productId: 'p2', unitPrice: 220_000 })];
			const base = { ...after, cartThresholdBase: /** @type {const} */ ('after_item_deals') };
			// 3,000 with 10% off and 2,200: goods 5,200 meet "from 5,000", after the item deal 4,900 do not
			expect(run({ lines, deals: [tenOnP1, fiveOver], rules: after }).applied.map((entry) => entry.amount)).toEqual([
				30_000, 24_500,
			]);
			expect(run({ lines, deals: [tenOnP1, fiveOver], rules: base }).applied.map((entry) => entry.amount)).toEqual([30_000]);
			// per_line_best: 300 + 5% of 2,200 on the goods; 300 alone after the item deals
			expect(run({ lines, deals: [tenOnP1, fiveOver] }).applied.map((entry) => entry.amount)).toEqual([30_000, 11_000]);
			const perLine = { ...DEAL_RULES, cartThresholdBase: /** @type {const} */ ('after_item_deals') };
			expect(run({ lines, deals: [tenOnP1, fiveOver], rules: perLine }).applied.map((entry) => entry.amount)).toEqual([
				30_000,
			]);
			// free delivery from 10,000 on a 10,500 lamp with 10% off: 9,450 after the deal
			const lamp = [line({ unitPrice: 1_050_000 })];
			const ship = deal({ id: 'deal_ship', type: 'free_delivery', conditions: { ...NO_CONDITIONS, cartTotal: 1_000_000 } });
			expect(run({ lines: lamp, deals: [tenOnP1, ship] }).freeDelivery).toBe(true);
			expect(run({ lines: lamp, deals: [tenOnP1, ship], rules: perLine }).freeDelivery).toBe(false);
			expect(run({ lines: lamp, deals: [tenOnP1, ship], rules: base })).toMatchObject({
				freeDelivery: false,
				dealIds: ['deal_item'],
			});
		});

		it('blocks points for any deal without points, or only for such a checkout deal (pointsBlockedBy)', () => {
			const onlyCart = { ...after, pointsBlockedBy: /** @type {const} */ ('cart_offer') };
			const noPointsItem = { ...tenOnP1, allowPoints: false };
			expect(run({ lines: mixed, deals: [noPointsItem], rules: after }).pointsBlocked).toBe(true);
			expect(run({ lines: mixed, deals: [noPointsItem], rules: onlyCart }).pointsBlocked).toBe(false);
			const noPointsCart = { ...fiveOver, allowPoints: false };
			expect(run({ lines: mixed, deals: [tenOnP1, noPointsCart], rules: onlyCart }).pointsBlocked).toBe(true);
			const noPointsShip = deal({ id: 'deal_ship', type: 'free_delivery', allowPoints: false });
			expect(
				run({ lines: mixed, deals: [noPointsShip], rules: { ...DEAL_RULES, pointsBlockedBy: 'cart_offer' } }).pointsBlocked,
			).toBe(true);
			// a checkout deal that did not apply blocks nothing
			expect(
				run({ lines: mixed, deals: [tenOnP1, noPointsCart], rules: { ...onlyCart, cartOffer: 'one_exclusive' } })
					.pointsBlocked,
			).toBe(false);
		});

		it('rounds item and checkout deals together, once, with total_half_up', () => {
			const deals = [deal({ id: 'deal_item', value: 7 }), { ...fiveOver, conditions: null }];
			const shirt = [line({ unitPrice: 499_900 })];
			// 349.93 + 5% of 4,649.07 (232.45) = 582.38: 582 rounded once; per unit down 349 + 232 = 581
			expect(run({ lines: shirt, deals, rules: after, unit: 100 }).lines[0]?.dealDiscount).toBe(58_100);
			const exact = run({ lines: shirt, deals, rules: { ...after, rounding: 'total_half_up' }, unit: 100 });
			expect(exact.lines[0]).toMatchObject({ dealDiscount: 58_200, perUnit: 35_000 });
			expect(exact.applied.map((entry) => entry.amount)).toEqual([35_000, 23_200]);
		});
	});

	it('keeps the deals and coupon an order was placed with when staff edit it (asPlaced, E29)', () => {
		const ended = [
			deal({ id: 'deal_a', active: false, value: 10 }),
			deal({ id: 'deal_b', endsAt: new Date(NOW - DAY), value: 20, scope: { ...empty(), productIds: ['p2'] } }),
			deal({ id: 'deal_c', limit: 1, used: 1, type: 'free_delivery' }),
		];
		const lines = [line(), line({ productId: 'p2' })];
		expect(run({ lines, deals: ended })).toMatchObject({ dealIds: [], freeDelivery: false });
		const kept = run({ lines, deals: ended, asPlaced: true });
		expect(kept.lines.map((item) => item.dealDiscount)).toEqual([100, 200]);
		expect(kept).toMatchObject({ dealIds: ['deal_a', 'deal_b', 'deal_c'], freeDelivery: true });
		// scope and conditions still count
		const narrow = { ...ended[0], scope: { ...empty(), productIds: ['p9'] } };
		expect(run({ lines, deals: [/** @type {any} */ (narrow)], asPlaced: true }).dealIds).toEqual([]);
		// the coupon too, even switched off
		const off = coupon({ active: false });
		expect(run({ lines, coupon: off, couponCode: 'SAVE10' }).couponProblem?.code).toBe('coupon_inactive');
		expect(run({ lines, coupon: off, couponCode: 'SAVE10', asPlaced: true }).couponId).toBe('cpn_1');
	});

	it('adds up one deal used on several lines', () => {
		const result = run({ lines: [line(), line({ productId: 'p2', categoryIds: ['c1'] })], deals: [deal()] });
		expect(result.applied).toEqual([{ id: 'deal_1', name: 'Deal', kind: 'deal', amount: 200 }]);
	});

	it('has helpers for views and the best deal', () => {
		expect(dealUnitDiscount(deal({ type: 'fixed', value: 300 }), 200)).toBe(200);
		expect(bestDeal({ productId: 'p1', categoryIds: [], brandId: null, unitPrice: 1000 }, [], NOW)).toBeNull();
		const d = deal({ endsAt: new Date(NOW + DAY), scope: { ...empty(), brandIds: ['b1'] } });
		expect(publicDeal(d)).toMatchObject({
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
		specs: {},
		variants: [
			{ id: 'v1', price: 2000, active: true, attributes: {} },
			{ id: 'v2', price: 1500, active: true, attributes: {} },
			{ id: 'v3', price: 100, active: false, attributes: {} },
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

	it('rounds one unit as the cart does (D4)', () => {
		const phone = /** @type {any} */ ({ ...product, variants: [{ id: 'v1', price: 499_900, active: true, attributes: {} }] });
		const deals = [deal({ value: 7 })];
		expect(quoteProduct({ product: phone, deals, now: NOW, unit: 100 })?.savings).toBe(34_900);
		const exact = { ...DEAL_RULES, rounding: /** @type {const} */ ('total_half_up') };
		expect(quoteProduct({ product: phone, deals, now: NOW, unit: 100, rules: exact })).toMatchObject({
			savings: 35_000,
			priceAfterDeals: 464_900,
		});
		const cheap = /** @type {any} */ ({ ...product, variants: [{ id: 'v1', price: 200, active: true, attributes: {} }] });
		expect(
			quoteProduct({ product: cheap, deals: [deal({ type: 'fixed', value: 300 })], now: NOW, rules: exact })?.savings,
		).toBe(200);
	});

	it('judges a deal’s weekdays and hours as the cart does, at the UTC time when no clock is given (K-15)', () => {
		const at = new Date(NOW);
		const today = at.getUTCDay();
		const minutes = at.getUTCHours() * 60 + at.getUTCMinutes();
		const elsewhere = [deal({ days: [(today + 1) % 7] }), deal({ id: 'deal_2', timeFrom: '00:00', timeTo: '00:01' })];
		expect(quoteProduct({ product, deals: elsewhere, now: NOW })?.savings).toBe(0);
		expect(quoteProduct({ product, deals: elsewhere, now: NOW, clock: { weekday: (today + 1) % 7, minutes } })).toMatchObject({
			savings: 150,
			deals: [{ id: 'deal_1' }],
		});
		expect(quoteProduct({ product, deals: elsewhere, now: NOW, clock: { weekday: today, minutes: 0 } })?.savings).toBe(150);
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
			roles: [],
			guests: 'none',
			earnBase: 'goods',
			earnAt: 'delivery',
			capBase: 'order',
			redeemMode: 'amount',
			expiryUnit: 'days',
			expiryRule: 'at_earn',
			memberFlag: 'off',
		});
		// who is a loyalty member (E47): everyone while the flag is off, else only a flagged customer; with first_order
		// an order makes its customer one
		expect(isLoyaltyMember({}, null)).toBe(true);
		expect(isLoyaltyMember({ memberFlag: 'manual' }, { loyaltyMember: false })).toBe(false);
		expect(isLoyaltyMember({ memberFlag: 'manual' }, { loyaltyMember: true })).toBe(true);
		expect(earnsAsMember({ memberFlag: 'manual' }, null)).toBe(false);
		expect(earnsAsMember({ memberFlag: 'first_order' }, null)).toBe(true);
		expect(loyaltyRules({ memberFlag: 'sometimes' }).memberFlag).toBe('off');
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

	it('checks a deal’s banner key: an edit takes a new one only from the deal’s own folder', () => {
		/** @param {unknown} banner @param {import('../core/deals.js').BannerKeys} [keys] */
		const banner = (banner, keys) => {
			const checked = checkDealInput({ name: 'x', type: 'percent', value: 5, banner }, keys);
			return checked.ok ? checked.value.banner.key : checked.field;
		};
		const edit = { held: 'offers/old.webp', folder: 'ecommerce/deals/deal_1/' };
		expect(banner({ key: 'ecommerce/deals/deal_1/a.png' }, edit)).toBe('ecommerce/deals/deal_1/a.png');
		expect(banner({ key: 'offers/old.webp' }, edit)).toBe('offers/old.webp');
		expect(banner({ key: 'ecommerce/deals/deal_2/a.png' }, edit)).toBe('banner');
		expect(banner({ key: 'ecommerce/deals/a.png' }, edit)).toBe('banner');
		expect(banner({ key: 'ecommerce/deals/deal_1/' }, edit)).toBe('banner');
		expect(banner({ key: 'ecommerce/deals/deal_1/../deal_2/a.png' }, edit)).toBe('banner');
		expect(banner({ key: 'ecommerce/deals/a.png' })).toBe('ecommerce/deals/a.png');
		expect(banner({ key: 'offers/a.png' }, { importing: true })).toBe('offers/a.png');
		expect(banner('ecommerce/deals/a.png')).toBe('banner');
		expect(banner({ key: 7 })).toBe('banner');
		expect(banner({ key: 'ecommerce/deals/a.png', alt: 'x'.repeat(201) })).toBe('banner/alt');
		expect(checkDealInput({ name: 'x', type: 'percent', value: 5, banner: { key: 'a' } }, edit)).toMatchObject({
			message: 'banner is { key, alt } of a photo uploaded for this deal, or null.',
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
