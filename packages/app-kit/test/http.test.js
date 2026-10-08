import { describe, expect, it } from 'vitest';
import { createLogger, created, defineRoute, noContent, noopLogger, ok, paginate, problem, toNextRoute } from '../src/index.js';
import { redact } from '../src/logger.js';
import { collectionPrefix, isKitError, kitError, omit } from '../src/util.js';
import { createMemoryStore } from '../src/testing.js';
import { BASE, productRoutes, setup } from './helpers.js';

const handler = () => ok({});

describe('results', () => {
	it('builds responses and problems with checked extensions', () => {
		expect(created({ a: 1 }, { location: '/x' })).toMatchObject({ status: 201, headers: { location: '/x' } });
		expect(created({ a: 1 })).toMatchObject({ status: 201, headers: {} });
		expect(noContent()).toMatchObject({ status: 204 });
		expect(problem('conflict', 'x', { extensions: { limitName: 'daily' } })).toMatchObject({
			code: 'conflict',
			extensions: { limitName: 'daily' },
		});
		expect(problem('conflict', 'x', { extensions: {} })).not.toHaveProperty('extensions');
		expect(() => problem('conflict', 'x', { extensions: /** @type {any} */ ([]) })).toThrow();
		expect(() => problem('conflict', 'x', { extensions: { a: 1 } })).toThrow(/name/);
		expect(() => problem('conflict', 'x', { extensions: { status: 1 } })).toThrow(/redefine/);
		expect(() => problem('conflict', 'x', { extensions: { func: () => {} } })).toThrow(/JSON/);
	});

	it('paginates with opaque cursors', () => {
		const all = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
		const first = paginate({ limit: '2', url: `${BASE}/v1/items?x=1` });
		const page = first.respond(all.slice(0, first.fetchLimit));
		expect(page.headers.link).toMatch(/^<\/v1\/items\?x=1&cursor=[\w-]+&limit=2>; rel="next"$/);
		const body = /** @type {any} */ (page.body);
		expect(body).toMatchObject({ items: [{ id: 'a' }, { id: 'b' }], hasMore: true });
		const second = paginate({ cursor: body.nextCursor, limit: 2 });
		expect(second.after).toBe('b');
		expect(second.page(all.slice(2)).nextCursor).toBeNull();
		const compound = paginate({ limit: 1 }).page([{ at: new Date(0), id: 'x' }, { id: 'y' }], (item) => [
			item.at ?? null,
			item.id,
		]);
		expect(paginate({ cursor: compound.nextCursor }).after).toEqual(['1970-01-01T00:00:00.000Z', 'x']);
		expect(paginate({ limit: 1 }).link('abc')).toBeNull();
		expect(paginate().respond([]).headers).toEqual({});
		for (const input of [
			{ limit: '0' },
			{ limit: 'x' },
			{ limit: 101 },
			{ cursor: '@@' },
			{ cursor: Buffer.from('{"x":1}').toString('base64url') },
			{ cursor: Buffer.from('{"k":{}}').toString('base64url') },
			{ cursor: Buffer.from('{"k":[]}').toString('base64url') },
		]) {
			expect(() => paginate(input)).toThrow();
		}
		expect(() => paginate({ limit: 1 }).page([{ id: {} }, { id: 2 }])).toThrow(/cursor key/);
		expect(() => paginate({ limit: 1 }).page([{ id: [] }, { id: 2 }], (item) => item.id)).toThrow(/compound/);
	});
});

describe('defineRoute', () => {
	it('validates definitions', () => {
		expect(() => defineRoute(/** @type {any} */ ({ method: 'GO', path: '/', auth: 'none', handler }))).toThrow();
		expect(() => defineRoute(/** @type {any} */ ({ method: 'GET', path: 'x', auth: 'none', handler }))).toThrow();
		expect(() => defineRoute(/** @type {any} */ ({ method: 'GET', path: '/', auth: 'website', handler }))).toThrow(/auth/);
		expect(() => defineRoute(/** @type {any} */ ({ method: 'GET', path: '/', auth: 'none' }))).toThrow(/handler/);
		expect(() => defineRoute({ method: 'GET', path: '/', auth: 'none', feature: 'notes', handler })).toThrow(/feature/);
		expect(() => defineRoute({ method: 'GET', path: '/', auth: 'server', permission: 'notes.read', handler })).toThrow(
			/permission/,
		);
		expect(() =>
			defineRoute(/** @type {any} */ ({ method: 'GET', path: '/', auth: 'dashboard', roles: ['admin'], handler })),
		).toThrow(/roles/);
		expect(() => defineRoute({ method: 'GET', path: '/', auth: 'none', roles: ['owner'], handler })).toThrow(/roles/);
		expect(() =>
			defineRoute(/** @type {any} */ ({ method: 'GET', path: '/', auth: 'none', rateLimit: { limit: 1 }, handler })),
		).toThrow(/rateLimit/);
		expect(() =>
			defineRoute(
				/** @type {any} */ ({
					method: 'GET',
					path: '/',
					auth: 'none',
					rateLimit: { limit: 1, windowSeconds: 1, per: 'x' },
					handler,
				}),
			),
		).toThrow();
		expect(defineRoute({ method: 'GET', path: '/', auth: 'dashboard', roles: ['owner'], handler }).roles).toEqual(['owner']);
	});

	it('refuses duplicate routes, unknown features and unknown permissions', async () => {
		const { product } = await setup();
		const route = defineRoute({ method: 'GET', path: '/v1/a/:id', auth: 'none', handler });
		expect(() => product.handler([route, { ...route, path: '/v1/a/:other' }])).toThrow(/duplicate/);
		expect(() =>
			product.handler([defineRoute({ method: 'GET', path: '/x', auth: 'server', feature: 'nope', handler })]),
		).toThrow(/feature/);
		expect(() =>
			product.handler([defineRoute({ method: 'GET', path: '/x', auth: 'ticket', permission: 'nope', handler })]),
		).toThrow(/permission/);
	});
});

describe('handler results and the Next.js adapter', () => {
	it('renders results, thrown problems, raw responses and unknown codes', async () => {
		let flaky = 0;
		const { call } = await setup({
			routes: [
				defineRoute({
					method: 'GET',
					path: '/v1/items/:id',
					auth: 'none',
					handler: (ctx) => ({ id: ctx.params.id, q: ctx.query, all: ctx.searchParams.getAll('a') }),
				}),
				defineRoute({ method: 'GET', path: '/v1/items/special', auth: 'none', handler: () => ({ special: true }) }),
				defineRoute({ method: 'DELETE', path: '/v1/items/:id', auth: 'none', handler: () => undefined }),
				defineRoute({
					method: 'PATCH',
					path: '/v1/raw',
					auth: 'none',
					handler: () => new Response('raw', { status: 202, headers: { 'x-raw': '1' } }),
				}),
				defineRoute({ method: 'PUT', path: '/v1/empty', auth: 'none', handler: () => new Response(null, { status: 204 }) }),
				defineRoute({
					method: 'GET',
					path: '/v1/throws',
					auth: 'none',
					handler: () => {
						throw problem('conflict', 'nope', { errors: [{ path: '/a', message: 'bad' }], extensions: { limitName: 'x' } });
					},
				}),
				defineRoute({ method: 'GET', path: '/v1/unknown', auth: 'none', handler: () => problem('not_a_code') }),
				defineRoute({
					method: 'POST',
					path: '/v1/flaky',
					auth: 'none',
					idempotent: true,
					handler: () => {
						flaky += 1;
						if (flaky === 1) throw new Error('db down');
						return created({ n: flaky });
					},
				}),
				defineRoute({ method: 'GET', path: '/v1/no-website', auth: 'none', handler: (ctx) => ctx.data() }),
			],
		});
		expect(await (await call('GET', '/v1/items/n%201?a=1&a=2&b=x')).json()).toEqual({
			id: 'n 1',
			q: { a: '1', b: 'x' },
			all: ['1', '2'],
		});
		expect(await (await call('GET', '/v1/items/special')).json()).toEqual({ special: true });
		expect((await call('DELETE', '/v1/items/1')).status).toBe(204);
		const raw = await call('PATCH', '/v1/raw');
		expect([raw.status, raw.headers.get('x-raw'), await raw.text()]).toEqual([202, '1', 'raw']);
		expect((await call('PUT', '/v1/empty')).status).toBe(204);
		const thrown = await call('GET', '/v1/throws');
		expect(await thrown.json()).toMatchObject({
			status: 409,
			detail: 'nope',
			limitName: 'x',
			errors: [{ path: '/a', message: 'bad' }],
		});
		expect((await call('GET', '/v1/unknown')).status).toBe(500);
		expect((await call('POST', '/v1/flaky', { headers: { 'idempotency-key': 'f1' } })).status).toBe(500);
		expect((await call('POST', '/v1/flaky', { headers: { 'idempotency-key': 'f1' } })).status).toBe(201);
		expect((await call('POST', '/v1/flaky', { headers: { 'idempotency-key': 'f1' } })).status).toBe(409);
		expect((await call('GET', '/v1/no-website')).status).toBe(400);
		expect((await call('GET', '/v1/items/%E0%A4%A')).status).toBe(404);
	});

	it('strips /api in Next.js and schedules work after the response', async () => {
		const { handler, server } = await setup();
		/** @type {Array<() => Promise<unknown>>} */
		const later = [];
		const next = toNextRoute(handler, { after: (task) => later.push(task) });
		expect(Object.keys(next).sort()).toEqual(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
		const response = await next.POST(
			new Request(`${BASE}/api/v1/echo`, { method: 'POST', body: '{"t":2}', headers: { 'content-type': 'application/json' } }),
		);
		expect(await response.json()).toEqual({ body: { t: 2 } });
		expect((await next.GET(new Request(`${BASE}/api`))).status).toBe(404);
		expect((await next.GET(new Request(`${BASE}/docs`))).status).toBe(200);
		await next.GET(new Request(`${BASE}/api/v1/server/open`, { headers: { authorization: `Bearer ${server.token}` } }));
		expect(later.length).toBeGreaterThan(0);
		for (const task of later) await task();
		const raw = toNextRoute(handler, { stripPrefix: false });
		expect((await raw.GET(new Request(`${BASE}/api/docs`))).status).toBe(404);
	});

	it('runs after-response work detached without a scheduler and fails open when the rate store fails', async () => {
		const ctx = await setup();
		const broken = { ...createMemoryStore(), hit: async () => Promise.reject(new Error('down')) };
		const plain = ctx.product.handler([
			defineRoute({ method: 'GET', path: '/x', auth: 'none', rateLimit: { limit: 1, windowSeconds: 60 }, handler }),
		]);
		expect((await plain(new Request(`${BASE}/x`))).status).toBe(200);
		const other = await setup({
			store: broken,
			routes: [defineRoute({ method: 'GET', path: '/x', auth: 'none', rateLimit: { limit: 1, windowSeconds: 60 }, handler })],
		});
		expect((await other.call('GET', '/x')).status).toBe(200);
		expect((await other.call('GET', '/x')).status).toBe(200);
	});
});

describe('logger and helpers', () => {
	it('redacts credentials and serialises errors', () => {
		const out = redact({
			uri: 'mongodb://u:p@h',
			nested: { apiKey: 'k', ok: 1 },
			list: [{ token: 't' }],
			error: Object.assign(new Error('m'), { code: 'c' }),
		});
		expect(out).toEqual({
			uri: '[redacted]',
			nested: { apiKey: '[redacted]', ok: 1 },
			list: [{ token: '[redacted]' }],
			error: { name: 'Error', message: 'm', code: 'c' },
		});
		/** @type {any} */
		let deep = {};
		const root = deep;
		for (let i = 0; i < 10; i += 1) deep = deep.next = {};
		expect(JSON.stringify(redact(root))).toContain('[depth]');
	});

	it('writes JSON lines above the level', () => {
		/** @type {string[]} */
		const lines = [];
		const logger = createLogger({ level: 'info', write: (line) => lines.push(line), now: () => 0, fields: { app: 'x' } });
		logger.debug('hidden');
		logger.info('shown', { secret: 's' });
		logger.child({ requestId: 'r' }).error('child');
		logger.warn('warned');
		expect(lines.map((line) => JSON.parse(line))).toEqual([
			{ level: 'info', time: '1970-01-01T00:00:00.000Z', msg: 'shown', app: 'x', secret: '[redacted]' },
			{ level: 'error', time: '1970-01-01T00:00:00.000Z', msg: 'child', app: 'x', requestId: 'r' },
			{ level: 'warn', time: '1970-01-01T00:00:00.000Z', msg: 'warned', app: 'x' },
		]);
		createLogger({ level: 'nope', write: (line) => lines.push(line) }).info('x');
		expect(lines).toHaveLength(4);
		for (const level of /** @type {const} */ (['debug', 'info', 'warn', 'error'])) noopLogger[level]('x');
		expect(noopLogger.child({})).toBe(noopLogger);
		createLogger({ level: 'silent' }).error('never written');
	});

	it('builds prefixes, omits members and types errors', () => {
		expect(collectionPrefix('coupon-box')).toBe('ss_coupon_box_');
		expect(omit({ a: 1, b: 2 }, ['a'])).toEqual({ b: 2 });
		const error = kitError('x', 'm', { a: 1 });
		expect(isKitError(error, 'x') && isKitError(error) && !isKitError(error, 'y') && !isKitError(new Error('m'))).toBe(true);
	});
});

describe('routes of several features and the permission list', () => {
	it('a route listing features works while any of them is on; /v1/permissions lists the manifest permissions', async () => {
		const routes = [
			...productRoutes(),
			defineRoute({
				method: 'GET',
				path: '/v1/either',
				auth: 'server',
				feature: ['notes', 'inbox'],
				database: false,
				handler: () => ({ either: true }),
			}),
		];
		const env = await setup({ routes });
		const off = await env.call('GET', '/v1/either', { token: env.server.token });
		expect(off.status).toBe(403);
		expect((await off.json()).detail).toBe('The feature notes or inbox is off.');
		await env.switchOn(['notes']);
		expect(await (await env.call('GET', '/v1/either', { token: env.server.token })).json()).toEqual({ either: true });
		const permissions = await env.call('GET', '/v1/permissions', { token: env.server.token });
		expect(await permissions.json()).toEqual({
			permissions: env.product.manifest.permissions.map((/** @type {any} */ p) => ({
				key: p.key,
				name: p.name,
				feature: p.feature,
			})),
		});
		const preflight = await env.call('OPTIONS', '/v1/notes', { origin: 'https://shop.example.com' });
		expect(preflight.headers.get('access-control-allow-headers')).toContain('ss-sign-in');
		expect(() => defineRoute({ method: 'GET', path: '/x', auth: 'server', feature: [], handler: () => 1 })).toThrow(
			/non-empty list/,
		);
	});
});
