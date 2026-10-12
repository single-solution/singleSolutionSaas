/**
 * Messages, events and staff alerts (PLAN 0.8.10 E32), driven by the shop's in-process hooks so every part that
 * places, moves, pays or refunds an order, takes a claim or changes the catalog is covered once:
 *
 * - the shopper's messages (`server/order-messages.js`): placed, and each status listed in `notifyStatuses` (one
 *   template, or one per status with `statusTemplates: per_status`); an order its window cancels says so (`expired`);
 * - events (feature `events`, the kit's K5): `order.placed`, `order.status_changed`, `order.paid`,
 *   `order.payment_recorded`, `order.proof_uploaded`, `order.cancelled`, `order.refunded`, `return.requested`,
 *   `return.status_changed`, `review.submitted`, `catalog.changed` and `stock.low` — ids and small facts only, listed by
 *   `GET /v1/events` and sent to the merchant's webhooks through Notifications;
 * - staff alerts (feature `staff_alerts`, the kit's K6): the events the setting `events` lists, as
 *   `ecommerce.staff_<event>` templates to its recipients.
 *
 * A failing message, event or alert never fails what triggered it (hooks never throw).
 * @module
 */
import { defineRoute } from '@ss/app-kit';
import { statusOf } from '../core/flow.js';
import { statusLabel } from '../core/orders.js';
import { createOrderMessages } from './order-messages.js';
import { SERVER_LIMITS } from './service.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('../core/model.js').OrderRecord} OrderRecord */

const serverLimits = [...SERVER_LIMITS];

/**
 * The small facts of an order an event carries (never addresses or contact details).
 * @param {OrderRecord} order
 */
const orderFacts = (order) => ({
	orderId: order.id,
	number: order.number,
	status: order.status,
	total: order.totals.total,
	currency: order.totals.currency,
	paymentMethod: order.payment.method,
	deliveryMethod: order.delivery.method,
});

/**
 * @param {Product} product
 * @param {Service} service
 * @returns {import('./routes.js').Area}
 */
export const createOrderEvents = (product, service) => {
	const messages = createOrderMessages(service);

	/** @param {Site} s */
	const flowOf = async (s) =>
		/** @type {import('../core/model.js').OrderFlow} */ (/** @type {unknown} */ (await s.list('order_flow')));

	/**
	 * Record an event while Events is on.
	 * @param {Site} s @param {string} type @param {Record<string, unknown>} data
	 */
	const publish = async (s, type, data) => {
		if (!s.has('events')) return;
		await product.events.emit({ websiteId: s.websiteId, merchantId: s.merchantId, after: s.ctx.after }, type, data);
	};

	/**
	 * Alert the staff of an event the `staff_alerts` setting lists.
	 * @param {Site} s @param {string} event `placed`, `status`, `paid`, `proof_uploaded`, `cancelled`, `expired` or
	 *   `return_requested` @param {OrderRecord} order
	 * @param {Record<string, string | number>} [extra]
	 */
	const alert = async (s, event, order, extra = {}) => {
		if (!s.has('staff_alerts')) return;
		const { events } = await s.values('staff_alerts');
		if (!Array.isArray(events) || !events.includes(event)) return;
		const { money } = await s.format();
		await product.staffAlerts.send(s.ctx, {
			feature: 'staff_alerts',
			event,
			values: {
				id: order.id,
				number: order.number,
				name: order.customer.name.slice(0, 200),
				total: money(order.totals.total, order.totals.currency),
				status: statusLabel(await flowOf(s), order.status),
				paymentMethod: order.payment.method,
				business: String((await s.business()).name ?? ''),
				...extra,
			},
		});
	};

	service.on('order.placed', async (s, { order, statusLabel: label }) => {
		await messages.placed(s, order, label ?? statusLabel(await flowOf(s), order.status));
		await publish(s, 'order.placed', orderFacts(order));
		await alert(s, 'placed', order);
	});

	service.on('order.moved', async (s, { order, from, to, by, reason }) => {
		const flow = await flowOf(s);
		const role = statusOf(flow, to)?.role;
		// a cancel says why: staff, the shopper, or the end of its window
		const cancelReason =
			role === 'cancelled' ? (reason === 'expired' ? 'expired' : reason === 'shopper' ? 'shopper' : 'staff') : '';
		await messages.status(s, order, statusLabel(flow, to), { cancelReason });
		await publish(s, 'order.status_changed', {
			...orderFacts(order),
			from,
			to,
			reason: reason ?? null,
			by: typeof by === 'object' && by !== null ? String(/** @type {any} */ (by).name ?? '') : String(by ?? ''),
		});
		if (role === 'cancelled') await publish(s, 'order.cancelled', { ...orderFacts(order), reason: cancelReason });
		if (role === 'cancelled')
			await alert(s, cancelReason === 'expired' ? 'expired' : 'cancelled', order, { reason: cancelReason });
		else await alert(s, 'status', order, { from: statusLabel(flow, from) });
	});

	service.on('order.paid', async (s, { order }) => {
		await publish(s, 'order.paid', { ...orderFacts(order), paid: order.payment.paid });
		await alert(s, 'paid', order);
	});

	service.on('order.payment_recorded', async (s, { order, entry }) => {
		await publish(s, 'order.payment_recorded', {
			...orderFacts(order),
			method: entry.method,
			amount: entry.amount,
			reference: String(entry.reference ?? '').slice(0, 120),
		});
	});

	service.on('order.proof_uploaded', async (s, { order, reference }) => {
		await publish(s, 'order.proof_uploaded', { ...orderFacts(order), reference: String(reference ?? '').slice(0, 120) });
		await alert(s, 'proof_uploaded', order, { reference: String(reference ?? '') });
	});

	service.on('order.refunded', async (s, { order, amount, claimId }) => {
		await publish(s, 'order.refunded', { ...orderFacts(order), amount, claimId: claimId ?? null });
	});

	service.on('return.requested', async (s, { claim, order }) => {
		await publish(s, 'return.requested', {
			claimId: claim.id,
			reference: claim.reference ?? '',
			kind: claim.kind,
			orderId: order.id,
			number: order.number,
		});
		await alert(s, 'return_requested', order, { claimId: claim.id, reference: String(claim.reference ?? '') });
	});

	service.on('return.status_changed', async (s, { claim, from, to }) => {
		await publish(s, 'return.status_changed', { claimId: claim.id, orderId: claim.orderId, from, to });
	});

	service.on('review.submitted', async (s, { review }) => {
		await publish(s, 'review.submitted', {
			reviewId: review.id,
			productId: review.productId,
			rating: review.rating,
			status: review.status,
		});
	});

	// catalog writes, and each write that leaves a variant at or under the catalog's low-stock level
	service.on('products.changed', async (s, { productIds }) => {
		if (!s.has('events') || !Array.isArray(productIds) || productIds.length === 0) return;
		const data = await s.data();
		const { lowStock } = await s.values('catalog');
		const rows = await data
			.collection('products')
			.find(
				{ websiteId: s.websiteId, id: { $in: productIds.slice(0, 200) } },
				{ projection: { _id: 0, id: 1, slug: 1, trackStock: 1, variants: { id: 1, stock: 1, active: 1 } } },
			)
			.toArray();
		for (const row of rows) {
			await publish(s, 'catalog.changed', { kind: 'product', id: row.id, slug: row.slug ?? '' });
			if (!row.trackStock) continue;
			for (const variant of row.variants ?? []) {
				if (!variant.active || variant.stock > Number(lowStock ?? 0)) continue;
				await publish(s, 'stock.low', { productId: row.id, variantId: variant.id, stock: variant.stock });
			}
		}
	});

	return {
		// the shop's events (the kit's, PLAN 0.8.10 K5): `?since=&types=&cursor=&limit=`, newest first, and their counts
		routes: [
			defineRoute({
				method: 'GET',
				path: '/v1/events',
				auth: 'server',
				feature: 'events',
				rateLimit: serverLimits,
				handler: (ctx) => product.events.list(ctx),
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/events/count',
				auth: 'server',
				feature: 'events',
				rateLimit: serverLimits,
				handler: (ctx) => product.events.count(ctx),
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/events/counts',
				auth: 'server',
				feature: 'events',
				rateLimit: serverLimits,
				handler: (ctx) => product.events.counts(ctx),
			}),
		],
	};
};
