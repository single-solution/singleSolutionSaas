import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createConnectionCode } from '@ss/protocol';
import { closeMongoClients } from '../../../src/infra/db.js';
import { PORTAL_URL, startMongo } from '../../helpers.js';
import { bootPortal, problemOf } from './boot.js';
import { startFakeProduct } from './fakes/product.js';
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
 * @param {{ manifest?: any, kid?: string }} [options]
 */
const product = async (t, { manifest = serviceManifest(), kid } = {}) => {
	const p = await startFakeProduct({ manifest, portalUrl: PORTAL_URL, now: t.clock.now, ...(kid ? { kid } : {}) });
	products.push(p);
	return p;
};

/**
 * Post a product's connect request to the Portal (what its /setup does).
 * @param {Awaited<ReturnType<typeof boot>>} t
 * @param {{ body: string, headers: Record<string, string> }} request
 */
const connect = (t, request) =>
	t.call('POST', '/v1/apps/connect', { body: request.body, headers: request.headers, idempotencyKey: null });

describe('onboarding by connection code (Portal side)', () => {
	it('adds a product: a one-time code, the product connects with proof of possession and is pinned', async () => {
		const t = await boot();
		const issued = await t.staff('POST', '/v1/admin/apps/connection-codes');
		expect(issued.status).toBe(201);
		expect(issued.json).toMatchObject({ status: 'open', reconnect: false, appId: expect.stringMatching(/^app_/) });
		expect(issued.json.code).toMatch(/^ssc_/);
		// the code is shown once: the list holds no code
		const list = await t.staff('GET', '/v1/admin/apps/connection-codes');
		expect(list.json.items[0]).toMatchObject({ codeId: issued.json.codeId, status: 'open' });
		expect(JSON.stringify(list.json)).not.toContain(issued.json.code);

		const p = await product(t);
		const request = await p.connectRequest(issued.json.code);
		const res = await connect(t, request);
		expect(res.status).toBe(200);
		const accepted = await p.accept(res.json, request);
		expect(accepted).toMatchObject({ appId: issued.json.appId, portalKid: 'portal-2026-10' });

		const appId = issued.json.appId;
		const detail = await t.staff('GET', `/v1/admin/apps/${appId}`);
		expect(detail.json).toMatchObject({
			slug: 'coupons',
			kind: 'service',
			status: 'pending',
			environments: { production: p.url, staging: null },
		});
		expect(detail.json.keys).toEqual([expect.objectContaining({ kid: 'product-k1', status: 'active', source: 'connection' })]);
		expect((await t.staff('GET', `/v1/admin/apps/${appId}/versions/1`)).json).toMatchObject({
			status: 'accepted',
			source: 'connection',
			manifest: serviceManifest(),
		});
		// client assertions verify against the pinned key
		const beat = await t.call('POST', '/v1/product/heartbeat', {
			bearer: await t.assertion(p.signer, appId),
			body: { version: '1.4.0', status: 'ok' },
		});
		expect(beat).toMatchObject({ status: 200, json: { ok: true } });
		const audit = await t.audit(appId);
		expect(audit.map((a) => a.action)).toEqual(['catalog.connection_code_created', 'catalog.app_connected']);

		// single use: the same code is refused, and the list shows it used
		problemOf(await connect(t, await p.connectRequest(issued.json.code)), 401, 'unauthorized');
		expect((await t.staff('GET', '/v1/admin/apps/connection-codes')).json.items[0].status).toBe('used');
	});

	it('refuses unknown, revoked and expired codes, forged proofs and codes of another Portal', async () => {
		const t = await boot();
		const p = await product(t, { manifest: renamedService('deals') });
		const foreign = createConnectionCode({ portalUrl: 'https://other-portal.test' }).code;
		problemOf(await connect(t, await p.connectRequest(foreign)), 401, 'unauthorized');
		const ours = createConnectionCode({ portalUrl: PORTAL_URL }).code; // never issued
		problemOf(await connect(t, await p.connectRequest(ours)), 401, 'unauthorized');

		const revoked = (await t.staff('POST', '/v1/admin/apps/connection-codes')).json;
		expect((await t.staff('DELETE', `/v1/admin/apps/connection-codes/${revoked.codeId}`)).status).toBe(200);
		problemOf(await t.staff('DELETE', `/v1/admin/apps/connection-codes/${revoked.codeId}`), 404, 'not_found');
		problemOf(await connect(t, await p.connectRequest(revoked.code)), 401, 'unauthorized');

		const expiring = (await t.staff('POST', '/v1/admin/apps/connection-codes')).json;
		t.clock.advance(25 * 60 * 60_000);
		problemOf(await connect(t, await p.connectRequest(expiring.code)), 401, 'unauthorized');

		const fresh = (await t.staff('POST', '/v1/admin/apps/connection-codes')).json;
		const request = await p.connectRequest(fresh.code);
		problemOf(await connect(t, { ...request, body: request.body.replace('"deals"', '"other"') }), 401, 'unauthorized');
		problemOf(await connect(t, { ...request, headers: {} }), 401, 'unauthorized');
		// still usable after the refusals
		expect((await connect(t, request)).status).toBe(200);
		// plain staff without apps.manage cannot add products
		problemOf(await t.staff('POST', '/v1/admin/apps/connection-codes', { roles: ['support'] }), 403, 'forbidden');
	});

	it('validates the manifest and the address before burning the code; a taken slug is a conflict', async () => {
		const t = await boot({ allowlist: [] });
		const p = await product(t, { manifest: renamedService('grades') });
		const code = (await t.staff('POST', '/v1/admin/apps/connection-codes')).json.code;
		const broken = await p.connectRequest(code, { manifest: { ...serviceManifest(), elements: 'nope' } });
		problemOf(await connect(t, broken), 422, 'invalid_manifest');
		// loopback is not allowed without the development allowlist
		problemOf(await connect(t, await p.connectRequest(code)), 422, 'catalog_target_refused');
		const ok = await connect(t, await p.connectRequest(code, { baseUrl: 'https://grades.example.dev' }));
		expect(ok.status).toBe(200);
		expect((await t.staff('GET', `/v1/admin/apps/${ok.json.appId}`)).json.environments.production).toBe(
			'https://grades.example.dev',
		);
		const again = (await t.staff('POST', '/v1/admin/apps/connection-codes')).json.code;
		problemOf(await connect(t, await p.connectRequest(again, { baseUrl: 'https://grades2.example.dev' })), 409, 'conflict');
	});

	it('reconnects an app: a new code for the same app, the old deployment told to disconnect, the old key revoked', async () => {
		const t = await boot();
		const manifest = renamedService('loyalty');
		const first = await product(t, { manifest });
		const registered = await t.register(first);
		expect(registered.status).toBe(201);
		const appId = registered.json.appId;

		const moved = await product(t, { manifest, kid: 'product-k2' });
		const issued = await t.staff('POST', `/v1/admin/apps/${appId}/reconnect`);
		expect(issued.status).toBe(201);
		expect(issued.json).toMatchObject({ appId, reconnect: true, disconnected: false, code: expect.stringMatching(/^ssc_/) });
		const request = await moved.connectRequest(issued.json.code);
		const res = await connect(t, request);
		expect(res.status).toBe(200);
		expect((await moved.accept(res.json, request)).appId).toBe(appId);
		const detail = await t.staff('GET', `/v1/admin/apps/${appId}`);
		expect(detail.json.environments.production).toBe(moved.url);
		expect(detail.json.keys.map((/** @type {any} */ k) => [k.kid, k.status])).toEqual([
			['product-k1', 'revoked'],
			['product-k2', 'active'],
		]);
		const audit = (await t.audit(appId)).map((a) => a.action);
		expect(audit).toContain('catalog.app_reconnected');
		// a reconnect code cannot attach another product
		const other = await product(t);
		const code = (await t.staff('POST', `/v1/admin/apps/${appId}/reconnect`)).json.code;
		problemOf(await connect(t, await other.connectRequest(code)), 409, 'conflict');
		problemOf(await t.staff('POST', '/v1/admin/apps/app_unknown000000000000000000/reconnect'), 404, 'not_found');
	});
});
