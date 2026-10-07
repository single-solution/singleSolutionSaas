import { describe, expect, it } from 'vitest';
import { resolveStrings, standardRoutes } from '../src/index.js';
import { WEBSITE, entitle, setup, websiteKey } from './helpers.js';

const BASE = 'https://coupons.example.dev';
const ORIGIN = 'https://shop.example.com';

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
	await entitle(env.portal);
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

describe('standard routes', () => {
	it('GET /v1/entitlement returns the cached document summary', async () => {
		const { site } = await app();
		const res = await site('/v1/entitlement');
		expect(res.status).toBe(200);
		expect(await res.clone().json()).not.toHaveProperty('experiments');
		expect(await body(res)).toMatchObject({
			websiteId: WEBSITE,
			productSlug: 'coupon-box',
			version: 1,
			stale: false,
			planCode: null,
			runtime: { state: 'active' },
			elements: { codes: { enabled: true } },
			features: { 'codes.maxActive': 50 },
		});
	});

	it('GET /v1/config returns config for enabled elements only', async () => {
		const { site } = await app();
		expect(await body(await site('/v1/config'))).toEqual({
			version: 1,
			stale: false,
			elements: { codes: { config: { prefix: 'SAVE' }, features: { maxActive: 50 } } },
		});
		expect(await body(await site('/v1/config?element=codes'))).toMatchObject({
			elements: { codes: { config: { prefix: 'SAVE' } } },
		});
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

	it('well-known manifest, events passthrough, and toggles', async () => {
		const { call, portal } = await app();
		const served = await call('/.well-known/ss-app.json');
		expect(served.headers.get('cache-control')).toBe('public, max-age=300');
		expect(served.headers.get('ss-manifest-signature')).toBeNull();
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
});
