import { describe, expect, it } from 'vitest';
import {
	createMemoryStores,
	created,
	defineRoute,
	noContent,
	ok,
	paginate,
	problem,
	standardRoutes,
	toNextRoute,
} from '../src/index.js';
import { MERCHANT, WEBSITE, entitle, setup, websiteKey } from './helpers.js';

const BASE = 'https://coupons.example.dev';
const ORIGIN = 'https://shop.example.com';

/**
 * @param {string} path
 * @param {RequestInit & { json?: unknown }} [init]
 */
const req = (path, { json, ...init } = {}) =>
	new Request(`${BASE}${path}`, {
		...init,
		...(json === undefined
			? {}
			: {
					body: JSON.stringify(json),
					headers: { 'content-type': 'application/json', .../** @type {any} */ (init.headers ?? {}) },
				}),
	});

/** Product + handler with a few custom routes. */
const app = async (/** @type {Record<string, any>} */ overrides = {}) => {
	const env = await setup({ overrides });
	await entitle(env.portal);
	const pk = await websiteKey(env.portal);
	const sk = await websiteKey(env.portal, { kind: 'sk', keyId: 'key_2', scopes: ['coupons.read', 'coupons.write'] });
	let counter = 0;
	const routes = [
		...standardRoutes(env.product),
		defineRoute({
			method: 'GET',
			path: '/v1/coupons',
			auth: 'website',
			element: 'codes',
			scopes: ['coupons.read'],
			handler: (ctx) => {
				const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { maxLimit: 3 });
				const all = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
				const after = page.after;
				const items = all.filter((x) => after === null || x.id > /** @type {string} */ (after)).slice(0, page.fetchLimit);
				return page.respond(items);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/coupons/:id',
			auth: 'website',
			element: 'codes',
			handler: (ctx) => ok({ id: ctx.params.id, stale: ctx.entitlement.stale }),
		}),
		defineRoute({ method: 'GET', path: '/v1/coupons/special', auth: 'none', handler: () => ok({ special: true }) }),
		defineRoute({
			method: 'POST',
			path: '/v1/coupons',
			auth: 'website',
			keyKind: 'sk',
			scopes: ['coupons.write'],
			element: 'codes',
			handler: (ctx) => {
				counter += 1;
				return created({ n: counter, body: ctx.body }, { location: `/v1/coupons/${counter}` });
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/imports',
			auth: 'website',
			keyKind: 'sk',
			element: 'bulk',
			handler: () => ok({}),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/flaky',
			auth: 'website',
			keyKind: 'sk',
			idempotent: 'optional',
			handler: () => {
				counter += 1;
				if (counter % 2 === 1) throw new Error('db down');
				return ok({ n: counter });
			},
		}),
		defineRoute({ method: 'DELETE', path: '/v1/coupons/:id', auth: 'website', keyKind: 'sk', handler: () => noContent() }),
		defineRoute({
			method: 'PATCH',
			path: '/v1/raw',
			auth: 'none',
			handler: () => new Response('raw', { status: 202, headers: { 'x-raw': '1' } }),
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/plain',
			auth: 'none',
			maxBodyBytes: 10,
			handler: (ctx) => (ctx.body ? { echoed: ctx.body } : undefined),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/throws-problem',
			auth: 'none',
			handler: () => {
				throw problem('conflict', 'nope', { errors: [{ path: '/a', message: 'bad' }] });
			},
		}),
		defineRoute({ method: 'GET', path: '/v1/unknown-code', auth: 'none', handler: () => problem('not_a_code') }),
		defineRoute({
			method: 'GET',
			path: '/v1/limited',
			auth: 'none',
			rateLimit: { limit: 2, windowSeconds: 60 },
			handler: () => ok({}),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/context/:id',
			auth: 'website',
			keyKind: 'sk',
			idempotent: 'optional',
			handler: (ctx) =>
				ok({
					website: ctx.website.websiteId,
					query: ctx.query,
					all: ctx.searchParams.getAll('a'),
					body: ctx.body,
					params: ctx.params,
					idempotencyKey: ctx.idempotencyKey ?? null,
					url: new URL(ctx.request.url).pathname,
					session: ctx.session,
				}),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/dashboard',
			auth: 'launch',
			roles: ['merchant', 'impersonate'],
			handler: (ctx) => ok({ role: ctx.session.role, websiteId: ctx.websiteId }),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/dashboard/codes',
			auth: 'launch',
			element: 'codes',
			handler: (ctx) => ok({ websiteId: ctx.websiteId }),
		}),
	];
	const handle = env.product.handler(routes);
	return { ...env, handle, pk, sk };
};

/** @param {Response} response */
const body = async (response) => JSON.parse(await response.text());

describe('request handler', () => {
	it('routes, generates request ids and renders RFC 9457 problems', async () => {
		const { handle } = await app();
		const missing = await handle(req('/nope'));
		expect(missing.status).toBe(404);
		expect(missing.headers.get('content-type')).toBe('application/problem+json');
		const doc = await body(missing);
		expect(doc).toMatchObject({ type: `${BASE}/problems/not_found`, title: 'Not found', status: 404, instance: '/nope' });
		expect(doc.requestId).toMatch(/^req_[0-9a-z]{26}$/);
		expect(missing.headers.get('x-request-id')).toBe(doc.requestId);
		const echoed = await handle(req('/healthz', { headers: { 'x-request-id': 'abc-123' } }));
		expect(echoed.headers.get('x-request-id')).toBe('abc-123');
		const unsafe = await handle(req('/healthz', { headers: { 'x-request-id': 'bad id!' } }));
		expect(unsafe.headers.get('x-request-id')).toMatch(/^req_/);
		const wrongMethod = await handle(req('/healthz', { method: 'DELETE' }));
		expect(wrongMethod.status).toBe(405);
		expect(wrongMethod.headers.get('allow')).toBe('GET');
		const thrown = await handle(req('/v1/throws-problem'));
		expect(await body(thrown)).toMatchObject({ status: 409, detail: 'nope', errors: [{ path: '/a', message: 'bad' }] });
		expect((await handle(req('/v1/unknown-code'))).status).toBe(500);
		const literal = await handle(req('/v1/coupons/special'));
		expect(await body(literal)).toEqual({ special: true });
		const head = await handle(req('/healthz', { method: 'HEAD' }));
		expect(head.status).toBe(200);
		expect(await head.text()).toBe('');
	});

	it('answers CORS preflights and echoes allowed origins', async () => {
		const { handle, pk } = await app();
		const preflight = await handle(req('/v1/coupons', { method: 'OPTIONS', headers: { origin: ORIGIN } }));
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get('access-control-allow-origin')).toBe(ORIGIN);
		expect(preflight.headers.get('access-control-allow-methods')).toBe('GET, POST');
		expect((await handle(req('/nope', { method: 'OPTIONS' }))).status).toBe(404);
		const noCors = await handle(req('/healthz', { method: 'OPTIONS', headers: { origin: ORIGIN } }));
		expect(noCors.headers.get('access-control-allow-origin')).toBeNull();
		const actual = await handle(req('/v1/coupons', { headers: { authorization: `Bearer ${pk}`, origin: ORIGIN } }));
		expect(actual.status).toBe(200);
		expect(actual.headers.get('access-control-allow-origin')).toBe(ORIGIN);
		const strings = await handle(req('/v1/strings'));
		expect(strings.headers.get('access-control-allow-origin')).toBe('*');
	});

	it('authenticates website keys with origin and scope checks', async () => {
		const { handle, pk, sk } = await app();
		expect((await handle(req('/v1/coupons'))).status).toBe(401);
		const evil = await handle(req('/v1/coupons', { headers: { authorization: `Bearer ${pk}`, origin: 'https://evil.test' } }));
		expect(await body(evil)).toMatchObject({ status: 403, type: `${BASE}/problems/origin_not_allowed` });
		const post = await handle(
			req('/v1/coupons', {
				method: 'POST',
				json: {},
				headers: { authorization: `Bearer ${pk}`, origin: ORIGIN, 'idempotency-key': 'k' },
			}),
		);
		expect(await body(post)).toMatchObject({ status: 403, type: `${BASE}/problems/forbidden` });
		const scoped = await websiteKey((await app()).portal, { kind: 'sk', keyId: 'key_3', scopes: [] });
		expect(scoped).toBeTypeOf('string');
		const noScope = await handle(
			req('/v1/coupons', {
				headers: { authorization: `Bearer ${`${sk.slice(0, -10)}${sk.at(-10) === 'A' ? 'B' : 'A'}${sk.slice(-9)}`}` },
			}),
		);
		expect(noScope.status).toBe(401);
	});

	it('gates elements and subscription state', async () => {
		const { handle, sk, portal, clock } = await app();
		const disabled = await handle(
			req('/v1/imports', { method: 'POST', json: {}, headers: { authorization: `Bearer ${sk}`, 'idempotency-key': 'i1' } }),
		);
		expect(await body(disabled)).toMatchObject({ status: 403, type: `${BASE}/problems/element_disabled` });
		clock.advance(5 * 60_000);
		await entitle(portal, { version: 2, runtime: { state: 'spend_cap', reason: 'cap' } });
		const capped = await handle(req('/v1/coupons/x', { headers: { authorization: `Bearer ${sk}` } }));
		expect(await body(capped)).toMatchObject({ status: 402, type: `${BASE}/problems/spend_cap_reached` });
		clock.advance(5 * 60_000);
		await entitle(portal, { version: 3, runtime: { state: 'paused', reason: 'merchant' } });
		expect(await body(await handle(req('/v1/coupons/x', { headers: { authorization: `Bearer ${sk}` } })))).toMatchObject({
			type: `${BASE}/problems/subscription_inactive`,
		});
		clock.advance(5 * 60_000);
		portal.removeEntitlement(WEBSITE);
		expect(await body(await handle(req('/v1/coupons/x', { headers: { authorization: `Bearer ${sk}` } })))).toMatchObject({
			status: 403,
			type: `${BASE}/problems/subscription_inactive`,
		});
	});

	it('serves stale entitlements during an outage and 503 without any', async () => {
		const { handle, sk, portal, clock } = await app();
		expect((await handle(req('/v1/coupons/x', { headers: { authorization: `Bearer ${sk}` } }))).status).toBe(200);
		portal.setDown(true);
		clock.advance(10 * 60_000);
		const stale = await handle(req('/v1/coupons/x', { headers: { authorization: `Bearer ${sk}` } }));
		expect(stale.status).toBe(200);
		expect(stale.headers.get('ss-entitlement-stale')).toBe('true');
		expect(await body(stale)).toEqual({ id: 'x', stale: true });
		const fresh = await app();
		fresh.portal.setDown(true);
		const unavailable = await fresh.handle(req('/v1/coupons/x', { headers: { authorization: `Bearer ${fresh.sk}` } }));
		expect(unavailable.status).toBe(503);
		expect(unavailable.headers.get('retry-after')).toBe('30');
	});

	it('rejects a key whose binding does not match the subscription', async () => {
		const { handle, portal } = await app();
		const testKey = await websiteKey(portal, { kind: 'sk', env: 'test', keyId: 'key_t' });
		const res = await handle(req('/v1/coupons/x', { headers: { authorization: `Bearer ${testKey}` } }));
		expect(await body(res)).toMatchObject({ status: 403, type: `${BASE}/problems/forbidden` });
	});

	it('replays idempotent POSTs and refuses key reuse with another body', async () => {
		const { handle, sk } = await app();
		const headers = { authorization: `Bearer ${sk}`, 'idempotency-key': 'create-1' };
		const first = await handle(req('/v1/coupons', { method: 'POST', json: { code: 'A' }, headers }));
		expect(first.status).toBe(201);
		expect(first.headers.get('location')).toBe('/v1/coupons/1');
		const replay = await handle(req('/v1/coupons', { method: 'POST', json: { code: 'A' }, headers }));
		expect(replay.status).toBe(201);
		expect(replay.headers.get('idempotent-replayed')).toBe('true');
		expect(await body(replay)).toEqual({ n: 1, body: { code: 'A' } });
		const conflict = await handle(req('/v1/coupons', { method: 'POST', json: { code: 'B' }, headers }));
		expect(await body(conflict)).toMatchObject({ status: 409, type: `${BASE}/problems/idempotency_conflict` });
		const missing = await handle(req('/v1/coupons', { method: 'POST', json: {}, headers: { authorization: `Bearer ${sk}` } }));
		expect(missing.status).toBe(428);
		const invalid = await handle(
			req('/v1/coupons', {
				method: 'POST',
				json: {},
				headers: { authorization: `Bearer ${sk}`, 'idempotency-key': 'bad key' },
			}),
		);
		expect(invalid.status).toBe(400);
	});

	it('does not store 5xx results, so the retry runs again', async () => {
		const { handle, sk } = await app();
		const headers = { authorization: `Bearer ${sk}`, 'idempotency-key': 'flaky-1' };
		expect((await handle(req('/v1/flaky', { method: 'POST', json: {}, headers }))).status).toBe(500);
		const retried = await handle(req('/v1/flaky', { method: 'POST', json: {}, headers }));
		expect(retried.status).toBe(200);
		expect(await body(retried)).toEqual({ n: 2 });
		// optional: works without a key too
		expect(
			(await handle(req('/v1/flaky', { method: 'POST', json: {}, headers: { authorization: `Bearer ${sk}` } }))).status,
		).toBe(500);
	});

	it('reports in-progress idempotent requests', async () => {
		const stores = createMemoryStores();
		await stores.idempotency.begin('x', 'y', Date.now() + 1000);
		const { handle, sk, product } = await app({
			stores: { idempotency: { ...stores.idempotency, begin: async () => ({ state: 'pending' }) } },
		});
		expect(product).toBeDefined();
		const res = await handle(
			req('/v1/coupons', { method: 'POST', json: {}, headers: { authorization: `Bearer ${sk}`, 'idempotency-key': 'p' } }),
		);
		expect(res.status).toBe(409);
		expect(res.headers.get('retry-after')).toBe('1');
	});

	it('limits body size and content type and parses JSON', async () => {
		const { handle } = await app();
		const big = await handle(
			req('/v1/plain', {
				method: 'PUT',
				body: JSON.stringify({ a: 'x'.repeat(20) }),
				headers: { 'content-type': 'application/json' },
			}),
		);
		expect(big.status).toBe(413);
		const chunked = await handle(
			new Request(`${BASE}/v1/plain`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('{"a":"xxxx'));
						controller.enqueue(new TextEncoder().encode('xxxxxxxx"}'));
						controller.close();
					},
				}),
				// @ts-expect-error Node fetch needs duplex for streamed bodies
				duplex: 'half',
			}),
		);
		expect(chunked.status).toBe(413);
		expect(
			(await handle(req('/v1/plain', { method: 'PUT', body: '{}', headers: { 'content-type': 'text/plain' } }))).status,
		).toBe(415);
		expect(
			(await handle(req('/v1/plain', { method: 'PUT', body: '{', headers: { 'content-type': 'application/json' } }))).status,
		).toBe(400);
		const echoed = await handle(
			req('/v1/plain', { method: 'PUT', body: '{"a":1}', headers: { 'content-type': 'application/merge-patch+json' } }),
		);
		expect(await body(echoed)).toEqual({ echoed: { a: 1 } });
		expect((await handle(req('/v1/plain', { method: 'PUT' }))).status).toBe(204);
		const raw = await handle(req('/v1/raw', { method: 'PATCH' }));
		expect([raw.status, raw.headers.get('x-raw'), await raw.text()]).toEqual([202, '1', 'raw']);
	});

	it('rate limits with standard headers', async () => {
		const { handle } = await app();
		const a = await handle(req('/v1/limited', { headers: { 'x-forwarded-for': '1.1.1.1, 10.0.0.1' } }));
		expect(a.headers.get('ratelimit-limit')).toBe('2');
		expect(a.headers.get('ratelimit-remaining')).toBe('1');
		await handle(req('/v1/limited', { headers: { 'x-forwarded-for': '1.1.1.1' } }));
		const limited = await handle(req('/v1/limited', { headers: { 'x-forwarded-for': '1.1.1.1' } }));
		expect(limited.status).toBe(429);
		expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
		expect((await handle(req('/v1/limited', { headers: { 'x-forwarded-for': '2.2.2.2' } }))).status).toBe(200);
	});

	it('fails open when the rate-limit store is down', async () => {
		const { handle, logs } = await app({
			stores: {
				rateLimits: {
					hit: async () => {
						throw new Error('down');
					},
				},
			},
		});
		expect((await handle(req('/v1/limited'))).status).toBe(200);
		expect(logs.some((l) => l.msg.includes('rate limit store failed'))).toBe(true);
	});

	it('paginates with opaque cursors', async () => {
		const { handle, sk } = await app();
		const headers = { authorization: `Bearer ${sk}` };
		const firstRes = await handle(req('/v1/coupons?limit=2', { headers }));
		expect(firstRes.headers.get('link')).toMatch(/^<\/v1\/coupons\?limit=2&cursor=[A-Za-z0-9_-]+>; rel="next"$/);
		const first = await body(firstRes);
		expect(first).toMatchObject({ items: [{ id: 'a' }, { id: 'b' }], hasMore: true });
		const second = await body(await handle(req(`/v1/coupons?limit=2&cursor=${first.nextCursor}`, { headers })));
		expect(second).toEqual({ items: [{ id: 'c' }, { id: 'd' }], nextCursor: null, hasMore: false });
		expect(paginate({ limit: 1 }).link('abc')).toBeNull();
		for (const query of [
			'limit=0',
			'limit=4',
			'limit=x',
			'cursor=@@',
			`cursor=${Buffer.from('{"x":1}').toString('base64url')}`,
			`cursor=${Buffer.from('{"k":{}}').toString('base64url')}`,
		]) {
			expect((await handle(req(`/v1/coupons?${query}`, { headers }))).status).toBe(400);
		}
		expect(paginate({ limit: 5 }).limit).toBe(5);
		expect(paginate().page([{ id: 1 }]).nextCursor).toBeNull();
	});

	it('authenticates launch sessions by cookie or bearer, with roles and website selection', async () => {
		const { handle, portal, product } = await app();
		const launch = await portal.issueLaunch({
			subject: 'usr_1',
			kind: 'merchant',
			user: { id: 'usr_1' },
			scope: { merchantId: MERCHANT, websiteIds: [WEBSITE] },
		});
		const exchanged = await product.launch.exchange(launch.token);
		if (!exchanged.ok) throw new Error('exchange');
		const id = exchanged.session.id;
		expect((await handle(req('/v1/dashboard'))).status).toBe(401);
		const byCookie = await handle(req('/v1/dashboard', { headers: { cookie: `a=1; ss_session=${id}` } }));
		expect(await body(byCookie)).toEqual({ role: 'merchant', websiteId: WEBSITE });
		const byBearer = await handle(req('/v1/dashboard/codes', { headers: { authorization: `Bearer ${id}` } }));
		expect(await body(byBearer)).toEqual({ websiteId: WEBSITE });
		expect(
			(await handle(req('/v1/dashboard', { headers: { authorization: `Bearer ${id}`, 'x-ss-website': 'web_other' } }))).status,
		).toBe(403);
		const demo = await portal.issueLaunch({ subject: 'usr_2', kind: 'demo', user: { id: 'usr_2' } });
		const demoSession = await product.launch.exchange(demo.token);
		if (!demoSession.ok) throw new Error('exchange');
		expect(
			(await handle(req('/v1/dashboard', { headers: { authorization: `Bearer ${demoSession.session.id}` } }))).status,
		).toBe(403);
		expect(
			(await handle(req('/v1/dashboard/codes', { headers: { authorization: `Bearer ${demoSession.session.id}` } }))).status,
		).toBe(400);
	});

	it('supports a base path, Next.js exports and internal errors', async () => {
		const { product } = await setup();
		const handle = product.handler([defineRoute({ method: 'GET', path: '/x', auth: 'none', handler: () => ok({ x: 1 }) })], {
			basePath: '/api/',
		});
		const next = toNextRoute(handle);
		expect(Object.keys(next).sort()).toEqual(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
		expect((await next.GET(new Request('https://h/api/x'))).status).toBe(200);
		expect((await next.POST(new Request('https://h/api', { method: 'POST' }))).status).toBe(404);
		const broken = product.handler([defineRoute({ method: 'GET', path: '/boom', auth: 'website', handler: () => ok({}) })]);
		const badKeys = {
			...product,
			keys: {
				verify: async () => {
					throw new Error('bug');
				},
			},
		};
		const brokenHandler = /** @type {any} */ (badKeys).handler;
		expect(brokenHandler).toBeTypeOf('function');
		expect((await broken(new Request('https://h/boom'))).status).toBe(401);
	});
});

describe('route context and adapters', () => {
	it('exposes { website, query, searchParams, body, params, idempotencyKey, request, session }', async () => {
		const { handle, sk } = await app();
		const res = await handle(
			req('/v1/context/n%201?a=1&a=2&b=x', {
				method: 'POST',
				json: { t: 1 },
				headers: { authorization: `Bearer ${sk}`, 'idempotency-key': 'ctx-1' },
			}),
		);
		expect(await body(res)).toEqual({
			website: WEBSITE,
			query: { a: '1', b: 'x' },
			all: ['1', '2'],
			body: { t: 1 },
			params: { id: 'n 1' },
			idempotencyKey: 'ctx-1',
			url: '/v1/context/n%201',
			session: null,
		});
	});

	it('toNextRoute strips a leading /api (with bodies) and can be disabled', async () => {
		const { handle, sk } = await app();
		const next = toNextRoute(handle);
		const res = await next.POST(
			new Request(`${BASE}/api/v1/context/x`, {
				method: 'POST',
				body: '{"t":2}',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${sk}` },
			}),
		);
		expect(await body(res)).toMatchObject({ params: { id: 'x' }, body: { t: 2 }, url: '/v1/context/x' });
		expect((await next.GET(new Request(`${BASE}/api`))).status).toBe(404);
		expect((await next.GET(new Request(`${BASE}/v1/strings`))).status).toBe(200);
		expect((await next.GET(new Request(`${BASE}/apix/v1/strings`))).status).toBe(404);
		const raw = toNextRoute(handle, { stripPrefix: false });
		expect((await raw.GET(new Request(`${BASE}/api/v1/strings`))).status).toBe(404);
	});
});

describe('defineRoute', () => {
	it('validates definitions', () => {
		const handler = () => ok({});
		expect(() => defineRoute(/** @type {any} */ ({ method: 'GO', path: '/', auth: 'none', handler }))).toThrow();
		expect(() => defineRoute(/** @type {any} */ ({ method: 'GET', path: 'x', auth: 'none', handler }))).toThrow();
		expect(() => defineRoute(/** @type {any} */ ({ method: 'GET', path: '/', auth: 'x', handler }))).toThrow();
		expect(() => defineRoute(/** @type {any} */ ({ method: 'GET', path: '/', auth: 'none' }))).toThrow();
		expect(() => defineRoute({ method: 'GET', path: '/', auth: 'none', element: 'codes', handler })).toThrow();
		expect(() =>
			defineRoute(/** @type {any} */ ({ method: 'GET', path: '/', auth: 'none', rateLimit: { limit: 1 }, handler })),
		).toThrow();
	});

	it('refuses duplicate routes', async () => {
		const { product } = await setup();
		const route = defineRoute({ method: 'GET', path: '/a/:id', auth: 'none', handler: () => ok({}) });
		expect(() => product.handler([route, { ...route, path: '/a/:other' }])).toThrow(/duplicate/);
	});
});
