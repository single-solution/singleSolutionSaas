/**
 * Messaging adapter — the one seam between customer updates and whatever sends them. Today it hands a rendered
 * message to the merchant's own messaging connector through app-kit (credentials from the Portal connector,
 * SSRF-guarded outbound, https only outside development). A later Messaging product takes over by switching
 * `customer_updates.delivery` to `event`: the service then publishes `orders.customer_update@1` instead of calling
 * this adapter, and nothing else changes.
 *
 * Wire format (provider-neutral JSON, `POST <send_path>` with `Idempotency-Key: <message id>`):
 * `{ id, channel, to: { email } | { phone }, lang, subject?, text, metadata: { orderId, number, status } }`. With an
 * `smtp` connector e-mail messages go out as plain-text mail; sms and whatsapp then need an HTTP gateway.
 * @module
 */
import { isKitError } from '@ss/app-kit';

/**
 * @typedef {object} OutboundMessage
 * @property {string} id
 * @property {string} channel
 * @property {{ email: string } | { phone: string }} to
 * @property {string} lang
 * @property {string | null} subject
 * @property {string} text
 * @property {Record<string, unknown>} metadata
 */

/** @typedef {{ ok: true, providerMessageId: string | null } | { ok: false, code: string, permanent: boolean }} SendResult */

/**
 * @param {any} connector smtp adapter
 * @param {OutboundMessage} message
 * @returns {Promise<SendResult>}
 */
const sendMail = async (connector, message) => {
	if (!('email' in message.to)) return { ok: false, code: 'channel_unsupported', permanent: true };
	try {
		const result = await connector.send({ to: message.to.email, subject: message.subject ?? message.id, text: message.text });
		return { ok: true, providerMessageId: typeof result?.id === 'string' ? result.id.slice(0, 256) : null };
	} catch (error) {
		if (!isKitError(error)) return { ok: false, code: 'upstream_error', permanent: false };
		const reply = Number(error.details?.responseCode);
		return reply >= 500 && reply <= 599
			? { ok: false, code: 'provider_refused', permanent: true }
			: { ok: false, code: error.code, permanent: false };
	}
};

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
			return { ok: false, code: isKitError(error) ? error.code : 'resource_unavailable', permanent: false };
		}
		if (connector?.provider === 'smtp') return sendMail(connector, message);
		try {
			const result = await connector.request({
				path,
				body: { ...message, subject: message.subject ?? undefined },
				headers: { 'idempotency-key': message.id },
			});
			if (!result.ok)
				return {
					ok: false,
					code: 'provider_refused',
					permanent: result.status >= 400 && result.status < 500 && result.status !== 429,
				};
			const body = result.body && typeof result.body === 'object' ? /** @type {Record<string, unknown>} */ (result.body) : {};
			const id = typeof body.id === 'string' ? body.id : typeof body.messageId === 'string' ? body.messageId : null;
			return { ok: true, providerMessageId: id ? id.slice(0, 256) : null };
		} catch (error) {
			return { ok: false, code: isKitError(error) ? error.code : 'upstream_error', permanent: false };
		}
	};
