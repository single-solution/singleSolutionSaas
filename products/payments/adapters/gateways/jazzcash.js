/**
 * JazzCash (PLAN 0.8.7), with the merchant's own account: hosted checkout by page redirection (version 1.1). The
 * payer's browser posts the signed request form to JazzCash's page; JazzCash posts the signed answer back to the return
 * address. Both carry `pp_SecureHash`: HMAC-SHA256 with the integrity salt over the salt and the values of every
 * non-empty `pp…` field sorted by name, joined by `&`, in capitals. Payments trusts only an answer whose hash matches,
 * whose reference is the payment's and whose amount is the payment's. Refunds are recorded by hand (the merchant
 * returns the money in the JazzCash portal).
 *
 * Connection `jazzcash`: `{ merchantId, password, integritySalt, sandbox? }`.
 * @module
 */
import { createHmac } from 'node:crypto';
import { formFields, isObject, same } from '../util.js';

/** @typedef {import('./types.js').GatewayAdapter} GatewayAdapter */

const JAZZCASH_LIVE = 'https://payments.jazzcash.com.pk';
const JAZZCASH_SANDBOX = 'https://sandbox.jazzcash.com.pk';
const FORM_PATH = '/CustomerPortal/transactionmanagement/merchantform/';
/** JazzCash takes times in Pakistan time (UTC+5, no daylight saving). */
const PKT_OFFSET_MS = 5 * 3_600_000;

/**
 * `yyyyMMddHHmmss` in Pakistan time.
 * @param {number} at epoch ms
 */
export const pakistanTime = (at) => new Date(at + PKT_OFFSET_MS).toISOString().replace(/[-:T]/g, '').slice(0, 14);

/**
 * The 20-character transaction reference of a payment (letters and digits).
 * @param {string} paymentId
 * @param {string} prefix
 */
export const shortRef = (paymentId, prefix) => `${prefix}${paymentId.replace(/^[a-z]+_/, '').slice(0, 19)}`;

/**
 * `pp_SecureHash` of fields.
 * @param {Record<string, string>} fields
 * @param {string} salt
 */
export const secureHash = (fields, salt) => {
	const values = Object.keys(fields)
		.filter((name) => name.toLowerCase().startsWith('pp') && name !== 'pp_SecureHash' && fields[name] !== '')
		.sort()
		.map((name) => fields[name]);
	return createHmac('sha256', salt)
		.update([salt, ...values].join('&'))
		.digest('hex')
		.toUpperCase();
};

/** @param {string} text @param {number} max */
const plain = (text, max) =>
	text
		.replace(/[^A-Za-z0-9 ]+/g, ' ')
		.trim()
		.slice(0, max);

/** @type {GatewayAdapter} */
export const jazzcash = {
	id: 'jazzcash',
	violation: (keys) => {
		if (!isObject(keys)) return 'Fill in the merchant id, the password and the integrity salt.';
		for (const name of ['merchantId', 'password', 'integritySalt'])
			if (typeof keys[name] !== 'string' || keys[name].trim() === '') return `Fill in: ${name}.`;
		if (keys.sandbox !== undefined && typeof keys.sandbox !== 'boolean') return 'sandbox is true or false.';
		return null;
	},
	// JazzCash has no read-only call for the keys: they are checked for their shape, and on the first payment
	test: async (keys) => {
		const problem = jazzcash.violation(keys);
		return problem ? { ok: false, message: problem } : { ok: true };
	},
	start: async ({ payment, keys, urls }, ctx) => {
		const ref = shortRef(payment.id, 'T');
		/** @type {Record<string, string>} */
		const fields = {
			pp_Version: '1.1',
			pp_TxnType: '',
			pp_Language: 'EN',
			pp_MerchantID: String(keys.merchantId),
			pp_SubMerchantID: '',
			pp_Password: String(keys.password),
			pp_BankID: '',
			pp_ProductID: '',
			pp_TxnRefNo: ref,
			pp_Amount: String(payment.amount),
			pp_TxnCurrency: payment.currency,
			pp_TxnDateTime: pakistanTime(ctx.now()),
			pp_BillReference: plain(payment.reference, 20).replace(/ /g, '') || 'payment',
			pp_Description: plain(payment.description || payment.reference, 100) || 'Payment',
			pp_TxnExpiryDateTime: pakistanTime(ctx.now() + 24 * 3_600_000),
			pp_ReturnURL: urls.return,
		};
		fields.pp_SecureHash = secureHash(fields, String(keys.integritySalt));
		return {
			kind: 'form',
			action: `${keys.sandbox === true ? JAZZCASH_SANDBOX : JAZZCASH_LIVE}${FORM_PATH}`,
			fields: Object.entries(fields),
			ref,
		};
	},
	returned: async (incoming, payment, keys) => {
		const data = Object.fromEntries(formFields(incoming.rawBody));
		const given = data.pp_SecureHash ?? '';
		if (!given || !same(given.toUpperCase(), secureHash(data, String(keys.integritySalt)))) return { news: null };
		if (data.pp_TxnRefNo !== payment.gatewayRef) return { news: null };
		const code = data.pp_ResponseCode;
		return {
			news: {
				kind: 'payment',
				paymentId: payment.id,
				ref: data.pp_TxnRefNo,
				outcome: code === '000' ? 'paid' : code === '124' || code === '157' ? 'pending' : 'failed',
				amount: Number(data.pp_Amount),
				currency: data.pp_TxnCurrency || payment.currency,
				capture: data.pp_RetreivalReferenceNo || data.pp_TxnRefNo,
			},
		};
	},
	refund: async () => ({ ok: true, manual: true }),
};
