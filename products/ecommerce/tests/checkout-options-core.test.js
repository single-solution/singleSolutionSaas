/**
 * The pure parts of the Phase 4 checkout options (PLAN 0.8.10 E18–E25): deal conditions, windows and locks, role
 * pricing, loyalty options, guests and order keys, COD fees and whole-unit amounts.
 */
import { describe, expect, it } from 'vitest';
import { codAdvance, codFee } from '../core/cod.js';
import { feeBaseOf, paymentOptions, priceLines, roleDiscountOf } from '../core/checkout.js';
import {
	conditionsHold,
	DEAL_RULES,
	dealLineDiscount,
	dealRulesOf,
	dealUnitDiscount,
	inWindow,
	NO_CONDITIONS,
} from '../core/deals.js';
import { keyOpens, newOrderKey, orderKeyHash, readLock, signLock } from '../adapters/crypto.js';
import { checkGuest, ORDER_KEY_LENGTH, phoneDigitsOf, phoneRules } from '../core/guests.js';
import { expiryFor, lotsByRule, pointsToEarn, pointsToRedeem, takesPart } from '../core/loyalty.js';
import { allocateUnits, roundDown, roundHalfUp, unitOf } from '../core/money.js';
import { checkRolePrices } from '../core/role-pricing.js';

const NOW = Date.parse('2026-10-05T10:00:00Z');
const empty = () => ({ everything: false, productIds: [], categoryIds: [], brandIds: [] });
/** @param {Record<string, any>} [o] @returns {any} */
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
/** @param {Record<string, any>} [o] */
const dealLine = (o = {}) => ({
	productId: 'p1',
	categoryIds: ['c1'],
	brandId: 'b1',
	grade: 'a',
	attributes: { att_colour: ['red'] },
	unitPrice: 1000,
	quantity: 1,
	...o,
});
const cart = { goods: 5000, paymentMethod: 'cod', weekday: 1, minutes: 600 };

describe('whole units (E25)', () => {
	it('knows the unit and rounds down, half up and in parts', () => {
		expect(unitOf('PKR', true)).toBe(100);
		expect(unitOf('PKR', false)).toBe(1);
		expect(unitOf('JPY', true)).toBe(1);
		expect(roundDown(1999, 100)).toBe(1900);
		expect(roundDown(19.9)).toBe(19);
		expect(roundHalfUp(1950, 100)).toBe(2000);
		expect(roundHalfUp(1949, 100)).toBe(1900);
		expect(allocateUnits(1000, [1, 1, 1], 100)).toEqual([400, 300, 300]);
		expect(allocateUnits(1050, [1, 3], 100)).toEqual([300, 750]);
		expect(allocateUnits(10, [1, 1])).toEqual([5, 5]);
	});

	it('rounds deal discounts down and fees and role discounts half up', () => {
		expect(dealUnitDiscount(deal({ value: 15 }), 1990, 100)).toBe(200);
		expect(dealUnitDiscount(deal({ value: 15 }), 1990)).toBe(299);
		expect(codFee(10_050, { feePercent: 5 }, 100)).toBe(500);
		expect(codFee(10_000, { feePercent: 25 })).toBe(2000);
		expect(codFee(10_000, { feePercent: 0 })).toBe(0);
		expect(roleDiscountOf(10_050, 10, 100)).toBe(1000);
		expect(roleDiscountOf(0, 10)).toBe(0);
		expect(codAdvance(10_050, { advanceAmount: 0, advancePercent: 10 }, 100)).toBe(1100);
	});

	it('reads the deal rules and works deals out exactly with total_half_up (D4)', () => {
		expect(DEAL_RULES).toEqual({
			rounding: 'per_unit_down',
			lineChoice: 'best',
			cartOffer: 'per_line_best',
			cartThresholdBase: 'goods',
			pointsBlockedBy: 'any_deal',
		});
		const set = {
			rounding: 'total_half_up',
			lineChoice: 'first',
			cartOffer: 'one_exclusive',
			cartThresholdBase: 'after_item_deals',
			pointsBlockedBy: 'cart_offer',
		};
		expect(dealRulesOf(set)).toEqual(set);
		expect(dealRulesOf({ rounding: 'sideways', lineChoice: 7 })).toEqual(DEAL_RULES);
		const exact = { rounding: /** @type {const} */ ('total_half_up') };
		expect(dealLineDiscount(deal({ value: 7 }), { unitPrice: 499_900, quantity: 1 }, { unit: 100 })).toBe(34_900);
		expect(dealLineDiscount(deal({ value: 7 }), { unitPrice: 499_900, quantity: 1 }, exact)).toBe(34_993);
		expect(dealLineDiscount(deal({ type: 'fixed', value: 1500 }), { unitPrice: 1000, quantity: 2 }, exact)).toBe(2000);
		expect(dealLineDiscount(deal({ target: 'cart', value: 7 }), { unitPrice: 499_900, quantity: 3 }, exact)).toBe(104_979);
		const share = { ...exact, share: 333.5 };
		expect(dealLineDiscount(deal({ target: 'cart', type: 'fixed', value: 500 }), { unitPrice: 1000, quantity: 1 }, share)).toBe(
			333.5,
		);
	});
});

describe('deal conditions and windows (E18)', () => {
	it('matches rules, groups and cart facts', () => {
		/** @returns {any} */
		const rules = (/** @type {any[]} */ list, match = 'all') => ({ ...NO_CONDITIONS, match, rules: list });
		expect(conditionsHold(null, dealLine(), cart)).toBe(true);
		expect(conditionsHold(rules([{ field: 'grades', op: 'in', values: ['a'] }]), dealLine(), cart)).toBe(true);
		expect(conditionsHold(rules([{ field: 'grades', op: 'not_in', values: ['a'] }]), dealLine(), cart)).toBe(false);
		const attribute = { field: 'attribute', attributeId: 'att_colour', op: 'in', values: ['red'] };
		expect(conditionsHold(rules([attribute]), dealLine(), cart)).toBe(true);
		expect(conditionsHold(rules([attribute]), dealLine({ attributes: {} }), cart)).toBe(false);
		const either = rules(
			[
				{ field: 'brands', op: 'in', values: ['b9'] },
				{ field: 'categories', op: 'in', values: ['c1'] },
			],
			'any',
		);
		expect(conditionsHold(either, dealLine(), cart)).toBe(true);
		const group = /** @type {any} */ ({
			...NO_CONDITIONS,
			groups: [{ match: 'all', rules: [{ field: 'products', op: 'in', values: ['p2'] }] }],
		});
		expect(conditionsHold(group, dealLine(), cart)).toBe(false);
		expect(conditionsHold({ ...NO_CONDITIONS, priceRange: { min: 500, max: 900 } }, dealLine(), cart)).toBe(false);
		expect(conditionsHold({ ...NO_CONDITIONS, minQuantity: 2 }, dealLine({ quantity: 2 }), cart)).toBe(true);
		expect(conditionsHold({ ...NO_CONDITIONS, cartTotal: 6000 }, dealLine(), cart)).toBe(false);
		expect(conditionsHold({ ...NO_CONDITIONS, paymentMethods: ['online'] }, dealLine(), cart)).toBe(false);
	});

	it('judges weekdays and hours, also past midnight', () => {
		expect(inWindow({ days: [], timeFrom: '', timeTo: '' }, { weekday: 3, minutes: 0 })).toBe(true);
		expect(inWindow({ days: [1], timeFrom: '', timeTo: '' }, { weekday: 2, minutes: 600 })).toBe(false);
		expect(inWindow({ days: [], timeFrom: '09:00', timeTo: '17:00' }, { weekday: 2, minutes: 17 * 60 })).toBe(false);
		const night = { days: [5], timeFrom: '22:00', timeTo: '02:00' };
		expect(inWindow(night, { weekday: 5, minutes: 23 * 60 })).toBe(true);
		expect(inWindow(night, { weekday: 6, minutes: 60 })).toBe(true);
		expect(inWindow(night, { weekday: 5, minutes: 60 })).toBe(false);
	});

	it('takes cart deals off the whole line', () => {
		expect(dealLineDiscount(deal({ target: 'cart' }), { unitPrice: 1000, quantity: 3 })).toBe(300);
		expect(
			dealLineDiscount(deal({ target: 'cart', type: 'fixed', value: 500 }), { unitPrice: 1000, quantity: 1 }, { share: 250 }),
		).toBe(250);
		expect(dealLineDiscount(deal({ type: 'free_delivery' }), { unitPrice: 1000, quantity: 1 })).toBe(0);
		expect(dealLineDiscount(deal(), { unitPrice: 1000, quantity: 3 })).toBe(300);
	});
});

describe('deal locks (E18)', () => {
	const key = { secret: 'secret-of-the-website', websiteId: 'web_1' };
	const lock = { dealId: 'deal_1', variantId: 'var_1', price: 1000, perUnit: 100, exp: NOW + 60_000 };

	it('reads back what it signed until it ends', () => {
		const text = signLock(lock, key);
		expect(readLock(text, { ...key, now: NOW })).toEqual(lock);
		expect(readLock(text, { ...key, now: NOW + 60_000 })).toBeNull();
	});

	it('refuses other websites, other secrets and changed bodies', () => {
		const text = signLock(lock, key);
		expect(readLock(text, { ...key, websiteId: 'web_2', now: NOW })).toBeNull();
		expect(readLock(text, { ...key, secret: 'other', now: NOW })).toBeNull();
		const [, signature] = text.split('.');
		const forged = Buffer.from(JSON.stringify({ d: 'deal_1', v: 'var_1', p: 1000, u: 999, e: NOW + 60_000 })).toString(
			'base64url',
		);
		expect(readLock(`${forged}.${signature}`, { ...key, now: NOW })).toBeNull();
		expect(readLock('x'.repeat(601), { ...key, now: NOW })).toBeNull();
		expect(readLock(42, { ...key, now: NOW })).toBeNull();
		expect(readLock('a.b.c', { ...key, now: NOW })).toBeNull();
	});
});

describe('role pricing (E19)', () => {
	it('checks the list', () => {
		expect(checkRolePrices([{ role: 'member', percent: 10, label: '' }])).toEqual({
			ok: true,
			value: [{ role: 'member', percent: 10, label: 'Member discount' }],
		});
		expect(checkRolePrices('x').ok).toBe(false);
		expect(checkRolePrices([{ role: 'member', percent: 95 }]).ok).toBe(false);
		expect(checkRolePrices([{ role: 'bad role', percent: 5 }]).ok).toBe(false);
		expect(
			checkRolePrices([
				{ role: 'a', percent: 5 },
				{ role: 'a', percent: 6 },
			]).ok,
		).toBe(false);
	});

	it('takes the percent after offers and before delivery, spread over the lines', () => {
		/** @type {any[]} */
		const lines = [
			{ key: 'a', unitPrice: 3000, quantity: 1, allCategoryIds: [] },
			{ key: 'b', unitPrice: 1000, quantity: 1, allCategoryIds: [] },
		];
		const priced = priceLines({
			lines,
			promotions: null,
			delivery: 500,
			pointsValue: 0,
			taxRules: [],
			region: null,
			taxIncluded: false,
			rolePercent: 10,
		});
		expect(priced.lines.map((line) => line.role)).toEqual([300, 100]);
		expect(priced.totals).toMatchObject({ roleDiscount: 400, delivery: 500, total: 4100 });
	});
});

describe('loyalty options (E20)', () => {
	it('lets listed roles take part', () => {
		expect(takesPart({}, undefined)).toBe(true);
		expect(takesPart({ roles: ['member'] }, 'member')).toBe(true);
		expect(takesPart({ roles: ['member'] }, 'customer')).toBe(false);
	});

	it('earns on the goods or the whole total', () => {
		const totals = { total: 12_000, delivery: 1000, tax: 0, fee: 1000 };
		expect(pointsToEarn(totals, { earnPercent: 10, pointValue: 100 })).toBe(10);
		expect(pointsToEarn(totals, { earnPercent: 10, pointValue: 100, earnBase: 'total' })).toBe(12);
	});

	it('redeems the most with one switch and keeps whole-unit values', () => {
		const settings = { pointValue: 30, minRedeem: 1 };
		expect(pointsToRedeem(5, 50, settings)).toBe(5);
		expect(pointsToRedeem(5, 50, { ...settings, redeemMode: 'maximum' })).toBe(50);
		expect(pointsToRedeem(0, 50, { ...settings, redeemMode: 'maximum' })).toBe(0);
		expect(pointsToRedeem(7, 50, settings, 100)).toBe(6);
		expect(pointsToRedeem(5, 50, { ...settings, minRedeem: 10 })).toBe(0);
	});

	it('expires by days or calendar months, and by the current rule when asked', () => {
		const earned = Date.parse('2026-01-31T10:00:00Z');
		expect(expiryFor(earned, { expiryDays: 0 })).toBeNull();
		expect(expiryFor(earned, { expiryDays: 2 })?.toISOString()).toBe('2026-02-02T10:00:00.000Z');
		expect(expiryFor(earned, { expiryDays: 1, expiryUnit: 'months' })?.toISOString()).toBe('2026-02-28T10:00:00.000Z');
		expect(expiryFor(earned, { expiryDays: 1, expiryUnit: 'months' }, 'Asia/Karachi')?.toISOString()).toBe(
			'2026-02-28T10:00:00.000Z',
		);
		const lots = [
			{ earnedAt: new Date(earned), expiresAt: null, points: 5, left: 5 },
			{ earnedAt: new Date(earned), expiresAt: new Date(NOW), points: 5, left: 5, kind: 'refund' },
		];
		const byRule = /** @type {any[]} */ (lotsByRule(/** @type {any} */ (lots), { expiryDays: 3, expiryRule: 'current' }));
		expect(byRule[0].expiresAt.toISOString()).toBe('2026-02-03T10:00:00.000Z');
		expect(byRule[1].expiresAt).toEqual(new Date(NOW));
		expect(lotsByRule(/** @type {any} */ (lots), { expiryDays: 3 })).toBe(lots);
	});
});

describe('guests and order keys (E21)', () => {
	it('reads phones with the shared normaliser and the website’s rules (K12)', () => {
		expect(phoneRules({ defaultCallingCode: '', trunkPrefix: '' }, 'PK')).toEqual({
			defaultCallingCode: '+92',
			trunkPrefix: '',
		});
		expect(phoneRules({ defaultCallingCode: '+44', trunkPrefix: '0' }, 'PK')).toEqual({
			defaultCallingCode: '+44',
			trunkPrefix: '0',
		});
		expect(phoneRules({}, null)).toEqual({ defaultCallingCode: '', trunkPrefix: '' });
		expect(phoneDigitsOf('+923001234567')).toBe('3001234567');
		expect(phoneDigitsOf(null)).toBe('');
	});

	it('checks a guest', () => {
		const rules = phoneRules({}, 'PK');
		expect(checkGuest({ name: ' Ayesha ', phone: '03001234567', email: 'A@X.PK' }, rules)).toEqual({
			ok: true,
			value: { name: 'Ayesha', phone: '+923001234567', email: 'a@x.pk' },
		});
		// already international without the +, and a trunk 0 after the code: one number, no second code
		for (const [typed, phone] of [
			['923001234567', '+923001234567'],
			['+92 0320 4862403', '+923204862403'],
			['0300-1234567', '+923001234567'],
			['0092 300 1234567', '+923001234567'],
		])
			expect(checkGuest({ name: 'A', phone: typed }, rules)).toMatchObject({ value: { phone } });
		// without a calling code (no setting, no business country) only international numbers are read
		const none = phoneRules({}, null);
		expect(checkGuest({ name: 'A', phone: '03001234567' }, none)).toMatchObject({ field: 'customer/phone' });
		expect(checkGuest({ name: 'A', phone: '+92 300 1234567' }, none)).toMatchObject({ value: { phone: '+923001234567' } });
		expect(checkGuest(null, rules)).toMatchObject({ ok: false, field: 'customer' });
		expect(checkGuest({ name: '', phone: '03001234567' }, rules)).toMatchObject({ field: 'customer/name' });
		expect(checkGuest({ name: 'A', phone: 'x' }, rules)).toMatchObject({ field: 'customer/phone' });
		expect(checkGuest({ name: 'A', phone: '3+00' }, rules)).toMatchObject({ field: 'customer/phone' });
		expect(checkGuest({ name: 'A', phone: '03001234567', email: 'nope' }, rules)).toMatchObject({ field: 'customer/email' });
	});

	it('opens an order only with its own key', () => {
		const key = newOrderKey();
		expect(key).toHaveLength(ORDER_KEY_LENGTH);
		expect(newOrderKey()).not.toBe(key);
		const hash = orderKeyHash(key);
		expect(keyOpens(key, hash)).toBe(true);
		expect(keyOpens(newOrderKey(), hash)).toBe(false);
		expect(keyOpens(key, null)).toBe(false);
		expect(keyOpens('short', hash)).toBe(false);
	});
});

const COD = { maxOrderValue: 0, advanceAmount: 0, advancePercent: 0, rtoThreshold: 0, rtoRequireAdvance: false };
const OPTIONS = {
	offered: ['cod', 'online', 'bank_transfer', 'pickup'],
	paymentsConnected: true,
	cod: { on: true, settings: COD },
	pickupPossible: true,
	deliveryMethod: /** @type {'delivery'} */ ('delivery'),
	digital: false,
	total: 10_000,
	rtoCount: 0,
};

describe('payment options (E22, E23, E24)', () => {
	const base = OPTIONS;

	it('follows the merchant order, adds the COD fee and offers COD at pickup when asked', () => {
		const order = ['bank_transfer', 'cod', 'online', 'pickup'];
		expect(paymentOptions({ ...base, order }).map((option) => option.method)).toEqual(order);
		const fee = paymentOptions({ ...base, cod: { on: true, settings: { ...base.cod.settings, feePercent: 4 } } });
		expect(fee[0]).toMatchObject({ method: 'cod', available: true, fee: 400 });
		const pickup = { ...base, deliveryMethod: /** @type {any} */ ('pickup') };
		expect(paymentOptions(pickup)[0]).toMatchObject({ method: 'cod', available: false, reason: 'needs_delivery' });
		const atPickup = { ...pickup, cod: { on: true, settings: { ...base.cod.settings, atPickup: true } } };
		expect(paymentOptions(atPickup)[0]).toMatchObject({ method: 'cod', available: true });
	});

	it('offers bank transfer without Payments when staff record it', () => {
		const without = { ...base, paymentsConnected: false };
		expect(paymentOptions(without).map((option) => option.method)).toEqual(['cod', 'pickup']);
		expect(paymentOptions({ ...without, bankManual: true }).map((option) => option.method)).toEqual([
			'cod',
			'bank_transfer',
			'pickup',
		]);
	});

	it('adds the fee on the whole order', () => {
		/** @type {any[]} */
		const lines = [{ key: 'a', unitPrice: 10_000, quantity: 1, allCategoryIds: [] }];
		const priced = priceLines({
			lines,
			promotions: null,
			delivery: 500,
			pointsValue: 0,
			taxRules: [],
			region: null,
			taxIncluded: false,
			feePercent: 2,
		});
		expect(priced.totals).toMatchObject({ fee: 210, total: 10_710 });
	});

	it('takes the fee on the order total, or on the goods after discounts (feeBase, D4)', () => {
		/** @type {any[]} */
		const lines = [{ key: 'a', unitPrice: 10_000, quantity: 1, allCategoryIds: [] }];
		const base = {
			lines,
			promotions: null,
			delivery: 250,
			pointsValue: 1000,
			taxRules: [],
			region: null,
			taxIncluded: true,
			feePercent: 2,
		};
		// 2% of 10,000 goods with 250 delivery and 1,000 of points: 185 on the order total, 200 on the goods
		const whole = priceLines(base);
		expect(whole.totals).toMatchObject({ fee: 185, total: 9435 });
		const goods = priceLines({ ...base, feeBase: 'goods_after_discounts' });
		expect(goods.totals).toMatchObject({ fee: 200, total: 9450 });
		// the role discount comes off first: 2% of 9,000
		expect(priceLines({ ...base, rolePercent: 10, feeBase: 'goods_after_discounts' }).totals.fee).toBe(180);
		const unpriced = priceLines({ ...base, feePercent: 0 });
		expect(feeBaseOf(unpriced)).toBe(9250);
		expect(feeBaseOf(unpriced, 'goods_after_discounts')).toBe(10_000);
		const cod = { on: true, settings: { ...COD, feePercent: 2 } };
		const offered = { ...OPTIONS, cod, total: 9250 };
		expect(paymentOptions(offered)[0]).toMatchObject({ method: 'cod', fee: 185 });
		expect(paymentOptions({ ...offered, feeBase: 10_000 })[0]).toMatchObject({ method: 'cod', fee: 200 });
	});
});
