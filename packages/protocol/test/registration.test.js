import { beforeAll, describe, expect, it } from 'vitest';
import {
	CONNECT_PATH,
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
const manifest = { ssps: '1', product: { slug: 'coupons' }, endpoints: { base: BASE } };

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
			() => createConnectRequest({ secret: 'short', productUrl: BASE, portalUrl: PORTAL, jwks: { keys: [] }, appId: 'app_1' }),
			'invalid_argument',
		);
	});
});

describe('connect handshake', () => {
	/** @param {ReturnType<typeof createClock>} clock */
	const start = (clock) =>
		createConnectRequest({
			secret: SECRET,
			productUrl: `${BASE}/`,
			portalUrl: PORTAL,
			jwks: createJwks([portal.publicJwk]),
			appId: 'app_1',
			now: clock.now,
		});

	it('verifies both directions with the shared secret; the secret is never sent', async () => {
		const clock = createClock();
		const request = start(clock);
		expect(request.url).toBe(`${BASE}${CONNECT_PATH}`);
		expect(request.body).not.toContain(SECRET);
		expect(JSON.stringify(request.headers)).not.toContain(SECRET);
		const verified = verifyConnectRequest({ secret: SECRET, headers: request.headers, body: request.body, now: clock.now });
		expect(verified).toMatchObject({ portalUrl: PORTAL, appId: 'app_1', baseUrl: BASE, nonce: request.nonce });
		expect(verified.jwks.keys[0]?.kid).toBe('portal-1');

		const answer = createConnectResponse({
			secret: SECRET,
			appId: 'app_1',
			nonce: verified.nonce,
			publicJwk: product.publicJwk,
			manifest,
			now: clock.now,
		});
		const accepted = await verifyConnectResponse({
			secret: SECRET,
			headers: answer.headers,
			body: answer.body,
			nonce: request.nonce,
			appId: 'app_1',
			now: clock.now,
		});
		expect(accepted.publicJwk.kid).toBe('product-1');
		expect(accepted.manifest).toEqual(manifest);
		const check = (/** @type {Record<string, unknown>} */ change) =>
			verifyConnectResponse({
				secret: SECRET,
				headers: answer.headers,
				body: answer.body,
				nonce: request.nonce,
				appId: 'app_1',
				now: clock.now,
				...change,
			});
		await expect(check({ nonce: 'another-nonce-0123' })).rejects.toMatchObject({ code: 'replay' });
		await expect(check({ appId: 'app_2' })).rejects.toMatchObject({ code: 'subject' });
		await expect(check({ secret: 'b'.repeat(40) })).rejects.toMatchObject({ code: 'signature' });
		// a request cannot be reflected as an answer
		await expect(check({ headers: request.headers, body: request.body })).rejects.toMatchObject({ code: 'signature' });
	});

	it('refuses tampering, other secrets and stale requests', () => {
		const clock = createClock();
		const request = start(clock);
		const verify = (/** @type {Record<string, unknown>} */ change) => () =>
			verifyConnectRequest({ secret: SECRET, headers: request.headers, body: request.body, now: clock.now, ...change });
		expectThrowCode(verify({ headers: {} }), 'malformed');
		expectThrowCode(verify({ secret: 'b'.repeat(40) }), 'signature');
		expectThrowCode(verify({ body: request.body.replace('app_1', 'app_2') }), 'signature');
		clock.advance(301_000);
		expectThrowCode(verify({}), 'expired');
	});

	it('canonicalises URLs for pinning', () => {
		expect(canonicalUrl('HTTPS://Portal.Test:443/')).toBe('https://portal.test');
		for (const bad of [1, 'nope', 'ftp://x', 'https://u:p@x', 'https://x/?q', 'https://x/#f'])
			expectThrowCode(() => canonicalUrl(bad), 'invalid_argument');
	});
});
