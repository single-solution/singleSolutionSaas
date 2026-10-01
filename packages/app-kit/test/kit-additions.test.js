import { describe, expect, it, vi } from 'vitest';
import {
	createBackground,
	defineRoute,
	detectRuntime,
	feature,
	ok,
	paginate,
	problem,
	standardRoutes,
	toNextRoute,
} from '../src/index.js';
import { WEBSITE, entitle, setup, websiteKey } from './helpers.js';

const BASE = 'https://coupons.example.dev';

/** @param {string} path @param {RequestInit} [init] */
const req = (path, init = {}) => new Request(`${BASE}${path}`, init);

describe('portal.publishEvent through the durable outbox', () => {
	it('sends right away, derives a stable id and dedupes a repeated publish', async () => {
		const { portal, product } = await setup();
		await entitle(portal);
		const input = { websiteId: WEBSITE, type: 'coupon_box.redeemed@1', data: { code: 'A' }, idempotencyKey: 'r-1' };
		const first = await product.portal.publishEvent(input);
		const again = await product.portal.publishEvent(input);
		expect(again.id).toBe(first.id);
		expect(first.id).toMatch(/^evt_[0-9a-z]{26}$/);
		expect(portal.published).toHaveLength(1);
		expect(await product.outbox.stats()).toEqual({ pending: 0, sent: 1, dead: 0 });
		const other = await product.portal.publishEvent({ ...input, idempotencyKey: 'r-2' });
		expect(other.id).not.toBe(first.id);
		const explicit = await product.portal.publishEvent({
			...input,
			idempotencyKey: 'r-3',
			id: 'evt_0123456789abcdefghjkmnpqrs',
		});
		expect(explicit.id).toBe('evt_0123456789abcdefghjkmnpqrs');
	});

	it('queues during a Portal outage and delivers with backoff on flush; rejections are dead-lettered', async () => {
		const { portal, product, clock } = await setup();
		await entitle(portal);
		await product.entitlements.forWebsite(WEBSITE);
		portal.setDown(true);
		const envelope = await product.portal.publishEvent({
			websiteId: WEBSITE,
			type: 'coupon_box.redeemed@1',
			data: {},
			idempotencyKey: 'down-1',
		});
		expect(envelope.type).toBe('coupon_box.redeemed@1');
		expect(await product.outbox.stats()).toMatchObject({ pending: 1 });
		portal.setDown(false);
		expect((await product.outbox.flush()).sent).toBe(0); // still backing off
		clock.advance(5_000);
		expect(await product.outbox.flush()).toMatchObject({ sent: 1, batches: 1 });
		expect(await product.outbox.stats()).toEqual({ pending: 0, sent: 1, dead: 0 });

		portal.rejectEventType('coupon_box.redeemed@1');
		await product.portal.publishEvent({ websiteId: WEBSITE, type: 'coupon_box.redeemed@1', data: {}, idempotencyKey: 'bad-1' });
		expect(await product.outbox.stats()).toMatchObject({ dead: 1 });
	});

	it('dead-letters a permanent 4xx on flush and retries 5xx', async () => {
		const { portal, product, clock } = await setup();
		await entitle(portal);
		await product.entitlements.forWebsite(WEBSITE);
		portal.failNext('/v1/product/events', 503);
		await product.portal.publishEvent({ websiteId: WEBSITE, type: 'coupon_box.redeemed@1', data: {}, idempotencyKey: 'a' });
		clock.advance(5_000);
		portal.failNext('/v1/product/events', 503);
		expect(await product.outbox.flush()).toMatchObject({ failed: 1 });
		clock.advance(60_000);
		portal.failNext('/v1/product/events', 422);
		expect(await product.outbox.flush()).toMatchObject({ rejected: 1 });
		expect(await product.outbox.stats()).toMatchObject({ pending: 0, dead: 1 });
	});
});

describe('background flushing', () => {
	it('detects serverless platforms', () => {
		expect(detectRuntime({ VERCEL: '1' })).toBe('serverless');
		expect(detectRuntime({ AWS_LAMBDA_FUNCTION_NAME: 'f' })).toBe('serverless');
		expect(detectRuntime({})).toBe('server');
		const logger = /** @type {any} */ ({ warn: () => {} });
		expect(() => createBackground({ tasks: [], logger, intervalMs: 10 })).toThrow(RangeError);
		expect(() => createBackground({ tasks: [], logger, everyRequests: 0 })).toThrow(RangeError);
	});

	it('server mode: an unref’d timer starts with the first request and stops on close', async () => {
		/** @type {Array<() => void>} */
		const timers = [];
		const unref = vi.fn();
		const clear = vi.fn();
		const run = vi.fn(async () => {});
		const failing = vi.fn(async () => Promise.reject(new Error('x')));
		const warn = vi.fn();
		const background = createBackground({
			tasks: [
				{ name: 'a', run: failing },
				{ name: 'b', run },
			],
			mode: 'server',
			logger: /** @type {any} */ ({ warn }),
			setInterval: (fn) => {
				timers.push(fn);
				return { unref };
			},
			clearInterval: clear,
		});
		expect(background.mode).toBe('server');
		background.afterRequest(null);
		background.afterRequest(null);
		expect(timers).toHaveLength(1);
		expect(unref).toHaveBeenCalled();
		timers[0]?.();
		await background.tick();
		expect(run).toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith('background flush failed', expect.objectContaining({ task: 'a' }));
		background.stop();
		expect(clear).toHaveBeenCalled();
	});

	it('serverless mode: flushes after requests that queued something (via after()), else every Nth request', async () => {
		const run = vi.fn(async () => {});
		const background = createBackground({
			tasks: [{ name: 'q', run }],
			mode: 'serverless',
			everyRequests: 3,
			logger: /** @type {any} */ ({ warn: () => {} }),
		});
		/** @type {Array<() => Promise<unknown>>} */
		const scheduled = [];
		const after = (/** @type {() => Promise<unknown>} */ task) => {
			scheduled.push(task);
		};
		background.afterRequest(after);
		expect(scheduled).toHaveLength(0);
		background.markDirty();
		background.afterRequest(after);
		expect(scheduled).toHaveLength(1);
		await scheduled[0]?.();
		expect(run).toHaveBeenCalledTimes(1);
		background.afterRequest(after); // 3rd request
		expect(scheduled).toHaveLength(2);
		await scheduled[1]?.();
		// a throwing after() (outside a request scope) falls back to a background run
		background.markDirty();
		background.afterRequest(() => {
			throw new Error('outside request');
		});
		await background.tick();
		expect(run).toHaveBeenCalledTimes(3);
		background.afterRequest(undefined); // off-cycle, clean: nothing
		const off = createBackground({ tasks: [{ name: 'q', run }], mode: 'off', logger: /** @type {any} */ ({}) });
		off.markDirty();
		off.afterRequest(after);
		expect(scheduled).toHaveLength(2);
	});

	it('wires into the product: usage recorded in a request is flushed after it (Next after) and by heartbeat', async () => {
		const { portal, product } = await setup({ overrides: { background: { mode: 'serverless', everyRequests: 1000 } } });
		await entitle(portal);
		const sk = await websiteKey(portal, { kind: 'sk', keyId: 'key_2' });
		const handle = product.handler([
			defineRoute({
				method: 'POST',
				path: '/v1/redeem',
				auth: 'website',
				idempotent: false,
				handler: async (ctx) => {
					await ctx.product.usage.record({
						websiteId: ctx.websiteId,
						unit: 'redemption',
						quantity: 1,
						idempotencyKey: 'u-1',
					});
					return ok({ ok: true });
				},
			}),
		]);
		/** @type {Array<() => Promise<unknown>>} */
		const scheduled = [];
		const next = toNextRoute(handle, { after: (task) => scheduled.push(task) });
		const res = await next.POST(req('/api/v1/redeem', { method: 'POST', headers: { authorization: `Bearer ${sk}` } }));
		expect(res.status).toBe(200);
		expect(scheduled).toHaveLength(1);
		await scheduled[0]?.();
		expect(portal.usage.size).toBe(1);
		await product.usage.record({ websiteId: WEBSITE, unit: 'redemption', quantity: 1, idempotencyKey: 'u-2' });
		await product.heartbeat();
		expect(portal.usage.size).toBe(2);
		expect(product.background.mode).toBe('serverless');
		await product.flush();
		await product.close();
	});
});

describe('dynamic rate limits', () => {
	it('evaluates limit(ctx) per request and shares a bucket between routes', async () => {
		const { portal, product } = await setup();
		await entitle(portal);
		const sk = await websiteKey(portal, { kind: 'sk', keyId: 'key_2' });
		const limit = (/** @type {any} */ ctx) => Number(feature(ctx.entitlement.doc, 'codes.maxActive')) / 25; // 50 → 2
		const handle = product.handler([
			defineRoute({
				method: 'GET',
				path: '/v1/a',
				auth: 'website',
				rateLimit: { limit, windowSeconds: 60, bucket: 'shared' },
				handler: () => ok({}),
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/b',
				auth: 'website',
				rateLimit: { limit, windowSeconds: 60, bucket: 'shared' },
				handler: () => ok({}),
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/free',
				auth: 'website',
				rateLimit: { limit: async () => Number.POSITIVE_INFINITY, windowMs: 1000, key: async () => 'k' },
				handler: () => ok({}),
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/closed',
				auth: 'website',
				rateLimit: { limit: () => 0, windowMs: 1000 },
				handler: () => ok({}),
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/broken',
				auth: 'website',
				rateLimit: { limit: () => 1.5, windowMs: 1000 },
				handler: () => ok({}),
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/throws',
				auth: 'website',
				rateLimit: {
					limit: () => {
						throw new Error('x');
					},
					windowMs: 1000,
				},
				handler: () => ok({}),
			}),
		]);
		const get = (/** @type {string} */ path) => handle(req(path, { headers: { authorization: `Bearer ${sk}` } }));
		expect((await get('/v1/a')).headers.get('ratelimit-limit')).toBe('2');
		expect((await get('/v1/b')).status).toBe(200);
		const third = await get('/v1/a');
		expect(third.status).toBe(429);
		expect(third.headers.get('retry-after')).toBeTruthy();
		for (let i = 0; i < 5; i += 1) expect((await get('/v1/free')).status).toBe(200);
		expect((await get('/v1/closed')).status).toBe(429);
		expect((await get('/v1/broken')).status).toBe(200);
		expect((await get('/v1/throws')).status).toBe(200);
		expect(() =>
			defineRoute({
				method: 'GET',
				path: '/',
				auth: 'none',
				rateLimit: { limit: 1, windowMs: 1, bucket: 'bad bucket' },
				handler: ok,
			}),
		).toThrow(/bucket/);
		expect(() =>
			defineRoute(
				/** @type {any} */ ({
					method: 'GET',
					path: '/',
					auth: 'none',
					rateLimit: { limit: 1, windowMs: 1, key: 'x' },
					handler: ok,
				}),
			),
		).toThrow(/key/);
	});
});

describe('problem extensions', () => {
	it('adds RFC 9457 extension members without clobbering standard members', async () => {
		const { product } = await setup();
		const handle = product.handler([
			defineRoute({
				method: 'GET',
				path: '/v1/x',
				auth: 'none',
				handler: () => problem('rate_limited', 'Slow down.', { extensions: { retryAfterSeconds: 30, limits: { daily: 5 } } }),
			}),
		]);
		const res = await handle(req('/v1/x'));
		expect(await res.json()).toMatchObject({ status: 429, detail: 'Slow down.', retryAfterSeconds: 30, limits: { daily: 5 } });
		expect(problem('bad_request', 'x', { extensions: {} })).not.toHaveProperty('extensions');
		for (const name of ['status', 'type', 'requestId', 'errors']) {
			expect(() => problem('bad_request', 'x', { extensions: { [name]: 1 } })).toThrow(TypeError);
		}
		expect(() => problem('bad_request', 'x', { extensions: { ab: 1 } })).toThrow(/name/);
		expect(() => problem('bad_request', 'x', { extensions: { '9lives': 1 } })).toThrow(/name/);
		expect(() => problem('bad_request', 'x', { extensions: { fine: undefined } })).toThrow(/JSON/);
		expect(() => problem('bad_request', 'x', { extensions: /** @type {any} */ ([1]) })).toThrow(/object/);
	});
});

describe('compound keyset cursors', () => {
	it('encodes an array key opaquely and returns it as `after`', () => {
		const rows = [
			{ at: new Date('2026-10-01T00:00:03Z'), id: 'c' },
			{ at: new Date('2026-10-01T00:00:02Z'), id: 'b' },
			{ at: new Date('2026-10-01T00:00:02Z'), id: 'a' },
		];
		const first = paginate({ limit: 2 });
		const page = first.page(rows, (r) => [r.at, r.id]);
		expect(page.hasMore).toBe(true);
		expect(page.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
		const next = paginate({ cursor: page.nextCursor, limit: 2 });
		expect(next.after).toEqual(['2026-10-01T00:00:02.000Z', 'b']);
		expect(paginate({ cursor: paginate({ limit: 1 }).page([{ id: 1 }, { id: 2 }]).nextCursor }).after).toBe(1);
		const bad = Buffer.from(JSON.stringify({ k: [{ nested: true }] })).toString('base64url');
		expect(() => paginate({ cursor: bad })).toThrow();
		expect(() => paginate({ cursor: Buffer.from(JSON.stringify({ k: [] })).toString('base64url') })).toThrow();
		expect(() => first.page([...rows, ...rows], () => [])).toThrow(TypeError);
		expect(() => first.page([...rows], () => ({}))).toThrow(TypeError);
	});
});

describe('product.outbound.fetch', () => {
	it('is the SSRF-guarded fetch under the product policy', async () => {
		const { product } = await setup();
		await expect(product.outbound.fetch('http://127.0.0.2/x')).rejects.toMatchObject({ code: expect.any(String) });
		await expect(product.outbound.fetch('https://10.0.0.1/x')).rejects.toMatchObject({ code: 'ssrf_blocked' });
		const send = vi.fn(async () => ({ status: 200, headers: {}, body: Buffer.from('ok'), url: 'https://example.com/' }));
		const { product: stubbed } = await setup({ overrides: { outboundSend: send } });
		expect((await stubbed.outbound.fetch('https://example.com/')).status).toBe(200);
		expect(send).toHaveBeenCalledWith('https://example.com/', undefined);
		expect(stubbed.outbound.policy).toBeDefined();
	});
});

describe('standard routes still work with the kit additions', () => {
	it('serves healthz', async () => {
		const { product } = await setup();
		const handle = product.handler(standardRoutes(product));
		expect((await handle(req('/healthz'))).status).toBe(200);
	});
});
