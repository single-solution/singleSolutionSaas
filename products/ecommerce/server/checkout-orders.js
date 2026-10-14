/**
 * Placing and paying orders, and the shopper's own orders (PLAN 0.8.8; payment confirmation PLAN 0.3; PLAN 0.8.10
 * E18–E25, E30).
 *
 * - Placing: the cart is priced again on the server; a signed-in shopper (Accounts) or, while `guests` allows, a
 *   guest with a name and phone (E21: normalised, one customer record per phone; `unless_password` sends members to
 *   sign in; a phone a member's record already has makes the order that member's, K-6) places it; COD safety, the
 *   blocklist and the open-order cap apply per customer; the ledger places the
 *   order in one transaction (stock, offer uses — deals kept by locks too —, points, booked slots) with a number by
 *   the business year and the yearly counter (E30). Online, bank-transfer and COD-advance orders start awaiting
 *   payment and get a Payments payment, unless transfers or advances are recorded by staff (`manual`: the order waits
 *   for the shopper's proof, E23, E24); cash-on-delivery, pay-at-pickup and free orders start where the order flow's
 *   `starts` say (awaiting confirmation by default; a free one may wait in awaiting payment without a time to pay,
 *   CK-41). A guest gets the order's key once (`orderKey`).
 * - Paying: an order is paid only when Payments says, server to server, that its payment is paid for exactly the
 *   order's amount (or advance) and currency; the payment is a log entry of the order (E26). A waiting payment is asked
 *   again when the order is read (at most every 30 seconds), on use, and once more before a waiting order is cancelled
 *   at the end of its window (0 = never). Nothing runs on a timer: waiting orders whose window ended are cancelled on
 *   use (`service.whenUsed`), giving back what they held. A cancelled order's Payments payment is cancelled there first
 *   (`server/order-payments.js`, K-13).
 * - The shopper's orders: list, detail (by id or number, with the sign-in or the order's key, E21) with downloads and
 *   licence keys, the statuses' shopper names and lines and the notes staff wrote for the shopper, cancel where the flow
 *   lets the shopper (a move with `who` shopper, E27; a paid order as its `shopperPaid` says), pay again, and the
 *   transfer proof (E24).
 * @module
 */
import { created, paginate, problem } from '@ss/app-kit';
import { createId } from '@ss/contracts';
import { normalisePhone } from '@ss/contracts/phone';
import { originAllowed } from '@ss/protocol';
import { keyOpens, newOrderKey, orderKeyHash } from '../adapters/crypto.js';
import { heldStockBefore, placeOrder, swapOrderStock } from '../adapters/ledger.js';
import { createOrdersStore } from '../adapters/orders-store.js';
import { STOCK_PROBLEMS, checkAddress, checkCart, checkOrderExtras } from '../core/checkout.js';
import { shipmentLink } from '../core/couriers.js';
import { PLACED_FACTS, factsGuard, isFacts } from '../core/facts.js';
import {
	WAITING_ROLES,
	shopperCancelOf,
	shopperLabelOf,
	shopperTextOf,
	startsOfFlow,
	statusOf,
	statusWithRole,
	triggersOfFlow,
} from '../core/flow.js';
import { shopperInvoiceReady } from '../core/invoice.js';
import { checkGuest, phoneDigitsOf } from '../core/guests.js';
import { loyaltyRules, pointsToEarn, takesPart } from '../core/loyalty.js';
import { lineageOf } from '../core/catalog-taxonomy.js';
import { gradesFor } from '../core/grades.js';
import { COLLECTIONS, ID_PREFIX } from '../core/model.js';
import { byActor, orderMoney, serverNote } from '../core/orders.js';
import { checkTransition, planTransition } from '../core/transitions.js';
import { createMedia } from './catalog-media.js';
import { createGuests, phoneRulesOf } from './guests.js';
import { RECHECK_MS, createOrderPayments, expectedOf } from './order-payments.js';
import { createTransitions, rulesOf } from './transitions.js';

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

/** The header a guest sends their order's key in (the kit's CORS allows it). */
const ORDER_KEY_HEADER = 'ss-order-key';
/** Who ends a waiting order whose window passed (the activity log). */
const SYSTEM_ACTOR = Object.freeze({ kind: 'system', id: 'checkout', name: 'System' });
/** Transfer proofs: what may be uploaded, and how big (E24). */
const PROOF_TYPES = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' });
const PROOF_MAX_BYTES = 10 * 1_048_576;
const PROOF_SECONDS = 900;

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const ORDER_NUMBER = /^[A-Za-z0-9_-]{1,40}$/;

/** @param {string} url @param {string} name @param {string} value */
const withParam = (url, name, value) => {
	const target = new URL(url);
	target.searchParams.set(name, value);
	return target.toString();
};

/** @param {Date | string | null | undefined} at */
const iso = (at) => (at ? new Date(at).toISOString() : null);

/**
 * A template address with `{number}` and `{id}` filled (E22 `successUrl` and `cancelUrl`).
 * @param {string} template @param {OrderRecord} order
 */
const fillAddress = (template, order) =>
	template.replaceAll('{number}', encodeURIComponent(order.number)).replaceAll('{id}', encodeURIComponent(order.id));

/**
 * @param {Product} product
 * @param {Service} service
 * @param {{ quoting: Quoting, digital: Digital }} parts
 */
export const createOrdering = (product, service, { quoting, digital }) => {
	const media = createMedia(product);
	const guests = createGuests(product);
	const payments = createOrderPayments(product, service);
	const transitions = createTransitions(product, service);

	/** @param {Site} s @returns {Promise<OrderFlow>} */
	const flowOf = async (s) => /** @type {OrderFlow} */ (/** @type {unknown} */ (await s.list('order_flow')));

	/** @param {OrderFlow} flow @param {string} status */
	const labelOf = (flow, status) => statusOf(flow, status)?.label ?? status;
	/** The name the shopper reads. @param {OrderFlow} flow @param {string} status */
	const shopperLabel = (flow, status) => shopperLabelOf(flow, status);

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

	/**
	 * Where the shopper goes back after paying or leaving the payment (E22): the address the widget sent (with
	 * `ss_order`), else the `successUrl` and `cancelUrl` templates (when on the website), else nowhere.
	 * @param {Site} s @param {OrderRecord} order @param {string | null} returnUrl
	 */
	const backOf = async (s, order, returnUrl) => {
		if (returnUrl) {
			const back = withParam(returnUrl, 'ss_order', order.id);
			return { success: back, cancel: back };
		}
		const { successUrl, cancelUrl } = await s.values('checkout');
		const success = successUrl ? fillAddress(String(successUrl), order) : '';
		const cancel = cancelUrl ? fillAddress(String(cancelUrl), order) : success;
		return {
			success: success && allowedReturn(s, success) ? success : null,
			cancel: cancel && allowedReturn(s, cancel) ? cancel : null,
		};
	};

	/**
	 * Where Payments sends the shopper back (it needs an address): the order's own return, else the website's home with
	 * `ss_order`.
	 * @param {Site} s @param {OrderRecord} order @param {string | null} returnUrl
	 */
	const paymentBackOf = async (s, order, returnUrl) => {
		const back = await backOf(s, order, returnUrl);
		const home = withParam(`https://${s.domain}/`, 'ss_order', order.id);
		return { success: back.success ?? home, cancel: back.cancel ?? back.success ?? home };
	};

	// ------------------------------------------------------------------------------------------------- payments

	/**
	 * Start the Payments payment of an order (its total, or its COD advance). Null when Payments cannot be reached or
	 * refuses: the order keeps waiting and the shopper can try again. The order takes the payment only while it has no
	 * other: when another start won meanwhile (two "pay" at once, CK-21) or the order moved, this payment is cancelled at
	 * Payments and the order is returned as it is now.
	 * @param {Site} s @param {OrderRecord} order @param {string | null} returnUrl @param {string} idempotencyKey
	 * @returns {Promise<OrderRecord | null>}
	 */
	const startPayment = async (s, order, returnUrl, idempotencyKey) => {
		const back = await paymentBackOf(s, order, returnUrl);
		const { customer } = order;
		const phone = normalisePhone(customer.phone);
		try {
			const payment = await service.payments.create(s, {
				...expectedOf(order),
				gateway: order.payment.method === 'bank_transfer' ? 'bank_transfer' : null,
				description: `${order.payment.advance > 0 ? 'Advance for order' : 'Order'} ${order.number}`,
				reference: order.number,
				customer: {
					id: customer.userId || customer.customerId || '',
					...(customer.name ? { name: customer.name.slice(0, 120) } : {}),
					...(EMAIL.test(customer.email) ? { email: customer.email } : {}),
					...(phone ? { phone } : {}),
				},
				metadata: { orderId: order.id },
				returnUrl: back.success,
				cancelUrl: back.cancel,
				idempotencyKey,
			});
			const store = createOrdersStore(await s.data());
			const started = await store.change(
				order,
				{ 'payment.paymentId': payment.id, 'payment.checkoutUrl': payment.checkoutUrl, 'payment.checkedAt': null },
				{ where: { 'payment.paymentId': order.payment.paymentId ?? null } },
			);
			if (started) return started;
			const current = await store.order(order.id);
			if (current?.payment.paymentId !== payment.id) await service.payments.cancel(s, payment.id, 'Payment started twice');
			return current;
		} catch (error) {
			s.ctx.log?.warn?.('payment not started', { code: /** @type {any} */ (error)?.code ?? 'error' });
			return null;
		}
	};

	/** @param {Site} s @param {OrderRecord} order */
	const refresh = async (s, order) => (await payments.recheck(s, order)).order;

	// ------------------------------------------------------------------------------------------------- cancelling

	/**
	 * Cancel an order for the shopper or because its window ended, giving back its stock, slots, offer uses and points
	 * (exactly once), through the order engine: the shopper along their move (`to`, listed for them), an ended window to
	 * the flow's `windowEnd` status (no listed move needed; the role rules hold). Money paid is refunded through Payments
	 * only when the shopper's move says so (`shopperPaid: refund`, `refund`), else it shows as due to refund. Its open
	 * Payments payment is cancelled first (K-13): when it was paid meanwhile the order is paid instead and is returned as
	 * it is now (not cancelled).
	 * @param {Site} s @param {OrderRecord} order as just read
	 * @param {{ by: string, note: string, code: import('../core/orders.js').HistoryNote,
	 *   reason: 'staff' | 'shopper' | 'expired', to?: string }} who `note` also tells Payments why its payment is cancelled;
	 *   `to`: the shopper's move's status
	 * @returns {Promise<OrderRecord | null>} null when it moved meanwhile, or the flow changed under it
	 */
	const cancel = async (s, order, { by, note, code, reason, to: target }) => {
		const flow = await flowOf(s);
		const who = by === 'system' ? 'system' : 'shopper';
		const listed = who === 'shopper';
		const to = target ?? triggersOfFlow(flow).windowEnd;
		if (!checkTransition({ order, flow, to, listed, who }).ok) return null;
		const step = await payments.beforeCancel(s, order, note);
		if (step.paid) return step.paid;
		const data = await s.data();
		const now = service.now();
		const actor =
			who === 'system'
				? SYSTEM_ACTOR
				: by === 'guest'
					? { kind: 'guest', id: order.customer.customerId || 'guest', name: 'Guest' }
					: { kind: 'shopper', id: order.customer.userId || 'shopper', name: 'Shopper' };
		const planned = planTransition({
			order,
			flow,
			to,
			input: { who, actor, by, note, code, cancelReason: reason, listed, payments: step.set },
			rules: await rulesOf(s),
			now,
		});
		if (!planned.ok) return null;
		// stock coming back tells the alerts (E34)
		const held = await heldStockBefore(data, order);
		try {
			await transitions.apply(s, order, planned.plan);
		} catch (error) {
			// lost to another change: a payment Payments cancelled for it is dropped, so the order stays payable
			await payments.dropVoided(s, order, step);
			if (/** @type {any} */ (error)?.code === 'conflict') return null;
			throw error;
		}
		if (held) await service.emit('products.changed', s, held);
		const store = createOrdersStore(data);
		await payments.afterCancel(s, /** @type {OrderRecord} */ (await store.order(order.id)), step);
		let after = /** @type {OrderRecord} */ (await store.order(order.id));
		await product.activity.record(
			{ websiteId: s.websiteId, merchantId: s.merchantId, after: s.ctx.after },
			{
				actor,
				action: 'order.moved',
				target: order.id,
				label: order.number,
				detail: `${labelOf(flow, order.status)} → ${labelOf(flow, to)}`,
			},
		);
		// the refund the shopper's move asks of Payments, right after the transaction (kept pending when it fails)
		if (planned.plan.external.length > 0) {
			const ran = await transitions.runEffects(s, after, { ids: planned.plan.external.map((effect) => effect.id) });
			after = ran.order;
			await transitions.announce(s, after, ran.outcomes);
		}
		await service.emit('order.moved', s, { order: after, ...planned.plan.event });
		return after;
	};

	/**
	 * End a waiting order whose window passed: a waiting payment is asked once more (paid: confirmed instead); else
	 * cancelled with the reason `expired`. When Payments cannot be reached the order waits for the next use (it may have
	 * been paid), unless the Payments token was removed.
	 * @param {Site} s @param {OrderRecord} order
	 */
	const expire = async (s, order) => {
		let current = order;
		if (order.role === 'awaiting_payment' && order.payment.state === 'pending' && order.payment.paymentId) {
			const checked = await payments.recheck(s, order, { force: true });
			if (!checked.reached && (await product.connections.value(s.websiteId, 'payments')) !== null) return;
			current = checked.order;
			if (current.status !== order.status || current.payment.state !== 'pending') return;
		}
		const unpaid = order.role === 'awaiting_payment';
		await cancel(s, current, {
			by: 'system',
			note: unpaid ? 'Not paid in time' : 'Not confirmed in time',
			code: unpaid ? 'not_paid_in_time' : 'not_confirmed_in_time',
			reason: 'expired',
		});
	};

	/**
	 * Work on use: recheck waiting payments, end waiting orders whose window passed, then the Payments side of cancelled
	 * orders (K-13) (bounded batches).
	 * @param {Site} s
	 */
	const sweep = async (s) => {
		if (!s.has('checkout') || (await product.connections.value(s.websiteId, 'database')) === null) return;
		const store = createOrdersStore(await s.data());
		const now = service.now();
		for (const order of await store.toRecheck(now, RECHECK_MS)) await payments.recheck(s, order);
		for (const order of await store.expired(WAITING_ROLES, now)) await expire(s, order);
		await payments.sweep(s);
		// refunds of cancelled orders Payments could not take yet (the order engine's pending effects)
		await transitions.sweep(s);
	};

	// --------------------------------------------------------------------------------------------------- views

	/**
	 * The move the shopper may cancel an order with (E27): a listed move from its status into a cancelled one that the
	 * shopper may make, unless the order is paid and the move refuses paid orders (`shopperPaid: refuse`); else null.
	 * @param {OrderFlow} flow @param {OrderRecord} order
	 */
	const shopperCancelMove = (flow, order) => {
		const move = shopperCancelOf(flow, order.status);
		if (!move || (order.payment.paid > 0 && move.options.shopperPaid === 'refuse')) return null;
		return move;
	};

	/**
	 * Whether the shopper may send a transfer proof: the order waits for a payment staff record (E24).
	 * @param {OrderRecord} order
	 */
	const takesProof = (order) =>
		order.role === 'awaiting_payment' && order.payment.via === 'manual' && order.payment.state !== 'paid';

	/**
	 * What the shopper sees of an order (never staff notes or who moved or paid it).
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
		const [checkout, zones, couriers, invoices] = await Promise.all([
			s.values('checkout'),
			s.has('delivery_zones') ? s.values('delivery_zones') : Promise.resolve(null),
			s.has('checkout') ? s.list('couriers') : Promise.resolve([]),
			s.has('invoices') ? s.values('invoices') : Promise.resolve(null),
		]);
		// paid, refunded and due counted the one way (a refund never makes a debt, CK-5)
		const sums = orderMoney(order);
		const bankTransfer =
			order.payment.method === 'bank_transfer' || (order.payment.via === 'manual' && order.payment.advance > 0);
		const quoteBank = bankTransfer && order.role === 'awaiting_payment' ? await quoting.bankDetailsOf(s) : null;
		return {
			id: order.id,
			number: order.number,
			status: order.status,
			statusLabel: shopperLabel(flow, order.status),
			// the line the merchant wrote under this status for the order's payment method ('' = none)
			statusText: shopperTextOf(flow, order.status, order.payment.method),
			role: order.role,
			placedAt: iso(order.placedAt),
			guest: !order.customer.userId,
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
						serials: line.serials ?? [],
						warrantyDays: line.warrantyDays ?? null,
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
			totals: { fee: 0, roleDiscount: 0, ...order.totals },
			promotions: {
				couponCode: order.promotions.couponCode,
				pointsRedeemed: order.promotions.pointsRedeemed,
				pointsValue: order.promotions.pointsValue,
				pointsEarned: order.promotions.pointsEarned,
				role: order.promotions.role ? { label: order.promotions.role.label, percent: order.promotions.role.percent } : null,
			},
			address: order.address,
			delivery: { ...order.delivery, locationName: location ? String(location.name) : '' },
			payment: {
				method: order.payment.method,
				state: order.payment.state,
				via: order.payment.via ?? 'payments',
				advance: order.payment.advance,
				paid: sums.paid,
				refunded: sums.refunded,
				balanceDue: sums.due,
				payUrl: waitingPayment ? String(order.payment.checkoutUrl || '') || null : null,
				payBy: order.role === 'awaiting_payment' ? iso(order.holdUntil) : null,
				proof: order.payment.proof ? { reference: order.payment.proof.reference, at: iso(order.payment.proof.at) } : null,
				// the payments log without staff names (E26)
				entries: (order.payments ?? []).map((entry) => ({
					method: entry.method,
					amount: entry.amount,
					reference: entry.reference,
					at: iso(entry.at),
				})),
				refunds: (order.refunds ?? []).map((entry) => ({
					method: entry.method,
					amount: entry.amount,
					reference: entry.reference,
					at: iso(entry.at),
				})),
			},
			bankDetails: quoteBank,
			canSendProof: takesProof(order),
			notes: {
				payment: String(
					{
						cod: checkout.noteCod,
						online: checkout.noteOnline,
						bank_transfer: checkout.noteBankTransfer,
						pickup: checkout.notePickup,
					}[order.payment.method] ?? '',
				),
				delivery: String(zones?.deliveryNote ?? ''),
				prep: String(zones?.prepNote ?? ''),
				pickupReady: order.delivery.method === 'pickup' ? String(zones?.pickupReadyNote ?? '') : '',
			},
			pickupPoint:
				order.delivery.method === 'pickup' && !order.delivery.locationId && zones?.pickupEnabled
					? {
							name: String(zones.pickupName ?? ''),
							address: String(zones.pickupAddress ?? ''),
							hours: String(zones.pickupHours ?? ''),
						}
					: null,
			// the timeline: each entry's status as the shopper reads it and the note staff wrote for the shopper (staff notes
			// stay internal)
			history: order.history.map((entry) => ({
				at: iso(entry.at),
				status: entry.to,
				label: shopperLabel(flow, entry.to),
				note: entry.shopperNote ?? '',
			})),
			shipment: order.shipment
				? {
						courier: order.shipment.courier,
						trackingNumber: order.shipment.trackingNumber,
						trackingUrl: shipmentLink(couriers, order.shipment),
						trackingNote: order.shipment.trackingNote ?? '',
						estimatedDeliveryAt: iso(order.shipment.estimatedDeliveryAt),
					}
				: null,
			dispatchVideo: await media.dispatchVideo(s, order),
			note: order.note,
			canCancel: shopperCancelMove(flow, order) !== null,
			// the same sign-in or order key opens the invoice (GET /v1/shop/orders/:id/invoice)
			invoice: invoices !== null && shopperInvoiceReady(order, invoices),
		};
	};

	/**
	 * What to do next after placing or paying: pay on Payments' page, try starting the payment again, or nothing (with
	 * the store's own success page, E22).
	 * @param {Site} s @param {OrderRecord} order
	 */
	const nextOf = async (s, order) => {
		if (order.role === 'awaiting_payment' && order.payment.state === 'pending') {
			const url = order.payment.checkoutUrl;
			return order.payment.paymentId && url ? { kind: 'pay', url: String(url) } : { kind: 'retry' };
		}
		if (takesProof(order)) return { kind: 'proof', url: (await backOf(s, order, null)).success };
		return { kind: 'done', url: (await backOf(s, order, null)).success };
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

	/**
	 * Who places an order: the signed-in shopper, else a guest while `guests` allows (E21).
	 * @param {Site} s @param {any} ctx @param {Record<string, any>} checkout
	 * @returns {Promise<{ shopper: Shopper | null, guest: { name: string, phone: string, email: string } | null }>}
	 */
	const buyerOf = async (s, ctx, checkout) => {
		const shopper = await service.shopper(s);
		if (shopper) {
			await guests.claim(s, shopper);
			return { shopper, guest: null };
		}
		const mode = String(checkout.guests ?? 'off');
		if (mode === 'off') throw problem('sign_in_required', 'Sign in to continue.');
		const body = typeof ctx.body === 'object' && ctx.body !== null ? ctx.body : {};
		const guest = checkGuest(body.customer, await phoneRulesOf(s));
		if (!guest.ok) throw service.invalid(guest.field, guest.message, guest.code);
		if (mode === 'unless_password' && (await guests.memberWithPassword(s, guest.value.phone)))
			throw problem('sign_in_required', 'This phone number has an account: sign in to order.', {
				// `reason` is the kit's own extension; this one says why a sign-in is needed
				extensions: { signIn: 'member_phone' },
			});
		return { shopper: null, guest: guest.value };
	};

	/**
	 * The order lines of a quote (placing and editing an order), with the slots its booking lines hold.
	 * @param {Site} s @param {import('./checkout-quote.js').Quote} q
	 */
	const linesOf = async (s, q) => {
		// each physical line keeps its warranty from placement (E12): the variant's, the product's, the grade's, the setting
		const grades = s.has('grades_serials') ? await s.list('grades') : [];
		const warrantyDefault = Number((await s.values('returns')).warrantyDays ?? 0);
		const graded = q.priced.filter((line) => line.grade);
		const paths =
			grades.length > 0 && graded.length > 0
				? await createOrdersStore(await s.data()).categoryPaths(graded.flatMap((line) => line.categoryIds ?? []))
				: new Map();
		const tree = new Map([...paths].map(([id, path]) => [id, { path }]));
		/**
		 * The grade's days are the entry of its product's category or the nearest one above it first (E45).
		 * @param {{ kind: string, grade: string | null, warrantyDays?: number | null, categoryIds?: string[] }} line
		 */
		const warrantyOf = (line) =>
			line.kind === 'physical'
				? (line.warrantyDays ??
					(line.grade ? gradesFor(grades, lineageOf(line.categoryIds ?? [], tree)).get(line.grade)?.warrantyDays : null) ??
					warrantyDefault)
				: null;
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
				warrantyDays: warrantyOf(line),
				booking,
				licences: [],
				returnedQuantity: 0,
				dealId: q.promotions?.lines.find((entry) => entry.key === line.key)?.dealId ?? null,
				...(line.kind === 'digital' ? { downloads: 0 } : {}),
			};
		});
		return { lines, slots };
	};

	/**
	 * Edit an order while it waits for payment or confirmation (E29): its lines (variant, quantity, an optional unit
	 * price), payment method and delivery. It is priced again with the offers it was placed with (kept even when they
	 * ended since, by the same deal rules, OR-9) — or, with the checkout setting `editPricing: keep_placed`, it keeps the
	 * offer discount, delivery fee and payment fee it was placed with —, its stock holds are swapped in one transaction, and a payment started
	 * through Payments for the old total is cancelled there and dropped (the shopper pays the new one; K-13).
	 * @param {Site} s
	 * @param {any} ctx
	 * @param {OrderRecord} order as read
	 * @param {import('../core/orders.js').WaitingEdit} input
	 * @returns {Promise<OrderRecord>}
	 */
	const editWaiting = async (s, ctx, order, input) => {
		if (!WAITING_ROLES.includes(order.role)) throw service.invalid('lines', 'Only an order that still waits can be edited.');
		if (order.payment.paid > 0) throw service.invalid('lines', 'This order has payments; refund them before editing it.');
		if (order.lines.some((line) => line.kind !== 'physical'))
			throw service.invalid('lines', 'Orders with digital items or bookings cannot be edited.');
		const data = await s.data();
		const store = createOrdersStore(data);
		const checkout = await s.values('checkout');
		const method = input.paymentMethod ?? order.payment.method;
		// the lines: as sent, else as they are
		const wanted =
			input.lines ??
			order.lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity, unitPrice: line.unitPrice }));
		const owners = await data
			.collection(COLLECTIONS.products)
			.find(
				{ websiteId: data.websiteId, 'variants.id': { $in: wanted.map((line) => line.variantId) } },
				{ projection: { _id: 0, id: 1, variants: { id: 1 } } },
			)
			.toArray();
		/** @param {string} variantId */
		const productOf = (variantId) =>
			owners.find((row) => (row.variants ?? []).some((/** @type {any} */ v) => v.id === variantId))?.id ?? null;
		for (const [index, line] of wanted.entries())
			if (!productOf(line.variantId)) throw service.invalid(`lines/${index}/variantId`, 'There is no such item.');
		/** @type {Map<string, number>} */
		const prices = new Map();
		for (const line of wanted)
			if (line.unitPrice !== undefined && line.unitPrice !== null) prices.set(line.variantId, line.unitPrice);
		const kept = order.promotions.dealIds.length
			? /** @type {import('../core/model.js').DealRecord[]} */ (
					await data
						.collection(COLLECTIONS.deals)
						.find({ websiteId: data.websiteId, id: { $in: order.promotions.dealIds } }, { projection: { _id: 0 } })
						.toArray()
				)
			: [];
		const coupon = order.promotions.couponId
			? /** @type {import('../core/model.js').CouponRecord | null} */ (
					await data
						.collection(COLLECTIONS.coupons)
						.findOne({ websiteId: data.websiteId, id: order.promotions.couponId }, { projection: { _id: 0 } })
				)
			: null;
		const delivery = input.delivery ?? {
			method: order.delivery.method === 'none' ? null : order.delivery.method,
			city: order.address?.city ?? '',
			area: order.address?.area ?? '',
			country: order.address?.country ?? '',
			locationId: order.delivery.locationId,
		};
		const given = input.address ?? order.address;
		/** @type {string[]} */
		const required = Array.isArray(checkout.addressRequired) ? checkout.addressRequired : ['line1', 'city'];
		const checkedAddress = given ? checkAddress(given, required, await phoneRulesOf(s)) : null;
		if (checkedAddress && !checkedAddress.ok) throw service.invalid(checkedAddress.field, checkedAddress.message);
		const address = checkedAddress?.ok ? checkedAddress.value : null;
		const q = await quoting.quote(
			s,
			{
				lines: wanted.map((line) => ({
					productId: /** @type {string} */ (productOf(line.variantId)),
					variantId: line.variantId,
					quantity: line.quantity,
					slot: null,
					// the deal a line had (the shopper's pick, `shopperChoice`)
					dealId: order.lines.find((placed) => placed.variantId === line.variantId)?.dealId ?? null,
					lock: null,
				})),
				coupon: '',
				points: 0,
				payment: method,
				delivery,
			},
			null,
			address,
			{
				customer: order.customer.customerId ? await store.guestCustomer(order.customer.phone) : null,
				edit: {
					prices,
					deals: kept,
					coupon: coupon ? { ...coupon, used: Math.max(0, coupon.used - 1) } : null,
					role: order.promotions.role
						? {
								role: order.promotions.role.key,
								percent: order.promotions.role.percent,
								label: order.promotions.role.label,
							}
						: null,
					points: { used: order.promotions.pointsRedeemed, value: order.promotions.pointsValue },
					// the amounts it was placed with, when the website keeps them (`editPricing: keep_placed`)
					...(checkout.editPricing === 'keep_placed'
						? {
								keep: {
									promotions: Math.max(
										0,
										order.totals.discount - (order.totals.roleDiscount ?? 0) - order.promotions.pointsValue,
									),
									delivery: order.totals.delivery,
									deliveryMethod: order.delivery.method,
									fee: order.totals.fee ?? 0,
									method: order.payment.method,
								},
							}
						: {}),
				},
			},
		);
		// stock is checked by the swap below (the order's own holds go back first)
		const other = q.lines.filter((line) => !line.priced || line.problems.some((issue) => !STOCK_PROBLEMS.includes(issue.code)));
		if (other.length > 0) throw service.invalid('lines', 'Some items cannot be ordered.');
		if (q.delivery.method === 'delivery' && !address) throw service.invalid('address', 'A delivery address is required.');
		if (q.deliveryProblem) throw service.invalid('delivery/locationId', 'Choose a pickup location.');
		const option = q.payments.find((entry) => entry.method === method);
		if (!option?.available) throw service.invalid('paymentMethod', 'This payment method cannot be used for this order.');
		const { lines } = await linesOf(s, q);
		const now = service.now();
		const restartPayment = order.payment.paymentId !== null;
		/** @type {Record<string, unknown>} */
		const set = {
			lines,
			totals: { ...q.totals, currency: order.totals.currency },
			delivery: { method: q.delivery.method, zone: q.delivery.zone, fee: q.delivery.fee, locationId: q.delivery.locationId },
			address: q.delivery.method === 'delivery' ? address : null,
			'payment.method': method,
			'payment.advance': method === 'cod' ? option.advance : 0,
			// the offers stay as placed (their uses stay counted and go back on a cancel); the points' value may shrink
			'promotions.pointsValue': q.points?.value ?? 0,
			...(restartPayment ? { 'payment.paymentId': null, 'payment.checkoutUrl': '', 'payment.checkedAt': null } : {}),
			updatedAt: new Date(now),
		};
		// the payment started for the old total is cancelled at Payments, so it can no longer be paid (K-13, CK-21)
		const dropped = restartPayment ? await payments.beforeCancel(s, order, 'Order edited') : null;
		if (dropped?.paid || dropped?.late)
			throw problem('conflict', 'This order was paid meanwhile; it can no longer be edited. Reload it.');
		if (dropped && !dropped.reached)
			throw problem('payments_unavailable', 'Payments cannot be reached to cancel the payment of the old total. Try again.');
		const swapped = await swapOrderStock(data, order, {
			lines: lines
				.filter((line) => line.kind === 'physical')
				.map((line) => ({ productId: line.productId, variantId: line.variantId, quantity: line.quantity, locationId: null })),
			update: async (session) => {
				// it holds its new lines' stock now, also an imported order that held none (its facts say so: a cancel gives
				// it back), only while its facts are as read
				const result = await data.collection(COLLECTIONS.orders).updateOne(
					{ websiteId: data.websiteId, id: order.id, updatedAt: order.updatedAt, ...factsGuard(order) },
					{
						$set: { ...set, stockHeld: true, ...(isFacts(order.facts) ? { 'facts.stock': 'held' } : {}) },
						$push: {
							history: {
								at: new Date(now),
								from: order.status,
								to: order.status,
								...byActor(service.actor(ctx)),
								...serverNote('edited', 'Order edited'),
								kind: 'edited',
							},
						},
					},
					{ session },
				);
				return result.modifiedCount === 1;
			},
		});
		if (!swapped.ok) {
			// its cancelled payment is dropped: the shopper's next pay starts one for the total as it is
			if (dropped)
				await store.change(order, { 'payment.paymentId': null, 'payment.checkoutUrl': '', 'payment.checkedAt': null });
			if (swapped.code === 'changed') throw problem('conflict', 'The order changed meanwhile; reload it and try again.');
			throw problem('out_of_stock', 'Some items are not in stock in the quantity asked.', {
				extensions: { lines: [{ productId: swapped.productId, variantId: swapped.variantId }] },
			});
		}
		const money = (await s.format()).money(q.totals.total, order.totals.currency);
		await service.log(ctx, 'order.edited', order.id, { label: order.number, detail: `New total ${money}` });
		if (swapped.taken.length > 0) await service.emit('stock.taken', s, { lines: swapped.taken });
		return /** @type {OrderRecord} */ (await store.order(order.id));
	};

	/** @param {any} ctx */
	const place = async (ctx) => {
		if (!ctx.idempotencyKey) throw problem('idempotency_key_required', 'Send an Idempotency-Key header.');
		const s = await service.site(ctx);
		const checkout = await s.values('checkout');
		const { shopper, guest } = await buyerOf(s, ctx, checkout);
		const cart = checkCart(ctx.body, {
			maxLines: Number(checkout.maxLines ?? 50),
			maxQuantity: Number(checkout.maxQuantity ?? 99),
		});
		if (!cart.ok) throw service.invalid(cart.field, cart.message);
		const extras = checkOrderExtras(ctx.body);
		if (!extras.ok) throw service.invalid(extras.field, extras.message);
		const { payment: method, note, returnUrl } = extras.value;
		if (returnUrl !== null && !allowedReturn(s, returnUrl))
			throw service.invalid('returnUrl', `returnUrl must be on https://${s.domain} (or a local address while testing).`);
		const data = await s.data();
		const store = createOrdersStore(data);
		const buyer = shopper
			? { userId: shopper.id, name: shopper.name, email: shopper.email, phone: shopper.phone }
			: { userId: null, .../** @type {{ name: string, phone: string, email: string }} */ (guest) };
		// a returning customer who orders as a guest is the customer their phone names (K-6): a member's record (the order,
		// its points, the block and the cap are that member's), else their own guest record (E21)
		const guestRecord = shopper ? null : await store.guestCustomer(buyer.phone);
		const member = shopper ? null : await store.memberByPhone(buyer.phone);
		const known = shopper ? await store.customer(shopper.id) : (member ?? guestRecord);
		if (known?.blocked || guestRecord?.blocked)
			throw problem('customer_blocked', 'Ordering is not possible for this account. Please contact the shop.');
		const owner = shopper?.id ?? member?.userId ?? null;
		const cap = Number(checkout.openOrderCap);
		if (cap > 0 && (await store.countWaiting({ userId: owner, customerId: known?.id ?? null }, WAITING_ROLES)) >= cap)
			throw problem(
				'too_many_open_orders',
				'You have orders waiting for payment or confirmation. Finish or cancel them first.',
			);

		/** @type {string[]} */
		const required = Array.isArray(checkout.addressRequired) ? checkout.addressRequired : ['line1', 'city'];
		const address =
			extras.value.address === undefined || extras.value.address === null
				? null
				: checkAddress(extras.value.address, required, await phoneRulesOf(s));
		const q = await quoting.quote(s, { ...cart.value, payment: method }, shopper, address?.ok ? address.value : null, {
			customer: known,
		});
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
		// the shopper confirms the total they were shown: another total is not charged (CK-14)
		if (extras.value.expectedTotal !== undefined && extras.value.expectedTotal !== q.totals.total)
			throw problem('price_changed', 'The total of your order changed. Check your cart again.', {
				extensions: { quote: await quoting.view(s, q) },
			});

		// the order record
		const flow = await flowOf(s);
		const now = service.now();
		const total = q.totals.total;
		const cod = await s.values('cod');
		const advance = method === 'cod' ? option.advance : 0;
		const bankManual = method === 'bank_transfer' && checkout.bankTransferVia === 'manual';
		const advanceManual = method === 'cod' && advance > 0 && cod.advanceVia === 'manual';
		const manual = bankManual || advanceManual;
		const viaPayments = total > 0 && !manual && (method === 'online' || method === 'bank_transfer' || advance > 0);
		// cash on delivery, pay at pickup and a free online or bank-transfer order (nothing to pay) start where the flow's
		// `starts` say; a free one in awaiting payment waits for staff without a time to pay (CK-41)
		const starts = startsOfFlow(flow);
		const startKey = method === 'cod' ? starts.cod : method === 'pickup' ? starts.pickup : starts.free;
		const freeWaits =
			total === 0 &&
			(method === 'online' || method === 'bank_transfer') &&
			statusOf(flow, starts.free)?.role === 'awaiting_payment';
		const waitsPayment = viaPayments || (total > 0 && manual) || freeWaits;
		const status = waitsPayment ? statusWithRole(flow, 'awaiting_payment') : startKey;
		/** @type {StatusRole} */
		const role = statusOf(flow, status)?.role ?? 'awaiting_confirmation';
		const holdMs =
			role === 'awaiting_payment'
				? freeWaits
					? 0
					: Number(checkout.paymentWindowMinutes) * 60_000
				: role === 'awaiting_confirmation'
					? Number(checkout.confirmationHours) * 3_600_000
					: 0;
		const orderId = createId(ID_PREFIX.order);
		const { lines, slots } = await linesOf(s, q);
		const promotions = q.promotions;
		const customer = member ?? (await store.ensureCustomer(buyer, { at: new Date(now) }));
		const loyalty = s.has('loyalty') ? await s.values('loyalty') : null;
		// a signed-in shopper whose role the loyalty settings leave out earns nothing, at delivery either (E20 roles): 0 is
		// fixed now
		const leftOut = loyalty !== null && shopper !== null && !takesPart(loyalty, shopper.role);
		const earns = loyalty !== null && !leftOut && (shopper !== null || loyaltyRules(loyalty).guests === 'earn');
		const orderKey = shopper ? null : newOrderKey();
		const order = {
			id: orderId,
			customer: {
				userId: owner ?? '',
				name: buyer.name,
				email: buyer.email,
				phone: buyer.phone,
				customerId: /** @type {string} */ (customer.id),
			},
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
				// worked out now; with `earnAt: placement` it stays fixed until delivery credits it (E20)
				pointsEarned: earns
					? Math.max(0, Math.floor(pointsToEarn(q.totals, /** @type {Record<string, any>} */ (loyalty))))
					: 0,
				pointsFixed: leftOut || (earns && loyaltyRules(loyalty).earnAt === 'placement'),
				pointsCredited: false,
				pointsBlocked: promotions?.pointsBlocked === true,
				role: q.role,
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
				via: /** @type {'manual' | 'payments'} */ (manual ? 'manual' : 'payments'),
				proof: null,
			},
			payments: [],
			refunds: [],
			status,
			role,
			history: [{ at: new Date(now), from: null, to: status, by: shopper ? 'shopper' : 'guest', note: '' }],
			shipment: null,
			media: [],
			stockHeld: true,
			// what the order holds (the order engine's facts): its stock, offer uses and spent points
			facts: { ...PLACED_FACTS },
			holdUntil: holdMs > 0 ? new Date(now + holdMs) : null,
			idempotencyKey: String(ctx.idempotencyKey),
			note,
			staffNote: '',
			seenBy: [],
			phoneDigits: phoneDigitsOf(buyer.phone),
			accessKeyHash: orderKey ? orderKeyHash(orderKey) : null,
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
				numberDigits: Number(checkout.numberDigits ?? 6),
				locationOrder,
				couponPerCustomer: q.coupon?.perCustomer ?? null,
				slots,
				lockedDealIds: (promotions?.lines ?? [])
					.filter((entry) => entry.locked && entry.dealId)
					.map((entry) => String(entry.dealId)),
			},
			{ now, timeZone: (await s.business()).timeZone ?? 'UTC' },
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
		// the order this customer placed with the key before (after the kit forgot the key): answered as its first answer
		// was, 201 (its key is not given again)
		if (placed.duplicate)
			return created({ order: await shopperView(s, placed.order, flow), next: await nextOf(s, placed.order) });

		let current = placed.order;
		await store.countOrder(/** @type {string} */ (customer.id), { city: order.address?.city ?? '', at: new Date(now) });
		if (viaPayments) current = (await startPayment(s, current, returnUrl, current.id)) ?? current;
		await service.emit('order.placed', s, { order: current, statusLabel: shopperLabel(flow, status) });
		if (placed.taken.length > 0) await service.emit('stock.taken', s, { lines: placed.taken });
		// a free order is paid as it is placed (its digital items are given now)
		if (current.payment.state === 'paid') {
			await service.emit('order.paid', s, { order: current, entry: null });
			current = (await store.order(current.id)) ?? current;
		}
		return created({
			order: await shopperView(s, current, flow),
			next: await nextOf(s, current),
			...(orderKey ? { orderKey } : {}),
		});
	};

	// ------------------------------------------------------------------------------------------- shopper routes

	/**
	 * The order a shopper asks for: their own with a sign-in, or any order whose key they send (E21).
	 * @param {any} ctx
	 * @param {(store: ReturnType<typeof createOrdersStore>) => Promise<OrderRecord | null>} find
	 */
	const ownOrder = async (ctx, find) => {
		const s = await service.site(ctx);
		const shopper = await service.shopper(s);
		if (shopper) await guests.claim(s, shopper);
		const key = ctx.headers?.get?.(ORDER_KEY_HEADER);
		if (!shopper && !key) throw problem('sign_in_required', 'Sign in to continue.');
		const found = await find(createOrdersStore(await s.data()));
		const mine =
			found && ((shopper && found.customer.userId === shopper.id) || (key && keyOpens(key, found.accessKeyHash ?? null)));
		if (!found || !mine) throw problem('not_found', 'There is no such order.');
		return { s, shopper, order: found };
	};

	/**
	 * The order of a shopper route's `:id`: their own with a sign-in, or the one their order key opens (E21).
	 * @param {any} ctx
	 */
	const shopperOrder = (ctx) => ownOrder(ctx, (store) => store.order(String(ctx.params.id)));

	/** @param {any} ctx */
	const list = async (ctx) => {
		const page = paginate(
			{ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url },
			{ defaultLimit: 20, maxLimit: 50 },
		);
		const s = await service.site(ctx);
		const shopper = await service.requireShopper(s);
		await guests.claim(s, shopper);
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
				statusLabel: shopperLabel(flow, order.status),
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

	/** GET /v1/shop/orders/by-number/:number: order pages by number (E21). @param {any} ctx */
	const readByNumber = async (ctx) => {
		const number = String(ctx.params.number);
		if (!ORDER_NUMBER.test(number)) throw problem('not_found', 'There is no such order.');
		const { s, order } = await ownOrder(ctx, (store) => store.byNumber(number));
		return shopperView(s, await refresh(s, order), await flowOf(s));
	};

	/** @param {any} ctx */
	const cancelByShopper = async (ctx) => {
		const { s, shopper, order } = await shopperOrder(ctx);
		const current = await refresh(s, order);
		const flow = await flowOf(s);
		const move = shopperCancelOf(flow, current.status);
		if (!move) throw problem('move_not_allowed', 'This order can no longer be cancelled here.');
		// a paid order as the move says (E27): refused (staff cancel and refund it), cancelled with the refund due, or
		// cancelled and refunded through Payments
		if (current.payment.paid > 0 && move.options.shopperPaid === 'refuse')
			throw problem('move_not_allowed', 'This order is paid; please ask the shop to cancel and refund it.');
		const cancelled = await cancel(s, current, {
			by: shopper ? 'shopper' : 'guest',
			note: 'Cancelled by the shopper',
			code: 'shopper',
			reason: 'shopper',
			to: move.to,
		});
		if (!cancelled) throw problem('move_not_allowed', 'This order can no longer be cancelled here.');
		// paid at Payments just before (K-13): it is paid now, and staff cancel and refund paid orders
		if (cancelled.role !== 'cancelled')
			throw problem('move_not_allowed', 'This order is paid; please ask the shop to cancel and refund it.');
		return { order: await shopperView(s, cancelled, flow) };
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
		if ((await nextOf(s, current)).kind !== 'pay') {
			const started = await startPayment(s, current, returnUrl, `${current.id}-${service.now()}`);
			if (!started) throw problem('payments_unavailable', 'Payments cannot be reached right now. Try again in a moment.');
			current = started;
		}
		return { order: await shopperView(s, current, await flowOf(s)), next: await nextOf(s, current) };
	};

	/** POST /v1/shop/orders/:id/proof/upload `{ type, size }`: a signed upload of a transfer proof (E24). @param {any} ctx */
	const proofUpload = async (ctx) => {
		const { s, order } = await shopperOrder(ctx);
		if (!takesProof(order)) throw problem('nothing_to_pay', 'This order is not waiting for a transfer proof.');
		const body = typeof ctx.body === 'object' && ctx.body !== null ? ctx.body : {};
		const extension = Object.hasOwn(PROOF_TYPES, body.type)
			? PROOF_TYPES[/** @type {keyof typeof PROOF_TYPES} */ (body.type)]
			: null;
		if (!extension) throw service.invalid('type', 'Upload a JPEG, PNG, WebP or PDF file.');
		if (!Number.isSafeInteger(body.size) || body.size < 1 || body.size > PROOF_MAX_BYTES)
			throw service.invalid('size', 'The largest proof is 10 MB.');
		const storage = await product.connections.storage(s.websiteId);
		if (!storage) throw problem('storage_not_connected', 'Uploads are not possible right now.');
		const signed = storage.presignPut({
			key: `ecommerce/proofs/${order.id}/${createId('prf')}.${extension}`,
			contentType: body.type,
			contentLength: body.size,
			expiresIn: PROOF_SECONDS,
		});
		return created({
			upload: { method: signed.method, url: signed.url, headers: signed.headers },
			key: signed.key,
			expiresAt: signed.expiresAt,
		});
	};

	/** POST /v1/shop/orders/:id/proof `{ key, reference? }`: send the transfer proof (E24). @param {any} ctx */
	const sendProof = async (ctx) => {
		const { s, order } = await shopperOrder(ctx);
		if (!takesProof(order)) throw problem('nothing_to_pay', 'This order is not waiting for a transfer proof.');
		const body = typeof ctx.body === 'object' && ctx.body !== null ? ctx.body : {};
		const key = typeof body.key === 'string' ? body.key : '';
		const folder = `ecommerce/proofs/${order.id}/`;
		if (!key.startsWith(folder) || !/^prf_[A-Za-z0-9_-]{1,64}\.(jpg|png|webp|pdf)$/.test(key.slice(folder.length)))
			throw service.invalid('key', 'Upload the proof first.');
		const reference = typeof body.reference === 'string' ? body.reference.trim() : '';
		if (reference.length > 120) throw service.invalid('reference', 'The reference has at most 120 characters.');
		const storage = await product.connections.storage(s.websiteId);
		const head = storage ? await storage.headObject({ key }) : null;
		if (!head?.exists) throw service.invalid('key', 'The proof was not uploaded.');
		const now = service.now();
		const store = createOrdersStore(await s.data());
		// with a proof the order no longer ends with the payment window: it waits for staff to confirm or cancel it
		const changed = await store.change(
			order,
			{ 'payment.proof': { key, reference, at: new Date(now) }, holdUntil: null },
			{
				push: {
					history: {
						at: new Date(now),
						from: order.status,
						to: order.status,
						by: 'shopper',
						...serverNote('proof_sent', 'Transfer proof sent'),
					},
				},
			},
		);
		if (!changed) throw problem('conflict', 'The order changed meanwhile; reload it and try again.');
		await service.emit('order.proof_uploaded', s, { order: changed, reference });
		return { order: await shopperView(s, changed, await flowOf(s)) };
	};

	/** @param {any} ctx */
	const downloadFile = async (ctx) => {
		const { s, order } = await shopperOrder(ctx);
		return digital.download(s, await refresh(s, order), String(ctx.params.lineId), String(ctx.params.file));
	};

	/** @param {any} ctx */
	const quoteCart = async (ctx) => {
		const s = await service.site(ctx);
		const checkout = await s.values('checkout');
		const cart = checkCart(ctx.body, {
			maxLines: Number(checkout.maxLines ?? 50),
			maxQuantity: Number(checkout.maxQuantity ?? 99),
		});
		if (!cart.ok) throw service.invalid(cart.field, cart.message);
		return quoting.view(s, await quoting.quote(s, cart.value, await service.shopper(s)));
	};

	return Object.freeze({
		sweep,
		place,
		editWaiting,
		shopperView,
		shopperOrder,
		list,
		read,
		readByNumber,
		cancelByShopper,
		pay,
		proofUpload,
		sendProof,
		downloadFile,
		quoteCart,
		cancel,
	});
};

/** @typedef {ReturnType<typeof createOrdering>} Ordering */
