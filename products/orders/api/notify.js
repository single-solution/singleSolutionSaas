/**
 * Customer updates (review A1): a status message per configured status, in the order's language, on the first
 * channel the customer can be reached on, through the merchant's own messaging connector — or handed to a messaging
 * product as `orders.customer_update@1` (identity references only; the text is read back with the sk_ key). Messages
 * are stored first and claimed before sending (a lease), so two instances never send one twice; failures retry
 * with backoff up to `max_attempts`. Nothing runs on a timer: a due retry is sent when its order is next read, or from
 * the dashboard's "Process due now".
 */
import { formatMoney } from '../core/money.js';
import { pickChannel, renderMessage } from '../core/messages.js';
import { customerRef } from '../core/orders.js';
import { labelsFor } from './context.js';

const LEASE_MS = 60_000;
const MAX_BACKOFF_MS = 6 * 3_600_000;

/**
 * @param {import('./context.js').Deps} deps
 */
export const createNotifier = (deps) => {
	/**
	 * Send one stored message (claim → provider → settle).
	 * @param {import('./context.js').Site} site
	 * @param {string} id
	 * @returns {Promise<'sent' | 'retry' | 'failed' | 'skipped'>}
	 */
	const send = async (site, id) => {
		const message = await site.repos.messages.claim(id, new Date(deps.now() + LEASE_MS));
		if (!message) return 'skipped';
		const result = await deps.send(
			site.websiteId,
			{
				id: message.id,
				channel: message.channel,
				to: message.to,
				lang: message.lang,
				subject: message.subject ?? null,
				text: message.text,
				metadata: { orderId: message.orderId, number: message.number, status: message.status },
			},
			{ path: site.settings.updates.send_path },
		);
		const at = new Date(deps.now());
		if (result.ok) {
			await site.repos.messages.settle(id, {
				state: 'sent',
				sentAt: at,
				providerMessageId: result.providerMessageId,
				error: null,
			});
			return 'sent';
		}
		const attempts = Number(message.attempts ?? 1);
		if (result.permanent || attempts >= site.settings.updates.max_attempts) {
			await site.repos.messages.settle(id, { state: 'failed', error: result.code, failedAt: at });
			return 'failed';
		}
		const delay = Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** Math.max(0, attempts - 1));
		await site.repos.messages.settle(id, { state: 'retry', error: result.code, nextAttemptAt: new Date(deps.now() + delay) });
		return 'retry';
	};

	/**
	 * Create the message an outbox entry asks for and send it (or hand it off). Idempotent per entry key.
	 * @param {import('./context.js').Site} site
	 * @param {Record<string, any>} order
	 * @param {{ key: string, status: string, reason?: string | null }} entry
	 * @returns {Promise<string>} what happened
	 */
	const deliver = async (site, order, entry) => {
		const { settings } = site;
		if (!settings.enabled('customer_updates') || !settings.updates.statuses.includes(entry.status)) return 'off';
		const target = pickChannel(
			{ email: order.customer?.email ?? null, phone: order.customer?.phone ?? order.shipping?.phone ?? null },
			settings.updates.channels,
		);
		if (!target) return 'unreachable';
		const labels = labelsFor(deps, site, order.lang);
		const tracking = order.fulfilment ?? {};
		const { subject, text } = renderMessage({
			status: entry.status,
			channel: target.channel,
			lang: labels.lang,
			templates: settings.updates.templates,
			strings: labels.strings,
			values: {
				brand: settings.updates.brand || settings.invoices.brand_name || settings.domain,
				name: order.customer?.name ?? order.shipping?.name ?? '',
				number: order.number,
				status: labels.statusLabel(entry.status === 'placed' ? order.status : entry.status),
				total: formatMoney(order.amounts.total, order.currency, labels.lang),
				carrier: tracking.carrierName ?? '',
				tracking_number: tracking.trackingNumber ?? '',
				tracking_url: tracking.trackingUrl ?? '',
				reason: entry.reason ?? '',
			},
		});
		const id = deps.stableId('msg', `${site.websiteId}|${entry.key}`);
		const event = settings.updates.delivery === 'event';
		const created = await site.repos.messages.insert({
			id,
			orderId: order.id,
			number: order.number,
			customerId: order.customer?.customerId ?? null,
			status: entry.status,
			channel: target.channel,
			to: target.to,
			lang: labels.lang,
			subject,
			text,
			state: event ? 'handed_off' : 'pending',
			attempts: 0,
			nextAttemptAt: new Date(deps.now()),
			error: null,
		});
		if (event) {
			if (created) {
				const ref = customerRef(order);
				await deps.publish({
					websiteId: site.websiteId,
					type: 'orders.customer_update@1',
					idempotencyKey: `update:${id}`,
					data: {
						messageId: id,
						orderId: order.id,
						number: String(order.number).slice(0, 64),
						status: entry.status,
						channel: /** @type {any} */ (target.channel),
						lang: labels.lang,
						...(ref?.customerId ? { customerId: ref.customerId } : {}),
						...(ref?.subject ? { subject: ref.subject } : {}),
					},
				});
			}
			return 'handed_off';
		}
		return send(site, id);
	};

	/**
	 * Retry due messages: the website's (the dashboard button) or one order's (when the order is read), bounded.
	 * @param {import('./context.js').Site} site
	 * @param {number} limit
	 * @param {{ orderId?: string }} [scope]
	 */
	const retryDue = async (site, limit, { orderId } = {}) => {
		let sent = 0;
		for (const message of await site.repos.messages.due(new Date(deps.now()), limit, orderId)) {
			// an expired lease (a crashed send) is released back to retry first
			if (message.state === 'sending') await site.repos.messages.settle(message.id, { state: 'retry' });
			if ((await send(site, message.id)) === 'sent') sent += 1;
		}
		return sent;
	};

	return Object.freeze({ deliver, send, retryDue });
};

/** @typedef {ReturnType<typeof createNotifier>} Notifier */
