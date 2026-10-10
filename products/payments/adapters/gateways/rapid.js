/**
 * Rapid Gateway (PLAN 0.8.7; `rapidgateway.pk`), with the merchant's own account: hosted checkout by redirect. Payments
 * creates the payment with Rapid's API (`POST /v1/payments`, the secret key as a bearer token, JSON, the amount in whole
 * rupees) and sends the payer to the `checkout_url` it answers, where the payer pays by card, Easypaisa, JazzCash or
 * Raast. Rapid confirms with a webhook to the notice address, signed in `X-RG-Signature`: hex HMAC-SHA256 of the raw
 * body with the webhook secret. Payments trusts only a webhook whose signature matches; `succeeded`, `paid` or
 * `success` is paid for the webhook's `amount`. Rapid offers no status or refund call that Payments uses, so a payment
 * is confirmed by the webhook only and refunds are recorded by hand (the merchant returns the money in the Rapid
 * dashboard).
 *
 * Connection `rapid`: `{ secretKey, webhookSecret, sandbox? }`.
 * @module
 */
import { fromDecimal, toDecimal } from '../../core/money.js';
import { hmacHex, isObject, same } from '../util.js';
import { call, failure, ok2xx } from './types.js';

/** @typedef {import('./types.js').GatewayAdapter} GatewayAdapter */

const RAPID_LIVE = 'https://api.rapidgateway.pk/v1';
const RAPID_SANDBOX = 'https://sandbox.api.rapidgateway.pk/v1';
/** The header of Rapid's signed webhooks. */
const SIGNATURE_HEADER = 'x-rg-signature';
/** The gateway's name in messages. */
const NAME = 'Rapid Gateway';
/** The ways to pay Rapid's checkout offers. */
const METHODS = Object.freeze(['card', 'easypaisa', 'jazzcash', 'raast']);
/** Webhook statuses of a paid payment. */
const PAID = new Set(['succeeded', 'paid', 'success']);

/** @param {Record<string, any>} keys */
const apiOf = (keys) => (keys.sandbox === true ? RAPID_SANDBOX : RAPID_LIVE);

/**
 * An amount in whole currency units (Rapid takes whole rupees), or null when it has a fraction.
 * @param {number} amount minor units
 * @param {string} currency
 */
export const wholeUnits = (amount, currency) => {
	const [whole = '0', fraction = ''] = toDecimal(amount, currency).split('.');
	return /^0*$/.test(fraction) ? Number(whole) : null;
};

/**
 * Rapid's webhook signature of a body.
 * @param {string} body
 * @param {string} secret
 */
export const webhookSignature = (body, secret) => hmacHex(secret, body);

/** @type {GatewayAdapter} */
export const rapid = {
	id: 'rapid',
	violation: (keys) => {
		if (!isObject(keys)) return 'Fill in the secret key and the webhook secret.';
		if (typeof keys.secretKey !== 'string' || keys.secretKey.trim().length < 8 || /\s/.test(keys.secretKey))
			return 'Fill in the secret key.';
		if (typeof keys.webhookSecret !== 'string' || keys.webhookSecret.trim().length < 8 || /\s/.test(keys.webhookSecret))
			return 'Fill in the webhook secret.';
		if (keys.sandbox !== undefined && typeof keys.sandbox !== 'boolean') return 'sandbox is true or false.';
		return null;
	},
	// Rapid has no read-only call for the keys: they are checked for their shape, and on the first payment
	test: async (keys) => {
		const problem = rapid.violation(keys);
		return problem ? { ok: false, message: problem } : { ok: true };
	},
	start: async ({ payment, keys, urls }, ctx) => {
		const amount = wholeUnits(payment.amount, payment.currency);
		if (amount === null) return { kind: 'error', message: `${NAME} takes whole amounts only.` };
		const answer = await call(ctx, `${apiOf(keys)}/payments`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${keys.secretKey}`,
				'content-type': 'application/json',
				'idempotency-key': `ss-${payment.id}`,
			},
			body: JSON.stringify({
				amount,
				currency: payment.currency,
				methods: METHODS,
				customer: payment.customer.phone ? { phone: payment.customer.phone } : {},
				metadata: { ss_payment: payment.id, ss_website: payment.websiteId },
				return_url: urls.return,
				webhook_url: urls.notify,
			}),
		});
		const url = answer.json?.checkout_url;
		const id = answer.json?.id;
		if (!ok2xx(answer.status) || typeof url !== 'string' || !url.startsWith('https://') || typeof id !== 'string' || id === '')
			return {
				kind: 'error',
				message: typeof answer.json?.message === 'string' ? answer.json.message : failure(NAME, answer.status),
			};
		return { kind: 'redirect', url, ref: id };
	},
	notice: async (incoming, keys) => {
		const given = (incoming.headers.get(SIGNATURE_HEADER) ?? '').trim().toLowerCase();
		if (!given || !same(given, webhookSignature(incoming.rawBody, String(keys.webhookSecret)))) return { ok: false };
		/** @type {any} */
		let body;
		try {
			body = JSON.parse(incoming.rawBody);
		} catch {
			return { ok: false };
		}
		if (!isObject(body)) return { ok: false };
		const status = typeof body.status === 'string' ? body.status.trim().toLowerCase() : '';
		const currency = typeof body.currency === 'string' && body.currency !== '' ? body.currency.toUpperCase() : 'PKR';
		const amount = fromDecimal(body.amount, currency);
		const ref = typeof body.id === 'string' && body.id !== '' ? body.id.slice(0, 200) : null;
		return {
			ok: true,
			news: [
				{
					kind: 'payment',
					paymentId: typeof body.metadata?.ss_payment === 'string' ? body.metadata.ss_payment : null,
					ref,
					outcome: PAID.has(status)
						? 'paid'
						: status === 'failed'
							? 'failed'
							: status === 'cancelled' || status === 'canceled'
								? 'cancelled'
								: 'pending',
					...(amount === null ? {} : { amount }),
					currency,
					capture: ref,
				},
			],
		};
	},
	refund: async () => ({ ok: true, manual: true }),
};
