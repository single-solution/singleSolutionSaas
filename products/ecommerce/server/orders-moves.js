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
import { expiryFor, loyaltyRules, pointsToEarn } from '../core/loyalty.js';
import { createId } from '@ss/contracts';
import { COLLECTIONS, ID_PREFIX } from '../core/model.js';
import {
	CASH_METHODS,
	isSerialized,
	missingSerials,
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
				if (cash && order.payment.state !== 'refunded' && order.payment.state !== 'partially_refunded') {
					set['payment.state'] = 'paid';
					set['payment.paid'] = order.totals.total;
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
				// only points that were credited are taken back (an order refunded before delivery earned none)
				const earned = order.promotions.pointsCredited === false ? 0 : order.promotions.pointsEarned;
				const owner = order.customer.userId
					? { userId: order.customer.userId }
					: order.customer.customerId
						? { customerId: order.customer.customerId }
						: null;
				if (earned > 0 && owner)
					await transact(s, async (session) => {
						await write(session);
						const taken = await takePoints(
							data,
							{ userId: owner, points: earned, orderId: order.id, kind: 'reverse', note: order.number },
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

	return Object.freeze({ move, refund, typeSerials, serializedOf });
};

/** @typedef {ReturnType<typeof createMoves>} Moves */
