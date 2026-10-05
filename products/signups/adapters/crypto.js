/**
 * Cryptography (node:crypto), the only module that touches key material.
 *
 * - **Sealing.** Per-website secrets (the HMAC pepper and the issuer's Ed25519 private keys) are stored in the
 *   merchant's own database, sealed with AES-256-GCM. The sealing key is derived per website with HKDF-SHA-256 from the
 *   product's own secret (`SIGNUPS_SEAL_SECRET`, ≥ 32 characters; without it, derived from `SS_APP_SIGNING_KEY`) with the
 *   website id as `info`; the AAD binds website, purpose and key id, so a sealed record copied to another website, slot
 *   or key does not open. The merchant's database alone never reveals a key; this deployment alone holds no key.
 *   `SIGNUPS_SEAL_SECRET_PREVIOUS` opens records sealed before a rotation of the secret (they are re-sealed on use).
 * - **Hashes.** Codes, magic-link and refresh tokens, identifiers and IPs used as counter keys are HMAC-SHA-256 with the
 *   website's pepper; comparisons are constant time.
 * - **Tokens.** Access tokens are compact JWS (`alg: EdDSA`, `typ: JWT`, `kid`) signed with Ed25519.
 * @module
 */
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	hkdfSync,
	randomBytes as nodeRandomBytes,
	sign as cryptoSign,
	timingSafeEqual,
	verify as cryptoVerify,
} from 'node:crypto';
import { createId } from '@ss/contracts';

/** Minimum length of a configured sealing secret. */
export const MIN_SECRET_LENGTH = 32;
const SEAL_SALT = 'ss-signups/seal/v1';

/** @param {number} n */
export const randomBytes = (n) => new Uint8Array(nodeRandomBytes(n));

/** URL-safe random secret of `bytes` bytes. @param {number} [bytes] */
export const randomSecret = (bytes = 32) => Buffer.from(nodeRandomBytes(bytes)).toString('base64url');

/** A new id (`<prefix>_` + 26 base32 characters). @param {string} prefix */
export const newId = (prefix) => createId(prefix, { randomBytes });

/**
 * HMAC-SHA-256 hex.
 * @param {Uint8Array} key
 * @param {string} text
 */
export const hmac = (key, text) => createHmac('sha256', key).update(text).digest('hex');

/** SHA-256 hex. @param {string} text */
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * Constant-time equality of two strings.
 * @param {string} a
 * @param {string} b
 */
export const safeEqual = (a, b) => {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Sealing secret material: `SIGNUPS_SEAL_SECRET`, else HKDF of the product signing key's private part.
 * @param {{ secret?: string | undefined, signingKey?: string | Record<string, unknown> | null }} input
 * @returns {Buffer}
 */
export const sealSecret = ({ secret, signingKey }) => {
	if (typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH) return Buffer.from(secret, 'utf8');
	const jwk = typeof signingKey === 'string' ? JSON.parse(signingKey) : signingKey;
	const material = typeof jwk?.d === 'string' ? Buffer.from(jwk.d, 'base64url') : null;
	if (!material || material.length === 0) throw new Error('SIGNUPS_SEAL_SECRET (≥ 32 chars) or SS_APP_SIGNING_KEY is required');
	return Buffer.from(hkdfSync('sha256', material, 'ss-signups', 'seal-secret/v1', 32));
};

/**
 * @typedef {{ alg: 'A256GCM', sk: string, iv: string, ct: string, tag: string }} Sealed
 *   `sk` identifies the sealing secret (first 12 hex of its SHA-256), never the secret itself
 */

/**
 * @param {{ secrets: Buffer[] }} options current secret first, then previous ones
 */
export const createSealer = ({ secrets }) => {
	if (secrets.length === 0) throw new Error('a sealing secret is required');
	const ids = secrets.map((secret) => createHash('sha256').update(secret).digest('hex').slice(0, 12));
	/** @param {Buffer} secret @param {string} websiteId */
	const keyFor = (secret, websiteId) => Buffer.from(hkdfSync('sha256', secret, SEAL_SALT, websiteId, 32));
	/** @param {string} websiteId @param {string} purpose @param {string} kid */
	const aad = (websiteId, purpose, kid) => Buffer.from(`${websiteId}|${purpose}|${kid}`, 'utf8');
	return Object.freeze({
		currentId: /** @type {string} */ (ids[0]),
		/**
		 * @param {{ websiteId: string, purpose: string, kid: string, plaintext: Uint8Array }} input
		 * @returns {Sealed}
		 */
		seal: ({ websiteId, purpose, kid, plaintext }) => {
			const iv = nodeRandomBytes(12);
			const cipher = createCipheriv('aes-256-gcm', keyFor(/** @type {Buffer} */ (secrets[0]), websiteId), iv);
			cipher.setAAD(aad(websiteId, purpose, kid));
			const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
			return {
				alg: 'A256GCM',
				sk: /** @type {string} */ (ids[0]),
				iv: iv.toString('base64url'),
				ct: ct.toString('base64url'),
				tag: cipher.getAuthTag().toString('base64url'),
			};
		},
		/**
		 * Open a sealed record (null when it was sealed for another website / purpose / key, or with an unknown secret).
		 * @param {Sealed} sealed
		 * @param {{ websiteId: string, purpose: string, kid: string }} context
		 * @returns {{ plaintext: Buffer, stale: boolean } | null} `stale`: sealed with a previous secret (re-seal it)
		 */
		open: (sealed, { websiteId, purpose, kid }) => {
			const index = ids.indexOf(sealed?.sk);
			const secret = secrets[index];
			if (index < 0 || !secret || sealed.alg !== 'A256GCM') return null;
			try {
				const decipher = createDecipheriv('aes-256-gcm', keyFor(secret, websiteId), Buffer.from(sealed.iv, 'base64url'));
				decipher.setAAD(aad(websiteId, purpose, kid));
				decipher.setAuthTag(Buffer.from(sealed.tag, 'base64url'));
				const plaintext = Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'base64url')), decipher.final()]);
				return { plaintext, stale: index > 0 };
			} catch {
				return null;
			}
		},
	});
};

/** @typedef {ReturnType<typeof createSealer>} Sealer */

/**
 * A new Ed25519 key pair as JWKs.
 * @param {string} kid
 * @returns {{ publicJwk: Record<string, string>, privateJwk: Record<string, string> }}
 */
export const generateSigningKeyPair = (kid) => {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	const pub = /** @type {Record<string, string>} */ (publicKey.export({ format: 'jwk' }));
	const priv = /** @type {Record<string, string>} */ (privateKey.export({ format: 'jwk' }));
	return {
		publicJwk: { kty: 'OKP', crv: 'Ed25519', x: /** @type {string} */ (pub.x), kid, alg: 'EdDSA', use: 'sig' },
		privateJwk: { kty: 'OKP', crv: 'Ed25519', x: /** @type {string} */ (priv.x), d: /** @type {string} */ (priv.d), kid },
	};
};

/** @param {unknown} value */
const b64json = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * Sign a JWT with an Ed25519 private JWK.
 * @param {Record<string, string>} privateJwk
 * @param {Record<string, unknown>} claims
 * @returns {string}
 */
export const signJwt = (privateJwk, claims) => {
	const input = `${b64json({ alg: 'EdDSA', typ: 'JWT', kid: privateJwk.kid })}.${b64json(claims)}`;
	const key = createPrivateKey({ key: /** @type {import('node:crypto').JsonWebKey} */ ({ ...privateJwk }), format: 'jwk' });
	return `${input}.${cryptoSign(null, Buffer.from(input), key).toString('base64url')}`;
};

const SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Verify a compact EdDSA JWS against public JWKs (by `kid`) and return its claims. Only `alg: EdDSA` with a known
 * `kid`; header-borne keys and `crit` are refused.
 * @param {unknown} token
 * @param {ReadonlyArray<Record<string, string>>} keys
 * @returns {{ ok: true, claims: Record<string, unknown> } | { ok: false, code: 'malformed' | 'algorithm' | 'unknown_key' | 'signature' }}
 */
export const verifyJwt = (token, keys) => {
	if (typeof token !== 'string' || token.length > 4096) return { ok: false, code: 'malformed' };
	const parts = token.split('.');
	if (parts.length !== 3 || !parts.every((part) => SEGMENT.test(part))) return { ok: false, code: 'malformed' };
	const [h, p, s] = /** @type {[string, string, string]} */ (parts);
	/** @type {any} */
	let header;
	/** @type {any} */
	let claims;
	try {
		header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
		claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
	} catch {
		return { ok: false, code: 'malformed' };
	}
	if (typeof header !== 'object' || header === null || typeof claims !== 'object' || claims === null || Array.isArray(claims))
		return { ok: false, code: 'malformed' };
	if (['jwk', 'jku', 'x5u', 'x5c', 'crit'].some((name) => Object.hasOwn(header, name))) return { ok: false, code: 'malformed' };
	if (header.alg !== 'EdDSA') return { ok: false, code: 'algorithm' };
	const jwk = keys.find((key) => key.kid === header.kid);
	if (!jwk) return { ok: false, code: 'unknown_key' };
	try {
		const key = createPublicKey({
			key: /** @type {import('node:crypto').JsonWebKey} */ ({ kty: 'OKP', crv: 'Ed25519', x: jwk.x }),
			format: 'jwk',
		});
		if (!cryptoVerify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url')))
			return { ok: false, code: 'signature' };
	} catch {
		return { ok: false, code: 'signature' };
	}
	return { ok: true, claims };
};
