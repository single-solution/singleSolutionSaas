/**
 * Orders as Checkout places them (pure): the placement request, the order document with its totals snapshot, the
 * lifecycle Checkout itself owns (confirm, pay, cancel, expire, complete, refund — the Orders product drives the rest
 * through events), the public view and the standard event data.
 *
 * Stock (review lesson A21): stock reserved at placement goes back only while the order has not been completed; a
 * completed order's stock is committed, and returns are restocked by whoever receives them (inventory events), never by
 * a late cancel. Payments and refunds are recorded on the order (lesson A22) with amount, method, reference and actor.
 * @module
 */
import { METHOD_KEYS, UNCONFIRMED } from './payments.js';
import { CURRENCY, cleanText, isId, isKey, isObject, issue } from './text.js';

/**
 * @typedef {'pending_payment' | 'awaiting_confirmation' | 'confirmed' | 'completed' | 'cancelled' | 'refunded'} OrderStatus
 */

export const PLACEMENT_LIMITS = Object.freeze({ codes: 10, consents: 20, note: 1000, lines: 500 });
const CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Validate the parts of a placement request that do not depend on the form settings (those are validated by
 * `validateForm`).
 * @param {unknown} body
 * @param {{ maxLines: number, maxQuantity: number, maxCodes: number, serverKey: boolean }} rules
 */
export const validatePlacement = (body, rules) => {
	/** @type {import('./text.js').FieldProblem[]} */
	const problems = [];
	if (!isObject(body)) return { problems: [issue('', 'body_invalid')], input: null };
	const hasCart = body.cartId !== undefined;
	const hasLines = body.lines !== undefined;
	if (hasCart === hasLines) problems.push(issue('/cartId', 'cart_or_lines'));
	if (hasCart && !isId(body.cartId)) problems.push(issue('/cartId', 'id_invalid'));
	/** @type {Array<{ itemId: string, variantId: string | null, quantity: number }>} */
	const lines = [];
	if (hasLines) {
		if (!Array.isArray(body.lines) || body.lines.length === 0 || body.lines.length > rules.maxLines)
			problems.push(issue('/lines', 'lines_count'));
		else
			body.lines.forEach((/** @type {any} */ line, index) => {
				if (!isObject(line) || !isId(line.itemId)) return problems.push(issue(`/lines/${index}/itemId`, 'id_invalid'));
				if (line.variantId !== undefined && line.variantId !== null && !isId(line.variantId))
					return problems.push(issue(`/lines/${index}/variantId`, 'id_invalid'));
				if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > rules.maxQuantity)
					return problems.push(issue(`/lines/${index}/quantity`, 'quantity_invalid'));
				const same = lines.find((entry) => entry.itemId === line.itemId && entry.variantId === (line.variantId ?? null));
				// the same variant on two lines is one line: it is validated and reserved against one combined quantity
				if (same) same.quantity += line.quantity;
				else lines.push({ itemId: line.itemId, variantId: line.variantId ?? null, quantity: line.quantity });
				return undefined;
			});
		if (lines.some((line) => line.quantity > rules.maxQuantity)) problems.push(issue('/lines', 'quantity_invalid'));
	}
	if (!METHOD_KEYS.includes(body.paymentMethod)) problems.push(issue('/paymentMethod', 'payment_unavailable'));
	const codes = body.codes === undefined ? [] : body.codes;
	if (
		!Array.isArray(codes) ||
		codes.length > rules.maxCodes ||
		codes.some((code) => typeof code !== 'string' || !CODE.test(code.trim()))
	)
		problems.push(issue('/codes', 'codes_invalid'));
	const points = body.loyaltyPoints ?? 0;
	if (!Number.isSafeInteger(points) || points < 0) problems.push(issue('/loyaltyPoints', 'points_invalid'));
	const consents = body.consents ?? [];
	if (!Array.isArray(consents) || consents.length > PLACEMENT_LIMITS.consents || consents.some((key) => !isKey(key)))
		problems.push(issue('/consents', 'consents_invalid'));
	if (body.expectedTotal !== undefined && !(Number.isSafeInteger(body.expectedTotal) && body.expectedTotal >= 0))
		problems.push(issue('/expectedTotal', 'amount_invalid'));
	if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > PLACEMENT_LIMITS.note))
		problems.push(issue('/note', 'too_long'));
	if (body.customer !== undefined) {
		if (!rules.serverKey) problems.push(issue('/customer', 'server_key_only'));
		else if (
			!isObject(body.customer) ||
			(body.customer.subject !== undefined && cleanText(body.customer.subject, 255) === null)
		)
			problems.push(issue('/customer', 'customer_invalid'));
	}
	if (problems.length > 0) return { problems, input: null };
	return {
		problems,
		input: {
			cartId: hasCart ? /** @type {string} */ (body.cartId) : null,
			lines: hasLines ? lines : null,
			paymentMethod: /** @type {import('./payments.js').MethodKey} */ (body.paymentMethod),
			codes: [...new Set(/** @type {string[]} */ (codes).map((code) => code.trim()))],
			loyaltyPoints: /** @type {number} */ (points),
			consents: [...new Set(/** @type {string[]} */ (consents))],
			expectedTotal: Number.isSafeInteger(body.expectedTotal) ? /** @type {number} */ (body.expectedTotal) : null,
			note: cleanText(body.note, PLACEMENT_LIMITS.note),
			saveAddress: body.saveAddress === true,
			returnUrl: typeof body.returnUrl === 'string' ? body.returnUrl.slice(0, 2048) : null,
			customer: isObject(body.customer)
				? {
						subject: cleanText(body.customer.subject, 255),
						email: cleanText(body.customer.email, 254),
						phone: cleanText(body.customer.phone, 40),
					}
				: null,
		},
	};
};

/** @typedef {NonNullable<ReturnType<typeof validatePlacement>['input']>} PlacementInput */

/**
 * The order number: prefix + sequence padded.
 * @param {number} sequence
 * @param {{ prefix: string, padding: number }} format
 */
export const orderNumber = (sequence, { prefix, padding }) => `${prefix}${String(sequence).padStart(padding, '0')}`;

/**
 * @typedef {object} TimelineEntry
 * @property {string} status
 * @property {string} at ISO time
 * @property {{ type: string, id?: string | null }} actor
 * @property {string | null} [reason]
 */

/** Allowed local transitions (from which statuses). */
export const TRANSITIONS = Object.freeze({
	confirm: /** @type {readonly string[]} */ (['pending_payment', 'awaiting_confirmation']),
	cancel: /** @type {readonly string[]} */ (['pending_payment', 'awaiting_confirmation', 'confirmed']),
	expire: /** @type {readonly string[]} */ (UNCONFIRMED),
	complete: /** @type {readonly string[]} */ (['pending_payment', 'awaiting_confirmation', 'confirmed']),
});

/**
 * May the customer cancel their own order (only before it is confirmed, when the setting allows)?
 * @param {Record<string, any>} order
 * @param {boolean} customerCancellable
 */
export const customerMayCancel = (order, customerCancellable) =>
	customerCancellable && /** @type {readonly string[]} */ (UNCONFIRMED).includes(order.status);

/**
 * Has the order's hold (payment or confirmation deadline) passed? An expired hold counts as expired from that moment,
 * whether or not a sweep has cancelled the order yet.
 * @param {Record<string, any>} order
 * @param {number} now
 */
export const holdExpired = (order, now) =>
	/** @type {readonly string[]} */ (UNCONFIRMED).includes(order.status) &&
	Boolean(order.expiresAt) &&
	new Date(order.expiresAt).getTime() <= now;

/**
 * Does moving to `cancelled` give the stock back? Only while the order is not completed and the stock is still held.
 * @param {Record<string, any>} order
 */
export const releasesStock = (order) =>
	order.stock?.state === 'reserved' && ['pending_payment', 'awaiting_confirmation', 'confirmed'].includes(order.status);

/**
 * Public view of an order (no tokens, hashes or internal fields).
 * @param {Record<string, any>} order
 */
export const orderView = (order) => ({
	id: order.id,
	number: order.number,
	status: order.status,
	placedAt: new Date(order.placedAt).toISOString(),
	expiresAt: order.expiresAt ? new Date(order.expiresAt).toISOString() : null,
	currency: order.currency,
	lines: (order.lines ?? []).map((/** @type {any} */ line) => ({
		itemId: line.itemId,
		variantId: line.variantId,
		title: line.title,
		variantTitle: line.variantTitle ?? null,
		sku: line.sku ?? null,
		image: line.image ?? null,
		quantity: line.quantity,
		unitAmount: line.unitAmount,
		totalAmount: line.unitAmount * line.quantity,
	})),
	totals: order.totals,
	contact: order.contact ?? {},
	address: order.address ?? null,
	delivery: order.delivery ?? null,
	pickupLocation: order.pickupLocation ?? null,
	payment: {
		method: order.payment.method,
		kind: order.payment.kind,
		status: order.payment.status,
		advance: order.payment.advance ?? 0,
		dueNow: order.payment.dueNow ?? 0,
		dueLater: order.payment.dueLater ?? 0,
		reference: order.payment.reference ?? null,
	},
	offers: {
		codes: order.offers?.coupons?.codes ?? [],
		deals: (order.offers?.deals?.deals ?? []).map((/** @type {any} */ deal) => ({ name: deal.name, amount: deal.amount })),
		loyaltyPoints: order.offers?.loyalty?.points ?? 0,
	},
	proofs: (order.proofs ?? [])
		.filter((/** @type {any} */ proof) => proof.status === 'submitted')
		.map((/** @type {any} */ proof) => ({ id: proof.id, submittedAt: proof.submittedAt, reference: proof.reference ?? null })),
	payments: (order.payments ?? []).map((/** @type {any} */ payment) => ({
		method: payment.method,
		amount: payment.amount,
		status: payment.status,
		reference: payment.reference ?? null,
		at: payment.at,
	})),
	refunds: (order.refunds ?? []).map((/** @type {any} */ refund) => ({
		amount: refund.amount,
		reason: refund.reason ?? null,
		at: refund.at,
	})),
	timeline: (order.timeline ?? []).map((/** @type {any} */ entry) => ({
		status: entry.status,
		at: entry.at,
		reason: entry.reason ?? null,
	})),
	cancellable: false,
});

/**
 * The customer reference of the standard order events (identity reference, never a profile): subject from the
 * website's identity issuer, e-mail, and the phone only when it is E.164.
 * @param {{ subject?: string | null, email?: string | null, phone?: string | null }} customer
 */
export const customerRef = (customer) => {
	/** @type {Record<string, string>} */
	const ref = {};
	if (customer.subject) ref.subject = customer.subject.slice(0, 255);
	if (customer.email && /^[^\s@]+@[^\s@]+$/.test(customer.email)) ref.email = customer.email;
	if (customer.phone && /^\+[1-9][0-9]{6,14}$/.test(customer.phone)) ref.phone = customer.phone;
	return Object.keys(ref).length > 0 ? ref : null;
};

/**
 * Lines of the standard order events.
 * @param {ReadonlyArray<Record<string, any>>} lines
 */
export const eventLines = (lines) =>
	lines.slice(0, PLACEMENT_LIMITS.lines).map((line) => ({
		itemId: line.itemId,
		...(line.variantId ? { variantId: line.variantId } : {}),
		...(line.sku ? { sku: String(line.sku).slice(0, 100) } : {}),
		title: String(line.title).slice(0, 300),
		quantity: line.quantity,
		unitAmount: line.unitAmount,
		totalAmount: line.unitAmount * line.quantity,
	}));

/** @param {unknown} value */
export const isCurrency = (value) => typeof value === 'string' && CURRENCY.test(value);
