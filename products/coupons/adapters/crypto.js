/**
 * Crypto adapters (node:crypto): cryptographically secure random bytes for code generation and ids, and stable ids
 * derived from idempotency material (so retries converge on the same document).
 */
import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * 26 lowercase Crockford base32 characters of the given bytes (the first 130 bits).
 * @param {Uint8Array} bytes at least 17 bytes
 * @returns {string}
 */
export const base32 = (bytes) => {
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
 * Stable 26-character id material from a text (SHA-256).
 * @param {string} text
 * @returns {string}
 */
export const stableId = (text) => base32(createHash('sha256').update(text).digest());

/**
 * Secure random bytes.
 * @param {number} n
 * @returns {Uint8Array}
 */
export const randomBytes = (n) => new Uint8Array(nodeRandomBytes(n));

/**
 * A random opaque id `<prefix>_<26 base32>` (128+ bits).
 * @param {string} prefix
 * @param {(n: number) => Uint8Array} [bytes]
 */
export const randomId = (prefix, bytes = randomBytes) => `${prefix}_${base32(bytes(17))}`;
