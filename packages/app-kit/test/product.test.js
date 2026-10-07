import { describe, expect, it } from 'vitest';
import { createAudit, createPortalClient, createProduct } from '../src/index.js';
import { createSigner, generateSigningKey } from '@ss/protocol';
import { PORTAL_URL, WEBSITE, createClock, entitle, manifest, setup } from './helpers.js';
import { createFakePortal, entitlementPayload } from '../src/testing.js';

describe('createProduct', () => {
	it('validates the manifest, the product kind and the signing key', async () => {
		const { privateJwk, publicJwk } = await generateSigningKey({ kid: 'k' });
		const base = { portalUrl: PORTAL_URL, signingKey: privateJwk };
		expect(() => createProduct({ ...base, manifest: /** @type {any} */ ({ ssps: '1' }) })).toThrow(/manifest is invalid/);
		const pack = {
			ssps: '1',
			product: { slug: 'notice-bar', name: 'Notice', kind: 'pack', version: '0.1.0', category: 'storefront' },
			elements: [
				{
					key: 'bar',
					name: 'Bar',
					modes: ['A', 'B'],
					price: { hourly: 0 },
					placement: true,
					headless: 'h.js#c',
					renderer: 'r.js#r',
				},
			],
			priceBook: { version: '1', effectiveFrom: '2026-10-01T00:00:00Z' },
		};
		expect(() => createProduct({ ...base, manifest: /** @type {any} */ (pack) })).toThrow(/service products/);
		expect(() => createProduct({ ...base, manifest: manifest(), portalUrl: /** @type {any} */ (5) })).toThrow(/portalUrl/);
		expect(() => createProduct({ ...base, manifest: manifest(), signingKey: 'not json' })).toThrow(/signingKey/);
		expect(() => createProduct({ ...base, manifest: manifest(), signingKey: '[1]' })).toThrow(/signingKey/);
		expect(() => createProduct({ ...base, manifest: manifest(), signingKey: /** @type {any} */ (publicJwk) })).toThrow(
			/private member/,
		);
		const product = createProduct({ ...base, manifest: manifest(), signingKey: `${privateJwk.kid}:${privateJwk.d}` });
		expect(await product.manifestRoute()).toEqual({
			status: 200,
			body: manifest(),
			headers: { 'cache-control': 'public, max-age=300' },
		});
	});

	it('serves the manifest unsigned once connected too', async () => {
		const { product } = await setup();
		const served = await product.manifestRoute();
		expect(served.headers).toEqual({ 'cache-control': 'public, max-age=300' });
		expect(served.body.product.slug).toBe(manifest().product.slug);
	});

	it('publishes events through the signed client', async () => {
		const { portal, product } = await setup();
		await entitle(portal);
		const envelope = await product.portal.publishEvent({
			websiteId: WEBSITE,
			type: 'coupon_box.redeemed@1',
			data: { code: 'A' },
			idempotencyKey: 'redeem-1',
		});
		expect(envelope).toMatchObject({
			type: 'coupon_box.redeemed@1',
			websiteId: WEBSITE,
			env: 'live',
			actor: { type: 'product', id: 'coupon-box' },
			context: { source: 'product', product: 'coupon-box' },
		});
		expect(envelope.id).toMatch(/^evt_/);
		expect(portal.published).toEqual([{ events: [envelope] }]);
		await product.portal.publishEvent({
			websiteId: 'web_9999999999abcdefghjkmnpq',
			env: 'test',
			type: 'coupon_box.redeemed@1',
			data: {},
			idempotencyKey: 'k',
			occurredAt: '2026-10-01T00:00:00Z',
			context: { element: 'codes' },
		});
		await expect(
			product.portal.publishEvent({ websiteId: WEBSITE, type: 'other.thing@1', data: {}, idempotencyKey: 'k' }),
		).rejects.toMatchObject({ code: 'invalid_event' });
		await expect(
			product.portal.publishEvent({
				websiteId: 'web_9999999999abcdefghjkmnpq',
				type: 'coupon_box.redeemed@1',
				data: {},
				idempotencyKey: 'k',
			}),
		).rejects.toMatchObject({ code: 'invalid_event' });
		await expect(
			product.portal.publishEvent({ websiteId: WEBSITE, type: 'coupon_box.redeemed@1', data: {}, idempotencyKey: '' }),
		).rejects.toMatchObject({ code: 'invalid_event' });
		await product.portal.publishEvents([]);
		expect(await product.portal.consumeLaunch({ jti: 'j' })).toEqual({ consumed: true });
	});

	it('requests to become a website identity issuer: pending until the merchant approves, then active', async () => {
		const { portal, product } = await setup();
		const body = {
			issuer: 'https://coupons.example.dev/i/web',
			jwksUrl: 'https://coupons.example.dev/jwks.json',
			audience: WEBSITE,
			claimMap: { subject: 'sub', email: 'email' },
		};
		const input = { websiteId: WEBSITE, ...body };
		const first = await product.portal.requestIdentityIssuer(input);
		expect(first).toMatchObject({ status: 'pending', request: { websiteId: WEBSITE, issuer: input.issuer } });
		expect(portal.calls.at(-1)).toEqual({
			method: 'PUT',
			path: `/v1/product/websites/${WEBSITE}/identity`,
			appId: 'app_test',
		});
		expect(portal.identityRequests.get(WEBSITE)).toEqual({ status: 'pending', appId: 'app_test', input: body });
		expect(portal.decideIdentityRequest(WEBSITE, 'approve')).toMatchObject({ status: 'approved' });
		expect(portal.decideIdentityRequest(WEBSITE, 'approve')).toBeNull();
		expect(await product.portal.requestIdentityIssuer(input)).toEqual({ status: 'active', issuer: body });
		// undefined members are not sent; a refusal surfaces as portal_error 403
		await product.portal.requestIdentityIssuer({ ...input, audience: undefined, issuer: 'https://other.example/' });
		expect(portal.identityRequests.get(WEBSITE)?.input).not.toHaveProperty('audience');
		portal.refuseIdentityRequests(WEBSITE);
		await expect(product.portal.requestIdentityIssuer(input)).rejects.toMatchObject({
			code: 'portal_error',
			details: { status: 403, problem: 'forbidden' },
		});
		await expect(product.portal.requestIdentityIssuer({ ...input, websiteId: '' })).rejects.toMatchObject({
			code: 'invalid_argument',
		});
	});

	it('uses custom problem base URIs and codes', async () => {
		const { product } = await setup({
			overrides: {
				problemBaseUri: 'https://errors.example.dev',
				problemCodes: { coupon_expired: { status: 410, title: 'Coupon expired' } },
			},
		});
		const { defineRoute, problem } = await import('../src/index.js');
		const handle = product.handler([
			defineRoute({ method: 'GET', path: '/x', auth: 'none', handler: () => problem('coupon_expired') }),
		]);
		const res = await handle(new Request('https://h/x'));
		expect(await res.json()).toMatchObject({
			type: 'https://errors.example.dev/coupon_expired',
			status: 410,
			title: 'Coupon expired',
		});
	});
});

describe('portal client', () => {
	it('maps errors, timeouts and malformed responses', async () => {
		const clock = createClock();
		const { privateJwk } = await generateSigningKey({ kid: 'p' });
		const signer = createSigner(privateJwk);
		/** @type {Array<() => Response | Promise<Response>>} */
		const answers = [];
		const client = createPortalClient({
			portalUrl: 'https://portal.test/',
			appId: () => 'app_1',
			signer,
			now: clock.now,
			fetch: /** @type {any} */ (
				async () => {
					const next = answers.shift();
					if (!next) throw new TypeError('down');
					return next();
				}
			),
		});
		expect(client.baseUrl).toBe('https://portal.test');
		await expect(client.jwks()).rejects.toMatchObject({ code: 'portal_unreachable' });
		answers.push(() => {
			throw Object.assign(new Error('t'), { name: 'TimeoutError' });
		});
		await expect(client.jwks()).rejects.toMatchObject({ code: 'portal_timeout' });
		answers.push(() => new Response('not json', { status: 200 }));
		await expect(client.jwks()).rejects.toMatchObject({ code: 'portal_error' });
		answers.push(() => new Response('', { status: 200 }));
		expect(await client.publishEvents([])).toBeNull();
		answers.push(() => new Response('[]', { status: 200 }));
		await expect(client.revocations()).rejects.toMatchObject({ code: 'portal_error' });
		answers.push(() => new Response('{"keyIds":["a",1]}', { status: 200 }));
		expect(await client.revocations({ since: '4' })).toEqual({ keyIds: ['a'], cursor: '4' });
		answers.push(() => new Response('{}', { status: 200 }));
		await expect(client.entitlements(WEBSITE)).rejects.toMatchObject({ code: 'portal_error' });
		answers.push(() => new Response('{"kind":"ai","descriptor":{},"expiresAt":"x"}', { status: 200 }));
		await expect(client.resolveResource({ websiteId: WEBSITE, kind: 'database' })).rejects.toMatchObject({
			code: 'portal_error',
		});
		answers.push(() => new Response('{"status":"pending"}', { status: 202 }));
		await expect(client.requestIdentityIssuer({ websiteId: WEBSITE, issuer: 'https://i.example/' })).rejects.toMatchObject({
			code: 'portal_error',
		});
		answers.push(() => new Response('{"status":"active","issuer":{"issuer":"https://i.example/"}}', { status: 200 }));
		expect(await client.requestIdentityIssuer({ websiteId: 'web/1', issuer: 'https://i.example/' })).toEqual({
			status: 'active',
			issuer: { issuer: 'https://i.example/' },
		});
		answers.push(() => new Response('{}', { status: 200 }));
		expect(await client.usage([])).toEqual({ results: [] });
		answers.push(() => new Response('{"title":"x"}', { status: 400 }));
		await expect(client.usage([])).rejects.toMatchObject({ code: 'portal_error', details: { status: 400 } });
		const unregistered = createPortalClient({ portalUrl: 'https://portal.test', appId: async () => null, signer, fetch });
		await expect(unregistered.publishEvents([])).rejects.toMatchObject({ code: 'not_registered' });
	});
});

describe('audit', () => {
	it('validates entries and writes to the sink or the merchant database', async () => {
		/** @type {any[]} */
		const written = [];
		const audit = createAudit({ data: /** @type {any} */ ({}), now: () => 0, sink: async (entry) => written.push(entry) });
		await audit.record({
			websiteId: WEBSITE,
			actor: { type: 'staff', id: 'u1' },
			action: 'coupon.created',
			target: { type: 'coupon', id: 'c1' },
			before: null,
			after: { a: 1 },
			requestId: 'r',
		});
		expect(written[0]).toEqual({
			websiteId: WEBSITE,
			actor: { type: 'staff', id: 'u1' },
			action: 'coupon.created',
			target: { type: 'coupon', id: 'c1' },
			before: null,
			after: { a: 1 },
			requestId: 'r',
			at: '1970-01-01T00:00:00.000Z',
		});
		await expect(audit.record(/** @type {any} */ ({}))).rejects.toMatchObject({ code: 'invalid_audit' });
		await expect(audit.record(/** @type {any} */ ({ websiteId: WEBSITE }))).rejects.toMatchObject({ code: 'invalid_audit' });
		await expect(
			audit.record(/** @type {any} */ ({ websiteId: WEBSITE, actor: { type: 'x' }, action: 'Bad Action' })),
		).rejects.toMatchObject({ code: 'invalid_audit' });
		/** @type {any[]} */
		const inserted = [];
		const dbAudit = createAudit({
			data: {
				forWebsite: async () => ({
					collection: () => ({ insertOne: async (/** @type {any} */ doc) => (inserted.push(doc), { insertedId: 'id1' }) }),
				}),
			},
		});
		expect(await dbAudit.record({ websiteId: WEBSITE, actor: { type: 'merchant' }, action: 'x' })).toEqual({
			ok: true,
			id: 'id1',
		});
		expect(inserted[0]).toMatchObject({ action: 'x', actor: { type: 'merchant' } });
	});
});

describe('fake portal', () => {
	it('routes unknown origins to the fallback and builds payloads', async () => {
		const portal = await createFakePortal({ fallbackFetch: /** @type {any} */ (async () => new Response('fallback')) });
		expect(await (await portal.fetch('https://other.test/x')).text()).toBe('fallback');
		const noFallback = await createFakePortal();
		await expect(noFallback.fetch('https://other.test/x')).rejects.toThrow(TypeError);
		expect((await portal.fetch('https://portal.test/v1/product/events', { method: 'POST' })).status).toBe(401);
		expect(entitlementPayload({ websiteId: WEBSITE, productSlug: 'a-b', now: 0 }).dataScope.prefix).toBe('ss_a_b_');
		expect(typeof (await portal.signDocument({ validUntil: '2030-01-01T00:00:00Z' }))).toBe('string');
	});

	it('answers 404 for unknown signed routes', async () => {
		const { portal, product } = await setup();
		expect(portal.url).toBe(PORTAL_URL);
		await expect(product.portal.resolveResource({ websiteId: WEBSITE, kind: 'ai' })).rejects.toMatchObject({
			details: { status: 424 },
		});
	});
});
