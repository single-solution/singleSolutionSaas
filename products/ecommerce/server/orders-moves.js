/**
 * Moving an order through the merchant's flow, and refunds (PLAN 0.8.8). A move is allowed only when the flow allows
 * it (`core/flow.js` `canMove`, with the role rules) and the order did not change since it was read (`updatedAt`).
 * What entering a status does depends on its role:
 *
 * - `packed`: with Grades and serials on, every unit of a serialized line gets an in-stock serial number of its
 *   variant, marked sold with the order in the same transaction as the move;
 * - `shipped`: a courier of the `couriers` list and a tracking number (the tracking link is filled from the courier's
 *   template), or a booking through the courier API (Courier APIs; a failed booking moves nothing);
 * - `delivered`: cash on delivery and pay at pickup become paid; products count the units sold; loyalty points are
 *   earned (Loyalty);
 * - `cancelled`: stock, slots, offer uses and redeemed points go back once (`adapters/ledger.js` `releaseOrder`),
 *   serials go back in stock, and money paid through Payments is refunded;
 * - `returned_to_origin`: stock comes back once and the customer's RTO count rises (`returnToOrigin`);
 * - `refunded`: what is left is refunded (through Payments for what Payments took, else recorded) and earned points
 *   are taken back.
 *
 * Every move is written to the order's history with the name of the staff member who made it (a ticket's user, or the
 * one a server-token call names in its `SS-Actor-*` headers, else `Server`; PLAN 0.8.10 K2), the activity log (with the
 * order number and the move), the `order.moved` hook and the shopper's message.
 * @module
 */
import { problem } from '@ss/app-kit';
import { givePoints, heldStockBefore, releaseOrder, returnToOrigin, takePoints } from '../adapters/ledger.js';
import { courierNamed, courierOf, trackingLink } from '../core/couriers.js';
import { WAITING_ROLES as WAITING, canMove, confirmedStatus, statusOf } from '../core/flow.js';
import { expiryFor, loyaltyRules, pointsToEarn } from '../core/loyalty.js';
import { createId } from '@ss/contracts';
import { COLLECTIONS, ID_PREFIX } from '../core/model.js';
import { createOrderPayments } from './order-payments.js';
import {
	CASH_METHODS,
	earnedLeft,
	isSerialized,
	missingSerials,
	paymentStateOf,
	refundSplit,
	refundable,
	serialCheckFailure,
	serialPlan,
	stateAfterRefund,
	statusLabel,
} from '../core/orders.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('../core/model.js').OrderRecord} OrderRecord */
/** @typedef {import('../core/model.js').OrderFlow} OrderFlow */
/** @typedef {import('../core/orders.js').MoveInput} MoveInput */
/** @typedef {import('mongodb').ClientSession} Session */

/** Tries of a move whose loyalty account changed meanwhile. */
const TRIES = 3;

/**
 * A refusal raised inside a transaction (aborts it): `order` the order changed, `points` the loyalty account changed
 * (try again), or a problem for staff.
 * @param {'order' | 'points'} code
 */
const stop = (code) => Object.assign(new Error(code), { stop: code });

/** @param {unknown} error @returns {string | null} */
const stopOf = (error) =>
	typeof error === 'object' && error !== null && typeof (/** @type {any} */ (error).stop) === 'string'
		? /** @type {any} */ (error).stop
		: null;

const changed = () => problem('conflict', 'The order changed meanwhile; reload it and try again.');

/**
 * @param {Product} product
 * @param {Service} service
 */
export const createMoves = (product, service) => {
	const payments = createOrderPayments(product, service);

	/**
	 * Cancel at Payments the open payment of an order about to be cancelled or refunded before delivery (K-13): what
	 * the move then writes with it, or a refusal when the shopper paid meanwhile (the order is paid now).
	 * @param {Site} s @param {OrderRecord} order @param {string} reason
	 */
	const cancelAtPayments = async (s, order, reason) => {
		const step = await payments.beforeCancel(s, order, reason);
		if (step.paid)
			throw problem(
				'move_not_allowed',
				'The shopper paid this order meanwhile, so it is paid now: move it again to cancel and refund it.',
			);
		return step;
	};

	/**
	 * Run `work` in a transaction, again when the loyalty account changed meanwhile.
	 * @param {Site} s
	 * @param {(session: Session) => Promise<void>} work
	 */
	const transact = async (s, work) => {
		const data = await s.data();
		for (let attempt = 1; ; attempt += 1) {
			try {
				await data.transaction(work);
				return;
			} catch (error) {
				const code = stopOf(error);
				if (code === 'order') throw changed();
				if (code !== 'points' || attempt >= TRIES) throw code === 'points' ? changed() : error;
			}
		}
	};

	/**
	 * Serials of an order back in stock (cancel, return to origin); serials typed for it (E11) were never in stock, so
	 * their records go.
	 * @param {Site} s @param {string} orderId @param {Session} session
	 */
	const releaseSerials = async (s, orderId, session) => {
		const serials = (await s.data()).collection(COLLECTIONS.serials);
		await serials.deleteMany({ websiteId: s.websiteId, orderId, status: 'sold', typed: true }, { session });
		await serials.updateMany(
			{ websiteId: s.websiteId, orderId, status: 'sold' },
			{ $set: { status: 'in_stock', orderId: null, lineId: null } },
			{ session },
		);
	};

	/**
	 * The website's serial capture (E11): `registered` (picked from stock when packing) or `typed`, and the check.
	 * @param {Site} s
	 */
	const serialRules = async (s) => {
		const values = await s.values('grades_serials');
		return {
			mode: /** @type {'registered' | 'typed'} */ (values.serialMode === 'typed' ? 'typed' : 'registered'),
			check: String(values.serialCheck ?? 'none'),
		};
	};

	/**
	 * The order's products that are serialized: their own switch, else as their categories say (E11).
	 * @param {Site} s @param {OrderRecord} order
	 */
	const serializedOf = async (s, order) => {
		const data = await s.data();
		const ids = [...new Set(order.lines.filter((line) => line.kind === 'physical').map((line) => line.productId))];
		const products = await data
			.collection(COLLECTIONS.products)
			.find({ websiteId: s.websiteId, id: { $in: ids } }, { projection: { _id: 0, id: 1, serialized: 1, categoryIds: 1 } })
			.toArray();
		const categories = new Map(
			(
				await data
					.collection(COLLECTIONS.categories)
					.find({ websiteId: s.websiteId }, { projection: { _id: 0, id: 1, path: 1, requiresSerial: 1 } })
					.limit(5000)
					.toArray()
			).map((row) => [String(row.id), { path: row.path ?? [], requiresSerial: row.requiresSerial ?? null }]),
		);
		return new Set(
			products
				.filter((row) => isSerialized({ serialized: row.serialized ?? null, categoryIds: row.categoryIds ?? [] }, categories))
				.map((row) => String(row.id)),
		);
	};

	/**
	 * Write the serial numbers of a plan: registered ones move from stock to the order; typed ones (E11) are recorded as
	 * sold to it (a registered unit typed by staff is taken from stock; one sold to another order is refused).
	 * @param {Site} s @param {OrderRecord} order
	 * @param {Array<{ lineId: string, productId: string, variantId: string, serials: string[], before: string[] }>} plan
	 * @param {'registered' | 'typed'} mode @param {Session} session
	 */
	const writeSerials = async (s, order, plan, mode, session) => {
		const serials = (await s.data()).collection(COLLECTIONS.serials);
		/** @param {string} lineId @param {string} message */
		const fail = (lineId, message) =>
			Object.assign(new Error('serial'), { problem: service.invalid(`serials/${lineId}`, message) });
		for (const line of plan) {
			const removed = line.before.filter((serial) => !line.serials.includes(serial));
			if (removed.length > 0) {
				const mine = {
					websiteId: s.websiteId,
					orderId: order.id,
					lineId: line.lineId,
					serial: { $in: removed },
					status: 'sold',
				};
				await serials.deleteMany({ ...mine, typed: true }, { session });
				await serials.updateMany(mine, { $set: { status: 'in_stock', orderId: null, lineId: null } }, { session });
			}
			for (const serial of line.serials) {
				if (line.before.includes(serial)) continue;
				const taken = await serials.updateOne(
					{ websiteId: s.websiteId, variantId: line.variantId, serial, status: 'in_stock' },
					{ $set: { status: 'sold', orderId: order.id, lineId: line.lineId } },
					{ session },
				);
				if (taken.modifiedCount === 1) continue;
				if (mode === 'registered') throw fail(line.lineId, `Serial number ${serial} is not in stock for this item.`);
				const known = await serials.findOne(
					{ websiteId: s.websiteId, serial },
					{ session, projection: { _id: 0, orderId: 1 } },
				);
				if (known) throw fail(line.lineId, `Serial number ${serial} is already recorded for another unit.`);
				await serials.insertOne(
					{
						id: createId(ID_PREFIX.serial),
						productId: line.productId,
						variantId: line.variantId,
						serial,
						status: 'sold',
						orderId: order.id,
						lineId: line.lineId,
						locationId: null,
						typed: true,
					},
					{ session },
				);
			}
		}
	};

	/**
	 * The shipment of an order entering a `shipped` status.
	 * @param {Site} s @param {OrderRecord} order @param {MoveInput['shipment']} input
	 * @returns {Promise<NonNullable<OrderRecord['shipment']>>}
	 */
	const shipmentOf = async (s, order, input) => {
		if (!input) {
			if (order.role === 'shipped' && order.shipment) return order.shipment;
			throw service.invalid('shipment', 'Give the courier and the tracking number, or book the shipment.');
		}
		const couriers = await s.list('couriers');
		if ('book' in input) {
			if (!s.has('courier_apis')) throw service.invalid('shipment/book', 'Booking needs Courier APIs.');
			const key = input.courier ?? String((await s.values('courier_apis')).courier);
			const courier = key ? courierOf(couriers, key) : null;
			if (input.courier && !courier) throw service.invalid('shipment/courier', 'There is no such courier.');
			const value = await product.connections.value(s.websiteId, 'courier');
			if (!value) throw problem('courier_failed', 'Connect the courier API keys first.');
			const booked = await product.couriers.book({ order, value });
			if (!booked.ok) throw problem('courier_failed', booked.message);
			return {
				courier: courier?.name ?? '',
				trackingNumber: booked.trackingNumber,
				trackingUrl: courier ? trackingLink(courier.trackingUrl, booked.trackingNumber) : '',
				booked: true,
				status: '',
				checkedAt: null,
			};
		}
		// the courier is kept by name and its link built on read from today's list (E28); a tracking number is needed
		// unless the website says otherwise
		const courier = input.courier ? courierNamed(couriers, input.courier) : null;
		if (input.courier && !courier) throw service.invalid('shipment/courier', 'There is no such courier.');
		if (!input.trackingNumber && (await s.values('checkout')).trackingRequired !== false)
			throw service.invalid('shipment/trackingNumber', 'Give the tracking number.');
		return {
			courier: courier?.name ?? '',
			trackingNumber: input.trackingNumber,
			trackingUrl: courier && input.trackingNumber ? trackingLink(courier.trackingUrl, input.trackingNumber) : '',
			trackingNote: input.trackingNote ?? '',
			estimatedDeliveryAt: input.estimatedDeliveryAt ?? null,
			booked: false,
			status: '',
			checkedAt: null,
		};
	};

	/**
	 * Refund through Payments, naming who asked; a refusal or failure becomes the problem Payments gave.
	 * @param {Site} s @param {any} ctx @param {OrderRecord} order @param {number} amount @param {string} reason
	 * @param {string} key
	 */
	const refundOnline = (s, ctx, order, amount, reason, key) =>
		service.payments.refund(s, /** @type {string} */ (order.payment.paymentId), {
			amount,
			reason,
			idempotencyKey: key,
			by: service.actor(ctx),
		});

	/**
	 * Who an order's points belong to: the member, or the guest's customer record (E20), or nobody.
	 * @param {OrderRecord} order
	 * @returns {{ userId: string } | { customerId: string } | null}
	 */
	const ownerOf = (order) =>
		order.customer.userId
			? { userId: order.customer.userId }
			: order.customer.customerId
				? { customerId: order.customer.customerId }
				: null;

	/**
	 * A refund entry of the order's log (E26).
	 * @param {any} ctx
	 * @param {{ method: 'online' | 'bank_transfer' | 'cash' | 'other', amount: number, reference?: string,
	 *   refundId?: string | null, claimId?: string | null, note?: string, manual?: boolean }} refund
	 */
	const refundEntry = (ctx, { method, amount, reference = '', refundId = null, claimId = null, note = '', manual = false }) => ({
		id: createId(ID_PREFIX.orderRefund),
		method,
		amount,
		reference,
		claimId,
		note,
		by: service.actor(ctx),
		at: new Date(product.now()),
		refundId,
		...(manual ? { manual: true } : {}),
	});

	/**
	 * The refund entry of money given back through Payments: `online`, or — when Payments only recorded the refund and
	 * the shop returns the money by hand (a bank transfer, a gateway without a refund API, K-22) — the way it goes back
	 * (`bank_transfer` for a transfer, else `other`), marked `manual`, with Payments' refund id (OR-8).
	 * @param {any} ctx @param {{ refundId: string, manual: boolean, gateway: string }} done what Payments answered
	 * @param {{ amount: number, reference?: string, claimId?: string | null, note?: string }} refund
	 */
	const paymentsRefundEntry = (ctx, done, refund) =>
		refundEntry(ctx, {
			...refund,
			method: done.manual ? (done.gateway === 'bank_transfer' ? 'bank_transfer' : 'other') : 'online',
			refundId: done.refundId || null,
			manual: done.manual,
		});

	/**
	 * What staff are told when Payments only recorded a refund: the shopper's money is not back yet (OR-8).
	 * @param {Site} s @param {OrderRecord} order @param {number} amount
	 */
	const returnByHand = async (s, order, amount) =>
		`Return ${(await s.format()).money(amount, order.totals.currency)} to the shopper by hand: Payments only recorded the refund.`;

	/**
	 * Points of a returned or refunded order (E27): what it earned and was not taken back yet (a claim's refund may have
	 * taken some, `pointsReversed`, OR-10) is taken back, as far as the balance goes, and what it redeemed is given back,
	 * once (`released`; K-23: also when a delivered order is refunded). Never fails the move.
	 * @param {Site} s @param {OrderRecord} order @param {number} now
	 */
	const returnPoints = async (s, order, now) => {
		const owner = ownerOf(order);
		if (!owner) return;
		const data = await s.data();
		const earned = order.promotions.pointsCredited === false ? 0 : earnedLeft(order);
		const redeemed = order.promotions.released ? 0 : order.promotions.pointsRedeemed;
		if (earned <= 0 && redeemed <= 0) return;
		try {
			await transact(s, async (session) => {
				if (earned > 0) {
					const taken = await takePoints(
						data,
						{ userId: owner, points: earned, orderId: order.id, kind: 'reverse', note: order.number },
						{ now, session },
					);
					if (!taken.ok) throw stop('points');
				}
				if (redeemed > 0)
					await givePoints(
						data,
						{ userId: owner, points: redeemed, orderId: order.id, kind: 'refund', expiresAt: null, note: order.number },
						{ now, session },
					);
				await data
					.collection(COLLECTIONS.orders)
					.updateOne(
						{ websiteId: s.websiteId, id: order.id },
						{ $set: { 'promotions.released': true }, $inc: { 'promotions.pointsReversed': earned } },
						{ session },
					);
			});
		} catch {
			// the points stay as they were; staff can adjust the account
		}
	};

	/**
	 * Free the serial numbers an order took when it was packed, as it moves back to open or waiting (E27).
	 * @param {Site} s @param {OrderRecord} order
	 * @param {(session: Session | undefined, extra?: Record<string, unknown>) => Promise<void>} write
	 */
	const unpack = async (s, order, write) => {
		if (order.role !== 'packed' || !order.lines.some((line) => (line.serials ?? []).length > 0)) {
			await write(undefined);
			return;
		}
		await transact(s, async (session) => {
			await write(session, { lines: order.lines.map((line) => ({ ...line, serials: [] })) });
			await releaseSerials(s, order.id, session);
		});
	};

	/**
	 * Move an order. Throws a problem when the move is not allowed, the input is wrong or the order changed meanwhile.
	 * @param {Site} s
	 * @param {any} ctx
	 * @param {OrderRecord} order as read
	 * @param {MoveInput} input
	 * @param {OrderFlow} flow
	 * @returns {Promise<{ order: OrderRecord, warnings: string[] }>}
	 */
	const move = async (s, ctx, order, input, flow) => {
		if (input.updatedAt !== null && input.updatedAt !== new Date(order.updatedAt).toISOString()) throw changed();
		const from = order.status;
		const target = statusOf(flow, input.to);
		if (!target || !canMove(flow, from, input.to))
			throw problem(
				'move_not_allowed',
				`An order cannot move from ${statusLabel(flow, from)} to ${target ? target.label : input.to}.`,
			);
		// refunds need the refund permission, also through a move (E27)
		if (target.role === 'refunded' && ctx.ticket && !ctx.ticket.permissions.includes('orders.refund'))
			throw problem('forbidden', 'Refunding an order needs the refund permission.');
		const data = await s.data();
		const orders = data.collection(COLLECTIONS.orders);
		const now = product.now();
		const checkout = await s.values('checkout');
		const restock = checkout.returnRestock !== 'no';
		// a parcel coming back is a return to origin (counted) or a customer's return (not counted) (E27)
		const reason =
			target.role === 'returned_to_origin'
				? (input.reason ?? 'rto')
				: target.role === 'returned'
					? 'customer_return'
					: undefined;
		const entry = {
			at: new Date(now),
			from,
			to: input.to,
			by: service.actor(ctx).name,
			note: input.note,
			...(reason ? { reason } : {}),
		};
		/** @type {Record<string, unknown>} */
		const set = { status: input.to, role: target.role, holdUntil: null };
		/** @type {string[]} */
		const warnings = [];
		/** What the move adds to the order's lists: its history entry, and payment or refund entries (E26). @type {Record<string, unknown>} */
		const push = { history: entry };
		const guard = { websiteId: s.websiteId, id: order.id, status: from, updatedAt: order.updatedAt };
		/**
		 * Write the move (inside a transaction: abort when the order changed).
		 * @param {Session | undefined} session
		 * @param {Record<string, unknown>} [extra]
		 */
		const write = async (session, extra = {}) => {
			const result = await orders.updateOne(guard, { $set: { ...set, ...extra }, $push: push }, { session });
			if (result.modifiedCount !== 1) throw session ? stop('order') : changed();
		};
		/**
		 * The status change of a ledger give-back (its claim already checked `updatedAt`).
		 * @param {Session} session
		 */
		const writeReleased = async (session) => {
			const result = await orders.updateOne(
				{ websiteId: s.websiteId, id: order.id, status: from },
				{ $set: set, $push: push },
				{ session },
			);
			if (result.modifiedCount !== 1) return false;
			await releaseSerials(s, order.id, session);
			return true;
		};

		// stock an order gives back tells the alerts (E34): what its products were before
		const held = ['cancelled', 'returned_to_origin', 'returned', 'refunded'].includes(target.role)
			? await heldStockBefore(data, order)
			: null;
		switch (target.role) {
			case 'awaiting_payment': {
				// the order waits for its payment again and its window restarts (E27); serials taken when packing go back
				const minutes = Number(checkout.paymentWindowMinutes ?? 0);
				set.holdUntil = minutes > 0 ? new Date(now + minutes * 60_000) : null;
				await unpack(s, order, write);
				break;
			}
			case 'open': {
				// back from packed: the serial numbers captured are freed (E27)
				await unpack(s, order, write);
				break;
			}
			case 'packed': {
				// the dispatch video taken when packing, as the website asks (E28)
				const videoRule = String(checkout.packingVideo ?? 'off');
				if (videoRule === 'required' && !input.video && !(order.media ?? []).some((m) => m.kind === 'dispatch_video'))
					throw service.invalid('video', 'Add the dispatch video before packing.');
				if (videoRule !== 'off' && input.video) push.media = input.video;
				const { plan, mode } = await packingPlan(s, order, input);
				if (plan.length === 0) {
					await write(undefined);
					break;
				}
				await transact(s, async (session) => {
					await writeSerials(s, order, plan, mode, session);
					const byLine = new Map(plan.map((line) => [line.lineId, line.serials]));
					await write(session, {
						lines: order.lines.map((line) => (byLine.has(line.id) ? { ...line, serials: byLine.get(line.id) } : line)),
					});
				}).catch((error) => {
					throw error?.problem ?? error;
				});
				break;
			}
			case 'shipped': {
				// typed serial numbers are needed before dispatch (E11)
				if (s.has('grades_serials') && (await serialRules(s)).mode === 'typed') {
					const missing = missingSerials(order, await serializedOf(s, order));
					if (missing.length > 0)
						throw service.invalid(
							`serials/${missing[0]?.id}`,
							`Type the serial numbers of ${missing.map((line) => line.name).join(', ')} before dispatch.`,
						);
				}
				set.shipment = await shipmentOf(s, order, input.shipment);
				await write(undefined);
				break;
			}
			case 'delivered': {
				set.deliveredAt = new Date(now);
				const cash = CASH_METHODS.includes(order.payment.method);
				// cash taken at the door counts as paid on delivery, unless staff record it (E23 `paidOnDelivery: false`)
				const onDelivery = !s.has('cod') || (await s.values('cod')).paidOnDelivery !== false;
				/** @type {Record<string, unknown> | null} */
				let cashEntry = null;
				if (
					cash &&
					onDelivery &&
					order.payment.state !== 'refunded' &&
					order.payment.state !== 'partially_refunded' &&
					order.totals.total > order.payment.paid
				) {
					cashEntry = {
						id: createId(ID_PREFIX.orderPayment),
						method: 'cash',
						amount: order.totals.total - order.payment.paid,
						reference: '',
						proofKey: null,
						note: 'Paid on delivery',
						by: service.actor(ctx),
						at: new Date(now),
					};
					set['payment.state'] = 'paid';
					set['payment.paid'] = order.totals.total;
					push.payments = cashEntry;
				}
				// points go to the member, or to the guest's customer record when guests earn (E20); fixed at placement or
				// worked out now, and credited once
				const owner = order.customer.userId
					? { userId: order.customer.userId }
					: order.customer.customerId
						? { customerId: order.customer.customerId }
						: null;
				const loyalty = s.has('loyalty') && owner && !order.promotions.pointsCredited ? await s.values('loyalty') : null;
				const earns = loyalty !== null && (order.customer.userId ? true : loyaltyRules(loyalty).guests === 'earn');
				const points = !earns
					? 0
					: order.promotions.pointsFixed
						? order.promotions.pointsEarned
						: Math.max(0, Math.floor(pointsToEarn(order.totals, /** @type {Record<string, any>} */ (loyalty))));
				if (points > 0) Object.assign(set, { 'promotions.pointsEarned': points, 'promotions.pointsCredited': true });
				const timeZone = (await s.format()).timeZone || 'UTC';
				const products = data.collection(COLLECTIONS.products);
				await transact(s, async (session) => {
					await write(session);
					for (const line of order.lines)
						await products.updateOne(
							{ websiteId: s.websiteId, id: line.productId },
							{ $inc: { sold: line.quantity } },
							{ session },
						);
					if (
						loyalty &&
						points > 0 &&
						!(await givePoints(
							data,
							{
								userId: /** @type {any} */ (owner),
								points,
								orderId: order.id,
								kind: 'earn',
								expiresAt: expiryFor(now, /** @type {Record<string, any>} */ (loyalty), timeZone),
								note: order.number,
							},
							{ now, session },
						))
					)
						throw stop('points');
				});
				break;
			}
			case 'cancelled': {
				// before shipping or a recalled parcel (E27): its open payment is cancelled at Payments first (K-13), then
				// everything is given back once
				const step = await cancelAtPayments(s, order, input.note || 'Order cancelled');
				Object.assign(set, step.set);
				if (!(await releaseOrder(data, order, { now, update: writeReleased }))) throw changed();
				await payments.afterCancel(
					s,
					/** @type {OrderRecord} */ (
						await orders.findOne({ websiteId: s.websiteId, id: order.id }, { projection: { _id: 0 } })
					),
					step,
				);
				const { online } = refundSplit(order, refundable(order));
				if (online > 0) {
					try {
						const done = await refundOnline(s, ctx, order, online, input.note || 'Order cancelled', `${order.id}:cancel`);
						const refunded = order.payment.refunded + online;
						await orders.updateOne(
							{ websiteId: s.websiteId, id: order.id },
							{
								$set: { 'payment.refunded': refunded, 'payment.state': stateAfterRefund(order.payment.paid, refunded) },
								$push: { refunds: paymentsRefundEntry(ctx, done, { amount: online, note: 'Order cancelled' }) },
							},
						);
						if (done.manual) warnings.push(await returnByHand(s, order, online));
					} catch (error) {
						warnings.push(
							`The order is cancelled but the refund failed (${/** @type {any} */ (error).detail}); refund it from the order.`,
						);
					}
				}
				break;
			}
			case 'returned_to_origin': {
				// an RTO counts on the customer's record, a customer's return does not; stock as `returnRestock` says (E27)
				const done = await returnToOrigin(data, order, {
					update: writeReleased,
					restock,
					countRto: reason !== 'customer_return',
				});
				if (!done) throw changed();
				break;
			}
			case 'returned': {
				// a customer's return after delivery (E27): stock as `returnRestock` says; earned points are taken back and
				// redeemed ones given back
				if (!(await returnToOrigin(data, order, { update: writeReleased, restock, countRto: false }))) throw changed();
				await returnPoints(s, order, now);
				break;
			}
			case 'refunded': {
				const amount = refundable(order);
				const before = !['delivered', 'returned_to_origin', 'returned'].includes(order.role);
				// before delivery a refund acts as a cancel, and only when something was paid (E27)
				if (before && order.payment.paid <= 0)
					throw problem('nothing_paid', 'Nothing was paid on this order; cancel it instead.');
				const note = input.note || 'Order refunded';
				// as a cancel: a payment still open at Payments is cancelled there first (K-13)
				if (before) Object.assign(set, (await cancelAtPayments(s, order, note)).set);
				const { online, manual } = refundSplit(order, amount);
				const done =
					online > 0
						? await refundOnline(s, ctx, order, online, note, `${order.id}:refund:${order.payment.refunded}`)
						: null;
				if (amount > 0) {
					set['payment.refunded'] = order.payment.paid;
					set['payment.state'] = 'refunded';
					push.refunds = {
						$each: [
							...(done ? [paymentsRefundEntry(ctx, done, { amount: online, note })] : []),
							...(manual > 0 ? [refundEntry(ctx, { method: 'other', amount: manual, note })] : []),
						],
					};
				}
				if (done?.manual) warnings.push(await returnByHand(s, order, online));
				if (before) {
					if (!(await releaseOrder(data, order, { now, update: writeReleased }))) throw changed();
					break;
				}
				// after delivery: earned points not taken back yet are taken back (an order refunded before delivery earned
				// none) and redeemed ones given back, once (K-23)
				await write(undefined);
				await returnPoints(s, order, now);
				break;
			}
			default:
				await write(undefined);
		}

		const after = /** @type {OrderRecord} */ (
			await orders.findOne({ websiteId: s.websiteId, id: order.id }, { projection: { _id: 0 } })
		);
		await service.log(ctx, 'order.moved', order.id, {
			label: order.number,
			detail: `${statusLabel(flow, from)} → ${target.label}`,
		});
		if (held && order.stockHeld && !after.stockHeld) await service.emit('products.changed', s, held);
		await service.emit('order.moved', s, {
			order: after,
			from,
			to: input.to,
			by: entry.by,
			// the note staff typed with the move: a cancel's reason in messages and alerts (K-10)
			note: entry.note,
			...(reason ? { reason } : {}),
		});
		return { order: after, warnings };
	};

	/**
	 * The serial numbers to capture when packing (none while Grades and serials is off): with registered serials every
	 * unit's, with typed ones those typed now (E11).
	 * @param {Site} s @param {OrderRecord} order @param {MoveInput} input
	 */
	const packingPlan = async (s, order, input) => {
		if (!s.has('grades_serials')) return { plan: [], mode: /** @type {'registered' | 'typed'} */ ('registered') };
		const { mode, check } = await serialRules(s);
		const refused = serialCheckFailure(input.serials, check);
		if (refused) throw service.invalid(refused.field, refused.message);
		const plan = serialPlan(order, await serializedOf(s, order), input.serials, { mode });
		if (!plan.ok) throw service.invalid(plan.field, plan.message);
		return { plan: plan.value.filter((line) => line.serials.length > 0 || line.before.length > 0), mode };
	};

	/**
	 * Type serial numbers of a packed, shipped or delivered order (typed serials, E11): one per unit of each line sent.
	 * @param {Site} s @param {any} ctx @param {OrderRecord} order @param {Record<string, string[]>} sent
	 * @returns {Promise<OrderRecord>}
	 */
	const typeSerials = async (s, ctx, order, sent) => {
		if (!s.has('grades_serials')) throw service.invalid('serials', 'Switch on Grades and serials first.');
		const { mode, check } = await serialRules(s);
		if (mode !== 'typed') throw service.invalid('serials', 'Serial numbers are picked from stock when the order is packed.');
		if (!['packed', 'shipped', 'delivered'].includes(order.role))
			throw service.invalid('serials', 'Serial numbers are typed once the order is packed.');
		const refused = serialCheckFailure(sent, check);
		if (refused) throw service.invalid(refused.field, refused.message);
		const plan = serialPlan(order, await serializedOf(s, order), sent, { mode, only: true });
		if (!plan.ok) throw service.invalid(plan.field, plan.message);
		const orders = (await s.data()).collection(COLLECTIONS.orders);
		const byLine = new Map(plan.value.map((line) => [line.lineId, line.serials]));
		await transact(s, async (session) => {
			await writeSerials(s, order, plan.value, mode, session);
			const result = await orders.updateOne(
				{ websiteId: s.websiteId, id: order.id, updatedAt: order.updatedAt },
				{
					$set: {
						lines: order.lines.map((line) => (byLine.has(line.id) ? { ...line, serials: byLine.get(line.id) } : line)),
					},
					$push: {
						history: {
							at: new Date(product.now()),
							from: order.status,
							to: order.status,
							by: service.actor(ctx).name,
							note: 'Serial numbers typed',
						},
					},
				},
				{ session },
			);
			if (result.modifiedCount !== 1) throw stop('order');
		}).catch((error) => {
			throw error?.problem ?? error;
		});
		await service.log(ctx, 'order.serials_typed', order.id, {
			label: order.number,
			detail: `${[...byLine.values()].flat().length} serial number(s)`,
		});
		return /** @type {OrderRecord} */ (
			await orders.findOne({ websiteId: s.websiteId, id: order.id }, { projection: { _id: 0 } })
		);
	};

	/**
	 * Refund part of what was paid without a status change (E26): through Payments for what Payments took (or as asked),
	 * the rest recorded as given back by `method`, with its reference and the claim it is for. With `autoRefundedStatus`,
	 * an order whose refunds reach what was paid moves to its refunded status.
	 * @param {Site} s
	 * @param {any} ctx
	 * @param {OrderRecord} order
	 * @param {import('../core/orders.js').RefundInput} input
	 */
	const refund = async (s, ctx, order, input) => {
		const split = refundSplit(order, input.amount);
		const online = input.method === null || input.method === 'online' ? split.online : 0;
		const manual = input.amount - online;
		if (input.method === 'online' && manual > 0)
			throw service.invalid('amount', `At most ${split.online} can be refunded through Payments.`);
		const done =
			online > 0
				? await refundOnline(s, ctx, order, online, input.reason, `${order.id}:refund:${order.payment.refunded}`)
				: null;
		const refundId = done ? done.refundId : null;
		const recorded = manual > 0 || done?.manual === true;
		const refunded = order.payment.refunded + input.amount;
		const money = (await s.format()).money(input.amount, order.totals.currency);
		const recordedMethod = input.method === null || input.method === 'online' ? 'other' : input.method;
		const entries = [
			...(done
				? [
						paymentsRefundEntry(ctx, done, {
							amount: online,
							reference: input.reference,
							claimId: input.claimId,
							note: input.reason,
						}),
					]
				: []),
			...(manual > 0
				? [
						refundEntry(ctx, {
							method: recordedMethod,
							amount: manual,
							reference: input.reference,
							claimId: input.claimId,
							note: input.reason,
						}),
					]
				: []),
		];
		const orders = (await s.data()).collection(COLLECTIONS.orders);
		const result = await orders.updateOne(
			{ websiteId: s.websiteId, id: order.id, 'payment.refunded': order.payment.refunded },
			{
				$set: { 'payment.refunded': refunded, 'payment.state': stateAfterRefund(order.payment.paid, refunded) },
				$push: {
					refunds: { $each: entries },
					history: {
						at: new Date(product.now()),
						from: order.status,
						to: order.status,
						by: service.actor(ctx).name,
						note: `Refunded ${money}${recorded ? ' (recorded)' : ''}: ${input.reason}`,
						kind: 'refund',
					},
				},
			},
		);
		if (result.modifiedCount !== 1) throw changed();
		await service.log(ctx, 'order.refunded', order.id, {
			label: order.number,
			detail: `Refunded ${money}${recorded ? ' (recorded)' : ''}`,
		});
		let after = /** @type {OrderRecord} */ (
			await orders.findOne({ websiteId: s.websiteId, id: order.id }, { projection: { _id: 0 } })
		);
		await service.emit('order.refunded', s, { order: after, amount: input.amount, claimId: input.claimId });
		/** @type {string[]} */
		const warnings = done?.manual ? [await returnByHand(s, order, online)] : [];
		if ((await s.values('checkout')).autoRefundedStatus === true && after.payment.paid > 0 && refunded >= after.payment.paid) {
			const flow = /** @type {OrderFlow} */ (/** @type {unknown} */ (await s.list('order_flow')));
			const to = flow.statuses.find((status) => status.role === 'refunded' && canMove(flow, after.status, status.key));
			if (to) {
				const moved = await move(
					s,
					ctx,
					after,
					{ to: to.key, note: 'Refunds cover the payments', serials: {}, shipment: null, updatedAt: null },
					flow,
				);
				after = moved.order;
				warnings.push(...moved.warnings);
			}
		}
		return { order: after, refund: { amount: input.amount, online, manual, refundId, recorded }, warnings, entries };
	};

	/**
	 * Record a payment staff took (E26): a bank transfer, cash or another way, at most the balance due. With `confirm`, a
	 * waiting order moves to its confirmed status in the same call.
	 * @param {Site} s
	 * @param {any} ctx
	 * @param {OrderRecord} order
	 * @param {import('../core/orders.js').PaymentInput} input
	 * @param {OrderFlow} flow
	 */
	const recordPayment = async (s, ctx, order, input, flow) => {
		const now = product.now();
		const paid = order.payment.paid + input.amount;
		const state = paymentStateOf({
			total: order.totals.total,
			paid,
			refunded: order.payment.refunded,
			state: order.payment.state,
		});
		const money = (await s.format()).money(input.amount, order.totals.currency);
		const entry = {
			id: createId(ID_PREFIX.orderPayment),
			method: input.method,
			amount: input.amount,
			reference: input.reference,
			proofKey: order.payment.proof?.key ?? null,
			note: input.note,
			by: service.actor(ctx),
			at: new Date(now),
		};
		const orders = (await s.data()).collection(COLLECTIONS.orders);
		const result = await orders.updateOne(
			{ websiteId: s.websiteId, id: order.id, 'payment.paid': order.payment.paid },
			{
				$set: { 'payment.paid': paid, 'payment.state': state, 'payment.checkedAt': new Date(now) },
				$push: {
					payments: entry,
					history: {
						at: new Date(now),
						from: order.status,
						to: order.status,
						by: service.actor(ctx).name,
						note: `Payment of ${money} recorded${input.reference ? ` (${input.reference})` : ''}`,
						kind: 'payment',
					},
				},
			},
		);
		if (result.modifiedCount !== 1) throw changed();
		await service.log(ctx, 'order.payment_recorded', order.id, { label: order.number, detail: `${money} by ${input.method}` });
		let after = /** @type {OrderRecord} */ (
			await orders.findOne({ websiteId: s.websiteId, id: order.id }, { projection: { _id: 0 } })
		);
		await service.emit('order.payment_recorded', s, { order: after, entry });
		if (state === 'paid' && order.payment.state !== 'paid') await service.emit('order.paid', s, { order: after, entry });
		/** @type {string[]} */
		const warnings = [];
		if (input.confirm && WAITING.includes(after.role)) {
			const to = confirmedStatus(flow, after.status);
			if (!to) throw problem('move_not_allowed', 'The order flow has no move from this status to a confirmed one.');
			const moved = await move(
				s,
				ctx,
				after,
				{ to, note: 'Payment recorded', serials: {}, shipment: null, updatedAt: null },
				flow,
			);
			after = moved.order;
			warnings.push(...moved.warnings);
		}
		return { order: after, warnings };
	};

	/**
	 * Give back what an order holds before it is deleted (E31), as a cancel does: its stock and slots, offer uses and
	 * redeemed points (once), and its serial numbers. With `payments`, its open Payments payment is cancelled first and
	 * a payment made meanwhile refuses the delete (K-13).
	 * @param {Site} s @param {OrderRecord} order @param {{ payments?: boolean }} [options]
	 */
	const giveBack = async (s, order, { payments: cancelPayment = false } = {}) => {
		// delivered, returned and settled orders hold nothing any more (what was sold stays sold)
		if (!['awaiting_payment', 'awaiting_confirmation', 'open', 'packed', 'shipped'].includes(order.role)) return;
		if (cancelPayment && (await payments.beforeCancel(s, order, 'Order deleted')).paid)
			throw problem('conflict', 'This order was paid meanwhile; refund it before deleting it.');
		const data = await s.data();
		if (order.stockHeld || !order.promotions.released)
			await releaseOrder(data, order, {
				now: product.now(),
				update: async (session) => {
					await releaseSerials(s, order.id, session);
					return true;
				},
			});
		else await data.transaction((session) => releaseSerials(s, order.id, session));
	};

	return Object.freeze({ move, refund, recordPayment, giveBack, typeSerials, serializedOf, recheck: payments.recheck });
};

/** @typedef {ReturnType<typeof createMoves>} Moves */
