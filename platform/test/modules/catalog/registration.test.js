import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeMongoClients } from '../../../src/infra/db.js';
import { PORTAL_URL, startMongo } from '../../helpers.js';
import { bootPortal, problemOf } from './boot.js';
import { PRODUCT_SECRET, startFakeProduct } from './fakes/product.js';
import { renamedService, serviceManifest } from './fixtures.js';

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

/** @param {Parameters<typeof bootPortal>[0] extends infer O ? Partial<O> : never} [options] */
const boot = (options = {}) => bootPortal({ db: mongo.db('cat_connect'), ...options });

/**
 * @param {Awaited<ReturnType<typeof boot>>} t
 * @param {{ manifest?: any, kid?: string, secret?: string }} [options]
 */
const product = async (t, { manifest = serviceManifest(), kid, secret } = {}) => {
	const p = await startFakeProduct({
		manifest,
		portalUrl: PORTAL_URL,
		now: t.clock.now,
		...(kid ? { kid } : {}),
		...(secret ? { secret } : {}),
	});
	products.push(p);
	return p;
};

/**
 * Admin → Apps → Add product (URL + connect secret).
 * @param {Awaited<ReturnType<typeof boot>>} t
 * @param {{ url: unknown, secret?: unknown }} body
 * @param {string[]} [roles]
 */
const connect = (t, { url, secret = PRODUCT_SECRET }, roles) =>
	t.staff('POST', '/v1/admin/apps/connect', { body: { url, secret }, ...(roles ? { roles } : {}) });

describe('onboarding with the connect secret (Portal side)', () => {
	it('adds a product: the Portal calls its ss-connect with the HMAC, verifies the answer and pins it', async () => {
		const t = await boot();
		const p = await product(t);
		const res = await connect(t, { url: p.url });
		expect(res.status).toBe(201);
		expect(res.json).toMatchObject({ slug: 'coupons', baseUrl: p.url, kid: 'product-k1', reconnected: false });
		const appId = res.json.appId;
		expect(appId).toMatch(/^app_/);
		expect(p.registrations).toEqual([{ appId, portalKid: 'portal-2026-10', baseUrl: p.url }]);
		// the secret is neither answered nor stored
		expect(JSON.stringify(res.json)).not.toContain(PRODUCT_SECRET);

		const detail = await t.staff('GET', `/v1/admin/apps/${appId}`);
		expect(detail.json).toMatchObject({
			slug: 'coupons',
			kind: 'service',
			status: 'pending',
			environments: { production: p.url, staging: null },
		});
		expect(JSON.stringify(detail.json)).not.toContain(PRODUCT_SECRET);
		expect(detail.json.keys).toEqual([expect.objectContaining({ kid: 'product-k1', status: 'active', source: 'connection' })]);
		expect((await t.staff('GET', `/v1/admin/apps/${appId}/versions/1`)).json).toMatchObject({
			status: 'accepted',
			source: 'connection',
			manifest: serviceManifest(),
		});
		const beat = await t.call('POST', '/v1/product/heartbeat', {
			bearer: await t.assertion(p.signer, appId),
			body: { version: '1.4.0', status: 'ok' },
		});
		expect(beat).toMatchObject({ status: 200, json: { ok: true } });
		const audit = await t.audit(appId);
		expect(audit.map((a) => a.action)).toEqual(['catalog.app_connected']);
		expect(JSON.stringify(audit)).not.toContain(PRODUCT_SECRET);
	});

	it('refuses a wrong or short secret, a forged answer and staff without apps.manage', async () => {
		const t = await boot();
		const p = await product(t, { manifest: renamedService('deals') });
		problemOf(await connect(t, { url: p.url, secret: 'w'.repeat(40) }), 401, 'unauthorized');
		problemOf(await connect(t, { url: p.url, secret: 'short' }), 422, 'validation_failed');
		problemOf(await connect(t, { url: 'not a url' }), 422, 'validation_failed');
		p.tamper.connect = 'bad_signature';
		expect((await connect(t, { url: p.url })).status).toBe(502);
		p.tamper.connect = 'other_nonce';
		expect((await connect(t, { url: p.url })).status).toBe(502);
		delete p.tamper.connect;
		problemOf(await connect(t, { url: p.url }, ['support']), 403, 'forbidden');
		expect((await t.staff('GET', '/v1/admin/apps')).json.items).toEqual([]);
		expect((await connect(t, { url: p.url })).status).toBe(201);
	});

	it("shows a misconfigured product's own reason", async () => {
		const t = await boot();
		const p = await product(t, { manifest: renamedService('alerts') });
		const reason = "MONGODB_URI is required in production: set it to this product's own database.";
		p.tamper.misconfigured = [reason];
		const down = problemOf(await connect(t, { url: p.url }), 502, 'upstream_error');
		expect(down.detail).toContain(reason);
		expect(down.detail).toContain('503');
		delete p.tamper.misconfigured;
		p.tamper.connect = 'no_secret';
		const refused = problemOf(await connect(t, { url: p.url }), 502, 'upstream_error');
		expect(refused.detail).toBe('This product refuses connections: CONNECT_SECRET is shorter than 32 characters.');
	});

	it('checks the address and the answered manifest', async () => {
		const t = await boot({ allowlist: [] });
		const p = await product(t, { manifest: renamedService('grades') });
		// loopback is not allowed without the development allowlist
		problemOf(await connect(t, { url: p.url }), 422, 'catalog_target_refused');
		const open = await boot();
		const q = await product(open, { manifest: renamedService('reviews') });
		q.tamper.connect = 'other_manifest';
		problemOf(await connect(open, { url: q.url }), 422, 'invalid_manifest');
	});

	it('connecting again replaces the binding: new address and key, the old key revoked, same app', async () => {
		const t = await boot();
		const manifest = renamedService('loyalty');
		const first = await product(t, { manifest });
		const registered = await t.register(first);
		expect(registered.status).toBe(201);
		const appId = registered.json.appId;

		const moved = await product(t, { manifest, kid: 'product-k2', secret: 'a-new-secret-after-a-leak-0123456789abcdef' });
		problemOf(await connect(t, { url: moved.url }), 401, 'unauthorized');
		const res = await connect(t, { url: moved.url, secret: moved.secret });
		expect(res.status).toBe(201);
		expect(res.json).toMatchObject({ appId, reconnected: true });
		expect(moved.registrations.at(-1)?.appId).toBe(appId);
		const detail = await t.staff('GET', `/v1/admin/apps/${appId}`);
		expect(detail.json.environments.production).toBe(moved.url);
		expect(detail.json.keys.map((/** @type {any} */ k) => [k.kid, k.status])).toEqual([
			['product-k1', 'revoked'],
			['product-k2', 'active'],
		]);
		expect((await t.audit(appId)).map((a) => a.action)).toContain('catalog.app_reconnected');
		// the same deployment again (its key kept): still one active key
		expect((await connect(t, { url: moved.url, secret: moved.secret })).status).toBe(201);
		expect(
			(await t.staff('GET', `/v1/admin/apps/${appId}`)).json.keys.filter((/** @type {any} */ k) => k.status === 'active'),
		).toHaveLength(1);
	});
});
