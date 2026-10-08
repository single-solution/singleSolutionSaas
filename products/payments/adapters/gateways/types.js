/**
 * The common gateway adapter interface (PLAN 0.8.7; the shape of the old kit payments interface `createPayment`,
 * `refund`, `status`, `verifyWebhook`, reshaped for redirect gateways). Every adapter sends the payer to the gateway's
 * own page or form, so card details never reach Payments, and reports what the gateway confirmed only after checking
 * its signature or asking the gateway server to server. Calls go through the outbound `send` (`@ss/net`).
 * @module
 */
import { isNetError } from '@ss/net';
import { GATEWAY_TIMEOUT_MS, jsonOf } from '../util.js';

/** @typedef {import('../util.js').OutboundSend} OutboundSend */
/** @typedef {{ send: OutboundSend, now: () => number }} GatewayContext */
/** @typedef {Record<string, any>} Keys the gateway's connection value (decrypted; never logged or returned) */
/**
 * What an adapter knows of a payment.
 * @typedef {{ id: string, websiteId: string, amount: number, currency: string, description: string, reference: string,
 *   customer: import('../../core/payments.js').Customer, gatewayRef?: string | null, captureRef?: string | null }} PaymentLike
 */
/** @typedef {{ id: string, plan: string, customer: import('../../core/payments.js').Customer, gatewayRef?: string | null }} SubscriptionLike */
/** @typedef {{ return: string, cancel: string, notify: string }} Urls the payer's return and cancel addresses and the notice address */
/**
 * How the payer goes on to the gateway: a redirect, or a form the payer's browser posts (fields in their order).
 * @typedef {{ kind: 'redirect', url: string, ref: string } | { kind: 'form', action: string, fields: Array<[string, string]>, ref: string }
 *   | { kind: 'error', message: string }} Started
 */
/**
 * What a gateway confirmed about a payment.
 * @typedef {{ kind: 'payment', paymentId: string | null, ref?: string | null, outcome: 'paid' | 'failed' | 'cancelled' | 'pending',
 *   amount?: number, currency?: string, capture?: string | null }} PaymentNews
 */
/** @typedef {{ kind: 'subscription', subscriptionId: string | null, ref: string, status: string | null }} SubscriptionNews */
/** @typedef {PaymentNews | SubscriptionNews} News */
/**
 * A request the gateway (or the payer coming back) sent; `self`: the address it came to, without the query.
 * @typedef {{ rawBody: string, headers: Headers, query: Record<string, string>, self?: string }} Incoming
 */
/** @typedef {{ ok: true, ref: string, manual?: false } | { ok: true, manual: true } | { ok: false, message: string }} Refunded */

/**
 * @typedef {object} GatewayAdapter
 * @property {string} id
 * @property {(keys: unknown) => string | null} violation why a connection value is not usable, or null
 * @property {(keys: Keys, ctx: GatewayContext) => Promise<{ ok: boolean, message?: string }>} test read-only check of the keys
 * @property {(input: { payment: PaymentLike, keys: Keys, urls: Urls }, ctx: GatewayContext) => Promise<Started>} start
 * @property {(incoming: Incoming, keys: Keys, ctx: GatewayContext) => Promise<{ ok: true, news: News[] } | { ok: false }>} [notice]
 *   a signed notice the gateway sent server to server
 * @property {(incoming: Incoming, payment: PaymentLike, keys: Keys, ctx: GatewayContext) => Promise<{ news: PaymentNews | null, next?: Started }>} [returned]
 *   the payer came back from the gateway: what the gateway confirms (signed, or asked server to server)
 * @property {(payment: PaymentLike, keys: Keys, ctx: GatewayContext) => Promise<PaymentNews | null>} [status] ask the gateway
 * @property {(input: { payment: PaymentLike, amount: number, reason: string, refundId: string }, keys: Keys, ctx: GatewayContext) => Promise<Refunded>} refund
 * @property {(input: { subscription: SubscriptionLike, keys: Keys, urls: Urls }, ctx: GatewayContext) => Promise<Started>} [subscribe]
 * @property {(subscription: SubscriptionLike, keys: Keys, ctx: GatewayContext) => Promise<SubscriptionNews | null>} [subscriptionStatus]
 * @property {(subscription: SubscriptionLike, keys: Keys, ctx: GatewayContext) => Promise<{ ok: boolean, message?: string }>} [cancelSubscription]
 */

/**
 * One gateway call: the status and JSON answer; status 0 when the gateway could not be reached.
 * @param {GatewayContext} ctx
 * @param {string} url
 * @param {import('@ss/net').SafeFetchInit} init
 * @returns {Promise<{ status: number, json: any, text: string }>}
 */
export const call = async (ctx, url, init) => {
	try {
		const response = await ctx.send(url, { timeoutMs: GATEWAY_TIMEOUT_MS, redirect: 'error', ...init });
		return { status: response.status, json: jsonOf(response), text: response.body.toString('utf8') };
	} catch (error) {
		if (!isNetError(error)) throw error;
		return { status: 0, json: null, text: '' };
	}
};

/**
 * The message for a failed gateway call.
 * @param {string} name the gateway's name
 * @param {number} status
 */
export const failure = (name, status) =>
	status === 0
		? `${name} could not be reached.`
		: status === 401 || status === 403
			? `${name} refused the keys.`
			: `${name} answered HTTP ${status}.`;

/** @param {unknown} value */
export const ok2xx = (value) => typeof value === 'number' && value >= 200 && value < 300;
