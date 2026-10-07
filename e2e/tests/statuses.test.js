/**
 * PLAN 0.4.7, 0.5.5, 0.5.6 and 0.5.9: the product obeys the status of each product on a website the Portal decides —
 * active, grace, stopped, suspended and removed — and learns changes at once from `status.changed`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAY, HOUR, codeOf, startSystem } from './helpers.js';

/** @type {import('./helpers.js').System} */
let sys;
/** @type {Awaited<ReturnType<import('./helpers.js').System['merchant']>>} */
let m;
let websiteId = '';
/** @type {{ browser: string, server: string }} */
let tokens;
beforeAll(async () => {
	sys = await startSystem({ graceDays: 1 });
	await sys.connect();
	await sys.setPrices({ notes: 1000 });
	m = await sys.merchant('status@shop.test', ['status.example.com']);
	websiteId = m.websiteIds[0] ?? '';
	await sys.addProduct(m.merchantId, websiteId);
	await sys.addCredits(m.merchantId, 2);
	const cookie = await sys.adminSession(await sys.owner(), websiteId);
	await sys.connectDatabase(cookie, websiteId);
	await sys.switchFeatures(cookie, websiteId, ['notes']);
	tokens = await sys.tokens(m.merchantId, websiteId);
});
afterAll(async () => {
	await sys?.stop();
});

/** The server-token API answer: [status, problem code, reason]. */
const api = async () => {
	const res = await sys.call('GET', '/v1/notes', { token: tokens.server });
	return [res.status, res.status === 200 ? '' : codeOf(res), res.json?.reason ?? null];
};

/** The Portal's status response for the website (what the product fetches). */
const portalStatus = async () => (await sys.productApi('GET', `/v1/product/websites/${websiteId}/status`)).json;

describe('statuses of the product on a website', () => {
	it('active: everything works', async () => {
		expect(await api()).toEqual([200, '', null]);
		expect(await portalStatus()).toMatchObject({
			websiteId,
			merchantId: m.merchantId,
			domain: 'status.example.com',
			status: 'active',
			graceEndsAt: null,
			featuresVersion: 1,
		});
	});

	it('grace: the credit runs out, the product keeps working and is charged', async () => {
		sys.clock.advance(HOUR); // 2 credits = two hours of Notes: the second hour empties the balance and starts grace
		const status = await portalStatus();
		expect(status).toMatchObject({ status: 'grace', graceEndsAt: expect.any(String) });
		expect(await api()).toEqual([200, '', null]);
		const own = await sys.merchantSession(m, websiteId);
		const overview = await sys.dashboard(own, 'GET', `/v1/dashboard/websites/${websiteId}/overview`);
		expect(overview.json.status).toEqual({ status: 'grace', graceEndsAt: status.graceEndsAt });
	});

	it('stopped: grace days pass with no credits; the API refuses, the merchant still opens the dashboard', async () => {
		sys.clock.advance(DAY + HOUR);
		expect(await api()).toEqual([403, 'product_unavailable', 'stopped']);
		expect((await portalStatus()).status).toBe('stopped');
		const own = await sys.merchantSession(m, websiteId);
		const overview = await sys.dashboard(own, 'GET', `/v1/dashboard/websites/${websiteId}/overview`);
		expect(overview.json.status.status).toBe('stopped');
		const config = await sys.call('GET', '/v1/widget/config', { token: tokens.browser, origin: 'https://status.example.com' });
		expect([config.status, config.json.reason]).toEqual([403, 'stopped']);
	});

	it('credits restart it at once (status.changed)', async () => {
		await sys.addCredits(m.merchantId, 1000);
		expect(await sys.waitingNotices()).toEqual([]);
		expect(await api()).toEqual([200, '', null]);
	});

	it('suspended: the API refuses, the merchant cannot open the dashboard, admins can', async () => {
		const owner = await sys.owner();
		const own = await sys.merchantSession(m, websiteId);
		const suspended = await owner.post(`/v1/admin/merchants/${m.merchantId}/suspend`, { reason: 'Checks' });
		expect(suspended.status).toBe(200);
		expect(await api()).toEqual([403, 'product_unavailable', 'suspended']);
		// the merchant's dashboard session ended (sessions.revoked) and a new launch is refused
		expect((await sys.dashboard(own, 'GET', '/v1/dashboard/session')).status).toBe(401);
		const signIn = await sys.api.call('POST', '/v1/auth/sign-in', {
			body: { email: m.email, password: 'correct horse battery staple' },
		});
		expect(signIn.status).not.toBe(200);
		const launch = await m.client.post(`/v1/merchants/${m.merchantId}/websites/${websiteId}/products/notes/launch`);
		expect(launch.status).toBeGreaterThanOrEqual(400);
		const admin = await sys.adminSession(owner, websiteId);
		const overview = await sys.dashboard(admin, 'GET', `/v1/dashboard/websites/${websiteId}/overview`);
		expect(overview.json.status.status).toBe('suspended');

		await owner.post(`/v1/admin/merchants/${m.merchantId}/resume`, {});
		expect(await api()).toEqual([200, '', null]);
	});

	it('removed: the API refuses; a re-add restores the same tokens with every feature off', async () => {
		const owner = await sys.owner();
		const removed = await owner.del(`/v1/merchants/${m.merchantId}/websites/${websiteId}/products/notes`);
		expect(removed.json).toEqual({ websiteId, productId: 'notes', status: 'removed' });
		expect(await api()).toEqual([403, 'product_unavailable', 'removed']);
		expect((await portalStatus()).status).toBe('removed');
		const launch = await owner.post('/v1/admin/products/notes/launch', { websiteId });
		expect(launch.status).toBe(404);
		const cards = await owner.get(`/v1/merchants/${m.merchantId}/websites/${websiteId}/products`);
		expect(cards.json.items).toEqual([]);

		const card = await sys.addProduct(m.merchantId, websiteId);
		expect(card).toMatchObject({ status: 'active', featuresOn: [] });
		expect(await sys.tokens(m.merchantId, websiteId)).toEqual(tokens);
		expect(await sys.product.featuresOn(websiteId)).toEqual([]);
		// the tokens work again; the feature routes wait until an admin switches the feature on
		const off = await sys.call('GET', '/v1/notes', { token: tokens.server });
		expect([off.status, codeOf(off)]).toEqual([403, 'feature_off']);
		const config = await sys.call('GET', '/v1/widget/config', { token: tokens.browser, origin: 'https://status.example.com' });
		expect(config.status).toBe(200);
		expect(config.json.features).toEqual([]);
		await sys.switchFeatures(await sys.adminSession(owner, websiteId), websiteId, ['notes']);
		expect(await api()).toEqual([200, '', null]);
	});
});
