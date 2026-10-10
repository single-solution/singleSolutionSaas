/**
 * PLAN 0.4.3 (Prices and Features screens), 0.4.12 rows 2–3 and 0.5.3: the product's dashboard sends price and feature
 * reports, the Portal accepts them and charges from them; a refused report changes nothing in the product.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOUR, startSystem } from './helpers.js';

/** @type {import('./helpers.js').System} */
let sys;
/** @type {Awaited<ReturnType<import('./helpers.js').System['merchant']>>} */
let m;
let websiteId = '';
beforeAll(async () => {
	sys = await startSystem();
	await sys.connect();
	m = await sys.merchant('reports@shop.test', ['reports.example.com']);
	websiteId = m.websiteIds[0] ?? '';
	await sys.addProduct(m.merchantId, websiteId);
	await sys.addCredits(m.merchantId, 100);
});
afterAll(async () => {
	await sys?.stop();
});

describe('price and feature reports', () => {
	it('an Owner saves the Prices screen: the Portal accepts the price report and the product keeps it', async () => {
		const owner = await sys.owner();
		const cookie = await sys.adminSession(owner, null);
		const saved = await sys.dashboard(cookie, 'PUT', '/v1/dashboard/prices', { prices: { notes: 1500 } });
		expect(saved.status).toBe(200);
		expect(saved.json).toMatchObject({ version: 2 });
		const page = await owner.get('/v1/admin/products/notes');
		expect(page.json).toMatchObject({
			priceListVersion: 2,
			features: [
				{ key: 'notes', millicreditsPerHour: 1500 },
				{ key: 'import', millicreditsPerHour: 0 },
			],
		});
		const [entry] = await sys.activity('product.prices_changed');
		expect(entry?.after).toMatchObject({ version: 2, changes: [{ key: 'notes', before: 0, after: 1500 }] });
		expect((await sys.dashboard(cookie, 'GET', '/v1/dashboard/prices')).json).toMatchObject({
			version: 2,
			features: [
				{ key: 'notes', millicreditsPerHour: 1500 },
				{ key: 'import', millicreditsPerHour: 0 },
			],
		});
		// Support never opens Prices; a negative price never leaves the product
		const support = await sys.admin('support');
		const supportCookie = await sys.adminSession(support.client, websiteId);
		expect((await sys.dashboard(supportCookie, 'PUT', '/v1/dashboard/prices', { prices: { notes: 1 } })).status).toBe(403);
		const negative = await sys.dashboard(cookie, 'PUT', '/v1/dashboard/prices', { prices: { notes: -1 } });
		expect(negative.status).toBe(422);
		expect((await owner.get('/v1/admin/products/notes')).json.priceListVersion).toBe(2);
	});

	it('a Support admin saves Features: the feature report is accepted and charging starts', async () => {
		const support = await sys.admin('support');
		const cookie = await sys.adminSession(support.client, websiteId);
		const saved = await sys.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${websiteId}/features`, { on: ['notes'] });
		expect(saved.status).toBe(200);
		expect(saved.json).toEqual({ version: 1, on: ['notes'] });
		const [entry] = await sys.activity('product.features_changed');
		expect(entry).toMatchObject({ actor: { type: 'admin', id: support.adminId, name: 'support admin' } });
		expect(entry?.after).toMatchObject({ version: 1, on: ['notes'] });
		const cards = await m.client.get(`/v1/merchants/${m.merchantId}/websites/${websiteId}/products`);
		expect(cards.json.items).toEqual([
			expect.objectContaining({ productId: 'notes', featuresOn: ['notes'], hourlyCost: 1500, dailyCost: 36_000 }),
		]);
		// a merchant never switches features
		const own = await sys.merchantSession(m, websiteId);
		expect((await sys.dashboard(own, 'PUT', `/v1/dashboard/websites/${websiteId}/features`, { on: [] })).status).toBe(403);

		// charged from the moment it is on, and every clock hour after
		const now = await sys.dashboard(cookie, 'GET', `/v1/dashboard/websites/${websiteId}/overview`);
		expect(now.json).toMatchObject({ featuresOn: ['notes'], todayMillicredits: 1500, status: { status: 'active' } });
		sys.clock.advance(HOUR);
		const later = await sys.dashboard(cookie, 'GET', `/v1/dashboard/websites/${websiteId}/overview`);
		expect(later.json.todayMillicredits).toBe(3000);
	});

	it('a refused feature report changes nothing in the product', async () => {
		const owner = await sys.owner();
		const support = await sys.admin('support');
		const cookie = await sys.adminSession(support.client, websiteId);
		// the admin becomes Finance while the product cannot hear it: its dashboard session lives on for now
		sys.setReachable(false);
		const changed = await owner.patch(`/v1/admin/admins/${support.adminId}`, { role: 'finance' });
		expect(changed.status).toBe(200);
		expect((await sys.waitingNotices()).map((n) => n.type)).toContain('sessions.revoked');
		sys.setReachable(true);

		const refused = await sys.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${websiteId}/features`, { on: [] });
		expect(refused.status).toBeGreaterThanOrEqual(400);
		expect(refused.json.detail).toMatch(/Nothing was changed/);
		expect(await sys.product.featuresOn(websiteId)).toEqual(['notes']);
		const owned = await sys.adminSession(owner, websiteId);
		expect((await sys.dashboard(owned, 'GET', `/v1/dashboard/websites/${websiteId}/features`)).json).toMatchObject({
			featuresVersion: 1,
			features: [
				{ key: 'notes', on: true },
				{ key: 'import', on: false },
			],
		});
		const cards = await owner.get(`/v1/merchants/${m.merchantId}/websites/${websiteId}/products`);
		expect(cards.json.items[0]).toMatchObject({ featuresOn: ['notes'], featuresVersion: 1 });
		// the Portal's next answer to the product delivered the waiting notice: that session has ended
		expect(await sys.waitingNotices()).toEqual([]);
		expect((await sys.dashboard(cookie, 'GET', '/v1/dashboard/session')).status).toBe(401);
	});
});
