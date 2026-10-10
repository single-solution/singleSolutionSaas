/**
 * Orders for the merchant (PLAN 0.8.8): what the merchant's staff (orders admin widget, ticket) and server (server
 * token) do with orders after placement — the order list and search, one order with its history and the statuses it
 * may move to, moves through the merchant's flow (`server/orders-moves.js`), refunds, the staff note and address edits,
 * the courier's tracking status (read again on view, at most every 30 minutes), invoices and packing slips (also the
 * shopper's own invoice), customers and the blocklist (`server/orders-customers.js`), bulk moves, and the data-rights
 * answers for orders and customer records. Checkout (`server/checkout.js`) places orders and handles waiting ones. The
 * order and customer lists have counts with the same filters (PLAN 0.8.10 K4): orders by `status`, `role` (the role of
 * each status key in the website's order flow), `paymentMethod` and `paymentState`; customers by `blocked`.
 * @module
 */
import { countHandlers, created, defineRoute, paginate, problem } from '@ss/app-kit';
import { createFulfilmentStore } from '../adapters/fulfilment-store.js';
import { invoiceHtml, invoiceTexts, packingSlipHtml } from '../core/invoice.js';
import {
	TRACK_EVERY_MS,
	checkBulkMove,
	checkEdit,
	checkMove,
	checkRefund,
	orderDetail,
	orderFilters,
	orderQuery,
	orderSummary,
	wire,
} from '../core/orders.js';
import { statusOf } from '../core/flow.js';
import { COLLECTIONS } from '../core/model.js';
import { createMedia } from './catalog-media.js';
import { createCustomers } from './orders-customers.js';
import { createMoves } from './orders-moves.js';
import { SERVER_LIMITS, VISITOR_LIMITS } from './service.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('../core/model.js').OrderRecord} OrderRecord */

/** Headers of the printable documents: never cached, no scripts, nothing loaded but images. */
const DOCUMENT_HEADERS = Object.freeze({
	'content-type': 'text/html; charset=utf-8',
	'cache-control': 'no-store',
	'x-content-type-options': 'nosniff',
	'content-security-policy':
		"default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; form-action 'none'",
});

const ORDER_ID = /^ord_[A-Za-z0-9_-]{1,64}$/;
const serverLimits = [...SERVER_LIMITS];
const visitorLimits = [...VISITOR_LIMITS];

/**
 * The website's order flow.
 * @param {Site} s
 * @returns {Promise<import('../core/model.js').OrderFlow>}
 */
const flowOf = async (s) => /** @type {any} */ (await s.list('order_flow'));

/**
 * @param {Product} product
 * @param {Service} service
 * @returns {import('./routes.js').Area}
 */
export const createOrders = (product, service) => {
	const moves = createMoves(product, service);
	const customers = createCustomers(service);
	const media = createMedia(product);

	/** @param {Site} s */
	const storeOf = async (s) => createFulfilmentStore(await s.data());

	/**
	 * The order of a request's `:id`, or 404.
	 * @param {Site} s @param {any} ctx
	 * @returns {Promise<OrderRecord>}
	 */
	const orderOf = async (s, ctx) => {
		const id = String(ctx.params.id);
		const order = ORDER_ID.test(id) ? await (await storeOf(s)).orders.get(id) : null;
		if (!order) throw problem('not_found', 'There is no such order.');
		return order;
	};

	/**
	 * Ask the courier API for the latest status of a booked parcel, at most every 30 minutes (on read). The order's
	 * `updatedAt` stays as it was, so a move staff are making meanwhile is not refused.
	 * @param {Site} s @param {OrderRecord} order
	 * @returns {Promise<OrderRecord>}
	 */
	const refreshTracking = async (s, order) => {
		const { shipment } = order;
		if (!s.has('courier_apis') || order.role !== 'shipped' || !shipment?.booked) return order;
		const now = product.now();
		if (shipment.checkedAt && now - new Date(shipment.checkedAt).getTime() < TRACK_EVERY_MS) return order;
		const value = await product.connections.value(s.websiteId, 'courier');
		if (!value) return order;
		const tracked = await product.couriers.track({ trackingNumber: shipment.trackingNumber, value });
		const next = { ...shipment, status: tracked.ok ? tracked.status : shipment.status, checkedAt: new Date(now) };
		await (
			await s.data()
		)
			.collection(COLLECTIONS.orders)
			.updateOne(
				{ websiteId: s.websiteId, id: order.id },
				{ $set: { 'shipment.status': next.status, 'shipment.checkedAt': next.checkedAt, updatedAt: order.updatedAt } },
			);
		return { ...order, shipment: next };
	};

	/**
	 * The staff view of an order.
	 * @param {Site} s @param {OrderRecord} order
	 */
	const detailOf = async (s, order) => {
		const [flow, customer, { money }] = await Promise.all([
			flowOf(s),
			order.customer.userId ? (await storeOf(s)).customers.get(order.customer.userId) : null,
			s.format(),
		]);
		/** @type {Map<string, string | null>} */
		const images = new Map();
		for (const line of order.lines) images.set(line.id, await media.mediaUrl(s, line.image));
		return orderDetail(order, flow, { customer, images, money });
	};

	// ------------------------------------------------------------------------------------------------- handlers

	/**
	 * The order list's website and filter (without `websiteId` and the page); the list and its counts share it. Bad
	 * filters are refused before anything is read.
	 * @param {any} ctx
	 */
	const orderSource = async (ctx) => {
		const filters = orderFilters(ctx.query);
		if (!filters.ok) throw service.invalid(filters.field, filters.message);
		return { s: await service.site(ctx), filter: orderQuery(filters.value) };
	};

	/** The order flow a count read, per request (to group status keys by their role). @type {WeakMap<object, import('../core/model.js').OrderFlow>} */
	const countedFlows = new WeakMap();
	const orderCounts = countHandlers({
		source: async (ctx) => {
			const { s, filter } = await orderSource(ctx);
			countedFlows.set(ctx, await flowOf(s));
			return { collection: (await s.data()).collection(COLLECTIONS.orders), filter: { websiteId: s.websiteId, ...filter } };
		},
		by: {
			status: 'status',
			role: {
				path: 'status',
				map: (key, ctx) => {
					const flow = countedFlows.get(ctx);
					return (flow && statusOf(flow, String(key))?.role) ?? null;
				},
			},
			paymentMethod: 'payment.method',
			paymentState: 'payment.state',
		},
	});

	/** @param {any} ctx */
	const listOrders = async (ctx) => {
		const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 25 });
		const { s, filter } = await orderSource(ctx);
		const [flow, rows, { money }] = await Promise.all([
			flowOf(s),
			(await storeOf(s)).orders.list({ filter, after: page.after, limit: page.fetchLimit }),
			s.format(),
		]);
		return page.respond(
			rows.map((order) => orderSummary(order, flow, money)),
			(view) => [view.createdAt, view.id],
		);
	};

	/** @param {any} ctx */
	const readOrder = async (ctx) => {
		const s = await service.site(ctx);
		return detailOf(s, await refreshTracking(s, await orderOf(s, ctx)));
	};

	/** @param {any} ctx */
	const moveOrder = async (ctx) => {
		const input = checkMove(ctx.body);
		if (!input.ok) throw service.invalid(input.field, input.message);
		const s = await service.site(ctx);
		const order = await orderOf(s, ctx);
		const moved = await moves.move(s, ctx, order, input.value, await flowOf(s));
		return { ...(await detailOf(s, moved.order)), warnings: moved.warnings };
	};

	/** @param {any} ctx */
	const refundOrder = async (ctx) => {
		const s = await service.site(ctx);
		const order = await orderOf(s, ctx);
		const input = checkRefund(ctx.body, order);
		if (!input.ok) throw service.invalid(input.field, input.message);
		const done = await moves.refund(s, ctx, order, input.value);
		return created({ order: await detailOf(s, done.order), refund: done.refund });
	};

	/** @param {any} ctx */
	const editOrder = async (ctx) => {
		const s = await service.site(ctx);
		const order = await orderOf(s, ctx);
		const input = checkEdit(ctx.body, order);
		if (!input.ok) throw service.invalid(input.field, input.message);
		const orders = (await s.data()).collection(COLLECTIONS.orders);
		const result = await orders.updateOne(
			{ websiteId: s.websiteId, id: order.id, updatedAt: order.updatedAt },
			{ $set: input.value },
		);
		if (result.modifiedCount !== 1) throw problem('conflict', 'The order changed meanwhile; reload it and try again.');
		await service.log(ctx, input.value.address ? 'order.address_changed' : 'order.noted', order.id, {
			label: order.number,
			detail: [
				...(input.value.address ? ['Delivery address changed'] : []),
				...(input.value.staffNote === undefined ? [] : ['Staff note changed']),
			].join(', '),
		});
		return detailOf(s, /** @type {OrderRecord} */ (await (await storeOf(s)).orders.get(order.id)));
	};

	/**
	 * A printable document of an order.
	 * @param {Site} s @param {OrderRecord} order @param {'invoice' | 'packing_slip'} kind
	 */
	const document = async (s, order, kind) => {
		const [business, settings, { format, timeZone }] = await Promise.all([s.business(), s.values('invoices'), s.format()]);
		const context = {
			business: /** @type {import('../core/invoice.js').BusinessLike} */ (business),
			texts: invoiceTexts(settings),
			format,
			timeZone,
		};
		const html = kind === 'invoice' ? invoiceHtml(order, context) : packingSlipHtml(order, context);
		return new Response(html, { headers: DOCUMENT_HEADERS });
	};

	/** @param {any} ctx */
	const invoice = async (ctx) => {
		const s = await service.site(ctx);
		return document(s, await orderOf(s, ctx), 'invoice');
	};

	/** @param {any} ctx */
	const packingSlip = async (ctx) => {
		const s = await service.site(ctx);
		return document(s, await orderOf(s, ctx), 'packing_slip');
	};

	/** @param {any} ctx */
	const shopInvoice = async (ctx) => {
		const s = await service.site(ctx);
		const shopper = await service.requireShopper(s);
		const id = String(ctx.params.id);
		const order = ORDER_ID.test(id) ? await (await storeOf(s)).orders.get(id) : null;
		if (!order || !order.customer.userId || order.customer.userId !== shopper.id)
			throw problem('not_found', 'There is no such order.');
		return document(s, order, 'invoice');
	};

	/** @param {any} ctx */
	const bulkMove = async (ctx) => {
		const input = checkBulkMove(ctx.body);
		if (!input.ok) throw service.invalid(input.field, input.message);
		const s = await service.site(ctx);
		const flow = await flowOf(s);
		const found = new Map((await (await storeOf(s)).orders.many(input.value.ids)).map((order) => [order.id, order]));
		/** @type {Array<{ id: string, ok: true, number: string, status: string, warnings: string[] } | { id: string, ok: false, code: string, detail: string }>} */
		const results = [];
		for (const id of input.value.ids) {
			const order = found.get(id);
			if (!order) {
				results.push({ id, ok: false, code: 'not_found', detail: 'There is no such order.' });
				continue;
			}
			try {
				const moved = await moves.move(
					s,
					ctx,
					order,
					{ to: input.value.to, note: input.value.note, serials: {}, shipment: null, updatedAt: null },
					flow,
				);
				results.push({ id, ok: true, number: order.number, status: moved.order.status, warnings: moved.warnings });
			} catch (error) {
				const failed = /** @type {any} */ (error);
				if (typeof failed?.code !== 'string' || !('headers' in failed)) throw error;
				const detail = failed.errors?.[0]?.message ?? failed.detail ?? '';
				results.push({ id, ok: false, code: failed.code, detail: String(detail) });
			}
		}
		const movedCount = results.filter((result) => result.ok).length;
		await service.log(ctx, 'orders.bulk_moved', `${movedCount} orders`, {
			label: `${movedCount} orders`,
			detail: `To ${statusOf(flow, input.value.to)?.label ?? input.value.to}${
				movedCount < results.length ? `; ${results.length - movedCount} not moved` : ''
			}`,
		});
		return { moved: movedCount, results };
	};

	// ------------------------------------------------------------------------------------------------ data rights

	/**
	 * @param {Site} s @param {import('./routes.js').Person} user
	 */
	const exportUser = async (s, user) => {
		const store = await storeOf(s);
		const [orders, records] = await Promise.all([store.orders.ofPerson(user), store.customers.ofPerson(user)]);
		/** @param {object} record @param {string[]} keys staff-only fields */
		const without = (record, keys) => Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
		return {
			orders: orders.map((order) => wire(without(order, ['staffNote', 'idempotencyKey']))),
			customers: records.map((record) => wire(without(record, ['note']))),
		};
	};

	/**
	 * @param {Site} s @param {import('./routes.js').Person} user
	 */
	const deleteUser = async (s, user) => {
		const store = await storeOf(s);
		const anonymised = await store.orders.anonymise(user);
		const deleted = await store.customers.remove(user);
		return { deleted, anonymised };
	};

	return {
		exportUser,
		deleteUser,
		routes: [
			// orders: the merchant's server and the orders admin widget
			defineRoute({
				method: 'GET',
				path: '/v1/orders',
				auth: 'server',
				feature: 'checkout',
				rateLimit: serverLimits,
				handler: listOrders,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/admin/orders',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'orders.read',
				rateLimit: serverLimits,
				handler: listOrders,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/orders/count',
				auth: 'server',
				feature: 'checkout',
				rateLimit: serverLimits,
				handler: orderCounts.count,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/orders/counts',
				auth: 'server',
				feature: 'checkout',
				rateLimit: serverLimits,
				handler: orderCounts.counts,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/admin/orders/count',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'orders.read',
				rateLimit: serverLimits,
				handler: orderCounts.count,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/admin/orders/counts',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'orders.read',
				rateLimit: serverLimits,
				handler: orderCounts.counts,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/orders/:id',
				auth: 'server',
				feature: 'checkout',
				rateLimit: serverLimits,
				handler: readOrder,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/admin/orders/:id',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'orders.read',
				rateLimit: serverLimits,
				handler: readOrder,
			}),
			defineRoute({
				method: 'PATCH',
				path: '/v1/orders/:id',
				auth: 'server',
				feature: 'checkout',
				rateLimit: serverLimits,
				handler: editOrder,
			}),
			defineRoute({
				method: 'PATCH',
				path: '/v1/admin/orders/:id',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'orders.manage',
				rateLimit: serverLimits,
				handler: editOrder,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/orders/:id/move',
				auth: 'server',
				feature: 'checkout',
				idempotent: true,
				rateLimit: serverLimits,
				handler: moveOrder,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/admin/orders/:id/move',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'orders.manage',
				idempotent: true,
				rateLimit: serverLimits,
				handler: moveOrder,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/orders/:id/refunds',
				auth: 'server',
				feature: 'checkout',
				idempotent: true,
				rateLimit: serverLimits,
				handler: refundOrder,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/admin/orders/:id/refunds',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'orders.refund',
				idempotent: true,
				rateLimit: serverLimits,
				handler: refundOrder,
			}),

			// invoices and packing slips
			defineRoute({
				method: 'GET',
				path: '/v1/orders/:id/invoice',
				auth: 'server',
				feature: 'invoices',
				rateLimit: serverLimits,
				handler: invoice,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/admin/orders/:id/invoice',
				auth: 'ticket',
				feature: 'invoices',
				permission: 'orders.read',
				rateLimit: serverLimits,
				handler: invoice,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/orders/:id/packing-slip',
				auth: 'server',
				feature: 'invoices',
				rateLimit: serverLimits,
				handler: packingSlip,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/admin/orders/:id/packing-slip',
				auth: 'ticket',
				feature: 'invoices',
				permission: 'orders.read',
				rateLimit: serverLimits,
				handler: packingSlip,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/shop/orders/:id/invoice',
				auth: 'browser',
				feature: 'invoices',
				rateLimit: visitorLimits,
				handler: shopInvoice,
			}),

			// bulk moves
			defineRoute({
				method: 'POST',
				path: '/v1/orders/bulk-move',
				auth: 'server',
				feature: 'bulk_actions',
				idempotent: true,
				rateLimit: serverLimits,
				handler: bulkMove,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/admin/orders/bulk-move',
				auth: 'ticket',
				feature: 'bulk_actions',
				permission: 'bulk.run',
				idempotent: true,
				rateLimit: serverLimits,
				handler: bulkMove,
			}),

			// customers and the blocklist
			defineRoute({
				method: 'GET',
				path: '/v1/customers',
				auth: 'server',
				feature: 'checkout',
				rateLimit: serverLimits,
				handler: customers.list,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/admin/customers',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'customers.manage',
				rateLimit: serverLimits,
				handler: customers.list,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/customers/count',
				auth: 'server',
				feature: 'checkout',
				rateLimit: serverLimits,
				handler: customers.count,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/customers/counts',
				auth: 'server',
				feature: 'checkout',
				rateLimit: serverLimits,
				handler: customers.counts,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/admin/customers/count',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'customers.manage',
				rateLimit: serverLimits,
				handler: customers.count,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/admin/customers/counts',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'customers.manage',
				rateLimit: serverLimits,
				handler: customers.counts,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/customers/:userId',
				auth: 'server',
				feature: 'checkout',
				rateLimit: serverLimits,
				handler: customers.read,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/admin/customers/:userId',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'customers.manage',
				rateLimit: serverLimits,
				handler: customers.read,
			}),
			defineRoute({
				method: 'PATCH',
				path: '/v1/customers/:userId',
				auth: 'server',
				feature: 'checkout',
				rateLimit: serverLimits,
				handler: customers.edit,
			}),
			defineRoute({
				method: 'PATCH',
				path: '/v1/admin/customers/:userId',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'customers.manage',
				rateLimit: serverLimits,
				handler: customers.edit,
			}),
		],
	};
};
