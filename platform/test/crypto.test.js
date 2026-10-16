import { describe, expect, it } from 'vitest';
import { createJwks, createKeyResolver, generateSigningKey, issueToken, verifyToken } from '@ss/protocol';
import { createPortalKeys, createSecretBox, resealEach, sumCounts } from '../src/infra/crypto.js';
import { isPlatformError } from '../src/infra/errors.js';
import { staticSecurityHeaders } from '@ss/net';
import { API_CSP, createNonce, pageCsp } from '../src/infra/security-headers.js';
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
		expect(keys.signer.kid).toBe('portal-new');
		expect(keys.tokenSigner.kid).toBe('token-new');
		const published = keys.publishedJwks();
		expect(published.keys.map((k) => k.kid)).toEqual(['portal-new', 'portal-old', 'token-new', 'token-old']);
		expect(JSON.stringify(published)).not.toContain('"d"');
		/** A resolver over the published keys whose kid starts with `prefix`. @param {string} prefix */
		const resolverOf = (prefix) =>
			createKeyResolver({ jwks: createJwks(published.keys.filter((k) => k.kid.startsWith(prefix))) });

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
		// tokens signed by the token signer verify with the token keys only
		const good = await issue(keys.tokenSigner);
		expect((await verify(good, resolverOf('token-'))).websiteId).toBe(WEBSITE);
		await expect(verify(good, resolverOf('portal-'))).rejects.toThrow();
		// a token signed with the Portal key is never accepted as a token
		await expect(verify(await issue(keys.signer), resolverOf('token-'))).rejects.toThrow();

		expect(codeOf(() => createPortalKeys([], [token]))).toBe('config_invalid');
		expect(codeOf(() => createPortalKeys([current], []))).toBe('config_invalid');
		const { privateJwk: clash } = await generateSigningKey({ kid: 'portal-new' });
		expect(codeOf(() => createPortalKeys([current], [clash]))).toBe('config_invalid');
	});
});

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

	it('key change: B with A as previous opens everything, re-seal moves it to B, then A can be removed (RT-14)', async () => {
		const sealedA = createSecretBox({ encryptionKey: KEY_A }).seal('server-token', { aad });
		const mailA = createSecretBox({ encryptionKey: KEY_A }).seal('smtp-password', { aad });
		const changing = createSecretBox({ encryptionKey: KEY_B, previousKey: KEY_A });
		expect(changing.previousKeyId).toBe(createSecretBox({ encryptionKey: KEY_A }).keyId);
		expect(changing.openText(sealedA, { aad })).toBe('server-token');
		/** @type {Record<string, string>} */
		const saved = {};
		const lost = createSecretBox({ encryptionKey: 'c'.repeat(40) }).seal('x', { aad });
		const values = { sealedA, mailA, lost };
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
		expect(Object.keys(saved)).toEqual(['sealedA', 'mailA']);
		const movedA = /** @type {string} */ (saved.sealedA);
		const movedMail = /** @type {string} */ (saved.mailA);
		const again = await resealEach(changing, [{ sealed: movedA, aad, save: async () => {} }]);
		expect(again).toEqual({ resealed: 0, current: 1, unreadable: 0 });
		expect(sumCounts([counts, again])).toEqual({ resealed: 2, current: 1, unreadable: 1 });
		const after = createSecretBox({ encryptionKey: KEY_B });
		expect(after.openText(movedA, { aad })).toBe('server-token');
		expect(after.openText(movedMail, { aad })).toBe('smtp-password');
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
	});
});
