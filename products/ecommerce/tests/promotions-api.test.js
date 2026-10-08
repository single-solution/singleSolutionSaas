/**
 * Promotions routes: the merchant's coupons, deals and bundles (server token and admin tickets), loyalty accounts,
 * the shopper's deals, quotes and points, data rights, the widget settings and `loadOffers`.
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { givePoints } from '../adapters/ledger.js';
import { insertOffers, isDuplicate, loadOffers } from '../adapters/promotions-store.js';
import { COLLECTIONS } from '../core/model.js';
import { readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
/** @type {import('@ss/app-kit').WebsiteData} */
let data;
/** @type {import('../core/model.js').ProductRecord} */
let phone;
/** @type {import('../core/model.js').ProductRecord} */
let cover;

beforeAll(async () => {
	shop = await readyShop();
	data = await shop.db();
	await data.ensureIndexes((await import('../adapters/product.js')).INDEXES);
	await data.collection(COLLECTIONS.categories).insertMany([
		{ id: 'cat_parent', slug: 'phones', name: 'Phones', parentId: null, path: [] },
		{ id: 'cat_child', slug: 'android', name: 'Android', parentId: 'cat_parent', path: ['cat_parent'] },
	]);
	await data.collection(COLLECTIONS.brands).insertOne({ id: 'brd_one', slug: 'one', name: 'One' });
	phone = await shop.seedProduct({
		name: 'Phone',
		categoryIds: ['cat_child'],
		brandId: 'brd_one',
		variants: [
			{
				id: 'var_big',
				sku: '',
				options: {},
				price: 20000,
				compareAtPrice: null,
				cost: null,
				stock: 3,
				locations: {},
				grade: null,
				active: true,
			},
			{
				id: 'var_small',
				sku: '',
				options: {},
				price: 10000,
				compareAtPrice: null,
				cost: null,
				stock: 3,
				locations: {},
				grade: null,
				active: true,
			},
		],
	});
	cover = await shop.seedProduct({ name: 'Cover', price: 1000 });
});
afterAll(async () => shop.product.close());

/** The stable code of a problem answer. @param {any} json */
const codeOf = (json) =>
	String(json?.type ?? '')
		.split('/')
		.pop();

describe('coupons', () => {
	it('creates, lists, reads, edits and deletes coupons with the server token', async () => {
		const made = await shop.api('POST', '/v1/coupons', {
			code: 'welcome10',
			type: 'percent',
			value: 10,
			scope: { productIds: [phone.id], categoryIds: ['cat_parent'], brandIds: ['brd_one'] },
		});
		expect(made.status).toBe(201);
		expect(made.json).toMatchObject({ code: 'WELCOME10', used: 0, active: true, startsAt: null });
		const id = made.json.id;

		expect((await shop.api('POST', '/v1/coupons', { code: 'WELCOME10', type: 'fixed', value: 5 })).json).toMatchObject({
			status: 409,
		});
		expect(codeOf((await shop.api('POST', '/v1/coupons', { code: 'welcome10', type: 'fixed', value: 5 })).json)).toBe(
			'coupon_code_taken',
		);
		const unknown = await shop.api('POST', '/v1/coupons', {
			code: 'X1X',
			type: 'fixed',
			value: 5,
			scope: { productIds: ['prd_missing'] },
		});
		expect(unknown.status).toBe(422);
		expect(unknown.json.errors[0].path).toBe('/scope/productIds');
		expect((await shop.api('POST', '/v1/coupons', { code: 'X', type: 'fixed', value: 5 })).status).toBe(422);
		const brand = await shop.api('POST', '/v1/coupons', {
			code: 'BRAND',
			type: 'fixed',
			value: 5,
			scope: { brandIds: ['brd_nope'] },
		});
		expect(brand.json.errors[0].path).toBe('/scope/brandIds');
		const category = await shop.api('POST', '/v1/coupons', {
			code: 'CAT',
			type: 'fixed',
			value: 5,
			scope: { categoryIds: ['cat_nope'] },
		});
		expect(category.json.errors[0].path).toBe('/scope/categoryIds');
		await shop.api('POST', '/v1/coupons', { code: 'SHIPFREE', type: 'free_delivery', active: false });

		const read = await shop.api('GET', `/v1/coupons/${id}`);
		expect(read.json.code).toBe('WELCOME10');
		expect((await shop.api('GET', '/v1/coupons/cpn_missing')).status).toBe(404);

		const first = await shop.api('GET', '/v1/coupons?limit=1');
		expect(first.json.items).toHaveLength(1);
		expect(first.json.hasMore).toBe(true);
		const second = await shop.api('GET', `/v1/coupons?limit=1&cursor=${first.json.nextCursor}`);
		expect(second.json.items[0].id).not.toBe(first.json.items[0].id);
		expect((await shop.api('GET', '/v1/coupons?active=false')).json.items.map((/** @type {any} */ c) => c.code)).toEqual([
			'SHIPFREE',
		]);
		expect((await shop.api('GET', '/v1/coupons?active=true&q=wel')).json.items.map((/** @type {any} */ c) => c.code)).toEqual([
			'WELCOME10',
		]);

		const edited = await shop.api('PATCH', `/v1/coupons/${id}`, { active: false, endsAt: '2027-01-01T00:00:00Z', used: 99 });
		expect(edited.status).toBe(200);
		expect(edited.json).toMatchObject({ active: false, endsAt: '2027-01-01T00:00:00.000Z', used: 0, code: 'WELCOME10' });
		expect(codeOf((await shop.api('PATCH', `/v1/coupons/${id}`, { code: 'SHIPFREE' })).json)).toBe('coupon_code_taken');
		expect((await shop.api('PATCH', `/v1/coupons/${id}`, { value: 500 })).status).toBe(422);
		expect((await shop.api('PATCH', `/v1/coupons/${id}`, [])).status).toBe(422);
		expect((await shop.api('PATCH', '/v1/coupons/cpn_missing', { active: true })).status).toBe(404);

		expect((await shop.api('DELETE', `/v1/coupons/${id}`)).status).toBe(204);
		expect((await shop.api('DELETE', `/v1/coupons/${id}`)).status).toBe(404);
	});

	it('generates a batch of codes', async () => {
		const batch = await shop.api('POST', '/v1/coupons/batch', {
			prefix: 'fall-',
			count: 5,
			coupon: { type: 'fixed', value: 200, limit: 1 },
		});
		expect(batch.status).toBe(201);
		expect(batch.json.created).toBe(5);
		expect(batch.json.codes.every((/** @type {string} */ code) => /^FALL-[A-Z2-9]{8}$/.test(code))).toBe(true);
		expect((await shop.api('POST', '/v1/coupons/batch', { prefix: 'x', count: 0 })).status).toBe(422);
		const missing = await shop.api('POST', '/v1/coupons/batch', {
			count: 1,
			coupon: { type: 'fixed', value: 1, scope: { productIds: ['prd_gone'] } },
		});
		expect(missing.status).toBe(422);
	});

	it('serves the admin widget with the coupons.edit permission only', async () => {
		const ticket = await shop.ticket(['coupons.edit']);
		const made = await shop.admin(ticket, 'POST', '/v1/admin/coupons', { code: 'STAFF5', type: 'fixed', value: 500 });
		expect(made.status).toBe(201);
		expect((await shop.admin(ticket, 'GET', '/v1/admin/coupons')).json.items.length).toBeGreaterThan(0);
		expect((await shop.admin(ticket, 'GET', `/v1/admin/coupons/${made.json.id}`)).json.code).toBe('STAFF5');
		expect((await shop.admin(ticket, 'PATCH', `/v1/admin/coupons/${made.json.id}`, { value: 600 })).json.value).toBe(600);
		const batch = await shop.admin(ticket, 'POST', '/v1/admin/coupons/batch', { count: 2, coupon: { type: 'free_delivery' } });
		expect(batch.json.created).toBe(2);
		expect((await shop.admin(ticket, 'DELETE', `/v1/admin/coupons/${made.json.id}`)).status).toBe(204);
		const other = await shop.ticket(['deals.edit']);
		expect((await shop.admin(other, 'GET', '/v1/admin/coupons')).status).toBe(403);
	});
});

describe('deals and bundles', () => {
	it('manages deals on both routes', async () => {
		const made = await shop.api('POST', '/v1/deals', {
			name: 'Phone week',
			type: 'percent',
			value: 10,
			priority: 2,
			scope: { categoryIds: ['cat_parent'] },
			endsAt: '2026-10-10T00:00:00Z',
		});
		expect(made.status).toBe(201);
		expect(made.json).toMatchObject({ name: 'Phone week', used: 0, endsAt: '2026-10-10T00:00:00.000Z' });
		const id = made.json.id;
		expect((await shop.api('POST', '/v1/deals', { name: 'Bad', type: 'percent' })).status).toBe(422);
		expect((await shop.api('GET', `/v1/deals/${id}`)).json.id).toBe(id);
		expect((await shop.api('GET', '/v1/deals?q=phone')).json.items).toHaveLength(1);
		expect((await shop.api('PATCH', `/v1/deals/${id}`, { description: 'All phones' })).json.description).toBe('All phones');
		const ticket = await shop.ticket(['deals.edit']);
		const staff = await shop.admin(ticket, 'POST', '/v1/admin/deals', {
			name: 'Covers',
			type: 'fixed',
			value: 100,
			scope: { productIds: [cover.id] },
		});
		expect(staff.status).toBe(201);
		expect((await shop.admin(ticket, 'GET', '/v1/admin/deals')).json.items).toHaveLength(2);
		expect((await shop.admin(ticket, 'GET', `/v1/admin/deals/${staff.json.id}`)).json.name).toBe('Covers');
		expect((await shop.admin(ticket, 'PATCH', `/v1/admin/deals/${staff.json.id}`, { active: false })).json.active).toBe(false);
		const old = await shop.api('POST', '/v1/deals', { name: 'Old', type: 'fixed', value: 1 });
		expect((await shop.admin(ticket, 'DELETE', `/v1/admin/deals/${old.json.id}`)).status).toBe(204);
		const spare = await shop.api('POST', '/v1/deals', { name: 'Spare', type: 'fixed', value: 1, active: false });
		expect((await shop.api('DELETE', `/v1/deals/${spare.json.id}`)).status).toBe(204);
	});

	it('manages bundles on both routes', async () => {
		const made = await shop.api('POST', '/v1/bundles', {
			name: 'Phone + cover',
			type: 'bundle',
			items: [{ productId: phone.id }, { productId: cover.id }],
			price: 10500,
		});
		expect(made.status).toBe(201);
		expect(made.json).toMatchObject({
			type: 'bundle',
			price: 10500,
			items: [
				{ productId: phone.id, quantity: 1 },
				{ productId: cover.id, quantity: 1 },
			],
		});
		const missing = await shop.api('POST', '/v1/bundles', {
			name: 'X',
			type: 'bundle',
			items: [{ productId: 'prd_none' }],
			value: 10,
		});
		expect(missing.json.errors[0].path).toBe('/scope/productIds');
		const changed = await shop.api('PATCH', `/v1/bundles/${made.json.id}`, {
			type: 'buy_x_get_y',
			buy: 2,
			get: 1,
			value: 100,
			getScope: { productIds: [cover.id] },
		});
		expect(changed.json).toMatchObject({ type: 'buy_x_get_y', items: [], price: null, value: 100 });
		expect((await shop.api('GET', `/v1/bundles/${made.json.id}`)).json.buy).toBe(2);
		expect((await shop.api('GET', '/v1/bundles')).json.items).toHaveLength(1);
		const ticket = await shop.ticket(['bundles.edit']);
		const staff = await shop.admin(ticket, 'POST', '/v1/admin/bundles', {
			name: 'Two covers',
			type: 'bundle',
			items: [{ productId: cover.id, quantity: 2 }],
			value: 20,
		});
		expect(staff.status).toBe(201);
		expect((await shop.admin(ticket, 'GET', '/v1/admin/bundles')).json.items).toHaveLength(2);
		expect((await shop.admin(ticket, 'GET', `/v1/admin/bundles/${staff.json.id}`)).json.value).toBe(20);
		expect((await shop.admin(ticket, 'PATCH', `/v1/admin/bundles/${staff.json.id}`, { value: 25 })).json.value).toBe(25);
		expect((await shop.admin(ticket, 'DELETE', `/v1/admin/bundles/${staff.json.id}`)).status).toBe(204);
		expect((await shop.api('DELETE', `/v1/bundles/${made.json.id}`)).status).toBe(204);
	});
});

describe('shopper routes', () => {
	it('lists live deals and quotes a product after deals', async () => {
		await shop.api('POST', '/v1/deals', { name: 'Later', type: 'fixed', value: 1, startsAt: '2027-01-01T00:00:00Z' });
		await shop.api('POST', '/v1/deals', { name: 'Brand', type: 'fixed', value: 50, scope: { brandIds: ['brd_one'] } });
		const deals = await shop.visitor('GET', '/v1/shop/deals?limit=5');
		expect(deals.status).toBe(200);
		expect(deals.json.items.map((/** @type {any} */ d) => d.name)).toEqual(['Phone week', 'Brand']);
		expect(deals.json.items[0]).toMatchObject({ scope: { everything: false, categoryIds: ['cat_parent'] } });
		expect((await shop.visitor('GET', '/v1/shop/deals?limit=1')).json.items).toHaveLength(1);
		expect((await shop.visitor('GET', '/v1/shop/deals')).json.items).toHaveLength(2);
		expect((await shop.visitor('GET', '/v1/shop/deals?limit=500')).status).toBe(422);

		const quote = await shop.visitor('GET', `/v1/shop/products/${phone.id}/quote`);
		expect(quote.json).toMatchObject({
			productId: phone.id,
			variantId: 'var_small',
			price: 10000,
			priceAfterDeals: 9000,
			savings: 1000,
			currency: 'USD',
		});
		expect(quote.json.deals[0].name).toBe('Phone week');
		const big = await shop.visitor('GET', `/v1/shop/products/${phone.id}/quote?variantId=var_big`);
		expect(big.json.savings).toBe(2000);
		expect((await shop.visitor('GET', `/v1/shop/products/${phone.id}/quote?variantId=var_nope`)).status).toBe(404);
		expect((await shop.visitor('GET', '/v1/shop/products/prd_none/quote')).status).toBe(404);
		expect((await shop.visitor('GET', `/v1/shop/products/${cover.id}/quote`)).json).toMatchObject({ savings: 0, deals: [] });
	});

	it('loads offers for pricing', async () => {
		const at = shop.now();
		await insertOffers(data, 'coupons', [
			{
				id: createId('cpn'),
				code: 'LOAD',
				type: 'fixed',
				value: 1,
				maxDiscount: null,
				minSubtotal: 0,
				scope: { productIds: [], categoryIds: [], brandIds: [] },
				startsAt: null,
				endsAt: null,
				limit: null,
				used: 0,
				perCustomer: null,
				firstOrderOnly: false,
				active: false,
			},
		]);
		await insertOffers(data, 'deals', [
			{
				id: createId('deal'),
				name: 'Spent',
				type: 'fixed',
				value: 1,
				scope: { productIds: [], categoryIds: [], brandIds: [] },
				startsAt: null,
				endsAt: null,
				limit: 2,
				used: 2,
				priority: 0,
				active: true,
			},
		]);
		const offers = await loadOffers(data, { now: at, couponCode: ' load ', deals: true, bundles: true });
		expect(offers.coupon?.code).toBe('LOAD');
		expect(offers.deals.map((d) => d.name).sort()).toEqual(['Brand', 'Phone week']);
		expect(offers.bundles).toEqual([]);
		expect(await loadOffers(data, { now: at })).toEqual({ deals: [], bundles: [], coupon: null });
		expect((await loadOffers(data, { now: at, couponCode: 'NOPE' })).coupon).toBeNull();
		expect(isDuplicate(null)).toBe(false);
		await expect(insertOffers(data, 'coupons', [{ id: 'cpn_x', code: 'LOAD' }])).rejects.toThrow();
		expect(await insertOffers(data, 'coupons', [])).toEqual([]);
		expect(
			await insertOffers(
				data,
				'coupons',
				[
					{ id: 'cpn_y', code: 'LOAD' },
					{ id: 'cpn_z', code: 'FRESH' },
				],
				{ skipDuplicates: true },
			),
		).toEqual(['cpn_z']);
	});
});

describe('loyalty', () => {
	const userId = 'usr_shopper0000001';

	it('looks up and adjusts a shopper account', async () => {
		const empty = await shop.api('GET', `/v1/loyalty/accounts/${userId}`);
		expect(empty.json).toMatchObject({ userId, balance: 0, value: 0, lots: [], history: [], expiringSoon: [] });
		await shop.setting('loyalty', 'expiryDays', 10);
		const added = await shop.api('POST', `/v1/loyalty/accounts/${userId}/adjust`, { points: 500, note: 'Welcome' });
		expect(added.status).toBe(200);
		expect(added.json).toMatchObject({ balance: 500, value: 50000, currency: 'USD' });
		expect(added.json.history[0]).toMatchObject({ kind: 'adjust', points: 500, note: 'Welcome' });
		expect(added.json.expiringSoon[0].points).toBe(500);
		const ticket = await shop.ticket(['loyalty.manage']);
		const taken = await shop.admin(ticket, 'POST', `/v1/admin/loyalty/accounts/${userId}/adjust`, { points: -200 });
		expect(taken.json.balance).toBe(300);
		expect((await shop.admin(ticket, 'GET', `/v1/admin/loyalty/accounts/${userId}`)).json.lots[0]).toMatchObject({
			points: 500,
			left: 300,
		});
		expect((await shop.api('POST', `/v1/loyalty/accounts/${userId}/adjust`, { points: -1000 })).json.errors[0].code).toBe(
			'too_many',
		);
		expect((await shop.api('POST', `/v1/loyalty/accounts/${userId}/adjust`, { points: 0 })).status).toBe(422);
		expect((await shop.api('POST', `/v1/loyalty/accounts/${userId}/adjust`, { points: 1, note: 'x'.repeat(201) })).status).toBe(
			422,
		);
		expect((await shop.api('POST', `/v1/loyalty/accounts/${userId}/adjust`, 'nope')).status).toBe(400);
		expect((await shop.api('GET', `/v1/loyalty/accounts/${'u'.repeat(129)}`)).status).toBe(404);
		expect((await shop.admin(await shop.ticket(['coupons.edit']), 'GET', `/v1/admin/loyalty/accounts/${userId}`)).status).toBe(
			403,
		);
	});

	it('shows the signed-in shopper their points', async () => {
		expect((await shop.visitor('GET', '/v1/shop/loyalty')).status).toBe(403);
		const token = await shop.signIn();
		const mine = await shop.visitor('GET', '/v1/shop/loyalty', { signIn: token });
		expect(mine.status).toBe(200);
		expect(mine.json).toMatchObject({
			balance: 300,
			value: 30000,
			currency: 'USD',
			pointValue: 100,
			minRedeem: 100,
			maxPercent: 20,
		});
		expect(mine.json.history).toHaveLength(2);
		expect(mine.json.history[0].kind).toBe('adjust');
		expect(mine.json.expiringSoon).toEqual([{ points: 300, expiresAt: new Date(shop.now() + 10 * 86_400_000).toISOString() }]);
	});

	it('gives the widgets the loyalty settings', async () => {
		const config = await shop.visitor('GET', '/v1/widget/config');
		expect(config.json.settings.loyalty).toEqual({ pointValue: 100, minRedeem: 100, maxPercent: 20 });
	});

	it('exports and deletes a person’s loyalty account and coupon uses', async () => {
		const other = 'usr_other00000001';
		await givePoints(data, { userId: other, points: 5, orderId: null, kind: 'adjust', expiresAt: null }, { now: shop.now() });
		await data.collection(COLLECTIONS.couponUses).insertMany([
			{ couponId: 'cpn_1', userId, orderId: 'ord_1', seq: 1 },
			{ couponId: 'cpn_2', userId, orderId: 'ord_2', seq: 1 },
		]);
		const exported = await shop.api('POST', '/v1/data-rights/export', { user: { id: userId } });
		expect(exported.status).toBe(200);
		const records = exported.json.records ?? exported.json;
		expect(records.loyalty[0]).toMatchObject({ userId, balance: 300 });
		expect(records.coupon_uses.map((/** @type {any} */ use) => use.orderId).sort()).toEqual(['ord_1', 'ord_2']);
		const byEmail = await shop.api('POST', '/v1/data-rights/export', { user: { email: 'sara@example.com' } });
		const none = byEmail.json.records ?? byEmail.json;
		expect(none.loyalty).toBeUndefined();

		const deleted = await shop.api('POST', '/v1/data-rights/delete', { user: { id: userId } });
		expect(deleted.status).toBe(200);
		expect(deleted.json.deleted).toBeGreaterThanOrEqual(3);
		expect(await data.collection(COLLECTIONS.loyalty).countDocuments({ websiteId: data.websiteId, userId })).toBe(0);
		expect(await data.collection(COLLECTIONS.loyalty).countDocuments({ websiteId: data.websiteId, userId: other })).toBe(1);
		const again = await shop.api('POST', '/v1/data-rights/export', { user: { id: userId } });
		expect((again.json.records ?? again.json).loyalty).toEqual([]);
		expect((await shop.api('POST', '/v1/data-rights/delete', { user: { phone: '+15550001111' } })).status).toBe(200);
	});
});

describe('features off', () => {
	it('answers feature_off and leaves loyalty out of the widget settings', async () => {
		const small = await readyShop({ features: ['catalog', 'checkout'] });
		try {
			expect(codeOf((await small.api('GET', '/v1/coupons')).json)).toBe('feature_off');
			expect(codeOf((await small.visitor('GET', '/v1/shop/deals')).json)).toBe('feature_off');
			expect((await small.visitor('GET', '/v1/widget/config')).json.settings.loyalty).toBeUndefined();
		} finally {
			await small.product.close();
		}
	});
});
