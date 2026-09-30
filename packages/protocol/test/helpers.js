import { expect } from 'vitest';
import { createJwks, createKeyResolver, createSigner, generateSigningKey } from '../src/index.js';
import { b64url, fromB64url, fromUtf8 } from '../src/encoding.js';

/** Fixed start instant used across tests (2026-10-01T00:00:00Z). */
export const T0 = Date.parse('2026-10-01T00:00:00Z');

/**
 * Controllable clock.
 * @param {number} [start]
 */
export const createClock = (start = T0) => {
	let t = start;
	return {
		now: () => t,
		/** @param {number} ms */
		advance: (ms) => {
			t += ms;
		},
		/** @param {number} ms */
		set: (ms) => {
			t = ms;
		},
	};
};

/**
 * Generate a key and signer.
 * @param {string} kid
 */
export const makeKey = async (kid) => {
	const { privateJwk, publicJwk } = await generateSigningKey({ kid });
	return { privateJwk, publicJwk, signer: createSigner(privateJwk) };
};

/**
 * Resolver over a static set of public keys.
 * @param {import('../src/index.js').PublicJwk[]} keys
 * @param {() => number} [now]
 */
export const staticResolver = (keys, now) => createKeyResolver({ jwks: createJwks(keys), ...(now ? { now } : {}) });

/**
 * Deterministic randomBytes.
 * @param {number} [seed]
 */
export const seededRandom = (seed = 1) => {
	let counter = seed;
	/** @param {number} length */
	return (length) => {
		const out = new Uint8Array(length);
		for (let i = 0; i < length; i += 1) out[i] = (counter * 31 + i * 7) & 0xff;
		counter += 1;
		return out;
	};
};

/**
 * Decode a compact JWS segment as JSON.
 * @param {string} token
 * @param {number} index
 * @returns {Record<string, any>}
 */
export const decodeSegment = (token, index) => JSON.parse(fromUtf8(fromB64url(/** @type {string} */ (token.split('.')[index]))));

/**
 * Replace a compact JWS segment with the JSON-encoded value (signature kept → must fail verification).
 * @param {string} token
 * @param {number} index
 * @param {(value: Record<string, any>) => Record<string, any>} mutate
 */
export const tamperSegment = (token, index, mutate) => {
	const parts = token.split('.');
	parts[index] = b64url(JSON.stringify(mutate(decodeSegment(token, index))));
	return parts.join('.');
};

/**
 * Flip one character of the signature segment.
 * @param {string} token
 */
export const tamperSignature = (token) => {
	const parts = token.split('.');
	const sig = /** @type {string} */ (parts[2]);
	parts[2] = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
	return parts.join('.');
};

/**
 * Assert that a promise rejects with a ProtocolError of the given code.
 * @param {Promise<unknown>} promise
 * @param {string} code
 */
export const expectCode = async (promise, code) => {
	await expect(promise).rejects.toMatchObject({ name: 'ProtocolError', code });
};

/**
 * Assert that a sync function throws a ProtocolError of the given code.
 * @param {() => unknown} fn
 * @param {string} code
 */
export const expectThrowCode = (fn, code) => {
	expect(fn).toThrow(expect.objectContaining({ name: 'ProtocolError', code }));
};
