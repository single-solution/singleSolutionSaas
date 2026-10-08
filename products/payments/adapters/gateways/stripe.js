/**
 * Stripe (PLAN 0.8.7), with the merchant's own keys: payments on Stripe Checkout (a Checkout Session in `payment`
 * mode; the payer pays on Stripe's page), refunds through the Refunds API, and subscriptions as Checkout Sessions in
 * `subscription` mode on the merchant's own Stripe price. Confirmations are Stripe webhooks checked with the endpoint's
 * signing secret (`Stripe-Signature`, HMAC-SHA256 of `<t>.<body>`, 5 minutes), or the session asked server to server.
 *
 * Connection `stripe`: `{ secretKey: sk_… | rk_…, webhookSecret: whsec_… }`. API version pinned with `Stripe-Version`.
 * @module
 */
import { formBody, isObject, verifyTimestamped } from '../util.js';
import { call, failure, ok2xx } from './types.js';

/** @typedef {import('./types.js').GatewayAdapter} GatewayAdapter */
/** @typedef {import('./types.js').PaymentNews} PaymentNews */

export const STRIPE_API = 'https://api.stripe.com';
/** The Stripe API version every call names (the smallest safe choice, PLAN 0.8.4). */
export const STRIPE_VERSION = '2024-06-20';

/** @param {Record<string, any>} keys @param {string} [idempotencyKey] */
const headers = (keys, idempotencyKey) => ({
	authorization: `Bearer ${keys.secretKey}`,
	'content-type': 'application/x-www-form-urlencoded',
	'stripe-version': STRIPE_VERSION,
	...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
});

/**
 * What a Checkout Session in `payment` mode says about its payment.
 * @param {any} session
 * @returns {PaymentNews}
 */
const sessionNews = (session) => ({
	kind: 'payment',
	paymentId: typeof session.client_reference_id === 'string' ? session.client_reference_id : null,
	ref: String(session.id ?? ''),
	outcome: session.payment_status === 'paid' || session.payment_status === 'no_payment_required' ? 'paid' : 'pending',
	amount: Number(session.amount_total),
	currency: String(session.currency ?? '').toUpperCase(),
	capture: typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent?.id ?? null),
});

/** @type {GatewayAdapter} */
export const stripe = {
	id: 'stripe',
	violation: (keys) => {
		if (!isObject(keys)) return 'Fill in the secret key and the webhook signing secret.';
		if (typeof keys.secretKey !== 'string' || !/^(sk|rk)_(live|test)_[A-Za-z0-9]{8,}$/.test(keys.secretKey))
			return 'The secret key starts with sk_live_, sk_test_ or rk_….';
		if (typeof keys.webhookSecret !== 'string' || !/^whsec_[A-Za-z0-9+/=]{8,}$/.test(keys.webhookSecret))
			return 'The webhook signing secret starts with whsec_.';
		return null;
	},
	test: async (keys, ctx) => {
		const answer = await call(ctx, `${STRIPE_API}/v1/balance`, { method: 'GET', headers: headers(keys) });
		return ok2xx(answer.status) ? { ok: true } : { ok: false, message: failure('Stripe', answer.status) };
	},
	start: async ({ payment, keys, urls }, ctx) => {
		const answer = await call(ctx, `${STRIPE_API}/v1/checkout/sessions`, {
			method: 'POST',
			headers: headers(keys, `ss-${payment.id}`),
			body: formBody({
				mode: 'payment',
				client_reference_id: payment.id,
				success_url: urls.return,
				cancel_url: urls.cancel,
				'line_items[0][quantity]': 1,
				'line_items[0][price_data][currency]': payment.currency.toLowerCase(),
				'line_items[0][price_data][unit_amount]': payment.amount,
				'line_items[0][price_data][product_data][name]': payment.description || payment.reference || payment.id,
				'metadata[ss_payment]': payment.id,
				'metadata[ss_website]': payment.websiteId,
				'payment_intent_data[metadata][ss_payment]': payment.id,
				...(payment.customer.email ? { customer_email: payment.customer.email } : {}),
			}),
		});
		if (!ok2xx(answer.status) || typeof answer.json?.url !== 'string')
			return { kind: 'error', message: answer.json?.error?.message ?? failure('Stripe', answer.status) };
		return { kind: 'redirect', url: answer.json.url, ref: String(answer.json.id) };
	},
	notice: async (incoming, keys, ctx) => {
		const signed = verifyTimestamped({
			header: incoming.headers.get('stripe-signature'),
			body: incoming.rawBody,
			secret: String(keys.webhookSecret),
			now: ctx.now(),
		});
		if (!signed) return { ok: false };
		/** @type {any} */
		let event;
		try {
			event = JSON.parse(incoming.rawBody);
		} catch {
			return { ok: false };
		}
		const object = event?.data?.object ?? {};
		switch (event?.type) {
			case 'checkout.session.completed':
			case 'checkout.session.async_payment_succeeded':
			case 'checkout.session.async_payment_failed': {
				if (object.mode === 'subscription')
					return {
						ok: true,
						news: [
							{
								kind: 'subscription',
								subscriptionId: object.client_reference_id ?? null,
								ref: String(object.subscription ?? ''),
								status: object.status === 'complete' ? 'active' : null,
							},
						],
					};
				const news = sessionNews(object);
				if (event.type === 'checkout.session.async_payment_failed') news.outcome = 'failed';
				return { ok: true, news: [news] };
			}
			case 'customer.subscription.created':
			case 'customer.subscription.updated':
			case 'customer.subscription.deleted':
				return {
					ok: true,
					news: [
						{
							kind: 'subscription',
							subscriptionId: object.metadata?.ss_subscription ?? null,
							ref: String(object.id ?? ''),
							status: event.type === 'customer.subscription.deleted' ? 'canceled' : (object.status ?? null),
						},
					],
				};
			default:
				return { ok: true, news: [] };
		}
	},
	status: async (payment, keys, ctx) => {
		if (!payment.gatewayRef) return null;
		const answer = await call(ctx, `${STRIPE_API}/v1/checkout/sessions/${encodeURIComponent(payment.gatewayRef)}`, {
			method: 'GET',
			headers: headers(keys),
		});
		if (!ok2xx(answer.status) || !isObject(answer.json)) return null;
		const news = sessionNews(answer.json);
		if (answer.json.status === 'expired') news.outcome = 'cancelled';
		return news;
	},
	returned: async (_incoming, payment, keys, ctx) => ({ news: (await stripe.status?.(payment, keys, ctx)) ?? null }),
	refund: async ({ payment, amount, refundId }, keys, ctx) => {
		if (!payment.captureRef) return { ok: false, message: 'Stripe has not confirmed this payment.' };
		const answer = await call(ctx, `${STRIPE_API}/v1/refunds`, {
			method: 'POST',
			headers: headers(keys, refundId),
			body: formBody({ payment_intent: payment.captureRef, amount, 'metadata[ss_refund]': refundId }),
		});
		if (!ok2xx(answer.status) || answer.json?.status === 'failed' || answer.json?.status === 'canceled')
			return { ok: false, message: answer.json?.error?.message ?? failure('Stripe', answer.status) };
		return { ok: true, ref: String(answer.json?.id ?? '') };
	},
	subscribe: async ({ subscription, keys, urls }, ctx) => {
		const answer = await call(ctx, `${STRIPE_API}/v1/checkout/sessions`, {
			method: 'POST',
			headers: headers(keys, `ss-${subscription.id}`),
			body: formBody({
				mode: 'subscription',
				client_reference_id: subscription.id,
				success_url: urls.return,
				cancel_url: urls.cancel,
				'line_items[0][price]': subscription.plan,
				'line_items[0][quantity]': 1,
				'subscription_data[metadata][ss_subscription]': subscription.id,
				...(subscription.customer.email ? { customer_email: subscription.customer.email } : {}),
			}),
		});
		if (!ok2xx(answer.status) || typeof answer.json?.url !== 'string')
			return { kind: 'error', message: answer.json?.error?.message ?? failure('Stripe', answer.status) };
		return { kind: 'redirect', url: answer.json.url, ref: String(answer.json.id) };
	},
	subscriptionStatus: async (subscription, keys, ctx) => {
		const ref = subscription.gatewayRef ?? '';
		// before Stripe confirms, the reference is the Checkout Session; then the subscription itself
		const path = ref.startsWith('cs_')
			? `/v1/checkout/sessions/${encodeURIComponent(ref)}?expand[]=subscription`
			: `/v1/subscriptions/${encodeURIComponent(ref)}`;
		if (!ref) return null;
		const answer = await call(ctx, `${STRIPE_API}${path}`, { method: 'GET', headers: headers(keys) });
		if (!ok2xx(answer.status) || !isObject(answer.json)) return null;
		const sub = ref.startsWith('cs_') ? answer.json.subscription : answer.json;
		if (!isObject(sub)) return null;
		return { kind: 'subscription', subscriptionId: subscription.id, ref: String(sub.id), status: sub.status ?? null };
	},
	cancelSubscription: async (subscription, keys, ctx) => {
		if (!subscription.gatewayRef?.startsWith('sub_')) return { ok: false, message: 'Stripe has not started it yet.' };
		const answer = await call(ctx, `${STRIPE_API}/v1/subscriptions/${encodeURIComponent(subscription.gatewayRef)}`, {
			method: 'DELETE',
			headers: headers(keys),
		});
		return ok2xx(answer.status) ? { ok: true } : { ok: false, message: failure('Stripe', answer.status) };
	},
};
