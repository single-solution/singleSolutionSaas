import { describe, expect, it } from 'vitest';
import { createProblemFactory } from '@ss/contracts';
import { can } from '../src/infra/rbac.js';
import {
	INFRA_PROBLEMS,
	accepted,
	compileRoutes,
	createApiHandler,
	created,
	defineRoute,
	isProblem,
	isResult,
	matchRoute,
	noContent,
	ok,
	paginate,
	problem,
	toNextRoute,
} from '../src/infra/http.js';
import { createClock, createTestLogger, MERCHANT, MERCHANT_2 } from './helpers.js';

const ORIGIN = 'https://portal.test';
const SECRET = Buffer.alloc(32, 9);

/** In-memory twins of the Mongo stores (same interfaces). */
const memoryStores = () => {
	/** @type {Map<string, any>} */
	const records = new Map();
	/** @type {Map<string, number>} */
	const counters = new Map();
	return {
		records,
		idempotency: {
			begin: async (/** @type {string} */ key, /** @type {string} */ fingerprint) => {
				const doc = records.get(key);
				if (!doc) {
					records.set(key, { fingerprint, response: null });
					return /** @type {const} */ ({ state: 'new' });
				}
				if (doc.fingerprint !== fingerprint) return /** @type {const} */ ({ state: 'mismatch' });
				return doc.response
					? { state: /** @type {const} */ ('done'), response: doc.response }
					: /** @type {const} */ ({ state: 'pending' });
			},
			complete: async (/** @type {string} */ key, /** @type {any} */ response) => {
				records.get(key).response = response;
			},
			release: async (/** @type {string} */ key) => {
				records.delete(key);
			},
		},
		rateLimits: {
			hit: async (/** @type {string} */ key, /** @type {number} */ windowMs, /** @type {number} */ t) => {
				const start = Math.floor(t / windowMs) * windowMs;
				const id = `${key}|${start}`;
				counters.set(id, (counters.get(id) ?? 0) + 1);
				return { count: /** @type {number} */ (counters.get(id)), resetAt: start + windowMs };
			},
		},
	};
};

/** Header-driven fake authenticators: `x-test-<mode>: <json actor>` (or `bad`). */
const fakeAuthenticators = () => {
	/**
	 * @param {'staff' | 'merchant' | 'websiteKey' | 'product' | 'cron'} mode
	 * @param {boolean} [cookie]
	 */
	const make = (mode, cookie = false) =>
		/** @type {import('../src/infra/http.js').Authenticator} */ (
			async (request) => {
				const value = request.headers.get(`x-test-${mode}`);
				if (value === null) return null;
				if (value === 'bad') return problem('invalid_credentials', 'bad', { headers: { 'x-auth': 'failed' } });
				return { ok: true, mode, actor: JSON.parse(value), cookie, headers: mode === 'websiteKey' ? { vary: 'Origin' } : {} };
			}
		);
	return {
		staff: make('staff', true),
		merchant: make('merchant', true),
		websiteKey: make('websiteKey'),
		product: make('product'),
		cron: make('cron'),
	};
};

const STAFF = JSON.stringify({ type: 'staff', id: 'stf_1', roles: ['admin'] });
const SUPPORT = JSON.stringify({ type: 'staff', id: 'stf_2', roles: ['support'] });
const OWNER = JSON.stringify({ type: 'merchant_user', id: 'usr_1', merchantId: MERCHANT, roles: ['owner'] });

/**
 * @param {import('../src/infra/http.js').RouteDefinition[]} routes
 * @param {Partial<Parameters<typeof createApiHandler>[0]>} [overrides]
 */
const build = (routes, overrides = {}) => {
	const clock = createClock();
	const stores = memoryStores();
	const { logger, entries } = createTestLogger();
	const handle = createApiHandler({
		routes,
		problems: createProblemFactory({
			baseUri: 'https://errors.test/',
			codes: { ...INFRA_PROBLEMS, custom_code: { status: 418, title: 'Custom' } },
		}),
		idempotencySecret: SECRET,
		logger,
		authenticators: fakeAuthenticators(),
		can,
		idempotency: stores.idempotency,
		rateLimits: stores.rateLimits,
		portalOrigin: ORIGIN,
		now: clock.now,
		trustProxyHeaders: true,
		maxBodyBytes: 64,
		...overrides,
	});
	/**
	 * @param {string} method
	 * @param {string} path
	 * @param {{ headers?: Record<string, string>, body?: unknown, raw?: string }} [init]
	 */
	const call = async (method, path, { headers = {}, body, raw } = {}) => {
		const text = raw ?? (body === undefined ? undefined : JSON.stringify(body));
		const response = await handle(
			new Request(`${ORIGIN}${path}`, {
				method,
				headers: {
					...(text !== undefined && !('content-type' in headers) ? { 'content-type': 'application/json' } : {}),
					...headers,
				},
				...(text === undefined ? {} : { body: text }),
			}),
		);
		const content = await response.text();
		return {
			status: response.status,
			headers: response.headers,
			text: content,
			json: content && /json/.test(response.headers.get('content-type') ?? '') ? JSON.parse(content) : null,
		};
	};
	return { handle, call, clock, stores, entries };
};

describe('route definitions', () => {
	const handler = () => ok({});
	it('validates definitions', () => {
		expect(() => defineRoute(/** @type {any} */ ({ method: 'TRACE', path: '/x', auth: 'public', handler }))).toThrow(/method/);
		expect(() => defineRoute({ method: 'GET', path: 'x', auth: 'public', handler })).toThrow(/path/);
		expect(() => defineRoute(/** @type {any} */ ({ method: 'GET', path: '/x', auth: 'nobody', handler }))).toThrow(/auth/);
		expect(() => defineRoute(/** @type {any} */ ({ method: 'GET', path: '/x', auth: [], handler }))).toThrow(/auth/);
		expect(() => defineRoute({ method: 'GET', path: '/x', auth: ['public', 'staff'], handler })).toThrow(/public/);
		expect(() => defineRoute({ method: 'GET', path: '/x', auth: 'public', permission: 'a.b', handler })).toThrow(/permission/);
		expect(() => defineRoute(/** @type {any} */ ({ method: 'GET', path: '/x', auth: 'public' }))).toThrow(/handler/);
		expect(() =>
			defineRoute({ method: 'GET', path: '/x', auth: 'public', rateLimit: { limit: 0, windowMs: 1 }, handler }),
		).toThrow(/rateLimit/);
		expect(() =>
			compileRoutes([
				{ method: 'GET', path: '/a/:x', auth: 'public', handler },
				{ method: 'GET', path: '/a/:y', auth: 'public', handler },
			]),
		).toThrow(/duplicate/);
	});

	it('matches literals before parameters', () => {
		const routes = compileRoutes([
			{ method: 'GET', path: '/v1/items/:id', auth: 'public', handler },
			{ method: 'GET', path: '/v1/items/special', auth: 'public', handler },
			{ method: 'POST', path: '/v1/items/:id', auth: 'public', handler },
		]);
		const hit = /** @type {any} */ (matchRoute(routes, 'GET', '/v1/items/special'));
		expect(hit.route.path).toBe('/v1/items/special');
		expect(/** @type {any} */ (matchRoute(routes, 'HEAD', '/v1/items/a%20b')).params).toEqual({ id: 'a b' });
		expect(matchRoute(routes, 'DELETE', '/v1/items/x')).toEqual({ route: null, allow: ['GET', 'POST'] });
		expect(matchRoute(routes, 'GET', '/v1/items/%E0%A4%A')).toEqual({ route: null, allow: [] }); // undecodable parameter
	});

	it('refuses modes without authenticators', () => {
		expect(() => build([{ method: 'GET', path: '/x', auth: 'staff', handler }], { authenticators: {} })).toThrow(
			/authenticator/,
		);
	});

	it('result helpers', () => {
		expect(isResult(ok(1))).toBe(true);
		expect(isProblem(ok(1))).toBe(false);
		expect(isProblem(problem('not_found'))).toBe(true);
		expect(isResult({})).toBe(false);
		expect(isResult(null)).toBe(false);
		expect(accepted({ a: 1 }).status).toBe(202);
		expect(created({}, { location: '/x' }).headers).toEqual({ location: '/x' });
		expect(noContent().status).toBe(204);
	});
});

describe('request pipeline', () => {
	it('routes, sets request ids, 404 and 405 problems', async () => {
		const { call, entries } = build([
			{ method: 'GET', path: '/v1/things', auth: 'public', handler: () => ({ hello: 'world' }) },
		]);
		const res = await call('GET', '/api/v1/things', { headers: { 'x-request-id': 'req-abc' } });
		expect(res.status).toBe(200);
		expect(res.json).toEqual({ hello: 'world' });
		expect(res.headers.get('x-request-id')).toBe('req-abc');
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(entries.some((e) => e.msg === 'request' && e.fields?.status === 200)).toBe(true);

		const direct = await call('GET', '/v1/things', { headers: { 'x-request-id': 'bad id with spaces' } });
		expect(direct.status).toBe(200);
		expect(direct.headers.get('x-request-id')).toMatch(/^req_/);

		const missing = await call('GET', '/v1/nothing');
		expect(missing.status).toBe(404);
		expect(missing.headers.get('content-type')).toBe('application/problem+json');
		expect(missing.json).toMatchObject({ type: 'https://errors.test/not_found', status: 404, instance: '/v1/nothing' });
		expect(missing.json.requestId).toMatch(/^req_/);

		const wrong = await call('DELETE', '/v1/things');
		expect(wrong.status).toBe(405);
		expect(wrong.headers.get('allow')).toBe('GET');
		const head = await call('HEAD', '/v1/things');
		expect(head.status).toBe(200);
		expect(head.text).toBe('');
		expect((await call('GET', '/api')).status).toBe(404);
	});

	it('answers preflights, with CORS only for cors routes', async () => {
		const { call } = build([
			{ method: 'GET', path: '/v1/open', auth: 'public', cors: true, handler: () => ({}) },
			{ method: 'GET', path: '/v1/closed', auth: 'public', handler: () => ({}) },
		]);
		const pre = await call('OPTIONS', '/v1/open', { headers: { origin: 'https://shop.example.com' } });
		expect(pre.status).toBe(204);
		expect(pre.headers.get('access-control-allow-origin')).toBe('https://shop.example.com');
		expect(pre.headers.get('allow')).toBe('GET, OPTIONS');
		const closed = await call('OPTIONS', '/v1/closed', { headers: { origin: 'https://shop.example.com' } });
		expect(closed.headers.get('access-control-allow-origin')).toBeNull();
		expect((await call('OPTIONS', '/v1/none')).status).toBe(404);
	});

	it('caps bodies, requires JSON and parses it', async () => {
		const { call } = build([
			{ method: 'PUT', path: '/v1/echo', auth: 'public', handler: (ctx) => ({ body: ctx.body }) },
			{
				method: 'PUT',
				path: '/v1/raw',
				auth: 'public',
				rawBody: true,
				maxBodyBytes: 10,
				handler: (ctx) => ({ raw: ctx.rawBody }),
			},
		]);
		expect((await call('PUT', '/v1/echo', { body: { a: 1 } })).json).toEqual({ body: { a: 1 } });
		expect((await call('PUT', '/v1/echo', { raw: 'x'.repeat(100) })).status).toBe(413);
		expect((await call('PUT', '/v1/echo', { raw: 'x', headers: { 'content-type': 'text/plain' } })).status).toBe(415);
		expect((await call('PUT', '/v1/echo', { raw: '{bad' })).status).toBe(400);
		expect(
			(await call('PUT', '/v1/echo', { raw: '{"a":1}', headers: { 'content-type': 'application/merge-patch+json' } })).json,
		).toEqual({ body: { a: 1 } });
		expect((await call('PUT', '/v1/raw', { raw: 'abc', headers: { 'content-type': 'text/plain' } })).json).toEqual({
			raw: 'abc',
		});
		expect((await call('PUT', '/v1/raw', { raw: 'abcdefghijkl', headers: { 'content-type': 'text/plain' } })).status).toBe(413);
		// streamed body without content-length
		const { handle } = build([
			{ method: 'PUT', path: '/v1/echo', auth: 'public', handler: (ctx) => ({ len: ctx.rawBody.length }) },
		]);
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('x'.repeat(40)));
				controller.enqueue(new TextEncoder().encode('x'.repeat(40)));
				controller.close();
			},
		});
		const res = await handle(
			new Request(
				`${ORIGIN}/v1/echo`,
				/** @type {RequestInit} */ ({
					method: 'PUT',
					body: stream,
					headers: { 'content-type': 'application/json' },
					duplex: 'half',
				}),
			),
		);
		expect(res.status).toBe(413);
	});

	it('authenticates with the first present credential and reports failures', async () => {
		const { call } = build([
			{
				method: 'GET',
				path: '/v1/who',
				auth: ['staff', 'product'],
				handler: (ctx) => ({ mode: ctx.authMode, actor: ctx.actor }),
			},
		]);
		expect((await call('GET', '/v1/who')).status).toBe(401);
		const viaProduct = await call('GET', '/v1/who', {
			headers: { 'x-test-product': JSON.stringify({ type: 'product', id: 'app_1' }) },
		});
		expect(viaProduct.json).toEqual({ mode: 'product', actor: { type: 'product', id: 'app_1' } });
		const both = await call('GET', '/v1/who', { headers: { 'x-test-staff': STAFF, 'x-test-product': 'bad' } });
		expect(both.json.mode).toBe('staff');
		const bad = await call('GET', '/v1/who', { headers: { 'x-test-staff': 'bad' } });
		expect(bad.status).toBe(401);
		expect(bad.headers.get('x-auth')).toBe('failed');
	});

	it('enforces CSRF on cookie-authenticated mutations only', async () => {
		const { call } = build([
			{ method: 'PATCH', path: '/v1/thing', auth: ['staff', 'product'], handler: () => ({ done: true }) },
			{ method: 'GET', path: '/v1/thing', auth: 'staff', handler: () => ({ read: true }) },
		]);
		expect((await call('PATCH', '/v1/thing', { headers: { 'x-test-staff': STAFF }, body: {} })).status).toBe(403);
		expect(
			(await call('PATCH', '/v1/thing', { headers: { 'x-test-staff': STAFF, origin: 'https://evil.test' }, body: {} })).status,
		).toBe(403);
		expect(
			(
				await call('PATCH', '/v1/thing', {
					headers: { 'x-test-staff': STAFF, origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
					body: {},
				})
			).status,
		).toBe(200);
		expect(
			(
				await call('PATCH', '/v1/thing', {
					headers: { 'x-test-product': JSON.stringify({ type: 'product', id: 'a' }) },
					body: {},
				})
			).status,
		).toBe(200);
		expect((await call('GET', '/v1/thing', { headers: { 'x-test-staff': STAFF } })).status).toBe(200);
	});

	it('checks RBAC permissions against the default or a custom resource', async () => {
		const { call } = build([
			{
				method: 'GET',
				path: '/v1/merchants/:merchantId/websites',
				auth: ['staff', 'merchant'],
				permission: 'websites.read',
				handler: () => ({ ok: true }),
			},
			{
				method: 'GET',
				path: '/v1/settings',
				auth: 'staff',
				permission: 'platform.settings.write',
				handler: () => ({ ok: true }),
			},
			{
				method: 'GET',
				path: '/v1/custom',
				auth: 'merchant',
				permission: 'config.write',
				resource: (ctx) => ({ merchantId: ctx.query.m ?? null, websiteId: ctx.query.w ?? null }),
				handler: (ctx) => {
					ctx.authorize('merchant.delete');
					return { ok: true };
				},
			},
		]);
		expect((await call('GET', `/v1/merchants/${MERCHANT}/websites`, { headers: { 'x-test-merchant': OWNER } })).status).toBe(
			200,
		);
		expect((await call('GET', `/v1/merchants/${MERCHANT_2}/websites`, { headers: { 'x-test-merchant': OWNER } })).status).toBe(
			403,
		);
		expect((await call('GET', `/v1/merchants/${MERCHANT_2}/websites`, { headers: { 'x-test-staff': SUPPORT } })).status).toBe(
			200,
		);
		expect((await call('GET', '/v1/settings', { headers: { 'x-test-staff': SUPPORT } })).status).toBe(403);
		expect((await call('GET', '/v1/settings', { headers: { 'x-test-staff': STAFF } })).status).toBe(200);
		expect((await call('GET', `/v1/custom?m=${MERCHANT}`, { headers: { 'x-test-merchant': OWNER } })).status).toBe(200);
		const editor = JSON.stringify({ type: 'merchant_user', id: 'usr_2', merchantId: MERCHANT, roles: ['editor'] });
		const denied = await call('GET', `/v1/custom?m=${MERCHANT}`, { headers: { 'x-test-merchant': editor } });
		expect(denied.status).toBe(403);
		expect(denied.json.detail).toBe('Missing permission merchant.delete.');
	});

	it('rate limits per route and subject with RateLimit headers', async () => {
		const { call, clock } = build([
			{ method: 'GET', path: '/v1/limited', auth: 'public', rateLimit: { limit: 2, windowMs: 60_000 }, handler: () => ({}) },
			{
				method: 'GET',
				path: '/v1/keyed',
				auth: 'public',
				rateLimit: { limit: 1, windowMs: 1000, key: (ctx) => String(ctx.query.k) },
				handler: () => ({}),
			},
		]);
		const ip = { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' };
		const first = await call('GET', '/v1/limited', { headers: ip });
		expect(first.headers.get('ratelimit-limit')).toBe('2');
		expect(first.headers.get('ratelimit-remaining')).toBe('1');
		await call('GET', '/v1/limited', { headers: ip });
		const third = await call('GET', '/v1/limited', { headers: ip });
		expect(third.status).toBe(429);
		expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0);
		expect((await call('GET', '/v1/limited', { headers: { 'x-forwarded-for': '198.51.100.1' } })).status).toBe(200);
		clock.advance(60_000);
		expect((await call('GET', '/v1/limited', { headers: ip })).status).toBe(200);
		expect((await call('GET', '/v1/keyed?k=a')).status).toBe(200);
		expect((await call('GET', '/v1/keyed?k=a')).status).toBe(429);
		expect((await call('GET', '/v1/keyed?k=b')).status).toBe(200);
	});

	it('allows requests when the rate-limit store fails', async () => {
		const { call, entries } = build(
			[{ method: 'GET', path: '/v1/x', auth: 'public', rateLimit: { limit: 1, windowMs: 1000 }, handler: () => ({}) }],
			{
				rateLimits: { hit: async () => Promise.reject(new Error('down')) },
			},
		);
		expect((await call('GET', '/v1/x')).status).toBe(200);
		expect(entries.some((e) => e.level === 'warn')).toBe(true);
	});

	it('requires, replays and guards Idempotency-Keys on POST', async () => {
		let counter = 0;
		const { call, stores } = build([
			{
				method: 'POST',
				path: '/v1/things',
				auth: ['staff', 'product'],
				handler: (ctx) => created({ n: (counter += 1), key: ctx.idempotencyKey }, { location: '/v1/things/1' }),
			},
			{ method: 'POST', path: '/v1/optional', auth: 'public', idempotent: 'optional', handler: () => ({ n: (counter += 1) }) },
			{ method: 'POST', path: '/v1/never', auth: 'public', idempotent: false, handler: () => ({ n: (counter += 1) }) },
			{ method: 'POST', path: '/v1/fails', auth: 'public', handler: () => problem('unavailable') },
		]);
		const app = { 'x-test-product': JSON.stringify({ type: 'product', id: 'app_1' }) };
		expect((await call('POST', '/v1/things', { headers: app, body: { a: 1 } })).status).toBe(428);
		expect(
			(await call('POST', '/v1/things', { headers: { ...app, 'idempotency-key': 'bad key' }, body: { a: 1 } })).status,
		).toBe(400);
		const first = await call('POST', '/v1/things', { headers: { ...app, 'idempotency-key': 'k1' }, body: { a: 1 } });
		expect(first.status).toBe(201);
		expect(first.json).toEqual({ n: 1, key: 'k1' });
		const replay = await call('POST', '/v1/things', { headers: { ...app, 'idempotency-key': 'k1' }, body: { a: 1 } });
		expect(replay.status).toBe(201);
		expect(replay.json).toEqual({ n: 1, key: 'k1' });
		expect(replay.headers.get('idempotent-replayed')).toBe('true');
		expect(replay.headers.get('location')).toBe('/v1/things/1');
		expect((await call('POST', '/v1/things', { headers: { ...app, 'idempotency-key': 'k1' }, body: { a: 2 } })).status).toBe(
			409,
		);
		// a different principal with the same key is a different record
		const other = await call('POST', '/v1/things', {
			headers: { 'x-test-product': JSON.stringify({ type: 'product', id: 'app_2' }), 'idempotency-key': 'k1' },
			body: { a: 1 },
		});
		expect(other.json.n).toBe(2);
		// pending
		const [pendingKey] = [...stores.records.keys()];
		stores.records.get(/** @type {string} */ (pendingKey)).response = null;
		const pending = await call('POST', '/v1/things', { headers: { ...app, 'idempotency-key': 'k1' }, body: { a: 1 } });
		expect(pending.status).toBe(409);
		expect(pending.headers.get('retry-after')).toBe('1');

		expect((await call('POST', '/v1/optional')).json.n).toBe(3);
		expect((await call('POST', '/v1/never', { headers: { 'idempotency-key': 'zzz' } })).json.n).toBe(4);
		const failing = await call('POST', '/v1/fails', { headers: { 'idempotency-key': 'f1' } });
		expect(failing.status).toBe(503);
		expect(stores.records.size).toBe(2); // k1 for app_1 and app_2; the 5xx record was released
		expect(
			(await call('POST', '/v1/fails', { headers: { 'idempotency-key': 'f1' } })).headers.get('idempotent-replayed'),
		).toBeNull();
		// fingerprints are keyed HMACs (a body with a password cannot be brute-forced from the store)
		const fingerprints = [...stores.records.values()].map((r) => r.fingerprint);
		expect(fingerprints.every((f) => /^[0-9a-f]{64}$/.test(f))).toBe(true);
		const { createHash } = await import('node:crypto');
		const plain = createHash('sha256')
			.update(`POST\n/v1/things\n\n${JSON.stringify({ a: 1 })}`)
			.digest('hex');
		expect(fingerprints).not.toContain(plain);
	});

	it("'no-store' routes keep only the status: replays answer 409 idempotency_replay_no_body", async () => {
		let counter = 0;
		const { call, stores } = build([
			{
				method: 'POST',
				path: '/v1/secrets',
				auth: 'public',
				idempotent: 'no-store',
				handler: () => created({ secret: `s3cret-${(counter += 1)}` }, { headers: { 'x-secret': 'header-secret' } }),
			},
			{
				method: 'POST',
				path: '/v1/secrets/fail',
				auth: 'public',
				idempotent: 'no-store',
				handler: () => problem('unavailable'),
			},
		]);
		const first = await call('POST', '/v1/secrets', { headers: { 'idempotency-key': 'n1' }, body: { password: 'pw' } });
		expect([first.status, first.json.secret]).toEqual([201, 's3cret-1']);
		const stored = JSON.stringify([...stores.records.values()]);
		expect(stored).not.toContain('s3cret');
		expect(stored).not.toContain('header-secret');
		expect(stored).not.toContain('pw');
		const replay = await call('POST', '/v1/secrets', { headers: { 'idempotency-key': 'n1' }, body: { password: 'pw' } });
		expect(replay.status).toBe(409);
		expect(replay.json.type).toBe('https://errors.test/idempotency_replay_no_body');
		expect(replay.json.detail).toContain('status 201');
		expect(replay.headers.get('idempotent-replayed')).toBe('true');
		expect(counter).toBe(1); // not executed twice
		// a different body under the same key is still a conflict, the key stays optional
		expect(
			(await call('POST', '/v1/secrets', { headers: { 'idempotency-key': 'n1' }, body: { password: 'x' } })).json.type,
		).toBe('https://errors.test/idempotency_conflict');
		expect((await call('POST', '/v1/secrets', { body: { password: 'pw' } })).status).toBe(201);
		// 5xx outcomes are released so the retry runs
		expect((await call('POST', '/v1/secrets/fail', { headers: { 'idempotency-key': 'n2' } })).status).toBe(503);
		expect((await call('POST', '/v1/secrets/fail', { headers: { 'idempotency-key': 'n2' } })).status).toBe(503);
	});

	it('refuses to build without a fingerprint secret', () => {
		expect(() => build([], { idempotencySecret: Buffer.alloc(8) })).toThrow(/idempotencySecret/);
	});

	it('renders handler outcomes: values, results, Responses, thrown problems and crashes', async () => {
		const { call, entries } = build([
			{ method: 'GET', path: '/v1/value', auth: 'public', handler: () => [1, 2] },
			{ method: 'GET', path: '/v1/empty', auth: 'public', handler: () => undefined },
			{
				method: 'GET',
				path: '/v1/response',
				auth: 'public',
				handler: () => new Response('plain', { status: 202, headers: { 'content-type': 'text/plain', 'set-cookie': 'a=1' } }),
			},
			{
				method: 'GET',
				path: '/v1/cookie',
				auth: 'public',
				handler: () => ok({}, { cookies: ['a=1; Path=/', 'b=2; Path=/'], headers: { 'cache-control': 'private' } }),
			},
			{
				method: 'GET',
				path: '/v1/thrown',
				auth: 'public',
				handler: () => {
					throw problem('validation_failed', 'nope', { errors: [{ path: '/a', message: 'bad' }] });
				},
			},
			{ method: 'GET', path: '/v1/custom', auth: 'public', handler: () => problem('custom_code') },
			{ method: 'GET', path: '/v1/unknown', auth: 'public', handler: () => problem('no_such_code') },
			{
				method: 'GET',
				path: '/v1/crash',
				auth: 'public',
				handler: () => {
					throw new Error('kaboom');
				},
			},
		]);
		expect((await call('GET', '/v1/value')).json).toEqual([1, 2]);
		expect((await call('GET', '/v1/empty')).status).toBe(204);
		const response = await call('GET', '/v1/response');
		expect([response.status, response.text, response.headers.get('set-cookie')]).toEqual([202, 'plain', 'a=1']);
		const cookie = await call('GET', '/v1/cookie');
		expect(cookie.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
		expect(cookie.headers.get('cache-control')).toBe('private');
		const thrown = await call('GET', '/v1/thrown');
		expect(thrown.status).toBe(422);
		expect(thrown.json.errors).toEqual([{ path: '/a', message: 'bad' }]);
		expect((await call('GET', '/v1/custom')).status).toBe(418);
		expect((await call('GET', '/v1/unknown')).json.type).toBe('https://errors.test/internal_error');
		const crash = await call('GET', '/v1/crash');
		expect(crash.status).toBe(500);
		expect(crash.text).not.toContain('kaboom');
		expect(entries.some((e) => e.msg === 'route handler failed')).toBe(true);
	});

	it('turns infrastructure failures into a 500 problem', async () => {
		const { call } = build([{ method: 'POST', path: '/v1/x', auth: 'public', handler: () => ({}) }], {
			idempotency: { begin: () => Promise.reject(new Error('db down')), complete: async () => {}, release: async () => {} },
		});
		const res = await call('POST', '/v1/x', { headers: { 'idempotency-key': 'k' } });
		expect(res.status).toBe(500);
		expect(res.json.type).toBe('https://errors.test/internal_error');
	});

	it('exposes query, params and the client IP only when proxy headers are trusted', async () => {
		const routes = [
			{
				method: /** @type {const} */ ('GET'),
				path: '/v1/items/:id',
				auth: /** @type {const} */ ('public'),
				handler: (/** @type {any} */ ctx) => ({
					id: ctx.params.id,
					q: ctx.query,
					all: ctx.searchParams.getAll('t'),
					ip: ctx.ip,
				}),
			},
		];
		const trusted = build(routes);
		expect((await trusted.call('GET', '/v1/items/a1?t=1&t=2&x=y', { headers: { 'x-real-ip': '192.0.2.4' } })).json).toEqual({
			id: 'a1',
			q: { t: '1', x: 'y' },
			all: ['1', '2'],
			ip: '192.0.2.4',
		});
		const untrusted = build(routes, { trustProxyHeaders: false });
		expect((await untrusted.call('GET', '/v1/items/a1', { headers: { 'x-forwarded-for': '192.0.2.4' } })).json.ip).toBeNull();
	});

	it('toNextRoute exposes every method', async () => {
		const { handle } = build([{ method: 'GET', path: '/v1/x', auth: 'public', handler: () => ({ ok: true }) }]);
		const next = toNextRoute(handle);
		expect(Object.keys(next).sort()).toEqual(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
		expect((await next.GET(new Request(`${ORIGIN}/api/v1/x`))).status).toBe(200);
	});
});

describe('paginate', () => {
	const items = Array.from({ length: 5 }, (_, i) => ({ id: `id${i}`, at: i }));
	it('pages with opaque cursors and Link headers', () => {
		const p = paginate({ limit: '2', url: 'https://portal.test/v1/items?x=1' });
		expect(p.fetchLimit).toBe(3);
		const res = p.respond(
			items.slice(0, 3),
			(item) => item.id,
			(item) => ({ id: item.id }),
		);
		expect(res.body).toMatchObject({ items: [{ id: 'id0' }, { id: 'id1' }], hasMore: true });
		const cursor = /** @type {any} */ (res.body).nextCursor;
		expect(res.headers.link).toBe(`</v1/items?x=1&cursor=${cursor}&limit=2>; rel="next"`);
		expect(paginate({ cursor }).after).toBe('id1');
		const composite = paginate({ limit: 1 }).page(items.slice(0, 2), (item) => [item.at, item.id]);
		expect(paginate({ cursor: /** @type {string} */ (composite.nextCursor) }).after).toEqual([0, 'id0']);
		const last = paginate({}).respond(items, (item) => item.id);
		expect(last.body).toMatchObject({ hasMore: false, nextCursor: null });
		expect(last.headers.link).toBeUndefined();
		expect(paginate({ limit: null }).limit).toBe(20);
	});
	it('rejects invalid limits and cursors', () => {
		for (const limit of ['0', '101', 'abc', 2.5]) expect(() => paginate({ limit })).toThrow();
		for (const cursor of [
			'***',
			Buffer.from('{"x":1}').toString('base64url'),
			Buffer.from('nope').toString('base64url'),
			Buffer.from('{"k":{"a":1}}').toString('base64url'),
		]) {
			expect(() => paginate({ cursor })).toThrow();
		}
		try {
			paginate({ limit: '0' });
		} catch (error) {
			expect(isProblem(error)).toBe(true);
		}
	});
});
