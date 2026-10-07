import { describe, expect, it } from 'vitest';
import {
	SCRYPT_PARAMS,
	actorFromSession,
	base32Decode,
	base32Encode,
	checkCsrf,
	clearCookie,
	findRecoveryCode,
	generateRecoveryCodes,
	generateTotpSecret,
	hashPassword,
	hotp,
	needsRehash,
	readCookie,
	serializeCookie,
	sessionCookieName,
	totpCode,
	totpUri,
	verifyPassword,
	verifyTotp,
} from '../src/infra/auth.js';
import { MERCHANT } from './helpers.js';

const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('passwords', () => {
	it('hashes with scrypt N=2^15 r=8 p=1 and a 64-byte key', async () => {
		const hash = await hashPassword('correct horse battery staple');
		const [scheme, N, r, p, salt, key] = hash.split('$');
		expect([scheme, Number(N), Number(r), Number(p)]).toEqual(['scrypt', 2 ** 15, 8, 1]);
		expect(Buffer.from(/** @type {string} */ (salt), 'base64url').length).toBe(16);
		expect(Buffer.from(/** @type {string} */ (key), 'base64url').length).toBe(64);
		expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
		expect(await verifyPassword('correct horse battery stapl', hash)).toBe(false);
		expect(await hashPassword('correct horse battery staple')).not.toBe(hash); // per-user salt
		expect(needsRehash(hash)).toBe(false);
	});

	it('verifies a dummy hash for unknown accounts and rejects junk', async () => {
		expect(await verifyPassword('anything', null)).toBe(false);
		expect(await verifyPassword('anything', 'garbage')).toBe(false);
		expect(await verifyPassword('anything', 'scrypt$3$8$1$AAAA$AAAA')).toBe(false);
		expect(await verifyPassword('', await hashPassword('x'))).toBe(false);
		await expect(hashPassword('')).rejects.toThrow();
		await expect(hashPassword('x'.repeat(2000))).rejects.toThrow();
	});

	it('flags weaker parameters for rehash', async () => {
		const weak = await hashPassword('pw', { params: { N: 2 ** 14 } });
		expect(await verifyPassword('pw', weak)).toBe(true);
		expect(needsRehash(weak)).toBe(true);
		expect(needsRehash('nope')).toBe(true);
		expect(SCRYPT_PARAMS.keyLength).toBe(64);
		for (const bad of [
			'scrypt$x$8$1$a$b',
			'scrypt$32768$99$1$a$b',
			'scrypt$32768$8$99$a$b',
			'scrypt$32768$8$1$AA$AA',
			'scrypt$1000$8$1$a$b',
		]) {
			expect(needsRehash(bad)).toBe(true);
		}
	});
});

describe('TOTP (RFC 6238)', () => {
	it('matches the RFC 6238 SHA-1 test vectors', () => {
		const vectors = [
			[59, '94287082'],
			[1111111109, '07081804'],
			[1111111111, '14050471'],
			[1234567890, '89005924'],
			[2000000000, '69279037'],
		];
		for (const [t, code] of vectors) expect(totpCode(RFC_SECRET, Number(t) * 1000, { digits: 8 })).toBe(code);
		const sha256 = base32Encode(Buffer.from('12345678901234567890123456789012'));
		expect(totpCode(sha256, 59_000, { digits: 8, algorithm: 'sha256' })).toBe('46119246');
	});

	it('HOTP matches RFC 4226', () => {
		expect([0, 1, 2, 9].map((c) => hotp(Buffer.from('12345678901234567890'), c))).toEqual([
			'755224',
			'287082',
			'359152',
			'520489',
		]);
	});

	it('verifies within the window and refuses replays', () => {
		const secret = generateTotpSecret();
		expect(base32Decode(secret).length).toBe(20);
		const at = 1_790_000_000_000;
		const code = totpCode(secret, at);
		const ok = verifyTotp(secret, code, { now: () => at });
		expect(ok.ok).toBe(true);
		const step = /** @type {{ step: number }} */ (ok).step;
		expect(verifyTotp(secret, code, { now: () => at, lastStep: step })).toEqual({ ok: false });
		expect(verifyTotp(secret, totpCode(secret, at - 30_000), { now: () => at }).ok).toBe(true);
		expect(verifyTotp(secret, totpCode(secret, at - 90_000), { now: () => at }).ok).toBe(false);
		expect(verifyTotp(secret, '12345', { now: () => at })).toEqual({ ok: false });
		expect(verifyTotp(secret, 123456, { now: () => at })).toEqual({ ok: false });
		expect(() => base32Decode('!!')).toThrow();
		expect(totpUri({ secret: 'ABC', issuer: 'Single Solution', account: 'a@b.c' })).toBe(
			'otpauth://totp/Single%20Solution:a%40b.c?secret=ABC&issuer=Single+Solution&algorithm=SHA1&digits=6&period=30',
		);
	});

	it('recovery codes are single values hashed with the secret', () => {
		const secret = Buffer.alloc(32, 1);
		const { codes, hashes } = generateRecoveryCodes({ secret, count: 8 });
		expect(codes).toHaveLength(8);
		expect(codes[0]).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/);
		expect(hashes.join()).not.toContain(/** @type {string} */ (codes[0]).replace('-', ''));
		expect(findRecoveryCode(/** @type {string} */ (codes[3]), hashes, secret)).toBe(3);
		expect(findRecoveryCode(/** @type {string} */ (codes[3]).toUpperCase().replace('-', ' '), hashes, secret)).toBe(3);
		expect(findRecoveryCode('wrong-codes', hashes, secret)).toBe(-1);
		expect(findRecoveryCode(/** @type {string} */ (codes[3]), hashes, Buffer.alloc(32, 2))).toBe(-1);
		expect(findRecoveryCode(42, hashes, secret)).toBe(-1);
	});
});

describe('cookies', () => {
	it('serialises HttpOnly SameSite=Lax cookies with the __Host- prefix when secure', () => {
		expect(sessionCookieName('admin', true)).toBe('__Host-ss_admin');
		expect(sessionCookieName('merchant', false)).toBe('ss_merchant');
		expect(serializeCookie('__Host-ss_staff', 'abc', { secure: true, maxAgeSeconds: 60.7 })).toBe(
			'__Host-ss_staff=abc; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=60',
		);
		expect(clearCookie('ss_staff', { secure: false })).toBe('ss_staff=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
		expect(() => serializeCookie('bad name', 'x', { secure: true })).toThrow();
		expect(() => serializeCookie('ok', 'x;y', { secure: true })).toThrow();
	});

	it('reads cookies and refuses duplicates', () => {
		expect(readCookie('a=1; ss_staff=tok; b=2', 'ss_staff')).toBe('tok');
		expect(readCookie('ss_staff=one; ss_staff=two', 'ss_staff')).toBeUndefined();
		expect(readCookie(null, 'x')).toBeUndefined();
		expect(readCookie('novalue; x=1', 'x')).toBe('1');
	});
});

describe('CSRF', () => {
	const origin = 'https://portal.test';
	/** @param {Record<string, string>} headers */
	const check = (headers, method = 'POST') => checkCsrf({ method, headers: new Headers(headers), allowedOrigin: origin });

	it('passes safe methods and same-origin mutations', () => {
		expect(check({}, 'GET')).toEqual({ ok: true });
		expect(check({ 'sec-fetch-site': 'same-origin', origin })).toEqual({ ok: true });
		expect(check({ origin: 'HTTPS://PORTAL.TEST' })).toEqual({ ok: true });
		expect(check({ 'sec-fetch-site': 'same-origin' })).toEqual({ ok: true });
	});

	it('refuses cross-site, mismatching, null and missing origins', () => {
		expect(check({})).toEqual({ ok: false, reason: 'missing_origin' });
		expect(check({ 'sec-fetch-site': 'cross-site', origin })).toEqual({ ok: false, reason: 'cross_site' });
		expect(check({ 'sec-fetch-site': 'same-site' })).toEqual({ ok: false, reason: 'cross_site' });
		expect(check({ 'sec-fetch-site': 'none' })).toEqual({ ok: false, reason: 'cross_site' });
		expect(check({ origin: 'https://evil.test' })).toEqual({ ok: false, reason: 'origin_mismatch' });
		expect(check({ origin: 'null' })).toEqual({ ok: false, reason: 'origin_mismatch' });
		expect(check({ origin: 'https://portal.test.evil.com' }, 'DELETE')).toEqual({ ok: false, reason: 'origin_mismatch' });
	});
});

describe('actorFromSession', () => {
	const base = {
		id: 'h',
		mfa: true,
		createdAt: new Date(),
		lastSeenAt: new Date(),
		expiresAt: new Date(),
		absoluteExpiresAt: new Date(),
	};
	it('maps admin and merchant sessions (one login = one admin or one merchant)', () => {
		expect(actorFromSession({ ...base, kind: 'admin', subject: 'adm_1', merchantId: null })).toEqual({
			type: 'admin',
			id: 'adm_1',
		});
		expect(actorFromSession({ ...base, kind: 'merchant', subject: MERCHANT, merchantId: MERCHANT })).toEqual({
			type: 'merchant',
			id: MERCHANT,
			merchantId: MERCHANT,
		});
	});
});
