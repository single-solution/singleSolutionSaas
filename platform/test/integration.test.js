import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createJwks, createKeyResolver, generateSigningKey, issueWebsiteKey, signAssertion } from '@ss/protocol';
import { defineCollection } from '../src/infra/db.js';
import { created, defineRoute, ok } from '../src/infra/http.js';
import { defineModule } from '../src/infra/modules.js';
import { COLLECTIONS } from '../src/infra/schema.js';
import { systemModule } from '../src/modules/system/index.js';
import { createPortal, healthz } from '../src/portal.js';
import { getPortal, resetPortal } from '../src/runtime.js';
import { closeMongoClients } from '../src/infra/db.js';
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
			...(withWebsitePort ? { websiteKeyRevoked: (/** @type {any} */ claims) => revoked.has(claims.keyId) } : {}),
		}),
		jobs: (ctx) => ({
			'probe.add': async (payload) => void (await ctx.service('probe').add(payload.merchantId, payload.name)),
		}),
		crons: () => ({
			settlement: async () => ({ settled: 0 }),
			broken: async () => Promise.reject(new Error('cron exploded')),
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
 * @param {{ dbName: string, modules?: any[], clock?: ReturnType<typeof createClock>, db?: any }} options
 */
const boot = async ({ dbName, modules, clock = createClock(), db }) => {
	const config = await testConfig();
	const { logger, entries } = createTestLogger();
	const portal = createPortal({
		config,
		db: db ?? mongo.db(dbName),
		modules: modules ?? [systemModule, probeModule()],
		logger,
		now: clock.now,
		pingTimeoutMs: 200,
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
		const { portal, call } = await boot({ dbName: 'it_boot' });
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
		expect(jwks.keys.map((/** @type {any} */ k) => k.kid)).toEqual(['portal-2026-10', 'portal-2026-04']);
		expect(JSON.stringify(jwks)).not.toContain('"d"');
		const ready = await portal.readyz();
		expect([ready.status, (await ready.json()).checks]).toEqual([200, { database: 'ok' }]);
		const live = healthz({ version: '9', now: () => 0 });
		expect(await live.json()).toEqual({ status: 'ok', version: '9', time: '1970-01-01T00:00:00.000Z' });
		expect((await call('GET', '/v1/probe/fail')).status).toBe(200);
		expect((await call('GET', '/v1/probe/foreign')).status).toBe(500); // modules cannot reach other modules' collections
	});

	it('reports not-ready when the database does not answer', async () => {
		const db = { collection: () => ({}), command: () => new Promise(() => {}) };
		const { portal, entries } = await boot({ dbName: 'unused', db, modules: [] });
		const res = await portal.readyz();
		expect(res.status).toBe(503);
		expect(res.headers.get('retry-after')).toBe('10');
		expect((await res.json()).checks).toEqual({ database: 'down' });
		expect(entries.some((e) => e.msg === 'readiness check failed')).toBe(true);
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
		const issue = async (/** @type {'pk' | 'sk'} */ kind, keyId = `key_${kind}`) =>
			(
				await issueWebsiteKey({
					signer: portal.shared.keys.signer,
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

	it('cron: bearer secret, built-in drain, module crons, failures and run records', async () => {
		const { portal, call, config } = await boot({ dbName: 'it_cron' });
		await portal.ensureIndexes();
		const auth = { authorization: `Bearer ${config.cronSecret}` };
		await portal.shared.jobs.enqueue({ name: 'probe.add', payload: { merchantId: MERCHANT, name: 'from-job' } });
		expect((await call('GET', '/api/cron/drain')).status).toBe(401);
		expect((await call('GET', '/api/cron/drain', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
		const drained = await call('GET', '/api/cron/drain', { headers: auth });
		expect(drained.status).toBe(200);
		expect(drained.json).toMatchObject({ status: 'ok', stats: { leased: 1, succeeded: 1 } });
		expect(await /** @type {any} */ (portal.modules.service('probe')).count(MERCHANT)).toBe(1);
		expect((await call('POST', '/api/cron/settlement', { headers: auth })).json).toMatchObject({
			status: 'ok',
			stats: { settled: 0 },
		});
		expect((await call('GET', '/api/cron/nope', { headers: auth })).status).toBe(404);
		expect((await call('GET', '/api/cron/broken', { headers: auth })).status).toBe(500);
		expect(portal.cron.names()).toEqual(['drain', 'settlement', 'broken']);
		const db = mongo.db('it_cron');
		const runs = await db.collection(COLLECTIONS.cronRuns).find({}).toArray();
		expect(runs.map((r) => `${r.name}:${r.trigger}:${r.status}`).sort()).toEqual([
			'broken:cron:failed',
			'drain:cron:ok',
			'settlement:manual:ok',
		]);
		// a staff or product credential cannot trigger crons
		const staff = await login(portal, { kind: 'staff', subject: 'stf_1', roles: ['superadmin'], mfa: true });
		expect((await call('GET', '/api/cron/drain', { headers: { cookie: staff.cookie } })).status).toBe(401);
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

describe('runtime', () => {
	it('builds one cached Portal from the environment and fails fast on bad config', async () => {
		resetPortal();
		expect(() => getPortal({ env: {} })).toThrow(/Invalid Portal configuration/);
		/** @type {string[]} */
		const lines = [];
		const env = await testEnv({ MONGODB_URI: `${mongo.uri.replace(/\/?(\?|$)/, '/it_runtime$1')}`, LOG_LEVEL: 'info' });
		const portal = getPortal({ env, write: (line) => lines.push(line) });
		expect(getPortal({ env: {} })).toBe(portal);
		const res = await portal.handle(new Request(`${PORTAL_URL}/v1/system/info`));
		expect(res.status).toBe(200);
		expect(lines.some((line) => JSON.parse(line).msg === 'request')).toBe(true);
		expect(portal.config.mongo.dbName).toBe('it_runtime');

		// the Next.js adapters delegate to the cached instance
		const api = await import('../app/api/[...path]/route.js');
		expect((await api.GET(new Request(`${PORTAL_URL}/api/v1/system/info`))).status).toBe(200);
		const cronRoute = await import('../app/api/cron/[job]/route.js');
		expect((await cronRoute.GET(new Request(`${PORTAL_URL}/api/cron/drain`))).status).toBe(401);
		expect(cronRoute.maxDuration).toBe(60);
		const jwks = await import('../app/.well-known/jwks.json/route.js');
		expect((await jwks.GET().json()).keys).toHaveLength(2);
		const ready = await import('../app/readyz/route.js');
		expect((await ready.GET()).status).toBe(200);
		const health = await import('../app/healthz/route.js');
		expect((await health.GET()).status).toBe(200);
		resetPortal();
		const prev = process.env.PORTAL_URL;
		delete process.env.PORTAL_URL;
		expect((await ready.GET()).status).toBe(503); // config invalid
		if (prev !== undefined) process.env.PORTAL_URL = prev;
	});
});
