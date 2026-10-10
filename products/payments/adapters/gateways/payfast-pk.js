/**
 * PayFast Pakistan (PLAN 0.8.7; APPS' gopayfast on `apps.net.pk`, not PayFast South Africa), with the merchant's own
 * account: hosted checkout by redirection. Payments first asks PayFast for an access token for the payment's basket id
 * and amount (`GetAccessToken`, server to server, with the merchant id and secured key); the payer's browser then posts
 * the payment form with that token to PayFast's own page (`PostTransaction`). PayFast sends the payer back to the return
 * address (success and failure alike) and calls the notice address (`CHECKOUT_URL`) server to server. Both carry
 * `validation_hash`: SHA-256 in hex of `basket_id|secured_key|merchant_id|err_code`. Payments trusts only an answer
 * whose hash matches and whose basket id is the payment's id; `000` (or `00`) is paid for the `transaction_amount`
 * PayFast reports, `001` is pending, any other code failed. PayFast's hosted checkout has no refund call, so refunds are
 * recorded by hand (the merchant returns the money in the PayFast merchant portal).
 *
 * Connection `payfast_pk`: `{ merchantId, securedKey, merchantName, sandbox? }`.
 * @module
 */
import { createHash } from 'node:crypto';
import { isId } from '@ss/contracts';
import { fromDecimal, toDecimal } from '../../core/money.js';
import { formBody, formFields, isObject, same } from '../util.js';
import { localMobile } from './easypaisa.js';
import { pakistanTime } from './jazzcash.js';
import { call, failure, ok2xx } from './types.js';

/** @typedef {import('./types.js').GatewayAdapter} GatewayAdapter */
/** @typedef {import('./types.js').PaymentNews} PaymentNews */

const PAYFAST_PK_LIVE = 'https://ipg1.apps.net.pk';
const PAYFAST_PK_SANDBOX = 'https://ipguat.apps.net.pk';
const TRANSACTION_PATH = '/Ecommerce/api/Transaction';
/** The gateway's name in messages. */
const NAME = 'PayFast (Pakistan)';
/** `err_code` of a paid transaction, and of one still pending. */
const PAID_CODES = new Set(['000', '00']);
const PENDING_CODES = new Set(['001']);

/** @param {Record<string, any>} keys */
const hostOf = (keys) => (keys.sandbox === true ? PAYFAST_PK_SANDBOX : PAYFAST_PK_LIVE);

/**
 * PayFast's amount text: the decimal amount, without `.00` for whole amounts (`150000` PKR → `1500`, `150050` →
 * `1500.50`).
 * @param {number} amount minor units
 * @param {string} currency
 */
export const payfastAmount = (amount, currency) => toDecimal(amount, currency).replace(/\.0+$/, '');

/**
 * `validation_hash` of an answer: SHA-256 in hex of `basket_id|secured_key|merchant_id|err_code`.
 * @param {string} basketId
 * @param {string} errCode
 * @param {Record<string, any>} keys
 */
export const validationHash = (basketId, errCode, keys) =>
	createHash('sha256').update(`${basketId}|${keys.securedKey}|${keys.merchantId}|${errCode}`).digest('hex');

/**
 * Ask PayFast for an access token for one basket and amount.
 * @param {Record<string, any>} keys
 * @param {import('./types.js').GatewayContext} ctx
 * @param {{ basketId: string, amount: string, currency: string }} input
 * @returns {Promise<{ ok: true, token: string } | { ok: false, message: string }>}
 */
const accessToken = async (keys, ctx, { basketId, amount, currency }) => {
	const answer = await call(ctx, `${hostOf(keys)}${TRANSACTION_PATH}/GetAccessToken`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: formBody({
			MERCHANT_ID: String(keys.merchantId),
			SECURED_KEY: String(keys.securedKey),
			BASKET_ID: basketId,
			TXNAMT: amount,
			CURRENCY_CODE: currency,
		}),
	});
	const token = answer.json?.ACCESS_TOKEN;
	if (ok2xx(answer.status) && typeof token === 'string' && token.trim() !== '') return { ok: true, token: token.trim() };
	return {
		ok: false,
		message: ok2xx(answer.status)
			? `${NAME} gave no access token: check the merchant id and the secured key.`
			: failure(NAME, answer.status),
	};
};

/**
 * The answer's fields (query and form body), with lower-case names: PayFast mixes `basket_id` and `PaymentName`.
 * @param {import('./types.js').Incoming} incoming
 * @returns {Record<string, string>}
 */
const answerOf = (incoming) =>
	Object.fromEntries(
		[...Object.entries(incoming.query), ...formFields(incoming.rawBody)].map(([name, value]) => [name.toLowerCase(), value]),
	);

/**
 * What a signed answer confirms, or null when its hash does not match.
 * @param {Record<string, string>} data
 * @param {Record<string, any>} keys
 * @returns {PaymentNews | null}
 */
const confirmation = (data, keys) => {
	const basket = data.basket_id ?? '';
	const code = data.err_code ?? '';
	const given = (data.validation_hash ?? '').toLowerCase();
	if (!basket || !given || !same(given, validationHash(basket, code, keys))) return null;
	const currency = !data.transaction_currency || data.transaction_currency === '586' ? 'PKR' : data.transaction_currency;
	const amount = fromDecimal(data.transaction_amount, currency);
	return {
		kind: 'payment',
		paymentId: isId(basket, 'pay') ? basket : null,
		ref: basket,
		outcome: PAID_CODES.has(code) ? 'paid' : PENDING_CODES.has(code) ? 'pending' : 'failed',
		...(amount === null ? {} : { amount }),
		currency,
		capture: data.transaction_id || null,
	};
};

/** @type {GatewayAdapter} */
export const payfastPk = {
	id: 'payfast_pk',
	violation: (keys) => {
		if (!isObject(keys)) return 'Fill in the merchant id, the secured key and the merchant name.';
		if (typeof keys.merchantId !== 'string' || !/^\d{1,20}$/.test(keys.merchantId)) return 'The merchant id is a number.';
		if (typeof keys.securedKey !== 'string' || keys.securedKey.trim() === '' || /\s/.test(keys.securedKey))
			return 'Fill in the secured key.';
		if (typeof keys.merchantName !== 'string' || keys.merchantName.trim() === '' || keys.merchantName.length > 100)
			return 'Fill in the merchant name registered with PayFast (at most 100 characters).';
		if (keys.sandbox !== undefined && typeof keys.sandbox !== 'boolean') return 'sandbox is true or false.';
		return null;
	},
	// the keys are tested by asking for an access token (no payment is made with it)
	test: async (keys, ctx) => {
		const answer = await accessToken(keys, ctx, {
			basketId: `SS-TEST-${Math.floor(ctx.now() / 1000)}`,
			amount: '1',
			currency: 'PKR',
		});
		return answer.ok ? { ok: true } : { ok: false, message: answer.message };
	},
	start: async ({ payment, keys, urls }, ctx) => {
		const amount = payfastAmount(payment.amount, payment.currency);
		const token = await accessToken(keys, ctx, { basketId: payment.id, amount, currency: payment.currency });
		if (!token.ok) return { kind: 'error', message: token.message };
		const name = String(keys.merchantName).trim();
		const at = pakistanTime(ctx.now());
		/** @type {Array<[string, string]>} */
		const fields = [
			['CURRENCY_CODE', payment.currency],
			['MERCHANT_ID', String(keys.merchantId)],
			['MERCHANT_NAME', name],
			['TOKEN', token.token],
			['BASKET_ID', payment.id],
			['TXNAMT', amount],
			[
				'ORDER_DATE',
				`${at.slice(0, 4)}-${at.slice(4, 6)}-${at.slice(6, 8)} ${at.slice(8, 10)}:${at.slice(10, 12)}:${at.slice(12)}`,
			],
			['SUCCESS_URL', urls.return],
			['FAILURE_URL', urls.return],
			['CHECKOUT_URL', urls.notify],
			['CUSTOMER_EMAIL_ADDRESS', payment.customer.email ?? ''],
			['CUSTOMER_MOBILE_NO', localMobile(payment.customer.phone)],
			['SIGNATURE', createHash('md5').update(`${keys.merchantId}:${name}:${amount}:${payment.id}`).digest('hex')],
			['VERSION', 'MERCHANTCART-0.1'],
			['TXNDESC', (payment.description || payment.reference || 'Payment').slice(0, 100)],
			['PROCCODE', '00'],
			['TRAN_TYPE', 'ECOMM_PURCHASE'],
		];
		return {
			kind: 'form',
			action: `${hostOf(keys)}${TRANSACTION_PATH}/PostTransaction`,
			fields: fields.filter(([, value]) => value !== ''),
			ref: payment.id,
		};
	},
	returned: async (incoming, payment, keys) => {
		const news = confirmation(answerOf(incoming), keys);
		return { news: news && news.paymentId === payment.id ? news : null };
	},
	notice: async (incoming, keys) => {
		const news = confirmation(answerOf(incoming), keys);
		return news ? { ok: true, news: [news] } : { ok: false };
	},
	refund: async () => ({ ok: true, manual: true }),
};
