import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeMongoClients } from '../../../src/infra/db.js';
import { PORTAL_URL, startMongo } from '../../helpers.js';
import { bootPortal, problemOf } from './boot.js';
import { fakeCommerce } from './fakes/modules.js';
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
 * @param {string} [role]
 */
const connect = (t, { url, secret = PRODUCT_SECRET }, role) =>
	t.staff('POST', '/v1/admin/apps/connect', { body: { url, secret }, ...(role ? { role } : {}) });

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

		const v1 = await t.staff('GET', `/v1/admin/apps/${appId}/versions/1`);
		expect(v1.status).toBe(200);
		expect(v1.json).toMatchObject({ appId, version: 1, status: 'accepted', manifest: { product: { slug: 'coupons' } } });
		expect((await t.staff('GET', `/v1/admin/apps/${appId}/versions/9`)).status).toBe(404);
		expect((await t.staff('GET', `/v1/admin/apps/${appId}/versions/x`)).status).toBe(404);

		const detail = await t.staff('GET', `/v1/admin/apps/${appId}`);
		expect(detail.json).toEqual({
			appId,
			slug: 'coupons',
			kind: 'service',
			status: 'inactive',
			name: 'Coupons',
			productVersion: serviceManifest().product.version,
			endpoints: serviceManifest().endpoints,
			baseUrl: p.url,
			currentVersion: 1,
			createdAt: expect.any(String),
			versions: [
				{ version: 1, productVersion: serviceManifest().product.version, status: 'accepted', createdAt: expect.any(String) },
			],
			keys: [{ kid: 'product-k1', thumbprint: expect.any(String), createdAt: expect.any(String) }],
		});
		expect(JSON.stringify(detail.json)).not.toContain(PRODUCT_SECRET);
		expect(await t.service().getManifest(appId)).toEqual(serviceManifest());
		expect(await t.service().versionDetail(appId, 1)).toMatchObject({ status: 'accepted', source: 'connection', assets: null });
		// the pinned key authenticates the product
		expect(await t.service().appKeys(appId)).not.toBeNull();
		expect(await t.service().appKeys('')).toBeNull();
		expect(await t.service().appKeys('app_nope')).toBeNull();
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
		problemOf(await connect(t, { url: p.url }, 'support'), 403, 'forbidden');
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

	it('connecting again replaces the binding: new address and key, same app; a changed manifest is current at once', async () => {
		/** @type {string[]} */
		const invalidated = [];
		const t = await boot({ modules: [fakeCommerce([], invalidated)] });
		const manifest = renamedService('loyalty');
		const first = await product(t, { manifest });
		const registered = await t.register(first);
		expect(registered.status).toBe(201);
		const appId = registered.json.appId;

		const moved = await product(t, { manifest, kid: 'product-k2', secret: 'a-new-secret-after-a-leak-0123456789abcdef' });
		problemOf(await connect(t, { url: moved.url }), 401, 'unauthorized');
		const res = await connect(t, { url: moved.url, secret: moved.secret });
		expect(res.status).toBe(201);
		expect(res.json).toEqual({ appId, slug: 'loyalty', baseUrl: moved.url, kid: 'product-k2', reconnected: true, version: 1 });
		expect(moved.registrations.at(-1)?.appId).toBe(appId);
		const detail = await t.staff('GET', `/v1/admin/apps/${appId}`);
		expect(detail.json.baseUrl).toBe(moved.url);
		expect(detail.json.keys.map((/** @type {any} */ k) => k.kid)).toEqual(['product-k2']);
		expect((await t.audit(appId)).map((a) => a.action)).toEqual(['catalog.app_connected', 'catalog.app_reconnected']);
		// the same deployment again (its key kept): still one key, nothing new announced
		expect((await connect(t, { url: moved.url, secret: moved.secret })).status).toBe(201);
		expect((await t.staff('GET', `/v1/admin/apps/${appId}`)).json.keys).toHaveLength(1);
		expect(t.integration?.emitted).toEqual([]);
		expect(invalidated).toEqual([]);

		// a new manifest with other prices: version 2 is current immediately, version 1 superseded
		const priced = renamedService('loyalty');
		priced.product.version = '1.5.0';
		priced.elements[0].price.hourly = 1500;
		moved.setManifest(priced);
		const changed = await connect(t, { url: moved.url, secret: moved.secret });
		expect(changed.json).toMatchObject({
			version: 2,
			priceChanges: [
				{
					element: 'codes',
					before: expect.objectContaining({ hourly: 1000 }),
					after: expect.objectContaining({ hourly: 1500 }),
				},
			],
		});
		const after = (await t.staff('GET', `/v1/admin/apps/${appId}`)).json;
		expect(after).toMatchObject({ currentVersion: 2, productVersion: '1.5.0' });
		expect(after.versions.map((/** @type {any} */ v) => [v.version, v.status])).toEqual([
			[2, 'accepted'],
			[1, 'superseded'],
		]);
		expect(t.integration?.emitted).toEqual([
			{
				type: 'manifest.accepted@1',
				data: expect.objectContaining({ appId, version: 2, productVersion: '1.5.0' }),
				options: { appIds: [appId] },
			},
		]);
		expect(invalidated).toEqual([appId]);
		// a description-only change: new version, no price note
		const described = structuredClone(priced);
		described.product.description = 'Now with points';
		moved.setManifest(described);
		const quiet = await connect(t, { url: moved.url, secret: moved.secret });
		expect(quiet.json.version).toBe(3);
		expect(quiet.json).not.toHaveProperty('priceChanges');
	});

	it('survives failing neighbours when announcing a new manifest', async () => {
		const t = await boot({ modules: [fakeCommerce([], null)] });
		const manifest = renamedService('wishlist');
		const p = await product(t, { manifest });
		const appId = (await t.register(p)).json.appId;
		const next = renamedService('wishlist');
		next.product.version = '2.0.0';
		p.setManifest(next);
		t.integration?.failOnce();
		const res = await connect(t, { url: p.url });
		expect(res.json.version).toBe(2);
		expect(t.entries.map((e) => e.msg)).toEqual(
			expect.arrayContaining(['manifest.accepted emission failed', 'entitlement refresh after a new manifest failed']),
		);
		expect((await t.service().getApp(appId)).currentVersion).toBe(2);

		const lone = await boot({ integration: null });
		const q = await product(lone, { manifest: renamedService('signups') });
		const lid = (await lone.register(q)).json.appId;
		const v2 = renamedService('signups');
		v2.product.version = '2.0.0';
		q.setManifest(v2);
		expect((await connect(lone, { url: q.url })).json.version).toBe(2);
		expect((await lone.service().getApp(lid)).currentVersion).toBe(2);
	});
});
