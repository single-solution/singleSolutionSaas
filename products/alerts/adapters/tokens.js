/**
 * Crypto adapters (node:crypto): ids, keyed contact hashes and signed link tokens.
 *
 * - **Ids**: random (`als_`, `alm_`, `trg_` + 26 Crockford base32 characters) or stable (derived from a key, so a
 *   replayed request or a redelivered event lands on the same record).
 * - **Contact keys**: HMAC-SHA-256 of `websiteId|email:<address>` / `|phone:<e164>` — caps, suppressions and
 *   uniqueness work on the hash, so the suppression list holds no addresses.
 * - **Link tokens** (unsubscribe, double opt-in confirm): `<purpose>1.<payload>.<hmac>` over
 *   `{ w: websiteId, s: subscriptionId, k: contactKey, e: expiry }`, bound to one website and one purpose, compared in
 *   constant time. They authorise exactly one thing (stop / confirm alerts of that contact) and expire.
 * @module
 */
import { createHash, createHmac, hkdfSync, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
/** Minimum length of a configured token secret. */
export const MIN_SECRET_LENGTH = 32;
/** Token purposes. */
export const PURPOSES = Object.freeze(/** @type {const} */ (['unsubscribe', 'confirm']));
const PREFIX = Object.freeze({ unsubscribe: 'us1', confirm: 'cf1' });

/**
 * 26 Crockford base32 characters of bytes.
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
 * Stable id: `<prefix>_` + base32(SHA-256(text)).
 * @param {string} prefix
 * @param {string} text
 */
export const stableId = (prefix, text) => `${prefix}_${base32(createHash('sha256').update(text).digest())}`;

/**
 * Random id: `<prefix>_` + 130 random bits.
 * @param {string} prefix
 */
export const randomId = (prefix) => `${prefix}_${base32(nodeRandomBytes(17))}`;

/**
 * The token secret: `ALERTS_TOKEN_SECRET`, else derived (HKDF) from the product signing key so a deployment works
 * without an extra variable (rotating the key then invalidates outstanding links).
 * @param {{ secret?: string | undefined, signingKey?: string | Record<string, unknown> | null }} input
 * @returns {Buffer}
 */
export const tokenSecret = ({ secret, signingKey }) => {
	if (typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH) return Buffer.from(secret, 'utf8');
	const jwk = typeof signingKey === 'string' ? { d: signingKey.slice(signingKey.lastIndexOf(':') + 1) } : signingKey; // kid:seed
	const material = typeof jwk?.d === 'string' ? Buffer.from(jwk.d, 'base64url') : null;
	if (!material || material.length === 0) throw new Error('ALERTS_TOKEN_SECRET (≥ 32 chars) or SIGNING_KEY is required');
	return Buffer.from(hkdfSync('sha256', material, 'ss-alerts', 'link-token/v1', 32));
};

/**
 * @param {{ secret: Buffer, now?: () => number }} options
 */
export const createTokens = ({ secret, now = Date.now }) => {
	const contactSecret = createHmac('sha256', secret).update('contact-key/v1').digest();
	/**
	 * @param {string} prefix
	 * @param {string} payload
	 */
	const sign = (prefix, payload) => createHmac('sha256', secret).update(`${prefix}.${payload}`).digest('base64url');
	return Object.freeze({
		/**
		 * Keyed hash of a contact within a website.
		 * @param {string} websiteId
		 * @param {string} contactId `email:<address>` / `phone:<e164>`
		 */
		contactKey: (websiteId, contactId) =>
			`ck_${createHmac('sha256', contactSecret).update(`${websiteId}|${contactId}`).digest('base64url').slice(0, 32)}`,
		/**
		 * Keyed hash of another identifier (rate-limit subjects such as IP addresses).
		 * @param {string} websiteId
		 * @param {string} value
		 */
		subjectKey: (websiteId, value) =>
			createHmac('sha256', contactSecret).update(`subject|${websiteId}|${value}`).digest('base64url').slice(0, 32),
		/**
		 * @param {'unsubscribe' | 'confirm'} purpose
		 * @param {{ websiteId: string, subscriptionId: string, contactKey: string, ttlSeconds: number }} input
		 * @returns {string}
		 */
		issue: (purpose, { websiteId, subscriptionId, contactKey, ttlSeconds }) => {
			const prefix = PREFIX[purpose];
			const exp = Math.floor(now() / 1000) + Math.max(60, Math.floor(ttlSeconds));
			const payload = Buffer.from(JSON.stringify({ w: websiteId, s: subscriptionId, k: contactKey, e: exp })).toString(
				'base64url',
			);
			return `${prefix}.${payload}.${sign(prefix, payload)}`;
		},
		/**
		 * Claims of a valid token of a purpose, else null.
		 * @param {'unsubscribe' | 'confirm'} purpose
		 * @param {unknown} token
		 * @returns {{ websiteId: string, subscriptionId: string, contactKey: string, expiresAt: number } | null}
		 */
		verify: (purpose, token) => {
			if (typeof token !== 'string' || token.length > 1024) return null;
			const [prefix, payload, signature] = token.split('.');
			if (prefix !== PREFIX[purpose] || !payload || !signature) return null;
			const expected = Buffer.from(sign(prefix, payload));
			const given = Buffer.from(signature);
			if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
			try {
				const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
				if (typeof claims.w !== 'string' || typeof claims.s !== 'string' || typeof claims.k !== 'string') return null;
				if (!(claims.e > now() / 1000)) return null;
				return { websiteId: claims.w, subscriptionId: claims.s, contactKey: claims.k, expiresAt: claims.e * 1000 };
			} catch {
				return null;
			}
		},
	});
};

/** @typedef {ReturnType<typeof createTokens>} Tokens */
