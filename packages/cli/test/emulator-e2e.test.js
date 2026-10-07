import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { createKeyResolver, generateSigningKey, verifyLaunch } from '@ss/protocol';
import { createPortal } from '../src/emulator/portal.js';
import { createEmulatorServer } from '../src/emulator/server.js';
import { normaliseFixture } from '../src/emulator/fixture.js';
import { initApp } from '../src/init.js';
import { loadManifest } from '../src/manifest.js';
import { FAKE_SECRET, createFakeProduct } from './helpers/fake-product.js';
import { freePort, removeDir, tempDir } from './helpers/util.js';

/** @type {string} */
let root;
/** @type {Awaited<ReturnType<typeof createPortal>>} */
let portal;
/** @type {ReturnType<typeof createEmulatorServer>} */
let server;
/** @type {ReturnType<typeof createFakeProduct>} */
let product;
/** @type {string} */
let portalUrl;
/** @type {string} */
let productUrl;

/** @param {string} operation @param {unknown} [body] @param {string} [token] */
const admin = async (operation, body, token = server.adminToken) => {
	const response = await fetch(`${portalUrl}/_dev/${operation}`, {
		method: body === undefined ? 'GET' : 'POST',
		headers: { 'content-type': 'application/json', 'x-ss-dev-token': token },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	return { status: response.status, body: /** @type {any} */ (await response.json()) };
};

beforeAll(async () => {
	root = await tempDir('ss-e2e-');
	const dir = path.join(root, 'svc');
	await initApp({ dir, kind: 'service', slug: 'e2e-notes', name: 'E2E Notes' });
	const manifest = (await loadManifest(dir)).manifest;
	portalUrl = `http://127.0.0.1:${await freePort()}`;
	portal = await createPortal({
		fixture: normaliseFixture({}),
		portalUrl,
		database: {
			resolve: async ({ merchantId }) => ({
				uri: `mongodb://127.0.0.1:1/client_${merchantId}`,
				dbName: `client_${merchantId}`,
			}),
		},
	});
	server = createEmulatorServer({ portal });
	await server.start();
	product = createFakeProduct({
		manifest,
		portalUrl,
		signingKey: (await generateSigningKey({ kid: 'e2e-app-1' })).privateJwk,
	});
	productUrl = await product.start();
});

afterAll(async () => {
	await product.stop();
	await server.stop();
	await removeDir(root);
});

describe('ss dev emulator end to end (with @ss/protocol verification on the product side)', () => {
	it('serves JWKS and protects the admin API', async () => {
		const jwks = await (await fetch(`${portalUrl}/.well-known/jwks.json`)).json();
		expect(jwks.keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', kid: 'portal-dev-1' });
		expect((await admin('state', undefined, 'wrong')).status).toBe(401);
		expect((await fetch(`${portalUrl}/nope`)).status).toBe(404);
		expect((await admin('unknown', {})).status).toBe(400);
		const bad = await fetch(`${portalUrl}/v1/product/usage`, { method: 'POST', body: '{ nope' });
		expect(bad.status).toBe(400);
	});

	it('connects the product with its connect secret; a wrong secret is refused; connecting again keeps the app', async () => {
		const wrong = await admin('connect', { url: productUrl, secret: 'w'.repeat(40) });
		expect(wrong.status).toBe(502);
		expect(wrong.body.error).toBe('connection_rejected');
		expect(product.appId).toBeNull();
		const connected = await admin('connect', { url: productUrl, secret: FAKE_SECRET });
		expect(connected.status).toBe(200);
		expect(product.appId).toBe(connected.body.appId);
		expect((await admin('state')).body.apps).toMatchObject([{ kids: ['e2e-app-1'], slug: 'e2e-notes', baseUrl: productUrl }]);
		const again = await admin('connect', { url: productUrl, secret: FAKE_SECRET });
		expect(again.body.appId).toBe(connected.body.appId);
		expect((await admin('state')).body.apps).toHaveLength(1);
		// the emulator has no product-initiated connect endpoint any more
		expect((await fetch(`${portalUrl}/v1/apps/connect`, { method: 'POST', body: '{}' })).status).toBe(404);
	});

	it('issues launches the product verifies, keys the product accepts, and delivers signed events', async () => {
		const launched = (await admin('launch', { kind: 'impersonate' })).body;
		const resolver = createKeyResolver({ fetchJwks: async () => (await fetch(`${portalUrl}/.well-known/jwks.json`)).json() });
		const claims = await verifyLaunch({
			token: launched.token,
			keyResolver: resolver,
			audience: /** @type {string} */ (product.appId),
			issuer: portalUrl,
			consume: () => true,
		});
		expect(claims).toMatchObject({ kind: 'impersonate', act: { sub: 'usr_devstaff01' } });
		expect(launched.url.startsWith(`${productUrl}/sso?launch=`)).toBe(true);

		const keys = (await admin('keys')).body;
		const sk = keys.find((/** @type {any} */ key) => key.kind === 'sk').key;
		const created = await fetch(`${productUrl}/v1/notes`, {
			method: 'POST',
			headers: { authorization: `Bearer ${sk}`, 'idempotency-key': 'k1', 'content-type': 'application/json' },
			body: JSON.stringify({ text: 'hi' }),
		});
		expect(created.status).toBe(201);
		expect(portal.usage()).toHaveLength(1);
		expect((await admin('keys', { websiteId: 'web_devwebsite01' })).body).toHaveLength(2);
		const revoked = await admin('revoke', { keyId: keys[0].keyId });
		expect(revoked.body.revokedAt).toBeTruthy();

		const emitted = await admin('emit', { type: 'order.placed', websiteId: 'web_devwebsite01' });
		expect(emitted.body.status).toBe(200);
		expect(emitted.body.event.type).toBe('order.placed@1');
		expect((await admin('emit', { type: 'cart.updated' })).status).toBe(400);

		const settled = (await admin('settle', { hours: 2 })).body;
		expect(settled.entries.length).toBeGreaterThanOrEqual(2);
		const changed = (await admin('entitlements', { websiteId: 'web_devwebsite01', element: 'notes', enabled: false })).body;
		expect(changed.layer.elements.notes).toEqual({ enabled: false });
		expect(changed.deliveries).toEqual([{ appId: product.appId, status: 200 }]);
		const paused = (
			await admin('subscription', { websiteId: 'web_devwebsite01', status: 'paused', reason: 'merchant_request' })
		).body;
		expect(paused.type).toBe('subscription.paused@1');
		expect(paused.deliveries.map((/** @type {any} */ delivery) => delivery.status)).toEqual([200, 200]);
		expect((await admin('subscription', { websiteId: 'web_devwebsite01', status: 'active' })).body.type).toBe(
			'subscription.resumed@1',
		);
		expect((await admin('subscription', { websiteId: 'web_devwebsite01', status: 'active' })).body.type).toBe(
			'subscription.activated@1',
		);
		expect((await admin('subscription', { websiteId: 'web_devwebsite01', status: 'odd' })).status).toBe(400);
		const resource = (await admin('resource', { websiteId: 'web_devwebsite01', kind: 'ai', status: 'connected' })).body;
		expect(resource.resources.ai).toBe('connected');
		expect(resource.deliveries.map((/** @type {any} */ delivery) => delivery.status)).toEqual([200, 200]);
		expect((await admin('resource', { websiteId: 'web_nope000000001', kind: 'ai', status: 'connected' })).status).toBe(404);
		const cancelled = (await admin('subscription', { websiteId: 'web_devwebsite01', status: 'cancelled' })).body;
		expect(cancelled.deliveries).toHaveLength(1);
		const state = (await admin('state')).body;
		expect(state.apps[0].slug).toBe('e2e-notes');
		expect(state.usage).toHaveLength(1);
		expect((await admin('revoke', { keyId: 'key_missing000001' })).status).toBe(404);
	});

	it('keeps the product running while the Portal is down (restartable server)', async () => {
		await server.stop();
		await server.stop();
		await expect(fetch(`${portalUrl}/.well-known/jwks.json`)).rejects.toThrow();
		await server.start();
		await server.start();
		expect((await fetch(`${portalUrl}/.well-known/jwks.json`)).status).toBe(200);
		expect(server.port).toBe(Number(new URL(portalUrl).port));
	});
});
