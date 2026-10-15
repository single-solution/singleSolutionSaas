/**
 * Signatures (PLAN 0.8.5): replies forwarded by Twilio (`X-Twilio-Signature`, the auth token) and the WhatsApp Cloud
 * API (`X-Hub-Signature-256`, the app secret) are checked before they unsubscribe anyone. Outgoing webhooks are signed
 * with `@ss/protocol`'s `signWebhook` (`SS-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`).
 * @module
 */
import { createHmac } from 'node:crypto';
import { constantTimeEqual, hmacSha256Hex } from '@ss/protocol';

/**
 * Check Twilio's signature: base64 HMAC-SHA1 of the full URL followed by every form field (sorted by name) as
 * name + value.
 * @param {{ url: string, params: URLSearchParams, signature: string | null, authToken: string }} input
 */
export const verifyTwilio = ({ url, params, signature, authToken }) => {
	if (!signature) return false;
	const data = [...params.keys()].sort().reduce((text, name) => `${text}${name}${params.getAll(name).join('')}`, url);
	return constantTimeEqual(createHmac('sha1', authToken).update(data).digest('base64'), signature);
};

/**
 * Check the WhatsApp Cloud API's signature: `sha256=` + hex HMAC-SHA256 of the raw body with the app secret.
 * @param {{ body: string, signature: string | null, appSecret: string }} input
 */
export const verifyMeta = ({ body, signature, appSecret }) =>
	signature !== null && constantTimeEqual(`sha256=${hmacSha256Hex(appSecret, body)}`, signature);
