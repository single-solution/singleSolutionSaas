/**
 * PLAN §1 / §7 “Then new products”: the only plug-in path — connect → set active → place on a website → Open
 * configure (password step-up + SSO) → Setup sheet blueprint. No Portal page named after the product; the website
 * shows a product row and the sheet aggregates `GET /v1/blueprint`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBlueprint } from '@ss/contracts';
import { CONNECT_SECRET, PASSWORD, PRODUCT_URL, codeOf, startSystem } from './helpers.js';

const DOMAIN = 'plugin.example.com';
const CONFIRM = { password: PASSWORD };

/** @type {import('./helpers.js').System} */
let sys;
beforeAll(async () => {
	sys = await startSystem();
});
afterAll(async () => {
	await sys?.stop();
});

describe('new product plug-in path (manifest → connect → place → launch → blueprint)', () => {
	it('connects inactive, activates, places, opens configure, and exposes a secret-free blueprint', async () => {
		const owner = await sys.owner();

		// 1. Connect (URL + CONNECT_SECRET) → inactive; wrong secret refused
		expect(
			codeOf(await owner.post('/v1/admin/products', { url: PRODUCT_URL, secret: `${CONNECT_SECRET}-wrong` })),
		).toBe('unauthorized');
		const connected = await owner.post('/v1/admin/products', { url: PRODUCT_URL, secret: CONNECT_SECRET });
		expect(connected.status).toBe(201);
		expect(connected.json.product).toMatchObject({
			productId: 'notes',
			name: 'Notes',
			status: 'inactive',
			baseUrl: PRODUCT_URL,
		});

		const m = await sys.merchant('plugin@shop.test', [DOMAIN]);
		const [websiteId = ''] = m.websiteIds;

		// inactive is not placeable
		expect(
			(await owner.post(`/v1/merchants/${m.merchantId}/websites/${websiteId}/products`, { productId: 'notes' })).status,
		).toBe(409);

		// 2. Set active → offered for placement
		expect((await owner.post('/v1/admin/products/notes/status', { status: 'active' })).json.product.status).toBe('active');

		// 3. Place on the website → tokens minted; product appears as a row (not a Portal route)
		const card = await sys.addProduct(m.merchantId, websiteId);
		expect(card).toMatchObject({ productId: 'notes', status: 'active', featuresOn: [] });
		const rows = await m.client.get(`/v1/merchants/${m.merchantId}/websites/${websiteId}/products`);
		expect(rows.status).toBe(200);
		expect(rows.json.items).toEqual([expect.objectContaining({ productId: 'notes', name: 'Notes' })]);
		const list = await m.client.get(`/v1/merchants/${m.merchantId}/websites/${websiteId}/tokens`);
		expect(list.json.items).toEqual([
			expect.objectContaining({
				productId: 'notes',
				browserToken: expect.any(String),
				serverToken: { canShow: true },
				widgetScriptUrl: `${PRODUCT_URL}/widget.js`,
			}),
		]);

		// 4. Open configure: password required; then single-use launch → dashboard session
		const launchPath = `/v1/merchants/${m.merchantId}/websites/${websiteId}/products/notes/launch`;
		expect((await m.client.post(launchPath, {})).status).toBe(422);
		const launch = await m.client.post(launchPath, CONFIRM);
		expect(launch.status).toBe(200);
		expect(launch.json.url).toMatch(new RegExp(`^${PRODUCT_URL}/sso\\?launch=`));
		const opened = await sys.open(launch.json.url);
		expect(opened.status).toBe(303);
		expect(opened.location).toBe(`/dashboard?websiteId=${websiteId}`);
		const session = await sys.dashboard(opened.cookie, 'GET', '/v1/dashboard/session');
		expect(session.status).toBe(200);
		expect(session.json.who).toMatchObject({ kind: 'merchant', id: m.merchantId });
		expect((await sys.open(launch.json.url)).status).toBe(401);

		// Owner Open as admin for the same website (password step-up)
		const adminLaunch = await owner.post('/v1/admin/products/notes/launch', { websiteId, ...CONFIRM });
		expect(adminLaunch.status).toBe(200);
		const adminOpened = await sys.open(adminLaunch.json.url);
		expect((await sys.dashboard(adminOpened.cookie, 'GET', '/v1/dashboard/session')).json.who).toMatchObject({
			kind: 'admin',
			role: 'portal_owner',
		});

		// 5. Setup sheet aggregates the product blueprint; no secrets
		const sheet = await m.client.get(`/v1/merchants/${m.merchantId}/websites/${websiteId}/setup`);
		expect(sheet.status).toBe(200);
		expect(validateBlueprint(sheet.json).ok).toBe(true);
		expect(sheet.json.website).toMatchObject({ id: websiteId, domain: DOMAIN });
		expect(sheet.json.products).toEqual([
			expect.objectContaining({ productId: 'notes', name: 'Notes', reachable: true, status: 'active' }),
		]);
		const revealed = await m.client.post(
			`/v1/merchants/${m.merchantId}/websites/${websiteId}/tokens/notes/reveal`,
			CONFIRM,
		);
		expect(revealed.status).toBe(200);
		const text = JSON.stringify(sheet.json);
		expect(text.includes(String(revealed.json.serverToken))).toBe(false);
		expect(text.includes(CONNECT_SECRET)).toBe(false);
	});
});
