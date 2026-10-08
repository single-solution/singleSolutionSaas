/**
 * Web push (RFC 8030, 8291, 8292) with the merchant's own push keys (VAPID): the payload `{ title, body, url }` is
 * encrypted for the subscription (aes128gcm) and posted to its push service through the outbound `send`.
 *
 * Push keys connection value: `{ publicKey, privateKey, subject }` — the P-256 key pair as base64url (public: the
 * 65-byte uncompressed point; private: the 32-byte scalar) and a `mailto:` or https contact.
 * @module
 */
import {
	createCipheriv,
	createECDH,
	createHmac,
	createPrivateKey,
	createPublicKey,
	randomBytes,
	sign,
	verify,
} from 'node:crypto';
import { isNetError } from '@ss/net';
import { isObject } from './util.js';

/** @typedef {import('./providers.js').OutboundSend} OutboundSend */
/** @typedef {{ endpoint: string, keys: { p256dh: string, auth: string } }} PushSubscription */
/**
 * @typedef {{ ok: true, id: string | null } | { ok: false, error: string, retryable: boolean, gone?: boolean }} PushOutcome
 */

/** How long a push service keeps an undelivered push (seconds). */
export const PUSH_TTL_SECONDS = 24 * 60 * 60;
/** VAPID tokens last this long (the RFC allows up to 24 hours). */
const VAPID_SECONDS = 12 * 60 * 60;

/** @param {Uint8Array | Buffer} bytes */
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

/** @param {string} text */
const bytesOf = (text) => Buffer.from(text, 'base64url');

/**
 * HMAC-SHA-256 (the HKDF extract and single-block expand steps of RFC 8291).
 * @param {Buffer} key
 * @param {Buffer} data
 */
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/**
 * The key pair of a push keys value, checked: the public key must belong to the private key.
 * @param {unknown} value
 * @returns {{ ok: true, publicKey: string, privateKey: import('node:crypto').KeyObject, subject: string } | { ok: false, message: string }}
 */
export const pushKeysOf = (value) => {
	if (!isObject(value)) return { ok: false, message: 'Enter the public key, the private key and the contact.' };
	const { publicKey, privateKey, subject } = value;
	if (typeof subject !== 'string' || !/^(mailto:\S+@\S+|https:\/\/\S+)$/.test(subject))
		return { ok: false, message: 'The contact must be mailto:<e-mail> or an https address.' };
	if (typeof publicKey !== 'string' || typeof privateKey !== 'string')
		return { ok: false, message: 'Enter the public key and the private key (base64url).' };
	const point = bytesOf(publicKey);
	const scalar = bytesOf(privateKey);
	if (point.length !== 65 || point[0] !== 4 || scalar.length !== 32)
		return { ok: false, message: 'The keys must be a P-256 key pair in base64url (65 and 32 bytes).' };
	try {
		const key = createPrivateKey({
			key: { kty: 'EC', crv: 'P-256', x: b64url(point.subarray(1, 33)), y: b64url(point.subarray(33)), d: b64url(scalar) },
			format: 'jwk',
		});
		const probe = Buffer.from('ss-push-keys');
		const signature = sign('sha256', probe, { key, dsaEncoding: 'ieee-p1363' });
		const pub = createPublicKey({
			key: { kty: 'EC', crv: 'P-256', x: b64url(point.subarray(1, 33)), y: b64url(point.subarray(33)) },
			format: 'jwk',
		});
		if (!verify('sha256', probe, { key: pub, dsaEncoding: 'ieee-p1363' }, signature))
			return { ok: false, message: 'The public key does not belong to the private key.' };
		return { ok: true, publicKey, privateKey: key, subject };
	} catch {
		return { ok: false, message: 'The public key does not belong to the private key.' };
	}
};

/**
 * Check a subscription a browser sends (`PushSubscription.toJSON()`).
 * @param {unknown} input
 * @returns {PushSubscription | null}
 */
export const checkSubscription = (input) => {
	if (!isObject(input) || typeof input.endpoint !== 'string' || !isObject(input.keys)) return null;
	const { endpoint } = input;
	const { p256dh, auth } = input.keys;
	if (endpoint.length > 2048 || !/^https:\/\/[^\s]+$/.test(endpoint)) return null;
	if (typeof p256dh !== 'string' || typeof auth !== 'string') return null;
	if (bytesOf(p256dh).length !== 65 || bytesOf(auth).length !== 16) return null;
	return { endpoint, keys: { p256dh, auth } };
};

/**
 * Encrypt a payload for a subscription (RFC 8291, one aes128gcm record).
 * @param {{ payload: Buffer, keys: { p256dh: string, auth: string }, salt?: Buffer, serverKeys?: import('node:crypto').ECDH }} input
 * @returns {Buffer} the request body
 */
export const encryptPayload = ({ payload, keys, salt = randomBytes(16), serverKeys }) => {
	const server = serverKeys ?? createECDH('prime256v1');
	if (!serverKeys) server.generateKeys();
	const uaPublic = bytesOf(keys.p256dh);
	const asPublic = server.getPublicKey();
	const shared = server.computeSecret(uaPublic);
	const prkKey = hmac(bytesOf(keys.auth), shared);
	const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
	const prk = hmac(salt, ikm);
	const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
	const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
	const cipher = createCipheriv('aes-128-gcm', cek, nonce);
	const encrypted = Buffer.concat([
		cipher.update(Buffer.concat([payload, Buffer.from([2])])),
		cipher.final(),
		cipher.getAuthTag(),
	]);
	const header = Buffer.alloc(21);
	salt.copy(header, 0);
	header.writeUInt32BE(4096, 16);
	header.writeUInt8(asPublic.length, 20);
	return Buffer.concat([header, asPublic, encrypted]);
};

/**
 * The VAPID `Authorization` header for a push service.
 * @param {{ endpoint: string, keys: { publicKey: string, privateKey: import('node:crypto').KeyObject, subject: string }, now: number }} input
 */
export const vapidHeader = ({ endpoint, keys, now }) => {
	const head = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
	const claims = b64url(
		Buffer.from(
			JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + VAPID_SECONDS, sub: keys.subject }),
		),
	);
	const signature = sign('sha256', Buffer.from(`${head}.${claims}`), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
	return `vapid t=${head}.${claims}.${b64url(signature)}, k=${keys.publicKey}`;
};

/**
 * @param {{ send: OutboundSend, now: () => number }} options
 */
export const createWebPush = ({ send, now }) => {
	/**
	 * Send one push.
	 * @param {unknown} keysValue the push keys connection value
	 * @param {PushSubscription} subscription
	 * @param {{ title: string, body: string, url?: string }} message
	 * @returns {Promise<PushOutcome>}
	 */
	const push = async (keysValue, subscription, message) => {
		const keys = pushKeysOf(keysValue);
		if (!keys.ok) return { ok: false, error: `The push keys are not usable: ${keys.message}`, retryable: false };
		const body = encryptPayload({ payload: Buffer.from(JSON.stringify(message)), keys: subscription.keys });
		try {
			const response = await send(subscription.endpoint, {
				method: 'POST',
				headers: {
					authorization: vapidHeader({ endpoint: subscription.endpoint, keys, now: now() }),
					'content-encoding': 'aes128gcm',
					'content-type': 'application/octet-stream',
					ttl: String(PUSH_TTL_SECONDS),
				},
				body,
				timeoutMs: 15_000,
				redirect: 'error',
			});
			if (response.status >= 200 && response.status < 300) return { ok: true, id: response.headers.location ?? null };
			const gone = response.status === 404 || response.status === 410;
			return {
				ok: false,
				error: gone ? 'The browser is no longer subscribed.' : `The push service answered HTTP ${response.status}.`,
				retryable: response.status >= 500 || response.status === 429,
				...(gone ? { gone: true } : {}),
			};
		} catch (error) {
			const reason = isNetError(error) ? error.code : 'network';
			return { ok: false, error: `The push service could not be reached (${reason}).`, retryable: reason !== 'ssrf_blocked' };
		}
	};
	return Object.freeze({ push });
};
