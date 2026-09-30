/**
 * Signed event / webhook delivery (Portal → product, product → merchant).
 *
 * Headers:
 *   SS-Timestamp: <unix seconds>
 *   SS-Signature: v1;kid=<kid>;sig=<base64url Ed25519 signature>[, v1;kid=<kid2>;sig=<...>]
 *   SS-Key-Id:    <kid of the first signature>   (informational routing/log hint — never trusted for verification)
 *
 * Signed message (UTF-8): `ss-event.v1.${timestamp}.${hex(sha256(rawBody))}`. The `ss-event.v1.` prefix gives domain
 * separation from JWS signing inputs made with the same key. Hashing the body keeps the signed message small and lets
 * verifiers stream large bodies. Several signatures (comma-separated) let the sender dual-sign during key rotation;
 * the verifier accepts the delivery if any signature verifies under a key it trusts.
 *
 * Verification: timestamp within ±toleranceSec, signature, then replay check on `timestamp + body hash` recorded
 * until the tolerance window closes (a replay after that fails the timestamp check anyway).
 */
import { createProtocolError, isProtocolError } from './errors.js';
import { b64url, fromB64url, getHeader, sha256Hex, utf8 } from './encoding.js';

/** @typedef {import('./keys.js').Signer} Signer */
/** @typedef {import('./keys.js').KeyResolver} KeyResolver */
/** @typedef {import('./replay.js').ReplayStore} ReplayStore */
/** @typedef {{ 'SS-Timestamp': string, 'SS-Signature': string, 'SS-Key-Id': string }} EventHeaders */

/** Header names. */
export const EVENT_HEADERS = Object.freeze({ timestamp: 'SS-Timestamp', signature: 'SS-Signature', keyId: 'SS-Key-Id' });
const MAX_SIGNATURES = 4;

/**
 * @param {number} timestamp
 * @param {string | Uint8Array} body
 * @returns {Uint8Array}
 */
const signedMessage = (timestamp, body) => utf8(`ss-event.v1.${timestamp}.${sha256Hex(body)}`);

/**
 * Sign an event body.
 * @param {{ signer?: Signer, signers?: Signer[], body: string | Uint8Array, timestamp: number }} params `timestamp` in
 *   unix seconds (take it from your injected clock). Pass `signers` to dual-sign during rotation.
 * @returns {Promise<EventHeaders>}
 */
export const signEvent = async ({ signer, signers, body, timestamp }) => {
	const all = signers ?? (signer ? [signer] : []);
	if (all.length === 0 || all.length > MAX_SIGNATURES)
		throw createProtocolError('invalid_argument', 'one to four signers are required');
	if (!Number.isInteger(timestamp) || timestamp <= 0)
		throw createProtocolError('invalid_argument', 'timestamp must be unix seconds');
	if (typeof body !== 'string' && !(body instanceof Uint8Array))
		throw createProtocolError('invalid_argument', 'body must be string or bytes');
	const message = signedMessage(timestamp, body);
	const entries = await Promise.all(all.map(async (s) => `v1;kid=${s.kid};sig=${b64url(await s.sign(message))}`));
	return {
		'SS-Timestamp': String(timestamp),
		'SS-Signature': entries.join(', '),
		'SS-Key-Id': /** @type {Signer} */ (all[0]).kid,
	};
};

/**
 * Parse the SS-Signature header strictly.
 * @param {string} header
 * @returns {{ kid: string, sig: Uint8Array }[]}
 */
const parseSignatureHeader = (header) => {
	const items = header.split(',').map((item) => item.trim());
	if (items.length === 0 || items.length > MAX_SIGNATURES) throw createProtocolError('malformed', 'bad SS-Signature header');
	return items.map((item) => {
		const match = /^v1;kid=([A-Za-z0-9._:-]{1,128});sig=([A-Za-z0-9_-]{86})$/.exec(item);
		if (!match) throw createProtocolError('malformed', 'bad SS-Signature entry');
		return { kid: /** @type {string} */ (match[1]), sig: fromB64url(/** @type {string} */ (match[2])) };
	});
};

/**
 * Verify a signed event delivery.
 * @param {{
 *   headers: Record<string, string | string[] | undefined> | Headers, rawBody: string | Uint8Array, keyResolver: KeyResolver,
 *   replayStore: ReplayStore, now?: () => number, toleranceSec?: number,
 * }} params `rawBody` must be the exact bytes received (verify before JSON parsing).
 * @returns {Promise<{ timestamp: number, kid: string, bodySha256: string }>}
 */
export const verifyEvent = async ({ headers, rawBody, keyResolver, replayStore, now = Date.now, toleranceSec = 300 }) => {
	if (!replayStore || typeof replayStore.seen !== 'function')
		throw createProtocolError('invalid_argument', 'replayStore is required');
	if (typeof rawBody !== 'string' && !(rawBody instanceof Uint8Array))
		throw createProtocolError('invalid_argument', 'rawBody is required');
	const rawTimestamp = getHeader(headers, EVENT_HEADERS.timestamp);
	const rawSignature = getHeader(headers, EVENT_HEADERS.signature);
	if (!rawTimestamp || !/^\d{1,12}$/.test(rawTimestamp))
		throw createProtocolError('malformed', 'SS-Timestamp is missing or invalid');
	if (!rawSignature) throw createProtocolError('malformed', 'SS-Signature is missing');
	const timestamp = Number(rawTimestamp);
	const age = now() / 1000 - timestamp;
	if (age > toleranceSec) throw createProtocolError('expired', 'event timestamp is outside the tolerance');
	if (age < -toleranceSec) throw createProtocolError('not_yet_valid', 'event timestamp is in the future');
	const entries = parseSignatureHeader(rawSignature);
	const message = signedMessage(timestamp, rawBody);
	/** @type {import('./errors.js').ProtocolError | undefined} */
	let keyError;
	/** @type {string | undefined} */
	let verifiedKid;
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
		if (ok) {
			verifiedKid = kid;
			break;
		}
	}
	if (!verifiedKid) {
		if (keyError && entries.length === 1) throw keyError;
		throw createProtocolError('signature', 'no valid event signature');
	}
	const bodySha256 = sha256Hex(rawBody);
	if (await replayStore.seen(`event|${timestamp}|${bodySha256}`, (timestamp + toleranceSec) * 1000)) {
		throw createProtocolError('replay', 'event was already delivered');
	}
	return { timestamp, kid: verifiedKid, bodySha256 };
};
