import { describe, expect, it } from 'vitest';
import { createFakePortal } from '../src/testing.js';
import { createProduct, createRequestHandler, standardRoutes } from '../src/index.js';
import { APP_ID, PORTAL_URL, WEBSITE, createClock, createTestLogger, entitle, manifest } from './helpers.js';

const BASE = 'https://coupons.deploy.test';

/**
 * An unconnected product (no fixed connection) and its fake Portal.
 * @param {{ clock?: ReturnType<typeof createClock>, stores?: any, nodeEnv?: string }} [options]
 */
const unconnected = async ({ clock = createClock(), stores, nodeEnv = 'test' } = {}) => {
	const portal = await createFakePortal({ url: PORTAL_URL, now: clock.now, appId: APP_ID });
	const { logger, entries } = createTestLogger();
	const product = createProduct({
		manifest: manifest(),
		fetch: portal.fetch,
		now: clock.now,
		logger,
		nodeEnv,
		...(stores ? { stores } : {}),
	});
	const handle = createRequestHandler(product, standardRoutes(product));
	/** @param {Record<string, string>} fields @param {boolean} [json] */
	const post = (fields, json = false) =>
		handle(
			new Request(`${BASE}/setup`, {
				method: 'POST',
				headers: { 'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded' },
				body: json ? JSON.stringify(fields) : new URLSearchParams(fields).toString(),
			}),
		);
	return { portal, product, handle, post, clock, logs: entries };
};

describe('connection-code setup', () => {
	it('refuses product routes before setup and serves the setup page, health and the manifest', async () => {
		const { product, handle } = await unconnected();
		const entitlement = await handle(new Request(`${BASE}/v1/entitlement`));
		expect(entitlement.status).toBe(503);
		expect((await entitlement.json()).detail).toMatch(/\/setup/);
		const page = await handle(new Request(`${BASE}/setup`));
		expect(page.status).toBe(200);
		expect(page.headers.get('content-type')).toContain('text/html');
		const html = await page.text();
		expect(html).toContain('Connection code');
		expect(html).toContain(`value="${BASE}"`);
		expect(html).toContain('right after deploying');
		expect((await handle(new Request(`${BASE}/healthz`))).status).toBe(200);
		expect((await handle(new Request(`${BASE}/.well-known/ss-app.json`))).status).toBe(200);
		expect(product.connected()).toBe(false);
		expect(() => product.portal.baseUrl).toThrow(/not connected/);
		await expect(product.portal.jwks()).rejects.toMatchObject({ code: 'not_connected' });
	});

	it('connects with a code: own key, proof of possession, pinned Portal; setup then closes', async () => {
		const { portal, product, handle, post, logs } = await unconnected();
		const res = await post({ code: portal.connectionCode(), baseUrl: `${BASE}/` });
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('is connected');
		expect(product.connected()).toBe(true);
		expect(product.portal.baseUrl).toBe(PORTAL_URL);
		expect(portal.connected()).toMatchObject({ baseUrl: BASE });
		expect(/** @type {any} */ (portal.connected()).manifest.endpoints.base).toBe(BASE);
		expect(logs.some((l) => l.msg === 'product connected to the Portal')).toBe(true);
		// the served manifest carries the recorded address and is signed for the appId
		const served = await product.manifestRoute();
		expect(served.body.endpoints.base).toBe(BASE);
		expect(served.headers['ss-manifest-signature']).toMatch(/\./);
		// the product now authenticates to the Portal with the stored key and appId
		await entitle(portal);
		expect((await product.entitlements.forWebsite(WEBSITE)).ok).toBe(true);
		// setup is closed
		expect((await handle(new Request(`${BASE}/setup`))).status).toBe(404);
		expect((await post({ code: portal.connectionCode(), baseUrl: BASE })).status).toBe(404);
		expect((await post({ code: portal.connectionCode(), baseUrl: BASE }, true)).status).toBe(404);
	});

	it('another instance on the same control database picks the connection up', async () => {
		const clock = createClock();
		const first = await unconnected({ clock });
		const stores = first.product.context.stores;
		const second = createProduct({ manifest: manifest(), stores, fetch: first.portal.fetch, now: clock.now });
		await second.ready();
		expect(second.connected()).toBe(false);
		expect((await first.post({ code: first.portal.connectionCode(), baseUrl: BASE }, true)).status).toBe(200);
		clock.advance(1500);
		await second.ready();
		expect(second.connected()).toBe(true);
		expect(await second.context.appId()).toBe(APP_ID);
		// both instances share the generated secret
		expect(second.secret('feed').equals(first.product.secret('feed'))).toBe(true);
		expect(second.secret('feed').equals(second.secret('other'))).toBe(false);
	});

	it('refuses bad codes, used codes, plain-http addresses and Portal refusals; nothing is stored', async () => {
		const { portal, product, post } = await unconnected({ nodeEnv: 'production' });
		const bad = await post({ code: 'nope', baseUrl: BASE });
		expect(bad.status).toBe(400);
		expect(await bad.text()).toContain('connection code');
		const insecure = await post({ code: portal.connectionCode(), baseUrl: 'http://coupons.deploy.test' }, true);
		expect(insecure.status).toBe(400);
		const unknown = await createFakePortal({ url: PORTAL_URL });
		const refused = await post({ code: unknown.connectionCode(), baseUrl: BASE }, true);
		expect(refused.status).toBe(502);
		expect((await refused.json()).detail).toMatch(/refused/);
		portal.setDown(true);
		expect((await post({ code: portal.connectionCode(), baseUrl: BASE }, true)).status).toBe(502);
		portal.setDown(false);
		expect(product.connected()).toBe(false);
		expect(await product.context.stores.settings.get('connection')).toBeNull();
		const code = portal.connectionCode();
		expect((await post({ code, baseUrl: BASE }, true)).status).toBe(200);
	});

	it('a Portal-signed disconnect reopens setup; a fixed connection cannot be changed', async () => {
		const { portal, product, handle, post } = await unconnected();
		expect((await post({ code: portal.connectionCode(), baseUrl: BASE }, true)).status).toBe(200);
		const signed = await portal.signRequest({ method: 'POST', path: '/v1/ss/disconnect' });
		const res = await handle(new Request(`${BASE}/v1/ss/disconnect`, { method: 'POST', headers: signed.headers }));
		expect(res.status).toBe(200);
		expect(product.connected()).toBe(false);
		expect((await handle(new Request(`${BASE}/setup`))).status).toBe(200);
		const unsigned = await handle(new Request(`${BASE}/v1/ss/disconnect`, { method: 'POST' }));
		expect(unsigned.status).toBe(503);

		const fixed = createProduct({
			manifest: manifest(),
			portalUrl: PORTAL_URL,
			appId: APP_ID,
			signingKey: 'k1:' + 'A'.repeat(43),
		});
		const fixedHandle = createRequestHandler(fixed, standardRoutes(fixed));
		expect((await fixedHandle(new Request(`${BASE}/setup`))).status).toBe(404);
		await expect(fixed.setup.connect({ code: portal.connectionCode(), baseUrl: BASE })).rejects.toMatchObject({
			code: 'conflict',
		});
		await expect(fixed.setup.disconnect()).rejects.toMatchObject({ code: 'conflict' });
	});
});
