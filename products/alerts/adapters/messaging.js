/**
 * Messaging adapter: hands a rendered alert to the merchant's own messaging provider through app-kit's messaging
 * connector (credentials from the Portal connector, SSRF-guarded `@ss/net` outbound, https only outside development).
 * Every send carries `Idempotency-Key: <message id>`, so a provider that honours it never delivers a message twice even
 * when a lease expired mid-send and another instance retried.
 *
 * The wire format is provider-neutral JSON: `{ id, channel, to: { email } | { phone }, lang, subject?, text,
 * headers?: { List-Unsubscribe, List-Unsubscribe-Post }, metadata }` POSTed to `dispatch.send_path` (default
 * `/messages`). The answer's `id` / `messageId` (if any) is kept as the provider message id.
 * @module
 */
import { createHttpMessaging, isKitError } from '@ss/app-kit';

/**
 * Connector adapter factories registered with app-kit: the Portal names its HTTP messaging provider `generic-http`,
 * app-kit's built-in adapter is keyed `http` — both map to the same generic HTTP adapter.
 * @type {Record<string, (context: { descriptor: Record<string, unknown>, send: any, policy: any }) => any>}
 */
export const MESSAGING_ADAPTERS = Object.freeze({
	'generic-http': ({ descriptor, send, policy }) => createHttpMessaging({ descriptor, send, policy }),
	http: ({ descriptor, send, policy }) => createHttpMessaging({ descriptor, send, policy }),
});

/**
 * @typedef {object} OutboundMessage
 * @property {string} id
 * @property {string} channel
 * @property {{ email: string } | { phone: string }} to
 * @property {string} lang
 * @property {string | null} subject
 * @property {string} text
 * @property {Record<string, string>} [headers]
 * @property {Record<string, unknown>} metadata
 */

/**
 * @typedef {{ ok: true, providerMessageId: string | null } | { ok: false, code: string, status?: number }} SendResult
 */

/**
 * @param {{ connectors: { messaging: (websiteId: string) => Promise<any> } }} product app-kit product
 * @returns {(websiteId: string, message: OutboundMessage, options: { path: string }) => Promise<SendResult>}
 */
export const createMessenger =
	(product) =>
	async (websiteId, message, { path }) => {
		/** @type {any} */
		let connector;
		try {
			connector = await product.connectors.messaging(websiteId);
		} catch (error) {
			return { ok: false, code: isKitError(error) ? error.code : 'resource_unavailable' };
		}
		try {
			const result = await connector.request({
				path,
				body: { ...message, subject: message.subject ?? undefined },
				headers: { 'idempotency-key': message.id },
			});
			if (!result.ok) return { ok: false, code: 'provider_refused', status: result.status };
			const body = result.body && typeof result.body === 'object' ? /** @type {Record<string, unknown>} */ (result.body) : {};
			const id = typeof body.id === 'string' ? body.id : typeof body.messageId === 'string' ? body.messageId : null;
			return { ok: true, providerMessageId: id ? id.slice(0, 256) : null };
		} catch (error) {
			return { ok: false, code: isKitError(error) ? error.code : 'upstream_error' };
		}
	};
