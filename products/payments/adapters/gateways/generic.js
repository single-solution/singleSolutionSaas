/**
 * The generic gateway adapter (PLAN 0.8.7) for any other gateway, or the merchant's own bridge to one. The payer's
 * browser posts signed fields to the checkout address; the gateway confirms by posting JSON to the notice address,
 * signed the same way as every Single Solution webhook. Refunds go to the refund address when one is set, else they are
 * recorded by hand.
 *
 * - Checkout fields: `payment_id`, `website_id`, `amount` (minor units), `currency`, `description`, `return_url`,
 *   `cancel_url`, `notify_url`, `timestamp` (unix seconds) and `signature`: hex HMAC-SHA256 with the secret over every
 *   other field sorted by name as `name=value` joined by `&`.
 * - Notice: `POST <notify_url>` with JSON `{ paymentId, status: paid | failed | cancelled, amount, currency, reference? }`
 *   and `SS-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">` (5 minutes).
 * - Refund: `POST <refundUrl>` with JSON `{ refundId, paymentId, reference, amount, currency, reason }`, signed the same
 *   way; any 2xx answer is a refund (its JSON `reference`, if any, is kept).
 *
 * Connection `generic`: `{ name, url, secret, refundUrl?, currencies? }` (`currencies`: comma-separated codes).
 * @module
 */
import { checkUrl, createOutboundPolicy } from '@ss/net';
import { isAmount, isCurrency } from '../../core/money.js';
import { hmacHex, isObject, signTimestamped, verifyTimestamped } from '../util.js';
import { call, failure, ok2xx } from './types.js';

/** @typedef {import('./types.js').GatewayAdapter} GatewayAdapter */

/** The header of the generic adapter's signed notices and refund requests. */
const SIGNATURE_HEADER = 'ss-signature';

/**
 * The checkout fields' signature.
 * @param {Record<string, string>} fields
 * @param {string} secret
 */
export const checkoutSignature = (fields, secret) =>
	hmacHex(
		secret,
		Object.keys(fields)
			.filter((name) => name !== 'signature')
			.sort()
			.map((name) => `${name}=${fields[name]}`)
			.join('&'),
	);

/**
 * The currencies the connection lists (empty: any).
 * @param {unknown} keys
 * @returns {string[]}
 */
export const genericCurrencies = (keys) =>
	isObject(keys) && typeof keys.currencies === 'string'
		? keys.currencies
				.split(',')
				.map((code) => code.trim().toUpperCase())
				.filter(isCurrency)
		: [];

/** @param {unknown} value @param {import('@ss/net').OutboundPolicy} policy */
const httpsAddress = (value, policy) => typeof value === 'string' && value.startsWith('https://') && checkUrl(value, policy).ok;

/**
 * @param {import('@ss/net').OutboundPolicy} [policy] the product's outbound policy (addresses merchants enter)
 * @returns {GatewayAdapter}
 */
export const createGeneric = (policy = createOutboundPolicy()) => {
	/** @type {GatewayAdapter} */
	const generic = {
		id: 'generic',
		violation: (keys) => {
			if (!isObject(keys)) return 'Fill in the name, the checkout address and the secret.';
			if (typeof keys.name !== 'string' || keys.name.trim() === '' || keys.name.length > 40)
				return 'The name payers see is required (at most 40 characters).';
			if (!httpsAddress(keys.url, policy)) return 'The checkout address must be a public https address.';
			if (typeof keys.secret !== 'string' || keys.secret.length < 24) return 'The secret has at least 24 characters.';
			if (keys.refundUrl !== undefined && keys.refundUrl !== '' && !httpsAddress(keys.refundUrl, policy))
				return 'The refund address must be a public https address.';
			if (keys.currencies !== undefined && typeof keys.currencies !== 'string')
				return 'Currencies are ISO 4217 codes separated by commas.';
			return null;
		},
		test: async (keys) => {
			const problem = generic.violation(keys);
			return problem ? { ok: false, message: problem } : { ok: true };
		},
		start: async ({ payment, keys, urls }, ctx) => {
			/** @type {Record<string, string>} */
			const fields = {
				payment_id: payment.id,
				website_id: payment.websiteId,
				amount: String(payment.amount),
				currency: payment.currency,
				description: payment.description,
				return_url: urls.return,
				cancel_url: urls.cancel,
				notify_url: urls.notify,
				timestamp: String(Math.floor(ctx.now() / 1000)),
			};
			fields.signature = checkoutSignature(fields, String(keys.secret));
			return { kind: 'form', action: String(keys.url), fields: Object.entries(fields), ref: payment.id };
		},
		notice: async (incoming, keys, ctx) => {
			const signed = verifyTimestamped({
				header: incoming.headers.get(SIGNATURE_HEADER),
				body: incoming.rawBody,
				secret: String(keys.secret),
				now: ctx.now(),
			});
			if (!signed) return { ok: false };
			/** @type {any} */
			let body;
			try {
				body = JSON.parse(incoming.rawBody);
			} catch {
				return { ok: false };
			}
			if (!isObject(body) || typeof body.paymentId !== 'string' || !['paid', 'failed', 'cancelled'].includes(body.status))
				return { ok: false };
			return {
				ok: true,
				news: [
					{
						kind: 'payment',
						paymentId: body.paymentId,
						ref: typeof body.reference === 'string' ? body.reference.slice(0, 200) : null,
						outcome: body.status,
						...(isAmount(body.amount) ? { amount: body.amount } : {}),
						...(isCurrency(body.currency) ? { currency: body.currency } : {}),
						capture: typeof body.reference === 'string' ? body.reference.slice(0, 200) : null,
					},
				],
			};
		},
		refund: async ({ payment, amount, reason, refundId }, keys, ctx) => {
			if (typeof keys.refundUrl !== 'string' || keys.refundUrl === '') return { ok: true, manual: true };
			const body = JSON.stringify({
				refundId,
				paymentId: payment.id,
				reference: payment.captureRef ?? null,
				amount,
				currency: payment.currency,
				reason,
			});
			const answer = await call(ctx, keys.refundUrl, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					[SIGNATURE_HEADER]: signTimestamped(body, String(keys.secret), ctx.now()),
				},
				body,
			});
			if (!ok2xx(answer.status)) return { ok: false, message: failure(String(keys.name), answer.status) };
			return { ok: true, ref: typeof answer.json?.reference === 'string' ? answer.json.reference.slice(0, 200) : refundId };
		},
	};
	return generic;
};
