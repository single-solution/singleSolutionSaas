/**
 * Crypto adapters (node:crypto): stable ids derived from request keys, and **report tokens**.
 *
 * A unit's shareable report link carries a random 256-bit token (`grr_…`). Only its SHA-256 is stored with the unit in
 * the merchant's database, so a database read never yields a working link; issuing a new link replaces the old one and
 * revoking clears it.
 */
import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
/** Prefix of report tokens. */
export const REPORT_TOKEN_PREFIX = 'grr_';
const REPORT_TOKEN = /^grr_[A-Za-z0-9_-]{43}$/;

/**
 * 26 lowercase Crockford base32 characters (130 bits) of SHA-256(text): stable ids from idempotency keys.
 * @param {string} text
 * @returns {string}
 */
export const stableId = (text) => {
	const digest = createHash('sha256').update(text).digest();
	let bits = 0;
	let value = 0;
	let out = '';
	for (const byte of digest) {
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
 * @param {{ randomBytes?: (n: number) => Uint8Array }} [options]
 */
export const createReportTokens = ({ randomBytes = (n) => new Uint8Array(nodeRandomBytes(n)) } = {}) =>
	Object.freeze({
		/** A new token and its stored hash. */
		issue: () => {
			const token = `${REPORT_TOKEN_PREFIX}${Buffer.from(randomBytes(32)).toString('base64url')}`;
			return { token, hash: createHash('sha256').update(token).digest('hex') };
		},
		/**
		 * The stored hash of a well-formed token, else null.
		 * @param {unknown} token
		 * @returns {string | null}
		 */
		hashOf: (token) =>
			typeof token === 'string' && REPORT_TOKEN.test(token) ? createHash('sha256').update(token).digest('hex') : null,
	});

/** @typedef {ReturnType<typeof createReportTokens>} ReportTokens */
