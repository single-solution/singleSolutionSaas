/**
 * Orders for the merchant (PLAN 0.8.8): what the merchant's staff (orders admin widget, ticket) and server (server
 * token) do with orders after placement — the order list and search, one order with its history and the statuses it
 * may move to, moves through the merchant's flow (`server/orders-moves.js`), refunds, the staff note and address edits,
 * the courier's tracking status (read again on view, at most every 30 minutes), invoices and packing slips (also the
 * shopper's own invoice), customers and the blocklist (`server/orders-customers.js`), bulk moves, and the data-rights
 * answers for orders and customer records (an export holds what the shopper sees, never what staff keep, SE-1). Checkout (`server/checkout.js`) places orders and handles waiting ones. The
 * order and customer lists have counts with the same filters (PLAN 0.8.10 K4): orders by `status`, `role` (the role of
 * each status key in the website's order flow), `paymentMethod` and `paymentState`; customers by `blocked`.
 * @module
 */
import { countHandlers, created, defineRoute, paginate, problem } from '@ss/app-kit';
import { createFulfilmentStore, markSeenBy } from '../adapters/fulfilment-store.js';
import { setOrderCounter } from '../adapters/ledger.js';
import { createOutbox } from '../adapters/outbox.js';
import { courierNamed, trackingLink } from '../core/couriers.js';
import { invoiceHtml, invoiceTexts, packingSlipHtml } from '../core/invoice.js';
import {
	TRACK_EVERY_MS,
	checkBulkMove,
	checkEdit,
	checkMove,
	checkPayment,
	checkRefund,
	customerOwnView,
	orderDetail,
	orderFilters,
	orderQuery,
	orderSummary,
} from '../core/orders.js';
import { WAITING_ROLES, statusOf } from '../core/flow.js';
import { COLLECTIONS } from '../core/model.js';
import { createMedia } from './catalog-media.js';
import { createCustomers } from './orders-customers.js';
import { createMoves } from './orders-moves.js';
import { openAtPayments } from './order-payments.js';
import { SERVER_LIMITS, VISITOR_LIMITS } from './service.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('../core/model.js').OrderRecord} OrderRecord */

/** Headers of the printable documents: never cached, no scripts, nothing loaded but images. */
export const DOCUMENT_HEADERS = Object.freeze({
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
 * @param {{ ordering: Pick<import('./checkout-orders.js').Ordering, 'editWaiting' | 'shopperView'> }} parts checkout's
 *   editing of a waiting order (E29) and what the shopper sees of an order
 * @returns {import('./routes.js').Area}
 */
export const createOrders = (product, service, { ordering }) => {
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
			// a guest order's customer by customer id (K-6), an older member order's by user id
			order.customer.customerId || order.customer.userId
				? (await storeOf(s)).customers.find(order.customer.customerId || order.customer.userId)
				: null,
			s.format(),
		]);
		/** @type {Map<string, string | null>} */
		const images = new Map();
		for (const line of order.lines) images.set(line.id, await media.mediaUrl(s, line.image));
		const serialized = s.has('grades_serials') ? await moves.serializedOf(s, order) : null;
		return orderDetail(order, flow, { customer, images, money, serialized });
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
		const seenBy = service.actor(ctx).id;
		return { s: await service.site(ctx), filter: orderQuery(filters.value, { seenBy }) };
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

	/**
	 * One order, with its waiting payment asked again (at most every 30 seconds), money paid after its cancel looked for
	 * (K-13) and its booked parcel's status.
	 * @param {any} ctx
	 */
	const readOrder = async (ctx) => {
		const s = await service.site(ctx);
		const order = (await moves.recheck(s, await orderOf(s, ctx))).order;
		return detailOf(s, await refreshTracking(s, order));
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
		return created({ order: await detailOf(s, done.order), refund: done.refund, warnings: done.warnings });
	};

	/** POST /v1/orders/:id/seen: the acting staff member opened the order (E31; the latest 50 are kept). @param {any} ctx */
	const markSeen = async (ctx) => {
		const s = await service.site(ctx);
		const order = await orderOf(s, ctx);
		await markSeenBy(await s.data(), COLLECTIONS.orders, { id: order.id }, service.actor(ctx).id);
		return { seen: true };
	};

	/**
	 * DELETE /v1/orders/:id (E31): what the order holds is given back as a cancel does (stock, slots, offer uses, points,
	 * serials; its open Payments payment is cancelled, K-13), then it is deleted; the activity entry keeps its number and
	 * total.
	 * @param {any} ctx
	 */
	const deleteOrder = async (ctx) => {
		const s = await service.site(ctx);
		const order = await orderOf(s, ctx);
		const data = await s.data();
		const orders = data.collection(COLLECTIONS.orders);
		await moves.giveBack(s, order, { payments: true });
		await orders.deleteOne({ websiteId: s.websiteId, id: order.id });
		const { money } = await s.format();
		await service.log(ctx, 'order.deleted', order.id, {
			label: order.number,
			detail: `Total ${money(order.totals.total, order.totals.currency)}`,
		});
		return undefined;
	};

	/**
	 * Cancel at Payments every open payment of the website's orders before they all go (K-13, CK-21), so none can be paid
	 * once its order is gone. Refused, with nothing deleted, while Payments cannot be reached for one of them (a cancel
	 * is idempotent, so the next try cancels the rest).
	 * @param {Site} s
	 */
	const cancelOpenPayments = async (s) => {
		const open = /** @type {OrderRecord[]} */ (
			await (
				await s.data()
			)
				.collection(COLLECTIONS.orders)
				.find(
					{ websiteId: s.websiteId, 'payment.paymentId': { $nin: [null, ''] }, 'payment.voidedAt': null },
					{ projection: { _id: 0 } },
				)
				.toArray()
		).filter(openAtPayments);
		let unreachable = 0;
		for (const order of open) {
			const answer = await service.payments.cancel(s, /** @type {string} */ (order.payment.paymentId), 'Order deleted');
			if (answer.outcome === 'unreachable') unreachable += 1;
		}
		if (unreachable > 0)
			throw problem(
				'payments_unavailable',
				`Payments cannot be reached to cancel the payments of ${unreachable} orders, so no order was deleted. Try again.`,
			);
	};

	/**
	 * POST /v1/data/delete-all `{ scope, confirm }` (server token, E31): every record of a scope goes, after held stock
	 * is given back (and, for orders, their open Payments payments are cancelled); `confirm` repeats the website's
	 * domain.
	 * @param {any} ctx
	 */
	const deleteAll = async (ctx) => {
		const body = typeof ctx.body === 'object' && ctx.body !== null ? ctx.body : {};
		const scope = body.scope;
		if (scope !== 'catalog' && scope !== 'orders' && scope !== 'customers')
			throw service.invalid('scope', 'scope is catalog, orders or customers.');
		const s = await service.site(ctx);
		if (body.confirm !== s.domain) throw service.invalid('confirm', `Type the website's domain (${s.domain}) to confirm.`);
		const data = await s.data();
		/** @type {Record<string, number>} */
		const deleted = {};
		/** @param {string} name */
		const wipe = async (name) => {
			deleted[name] = (await data.collection(name).deleteMany({ websiteId: s.websiteId })).deletedCount ?? 0;
		};
		if (scope === 'orders') {
			await cancelOpenPayments(s);
			const held = await data
				.collection(COLLECTIONS.orders)
				.find({ websiteId: s.websiteId, stockHeld: true }, { projection: { _id: 0 } })
				.toArray();
			for (const order of held) await moves.giveBack(s, /** @type {OrderRecord} */ (/** @type {unknown} */ (order)));
			for (const name of [COLLECTIONS.orders, COLLECTIONS.slots, COLLECTIONS.couponUses, COLLECTIONS.returns])
				await wipe(name);
		} else if (scope === 'customers') {
			for (const name of [COLLECTIONS.customers, COLLECTIONS.loyalty]) await wipe(name);
		} else {
			for (const name of [
				COLLECTIONS.products,
				COLLECTIONS.categories,
				COLLECTIONS.brands,
				COLLECTIONS.attributes,
				COLLECTIONS.serials,
				COLLECTIONS.sizeCharts,
				COLLECTIONS.landings,
			])
				await wipe(name);
		}
		await service.log(ctx, 'data.deleted_all', scope, {
			label: scope,
			detail: Object.entries(deleted)
				.map(([name, count]) => `${count} ${name}`)
				.join(', '),
		});
		return { scope, deleted };
	};

	/** POST /v1/orders/counter `{ year, next }`: the next order number of a year (E30). @param {any} ctx */
	const setCounter = async (ctx) => {
		const body = typeof ctx.body === 'object' && ctx.body !== null ? ctx.body : {};
		const year = body.year;
		const next = body.next;
		if (!Number.isSafeInteger(year) || year < 2000 || year > 9999) throw service.invalid('year', 'year is a four-digit year.');
		if (!Number.isSafeInteger(next) || next < 1 || next > 99_999_999)
			throw service.invalid('next', 'next is the next order number, from 1.');
		const s = await service.site(ctx);
		const prefix = String((await s.values('checkout')).numberPrefix ?? '');
		const done = await setOrderCounter(await s.data(), { prefix, year, next });
		if (!done.ok) throw service.invalid('next', `Order number ${done.used} of ${year} is already used; give a higher one.`);
		await service.log(ctx, 'orders.counter_set', `${prefix}${year}`, { label: `${prefix}${year}`, detail: `Next ${next}` });
		return { prefix, year, next: done.next };
	};

	/** POST /v1/orders/:id/payments: a payment staff took (E26). @param {any} ctx */
	const recordPayment = async (ctx) => {
		const s = await service.site(ctx);
		const order = await orderOf(s, ctx);
		const input = checkPayment(ctx.body, order);
		if (!input.ok) throw service.invalid(input.field, input.message);
		const done = await moves.recordPayment(s, ctx, order, input.value, await flowOf(s));
		return created({ order: await detailOf(s, done.order), warnings: done.warnings });
	};

	/** @param {any} ctx */
	const editOrder = async (ctx) => {
		const s = await service.site(ctx);
		let order = await orderOf(s, ctx);
		const input = checkEdit(ctx.body, order);
		if (!input.ok) throw service.invalid(input.field, input.message);
		// serial numbers typed at packing or later (E11)
		const { serials, shipment, waiting, ...rest } = input.value;
		// lines, payment and delivery of a waiting order are priced again by checkout (E29)
		if (waiting) {
			order = await ordering.editWaiting(s, ctx, order, { ...waiting, ...(rest.address ? { address: rest.address } : {}) });
			delete rest.address;
			if (rest.staffNote === undefined && !shipment && !serials) return detailOf(s, order);
		}
		if (serials) {
			order = await moves.typeSerials(s, ctx, order, serials);
			if (rest.staffNote === undefined && rest.address === undefined && !shipment) return detailOf(s, order);
		}
		/** @type {Record<string, unknown>} */
		const set = { ...rest };
		// the shipment's details may change at any time; the courier is kept by name (E28)
		if (shipment) {
			const couriers = await s.list('couriers');
			const courier = shipment.courier ? courierNamed(couriers, shipment.courier) : null;
			if (shipment.courier && !courier) throw service.invalid('shipment/courier', 'There is no such courier.');
			set.shipment = {
				booked: false,
				status: '',
				checkedAt: null,
				...(order.shipment ?? {}),
				courier: courier?.name ?? '',
				trackingNumber: shipment.trackingNumber,
				trackingUrl: courier && shipment.trackingNumber ? trackingLink(courier.trackingUrl, shipment.trackingNumber) : '',
				trackingNote: shipment.trackingNote,
				estimatedDeliveryAt: shipment.estimatedDeliveryAt,
			};
		}
		const orders = (await s.data()).collection(COLLECTIONS.orders);
		const result = await orders.updateOne({ websiteId: s.websiteId, id: order.id, updatedAt: order.updatedAt }, { $set: set });
		if (result.modifiedCount !== 1) throw problem('conflict', 'The order changed meanwhile; reload it and try again.');
		await service.log(
			ctx,
			rest.address ? 'order.address_changed' : shipment ? 'order.shipment_changed' : 'order.noted',
			order.id,
			{
				label: order.number,
				detail: [
					...(rest.address ? ['Delivery address changed'] : []),
					...(shipment ? ['Shipment changed'] : []),
					...(rest.staffNote === undefined ? [] : ['Staff note changed']),
				].join(', '),
			},
		);
		return detailOf(s, /** @type {OrderRecord} */ (await (await storeOf(s)).orders.get(order.id)));
	};

	/**
	 * A printable document of an order.
	 * @param {Site} s @param {OrderRecord} order @param {'invoice' | 'packing_slip'} kind
	 * @param {import('../core/invoice.js').InvoiceOptions} [options] the shopper's copy has no staff names (E35)
	 */
	const document = async (s, order, kind, options) => {
		const [business, settings, { format, timeZone }] = await Promise.all([s.business(), s.values('invoices'), s.format()]);
		const context = {
			business: /** @type {import('../core/invoice.js').BusinessLike} */ (business),
			texts: invoiceTexts(settings),
			format,
			timeZone,
		};
		const html = kind === 'invoice' ? invoiceHtml(order, context, options) : packingSlipHtml(order, context);
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
		// with `shopperFrom` confirmed, the invoice comes once the order is confirmed: not while it waits, nor once
		// cancelled (E35)
		const { shopperFrom } = await s.values('invoices');
		if (shopperFrom === 'confirmed' && (WAITING_ROLES.includes(order.role) || order.role === 'cancelled'))
			throw problem('not_found', 'This order has no invoice yet.');
		return document(s, order, 'invoice', { shopper: true });
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
				const item = input.value.items.get(id);
				const moved = await moves.move(
					s,
					ctx,
					order,
					{
						to: input.value.to,
						note: input.value.note,
						serials: item?.serials ?? {},
						shipment: item?.shipment ?? null,
						updatedAt: null,
						...(item?.video ? { video: item.video } : {}),
					},
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
		const flow = await flowOf(s);
		// what the shopper sees of their orders (GET /v1/shop/orders/:id) and of their record: never unit costs, staff
		// notes or names, who opened them, or a block and its reason (SE-1)
		return {
			orders: await Promise.all(orders.map((order) => ordering.shopperView(s, order, flow))),
			customers: records.map(customerOwnView),
		};
	};

	/**
	 * @param {Site} s @param {import('./routes.js').Person} user
	 */
	const deleteUser = async (s, user) => {
		const store = await storeOf(s);
		// the messages still waiting in the outbox to the person or about their orders go first (E63)
		const [orders, records] = await Promise.all([store.orders.ofPerson(user), store.customers.ofPerson(user)]);
		const people = [...orders.map((order) => order.customer), ...records, user];
		/** @param {Array<string | undefined>} values */
		const known = (values) => [
			...new Set(values.filter(/** @returns {value is string} */ (value) => typeof value === 'string' && value !== '')),
		];
		const forgotten = await createOutbox(await s.data()).forget({
			emails: known(people.flatMap((person) => [person.email, person.email?.trim().toLowerCase()])),
			phones: known(people.map((person) => person.phone)),
			numbers: known(orders.map((order) => order.number)),
		});
		const anonymised = await store.orders.anonymise(user);
		const deleted = (await store.customers.remove(user)) + forgotten;
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
				path: '/v1/orders/:id/seen',
				auth: 'server',
				feature: 'checkout',
				rateLimit: serverLimits,
				handler: markSeen,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/admin/orders/:id/seen',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'orders.read',
				rateLimit: serverLimits,
				handler: markSeen,
			}),
			defineRoute({
				method: 'DELETE',
				path: '/v1/orders/:id',
				auth: 'server',
				feature: 'checkout',
				rateLimit: serverLimits,
				handler: deleteOrder,
			}),
			defineRoute({
				method: 'DELETE',
				path: '/v1/admin/orders/:id',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'orders.delete',
				rateLimit: serverLimits,
				handler: deleteOrder,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/data/delete-all',
				auth: 'server',
				feature: 'bulk_actions',
				rateLimit: serverLimits,
				handler: deleteAll,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/orders/counter',
				auth: 'server',
				feature: 'checkout',
				rateLimit: serverLimits,
				handler: setCounter,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/orders/:id/payments',
				auth: 'server',
				feature: 'checkout',
				idempotent: true,
				rateLimit: serverLimits,
				handler: recordPayment,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/admin/orders/:id/payments',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'orders.manage',
				idempotent: true,
				rateLimit: serverLimits,
				handler: recordPayment,
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
			defineRoute({
				method: 'POST',
				path: '/v1/customers/:userId/seen',
				auth: 'server',
				feature: 'checkout',
				rateLimit: serverLimits,
				handler: customers.seen,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/admin/customers/:userId/seen',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'customers.manage',
				rateLimit: serverLimits,
				handler: customers.seen,
			}),
		],
	};
};
