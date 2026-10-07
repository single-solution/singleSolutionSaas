import { describe, expect, it } from 'vitest';
import { createConnectRequest, createJwks, generateSigningKey } from '@ss/protocol';
import { createFakePortal } from '../src/testing.js';
import { createProduct, createRequestHandler, standardRoutes } from '../src/index.js';
import { APP_ID, PORTAL_URL, WEBSITE, createClock, createTestLogger, entitle, manifest } from './helpers.js';

const BASE = 'https://coupons.deploy.test';
const SECRET = 's'.repeat(40);

/**
 * An unconnected product (no fixed connection) and its fake Portal.
 * @param {{ clock?: ReturnType<typeof createClock>, stores?: any, nodeEnv?: string, connectSecret?: string }} [options]
 */
const unconnected = async ({ clock = createClock(), stores, nodeEnv = 'test', connectSecret = SECRET } = {}) => {
	const portal = await createFakePortal({ url: PORTAL_URL, now: clock.now, appId: APP_ID });
	const { logger, entries } = createTestLogger();
	const product = createProduct({
		manifest: manifest(),
		fetch: portal.fetch,
		now: clock.now,
		logger,
		nodeEnv,
		connectSecret,
		...(stores ? { stores } : {}),
	});
	const handle = createRequestHandler(product, standardRoutes(product));
	/** @param {{ secret?: string, productUrl?: string, via?: Awaited<ReturnType<typeof createFakePortal>> }} [input] */
	const connect = ({ secret = SECRET, productUrl = BASE, via = portal } = {}) =>
		via.connect({ productUrl, secret, fetch: handle });
	return { portal, product, handle, connect, clock, logs: entries };
};

describe('connect-secret onboarding', () => {
	it('refuses product routes before a Portal connects; the manifest answers', async () => {
		const { product, handle } = await unconnected();
		const entitlement = await handle(new Request(`${BASE}/v1/entitlement`));
		expect(entitlement.status).toBe(503);
		expect((await entitlement.json()).detail).toMatch(/Add product/);
		expect((await handle(new Request(`${BASE}/setup`))).status).toBe(404);
		expect((await handle(new Request(`${BASE}/.well-known/ss-app.json`))).status).toBe(200);
		expect(product.connected()).toBe(false);
		expect(() => product.portal.baseUrl).toThrow(/not connected/);
	});

	it('connects with the secret: own key, pinned Portal, signed answer', async () => {
		const { portal, product, connect, logs } = await unconnected();
		expect(await connect({ productUrl: `${BASE}/` })).toEqual({ status: 200, appId: APP_ID });
		expect(product.connected()).toBe(true);
		expect(product.portal.baseUrl).toBe(PORTAL_URL);
		expect(portal.connected()).toMatchObject({ baseUrl: BASE });
		expect(/** @type {any} */ (portal.connected()).manifest.endpoints.base).toBe(BASE);
		expect(logs.some((l) => l.msg === 'product connected to the Portal')).toBe(true);
		const served = await product.manifestRoute();
		expect(served.body.endpoints.base).toBe(BASE);
		await entitle(portal);
		expect((await product.entitlements.forWebsite(WEBSITE)).ok).toBe(true);
	});

	it('connecting again replaces the binding and keeps the signing key', async () => {
		const { product, connect, clock } = await unconnected();
		expect((await connect()).status).toBe(200);
		const key = await product.context.stores.settings.get('signingKey');
		const other = await createFakePortal({ url: 'https://other-portal.test', now: clock.now, appId: 'app_other' });
		expect((await connect({ via: other })).status).toBe(200);
		expect(product.portal.baseUrl).toBe('https://other-portal.test');
		expect(await product.context.appId()).toBe('app_other');
		expect(await product.context.stores.settings.get('signingKey')).toEqual(key);
	});

	it('another instance on the same control database picks the connection up', async () => {
		const clock = createClock();
		const first = await unconnected({ clock });
		const stores = first.product.context.stores;
		const second = createProduct({ manifest: manifest(), stores, fetch: first.portal.fetch, now: clock.now });
		await second.ready();
		expect(second.connected()).toBe(false);
		expect((await first.connect()).status).toBe(200);
		clock.advance(1500);
		await second.ready();
		expect(second.connected()).toBe(true);
		expect(await second.context.appId()).toBe(APP_ID);
		expect(second.secret('feed').equals(first.product.secret('feed'))).toBe(true);
		expect(second.secret('feed').equals(second.secret('other'))).toBe(false);
	});

	it('refuses a wrong secret, a missing secret, plain-http in production, stale and replayed requests', async () => {
		const { product, handle, connect, clock } = await unconnected({ nodeEnv: 'production' });
		expect((await connect({ secret: 'x'.repeat(40) })).status).toBe(401);
		expect((await connect({ productUrl: 'http://coupons.deploy.test' })).status).toBe(400);
		const { publicJwk } = await generateSigningKey({ kid: 'p1' });
		const request = createConnectRequest({
			secret: SECRET,
			productUrl: BASE,
			portalUrl: PORTAL_URL,
			jwks: createJwks([publicJwk]),
			appId: APP_ID,
			now: clock.now,
		});
		const send = () => handle(new Request(request.url, { method: 'POST', headers: request.headers, body: request.body }));
		expect((await send()).status).toBe(200);
		expect((await send()).status).toBe(401);
		clock.advance(6 * 60_000);
		const stale = createConnectRequest({
			secret: SECRET,
			productUrl: BASE,
			portalUrl: PORTAL_URL,
			jwks: createJwks([publicJwk]),
			appId: APP_ID,
			now: () => clock.now() - 6 * 60_000,
		});
		const res = await handle(new Request(stale.url, { method: 'POST', headers: stale.headers, body: stale.body }));
		expect(res.status).toBe(401);
		expect(product.connected()).toBe(true);

		const without = await unconnected({ connectSecret: '' });
		expect((await without.connect()).status).toBe(503);
		expect(without.product.connected()).toBe(false);
		expect(await without.product.context.stores.settings.get('connection')).toBeNull();
	});

	it('a fixed connection cannot be changed', async () => {
		const portal = await createFakePortal({ url: PORTAL_URL, appId: APP_ID });
		const fixed = createProduct({
			manifest: manifest(),
			portalUrl: PORTAL_URL,
			appId: APP_ID,
			signingKey: 'k1:' + 'A'.repeat(43),
			connectSecret: SECRET,
		});
		const fixedHandle = createRequestHandler(fixed, standardRoutes(fixed));
		expect((await portal.connect({ productUrl: BASE, secret: SECRET, fetch: fixedHandle })).status).toBe(409);
		expect((await fixedHandle(new Request(`${BASE}/v1/ss/disconnect`, { method: 'POST' }))).status).toBe(404);
	});
});
