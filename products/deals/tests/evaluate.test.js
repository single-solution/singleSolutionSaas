import { describe, expect, it } from 'vitest';
import { settingsFrom } from '../api/settings.js';
import { normaliseDeal } from '../core/deals.js';
import {
	cartReward,
	evaluateCart,
	hasCartConditions,
	itemDealDiscount,
	rewardSummary,
	staticIneligibility,
} from '../core/evaluate.js';
import { formInstances, instanceDiscount } from '../core/bundles.js';
import { allocate, percentOf, roundAmount } from '../core/money.js';
import { normaliseLine } from '../core/scope.js';
import { classesCombine, createPolicy } from '../core/stacking.js';

const NOW = Date.parse('2026-10-02T12:00:00Z');
/** @param {Record<string, Record<string, unknown>>} [config] @param {Record<string, boolean>} [off] */
const settingsWith = (config = {}, off = {}) =>
	settingsFrom({ can: (key) => off[key] !== true, config: (key) => config[key] ?? {} });
const base = settingsWith();
let seq = 0;
/** @param {Record<string, any>} input @param {any} [s] */
const deal = (input, s = base) =>
	normaliseDeal(input, {
		id: input.id ?? `dl_${String((seq += 1)).padStart(3, '0')}`,
		rules: s.dealRules,
		defaults: s.defaults,
	});
const customer = { id: null, segments: [], orders: null, tags: [] };
/**
 * @param {Array<Record<string, any>>} lines
 * @param {any[]} deals
 * @param {{ settings?: any, extra?: Record<string, any>, usage?: any, customerUsage?: any, locks?: Map<string, any> }} [options]
 */
const run = (lines, deals, { settings = base, extra = {}, usage = {}, customerUsage = {}, locks } = {}) =>
	evaluateCart({
		cart: {
			currency: 'EUR',
			lines: lines.map((l, i) => normaliseLine(/** @type {any} */ (l), i)),
			customer,
			paymentMethod: null,
			deliveryMethod: null,
			shippingAmount: null,
			...extra,
		},
		deals,
		usage,
		customerUsage,
		...(locks ? { locks } : {}),
		settings: settings.engine,
		now: NOW,
	});
const shoe = { itemId: 'shoe', quantity: 1, unitAmount: 10_000, collections: ['shoes'], brand: 'acme' };
const sock = { itemId: 'sock', quantity: 3, unitAmount: 1000, collections: ['socks'] };

describe('money', () => {
	it('rounds, allocates exactly and takes percents', () => {
		expect(roundAmount(10.5, 'half_up')).toBe(11);
		expect(roundAmount(10.5, 'floor')).toBe(10);
		expect(roundAmount(10.2, 'ceil')).toBe(11);
		expect(roundAmount(10.0000000001, 'ceil')).toBe(10);
		expect(roundAmount(-1, 'half_up')).toBe(0);
		expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
		expect(allocate(5, [0, 0])).toEqual([5, 0]);
		expect(allocate(1, [])).toEqual([]);
		expect(percentOf(999, 12.5)).toBeCloseTo(124.875);
		expect(percentOf(100, 150)).toBe(100);
	});
});

describe('item deals', () => {
	it('computes percent, amount off, fixed price and buy-x-get-y on a line', () => {
		const pct = deal({ kind: 'item', name: 'p', action: { type: 'percent', percent: 15 } });
		expect(itemDealDiscount(pct, { amount: 999, quantity: 1, n: 1, rounding: 'half_up' })).toEqual({ amount: 150, units: 1 });
		expect(itemDealDiscount(pct, { amount: 999, quantity: 1, n: 1, rounding: 'floor' }).amount).toBe(149);
		const off = deal({ kind: 'item', name: 'o', action: { type: 'amount_off', amount: 600 } });
		expect(itemDealDiscount(off, { amount: 1000, quantity: 2, n: 2, rounding: 'half_up' })).toEqual({ amount: 1000, units: 2 });
		const price = deal({ kind: 'item', name: 'f', action: { type: 'fixed_price', amount: 700 } });
		expect(itemDealDiscount(price, { amount: 3000, quantity: 3, n: 2, rounding: 'half_up' }).amount).toBe(600);
		expect(itemDealDiscount(price, { amount: 600, quantity: 1, n: 1, rounding: 'half_up' })).toEqual({ amount: 0, units: 0 });
		const bxgy = deal({ kind: 'item', name: 'b', action: { type: 'buy_x_get_y', buy: 2, get: 1 } });
		expect(itemDealDiscount(bxgy, { amount: 7000, quantity: 7, n: 7, rounding: 'half_up' })).toEqual({
			amount: 2000,
			units: 6,
		});
		const half = deal({ kind: 'item', name: 'h', action: { type: 'buy_x_get_y', buy: 1, get: 1, percent: 50 } });
		expect(itemDealDiscount(half, { amount: 2000, quantity: 2, n: 2, rounding: 'half_up' }).amount).toBe(500);
		expect(itemDealDiscount(pct, { amount: 1000, quantity: 1, n: 0, rounding: 'half_up' })).toEqual({ amount: 0, units: 0 });
		expect(
			itemDealDiscount(/** @type {any} */ ({ action: { type: 'other' } }), {
				amount: 1000,
				quantity: 1,
				n: 1,
				rounding: 'half_up',
			}),
		).toEqual({
			amount: 0,
			units: 0,
		});
	});

	it('matches scopes and line minimums, caps units per order and by stock left', () => {
		const shoes = deal({
			kind: 'item',
			name: 'shoes',
			scope: { collections: ['shoes'] },
			action: { type: 'percent', percent: 10 },
			conditions: { minQuantity: 2 },
		});
		expect(run([shoe], [shoes]).discountTotal).toBe(0);
		expect(run([{ ...shoe, quantity: 2 }], [shoes]).discountTotal).toBe(2000);
		const capped = deal({
			kind: 'flash',
			name: 'cap',
			scope: { collections: ['socks'] },
			action: { type: 'amount_off', amount: 100 },
			limits: { maxUnitsPerOrder: 2, stockUnits: 10 },
		});
		expect(run([sock], [capped]).lines[0]).toMatchObject({ discount: 200 });
		// stock left (10 − 9 = 1) is shared across lines in cart order
		const result = run([sock, { ...sock, itemId: 'sock2' }], [capped], { usage: { [capped.id]: { uses: 5, units: 9 } } });
		expect(result.lines.map((l) => l.discount)).toEqual([100, 0]);
		expect(run([sock], [capped], { usage: { [capped.id]: { uses: 5, units: 10 } } }).ineligible[capped.id]).toBe('sold_out');
	});

	it('excludes deals by status, kind switch, schedule, limits and customer conditions', () => {
		const ctx = (/** @type {Record<string, any>} */ extra = {}) => ({
			now: NOW,
			settings: base.engine,
			usage: {},
			customerUsage: {},
			customer,
			...extra,
		});
		const d = (/** @type {Record<string, any>} */ input) =>
			deal({ kind: 'item', name: 'x', action: { type: 'percent', percent: 5 }, ...input });
		expect(staticIneligibility(d({ status: 'paused' }), ctx())).toBe('inactive');
		expect(
			staticIneligibility(
				d({ kind: 'bundle', bundle: { type: 'mix_and_match', scope: {}, quantity: 2 } }),
				ctx({ settings: settingsWith({}, { bundles: true }).engine }),
			),
		).toBe('kind_disabled');
		expect(staticIneligibility(d({ schedule: { startsAt: '2027-01-01T00:00:00Z' } }), ctx())).toBe('scheduled');
		expect(staticIneligibility(d({ schedule: { endsAt: '2026-01-01T00:00:00Z' } }), ctx())).toBe('ended');
		const limited = d({ limits: { totalUses: 2, perCustomer: 1 } });
		expect(staticIneligibility(limited, ctx({ usage: { [limited.id]: { uses: 2, units: 0 } } }))).toBe('exhausted');
		expect(staticIneligibility(limited, ctx())).toBe('customer_required');
		expect(
			staticIneligibility(
				limited,
				ctx({ settings: settingsWith({ quote_api: { anonymous_limited_deals: 'allow' } }).engine }),
			),
		).toBeNull();
		const known = { id: 'cus_1', segments: ['vip'], orders: 0, tags: [] };
		expect(staticIneligibility(limited, ctx({ customer: known, customerUsage: { [limited.id]: 1 } }))).toBe('customer_limit');
		expect(staticIneligibility(d({ conditions: { newCustomersOnly: true } }), ctx())).toBe('new_customers_only');
		expect(staticIneligibility(d({ conditions: { newCustomersOnly: true } }), ctx({ customer: known }))).toBeNull();
		expect(staticIneligibility(d({ conditions: { customerSegments: ['wholesale'] } }), ctx({ customer: known }))).toBe(
			'segment',
		);
		expect(staticIneligibility(d({ conditions: { customerSegments: ['vip'] } }), ctx({ customer: known }))).toBeNull();
		expect(hasCartConditions(d({ conditions: { paymentMethods: ['card'] } }))).toBe(true);
		expect(hasCartConditions(d({ conditions: { minQuantity: 1 } }))).toBe(false);
	});

	it('applies payment, delivery, minimum-subtotal and rules@1 conditions', () => {
		const card = deal({
			kind: 'item',
			name: 'card',
			action: { type: 'percent', percent: 10 },
			conditions: { paymentMethods: ['card'], deliveryMethods: ['pickup'] },
		});
		expect(run([shoe], [card]).ineligible[card.id]).toBe('payment_method');
		expect(run([shoe], [card], { extra: { paymentMethod: 'card' } }).ineligible[card.id]).toBe('delivery_method');
		expect(run([shoe], [card], { extra: { paymentMethod: 'card', deliveryMethod: 'pickup' } }).discountTotal).toBe(1000);
		const big = deal({
			kind: 'item',
			name: 'big',
			action: { type: 'percent', percent: 10 },
			conditions: { minSubtotal: 20_000 },
		});
		expect(run([shoe], [big]).ineligible[big.id]).toBe('min_subtotal');
		const when = deal({
			kind: 'item',
			name: 'when',
			action: { type: 'percent', percent: 10 },
			conditions: { when: 'cart.quantity >= 4' },
			scope: { when: "item.brand == 'acme'" },
		});
		expect(run([shoe], [when]).ineligible[when.id]).toBe('condition');
		const result = run([shoe, sock], [when]);
		expect(result.lines.map((l) => l.discount)).toEqual([1000, 0]);
	});
});

describe('stacking', () => {
	const ten = deal({
		id: 'dl_a10',
		kind: 'item',
		name: 'ten',
		scope: { collections: ['shoes'] },
		action: { type: 'percent', percent: 10 },
	});
	const twenty = deal({
		id: 'dl_b20',
		kind: 'item',
		name: 'twenty',
		scope: { brands: ['acme'] },
		action: { type: 'percent', percent: 20 },
	});
	const cart5 = deal({ id: 'dl_c05', kind: 'cart', name: 'cart', action: { type: 'percent', percent: 5 } });

	it('is mutual between classes and switchable', () => {
		const policy = createPolicy({
			enabled: true,
			classes: [
				{ key: 'a', stack_within: true, combines_with: ['b'] },
				{ key: 'b', stack_within: false, combines_with: [] },
			],
		});
		expect(classesCombine(policy, 'a', 'a')).toBe(true);
		expect(classesCombine(policy, 'b', 'b')).toBe(false);
		expect(classesCombine(policy, 'a', 'b')).toBe(false); // b does not list a
		expect(classesCombine(policy, 'a', 'zzz')).toBe(false);
		expect(
			classesCombine(
				createPolicy({ enabled: false, classes: [{ key: 'a', stack_within: true, combines_with: [] }] }),
				'a',
				'a',
			),
		).toBe(false);
	});

	it('picks the best compatible combination for the customer', () => {
		// default classes: item deals do not stack with each other; item + cart combine
		const result = run([shoe], [ten, twenty, cart5]);
		expect(result.deals.map((d) => d.dealId)).toEqual(['dl_b20', 'dl_c05']);
		expect(result.discountTotal).toBe(2000 + 400);
		// stacking off: one offer per line, and a cart deal only on lines without one
		const off = run([shoe], [ten, twenty, cart5], { settings: settingsWith({}, { stacking: true }) });
		expect(off.deals.map((d) => d.dealId)).toEqual(['dl_b20']);
		// item deals that stack within their class compound on the remaining price
		const stackable = settingsWith({
			stacking: {
				classes: [
					{ key: 'item', stack_within: true, combines_with: ['cart'] },
					{ key: 'cart', stack_within: false, combines_with: ['item'] },
				],
			},
		});
		const both = run([shoe], [deal({ ...ten, id: 'dl_a10' }, stackable), deal({ ...twenty, id: 'dl_b20' }, stackable)], {
			settings: stackable,
		});
		expect(both.discountTotal).toBe(2000 + 800);
	});

	it('admits deals by priority when the strategy is priority', () => {
		const settings = settingsWith({ stacking: { strategy: 'priority' } });
		const low = deal({ ...twenty, id: 'dl_low', priority: 1 }, settings);
		const high = deal({ ...ten, id: 'dl_high', priority: 5 }, settings);
		const exclusiveCart = deal(
			{ id: 'dl_excl', kind: 'cart', name: 'excl', class: 'exclusive', priority: 10, action: { type: 'percent', percent: 1 } },
			settings,
		);
		const result = run([shoe], [low, high], { settings });
		expect(result.deals.map((d) => d.dealId)).toEqual(['dl_high']);
		// a higher-priority exclusive cart deal blocks the item deals on every line it touches
		const blocked = run([shoe], [low, high, exclusiveCart], { settings });
		expect(blocked.deals.map((d) => d.dealId)).toEqual(['dl_excl']);
		// a cart deal whose threshold is not met is dropped and the item deals come back
		const unmet = deal({ ...exclusiveCart, id: 'dl_unmet', conditions: { minSubtotal: 1_000_000 } }, settings);
		expect(run([shoe], [low, high, unmet], { settings }).deals.map((d) => d.dealId)).toEqual(['dl_high']);
	});
});

describe('cart deals', () => {
	it('measures thresholds after item discounts (or before), tiers, caps and free shipping', () => {
		const item = deal({ kind: 'item', name: 'i', action: { type: 'percent', percent: 50 }, scope: { collections: ['shoes'] } });
		const threshold = deal({ kind: 'cart', name: 'fs', conditions: { minSubtotal: 8000 }, action: { type: 'free_shipping' } });
		const after = run([shoe], [item, threshold], { extra: { shippingAmount: 500 } });
		expect(after.shipping).toEqual({ amount: 500, discount: 0, free: false });
		expect(after.hints).toEqual([
			{ dealId: threshold.id, name: 'fs', basis: 'subtotal', remaining: 3000, reward: { type: 'free_shipping' } },
		]);
		const before = settingsWith({ cart_deals: { threshold_basis: 'before_discounts' } });
		expect(run([shoe], [item, threshold], { settings: before, extra: { shippingAmount: 500 } }).shipping.free).toBe(true);
		const tiered = deal({
			kind: 'cart',
			name: 't',
			action: {
				type: 'tiered',
				basis: 'quantity',
				tiers: [
					{ min: 2, percent: 5 },
					{ min: 4, amount: 1000, freeShipping: true },
				],
			},
		});
		expect(run([sock], [tiered]).discountTotal).toBe(150);
		const four = run([{ ...sock, quantity: 4 }], [tiered]);
		expect(four).toMatchObject({ discountTotal: 1000, shipping: { free: true } });
		expect(run([{ ...sock, quantity: 1 }], [tiered]).hints[0]).toMatchObject({
			basis: 'quantity',
			remaining: 1,
			reward: { type: 'tier', percent: 5 },
		});
		const capped = deal({
			kind: 'cart',
			name: 'c',
			action: { type: 'percent', percent: 50, maxDiscount: 700 },
			scope: { collections: ['socks'] },
		});
		const scoped = run([shoe, sock], [capped]);
		expect(scoped.lines.map((l) => l.discount)).toEqual([0, 700]);
		const qty = deal({ kind: 'cart', name: 'q', conditions: { minQuantity: 5 }, action: { type: 'amount_off', amount: 300 } });
		expect(run([sock], [qty]).hints[0]).toMatchObject({ basis: 'quantity', remaining: 2 });
		expect(run([{ ...sock, quantity: 5 }], [qty]).discountTotal).toBe(300);
		// cart amounts spread across eligible lines and sum exactly
		const spread = run([shoe, sock], [deal({ kind: 'cart', name: 's', action: { type: 'amount_off', amount: 1001 } })]);
		expect(spread.lines.reduce((s, l) => s + l.discount, 0)).toBe(1001);
		expect(cartReward(/** @type {any} */ ({ action: { type: 'other' } }), { measure: 0, quantity: 0 })).toBeNull();
		expect(cartReward(tiered, { measure: 0, quantity: 1 })).toBeNull();
		expect(rewardSummary(tiered.action)).toMatchObject({ type: 'tiered', upTo: { type: 'tier', amount: 1000 } });
	});

	it('reports whether coupons and loyalty points may combine', () => {
		const exclusive = deal({
			kind: 'item',
			name: 'e',
			action: { type: 'percent', percent: 5 },
			combinesWithCoupons: false,
			combinesWithLoyalty: false,
		});
		expect(run([shoe], [exclusive])).toMatchObject({ couponsAllowed: false, loyaltyAllowed: false });
		expect(run([shoe], [])).toMatchObject({ couponsAllowed: true, loyaltyAllowed: true, discountTotal: 0, total: 10_000 });
	});
});

describe('bundles', () => {
	it('forms mix-and-match instances from the most expensive units, each unit once', () => {
		const mix = deal({
			kind: 'bundle',
			name: 'any 3 for 20',
			bundle: { type: 'mix_and_match', scope: { collections: ['socks'] }, quantity: 3 },
			action: { type: 'fixed_price', amount: 2000 },
		});
		const result = run([sock, { itemId: 'luxe', quantity: 1, unitAmount: 1500, collections: ['socks'] }, shoe], [mix]);
		// 4 socks → one bundle of the 3 most expensive (1500 + 1000 + 1000 = 3500 → 2000)
		expect(result.discountTotal).toBe(1500);
		expect(result.lines.map((l) => l.discount)).toEqual([857, 643, 0]);
		const none = run([{ ...sock, quantity: 2 }], [mix]);
		expect(none.discountTotal).toBe(0);
	});

	it('prices buy-together components and caps bundles per order', () => {
		const together = deal({
			kind: 'bundle',
			name: 'shoe + socks',
			bundle: {
				type: 'buy_together',
				components: [
					{ scope: { collections: ['shoes'] }, quantity: 1 },
					{ scope: { collections: ['socks'] }, quantity: 2 },
				],
				maxPerOrder: 1,
			},
			action: { type: 'percent', percent: 10 },
		});
		const result = run(
			[
				{ ...shoe, quantity: 2 },
				{ ...sock, quantity: 5 },
			],
			[together],
		);
		expect(result.discountTotal).toBe(1200); // one bundle: (10000 + 2 × 1000) × 10 %
		expect(result.deals[0]).toMatchObject({ kind: 'bundle', units: 3 });
		expect(run([shoe], [together]).discountTotal).toBe(0);
		// lines matching several components are not used twice
		const pools = () => [{ lineId: 'x', unitPrice: 100, available: 1 }];
		expect(
			formInstances(
				{
					type: 'buy_together',
					components: [
						{ scope: {}, quantity: 1 },
						{ scope: {}, quantity: 1 },
					],
				},
				pools,
				5,
			),
		).toEqual([]);
		expect(instanceDiscount({ type: 'amount_off', amount: 50 }, 30, 'half_up')).toBe(30);
		expect(instanceDiscount({ type: 'other' }, 30, 'half_up')).toBe(0);
	});
});

describe('price locks in the engine', () => {
	const ten = deal({
		id: 'dl_lock10',
		kind: 'item',
		name: 'ten',
		scope: { collections: ['shoes'] },
		action: { type: 'percent', percent: 10 },
	});
	const lock = (/** @type {number} */ unitPrice) =>
		new Map([
			[
				'1',
				{
					lock: /** @type {const} */ (true),
					id: 'lock:1',
					lineId: '1',
					unitPrice,
					maxUnits: 1,
					dealIds: ['dl_lock10'],
					classes: ['item'],
					priority: Number.MAX_SAFE_INTEGER,
				},
			],
		]);
	it('honours a lock, or a better live price when preferred', () => {
		const honoured = run([{ ...shoe, quantity: 2 }], [ten], { locks: lock(8000) });
		// one locked unit at 8000, the second unit at the list price (the lock replaces item deals on the line)
		expect(honoured.lines[0]).toMatchObject({ discount: 2000, locked: true });
		const better = run(
			[{ ...shoe, quantity: 2 }],
			[deal({ ...ten, id: 'dl_lock10', action: { type: 'percent', percent: 30 } })],
			{ locks: lock(8000) },
		);
		expect(better.lines[0]).toMatchObject({ discount: 6000, locked: false });
		const strict = settingsWith({ price_locks: { prefer_better_live_price: false } });
		const forced = run(
			[{ ...shoe, quantity: 2 }],
			[deal({ ...ten, id: 'dl_lock10', action: { type: 'percent', percent: 30 } }, strict)],
			{ settings: strict, locks: lock(8000) },
		);
		expect(forced.lines[0]).toMatchObject({ discount: 2000, locked: true });
		// a forced lock rules out group deals that cannot combine with its classes
		const exclusive = deal(
			{ id: 'dl_x', kind: 'cart', name: 'x', class: 'exclusive', action: { type: 'percent', percent: 50 } },
			strict,
		);
		expect(run([shoe], [ten, exclusive], { settings: strict, locks: lock(8000) }).deals.map((d) => d.dealId)).toEqual([
			'dl_lock10',
		]);
		const priority = settingsWith({ stacking: { strategy: 'priority' }, price_locks: { prefer_better_live_price: false } });
		expect(run([shoe], [ten], { settings: priority, locks: lock(8000) }).lines[0]).toMatchObject({
			locked: true,
			discount: 2000,
		});
		const priorityLive = settingsWith({ stacking: { strategy: 'priority' } });
		const live30 = deal({ ...ten, id: 'dl_lock10', action: { type: 'percent', percent: 30 } }, priorityLive);
		expect(run([shoe], [live30], { settings: priorityLive, locks: lock(8000) }).lines[0]).toMatchObject({
			locked: false,
			discount: 3000,
		});
	});
});
