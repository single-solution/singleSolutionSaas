import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveStrings, standardRoutes } from '../src/index.js';
import { WEBSITE, entitle, setup, websiteKey } from './helpers.js';
import { startMongo } from './mongo.js';

const BASE = 'https://coupons.example.dev';
const ORIGIN = 'https://shop.example.com';

/** @type {Awaited<ReturnType<typeof startMongo>>} */
let mongo;
beforeAll(async () => {
	mongo = await startMongo();
}, 120_000);
afterAll(async () => {
	await mongo?.stop();
});

/** @param {Response} response */
const body = async (response) => JSON.parse(await response.text());

const orderEvent = (/** @type {Record<string, any>} */ overrides = {}) => ({
	id: 'evt_0123456789abcdefghjkmnpq',
	type: 'order.placed@1',
	occurredAt: '2026-10-01T10:00:00Z',
	idempotencyKey: 'order-1',
	actor: { type: 'customer', id: 'cus_1' },
	data: {
		orderId: 'ord_1',
		currency: 'EUR',
		amounts: { subtotal: 100, total: 100 },
		lines: [{ itemId: 'itm_1', quantity: 1, unitAmount: 100 }],
	},
	...overrides,
});

const app = async (/** @type {Record<string, any>} */ overrides = {}, /** @type {any} */ routeOptions = undefined) => {
	const env = await setup({ overrides });
	await entitle(env.portal, { experiments: [{ element: 'codes', variant: 'b' }] });
	const pk = await websiteKey(env.portal);
	const handle = env.product.handler(standardRoutes(env.product, routeOptions));
	/** @param {string} path @param {RequestInit} [init] */
	const call = (path, init = {}) => handle(new Request(`${BASE}${path}`, init));
	/** @param {string} path @param {RequestInit} [init] */
	const site = (path, init = {}) =>
		call(path, {
			...init,
			headers: { authorization: `Bearer ${pk}`, origin: ORIGIN, .../** @type {any} */ (init.headers ?? {}) },
		});
	return { ...env, handle, call, site, pk };
};

describe('dev probes', () => {
	it('are mounted only with devProbes outside production', async () => {
		const off = await app();
		expect((await off.site('/v1/ss-probe/data-guard')).status).toBe(404);
		const prod = await app({ devProbes: true, nodeEnv: 'production' });
		expect((await prod.site('/v1/ss-probe/data-guard')).status).toBe(404);
	});

	it('report the data guard and event effects', async () => {
		const { site, portal, product } = await app({ devProbes: true, nodeEnv: 'development' });
		// without a database: the guard runs over a stub
		expect(await body(await site('/v1/ss-probe/data-guard'))).toEqual({ rejected: true, code: 'tenant_guard' });
		portal.setResource(WEBSITE, 'database', { uri: mongo.uriFor('probe_1') });
		expect(await body(await site('/v1/ss-probe/data-guard'))).toEqual({ rejected: true, code: 'tenant_guard' });
		let runs = 0;
		product.events.on('order.placed@1', () => {
			runs += 1;
		});
		const event = { ...orderEvent(), websiteId: WEBSITE, env: 'live' };
		for (const delivery of [
			await portal.signEvent(event),
			await portal.signEvent({ ...event, context: { source: 'portal' } }),
		]) {
			expect((await product.events.handle({ headers: delivery.headers, rawBody: delivery.body })).status).toBe(200);
		}
		expect(runs).toBe(1);
		expect(await body(await site(`/v1/ss-probe/events/${event.id}`))).toEqual({ id: event.id, effects: 1 });
		expect(await body(await site('/v1/ss-probe/events/evt_none'))).toEqual({ id: 'evt_none', effects: 0 });
		await product.close();
	});
});

describe('standard routes', () => {
	it('GET /v1/entitlement returns the cached document summary', async () => {
		const { site } = await app();
		const res = await site('/v1/entitlement');
		expect(res.status).toBe(200);
		expect(await body(res)).toMatchObject({
			websiteId: WEBSITE,
			productSlug: 'coupon-box',
			version: 1,
			stale: false,
			planCode: null,
			runtime: { state: 'active' },
			elements: { codes: { enabled: true } },
			features: { 'codes.maxActive': 50 },
			experiments: [{ element: 'codes', variant: 'b' }],
		});
	});

	it('GET /v1/config returns config for enabled elements only', async () => {
		const { site } = await app();
		expect(await body(await site('/v1/config'))).toEqual({
			version: 1,
			stale: false,
			elements: { codes: { config: { prefix: 'SAVE' }, features: { maxActive: 50 }, variant: 'b' } },
		});
		expect(await body(await site('/v1/config?element=codes'))).toMatchObject({ elements: { codes: { variant: 'b' } } });
		expect((await site('/v1/config?element=bulk')).status).toBe(403);
		expect((await site('/v1/config?element=nope')).status).toBe(404);
	});

	it('POST /v1/events validates, binds to the key and dispatches once', async () => {
		const { site, product } = await app();
		/** @type {any[]} */
		const seen = [];
		product.events.on('order.placed', (/** @type {any} */ event, /** @type {any} */ meta) => {
			seen.push([event.websiteId, event.env, meta.source, meta.website.websiteId]);
		});
		const post = (/** @type {unknown} */ payload) =>
			site('/v1/events', { method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } });
		const accepted = await post(orderEvent());
		expect(accepted.status).toBe(202);
		expect(await body(accepted)).toEqual({ accepted: 1, duplicates: 0 });
		expect(
			await body(await post({ events: [orderEvent(), orderEvent({ id: 'evt_2', type: 'coupon_box.applied@1', data: {} })] })),
		).toEqual({ accepted: 1, duplicates: 1 });
		expect(seen).toEqual([[WEBSITE, 'live', 'site', WEBSITE]]);
		const invalid = await post({
			events: [
				orderEvent({ websiteId: 'web_1123456789abcdefghjkmnpq' }),
				orderEvent({ env: 'test' }),
				'x',
				orderEvent({ type: 'customer.created@1', data: { customerId: 'cus_1' } }),
				orderEvent({ data: {} }),
			],
		});
		const problemDoc = await body(invalid);
		expect(problemDoc).toMatchObject({ status: 422, type: `${BASE}/problems/invalid_event` });
		expect(problemDoc.errors.map((/** @type {any} */ e) => e.path)).toEqual(
			expect.arrayContaining(['/events/0/websiteId', '/events/1/env', '/events/2', '/events/3/type']),
		);
		expect((await post({ events: [] })).status).toBe(400);
		expect((await post([])).status).toBe(400);
		expect((await post({ events: Array.from({ length: 101 }, () => orderEvent()) })).status).toBe(413);
	});

	it('GET /v1/strings resolves languages with fallback', async () => {
		const { call } = await app({ strings: { en: { hello: 'Hello' }, pt: { hello: 'Olá' } } });
		expect(await body(await call('/v1/strings?lang=pt-BR'))).toEqual({ lang: 'pt', strings: { hello: 'Olá' } });
		expect(await body(await call('/v1/strings'))).toEqual({ lang: 'en', strings: { hello: 'Hello' } });
		expect(await body(await call('/api/v1/strings?lang=pt'))).toMatchObject({ title: 'Not found' });
		expect((await call('/v1/strings?lang=../x')).status).toBe(400);
		expect(await resolveStrings(async (/** @type {string} */ lang) => (lang === 'fr' ? { a: 'b' } : null), 'fr-CA')).toEqual({
			lang: 'fr',
			strings: { a: 'b' },
		});
		expect(await resolveStrings(undefined, 'de')).toEqual({ lang: 'en', strings: {} });
	});

	it('health endpoints', async () => {
		const { call, portal } = await app();
		expect(await body(await call('/healthz'))).toEqual({ status: 'ok', product: 'coupon-box', version: '1.4.0' });
		expect(await body(await call('/readyz'))).toMatchObject({
			status: 'ok',
			checks: { portal: { ok: true, cached: false }, productDb: { ok: true } },
		});
		portal.setDown(true);
		expect(await body(await call('/readyz'))).toMatchObject({ status: 'ok', checks: { portal: { cached: true } } });
	});

	it('well-known manifest, events passthrough, and toggles', async () => {
		const { call, portal } = await app();
		const served = await call('/.well-known/ss-app.json');
		expect(served.headers.get('cache-control')).toBe('public, max-age=300');
		expect(served.headers.get('ss-manifest-signature')).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
		expect((await body(served)).product.slug).toBe('coupon-box');
		const delivery = await portal.signEvent({ ...orderEvent(), websiteId: WEBSITE, env: 'live' });
		const res = await call('/.well-known/ss-events', { method: 'POST', body: delivery.body, headers: delivery.headers });
		expect(await body(res)).toEqual({ received: true });
		const bare = await app({}, { wellKnown: false, sso: false });
		expect((await bare.call('/.well-known/ss-app.json')).status).toBe(404);
		expect((await bare.call('/sso?launch=x')).status).toBe(404);
	});

	it('GET /sso exchanges a launch for a session cookie', async () => {
		const { call, portal } = await app();
		const { token } = await portal.issueLaunch({
			subject: 'usr_1',
			kind: 'merchant',
			user: { id: 'usr_1' },
			scope: { merchantId: 'mer_1' },
		});
		const res = await call(`/sso?launch=${token}`);
		expect(res.status).toBe(303);
		expect(res.headers.get('location')).toBe('/dashboard');
		expect(res.headers.get('set-cookie')).toMatch(
			/^ss_session=ses_[A-Za-z0-9_-]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=\d+$/,
		);
		expect((await call(`/sso?launch=${token}`)).status).toBe(401);
		expect((await call('/sso')).status).toBe(401);
	});

	it('data:export / data:anonymize require a Portal signature and use declared collections', async () => {
		const { call, portal, product } = await app({
			privacy: {
				collections: [
					{ name: 'redemptions', fields: ['email'] },
					{ name: 'orphans', subjectField: 'visitorId' },
				],
			},
		});
		portal.setResource(WEBSITE, 'database', { uri: mongo.uriFor('privacy_1') });
		const scope = await product.data.forWebsite(WEBSITE);
		await scope.collection('redemptions').insertMany([
			{ customerId: 'cus_1', email: 'a@x.test' },
			{ customerId: 'cus_2', email: 'b@x.test' },
		]);
		const signed = async (/** @type {string} */ path, /** @type {unknown} */ payload) => {
			const { headers, body: raw } = await portal.signRequest({ method: 'POST', path, body: payload });
			return call(path, { method: 'POST', body: raw, headers });
		};
		expect(
			(await call('/v1/data:export', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status,
		).toBe(401);
		const all = await body(await signed('/v1/data:export', { websiteId: WEBSITE }));
		expect(all.collections.redemptions).toHaveLength(2);
		const one = await body(
			await signed('/v1/data:export', { websiteId: WEBSITE, subject: { customerId: 'cus_1' }, requestId: 'r1' }),
		);
		expect(one.collections.redemptions).toHaveLength(1);
		expect(one.collections.orphans).toBeUndefined();
		expect(await body(await signed('/v1/data:anonymize', { websiteId: WEBSITE, subject: { customerId: 'cus_1' } }))).toEqual({
			websiteId: WEBSITE,
			anonymized: { redemptions: 1 },
		});
		expect(await scope.collection('redemptions').findOne({ websiteId: WEBSITE, customerId: 'cus_1' })).toMatchObject({
			email: null,
		});
		expect((await signed('/v1/data:anonymize', { websiteId: WEBSITE })).status).toBe(400);
		expect((await signed('/v1/data:export', { nope: 1 })).status).toBe(400);
		// a request signed for export cannot be replayed against anonymize, another method, query or product
		const exportSigned = await portal.signRequest({
			method: 'POST',
			path: '/v1/data:export',
			body: { websiteId: WEBSITE, subject: { customerId: 'cus_2' } },
		});
		expect(
			(await call('/v1/data:anonymize', { method: 'POST', body: exportSigned.body, headers: exportSigned.headers })).status,
		).toBe(401);
		const otherApp = await portal.signRequest({
			method: 'POST',
			path: '/v1/data:export',
			body: { websiteId: WEBSITE },
			audience: 'app_other',
		});
		expect((await call('/v1/data:export', { method: 'POST', body: otherApp.body, headers: otherApp.headers })).status).toBe(
			401,
		);
		const withQuery = await portal.signRequest({
			method: 'POST',
			path: '/v1/data:export?b=2&a=1',
			body: { websiteId: WEBSITE },
		});
		expect(
			(await call('/v1/data:export?a=1&b=2', { method: 'POST', body: withQuery.body, headers: withQuery.headers })).status,
		).toBe(200);
		const eventSigned = await portal.signEvent({ websiteId: WEBSITE });
		expect(
			(await call('/v1/data:export', { method: 'POST', body: eventSigned.body, headers: eventSigned.headers })).status,
		).toBe(401);
		await product.close();
	});

	it('data handlers default to 501 and accept custom handlers', async () => {
		const none = await app();
		const sign = async (/** @type {any} */ env, /** @type {string} */ path, /** @type {unknown} */ payload) => {
			const { headers, body: raw } = await env.portal.signRequest({ method: 'POST', path, body: payload });
			return env.call(path, { method: 'POST', body: raw, headers });
		};
		expect((await sign(none, '/v1/data:export', { websiteId: WEBSITE })).status).toBe(501);
		expect((await sign(none, '/v1/data:anonymize', { websiteId: WEBSITE, subject: { customerId: 'c' } })).status).toBe(501);
		const custom = await app({ privacy: { export: async () => ({ custom: true }), anonymize: async () => ({ done: true }) } });
		expect(await body(await sign(custom, '/v1/data:export', { websiteId: WEBSITE }))).toEqual({ custom: true });
		expect(await body(await sign(custom, '/v1/data:anonymize', { websiteId: WEBSITE, subject: { customerId: 'c' } }))).toEqual({
			done: true,
		});
	});
});
