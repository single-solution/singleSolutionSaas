/**
 * Placing and paying orders, and the shopper's own orders (PLAN 0.8.8; payment confirmation PLAN 0.3).
 *
 * - Placing: the cart is priced again on the server, the shopper must be signed in (Accounts), COD safety and the
 *   blocklist and open-order cap apply, and the ledger places the order in one transaction (stock, offer uses, points,
 *   booked slots). Online, bank-transfer and COD-advance orders start awaiting payment and get a Payments payment
 *   (the shopper pays on Payments' page and comes back to `returnUrl?ss_order=<id>`); COD and pay-at-pickup orders
 *   start awaiting confirmation.
 * - Paying: an order is paid only when Payments says, server to server, that its payment is paid for exactly the
 *   order's amount (or advance) and currency. A waiting payment is asked again when the order is read (at most every
 *   30 seconds), on use, and once more before a waiting order is cancelled at the end of its window. Nothing runs on a
 *   timer: waiting orders whose window ended are cancelled on use (`service.whenUsed`), giving back what they held.
 * - The shopper's orders (list, detail with downloads and licence keys, cancel while waiting, pay again) and the
 *   shopper's success page (it reads `ss_order` and reads the order, which rechecks its payment).
 * @module
 */
import { created, paginate, problem } from '@ss/app-kit';
import { createId } from '@ss/contracts';
import { originAllowed } from '@ss/protocol';
import { placeOrder, releaseOrder } from '../adapters/ledger.js';
import { createOrdersStore } from '../adapters/orders-store.js';
import { STOCK_PROBLEMS, checkAddress, checkCart, checkOrderExtras } from '../core/checkout.js';
import { WAITING_ROLES, cancelledStatus, confirmedStatus, statusOf, statusWithRole } from '../core/flow.js';
import { pointsToEarn } from '../core/loyalty.js';
import { COLLECTIONS, ID_PREFIX } from '../core/model.js';
import { createMedia } from './catalog-media.js';
import { createOrderMessages } from './order-messages.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').Shopper} Shopper */
/** @typedef {import('./checkout-quote.js').Quoting} Quoting */
/** @typedef {import('./checkout-quote.js').Quote} Quote */
/** @typedef {import('./checkout-digital.js').Digital} Digital */
/** @typedef {import('../core/model.js').OrderRecord} OrderRecord */
/** @typedef {import('../core/model.js').OrderLineRecord} OrderLineRecord */
/** @typedef {import('../core/model.js').OrderFlow} OrderFlow */
/** @typedef {import('../core/model.js').StatusRole} StatusRole */

/** A waiting payment is asked of Payments at most this often per order. */
const RECHECK_MS = 30_000;

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const E164 = /^\+[1-9]\d{6,14}$/;

/** @param {string} url @param {string} name @param {string} value */
const withParam = (url, name, value) => {
	const target = new URL(url);
	target.searchParams.set(name, value);
	return target.toString();
};

/** @param {Date | string | null | undefined} at */
const iso = (at) => (at ? new Date(at).toISOString() : null);

/** What Payments must confirm for an order: its advance (COD) or its total. @param {OrderRecord} order */
const expectedOf = (order) => ({
	amount: order.payment.advance > 0 ? order.payment.advance : order.totals.total,
	currency: order.totals.currency,
});

/**
 * @param {Product} product
 * @param {Service} service
 * @param {{ quoting: Quoting, digital: Digital }} parts
 */
export const createOrdering = (product, service, { quoting, digital }) => {
	const media = createMedia(product);
	const messages = createOrderMessages(service);

	/** @param {Site} s @returns {Promise<OrderFlow>} */
	const flowOf = async (s) => /** @type {OrderFlow} */ (/** @type {unknown} */ (await s.list('order_flow')));

	/** @param {OrderFlow} flow @param {string} status */
	const labelOf = (flow, status) => statusOf(flow, status)?.label ?? status;

	/**
	 * Whether a return address belongs to the website (its exact https domain, or a local address while testing).
	 * @param {Site} s @param {string} url
	 */
	const allowedReturn = (s, url) => {
		try {
			const target = new URL(url);
			return !target.username && !target.password && originAllowed({ origin: target.origin, domain: s.domain });
		} catch {
			return false;
		}
	};

	// ------------------------------------------------------------------------------------------------- payments

	/**
	 * Start the Payments payment of an order (its total, or its COD advance). Null when Payments cannot be reached or
	 * refuses: the order keeps waiting and the shopper can try again.
	 * @param {Site} s @param {OrderRecord} order @param {string | null} returnUrl @param {string} idempotencyKey
	 * @returns {Promise<OrderRecord | null>}
	 */
	const startPayment = async (s, order, returnUrl, idempotencyKey) => {
		const back = returnUrl ? withParam(returnUrl, 'ss_order', order.id) : null;
		const { customer } = order;
		try {
			const payment = await service.payments.create(s, {
				...expectedOf(order),
				gateway: order.payment.method === 'bank_transfer' ? 'bank_transfer' : null,
				description: `${order.payment.advance > 0 ? 'Advance for order' : 'Order'} ${order.number}`,
				reference: order.number,
				customer: {
					id: customer.userId,
					...(customer.name ? { name: customer.name.slice(0, 120) } : {}),
					...(EMAIL.test(customer.email) ? { email: customer.email } : {}),
					...(E164.test(customer.phone) ? { phone: customer.phone } : {}),
				},
				metadata: { orderId: order.id },
				returnUrl: back,
				cancelUrl: back,
				idempotencyKey,
			});
			const store = createOrdersStore(await s.data());
			return (
				(await store.change(order, {
					'payment.paymentId': payment.id,
					'payment.checkoutUrl': payment.checkoutUrl,
					'payment.checkedAt': null,
				})) ?? null
			);
		} catch (error) {
			s.ctx.log?.warn?.('payment not started', { code: /** @type {any} */ (error)?.code ?? 'error' });
			return null;
		}
	};

	/**
	 * Mark an order paid (Payments confirmed it) and move it to the flow's confirmed status.
	 * @param {Site} s @param {OrderRecord} order
	 * @returns {Promise<OrderRecord>}
	 */
	const confirmPaid = async (s, order) => {
		const store = createOrdersStore(await s.data());
		const flow = await flowOf(s);
		const now = service.now();
		const to = confirmedStatus(flow, order.status);
		const advance = order.payment.advance > 0;
		/** @type {Record<string, unknown>} */
		const set = {
			'payment.state': advance ? 'unpaid' : 'paid',
			'payment.paid': expectedOf(order).amount,
			'payment.checkedAt': new Date(now),
			holdUntil: null,
		};
		// the flow may have no move from waiting to an open status: the order is then paid but stays where it is
		const next = statusOf(flow, to ?? '');
		if (next) Object.assign(set, { status: next.key, role: next.role });
		const moved = await store.change(order, set, {
			where: { 'payment.state': 'pending' },
			...(next
				? {
						push: {
							history: { at: new Date(now), from: order.status, to: next.key, by: 'system', note: 'Payment confirmed' },
						},
					}
				: {}),
		});
		if (!moved) return (await store.order(order.id)) ?? order;
		await service.emit('order.paid', s, { order: moved });
		if (next) {
			await service.emit('order.moved', s, { order: moved, from: order.status, to: next.key });
			await messages.status(s, moved, next.label);
		}
		return (await store.order(order.id)) ?? moved;
	};

	/**
	 * Ask Payments about an order's waiting payment (at most every {@link RECHECK_MS} unless `force`) and confirm the
	 * order when it is paid. Never throws: when Payments cannot be reached the order is returned as it was.
	 * @param {Site} s @param {OrderRecord} order @param {{ force?: boolean }} [options]
	 * @returns {Promise<{ order: OrderRecord, reached: boolean }>}
	 */
	const recheck = async (s, order, { force = false } = {}) => {
		if (order.role !== 'awaiting_payment' || order.payment.state !== 'pending' || !order.payment.paymentId)
			return { order, reached: true };
		const now = service.now();
		const checkedAt = order.payment.checkedAt ? new Date(order.payment.checkedAt).getTime() : null;
		if (!force && checkedAt !== null && now - checkedAt < RECHECK_MS) return { order, reached: true };
		let verified = false;
		try {
			verified = (await service.payments.verify(s, order.payment.paymentId, expectedOf(order))).verified;
		} catch {
			return { order, reached: false };
		}
		if (verified) return { order: await confirmPaid(s, order), reached: true };
		const store = createOrdersStore(await s.data());
		return { order: (await store.change(order, { 'payment.checkedAt': new Date(now) })) ?? order, reached: true };
	};

	/** @param {Site} s @param {OrderRecord} order */
	const refresh = async (s, order) => (await recheck(s, order)).order;

	// ------------------------------------------------------------------------------------------------- cancelling

	/**
	 * Cancel a waiting order, giving back its stock, slots, offer uses and points (exactly once).
	 * @param {Site} s @param {OrderRecord} order as just read @param {{ by: string, note: string }} who
	 * @returns {Promise<OrderRecord | null>} null when it moved meanwhile or the flow has no cancelled status
	 */
	const cancel = async (s, order, { by, note }) => {
		const flow = await flowOf(s);
		const to = cancelledStatus(flow, order.status) ?? '';
		const role = statusOf(flow, to)?.role;
		if (!role) return null;
		const data = await s.data();
		const now = service.now();
		let done = false;
		try {
			done = await releaseOrder(data, order, {
				now,
				update: async (session) => {
					const result = await data.collection(COLLECTIONS.orders).updateOne(
						{ websiteId: data.websiteId, id: order.id, status: order.status },
						{
							$set: { status: to, role, holdUntil: null },
							$push: { history: { at: new Date(now), from: order.status, to, by, note } },
						},
						{ session },
					);
					return result.modifiedCount === 1;
				},
			});
		} catch (error) {
			if (/** @type {any} */ (error)?.message !== 'order changed') throw error;
		}
		if (!done) return null;
		const after = /** @type {OrderRecord} */ (await createOrdersStore(data).order(order.id));
		await service.emit('order.moved', s, { order: after, from: order.status, to });
		await messages.status(s, after, labelOf(flow, to));
		return after;
	};

	/**
	 * End a waiting order whose window passed: a waiting payment is asked once more (paid: confirmed instead); else
	 * cancelled. When Payments cannot be reached the order waits for the next use (it may have been paid), unless
	 * the Payments token was removed.
	 * @param {Site} s @param {OrderRecord} order
	 */
	const expire = async (s, order) => {
		let current = order;
		if (order.role === 'awaiting_payment' && order.payment.state === 'pending' && order.payment.paymentId) {
			const checked = await recheck(s, order, { force: true });
			if (!checked.reached && (await product.connections.value(s.websiteId, 'payments')) !== null) return;
			current = checked.order;
			if (current.status !== order.status || current.payment.state !== 'pending') return;
		}
		await cancel(s, current, {
			by: 'system',
			note: order.role === 'awaiting_payment' ? 'Not paid in time' : 'Not confirmed in time',
		});
	};

	/**
	 * Work on use: recheck waiting payments, then end waiting orders whose window passed (bounded batches).
	 * @param {Site} s
	 */
	const sweep = async (s) => {
		if (!s.has('checkout') || (await product.connections.value(s.websiteId, 'database')) === null) return;
		const store = createOrdersStore(await s.data());
		const now = service.now();
		for (const order of await store.toRecheck(now, RECHECK_MS)) await recheck(s, order);
		for (const order of await store.expired(WAITING_ROLES, now)) await expire(s, order);
	};

	// --------------------------------------------------------------------------------------------------- views

	/**
	 * What the shopper sees of an order (never staff notes or who moved it).
	 * @param {Site} s @param {OrderRecord} order @param {OrderFlow} flow
	 */
	const shopperView = async (s, order, flow) => {
		const downloads = s.has('digital_goods') ? await digital.linesOf(s, order) : new Map();
		const location =
			order.delivery.method === 'pickup' && order.delivery.locationId
				? await (
						await s.data()
					)
						.collection(COLLECTIONS.locations)
						.findOne({ websiteId: s.websiteId, id: order.delivery.locationId }, { projection: { _id: 0, name: 1 } })
				: null;
		const waitingPayment =
			order.role === 'awaiting_payment' && order.payment.state === 'pending' && order.payment.paymentId !== null;
		return {
			id: order.id,
			number: order.number,
			status: order.status,
			statusLabel: labelOf(flow, order.status),
			role: order.role,
			placedAt: iso(order.placedAt),
			lines: await Promise.all(
				order.lines.map(async (line) => {
					const extra = downloads.get(line.id);
					return {
						id: line.id,
						productId: line.productId,
						variantId: line.variantId,
						kind: line.kind,
						name: line.name,
						variantName: line.variantName,
						gradeLabel: line.gradeLabel,
						image: await media.mediaUrl(s, line.image),
						unitPrice: line.unitPrice,
						quantity: line.quantity,
						discount: line.discount,
						tax: line.tax,
						total: line.total,
						booking: line.booking ? { start: iso(line.booking.start), end: iso(line.booking.end) } : null,
						downloads: extra?.files ?? [],
						downloadsLeft: extra?.downloadsLeft ?? null,
						licenceKeys: extra?.licenceKeys ?? [],
					};
				}),
			),
			totals: order.totals,
			promotions: {
				couponCode: order.promotions.couponCode,
				pointsRedeemed: order.promotions.pointsRedeemed,
				pointsValue: order.promotions.pointsValue,
			},
			address: order.address,
			delivery: { ...order.delivery, locationName: location ? String(location.name) : '' },
			payment: {
				method: order.payment.method,
				state: order.payment.state,
				advance: order.payment.advance,
				paid: order.payment.paid,
				refunded: order.payment.refunded,
				payUrl: waitingPayment ? String(/** @type {any} */ (order.payment).checkoutUrl || '') || null : null,
				payBy: order.role === 'awaiting_payment' ? iso(order.holdUntil) : null,
			},
			history: order.history.map((entry) => ({ at: iso(entry.at), status: entry.to, label: labelOf(flow, entry.to) })),
			shipment: order.shipment
				? {
						courier: order.shipment.courier,
						trackingNumber: order.shipment.trackingNumber,
						trackingUrl: order.shipment.trackingUrl,
					}
				: null,
			note: order.note,
			canCancel: WAITING_ROLES.includes(order.role),
		};
	};

	/**
	 * What to do next after placing or paying: pay on Payments' page, try starting the payment again, or nothing.
	 * @param {OrderRecord} order
	 */
	const nextOf = (order) => {
		if (order.role !== 'awaiting_payment' || order.payment.state !== 'pending') return { kind: 'done' };
		const url = /** @type {any} */ (order.payment).checkoutUrl;
		return order.payment.paymentId && url ? { kind: 'pay', url: String(url) } : { kind: 'retry' };
	};

	// ---------------------------------------------------------------------------------------------------- placing

	/**
	 * Refuse a cart whose lines cannot be ordered: stock (and slots) → 409 `out_of_stock` / `slot_taken`; anything
	 * else → 422 naming the lines.
	 * @param {Quote} q
	 */
	const refuseLines = (q) => {
		const bad = q.lines.map((line, index) => ({ line, index })).filter(({ line }) => !line.priced || line.problems.length > 0);
		if (bad.length === 0) return;
		const codes = bad.flatMap(({ line }) => line.problems.map((p) => p.code));
		if (codes.every((code) => STOCK_PROBLEMS.includes(code))) {
			const slot = codes.every((code) => code === 'slot_taken');
			throw problem(
				slot ? 'slot_taken' : 'out_of_stock',
				slot ? 'A chosen time is already booked.' : 'Some items are not in stock in the quantity asked.',
				{ extensions: { lines: bad.map(({ line }) => ({ key: line.key, problems: line.problems })) } },
			);
		}
		throw problem('validation_failed', 'Some items cannot be ordered.', {
			errors: bad.flatMap(({ line, index }) =>
				(line.problems.length > 0 ? line.problems : [{ code: 'unavailable', message: 'This item is not available.' }]).map(
					(p) => ({ path: `/lines/${index}`, message: p.message, code: p.code }),
				),
			),
		});
	};

	/** @param {any} ctx */
	const place = async (ctx) => {
		if (!ctx.idempotencyKey) throw problem('idempotency_key_required', 'Send an Idempotency-Key header.');
		const s = await service.site(ctx);
		const shopper = await service.requireShopper(s);
		const cart = checkCart(ctx.body);
		if (!cart.ok) throw service.invalid(cart.field, cart.message);
		const extras = checkOrderExtras(ctx.body);
		if (!extras.ok) throw service.invalid(extras.field, extras.message);
		const { payment: method, note, returnUrl } = extras.value;
		if (returnUrl !== null && !allowedReturn(s, returnUrl))
			throw service.invalid('returnUrl', `returnUrl must be on https://${s.domain} (or a local address while testing).`);
		const checkout = await s.values('checkout');
		const data = await s.data();
		const store = createOrdersStore(data);
		const customer = await store.customer(shopper.id);
		if (customer?.blocked)
			throw problem('customer_blocked', 'Ordering is not possible for this account. Please contact the shop.');
		const cap = Number(checkout.openOrderCap);
		if (cap > 0 && (await store.countWaiting(shopper.id, WAITING_ROLES)) >= cap)
			throw problem(
				'too_many_open_orders',
				'You have orders waiting for payment or confirmation. Finish or cancel them first.',
			);

		/** @type {string[]} */
		const required = checkout.addressRequired;
		const address =
			extras.value.address === undefined || extras.value.address === null
				? null
				: checkAddress(extras.value.address, required);
		const q = await quoting.quote(s, cart.value, shopper, address?.ok ? address.value : null);
		refuseLines(q);
		if (q.delivery.method === 'delivery' && !address?.ok)
			throw service.invalid(
				address?.ok === false ? address.field : 'address',
				address?.ok === false ? address.message : 'A delivery address is required.',
			);
		if (q.deliveryProblem) throw service.invalid('delivery/locationId', 'Choose a pickup location.');
		const option = q.payments.find((entry) => entry.method === method);
		if (!option) throw service.invalid('payment', 'This payment method is not offered.');
		if (!option.available) {
			if (method === 'cod')
				throw problem(
					'cod_not_allowed',
					option.reason === 'over_max'
						? 'Cash on delivery is not possible for an order this large. Please choose another way to pay.'
						: 'Cash on delivery is not possible for this order. Please choose another way to pay.',
					{ extensions: { codReason: option.reason } },
				);
			throw service.invalid('payment', 'This payment method cannot be used for this order.');
		}

		// the order record
		const flow = await flowOf(s);
		const now = service.now();
		const total = q.totals.total;
		const advance = method === 'cod' ? option.advance : 0;
		const viaPayments = total > 0 && (method === 'online' || method === 'bank_transfer' || advance > 0);
		/** @type {StatusRole} */
		const role = viaPayments ? 'awaiting_payment' : 'awaiting_confirmation';
		const status = statusWithRole(flow, role);
		const holdMs = viaPayments
			? Number(checkout.paymentWindowMinutes) * 60_000
			: Number(checkout.confirmationHours) * 3_600_000;
		const orderId = createId(ID_PREFIX.order);
		/** @type {Array<{ productId: string, start: Date, end: Date, lineId: string }>} */
		const slots = [];
		/** @type {OrderLineRecord[]} */
		const lines = q.priced.map((line, index) => {
			const price = /** @type {import('../core/checkout.js').PricedLine} */ (q.prices[index]);
			const id = createId(ID_PREFIX.line);
			const booking = line.booking ? { start: new Date(line.booking.start), end: new Date(line.booking.end) } : null;
			if (booking) slots.push({ productId: line.productId, start: booking.start, end: booking.end, lineId: id });
			return {
				id,
				productId: line.productId,
				variantId: line.variantId,
				kind: line.kind,
				name: line.name,
				variantName: line.variantName,
				sku: line.sku,
				grade: line.grade,
				gradeLabel: line.gradeLabel,
				image: line.image,
				unitPrice: line.unitPrice,
				quantity: line.quantity,
				discount: price.discount,
				tax: price.tax,
				total: price.total,
				cost: line.cost,
				categoryIds: line.categoryIds,
				brandId: line.brandId,
				locationId: null,
				serials: [],
				booking,
				licences: [],
				returnedQuantity: 0,
				...(line.kind === 'digital' ? { downloads: 0 } : {}),
			};
		});
		const promotions = q.promotions;
		const order = {
			id: orderId,
			customer: { userId: shopper.id, name: shopper.name, email: shopper.email, phone: shopper.phone },
			address: q.delivery.method === 'delivery' && address?.ok ? address.value : null,
			delivery: { method: q.delivery.method, zone: q.delivery.zone, fee: q.delivery.fee, locationId: q.delivery.locationId },
			lines,
			totals: { ...q.totals, currency: s.currency },
			promotions: {
				couponId: promotions?.couponId ?? null,
				couponCode: promotions?.couponId ? promotions.couponCode : '',
				dealIds: promotions?.dealIds ?? [],
				bundleIds: promotions?.bundleIds ?? [],
				pointsRedeemed: q.points?.used ?? 0,
				pointsValue: q.points?.value ?? 0,
				pointsEarned: s.has('loyalty')
					? Math.max(
							0,
							Math.floor(
								pointsToEarn({ total, delivery: q.totals.delivery, tax: q.totals.tax }, await s.values('loyalty')),
							),
						)
					: 0,
				released: false,
			},
			payment: {
				method,
				state: /** @type {import('../core/model.js').PaymentState} */ (
					viaPayments ? 'pending' : total === 0 ? 'paid' : 'unpaid'
				),
				paymentId: null,
				advance,
				paid: 0,
				refunded: 0,
				checkedAt: null,
				checkoutUrl: '',
			},
			status,
			role,
			history: [{ at: new Date(now), from: null, to: status, by: 'shopper', note: '' }],
			shipment: null,
			stockHeld: true,
			holdUntil: new Date(now + holdMs),
			idempotencyKey: String(ctx.idempotencyKey),
			note,
			staffNote: '',
			placedAt: new Date(now),
			deliveredAt: null,
		};
		const pickupFirst = q.delivery.locationId ? [q.delivery.locationId] : [];
		const locationOrder = s.has('multi_location')
			? [...new Set([...pickupFirst, ...q.locations.map((location) => location.id)])]
			: [];
		const placed = await placeOrder(
			data,
			{
				order,
				numberPrefix: String(checkout.numberPrefix),
				locationOrder,
				couponPerCustomer: q.coupon?.perCustomer ?? null,
				slots,
			},
			{ now },
		);
		if (!placed.ok) {
			if (placed.code === 'out_of_stock')
				throw problem('out_of_stock', 'Some items are not in stock in the quantity asked.', {
					extensions: { productId: placed.productId, variantId: placed.variantId },
				});
			if (placed.code === 'offer_unavailable')
				throw problem('offer_unavailable', 'An offer in your cart is no longer available. Check your cart again.');
			if (placed.code === 'points_changed')
				throw problem('points_changed', 'Your points balance changed. Check your cart again.');
			throw problem('slot_taken', 'A chosen time is already booked.');
		}
		if (placed.duplicate) return { order: await shopperView(s, placed.order, flow), next: nextOf(placed.order) };

		let current = placed.order;
		await store.recordCustomer(shopper);
		if (viaPayments) current = (await startPayment(s, current, returnUrl, current.id)) ?? current;
		await messages.placed(s, current, labelOf(flow, status));
		await service.emit('order.placed', s, { order: current });
		// a free order is paid as it is placed (its digital items are given now)
		if (current.payment.state === 'paid') {
			await service.emit('order.paid', s, { order: current });
			current = (await store.order(current.id)) ?? current;
		}
		return created({ order: await shopperView(s, current, flow), next: nextOf(current) });
	};

	// ------------------------------------------------------------------------------------------- shopper routes

	/** @param {any} ctx */
	const shopperOrder = async (ctx) => {
		const s = await service.site(ctx);
		const shopper = await service.requireShopper(s);
		const found = await createOrdersStore(await s.data()).customerOrder(shopper.id, String(ctx.params.id));
		if (!found) throw problem('not_found', 'There is no such order.');
		return { s, shopper, order: found };
	};

	/** @param {any} ctx */
	const list = async (ctx) => {
		const page = paginate(
			{ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url },
			{ defaultLimit: 20, maxLimit: 50 },
		);
		const s = await service.site(ctx);
		const shopper = await service.requireShopper(s);
		const flow = await flowOf(s);
		const rows = await createOrdersStore(await s.data()).customerOrders(shopper.id, {
			after: page.after,
			limit: page.fetchLimit,
		});
		const fresh = await Promise.all(rows.map((order) => refresh(s, order)));
		const items = await Promise.all(
			fresh.map(async (order) => ({
				id: order.id,
				number: order.number,
				status: order.status,
				statusLabel: labelOf(flow, order.status),
				total: order.totals.total,
				currency: order.totals.currency,
				placedAt: iso(order.placedAt),
				itemCount: order.lines.reduce((n, line) => n + line.quantity, 0),
				image: await media.mediaUrl(s, order.lines[0]?.image),
			})),
		);
		return page.respond(items, (item) => [item.placedAt, item.id]);
	};

	/** @param {any} ctx */
	const read = async (ctx) => {
		const { s, order } = await shopperOrder(ctx);
		return shopperView(s, await refresh(s, order), await flowOf(s));
	};

	/** @param {any} ctx */
	const cancelByShopper = async (ctx) => {
		const { s, order } = await shopperOrder(ctx);
		const current = await refresh(s, order);
		if (!WAITING_ROLES.includes(current.role)) throw problem('move_not_allowed', 'This order can no longer be cancelled here.');
		const cancelled = await cancel(s, current, { by: 'shopper', note: 'Cancelled by the shopper' });
		if (!cancelled) throw problem('move_not_allowed', 'This order can no longer be cancelled here.');
		return { order: await shopperView(s, cancelled, await flowOf(s)) };
	};

	/** @param {any} ctx */
	const pay = async (ctx) => {
		const { s, order } = await shopperOrder(ctx);
		const body = typeof ctx.body === 'object' && ctx.body !== null ? ctx.body : {};
		const returnUrl = body.returnUrl ?? null;
		if (returnUrl !== null && (typeof returnUrl !== 'string' || returnUrl.length > 2000 || !allowedReturn(s, returnUrl)))
			throw service.invalid('returnUrl', `returnUrl must be on https://${s.domain} (or a local address while testing).`);
		let current = await refresh(s, order);
		if (current.role !== 'awaiting_payment' || current.payment.state !== 'pending')
			throw problem('nothing_to_pay', 'This order is not waiting for a payment.');
		if (nextOf(current).kind !== 'pay') {
			const started = await startPayment(s, current, returnUrl, `${current.id}-${service.now()}`);
			if (!started) throw problem('payments_unavailable', 'Payments cannot be reached right now. Try again in a moment.');
			current = started;
		}
		return { order: await shopperView(s, current, await flowOf(s)), next: nextOf(current) };
	};

	/** @param {any} ctx */
	const downloadFile = async (ctx) => {
		const { s, order } = await shopperOrder(ctx);
		return digital.download(s, await refresh(s, order), String(ctx.params.lineId), String(ctx.params.file));
	};

	/** @param {any} ctx */
	const quoteCart = async (ctx) => {
		const s = await service.site(ctx);
		const cart = checkCart(ctx.body);
		if (!cart.ok) throw service.invalid(cart.field, cart.message);
		return quoting.view(s, await quoting.quote(s, cart.value, await service.shopper(s)));
	};

	return Object.freeze({ sweep, place, list, read, cancelByShopper, pay, downloadFile, quoteCart });
};
