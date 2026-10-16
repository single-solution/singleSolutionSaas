/**
 * Messages, events and staff alerts (PLAN 0.8.10 E32), driven by the shop's in-process hooks so every part that
 * places, moves, pays or refunds an order, takes a claim or changes the catalog is covered once:
 *
 * - the shopper's messages (`server/order-messages.js`): placed, and each status of the flow that sends one (its
 *   `notify`; one template, or one per status with `statusTemplates: per_status`); an order its window cancels says so
 *   (`expired`);
 * - events (feature `events`, the kit's K5; `EVENT_TYPES` in `core/events.js`): `order.placed`, `order.status_changed`,
 *   `order.paid`, `order.payment_recorded`, `order.proof_uploaded`, `order.cancelled`, `order.refunded`,
 *   `return.requested`, `return.status_changed`, `review.submitted`, `catalog.changed`, `stock.low` and `stock.out` —
 *   ids and small facts only, listed by `GET /v1/events` and sent to the merchant's webhooks through Notifications;
 *   the stock events follow E44's levels: a variant that counts for stock (`countsForStock`) whose units an order or a
 *   catalog write drops into 1 to the catalog setting `lowStock` (`stock.low`) or to 0 (`stock.out`);
 * - staff alerts (feature `staff_alerts`, the kit's K6 rules, `server/staff-alerts.js`): the events the setting `events`
 *   lists, and a move into a status of the flow whose `staffAlert` is on (`status`, E36), as `ecommerce.staff_<event>`
 *   templates to its recipients, required and saved before they are sent (K-17); with the setting `includePhone`, each
 *   carries the shopper's phone (`phone`).
 *
 * A failing message, event or alert never fails what triggered it (hooks never throw).
 * @module
 */
import { defineRoute } from '@ss/app-kit';
import { productTypes } from '../adapters/catalog-store.js';
import { countsForStock, stockEventOf } from '../core/catalog-query.js';
import { levelOf } from '../core/measure.js';
import { notifiesOf, shopperLabelOf, staffAlertOf, statusOf } from '../core/flow.js';
import { statusLabel } from '../core/orders.js';
import { createOrderMessages, messageWords } from './order-messages.js';
import { SERVER_LIMITS } from './service.js';
import { STAFF_ALERT_PHONE, createStaffAlerts } from './staff-alerts.js';

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
	const staffAlerts = createStaffAlerts(product, service);

	/** @param {Site} s */
	const flowOf = async (s) =>
		/** @type {import('../core/model.js').OrderFlow} */ (/** @type {unknown} */ (await s.list('order_flow')));

	/**
	 * Record an event while Events is on.
	 * @param {Site} s @param {import('../core/events.js').EventType} type @param {Record<string, unknown>} data
	 */
	const publish = async (s, type, data) => {
		if (!s.has('events')) return;
		await product.events.emit({ websiteId: s.websiteId, merchantId: s.merchantId, after: s.ctx.after }, type, data);
	};

	/**
	 * Alert the staff of an event the `staff_alerts` setting lists, or of a move into a status whose staff alert is on
	 * (`status`, E36: the order flow says, not the setting).
	 * @param {Site} s @param {string} event `placed`, `status`, `paid`, `proof_uploaded`, `cancelled`, `expired`,
	 *   `return_requested` or `refund_due` @param {OrderRecord} order
	 * @param {Record<string, string | number>} [extra]
	 */
	const alert = async (s, event, order, extra = {}) => {
		if (!s.has('staff_alerts')) return;
		const { events, includePhone } = await s.values('staff_alerts');
		if (event !== 'status' && (!Array.isArray(events) || !events.includes(event))) return;
		const { money } = await s.format();
		await staffAlerts.send(s, {
			feature: 'staff_alerts',
			event,
			values: {
				id: order.id,
				number: order.number,
				name: order.customer.name.slice(0, 200),
				total: money(order.totals.total, order.totals.currency),
				status: statusLabel(await flowOf(s), order.status),
				paymentMethod: (await messageWords(s)).payment(order.payment.method),
				business: String((await s.business()).name ?? ''),
				...(includePhone === true ? { [STAFF_ALERT_PHONE]: order.customer.phone } : {}),
				...extra,
			},
		});
	};

	service.on('order.placed', async (s, { order, statusLabel: label }) => {
		await messages.placed(s, order, label ?? shopperLabelOf(await flowOf(s), order.status));
		await publish(s, 'order.placed', orderFacts(order));
		await alert(s, 'placed', order);
	});

	service.on('order.moved', async (s, { order, from, to, by, reason, note, shopperNote }) => {
		const flow = await flowOf(s);
		const role = statusOf(flow, to)?.role;
		// a cancel says why: staff, the shopper, or the end of its window (events keep the code; messages and alerts get
		// words, K-10): the shopper reads the note for the shopper, else the website's text for it — the note staff typed
		// stays with staff (owner, 2026-10-14 (3)), whose alert reads it first
		const cancelReason =
			role === 'cancelled' ? (reason === 'expired' ? 'expired' : reason === 'shopper' ? 'shopper' : 'staff') : '';
		/** @type {import('./order-messages.js').CancelCode} */
		const cancelCode =
			cancelReason === 'expired'
				? statusOf(flow, from)?.role === 'awaiting_payment'
					? 'unpaid'
					: 'unconfirmed'
				: /** @type {'staff' | 'shopper'} */ (cancelReason || 'staff');
		const forShopper = typeof shopperNote === 'string' ? shopperNote : '';
		const words = await messageWords(s);
		const cancelWords = role === 'cancelled' ? words.cancel(cancelCode, forShopper) : '';
		// a cancel's note for the shopper is its reason, said once (shopperNote is then empty)
		await messages.status(s, order, shopperLabelOf(flow, to), {
			cancelReason: cancelWords,
			shopperNote: role === 'cancelled' ? '' : forShopper,
			notify: notifiesOf(flow, to),
		});
		await publish(s, 'order.status_changed', {
			...orderFacts(order),
			from,
			to,
			reason: reason ?? null,
			by: typeof by === 'object' && by !== null ? String(/** @type {any} */ (by).name ?? '') : String(by ?? ''),
		});
		if (role === 'cancelled') await publish(s, 'order.cancelled', { ...orderFacts(order), reason: cancelReason });
		if (role === 'cancelled')
			await alert(s, cancelReason === 'expired' ? 'expired' : 'cancelled', order, {
				reason: words.cancel(cancelCode, (typeof note === 'string' ? note : '') || forShopper),
			});
		else if (staffAlertOf(flow, to)) await alert(s, 'status', order, { from: statusLabel(flow, from) });
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

	// money for a canceled order that arrived at Payments after the cancel: staff refund it
	service.on('order.refund_due', async (s, { order, amount }) => {
		const { money } = await s.format();
		await alert(s, 'refund_due', order, { amount: money(Number(amount), order.totals.currency) });
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

	/** The catalog setting `lowStock` (E44). @param {Site} s */
	const lowStockOf = async (s) => Number((await s.values('catalog')).lowStock);

	/**
	 * The products sold in a unit of their own among some (their stock counts thousandths of their unit, so the
	 * low-stock level is compared in their units).
	 * @param {Site} s @param {import('@ss/app-kit').WebsiteData} data
	 * @param {Array<{ id: string, kind: string, typeKey?: string | null, categoryIds: string[] }>} rows
	 * @returns {Promise<Set<string>>}
	 */
	const measuredIds = async (s, data, rows) => {
		const types = await s.list('item_types');
		if (rows.length === 0 || !types.some((/** @type {any} */ type) => type.elements.measure)) return new Set();
		const typed = await productTypes(data, rows, types);
		return new Set([...typed].filter(([, type]) => type.elements.measure).map(([id]) => id));
	};

	// catalog writes: the product changed, and a variant counting for stock the write left with fewer units may be low
	// or out (its units before come with the write; stock given back has none, and only rises)
	service.on('products.changed', async (s, { productIds, before }) => {
		if (!s.has('events') || !Array.isArray(productIds) || productIds.length === 0) return;
		const data = await s.data();
		const level = await lowStockOf(s);
		const rows = await data
			.collection('products')
			.find(
				{ websiteId: s.websiteId, id: { $in: productIds.slice(0, 200) } },
				{
					projection: {
						_id: 0,
						id: 1,
						slug: 1,
						status: 1,
						trackStock: 1,
						kind: 1,
						typeKey: 1,
						categoryIds: 1,
						variants: { id: 1, stock: 1, active: 1, soldOut: 1 },
					},
				},
			)
			.toArray();
		const measured = await measuredIds(
			s,
			data,
			rows.map((row) => ({
				id: String(row.id),
				kind: String(row.kind),
				typeKey: row.typeKey ?? null,
				categoryIds: (row.categoryIds ?? []).map(String),
			})),
		);
		for (const row of rows) {
			await publish(s, 'catalog.changed', { kind: 'product', id: row.id, slug: row.slug });
			/** @type {Map<string, number> | undefined} */
			const units = before?.get(row.id)?.stock;
			if (!units) continue;
			for (const variant of row.variants) {
				const was = units.get(variant.id);
				const type =
					was === undefined || !countsForStock(row, variant)
						? null
						: stockEventOf(was, variant.stock, levelOf(level, measured.has(String(row.id))));
				if (type) await publish(s, type, { productId: row.id, variantId: variant.id, stock: variant.stock });
			}
		}
	});

	// a category, brand or deal staff wrote: the pages that show it (its own, product pages, listings, shown prices)
	service.on('page.changed', async (s, { kind, id, slug }) => {
		if (s.has('events')) await publish(s, 'catalog.changed', { kind, id, slug });
	});

	// an order took stock (placed, or edited to more units): only offered variants not marked sold out, of active
	// products that track stock, are held, so each counts for stock
	service.on('stock.taken', async (s, { lines }) => {
		if (!s.has('events') || !Array.isArray(lines) || lines.length === 0) return;
		const level = await lowStockOf(s);
		const taken = /** @type {import('../adapters/ledger.js').TakenStock[]} */ (lines);
		const data = await s.data();
		const products = (await s.list('item_types')).some((/** @type {any} */ type) => type.elements.measure)
			? await data
					.collection('products')
					.find(
						{ websiteId: s.websiteId, id: { $in: [...new Set(taken.map((line) => line.productId))] } },
						{ projection: { _id: 0, id: 1, kind: 1, typeKey: 1, categoryIds: 1 } },
					)
					.toArray()
			: [];
		const measured = await measuredIds(
			s,
			data,
			products.map((row) => ({
				id: String(row.id),
				kind: String(row.kind),
				typeKey: row.typeKey ?? null,
				categoryIds: (row.categoryIds ?? []).map(String),
			})),
		);
		for (const line of taken) {
			const type = stockEventOf(line.left + line.quantity, line.left, levelOf(level, measured.has(line.productId)));
			if (type) await publish(s, type, { productId: line.productId, variantId: line.variantId, stock: line.left });
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
