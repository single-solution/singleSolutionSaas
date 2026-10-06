/**
 * The order outbox: the events and customer messages a change causes are pushed onto the order (`pending`) in the
 * same single-document write as the change, then delivered — events through app-kit's durable event outbox, messages
 * through the notifier — and pulled. A crash between the write and the delivery leaves the entries on the order; they
 * are delivered again with the same idempotency keys the next time the order is read (`redeliver`) or from the
 * dashboard's "Process due now" (`retry`), so nothing is lost and nothing is sent twice. Nothing runs on a timer.
 */
import { customerRef, eventContext } from '../core/orders.js';
import { isRevenue } from '../core/lifecycle.js';

/**
 * @typedef {{ key: string, kind: 'event', type: string, data: Record<string, unknown> }
 *   | { key: string, kind: 'notify', status: string, reason: string | null }} PendingEntry
 */

/**
 * The entries a status move causes: `orders.status_changed@1`, the catalogued event the transition publishes, and the
 * customer message.
 * @param {import('./context.js').Site} site
 * @param {Record<string, any>} order the order after the move
 * @param {{ from: string, to: string, actor: string, reason: string | null, publish: string, seq: number }} move
 * @returns {PendingEntry[]}
 */
export const moveEntries = (site, order, { from, to, actor, reason, publish, seq }) => {
	const ref = customerRef(order);
	const f = order.fulfilment ?? {};
	/** @type {PendingEntry[]} */
	const entries = [
		{
			key: `status:${order.id}:${seq}`,
			kind: 'event',
			type: 'orders.status_changed@1',
			data: {
				orderId: order.id,
				number: String(order.number).slice(0, 64),
				from,
				to,
				actor,
				...(reason ? { reason } : {}),
				revenue: isRevenue(site.settings.matrix, to),
				...(ref?.customerId ? { customerId: ref.customerId } : {}),
				...(ref?.subject ? { subject: ref.subject } : {}),
				...(f.carrierName ? { carrier: f.carrierName } : {}),
				...(f.trackingNumber ? { trackingNumber: f.trackingNumber } : {}),
				...(f.trackingUrl ? { trackingUrl: f.trackingUrl } : {}),
			},
		},
	];
	if (publish === 'order.cancelled')
		entries.push({
			key: `order.cancelled:${order.id}`,
			kind: 'event',
			type: 'order.cancelled@1',
			data: {
				orderId: order.id,
				...eventContext(order),
				...(reason ? { reason: `${to}:${reason}`.slice(0, 500) } : { reason: to }),
			},
		});
	if (publish === 'order.completed')
		entries.push({
			key: `order.completed:${order.id}`,
			kind: 'event',
			type: 'order.completed@1',
			data: { orderId: order.id, ...eventContext(order) },
		});
	entries.push({ key: `notify:${order.id}:${to}:${seq}`, kind: 'notify', status: to, reason });
	return entries;
};

/** Entries younger than this belong to a request that is still delivering them. */
export const OUTBOX_GRACE_MS = 60_000;

/**
 * @param {import('./context.js').Deps} deps
 * @param {import('./notify.js').Notifier} notifier
 */
export const createOutbox = (deps, notifier) => {
	/**
	 * Deliver an order's pending entries and pull the delivered ones.
	 * @param {import('./context.js').Site} site
	 * @param {Record<string, any>} order
	 * @returns {Promise<number>} entries delivered
	 */
	const flush = async (site, order) => {
		const pending = /** @type {PendingEntry[]} */ (order.pending ?? []);
		if (pending.length === 0) return 0;
		/** @type {string[]} */
		const done = [];
		for (const entry of pending) {
			try {
				if (entry.kind === 'event')
					await deps.publish({ websiteId: site.websiteId, type: entry.type, data: entry.data, idempotencyKey: entry.key });
				else await notifier.deliver(site, order, entry);
				done.push(entry.key);
			} catch (error) {
				deps.log?.warn?.('order outbox entry failed', {
					websiteId: site.websiteId,
					orderId: order.id,
					entry: entry.key,
					error: /** @type {Error} */ (error)?.message,
				});
			}
		}
		if (done.length > 0) await site.repos.orders.pull(order.id, done);
		return done.length;
	};

	/**
	 * Is the order carrying entries a crashed request left behind?
	 * @param {Record<string, any>} order
	 */
	const leftBehind = (order) => Boolean(order.pendingAt) && new Date(order.pendingAt).getTime() <= deps.now() - OUTBOX_GRACE_MS;

	/**
	 * Redeliver one order's left-behind entries when it is read (no timer). Returns entries delivered.
	 * @param {import('./context.js').Site} site
	 * @param {Record<string, any>} order
	 */
	const redeliver = async (site, order) => (leftBehind(order) ? flush(site, order) : 0);

	/**
	 * Redeliver the website's left-behind entries, bounded (the dashboard's "Process due now").
	 * @param {import('./context.js').Site} site
	 * @param {number} limit
	 */
	const retry = async (site, limit) => {
		let delivered = 0;
		for (const order of await site.repos.orders.pendingOutbox(new Date(deps.now() - OUTBOX_GRACE_MS), limit))
			delivered += await flush(site, order);
		return delivered;
	};

	return Object.freeze({ flush, redeliver, retry });
};

/** @typedef {ReturnType<typeof createOutbox>} Outbox */
