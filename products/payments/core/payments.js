/**
 * Payments, links, refunds and subscriptions as data (PLAN 0.8.7): input checks, statuses, refund rules, the views the
 * API and widgets answer, and the CSV the Payments admin widget exports. No I/O.
 * @module
 */
import { toCsv } from '@ss/contracts/csv';
import { normalizeEmail } from '@ss/contracts/email';
import { isCurrency, isPositiveAmount, toDecimal } from '@ss/contracts/format';
import { isObject } from '@ss/contracts/util';
import { isGateway, SUBSCRIPTION_GATEWAYS } from './gateways.js';
import { isMethodKey } from './methods.js';

// the decimal amounts the admin widgets take and show (widgets reach @ss/contracts through core/)
export { fromDecimal, toDecimal } from '@ss/contracts/format';

/**
 * Payment statuses. `pending`: waiting for the payer or the gateway; `cancelled`: the payer canceled at the gateway
 * (they may try again); `voided`: the merchant canceled it (`POST /v1/payments/:id/cancel`, for example its order was
 * canceled or expired), so nobody can pay it any more; `refunded` and `partially_refunded` were paid.
 */
export const PAYMENT_STATUSES = Object.freeze(
	/** @type {const} */ (['pending', 'paid', 'failed', 'cancelled', 'voided', 'partially_refunded', 'refunded']),
);
/** Subscription statuses mirrored from the gateway. */
export const SUBSCRIPTION_STATUSES = Object.freeze(
	/** @type {const} */ (['pending', 'active', 'past_due', 'paused', 'cancelled', 'expired']),
);
/**
 * Payment events (the kit's events, PLAN 0.8.10 K5: listed by `GET /v1/events` and sent to the merchant through
 * Notifications as `payments.<type>`).
 */
export const EVENT_TYPES = Object.freeze(
	/** @type {const} */ ([
		'payment.paid',
		'payment.failed',
		'payment.refunded',
		'payment.proof_uploaded',
		'subscription.updated',
	]),
);
/** The largest event data the kit takes (16 kB of JSON). */
export const EVENT_DATA_LIMIT = 16 * 1024;

/** @typedef {typeof PAYMENT_STATUSES[number]} PaymentStatus */
/** @typedef {typeof SUBSCRIPTION_STATUSES[number]} SubscriptionStatus */
/** @typedef {{ id?: string, name?: string, email?: string, phone?: string }} Customer */
/** @typedef {{ ok: true, value: any } | { ok: false, field: string, message: string }} Checked */

/**
 * Plain one-line text: trimmed, control characters removed, at most `max` characters; '' when absent.
 * @param {unknown} value
 * @param {number} max
 * @returns {string | null} null when it is not text or too long
 */
export const cleanText = (value, max) => {
	if (value === undefined || value === null) return '';
	if (typeof value !== 'string') return null;
	// eslint-disable-next-line no-control-regex
	const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
	return text.length > max ? null : text;
};

const PHONE = /^\+[1-9]\d{6,14}$/;

/**
 * A payer's details: the Accounts user id, name, email and phone (international format), each optional.
 * @param {unknown} value
 * @returns {Checked}
 */
export const checkCustomer = (value) => {
	if (value === undefined || value === null) return { ok: true, value: {} };
	if (!isObject(value)) return { ok: false, field: 'customer', message: 'customer must be an object.' };
	/** @type {Customer} */
	const customer = {};
	const id = cleanText(value.id, 128);
	if (id === null) return { ok: false, field: 'customer/id', message: 'customer.id is at most 128 characters.' };
	if (id) customer.id = id;
	const name = cleanText(value.name, 120);
	if (name === null) return { ok: false, field: 'customer/name', message: 'customer.name is at most 120 characters.' };
	if (name) customer.name = name;
	if (value.email !== undefined && value.email !== '') {
		const email = normalizeEmail(value.email);
		if (email === null) return { ok: false, field: 'customer/email', message: 'customer.email is not an email address.' };
		customer.email = email;
	}
	if (value.phone !== undefined && value.phone !== '') {
		const phone = typeof value.phone === 'string' ? value.phone.replace(/[\s()-]/g, '') : '';
		if (!PHONE.test(phone))
			return { ok: false, field: 'customer/phone', message: 'customer.phone needs the international format (+…).' };
		customer.phone = phone;
	}
	return { ok: true, value: customer };
};

/**
 * The merchant's own labels on a payment: up to 20 names (letters, digits, `_`, `-`, `.`) with texts of at most 500
 * characters.
 * @param {unknown} value
 * @returns {Checked}
 */
export const checkMetadata = (value) => {
	if (value === undefined || value === null) return { ok: true, value: {} };
	const message = 'metadata maps up to 20 names to texts of at most 500 characters.';
	if (!isObject(value)) return { ok: false, field: 'metadata', message };
	const entries = Object.entries(value);
	if (entries.length > 20) return { ok: false, field: 'metadata', message };
	/** @type {Record<string, string>} */
	const metadata = {};
	for (const [name, text] of entries) {
		if (!/^[A-Za-z0-9_.-]{1,40}$/.test(name) || typeof text !== 'string' || text.length > 500)
			return { ok: false, field: 'metadata', message };
		metadata[name] = text;
	}
	return { ok: true, value: metadata };
};

/**
 * True for what a payment's `gateway` may name: a gateway id or a manual payment method's key.
 * @param {unknown} value
 * @returns {value is string}
 */
export const isPaymentMethod = (value) => isGateway(value) || isMethodKey(value);

/**
 * A new payment from the API: amount (minor units) and currency, optional gateway or manual method (else the payer
 * picks one), the
 * description payers see, the merchant's reference (for example the order id), the payer, metadata and the return and
 * cancel addresses (their origins are checked against the website by the caller).
 * @param {unknown} body
 * @returns {Checked}
 */
export const checkPaymentInput = (body) => {
	const input = isObject(body) ? body : {};
	if (!isPositiveAmount(input.amount))
		return { ok: false, field: 'amount', message: 'amount is a whole number of minor units (cents, pence …), at least 1.' };
	if (!isCurrency(input.currency))
		return { ok: false, field: 'currency', message: 'currency is an ISO 4217 code (USD, EUR …).' };
	if (input.gateway !== undefined && input.gateway !== null && !isPaymentMethod(input.gateway))
		return { ok: false, field: 'gateway', message: "gateway is a gateway id or a manual payment method's key." };
	const description = cleanText(input.description, 200);
	if (description === null) return { ok: false, field: 'description', message: 'description is at most 200 characters.' };
	const reference = cleanText(input.reference, 120);
	if (reference === null) return { ok: false, field: 'reference', message: 'reference is at most 120 characters.' };
	const customer = checkCustomer(input.customer);
	if (!customer.ok) return customer;
	const metadata = checkMetadata(input.metadata);
	if (!metadata.ok) return metadata;
	for (const field of ['returnUrl', 'cancelUrl'])
		if (input[field] !== undefined && (typeof input[field] !== 'string' || input[field].length > 2048))
			return { ok: false, field, message: `${field} is an address of at most 2048 characters.` };
	return {
		ok: true,
		value: {
			amount: input.amount,
			currency: input.currency,
			gateway: input.gateway ?? null,
			description,
			reference,
			customer: customer.value,
			metadata: metadata.value,
			answers: [],
			returnUrl: input.returnUrl ?? null,
			cancelUrl: input.cancelUrl ?? null,
		},
	};
};

/** Whether a payment link asks the payer's phone (P3). */
export const LINK_PHONE = Object.freeze(/** @type {const} */ (['off', 'optional', 'required']));

/** Engine caps of a link's own questions (P3, code constants). */
export const LINK_FIELDS = Object.freeze({ max: 3, label: 60, answer: 200 });

/** The longest a link may say it ends after (payments). */
const MAX_LINK_PAYMENTS = 1_000_000;

/**
 * A new payment link: a title, an optional description, a fixed amount (or `null`: the payer enters it, at least
 * `minAmount`), the currency, the gateways it offers (empty: every ready one), where payers return afterwards, and
 * (P3) whether it asks the payer's phone (`off`, `optional`, `required`), up to 3 questions of the merchant's own
 * (`fields`: `{ label, required }`), and when it ends by itself: on a date (`expiresAt`, an ISO time) or after a number
 * of payments (`maxPayments`).
 * @param {unknown} body
 * @returns {Checked}
 */
export const checkLinkInput = (body) => {
	const input = isObject(body) ? body : {};
	const title = cleanText(input.title, 120);
	if (!title) return { ok: false, field: 'title', message: 'title is required (at most 120 characters).' };
	const description = cleanText(input.description, 1000);
	if (description === null) return { ok: false, field: 'description', message: 'description is at most 1000 characters.' };
	if (!isCurrency(input.currency))
		return { ok: false, field: 'currency', message: 'currency is an ISO 4217 code (USD, EUR …).' };
	const amount = input.amount ?? null;
	if (amount !== null && !isPositiveAmount(amount))
		return {
			ok: false,
			field: 'amount',
			message: 'amount is a whole number of minor units, or null to let the payer enter it.',
		};
	const minAmount = input.minAmount ?? 1;
	if (!isPositiveAmount(minAmount))
		return { ok: false, field: 'minAmount', message: 'minAmount is a whole number of minor units.' };
	const gateways = input.gateways ?? [];
	if (!Array.isArray(gateways) || gateways.length > 40 || !gateways.every(isPaymentMethod))
		return { ok: false, field: 'gateways', message: "gateways lists gateway ids and manual payment methods' keys." };
	if (input.returnUrl !== undefined && (typeof input.returnUrl !== 'string' || input.returnUrl.length > 2048))
		return { ok: false, field: 'returnUrl', message: 'returnUrl is an address of at most 2048 characters.' };
	const reference = cleanText(input.reference, 120);
	if (reference === null) return { ok: false, field: 'reference', message: 'reference is at most 120 characters.' };
	const phone = input.phone ?? 'off';
	if (!(/** @type {readonly unknown[]} */ (LINK_PHONE).includes(phone)))
		return { ok: false, field: 'phone', message: `phone is ${LINK_PHONE.join(', ')}.` };
	const fieldsIn = input.fields ?? [];
	const fieldMessage = `fields lists up to ${LINK_FIELDS.max} questions { label (at most ${LINK_FIELDS.label} characters), required }.`;
	if (!Array.isArray(fieldsIn) || fieldsIn.length > LINK_FIELDS.max)
		return { ok: false, field: 'fields', message: fieldMessage };
	/** @type {Array<{ label: string, required: boolean }>} */
	const fields = [];
	for (const item of fieldsIn) {
		const label = isObject(item) ? cleanText(item.label, LINK_FIELDS.label) : null;
		if (!label || (item.required !== undefined && typeof item.required !== 'boolean'))
			return { ok: false, field: 'fields', message: fieldMessage };
		fields.push({ label, required: item.required === true });
	}
	const expiresAt = input.expiresAt ?? null;
	if (expiresAt !== null && (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))))
		return { ok: false, field: 'expiresAt', message: 'expiresAt is an ISO 8601 time, or null for no end date.' };
	const maxPayments = input.maxPayments ?? null;
	if (
		maxPayments !== null &&
		(typeof maxPayments !== 'number' ||
			!Number.isSafeInteger(maxPayments) ||
			maxPayments < 1 ||
			maxPayments > MAX_LINK_PAYMENTS)
	)
		return { ok: false, field: 'maxPayments', message: 'maxPayments is a whole number from 1, or null for no limit.' };
	return {
		ok: true,
		value: {
			title,
			description,
			amount,
			minAmount: amount === null ? minAmount : null,
			currency: input.currency,
			gateways: [...new Set(gateways)],
			returnUrl: input.returnUrl ?? null,
			reference,
			phone,
			fields,
			expiresAt: expiresAt === null ? null : new Date(expiresAt),
			maxPayments,
		},
	};
};

/**
 * Why a link no longer takes payments by itself (P3): its end date passed (`expired`) or it has its number of payments
 * (`full`); null while it is open (the merchant's own switch is `active`).
 * @param {{ expiresAt?: Date | string | null, maxPayments?: number | null, paidCount: number }} link
 * @param {number} now
 * @returns {'expired' | 'full' | null}
 */
export const linkClosed = (link, now) => {
	if (link.expiresAt && new Date(link.expiresAt).getTime() <= now) return 'expired';
	if (link.maxPayments && link.paidCount >= link.maxPayments) return 'full';
	return null;
};

/**
 * What a payer gave a link beyond the amount (P3): the phone it asks (international format; required or optional), and
 * the answers to its questions (each at most 200 characters, the required ones not empty).
 * @param {{ phone: string, fields: Array<{ label: string, required: boolean }> }} link
 * @param {{ phone?: unknown, answers?: unknown }} input `answers`: one text per question, in order
 * @returns {{ ok: true, phone: string, answers: Array<{ label: string, value: string }> } |
 *   { ok: false, field: string, index?: number }}
 */
export const checkLinkAnswers = (link, input) => {
	const typed = link.phone === 'off' || typeof input.phone !== 'string' ? '' : input.phone.trim();
	const checked = checkCustomer({ phone: typed });
	if (!checked.ok || (link.phone === 'required' && typed === '')) return { ok: false, field: 'phone' };
	const phone = typeof checked.value.phone === 'string' ? checked.value.phone : '';
	const given = Array.isArray(input.answers) ? input.answers : [];
	/** @type {Array<{ label: string, value: string }>} */
	const answers = [];
	for (const [index, field] of link.fields.entries()) {
		const value = cleanText(given[index] ?? '', LINK_FIELDS.answer);
		if (value === null || (field.required && value === '')) return { ok: false, field: 'answers', index };
		if (value !== '') answers.push({ label: field.label, value });
	}
	return { ok: true, phone, answers };
};

/**
 * A new subscription: the gateway (Stripe or PayPal), the gateway's own plan (a Stripe price id or a PayPal plan id),
 * the payer, the merchant's reference and the return and cancel addresses.
 * @param {unknown} body
 * @returns {Checked}
 */
export const checkSubscriptionInput = (body) => {
	const input = isObject(body) ? body : {};
	if (!(/** @type {readonly unknown[]} */ (SUBSCRIPTION_GATEWAYS).includes(input.gateway)))
		return { ok: false, field: 'gateway', message: `gateway is ${SUBSCRIPTION_GATEWAYS.join(' or ')}.` };
	if (typeof input.plan !== 'string' || !/^[A-Za-z0-9_-]{3,100}$/.test(input.plan))
		return { ok: false, field: 'plan', message: "plan is the gateway's plan or price id." };
	const customer = checkCustomer(input.customer);
	if (!customer.ok) return customer;
	const reference = cleanText(input.reference, 120);
	if (reference === null) return { ok: false, field: 'reference', message: 'reference is at most 120 characters.' };
	if (typeof input.returnUrl !== 'string' || input.returnUrl.length > 2048)
		return { ok: false, field: 'returnUrl', message: 'returnUrl is required (at most 2048 characters).' };
	if (input.cancelUrl !== undefined && (typeof input.cancelUrl !== 'string' || input.cancelUrl.length > 2048))
		return { ok: false, field: 'cancelUrl', message: 'cancelUrl is an address of at most 2048 characters.' };
	return {
		ok: true,
		value: {
			gateway: input.gateway,
			plan: input.plan,
			customer: customer.value,
			reference,
			returnUrl: input.returnUrl,
			cancelUrl: input.cancelUrl ?? null,
		},
	};
};

/**
 * Whether a payment can be refunded by `amount` (minor units; undefined = the rest): it was paid and the amount is
 * at most what is left.
 * @param {{ status: string, amount: number, refunded: number }} payment
 * @param {unknown} amount
 * @returns {{ ok: true, amount: number } | { ok: false, code: 'not_refundable' | 'invalid', message: string }}
 */
export const refundAmount = (payment, amount) => {
	if (payment.status !== 'paid' && payment.status !== 'partially_refunded')
		return { ok: false, code: 'not_refundable', message: 'Only a paid payment can be refunded.' };
	const left = payment.amount - payment.refunded;
	const wanted = amount === undefined || amount === null ? left : amount;
	if (!isPositiveAmount(wanted) || Number(wanted) > left)
		return { ok: false, code: 'invalid', message: `amount is a whole number of minor units, at most ${left}.` };
	return { ok: true, amount: Number(wanted) };
};

/**
 * The status after a refund of `amount`.
 * @param {{ amount: number, refunded: number }} payment before the refund
 * @param {number} amount
 * @returns {'refunded' | 'partially_refunded'}
 */
export const statusAfterRefund = (payment, amount) =>
	payment.refunded + amount >= payment.amount ? 'refunded' : 'partially_refunded';

/**
 * What the payer or the merchant adds to a bank transfer (PLAN 0.8.10 P3): the transfer's `reference` (at most 120
 * characters) with a proof or a confirmation, and the merchant's `note` (at most 500) with a confirmation. Plain
 * one-line texts; '' when absent.
 * @param {unknown} body
 * @param {{ note?: boolean }} [options] `note`: a note is taken too (confirmations)
 * @returns {{ ok: true, value: { reference: string, note: string } } | { ok: false, field: string, message: string }}
 */
export const checkTransferInput = (body, { note: withNote = false } = {}) => {
	const input = isObject(body) ? body : {};
	const reference = cleanText(input.reference, 120);
	if (reference === null) return { ok: false, field: 'reference', message: 'reference is at most 120 characters.' };
	const note = withNote ? cleanText(input.note, 500) : '';
	if (note === null) return { ok: false, field: 'note', message: 'note is at most 500 characters.' };
	return { ok: true, value: { reference, note } };
};

/**
 * Whether money arrived for a payment the merchant had canceled (K-13): it is recorded as paid, and is to be
 * refunded (until all of it is).
 * @param {{ status: string, voidedAt?: Date | string | null }} payment
 */
export const isRefundDue = (payment) =>
	Boolean(payment.voidedAt) && (payment.status === 'paid' || payment.status === 'partially_refunded');

/**
 * Whether a payment is confirmed for the exact amount and currency (PLAN 0.3: Ecommerce marks an order paid only for
 * the same website and the order's exact amount). A payment refunded later was still paid; one the merchant canceled
 * never confirms, even when money arrived after (it is to be refunded).
 * @param {{ status: string, amount: number, currency: string, voidedAt?: Date | string | null }} payment
 * @param {{ amount: unknown, currency: unknown }} expected
 */
export const isConfirmedFor = (payment, expected) =>
	!payment.voidedAt &&
	['paid', 'partially_refunded', 'refunded'].includes(payment.status) &&
	payment.amount === expected.amount &&
	payment.currency === expected.currency;

/** @param {Date | number | string | null | undefined} at */
const iso = (at) => (at === null || at === undefined ? null : new Date(at).toISOString());

/**
 * A payment as the API answers it (no gateway secrets; the proof as a mark only). `voidedAt`: when the merchant
 * canceled it; `refundDue`: money arrived after that, and is to be refunded (K-13).
 * @param {any} payment the stored record
 * @param {string} checkoutUrl the payer's page for it
 */
export const paymentView = (payment, checkoutUrl) => ({
	id: payment.id,
	status: payment.status,
	refundDue: isRefundDue(payment),
	amount: payment.amount,
	currency: payment.currency,
	amountText: toDecimal(payment.amount, payment.currency),
	refunded: payment.refunded,
	gateway: payment.gateway,
	kind: payment.gateway === null ? null : (payment.manual?.kind ?? 'gateway'),
	methodName: payment.manual?.name ?? payment.gatewayName ?? '',
	answers: payment.answers,
	description: payment.description,
	reference: payment.reference,
	customer: payment.customer,
	metadata: payment.metadata,
	source: payment.source,
	linkId: payment.linkId,
	gatewayReference: payment.gatewayRef,
	proof: payment.proof ? { type: payment.proof.type, size: payment.proof.size, uploadedAt: iso(payment.proof.at) } : null,
	refunds: payment.refunds.map((/** @type {any} */ refund) => ({
		id: refund.id,
		amount: refund.amount,
		reason: refund.reason,
		manual: refund.manual,
		by: refund.by,
		createdAt: iso(refund.at),
	})),
	history: payment.history.map((/** @type {any} */ entry) => ({
		at: iso(entry.at),
		event: entry.event,
		...(entry.detail ? { detail: entry.detail } : {}),
		...(entry.by ? { by: entry.by } : {}),
		...(entry.reference ? { reference: entry.reference } : {}),
		...(entry.note ? { note: entry.note } : {}),
	})),
	checkoutUrl,
	paidAt: iso(payment.paidAt),
	voidedAt: iso(payment.voidedAt),
	createdAt: iso(payment.createdAt),
	updatedAt: iso(payment.updatedAt),
});

/**
 * The data of a payment event: the payment as the API answers it (plus `extra`, for example the refund). A payment
 * whose metadata and history make it larger than an event may be is sent without them; read the payment for them.
 * @param {ReturnType<typeof paymentView>} view
 * @param {Record<string, unknown>} [extra]
 * @returns {Record<string, unknown>}
 */
export const paymentEventData = (view, extra = {}) => {
	const data = { payment: view, ...extra };
	if (JSON.stringify(data).length <= EVENT_DATA_LIMIT) return data;
	return { payment: { ...view, metadata: {}, history: [] }, ...extra };
};

/**
 * A payment link as the API answers it, with why it ended by itself (`closed`, P3).
 * @param {any} link
 * @param {string} url the hosted link page
 * @param {number} now
 */
export const linkView = (link, url, now) => ({
	id: link.id,
	title: link.title,
	description: link.description,
	amount: link.amount,
	minAmount: link.minAmount,
	currency: link.currency,
	gateways: link.gateways,
	returnUrl: link.returnUrl,
	reference: link.reference,
	active: link.active,
	paidCount: link.paidCount,
	phone: link.phone,
	fields: link.fields,
	expiresAt: link.expiresAt ? iso(link.expiresAt) : null,
	maxPayments: link.maxPayments,
	closed: linkClosed(link, now),
	url,
	createdAt: iso(link.createdAt),
});

/**
 * A subscription as the API answers it.
 * @param {any} subscription
 */
export const subscriptionView = (subscription) => ({
	id: subscription.id,
	status: subscription.status,
	gateway: subscription.gateway,
	plan: subscription.plan,
	reference: subscription.reference,
	customer: subscription.customer,
	gatewayReference: subscription.gatewayRef,
	history: subscription.history.map((/** @type {any} */ entry) => ({
		at: iso(entry.at),
		event: entry.event,
		...(entry.detail ? { detail: entry.detail } : {}),
		...(entry.by ? { by: entry.by } : {}),
	})),
	createdAt: iso(subscription.createdAt),
	updatedAt: iso(subscription.updatedAt),
});

/** Stripe subscription statuses → mirrored statuses. */
const STRIPE_SUBSCRIPTION = Object.freeze({
	incomplete: 'pending',
	trialing: 'active',
	active: 'active',
	past_due: 'past_due',
	unpaid: 'past_due',
	paused: 'paused',
	canceled: 'cancelled',
	incomplete_expired: 'expired',
});
/** PayPal subscription statuses → mirrored statuses. */
const PAYPAL_SUBSCRIPTION = Object.freeze({
	APPROVAL_PENDING: 'pending',
	APPROVED: 'pending',
	ACTIVE: 'active',
	SUSPENDED: 'paused',
	CANCELLED: 'cancelled',
	EXPIRED: 'expired',
});

/**
 * A gateway's subscription status as Payments mirrors it, or null when unknown.
 * @param {'stripe' | 'paypal'} gateway
 * @param {unknown} status
 * @returns {SubscriptionStatus | null}
 */
export const mirrorStatus = (gateway, status) => {
	const table = /** @type {Record<string, SubscriptionStatus>} */ (
		gateway === 'stripe' ? STRIPE_SUBSCRIPTION : PAYPAL_SUBSCRIPTION
	);
	return typeof status === 'string' && Object.hasOwn(table, status) ? /** @type {SubscriptionStatus} */ (table[status]) : null;
};

/**
 * Payments as CSV (the Payments admin widget's export, `@ss/contracts/csv`, P8): one row per payment with the given
 * column titles; the status and the gateway are the website's words for them (a manual payment method's own name as the
 * payment took it); the amount and the refunded amount are plain decimals with the payment's currency beside them.
 * @param {ReadonlyArray<any>} payments views
 * @param {{ id: string, date: string, status: string, amount: string, currency: string, refunded: string, gateway: string,
 *   reference: string, email: string, description: string }} titles
 * @param {{ status: (status: string) => string, gateway: (gateway: string, methodName: string) => string }} names
 */
export const paymentsCsv = (payments, titles, names) =>
	toCsv(
		[
			titles.id,
			titles.date,
			titles.status,
			titles.amount,
			titles.currency,
			titles.refunded,
			titles.gateway,
			titles.reference,
			titles.email,
			titles.description,
		],
		payments.map((payment) => [
			payment.id,
			payment.createdAt,
			names.status(payment.status),
			toDecimal(payment.amount, payment.currency),
			payment.currency,
			toDecimal(payment.refunded, payment.currency),
			payment.gateway ? names.gateway(payment.gateway, payment.methodName) : '',
			payment.reference,
			payment.customer?.email,
			payment.description,
		]),
	);
