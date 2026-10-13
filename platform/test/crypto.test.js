import { describe, expect, it } from 'vitest';
import { generateSigningKey, issueToken, verifyToken } from '@ss/protocol';
import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { createPortalKeys, createSecretBox, resealEach, sumCounts } from '../src/infra/crypto.js';
import { isPlatformError } from '../src/infra/errors.js';
import { API_CSP, createNonce, pageCsp, staticSecurityHeaders } from '../src/infra/security-headers.js';
import { MERCHANT, WEBSITE } from './helpers.js';

const aad = { merchantId: MERCHANT, productId: 'notes' };

/** @param {() => unknown} fn */
const codeOf = (fn) => {
	try {
		fn();
	} catch (error) {
		return isPlatformError(error) ? error.code : 'other';
	}
	return null;
};

describe('portal keys', () => {
	it('signs with the first key and publishes all of them, browser and server tokens with their dedicated signer', async () => {
		const { privateJwk: current } = await generateSigningKey({ kid: 'portal-new' });
		const { privateJwk: previous } = await generateSigningKey({ kid: 'portal-old' });
		const { privateJwk: token } = await generateSigningKey({ kid: 'token-new' });
		const { privateJwk: tokenOld } = await generateSigningKey({ kid: 'token-old' });
		const keys = createPortalKeys([current, previous], [token, tokenOld]);
		expect(keys.activeKid).toBe('portal-new');
		expect(keys.signers.map((s) => s.kid)).toEqual(['portal-new', 'portal-old']);
		const jwks = keys.jwks();
		expect(jwks.keys.map((k) => k.kid)).toEqual(['portal-new', 'portal-old']);
		expect(JSON.stringify(jwks)).not.toContain('"d"');
		expect(keys.tokenSigner.kid).toBe('token-new');
		expect(keys.tokenJwks().keys.map((k) => k.kid)).toEqual(['token-new', 'token-old']);
		const published = keys.publishedJwks();
		expect(published.keys.map((k) => k.kid)).toEqual(['portal-new', 'portal-old', 'token-new', 'token-old']);
		expect(JSON.stringify(published)).not.toContain('"d"');

		/** @param {import('@ss/protocol').Signer} signer */
		const issue = async (signer) =>
			(
				await issueToken({
					signer,
					issuer: 'https://portal.test',
					websiteId: WEBSITE,
					domain: 'shop.example.com',
					productId: 'notes',
					kind: 'server',
				})
			).token;
		const verify = (/** @type {string} */ value, /** @type {import('@ss/protocol').KeyResolver} */ keyResolver) =>
			verifyToken({ token: value, keyResolver, issuer: 'https://portal.test', productId: 'notes' });
		// tokens signed by the token signer verify with the token resolver only
		const good = await issue(keys.tokenSigner);
		expect((await verify(good, keys.tokenKeyResolver)).websiteId).toBe(WEBSITE);
		await expect(verify(good, keys.keyResolver)).rejects.toThrow();
		// a token signed with the Portal key is never accepted as a token
		await expect(verify(await issue(keys.signer), keys.tokenKeyResolver)).rejects.toThrow();

		expect(codeOf(() => createPortalKeys([], [token]))).toBe('config_invalid');
		expect(codeOf(() => createPortalKeys([current], []))).toBe('config_invalid');
		const { privateJwk: clash } = await generateSigningKey({ kid: 'portal-new' });
		expect(codeOf(() => createPortalKeys([current], [clash]))).toBe('config_invalid');
	});
});

/**
 * A value as the Portal sealed it before the one format: `ssenc1.ek1.<wrapped data key>.<data>`.
 * @param {string} encryptionKey
 * @param {string | Buffer} plaintext
 * @param {Record<string, string>} aadObject
 * @param {Buffer} [dek] the data key (another length tests a malformed one)
 */
const sealedBefore = (encryptionKey, plaintext, aadObject, dek = randomBytes(32)) => {
	const kekKey = Buffer.from(
		hkdfSync('sha256', Buffer.from(encryptionKey, 'utf8'), Buffer.alloc(0), 'ss-portal-secrets.v1', 32),
	);
	/** @param {Buffer} key @param {Buffer} data @param {string} ad */
	const seal = (key, data, ad) => {
		const iv = randomBytes(12);
		const cipher = createCipheriv('aes-256-gcm', key, iv);
		cipher.setAAD(Buffer.from(ad, 'utf8'));
		return Buffer.concat([iv, cipher.update(data), cipher.final(), cipher.getAuthTag()]);
	};
	const ad = `ss-data.v1|${JSON.stringify(Object.fromEntries(Object.entries(aadObject).sort()))}`;
	return [
		'ssenc1',
		'ek1',
		seal(kekKey, dek, 'ss-dek.v1|ek1').toString('base64url'),
		seal(dek.length === 32 ? dek : randomBytes(32), Buffer.from(plaintext), ad).toString('base64url'),
	].join('.');
};

const KEY_A = 'a'.repeat(40);
const KEY_B = 'b'.repeat(40);

describe('secret box (ENCRYPTION_KEY)', () => {
	it('seals with a key id and AAD binding; another key cannot open', () => {
		const box = createSecretBox({ encryptionKey: KEY_A });
		const sealed = box.seal('mongodb+srv://u:p@cluster/db', { aad });
		expect(sealed.startsWith(`ss2.${box.keyId}.`)).toBe(true);
		expect(sealed).not.toContain('cluster');
		expect(box.previousKeyId).toBeNull();
		expect(box.openText(sealed, { aad })).toBe('mongodb+srv://u:p@cluster/db');
		// key order irrelevant
		expect(box.openText(sealed, { aad: { productId: 'notes', merchantId: MERCHANT } })).toBe('mongodb+srv://u:p@cluster/db');
		expect(codeOf(() => box.openText(sealed, { aad: { ...aad, merchantId: 'mer_other' } }))).toBe('decrypt_failed');
		expect(box.seal('x', { aad })).not.toBe(box.seal('x', { aad })); // fresh IV
		expect(codeOf(() => createSecretBox({ encryptionKey: KEY_B }).openText(sealed, { aad }))).toBe('decrypt_failed');
		expect(codeOf(() => box.openText('nope', { aad }))).toBe('decrypt_failed');
		expect(codeOf(() => box.seal('x', { aad: {} }))).toBe('invalid_argument');
		expect(codeOf(() => box.seal('x', { aad: { merchantId: '' } }))).toBe('invalid_argument');
		expect(codeOf(() => box.seal('x', { aad: /** @type {any} */ (null) }))).toBe('invalid_argument');
		expect(codeOf(() => createSecretBox({ encryptionKey: 'short' }))).toBe('config_invalid');
		expect(codeOf(() => createSecretBox({ encryptionKey: KEY_A, previousKey: 'short' }))).toBe('config_invalid');
	});

	it('reads values sealed before the one format, with either key, and detects tampering', () => {
		const before = sealedBefore(KEY_A, 'credential', aad);
		expect(createSecretBox({ encryptionKey: KEY_A }).openText(before, { aad })).toBe('credential');
		expect(createSecretBox({ encryptionKey: KEY_B, previousKey: KEY_A }).openText(before, { aad })).toBe('credential');
		expect(codeOf(() => createSecretBox({ encryptionKey: KEY_B }).openText(before, { aad }))).toBe('decrypt_failed');
		const box = createSecretBox({ encryptionKey: KEY_A });
		const parts = before.split('.');
		const body = Buffer.from(/** @type {string} */ (parts[3]), 'base64url');
		body[14] = (Number(body[14]) ^ 1) & 0xff;
		const tampered = [parts[0], parts[1], parts[2], body.toString('base64url')].join('.');
		expect(codeOf(() => box.openText(tampered, { aad }))).toBe('decrypt_failed');
		const wrapped = Buffer.from(/** @type {string} */ (parts[2]), 'base64url');
		wrapped[20] = (Number(wrapped[20]) ^ 1) & 0xff;
		const badKey = [parts[0], parts[1], wrapped.toString('base64url'), parts[3]].join('.');
		expect(codeOf(() => box.openText(badKey, { aad }))).toBe('decrypt_failed');
		expect(codeOf(() => box.openText([parts[0], 'k9', parts[2], parts[3]].join('.'), { aad }))).toBe('decrypt_failed');
		expect(codeOf(() => box.openText([parts[0], parts[1], parts[2], 'AA'].join('.'), { aad }))).toBe('decrypt_failed');
		expect(codeOf(() => box.openText(sealedBefore(KEY_A, 'x', aad, randomBytes(16)), { aad }))).toBe('decrypt_failed');
	});

	it('key change: B with A as previous opens everything, re-seal moves it to B, then A can be removed (RT-14)', async () => {
		const sealedA = createSecretBox({ encryptionKey: KEY_A }).seal('server-token', { aad });
		const before = sealedBefore(KEY_A, 'smtp-password', aad);
		const changing = createSecretBox({ encryptionKey: KEY_B, previousKey: KEY_A });
		expect(changing.previousKeyId).toBe(createSecretBox({ encryptionKey: KEY_A }).keyId);
		expect(changing.openText(sealedA, { aad })).toBe('server-token');
		/** @type {Record<string, string>} */
		const saved = {};
		const lost = createSecretBox({ encryptionKey: 'c'.repeat(40) }).seal('x', { aad });
		const values = { sealedA, before, lost };
		const counts = await resealEach(
			changing,
			Object.entries(values).map(([name, sealed]) => ({
				sealed,
				aad,
				save: async (/** @type {string} */ next) => {
					saved[name] = next;
				},
			})),
		);
		expect(counts).toEqual({ resealed: 2, current: 0, unreadable: 1 });
		expect(Object.keys(saved)).toEqual(['sealedA', 'before']);
		const movedA = /** @type {string} */ (saved.sealedA);
		const movedBefore = /** @type {string} */ (saved.before);
		const again = await resealEach(changing, [{ sealed: movedA, aad, save: async () => {} }]);
		expect(again).toEqual({ resealed: 0, current: 1, unreadable: 0 });
		expect(sumCounts([counts, again])).toEqual({ resealed: 2, current: 1, unreadable: 1 });
		const after = createSecretBox({ encryptionKey: KEY_B });
		expect(after.openText(movedA, { aad })).toBe('server-token');
		expect(after.openText(movedBefore, { aad })).toBe('smtp-password');
		expect(codeOf(() => createSecretBox({ encryptionKey: KEY_A }).openText(movedA, { aad }))).toBe('decrypt_failed');
	});
});

describe('security headers', () => {
	it('builds a nonce CSP', () => {
		const nonce = createNonce();
		const csp = pageCsp({ nonce });
		expect(csp).toContain(`'nonce-${nonce}'`);
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).toContain('upgrade-insecure-requests');
		expect(csp).not.toContain('unsafe-eval');
		expect(csp).toContain(`style-src 'self' 'nonce-${nonce}'`);
		expect(csp).not.toContain('unsafe-inline');
		// development only: React debugging and the inline styles of the Next.js dev tools
		const dev = pageCsp({ nonce, dev: true, upgradeInsecure: false });
		expect(dev).toContain("'unsafe-eval'");
		expect(dev).toContain("style-src 'self' 'unsafe-inline'");
		expect(() => pageCsp({ nonce: "x' 'unsafe-inline" })).toThrow();
		expect(API_CSP).toContain("default-src 'none'");
		const keys = staticSecurityHeaders().map((h) => h.key);
		expect(keys).toEqual(
			expect.arrayContaining(['Strict-Transport-Security', 'Referrer-Policy', 'Permissions-Policy', 'X-Frame-Options']),
		);
		expect(staticSecurityHeaders({ hsts: false }).map((h) => h.key)).not.toContain('Strict-Transport-Security');
	});
});
