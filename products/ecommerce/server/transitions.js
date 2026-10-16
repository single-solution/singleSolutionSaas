/**
 * The order engine's runner (PLAN 0.8.10 "Ecommerce dynamic model", design §3.3, phase 1): a plan of
 * `core/transitions.js` runs in **one database transaction** — the order's compare-and-set write (its status,
 * `updatedAt` and facts as read) with every ledger effect (`adapters/ledger.js` `applyTransition`) — so of two moves at
 * once one wins and the other gets 409 `conflict`, and nothing is given back or taken twice. A loyalty account that
 * changed meanwhile tries the transaction again (at most three times).
 *
 * External effects (a refund through Payments) are written on the order in that transaction as `effects` (`pending`)
 * and run right after it, with their id as the Idempotency-Key: done, the refund is recorded (`done`); Payments not
 * reached (or its answer lost), it stays `pending` and is tried again with the same key when staff open the order and
 * on use (`sweep`, at most every minute per order; no timer); refused by Payments, it is `failed` and staff refund it
 * from the order. A try takes the effect first (`runningAt`, while the order's refunds are as read), and staff refunding
 * by hand settle it first (`dropPending`: a refund Payments did is recorded, else it is `skipped`), so the money never
 * goes back twice. Staff see each effect on the order.
 *
 * Staff refunds (`POST /v1/orders/:id/refunds`, a claim's refund) go through the same effects (phase 2, the refund
 * lock): the refund through Payments is written on the order first — guarded by the order's refunds as read and no
 * other refund pending — as an effect already taken (`runningAt`), then sent with its id as the Idempotency-Key and
 * recorded together with the part recorded by hand and its history entry (`record`). Of two refunds at once one wins
 * (the other 409 `conflict`), and a refund Payments made is always recorded: done now, or, when Payments' answer did
 * not come, pending and sent again with the same key on use. One done later tells the caller (`refunded`: the flow's
 * `refundsCover` trigger then moves the order); a claim's that is refused or not sent later gives the claim back what
 * it reserved (`claimBack`), so a claim never says it refunded money that did not go back.
 * @module
 */
import { problem } from '@ss/app-kit';
import { applyTransition, isPointsChanged, unitRefusalOf } from '../adapters/ledger.js';
import { COLLECTIONS } from '../core/model.js';
import { refundSplit, refundable, stateAfterRefund } from '../core/orders.js';
import { paymentsRefundEntry } from '../core/transitions.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('../core/model.js').OrderRecord} OrderRecord */
/** @typedef {import('../core/transitions.js').TransitionPlan} TransitionPlan */
/** @typedef {import('../core/transitions.js').OrderEffect} OrderEffect */
/** @typedef {import('../core/orders.js').Warning} Warning */

/** Tries of a transition whose loyalty account changed meanwhile. */
const TRIES = 3;
/** A pending effect is tried again at most this often (on use, no timer), until done, refused or taken over by staff. */
const EFFECT_RETRY_MS = 60_000;
/** A try at Payments taken this long ago is over (a call times out well before): the effect may be taken again. */
const EFFECT_RUNNING_MS = 2 * 60_000;
/** Orders with pending effects handled per use. */
const EFFECT_BATCH = 10;
/** Tries of recording a refund Payments made while the order changes meanwhile. */
const RECORD_TRIES = 5;

/**
 * What one external effect came to: `refunded` the money it gave back (with what Payments answered), and a warning
 * for staff.
 * @typedef {{ effect: OrderEffect, state: OrderEffect['state'], amount: number,
 *   done: { refundId: string, manual: boolean, gateway: string } | null, warning: Warning | null,
 *   error?: unknown }} EffectOutcome `error`: what Payments answered when it did not refund
 */

/**
 * What the website's settings say for every transition (the options of each move are in the order flow).
 * @param {Site} s
 * @returns {Promise<import('../core/transitions.js').TransitionRules>}
 */
export const rulesOf = async (s) => {
	const checkout = await s.values('checkout');
	return {
		paymentWindowMinutes: Number(checkout.paymentWindowMinutes ?? 0),
		loyalty: s.has('loyalty') ? await s.values('loyalty') : null,
		timeZone: (await s.format()).timeZone || 'UTC',
	};
};

/**
 * The part of a transition's guard that keeps money right: a move into a canceled or refunded status works out what
 * is left to refund from the order as read, so it happens only while the order's refunds are as read and no refund runs
 * at Payments for it (a staff refund taken meanwhile: the move gets 409 `conflict`).
 * @param {OrderRecord} order @param {import('../core/transitions.js').TransitionPlan} plan
 * @returns {Record<string, unknown>}
 */
const moneyGuard = (order, plan) =>
	plan.stage === 'cancelled' || plan.stage === 'refunded'
		? {
				'payment.refunded': order.payment.refunded,
				effects: { $not: { $elemMatch: { state: 'pending', runningAt: { $ne: null } } } },
			}
		: {};

/**
 * A refund Payments made for an order's payment that the order does not record (its entries keep Payments' refund
 * ids), of an amount: the refund an effect asked for whose answer was lost.
 * @param {OrderRecord} order @param {import('./service.js').PaymentFacts} payment @param {number} amount
 */
const unrecordedRefund = (order, payment, amount) => {
	const recorded = new Set(order.refunds.map((entry) => entry.refundId).filter(Boolean));
	return payment.refunds.find((refund) => refund.id && !recorded.has(refund.id) && refund.amount === amount) ?? null;
};

/**
 * What staff are told when a refund through Payments is not sent: the order was refunded meanwhile.
 * @param {OrderEffect} effect
 * @returns {Warning}
 */
const refundSkipped = (effect) => ({
	code: 'refund_skipped',
	values: { amount: effect.amount },
	text: 'A refund through Payments was not sent: the order was refunded meanwhile. Check its refunds.',
});

/**
 * @param {Product} product
 * @param {Service} service
 * @param {{ refunded?: (s: Site, order: OrderRecord) => Promise<OrderRecord> }} [hooks] `refunded`: a staff refund
 *   Payments did not answer at once is done now (given the order as it is after it, returns it as it is then)
 */
export const createTransitions = (product, service, { refunded } = {}) => {
	const changed = () => problem('conflict', 'The order changed meanwhile; reload it and try again.');

	/** @param {Site} s */
	const ordersOf = async (s) => (await s.data()).collection(COLLECTIONS.orders);

	/**
	 * A claim's refund through Payments that did not happen (refused by Payments, or not sent because the order was
	 * refunded otherwise) gives the claim back what it reserved: its refund as it was before, and the status it had when
	 * it had refunded nothing before, with an entry by the shop itself; only while the claim is as that refund left it.
	 * Its units stay counted as returned and its points as taken back, so refunded again it counts them once.
	 * @param {Site} s @param {OrderEffect} effect
	 */
	const claimBack = async (s, effect) => {
		const claim = effect.record?.claim;
		if (!claim) return;
		const { before } = claim;
		// refunded before: it stays in the refunded status the refund put it in; else back where it was (E18)
		const back = before.refundAmount > 0 ? null : { status: before.status, role: before.role };
		const status = back?.status ?? claim.status;
		/** @type {Record<string, unknown>} */
		const set = { ...(back ?? {}), refundAmount: before.refundAmount, refundId: before.refundId };
		/** @type {Record<string, ''>} */
		const unset = {};
		if (before.refundMethod === null) unset.refundMethod = '';
		else set.refundMethod = before.refundMethod;
		if (before.refundReference === null) unset.refundReference = '';
		else set.refundReference = before.refundReference;
		await (await s.data()).collection(COLLECTIONS.returns).updateOne(
			{ websiteId: s.websiteId, id: claim.id, role: 'refunded', refundAmount: claim.refundAmount },
			{
				$set: set,
				...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
				$push: {
					history: { at: new Date(product.now()), status, role: back?.role ?? 'refunded', by: 'system', note: '' },
				},
			},
		);
	};

	/** @param {Site} s @param {string} id @returns {Promise<OrderRecord | null>} */
	const read = async (s, id) =>
		/** @type {OrderRecord | null} */ (
			await (await ordersOf(s)).findOne({ websiteId: s.websiteId, id }, { projection: { _id: 0 } })
		);

	/**
	 * Run a plan in one transaction (with `more` the order must still match too, and with `remove` the order deleted in
	 * it). Throws 409 `conflict` when the order changed meanwhile (or its loyalty account kept changing) and 422 for a
	 * serial number the shop refuses; nothing is written then.
	 * @param {Site} s @param {OrderRecord} order as read @param {TransitionPlan} plan
	 * @param {{ more?: Record<string, unknown>, remove?: boolean }} [how]
	 */
	const run = async (s, order, plan, { more = {}, remove = false } = {}) => {
		const data = await s.data();
		const guard = { ...plan.guard, ...moneyGuard(order, plan), ...more };
		/** @type {Record<string, unknown>} */
		const update = { $set: plan.set };
		if (Object.keys(plan.push).length > 0) update.$push = plan.push;
		if (Object.keys(plan.inc).length > 0) update.$inc = plan.inc;
		for (let attempt = 1; ; attempt += 1) {
			try {
				const done = await applyTransition(
					data,
					{ orderId: order.id, guard, update, effects: plan.ledger, remove },
					{ now: product.now() },
				);
				if (!done) throw changed();
				return;
			} catch (error) {
				const refusal = unitRefusalOf(error);
				if (refusal) throw service.invalid(refusal.field, refusal.message);
				if (!isPointsChanged(error)) throw error;
				if (attempt >= TRIES) throw changed();
			}
		}
	};

	/**
	 * Run a plan in one transaction (`run`).
	 * @param {Site} s @param {OrderRecord} order as read @param {TransitionPlan} plan
	 * @returns {Promise<OrderRecord>} the order after it
	 */
	const apply = async (s, order, plan) => {
		await run(s, order, plan);
		return /** @type {OrderRecord} */ (await read(s, order.id));
	};

	/**
	 * Delete an order with what it gives back (`planRelease`, or nothing) in one transaction, only while it is as read:
	 * its status, `updatedAt` and facts, its money (paid and refunded) and no refund pending at Payments (E31).
	 * @param {Site} s @param {OrderRecord} order as read @param {TransitionPlan | null} plan
	 * @returns {Promise<boolean>} false when the order changed meanwhile (nothing given back, nothing deleted)
	 */
	const remove = async (s, order, plan) => {
		const more = {
			'payment.paid': order.payment.paid,
			'payment.refunded': order.payment.refunded,
			effects: { $not: { $elemMatch: { state: 'pending' } } },
		};
		if (!plan) {
			const gone = await (
				await ordersOf(s)
			).deleteOne({ ...more, websiteId: s.websiteId, id: order.id, status: order.status, updatedAt: order.updatedAt });
			return gone.deletedCount === 1;
		}
		try {
			await run(s, order, plan, { more, remove: true });
			return true;
		} catch (error) {
			if (/** @type {any} */ (error)?.code === 'conflict') return false;
			throw error;
		}
	};

	/**
	 * Change one effect of an order while it is still as it was read (its state, and nobody running it).
	 * @param {Site} s @param {string} orderId @param {OrderEffect} effect @param {Record<string, unknown>} patch
	 * @returns {Promise<boolean>} whether it changed it
	 */
	const mark = async (s, orderId, effect, patch) =>
		(
			await (
				await ordersOf(s)
			).updateOne(
				{
					websiteId: s.websiteId,
					id: orderId,
					effects: { $elemMatch: { id: effect.id, state: effect.state, runningAt: effect.runningAt ?? null } },
				},
				{ $set: Object.fromEntries(Object.entries(patch).map(([key, value]) => [`effects.$.${key}`, value])) },
			)
		).modifiedCount === 1;

	/**
	 * Take an effect to run it: only while the order's refunds are as read (the check that the refund is still due
	 * stands) and nobody else runs it. While it runs, staff cannot refund on the order (`dropPending`), so the money never
	 * goes back twice.
	 * @param {Site} s @param {OrderRecord} order as read @param {OrderEffect} effect @param {Date} now
	 */
	const claim = async (s, order, effect, now) =>
		(
			await (
				await ordersOf(s)
			).updateOne(
				{
					websiteId: s.websiteId,
					id: order.id,
					'payment.refunded': order.payment.refunded,
					effects: { $elemMatch: { id: effect.id, state: 'pending', runningAt: effect.runningAt ?? null } },
				},
				{ $set: { 'effects.$.runningAt': now } },
			)
		).modifiedCount === 1;

	/**
	 * What staff are told when a refund a cancel (`cancel_refund_failed`) or a move into a refunded status
	 * (`refund_failed`) asked of Payments did not go through.
	 * @param {OrderEffect} effect @param {string} detail @param {boolean} retried it is tried again later
	 * @returns {Warning}
	 */
	const refundFailed = (effect, detail, retried) => {
		if (effect.record)
			return {
				code: retried ? 'refund_pending' : 'refund_failed',
				values: { amount: effect.amount },
				text: retried
					? `Payments did not answer (${detail}): the refund is kept on the order and sent again when the order is next used. Do not refund it again.`
					: `Payments refused the refund (${detail}).`,
			};
		const what = /:cancel(:\d+)?$/.test(effect.id) ? 'canceled' : 'refunded';
		return {
			code: what === 'canceled' ? 'cancel_refund_failed' : 'refund_failed',
			values: { amount: effect.amount },
			text: retried
				? `The order is ${what}, but the refund failed (${detail}); it is tried again when the order is next used, or refund it from the order.`
				: `The order is ${what}, but the refund failed (${detail}); refund it from the order.`,
		};
	};

	/**
	 * Record a refund Payments made for an effect (the payment state, the refund entry and the effect done) in one
	 * write, tried again while the order changes meanwhile; false when the effect was recorded by someone else.
	 * @param {Site} s @param {string} orderId @param {OrderEffect} effect
	 * @param {{ refundId: string, manual: boolean, gateway: string }} done
	 */
	const recordRefund = async (s, orderId, effect, done) => {
		const orders = await ordersOf(s);
		const now = product.now();
		for (let attempt = 1; attempt <= RECORD_TRIES; attempt += 1) {
			const current = await read(s, orderId);
			const found = current?.effects?.find((entry) => entry.id === effect.id);
			if (!current || !found || found.state === 'done') return false;
			// a staff refund also records its part given back by hand and its history entry (the refund lock)
			const record = effect.record ?? null;
			const refunded = current.payment.refunded + effect.amount + (record?.manual ?? 0);
			const recorded = (record?.manual ?? 0) > 0 || done.manual;
			const result = await orders.updateOne(
				{
					websiteId: s.websiteId,
					id: orderId,
					'payment.refunded': current.payment.refunded,
					effects: { $elemMatch: { id: effect.id, state: found.state } },
				},
				{
					$set: {
						'payment.refunded': refunded,
						'payment.state': stateAfterRefund(current.payment.paid, refunded),
						'effects.$.state': 'done',
						'effects.$.doneAt': new Date(now),
						'effects.$.refundId': done.refundId || null,
						'effects.$.tries': (found.tries ?? 0) + 1,
						'effects.$.triedAt': new Date(now),
						'effects.$.runningAt': null,
					},
					$push: {
						refunds: {
							$each: [
								paymentsRefundEntry(effect.by, now, done, {
									amount: effect.amount,
									note: effect.note,
									...(record ? { reference: record.reference, claimId: record.claimId } : {}),
								}),
								...(record?.entries ?? []),
							],
						},
						...(record
							? { history: { ...record.history, at: new Date(now), ...(recorded ? record.recordedNote : record.note) } }
							: {}),
					},
				},
			);
			if (result.modifiedCount === 1) return true;
		}
		return false;
	};

	/**
	 * Run one external effect of an order (a refund through Payments, once: its id is the Idempotency-Key). `claimed`: the
	 * effect was written already taken (`runningAt`, a staff refund's lock), so it is sent at once. An effect asked of
	 * Payments before is first looked for in what Payments shows (`payment`: read already): a refund Payments made that
	 * the order does not record is recorded as this one's, not asked again; Payments that cannot be read leaves it
	 * pending. Skipped when the order was refunded meanwhile (warning `refund_skipped`). A claim's refund skipped, or
	 * refused on a later try, gives the claim back its refund (`claimBack`).
	 * @param {Site} s @param {OrderRecord} order as read @param {OrderEffect} effect
	 * @param {{ claimed?: boolean, payment?: import('./service.js').PaymentFacts }} [how]
	 * @returns {Promise<EffectOutcome>}
	 */
	const runEffect = async (s, order, effect, { claimed = false, payment } = {}) => {
		const now = new Date(product.now());
		/** @type {EffectOutcome} */
		const untouched = { effect, state: 'pending', amount: 0, done: null, warning: null };
		// asked of Payments before (its answer may have been lost): a staff refund's lock is its first ask
		const askedBefore = !claimed && ((effect.tries ?? 0) > 0 || Boolean(effect.runningAt));
		if (!claimed) {
			// only while what Payments holds of the order still covers it: staff may have refunded it meanwhile
			const { online } = refundSplit(order, refundable(order));
			if (!order.payment.paymentId || online < effect.amount) {
				const skipped = { state: 'skipped', triedAt: now, runningAt: null, detail: 'Refunded meanwhile' };
				if (await mark(s, order.id, effect, skipped)) await claimBack(s, effect);
				return { effect, state: 'skipped', amount: 0, done: null, warning: refundSkipped(effect) };
			}
			// taken while the order's refunds are as read, so a refund staff record meanwhile stops it (or waits for it)
			if (!(await claim(s, order, effect, now))) return untouched;
		}
		const running = claimed && effect.runningAt ? new Date(effect.runningAt) : now;
		if (askedBefore) {
			// what Payments shows first: a refund it made that the order does not record yet is this one, recorded and never
			// asked again (Payments forgets an Idempotency-Key after 24 hours: a second ask would refund twice, or be refused)
			/** @type {import('./service.js').PaymentFacts} */
			let facts;
			try {
				facts = payment ?? (await service.payments.read(s, /** @type {string} */ (order.payment.paymentId)));
			} catch {
				const detail = 'Payments cannot be reached right now.';
				await mark(s, order.id, { ...effect, runningAt: running }, { triedAt: now, runningAt: null, detail });
				return { ...untouched, warning: refundFailed(effect, detail, true) };
			}
			const made = unrecordedRefund(order, facts, effect.amount);
			if (made) {
				const done = { refundId: made.id, manual: made.manual, gateway: facts.gateway };
				if (!(await recordRefund(s, order.id, effect, done))) return untouched;
				return { effect, state: 'done', amount: effect.amount, done, warning: null };
			}
		}
		/** @type {{ refundId: string, manual: boolean, gateway: string }} */
		let done;
		try {
			done = await service.payments.refund(s, /** @type {string} */ (order.payment.paymentId), {
				amount: effect.amount,
				reason: effect.reason,
				idempotencyKey: effect.id,
				by: effect.by,
			});
		} catch (error) {
			const failed = /** @type {any} */ (error);
			const detail = String(failed?.detail ?? 'Payments cannot be reached right now.');
			// refused by Payments: not done (staff refund it from the order); else it may have been done: tried again
			const state = failed?.code === 'payments_refused' ? 'failed' : 'pending';
			const marked = await mark(
				s,
				order.id,
				{ ...effect, runningAt: running },
				{
					state,
					tries: (effect.tries ?? 0) + 1,
					triedAt: now,
					runningAt: null,
					detail,
				},
			);
			// a claim's refund refused on a later try gives the claim back its refund (a staff refund's first ask is
			// refused to the staff member, whose claim is put back as it was)
			if (marked && state === 'failed' && !claimed) await claimBack(s, effect);
			return {
				effect,
				state,
				amount: 0,
				done: null,
				warning: refundFailed(effect, detail, state === 'pending'),
				error: failed,
			};
		}
		// recorded once; an order that kept changing leaves it running, and the next try (same key) records it
		if (!(await recordRefund(s, order.id, effect, done))) return untouched;
		return { effect, state: 'done', amount: effect.amount, done, warning: null };
	};

	/**
	 * A staff refund through Payments under the order's refund lock: written on the order as an effect already taken
	 * (with the part recorded by hand and the history entry it records with it), only while the order's refunds are as
	 * read and no refund is pending, then sent at once. Throws 409 `conflict` when another refund took the order first.
	 * @param {Site} s @param {OrderRecord} order as read
	 * @param {Omit<OrderEffect, 'state' | 'tries' | 'triedAt' | 'runningAt'>} refund
	 * @returns {Promise<{ order: OrderRecord, outcome: EffectOutcome }>}
	 */
	const lockedRefund = async (s, order, refund) => {
		const now = new Date(product.now());
		/** @type {OrderEffect} */
		const effect = { ...refund, state: 'pending', tries: 0, triedAt: null, runningAt: now };
		const taken = await (
			await ordersOf(s)
		).updateOne(
			{
				websiteId: s.websiteId,
				id: order.id,
				'payment.refunded': order.payment.refunded,
				effects: { $not: { $elemMatch: { state: 'pending' } } },
			},
			{ $push: { effects: effect } },
		);
		if (taken.modifiedCount !== 1) throw changed();
		const outcome = await runEffect(s, order, effect, { claimed: true });
		return { order: /** @type {OrderRecord} */ (await read(s, order.id)), outcome };
	};

	/**
	 * Run the pending effects of an order: those named (right after its transition), else those not tried in the last
	 * {@link EFFECT_RETRY_MS} (on use); never one another call runs now (taken in the last {@link EFFECT_RUNNING_MS}).
	 * Never throws for a failed effect: it stays pending or failed.
	 * @param {Site} s @param {OrderRecord} order as read @param {{ ids?: string[] }} [which]
	 * @returns {Promise<{ order: OrderRecord, outcomes: EffectOutcome[] }>}
	 */
	const runEffects = async (s, order, { ids } = {}) => {
		const now = product.now();
		const due = (order.effects ?? []).filter(
			(effect) =>
				effect.state === 'pending' &&
				(!effect.runningAt || now - new Date(effect.runningAt).getTime() >= EFFECT_RUNNING_MS) &&
				(ids ? ids.includes(effect.id) : !effect.triedAt || now - new Date(effect.triedAt).getTime() >= EFFECT_RETRY_MS),
		);
		if (due.length === 0) return { order, outcomes: [] };
		/** @type {EffectOutcome[]} */
		const outcomes = [];
		let current = order;
		for (const effect of due) {
			outcomes.push(await runEffect(s, current, effect));
			current = (await read(s, order.id)) ?? current;
		}
		return { order: current, outcomes };
	};

	/**
	 * Before staff refund an order by hand, the refunds a transition left pending at Payments are settled, so the money
	 * never goes back twice. One never sent, or sent while Payments now shows nothing it refunded that the order does not
	 * record, is not sent any more (`skipped`, all in one write while the order's refunds are as read): `ok`. When Payments
	 * shows money refunded that the order does not record (an answer that never came), the pending refund is sent again
	 * with its Idempotency-Key, which gets Payments' first answer if it was done (recorded now, or refused when it would be
	 * too much): `changed`, staff reload. `running`: one runs at Payments right now (it records itself); `unavailable`:
	 * Payments cannot be reached to tell. A claim's refund not sent any more gives the claim back its refund.
	 * @param {Site} s @param {OrderRecord} order as read
	 * @returns {Promise<'ok' | 'changed' | 'running' | 'unavailable'>}
	 */
	const dropPending = async (s, order) => {
		const pending = (order.effects ?? []).filter((effect) => effect.state === 'pending');
		if (pending.length === 0) return 'ok';
		const now = product.now();
		if (pending.some((effect) => effect.runningAt && now - new Date(effect.runningAt).getTime() < EFFECT_RUNNING_MS))
			return 'running';
		const sent = pending.filter((effect) => (effect.tries ?? 0) > 0 || effect.runningAt);
		if (sent.length > 0 && order.payment.paymentId) {
			/** @type {import('./service.js').PaymentFacts} */
			let payment;
			try {
				payment = await service.payments.read(s, order.payment.paymentId);
			} catch {
				return 'unavailable';
			}
			// what Payments refunded of the payment that the order records
			const recorded = order.refunds.filter((entry) => entry.refundId).reduce((sum, entry) => sum + entry.amount, 0);
			if (payment.refunded > recorded) {
				/** @type {EffectOutcome[]} */
				const outcomes = [];
				for (const effect of sent) outcomes.push(await runEffect(s, order, effect, { payment }));
				await announce(s, (await read(s, order.id)) ?? order, outcomes);
				const waiting = outcomes.filter((outcome) => outcome.state === 'pending');
				// not reached (a warning says why), or taken by another call meanwhile
				if (waiting.some((outcome) => outcome.warning)) return 'unavailable';
				return waiting.length > 0 ? 'running' : 'changed';
			}
		}
		const result = await (
			await ordersOf(s)
		).updateOne(
			{
				websiteId: s.websiteId,
				id: order.id,
				'payment.refunded': order.payment.refunded,
				$and: pending.map((effect) => ({
					effects: { $elemMatch: { id: effect.id, state: 'pending', runningAt: effect.runningAt ?? null } },
				})),
			},
			{
				$set: Object.fromEntries(
					pending.flatMap((effect, index) => [
						[`effects.$[e${index}].state`, 'skipped'],
						[`effects.$[e${index}].runningAt`, null],
						[`effects.$[e${index}].triedAt`, new Date(now)],
						[`effects.$[e${index}].detail`, 'Refunded from the order instead'],
					]),
				),
			},
			{ arrayFilters: pending.map((effect, index) => ({ [`e${index}.id`]: effect.id })) },
		);
		if (result.modifiedCount !== 1) return 'changed';
		// a claim's refund not sent any more gives the claim back its refund
		for (const effect of pending) await claimBack(s, effect);
		return 'ok';
	};

	/**
	 * Tell what a retried effect did: the refund in the activity log (named after the staff member whose move asked for
	 * it) and the `order.refunded` hook (with the claim a claim's refund is for); a staff refund done now tells the
	 * caller too (`refunded`, which may move the order).
	 * @param {Site} s @param {OrderRecord} order @param {EffectOutcome[]} outcomes
	 * @returns {Promise<OrderRecord>} the order as it is now
	 */
	const announce = async (s, order, outcomes) => {
		const { money } = await s.format();
		const done = outcomes.filter((outcome) => outcome.state === 'done');
		for (const outcome of done) {
			await product.activity.record(
				{ websiteId: s.websiteId, merchantId: s.merchantId, after: s.ctx.after },
				{
					actor: outcome.effect.by,
					action: 'order.refunded',
					target: order.id,
					label: order.number,
					detail: `Refunded ${money(outcome.amount, order.totals.currency)}`,
				},
			);
			await service.emit('order.refunded', s, {
				order,
				amount: outcome.amount,
				claimId: outcome.effect.record?.claimId ?? null,
			});
		}
		return refunded && done.some((outcome) => outcome.effect.record) ? refunded(s, order) : order;
	};

	/**
	 * Try the pending effects of one order again (staff opened it), at most every {@link EFFECT_RETRY_MS}.
	 * @param {Site} s @param {OrderRecord} order
	 * @returns {Promise<OrderRecord>}
	 */
	const settle = async (s, order) => {
		const { order: after, outcomes } = await runEffects(s, order);
		return announce(s, after, outcomes);
	};

	/**
	 * Work on use: the pending effects of the website's orders not tried in the last minute (a bounded batch).
	 * @param {Site} s
	 */
	const sweep = async (s) => {
		const orders = await ordersOf(s);
		const now = product.now();
		const due = /** @type {OrderRecord[]} */ (
			await orders
				.find(
					{
						websiteId: s.websiteId,
						// the equality lets the partial index of pending effects answer (by_pending_effect)
						'effects.state': 'pending',
						effects: {
							$elemMatch: {
								state: 'pending',
								$and: [
									{ $or: [{ triedAt: null }, { triedAt: { $lte: new Date(now - EFFECT_RETRY_MS) } }] },
									{ $or: [{ runningAt: null }, { runningAt: { $lte: new Date(now - EFFECT_RUNNING_MS) } }] },
								],
							},
						},
					},
					{ projection: { _id: 0 } },
				)
				.limit(EFFECT_BATCH)
				.toArray()
		);
		for (const order of due) await settle(s, order);
	};

	return Object.freeze({ apply, remove, runEffects, settle, sweep, dropPending, lockedRefund, announce });
};

/** @typedef {ReturnType<typeof createTransitions>} Transitions */
