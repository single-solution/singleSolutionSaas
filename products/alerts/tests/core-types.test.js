import { describe, expect, it } from 'vitest';
import {
	addressFor,
	contactIdOf,
	fieldOf,
	isChannel,
	maskAddress,
	normalizeEmail,
	normalizePhone,
	resolveAddress,
} from '../core/contact.js';
import { claimOf, notifyCount, rankOf, waitlistOrder } from '../core/priority.js';
import {
	availableFrom,
	customKeyOf,
	customType,
	dropPercent,
	enabledTypes,
	freeUnits,
	isId,
	isMoney,
	isTypeEnabled,
	matchingKeys,
	priceReference,
	shouldFire,
	targetKeyOf,
} from '../core/types.js';

/** @type {import('../core/types.js').TypeSettings} */
const settings = {
	backInStock: true,
	priceDrop: true,
	availability: true,
	minDropPercent: 0,
	minDropAmount: 0,
	allowTarget: true,
	requiresStock: true,
	customTypes: [
		{ key: 'preorder', event: 'custom.preorder_opened' },
		{ key: 'Bad Key', event: 'custom.x' },
	],
};
const eur = (/** @type {number} */ amount) => ({ amount, currency: 'EUR' });

describe('types', () => {
	it('lists enabled types and custom keys', () => {
		expect(enabledTypes(settings)).toEqual(['back_in_stock', 'price_drop', 'availability', 'custom:preorder']);
		expect(enabledTypes({ ...settings, backInStock: false, priceDrop: false, availability: false, customTypes: [] })).toEqual(
			[],
		);
		expect(isTypeEnabled('custom:preorder', settings)).toBe(true);
		expect(isTypeEnabled('custom:Bad Key', settings)).toBe(false);
		expect(customType('x')).toBe('custom:x');
		expect(customKeyOf('custom:restock_vip')).toBe('restock_vip');
		expect(customKeyOf('back_in_stock')).toBeNull();
		expect(customKeyOf('custom:9x')).toBeNull();
	});

	it('keys targets and the subscriptions a change concerns', () => {
		expect(targetKeyOf({ itemId: 'itm_1' })).toBe('itm_1|');
		expect(targetKeyOf({ itemId: 'itm_1', variantId: 'v1' })).toBe('itm_1|v1');
		expect(matchingKeys({ itemId: 'itm_1', variantId: 'v1' })).toEqual(['itm_1|v1', 'itm_1|']);
		expect(matchingKeys({ itemId: 'itm_1' })).toEqual(['itm_1|']);
		expect(isId('itm_1')).toBe(true);
		expect(isId('bad id')).toBe(false);
		expect(isId(42)).toBe(false);
	});

	it('checks money and availability', () => {
		expect(isMoney(eur(10))).toBe(true);
		expect(isMoney({ amount: -1, currency: 'EUR' })).toBe(false);
		expect(isMoney({ amount: 1, currency: 'eur' })).toBe(false);
		expect(isMoney(null)).toBe(false);
		expect(availableFrom(undefined, 0)).toBeUndefined();
		expect(availableFrom(1, 0)).toBe(true);
		expect(availableFrom(2, 2)).toBe(false);
		expect(freeUnits({ quantity: 7 }, 2)).toBe(5);
		expect(freeUnits({ quantity: 1 }, 2)).toBe(0);
		expect(freeUnits({}, 0)).toBeNull();
	});

	it('fires back-in-stock and availability on the transition to available only', () => {
		const sub = { type: 'back_in_stock' };
		expect(shouldFire(sub, { available: false }, { available: true }, settings)).toBe(true);
		expect(shouldFire(sub, {}, { available: true }, settings)).toBe(true);
		expect(shouldFire(sub, { available: true }, { available: true }, settings)).toBe(false);
		expect(shouldFire(sub, { available: false }, { available: false }, settings)).toBe(false);
		expect(shouldFire({ type: 'availability' }, { available: false }, { available: true }, settings)).toBe(true);
		expect(shouldFire({ type: 'custom:x' }, { available: false }, { available: true }, settings)).toBe(false);
	});

	it('computes the price-drop reference (target, percent, amount, at least one unit)', () => {
		const t = { minDropPercent: 0, minDropAmount: 0, allowTarget: true };
		expect(priceReference({ priceAtSubscribe: eur(1000) }, {}, t)).toEqual(eur(999));
		expect(priceReference({ priceAtSubscribe: eur(1000), threshold: { percent: 10 } }, {}, t)).toEqual(eur(900));
		expect(priceReference({ priceAtSubscribe: eur(1000), threshold: { amount: 250 } }, {}, t)).toEqual(eur(750));
		expect(priceReference({ priceAtSubscribe: eur(1000) }, {}, { ...t, minDropPercent: 20 })).toEqual(eur(800));
		expect(priceReference({ priceAtSubscribe: eur(1000) }, {}, { ...t, minDropAmount: 300 })).toEqual(eur(700));
		expect(priceReference({ threshold: { targetAmount: 500 } }, { price: eur(800) }, t)).toEqual(eur(500));
		expect(priceReference({ threshold: { targetAmount: 500 } }, {}, t)).toBeNull();
		expect(
			priceReference({ threshold: { targetAmount: 500 }, priceAtSubscribe: eur(900) }, {}, { ...t, allowTarget: false }),
		).toEqual(eur(899));
		expect(priceReference({}, {}, t)).toBeNull();
		expect(priceReference({}, { price: eur(0) }, t)).toBeNull();
		expect(priceReference({}, { price: eur(400) }, t)).toEqual(eur(399));
	});

	it('fires price drops (ported from ibrahimMobiles shouldSendStockAlert)', () => {
		const sub = { type: 'price_drop', priceAtSubscribe: eur(1000) };
		const inStock = { available: true, price: eur(1000) };
		expect(shouldFire(sub, inStock, { available: true, price: eur(900) }, settings)).toBe(true);
		expect(shouldFire(sub, inStock, { available: true, price: eur(1000) }, settings)).toBe(false);
		expect(shouldFire(sub, inStock, { available: true, price: eur(1200) }, settings)).toBe(false);
		// sold out: not while out of stock when requiresStock, but on coming back cheaper
		expect(shouldFire(sub, inStock, { available: false, price: eur(900) }, settings)).toBe(false);
		expect(shouldFire(sub, inStock, { available: false, price: eur(900) }, { ...settings, requiresStock: false })).toBe(true);
		expect(shouldFire(sub, { available: false, price: eur(900) }, { available: true, price: eur(900) }, settings)).toBe(true);
		// unknown previous price: the price at subscription is the reference
		expect(shouldFire(sub, {}, { price: eur(800) }, settings)).toBe(true);
		expect(shouldFire({ type: 'price_drop' }, {}, { price: eur(800) }, settings)).toBe(false);
		// target price
		const target = { type: 'price_drop', priceAtSubscribe: eur(1000), threshold: { targetAmount: 700 } };
		expect(shouldFire(target, inStock, { available: true, price: eur(800) }, settings)).toBe(false);
		expect(shouldFire(target, inStock, { available: true, price: eur(700) }, settings)).toBe(true);
		// other currency, free item, no price
		expect(shouldFire(sub, inStock, { available: true, price: { amount: 1, currency: 'USD' } }, settings)).toBe(false);
		expect(shouldFire(sub, inStock, { available: true, price: eur(0) }, settings)).toBe(false);
		expect(shouldFire(sub, inStock, { available: true }, settings)).toBe(false);
		expect(
			shouldFire(
				sub,
				{ available: true, price: { amount: 2000, currency: 'USD' } },
				{ available: true, price: eur(900) },
				settings,
			),
		).toBe(false);
	});

	it('computes drop percents', () => {
		expect(dropPercent(eur(1000), eur(750))).toBe(25);
		expect(dropPercent(eur(1000), eur(1000))).toBe(0);
		expect(dropPercent(eur(0), eur(10))).toBe(0);
		expect(dropPercent(null, eur(10))).toBe(0);
		expect(dropPercent(eur(1000), { amount: 1, currency: 'USD' })).toBe(0);
	});
});

describe('contact', () => {
	it('normalises e-mails and international phone numbers', () => {
		expect(normalizeEmail('  Jane@Example.COM ')).toBe('jane@example.com');
		expect(normalizeEmail('nope')).toBeNull();
		expect(normalizeEmail(`${'a'.repeat(250)}@x.io`)).toBeNull();
		expect(normalizeEmail(5)).toBeNull();
		expect(normalizePhone('+44 (0)20 7946-0958'.replace('(0)', ''))).toBe('+442079460958');
		expect(normalizePhone('0044 20 7946 0958')).toBe('+442079460958');
		expect(normalizePhone('020 7946 0958')).toBeNull();
		expect(normalizePhone('+0123456789')).toBeNull();
		expect(normalizePhone('x'.repeat(41))).toBeNull();
		expect(normalizePhone(null)).toBeNull();
	});

	it('maps channels to address fields', () => {
		expect(isChannel('whatsapp')).toBe(true);
		expect(isChannel('fax')).toBe(false);
		expect(fieldOf('email')).toBe('email');
		expect(fieldOf('sms')).toBe('phone');
		expect(addressFor('email', 'a@b.co')).toEqual({ email: 'a@b.co' });
		expect(addressFor('whatsapp', '+5511987654321')).toEqual({ phone: '+5511987654321' });
		expect(addressFor('sms', 'bad')).toBeNull();
		expect(addressFor('email', 'bad')).toBeNull();
		expect(contactIdOf({ email: 'a@b.co' })).toBe('email:a@b.co');
		expect(contactIdOf({ phone: '+15550001111' })).toBe('phone:+15550001111');
	});

	it('resolves the address from the identity or the typed entry', () => {
		const open = { allowEntry: true, preferIdentity: true };
		const identity = { email: 'login@example.com' };
		expect(resolveAddress({ channel: 'email', email: 'typed@example.com' }, identity, open)).toEqual({
			ok: true,
			address: { email: 'login@example.com' },
			source: 'identity',
		});
		expect(
			resolveAddress({ channel: 'email', email: 'typed@example.com' }, identity, { ...open, preferIdentity: false }),
		).toMatchObject({
			address: { email: 'typed@example.com' },
			source: 'entry',
		});
		expect(resolveAddress({ channel: 'email' }, identity, { ...open, preferIdentity: false })).toMatchObject({
			source: 'identity',
		});
		expect(resolveAddress({ channel: 'email' }, null, open)).toEqual({ ok: false, code: 'contact_required' });
		expect(resolveAddress({ channel: 'email' }, null, { allowEntry: false, preferIdentity: true })).toEqual({
			ok: false,
			code: 'entry_not_allowed',
		});
		expect(resolveAddress({ channel: 'sms', phone: '12' }, null, open)).toEqual({ ok: false, code: 'contact_invalid' });
		expect(
			resolveAddress({ channel: 'sms', phone: '+15550001111' }, null, { allowEntry: false, preferIdentity: false }),
		).toEqual({
			ok: false,
			code: 'entry_not_allowed',
		});
		expect(
			resolveAddress({ channel: 'email', email: 'x@y.zz' }, identity, { allowEntry: false, preferIdentity: false }),
		).toMatchObject({ source: 'identity' });
		expect(resolveAddress({ channel: 'sms', phone: '+15550001111' }, identity, open)).toMatchObject({ source: 'entry' });
	});

	it('masks addresses', () => {
		expect(maskAddress({ email: 'jane@example.com' })).toBe('j•••@example.com');
		expect(maskAddress({ phone: '+442079460958' })).toBe('+44•••••••958');
		expect(maskAddress(null)).toBeNull();
		expect(maskAddress(/** @type {any} */ ({ other: 1 }))).toBeNull();
	});
});

describe('priority', () => {
	const tiers = [
		{ key: 'gold', rank: 0 },
		{ key: 'silver', rank: 1 },
	];
	it('ranks tiers (lower first, unknown last) and FIFO otherwise', () => {
		expect(rankOf('gold', { order: 'tier', tiers })).toBe(0);
		expect(rankOf('silver', { order: 'tier', tiers })).toBe(1);
		expect(rankOf('bronze', { order: 'tier', tiers })).toBe(2);
		expect(rankOf(null, { order: 'tier', tiers })).toBe(2);
		expect(rankOf('gold', { order: 'fifo', tiers })).toBe(0);
		expect(rankOf(null, { order: 'tier', tiers: [] })).toBe(1);
	});

	it('limits availability waitlists by free units', () => {
		expect(notifyCount({ type: 'back_in_stock', freeUnits: 2, perUnit: 1 })).toBeNull();
		expect(notifyCount({ type: 'availability', freeUnits: 3, perUnit: 2 })).toBe(6);
		expect(notifyCount({ type: 'availability', freeUnits: null, perUnit: 2 })).toBeNull();
		expect(notifyCount({ type: 'custom:x', freeUnits: -1, perUnit: 0, capacityLimited: true })).toBe(0);
	});

	it('orders waitlists and reads claims', () => {
		const rows = [
			{ id: 'b', rank: 1, subscribedAt: '2026-01-01' },
			{ id: 'a', rank: 1, subscribedAt: '2026-01-01' },
			{ id: 'c', rank: 0, subscribedAt: '2026-02-01' },
			{ id: 'd', subscribedAt: '2025-01-01' },
		];
		expect([...rows].sort(waitlistOrder).map((row) => row.id)).toEqual(['d', 'c', 'a', 'b']);
		expect(claimOf({ tier: 'gold' }, 'tier')).toBe('gold');
		expect(claimOf({ loyalty: { tier: 'silver' } }, 'loyalty.tier')).toBe('silver');
		expect(claimOf({ loyalty: { tier: 3 } }, 'loyalty.tier')).toBeNull();
		expect(claimOf({ loyalty: null }, 'loyalty.tier')).toBeNull();
		expect(claimOf(null, 'tier')).toBeNull();
		expect(claimOf({ tier: 'x'.repeat(65) }, 'tier')).toBeNull();
		expect(claimOf({ tier: 'gold' }, '')).toBeNull();
	});
});
