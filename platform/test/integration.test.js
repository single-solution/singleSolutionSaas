import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createJwks, createKeyResolver, generateSigningKey, signAssertion } from '@ss/protocol';
import { defineCollection } from '../src/infra/db.js';
import { created, defineRoute, ok, problem } from '../src/infra/http.js';
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
	ENCRYPTION_KEY,
	MERCHANT,
	MERCHANT_2,
	PORTAL_URL,
	createClock,
	createTestLogger,
	startMongo,
	testConfig,
	testEnv,
	testSessionActor,
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
const probeModule = ({ productJwks = /** @type {any} */ (null) } = {}) =>
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
			sessionActor: testSessionActor,
			productKeys: (/** @type {string} */ productId) =>
				productJwks && productId === 'probe' ? createKeyResolver({ jwks: productJwks }) : null,
		}),
		routes: (ctx) => [
			defineRoute({
				method: 'POST',
				path: '/v1/probe/merchants/:merchantId/items',
				auth: ['admin', 'merchant'],
				permission: 'tokens.manage',
				idempotent: true,
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
				path: '/v1/probe/info',
				auth: 'public',
				rateLimit: { limit: 120, windowMs: 60_000 },
				handler: () => ok({ portalUrl: ctx.config.portalUrl }, { headers: { 'cache-control': 'public, max-age=30' } }),
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/probe/whoami',
				auth: ['admin', 'merchant', 'product'],
				handler: (c) =>
					ok({
						authMode: c.authMode,
						actor: c.actor,
						...(c.session ? { session: { kind: c.session.kind, mfa: c.session.mfa } } : {}),
						...(c.product ? { product: c.product } : {}),
					}),
			}),
			defineRoute({
				method: 'PUT',
				path: '/v1/probe/setting',
				auth: 'admin',
				permission: 'portal_settings.write',
				handler: async (c) => {
					const text = /** @type {any} */ (c.body)?.text;
					if (typeof text !== 'string' || text === '') return problem('validation_failed', 'text is required');
					await ctx.audit.record({
						actor: /** @type {any} */ (c.actor),
						action: 'probe.setting_set',
						target: { type: 'setting', id: 'probe' },
						after: { text },
						requestId: c.requestId,
						ip: c.ip,
					});
					return ok({ text });
				},
			}),
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
	it('boots, ensures indexes and serves public routes and the JWKS', async () => {
		const { portal, call } = await boot({ dbName: 'it_boot', db: mongo.db('it_boot', { fresh: true }) });
		const indexes = await portal.ensureIndexes();
		expect(indexes.created).toEqual(
			expect.arrayContaining(['probe_items.tenant', `${COLLECTIONS.audit}.merchantId_1_at_-1__id_-1`]),
		);

		const info = await call('GET', '/api/v1/probe/info');
		expect(info.status).toBe(200);
		expect(info.json).toEqual({ portalUrl: PORTAL_URL });
		expect(info.headers.get('cache-control')).toBe('public, max-age=30');
		expect(info.headers.get('ratelimit-limit')).toBe('120');
		expect((await call('GET', '/v1/probe/info')).status).toBe(200);

		const jwks = await portal.jwks().json();
		// Portal keys and the dedicated token signing key, distinct kids
		expect(jwks.keys.map((/** @type {any} */ k) => k.kid)).toEqual(['portal-2026-10', 'portal-2026-04', 'token-2026-10']);
		expect(JSON.stringify(jwks)).not.toContain('"d"');
		expect((await call('GET', '/v1/probe/fail')).status).toBe(200);
		expect((await call('GET', '/v1/probe/foreign')).status).toBe(500); // modules cannot reach other modules' collections
	});

	it('admin sessions: Require two-step, RBAC, CSRF against PORTAL_URL, audit', async () => {
		const { portal, call } = await boot({ dbName: 'it_staff' });
		const admin = await login(portal, { kind: 'admin', subject: 'adm_owner', mfa: true });
		const support = await login(portal, { kind: 'admin', subject: 'adm_support', mfa: true });
		const halfway = await login(portal, { kind: 'admin', subject: 'adm_owner_pending', mfa: true });

		const who = await call('GET', '/v1/probe/whoami', { headers: { cookie: admin.cookie } });
		expect(who.json).toMatchObject({
			authMode: 'admin',
			actor: { type: 'admin', id: 'adm_owner', role: 'owner' },
			session: { kind: 'admin', mfa: true },
		});
		// Require two-step for admins: only the setup routes open (`mfa: false`)
		const pending = await call('GET', '/v1/probe/whoami', { headers: { cookie: halfway.cookie } });
		expect([pending.status, pending.json.type]).toEqual([403, `${PORTAL_URL}/problems/two_step_required`]);
		expect(
			(
				await call('GET', '/v1/probe/whoami', {
					headers: { cookie: `${portal.shared.cookies.name('admin')}=${'x'.repeat(43)}` },
				})
			).status,
		).toBe(401);
		expect((await call('GET', '/v1/probe/whoami')).status).toBe(401);

		const body = { text: 'Maintenance tonight' };
		expect((await call('PUT', '/v1/probe/setting', { headers: { cookie: admin.cookie }, body })).status).toBe(403); // no Origin → CSRF
		expect(
			(await call('PUT', '/v1/probe/setting', { headers: { cookie: admin.cookie, origin: 'https://evil.test' }, body }))
				.status,
		).toBe(403);
		expect((await call('PUT', '/v1/probe/setting', { headers: { cookie: support.cookie, ...SAME_ORIGIN }, body })).status).toBe(
			403,
		); // RBAC
		const invalid = await call('PUT', '/v1/probe/setting', {
			headers: { cookie: admin.cookie, ...SAME_ORIGIN },
			body: { text: '' },
		});
		expect(invalid.status).toBe(422);
		const saved = await call('PUT', '/v1/probe/setting', {
			headers: { cookie: admin.cookie, ...SAME_ORIGIN, 'x-request-id': 'req-setting' },
			body,
		});
		expect(saved.status).toBe(200);

		const entries = await portal.shared.audit.list({ targetId: 'probe' });
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			action: 'probe.setting_set',
			actor: { type: 'admin', id: 'adm_owner', name: 'Admin adm_owner' },
			after: body,
			requestId: 'req-setting',
			merchantId: null,
		});
	});

	it('merchant sessions are confined to their merchant; idempotency and rate limits use the shared stores', async () => {
		const { portal, call } = await boot({ dbName: 'it_merchant' });
		const owner = await login(portal, { kind: 'merchant', subject: MERCHANT });
		const finance = await login(portal, { kind: 'admin', subject: 'adm_finance' });
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
		// Finance never sees tokens (PLAN 0.2)
		expect(
			(
				await call('POST', path, {
					headers: { cookie: finance.cookie, ...SAME_ORIGIN, 'idempotency-key': 'e1' },
					body: { name: 'e' },
				})
			).status,
		).toBe(403);
		expect(await /** @type {any} */ (portal.modules.service('probe')).count(MERCHANT_2)).toBe(0);
		const who = await call('GET', '/v1/probe/whoami', { headers: { cookie: owner.cookie } });
		expect(who.json.actor).toEqual({ type: 'merchant', id: MERCHANT, merchantId: MERCHANT });
	});

	it('product client assertions: product keys port, audience and replay protection', async () => {
		const { privateJwk, publicJwk } = await generateSigningKey({ kid: 'probe-1' });
		const { call, clock } = await boot({
			dbName: 'it_product',
			modules: [systemModule, probeModule({ productJwks: createJwks([publicJwk]) })],
		});
		const { createSigner } = await import('@ss/protocol');
		const signer = createSigner(privateJwk);
		const assertion = await signAssertion({ signer, productId: 'probe', audience: PORTAL_URL, now: clock.now });
		const who = await call('GET', '/v1/probe/whoami', { headers: { authorization: `Bearer ${assertion}` } });
		expect(who.json).toEqual({
			authMode: 'product',
			actor: { type: 'product', id: 'probe' },
			product: { productId: 'probe' },
		});
		expect((await call('GET', '/v1/probe/whoami', { headers: { authorization: `Bearer ${assertion}` } })).status).toBe(401); // replay
		const wrongAudience = await signAssertion({ signer, productId: 'probe', audience: 'https://other.test', now: clock.now });
		expect((await call('GET', '/v1/probe/whoami', { headers: { authorization: `Bearer ${wrongAudience}` } })).status).toBe(401);
		const unknown = await signAssertion({ signer, productId: 'other', audience: PORTAL_URL, now: clock.now });
		expect((await call('GET', '/v1/probe/whoami', { headers: { authorization: `Bearer ${unknown}` } })).status).toBe(401);
		expect((await call('GET', '/v1/probe/whoami', { headers: { authorization: 'Bearer not-a-jwt' } })).status).toBe(401);

		const noPort = await boot({ dbName: 'it_product_noport', modules: [systemModule, probeModule()] });
		const fresh = await signAssertion({ signer, productId: 'probe', audience: PORTAL_URL, now: noPort.clock.now });
		expect((await noPort.call('GET', '/v1/probe/whoami', { headers: { authorization: `Bearer ${fresh}` } })).status).toBe(401);
	});

	it('work after responses: deferred tasks run right after the request, and only its own (PLAN 0.10)', async () => {
		/** @type {Array<() => Promise<unknown>>} */
		const scheduled = [];
		/** @type {string[]} */
		const called = [];
		const { privateJwk, publicJwk } = await generateSigningKey({ kid: 'probe2-1' });
		const probe = defineModule({
			name: 'probe2',
			ports: () => ({
				productKeys: (/** @type {string} */ productId) =>
					productId === 'probe' ? createKeyResolver({ jwks: createJwks([publicJwk]) }) : null,
				productCalled: async (/** @type {string} */ productId) => void called.push(productId),
			}),
			routes: () => [
				defineRoute({
					method: 'GET',
					path: '/v1/probe2/defer',
					auth: 'public',
					handler: (c) => {
						c.defer(async () => Promise.reject(new Error('deferred failed')));
						return ok({ deferred: true });
					},
				}),
				defineRoute({ method: 'GET', path: '/v1/probe2/product', auth: 'product', handler: () => ok({}) }),
			],
		});
		const background = { mode: 'on', fallback: (/** @type {any} */ task) => void scheduled.push(task) };
		const one = await boot({ dbName: 'it_after', modules: [systemModule, probe], background });
		await one.portal.ensureIndexes();
		expect((await one.call('GET', '/v1/probe2/defer')).status).toBe(200);
		expect(scheduled).toHaveLength(1);
		for (const task of scheduled.splice(0)) await task();
		expect(one.entries.some((e) => e.msg === 'deferred task failed')).toBe(true);
		// a product's request is followed by the productCalled port
		await one.call('GET', '/v1/probe2/defer', { headers: { authorization: 'Bearer nope' } });
		for (const task of scheduled.splice(0)) await task();
		expect(called).toEqual([]); // unauthenticated (public route): no product
		const { createSigner } = await import('@ss/protocol');
		const assertion = await signAssertion({
			signer: createSigner(privateJwk),
			productId: 'probe',
			audience: PORTAL_URL,
			now: one.clock.now,
		});
		expect((await one.call('GET', '/v1/probe2/product', { headers: { authorization: `Bearer ${assertion}` } })).status).toBe(
			200,
		);
		for (const task of scheduled.splice(0)) await task();
		expect(called).toEqual(['probe']);
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
			onProductCall: async (productId) => void calls.push(productId),
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
			product: { productId: 'notes' },
		});
		expect(fallback).toHaveLength(1);
		await fallback[0]?.();
		expect(calls).toEqual(['notes', 'nested']);
		expect(entries.some((e) => e.msg === 'deferred task failed')).toBe(true);
		bg.afterResponse({ deferred: [], schedule: null, log: logger, product: null }); // nothing to do
		expect(fallback).toHaveLength(1);
		// a task that keeps deferring is cut off
		const loop = createBackground({ logger, fallback: (task) => void fallback.push(task) });
		/** @type {() => Promise<void>} */
		const again = async () => void afterResponse(again);
		loop.afterResponse({ deferred: [again], schedule: null, log: logger, product: null });
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
			product: null,
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(ran).toBe(true);
		// outside a request, afterResponse schedules nothing
		expect(afterResponse(async () => {})).toBe(false);
	});
});

describe('sessions (Mongo)', () => {
	it('create, touch, one lifetime from sign-in (Session length), rotation, revocation', async () => {
		const { portal, clock, config } = await boot({ dbName: 'it_sessions', modules: [] });
		const sessions = portal.shared.sessions;
		expect(config.sessions.admin).toEqual({ idleMs: 12 * 3_600_000, absoluteMs: 12 * 3_600_000 });
		const { token, session } = await sessions.create({
			kind: 'admin',
			subject: 'adm_1',
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

		const rotated = await sessions.rotate(token, { mfa: true });
		expect(rotated?.session).toMatchObject({
			mfa: true,
			createdAt: session.createdAt,
			absoluteExpiresAt: session.absoluteExpiresAt,
		});
		expect(await sessions.get(token)).toBeNull();
		expect(await sessions.rotate(token)).toBeNull();
		const live = /** @type {string} */ (rotated?.token);
		expect(await sessions.get(live)).not.toBeNull();

		clock.advance(config.sessions.admin.absoluteMs + 1);
		expect(await sessions.get(live)).toBeNull(); // the sign-in's lifetime ended

		const a = await sessions.create({ kind: 'merchant', subject: MERCHANT });
		expect((await sessions.get(a.token))?.merchantId).toBe(MERCHANT);
		clock.advance(config.sessions.merchant.absoluteMs + 1);
		expect(await sessions.get(a.token)).toBeNull(); // absolute expiry

		const s1 = await sessions.create({ kind: 'merchant', subject: 'usr_2' });
		const s2 = await sessions.create({ kind: 'merchant', subject: 'usr_2' });
		const s3 = await sessions.create({ kind: 'merchant', subject: 'usr_2' });
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
		await expect(sessions.create({ kind: 'admin', subject: '' })).rejects.toThrow();
	});

	it('session actors can be resolved by a module port', async () => {
		const deactivated = new Set([MERCHANT_2]);
		const identity = defineModule({
			name: 'identity',
			ports: () => ({
				sessionActor: (/** @type {any} */ session) =>
					deactivated.has(session.subject) ? null : { type: 'merchant', id: session.subject, merchantId: session.subject },
			}),
		});
		const probe = defineModule({ name: 'probeb', routes: (ctx) => probeModule().routes?.(ctx) ?? [] });
		const { portal, call } = await boot({ dbName: 'it_session_port', modules: [systemModule, identity, probe] });
		const live = await login(portal, { kind: 'merchant', subject: MERCHANT });
		expect((await call('GET', '/v1/probe/whoami', { headers: { cookie: live.cookie } })).json.actor).toEqual({
			type: 'merchant',
			id: MERCHANT,
			merchantId: MERCHANT,
		});
		const gone = await login(portal, { kind: 'merchant', subject: MERCHANT_2 });
		expect((await call('GET', '/v1/probe/whoami', { headers: { cookie: gone.cookie } })).status).toBe(401);
		// a merchant cookie does not authenticate as an admin
		const staffName = portal.shared.cookies.name('admin');
		expect((await call('GET', '/v1/probe/whoami', { headers: { cookie: `${staffName}=${live.token}` } })).status).toBe(401);
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

describe('Settings (stored in the database, never in the environment; Owner only)', () => {
	it('sets e-mail sending (password sealed, never returned), branding, support contact and security, written to Activity', async () => {
		const db = mongo.db('it_settings');
		const system = createSystemStore(db, { encryptionKey: ENCRYPTION_KEY });
		const { portal, call } = await boot({ dbName: 'it_settings', db, system });
		const owner = await login(portal, { kind: 'admin', subject: 'adm_owner', mfa: true });
		const support = await login(portal, { kind: 'admin', subject: 'adm_support', mfa: true });
		/** @param {{ cookie: string }} who */
		const as = (who) => ({ cookie: who.cookie, ...SAME_ORIGIN });

		expect((await call('GET', '/v1/admin/settings', { headers: as(support) })).status).toBe(403);
		const read = await call('GET', '/v1/admin/settings', { headers: as(owner) });
		expect(read.status).toBe(200);
		expect(read.json).toMatchObject({ mail: null, security: { sessionHours: 12, requireTwoStepForAdmins: false } });
		expect(JSON.stringify(read.json)).not.toMatch(/seed|keys/);
		// no stored Portal URL (it is PORTAL_URL) and no key rotation
		expect((await call('PUT', '/v1/admin/settings/portal-url', { headers: as(owner), body: {} })).status).toBe(404);
		expect((await call('POST', '/v1/admin/system/keys/signing/rotate', { headers: as(owner) })).status).toBe(404);

		const mail = {
			host: 'smtp.example.com',
			port: 587,
			user: 'mailer',
			password: 's3cret',
			senderName: 'Portal',
			senderAddress: 'no-reply@example.com',
		};
		const bad = await call('PUT', '/v1/admin/settings/mail', {
			headers: as(owner),
			body: { mail: { ...mail, senderAddress: 'bad' } },
		});
		expect(bad.status).toBe(422);
		const saved = await call('PUT', '/v1/admin/settings/mail', { headers: as(owner), body: { mail } });
		expect(saved.json.mail).toEqual({
			host: 'smtp.example.com',
			port: 587,
			secure: false,
			user: 'mailer',
			senderName: 'Portal',
			senderAddress: 'no-reply@example.com',
			hasPassword: true,
			passwordUnreadable: false,
		});
		expect(JSON.stringify(saved.json)).not.toContain('s3cret');
		expect((await system.load()).state.mail).toMatchObject({ pass: 's3cret', from: 'Portal <no-reply@example.com>' });
		expect(
			JSON.stringify(await db.collection('platform_system').findOne({ _id: /** @type {any} */ ('settings') })),
		).not.toContain('s3cret');
		expect((await call('PUT', '/v1/admin/settings/mail', { headers: as(owner), body: { mail: null } })).json.mail).toBeNull();
		// Send test e-mail needs e-mail sending first
		expect((await call('POST', '/v1/admin/settings/mail/test', { headers: as(owner) })).status).toBe(409);

		const branding = await call('PUT', '/v1/admin/settings/branding', {
			headers: as(owner),
			body: { name: 'Acme Portal', accent: '#112233' },
		});
		expect(branding.json.branding).toMatchObject({ name: 'Acme Portal', accent: '#112233' });
		expect(
			(
				await call('PUT', '/v1/admin/settings/branding', { headers: as(owner), body: { name: '', accent: 'red' } })
			).json.errors.map((/** @type {any} */ e) => e.path),
		).toEqual(['/name', '/accent']);
		const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);
		const logo = await call('PUT', '/v1/admin/settings/branding/logo', {
			headers: as(owner),
			body: { type: 'image/png', data: png.toString('base64') },
		});
		expect(logo.json.branding).toMatchObject({ hasLogo: true, logoVersion: 1 });
		// SVG and mismatching bytes are refused
		expect(
			(
				await call('PUT', '/v1/admin/settings/branding/logo', {
					headers: as(owner),
					body: { type: 'image/svg+xml', data: 'PHN2Zz4=' },
				})
			).status,
		).toBe(422);
		expect(
			(
				await call('PUT', '/v1/admin/settings/branding/logo', {
					headers: as(owner),
					body: { type: 'image/jpeg', data: png.toString('base64') },
				})
			).status,
		).toBe(422);
		const served = await portal.handle(new Request(`${PORTAL_URL}/branding/logo`));
		expect([served.status, served.headers.get('content-type')]).toEqual([200, 'image/png']);
		expect(Buffer.from(await served.arrayBuffer()).equals(png)).toBe(true);
		expect((await call('DELETE', '/v1/admin/settings/branding/logo', { headers: as(owner) })).json.branding.hasLogo).toBe(
			false,
		);
		expect((await call('GET', '/branding/logo')).status).toBe(404);

		const supportContact = await call('PUT', '/v1/admin/settings/support', {
			headers: as(owner),
			body: { email: 'help@acme.test', phone: '+92 300 1234567', whatsapp: '' },
		});
		expect(supportContact.json.support).toEqual({ email: 'help@acme.test', phone: '+92 300 1234567', whatsapp: null });
		expect(
			(await call('PUT', '/v1/admin/settings/support', { headers: as(owner), body: { email: 'nope', phone: 'x' } })).status,
		).toBe(422);

		const security = await call('PUT', '/v1/admin/settings/security', {
			headers: as(owner),
			body: { sessionHours: 24, requireTwoStepForAdmins: true },
		});
		expect(security.json.security).toEqual({ sessionHours: 24, requireTwoStepForAdmins: true });
		for (const hours of [0, 337, 1.5])
			expect(
				(
					await call('PUT', '/v1/admin/settings/security', {
						headers: as(owner),
						body: { sessionHours: hours, requireTwoStepForAdmins: false },
					})
				).status,
			).toBe(422);

		const billing = await call('PUT', '/v1/admin/settings/billing', {
			headers: as(owner),
			body: { graceDays: 0, lowBalanceDays: 30 },
		});
		expect(billing.json.billing).toEqual({ graceDays: 0, lowBalanceDays: 30 });
		for (const body of [{ graceDays: 31, lowBalanceDays: 3 }, { graceDays: 3, lowBalanceDays: 0 }, { graceDays: 1.5 }])
			expect((await call('PUT', '/v1/admin/settings/billing', { headers: as(owner), body })).status).toBe(422);

		const entries = await db.collection('platform_audit').find({ action: 'settings.changed' }).toArray();
		expect(new Set(entries.map((e) => e.target.id))).toEqual(
			new Set(['mail', 'branding', 'branding_logo', 'support', 'security', 'billing']),
		);
		expect(entries.every((e) => e.actor.type === 'admin' && e.actor.id === 'adm_owner')).toBe(true);
		expect(JSON.stringify(entries)).not.toContain('s3cret');
	});

	it('serves the public branding, and without a settings store the Settings API answers 503', async () => {
		const { portal, call } = await boot({ dbName: 'it_settings_none' });
		const owner = await login(portal, { kind: 'admin', subject: 'adm_owner', mfa: true });
		expect((await call('GET', '/v1/admin/settings', { headers: { cookie: owner.cookie, ...SAME_ORIGIN } })).status).toBe(503);
		const branding = await call('GET', '/v1/branding');
		expect(branding.json).toEqual({
			name: 'Single Solution',
			accent: '#4f46e5',
			logoUrl: null,
			support: { email: null, phone: null, whatsapp: null },
		});
		expect((await call('GET', '/branding/logo')).status).toBe(503);
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
		// no setup step: the API answers at once; the Portal's address is PORTAL_URL, never the request's headers
		const portal = before;
		expect(portal.config.portalUrl).toBe(PORTAL_URL);
		const forwarded = {
			host: 'evil.example.test',
			'x-forwarded-proto': 'https',
			origin: PORTAL_URL,
			'sec-fetch-site': 'same-origin',
		};
		const first = await portal.handle(
			new Request('http://internal/v1/auth/first-admin', {
				method: 'POST',
				headers: { ...forwarded, 'content-type': 'application/json' },
				body: JSON.stringify({ name: 'Owner', email: 'owner@portal.test', password: 'a-long-enough-passphrase' }),
			}),
		);
		expect(first.status).toBe(201);
		const [cookie = ''] = String(first.headers.get('set-cookie')).split(';');
		expect(cookie).toMatch(/^__Host-ss_admin=/);
		const settings = await portal.handle(
			new Request('http://internal/v1/admin/settings', { headers: { ...forwarded, cookie } }),
		);
		expect(settings.status).toBe(200);
		// a write whose Origin is the request's host (not PORTAL_URL) is refused
		const forged = await portal.handle(
			new Request('http://internal/v1/me', {
				method: 'PATCH',
				headers: { cookie, origin: 'https://evil.example.test', 'content-type': 'application/json' },
				body: JSON.stringify({ name: 'x' }),
			}),
		);
		expect(forged.status).toBe(403);
		expect((await import('node:fs')).existsSync(new URL('../app/setup/route.js', import.meta.url))).toBe(false);

		const res = await portal.handle(new Request('https://portal.example.test/v1/branding'));
		expect(res.status).toBe(200);
		expect(lines.some((line) => JSON.parse(line).msg === 'request')).toBe(true);

		// the Next.js adapters delegate to the cached instance
		const api = await import('../app/api/[...path]/route.js');
		expect((await api.GET(new Request('https://portal.example.test/api/v1/branding'))).status).toBe(200);
		// /.well-known/jwks.json is rewritten to the same catch-all (GET/HEAD only)
		const system = (/** @type {string} */ path, method = 'GET') =>
			api[/** @type {'GET'} */ (method)](new Request(`https://portal.example.test/api${path}`, { method }));
		expect((await (await system('/.well-known/jwks.json')).json()).keys).toHaveLength(2);
		expect((await system('/.well-known/jwks.json', 'HEAD')).status).toBe(200);
		expect((await system('/.well-known/jwks.json', 'POST')).status).toBe(404);
		resetPortal();
		await expect(getPortal({ env: {} })).rejects.toThrow(/MONGODB_URI/);
		const invalid = await system('/v1/catalog/products'); // config invalid
		expect(invalid.status).toBe(503);
		expect((await invalid.json()).status).toBe('misconfigured');
		resetPortal();
	}, 60_000);
});

describe('infra hardening (Mongo)', () => {
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

	it('offers transactions, the platform mailer and the rights table; reserves infra names', async () => {
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
		expect(can({ type: 'admin', id: 's', role: 'owner' }, 'products.manage')).toBe(true);
		expect(can({ type: 'admin', id: 's', role: 'support' }, 'products.manage')).toBe(false);
		expect(can({ type: 'merchant', id: MERCHANT, merchantId: MERCHANT }, 'products.manage')).toBe(false);

		const config = await testConfig();
		const { logger } = createTestLogger();
		const build = (/** @type {any} */ definition) =>
			createPortal({ config, db: mongo.db('it_reserved'), modules: [defineModule({ name: 'clash', ...definition })], logger });
		// periodic module work does not exist (PLAN 0.10)
		expect(() => build({ background: () => ({}) })).not.toThrow();
		expect(() => build({ problems: { idempotency_replay_no_body: { status: 409, title: 'x' } } })).toThrow(/reserved/);
	});
});
