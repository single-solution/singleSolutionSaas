import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { IDENTITY_MAX_AGE_MS, IDENTITY_MAX_LIFE_SECONDS, verifyIdentityToken } from '../src/identity.js';
import { T0, setup } from './helpers.js';

const NOW_S = Math.floor(T0 / 1000);
const ISSUER = 'https://accounts.example.dev/';
const AUDIENCE = 'web_1';
/** @param {Record<string, unknown>} [over] */
const claims = (over = {}) => ({
	iss: ISSUER,
	aud: AUDIENCE,
	sub: 'cust-42',
	email: 'a@example.com',
	iat: NOW_S,
	exp: NOW_S + 600,
	...over,
});
const now = () => T0;

/**
 * An issuer for tests: a key pair, the issuer settings and `sign(claims, header?)`.
 * @param {{ alg?: 'EdDSA' | 'ES256' | 'RS256', kid?: string }} [options]
 */
const createIssuer = ({ alg = 'EdDSA', kid = 'site-key-1' } = {}) => {
	const pair =
		alg === 'EdDSA'
			? generateKeyPairSync('ed25519')
			: alg === 'ES256'
				? generateKeyPairSync('ec', { namedCurve: 'P-256' })
				: generateKeyPairSync('rsa', { modulusLength: 2048 });
	const jwk = /** @type {Record<string, string>} */ (pair.publicKey.export({ format: 'jwk' }));
	const section = { issuer: ISSUER, jwks: [{ ...jwk, kid, alg, use: 'sig' }], audience: AUDIENCE };
	/** @param {unknown} value */
	const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
	return {
		section,
		/** @param {Record<string, unknown>} payload @param {Record<string, unknown>} [header] */
		sign: (payload, header = {}) => {
			const input = `${b64({ alg, kid, typ: 'JWT', ...header })}.${b64(payload)}`;
			const signature = cryptoSign(
				alg === 'EdDSA' ? null : 'sha256',
				Buffer.from(input),
				alg === 'ES256' ? { key: pair.privateKey, dsaEncoding: 'ieee-p1363' } : pair.privateKey,
			);
			return `${input}.${signature.toString('base64url')}`;
		},
	};
};

describe('verifyIdentityToken', () => {
	it.each(/** @type {const} */ (['EdDSA', 'ES256', 'RS256']))('accepts %s tokens and maps the claims', (alg) => {
		const issuer = createIssuer({ alg });
		const payload = claims({ phone: '+96550000000', tier: { name: 'gold' } });
		const result = verifyIdentityToken(issuer.sign(payload), issuer.section, { now });
		expect(result).toEqual({
			ok: true,
			identity: { subject: 'cust-42', email: 'a@example.com', phone: '+96550000000', issuer: ISSUER, claims: payload },
		});
	});

	it('refuses every malformed, mismatched, expired or forged token with a stable code', () => {
		const issuer = createIssuer();
		const other = createIssuer({ kid: 'site-key-1' });
		const ok = issuer.sign(claims({ aud: ['x', AUDIENCE] }));
		expect(verifyIdentityToken(ok, issuer.section, { now }).ok).toBe(true);
		const [h, p] = ok.split('.');
		/** @type {Array<[unknown, string]>} */
		const cases = [
			[undefined, 'identity_missing'],
			['', 'identity_missing'],
			['x'.repeat(9000), 'malformed'],
			['a.b', 'malformed'],
			['a.b.c d', 'malformed'],
			[`${h}..`, 'malformed'],
			[`bm90LWpzb24.${p}.c2ln`, 'malformed'],
			[issuer.sign(claims(), { jku: 'https://evil.example/jwks' }), 'malformed'],
			[issuer.sign(claims(), { alg: 'none' }), 'algorithm'],
			[issuer.sign(claims(), { alg: 'HS256' }), 'algorithm'],
			[issuer.sign(claims(), { alg: 'ES256' }), 'unknown_key'],
			[issuer.sign(claims(), { kid: 'other' }), 'unknown_key'],
			[other.sign(claims()), 'signature'],
			[issuer.sign(claims({ iss: 'https://evil.example/' })), 'issuer'],
			[issuer.sign(claims({ aud: 'other' })), 'audience'],
			[issuer.sign(claims({ aud: undefined })), 'audience'],
			[issuer.sign(claims({ exp: NOW_S - 61 })), 'expired'],
			[issuer.sign(claims({ exp: undefined })), 'expired'],
			[issuer.sign(claims({ nbf: NOW_S + 120 })), 'not_yet_valid'],
			[issuer.sign(claims({ nbf: 'soon' })), 'not_yet_valid'],
			[issuer.sign(claims({ iat: NOW_S + 120 })), 'not_yet_valid'],
			[issuer.sign(claims({ iat: undefined })), 'not_yet_valid'],
			[issuer.sign(claims({ iat: NOW_S - IDENTITY_MAX_AGE_MS / 1000 - 1 })), 'too_old'],
			[issuer.sign(claims({ sub: '' })), 'subject'],
			[issuer.sign(claims({ sub: 'x'.repeat(300) })), 'subject'],
		];
		for (const [token, code] of cases)
			expect(verifyIdentityToken(token, issuer.section, { now }), String(code)).toEqual({ ok: false, code });
		// a numeric subject is stringified; a key without kid matches when it is the only compatible key
		const kidless = issuer.sign(claims({ sub: 42 }), { kid: undefined });
		expect(verifyIdentityToken(kidless, issuer.section, { now })).toMatchObject({ ok: true, identity: { subject: '42' } });
		// a corrupted signature never throws
		expect(verifyIdentityToken(`${h}.${p}.AAAA`, issuer.section, { now })).toEqual({ ok: false, code: 'signature' });
	});
});

describe('verifyIdentityToken: the life of a sign-in', () => {
	it('refuses a token that lives longer than the 15 minutes Accounts issues, so a removed role cannot be used for a day', () => {
		const issuer = createIssuer();
		expect(IDENTITY_MAX_LIFE_SECONDS).toBe(900);
		const life = (/** @type {number} */ seconds) => issuer.sign(claims({ exp: NOW_S + seconds }));
		expect(verifyIdentityToken(life(900), issuer.section, { now }).ok).toBe(true);
		expect(verifyIdentityToken(life(1), issuer.section, { now }).ok).toBe(true);
		expect(verifyIdentityToken(life(901), issuer.section, { now })).toEqual({ ok: false, code: 'too_long' });
		expect(verifyIdentityToken(life(24 * 60 * 60), issuer.section, { now })).toEqual({ ok: false, code: 'too_long' });
		// the life counts from `iat`, not from now: a token issued 10 minutes ago for 30 minutes is refused too
		const earlier = issuer.sign(claims({ iat: NOW_S - 600, exp: NOW_S + 1200 }));
		expect(verifyIdentityToken(earlier, issuer.section, { now })).toEqual({ ok: false, code: 'too_long' });
		const fine = issuer.sign(claims({ iat: NOW_S - 600, exp: NOW_S + 300 }));
		expect(verifyIdentityToken(fine, issuer.section, { now }).ok).toBe(true);
	});

	it('a staff route of a product refuses a long-lived sign-in too', async () => {
		const { product, websiteId, accounts, link } = await setup();
		await link('accounts');
		const token = await accounts.signIn({ websiteId, sub: 'usr_1', role: 'owner', ttlSeconds: 24 * 60 * 60 });
		expect(await product.accounts.verify({ websiteId, token })).toEqual({ ok: false, code: 'too_long' });
		const ok = await accounts.signIn({ websiteId, sub: 'usr_1', role: 'owner' });
		expect((await product.accounts.verify({ websiteId, token: ok })).ok).toBe(true);
	});
});

describe('accounts.verify (Accounts sign-ins through the pasted Accounts token)', () => {
	it('refuses until the token is pasted, then verifies sign-ins offline with the keys fetched once', async () => {
		const { product, websiteId, accounts, link, clock } = await setup();
		const token = await accounts.signIn({ websiteId, sub: 'usr_1', email: 'a@example.com', role: 'customer' });
		expect(await product.accounts.verify({ websiteId, token })).toEqual({ ok: false, code: 'accounts_not_connected' });
		expect(await product.accounts.verify({ websiteId, token: '' })).toEqual({ ok: false, code: 'identity_missing' });
		await link('accounts');
		expect(await product.accounts.verify({ websiteId, token })).toMatchObject({
			ok: true,
			user: { id: 'usr_1', email: 'a@example.com', role: 'customer' },
			claims: { sub: 'usr_1', aud: websiteId },
		});
		// another website's sign-in is refused (audience), and so is an expired one
		const other = await accounts.signIn({ websiteId: 'web_other', sub: 'usr_1' });
		expect(await product.accounts.verify({ websiteId, token: other })).toEqual({ ok: false, code: 'audience' });
		clock.advance(16 * 60_000);
		expect(await product.accounts.verify({ websiteId, token })).toEqual({ ok: false, code: 'expired' });
		// keys unavailable once the cached copy is older than 10 minutes
		accounts.setFailing(true);
		clock.advance(11 * 60_000);
		const fresh = await accounts.signIn({ websiteId, sub: 'usr_2' });
		expect(await product.accounts.verify({ websiteId, token: fresh })).toEqual({ ok: false, code: 'accounts_unavailable' });
	});
});
