/**
 * Coupon codes (pure): normalisation, validation, patterns and unbiased random generation. Randomness is injected
 * (`nextByte`, fed by the adapters with cryptographically secure bytes), so generation is deterministic in tests and
 * never uses `Math.random`.
 *
 * Pattern syntax: `?` = one character of the configured alphabet, `#` = one digit, any of `A–Z a–z 0–9 - _` = itself.
 * `SPRING-????-####` → `SPRING-K7QM-0482`. A pattern must carry at least `codes.min_random_chars` random positions
 * so bulk codes cannot be guessed.
 * @module
 */

/** Characters a code may contain (after normalisation). */
export const CODE_CHARACTERS = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const LITERAL = /^[A-Za-z0-9_-]$/;
const DIGITS = '0123456789';

/**
 * Normalise a code as typed by a customer: trimmed, upper-cased unless codes are case-sensitive.
 * @param {unknown} value
 * @param {{ caseSensitive: boolean }} options
 * @returns {string}
 */
export const normaliseCode = (value, { caseSensitive }) => {
	if (typeof value !== 'string') return '';
	const trimmed = value.trim();
	return caseSensitive ? trimmed : trimmed.toUpperCase();
};

/**
 * @param {string} code normalised
 * @param {{ minLength: number, maxLength: number }} bounds
 */
export const isValidCode = (code, { minLength, maxLength }) =>
	code.length >= minLength && code.length <= maxLength && CODE_CHARACTERS.test(code);

/**
 * @typedef {{ ok: true, tokens: Array<{ kind: 'random' | 'digit' | 'literal', char?: string }>, random: number, digits: number }
 *   | { ok: false, error: 'pattern_invalid' | 'pattern_too_long' | 'pattern_too_weak' }} ParsedPattern
 */

/**
 * Parse a pattern.
 * @param {unknown} pattern
 * @param {{ maxLength: number, minRandom: number }} bounds
 * @returns {ParsedPattern}
 */
export const parsePattern = (pattern, { maxLength, minRandom }) => {
	if (typeof pattern !== 'string' || pattern.length === 0) return { ok: false, error: 'pattern_invalid' };
	if (pattern.length > maxLength) return { ok: false, error: 'pattern_too_long' };
	/** @type {Array<{ kind: 'random' | 'digit' | 'literal', char?: string }>} */
	const tokens = [];
	let random = 0;
	let digits = 0;
	for (const char of pattern) {
		if (char === '?') {
			tokens.push({ kind: 'random' });
			random += 1;
		} else if (char === '#') {
			tokens.push({ kind: 'digit' });
			digits += 1;
		} else if (LITERAL.test(char)) tokens.push({ kind: 'literal', char });
		else return { ok: false, error: 'pattern_invalid' };
	}
	const first = tokens[0];
	if (first?.kind === 'literal' && (first.char === '-' || first.char === '_')) return { ok: false, error: 'pattern_invalid' };
	if (random + digits < minRandom) return { ok: false, error: 'pattern_too_weak' };
	return { ok: true, tokens, random, digits };
};

/**
 * Bits of entropy of a parsed pattern over an alphabet.
 * @param {{ random: number, digits: number }} parsed
 * @param {number} alphabetSize
 */
export const entropyBits = (parsed, alphabetSize) => parsed.random * Math.log2(alphabetSize) + parsed.digits * Math.log2(10);

/**
 * An unbiased index in `[0, size)` from a byte source (rejection sampling: bytes ≥ the largest multiple of `size` are
 * discarded, so every index is equally likely).
 * @param {number} size 1…256
 * @param {() => number} nextByte a uniformly random byte 0…255
 */
export const unbiasedIndex = (size, nextByte) => {
	if (!Number.isInteger(size) || size < 1 || size > 256) throw new RangeError('size must be 1…256');
	const limit = 256 - (256 % size);
	for (;;) {
		const byte = nextByte();
		if (byte < limit) return byte % size;
	}
};

/**
 * Draw one code for a parsed pattern.
 * @param {Extract<ParsedPattern, { ok: true }>} parsed
 * @param {string} alphabet
 * @param {() => number} nextByte
 * @returns {string}
 */
export const drawCode = (parsed, alphabet, nextByte) =>
	parsed.tokens
		.map((token) => {
			if (token.kind === 'literal') return token.char ?? '';
			const set = token.kind === 'digit' ? DIGITS : alphabet;
			return set[unbiasedIndex(set.length, nextByte)] ?? '';
		})
		.join('');

/**
 * A byte reader over a refillable source of random bytes.
 * @param {(n: number) => Uint8Array} randomBytes
 * @param {number} [chunk]
 * @returns {() => number}
 */
export const byteReader = (randomBytes, chunk = 256) => {
	/** @type {Uint8Array} */
	let buffer = new Uint8Array(0);
	let offset = 0;
	return () => {
		if (offset >= buffer.length) {
			buffer = randomBytes(chunk);
			offset = 0;
		}
		const byte = buffer[offset] ?? 0;
		offset += 1;
		return byte;
	};
};

/**
 * Validate an alphabet: unique characters from `A–Z a–z 0–9`, at least 10.
 * @param {unknown} alphabet
 */
export const isValidAlphabet = (alphabet) =>
	typeof alphabet === 'string' &&
	alphabet.length >= 10 &&
	alphabet.length <= 64 &&
	/^[A-Za-z0-9]+$/.test(alphabet) &&
	new Set(alphabet).size === alphabet.length;
