import { createHmac } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	CONNECT_PATH,
	canonicalJson,
	canonicalUrl,
	createConnectRequest,
	createConnectResponse,
	createJwks,
	generateConnectSecret,
	isConnectSecret,
	verifyConnectRequest,
	verifyConnectResponse,
} from '../src/index.js';
import { createClock, expectThrowCode, makeKey } from './helpers.js';

const PORTAL = 'https://portal.test';
const BASE = 'https://coupons.example.com';
const SECRET = 'a'.repeat(40);
const manifest = { id: 'coupons', name: 'Coupons', endpoints: { base: BASE } };
const prices = {
	version: 1,
	features: [{ key: 'codes', name: 'Codes', description: 'd', dependsOn: [], millicreditsPerHour: 0 }],
};

/** @type {Awaited<ReturnType<typeof makeKey>>} */
let portal;
/** @type {Awaited<ReturnType<typeof makeKey>>} */
let product;
beforeAll(async () => {
	portal = await makeKey('portal-1');
	product = await makeKey('product-1');
});

describe('connect secret', () => {
	it('generates 256-bit secrets and refuses short ones', () => {
		const secret = generateConnectSecret();
		expect(isConnectSecret(secret)).toBe(true);
		expect(isConnectSecret('short')).toBe(false);
		expectThrowCode(
			() =>
				createConnectRequest({
					secret: 'short',
					productUrl: BASE,
					portalUrl: PORTAL,
					jwks: { keys: [] },
					priceListVersion: 0,
				}),
			'invalid_argument',
		);
	});
});

describe('connect handshake', () => {
	/** @param {ReturnType<typeof createClock>} clock */
	const start = (clock, priceListVersion = 3) =>
		createConnectRequest({
			secret: SECRET,
			productUrl: `${BASE}/`,
			portalUrl: PORTAL,
			jwks: createJwks([portal.publicJwk]),
			priceListVersion,
			now: clock.now,
		});

	it('verifies both directions with the shared secret; the secret is never sent', async () => {
		const clock = createClock();
		const request = start(clock);
		expect(request.url).toBe(`${BASE}${CONNECT_PATH}`);
		expect(request.body).not.toContain(SECRET);
		expect(JSON.stringify(request.headers)).not.toContain(SECRET);
		const verified = verifyConnectRequest({ secret: SECRET, headers: request.headers, body: request.body, now: clock.now });
		expect(verified).toEqual({
			portalUrl: PORTAL,
			jwks: { keys: [portal.publicJwk] },
			baseUrl: BASE,
			nonce: request.nonce,
			priceListVersion: 3,
		});
		expect(JSON.parse(request.body)).not.toHaveProperty('appId');
		expect(verified.jwks.keys[0]?.kid).toBe('portal-1');

		const answer = createConnectResponse({
			secret: SECRET,
			productId: 'coupons',
			nonce: verified.nonce,
			publicJwk: product.privateJwk,
			manifest,
			prices,
			now: clock.now,
		});
		expect(answer.body).not.toContain(product.privateJwk.d);
		const accepted = verifyConnectResponse({
			secret: SECRET,
			headers: answer.headers,
			body: answer.body,
			nonce: request.nonce,
			now: clock.now,
		});
		expect(accepted).toEqual({ productId: 'coupons', publicJwk: product.publicJwk, manifest, prices });
		const check = (/** @type {Record<string, unknown>} */ change) => () =>
			verifyConnectResponse({
				secret: SECRET,
				headers: answer.headers,
				body: answer.body,
				nonce: request.nonce,
				now: clock.now,
				...change,
			});
		expectThrowCode(check({ nonce: 'another-nonce-0123' }), 'replay');
		expectThrowCode(check({ nonce: undefined }), 'replay');
		expectThrowCode(check({ secret: 'b'.repeat(40) }), 'signature');
		// a request cannot be reflected as an answer
		expectThrowCode(check({ headers: request.headers, body: request.body }), 'signature');
	});

	it('checks the answer members', () => {
		const clock = createClock();
		const nonce = 'n'.repeat(22);
		const resign = (/** @type {Record<string, unknown>} */ members) => {
			const body = JSON.stringify({ productId: 'coupons', nonce, publicJwk: product.publicJwk, manifest, prices, ...members });
			const timestamp = String(Math.floor(clock.now() / 1000));
			const signature = createHmac('sha256', SECRET).update(`ss-connected.v1|${timestamp}|${body}`).digest('hex');
			return () =>
				verifyConnectResponse({
					secret: SECRET,
					headers: { 'SS-Connect-Timestamp': timestamp, 'SS-Connect-Signature': signature },
					body,
					nonce,
					now: clock.now,
				});
		};
		expect(resign({})()).toMatchObject({ productId: 'coupons' });
		expectThrowCode(resign({ productId: 'App_1' }), 'malformed');
		expectThrowCode(resign({ manifest: null }), 'malformed');
		expectThrowCode(resign({ prices: [] }), 'malformed');
		expectThrowCode(resign({ publicJwk: { kty: 'EC' } }), 'malformed');
		expectThrowCode(
			() => createConnectResponse({ secret: SECRET, productId: 'Bad', nonce, publicJwk: product.publicJwk, manifest, prices }),
			'invalid_argument',
		);
		expectThrowCode(
			() =>
				createConnectResponse({
					secret: SECRET,
					productId: 'coupons',
					nonce,
					publicJwk: product.publicJwk,
					manifest,
					prices: 1,
				}),
			'invalid_argument',
		);
		expectThrowCode(
			() =>
				createConnectResponse({
					secret: SECRET,
					productId: 'coupons',
					nonce: 'x',
					publicJwk: product.publicJwk,
					manifest,
					prices,
				}),
			'malformed',
		);
	});

	it('refuses tampering, other secrets and stale requests', () => {
		const clock = createClock();
		const request = start(clock);
		const verify = (/** @type {Record<string, unknown>} */ change) => () =>
			verifyConnectRequest({ secret: SECRET, headers: request.headers, body: request.body, now: clock.now, ...change });
		expectThrowCode(verify({ headers: {} }), 'malformed');
		expectThrowCode(() => start(clock, -1), 'invalid_argument');
		expectThrowCode(() => start(clock, 1.5), 'invalid_argument');
		expectThrowCode(verify({ secret: 'b'.repeat(40) }), 'signature');
		expectThrowCode(verify({ body: request.body.replace('"priceListVersion":3', '"priceListVersion":4') }), 'signature');
		clock.advance(301_000);
		expectThrowCode(verify({}), 'expired');
	});

	it('refuses signed requests with bad members', () => {
		const clock = createClock();
		/** @param {Record<string, unknown>} members */
		const signed = (members) => {
			const body = JSON.stringify({
				portalUrl: PORTAL,
				jwks: createJwks([portal.publicJwk]),
				baseUrl: BASE,
				nonce: 'n'.repeat(22),
				priceListVersion: 0,
				...members,
			});
			const timestamp = String(Math.floor(clock.now() / 1000));
			const signature = createHmac('sha256', SECRET).update(`ss-connect.v1|${timestamp}|${body}`).digest('hex');
			return () =>
				verifyConnectRequest({
					secret: SECRET,
					headers: { 'SS-Connect-Timestamp': timestamp, 'SS-Connect-Signature': signature },
					body,
					now: clock.now,
				});
		};
		expect(signed({})()).toMatchObject({ priceListVersion: 0 });
		expectThrowCode(signed({ priceListVersion: -1 }), 'malformed');
		expectThrowCode(signed({ priceListVersion: undefined }), 'malformed');
		expectThrowCode(signed({ jwks: { keys: [] } }), 'malformed');
		expectThrowCode(signed({ portalUrl: 'ftp://x' }), 'malformed');
		expectThrowCode(signed({ nonce: 'short' }), 'malformed');
	});

	it('canonicalises URLs for pinning', () => {
		expect(canonicalUrl('HTTPS://Portal.Test:443/')).toBe('https://portal.test');
		for (const bad of [1, 'nope', 'ftp://x', 'https://u:p@x', 'https://x/?q', 'https://x/#f'])
			expectThrowCode(() => canonicalUrl(bad), 'invalid_argument');
	});
});

describe('canonicalJson', () => {
	it('sorts keys, drops undefined members and nulls undefined array items', () => {
		expect(canonicalJson({ b: [1, undefined, 'x'], a: { d: undefined, c: true }, e: null })).toBe(
			'{"a":{"c":true},"b":[1,null,"x"],"e":null}',
		);
	});

	it('refuses values JSON cannot represent', () => {
		expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
		expect(() => canonicalJson(() => 1)).toThrow(TypeError);
		expect(() => canonicalJson(1n)).toThrow(TypeError);
	});
});
