/**
 * The API descriptions of promotions (`schemas/api.json`): every member a coupon, deal, bundle, loyalty account,
 * shopper deal, shopper points and product quote can carry, so the test helper checks each shape against its
 * description: a percent coupon with every limit and its edit to a fixed one, a batch through both twins, a deal with
 * conditions, groups, hours, a banner and display fields as staff and shoppers see it, buy X get Y with both scopes, a
 * guest's points by customer id, and the shopper's points with history pages and pending points.
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
const SARA = 'usr_shopper0000001';

/** @param {{ json: any }} response */
const codeOf = (response) =>
	String(response.json?.type ?? '')
		.split('/')
		.pop();

beforeAll(async () => {
	shop = await readyShop();
	data = await shop.db();
	await data.collection(COLLECTIONS.categories).insertOne({ id: 'cat_phones', slug: 'phones', name: 'Phones', path: [] });
	await data.collection(COLLECTIONS.brands).insertOne({ id: 'brd_acme', slug: 'acme', name: 'Acme' });
	phone = await shop.seedProduct({ name: 'Phone', price: 20_000, categoryIds: ['cat_phones'], brandId: 'brd_acme' });
	cover = await shop.seedProduct({ name: 'Cover', price: 1_000 });
});
afterAll(async () => shop.product.close());

describe('coupons', () => {
	it('answers a coupon with every limit, and a batch through both twins', async () => {
		const made = await shop.api('POST', '/v1/coupons', {
			code: ' vip-15 ',
			type: 'percent',
			value: 12.5,
			maxDiscount: 3_000,
			minSubtotal: 5_000,
			scope: { categoryIds: ['cat_phones'] },
			startsAt: '2026-10-01T00:00:00Z',
			endsAt: '2026-12-31T00:00:00Z',
			limit: 100,
			perCustomer: 1,
			firstOrderOnly: true,
		});
		expect(made.status).toBe(201);
		expect(made.json).toMatchObject({
			code: 'VIP-15',
			value: 12.5,
			maxDiscount: 3_000,
			scope: { productIds: [], categoryIds: ['cat_phones'], brandIds: [] },
			startsAt: '2026-10-01T00:00:00.000Z',
			perCustomer: 1,
			firstOrderOnly: true,
			used: 0,
		});
		// a fixed coupon has no cap
		const fixed = await shop.api('PATCH', `/v1/coupons/${made.json.id}`, { type: 'fixed', value: 700 });
		expect(fixed.json).toMatchObject({ type: 'fixed', value: 700, maxDiscount: null, minSubtotal: 5_000 });
		expect((await shop.api('PATCH', `/v1/coupons/${made.json.id}`, { endsAt: '2026-09-01T00:00:00Z' })).status).toBe(422);

		const ticket = await shop.ticket(['coupons.edit']);
		const batch = await shop.admin(ticket, 'POST', '/v1/admin/coupons/batch', {
			prefix: 'gift_',
			count: 3,
			coupon: { type: 'fixed', value: 500, perCustomer: 1, scope: { productIds: [cover.id] } },
		});
		expect(batch.status).toBe(201);
		expect(batch.json.created).toBe(3);
		expect(batch.json.codes.every((/** @type {string} */ code) => /^GIFT_[A-HJ-NP-Z2-9]{8}$/.test(code))).toBe(true);
		const listed = await shop.admin(ticket, 'GET', '/v1/admin/coupons?q=gift&limit=2');
		expect(listed.json.items).toHaveLength(2);
		expect(listed.json.hasMore).toBe(true);
		expect(listed.json.items[0]).toMatchObject({ type: 'fixed', scope: { productIds: [cover.id] }, limit: null });
		expect((await shop.api('GET', '/v1/coupons?limit=101')).status).toBe(400);
	});
});

describe('deals', () => {
	it('answers a deal with conditions, hours, a banner and display fields to staff and shoppers', async () => {
		const made = await shop.api('POST', '/v1/deals', {
			name: 'Sunday morning phones',
			description: 'Early birds',
			type: 'percent',
			value: 10,
			target: 'cart',
			priority: 3,
			scope: { brandIds: ['brd_acme'] },
			conditions: {
				match: 'any',
				rules: [{ field: 'attribute', attributeId: 'color', values: ['black'], op: 'not_in' }],
				groups: [{ match: 'all', rules: [{ field: 'categories', values: ['cat_phones'] }] }],
				priceRange: { min: 1_000, max: null },
				minQuantity: 2,
				cartTotal: 10_000,
				paymentMethods: ['cod', 'online'],
			},
			allowPoints: false,
			days: [0, 6, 0],
			timeFrom: '22:00',
			timeTo: '02:00',
			slug: 'sunday-phones',
			badgeLabel: 'Early',
			discountLabel: '10% off the cart',
			color: '#0a0',
			content: 'All Acme phones.',
			sort: -5,
			banner: { key: 'ecommerce/deals/sunday.webp', alt: 'A phone', type: 'image/webp', size: 2048 },
			seo: { title: 'Sunday phones' },
			limit: 50,
		});
		expect(made.status).toBe(201);
		expect(made.json).toMatchObject({
			target: 'cart',
			days: [0, 6],
			conditions: { match: 'any', priceRange: { min: 1_000, max: null }, paymentMethods: ['cod', 'online'] },
			banner: { key: 'ecommerce/deals/sunday.webp', alt: 'A phone', type: 'image/webp', size: 2048 },
			seo: { title: 'Sunday phones', description: '' },
			allowPoints: false,
		});
		const free = await shop.api('POST', '/v1/deals', { name: 'Free delivery', type: 'free_delivery', target: 'cart' });
		expect(free.json).toMatchObject({ target: 'items', value: 0, conditions: null, banner: null, slug: '' });

		const ticket = await shop.ticket(['deals.edit']);
		const changed = await shop.admin(ticket, 'PATCH', `/v1/admin/deals/${made.json.id}`, { conditions: null, banner: null });
		expect(changed.json).toMatchObject({ conditions: null, banner: null, slug: 'sunday-phones' });
		const rebanner = await shop.admin(ticket, 'PATCH', `/v1/admin/deals/${made.json.id}`, {
			banner: { key: `ecommerce/deals/${made.json.id}/sunday.webp`, alt: 'A phone' },
		});
		expect(rebanner.status).toBe(200);
		expect((await shop.admin(ticket, 'GET', '/v1/admin/deals?active=true')).json.items).toHaveLength(2);

		// outside its weekdays and hours (Monday 10:00) shoppers do not see the deal, as the cart would not give it (PR-6)
		const outside = await shop.visitor('GET', '/v1/shop/deals');
		expect(outside.json.items.map((/** @type {any} */ item) => item.name)).toEqual(['Free delivery']);
		expect((await shop.visitor('GET', '/v1/shop/deals/sunday-phones')).status).toBe(404);
		// inside them: with the banner's address and no use counts
		await shop.admin(ticket, 'PATCH', `/v1/admin/deals/${made.json.id}`, { days: [1], timeFrom: '09:00', timeTo: '11:00' });
		const listed = await shop.visitor('GET', '/v1/shop/deals');
		expect(listed.json.items.map((/** @type {any} */ item) => item.name)).toEqual(['Sunday morning phones', 'Free delivery']);
		const page = await shop.visitor('GET', '/v1/shop/deals/sunday-phones');
		expect(page.json).toMatchObject({
			id: made.json.id,
			banner: { alt: 'A phone' },
			scope: { everything: false, brandIds: ['brd_acme'] },
			minQuantity: 0,
			paymentMethods: [],
			days: [1],
			timeFrom: '09:00',
		});
		expect(page.json.banner.url).toMatch(/^https:\/\//);
		expect(page.json).not.toHaveProperty('used');
		expect((await shop.visitor('GET', `/v1/shop/deals/${free.json.id}`)).json.scope.everything).toBe(true);
		await shop.api('DELETE', `/v1/deals/${made.json.id}`);
		await shop.api('DELETE', `/v1/deals/${free.json.id}`);
	});

	it('gives a presigned upload for a deal’s banner under the deal’s folder, set with an edit', async () => {
		const deal = (await shop.api('POST', '/v1/deals', { name: 'Banner', type: 'percent', value: 5 })).json;
		const asked = await shop.api('POST', `/v1/deals/${deal.id}/banner/upload`, { type: 'image/webp', size: 2048 });
		expect(asked.status).toBe(200);
		expect(asked.json.key).toMatch(new RegExp(`^ecommerce/deals/${deal.id}/[a-z0-9]+\\.webp$`));
		expect(asked.json.upload).toMatchObject({ method: 'PUT', headers: { 'content-type': 'image/webp' } });
		const ticket = await shop.ticket(['deals.edit']);
		const fromWidget = await shop.admin(ticket, 'POST', `/v1/admin/deals/${deal.id}/banner/upload`, {
			type: 'image/png',
			size: 10,
		});
		expect(fromWidget.json.key).toMatch(new RegExp(`^ecommerce/deals/${deal.id}/[a-z0-9]+\\.png$`));
		const set = await shop.admin(ticket, 'PATCH', `/v1/admin/deals/${deal.id}`, {
			banner: { key: fromWidget.json.key, alt: 'Big sale', type: 'image/png', size: 10 },
		});
		expect(set.json.banner).toEqual({ key: fromWidget.json.key, alt: 'Big sale', type: 'image/png', size: 10 });
		// an edit takes a new key only from this deal's folder; the key it holds stays valid
		const other = (await shop.api('POST', '/v1/deals', { name: 'Other', type: 'percent', value: 5 })).json;
		/** @param {string} key @param {boolean} [admin] */
		const edited = async (key, admin = false) => {
			const body = { banner: { key, alt: 'Big sale' } };
			const answer = admin
				? await shop.admin(ticket, 'PATCH', `/v1/admin/deals/${deal.id}`, body)
				: await shop.api('PATCH', `/v1/deals/${deal.id}`, body);
			return [answer.status, answer.json.errors?.[0]?.path ?? answer.json.banner?.key];
		};
		for (const admin of [false, true]) {
			expect(await edited(`ecommerce/deals/${other.id}/abc.png`, admin)).toEqual([422, '/banner']);
			expect(await edited('ecommerce/deals/abc.png', admin)).toEqual([422, '/banner']);
			expect(await edited(`ecommerce/deals/${deal.id}/`, admin)).toEqual([422, '/banner']);
			expect(await edited(`ecommerce/deals/${deal.id}/../${other.id}/abc.png`, admin)).toEqual([422, '/banner']);
			expect(await edited(fromWidget.json.key, admin)).toEqual([200, fromWidget.json.key]);
		}
		const wrong = await shop.api('PATCH', `/v1/deals/${deal.id}`, { banner: { key: 'ecommerce/deals/abc.png' } });
		expect(wrong.json.errors[0].message).toMatch(/uploaded for this deal/);
		expect(await edited(asked.json.key)).toEqual([200, asked.json.key]);
		expect((await shop.api('PATCH', `/v1/deals/${deal.id}`, { name: 'Banner sale' })).json.banner.key).toBe(asked.json.key);
		await shop.api('DELETE', `/v1/deals/${other.id}`);
		/** @param {Record<string, unknown>} body @param {string} [id] */
		const refused = async (body, id = deal.id) => {
			const answer = await shop.api('POST', `/v1/deals/${id}/banner/upload`, body);
			return [answer.status, answer.json.errors?.[0]?.path ?? answer.json.type.split('/').pop()];
		};
		expect(await refused({ type: 'image/gif', size: 10 })).toEqual([422, '/type']);
		expect(await refused({ type: 'image/png', size: 0 })).toEqual([422, '/size']);
		expect(await refused({ type: 'image/png', size: 100 * 1024 * 1024 })).toEqual([422, '/size']);
		expect(await refused({ type: 'image/png', size: 10 }, createId('deal'))).toEqual([404, 'not_found']);
		await shop.dashboard(await shop.adminSession(), 'DELETE', `/v1/dashboard/websites/${shop.websiteId}/connections/storage`);
		expect(await refused({ type: 'image/png', size: 10 })).toEqual([503, 'storage_not_connected']);
		await shop.connectStorage();
		await shop.api('DELETE', `/v1/deals/${deal.id}`);
	});

	it('quotes one unit with the best item deal only', async () => {
		const scope = { productIds: [phone.id] };
		const night = await shop.api('POST', '/v1/deals', { name: 'Night', type: 'percent', value: 50, scope, days: [0] });
		const two = await shop.api('POST', '/v1/deals', {
			name: 'Two or more',
			type: 'fixed',
			value: 5_000,
			scope,
			conditions: { minQuantity: 2 },
		});
		const cart = await shop.api('POST', '/v1/deals', { name: 'Cart', type: 'percent', value: 40, target: 'cart', scope });
		const plain = await shop.api('POST', '/v1/deals', { name: 'Plain', type: 'fixed', value: 1_500, scope });
		const quote = await shop.visitor('GET', `/v1/shop/products/${phone.id}/quote?variantId=${phone.variants[0]?.id}`);
		expect(quote.json).toEqual({
			productId: phone.id,
			variantId: phone.variants[0]?.id,
			price: 20_000,
			priceAfterDeals: 18_500,
			savings: 1_500,
			currency: 'USD',
			deals: [{ id: plain.json.id, name: 'Plain' }],
		});
		for (const made of [night, two, cart, plain]) await shop.api('DELETE', `/v1/deals/${made.json.id}`);
	});
});

describe('bundles', () => {
	it('answers buy X get Y with both scopes, and a priced bundle', async () => {
		const made = await shop.api('POST', '/v1/bundles', {
			name: 'Buy a phone, cover half off',
			type: 'buy_x_get_y',
			buy: 1,
			get: 1,
			value: 50,
			scope: { categoryIds: ['cat_phones'] },
			getScope: { productIds: [cover.id] },
			endsAt: '2027-01-01T00:00:00Z',
		});
		expect(made.status).toBe(201);
		expect(made.json).toMatchObject({
			items: [],
			price: null,
			scope: { categoryIds: ['cat_phones'] },
			getScope: { productIds: [cover.id] },
			value: 50,
		});
		const priced = await shop.api('POST', '/v1/bundles', {
			name: 'Phone and cover',
			type: 'bundle',
			items: [{ productId: phone.id }, { productId: cover.id, quantity: 2 }],
			price: 20_500,
			scope: { productIds: [cover.id] },
		});
		expect(priced.json).toMatchObject({ buy: 0, get: 0, value: 0, scope: { productIds: [] }, getScope: { productIds: [] } });
		const off = await shop.api('PATCH', `/v1/bundles/${priced.json.id}`, { price: null, value: 15, active: false });
		expect(off.json).toMatchObject({ price: null, value: 15, active: false });
		expect((await shop.api('GET', '/v1/bundles?active=false')).json.items.map((/** @type {any} */ b) => b.id)).toEqual([
			priced.json.id,
		]);
		expect((await shop.api('PATCH', `/v1/bundles/${priced.json.id}`, { price: null })).status).toBe(200);
		expect((await shop.api('PATCH', `/v1/bundles/${made.json.id}`, { get: 0 })).status).toBe(422);
	});
});

describe('loyalty', () => {
	it('answers a guest’s account by customer id', async () => {
		const guest = createId('cus');
		await data
			.collection(COLLECTIONS.customers)
			.insertOne({ id: guest, userId: null, name: 'Gus Guest', phone: '+15550002222' });
		const empty = await shop.api('GET', `/v1/loyalty/accounts/${guest}`);
		expect(empty.json).toMatchObject({ userId: null, customerId: guest, balance: 0, lots: [] });
		const ticket = await shop.ticket(['loyalty.manage']);
		const added = await shop.admin(ticket, 'POST', `/v1/admin/loyalty/accounts/${guest}/adjust`, { points: 250 });
		expect(added.json).toMatchObject({ userId: null, customerId: guest, balance: 250, value: 25_000 });
		expect(added.json.lots[0]).toMatchObject({ points: 250, left: 250, expiresAt: null, orderId: null });
		expect(added.json.history[0]).toMatchObject({ kind: 'adjust', points: 250, orderId: null, note: '' });
		expect(codeOf(await shop.api('GET', `/v1/loyalty/accounts/${createId('cus')}`))).toBe('not_found');
	});

	it('pages the signed-in shopper’s history and counts pending points', async () => {
		for (const points of [100, 200, -50]) await shop.api('POST', `/v1/loyalty/accounts/${SARA}/adjust`, { points });
		await data.collection(COLLECTIONS.orders).insertOne({
			id: createId('ord'),
			customer: { userId: SARA },
			role: 'open',
			promotions: { pointsEarned: 40, pointsCredited: false },
		});
		const token = await shop.signIn();
		const first = await shop.visitor('GET', '/v1/shop/loyalty?limit=2', { signIn: token });
		expect(first.json).toMatchObject({
			balance: 250,
			value: 25_000,
			lifetimeEarned: 0,
			pending: 40,
			expiringSoon: [],
		});
		expect(first.json.history.map((/** @type {any} */ entry) => entry.points)).toEqual([50, 200]);
		// the history is the newest `limit` entries (the most a shopper's page shows), not a paged list
		expect(first.json).not.toHaveProperty('hasMore');
		const all = await shop.visitor('GET', '/v1/shop/loyalty', { signIn: token });
		expect(all.json.history.map((/** @type {any} */ entry) => entry.points)).toEqual([50, 200, 100]);
		expect((await shop.visitor('GET', '/v1/shop/loyalty?limit=0', { signIn: token })).status).toBe(422);
	});
});
