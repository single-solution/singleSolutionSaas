/**
 * Messaging adapter: hands a rendered alert to the merchant's own messaging provider through app-kit's messaging
 * connector (credentials from the Portal connector, SSRF-guarded `@ss/net` outbound, https only outside development).
 * Every send carries `Idempotency-Key: <message id>`, so a provider that honours it never delivers a message twice even
 * when a lease expired mid-send and another instance retried.
 *
 * The wire format is provider-neutral JSON: `{ id, channel, to: { email } | { phone }, lang, subject?, text,
 * headers?: { List-Unsubscribe, List-Unsubscribe-Post }, metadata }` POSTed to `dispatch.send_path` (default
 * `/messages`). The answer's `id` / `messageId` (if any) is kept as the provider message id.
 *
 * app-kit resolves the adapter from the Portal descriptor's `provider` (built-in: `generic-http` and `smtp`), so the
 * product registers no adapters. With an `smtp` connector, e-mail alerts are sent as plain-text mail (subject, text and
 * the `List-Unsubscribe` headers); SMS alerts need an HTTP gateway and fail with `channel_unsupported`.
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
 * @property {Record<string, string>} [headers]
 * @property {Record<string, unknown>} metadata
 */

/**
 * @typedef {{ ok: true, providerMessageId: string | null } | { ok: false, code: string, status?: number }} SendResult
 */

/**
 * Send an e-mail alert through app-kit's SMTP adapter.
 * @param {{ send: (message: Record<string, unknown>) => Promise<{ id: string | null }> }} connector
 * @param {OutboundMessage} message
 * @returns {Promise<SendResult>}
 */
const sendMail = async (connector, message) => {
	if (!('email' in message.to)) return { ok: false, code: 'channel_unsupported' };
	const subject = message.subject ?? (message.text.split(/\r?\n/, 1)[0] ?? '').slice(0, 78).trim();
	try {
		const result = await connector.send({
			to: message.to.email,
			subject: subject === '' ? message.id : subject,
			text: message.text,
			...(message.headers ? { headers: message.headers } : {}),
		});
		return { ok: true, providerMessageId: typeof result?.id === 'string' ? result.id.slice(0, 256) : null };
	} catch (error) {
		if (!isKitError(error)) return { ok: false, code: 'upstream_error' };
		// SMTP 5xx replies are permanent (bad mailbox, refused content); 4xx and network trouble are retried
		const reply = Number(error.details?.responseCode);
		return { ok: false, code: reply >= 500 && reply <= 599 ? 'provider_refused' : error.code };
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
			return { ok: false, code: isKitError(error) ? error.code : 'resource_unavailable' };
		}
		if (connector?.provider === 'smtp') return sendMail(connector, message);
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
