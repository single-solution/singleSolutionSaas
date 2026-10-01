import { describe, expect, it } from 'vitest';
import {
	IDENTITY_MAX_AGE_MS,
	createIdentity,
	createRequestHandler,
	defineRoute,
	identityTokenOf,
	verifyIdentityToken,
} from '../src/index.js';
import { createTestIdentityIssuer } from '../src/testing.js';
import { T0, entitle, setup, websiteKey } from './helpers.js';

const NOW_S = Math.floor(T0 / 1000);
const ISSUER = 'https://login.shop.example.com/';
/** @param {Record<string, unknown>} [over] */
const claims = (over = {}) => ({ iss: ISSUER, sub: 'cust-42', email: 'a@example.com', iat: NOW_S, exp: NOW_S + 600, ...over });
const now = () => T0;

describe('verifyIdentityToken', () => {
	it.each(/** @type {const} */ (['EdDSA', 'ES256', 'RS256']))('accepts %s tokens and maps the claims', (alg) => {
		const issuer = createTestIdentityIssuer({ alg });
		const result = verifyIdentityToken(issuer.sign(claims({ phone_number: '+96550000000' })), issuer.section, { now });
		expect(result).toEqual({
			ok: true,
			identity: { subject: 'cust-42', email: 'a@example.com', phone: '+96550000000', issuer: ISSUER },
		});
	});

	it('refuses every malformed, mismatched, expired or forged token with a stable code', () => {
		const issuer = createTestIdentityIssuer({ audience: 'shop-web' });
		const other = createTestIdentityIssuer({ kid: 'site-key-1' });
		const ok = issuer.sign(claims({ aud: ['x', 'shop-web'] }));
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
			[other.sign(claims({ aud: 'shop-web' })), 'signature'],
			[issuer.sign(claims({ iss: 'https://evil.example/', aud: 'shop-web' })), 'issuer'],
			[issuer.sign(claims({ aud: 'other' })), 'audience'],
			[issuer.sign(claims({ aud: 'shop-web', exp: NOW_S - 61 })), 'expired'],
			[issuer.sign(claims({ aud: 'shop-web', exp: undefined })), 'expired'],
			[issuer.sign(claims({ aud: 'shop-web', nbf: NOW_S + 120 })), 'not_yet_valid'],
			[issuer.sign(claims({ aud: 'shop-web', nbf: 'soon' })), 'not_yet_valid'],
			[issuer.sign(claims({ aud: 'shop-web', iat: NOW_S + 120 })), 'not_yet_valid'],
			[issuer.sign(claims({ aud: 'shop-web', iat: undefined })), 'not_yet_valid'],
			[issuer.sign(claims({ aud: 'shop-web', iat: NOW_S - IDENTITY_MAX_AGE_MS / 1000 - 1 })), 'too_old'],
			[issuer.sign(claims({ aud: 'shop-web', sub: '' })), 'subject'],
			[issuer.sign(claims({ aud: 'shop-web', sub: 'x'.repeat(300) })), 'subject'],
		];
		for (const [token, code] of cases)
			expect(verifyIdentityToken(token, issuer.section, { now }), String(code)).toEqual({ ok: false, code });
		expect(verifyIdentityToken(ok, null)).toEqual({ ok: false, code: 'identity_not_configured' });
		// a numeric subject is stringified; a key without kid matches when it is the only compatible key
		const kidless = issuer.sign(claims({ aud: 'shop-web', sub: 42 }), { kid: undefined });
		expect(verifyIdentityToken(kidless, issuer.section, { now })).toMatchObject({ ok: true, identity: { subject: '42' } });
		// a corrupted signature never throws
		expect(verifyIdentityToken(`${h}.${p}.AAAA`, issuer.section, { now })).toEqual({ ok: false, code: 'signature' });
	});

	it('reads the token from SS-Identity or the beacon body', () => {
		expect(identityTokenOf({ headers: new Headers({ 'ss-identity': ' tok ' }) }, { identity: 'body' })).toBe('tok');
		expect(identityTokenOf({ headers: new Headers() }, { identity: 'body' })).toBe('body');
		expect(identityTokenOf({ headers: new Headers() }, { identity: 7 })).toBeNull();
		expect(identityTokenOf({ headers: new Headers() })).toBeNull();
		const identity = createIdentity({ now });
		expect(identity.verify({ headers: new Headers() }, { doc: null })).toEqual({ ok: false, code: 'identity_missing' });
		expect(identity.verify({ headers: new Headers({ 'ss-identity': 't' }) }, { doc: /** @type {any} */ ({}) })).toEqual({
			ok: false,
			code: 'identity_not_configured',
		});
		const issuer = createTestIdentityIssuer();
		expect(identity.verifyToken(issuer.sign(claims()), issuer.section).ok).toBe(true);
	});
});

describe('route option identity', () => {
	it('rejects identity on routes without website auth or entitlement', () => {
		const handler = () => ({});
		expect(() => defineRoute({ method: 'GET', path: '/x', auth: 'none', identity: 'optional', handler })).toThrow(
			/website auth/,
		);
		expect(() =>
			defineRoute({ method: 'GET', path: '/x', auth: 'website', entitlement: false, identity: 'required', handler }),
		).toThrow(/website auth/);
		expect(() =>
			defineRoute({ method: 'GET', path: '/x', auth: 'website', identity: /** @type {any} */ ('yes'), handler }),
		).toThrow(/required' or 'optional/);
	});

	it('puts the verified customer on ctx.identity (required → 401, optional → null with a reason)', async () => {
		const { portal, product } = await setup();
		const issuer = createTestIdentityIssuer();
		await entitle(portal, { identity: issuer.section });
		const pk = await websiteKey(portal);
		const handle = createRequestHandler(product, [
			defineRoute({
				method: 'GET',
				path: '/v1/me',
				auth: 'website',
				identity: 'required',
				handler: (ctx) => ({ identity: ctx.identity }),
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/beacon',
				auth: 'website',
				identity: 'optional',
				idempotent: false,
				handler: (ctx) => ({ identity: ctx.identity, problem: ctx.identityProblem }),
			}),
		]);
		const base = 'https://coupons.example.dev';
		const headers = { authorization: `Bearer ${pk}`, origin: 'https://shop.example.com' };
		/** @param {string} path @param {RequestInit} [init] */
		const call = async (path, init = {}) => {
			const res = await handle(new Request(`${base}${path}`, init));
			return { status: res.status, json: await res.json(), headers: res.headers };
		};
		const token = issuer.sign(claims());
		const me = await call('/v1/me', { headers: { ...headers, 'ss-identity': token } });
		expect(me.status).toBe(200);
		expect(me.json.identity).toEqual({ subject: 'cust-42', email: 'a@example.com', issuer: ISSUER });
		const missing = await call('/v1/me', { headers });
		expect([missing.status, missing.json.type]).toEqual([401, expect.stringMatching(/identity_required$/)]);
		const forged = createTestIdentityIssuer().sign(claims());
		const invalid = await call('/v1/me', { headers: { ...headers, 'ss-identity': forged } });
		expect([invalid.status, invalid.json.type, invalid.json.detail]).toEqual([
			401,
			expect.stringMatching(/identity_invalid$/),
			expect.stringContaining('signature'),
		]);
		// sendBeacon-style body identity
		const beacon = await call('/v1/beacon', {
			method: 'POST',
			headers: { ...headers, 'content-type': 'application/json' },
			body: JSON.stringify({ identity: token }),
		});
		expect(beacon.json).toEqual({ identity: { subject: 'cust-42', email: 'a@example.com', issuer: ISSUER }, problem: null });
		const anonymous = await call('/v1/beacon', {
			method: 'POST',
			headers: { ...headers, 'ss-identity': 'wt1.legacy.token' },
		});
		expect(anonymous.json).toEqual({ identity: null, problem: 'malformed' });
		// the browser may send SS-Identity cross-origin
		const preflight = await handle(
			new Request(`${base}/v1/me`, { method: 'OPTIONS', headers: { origin: 'https://shop.example.com' } }),
		);
		expect(preflight.headers.get('access-control-allow-headers')).toContain('ss-identity');

		// a website without an identity issuer
		await entitle(portal, { version: 2 });
		product.entitlements.invalidate('web_0123456789abcdefghjkmnpq');
		const unconfigured = await call('/v1/me', { headers: { ...headers, 'ss-identity': token } });
		expect([unconfigured.status, unconfigured.json.detail]).toEqual([401, expect.stringContaining('no identity issuer')]);
	});
});
