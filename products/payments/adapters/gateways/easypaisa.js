/**
 * Easypaisa (PLAN 0.8.7), with the merchant's own Easypay store: hosted checkout in two steps. The payer's browser
 * posts the request (with `merchantHashedReq`: AES-128-ECB with the store's hash key over the sorted fields, base64)
 * to Easypay's page; Easypay sends the browser back with an `auth_token`, which the browser posts to Easypay's confirm
 * page; Easypay then sends it back once more. Payments never trusts that last visit: it asks Easypay's
 * inquire-transaction API (server to server, with the store's API credentials) and takes only `PAID` for the
 * payment's amount. Refunds are recorded by hand (the merchant returns the money in the Easypay portal).
 *
 * Connection `easypaisa`: `{ storeId, hashKey, username, password, accountNum, sandbox? }`.
 * @module
 */
import { createCipheriv } from 'node:crypto';
import { fromDecimal, toDecimal } from '../../core/money.js';
import { formFields, isObject } from '../util.js';
import { pakistanTime, shortRef } from './jazzcash.js';
import { call, ok2xx } from './types.js';

/** @typedef {import('./types.js').GatewayAdapter} GatewayAdapter */

const EASYPAY_LIVE = 'https://easypay.easypaisa.com.pk';
const EASYPAY_SANDBOX = 'https://easypaystg.easypaisa.com.pk';

/** @param {Record<string, any>} keys */
const hostOf = (keys) => (keys.sandbox === true ? EASYPAY_SANDBOX : EASYPAY_LIVE);

/**
 * `merchantHashedReq`: the fields sorted by name as `name=value` joined by `&`, AES-128-ECB (PKCS#5) with the hash key,
 * base64.
 * @param {Record<string, string>} fields
 * @param {string} hashKey 16 characters
 */
export const hashedRequest = (fields, hashKey) => {
	const text = Object.keys(fields)
		.sort()
		.map((name) => `${name}=${fields[name]}`)
		.join('&');
	const cipher = createCipheriv('aes-128-ecb', Buffer.from(hashKey, 'utf8'), null);
	return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('base64');
};

/**
 * Easypay's local mobile number format (`03…`) of an international Pakistani number, or ''.
 * @param {string | undefined} phone
 */
const localMobile = (phone) => (phone && /^\+923\d{9}$/.test(phone) ? `0${phone.slice(3)}` : '');

/** @type {GatewayAdapter} */
export const easypaisa = {
	id: 'easypaisa',
	violation: (keys) => {
		if (!isObject(keys)) return 'Fill in the store id, the hash key and the API credentials.';
		if (typeof keys.storeId !== 'string' || !/^\d{1,12}$/.test(keys.storeId)) return 'The store id is a number.';
		if (typeof keys.hashKey !== 'string' || keys.hashKey.length !== 16) return 'The hash key has 16 characters.';
		for (const name of ['username', 'password', 'accountNum'])
			if (typeof keys[name] !== 'string' || keys[name].trim() === '') return `Fill in: ${name}.`;
		if (keys.sandbox !== undefined && typeof keys.sandbox !== 'boolean') return 'sandbox is true or false.';
		return null;
	},
	// Easypay has no read-only call for the keys: they are checked for their shape, and on the first payment
	test: async (keys) => {
		const problem = easypaisa.violation(keys);
		return problem ? { ok: false, message: problem } : { ok: true };
	},
	start: async ({ payment, keys, urls }, ctx) => {
		const ref = shortRef(payment.id, 'E');
		const expiry = pakistanTime(ctx.now() + 24 * 3_600_000);
		/** @type {Record<string, string>} */
		const fields = {
			amount: toDecimal(payment.amount, payment.currency),
			autoRedirect: '1',
			expiryDate: `${expiry.slice(0, 8)} ${expiry.slice(8)}`,
			orderRefNum: ref,
			postBackURL: urls.return,
			storeId: String(keys.storeId),
		};
		if (payment.customer.email) fields.emailAddr = payment.customer.email;
		const mobile = localMobile(payment.customer.phone);
		if (mobile) fields.mobileNum = mobile;
		return {
			kind: 'form',
			action: `${hostOf(keys)}/easypay/Index.jsf`,
			fields: [...Object.entries(fields), ['merchantHashedReq', hashedRequest(fields, String(keys.hashKey))]],
			ref,
		};
	},
	returned: async (incoming, payment, keys, ctx) => {
		const data = Object.fromEntries([...formFields(incoming.rawBody), ...Object.entries(incoming.query)]);
		// first visit: Easypay hands over a token, which the browser posts to Easypay's confirm page
		if (typeof data.auth_token === 'string' && data.auth_token !== '')
			return {
				news: null,
				next: {
					kind: 'form',
					action: `${hostOf(keys)}/easypay/Confirm.jsf`,
					fields: [
						['auth_token', data.auth_token],
						['postBackURL', incoming.self ?? ''],
					],
					ref: String(payment.gatewayRef),
				},
			};
		return { news: (await easypaisa.status?.(payment, keys, ctx)) ?? null };
	},
	status: async (payment, keys, ctx) => {
		if (!payment.gatewayRef) return null;
		const answer = await call(ctx, `${hostOf(keys)}/easypay-service/rest/v4/inquire-transaction`, {
			method: 'POST',
			headers: {
				credentials: Buffer.from(`${keys.username}:${keys.password}`).toString('base64'),
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				orderId: payment.gatewayRef,
				storeId: String(keys.storeId),
				accountNum: String(keys.accountNum),
			}),
		});
		if (!ok2xx(answer.status) || answer.json?.responseCode !== '0000') return null;
		const status = String(answer.json.transactionStatus ?? '').toUpperCase();
		return {
			kind: 'payment',
			paymentId: payment.id,
			ref: payment.gatewayRef,
			outcome: status === 'PAID' ? 'paid' : status === 'FAILED' || status === 'REVERSED' ? 'failed' : 'pending',
			amount: fromDecimal(answer.json.transactionAmount, payment.currency) ?? undefined,
			currency: payment.currency,
			capture: typeof answer.json.transactionId === 'string' ? answer.json.transactionId : payment.gatewayRef,
		};
	},
	refund: async () => ({ ok: true, manual: true }),
};
