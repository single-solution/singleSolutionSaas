/**
 * Internal: detached Ed25519 signatures carried in `SS-Timestamp` / `SS-Signature` headers, shared by signed events
 * (`events.js`) and signed requests (`requests.js`). Each caller supplies its own domain-separated message builder, so
 * a signature made for one purpose never verifies for the other.
 *
 * `SS-Signature: v1;kid=<kid>;sig=<base64url>[, v1;kid=<kid2>;sig=<...>]` — up to four entries for dual-signing.
 */
import { createProtocolError, isProtocolError } from './errors.js';
import { b64url, fromB64url, getHeader } from './encoding.js';

/** @typedef {import('./keys.js').Signer} Signer */
/** @typedef {import('./keys.js').KeyResolver} KeyResolver */
/** @typedef {Record<string, string | string[] | undefined> | Headers} HeaderBag */

/** Header names. */
export const SIGNATURE_HEADERS = Object.freeze({ timestamp: 'SS-Timestamp', signature: 'SS-Signature', keyId: 'SS-Key-Id' });
const MAX_SIGNATURES = 4;

/**
 * Validate signers and timestamp; return the signer list.
 * @param {{ signer?: Signer, signers?: Signer[], timestamp: number }} params
 * @returns {Signer[]}
 */
export const checkSigningInputs = ({ signer, signers, timestamp }) => {
	const all = signers ?? (signer ? [signer] : []);
	if (all.length === 0 || all.length > MAX_SIGNATURES) {
		throw createProtocolError('invalid_argument', 'one to four signers are required');
	}
	if (!Number.isInteger(timestamp) || timestamp <= 0)
		throw createProtocolError('invalid_argument', 'timestamp must be unix seconds');
	return all;
};

/**
 * Sign `message` with every signer and build the headers.
 * @param {Signer[]} signers
 * @param {number} timestamp
 * @param {Uint8Array} message
 * @returns {Promise<{ 'SS-Timestamp': string, 'SS-Signature': string, 'SS-Key-Id': string }>}
 */
export const signDetached = async (signers, timestamp, message) => {
	const entries = await Promise.all(signers.map(async (s) => `v1;kid=${s.kid};sig=${b64url(await s.sign(message))}`));
	return {
		'SS-Timestamp': String(timestamp),
		'SS-Signature': entries.join(', '),
		'SS-Key-Id': /** @type {Signer} */ (signers[0]).kid,
	};
};

/**
 * Parse the SS-Signature header strictly.
 * @param {string} header
 * @returns {{ kid: string, sig: Uint8Array }[]}
 */
const parseSignatureHeader = (header) => {
	const items = header.split(',').map((item) => item.trim());
	if (items.length > MAX_SIGNATURES) throw createProtocolError('malformed', 'bad SS-Signature header');
	return items.map((item) => {
		const match = /^v1;kid=([A-Za-z0-9._:-]{1,128});sig=([A-Za-z0-9_-]{86})$/.exec(item);
		if (!match) throw createProtocolError('malformed', 'bad SS-Signature entry');
		return { kid: /** @type {string} */ (match[1]), sig: fromB64url(/** @type {string} */ (match[2])) };
	});
};

/**
 * Read and check the timestamp header against the clock.
 * @param {HeaderBag} headers
 * @param {() => number} now
 * @param {number} toleranceSec
 * @returns {number}
 */
export const readTimestamp = (headers, now, toleranceSec) => {
	const raw = getHeader(headers, SIGNATURE_HEADERS.timestamp);
	if (!raw || !/^\d{1,12}$/.test(raw)) throw createProtocolError('malformed', 'SS-Timestamp is missing or invalid');
	const timestamp = Number(raw);
	const age = now() / 1000 - timestamp;
	if (age > toleranceSec) throw createProtocolError('expired', 'timestamp is outside the tolerance');
	if (age < -toleranceSec) throw createProtocolError('not_yet_valid', 'timestamp is in the future');
	return timestamp;
};

/**
 * Verify the SS-Signature header over `message`; returns the kid that verified.
 * @param {HeaderBag} headers
 * @param {Uint8Array} message
 * @param {KeyResolver} keyResolver
 * @returns {Promise<string>}
 */
export const verifyDetached = async (headers, message, keyResolver) => {
	const raw = getHeader(headers, SIGNATURE_HEADERS.signature);
	if (!raw) throw createProtocolError('malformed', 'SS-Signature is missing');
	const entries = parseSignatureHeader(raw);
	/** @type {import('./errors.js').ProtocolError | undefined} */
	let keyError;
	for (const { kid, sig } of entries) {
		/** @type {CryptoKey} */
		let key;
		try {
			key = await keyResolver.resolve(kid);
		} catch (error) {
			if (!isProtocolError(error)) throw error;
			keyError ??= error;
			continue;
		}
		const ok = await globalThis.crypto.subtle.verify(
			{ name: 'Ed25519' },
			key,
			/** @type {BufferSource} */ (sig),
			/** @type {BufferSource} */ (message),
		);
		if (ok) return kid;
	}
	if (keyError && entries.length === 1) throw keyError;
	throw createProtocolError('signature', 'no valid signature');
};

/**
 * @param {unknown} value
 * @returns {asserts value is string | Uint8Array}
 */
export const assertBody = (value) => {
	if (typeof value !== 'string' && !(value instanceof Uint8Array)) {
		throw createProtocolError('invalid_argument', 'body must be string or bytes');
	}
};
