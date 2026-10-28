/**
 * Orders for the merchant (PLAN 0.8.8): what the merchant's staff (orders admin widget, ticket) and server (server
 * token) do with orders after placement — the order list and search, one order with its history and the statuses it
 * may move to, moves through the merchant's flow (`server/orders-moves.js`), refunds, the staff note and address edits,
 * the courier's tracking status (read again on view, at most every 30 minutes), invoices and packing slips (also the
 * shopper's own invoice), customers and the blocklist (`server/orders-customers.js`), bulk moves, moving every order of
 * a status to another status of the same kind (restatus, so the flow can drop or re-key it), and the data-rights
 * answers for orders and customer records (an export holds what the shopper sees, never what staff keep, SE-1). Checkout (`server/checkout.js`) places orders and handles waiting ones. The
 * order and customer lists have counts with the same filters (PLAN 0.8.10 K4): orders by `status`, `role` (the role of
 * each status key in the website's order flow), `paymentMethod` and `paymentState`; customers by `blocked`.
 * @module
 */
import { createId } from '@ss/contracts';
import { countHandlers, created, defineRoute, paginate, problem } from '@ss/app-kit';
import { documentFieldsOf, fieldsOn, unitsOfOrders } from '../adapters/catalog-store.js';
import { createFulfillmentStore, markSeenBy } from '../adapters/fulfillment-store.js';
import { setOrderCounter } from '../adapters/ledger.js';
import { createOrdersStore } from '../adapters/orders-store.js';
import { createOutbox } from '../adapters/outbox.js';
import { attachmentsOf } from '../core/attachments.js';
import { checkAddress } from '../core/checkout.js';
import { phoneSearchOf } from '../core/guests.js';
import { courierNamed, trackingLink } from '../core/couriers.js';
import { checkFieldValues } from '../core/fields.js';
import {
	documentWordsOf,
	invoiceColumnsOf,
	invoiceHtml,
	invoiceTexts,
	packingSlipHtml,
	sellerDetailsOf,
	shopperInvoiceReady,
} from '../core/invoice.js';
import {
	TRACK_EVERY_MS,
	byActor,
	checkBulkMove,
	checkEdit,
	checkMove,
	checkPayment,
	checkRefund,
	customerOwnView,
	ORDER_ID,
	orderDetail,
	orderFilters,
	orderMoney,
	orderQuery,
	orderSummary,
	serverNote,
	warningsOf,
} from '../core/orders.js';
import { checkRestatus, statusOf } from '../core/flow.js';
import { COLLECTIONS } from '../core/model.js';
import { counterIdOf, counterNameOf, numberFormOf, periodOf } from '../core/order-numbers.js';
import { createMedia } from './catalog-media.js';
import { addressRulesOf, phoneRulesOf } from './guests.js';
import { createCustomers } from './orders-customers.js';
import { createTagTools } from './tags.js';
import { createMoves } from './orders-moves.js';
import { openAtPayments } from './order-payments.js';
import { SERVER_LIMITS, VISITOR_LIMITS } from './service.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('../core/model.js').OrderRecord} OrderRecord */

/** Headers of the printable documents: never cached, no scripts, nothing loaded but images. */
/**
 * What an order's documents are printed with (E35, E26): the business, the invoices settings' titles and columns and the
 * website's texts for the labels, the
 * website's payment words (its payment methods' names, E16, and its texts' payment states, decision 10), its Format and
 * business time zone, and the merchant fields with the values the
 * orders name.
 * @param {Site} s @param {OrderRecord[]} orders
 * @returns {Promise<import('../core/invoice.js').DocumentContext>}
 */
export const documentContextOf = async (s, orders) => {
	const [business, website, settings, texts, { format, timeZone }, fields, methods] = await Promise.all([
		s.business(),
		s.website(),
		s.values('invoices'),
		s.texts(),
		s.format(),
		s.data().then((data) => documentFieldsOf(data, orders)),
		s.list('payment_methods'),
	]);
	return {
		business: /** @type {import('../core/invoice.js').BusinessLike} */ (business),
		// the seller's legal name and tax number are the website's, set once in the Portal (Business)
		texts: invoiceTexts(settings, texts, sellerDetailsOf(website.business, texts)),
		words: documentWordsOf(texts, /** @type {import('../core/payment-methods.js').PaymentMethodRecord[]} */ (methods)),
		columns: invoiceColumnsOf(settings),
		format,
		timeZone,
		fields,
	};
};

export const DOCUMENT_HEADERS = Object.freeze({
	'content-type': 'text/html; charset=utf-8',
	'cache-control': 'no-store',
	'x-content-type-options': 'nosniff',
	'content-security-policy':
		"default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; form-action 'none'",
});

/** How long the staff link to a transfer proof works (seconds). */
const PROOF_LINK_SECONDS = 300;

/**
 * @param {Product} product
 * @param {Service} service
 * @param {{ ordering: Pick<import('./checkout-orders.js').Ordering, 'editWaiting' | 'shopperView' | 'shopperOrder'> }} parts
 *   checkout's editing of a waiting order (E29), what the shopper sees of an order and which order a shopper may open
 * @returns {import('./routes.js').Area}
 */
export const createOrders = (product, service, { ordering }) => {
	const moves = createMoves(product, service);
	const customers = createCustomers(service);
	const customerTags = createTagTools(service, {
		collection: COLLECTIONS.customers,
		what: 'customers',
		idFilter: (ids) => ({ $or: [{ id: { $in: ids } }, { userId: { $in: ids } }] }),
		stamp: false,
		now: product.now,
	});
	const orderTags = createTagTools(service, {
		collection: COLLECTIONS.orders,
		what: 'orders',
		idFilter: (ids) => ({ id: { $in: ids } }),
		stamp: true,
		now: product.now,
	});
	const media = createMedia(product);

	/** @param {Site} s */
	const storeOf = async (s) => createFulfillmentStore(await s.data());

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
	 * Ask the courier API of the courier it was booked with for the latest status of a booked package, at most every 30
	 * minutes (on read). The order's
	 * `updatedAt` stays as it was, so a move staff are making meanwhile is not refused.
	 * @param {Site} s @param {OrderRecord} order
	 * @returns {Promise<OrderRecord>}
	 */
	const refreshTracking = async (s, order) => {
		const { shipment } = order;
		if (!s.has('courier_apis') || order.role !== 'shipped' || !shipment?.booked) return order;
		const now = product.now();
		if (shipment.checkedAt && now - new Date(shipment.checkedAt).getTime() < TRACK_EVERY_MS) return order;
		// the connection of the courier it was booked with (E25), found by its name or key in today's list
		const courier = courierNamed(await s.list('couriers'), shipment.courier);
		const value = courier?.connection ? await product.connections.value(s.websiteId, courier.connection) : null;
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
	 * The staff view of an order, the transfer proof with a link to open it.
	 * @param {Site} s @param {OrderRecord} order
	 */
	const detailOf = async (s, order) => {
		const [flow, customer, { money }] = await Promise.all([
			s.flow(),
			// the order's customer record (K-6)
			order.customer.customerId ? (await storeOf(s)).customers.find(order.customer.customerId) : null,
			s.format(),
		]);
		/** @type {Map<string, string | null>} */
		const images = new Map();
		for (const line of order.lines) images.set(line.id, await media.mediaUrl(s, line.image));
		// how the lines' units are numbered (their item types), and the units' values (staff see every value)
		const data = await s.data();
		const [rules, unitValues, orderFields, cancel, failure, attachmentKinds] = await Promise.all([
			moves.unitRulesFor(s, order),
			unitsOfOrders(data, [order.id]),
			fieldsOn(data, 'order'),
			s.list('cancel_reasons'),
			s.list('delivery_failure_reasons'),
			s.list('attachment_kinds'),
		]);
		const detail = orderDetail(order, flow, {
			customer,
			images,
			money,
			units: { rules, values: unitValues.get(order.id) ?? new Map() },
			orderFields,
			reasons: { cancel, failure },
			attachmentKinds,
		});
		// each attachment opens at its address: an upload's, or the https address kept (E20)
		detail.attachments = await Promise.all(
			detail.attachments.map(async (attachment) => ({
				...attachment,
				href: attachment.key ? await media.mediaUrl(s, attachment.key) : attachment.url,
			})),
		);
		// the shopper's transfer proof opens with a signed link of 5 minutes (E24)
		const proof = order.payment.proof;
		if (!proof) return detail;
		const storage = await product.connections.storage(s.websiteId);
		const url = storage ? storage.presignGet({ key: proof.key, expiresIn: PROOF_LINK_SECONDS }).url : null;
		return { ...detail, payment: { ...detail.payment, proof: { ...detail.payment.proof, url } } };
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
		const s = await service.site(ctx);
		// a phone typed as shoppers type it (national, with its trunk prefix) is found by its whole number
		if (filters.value.q) filters.value.phoneDigits = phoneSearchOf(filters.value.q, await phoneRulesOf(s));
		return { s, filter: orderQuery(filters.value, { seenBy }) };
	};

	/** The order flow a count read, per request (to group status keys by their role). @type {WeakMap<object, import('../core/model.js').OrderFlow>} */
	const countedFlows = new WeakMap();
	const orderCounts = countHandlers({
		source: async (ctx) => {
			const { s, filter } = await orderSource(ctx);
			countedFlows.set(ctx, await s.flow());
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
			// why orders were canceled or came back (E19)
			reason: 'closeReason',
		},
	});

	/** @param {any} ctx */
	const listOrders = async (ctx) => {
		const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 25 });
		const { s, filter } = await orderSource(ctx);
		const [flow, rows, { money }] = await Promise.all([
			s.flow(),
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
	 * (K-13) and its booked package's status.
	 * @param {any} ctx
	 */
	const readOrder = async (ctx) => {
		const s = await service.site(ctx);
		const rechecked = (await moves.recheck(s, await orderOf(s, ctx))).order;
		// a refund its cancel left pending at Payments is tried again (at most every minute)
		const order = await moves.settle(s, rechecked);
		return detailOf(s, await refreshTracking(s, order));
	};

	/** @param {any} ctx */
	const moveOrder = async (ctx) => {
		const input = checkMove(ctx.body);
		if (!input.ok) throw service.invalid(input.field, input.message);
		const s = await service.site(ctx);
		const order = await orderOf(s, ctx);
		const moved = await moves.move(s, ctx, order, input.value, await s.flow());
		return { ...(await detailOf(s, moved.order)), ...warningsOf(moved.warnings) };
	};

	/**
	 * The keys of the website's payment methods: the ways staff record money by, besides `other` (E16).
	 * @param {Site} s
	 * @returns {Promise<string[]>}
	 */
	const methodKeys = async (s) =>
		/** @type {import('../core/payment-methods.js').PaymentMethodRecord[]} */ (await s.list('payment_methods')).map(
			(method) => method.key,
		);

	/** @param {any} ctx */
	const refundOrder = async (ctx) => {
		const s = await service.site(ctx);
		const order = await orderOf(s, ctx);
		const input = checkRefund(ctx.body, order, await methodKeys(s));
		if (!input.ok) throw service.invalid(input.field, input.message);
		const done = await moves.refund(s, ctx, order, input.value);
		return created({ order: await detailOf(s, done.order), refund: done.refund, ...warningsOf(done.warnings) });
	};

	/** POST /v1/orders/:id/seen: the acting staff member opened the order (E31; the latest 50 are kept). @param {any} ctx */
	const markSeen = async (ctx) => {
		const s = await service.site(ctx);
		const order = await orderOf(s, ctx);
		await markSeenBy(await s.data(), COLLECTIONS.orders, { id: order.id }, service.actor(ctx).id);
		return { seen: true };
	};

	/**
	 * DELETE /v1/orders/:id (E31): its open Payments payment is canceled (K-13), then what the order holds is given back
	 * as a cancel does (stock, slots, offer uses, points, serials) and it is deleted, in one transaction; the activity
	 * entry keeps its number and total.
	 * @param {any} ctx
	 */
	const deleteOrder = async (ctx) => {
		const s = await service.site(ctx);
		const order = await orderOf(s, ctx);
		const { money } = await s.format();
		// the shopper's money is never deleted with it: a refund still running at Payments, or money a not delivered or
		// closed order still holds, is refunded first
		if ((order.effects ?? []).some((effect) => effect.state === 'pending'))
			throw problem(
				'conflict',
				'A refund through Payments is pending for this order; delete it once the refund is done (reload it to try the refund again).',
			);
		// a parcel with the courier comes back first (returned to origin, owner 2026-10-14 Q5): deleted now, its units would
		// be counted in stock while they are out
		if (order.role === 'shipped')
			throw problem('conflict', 'This order is with the courier: mark it delivered or returned to origin before deleting it.');
		const held = order.role === 'delivered' ? 0 : orderMoney(order).net;
		if (held > 0)
			throw problem(
				'conflict',
				`Refund the ${money(held, order.totals.currency)} it still holds to the shopper before deleting this order.`,
			);
		// what it holds goes back once, with the delete; an order that changed meanwhile (also paid or refunded meanwhile)
		// is neither given back nor deleted
		if (!(await moves.remove(s, order))) throw problem('conflict', 'The order changed meanwhile; reload it and try again.');
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
	 * is given back (and, for orders, their open Payments payments are canceled). It needs its own permission
	 * (`data.delete_all`, held by the Owner role alone unless the merchant gives it to another), and `confirm` is the
	 * words `DELETE <scope>` the person types (the website's domain is public, so it confirmed nothing; SR-5b-2).
	 * @param {any} ctx
	 */
	const deleteAll = async (ctx) => {
		const body = typeof ctx.body === 'object' && ctx.body !== null ? ctx.body : {};
		const scope = body.scope;
		if (scope !== 'catalog' && scope !== 'orders' && scope !== 'customers')
			throw service.invalid('scope', 'scope is catalog, orders or customers.');
		const s = await service.site(ctx);
		if (body.confirm !== `DELETE ${scope}`) throw service.invalid('confirm', `Type DELETE ${scope} to confirm.`);
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
				COLLECTIONS.landingIndex,
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

	/**
	 * POST /v1/orders/counter `{ year?, month?, next }`: the next order number (E30, E29) — of the running counter, or of
	 * a year's or month's when the pattern has `{year}` or `{month}` (`checkout.numberPattern`; `year`, and `month` with
	 * `{month}`, are given exactly then).
	 * @param {any} ctx
	 */
	const setCounter = async (ctx) => {
		const body = typeof ctx.body === 'object' && ctx.body !== null ? ctx.body : {};
		const s = await service.site(ctx);
		const form = numberFormOf(await s.values('checkout'));
		const period = periodOf(form);
		const { year, month, next } = body;
		if (period === 'all' && year !== undefined)
			throw service.invalid('year', 'Order numbers have no year (checkout.numberPattern): give only next.');
		if (period !== 'month' && month !== undefined)
			throw service.invalid('month', 'Order numbers have no month (checkout.numberPattern): leave month out.');
		if (period !== 'all' && (!Number.isSafeInteger(year) || year < 2000 || year > 9999))
			throw service.invalid('year', 'year is a four-digit year.');
		if (period === 'month' && (!Number.isSafeInteger(month) || month < 1 || month > 12))
			throw service.invalid('month', 'month is a month from 1 to 12.');
		if (!Number.isSafeInteger(next) || next < 1 || next > 99_999_999)
			throw service.invalid('next', 'next is the next order number, from 1.');
		const at = { year: period === 'all' ? 0 : year, month: period === 'month' ? month : 0 };
		const done = await setOrderCounter(await s.data(), { form, at, next });
		const counter = counterNameOf(form, at);
		if (!done.ok) throw service.invalid('next', `Order number ${done.used} of ${counter} is already used; give a higher one.`);
		await service.log(ctx, 'orders.counter_set', counterIdOf(form, at), { label: counter, detail: `Next ${next}` });
		return {
			prefix: form.prefix,
			year: period === 'all' ? null : year,
			month: period === 'month' ? month : null,
			next: done.next,
		};
	};

	/**
	 * POST /v1/orders/restatus `{ from, to }`: every order of a status moves to another status of the same kind of step
	 * (role), so a status with orders can be removed or re-keyed from the flow afterwards (the flow's save guard). Nothing
	 * is given back or taken (the orders' facts stay) and no message is sent; each order's history gets an entry and the
	 * activity log one line.
	 * @param {any} ctx
	 */
	const restatus = async (ctx) => {
		const body = typeof ctx.body === 'object' && ctx.body !== null ? ctx.body : {};
		const from = typeof body.from === 'string' ? body.from : '';
		const to = typeof body.to === 'string' ? body.to : '';
		const s = await service.site(ctx);
		const flow = await s.flow();
		const checked = checkRestatus(flow, from, to);
		if (!checked.ok) throw service.invalid(checked.field, checked.message);
		const actor = service.actor(ctx);
		const fromLabel = statusOf(flow, from)?.label ?? from;
		const toLabel = statusOf(flow, to)?.label ?? to;
		const moved = await createOrdersStore(await s.data()).restatus({
			from,
			to,
			role: checked.role,
			entry: {
				at: new Date(product.now()),
				from,
				to,
				...byActor(actor),
				...serverNote('restatus', `Moved from ${fromLabel} to ${toLabel} with the other orders of that status`),
			},
		});
		await service.log(ctx, 'orders.restatus', from, {
			label: `${moved} orders`,
			detail: `${fromLabel} → ${toLabel}`,
		});
		return { from, to, role: checked.role, moved };
	};

	/** POST /v1/orders/:id/payments: a payment staff took (E26). @param {any} ctx */
	const recordPayment = async (ctx) => {
		const s = await service.site(ctx);
		const order = await orderOf(s, ctx);
		const input = checkPayment(ctx.body, order, await methodKeys(s));
		if (!input.ok) throw service.invalid(input.field, input.message);
		const done = await moves.recordPayment(s, ctx, order, input.value, await s.flow());
		return created({ order: await detailOf(s, done.order), ...warningsOf(done.warnings) });
	};

	/** @param {any} ctx */
	const editOrder = async (ctx) => {
		const s = await service.site(ctx);
		let order = await orderOf(s, ctx);
		const input = checkEdit(ctx.body, order);
		if (!input.ok) throw service.invalid(input.field, input.message);
		// serial numbers typed at packing or later (E11)
		const { serials, shipment, waiting, attachments, removeAttachments, fields, ...rest } = input.value;
		const attaching = Boolean(attachments || removeAttachments);
		// a changed address holds what the website requires, as checkout checks it (a waiting order's is checked when it
		// is priced again)
		if (rest.address && !waiting) {
			const checked = checkAddress(rest.address, await addressRulesOf(s));
			if (!checked.ok) throw service.invalid(checked.field, checked.message);
			rest.address = checked.value;
		}
		// lines, payment and delivery of a waiting order are priced again by checkout (E29)
		if (waiting) {
			order = await ordering.editWaiting(s, ctx, order, { ...waiting, ...(rest.address ? { address: rest.address } : {}) });
			delete rest.address;
			if (Object.keys(rest).length === 0 && !shipment && !serials && !attaching && !fields) return detailOf(s, order);
		}
		if (serials) {
			order = await moves.typeSerials(s, ctx, order, serials);
			if (Object.keys(rest).length === 0 && !shipment && !attaching && !fields) return detailOf(s, order);
		}
		/** @type {Record<string, unknown>} */
		const set = { ...rest };
		// the order fields' values staff give (each in its field's rules; null clears one), kept with the others
		if (fields) {
			const known = (await fieldsOn(await s.data(), 'order')).filter((field) => field.active);
			const checked = checkFieldValues(fields, known);
			if (!checked.ok) throw service.invalid(checked.path, checked.message);
			const next = { ...(order.fields ?? {}), ...checked.value };
			for (const id of checked.cleared) delete next[id];
			set.fields = next;
		}
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
		/** @type {Record<string, unknown>} */
		const update = { $set: set };
		// attachments added (of the merchant's kinds) and removed at any time (E20), with a history entry
		if (attaching) {
			const kept = (order.attachments ?? []).filter((held) => !(removeAttachments ?? []).includes(held.id));
			const added = attachmentsOf(attachments ?? [], await s.list('attachment_kinds'), {
				held: kept.length,
				at: new Date(product.now()),
				by: service.actor(ctx).name,
				id: () => createId('att'),
			});
			if (!added.ok) throw service.invalid(added.field, added.message);
			set.attachments = [...kept, ...added.value];
			update.$push = {
				history: {
					at: new Date(product.now()),
					from: order.status,
					to: order.status,
					...byActor(service.actor(ctx)),
					...(added.value.length > 0
						? serverNote('attachment_added', 'Attachment added')
						: serverNote('attachment_removed', 'Attachment removed')),
					kind: 'attachments',
				},
			};
		}
		const orders = (await s.data()).collection(COLLECTIONS.orders);
		const result = await orders.updateOne({ websiteId: s.websiteId, id: order.id, updatedAt: order.updatedAt }, update);
		if (result.modifiedCount !== 1) throw problem('conflict', 'The order changed meanwhile; reload it and try again.');
		await service.log(
			ctx,
			rest.address
				? 'order.address_changed'
				: shipment
					? 'order.shipment_changed'
					: attaching
						? 'order.attachments_changed'
						: 'order.noted',
			order.id,
			{
				label: order.number,
				detail: [
					...(rest.address ? ['Delivery address changed'] : []),
					...(shipment ? ['Shipment changed'] : []),
					...(attachments ? ['Attachment added'] : []),
					...(removeAttachments ? ['Attachment removed'] : []),
					...(rest.staffNote === undefined ? [] : ['Staff note changed']),
					...(rest.tags === undefined ? [] : ['Tags changed']),
					...(fields ? ['Fields changed'] : []),
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
		const context = await documentContextOf(s, [order]);
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

	/**
	 * GET /v1/shop/orders/:id/invoice: the order the shopper may open, as on its page (their sign-in, or a guest order's
	 * key in `SS-Order-Key`, E21); with `shopperFrom` confirmed, once the order is confirmed: not while it waits, nor once
	 * canceled (E35).
	 * @param {any} ctx
	 */
	const shopInvoice = async (ctx) => {
		const { s, order } = await ordering.shopperOrder(ctx);
		if (!shopperInvoiceReady(order, await s.values('invoices'))) throw problem('not_found', 'This order has no invoice yet.');
		return document(s, order, 'invoice', { shopper: true });
	};

	/** @param {any} ctx */
	const bulkMove = async (ctx) => {
		const input = checkBulkMove(ctx.body);
		if (!input.ok) throw service.invalid(input.field, input.message);
		const s = await service.site(ctx);
		const flow = await s.flow();
		const found = new Map((await (await storeOf(s)).orders.many(input.value.ids)).map((order) => [order.id, order]));
		/** @type {Array<{ id: string, ok: true, number: string, status: string } & ReturnType<typeof warningsOf> | { id: string, ok: false, code: string, detail: string }>} */
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
						...(input.value.shopperNote ? { shopperNote: input.value.shopperNote } : {}),
						...(input.value.restock === undefined ? {} : { restock: input.value.restock }),
						serials: item?.serials ?? {},
						shipment: item?.shipment ?? null,
						updatedAt: null,
						...(item?.attachments ? { attachments: item.attachments } : {}),
					},
					flow,
				);
				results.push({ id, ok: true, number: order.number, status: moved.order.status, ...warningsOf(moved.warnings) });
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
		const flow = await s.flow();
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
		const anonymized = await store.orders.anonymize(user);
		const deleted = (await store.customers.forget(user)) + forgotten;
		return { deleted, anonymized };
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
				permission: 'orders.read',
				feature: 'checkout',
				rateLimit: SERVER_LIMITS,
				handler: listOrders,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/admin/orders',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'orders.read',
				rateLimit: SERVER_LIMITS,
				handler: listOrders,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/orders/count',
				auth: 'server',
				permission: 'orders.read',
				feature: 'checkout',
				rateLimit: SERVER_LIMITS,
				handler: orderCounts.count,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/orders/counts',
				auth: 'server',
				permission: 'orders.read',
				feature: 'checkout',
				rateLimit: SERVER_LIMITS,
				handler: orderCounts.counts,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/admin/orders/count',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'orders.read',
				rateLimit: SERVER_LIMITS,
				handler: orderCounts.count,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/admin/orders/counts',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'orders.read',
				rateLimit: SERVER_LIMITS,
				handler: orderCounts.counts,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/orders/:id',
				auth: 'server',
				permission: 'orders.read',
				feature: 'checkout',
				rateLimit: SERVER_LIMITS,
				handler: readOrder,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/admin/orders/:id',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'orders.read',
				rateLimit: SERVER_LIMITS,
				handler: readOrder,
			}),
			defineRoute({
				method: 'PATCH',
				path: '/v1/orders/:id',
				auth: 'server',
				permission: 'orders.manage',
				feature: 'checkout',
				rateLimit: SERVER_LIMITS,
				handler: editOrder,
			}),
			defineRoute({
				method: 'PATCH',
				path: '/v1/admin/orders/:id',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'orders.manage',
				rateLimit: SERVER_LIMITS,
				handler: editOrder,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/orders/:id/move',
				auth: 'server',
				permission: 'orders.manage',
				feature: 'checkout',
				idempotent: true,
				rateLimit: SERVER_LIMITS,
				handler: moveOrder,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/admin/orders/:id/move',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'orders.manage',
				idempotent: true,
				rateLimit: SERVER_LIMITS,
				handler: moveOrder,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/orders/:id/seen',
				auth: 'server',
				permission: 'orders.read',
				feature: 'checkout',
				rateLimit: SERVER_LIMITS,
				handler: markSeen,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/admin/orders/:id/seen',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'orders.read',
				rateLimit: SERVER_LIMITS,
				handler: markSeen,
			}),
			defineRoute({
				method: 'DELETE',
				path: '/v1/orders/:id',
				auth: 'server',
				permission: 'orders.delete',
				feature: 'checkout',
				rateLimit: SERVER_LIMITS,
				handler: deleteOrder,
			}),
			defineRoute({
				method: 'DELETE',
				path: '/v1/admin/orders/:id',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'orders.delete',
				rateLimit: SERVER_LIMITS,
				handler: deleteOrder,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/data/delete-all',
				auth: 'server',
				permission: 'data.delete_all',
				feature: 'catalog',
				rateLimit: SERVER_LIMITS,
				handler: deleteAll,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/orders/counter',
				auth: 'server',
				permission: 'orders.manage',
				feature: 'checkout',
				rateLimit: SERVER_LIMITS,
				handler: setCounter,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/orders/restatus',
				auth: 'server',
				permission: 'orders.manage',
				feature: 'checkout',
				idempotent: true,
				rateLimit: SERVER_LIMITS,
				handler: restatus,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/admin/orders/restatus',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'orders.manage',
				idempotent: true,
				rateLimit: SERVER_LIMITS,
				handler: restatus,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/orders/:id/payments',
				auth: 'server',
				permission: 'orders.manage',
				feature: 'checkout',
				idempotent: true,
				rateLimit: SERVER_LIMITS,
				handler: recordPayment,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/admin/orders/:id/payments',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'orders.manage',
				idempotent: true,
				rateLimit: SERVER_LIMITS,
				handler: recordPayment,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/orders/:id/refunds',
				auth: 'server',
				permission: 'orders.refund',
				feature: 'checkout',
				idempotent: true,
				rateLimit: SERVER_LIMITS,
				handler: refundOrder,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/admin/orders/:id/refunds',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'orders.refund',
				idempotent: true,
				rateLimit: SERVER_LIMITS,
				handler: refundOrder,
			}),

			// invoices and packing slips
			defineRoute({
				method: 'GET',
				path: '/v1/orders/:id/invoice',
				auth: 'server',
				permission: 'orders.read',
				feature: 'invoices',
				rateLimit: SERVER_LIMITS,
				handler: invoice,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/admin/orders/:id/invoice',
				auth: 'ticket',
				feature: 'invoices',
				permission: 'orders.read',
				rateLimit: SERVER_LIMITS,
				handler: invoice,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/orders/:id/packing-slip',
				auth: 'server',
				permission: 'orders.read',
				feature: 'invoices',
				rateLimit: SERVER_LIMITS,
				handler: packingSlip,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/admin/orders/:id/packing-slip',
				auth: 'ticket',
				feature: 'invoices',
				permission: 'orders.read',
				rateLimit: SERVER_LIMITS,
				handler: packingSlip,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/shop/orders/:id/invoice',
				auth: 'browser',
				feature: 'invoices',
				rateLimit: VISITOR_LIMITS,
				handler: shopInvoice,
			}),

			// bulk moves
			defineRoute({
				method: 'POST',
				path: '/v1/orders/bulk-move',
				auth: 'server',
				permission: 'bulk.run',
				feature: 'catalog',
				idempotent: true,
				rateLimit: SERVER_LIMITS,
				handler: bulkMove,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/admin/orders/bulk-move',
				auth: 'ticket',
				feature: 'catalog',
				permission: 'bulk.run',
				idempotent: true,
				rateLimit: SERVER_LIMITS,
				handler: bulkMove,
			}),

			// customers and the blocklist
			defineRoute({
				method: 'GET',
				path: '/v1/customers',
				auth: 'server',
				permission: 'customers.manage',
				feature: 'checkout',
				rateLimit: SERVER_LIMITS,
				handler: customers.list,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/admin/customers',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'customers.manage',
				rateLimit: SERVER_LIMITS,
				handler: customers.list,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/customers/count',
				auth: 'server',
				permission: 'customers.manage',
				feature: 'checkout',
				rateLimit: SERVER_LIMITS,
				handler: customers.count,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/customers/counts',
				auth: 'server',
				permission: 'customers.manage',
				feature: 'checkout',
				rateLimit: SERVER_LIMITS,
				handler: customers.counts,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/admin/customers/count',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'customers.manage',
				rateLimit: SERVER_LIMITS,
				handler: customers.count,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/admin/customers/counts',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'customers.manage',
				rateLimit: SERVER_LIMITS,
				handler: customers.counts,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/customers/:userId',
				auth: 'server',
				permission: 'customers.manage',
				feature: 'checkout',
				rateLimit: SERVER_LIMITS,
				handler: customers.read,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/admin/customers/:userId',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'customers.manage',
				rateLimit: SERVER_LIMITS,
				handler: customers.read,
			}),
			defineRoute({
				method: 'PATCH',
				path: '/v1/customers/:userId',
				auth: 'server',
				permission: 'customers.manage',
				feature: 'checkout',
				rateLimit: SERVER_LIMITS,
				handler: customers.edit,
			}),
			defineRoute({
				method: 'PATCH',
				path: '/v1/admin/customers/:userId',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'customers.manage',
				rateLimit: SERVER_LIMITS,
				handler: customers.edit,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/customers',
				auth: 'server',
				permission: 'customers.manage',
				feature: 'checkout',
				rateLimit: SERVER_LIMITS,
				handler: customers.create,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/admin/customers',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'customers.manage',
				rateLimit: SERVER_LIMITS,
				handler: customers.create,
			}),
			defineRoute({
				method: 'PUT',
				path: '/v1/customers/:userId/addresses',
				auth: 'server',
				permission: 'customers.manage',
				feature: 'checkout',
				rateLimit: SERVER_LIMITS,
				handler: customers.setAddresses,
			}),
			defineRoute({
				method: 'PUT',
				path: '/v1/admin/customers/:userId/addresses',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'customers.manage',
				rateLimit: SERVER_LIMITS,
				handler: customers.setAddresses,
			}),
			defineRoute({
				method: 'DELETE',
				path: '/v1/customers/:userId',
				auth: 'server',
				permission: 'customers.manage',
				feature: 'checkout',
				rateLimit: SERVER_LIMITS,
				handler: customers.remove,
			}),
			defineRoute({
				method: 'DELETE',
				path: '/v1/admin/customers/:userId',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'customers.manage',
				rateLimit: SERVER_LIMITS,
				handler: customers.remove,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/customers/:userId/seen',
				auth: 'server',
				permission: 'customers.manage',
				feature: 'checkout',
				rateLimit: SERVER_LIMITS,
				handler: customers.seen,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/admin/customers/:userId/seen',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'customers.manage',
				rateLimit: SERVER_LIMITS,
				handler: customers.seen,
			}),
			// saved segments and tags of customers and orders (E11)
			defineRoute({
				method: 'GET',
				path: '/v1/customers/segments',
				auth: 'server',
				permission: 'customers.manage',
				feature: 'checkout',
				rateLimit: SERVER_LIMITS,
				handler: customers.segments,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/admin/customers/segments',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'customers.manage',
				rateLimit: SERVER_LIMITS,
				handler: customers.segments,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/customers/tags',
				auth: 'server',
				permission: 'customers.manage',
				feature: 'checkout',
				rateLimit: SERVER_LIMITS,
				handler: customerTags.list,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/admin/customers/tags',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'customers.manage',
				rateLimit: SERVER_LIMITS,
				handler: customerTags.list,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/customers/tags/rename',
				auth: 'server',
				permission: 'customers.manage',
				feature: 'checkout',
				rateLimit: SERVER_LIMITS,
				handler: customerTags.rename,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/admin/customers/tags/rename',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'customers.manage',
				rateLimit: SERVER_LIMITS,
				handler: customerTags.rename,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/customers/tags/remove',
				auth: 'server',
				permission: 'customers.manage',
				feature: 'checkout',
				rateLimit: SERVER_LIMITS,
				handler: customerTags.remove,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/admin/customers/tags/remove',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'customers.manage',
				rateLimit: SERVER_LIMITS,
				handler: customerTags.remove,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/customers/tags/apply',
				auth: 'server',
				permission: 'customers.manage',
				feature: 'checkout',
				rateLimit: SERVER_LIMITS,
				handler: customerTags.apply,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/admin/customers/tags/apply',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'customers.manage',
				rateLimit: SERVER_LIMITS,
				handler: customerTags.apply,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/orders/tags',
				auth: 'server',
				permission: 'orders.read',
				feature: 'checkout',
				rateLimit: SERVER_LIMITS,
				handler: orderTags.list,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/admin/orders/tags',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'orders.read',
				rateLimit: SERVER_LIMITS,
				handler: orderTags.list,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/orders/tags/rename',
				auth: 'server',
				permission: 'orders.manage',
				feature: 'checkout',
				rateLimit: SERVER_LIMITS,
				handler: orderTags.rename,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/admin/orders/tags/rename',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'orders.manage',
				rateLimit: SERVER_LIMITS,
				handler: orderTags.rename,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/orders/tags/remove',
				auth: 'server',
				permission: 'orders.manage',
				feature: 'checkout',
				rateLimit: SERVER_LIMITS,
				handler: orderTags.remove,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/admin/orders/tags/remove',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'orders.manage',
				rateLimit: SERVER_LIMITS,
				handler: orderTags.remove,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/orders/tags/apply',
				auth: 'server',
				permission: 'orders.manage',
				feature: 'checkout',
				rateLimit: SERVER_LIMITS,
				handler: orderTags.apply,
			}),
			defineRoute({
				method: 'POST',
				path: '/v1/admin/orders/tags/apply',
				auth: 'ticket',
				feature: 'checkout',
				permission: 'orders.manage',
				rateLimit: SERVER_LIMITS,
				handler: orderTags.apply,
			}),
		],
	};
};
