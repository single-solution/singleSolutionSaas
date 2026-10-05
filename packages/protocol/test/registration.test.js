import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
	canonicalUrl,
	createJwks,
	createMemoryReplayStore,
	createRegistrationHandler,
	createRegistrationRequest,
	createSigner,
	hashManifest,
	hashRegistrationToken,
	thumbprint,
	verifyRegistrationResponse,
} from '../src/index.js';
import { signCompact } from '../src/jws.js';
import {
	createClock,
	decodeSegment,
	expectCode,
	expectThrowCode,
	makeKey,
	seededRandom,
	tamperSegment,
	tamperSignature,
} from './helpers.js';

const PORTAL = 'https://portal.test';
const PINNED_JWKS = 'https://portal.test/.well-known/jwks.json';
const EVIL_JWKS = 'https://evil.test/jwks.json';
const TOKEN = 'rt_0123456789abcdefghijklmnop';
const manifest = { ssps: '1', product: { slug: 'coupons' } };

/** @type {Awaited<ReturnType<typeof makeKey>>} */
let portal;
/** @type {Awaited<ReturnType<typeof makeKey>>} */
let attacker;
/** @type {Awaited<ReturnType<typeof makeKey>>} */
let product;
beforeAll(async () => {
	portal = await makeKey('portal-1');
	attacker = await makeKey('portal-1');
	product = await makeKey('product-1');
});

/**
 * @param {ReturnType<typeof createClock>} clock
 * @param {Record<string, any>} [overrides]
 */
const setup = (clock, overrides = {}) => {
	let burned = false;
	const fetchJwks = vi.fn(async (/** @type {string} */ url) => {
		if (url === PINNED_JWKS) return createJwks([portal.publicJwk]);
		if (url === EVIL_JWKS) return createJwks([attacker.publicJwk]);
		throw new Error('unexpected url');
	});
	const onRegistered = vi.fn(async () => {});
	const burnToken = vi.fn(async () => {
		if (burned) return false;
		burned = true;
		return true;
	});
	const handler = createRegistrationHandler({
		registrationTokenHash: hashRegistrationToken(TOKEN),
		allowedPortalUrl: PORTAL,
		fetchJwks,
		manifest,
		productPublicJwk: product.privateJwk,
		productSigner: product.signer,
		onRegistered,
		burnToken,
		isTokenBurned: () => burned,
		nonceStore: createMemoryReplayStore({ now: clock.now }),
		expectedAudience: 'https://coupons.test',
		now: clock.now,
		...overrides,
	});
	return { handler, fetchJwks, onRegistered, burnToken, isBurned: () => burned };
};

/**
 * @param {ReturnType<typeof createClock>} clock
 * @param {Record<string, any>} [overrides]
 */
const request = (clock, overrides = {}) =>
	createRegistrationRequest({
		portalUrl: PORTAL,
		portalJwksUrl: PINNED_JWKS,
		signer: portal.signer,
		registrationToken: TOKEN,
		audience: 'https://coupons.test',
		appId: 'app_coupons',
		now: clock.now,
		randomBytes: seededRandom(),
		...overrides,
	});

describe('registration handshake', () => {
	it('succeeds once, returns manifest + public key only, and burns the token', async () => {
		const clock = createClock();
		const { handler, onRegistered, burnToken, fetchJwks, isBurned } = setup(clock);
		const req = await request(clock);
		expect(req.headers.Authorization).toBe(`Bearer ${TOKEN}`);
		expect(req.body).not.toContain(TOKEN);
		const res = await handler.handle(req);
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ manifest, publicJwk: product.publicJwk, proof: expect.any(String) });
		expect(JSON.stringify(res.body)).not.toContain('"d"');
		expect(burnToken).toHaveBeenCalledTimes(1);
		expect(isBurned()).toBe(true);
		expect(fetchJwks).toHaveBeenCalledWith(PINNED_JWKS);
		expect(onRegistered).toHaveBeenCalledWith(
			expect.objectContaining({ portalUrl: PORTAL, appId: 'app_coupons', portalKid: 'portal-1', registeredAt: clock.now() }),
		);
		// a second, fresh request with the same token is refused
		const again = await handler.handle(await request(clock, { randomBytes: seededRandom(9) }));
		expect(again).toMatchObject({ status: 401, body: { error: 'unauthorized' }, reason: 'token_burned' });
	});

	/**
	 * @param {{ headers: Record<string, any>, body: unknown }} req
	 * @param {string} reason
	 * @param {Record<string, any>} [setupOverrides]
	 * @param {ReturnType<typeof createClock>} [clock]
	 */
	const expectDenied = async (req, reason, setupOverrides = {}, clock = createClock()) => {
		const ctx = setup(clock, setupOverrides);
		const res = await ctx.handler.handle(req);
		expect(res).toEqual({ status: 401, body: { error: 'unauthorized' }, reason });
		expect(ctx.onRegistered).not.toHaveBeenCalled();
		return ctx;
	};

	it('rejects a wrong or missing bearer token without fetching keys', async () => {
		const clock = createClock();
		const req = await request(clock);
		const ctx = await expectDenied(
			{ ...req, headers: { ...req.headers, Authorization: 'Bearer rt_wrong_token_0123456789' } },
			'token_invalid',
		);
		expect(ctx.fetchJwks).not.toHaveBeenCalled();
		await expectDenied({ ...req, headers: {} }, 'token_invalid');
		await expectDenied({ ...req, headers: { Authorization: `Basic ${TOKEN}` } }, 'token_invalid');
		await expectDenied({ ...req, headers: { authorization: 'Bearer short' } }, 'token_invalid');
	});

	it('rejects when the token is already burned', async () => {
		const clock = createClock();
		await expectDenied(await request(clock), 'token_burned', { isTokenBurned: () => true });
		// race: isTokenBurned said no, but the atomic burn lost
		await expectDenied(await request(clock), 'token_burned', { burnToken: async () => false });
	});

	it('rejects a request claiming another Portal URL', async () => {
		const clock = createClock();
		await expectDenied(await request(clock, { portalUrl: 'https://evil.test' }), 'portal_url');
		await expectDenied(await request(clock, { portalUrl: 'https://portal.test.evil.test' }), 'portal_url');
		// a missing portalUrl in an otherwise valid signed body
		const iat = Math.floor(clock.now() / 1000);
		const signed = await signCompact({
			signer: portal.signer,
			typ: 'ss-registration+jws',
			payload: { nonce: 'n'.repeat(20), iat, exp: iat + 300, tth: hashRegistrationToken(TOKEN), aud: 'https://coupons.test' },
		});
		await expectDenied({ headers: { Authorization: `Bearer ${TOKEN}` }, body: { request: signed } }, 'portal_url');
	});

	it('ignores a JWKS URL in the body: keys come only from the pinned URL', async () => {
		const clock = createClock();
		const req = await request(clock, { signer: attacker.signer, portalJwksUrl: EVIL_JWKS });
		const ctx = await expectDenied(req, 'signature:signature');
		expect(ctx.fetchJwks).toHaveBeenCalledTimes(1);
		expect(ctx.fetchJwks).toHaveBeenCalledWith(PINNED_JWKS);
		expect(ctx.fetchJwks).not.toHaveBeenCalledWith(EVIL_JWKS);
		expect(ctx.isBurned()).toBe(false);
	});

	it('rejects skewed timestamps (±5 min)', async () => {
		const clock = createClock();
		await expectDenied(await request(createClock(clock.now() - 301_000)), 'timestamp', {}, clock);
		await expectDenied(await request(createClock(clock.now() + 301_000)), 'timestamp', {}, clock);
		const ok = setup(clock);
		expect((await ok.handler.handle(await request(createClock(clock.now() - 299_000)))).status).toBe(200);
	});

	it('rejects a reused nonce', async () => {
		const clock = createClock();
		const nonceStore = createMemoryReplayStore({ now: clock.now });
		const req = await request(clock, { nonce: 'nonce-0123456789abcdef' });
		// first attempt fails late (burn fails) but consumes the nonce
		await expectDenied(req, 'token_burned', { nonceStore, burnToken: async () => false });
		await expectDenied(req, 'nonce_reused', { nonceStore });
		await expectDenied(await request(clock, { nonce: 'short' }), 'nonce_invalid');
	});

	it('rejects bodies signed for another product, bound to another token, or tampered', async () => {
		const clock = createClock();
		await expectDenied(await request(clock, { audience: 'https://other.test' }), 'audience');
		const otherToken = await request(clock, { registrationToken: 'rt_another_token_0123456789' });
		await expectDenied({ ...otherToken, headers: { Authorization: `Bearer ${TOKEN}` } }, 'token_binding');
		const req = await request(clock);
		const parsed = JSON.parse(req.body);
		const parts = parsed.request.split('.');
		parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
		await expectDenied({ ...req, body: JSON.stringify({ request: parts.join('.') }) }, 'signature:signature');
		await expectDenied({ ...req, body: '{not json' }, 'body_malformed');
		await expectDenied({ ...req, body: { request: 42 } }, 'body_malformed');
	});

	it('accepts a parsed-object body', async () => {
		const clock = createClock();
		const { handler } = setup(clock);
		const req = await request(clock);
		expect((await handler.handle({ headers: req.headers, body: JSON.parse(req.body) })).status).toBe(200);
	});

	it('reports signature failures when the pinned JWKS is unreachable', async () => {
		const clock = createClock();
		await expectDenied(await request(clock), 'signature:jwks_unavailable', {
			fetchJwks: async () => {
				throw new Error('down');
			},
		});
	});

	it('returns 500 when onRegistered fails and keeps the token burned', async () => {
		const clock = createClock();
		const ctx = setup(clock, {
			onRegistered: async () => {
				throw new Error('db down');
			},
		});
		const res = await ctx.handler.handle(await request(clock));
		expect(res).toEqual({ status: 500, body: { error: 'registration_failed' }, reason: 'on_registered_failed' });
		expect(ctx.isBurned()).toBe(true);
	});

	it('maps unexpected internal errors to the generic 401', async () => {
		const clock = createClock();
		await expectDenied(await request(clock), 'internal_error', {
			isTokenBurned: () => {
				throw new Error('store down');
			},
		});
	});

	it('validates handler configuration', () => {
		const clock = createClock();
		expectThrowCode(() => setup(clock, { registrationTokenHash: TOKEN }), 'invalid_argument');
		expectThrowCode(() => setup(clock, { burnToken: undefined }), 'invalid_argument');
		expectThrowCode(() => setup(clock, { nonceStore: undefined }), 'invalid_argument');
		expectThrowCode(() => setup(clock, { productSigner: undefined }), 'invalid_argument');
		expectThrowCode(() => setup(clock, { productSigner: portal.signer }), 'invalid_argument');
		expectThrowCode(() => setup(clock, { manifest: { n: Number.NaN } }), 'invalid_argument');
		expectThrowCode(() => setup(clock, { allowedPortalJwksUrl: EVIL_JWKS }), 'invalid_argument');
		expectThrowCode(() => setup(clock, { allowedPortalUrl: 'ftp://portal.test' }), 'invalid_argument');
		expect(() => setup(clock, { allowedPortalJwksUrl: 'https://portal.test/keys' })).not.toThrow();
	});

	it('canonicalUrl normalises and rejects non-plain URLs', () => {
		expect(canonicalUrl('HTTPS://Portal.Test:443/')).toBe('https://portal.test');
		expect(canonicalUrl('https://portal.test/base/')).toBe('https://portal.test/base');
		for (const bad of [
			42,
			'nope',
			'https://u:p@portal.test',
			'https://portal.test/?a=1',
			'https://portal.test/#x',
			'ftp://portal.test',
		]) {
			expectThrowCode(() => canonicalUrl(bad), 'invalid_argument');
		}
	});

	it('hashRegistrationToken requires a token', () => {
		expectThrowCode(() => hashRegistrationToken(''), 'invalid_argument');
		expect(hashRegistrationToken(TOKEN)).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('registration response proof of possession', () => {
	/**
	 * Run a full successful handshake and return what the Portal receives.
	 * @param {ReturnType<typeof createClock>} clock
	 * @param {Record<string, any>} [setupOverrides]
	 */
	const handshake = async (clock, setupOverrides = {}) => {
		const req = await request(clock);
		const res = await setup(clock, setupOverrides).handler.handle(req);
		expect(res.status).toBe(200);
		return { nonce: req.nonce, response: /** @type {Record<string, any>} */ (JSON.parse(JSON.stringify(res.body))) };
	};

	/**
	 * @param {ReturnType<typeof createClock>} clock
	 * @param {unknown} response
	 * @param {string} nonce
	 * @param {Record<string, any>} [overrides]
	 */
	const verify = (clock, response, nonce, overrides = {}) =>
		verifyRegistrationResponse({ response, expectedNonce: nonce, expectedPortalUrl: PORTAL, now: clock.now, ...overrides });

	it('signs { appId, manifestHash, jkt, nonce, portalUrl, iat } and verifies on the Portal side', async () => {
		const clock = createClock();
		const { nonce, response } = await handshake(clock);
		expect(decodeSegment(response.proof, 0)).toEqual({ alg: 'EdDSA', kid: 'product-1', typ: 'ss-registration-response+jws' });
		expect(decodeSegment(response.proof, 1)).toEqual({
			appId: 'app_coupons',
			manifestHash: hashManifest(manifest),
			jkt: await thumbprint(product.publicJwk),
			nonce,
			portalUrl: PORTAL,
			iat: Math.floor(clock.now() / 1000),
		});
		const result = await verify(clock, response, nonce, {
			expectedAppId: 'app_coupons',
			expectedPortalUrl: 'https://PORTAL.test/',
		});
		expect(result).toEqual({
			manifest,
			publicJwk: product.publicJwk,
			thumbprint: await thumbprint(product.publicJwk),
			appId: 'app_coupons',
		});
	});

	it('manifest hash is canonical (key order does not matter)', () => {
		expect(hashManifest({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: 'é' } })).toBe(
			hashManifest({ a: { c: 'é', d: [1, { x: 1, y: 2 }] }, b: 1 }),
		);
		expect(hashManifest({ a: 1, u: undefined })).toBe(hashManifest({ a: 1 }));
		expect(hashManifest([undefined])).toBe(hashManifest([null]));
		expect(hashManifest({ a: 1 })).not.toBe(hashManifest({ a: 2 }));
		expectThrowCode(() => hashManifest({ f: () => 1 }), 'invalid_argument');
		expectThrowCode(() => hashManifest({ n: Infinity }), 'invalid_argument');
	});

	it('rejects a proof signed by another key (key substitution)', async () => {
		const clock = createClock();
		// product registers someone else's public key while signing with its own
		const { nonce, response } = await handshake(clock);
		const swapped = { ...response, publicJwk: { ...attacker.publicJwk, kid: 'product-1' } };
		await expectCode(verify(clock, swapped, nonce), 'signature');
		// public key and kid of another party
		await expectCode(verify(clock, { ...response, publicJwk: portal.publicJwk }, nonce), 'unknown_kid');
		// a product whose signer does not hold the private key of the published JWK
		const impostor = await makeKey('product-1');
		const other = await handshake(clock, { productSigner: createSigner(impostor.privateJwk) });
		await expectCode(verify(clock, other.response, other.nonce), 'signature');
		await expectCode(verify(clock, { ...response, proof: tamperSignature(response.proof) }, nonce), 'signature');
	});

	it('rejects a thumbprint that does not match the included key', async () => {
		const clock = createClock();
		const { nonce, response } = await handshake(clock);
		const forged = tamperSegment(response.proof, 1, (p) => ({ ...p, jkt: 'x' }));
		await expectCode(verify(clock, { ...response, proof: forged }, nonce), 'signature');
		// correctly signed but wrong jkt
		const { signCompact } = await import('../src/jws.js');
		const payload = { ...decodeSegment(response.proof, 1), jkt: await thumbprint(attacker.publicJwk) };
		const proof = await signCompact({ signer: product.signer, typ: 'ss-registration-response+jws', payload });
		await expectCode(verify(clock, { ...response, proof }, nonce), 'signature');
	});

	it('rejects an altered manifest', async () => {
		const clock = createClock();
		const { nonce, response } = await handshake(clock);
		await expectCode(verify(clock, { ...response, manifest: { ...manifest, product: { slug: 'evil' } } }, nonce), 'signature');
		await expectCode(verify(clock, { ...response, manifest: { n: Number.NaN } }, nonce), 'malformed');
	});

	it('rejects a wrong nonce, another Portal and another app', async () => {
		const clock = createClock();
		const { nonce, response } = await handshake(clock);
		await expectCode(verify(clock, response, 'another-nonce-0123456789'), 'replay');
		await expectCode(verify(clock, response, nonce, { expectedPortalUrl: 'https://evil.test' }), 'audience');
		await expectCode(verify(clock, response, nonce, { expectedAppId: 'app_other' }), 'subject');
	});

	it('rejects stale and future proofs (±5 min)', async () => {
		const clock = createClock();
		const { nonce, response } = await handshake(clock);
		await expect(verify(createClock(clock.now() + 300_000), response, nonce)).resolves.toBeTruthy();
		await expectCode(verify(createClock(clock.now() + 301_000), response, nonce), 'expired');
		await expectCode(verify(createClock(clock.now() - 301_000), response, nonce), 'not_yet_valid');
	});

	it('rejects malformed responses and claims', async () => {
		const clock = createClock();
		const { nonce, response } = await handshake(clock);
		await expectCode(verify(clock, null, nonce), 'malformed');
		await expectCode(verify(clock, { ...response, proof: undefined }, nonce), 'malformed');
		await expectCode(verify(clock, { publicJwk: response.publicJwk, proof: response.proof }, nonce), 'malformed');
		await expectCode(verify(clock, { ...response, publicJwk: { kty: 'RSA' } }, nonce), 'malformed');
		await expectCode(verify(clock, response, ''), 'invalid_argument');
		const { signCompact } = await import('../src/jws.js');
		const base = decodeSegment(response.proof, 1);
		/** @param {Record<string, unknown>} payload */
		const resign = async (payload) => ({
			...response,
			proof: await signCompact({ signer: product.signer, typ: 'ss-registration-response+jws', payload }),
		});
		await expectCode(verify(clock, await resign({ ...base, iat: undefined }), nonce), 'malformed');
		await expectCode(verify(clock, await resign({ ...base, appId: 7 }), nonce), 'malformed');
		await expectCode(verify(clock, await resign({ ...base, nonce: 5 }), nonce), 'replay');
		const wrongTyp = {
			...response,
			proof: await signCompact({ signer: product.signer, typ: 'ss-registration+jws', payload: base }),
		};
		await expectCode(verify(clock, wrongTyp, nonce), 'wrong_type');
		const noApp = await resign({ ...base, appId: undefined });
		expect(await verify(clock, noApp, nonce)).not.toHaveProperty('appId');
	});
});
