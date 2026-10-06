import { beforeAll, describe, expect, it } from 'vitest';
import {
	CONNECT_PATH,
	canonicalUrl,
	createConnectRequest,
	createConnectResponse,
	createConnectionCode,
	createJwks,
	hashConnectionToken,
	hashManifest,
	parseConnectionCode,
	verifyConnectRequest,
	verifyConnectResponse,
} from '../src/index.js';
import { createClock, expectThrowCode, makeKey, seededRandom } from './helpers.js';

const PORTAL = 'https://portal.test';
const BASE = 'https://coupons.example.com';
const manifest = { ssps: '1', product: { slug: 'coupons' }, endpoints: { base: BASE } };

/** @type {Awaited<ReturnType<typeof makeKey>>} */
let portal;
/** @type {Awaited<ReturnType<typeof makeKey>>} */
let product;
/** @type {Awaited<ReturnType<typeof makeKey>>} */
let other;
beforeAll(async () => {
	portal = await makeKey('portal-1');
	product = await makeKey('product-1');
	other = await makeKey('product-1');
});

/** @param {string} body @param {(value: any) => any} change */
const edit = (body, change) => JSON.stringify(change(JSON.parse(body)));

describe('connection codes', () => {
	it('round-trips the Portal URL and a 256-bit token; only the hash is stored', () => {
		const { code, token, tokenHash } = createConnectionCode({ portalUrl: `${PORTAL}/`, randomBytes: seededRandom(1) });
		expect(code).toMatch(/^ssc_[A-Za-z0-9_-]+$/);
		expect(parseConnectionCode(` ${code} `)).toEqual({ portalUrl: PORTAL, token });
		expect(tokenHash).toBe(hashConnectionToken(token));
		expect(code).not.toContain(tokenHash);
	});

	it('rejects anything that is not a connection code', () => {
		for (const bad of [undefined, '', 'ssc_', 'abc', 'ssc_***', `ssc_${Buffer.from('https://p.test').toString('base64url')}`])
			expectThrowCode(() => parseConnectionCode(bad), 'invalid_argument');
		const notUrl = `ssc_${Buffer.from(`ftp://x sct_${'a'.repeat(43)}`).toString('base64url')}`;
		expectThrowCode(() => parseConnectionCode(notUrl), 'invalid_argument');
	});
});

describe('connect handshake', () => {
	/** @param {ReturnType<typeof createClock>} clock */
	const start = async (clock, signer = product.signer, publicJwk = product.publicJwk) => {
		const { code, tokenHash } = createConnectionCode({ portalUrl: PORTAL });
		const request = await createConnectRequest({ code, baseUrl: `${BASE}/`, manifest, signer, publicJwk, now: clock.now });
		return { code, tokenHash, request };
	};

	it('proves possession of the new key, bound to token, manifest and base URL; the answer is verified', async () => {
		const clock = createClock();
		const { tokenHash, request } = await start(clock);
		expect(request.url).toBe(`${PORTAL}${CONNECT_PATH}`);
		const verified = await verifyConnectRequest({
			headers: request.headers,
			body: request.body,
			portalUrl: PORTAL,
			now: clock.now,
		});
		expect(verified).toMatchObject({ tokenHash, baseUrl: BASE, nonce: request.nonce, thumbprint: request.jkt });
		expect(hashManifest(verified.manifest)).toBe(hashManifest(manifest));
		expect(verified.publicJwk).not.toHaveProperty('d');

		const answer = await createConnectResponse({
			signer: portal.signer,
			appId: 'app_1',
			portalUrl: PORTAL,
			jkt: verified.thumbprint,
			nonce: verified.nonce,
			jwks: createJwks([portal.publicJwk]),
			now: clock.now,
		});
		const parsed = JSON.parse(JSON.stringify(answer));
		const accepted = await verifyConnectResponse({
			body: parsed,
			portalUrl: PORTAL,
			nonce: request.nonce,
			jkt: request.jkt,
			now: clock.now,
		});
		expect(accepted).toMatchObject({ appId: 'app_1', portalKid: 'portal-1' });
		await expect(
			verifyConnectResponse({
				body: parsed,
				portalUrl: PORTAL,
				nonce: 'another-nonce-0123',
				jkt: request.jkt,
				now: clock.now,
			}),
		).rejects.toMatchObject({ code: 'replay' });
		await expect(
			verifyConnectResponse({
				body: { ...parsed, appId: 'app_2' },
				portalUrl: PORTAL,
				nonce: request.nonce,
				jkt: request.jkt,
				now: clock.now,
			}),
		).rejects.toMatchObject({ code: 'malformed' });
		await expect(
			verifyConnectResponse({
				body: parsed,
				portalUrl: 'https://evil.test',
				nonce: request.nonce,
				jkt: request.jkt,
				now: clock.now,
			}),
		).rejects.toMatchObject({ code: 'audience' });
		await expect(
			verifyConnectResponse({ body: parsed, portalUrl: PORTAL, nonce: request.nonce, jkt: 'other', now: clock.now }),
		).rejects.toMatchObject({ code: 'subject' });
		await expect(verifyConnectResponse({ body: {}, portalUrl: PORTAL, nonce: 'n', jkt: 'j' })).rejects.toMatchObject({
			code: 'malformed',
		});
	});

	it('refuses tampering, other tokens, other Portals, stale requests and foreign keys', async () => {
		const clock = createClock();
		const { request } = await start(clock);
		/** @param {Partial<{ headers: any, body: string, portalUrl: string }>} change */
		const verify = (change) =>
			verifyConnectRequest({ headers: request.headers, body: request.body, portalUrl: PORTAL, now: clock.now, ...change });
		await expect(verify({ headers: {} })).rejects.toMatchObject({ code: 'malformed' });
		await expect(verify({ headers: { authorization: `Bearer sct_${'b'.repeat(43)}` } })).rejects.toMatchObject({
			code: 'signature',
		});
		await expect(verify({ portalUrl: 'https://other.test' })).rejects.toMatchObject({ code: 'audience' });
		await expect(
			verify({ body: edit(request.body, (b) => ({ ...b, manifest: { ...manifest, x: 1 } })) }),
		).rejects.toMatchObject({
			code: 'signature',
		});
		await expect(verify({ body: edit(request.body, (b) => ({ ...b, publicJwk: other.publicJwk })) })).rejects.toMatchObject({
			code: 'signature',
		});
		await expect(verify({ body: edit(request.body, (b) => ({ ...b, publicJwk: { kty: 'RSA' } })) })).rejects.toMatchObject({
			code: 'malformed',
		});
		await expect(verify({ body: 'not json' })).rejects.toMatchObject({ code: 'malformed' });
		await expect(verify({ body: JSON.stringify({ request: 1 }) })).rejects.toMatchObject({ code: 'malformed' });
		clock.advance(301_000);
		await expect(verify({})).rejects.toMatchObject({ code: 'expired' });
		await expect(
			createConnectRequest({
				code: createConnectionCode({ portalUrl: PORTAL }).code,
				baseUrl: BASE,
				manifest,
				signer: portal.signer,
				publicJwk: product.publicJwk,
			}),
		).rejects.toMatchObject({ code: 'invalid_argument' });
	});

	it('canonicalises URLs for pinning', () => {
		expect(canonicalUrl('HTTPS://Portal.Test:443/')).toBe('https://portal.test');
		for (const bad of [1, 'nope', 'ftp://x', 'https://u:p@x', 'https://x/?q', 'https://x/#f'])
			expectThrowCode(() => canonicalUrl(bad), 'invalid_argument');
	});
});
