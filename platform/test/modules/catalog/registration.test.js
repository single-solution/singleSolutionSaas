import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeMongoClients } from '../../../src/infra/db.js';
import { PORTAL_URL, startMongo } from '../../helpers.js';
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

/** @param {Parameters<typeof bootPortal>[0] extends infer O ? Partial<O> : never} [options] */
const boot = (options = {}) => bootPortal({ db: mongo.db(`cat_reg_${options.clock ? 'b' : 'a'}`), ...options });

/**
 * @param {Awaited<ReturnType<typeof boot>>} t
 * @param {any} [manifest]
 */
const product = async (t, manifest = serviceManifest()) => {
	const p = await startFakeProduct({ manifest, portalUrl: PORTAL_URL, fetchJwks: t.jwks, now: t.clock.now });
	products.push(p);
	return p;
};

/** @param {any} p */
const body = (p) => ({ baseUrl: p.url, token: p.token });

describe('registration handshake (Portal side)', () => {
	it('registers a service product end to end and authenticates it afterwards', async () => {
		const t = await boot();
		const p = await product(t);
		const res = await t.staff('POST', '/v1/admin/apps/register', { body: { ...body(p), stagingBaseUrl: p.url } });
		expect(res.status).toBe(201);
		const app = res.json;
		expect(app).toMatchObject({
			slug: 'coupons',
			kind: 'service',
			status: 'pending',
			currentVersion: 1,
			pendingVersion: null,
			kid: 'product-k1',
			environments: { production: p.url, staging: p.url },
			endpoints: { base: 'https://coupons.example.dev' },
			health: { stale: true, lastHeartbeatAt: null },
		});
		expect(app.appId).toMatch(/^app_[0-9a-z]{26}$/);
		// the product learned its appId and the Portal key that signed the request
		expect(p.registrations).toEqual([
			expect.objectContaining({ appId: app.appId, portalUrl: PORTAL_URL, portalKid: 'portal-2026-10' }),
		]);

		const detail = await t.staff('GET', `/v1/admin/apps/${app.appId}`);
		expect(detail.json.keys).toEqual([
			expect.objectContaining({ kid: 'product-k1', status: 'active', source: 'registration', usable: true, notAfter: null }),
		]);
		const version = await t.staff('GET', `/v1/admin/apps/${app.appId}/versions/1`);
		expect(version.json).toMatchObject({
			status: 'accepted',
			source: 'registration',
			breaking: false,
			manifest: serviceManifest(),
		});

		// client assertions now verify against the registered key (appKeys port)
		const beat = await t.call('POST', '/v1/product/heartbeat', {
			bearer: await t.assertion(p.signer, app.appId),
			body: { version: '1.4.0', status: 'ok', queues: { usagePending: 0 } },
		});
		expect(beat).toMatchObject({ status: 200, json: { ok: true } });
		expect((await t.service().getApp(app.appId)).health).toMatchObject({ stale: false, version: '1.4.0', status: 'ok' });

		const audit = await t.audit(app.appId);
		expect(audit.map((a) => a.action)).toEqual(['catalog.app_registered']);
		expect(audit[0]).toMatchObject({
			actor: { type: 'staff', id: 'stf_alice' },
			after: { kid: 'product-k1', slug: 'coupons' },
		});

		// the slug is taken now: refused before the product is contacted again
		problemOf(await t.staff('POST', '/v1/admin/apps/register', { body: body(p) }), 409, 'conflict');
	});

	it('requires platform.apps.manage and a valid body', async () => {
		const t = await boot();
		problemOf(
			await t.staff('POST', '/v1/admin/apps/register', {
				body: { baseUrl: 'https://x.example.com', token: 't'.repeat(20) },
				roles: ['support'],
			}),
			403,
		);
		const bad = problemOf(
			await t.staff('POST', '/v1/admin/apps/register', { body: { baseUrl: 'x' } }),
			422,
			'validation_failed',
		);
		expect(bad.errors.map((/** @type {any} */ e) => e.path)).toEqual(['/token']);
		problemOf(
			await t.staff('POST', '/v1/admin/apps/register', { body: { baseUrl: 'not a url', token: 't'.repeat(20) } }),
			422,
			'validation_failed',
		);
	});

	it('rejects a bad proof of possession', async () => {
		const t = await boot();
		const p = await product(t);
		p.tamper.response = (b) => ({ ...b, proof: `${b.proof.slice(0, -4)}AAAA` });
		const res = problemOf(
			await t.staff('POST', '/v1/admin/apps/register', { body: body(p) }),
			502,
			'catalog_registration_failed',
		);
		expect(res.detail).toMatch(/proof was rejected \(signature\)/);
	});

	it('rejects a proof for a key the product does not hold', async () => {
		const t = await boot();
		const p = await product(t);
		const other = await product(t);
		p.tamper.response = (b) => ({ ...b, publicJwk: other.publicJwk });
		const res = problemOf(
			await t.staff('POST', '/v1/admin/apps/register', { body: body(p) }),
			502,
			'catalog_registration_failed',
		);
		expect(res.detail).toMatch(/signature/);
	});

	it('rejects a replayed response (wrong nonce)', async () => {
		const a = await boot();
		const p = await product(a);
		/** @type {any} */
		let captured = null;
		p.tamper.response = (b) => (captured = b);
		expect((await a.staff('POST', '/v1/admin/apps/register', { body: body(p) })).status).toBe(201);
		// a second Portal (same keys) registers the same product; the product answers with the old response
		const b = await boot({ clock: a.clock });
		p.reset();
		p.tamper.response = () => captured;
		const res = problemOf(
			await b.staff('POST', '/v1/admin/apps/register', { body: body(p) }),
			502,
			'catalog_registration_failed',
		);
		expect(res.detail).toMatch(/\(replay\)/);
	});

	it('rejects a manifest swapped after signing', async () => {
		const t = await boot();
		const p = await product(t);
		p.tamper.response = (b) => ({ ...b, manifest: { ...b.manifest, trialHours: 1 } });
		const res = problemOf(
			await t.staff('POST', '/v1/admin/apps/register', { body: body(p) }),
			502,
			'catalog_registration_failed',
		);
		expect(res.detail).toMatch(/signature/);
	});

	it('rejects an invalid manifest (schema and semantics) after a valid handshake', async () => {
		const t = await boot();
		const m = serviceManifest();
		m.elements[1].dependsOn = ['missing'];
		const p = await product(t, m);
		const res = problemOf(await t.staff('POST', '/v1/admin/apps/register', { body: body(p) }), 422, 'invalid_manifest');
		expect(res.errors.length).toBeGreaterThan(0);
		expect(res.errors[0].path).toMatch(/^\/manifest\/elements\/1/);

		const pack = serviceManifest();
		pack.product.kind = 'pack';
		const q = await product(t, pack);
		problemOf(await t.staff('POST', '/v1/admin/apps/register', { body: body(q) }), 422, 'invalid_manifest');
	});

	it('rejects inconsistent advertised manifests', async () => {
		const t = await boot();
		const p = await product(t);
		p.tamper.advertised = (m) => ({ ...m, endpoints: { ...m.endpoints, register: 'register' } });
		problemOf(await t.staff('POST', '/v1/admin/apps/register', { body: body(p) }), 422, 'invalid_manifest');
		p.tamper.advertised = (m) => ({ ...m, endpoints: { ...m.endpoints, base: 'not a url' } });
		problemOf(await t.staff('POST', '/v1/admin/apps/register', { body: body(p) }), 422, 'invalid_manifest');
		p.tamper.advertised = () => [1, 2];
		problemOf(await t.staff('POST', '/v1/admin/apps/register', { body: body(p) }), 422, 'invalid_manifest');
		// the product signs a manifest with another base than it advertised
		p.tamper.advertised = (m) => ({ ...m, endpoints: { ...m.endpoints, base: 'https://other.example.dev' } });
		const res = problemOf(
			await t.staff('POST', '/v1/admin/apps/register', { body: body(p) }),
			502,
			'catalog_registration_failed',
		);
		expect(res.detail).toMatch(/refused the registration \(401\)|advertised/);
	});

	it('surfaces product refusals and wrong tokens', async () => {
		const t = await boot();
		const p = await product(t);
		problemOf(
			await t.staff('POST', '/v1/admin/apps/register', { body: { baseUrl: p.url, token: 'wrong-token-0123456789' } }),
			502,
			'catalog_registration_failed',
		);
		p.tamper.registerStatus = 500;
		const res = problemOf(
			await t.staff('POST', '/v1/admin/apps/register', { body: body(p) }),
			502,
			'catalog_registration_failed',
		);
		expect(res.detail).toMatch(/\(500\)/);
	});

	describe('SSRF protection', () => {
		it('refuses 127.0.0.1 without the dev allowlist', async () => {
			const t = await boot({ allowlist: [] });
			const p = await product(t);
			const res = problemOf(
				await t.staff('POST', '/v1/admin/apps/register', { body: body(p) }),
				422,
				'catalog_target_refused',
			);
			expect(res.detail).toMatch(/https/);
			problemOf(
				await t.staff('POST', '/v1/admin/apps/register', {
					body: { baseUrl: p.url.replace('http:', 'https:'), token: p.token },
				}),
				422,
				'catalog_target_refused',
			);
		});

		it('refuses cloud metadata, private ranges and names resolving to them', async () => {
			const t = await boot({
				allowlist: [],
				resolveHost: async (/** @type {string} */ host) =>
					host === 'internal.example.com' ? [{ address: '10.0.0.12', family: 4 }] : [{ address: '172.20.0.1', family: 4 }],
			});
			for (const baseUrl of [
				'https://169.254.169.254',
				'https://10.20.30.40',
				'https://[::ffff:192.168.0.1]',
				'https://localhost',
			]) {
				problemOf(
					await t.staff('POST', '/v1/admin/apps/register', { body: { baseUrl, token: 't'.repeat(20) } }),
					422,
					'catalog_target_refused',
				);
			}
			const res = problemOf(
				await t.staff('POST', '/v1/admin/apps/register', {
					body: { baseUrl: 'https://internal.example.com', token: 't'.repeat(20) },
				}),
				422,
				'catalog_target_refused',
			);
			expect(res.detail).toMatch(/10\.0\.0\.0\/8/);
			problemOf(
				await t.staff('POST', '/v1/admin/apps/register', {
					body: { baseUrl: 'https://intranet.example.com', token: 't'.repeat(20) },
				}),
				422,
				'catalog_target_refused',
			);
		});

		it('refuses a redirect to another host', async () => {
			const t = await boot();
			const p = await product(t);
			p.tamper.redirectManifest = {
				status: 302,
				location: `${p.url.replace('127.0.0.1', 'localhost')}/.well-known/ss-app.json`,
			};
			const res = problemOf(
				await t.staff('POST', '/v1/admin/apps/register', { body: body(p) }),
				422,
				'catalog_target_refused',
			);
			expect(res.detail).toMatch(/another host/);
		});

		it('refuses an oversized manifest response', async () => {
			const t = await boot();
			const p = await product(t);
			p.tamper.manifestBytes = 300 * 1024;
			const res = problemOf(await t.staff('POST', '/v1/admin/apps/register', { body: body(p) }), 502, 'upstream_error');
			expect(res.detail).toMatch(/too large/);
		});

		it('maps unreachable products, timeouts and error statuses', async () => {
			const timeouts = await boot({
				fetch: async () => {
					throw Object.assign(new Error('slow'), { name: 'PlatformError', code: 'timeout' });
				},
			});
			problemOf(
				await timeouts.staff('POST', '/v1/admin/apps/register', {
					body: { baseUrl: 'https://x.example.com', token: 't'.repeat(20) },
				}),
				504,
				'timeout',
			);
			const broken = await boot({
				fetch: async () => {
					throw new Error('bug');
				},
			});
			problemOf(
				await broken.staff('POST', '/v1/admin/apps/register', {
					body: { baseUrl: 'https://x.example.com', token: 't'.repeat(20) },
				}),
				500,
			);
			const missing = await boot({ fetch: async () => ({ status: 404, headers: {}, text: '', url: '' }) });
			problemOf(
				await missing.staff('POST', '/v1/admin/apps/register', {
					body: { baseUrl: 'https://x.example.com', token: 't'.repeat(20) },
				}),
				502,
				'upstream_error',
			);
		});
	});

	it('requires the advertised base to be the registered base outside the allowlist', async () => {
		// production-like: https target, no allowlist; HTTP goes to a fake client that serves the product
		const m = serviceManifest();
		const t0 = await boot();
		const p = await product(t0, m);
		/** @type {any} */
		const viaProduct = async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
			const target = url.replace(/^https:\/\/[^/]+/, p.url);
			const res = await fetch(target, { method: init.method ?? 'GET', headers: init.headers, body: init.body });
			return { status: res.status, headers: {}, text: await res.text(), url };
		};
		const t = await boot({ allowlist: [], fetch: viaProduct, clock: t0.clock });
		const mismatch = problemOf(
			await t.staff('POST', '/v1/admin/apps/register', { body: { baseUrl: 'https://coupons2.example.dev', token: p.token } }),
			502,
			'catalog_registration_failed',
		);
		expect(mismatch.detail).toMatch(/advertises endpoints\.base/);
		const ok = await t.staff('POST', '/v1/admin/apps/register', {
			body: { baseUrl: 'https://coupons.example.dev/', token: p.token },
		});
		expect(ok.status).toBe(201);
		expect(ok.json.environments.production).toBe('https://coupons.example.dev');
	});
});
