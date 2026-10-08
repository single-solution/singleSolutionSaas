/**
 * Outgoing webhooks (PLAN 0.8.5): events sent to the merchant's own URLs, signed with the merchant's signing secret so
 * the receiver can check them (the signing is in `adapters/signatures.js`). No I/O.
 * @module
 */

/** Events a merchant can receive. */
export const WEBHOOK_EVENTS = Object.freeze(['message.sent', 'message.failed', 'recipient.unsubscribed']);
/** Name of the signature header. */
export const SIGNATURE_HEADER = 'ss-signature';
/** URLs a website may send events to, at most. */
export const MAX_WEBHOOK_URLS = 5;
/** A receiver should refuse signatures older than this (the docs say so). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * The webhook URLs of a website's settings that are https addresses (the setting allows up to five).
 * @param {unknown} urls
 * @returns {string[]}
 */
export const webhookUrls = (urls) =>
	(Array.isArray(urls) ? urls : [])
		.filter((url) => typeof url === 'string' && /^https:\/\/[^\s]+$/.test(url))
		.slice(0, MAX_WEBHOOK_URLS);
