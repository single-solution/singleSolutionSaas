/**
 * Timestamped webhook signatures, the one format of every signed call a product sends to a merchant's server (webhooks,
 * chat tools, gateway notices) and the one Stripe sends: a header `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`
 * made with a shared secret. A check accepts any `v1` in the header (Stripe sends several while a secret rotates) and
 * refuses a time more than `toleranceSeconds` away from now, so an old call cannot be sent again later.
 * @module
 */
import { constantTimeEqual, hmacSha256Hex } from './encoding.js';

/** Default accepted distance between the signature's time and now, seconds. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/** A signature time: unix seconds, digits only. */
const TIMESTAMP = /^\d{1,12}$/;

/**
 * @param {unknown} secret
 * @returns {secret is string}
 */
const isSecret = (secret) => typeof secret === 'string' && secret.length > 0;

/**
 * The signature header value of a body: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`.
 * @param {{ body: string, secret: string, now?: () => number }} params `body` is the exact text sent; `now` epoch ms
 * @returns {string}
 */
export const signWebhook = ({ body, secret, now = Date.now }) => {
	if (!isSecret(secret)) throw new TypeError('secret is required');
	if (typeof body !== 'string') throw new TypeError('body must be the exact text sent');
	const t = Math.floor(now() / 1000);
	return `t=${t},v1=${hmacSha256Hex(secret, `${t}.${body}`)}`;
};

/**
 * Check a signature header as {@link signWebhook} makes it: true only when its time is within `toleranceSeconds` of
 * now and one of its `v1` values is the HMAC of `"<t>.<body>"` (compared in constant time). A missing or malformed
 * header, an empty secret or a body that is not text is false.
 * @param {{ header: string | null | undefined, body: string, secret: string, now?: () => number,
 *   toleranceSeconds?: number }} params `body` is the raw text received; `now` epoch ms
 * @returns {boolean}
 */
export const verifyWebhook = ({ header, body, secret, now = Date.now, toleranceSeconds = WEBHOOK_TOLERANCE_SECONDS }) => {
	if (typeof header !== 'string' || typeof body !== 'string' || !isSecret(secret)) return false;
	const parts = header.split(',').map((part) => {
		const text = part.trim();
		const at = text.indexOf('=');
		return at === -1 ? ['', ''] : [text.slice(0, at), text.slice(at + 1)];
	});
	const t = parts.find(([name]) => name === 't')?.[1];
	if (t === undefined || !TIMESTAMP.test(t) || Math.abs(now() / 1000 - Number(t)) > toleranceSeconds) return false;
	const expected = hmacSha256Hex(secret, `${t}.${body}`);
	return parts.some(([name, value]) => name === 'v1' && constantTimeEqual(value, expected));
};
