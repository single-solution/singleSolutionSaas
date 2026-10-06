/**
 * Orders after placement: access (server key, the shopper's identity, or the order's access token), the lifecycle
 * Checkout owns (confirm, cancel, expire), the Order Manager's lifecycle arriving as standard events (`order.paid`,
 * `order.completed`, `order.cancelled`, `order.refunded`), the success view, and the scheduled sweep (expired holds,
 * abandoned carts).
 *
 * Expiry is checked on read: an order whose hold passed is cancelled (stock, codes and points released) the moment it is
 * accessed, confirmed or listed, and it never counts as open — the sweep (daily cron, throttled runs after requests)
 * only catches up on orders nobody touched.
 *
 * Every move is a compare-and-set on the status, so a re-delivered event or a double click changes nothing twice. Stock
 * goes back only for orders that were not completed (lesson A21); payments and refunds are recorded on the order with
 * amount, method, reference and actor (lesson A22).
 */
import { timingSafeEqual } from 'node:crypto';
import { formatMoney } from '../core/money.js';
import {
	TRANSITIONS,
	customerMayCancel,
	customerRef,
	eventLines,
	holdExpired,
	orderView,
	releasesStock,
} from '../core/orders.js';
import { UNCONFIRMED } from '../core/payments.js';
import { eventAmounts } from '../core/pricing.js';
import { successSteps } from '../core/success.js';
import { cartUpdatedData, subtotalOf } from '../core/cart.js';

/** @typedef {import('./context.js').Site} Site */
/** @typedef {import('./context.js').Checkout} Checkout */
/** @typedef {import('./carts.js').Requester} Requester */
/** @typedef {{ type: string, id?: string | null }} Actor */

/**
 * @param {Checkout} checkout
 */
export const createOrdersService = (checkout) => {
	const { app, integrations } = checkout;
	const iso = () => new Date(app.now()).toISOString();

	/**
	 * @param {Site} site
	 * @param {string} id
	 * @param {Requester} who
	 * @param {unknown} [token] order access token (guests)
	 * @returns {Promise<Record<string, any> | null>}
	 */
	const access = async (site, id, who, token) => {
		if (typeof id !== 'string' || id.length > 64) return null;
		const order = await site.repos.orders.get(id);
		if (!order) return null;
		if (who.kind === 'sk' || who.kind === 'session') return expireIfDue(site, order);
		if (who.subject && order.customerId === who.subject) return expireIfDue(site, order);
		if (typeof token === 'string' && token.length <= 64 && typeof order.accessTokenHash === 'string') {
			const given = Buffer.from(app.hash(token));
			const stored = Buffer.from(order.accessTokenHash);
			if (given.length === stored.length && timingSafeEqual(given, stored)) return expireIfDue(site, order);
		}
		return null;
	};

	/**
	 * Order view with what the requester may do.
	 * @param {Site} site
	 * @param {Record<string, any>} order
	 * @param {Requester} who
	 */
	const view = (site, order, who) => ({
		...orderView(order),
		cancellable:
			who.kind === 'sk' || who.kind === 'session'
				? TRANSITIONS.cancel.includes(order.status)
				: customerMayCancel(order, site.settings.place.customer_cancellable),
	});

	/**
	 * Give an order's stock back (local decrements or the Catalog reservation).
	 * @param {Site} site
	 * @param {Record<string, any>} order
	 */
	const releaseStock = async (site, order) => {
		if (order.stock?.source === 'checkout')
			for (const line of order.lines)
				await site.repos.items.give({ itemId: line.itemId, variantId: line.variantId, quantity: line.quantity });
		if (order.stock?.source === 'catalog' && order.stock.reservationId) {
			const { catalog } = await checkout.connectionsFor(site);
			await integrations.catalog.release(catalog, order.stock.reservationId);
		}
	};

	/**
	 * Cancel an order (customer, merchant, expiry or an `order.cancelled@1` from elsewhere).
	 * @param {Site} site
	 * @param {Record<string, any>} order
	 * @param {{ reason: string, actor: Actor, publish: boolean, from?: readonly string[] }} options
	 * @returns {Promise<Record<string, any> | null>} the cancelled order, null when it could not move
	 */
	const cancel = async (site, order, { reason, actor, publish, from = TRANSITIONS.cancel }) => {
		const release = releasesStock(order);
		const moved = await site.repos.orders.transition(order.id, from, {
			set: {
				status: 'cancelled',
				expiresAt: null,
				cancelledAt: new Date(app.now()),
				cancelReason: reason,
				...(release ? { 'stock.state': 'released' } : {}),
			},
			push: { timeline: { status: 'cancelled', at: iso(), actor, reason } },
			...(order.expiresAt && reason === 'expired' ? { filter: { expiresAt: { $lte: new Date(app.now()) } } } : {}),
		});
		if (!moved) return null;
		if (release) await releaseStock(site, moved);
		if (publish) {
			const ref = customerRef(moved.customer ?? {});
			await checkout.publish(
				site,
				'order.cancelled@1',
				{
					orderId: moved.id,
					number: moved.number,
					reason,
					...(ref ? { customer: ref } : {}),
					currency: moved.currency,
					lines: eventLines(moved.lines),
					amounts: eventAmounts(moved.totals),
				},
				`${moved.id}:cancelled`,
			);
		}
		return moved;
	};

	/**
	 * Expire on read: when Checkout owns expiry and the order's hold passed, cancel it now (releasing what it held) and
	 * return the order as it is after that; any other order is returned unchanged.
	 * @param {Site} site
	 * @param {Record<string, any>} order
	 * @returns {Promise<Record<string, any>>}
	 */
	const expireIfDue = async (site, order) => {
		if (site.settings.place.expiry_owner !== 'checkout' || !holdExpired(order, app.now())) return order;
		const moved = await cancel(site, order, {
			reason: 'expired',
			actor: { type: 'system' },
			publish: true,
			from: TRANSITIONS.expire,
		});
		// lost a race (paid, confirmed or cancelled meanwhile): the stored order is the truth
		return moved ?? (await site.repos.orders.get(order.id)) ?? order;
	};

	/**
	 * Confirm an unconfirmed order (merchant: COD confirmed by call, transfer seen in the bank).
	 * @param {Site} site
	 * @param {Record<string, any>} order
	 * @param {{ actor: Actor, by: 'merchant' | 'payment' }} options
	 */
	const confirm = async (site, order, { actor, by }) => {
		// a merchant confirming after the hold passed is too late (a payment that arrives late still confirms the order)
		if (by === 'merchant' && (await expireIfDue(site, order)) !== order) return null;
		const moved = await site.repos.orders.transition(order.id, TRANSITIONS.confirm, {
			set: { status: 'confirmed', expiresAt: null, confirmedAt: new Date(app.now()) },
			push: { timeline: { status: 'confirmed', at: iso(), actor } },
		});
		if (moved)
			await checkout.publish(
				site,
				'checkout.order_confirmed@1',
				{ orderId: moved.id, number: moved.number, method: moved.payment.method, by },
				`${moved.id}:confirmed`,
			);
		return moved;
	};

	/**
	 * Record a payment (gateway success, `order.paid@1`, merchant). Confirms a `pending_payment` order once what is due
	 * now is covered; duplicates (same reference) are ignored.
	 * @param {Site} site
	 * @param {Record<string, any>} order
	 * @param {{ amount: number, method: string, reference: string | null, actor: Actor, publish: boolean }} payment
	 */
	const recordPayment = async (site, order, { amount, method, reference, actor, publish }) => {
		if (reference && (order.payments ?? []).some((/** @type {any} */ p) => p.reference === reference && p.status === 'paid'))
			return order;
		const paidSoFar = (order.payments ?? [])
			.filter((/** @type {any} */ p) => p.status === 'paid')
			.reduce((/** @type {number} */ sum, /** @type {any} */ p) => sum + p.amount, 0);
		const covered = paidSoFar + amount >= (order.payment.dueNow > 0 ? order.payment.dueNow : order.totals.total);
		const fully = paidSoFar + amount >= order.totals.total;
		const moved = await site.repos.orders.transition(order.id, [...TRANSITIONS.cancel, 'completed'], {
			set: {
				'payment.status': fully ? 'paid' : covered ? 'partially_paid' : order.payment.status,
				...(reference ? { 'payment.reference': reference } : {}),
			},
			push: { payments: { method, amount, status: 'paid', reference, actor, at: iso() } },
		});
		if (!moved) return null;
		if (publish)
			await checkout.publish(
				site,
				'order.paid@1',
				{ orderId: moved.id, amount: { amount, currency: moved.currency }, method, ...(reference ? { reference } : {}) },
				`${moved.id}:paid:${reference ?? paidSoFar + amount}`,
			);
		if (covered && moved.status === 'pending_payment') return (await confirm(site, moved, { actor, by: 'payment' })) ?? moved;
		return moved;
	};

	/**
	 * Event consumers for the Order Manager's lifecycle (and any other checkout's): only orders Checkout placed.
	 * @param {Site} site
	 * @param {string} type
	 * @param {any} event
	 */
	const onOrderEvent = async (site, type, event) => {
		const data = event?.data ?? {};
		if (typeof data.orderId !== 'string') return false;
		const order = await site.repos.orders.get(data.orderId);
		if (!order) return false;
		const actor = { type: 'event', id: String(event.id ?? '') };
		if (type === 'order.cancelled@1')
			return Boolean(
				await cancel(site, order, {
					reason: typeof data.reason === 'string' ? data.reason.slice(0, 200) : 'cancelled',
					actor,
					publish: false,
				}),
			);
		if (type === 'order.completed@1')
			return Boolean(
				await site.repos.orders.transition(order.id, TRANSITIONS.complete, {
					set: {
						status: 'completed',
						expiresAt: null,
						completedAt: new Date(app.now()),
						'stock.state': order.stock?.state === 'reserved' ? 'committed' : order.stock?.state,
					},
					push: { timeline: { status: 'completed', at: iso(), actor } },
				}),
			);
		if (type === 'order.paid@1') {
			const amount = data.amount?.amount;
			if (!Number.isSafeInteger(amount) || data.amount?.currency !== order.currency) return false;
			return Boolean(
				await recordPayment(site, order, {
					amount,
					method: typeof data.method === 'string' ? data.method.slice(0, 64) : order.payment.method,
					reference: typeof data.reference === 'string' ? data.reference.slice(0, 200) : `event:${event.id}`,
					actor,
					publish: false,
				}),
			);
		}
		if (type === 'order.refunded@1') {
			const amount = data.amount?.amount;
			if (!Number.isSafeInteger(amount) || (order.refunds ?? []).some((/** @type {any} */ r) => r.eventId === event.id))
				return false;
			const refunded =
				(order.refunds ?? []).reduce((/** @type {number} */ sum, /** @type {any} */ r) => sum + r.amount, 0) + amount;
			const full = refunded >= order.totals.total;
			return Boolean(
				await site.repos.orders.transition(order.id, [...TRANSITIONS.cancel, 'completed', 'cancelled', 'refunded'], {
					set: { 'payment.status': full ? 'refunded' : 'partially_refunded', ...(full ? { status: 'refunded' } : {}) },
					push: {
						refunds: {
							eventId: event.id,
							amount,
							reason: typeof data.reason === 'string' ? data.reason.slice(0, 500) : null,
							at: iso(),
						},
						...(full ? { timeline: { status: 'refunded', at: iso(), actor } } : {}),
					},
				}),
			);
		}
		return false;
	};

	/**
	 * The success view: order, steps, bank details, links.
	 * @param {Site} site
	 * @param {Record<string, any>} order
	 * @param {Requester} who
	 */
	const success = (site, order, who) => {
		const t = checkout.translator(site.settings.language);
		const locale = t('checkout.locale');
		const money = (/** @type {number} */ amount) => formatMoney(amount, order.currency, locale);
		const proofsEnabled = site.settings.enabled('payment_proofs');
		const steps = successSteps(order, site.settings.success, { formatMoney: money, proofsEnabled });
		const unpaidTransfer =
			order.status === 'pending_payment' &&
			order.payment.status !== 'paid' &&
			(order.payment.method === 'bank_transfer' || (order.payment.method === 'cod' && order.payment.advance > 0));
		return {
			order: view(site, order, who),
			title: t(`success.title.${order.status}`),
			steps: steps.map((step) => ({ key: step.key, text: t(step.text, step.params), when: step.when, current: step.current })),
			bankDetails: unpaidTransfer && site.settings.success.show_bank_details ? site.settings.manual.bank_details : [],
			proofUpload: unpaidTransfer && proofsEnabled,
			continueUrl: site.settings.success.continue_url,
		};
	};

	/**
	 * Cancel expired holds (when Checkout owns expiry). Returns how many were cancelled.
	 * @param {Site} site
	 * @param {{ limit: number }} options
	 */
	const expire = async (site, { limit }) => {
		if (site.settings.place.expiry_owner !== 'checkout') return 0;
		const due = await site.repos.orders.expiring(UNCONFIRMED, new Date(app.now()), limit);
		let count = 0;
		for (const order of due)
			if (await cancel(site, order, { reason: 'expired', actor: { type: 'system' }, publish: true, from: TRANSITIONS.expire }))
				count += 1;
		return count;
	};

	/**
	 * Publish `checkout.cart_abandoned@1` once for carts untouched long enough.
	 * @param {Site} site
	 * @param {{ limit: number }} options
	 */
	const abandon = async (site, { limit }) => {
		const hours = site.settings.cart.abandoned_after_hours;
		if (hours <= 0) return 0;
		const carts = await site.repos.carts.abandonable(new Date(app.now() - hours * 3_600_000), limit);
		let count = 0;
		for (const cart of carts) {
			if (!cart.currency || !(await site.repos.carts.markAbandoned(cart.id, new Date(app.now())))) continue;
			const data = cartUpdatedData(cart);
			await checkout.publish(
				site,
				'checkout.cart_abandoned@1',
				{
					cartId: cart.id,
					...(cart.customerId ? { subject: String(cart.customerId).slice(0, 255) } : {}),
					currency: cart.currency,
					lineCount: cart.lines.length,
					quantity: cart.lines.reduce((/** @type {number} */ sum, /** @type {any} */ line) => sum + line.quantity, 0),
					subtotalAmount: subtotalOf(cart.lines),
					itemIds: [...new Set(data.lines.map((line) => line.itemId))].slice(0, 50),
					updatedAt: new Date(cart.updatedAt).toISOString(),
				},
				`${cart.id}:abandoned`,
			);
			count += 1;
		}
		return count;
	};

	return Object.freeze({
		access,
		view,
		cancel,
		expireIfDue,
		confirm,
		recordPayment,
		onOrderEvent,
		success,
		expire,
		abandon,
		releaseStock,
	});
};

/** @typedef {ReturnType<typeof createOrdersService>} OrdersService */
