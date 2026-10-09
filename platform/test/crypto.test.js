import { describe, expect, it } from 'vitest';
import { generateSigningKey, issueToken, verifyToken } from '@ss/protocol';
import { createEnvelope, createPortalKeys, createSecretBox } from '../src/infra/crypto.js';
import { isPlatformError } from '../src/infra/errors.js';
import { API_CSP, createNonce, pageCsp, staticSecurityHeaders } from '../src/infra/security-headers.js';
import { MERCHANT, WEBSITE } from './helpers.js';

const kek = (/** @type {string} */ id, /** @type {number} */ fill) => ({ id, key: Buffer.alloc(32, fill) });
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

describe('envelope encryption', () => {
	it('seals and opens with AAD binding', () => {
		const envelope = createEnvelope({ keks: [kek('k2', 2), kek('k1', 1)] });
		const sealed = envelope.seal('mongodb+srv://u:p@cluster/db', { aad });
		expect(sealed.startsWith('ssenc1.k2.')).toBe(true);
		expect(sealed).not.toContain('cluster');
		expect(envelope.openText(sealed, { aad })).toBe('mongodb+srv://u:p@cluster/db');
		expect(envelope.open(sealed, { aad: { productId: 'notes', merchantId: MERCHANT } }).toString()).toBe(
			'mongodb+srv://u:p@cluster/db',
		); // key order irrelevant
		expect(codeOf(() => envelope.open(sealed, { aad: { ...aad, merchantId: 'mer_other' } }))).toBe('decrypt_failed');
		expect(envelope.seal(new Uint8Array([1, 2, 3]), { aad })).not.toBe(envelope.seal(new Uint8Array([1, 2, 3]), { aad })); // fresh data key + IV
		expect(envelope.kekIdOf(sealed)).toBe('k2');
	});

	it('detects tampering and malformed input', () => {
		const envelope = createEnvelope({ keks: [kek('k1', 1)] });
		const sealed = envelope.seal('secret', { aad });
		const parts = sealed.split('.');
		const body = Buffer.from(/** @type {string} */ (parts[3]), 'base64url');
		body[14] = (Number(body[14]) ^ 1) & 0xff;
		const tampered = [parts[0], parts[1], parts[2], body.toString('base64url')].join('.');
		expect(codeOf(() => envelope.open(tampered, { aad }))).toBe('decrypt_failed');
		const wrapped = Buffer.from(/** @type {string} */ (parts[2]), 'base64url');
		wrapped[20] = (Number(wrapped[20]) ^ 1) & 0xff;
		expect(codeOf(() => envelope.open([parts[0], parts[1], wrapped.toString('base64url'), parts[3]].join('.'), { aad }))).toBe(
			'decrypt_failed',
		);
		expect(codeOf(() => envelope.open('nope', { aad }))).toBe('decrypt_failed');
		expect(codeOf(() => envelope.open([parts[0], 'k9', parts[2], parts[3]].join('.'), { aad }))).toBe('decrypt_failed');
		expect(codeOf(() => envelope.open([parts[0], parts[1], parts[2], 'AA'].join('.'), { aad }))).toBe('decrypt_failed');
		expect(codeOf(() => envelope.seal('x', { aad: {} }))).toBe('invalid_argument');
		expect(codeOf(() => envelope.seal('x', { aad: { merchantId: '' } }))).toBe('invalid_argument');
		expect(codeOf(() => envelope.seal('x', { aad: /** @type {any} */ (null) }))).toBe('invalid_argument');
	});

	it('rotates KEKs: old records open, rewrap moves them to the active KEK', () => {
		const old = createEnvelope({ keks: [kek('k1', 1)] });
		const sealed = old.seal('credential', { aad });
		const rotated = createEnvelope({ keks: [kek('k2', 2), kek('k1', 1)] });
		expect(rotated.openText(sealed, { aad })).toBe('credential');
		const moved = rotated.rewrap(sealed);
		expect(rotated.kekIdOf(moved)).toBe('k2');
		expect(moved.split('.')[3]).toBe(sealed.split('.')[3]); // ciphertext untouched
		expect(rotated.rewrap(moved)).toBe(moved);
		const retired = createEnvelope({ keks: [kek('k2', 2)] });
		expect(retired.openText(moved, { aad })).toBe('credential');
		expect(codeOf(() => retired.openText(sealed, { aad }))).toBe('decrypt_failed');
	});

	it('validates KEKs', () => {
		expect(() => createEnvelope({ keks: [] })).toThrow();
		expect(() => createEnvelope({ keks: [{ id: 'k', key: Buffer.alloc(16) }] })).toThrow();
		expect(() => createEnvelope({ keks: [kek('k', 1), kek('k', 2)] })).toThrow();
	});
});

describe('secret box (ENCRYPTION_KEY)', () => {
	it('seals with a key derived from ENCRYPTION_KEY; another key cannot open', () => {
		const box = createSecretBox({ encryptionKey: 'a'.repeat(40) });
		const sealed = box.seal('server-token', { aad });
		expect(box.openText(sealed, { aad })).toBe('server-token');
		expect(codeOf(() => createSecretBox({ encryptionKey: 'b'.repeat(40) }).open(sealed, { aad }))).toBe('decrypt_failed');
		expect(codeOf(() => createSecretBox({ encryptionKey: 'short' }))).toBe('config_invalid');
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
