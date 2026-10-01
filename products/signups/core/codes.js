/**
 * One-time codes (pure). Ported from the ibrahimMobiles OTP service (`apps/web/src/lib/otp/service.ts`): crypto-strong
 * codes, never stored in plain text (the adapters keep an HMAC with a per-website pepper), atomic attempt budgets —
 * generalised so length, alphabet, expiry, cooldown and every limit are element features.
 *
 * Randomness is injected (`randomBytes`) and reduced **without modulo bias** by rejection sampling.
 * @module
 */

/**
 * Code alphabets. `alphanumeric` is Crockford-style upper case without look-alikes (no 0/O, 1/I/L, U), so codes read
 * aloud or typed from a phone stay unambiguous.
 */
export const ALPHABETS = Object.freeze({
	numeric: '0123456789',
	alphanumeric: '23456789ABCDEFGHJKMNPQRSTVWXYZ',
});

/** @typedef {keyof typeof ALPHABETS} AlphabetName */

/**
 * @param {unknown} name
 * @returns {string}
 */
export const alphabetOf = (name) => (name === 'alphanumeric' ? ALPHABETS.alphanumeric : ALPHABETS.numeric);

/**
 * Generate a code of `length` characters from `alphabet`.
 * @param {{ length: number, alphabet: string, randomBytes: (n: number) => Uint8Array }} input
 * @returns {string}
 */
export const generateCode = ({ length, alphabet, randomBytes }) => {
	const n = alphabet.length;
	if (!Number.isInteger(length) || length < 1 || n < 2 || n > 256) throw new RangeError('invalid code shape');
	const limit = Math.floor(256 / n) * n; // bytes ≥ limit would bias the result: drop them
	let out = '';
	while (out.length < length) {
		for (const byte of randomBytes(length * 2)) {
			if (byte < limit) out += alphabet[byte % n];
			if (out.length === length) break;
		}
	}
	return out;
};

/**
 * What the customer typed, normalised for comparison: separators (spaces, dashes, dots) removed, letters upper-cased
 * for the alphanumeric alphabet. Returns null when the result cannot be a code of this shape (no attempt is spent on
 * it).
 * @param {unknown} input
 * @param {{ length: number, alphabet: string }} shape
 * @returns {string | null}
 */
export const normaliseCode = (input, { length, alphabet }) => {
	if (typeof input !== 'string' || input.length > 64) return null;
	const cleaned = input.replace(/[\s.-]/g, '');
	const value = alphabet === ALPHABETS.numeric ? cleaned : cleaned.toUpperCase();
	if (value.length !== length) return null;
	for (const char of value) if (!alphabet.includes(char)) return null;
	return value;
};

/**
 * Remaining attempts after `attempts` reservations.
 * @param {number} attempts
 * @param {number} max
 */
export const attemptsRemaining = (attempts, max) => Math.max(0, max - attempts);
