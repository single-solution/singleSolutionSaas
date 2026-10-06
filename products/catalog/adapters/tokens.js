/**
 * Crypto adapters (node:crypto): random ids, stable ids derived from idempotency keys, and **feed tokens**.
 *
 * A feed URL is `/feeds/<token>`: the token is HMAC-SHA-256 over `{ w: websiteId, f: feedKey, v: tokenVersion }`
 * (base64url payload + signature), so the public route knows which website and feed to serve without any lookup, and
 * raising `feeds.token_version` in the settings revokes every link at once. The secret is the generated secret (`product.secret`, kept in the control database), else
 * derived (HKDF) from the product signing key. Tokens are compared in constant time and never logged.
 *
 * **Export links** (`ex1.…`) are the same construction with their own derived key, bound to a website, an export kind
 * and its parameters, and valid for at most five minutes (`createExportLinks`).
 */
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
const TOKEN_PREFIX = 'fd1';
/** Minimum length of a configured feed secret. */
export const MIN_SECRET_LENGTH = 32;

/**
 * 26 lowercase Crockford base32 characters of some bytes.
 * @param {Uint8Array} bytes
 */
const base32 = (bytes) => {
	let bits = 0;
	let value = 0;
	let out = '';
	for (const byte of bytes) {
		value = ((value << 8) | byte) & 0xffff;
		bits += 8;
		while (bits >= 5 && out.length < 26) {
			out += CROCKFORD[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
		if (out.length >= 26) break;
	}
	return out;
};

/**
 * A stable id body from text (SHA-256): ids derived from idempotency keys converge on retries.
 * @param {string} text
 */
export const stableId = (text) => base32(createHash('sha256').update(text).digest());

/**
 * A random id: `<prefix>_` + 128 random bits.
 * @param {string} prefix
 */
export const newId = (prefix) => `${prefix}_${base32(randomBytes(17))}`;

/**
 * The feed-token secret: the generated secret (`product.secret`, kept in the control database), else HKDF of the product signing key.
 * @param {{ secret?: string | undefined, signingKey?: string | Record<string, unknown> | null }} input
 * @returns {Buffer}
 */
export const feedSecret = ({ secret, signingKey }) => {
	if (typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH) return Buffer.from(secret, 'utf8');
	const jwk = typeof signingKey === 'string' ? { d: signingKey.slice(signingKey.lastIndexOf(':') + 1) } : signingKey; // kid:seed
	const material = typeof jwk?.d === 'string' ? Buffer.from(jwk.d, 'base64url') : null;
	if (!material || material.length === 0)
		throw new Error('a generated secret (≥ 32 chars, product.secret) or the signing key is required');
	return Buffer.from(hkdfSync('sha256', material, 'ss-catalog', 'feed-token/v1', 32));
};

/**
 * @param {{ secret: Buffer }} options
 */
export const createFeedTokens = ({ secret }) => {
	/** @param {string} payload */
	const sign = (payload) => createHmac('sha256', secret).update(`${TOKEN_PREFIX}.${payload}`).digest('base64url');
	return Object.freeze({
		/**
		 * @param {{ websiteId: string, feedKey: string, version: number }} input
		 * @returns {string}
		 */
		issue: ({ websiteId, feedKey, version }) => {
			const payload = Buffer.from(JSON.stringify({ w: websiteId, f: feedKey, v: version })).toString('base64url');
			return `${TOKEN_PREFIX}.${payload}.${sign(payload)}`;
		},
		/**
		 * The claims of a valid token (the version is checked by the caller against the settings), else null.
		 * @param {unknown} token
		 * @returns {{ websiteId: string, feedKey: string, version: number } | null}
		 */
		verify: (token) => {
			if (typeof token !== 'string' || token.length > 1024) return null;
			const [prefix, payload, signature, extra] = token.split('.');
			if (prefix !== TOKEN_PREFIX || !payload || !signature || extra !== undefined) return null;
			const expected = Buffer.from(sign(payload));
			const given = Buffer.from(signature);
			if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
			try {
				const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
				if (typeof claims.w !== 'string' || typeof claims.f !== 'string' || !Number.isSafeInteger(claims.v)) return null;
				return { websiteId: claims.w, feedKey: claims.f, version: claims.v };
			} catch {
				return null;
			}
		},
	});
};

/** @typedef {ReturnType<typeof createFeedTokens>} FeedTokens */

const EXPORT_PREFIX = 'ex1';
/** Longest life of a signed export download link. */
export const EXPORT_LINK_MAX_MS = 5 * 60_000;

/**
 * The export-link secret: HKDF of the generated secret (`product.secret`, kept in the control database) when set (≥ 32 chars), else of the product signing key, with
 * its own label — so a feed token can never be replayed as an export link and the other way round.
 * @param {{ secret?: string | undefined, signingKey?: string | Record<string, unknown> | null }} input
 * @returns {Buffer}
 */
export const exportSecret = ({ secret, signingKey }) => {
	if (typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH)
		return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), 'ss-catalog', 'export-link/v1', 32));
	const jwk = typeof signingKey === 'string' ? { d: signingKey.slice(signingKey.lastIndexOf(':') + 1) } : signingKey; // kid:seed
	const material = typeof jwk?.d === 'string' ? Buffer.from(jwk.d, 'base64url') : null;
	if (!material || material.length === 0)
		throw new Error('a generated secret (≥ 32 chars, product.secret) or the signing key is required');
	return Buffer.from(hkdfSync('sha256', material, 'ss-catalog', 'export-link/v1', 32));
};

/**
 * Short-lived signed export download links: the token is HMAC-SHA-256 over `{ w: websiteId, k: kind, p: params,
 * e: expiry (ms) }` (base64url payload + signature), so the download route needs no session, header or lookup.
 * Signatures are compared in constant time; tokens are never logged.
 * @param {{ secret: Buffer, now?: () => number, ttlMs?: number }} options
 */
export const createExportLinks = ({ secret, now = Date.now, ttlMs = EXPORT_LINK_MAX_MS }) => {
	const life = Math.min(Math.max(1_000, ttlMs), EXPORT_LINK_MAX_MS);
	/** @param {string} payload */
	const sign = (payload) => createHmac('sha256', secret).update(`${EXPORT_PREFIX}.${payload}`).digest('base64url');
	return Object.freeze({
		/**
		 * @param {{ websiteId: string, kind: string, params: Record<string, string> }} input
		 * @returns {{ token: string, expiresAt: string }}
		 */
		issue: ({ websiteId, kind, params }) => {
			const expires = now() + life;
			const payload = Buffer.from(JSON.stringify({ w: websiteId, k: kind, p: params, e: expires })).toString('base64url');
			return { token: `${EXPORT_PREFIX}.${payload}.${sign(payload)}`, expiresAt: new Date(expires).toISOString() };
		},
		/**
		 * @param {unknown} token
		 * @returns {{ ok: true, websiteId: string, kind: string, params: Record<string, string> } | { ok: false, reason: 'invalid' | 'expired' }}
		 */
		verify: (token) => {
			const invalid = { ok: /** @type {const} */ (false), reason: /** @type {const} */ ('invalid') };
			if (typeof token !== 'string' || token.length > 2048) return invalid;
			const [prefix, payload, signature, extra] = token.split('.');
			if (prefix !== EXPORT_PREFIX || !payload || !signature || extra !== undefined) return invalid;
			const expected = Buffer.from(sign(payload));
			const given = Buffer.from(signature);
			if (expected.length !== given.length || !timingSafeEqual(expected, given)) return invalid;
			/** @type {any} */
			let claims;
			try {
				claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
			} catch {
				return invalid;
			}
			const params = claims?.p;
			if (
				typeof claims?.w !== 'string' ||
				typeof claims.k !== 'string' ||
				!Number.isSafeInteger(claims.e) ||
				typeof params !== 'object' ||
				params === null ||
				Array.isArray(params) ||
				!Object.values(params).every((value) => typeof value === 'string')
			)
				return invalid;
			if (claims.e <= now()) return { ok: false, reason: 'expired' };
			return { ok: true, websiteId: claims.w, kind: claims.k, params };
		},
	});
};

/** @typedef {ReturnType<typeof createExportLinks>} ExportLinks */

/**
 * Strong ETag of a body.
 * @param {string} body
 */
export const etagOf = (body) => `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;
