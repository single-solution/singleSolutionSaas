/**
 * PLAN 0.4.12 row 1, 0.8.2 Products: Add product (URL + connect secret), the first price list, Reconnect and Set active,
 * between the real Portal and the Notes product on the kit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONNECT_SECRET, PRODUCT_URL, codeOf, startSystem } from './helpers.js';

/** @type {import('./helpers.js').System} */
let sys;
beforeAll(async () => {
	sys = await startSystem();
});
afterAll(async () => {
	await sys?.stop();
});

describe('connecting a product', () => {
	it('Add product connects it inactive with price list 1 at 0; the secret is checked both ways', async () => {
		const owner = await sys.owner();
		const refused = await owner.post('/v1/admin/products', { url: PRODUCT_URL, secret: `${CONNECT_SECRET}-wrong` });
		expect([refused.status, codeOf(refused)]).toEqual([401, 'unauthorized']);

		const added = await owner.post('/v1/admin/products', { url: PRODUCT_URL, secret: CONNECT_SECRET });
		expect(added.status).toBe(201);
		expect(added.json.product).toMatchObject({
			productId: 'notes',
			name: 'Notes',
			status: 'inactive',
			baseUrl: PRODUCT_URL,
			widgetScriptUrl: `${PRODUCT_URL}/widget.js`,
			docsUrl: `${PRODUCT_URL}/docs`,
			reconnectedAt: null,
		});
		const page = await owner.get('/v1/admin/products/notes');
		expect(page.json).toMatchObject({
			priceListVersion: 1,
			features: [{ key: 'notes', name: 'Notes', dependsOn: [], millicreditsPerHour: 0 }],
		});
		expect((await sys.activity('product.connected')).length).toBe(1);

		// the product pinned the Portal: its dashboard prices show the same list
		const cookie = await sys.adminSession(owner, null);
		const prices = await sys.dashboard(cookie, 'GET', '/v1/dashboard/prices');
		expect(prices.json).toMatchObject({ version: 1, features: [{ key: 'notes', millicreditsPerHour: 0 }] });
	});

	it('refuses an id that is already connected (use Reconnect)', async () => {
		const again = await (await sys.owner()).post('/v1/admin/products', { url: PRODUCT_URL, secret: CONNECT_SECRET });
		expect([again.status, codeOf(again)]).toEqual([409, 'conflict']);
		expect(again.json.detail).toMatch(/Reconnect/);
	});

	it('an inactive product is not offered; Set active offers it', async () => {
		const owner = await sys.owner();
		const m = await sys.merchant('connect@shop.test', ['connect.example.com']);
		const [websiteId = ''] = m.websiteIds;
		const offered = await owner.get('/v1/admin/products?status=active');
		expect(offered.json.items).toEqual([]);
		const early = await owner.post(`/v1/merchants/${m.merchantId}/websites/${websiteId}/products`, { productId: 'notes' });
		expect(early.status).toBe(409);

		const active = await owner.post('/v1/admin/products/notes/status', { status: 'active' });
		expect(active.json.product.status).toBe('active');
		expect((await owner.get('/v1/admin/products?status=active')).json.items.map((/** @type {any} */ p) => p.productId)).toEqual(
			['notes'],
		);
		const card = await sys.addProduct(m.merchantId, websiteId);
		expect(card).toMatchObject({ productId: 'notes', status: 'active', featuresOn: [] });
	});

	it('Reconnect keeps the id, the websites, the tokens and the switches', async () => {
		const owner = await sys.owner();
		const m = await sys.merchant('reconnect@shop.test', ['reconnect.example.com']);
		const [websiteId = ''] = m.websiteIds;
		await sys.addProduct(m.merchantId, websiteId);
		const before = await sys.tokens(m.merchantId, websiteId);
		await sys.switchFeatures(await sys.adminSession(owner, websiteId), websiteId, ['notes']);

		const res = await owner.post('/v1/admin/products/notes/reconnect', { url: PRODUCT_URL, secret: CONNECT_SECRET });
		expect(res.status).toBe(200);
		expect(res.json.product).toMatchObject({ productId: 'notes', status: 'active', reconnectedAt: expect.any(String) });
		expect((await sys.activity('product.reconnected')).length).toBe(1);
		// a reconnect with the wrong secret changes nothing
		const wrong = await owner.post('/v1/admin/products/notes/reconnect', { secret: `${CONNECT_SECRET}-wrong` });
		expect(wrong.status).toBe(401);

		expect(await sys.tokens(m.merchantId, websiteId)).toEqual(before);
		const websites = await owner.get('/v1/admin/products/notes/websites');
		expect(websites.json.items).toContainEqual(expect.objectContaining({ websiteId, featuresOn: ['notes'] }));
		// the product still takes the same tokens and keeps its switches
		const ticket = await sys.call('POST', '/v1/tickets', {
			token: before.server,
			body: {
				user: { id: 'u1', name: 'Sam', email: 'sam@shop.test' },
				permissions: ['notes.read'],
				origin: 'https://admin.reconnect.example.com',
			},
		});
		expect(ticket.status).toBe(200);
		expect(await sys.product.featuresOn(websiteId)).toEqual(['notes']);
		expect((await owner.get('/v1/admin/products/notes')).json.priceListVersion).toBe(1);
	});
});
