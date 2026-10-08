/**
 * PayFast (PLAN 0.8.7), with the merchant's own account: the payer's browser posts a signed form to PayFast's own page
 * (custom integration); PayFast confirms with an ITN (instant transaction notification) to the notice address, which
 * Payments checks three ways: the MD5 signature over the posted fields in their order (with the passphrase), the amount,
 * and PayFast's own validate endpoint (server to server). Refunds and the connection test use PayFast's API (headers
 * `merchant-id`, `version`, `timestamp` and an MD5 `signature` over the sorted fields with the passphrase).
 *
 * Connection `payfast`: `{ merchantId, merchantKey, passphrase, sandbox? }`.
 * @module
 */
import { createHash } from 'node:crypto';
import { fromDecimal, toDecimal } from '../../core/money.js';
import { formBody, formFields, isObject, phpUrlencode, same } from '../util.js';
import { call, failure, ok2xx } from './types.js';

/** @typedef {import('./types.js').GatewayAdapter} GatewayAdapter */

const PAYFAST_LIVE = 'https://www.payfast.co.za';
const PAYFAST_SANDBOX = 'https://sandbox.payfast.co.za';
const PAYFAST_API = 'https://api.payfast.co.za';

/** @param {Record<string, any>} keys */
const siteOf = (keys) => (keys.sandbox === true ? PAYFAST_SANDBOX : PAYFAST_LIVE);

/**
 * PayFast's form signature: the non-empty fields in their order as `name=urlencoded value` joined by `&`, then
 * `&passphrase=…` when there is one, MD5 in hex.
 * @param {Array<[string, string]>} fields
 * @param {string} passphrase
 */
export const formSignature = (fields, passphrase) => {
	const text = fields
		.filter(([name, value]) => name !== 'signature' && value !== '')
		.map(([name, value]) => `${name}=${phpUrlencode(value.trim())}`)
		.join('&');
	return createHash('md5')
		.update(passphrase ? `${text}&passphrase=${phpUrlencode(passphrase.trim())}` : text)
		.digest('hex');
};

/**
 * PayFast's API signature: every header field and body field plus the passphrase, sorted by name, as
 * `name=urlencoded value` joined by `&`, MD5 in hex.
 * @param {Record<string, string>} fields
 * @param {string} passphrase
 */
export const apiSignature = (fields, passphrase) => {
	/** @type {Record<string, string>} */
	const all = { ...fields, ...(passphrase ? { passphrase } : {}) };
	const text = Object.keys(all)
		.sort()
		.map((name) => `${name}=${phpUrlencode(String(all[name]))}`)
		.join('&');
	return createHash('md5').update(text).digest('hex');
};

/**
 * A call to PayFast's API.
 * @param {Record<string, any>} keys
 * @param {import('./types.js').GatewayContext} ctx
 * @param {string} method
 * @param {string} path
 * @param {Record<string, string>} [body]
 */
const api = (keys, ctx, method, path, body = {}) => {
	const head = {
		'merchant-id': String(keys.merchantId),
		version: 'v1',
		timestamp: new Date(ctx.now()).toISOString().replace(/\.\d{3}Z$/, '+00:00'),
	};
	return call(ctx, `${PAYFAST_API}${path}${keys.sandbox === true ? '?testing=true' : ''}`, {
		method,
		headers: {
			...head,
			signature: apiSignature({ ...head, ...body }, String(keys.passphrase ?? '')),
			...(method === 'GET' ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
		},
		...(method === 'GET' ? {} : { body: formBody(body) }),
	});
};

/** @type {GatewayAdapter} */
export const payfast = {
	id: 'payfast',
	violation: (keys) => {
		if (!isObject(keys)) return 'Fill in the merchant id, the merchant key and the passphrase.';
		if (typeof keys.merchantId !== 'string' || !/^\d{4,20}$/.test(keys.merchantId)) return 'The merchant id is a number.';
		if (typeof keys.merchantKey !== 'string' || !/^[A-Za-z0-9]{6,40}$/.test(keys.merchantKey))
			return 'Fill in the merchant key.';
		if (typeof keys.passphrase !== 'string' || keys.passphrase.trim().length < 8)
			return 'Fill in the passphrase set in your PayFast account (needed for the API).';
		if (keys.sandbox !== undefined && typeof keys.sandbox !== 'boolean') return 'sandbox is true or false.';
		return null;
	},
	test: async (keys, ctx) => {
		const answer = await api(keys, ctx, 'GET', '/ping');
		return ok2xx(answer.status) ? { ok: true } : { ok: false, message: failure('PayFast', answer.status) };
	},
	start: async ({ payment, keys, urls }) => {
		const [first = '', ...rest] = (payment.customer.name ?? '').split(' ');
		/** @type {Array<[string, string]>} */
		const fields = [
			['merchant_id', String(keys.merchantId)],
			['merchant_key', String(keys.merchantKey)],
			['return_url', urls.return],
			['cancel_url', urls.cancel],
			['notify_url', urls.notify],
			['name_first', first.slice(0, 100)],
			['name_last', rest.join(' ').slice(0, 100)],
			['email_address', payment.customer.email ?? ''],
			['m_payment_id', payment.id],
			['amount', toDecimal(payment.amount, payment.currency)],
			['item_name', (payment.description || payment.reference || payment.id).slice(0, 100)],
		];
		const filled = fields.filter(([, value]) => value !== '');
		filled.push(['signature', formSignature(filled, String(keys.passphrase ?? ''))]);
		return { kind: 'form', action: `${siteOf(keys)}/eng/process`, fields: filled, ref: payment.id };
	},
	notice: async (incoming, keys, ctx) => {
		const fields = formFields(incoming.rawBody);
		const data = Object.fromEntries(fields);
		const given = data.signature ?? '';
		const expected = formSignature(fields, String(keys.passphrase ?? ''));
		if (!given || !same(given, expected) || data.merchant_id !== keys.merchantId) return { ok: false };
		// PayFast confirms the ITN it sent: the same fields (without the signature) posted back to its validate endpoint
		const checked = await call(ctx, `${siteOf(keys)}/eng/query/validate`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: fields
				.filter(([name]) => name !== 'signature')
				.map(([name, value]) => `${name}=${phpUrlencode(value)}`)
				.join('&'),
		});
		if (!ok2xx(checked.status) || checked.text.trim() !== 'VALID') return { ok: false };
		const status = data.payment_status;
		return {
			ok: true,
			news: [
				{
					kind: 'payment',
					paymentId: data.m_payment_id ?? null,
					ref: data.m_payment_id ?? null,
					outcome:
						status === 'COMPLETE'
							? 'paid'
							: status === 'CANCELLED'
								? 'cancelled'
								: status === 'FAILED'
									? 'failed'
									: 'pending',
					amount: fromDecimal(data.amount_gross, 'ZAR') ?? undefined,
					currency: 'ZAR',
					capture: data.pf_payment_id ?? null,
				},
			],
		};
	},
	refund: async ({ payment, amount, reason }, keys, ctx) => {
		if (!payment.captureRef) return { ok: false, message: 'PayFast has not confirmed this payment.' };
		const answer = await api(keys, ctx, 'POST', `/refunds/${encodeURIComponent(payment.captureRef)}`, {
			amount: String(amount),
			reason: (reason || 'Refund').slice(0, 255),
			notify_buyer: '1',
		});
		return ok2xx(answer.status)
			? { ok: true, ref: payment.captureRef }
			: { ok: false, message: answer.json?.data?.message ?? failure('PayFast', answer.status) };
	},
};
