/**
 * Message delivery through the merchant's **own** messaging connector (app-kit `connectors.messaging(websiteId)`,
 * credentials resolved from the Portal, SSRF-guarded HTTPS, never platform keys). One transport for every channel,
 * like the ibrahimMobiles gateway client (`packages/shared/src/messaging`): the merchant's gateway receives
 *
 * ```json
 * POST <baseUrl>/messages
 * { "channel": "email" | "sms" | "whatsapp", "to": "<e-mail or E.164>", "subject"?: "…", "text": "…",
 *   "purpose": "otp" | "magic_link" | "new_device", "lang": "en", "reference": "<challenge or session id>",
 *   "idempotencyKey": "…", "variables": { "code"?, "link"?, "minutes"?, "brand", "device"? } }
 * ```
 *
 * and routes it to its e-mail / SMS / WhatsApp provider. A non-2xx answer (or a 2xx whose JSON body says it was not
 * sent, as gateways sometimes do — the ibrahimMobiles lesson) is a failed delivery. Nothing about the message is
 * logged: it carries a secret.
 * @module
 */

/**
 * @typedef {object} OutboundMessage
 * @property {string} channel
 * @property {string} to
 * @property {string} [subject]
 * @property {string} text
 * @property {string} purpose
 * @property {string} lang
 * @property {string} reference
 * @property {string} idempotencyKey
 * @property {Record<string, string | number>} variables
 */

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const FAILURE_WORDS = new Set(['error', 'failed', 'fail', 'failure', 'invalid', 'rejected', 'false']);

/**
 * Whether a gateway's 2xx JSON body nevertheless reports a failure (`{ error }`, `{ sent: false }`, `{ success: false }`,
 * `{ status: "failed" }`).
 * @param {unknown} body
 */
export const reportsFailure = (body) => {
	if (!isObject(body)) return false;
	const falsy = (/** @type {unknown} */ v) => v === false || v === 0 || v === 'false' || v === '0';
	if (body.error !== undefined && body.error !== null && body.error !== '' && body.error !== false) return true;
	if ('sent' in body && falsy(body.sent)) return true;
	if ('success' in body && falsy(body.success)) return true;
	return typeof body.status === 'string' && FAILURE_WORDS.has(body.status.trim().toLowerCase());
};

/**
 * @param {{ connectors: { messaging: (websiteId: string) => Promise<{ send: (message: Record<string, unknown>) => Promise<unknown> }> },
 *   log?: { warn?: (message: string, fields?: Record<string, unknown>) => void } }} deps
 */
export const createMessenger = ({ connectors, log }) =>
	Object.freeze({
		/**
		 * @param {string} websiteId
		 * @param {OutboundMessage} message
		 * @returns {Promise<{ ok: true } | { ok: false, code: 'delivery_failed' | 'resource_missing' }>}
		 */
		send: async (websiteId, message) => {
			try {
				const adapter = await connectors.messaging(websiteId);
				const body = await adapter.send({ ...message });
				if (reportsFailure(body)) {
					log?.warn?.('messaging gateway reported a failure', {
						websiteId,
						purpose: message.purpose,
						channel: message.channel,
					});
					return { ok: false, code: 'delivery_failed' };
				}
				return { ok: true };
			} catch (error) {
				const code = /** @type {{ code?: string }} */ (error)?.code;
				log?.warn?.('message delivery failed', { websiteId, purpose: message.purpose, channel: message.channel, code });
				return {
					ok: false,
					code: code === 'resource_missing' || code === 'not_implemented' ? 'resource_missing' : 'delivery_failed',
				};
			}
		},
	});

/** @typedef {ReturnType<typeof createMessenger>} Messenger */
