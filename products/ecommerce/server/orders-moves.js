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
import { givePoints, releaseOrder, returnToOrigin, takePoints } from '../adapters/ledger.js';
import { courierOf, trackingLink } from '../core/couriers.js';
import { canMove, statusOf } from '../core/flow.js';
import { expiryFor, pointsToEarn } from '../core/loyalty.js';
import { COLLECTIONS } from '../core/model.js';
import { CASH_METHODS, refundSplit, refundable, serialPlan, stateAfterRefund, statusLabel } from '../core/orders.js';
import { createOrderMessages } from './order-messages.js';

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
	const messages = createOrderMessages(service);

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
	 * Serials of an order back in stock (cancel, return to origin).
	 * @param {Site} s @param {string} orderId @param {Session} session
	 */
	const releaseSerials = async (s, orderId, session) =>
		(await s.data())
			.collection(COLLECTIONS.serials)
			.updateMany(
				{ websiteId: s.websiteId, orderId, status: 'sold' },
				{ $set: { status: 'in_stock', orderId: null, lineId: null } },
				{ session },
			);

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
		const courier = courierOf(couriers, input.courier);
		if (!courier) throw service.invalid('shipment/courier', 'There is no such courier.');
		return {
			courier: courier.name,
			trackingNumber: input.trackingNumber,
			trackingUrl: trackingLink(courier.trackingUrl, input.trackingNumber),
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
		const data = await s.data();
		const orders = data.collection(COLLECTIONS.orders);
		const now = product.now();
		const entry = { at: new Date(now), from, to: input.to, by: service.actor(ctx).name, note: input.note };
		/** @type {Record<string, unknown>} */
		const set = { status: input.to, role: target.role, holdUntil: null };
		/** @type {string[]} */
		const warnings = [];
		const guard = { websiteId: s.websiteId, id: order.id, status: from, updatedAt: order.updatedAt };
		/**
		 * Write the move (inside a transaction: abort when the order changed).
		 * @param {Session | undefined} session
		 * @param {Record<string, unknown>} [extra]
		 */
		const write = async (session, extra = {}) => {
			const result = await orders.updateOne(guard, { $set: { ...set, ...extra }, $push: { history: entry } }, { session });
			if (result.modifiedCount !== 1) throw session ? stop('order') : changed();
		};
		/**
		 * The status change of a ledger give-back (its claim already checked `updatedAt`).
		 * @param {Session} session
		 */
		const writeReleased = async (session) => {
			const result = await orders.updateOne(
				{ websiteId: s.websiteId, id: order.id, status: from },
				{ $set: set, $push: { history: entry } },
				{ session },
			);
			if (result.modifiedCount !== 1) return false;
			await releaseSerials(s, order.id, session);
			return true;
		};

		switch (target.role) {
			case 'packed': {
				const plan = await packingPlan(s, order, input);
				if (plan.length === 0) {
					await write(undefined);
					break;
				}
				const serials = data.collection(COLLECTIONS.serials);
				await transact(s, async (session) => {
					for (const line of plan) {
						const removed = line.before.filter((serial) => !line.serials.includes(serial));
						if (removed.length > 0)
							await serials.updateMany(
								{
									websiteId: s.websiteId,
									orderId: order.id,
									lineId: line.lineId,
									serial: { $in: removed },
									status: 'sold',
								},
								{ $set: { status: 'in_stock', orderId: null, lineId: null } },
								{ session },
							);
						for (const serial of line.serials) {
							if (line.before.includes(serial)) continue;
							const taken = await serials.updateOne(
								{ websiteId: s.websiteId, variantId: line.variantId, serial, status: 'in_stock' },
								{ $set: { status: 'sold', orderId: order.id, lineId: line.lineId } },
								{ session },
							);
							if (taken.modifiedCount !== 1)
								throw Object.assign(new Error('serial'), {
									problem: service.invalid(
										`serials/${line.lineId}`,
										`Serial number ${serial} is not in stock for this item.`,
									),
								});
						}
					}
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
				set.shipment = await shipmentOf(s, order, input.shipment);
				await write(undefined);
				break;
			}
			case 'delivered': {
				set.deliveredAt = new Date(now);
				const cash = CASH_METHODS.includes(order.payment.method);
				if (cash && order.payment.state !== 'refunded' && order.payment.state !== 'partially_refunded') {
					set['payment.state'] = 'paid';
					set['payment.paid'] = order.totals.total;
				}
				const loyalty = s.has('loyalty') && order.customer.userId ? await s.values('loyalty') : null;
				const points = loyalty ? Math.max(0, Math.floor(pointsToEarn(order.totals, loyalty))) : 0;
				if (points > 0) set['promotions.pointsEarned'] = points;
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
								userId: order.customer.userId,
								points,
								orderId: order.id,
								kind: 'earn',
								expiresAt: expiryFor(now, loyalty),
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
				if (!(await releaseOrder(data, order, { now, update: writeReleased }))) throw changed();
				const { online } = refundSplit(order, refundable(order));
				if (online > 0) {
					try {
						const refunded = order.payment.refunded + online;
						await refundOnline(s, ctx, order, online, input.note || 'Order cancelled', `${order.id}:cancel`);
						await orders.updateOne(
							{ websiteId: s.websiteId, id: order.id },
							{ $set: { 'payment.refunded': refunded, 'payment.state': stateAfterRefund(order.payment.paid, refunded) } },
						);
					} catch (error) {
						warnings.push(
							`The order is cancelled but the refund failed (${/** @type {any} */ (error).detail}); refund it from the order.`,
						);
					}
				}
				break;
			}
			case 'returned_to_origin': {
				if (!(await returnToOrigin(data, order, { update: writeReleased }))) throw changed();
				break;
			}
			case 'refunded': {
				const amount = refundable(order);
				const { online } = refundSplit(order, amount);
				if (online > 0)
					await refundOnline(
						s,
						ctx,
						order,
						online,
						input.note || 'Order refunded',
						`${order.id}:refund:${order.payment.refunded}`,
					);
				if (amount > 0) {
					set['payment.refunded'] = order.payment.paid;
					set['payment.state'] = 'refunded';
				}
				const earned = order.promotions.pointsEarned;
				if (earned > 0 && order.customer.userId)
					await transact(s, async (session) => {
						await write(session);
						const taken = await takePoints(
							data,
							{ userId: order.customer.userId, points: earned, orderId: order.id, kind: 'reverse', note: order.number },
							{ now, session },
						);
						if (!taken.ok) throw stop('points');
					});
				else await write(undefined);
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
		await service.emit('order.moved', s, { order: after, from, to: input.to });
		await messages.status(s, after, target.label);
		return { order: after, warnings };
	};

	/**
	 * The serial numbers to capture when packing (none while Grades and serials is off).
	 * @param {Site} s @param {OrderRecord} order @param {MoveInput} input
	 */
	const packingPlan = async (s, order, input) => {
		if (!s.has('grades_serials')) return [];
		const ids = [...new Set(order.lines.filter((line) => line.kind === 'physical').map((line) => line.productId))];
		const serialized = await (
			await s.data()
		)
			.collection(COLLECTIONS.products)
			.find({ websiteId: s.websiteId, id: { $in: ids }, serialized: true }, { projection: { _id: 0, id: 1 } })
			.toArray();
		const plan = serialPlan(order, new Set(serialized.map((row) => String(row.id))), input.serials);
		if (!plan.ok) throw service.invalid(plan.field, plan.message);
		return plan.value;
	};

	/**
	 * Refund part of what was paid without a status change: through Payments for what Payments took, the rest is
	 * recorded as given back by hand (`manual`).
	 * @param {Site} s
	 * @param {any} ctx
	 * @param {OrderRecord} order
	 * @param {{ amount: number, reason: string }} input
	 */
	const refund = async (s, ctx, order, input) => {
		const { online, manual } = refundSplit(order, input.amount);
		/** @type {string | null} */
		let refundId = null;
		let recorded = manual > 0;
		if (online > 0) {
			const done = await refundOnline(s, ctx, order, online, input.reason, `${order.id}:refund:${order.payment.refunded}`);
			refundId = done.refundId;
			recorded = recorded || done.manual;
		}
		const refunded = order.payment.refunded + input.amount;
		const money = (await s.format()).money(input.amount, order.totals.currency);
		const orders = (await s.data()).collection(COLLECTIONS.orders);
		const result = await orders.updateOne(
			{ websiteId: s.websiteId, id: order.id, 'payment.refunded': order.payment.refunded },
			{
				$set: { 'payment.refunded': refunded, 'payment.state': stateAfterRefund(order.payment.paid, refunded) },
				$push: {
					history: {
						at: new Date(product.now()),
						from: order.status,
						to: order.status,
						by: service.actor(ctx).name,
						note: `Refunded ${money}${recorded ? ' (recorded)' : ''}: ${input.reason}`,
					},
				},
			},
		);
		if (result.modifiedCount !== 1) throw changed();
		await service.log(ctx, 'order.refunded', order.id, {
			label: order.number,
			detail: `Refunded ${money}${recorded ? ' (recorded)' : ''}`,
		});
		return {
			order: /** @type {OrderRecord} */ (
				await orders.findOne({ websiteId: s.websiteId, id: order.id }, { projection: { _id: 0 } })
			),
			refund: { amount: input.amount, online, manual, refundId, recorded },
		};
	};

	return Object.freeze({ move, refund });
};

/** @typedef {ReturnType<typeof createMoves>} Moves */
