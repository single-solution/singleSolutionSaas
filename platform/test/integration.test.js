import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createJwks, createKeyResolver, generateSigningKey, issueWebsiteKey, signAssertion } from '@ss/protocol';
import { defineCollection } from '../src/infra/db.js';
import { created, defineRoute, ok } from '../src/infra/http.js';
import { defineModule } from '../src/infra/modules.js';
import { COLLECTIONS } from '../src/infra/schema.js';
import { systemModule } from '../src/modules/system/index.js';
import { createPortal } from '../src/portal.js';
import { createBackground } from '../src/infra/background.js';
import { afterResponse } from '../src/infra/request-scope.js';
import { toNextRoute } from '../src/infra/http.js';
import { getPortal, resetPortal } from '../src/runtime.js';
import { closeMongoClients } from '../src/infra/db.js';
import { createSystemStore } from '../src/infra/system.js';
import {
	MERCHANT,
	MERCHANT_2,
	PORTAL_URL,
	WEBSITE,
	createClock,
	createTestLogger,
	startMongo,
	testConfig,
	testEnv,
} from './helpers.js';

/** @type {Awaited<ReturnType<typeof startMongo>>} */
let mongo;
beforeAll(async () => {
	mongo = await startMongo();
}, 120_000);
afterAll(async () => {
	resetPortal();
	await closeMongoClients();
	await mongo?.stop();
});

const ORIGIN = PORTAL_URL;
const SAME_ORIGIN = { origin: ORIGIN, 'sec-fetch-site': 'same-origin' };

/** A module exercising the extension points the real modules will use. */
const probeModule = ({ revoked = new Set(), appJwks = /** @type {any} */ (null), withWebsitePort = true } = {}) =>
	defineModule({
		name: 'probe',
		collections: [defineCollection({ module: 'probe', name: 'probe_items', tenant: 'merchant' })],
		problems: { probe_failed: { status: 422, title: 'Probe failed' } },
		service: (ctx) => {
			const items = ctx.collection('probe_items');
			return {
				/** @param {string} merchantId @param {string} name */
				add: async (merchantId, name) => items.forMerchant(merchantId).insertOne({ name }),
				/** @param {string} merchantId */
				count: (merchantId) => items.forMerchant(merchantId).countDocuments({ merchantId }),
			};
		},
		ports: () => ({
			appKeys: (/** @type {string} */ appId) =>
				appJwks && appId === 'app_probe' ? createKeyResolver({ jwks: appJwks }) : null,
			...(withWebsitePort
				? {
						websiteKeyRevoked: (/** @type {any} */ claims, /** @type {string} */ rawKey) =>
							revoked.has(claims.keyId) || !rawKey.startsWith(`${claims.kind}_`),
					}
				: {}),
		}),
		jobs: (ctx) => ({
			'probe.add': async (payload) => void (await ctx.service('probe').add(payload.merchantId, payload.name)),
		}),
		routes: (ctx) => [
			defineRoute({
				method: 'POST',
				path: '/v1/probe/merchants/:merchantId/items',
				auth: ['staff', 'merchant'],
				permission: 'config.write',
				rateLimit: { limit: 5, windowMs: 60_000 },
				handler: async (c) => {
					const svc = ctx.service('probe');
					await svc.add(c.params.merchantId, String(/** @type {any} */ (c.body)?.name));
					return created({ count: await svc.count(c.params.merchantId) });
				},
			}),
			defineRoute({ method: 'GET', path: '/v1/probe/fail', auth: 'public', handler: () => ({ code: 'x' }) }),
			defineRoute({
				method: 'GET',
				path: '/v1/probe/foreign',
				auth: 'public',
				handler: () => {
					ctx.collection(COLLECTIONS.sessions);
					return ok({});
				},
			}),
		],
	});

/**
 * @param {{ dbName: string, modules?: any[], clock?: ReturnType<typeof createClock>, db?: any, background?: any, system?: any }} options
 */
const boot = async ({ dbName, modules, clock = createClock(), db, background, system }) => {
	const config = await testConfig();
	const { logger, entries } = createTestLogger();
	const portal = createPortal({
		config,
		db: db ?? mongo.db(dbName),
		modules: modules ?? [systemModule, probeModule()],
		logger,
		now: clock.now,
		...(background ? { background } : {}),
		...(system ? { system } : {}),
	});
	/**
	 * @param {string} method
	 * @param {string} path
	 * @param {{ headers?: Record<string, string>, body?: unknown }} [init]
	 */
	const call = async (method, path, { headers = {}, body } = {}) => {
		const response = await portal.handle(
			new Request(`${ORIGIN}${path}`, {
				method,
				headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
		const text = await response.text();
		return { status: response.status, headers: response.headers, json: text ? JSON.parse(text) : null };
	};
	return { portal, config, call, clock, entries };
};

/**
 * @param {any} portal
 * @param {import('../src/infra/auth.js').SessionInput} input
 */
const login = async (portal, input) => {
	const { token } = await portal.shared.sessions.create(input);
	return { cookie: `${portal.shared.cookies.name(input.kind)}=${token}`, token };
};

describe('Portal end to end', () => {
	it('boots, ensures indexes, migrates and serves public info, JWKS and health', async () => {
		const { portal, call } = await boot({ dbName: 'it_boot', db: mongo.db('it_boot', { fresh: true }) });
		const indexes = await portal.ensureIndexes();
		expect(indexes.created).toEqual(
			expect.arrayContaining(['probe_items.tenant', `${COLLECTIONS.audit}.merchantId_1_at_-1__id_-1`]),
		);
		expect((await portal.migrate({ dryRun: true })).pending.map((p) => p.id)).toEqual(['202610010000-system-notice-default']);
		expect((await portal.migrate()).applied).toEqual(['202610010000-system-notice-default']);
		expect((await portal.migrate()).applied).toEqual([]);

		const info = await call('GET', '/api/v1/system/info');
		expect(info.status).toBe(200);
		expect(info.json).toMatchObject({
			portalUrl: PORTAL_URL,
			jwksUrl: `${PORTAL_URL}/.well-known/jwks.json`,
			modules: ['probe', 'system'],
			notice: null,
		});
		expect(info.headers.get('cache-control')).toBe('public, max-age=30');
		expect(info.headers.get('ratelimit-limit')).toBe('120');
		expect((await call('GET', '/v1/system/info')).status).toBe(200);

		const jwks = await portal.jwks().json();
		// Portal keys and the dedicated website-key signing key, distinct kids
		expect(jwks.keys.map((/** @type {any} */ k) => k.kid)).toEqual(['portal-2026-10', 'portal-2026-04', 'website-2026-10']);
		expect(JSON.stringify(jwks)).not.toContain('"d"');
		expect((await call('GET', '/v1/probe/fail')).status).toBe(200);
		expect((await call('GET', '/v1/probe/foreign')).status).toBe(500); // modules cannot reach other modules' collections
	});

	it('staff sessions: MFA, RBAC, CSRF, audit', async () => {
		const { portal, call } = await boot({ dbName: 'it_staff' });
		const admin = await login(portal, { kind: 'staff', subject: 'stf_admin', roles: ['admin'], mfa: true });
		const support = await login(portal, { kind: 'staff', subject: 'stf_support', roles: ['support'], mfa: true });
		const halfway = await login(portal, { kind: 'staff', subject: 'stf_new', roles: ['admin'], mfa: false });

		const who = await call('GET', '/v1/system/whoami', { headers: { cookie: admin.cookie } });
		expect(who.json).toMatchObject({
			authMode: 'staff',
			actor: { type: 'staff', id: 'stf_admin', roles: ['admin'] },
			session: { kind: 'staff', mfa: true },
		});
		expect((await call('GET', '/v1/system/whoami', { headers: { cookie: halfway.cookie } })).status).toBe(403);
		expect(
			(
				await call('GET', '/v1/system/whoami', {
					headers: { cookie: `${portal.shared.cookies.name('staff')}=${'x'.repeat(43)}` },
				})
			).status,
		).toBe(401);
		expect((await call('GET', '/v1/system/whoami')).status).toBe(401);

		const body = { notice: { text: 'Maintenance tonight', level: 'warning' } };
		expect((await call('PUT', '/v1/system/notice', { headers: { cookie: admin.cookie }, body })).status).toBe(403); // no Origin → CSRF
		expect(
			(await call('PUT', '/v1/system/notice', { headers: { cookie: admin.cookie, origin: 'https://evil.test' }, body }))
				.status,
		).toBe(403);
		expect((await call('PUT', '/v1/system/notice', { headers: { cookie: support.cookie, ...SAME_ORIGIN }, body })).status).toBe(
			403,
		); // RBAC
		const invalid = await call('PUT', '/v1/system/notice', {
			headers: { cookie: admin.cookie, ...SAME_ORIGIN },
			body: { notice: { text: '' } },
		});
		expect(invalid.status).toBe(422);
		const saved = await call('PUT', '/v1/system/notice', {
			headers: { cookie: admin.cookie, ...SAME_ORIGIN, 'x-request-id': 'req-notice' },
			body,
		});
		expect(saved.status).toBe(200);
		expect((await call('GET', '/v1/system/info')).json.notice).toEqual(body.notice);

		const entries = await portal.shared.audit.list({ targetId: 'notice' });
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			action: 'system.notice_set',
			actor: { type: 'staff', id: 'stf_admin', via: null },
			before: null,
			after: body.notice,
			requestId: 'req-notice',
			merchantId: null,
		});
	});

	it('merchant sessions are confined to their merchant; idempotency and rate limits use the shared stores', async () => {
		const { portal, call } = await boot({ dbName: 'it_merchant' });
		const owner = await login(portal, { kind: 'merchant', subject: 'usr_owner', merchantId: MERCHANT, roles: ['owner'] });
		const editor = await login(portal, {
			kind: 'merchant',
			subject: 'usr_editor',
			merchantId: MERCHANT,
			roles: [],
			grants: [{ websiteId: WEBSITE, roles: ['editor'] }],
		});
		const path = `/v1/probe/merchants/${MERCHANT}/items`;
		const headers = { cookie: owner.cookie, ...SAME_ORIGIN };

		expect((await call('POST', path, { headers, body: { name: 'a' } })).status).toBe(428);
		const first = await call('POST', path, { headers: { ...headers, 'idempotency-key': 'item-1' }, body: { name: 'a' } });
		expect([first.status, first.json]).toEqual([201, { count: 1 }]);
		const replay = await call('POST', path, { headers: { ...headers, 'idempotency-key': 'item-1' }, body: { name: 'a' } });
		expect([replay.status, replay.json, replay.headers.get('idempotent-replayed')]).toEqual([201, { count: 1 }, 'true']);
		expect(
			(await call('POST', path, { headers: { ...headers, 'idempotency-key': 'item-1' }, body: { name: 'b' } })).status,
		).toBe(409);
		expect(
			(await call('POST', path, { headers: { ...headers, 'idempotency-key': 'item-2' }, body: { name: 'b' } })).json,
		).toEqual({ count: 2 });
		expect(
			(await call('POST', path, { headers: { ...headers, 'idempotency-key': 'item-3' }, body: { name: 'c' } })).status,
		).toBe(429); // limit 5: every authorised attempt counts (428, replay and 409 included)

		expect(
			(
				await call('POST', `/v1/probe/merchants/${MERCHANT_2}/items`, {
					headers: { ...headers, 'idempotency-key': 'x' },
					body: { name: 'z' },
				})
			).status,
		).toBe(403);
		expect(
			(
				await call('POST', path, {
					headers: { cookie: editor.cookie, ...SAME_ORIGIN, 'idempotency-key': 'e1' },
					body: { name: 'e' },
				})
			).status,
		).toBe(403);
		expect(await /** @type {any} */ (portal.modules.service('probe')).count(MERCHANT_2)).toBe(0);
		const who = await call('GET', '/v1/system/whoami', { headers: { cookie: editor.cookie } });
		expect(who.json.actor).toEqual({
			type: 'merchant_user',
			id: 'usr_editor',
			roles: [],
			grants: [{ websiteId: WEBSITE, roles: ['editor'] }],
			merchantId: MERCHANT,
		});
	});

	it('product client assertions: app keys port, audience and replay protection', async () => {
		const { privateJwk, publicJwk } = await generateSigningKey({ kid: 'probe-1' });
		const { call, clock } = await boot({
			dbName: 'it_product',
			modules: [systemModule, probeModule({ appJwks: createJwks([publicJwk]) })],
		});
		const { createSigner } = await import('@ss/protocol');
		const signer = createSigner(privateJwk);
		const assertion = await signAssertion({ signer, appId: 'app_probe', audience: PORTAL_URL, now: clock.now });
		const who = await call('GET', '/v1/system/whoami', { headers: { authorization: `Bearer ${assertion}` } });
		expect(who.json).toEqual({ authMode: 'product', actor: { type: 'product', id: 'app_probe' } });
		expect((await call('GET', '/v1/system/whoami', { headers: { authorization: `Bearer ${assertion}` } })).status).toBe(401); // replay
		const wrongAudience = await signAssertion({ signer, appId: 'app_probe', audience: 'https://other.test', now: clock.now });
		expect((await call('GET', '/v1/system/whoami', { headers: { authorization: `Bearer ${wrongAudience}` } })).status).toBe(
			401,
		);
		const unknownApp = await signAssertion({ signer, appId: 'app_other', audience: PORTAL_URL, now: clock.now });
		expect((await call('GET', '/v1/system/whoami', { headers: { authorization: `Bearer ${unknownApp}` } })).status).toBe(401);
		expect((await call('GET', '/v1/system/whoami', { headers: { authorization: 'Bearer not-a-jwt' } })).status).toBe(401);

		const noPort = await boot({ dbName: 'it_product_noport', modules: [systemModule] });
		const fresh = await signAssertion({ signer, appId: 'app_probe', audience: PORTAL_URL, now: noPort.clock.now });
		expect((await noPort.call('GET', '/v1/system/whoami', { headers: { authorization: `Bearer ${fresh}` } })).status).toBe(401);
	});

	it('website keys: offline verification, revocation port, origin and scopes', async () => {
		const revoked = new Set();
		const { portal, call, clock } = await boot({ dbName: 'it_keys', modules: [systemModule, probeModule({ revoked })] });
		const issue = async (
			/** @type {'pk' | 'sk'} */ kind,
			keyId = `key_${kind}`,
			signer = portal.shared.keys.websiteKeySigner,
		) =>
			(
				await issueWebsiteKey({
					signer,
					kind,
					websiteId: WEBSITE,
					merchantId: MERCHANT,
					domain: 'shop.example.com',
					env: 'live',
					scopes: ['config.*'],
					keyId,
					now: clock.now,
				})
			).key;
		const sk = await issue('sk');
		const who = await call('GET', '/v1/system/whoami', { headers: { authorization: `Bearer ${sk}` } });
		expect(who.json).toEqual({
			authMode: 'websiteKey',
			actor: { type: 'website', id: 'key_sk', merchantId: MERCHANT },
			website: { websiteId: WEBSITE, kind: 'sk', env: 'live', scopes: ['config.*'] },
		});
		const pk = await issue('pk');
		expect((await call('GET', '/v1/system/whoami', { headers: { authorization: `Bearer ${pk}` } })).status).toBe(403); // no origin
		expect(
			(
				await call('GET', '/v1/system/whoami', {
					headers: { authorization: `Bearer ${pk}`, origin: 'https://evil.example.com' },
				})
			).status,
		).toBe(403);
		expect(
			(
				await call('GET', '/v1/system/whoami', {
					headers: { authorization: `Bearer ${pk}`, origin: 'https://shop.example.com' },
				})
			).status,
		).toBe(200);
		revoked.add('key_sk');
		expect((await call('GET', '/v1/system/whoami', { headers: { authorization: `Bearer ${sk}` } })).status).toBe(401);
		expect((await call('GET', '/v1/system/whoami', { headers: { authorization: `Bearer sk_live_garbage` } })).status).toBe(401);
		// a token signed with the Portal (launch/document) key is not a website key
		const portalSigned = await issue('sk', 'key_portal', portal.shared.keys.signer);
		expect((await call('GET', '/v1/system/whoami', { headers: { authorization: `Bearer ${portalSigned}` } })).status).toBe(401);

		// a key signed by someone else's key never verifies
		const { privateJwk } = await generateSigningKey({ kid: 'portal-2026-10' });
		const { createSigner } = await import('@ss/protocol');
		const forged = await issueWebsiteKey({
			signer: createSigner(privateJwk),
			kind: 'sk',
			websiteId: WEBSITE,
			merchantId: MERCHANT,
			domain: 'shop.example.com',
			env: 'live',
			scopes: [],
			keyId: 'key_f',
		});
		expect((await call('GET', '/v1/system/whoami', { headers: { authorization: `Bearer ${forged.key}` } })).status).toBe(401);

		// without a revocation port, website keys fail closed
		const closed = await boot({ dbName: 'it_keys_closed', modules: [systemModule, probeModule({ withWebsitePort: false })] });
		const res = await closed.call('GET', '/v1/system/whoami', { headers: { authorization: `Bearer ${sk}` } });
		expect([res.status, res.headers.get('retry-after')]).toEqual([503, '30']);
	});

	it('no admin operations: jobs run after the request that enqueued them, the operations routes are gone', async () => {
		const { portal, call } = await boot({ dbName: 'it_operations' });
		await portal.ensureIndexes();
		const staff = await login(portal, { kind: 'staff', subject: 'stf_1', roles: ['superadmin'], mfa: true });
		const headers = { cookie: staff.cookie, ...SAME_ORIGIN };
		expect((await call('POST', '/v1/admin/operations/drain', { headers })).status).toBe(404);
		expect((await call('GET', '/v1/admin/operations', { headers })).status).toBe(404);
	});

	it('work after responses: a job enqueued by a request runs right after it, and only that job (F.19)', async () => {
		/** @type {Array<() => Promise<unknown>>} */
		const scheduled = [];
		/** @type {string[]} */
		const called = [];
		const probe = defineModule({
			name: 'probe2',
			jobs: (ctx) => ({
				'probe2.mark': async (payload) => {
					await ctx.locks.acquire(`mark:${payload.name}`, { ttlMs: 60_000 });
				},
			}),
			ports: () => ({
				appKeys: () => null,
				productCalled: async (/** @type {string} */ appId) => void called.push(appId),
			}),
			routes: (ctx) => [
				defineRoute({
					method: 'GET',
					path: '/v1/probe2/defer',
					auth: 'public',
					handler: (c) => {
						c.defer(async () => Promise.reject(new Error('deferred failed')));
						return ok({ deferred: true });
					},
				}),
				defineRoute({
					method: 'POST',
					path: '/v1/probe2/mark',
					auth: 'public',
					idempotent: false,
					handler: async () => {
						await ctx.jobs.enqueue({ name: 'probe2.mark', payload: { name: 'now' } });
						await ctx.jobs.enqueue({ name: 'probe2.mark', payload: { name: 'later' }, runAt: Date.now() + 3_600_000 });
						return ok({});
					},
				}),
			],
		});
		const background = { mode: 'on', fallback: (/** @type {any} */ task) => void scheduled.push(task) };
		const one = await boot({ dbName: 'it_after', modules: [systemModule, probe], background });
		await one.portal.ensureIndexes();
		const jobs = one.portal.shared.jobs;
		// an unrelated job waiting in the queue is never swept by a request
		await jobs.enqueue({ name: 'probe2.mark', payload: { name: 'unrelated' } });
		expect((await one.call('GET', '/v1/probe2/defer')).status).toBe(200);
		expect(scheduled).toHaveLength(1);
		for (const task of scheduled.splice(0)) await task();
		expect(one.entries.some((e) => e.msg === 'deferred task failed')).toBe(true);
		expect(await jobs.stats()).toMatchObject({ done: 0, queued: 1 });
		expect((await one.call('POST', '/v1/probe2/mark')).status).toBe(200);
		for (const task of scheduled.splice(0)) await task();
		// the job due now ran; the future one and the unrelated one still wait
		expect(await jobs.stats()).toMatchObject({ done: 1, queued: 2 });
		// a product's request is followed by the productCalled port
		await one.call('GET', '/v1/probe2/defer', { headers: { authorization: 'Bearer nope' } });
		for (const task of scheduled.splice(0)) await task();
		expect(called).toEqual([]); // unauthenticated (public route): no product
		// Next.js adapter: the request's after() takes precedence over the fallback
		/** @type {Array<() => Promise<unknown>>} */
		const viaAfter = [];
		const route = toNextRoute((request) => one.portal.handle(request), { after: (task) => void viaAfter.push(task) });
		await route.GET(new Request(`${ORIGIN}/v1/probe2/defer`));
		expect([viaAfter.length, scheduled.length]).toEqual([1, 0]);
		// test mode runs nothing after responses
		const off = await boot({ dbName: 'it_after', modules: [systemModule, probe] });
		expect(off.portal.background.mode).toBe('off');
		await off.call('GET', '/v1/probe2/defer');
		expect(scheduled).toHaveLength(0);
	});
});

describe('background (unit)', () => {
	it('runs deferred tasks (and those they defer), follows product calls, falls back when after() throws', async () => {
		const { logger, entries } = createTestLogger();
		/** @type {Array<() => Promise<unknown>>} */
		const fallback = [];
		/** @type {string[]} */
		const calls = [];
		const bg = createBackground({
			logger,
			fallback: (task) => void fallback.push(task),
			onProductCall: async (appId) => void calls.push(appId),
		});
		/** @type {Array<() => Promise<unknown>>} */
		const deferred = [
			async () => {
				afterResponse(async () => void calls.push('nested'));
			},
			async () => Promise.reject(new Error('boom')),
		];
		bg.afterResponse({
			deferred,
			schedule: () => {
				throw new Error('outside a request');
			},
			log: logger,
			app: { appId: 'app_1' },
		});
		expect(fallback).toHaveLength(1);
		await fallback[0]?.();
		expect(calls).toEqual(['app_1', 'nested']);
		expect(entries.some((e) => e.msg === 'deferred task failed')).toBe(true);
		bg.afterResponse({ deferred: [], schedule: null, log: logger, app: null }); // nothing to do
		expect(fallback).toHaveLength(1);
		// a task that keeps deferring is cut off
		const loop = createBackground({ logger, fallback: (task) => void fallback.push(task) });
		/** @type {() => Promise<void>} */
		const again = async () => void afterResponse(again);
		loop.afterResponse({ deferred: [again], schedule: null, log: logger, app: null });
		await fallback[1]?.();
		expect(entries.some((e) => e.msg === 'deferred tasks dropped')).toBe(true);
		// the default fallback runs the work in the background of the request
		let ran = false;
		const plain = createBackground({ logger });
		plain.afterResponse({
			deferred: [
				async () => {
					ran = true;
				},
			],
			schedule: null,
			log: logger,
			app: null,
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(ran).toBe(true);
		// outside a request, afterResponse schedules nothing
		expect(afterResponse(async () => {})).toBe(false);
	});
});

describe('sessions (Mongo)', () => {
	it('create, touch, idle and absolute expiry, rotation, revocation', async () => {
		const { portal, clock, config } = await boot({ dbName: 'it_sessions', modules: [] });
		const sessions = portal.shared.sessions;
		const { token, session } = await sessions.create({
			kind: 'staff',
			subject: 'stf_1',
			roles: ['admin'],
			mfa: false,
			ip: '192.0.2.1',
			userAgent: 'x'.repeat(400),
		});
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(session.id).not.toContain(token);
		const stored = await mongo.db('it_sessions').collection(COLLECTIONS.sessions).findOne({});
		expect(JSON.stringify(stored)).not.toContain(token);
		expect(stored?.userAgent).toHaveLength(256);

		clock.advance(29 * 60_000);
		expect((await sessions.get(token))?.lastSeenAt).toEqual(new Date(clock.now())); // touched → idle window extended
		clock.advance(29 * 60_000);
		expect(await sessions.get(token)).not.toBeNull();
		clock.advance(10_000);
		expect((await sessions.get(token))?.lastSeenAt).not.toEqual(new Date(clock.now())); // throttled touch

		const rotated = await sessions.rotate(token, { mfa: true, roles: ['superadmin'] });
		expect(rotated?.session).toMatchObject({
			mfa: true,
			roles: ['superadmin'],
			createdAt: session.createdAt,
			absoluteExpiresAt: session.absoluteExpiresAt,
		});
		expect(await sessions.get(token)).toBeNull();
		expect(await sessions.rotate(token)).toBeNull();
		const live = /** @type {string} */ (rotated?.token);
		expect(await sessions.get(live)).not.toBeNull();

		clock.advance(config.sessions.staff.idleMs + 1);
		expect(await sessions.get(live)).toBeNull(); // idle expiry

		const a = await sessions.create({ kind: 'merchant', subject: 'usr_1', merchantId: MERCHANT, absoluteMs: 60_000 });
		clock.advance(61_000);
		expect(await sessions.get(a.token)).toBeNull(); // absolute expiry (shortened, e.g. impersonation)

		const s1 = await sessions.create({ kind: 'merchant', subject: 'usr_2', merchantId: MERCHANT });
		const s2 = await sessions.create({ kind: 'merchant', subject: 'usr_2', merchantId: MERCHANT });
		const s3 = await sessions.create({ kind: 'merchant', subject: 'usr_2', merchantId: MERCHANT });
		expect((await sessions.list('merchant', 'usr_2')).length).toBe(3);
		expect(await sessions.revoke(s1.token)).toBe(true);
		expect(await sessions.revoke(s1.token)).toBe(false);
		expect(await sessions.revoke('bad')).toBe(false);
		expect(await sessions.revokeAll('merchant', 'usr_2', { exceptToken: s3.token })).toBe(1);
		expect(await sessions.get(s2.token)).toBeNull();
		expect(await sessions.revokeById(s3.session.id, { kind: 'merchant', subject: 'usr_other' })).toBe(false);
		expect(await sessions.revokeById(s3.session.id, { kind: 'merchant', subject: 'usr_2' })).toBe(true);
		expect(await sessions.get(undefined)).toBeNull();
		await expect(sessions.create(/** @type {any} */ ({ kind: 'robot', subject: 'x' }))).rejects.toThrow();
		await expect(sessions.create({ kind: 'staff', subject: '' })).rejects.toThrow();
	});

	it('session actors can be resolved by a module port', async () => {
		const deactivated = new Set(['usr_gone']);
		const identity = defineModule({
			name: 'identity',
			ports: () => ({
				sessionActor: (/** @type {any} */ session) =>
					deactivated.has(session.subject)
						? null
						: { type: 'merchant_user', id: session.subject, merchantId: session.merchantId, roles: ['billing'] },
			}),
		});
		const { portal, call } = await boot({ dbName: 'it_session_port', modules: [systemModule, identity] });
		const live = await login(portal, { kind: 'merchant', subject: 'usr_live', merchantId: MERCHANT, roles: ['owner'] });
		expect((await call('GET', '/v1/system/whoami', { headers: { cookie: live.cookie } })).json.actor.roles).toEqual([
			'billing',
		]);
		const gone = await login(portal, { kind: 'merchant', subject: 'usr_gone', merchantId: MERCHANT });
		expect((await call('GET', '/v1/system/whoami', { headers: { cookie: gone.cookie } })).status).toBe(401);
		// a merchant cookie does not authenticate as staff
		const staffName = portal.shared.cookies.name('staff');
		expect((await call('GET', '/v1/system/whoami', { headers: { cookie: `${staffName}=${live.token}` } })).status).toBe(401);
		expect(portal.shared.cookies.set('merchant', live.token, 60)).toContain('__Host-ss_merchant=');
		expect(portal.shared.cookies.clear('merchant')).toContain('Max-Age=0');
	});
});

describe('login throttle (Mongo)', () => {
	it('locks accounts progressively and throttles IPs', async () => {
		const { portal, clock } = await boot({ dbName: 'it_throttle', modules: [] });
		const throttle = portal.shared.loginThrottle;
		const who = { account: 'Owner@Example.com ', ip: '192.0.2.10' };
		expect(await throttle.check(who)).toEqual({ allowed: true });
		for (let i = 0; i < 4; i += 1) expect(await throttle.recordFailure(who)).toEqual({ locked: false });
		expect(await throttle.recordFailure({ account: 'owner@example.com', ip: '192.0.2.10' })).toEqual({
			locked: true,
			retryAfterSeconds: 900,
		});
		expect(await throttle.check({ account: 'owner@example.com' })).toMatchObject({
			allowed: false,
			reason: 'account_locked',
			retryAfterSeconds: 900,
		});
		clock.advance(901_000);
		expect(await throttle.check(who)).toEqual({ allowed: true });
		for (let i = 0; i < 5; i += 1) await throttle.recordFailure({ account: who.account });
		expect(await throttle.check(who)).toMatchObject({ allowed: false, retryAfterSeconds: 1800 }); // doubled
		await throttle.recordSuccess({ account: who.account });
		expect(await throttle.check(who)).toEqual({ allowed: true });
		const stored = JSON.stringify(await mongo.db('it_throttle').collection(COLLECTIONS.loginThrottle).find({}).toArray());
		expect(stored).not.toContain('example.com');
		expect(stored).not.toContain('192.0.2.10');

		// failures spread over time do not accumulate past the window
		const slow = { account: 'slow@example.com' };
		for (let i = 0; i < 6; i += 1) {
			expect((await throttle.recordFailure(slow)).locked).toBe(false);
			clock.advance(16 * 60_000);
		}
		// IP throttling
		for (let i = 0; i < 50; i += 1) await throttle.recordFailure({ ip: '198.51.100.7' });
		expect(await throttle.check({ ip: '198.51.100.7', account: 'someone@example.com' })).toMatchObject({
			allowed: false,
			reason: 'ip_throttled',
		});
		expect(await throttle.recordFailure({})).toEqual({ locked: false });
	});
});

describe('admin settings (stored in the database, never in the environment)', () => {
	it('shows the request origin as the Portal URL and sets the mailer, audited', async () => {
		const db = mongo.db('it_settings');
		const system = createSystemStore(db);
		const { portal, call } = await boot({ dbName: 'it_settings', db, system });
		const admin = await login(portal, { kind: 'staff', subject: 'stf_admin', roles: ['admin'], mfa: true });
		const superadmin = await login(portal, { kind: 'staff', subject: 'stf_root', roles: ['superadmin'], mfa: true });
		/** @param {{ cookie: string }} who */
		const as = (who) => ({ cookie: who.cookie, ...SAME_ORIGIN });

		const read = await call('GET', '/v1/admin/system/settings', { headers: as(admin) });
		expect(read.status).toBe(200);
		expect(read.json).toMatchObject({ portalUrl: PORTAL_URL, mail: null });
		expect(JSON.stringify(read.json)).not.toMatch(/seed|keys/);

		// no stored Portal URL: the route to change it is gone
		expect((await call('PUT', '/v1/admin/system/settings/portal-url', { headers: as(superadmin), body: {} })).status).toBe(404);

		// no preview URL setting and no key rotation; the mailer (the password is sealed, never returned)
		expect((await call('PUT', '/v1/admin/system/settings/preview-url', { headers: as(admin), body: {} })).status).toBe(404);
		expect((await call('POST', '/v1/admin/system/keys/signing/rotate', { headers: as(superadmin) })).status).toBe(404);
		const mail = {
			host: 'smtp.example.com',
			port: 587,
			secure: false,
			user: 'mailer',
			password: 's3cret',
			from: 'Portal <no-reply@example.com>',
		};
		expect(
			(await call('PUT', '/v1/admin/system/settings/mail', { headers: as(admin), body: { mail: { ...mail, from: 'bad' } } }))
				.status,
		).toBe(422);
		const saved = await call('PUT', '/v1/admin/system/settings/mail', { headers: as(admin), body: { mail } });
		expect(saved.json.mail).toEqual({
			host: 'smtp.example.com',
			port: 587,
			secure: false,
			user: 'mailer',
			from: mail.from,
			hasPassword: true,
		});
		expect(JSON.stringify(saved.json)).not.toContain('s3cret');
		expect((await system.load()).state.mail?.pass).toBe('s3cret');
		expect(
			(await call('PUT', '/v1/admin/system/settings/mail', { headers: as(admin), body: { mail: null } })).json.mail,
		).toBeNull();

		const actions = (await db.collection('platform_audit').find({}).toArray()).map((a) => a.action);
		expect(actions).toEqual(expect.arrayContaining(['system.mail_set']));
	});

	it('without a settings store the settings API answers 503', async () => {
		const { portal, call } = await boot({ dbName: 'it_settings_none' });
		const admin = await login(portal, { kind: 'staff', subject: 'stf_admin', roles: ['admin'], mfa: true });
		expect((await call('GET', '/v1/admin/system/settings', { headers: { cookie: admin.cookie, ...SAME_ORIGIN } })).status).toBe(
			503,
		);
	});
});

describe('runtime', () => {
	it('builds one cached Portal: secrets generated on first start, schema prepared, the API at once', async () => {
		resetPortal();
		await expect(getPortal({ env: {} })).rejects.toThrow(/Invalid Portal configuration/);
		/** @type {string[]} */
		const lines = [];
		const runtimeDb = mongo.dbName('it_runtime');
		const env = await testEnv({ MONGODB_URI: `${mongo.uri.replace(/\/?(\?|$)/, `/${runtimeDb}$1`)}`, LOG_LEVEL: 'info' });
		const before = await getPortal({ env, write: (line) => lines.push(line) });
		expect(await getPortal()).toBe(before);
		expect(before.config.mongo.dbName).toBe(runtimeDb);
		const db = mongo.client.db(runtimeDb);
		expect(await db.collection('platform_system').countDocuments({ _id: /** @type {any} */ ('secrets') })).toBe(1);
		expect(await db.collection('platform_system').findOne({ _id: /** @type {any} */ ('schema') })).toMatchObject({
			fingerprint: expect.any(String),
		});
		// no setup step: the API answers at once, and the Portal URL is the request's origin
		const portal = before;
		const info = await portal.handle(
			new Request('http://internal/v1/system/info', {
				headers: { host: 'portal.example.test', 'x-forwarded-proto': 'https' },
			}),
		);
		expect((await info.json()).portalUrl).toBe('https://portal.example.test');
		expect((await import('node:fs')).existsSync(new URL('../app/setup/route.js', import.meta.url))).toBe(false);

		const res = await portal.handle(new Request('https://portal.example.test/v1/system/info'));
		expect(res.status).toBe(200);
		expect(lines.some((line) => JSON.parse(line).msg === 'request')).toBe(true);

		// the Next.js adapters delegate to the cached instance
		const api = await import('../app/api/[...path]/route.js');
		expect((await api.GET(new Request('https://portal.example.test/api/v1/system/info'))).status).toBe(200);
		// /.well-known/jwks.json is rewritten to the same catch-all (GET/HEAD only)
		const system = (/** @type {string} */ path, method = 'GET') =>
			api[/** @type {'GET'} */ (method)](new Request(`https://portal.example.test/api${path}`, { method }));
		expect((await (await system('/.well-known/jwks.json')).json()).keys).toHaveLength(2);
		expect((await system('/.well-known/jwks.json', 'HEAD')).status).toBe(200);
		expect((await system('/.well-known/jwks.json', 'POST')).status).toBe(404);
		resetPortal();
		await expect(getPortal({ env: {} })).rejects.toThrow(/MONGODB_URI/);
		const invalid = await system('/v1/system/info'); // config invalid
		expect(invalid.status).toBe(503);
		expect((await invalid.json()).status).toBe('misconfigured');
		resetPortal();
	}, 60_000);
});

describe('infra hardening (Mongo)', () => {
	it('ctx.verifyWebsiteKey: the authenticator logic for keys outside the header (kind, env, scopes, origin, raw key)', async () => {
		const seenKeys = /** @type {string[]} */ ([]);
		const watcher = defineModule({
			name: 'watcher',
			ports: () => ({
				websiteKeyRevoked: (/** @type {any} */ claims, /** @type {string} */ rawKey) => {
					seenKeys.push(rawKey);
					return claims.keyId === 'key_revoked';
				},
			}),
		});
		const { portal, clock } = await boot({ dbName: 'it_verify', modules: [systemModule, watcher] });
		const verify = portal.modules.context('watcher').verifyWebsiteKey;
		const issue = async (/** @type {'pk' | 'sk'} */ kind, /** @type {Record<string, any>} */ over = {}) =>
			(
				await issueWebsiteKey({
					signer: portal.shared.keys.websiteKeySigner,
					kind,
					websiteId: WEBSITE,
					merchantId: MERCHANT,
					domain: 'shop.example.com',
					env: 'live',
					scopes: ['events.write'],
					keyId: `key_${kind}`,
					now: clock.now,
					...over,
				})
			).key;
		const sk = await issue('sk');
		const pk = await issue('pk');
		const codeOf = async (/** @type {any} */ check) =>
			verify(check).then(
				() => 'ok',
				(/** @type {any} */ e) => e.code,
			);
		expect((await verify({ key: sk, scopes: ['events.write'], keyKind: 'sk', env: 'live' })).keyId).toBe('key_sk');
		expect(seenKeys).toEqual([sk]);
		expect(await codeOf({ key: sk, keyKind: 'pk' })).toBe('forbidden');
		expect(await codeOf({ key: sk, env: 'test' })).toBe('forbidden');
		expect(await codeOf({ key: sk, scopes: ['config.write'] })).toBe('scope_missing');
		expect(await codeOf({ key: pk })).toBe('origin_not_allowed');
		expect(await codeOf({ key: pk, origin: 'https://shop.example.com' })).toBe('ok');
		expect(await codeOf({ key: pk, referer: 'https://shop.example.com/cart' })).toBe('ok');
		expect(await codeOf({ key: await issue('sk', { keyId: 'key_revoked' }) })).toBe('invalid_credentials');
		expect(await codeOf({ key: 'not-a-key' })).toBe('invalid_credentials');
		expect(await codeOf({ key: await issue('sk', { signer: portal.shared.keys.signer }) })).toBe('invalid_credentials');
		const unavailable = await boot({
			dbName: 'it_verify_none',
			modules: [systemModule, probeModule({ withWebsitePort: false })],
		});
		expect(
			await unavailable.portal.modules
				.context('probe')
				.verifyWebsiteKey({ key: sk })
				.catch((/** @type {any} */ e) => e.code),
		).toBe('unavailable');
	});

	it('hash-chains audit entries and verifies them per scope', async () => {
		const { portal, call } = await boot({ dbName: 'it_audit_chain' });
		await portal.ensureIndexes();
		const audit = portal.shared.audit;
		const actor = /** @type {const} */ ({ type: 'staff', id: 'stf_1' });
		await audit.record({ actor, action: 'staff.created', target: { type: 'staff', id: 'stf_2' } });
		await audit.record({ actor, action: 'credits.adjusted', target: { type: 'merchant', id: MERCHANT, merchantId: MERCHANT } });
		await audit.record({ actor, action: 'credits.adjusted', target: { type: 'merchant', id: MERCHANT, merchantId: MERCHANT } });
		const staff = await login(portal, { kind: 'staff', subject: 'stf_9', roles: ['superadmin'], mfa: true });
		const headers = { cookie: staff.cookie, ...SAME_ORIGIN };
		const scope = encodeURIComponent(`merchant:${MERCHANT}`);
		const verified = await call('GET', `/v1/admin/audit/verification?scope=${scope}`, { headers });
		expect(verified.json).toMatchObject({ ok: true, entries: 2 });
		const raw = mongo.db('it_audit_chain').collection(COLLECTIONS.audit);
		await raw.updateOne({ merchantId: MERCHANT, seq: 1 }, { $set: { action: 'credits.refunded' } });
		expect((await call('GET', `/v1/admin/audit/verification?scope=${scope}`, { headers })).json).toMatchObject({
			ok: false,
			broken: { seq: 1, reason: 'hash' },
		});
	});

	it("idempotent 'no-store' routes keep only the status in the shared store", async () => {
		let runs = 0;
		const secrets = defineModule({
			name: 'secrets',
			routes: () => [
				defineRoute({
					method: 'POST',
					path: '/v1/secrets',
					auth: 'public',
					idempotent: 'no-store',
					handler: () => created({ secret: `sk_secret_${(runs += 1)}` }),
				}),
			],
		});
		const { call } = await boot({ dbName: 'it_no_store', modules: [secrets] });
		const headers = { 'idempotency-key': 'once' };
		const first = await call('POST', '/v1/secrets', { headers, body: { password: 'hunter2-long' } });
		expect(first.json.secret).toBe('sk_secret_1');
		const replay = await call('POST', '/v1/secrets', { headers, body: { password: 'hunter2-long' } });
		expect([replay.status, replay.json.type]).toEqual([409, `${PORTAL_URL}/problems/idempotency_replay_no_body`]);
		expect(runs).toBe(1);
		const stored = JSON.stringify(await mongo.db('it_no_store').collection(COLLECTIONS.idempotency).find({}).toArray());
		expect(stored).not.toContain('sk_secret');
		expect(stored).not.toContain('hunter2');
	});

	it('offers transactions, the platform mailer and platform.config.write; reserves infra names', async () => {
		const { portal } = await boot({ dbName: 'it_shared' });
		await portal.ensureIndexes();
		const ctx = portal.modules.context('probe');
		expect(ctx.mailer.available).toBe(true); // logging mailer in the test environment
		const items = ctx.collection('probe_items').forMerchant(MERCHANT);
		await expect(
			ctx.withTransaction(async (session) => {
				await items.insertOne({ name: 'rolled back' }, { session });
				throw new Error('abort');
			}),
		).rejects.toThrow('abort');
		expect(await items.countDocuments({ merchantId: MERCHANT })).toBe(0);
		await ctx.withTransaction(async (session) => items.insertOne({ name: 'kept' }, { session }));
		expect(await items.countDocuments({ merchantId: MERCHANT })).toBe(1);

		const { can } = portal.shared.rbac;
		expect(can({ type: 'staff', id: 's', roles: ['admin'] }, 'platform.config.write')).toBe(true);
		expect(can({ type: 'staff', id: 's', roles: ['superadmin'] }, 'platform.config.write')).toBe(true);
		expect(can({ type: 'staff', id: 's', roles: ['support'] }, 'platform.config.write')).toBe(false);
		expect(can({ type: 'merchant_user', id: 'u', merchantId: MERCHANT, roles: ['owner'] }, 'platform.config.write')).toBe(
			false,
		);

		const config = await testConfig();
		const { logger } = createTestLogger();
		const build = (/** @type {any} */ definition) =>
			createPortal({ config, db: mongo.db('it_reserved'), modules: [defineModule({ name: 'clash', ...definition })], logger });
		// periodic module work no longer exists (F.19)
		expect(() => build({ background: () => ({}) })).not.toThrow();
		expect(() => build({ problems: { idempotency_replay_no_body: { status: 409, title: 'x' } } })).toThrow(/reserved/);
	});
});
