import { describe, expect, it } from 'vitest';
import { hashRegistrationToken } from '@ss/protocol';
import { createProduct, standardRoutes } from '../src/index.js';
import { PORTAL_URL, WEBSITE, createClock, createTestLogger, entitle, manifest, setup } from './helpers.js';

const TOKEN = 'reg_tok_0123456789abcdefghijklmnop';
const BASE = 'https://coupons.example.dev';

describe('registration', () => {
	it('completes the handshake, burns the token and learns the appId', async () => {
		const { portal, product, logs } = await setup({
			overrides: { appId: null, registrationTokenHash: hashRegistrationToken(TOKEN) },
		});
		portal.trustProductKey(/** @type {any} */ (null));
		expect((await product.manifestRoute()).headers).not.toHaveProperty('ss-manifest-signature');
		const request = await portal.registrationRequest({ token: TOKEN, audience: BASE });
		const handle = product.handler(standardRoutes(product));
		const res = await handle(
			new Request('https://coupons.example.dev/.well-known/ss-register', {
				method: 'POST',
				headers: request.headers,
				body: request.body,
			}),
		);
		expect(res.status).toBe(200);
		const response = await res.json();
		const verified = await portal.completeRegistration({ response, nonce: request.nonce });
		expect(verified.appId).toBe('app_test');
		expect(logs.some((l) => l.msg.includes('registered'))).toBe(true);
		// once registered, the served manifest is signed for the learned appId
		expect((await product.manifestRoute()).headers['ss-manifest-signature']).toMatch(/\./);
		// the product now authenticates to the Portal with the learned appId
		await entitle(portal);
		expect((await product.entitlements.forWebsite(WEBSITE)).ok).toBe(true);
		// the token is burned
		const again = await portal.registrationRequest({ token: TOKEN, audience: BASE });
		expect(await product.registration.handle({ headers: again.headers, body: again.body })).toEqual({
			status: 401,
			body: { error: 'unauthorized' },
		});
		expect(logs.some((l) => l.fields?.reason === 'token_burned')).toBe(true);
	});

	it('learns the appId from the shared store on another instance', async () => {
		const clock = createClock();
		const { portal, product, privateJwk } = await setup({
			clock,
			overrides: { appId: null, registrationTokenHash: hashRegistrationToken(TOKEN) },
		});
		const request = await portal.registrationRequest({ token: TOKEN, audience: BASE });
		expect((await product.registration.handle({ headers: request.headers, body: request.body })).status).toBe(200);
		const stores = product.context.stores;
		const sibling = createProduct({
			manifest: manifest(),
			portalUrl: PORTAL_URL,
			signingKey: `${privateJwk.kid}:${privateJwk.d}`,
			registrationTokenHash: hashRegistrationToken(TOKEN),
			stores,
			fetch: portal.fetch,
			now: clock.now,
		});
		expect(await sibling.context.appId()).toBe('app_test');
	});

	it.each([
		['endpoints.base', 'https://coupons.example.dev', 200],
		['endpoints.base with a trailing slash', 'https://coupons.example.dev/', 200],
		['the appId', 'app_test', 200],
		['a configured extra audience', 'urn:extra', 200],
		['another product', 'https://other.example.dev', 401],
	])('accepts or refuses aud = %s', async (_label, audience, status) => {
		const { portal, product } = await setup({
			overrides: { appId: null, registrationTokenHash: hashRegistrationToken(TOKEN), registrationAudience: 'urn:extra' },
		});
		const request = await portal.registrationRequest({ token: TOKEN, audience });
		expect((await product.registration.handle({ headers: request.headers, body: request.body })).status).toBe(status);
	});

	it('rejects requests without aud (generic 401, reason audience_missing) and keeps the token unburned', async () => {
		const { portal, product, logs } = await setup({ overrides: { registrationTokenHash: hashRegistrationToken(TOKEN) } });
		const request = await portal.registrationRequest({ token: TOKEN });
		expect(await product.registration.handle({ headers: request.headers, body: request.body })).toEqual({
			status: 401,
			body: { error: 'unauthorized' },
		});
		expect(logs.some((l) => l.fields?.reason === 'audience_missing')).toBe(true);
		const retry = await portal.registrationRequest({ token: TOKEN, audience: BASE });
		expect((await product.registration.handle({ headers: retry.headers, body: retry.body })).status).toBe(200);
	});

	it('accepts the known appId as audience and tolerates unparseable bodies', async () => {
		const { portal, product } = await setup({ overrides: { registrationTokenHash: hashRegistrationToken(TOKEN) } });
		expect((await product.registration.handle({ headers: {}, body: '{' })).status).toBe(401);
		expect((await product.registration.handle({ headers: {}, body: { request: 'x' } })).status).toBe(401);
		const request = await portal.registrationRequest({ token: TOKEN, audience: 'app_test' });
		expect((await product.registration.handle({ headers: request.headers, body: JSON.parse(request.body) })).status).toBe(200);
	});

	it('refuses wrong tokens and products without a token hash', async () => {
		const { portal, product } = await setup({ overrides: { registrationTokenHash: hashRegistrationToken(TOKEN) } });
		const wrong = await portal.registrationRequest({ token: 'reg_tok_wrong_wrong_wrong_wrong_1', audience: BASE });
		expect((await product.registration.handle({ headers: wrong.headers, body: wrong.body })).status).toBe(401);
		const { logger, entries } = createTestLogger();
		const none = await setup({ overrides: { logger } });
		const request = await portal.registrationRequest({ token: TOKEN, audience: BASE });
		expect(await none.product.registration.handle({ headers: request.headers, body: request.body })).toEqual({
			status: 401,
			body: { error: 'unauthorized' },
		});
		expect(entries.some((e) => e.msg.includes('without a registration token'))).toBe(true);
	});

	it('returns 500 when onRegistered fails (token stays burned)', async () => {
		const { portal, product } = await setup({
			overrides: {
				registrationTokenHash: hashRegistrationToken(TOKEN),
				onRegistered: async () => {
					throw new Error('persist failed');
				},
			},
		});
		const request = await portal.registrationRequest({ token: TOKEN, audience: BASE });
		expect(await product.registration.handle({ headers: request.headers, body: request.body })).toEqual({
			status: 500,
			body: { error: 'registration_failed' },
		});
	});

	it('fails the JWKS fetch cleanly when the Portal is down', async () => {
		const { portal, product } = await setup({ overrides: { registrationTokenHash: hashRegistrationToken(TOKEN) } });
		const request = await portal.registrationRequest({ token: TOKEN, audience: BASE });
		portal.failNext('/.well-known/jwks.json', 503);
		expect((await product.registration.handle({ headers: request.headers, body: request.body })).status).toBe(401);
	});
});
