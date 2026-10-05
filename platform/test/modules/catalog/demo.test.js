/**
 * Merchant "Try demo": `POST /v1/merchants/:merchantId/apps/:appId/demo` issues a `demo` launch (no merchant or
 * website scope) for listed products that declare `capabilities.sandbox` or `endpoints.demo`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeMongoClients } from '../../../src/infra/db.js';
import { MERCHANT, PORTAL_URL, startMongo } from '../../helpers.js';
import { bootPortal, problemOf } from './boot.js';
import { startFakeProduct } from './fakes/product.js';
import { serviceManifest } from './fixtures.js';

/** @type {Awaited<ReturnType<typeof startMongo>>} */
let mongo;
/** @type {Array<{ close: () => Promise<unknown> }>} */
const products = [];

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

beforeAll(async () => {
	mongo = await startMongo();
}, 120_000);
afterAll(async () => {
	await Promise.all(products.map((p) => p.close()));
	await closeMongoClients();
	await mongo?.stop();
});

/** @param {any} manifest */
const setup = async (manifest = serviceManifest()) => {
	const t = await bootPortal({ db: mongo.db('cat_demo') });
	const p = await startFakeProduct({ manifest, portalUrl: PORTAL_URL, fetchJwks: t.jwks, now: t.clock.now });
	products.push(p);
	const res = await t.staff('POST', '/v1/admin/apps/register', { body: { baseUrl: p.url, token: p.token } });
	expect(res.status).toBe(201);
	const appId = /** @type {string} */ (res.json.appId);
	const cookie = await t.session({ kind: 'merchant', subject: 'usr_owner', roles: ['owner'], merchantId: MERCHANT });
	return { t, p, appId, cookie };
};

describe('merchant demo launch', () => {
	it('issues a demo launch without merchant scope for an active sandbox product', async () => {
		const { t, p, appId, cookie } = await setup();
		problemOf(
			await t.call('POST', `/v1/merchants/${MERCHANT}/apps/${appId}/demo`, { cookie, body: {} }),
			422,
			'catalog_launch_refused',
		);
		expect((await t.staff('POST', `/v1/admin/apps/${appId}/lifecycle`, { body: { action: 'activate' } })).status).toBe(200);
		const res = await t.call('POST', `/v1/merchants/${MERCHANT}/apps/${appId}/demo`, { cookie, body: {} });
		expect(res.status, JSON.stringify(res.json)).toBe(200);
		const url = new URL(res.json.url);
		expect(`${url.origin}${url.pathname}`).toBe(`${p.url}/sso`);
		expect(Date.parse(res.json.expiresAt)).toBeGreaterThan(t.clock.now());
		const claims = await t.verify(/** @type {string} */ (url.searchParams.get('launch')), appId);
		expect(claims).toMatchObject({ kind: 'demo', sub: 'usr_owner', aud: appId, iss: PORTAL_URL, scope: {} });
		expect(claims.scope.merchantId).toBeUndefined();
		// the body takes no fields; other merchants, missing sessions and unknown apps are refused
		problemOf(
			await t.call('POST', `/v1/merchants/${MERCHANT}/apps/${appId}/demo`, { cookie, body: { websiteId: 'web_x' } }),
			422,
			'validation_failed',
		);
		problemOf(await t.call('POST', `/v1/merchants/mer_1123456789abcdefghjkmnpq/apps/${appId}/demo`, { cookie, body: {} }), 403);
		expect((await t.call('POST', `/v1/merchants/${MERCHANT}/apps/${appId}/demo`, { body: {} })).status).toBe(401);
		problemOf(
			await t.call('POST', `/v1/merchants/${MERCHANT}/apps/app_0000000000000000000000nope/demo`, { cookie, body: {} }),
			404,
		);
	});

	it('refuses products without a sandbox or demo endpoint', async () => {
		const manifest = serviceManifest();
		manifest.capabilities = { ...manifest.capabilities, sandbox: false };
		delete manifest.endpoints.demo;
		const { t, appId, cookie } = await setup(manifest);
		await t.staff('POST', `/v1/admin/apps/${appId}/lifecycle`, { body: { action: 'activate' } });
		problemOf(
			await t.call('POST', `/v1/merchants/${MERCHANT}/apps/${appId}/demo`, { cookie, body: {} }),
			422,
			'catalog_launch_refused',
		);
	});

	it('accepts an endpoints.demo without the sandbox capability', async () => {
		const manifest = serviceManifest();
		manifest.capabilities = { ...manifest.capabilities, sandbox: false };
		manifest.endpoints.demo = '/demo';
		const { t, appId, cookie } = await setup(manifest);
		await t.staff('POST', `/v1/admin/apps/${appId}/lifecycle`, { body: { action: 'activate' } });
		expect((await t.call('POST', `/v1/merchants/${MERCHANT}/apps/${appId}/demo`, { cookie })).status).toBe(200);
	});
});
