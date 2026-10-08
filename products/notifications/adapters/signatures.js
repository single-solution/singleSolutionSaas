/**
 * Signatures (PLAN 0.8.5): outgoing webhooks are signed with the merchant's signing secret as
 * `SS-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">` (the docs' check snippet verifies the same);
 * replies forwarded by Twilio (`X-Twilio-Signature`, the auth token) and the WhatsApp Cloud API
 * (`X-Hub-Signature-256`, the app secret) are checked before they unsubscribe anyone.
 * @module
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { SIGNATURE_TOLERANCE_SECONDS } from '../core/webhooks.js';

/**
 * @param {string} a
 * @param {string} b
 */
const same = (a, b) => {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * Check Twilio's signature: base64 HMAC-SHA1 of the full URL followed by every form field (sorted by name) as
 * name + value.
 * @param {{ url: string, params: URLSearchParams, signature: string | null, authToken: string }} input
 */
export const verifyTwilio = ({ url, params, signature, authToken }) => {
	if (!signature) return false;
	const data = [...params.keys()].sort().reduce((text, name) => `${text}${name}${params.getAll(name).join('')}`, url);
	return same(createHmac('sha1', authToken).update(data).digest('base64'), signature);
};

/**
 * Check the WhatsApp Cloud API's signature: `sha256=` + hex HMAC-SHA256 of the raw body with the app secret.
 * @param {{ body: string, signature: string | null, appSecret: string }} input
 */
export const verifyMeta = ({ body, signature, appSecret }) =>
	signature !== null && same(`sha256=${createHmac('sha256', appSecret).update(body).digest('hex')}`, signature);

/**
 * The signature header value of a body.
 * @param {string} body the exact JSON text sent
 * @param {string} secret
 * @param {number} now epoch ms
 */
export const signWebhook = (body, secret, now) => {
	const t = Math.floor(now / 1000);
	return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
};

/**
 * Check a signature header (what a receiver does; used by the tests and shown in the docs).
 * @param {{ body: string, header: string | null, secret: string, now: number, toleranceSeconds?: number }} input
 */
export const verifyWebhook = ({ body, header, secret, now, toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS }) => {
	const parts = Object.fromEntries((header ?? '').split(',').map((part) => part.split('=', 2)));
	const t = Number(parts.t);
	if (!Number.isInteger(t) || Math.abs(now / 1000 - t) > toleranceSeconds || typeof parts.v1 !== 'string') return false;
	const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${body}`).digest('hex'));
	const given = Buffer.from(parts.v1);
	return given.length === expected.length && timingSafeEqual(given, expected);
};
