/**
 * Moving an order through the merchant's flow, and refunds (PLAN 0.8.8). A move is allowed only when the flow lists it
 * for staff (`core/flow.js` `moveOf`, with the role rules), the staff ticket has the move's permission, staff give what
 * it needs (a note, a note for the shopper, the answer to whether the items go back in stock), the order's role is
 * still the flow's role of its status (`flow_changed`) and the order did not change since it was read (`updatedAt`).
 * The move's options (PLAN 0.8.10 dynamic model phase 2) say what it records and asks. Every move is planned by the order
 * engine (`core/transitions.js`) and run in one transaction with everything it gives back or takes
 * (`server/transitions.js`); what entering a status does depends on its role:
 *
 * - `packed`, `shipped`, `delivered`: with Condition grades and unit numbers on, the units of lines whose item type numbers them get
 *   their numbers (dynamic model §1): units added to stock are picked when packing (marked sold with the order in the
 *   same transaction as the move); typed ones may be typed with any of these moves or later, and are needed before the
 *   stage the type says (`requiredBefore`);
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
 * What a move needs is checked before anything is called: the permissions (the move's, and the refund permission for
 * any move that gives money back: into a refunded status, or a cancel that refunds what was paid), the shipment (its
 * tracking number as the move's `tracking` says), the serial numbers (every one the item types need by the stage the
 * order enters), the dispatch video (the move's `video`) and the order fields required by the stage it moves into
 * (`requiredAt`); then the open Payments payment is canceled (K-13), a shipment booked and a refund made, as the move
 * needs. A staff refund (`refund`) goes through the order's refund lock (`server/transitions.js` `lockedRefund`).
 *
 * Every move is written to the order's history with the name of the staff member who made it (a ticket's user, or the
 * one a server-token call names in its `SS-Actor-*` headers, else `Server`; PLAN 0.8.10 K2) and its kind, the activity
 * log (with the order number and the move), the `order.moved` hook and the shopper's message. Notes the server writes
 * itself and the warnings staff get carry a code and values besides their English (PLAN 0.4.10).
 * @module
 */
import { problem } from '@ss/app-kit';
import { fieldsOn, productTypes, unitRulesOf } from '../adapters/catalog-store.js';
import { heldStockBefore } from '../adapters/ledger.js';
import { checkUnit, missingOrderFields, sharedKeys, unitKeys } from '../core/fields.js';
import { bookingCourier, courierNamed, trackingLink } from '../core/couriers.js';
import { BEFORE_DELIVERY_ROLES, WAITING_ROLES as WAITING, canMove, confirmedStatus, moveOf, statusOf } from '../core/flow.js';
import { createId } from '@ss/contracts';
import { elementsOf } from '../core/item-types.js';
import { reasonOf } from '../core/order-reasons.js';
import { OTHER_WAY, VIA_PAYMENTS } from '../core/payment-methods.js';
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
import { DROPPED, createOrderPayments, openAtPayments } from './order-payments.js';
import { createTransitions, rulesOf } from './transitions.js';
import {
	byActor,
	missingSerials,
	orderMoney,
	paymentStateOf,
	refundSplit,
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
	// a staff refund Payments finishes later moves the order as one done at once does
	const transitions = createTransitions(product, service, { refunded: (s, order) => coverLater(s, order) });

	/**
	 * Cancel at Payments the open payment of an order about to be canceled or refunded before delivery (K-13): what
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
	 * A waiting order staff move on no longer waits for its Payments payment: an open one is canceled there first (K-13),
	 * so the shopper can no longer pay it (money that still arrives Payments flags to give back); the move then lets it
	 * go (`DROPPED`, as an edit does: waiting again, the shopper's next pay starts one for the order as it is), or keeps
	 * it canceled with the payment staff record (`paidOnConfirm`). Paid meanwhile, the move is refused (the order is paid
	 * now: Payments' payment is recorded), and so is a Payments that cannot be reached. Null when the order has no open
	 * Payments payment.
	 * @param {Site} s @param {OrderRecord} order @param {string} reason kept in the payment's history
	 * @returns {Promise<import('./order-payments.js').CancelStep | null>}
	 */
	const leaveWaiting = async (s, order, reason) => {
		if (!openAtPayments(order)) return null;
		const step = await payments.beforeCancel(s, order, reason);
		if (step.paid || step.late) throw problem('move_not_allowed', 'Payments says this order was paid meanwhile; reload it.');
		if (!step.reached)
			throw problem('payments_unavailable', 'Payments cannot be reached to cancel the order’s payment there. Try again.');
		return step;
	};

	/**
	 * How the units of an order's products are numbered (their item types, dynamic model §1); none while Grades and
	 * serials is off.
	 * @param {Site} s @param {OrderRecord} order
	 */
	const unitRulesFor = async (s, order) =>
		unitRulesOf(
			await s.data(),
			[...new Set(order.lines.filter((line) => line.kind === 'physical').map((line) => line.productId))],
			{ types: await s.list('item_types'), has: s.has },
		);

	/**
	 * The units staff give per line, checked: units in stock are picked by their serial numbers; typed ones are checked
	 * against the unit fields of the line's item type (each value in its field's format, the required ones given, a
	 * text alone the first field's value; without unit fields a plain serial number), and no number may name two units
	 * (in this request: its own keys; others are refused when they are captured).
	 * @param {OrderRecord} order
	 * @param {Record<string, import('../core/orders.js').UnitInput[]>} sent
	 * @param {Map<string, import('../core/item-types.js').UnitRules>} rules
	 * @returns {{ serials: Record<string, string[]>, units: Map<string, import('../core/fields.js').UnitRecordValues[]> }}
	 */
	const unitsSent = (order, sent, rules) => {
		/** @type {Record<string, string[]>} */
		const serials = {};
		/** @type {Map<string, import('../core/fields.js').UnitRecordValues[]>} */
		const units = new Map();
		const lines = new Map(order.lines.map((line) => [line.id, line]));
		for (const [lineId, list] of Object.entries(sent)) {
			const line = lines.get(lineId);
			const numbered = line?.kind === 'physical' ? rules.get(line.productId) : undefined;
			if (!numbered) throw service.invalid(`serials/${lineId}`, 'This line takes no serial numbers.');
			/** @type {import('../core/fields.js').UnitRecordValues[]} */
			const checked = [];
			for (const [index, entry] of list.entries()) {
				if (numbered.capture === 'stock') {
					if (typeof entry !== 'string')
						throw service.invalid(`serials/${lineId}/${index}`, 'Units in stock are picked by their serial numbers.');
					checked.push({ serial: entry, values: {}, keys: unitKeys(entry) });
					continue;
				}
				const unit = checkUnit(entry, numbered.fields);
				if (!unit.ok) throw service.invalid(`serials/${lineId}/${index}${unit.path}`, unit.message);
				checked.push(unit.value);
			}
			serials[lineId] = checked.map((unit) => unit.serial);
			units.set(lineId, checked);
		}
		const twice = sharedKeys([...units.values()].flat());
		if (twice.length > 0)
			throw service.invalid('serials', `${String(twice[0]).replace(/^[^:]+:/, '')} is given for two units.`);
		return { serials, units };
	};

	/**
	 * The weight in grams of an order's package for a courier booking: each physical line's variant weight (its item
	 * type's `parcel`, while Delivery zones is on) times its quantity (a measured line's weight is per unit, rounded up
	 * for its thousandths); null when one of them is not known.
	 * @param {Site} s @param {OrderRecord} order
	 * @returns {Promise<number | null>}
	 */
	const parcelWeight = async (s, order) => {
		const lines = order.lines.filter((line) => line.kind === 'physical');
		if (lines.length === 0) return null;
		const data = await s.data();
		const products = /** @type {import('../core/model.js').ProductRecord[]} */ (
			/** @type {unknown} */ (
				await data
					.collection(COLLECTIONS.products)
					.find(
						{ websiteId: s.websiteId, id: { $in: [...new Set(lines.map((line) => line.productId))] } },
						{ projection: { _id: 0, id: 1, kind: 1, typeKey: 1, categoryIds: 1, 'variants.id': 1, 'variants.parcel': 1 } },
					)
					.toArray()
			)
		);
		const types = await productTypes(data, products, await s.list('item_types'));
		const byId = new Map(products.map((item) => [item.id, item]));
		let grams = 0;
		for (const line of lines) {
			const item = byId.get(line.productId);
			const type = types.get(line.productId);
			const weight = item?.variants.find((variant) => variant.id === line.variantId)?.parcel?.weightG;
			if (!type || !elementsOf(type, s.has).parcel || !weight) return null;
			grams += line.measure ? Math.ceil((weight * line.quantity) / 1000) : weight * line.quantity;
		}
		return grams;
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
			// the courier picked, else the preselected one, else the first with a booking connection (E25)
			const courier = bookingCourier(couriers, {
				picked: input.courier ?? '',
				preselected: String((await s.values('courier_apis')).courier ?? ''),
			});
			if (input.courier && !courier) throw service.invalid('shipment/courier', 'There is no such courier.');
			// a package booked for it already (a move that failed after the booking) ships with that booking, never booked
			// twice
			const booked = order.shipment;
			if (booked?.booked && booked.trackingNumber && (!input.courier || courier?.name === booked.courier))
				return { shipment: booked };
			if (!courier?.connection)
				throw problem(
					'courier_failed',
					courier ? `${courier.name} has no booking connection.` : 'No courier has a booking connection.',
				);
			const value = await product.connections.value(s.websiteId, courier.connection);
			if (!value) throw problem('courier_failed', `Connect the courier API keys of ${courier.name} first.`);
			return {
				book: async () => {
					const booked = await product.couriers.book({ order, value, weightG: await parcelWeight(s, order) });
					if (!booked.ok) throw problem('courier_failed', booked.message);
					return {
						courier: courier.name,
						trackingNumber: booked.trackingNumber,
						trackingUrl: trackingLink(courier.trackingUrl, booked.trackingNumber),
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
	 * the balance due, as a payment of the order's own method (E16), written with
	 * what canceling its open Payments payment writes (K-13, `leaveWaiting`); null when the move records none.
	 * @param {any} ctx @param {OrderRecord} order @param {import('../core/model.js').StatusRole} to
	 * @param {ReadonlyArray<string>} methods the move's `paidOnConfirm`
	 */
	const paidOnConfirm = (ctx, order, to, methods) => {
		const { due } = orderMoney(order);
		if (!WAITING.includes(order.role) || !['open', 'packed', 'shipped'].includes(to) || !methods.includes(order.payment.method))
			return null;
		if (due <= 0) return null;
		const paid = order.payment.paid + due;
		const entry = {
			id: createId(ID_PREFIX.orderPayment),
			method: order.payment.method,
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
		return { entry, set: { 'payment.paid': paid, 'payment.state': state } };
	};

	/**
	 * The serial numbers a move into a packed, shipped or delivered status captures (none while Condition grades and unit numbers is
	 * off): those sent, checked against the item types of the lines; every unit the stage needs must have one by then.
	 * @param {Site} s @param {OrderRecord} order @param {MoveInput} input @param {string} stage the role entered
	 */
	const capturePlan = async (s, order, input, stage) => {
		if (!s.has('grades_serials')) return [];
		const rules = await unitRulesFor(s, order);
		// numbers a later step needs, not given with it
		const missing = stage === 'packed' ? [] : missingSerials(order, rules, stage).filter((line) => !input.serials[line.id]);
		if (missing.length > 0)
			throw service.invalid(
				`serials/${missing[0]?.id}`,
				`Type the serial numbers of ${missing.map((line) => line.name).join(', ')} ${stage === 'shipped' ? 'before dispatch' : 'first'}.`,
			);
		const { serials, units } = unitsSent(order, input.serials, rules);
		const plan = serialPlan(order, rules, serials, { stage });
		if (!plan.ok) throw service.invalid(plan.field, plan.message);
		return plan.value
			.filter((line) => JSON.stringify(line.serials) !== JSON.stringify(line.before))
			.map((line) => ({ ...line, ...(units.has(line.lineId) ? { units: units.get(line.lineId) } : {}) }));
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
			// the order fields required by this stage (requiredAt packed, shipped or delivered) are given first
			if (['packed', 'shipped', 'delivered'].includes(target.role)) {
				const missing = missingOrderFields(order.fields ?? {}, await fieldsOn(await s.data(), 'order'), target.role);
				if (missing.length > 0)
					throw service.invalid(
						`fields/${missing[0]?.id}`,
						`Give ${missing.map((field) => field.name).join(', ')} before this move.`,
					);
			}
		}
		const chosen = choicesOf({
			move: rules,
			from: order.role,
			to: target.role,
			input: { who: 'staff', trigger, ...(input.restock === undefined ? {} : { restock: input.restock }) },
		});
		if (!chosen.ok) throw service.invalid(chosen.field ?? 'restock', chosen.message);
		// why staff cancel or a package came back: a reason of the merchant's list for that move (E19), with whether it
		// counts against the customer
		const reasons =
			target.role === 'cancelled'
				? await s.list('cancel_reasons')
				: target.role === 'returned_to_origin'
					? await s.list('delivery_failure_reasons')
					: null;
		if (!reasons && input.reason) throw service.invalid('reason', 'Only a cancel or a package that came back takes a reason.');
		const why = reasons
			? reasonOf(input.reason, reasons, { fallbackFirst: target.role === 'returned_to_origin' })
			: { ok: true, reason: null };
		if (!why.ok)
			throw service.invalid(
				'reason',
				`reason is a key of the ${target.role === 'cancelled' ? 'cancel_reasons' : 'delivery_failure_reasons'} list.`,
			);
		const data = await s.data();
		const now = product.now();
		const actor = service.actor(ctx);
		const settings = await rulesOf(s);
		/** What staff ask of the move as the order engine plans it (what the move calls out for is added once called). */
		const asked = {
			who: /** @type {const} */ ('staff'),
			...(trigger ? { trigger: true } : {}),
			actor,
			...byActor(actor),
			note: input.note,
			...(input.shopperNote ? { shopperNote: input.shopperNote } : {}),
			...(input.restock === undefined ? {} : { restock: input.restock }),
			...(input.code ? { code: input.code } : {}),
			...(why.reason ? { reason: why.reason.key, countsAgainst: why.reason.countsAgainst } : {}),
		};
		// a move that gives money back needs the refund permission, whatever permission it names (a cancel that refunds
		// what was paid, before delivery or after it, E40): planned with the order as read, before anything is called
		if (ctx.ticket && !ctx.ticket.permissions.includes('orders.refund')) {
			const planned = planTransition({ order, flow, to: input.to, input: asked, rules: settings, now });
			if (planned.ok && (planned.plan.external.length > 0 || planned.plan.refunded > 0))
				throw problem('forbidden', 'This move gives money back, so it needs the refund permission.');
		}

		// what the move needs, checked before anything is called
		/** @type {{ plan: Awaited<ReturnType<typeof capturePlan>> } | undefined} */
		let units;
		/** @type {import('../core/orders.js').OrderMedia | undefined} */
		let video;
		if (target.role === 'packed') {
			// the dispatch video taken when packing, as the move asks (E28)
			const videoRule = String(rules.options.video ?? 'off');
			if (videoRule === 'required' && !input.video && !(order.media ?? []).some((m) => m.kind === 'dispatch_video'))
				throw service.invalid('video', 'Add the dispatch video before packing.');
			if (videoRule !== 'off' && input.video) video = input.video;
		}
		// the units of the lines whose item type numbers them: those sent, and every one the stage needs by now
		if (['packed', 'shipped', 'delivered'].includes(target.role))
			units = { plan: await capturePlan(s, order, input, target.role) };
		/** @type {Awaited<ReturnType<typeof shipmentOf>> | null} */
		let shipping = null;
		if (target.role === 'shipped') shipping = await shipmentOf(s, order, input.shipment, rules.options.tracking !== 'optional');
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
			const cancelling =
				(target.role === 'cancelled' || target.role === 'refunded') && BEFORE_DELIVERY_ROLES.includes(order.role);
			// a waiting order staff move on counts as paid when its method is listed (`paidOnConfirm`, OR-7)
			const paid = paidOnConfirm(ctx, order, target.role, rules.options.paidOnConfirm ?? []);
			// its open Payments payment is canceled there first (K-13): a cancel before dispatch, or a refund acting as one
			// (the canceled order watches it for money that still comes), and a waiting order staff move on (it lets the
			// payment go, or keeps it canceled with the payment staff record)
			const step = cancelling
				? await cancelAtPayments(s, order, input.note || (target.role === 'cancelled' ? 'Order canceled' : 'Order refunded'))
				: WAITING.includes(order.role)
					? await leaveWaiting(s, order, paid ? 'Paid by hand' : 'Moved on by staff')
					: null;
			if (step) called.steps.push(step);
			const shipment = shipping
				? 'book' in shipping
					? (called.booked = await shipping.book())
					: shipping.shipment
				: undefined;
			// stock an order gives back tells the alerts (E34): what its products were before
			const held = ['cancelled', 'returned_to_origin', 'returned', 'refunded'].includes(target.role)
				? await heldStockBefore(data, order)
				: null;
			const planned = planTransition({
				order,
				flow,
				to: input.to,
				input: {
					...asked,
					...(shipment ? { shipment } : {}),
					...(video ? { video } : {}),
					...(units ? { units } : {}),
					...(paid ? { paid: { ...paid, set: { ...step?.set, ...paid.set } } } : {}),
					...(step && !paid ? { payments: cancelling ? step.set : { ...DROPPED } } : {}),
				},
				rules: settings,
				now,
			});
			if (!planned.ok)
				throw planned.code === 'input_needed'
					? service.invalid(planned.field ?? 'restock', planned.message)
					: problem(planned.code, planned.message);
			const { plan } = planned;
			let after = await transitions.apply(s, order, plan);
			// money paid after an earlier cancel of its payment is recorded on the canceled order (K-13)
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
	 * canceled for it is dropped while the order still names it and nothing canceled the order meanwhile (the
	 * shopper's next pay starts one for the order as it is, as an edit does); a package the courier booked is kept as its
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
	 * Type the units of a packed, shipped or delivered order: one per unit of each line sent, with the values of its item
	 * type's unit fields; only lines whose type has its units typed (`capture: 'packing'`), the others' are picked from
	 * stock when packing.
	 * @param {Site} s @param {any} ctx @param {OrderRecord} order
	 * @param {Record<string, import('../core/orders.js').UnitInput[]>} sent
	 * @returns {Promise<OrderRecord>}
	 */
	const typeSerials = async (s, ctx, order, sent) => {
		if (!s.has('grades_serials')) throw service.invalid('serials', 'Switch on Condition grades and unit numbers first.');
		if (!['packed', 'shipped', 'delivered'].includes(order.role))
			throw service.invalid('serials', 'Serial numbers are typed once the order is packed.');
		const rules = await unitRulesFor(s, order);
		const lines = new Map(order.lines.map((line) => [line.id, line]));
		for (const lineId of Object.keys(sent))
			if (rules.get(lines.get(lineId)?.productId ?? '')?.capture === 'stock')
				throw service.invalid(`serials/${lineId}`, 'Serial numbers are picked from stock when the order is packed.');
		const { serials, units } = unitsSent(order, sent, rules);
		const checked = serialPlan(order, rules, serials, { stage: order.role, only: true });
		if (!checked.ok) throw service.invalid(checked.field, checked.message);
		const plan = checked.value.map((line) => ({ ...line, units: units.get(line.lineId) ?? [] }));
		const byLine = new Map(plan.map((line) => [line.lineId, line.serials]));
		// captured through the order engine: the lines, their facts and the numbers in one transaction
		const after = await transitions.apply(
			s,
			order,
			planUnits({
				order,
				units: { plan },
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

	/** @param {Site} s @returns {Promise<OrderFlow>} */
	const flowOf = async (s) => /** @type {OrderFlow} */ (/** @type {unknown} */ (await s.list('order_flow')));

	/** @param {Site} s @param {string} id @returns {Promise<OrderRecord | null>} */
	const orderNow = async (s, id) =>
		/** @type {OrderRecord | null} */ (
			await (await s.data()).collection(COLLECTIONS.orders).findOne({ websiteId: s.websiteId, id }, { projection: { _id: 0 } })
		);

	/**
	 * The status the flow's trigger `refundsCover` moves an order to once its refunds reach what was paid (`refunded`
	 * what it will have refunded), when the flow lists the move; null when none.
	 * @param {OrderFlow} flow @param {OrderRecord} order @param {number} [refunded]
	 */
	const coverStatus = (flow, order, refunded = order.payment.refunded) => {
		const to = flow.triggers.refundsCover;
		return to && order.payment.paid > 0 && refunded >= order.payment.paid && canMove(flow, order.status, to) ? to : null;
	};

	/**
	 * Refunds that reach what was paid move the order to the flow's refunded status (`triggers.refundsCover`), a
	 * transition like any other that the shop makes for whoever refunded it (`ctx`). It never undoes the refund before it
	 * (the money is recorded): a move that lost its race to another change is made again with the order read again, and
	 * one the order cannot make now is left to staff (the server's log says why).
	 * @param {Site} s @param {any} ctx @param {OrderRecord} order after the refund @param {OrderFlow} flow
	 * @returns {Promise<{ order: OrderRecord, warnings: Warning[] }>}
	 */
	const cover = async (s, ctx, order, flow) => {
		let current = order;
		for (let attempt = 1; attempt <= 2; attempt += 1) {
			const to = coverStatus(flow, current);
			if (!to) break;
			try {
				return await move(
					s,
					ctx,
					current,
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
			} catch (error) {
				const code = String(/** @type {any} */ (error)?.code ?? 'error');
				s.ctx.log?.warn?.('refunds cover the payments, the order was not moved', { code, orderId: order.id });
				if (code !== 'conflict') break;
				current = (await orderNow(s, order.id)) ?? current;
			}
		}
		return { order: current, warnings: [] };
	};

	/**
	 * A staff refund Payments did not answer at once is done now (staff opened the order, or on use): refunds that reach
	 * what was paid move the order as `cover` does, for the staff member who refunded it.
	 * @param {Site} s @param {OrderRecord} order after the refund
	 * @returns {Promise<OrderRecord>}
	 */
	const coverLater = async (s, order) => {
		const by = (order.effects ?? []).findLast((effect) => effect.record && effect.state === 'done')?.by;
		const ctx = {
			websiteId: s.websiteId,
			merchantId: s.merchantId,
			after: s.ctx.after,
			ticket: null,
			...(by ? { actor: by } : {}),
		};
		return (await cover(s, ctx, order, await flowOf(s))).order;
	};

	/**
	 * Refund part of what was paid without a status change (E26): through Payments for what Payments took (or as asked),
	 * the rest recorded as given back by `method`, with its reference and the claim it is for (a claim refunded without
	 * a note gives `Claim <reference>` as the reason). The part through Payments goes through the order's refund lock
	 * (`lockedRefund`): written on the order first, so of two refunds at once one wins (409 `conflict`) and a refund
	 * Payments made is always recorded — done now, or pending and sent again with the same key when Payments did not
	 * answer (warning `refund_pending`). A part only recorded is written while the order's refunds are as read and no
	 * refund runs at Payments. With the flow's trigger `refundsCover`, an order whose refunds reach what was paid moves to
	 * that refunded status when the flow lists the move (`cover`): staff refunding it need that move's permission,
	 * checked before any money moves.
	 * @param {Site} s
	 * @param {any} ctx
	 * @param {OrderRecord} order
	 * @param {import('../core/orders.js').RefundInput} input
	 */
	const refund = async (s, ctx, order, input) => {
		const flow = await flowOf(s);
		// a refund that will move the order needs that move's permission too, before anything is called (no money moves
		// for a refund that would then be refused)
		const to = coverStatus(flow, order, order.payment.refunded + input.amount);
		const permission = to ? moveOf(flow, order.status, to)?.permission : undefined;
		if (to && permission && ctx.ticket && !ctx.ticket.permissions.includes(permission))
			throw problem(
				'forbidden',
				`This refund covers what was paid, so the order moves to ${statusOf(flow, to)?.label ?? to}: that needs the ${
					permission === 'orders.refund' ? 'refund permission' : `permission ${permission}`
				}.`,
			);
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
		const online = input.method === null || input.method === VIA_PAYMENTS ? split.online : 0;
		const manual = input.amount - online;
		if (input.method === VIA_PAYMENTS && manual > 0)
			throw service.invalid('amount', `At most ${split.online} can be refunded through Payments.`);
		const money = (await s.format()).money(input.amount, order.totals.currency);
		const recordedMethod = input.method === null || input.method === VIA_PAYMENTS ? OTHER_WAY : input.method;
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
					...(input.claim ? { claim: input.claim } : {}),
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
		if (!pending) {
			const moved = await cover(s, ctx, after, flow);
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
	 * Payments payment is canceled first, so the money cannot be taken twice (CK-21, as a waiting order staff move on
	 * does); a payment made there meanwhile, or a Payments that cannot be reached, refuses it, and one that loses its race
	 * to another change drops the payment it canceled. With `confirm`, a waiting order moves to its confirmed status in
	 * the same call (a transition like any other).
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
		if (result.modifiedCount !== 1) {
			// another change won: the payment Payments canceled for this one is dropped, so the order stays payable
			await payments.dropVoided(s, order, step);
			throw changed();
		}
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
	 * What giving back what an order holds plans (E31), as a cancel gives it, through the order engine (a release without
	 * a status): its stock and slots, offer uses and redeemed points, and its serial numbers, each once; with the checkout
	 * setting `deleteGivesBack: all`, a delivered or closed order's items still with the customer, offer uses and points
	 * too (stock back, earned points taken back, redeemed ones given back). Null when it holds nothing any more.
	 * @param {Site} s @param {OrderRecord} order
	 */
	const releaseOf = async (s, order) => planRelease({ order, all: (await s.values('checkout')).deleteGivesBack === 'all' });

	/**
	 * Give back what an order holds (`releaseOf`) before every order goes (`POST /v1/data/delete-all`, which cancels their
	 * Payments payments first).
	 * @param {Site} s @param {OrderRecord} order
	 * @returns {Promise<boolean>} false when the order changed meanwhile (nothing was given back)
	 */
	const giveBack = async (s, order) => {
		const plan = await releaseOf(s, order);
		if (!plan) return true;
		try {
			await transitions.apply(s, order, plan);
			return true;
		} catch (error) {
			if (/** @type {any} */ (error)?.code === 'conflict') return false;
			throw error;
		}
	};

	/**
	 * Delete an order (E31). Its open Payments payment is canceled first (K-13; also when the order holds nothing any
	 * more): a payment made meanwhile refuses the delete, and so does a Payments that cannot be reached (a deleted order
	 * cannot try the cancel again later). Then what it holds goes back (`releaseOf`) and it is deleted in one
	 * transaction, only while it is as read (its status, facts and money, no refund pending); one that changed meanwhile
	 * is neither given back nor deleted, and the payment canceled for it is dropped, so it stays payable.
	 * @param {Site} s @param {OrderRecord} order
	 * @returns {Promise<boolean>} false when the order changed meanwhile
	 */
	const remove = async (s, order) => {
		const step = await payments.beforeCancel(s, order, 'Order deleted');
		if (step.paid || step.late) throw problem('conflict', 'This order was paid meanwhile; refund it before deleting it.');
		if (!step.reached)
			throw problem('payments_unavailable', 'Payments cannot be reached to cancel the order’s payment there. Try again.');
		let removed = false;
		try {
			removed = await transitions.remove(s, order, await releaseOf(s, order));
		} finally {
			if (!removed) await payments.dropVoided(s, order, step);
		}
		return removed;
	};

	return Object.freeze({
		move,
		refund,
		recordPayment,
		giveBack,
		remove,
		typeSerials,
		unitRulesFor,
		recheck: payments.recheck,
		settle: transitions.settle,
		sweep: transitions.sweep,
	});
};

/** @typedef {ReturnType<typeof createMoves>} Moves */
