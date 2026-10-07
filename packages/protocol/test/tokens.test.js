import { beforeAll, describe, expect, it } from 'vitest';
import {
	TOKEN_KINDS,
	canonicalOrigin,
	createJwks,
	createKeyResolver,
	isLocalOrigin,
	isProductId,
	issueToken,
	normalizeDomain,
	originAllowed,
	ticketOriginAllowed,
	verifyToken,
} from '../src/index.js';
import { signCompact } from '../src/jws.js';
import {
	createClock,
	decodeSegment,
	expectCode,
	expectThrowCode,
	makeKey,
	seededRandom,
	staticResolver,
	tamperSegment,
	tamperSignature,
} from './helpers.js';

const ISS = 'https://portal.test';

/** @type {Awaited<ReturnType<typeof makeKey>>} */
let portal;
/** @type {Awaited<ReturnType<typeof makeKey>>} */
let attacker;

beforeAll(async () => {
	portal = await makeKey('portal-1');
	attacker = await makeKey('portal-1');
});

/**
 * @param {ReturnType<typeof createClock>} clock
 * @param {Record<string, any>} [overrides]
 */
const issue = (clock, overrides = {}) =>
	issueToken({
		signer: portal.signer,
		issuer: ISS,
		websiteId: 'web_1',
		domain: 'Shop.Example.com',
		productId: 'chat',
		kind: 'browser',
		now: clock.now,
		randomBytes: seededRandom(),
		...overrides,
	});

/**
 * @param {ReturnType<typeof createClock>} clock
 * @param {unknown} token
 * @param {Record<string, any>} [overrides]
 */
const verify = (clock, token, overrides = {}) =>
	verifyToken({
		token,
		keyResolver: staticResolver([portal.publicJwk]),
		issuer: ISS,
		productId: 'chat',
		now: clock.now,
		...overrides,
	});

/** @param {Record<string, unknown>} payload */
const signRaw = (payload) => signCompact({ signer: portal.signer, typ: 'ss-token+jws', payload });

describe('tokens', () => {
	it('issues tokens with exactly the seven claims and no expiry', async () => {
		const clock = createClock();
		const { token, claims } = await issue(clock);
		expect(Object.keys(claims).sort()).toEqual(['domain', 'iat', 'iss', 'jti', 'kind', 'productId', 'websiteId']);
		expect(claims).toMatchObject({
			iss: ISS,
			websiteId: 'web_1',
			domain: 'shop.example.com',
			productId: 'chat',
			kind: 'browser',
		});
		expect(decodeSegment(token, 0)).toEqual({ alg: 'EdDSA', kid: 'portal-1', typ: 'ss-token+jws' });
		expect(decodeSegment(token, 1)).toEqual(claims);
		expect(TOKEN_KINDS).toEqual(['browser', 'server']);
	});

	it('verifies offline, years later, with or without an expected kind', async () => {
		const clock = createClock();
		const { token, claims } = await issue(clock, { kind: 'server', jti: 'tok_fixed' });
		clock.advance(3 * 365 * 24 * 3_600_000);
		expect(await verify(clock, token)).toEqual(claims);
		expect(await verify(clock, token, { kind: 'server' })).toEqual(claims);
		expect(await verify(clock, token, { isRevoked: async () => false })).toEqual(claims);
	});

	it('refuses every bad token with the same invalid_token error', async () => {
		const clock = createClock();
		const { token, claims } = await issue(clock);
		const cases = [
			() => verify(clock, token, { kind: 'server' }),
			() => verify(clock, token, { productId: 'growth' }),
			() => verify(clock, token, { issuer: 'https://evil.test' }),
			() => verify(clock, token, { isRevoked: (/** @type {string} */ jti) => jti === claims.jti }),
			() => verify(clock, token, { keyResolver: staticResolver([attacker.publicJwk]) }),
			() => verify(clock, token, { keyResolver: staticResolver([]) }),
			() => verify(clock, tamperSignature(token)),
			() =>
				verify(
					clock,
					tamperSegment(token, 0, (h) => ({ ...h, typ: 'ss-ticket+jws' })),
				),
			() =>
				verify(
					clock,
					tamperSegment(token, 1, (p) => ({ ...p, websiteId: 'web_2' })),
				),
			() => verify(clock, 'nope'),
			() => verify(clock, 42),
			() => verify(clock, `${token}x`.repeat(300)),
			async () => verify(clock, await signRaw({ ...claims, kind: 'admin' })),
			async () => verify(clock, await signRaw({ ...claims, jti: '' })),
			async () => verify(clock, await signRaw({ ...claims, websiteId: 5 })),
			async () => verify(clock, await signRaw({ ...claims, domain: 'SHOP.example.com' })),
			async () => verify(clock, await signRaw({ ...claims, domain: 'localhost' })),
			async () => verify(clock, await signRaw({ ...claims, domain: undefined })),
			async () => verify(clock, await signRaw({ ...claims, iat: 'x' })),
			async () => verify(clock, await signRaw({ ...claims, iat: claims.iat + 301 })),
		];
		for (const run of cases)
			await expect(run()).rejects.toMatchObject({
				name: 'ProtocolError',
				code: 'invalid_token',
				message: 'token is not valid',
			});
		expect(await verify(clock, await signRaw({ ...claims, iat: claims.iat + 299, extra: 1 }))).toEqual({
			...claims,
			iat: claims.iat + 299,
		});
	});

	it('passes errors of the revocation lookup through', async () => {
		const clock = createClock();
		const { token } = await issue(clock);
		const failure = new Error('database down');
		await expect(
			verify(clock, token, {
				isRevoked: () => {
					throw failure;
				},
			}),
		).rejects.toBe(failure);
	});

	it('passes unexpected key resolver errors through', async () => {
		const clock = createClock();
		const { token } = await issue(clock);
		const failure = new TypeError('boom');
		await expect(
			verify(clock, token, {
				keyResolver: {
					resolve: () => {
						throw failure;
					},
				},
			}),
		).rejects.toBe(failure);
	});

	it('rejects a revoked Portal key as invalid_token', async () => {
		const clock = createClock();
		const { token } = await issue(clock);
		const keyResolver = createKeyResolver({ jwks: createJwks([portal.publicJwk]), revokedKids: ['portal-1'] });
		await expectCode(verify(clock, token, { keyResolver }), 'invalid_token');
	});

	it('validates arguments', async () => {
		const clock = createClock();
		await expectCode(issue(clock, { issuer: '' }), 'invalid_argument');
		await expectCode(issue(clock, { websiteId: '' }), 'invalid_argument');
		await expectCode(issue(clock, { productId: 'Chat' }), 'invalid_argument');
		await expectCode(issue(clock, { kind: 'pk' }), 'invalid_argument');
		await expectCode(issue(clock, { jti: '' }), 'invalid_argument');
		await expectCode(issue(clock, { domain: 'localhost' }), 'invalid_argument');
		const { token } = await issue(clock);
		await expectCode(verify(clock, token, { issuer: '' }), 'invalid_argument');
		await expectCode(verify(clock, token, { productId: 'x' }), 'invalid_argument');
		await expectCode(verify(clock, token, { kind: 'pk' }), 'invalid_argument');
		await expectCode(verify(clock, token, { keyResolver: null }), 'invalid_argument');
	});

	it('checks product ids', () => {
		for (const id of ['accounts', 'ecommerce', 'chat', 'notifications', 'payments', 'growth', 'my-product1'])
			expect(isProductId(id)).toBe(true);
		for (const id of ['a', 'Chat', '1chat', 'chat_x', 'a'.repeat(32), 7]) expect(isProductId(id)).toBe(false);
	});
});

describe('normalizeDomain', () => {
	it.each([
		['shop.com', 'shop.com'],
		['Shop.Example.COM', 'shop.example.com'],
		['shop.com.', 'shop.com'],
		['münchen.de', 'xn--mnchen-3ya.de'],
		['123.example.com', '123.example.com'],
	])('normalises %s', (input, expected) => {
		expect(normalizeDomain(input)).toBe(expected);
	});

	it.each([
		['not a string', 5],
		['empty', ''],
		['too long', `${'a.'.repeat(127)}com`],
		['a scheme', 'https://shop.com'],
		['a port', 'shop.com:443'],
		['a path', 'shop.com/x'],
		['userinfo', 'a@shop.com'],
		['a wildcard', '*.shop.com'],
		['whitespace', 'shop .com'],
		['a backslash', 'shop.com\\x'],
		['a percent', 'shop%2ecom'],
		['an IPv4 literal', '192.168.0.1'],
		['a numeric name', '1.2.3'],
		['an IPv6 literal', '[::1]'],
		['localhost', 'localhost'],
		['a localhost subdomain', 'app.localhost'],
		['a single label', 'intranet'],
		['an empty label', 'a..b.com'],
		['a bad label', '-shop.com'],
		['an underscore', 'ex_ample.com'],
	])('refuses %s', (_name, input) => {
		expectThrowCode(() => normalizeDomain(input), 'invalid_argument');
	});
});

describe('origins', () => {
	it('canonicalises origins', () => {
		expect(canonicalOrigin('HTTPS://Shop.COM:443')).toBe('https://shop.com');
		expect(canonicalOrigin('http://shop.com:80')).toBe('http://shop.com');
		expect(canonicalOrigin('https://shop.com:8443')).toBe('https://shop.com:8443');
		expect(canonicalOrigin('https://münchen.de')).toBe('https://xn--mnchen-3ya.de');
		expect(canonicalOrigin('http://[::1]:3000')).toBe('http://[::1]:3000');
		for (const bad of [
			undefined,
			'',
			'null',
			'https://shop.com/',
			'https://shop.com/x',
			'https://shop.com?x',
			'https://shop.com#x',
			'https://u:p@shop.com',
			'https://@shop.com',
			'ftp://shop.com',
			'https://shop .com',
			'https://shop.com\\x',
			'https://shop.com\u0000',
			'https://',
			'https://shop.com:99999',
			`https://${'a'.repeat(2050)}.com`,
		])
			expect(canonicalOrigin(bad)).toBeNull();
	});

	it('recognises local origins on any port', () => {
		for (const origin of [
			'http://localhost',
			'https://localhost:3000',
			'http://shop.localhost:8080',
			'http://127.0.0.1:5173',
			'https://[::1]:3000',
		])
			expect(isLocalOrigin(origin)).toBe(true);
		for (const origin of ['http://127.0.0.2', 'https://localhost.shop.com', 'http://10.0.0.1', 'localhost', null])
			expect(isLocalOrigin(origin)).toBe(false);
	});

	it('allows browser tokens only from the exact https domain or a local origin', () => {
		const domain = 'shop.com';
		expect(originAllowed({ origin: 'https://shop.com', domain })).toBe(true);
		expect(originAllowed({ origin: 'https://SHOP.com:443', domain: 'Shop.com' })).toBe(true);
		expect(originAllowed({ origin: 'http://localhost:3000', domain })).toBe(true);
		expect(originAllowed({ origin: 'https://127.0.0.1:8443', domain })).toBe(true);
		for (const origin of [
			'http://shop.com',
			'https://shop.com:8443',
			'https://www.shop.com',
			'https://evilshop.com',
			'https://shop.com.evil.com',
			'https://shop.com/',
			'null',
			undefined,
			'',
		])
			expect(originAllowed({ origin, domain })).toBe(false);
		expect(originAllowed({ origin: 'https://shop.com', domain: 'not a domain' })).toBe(false);
	});

	it('allows tickets from any https origin or a local origin', () => {
		expect(ticketOriginAllowed('https://admin.shop.com')).toBe(true);
		expect(ticketOriginAllowed('https://other.example:8443')).toBe(true);
		expect(ticketOriginAllowed('http://localhost:3000')).toBe(true);
		expect(ticketOriginAllowed('http://admin.shop.com')).toBe(false);
		expect(ticketOriginAllowed('https://admin.shop.com/path')).toBe(false);
		expect(ticketOriginAllowed(undefined)).toBe(false);
	});
});
