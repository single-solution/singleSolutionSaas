/**
 * Moving an order through the merchant's flow, and refunds (PLAN 0.8.8). A move is allowed only when the flow lists it
 * for staff (`core/flow.js` `moveOf`, with the role rules), the staff ticket has the move's permission, staff give what
 * it needs (a note, a note for the shopper, the answer to whether the items go back in stock), the order's role is
 * still the flow's role of its status (`flow_changed`) and the order did not change since it was read (`updatedAt`).
 * The move's options (PLAN 0.8.10 dynamic model phase 2) say what it records and asks. Every move is planned by the order
 * engine (`core/transitions.js`) and run in one transaction with everything it gives back or takes
 * (`server/transitions.js`); what entering a status does depends on its role:
 *
 * - `packed`: with Grades and serials on, every unit of a serialized line gets an in-stock serial number of its
 *   variant, marked sold with the order in the same transaction as the move;
 * - `shipped`: a courier of the `couriers` list and a tracking number (the tracking link is filled from the courier's
 *   template), or a booking through the courier API (Courier APIs; a failed booking moves nothing);
 * - `delivered`: cash on delivery and pay at pickup become paid; products count the units sold; loyalty points are
 *   earned (Loyalty);
 * - `cancelled`: stock, slots, offer uses and redeemed points go back once, serials go back in stock, and money paid
 *   through Payments is refunded right after (a refund Payments cannot take now stays pending on the order and is
 *   tried again on use);
 * - `returned_to_origin`: stock comes back once and the customer's RTO count rises;
 * - `refunded`: what is left is refunded (through Payments for what Payments took, else recorded) and earned points
 *   are taken back.
 *
 * What a move needs is checked before anything is called: the shipment (its tracking number as the move's `tracking`
 * says), the serial numbers (every one before the parcel goes out when the move `needs` units) and the dispatch video
 * (the move's `video`); then the open Payments payment is cancelled (K-13), a shipment booked and a refund made, as the
 * move needs. A staff refund (`refund`) goes through the order's refund lock (`server/transitions.js` `lockedRefund`).
 *
 * Every move is written to the order's history with the name of the staff member who made it (a ticket's user, or the
 * one a server-token call names in its `SS-Actor-*` headers, else `Server`; PLAN 0.8.10 K2) and its kind, the activity
 * log (with the order number and the move), the `order.moved` hook and the shopper's message. Notes the server writes
 * itself and the warnings staff get carry a code and values besides their English (PLAN 0.4.10).
 * @module
 */
import { problem } from '@ss/app-kit';
import { heldStockBefore } from '../adapters/ledger.js';
import { courierNamed, courierOf, trackingLink } from '../core/couriers.js';
import { BEFORE_DELIVERY_ROLES, WAITING_ROLES as WAITING, canMove, confirmedStatus, triggersOfFlow } from '../core/flow.js';
import { createId } from '@ss/contracts';
import { COLLECTIONS, ID_PREFIX } from '../core/model.js';
import {
	checkTransition,
	choicesOf,
	nothingPaid,
	paymentsRefundEntry,
	planRelease,
	planTransition,
	planUnits,
	refundEntry,
} from '../core/transitions.js';
import { createOrderPayments } from './order-payments.js';
import { createTransitions, rulesOf } from './transitions.js';
import {
	CASH_METHODS,
	byActor,
	isSerialized,
	missingSerials,
	orderMoney,
	paymentStateOf,
	refundSplit,
	serialCheckFailure,
	serialPlan,
	serverNote,
	stateAfterRefund,
	statusLabel,
} from '../core/orders.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('../core/model.js').OrderRecord} OrderRecord */
/** @typedef {import('../core/model.js').OrderFlow} OrderFlow */
/** @typedef {import('../core/orders.js').MoveInput} MoveInput */
/** @typedef {import('../core/orders.js').Warning} Warning */

const changed = () => problem('conflict', 'The order changed meanwhile; reload it and try again.');

/**
 * @param {Product} product
 * @param {Service} service
 */
export const createMoves = (product, service) => {
	const payments = createOrderPayments(product, service);
	const transitions = createTransitions(product, service);

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
			).map((row) => [String(row.id), { path: row.path, requiresSerial: row.requiresSerial }]),
		);
		return new Set(
			products
				.filter((row) => isSerialized({ serialized: row.serialized, categoryIds: row.categoryIds }, categories))
				.map((row) => String(row.id)),
		);
	};

	/**
	 * The shipment of an order entering a `shipped` status as staff give it, checked; a booking through the courier
	 * API is only prepared here (`book`), and made after every other check.
	 * @param {Site} s @param {OrderRecord} order @param {MoveInput['shipment']} input
	 * @param {boolean} trackingRequired the move needs a tracking number (its `tracking` option)
	 * @returns {Promise<{ shipment: NonNullable<OrderRecord['shipment']> } | { book: (() => Promise<NonNullable<OrderRecord['shipment']>>) }>}
	 */
	const shipmentOf = async (s, order, input, trackingRequired) => {
		if (!input) {
			if (order.role === 'shipped' && order.shipment) return { shipment: order.shipment };
			throw service.invalid('shipment', 'Give the courier and the tracking number, or book the shipment.');
		}
		const couriers = await s.list('couriers');
		if ('book' in input) {
			if (!s.has('courier_apis')) throw service.invalid('shipment/book', 'Booking needs Courier APIs.');
			const key = input.courier ?? String((await s.values('courier_apis')).courier);
			const courier = key ? courierOf(couriers, key) : null;
			if (input.courier && !courier) throw service.invalid('shipment/courier', 'There is no such courier.');
			// a parcel booked for it already (a move that failed after the booking) ships with that booking, never booked
			// twice
			const booked = order.shipment;
			if (booked?.booked && booked.trackingNumber && (!input.courier || courier?.name === booked.courier))
				return { shipment: booked };
			const value = await product.connections.value(s.websiteId, 'courier');
			if (!value) throw problem('courier_failed', 'Connect the courier API keys first.');
			return {
				book: async () => {
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
				},
			};
		}
		// the courier is kept by name and its link built on read from today's list (E28); a tracking number is needed
		// unless the move says otherwise
		const courier = input.courier ? courierNamed(couriers, input.courier) : null;
		if (input.courier && !courier) throw service.invalid('shipment/courier', 'There is no such courier.');
		if (!input.trackingNumber && trackingRequired)
			throw service.invalid('shipment/trackingNumber', 'Give the tracking number.');
		return {
			shipment: {
				courier: courier?.name ?? '',
				trackingNumber: input.trackingNumber,
				trackingUrl: courier && input.trackingNumber ? trackingLink(courier.trackingUrl, input.trackingNumber) : '',
				trackingNote: input.trackingNote ?? '',
				estimatedDeliveryAt: input.estimatedDeliveryAt ?? null,
				booked: false,
				status: '',
				checkedAt: null,
			},
		};
	};

	/**
	 * What staff are told when Payments only recorded a refund: the shopper's money is not back yet (OR-8).
	 * @param {Site} s @param {OrderRecord} order @param {number} amount
	 * @returns {Promise<Warning>}
	 */
	const returnByHand = async (s, order, amount) => ({
		code: 'refund_by_hand',
		values: { amount },
		text: `Return ${(await s.format()).money(amount, order.totals.currency)} to the shopper by hand: Payments only recorded the refund.`,
	});

	/**
	 * The payment a move out of waiting records when the order's method counts as paid then (`paidOnConfirm`, OR-7):
	 * the balance due, as a payment of the order's method (cash for cash on delivery and pay at pickup), after its open
	 * Payments payment is cancelled (K-13); null when the move records none.
	 * @param {Site} s @param {any} ctx @param {OrderRecord} order @param {import('../core/model.js').StatusRole} to
	 * @param {ReadonlyArray<string>} methods the move's `paidOnConfirm`
	 */
	const paidOnConfirm = async (s, ctx, order, to, methods) => {
		const { due } = orderMoney(order);
		if (!WAITING.includes(order.role) || !['open', 'packed', 'shipped'].includes(to) || !methods.includes(order.payment.method))
			return null;
		if (due <= 0) return null;
		const step = await payments.beforeCancel(s, order, 'Paid by hand');
		if (step.paid || step.late) throw problem('move_not_allowed', 'Payments says this order was paid meanwhile; reload it.');
		if (!step.reached)
			throw problem('payments_unavailable', 'Payments cannot be reached to cancel the order’s payment there. Try again.');
		const paid = order.payment.paid + due;
		const entry = {
			id: createId(ID_PREFIX.orderPayment),
			method:
				order.payment.method === 'bank_transfer'
					? 'bank_transfer'
					: CASH_METHODS.includes(order.payment.method)
						? 'cash'
						: 'other',
			amount: due,
			reference: order.payment.proof?.reference ?? '',
			proofKey: order.payment.proof?.key ?? null,
			note: 'Paid on confirmation',
			by: service.actor(ctx),
			at: new Date(product.now()),
		};
		const state = paymentStateOf({
			total: order.totals.total,
			paid,
			refunded: order.payment.refunded,
			state: order.payment.state,
		});
		return { entry, set: { ...step.set, 'payment.paid': paid, 'payment.state': state }, step };
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
	 * Move an order. Throws a problem when the move is not allowed, the input is wrong or the order changed meanwhile.
	 * `trigger`: the shop makes the move by itself for staff (refunds that cover the payments): any listed move, without
	 * what staff would give (a move that asks whether the items go back in stock takes no).
	 * @param {Site} s
	 * @param {any} ctx
	 * @param {OrderRecord} order as read
	 * @param {MoveInput} input
	 * @param {OrderFlow} flow
	 * @param {{ trigger?: boolean }} [how]
	 * @returns {Promise<{ order: OrderRecord, warnings: Warning[] }>}
	 */
	const move = async (s, ctx, order, input, flow, { trigger = false } = {}) => {
		if (input.updatedAt !== null && input.updatedAt !== new Date(order.updatedAt).toISOString()) throw changed();
		const from = order.status;
		const checked = checkTransition({ order, flow, to: input.to, who: trigger ? 'system' : 'staff' });
		if (!checked.ok) throw problem(checked.code, checked.message);
		const target = checked.target;
		const rules = /** @type {NonNullable<typeof checked.move>} */ (checked.move);
		// the permission the move needs of a staff ticket (into a refunded status always the refund permission, E27)
		if (ctx.ticket && !ctx.ticket.permissions.includes(rules.permission))
			throw problem(
				'forbidden',
				rules.permission === 'orders.refund'
					? 'Refunding an order needs the refund permission.'
					: `This move needs the permission ${rules.permission}.`,
			);
		// what staff give with it
		if (!trigger) {
			if (rules.needs.includes('note') && !input.note) throw service.invalid('note', 'This move needs a note.');
			if (rules.needs.includes('reason') && !input.shopperNote)
				throw service.invalid('shopperNote', 'This move needs a note for the shopper.');
			if (input.restock !== undefined && rules.options.restock !== 'ask')
				throw service.invalid('restock', 'This move does not ask whether the items go back in stock.');
		}
		const chosen = choicesOf({
			move: rules,
			from: order.role,
			to: target.role,
			input: { who: 'staff', trigger, ...(input.restock === undefined ? {} : { restock: input.restock }) },
		});
		if (!chosen.ok) throw service.invalid(chosen.field ?? 'restock', chosen.message);
		const data = await s.data();
		const now = product.now();
		const actor = service.actor(ctx);

		// what the move needs, checked before anything is called
		/** @type {{ plan: Awaited<ReturnType<typeof packingPlan>>['plan'], mode: 'registered' | 'typed' } | undefined} */
		let units;
		/** @type {import('../core/orders.js').OrderMedia | undefined} */
		let video;
		if (target.role === 'packed') {
			// the dispatch video taken when packing, as the move asks (E28)
			const videoRule = String(rules.options.video ?? 'off');
			if (videoRule === 'required' && !input.video && !(order.media ?? []).some((m) => m.kind === 'dispatch_video'))
				throw service.invalid('video', 'Add the dispatch video before packing.');
			if (videoRule !== 'off' && input.video) video = input.video;
			units = await packingPlan(s, order, input);
		}
		/** @type {Awaited<ReturnType<typeof shipmentOf>> | null} */
		let shipping = null;
		if (target.role === 'shipped') {
			// typed serial numbers are needed before dispatch when the move says so (E11)
			if (rules.needs.includes('units') && s.has('grades_serials') && (await serialRules(s)).mode === 'typed') {
				const missing = missingSerials(order, await serializedOf(s, order));
				if (missing.length > 0)
					throw service.invalid(
						`serials/${missing[0]?.id}`,
						`Type the serial numbers of ${missing.map((line) => line.name).join(', ')} before dispatch.`,
					);
			}
			shipping = await shipmentOf(s, order, input.shipment, rules.options.tracking !== 'optional');
		}
		if (target.role === 'delivered' && rules.needs.includes('units') && s.has('grades_serials')) {
			const missing = (await serialRules(s)).mode === 'typed' ? missingSerials(order, await serializedOf(s, order)) : [];
			if (missing.length > 0)
				throw service.invalid(
					`serials/${missing[0]?.id}`,
					`Type the serial numbers of ${missing.map((line) => line.name).join(', ')} first.`,
				);
		}
		const unpaid = nothingPaid(order, target.role, chosen.choices.unpaid);
		if (unpaid) throw problem(unpaid.code, unpaid.message);

		// then what it calls; a move that fails after that (it lost its race to another change: 409) leaves nothing the
		// order does not know (`leftBehind`)
		/** @type {{ steps: import('./order-payments.js').CancelStep[], booked: NonNullable<OrderRecord['shipment']> | null }} */
		const called = { steps: [], booked: null };
		try {
			return await moveOn();
		} catch (error) {
			await leftBehind(s, order, called);
			throw error;
		}

		async function moveOn() {
			// a waiting order staff move on counts as paid when its method is listed (`paidOnConfirm`, OR-7), once its open
			// Payments payment is cancelled (K-13)
			const paid = await paidOnConfirm(s, ctx, order, target.role, rules.options.paidOnConfirm ?? []);
			if (paid) called.steps.push(paid.step);
			const shipment = shipping
				? 'book' in shipping
					? (called.booked = await shipping.book())
					: shipping.shipment
				: undefined;
			const cancelling =
				(target.role === 'cancelled' || target.role === 'refunded') && BEFORE_DELIVERY_ROLES.includes(order.role);
			// before shipping or a recalled parcel (E27), or a refund acting as a cancel: its open payment is cancelled at
			// Payments first (K-13)
			const step = cancelling
				? await cancelAtPayments(s, order, input.note || (target.role === 'cancelled' ? 'Order cancelled' : 'Order refunded'))
				: null;
			if (step) called.steps.push(step);
			// stock an order gives back tells the alerts (E34): what its products were before
			const held = ['cancelled', 'returned_to_origin', 'returned', 'refunded'].includes(target.role)
				? await heldStockBefore(data, order)
				: null;
			const planned = planTransition({
				order,
				flow,
				to: input.to,
				input: {
					who: 'staff',
					...(trigger ? { trigger: true } : {}),
					actor,
					...byActor(actor),
					note: input.note,
					...(input.shopperNote ? { shopperNote: input.shopperNote } : {}),
					...(input.restock === undefined ? {} : { restock: input.restock }),
					...(input.code ? { code: input.code } : {}),
					...(input.reason ? { reason: input.reason } : {}),
					...(shipment ? { shipment } : {}),
					...(video ? { video } : {}),
					...(units ? { units } : {}),
					...(paid ? { paid } : {}),
					...(step ? { payments: step.set } : {}),
				},
				rules: await rulesOf(s),
				now,
			});
			if (!planned.ok)
				throw planned.code === 'input_needed'
					? service.invalid(planned.field ?? 'restock', planned.message)
					: problem(planned.code, planned.message);
			const { plan } = planned;
			let after = await transitions.apply(s, order, plan);
			// money paid after an earlier cancel of its payment is recorded on the cancelled order (K-13)
			if (step && target.role === 'cancelled') {
				await payments.afterCancel(s, after, step);
				after = /** @type {OrderRecord} */ (
					await data
						.collection(COLLECTIONS.orders)
						.findOne({ websiteId: s.websiteId, id: order.id }, { projection: { _id: 0 } })
				);
			}

			/** @type {Warning[]} */
			const warnings = [];
			let refundedNow = plan.refunded;
			// the refund through Payments a cancel or a refund asks for, right after the transaction
			if (plan.external.length > 0) {
				const ran = await transitions.runEffects(s, after, { ids: plan.external.map((effect) => effect.id) });
				after = ran.order;
				for (const outcome of ran.outcomes) {
					refundedNow += outcome.amount;
					if (outcome.done?.manual) warnings.push(await returnByHand(s, order, outcome.amount));
					if (outcome.warning) warnings.push(outcome.warning);
				}
			}

			await service.log(ctx, 'order.moved', order.id, {
				label: order.number,
				detail: `${statusLabel(flow, from)} → ${target.label}`,
			});
			const { money } = await s.format();
			const recorded = /** @type {{ method: string, amount: number } | null} */ (plan.recorded);
			if (recorded) {
				await service.log(ctx, 'order.payment_recorded', order.id, {
					label: order.number,
					detail: `${money(recorded.amount, order.totals.currency)} by ${recorded.method}`,
				});
				await service.emit('order.payment_recorded', s, { order: after, entry: recorded });
				if (after.payment.state === 'paid' && order.payment.state !== 'paid')
					await service.emit('order.paid', s, { order: after, entry: recorded });
			}
			if (refundedNow > 0) {
				await service.log(ctx, 'order.refunded', order.id, {
					label: order.number,
					detail: `Refunded ${money(refundedNow, order.totals.currency)}`,
				});
				await service.emit('order.refunded', s, { order: after, amount: refundedNow, claimId: null });
			}
			if (held && order.stockHeld && !after.stockHeld) await service.emit('products.changed', s, held);
			// the note staff typed with the move: a cancel's reason in messages and alerts (K-10)
			await service.emit('order.moved', s, { order: after, ...plan.event });
			return { order: after, warnings };
		}
	};

	/**
	 * What a move that failed after calling out leaves on the order, so nothing is lost or done twice: a payment Payments
	 * cancelled for it is dropped while the order still names it and nothing cancelled the order meanwhile (the
	 * shopper's next pay starts one for the order as it is, as an edit does); a parcel the courier booked is kept as its
	 * shipment (staff see the tracking number; the move made again ships with it, never booking twice).
	 * @param {Site} s @param {OrderRecord} order as read
	 * @param {{ steps: import('./order-payments.js').CancelStep[], booked: NonNullable<OrderRecord['shipment']> | null }} called
	 */
	const leftBehind = async (s, order, { steps, booked }) => {
		for (const step of steps) await payments.dropVoided(s, order, step);
		if (booked)
			await (
				await s.data()
			)
				.collection(COLLECTIONS.orders)
				.updateOne(
					{ websiteId: s.websiteId, id: order.id, 'shipment.booked': { $ne: true } },
					{ $set: { shipment: booked } },
				);
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
		const byLine = new Map(plan.value.map((line) => [line.lineId, line.serials]));
		// captured through the order engine: the lines, their facts and the numbers in one transaction
		const after = await transitions.apply(
			s,
			order,
			planUnits({
				order,
				units: { plan: plan.value, mode },
				history: {
					at: new Date(product.now()),
					from: order.status,
					to: order.status,
					...byActor(service.actor(ctx)),
					...serverNote('serials_typed', 'Serial numbers typed'),
				},
			}),
		);
		await service.log(ctx, 'order.serials_typed', order.id, {
			label: order.number,
			detail: `${[...byLine.values()].flat().length} serial number(s)`,
		});
		return after;
	};

	/**
	 * Refund part of what was paid without a status change (E26): through Payments for what Payments took (or as asked),
	 * the rest recorded as given back by `method`, with its reference and the claim it is for (a claim refunded without
	 * a note gives `Claim <reference>` as the reason). The part through Payments goes through the order's refund lock
	 * (`lockedRefund`): written on the order first, so of two refunds at once one wins (409 `conflict`) and a refund
	 * Payments made is always recorded — done now, or pending and sent again with the same key when Payments did not
	 * answer (warning `refund_pending`). A part only recorded is written while the order's refunds are as read and no
	 * refund runs at Payments. With the flow's trigger `refundsCover`, an order whose refunds reach what was paid moves to
	 * that refunded status when the flow lists the move (a transition like any other).
	 * @param {Site} s
	 * @param {any} ctx
	 * @param {OrderRecord} order
	 * @param {import('../core/orders.js').RefundInput} input
	 */
	const refund = async (s, ctx, order, input) => {
		// staff refund now: a refund the order's cancel left pending at Payments is not sent any more (one running right
		// now records itself first)
		const settled = await transitions.dropPending(s, order);
		if (settled === 'unavailable')
			throw problem(
				'payments_unavailable',
				'Payments cannot be reached to check the refund this order’s cancel asked for. Try again.',
			);
		if (settled !== 'ok')
			throw problem(
				'conflict',
				settled === 'running'
					? 'A refund through Payments is running for this order; reload it in a moment.'
					: 'The order changed meanwhile (its refund through Payments may have gone through); reload it and try again.',
			);
		const reason = input.reason || `Claim ${input.claimReference ?? ''}`;
		const split = refundSplit(order, input.amount);
		const online = input.method === null || input.method === 'online' ? split.online : 0;
		const manual = input.amount - online;
		if (input.method === 'online' && manual > 0)
			throw service.invalid('amount', `At most ${split.online} can be refunded through Payments.`);
		const money = (await s.format()).money(input.amount, order.totals.currency);
		const recordedMethod = input.method === null || input.method === 'online' ? 'other' : input.method;
		const actor = service.actor(ctx);
		const now = product.now();
		const manualEntries =
			manual > 0
				? [
						refundEntry(actor, now, {
							method: recordedMethod,
							amount: manual,
							reference: input.reference,
							claimId: input.claimId,
							note: reason,
						}),
					]
				: [];
		/** The history note of the refund: recorded (by hand, or Payments only recorded it) or refunded through Payments. @param {boolean} recorded */
		const noteOf = (recorded) => {
			const said = `Refunded ${money}${recorded ? ' (recorded)' : ''}: ${reason}`;
			return input.reason
				? serverNote(recorded ? 'refunded_recorded' : 'refunded', said, { amount: input.amount, reason })
				: serverNote(recorded ? 'claim_refunded_recorded' : 'claim_refunded', said, {
						amount: input.amount,
						reference: input.claimReference ?? '',
					});
		};
		const history = { from: order.status, to: order.status, ...byActor(actor), kind: 'refund' };
		const orders = (await s.data()).collection(COLLECTIONS.orders);
		/** @type {Warning[]} */
		const warnings = [];
		/** @type {OrderRecord} */
		let after;
		/** @type {Record<string, unknown>[]} */
		let entries = manualEntries;
		let refundId = null;
		let recorded = true;
		let pending = false;
		if (online > 0) {
			const locked = await transitions.lockedRefund(s, order, {
				id: `${order.id}:staff-refund:${createId('rfk')}`,
				kind: 'refund',
				amount: online,
				reason,
				note: reason,
				by: actor,
				at: new Date(now),
				record: {
					manual,
					entries: manualEntries,
					reference: input.reference,
					claimId: input.claimId,
					history,
					note: noteOf(false),
					recordedNote: noteOf(true),
				},
			});
			after = locked.order;
			const { outcome } = locked;
			// refused by Payments: nothing is recorded (the effect says it failed)
			if (outcome.state === 'failed') throw outcome.error ?? problem('payments_refused', 'Payments refused the refund.');
			if (outcome.state === 'done' && outcome.done) {
				refundId = outcome.done.refundId || null;
				recorded = manual > 0 || outcome.done.manual;
				entries = [
					paymentsRefundEntry(actor, now, outcome.done, {
						amount: online,
						reference: input.reference,
						claimId: input.claimId,
						note: reason,
					}),
					...manualEntries,
				];
				if (outcome.done.manual) warnings.push(await returnByHand(s, order, online));
			} else {
				// Payments did not answer: kept on the order and sent again with the same key on use (never twice)
				pending = true;
				recorded = false;
				warnings.push(
					outcome.warning ?? {
						code: 'refund_pending',
						values: { amount: online },
						text: 'Payments did not answer: the refund is kept on the order and sent again when the order is next used.',
					},
				);
			}
		} else {
			// only recorded: while the order's refunds are as read and no refund runs at Payments for it
			const refunded = order.payment.refunded + input.amount;
			const result = await orders.updateOne(
				{
					websiteId: s.websiteId,
					id: order.id,
					'payment.refunded': order.payment.refunded,
					effects: { $not: { $elemMatch: { state: 'pending' } } },
				},
				{
					$set: { 'payment.refunded': refunded, 'payment.state': stateAfterRefund(order.payment.paid, refunded) },
					$push: {
						refunds: { $each: manualEntries },
						history: { at: new Date(now), ...history, ...noteOf(true) },
					},
				},
			);
			if (result.modifiedCount !== 1) throw changed();
			after = /** @type {OrderRecord} */ (
				await orders.findOne({ websiteId: s.websiteId, id: order.id }, { projection: { _id: 0 } })
			);
		}
		if (!pending) {
			await service.log(ctx, 'order.refunded', order.id, {
				label: order.number,
				detail: `Refunded ${money}${recorded ? ' (recorded)' : ''}`,
			});
			await service.emit('order.refunded', s, { order: after, amount: input.amount, claimId: input.claimId });
		}
		// refunds that reach what was paid move the order to the flow's refunded status, when the flow lists the move
		const flow = /** @type {OrderFlow} */ (/** @type {unknown} */ (await s.list('order_flow')));
		const to = triggersOfFlow(flow).refundsCover;
		if (
			!pending &&
			to &&
			after.payment.paid > 0 &&
			after.payment.refunded >= after.payment.paid &&
			canMove(flow, after.status, to)
		) {
			const moved = await move(
				s,
				ctx,
				after,
				{
					to,
					note: 'Refunds cover the payments',
					code: 'refunds_cover_payments',
					serials: {},
					shipment: null,
					updatedAt: null,
				},
				flow,
				{ trigger: true },
			);
			after = moved.order;
			warnings.push(...moved.warnings);
		}
		return {
			order: after,
			refund: { amount: input.amount, online, manual, refundId, recorded, ...(pending ? { pending: true } : {}) },
			warnings,
			entries,
		};
	};

	/**
	 * Record a payment staff took (E26): a bank transfer, cash or another way, at most the balance due. The order's open
	 * Payments payment is cancelled first, so the money cannot be taken twice (CK-21, as `paidOnConfirm` does); a payment
	 * made there meanwhile, or a Payments that cannot be reached, refuses it. With `confirm`, a waiting order moves to its
	 * confirmed status in the same call (a transition like any other).
	 * @param {Site} s
	 * @param {any} ctx
	 * @param {OrderRecord} order
	 * @param {import('../core/orders.js').PaymentInput} input
	 * @param {OrderFlow} flow
	 */
	const recordPayment = async (s, ctx, order, input, flow) => {
		const step = await payments.beforeCancel(s, order, 'Paid by hand');
		if (step.paid || step.late) throw problem('conflict', 'Payments says this order was paid meanwhile; reload it.');
		if (!step.reached)
			throw problem('payments_unavailable', 'Payments cannot be reached to cancel the order’s payment there. Try again.');
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
				$set: { ...step.set, 'payment.paid': paid, 'payment.state': state, 'payment.checkedAt': new Date(now) },
				$push: {
					payments: entry,
					history: {
						at: new Date(now),
						from: order.status,
						to: order.status,
						...byActor(service.actor(ctx)),
						...(input.reference
							? serverNote('payment_recorded_reference', `Payment of ${money} recorded (${input.reference})`, {
									amount: input.amount,
									reference: input.reference,
								})
							: serverNote('payment_recorded', `Payment of ${money} recorded`, { amount: input.amount })),
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
		/** @type {Warning[]} */
		const warnings = [];
		if (input.confirm && WAITING.includes(after.role)) {
			const to = confirmedStatus(flow, after.status, 'staff');
			if (!to) throw problem('move_not_allowed', 'The order flow has no move from this status to a confirmed one.');
			const moved = await move(
				s,
				ctx,
				after,
				{ to, note: 'Payment recorded', code: 'confirmed_on_payment', serials: {}, shipment: null, updatedAt: null },
				flow,
			);
			after = moved.order;
			warnings.push(...moved.warnings);
		}
		return { order: after, warnings };
	};

	/**
	 * Give back what an order holds before it is deleted (E31), as a cancel does, through the order engine (a release
	 * without a status): its stock and slots, offer uses and redeemed points, and its serial numbers, each once; with the
	 * checkout setting `deleteGivesBack: all`, a delivered or closed order's items still with the customer, offer uses
	 * and points too (stock back, earned points taken back, redeemed ones given back). With
	 * `payments`, its open Payments payment is cancelled first; a payment made meanwhile refuses the delete (K-13), and
	 * so does a Payments that cannot be reached (a deleted order cannot try the cancel again later).
	 * @param {Site} s @param {OrderRecord} order @param {{ payments?: boolean }} [options]
	 * @returns {Promise<boolean>} false when the order changed meanwhile (nothing was given back)
	 */
	const giveBack = async (s, order, { payments: cancelPayment = false } = {}) => {
		// delivered, returned and settled orders keep what was sold, unless the website's deletes give everything back
		const all = (await s.values('checkout')).deleteGivesBack === 'all';
		const plan = planRelease({ order, all });
		if (!plan) return true;
		const step = cancelPayment ? await payments.beforeCancel(s, order, 'Order deleted') : null;
		if (step?.paid || step?.late) throw problem('conflict', 'This order was paid meanwhile; refund it before deleting it.');
		if (step && !step.reached)
			throw problem('payments_unavailable', 'Payments cannot be reached to cancel the order’s payment there. Try again.');
		try {
			await transitions.apply(s, order, plan);
			return true;
		} catch (error) {
			if (/** @type {any} */ (error)?.code === 'conflict') return false;
			throw error;
		}
	};

	return Object.freeze({
		move,
		refund,
		recordPayment,
		giveBack,
		typeSerials,
		serializedOf,
		recheck: payments.recheck,
		settle: transitions.settle,
	});
};

/** @typedef {ReturnType<typeof createMoves>} Moves */
