/**
 * PayPal (PLAN 0.8.7), with the merchant's own REST app: payments through the Orders API v2 (the payer approves on
 * PayPal's page, then Payments captures the order server to server), refunds of the capture, and subscriptions on the
 * merchant's own PayPal plan (Subscriptions API v1). Confirmations are the capture answer, the order or subscription
 * asked server to server, and webhooks whose signature PayPal itself verifies (`verify-webhook-signature` with the
 * merchant's webhook id).
 *
 * Connection `paypal`: `{ clientId, secret, webhookId, sandbox? }` (`sandbox`: the merchant's PayPal sandbox app).
 * @module
 */
import { fromDecimal, toDecimal } from '@ss/contracts/format';
import { isObject } from '@ss/contracts/util';
import { sha256Hex } from '@ss/protocol';
import { formBody } from '../util.js';
import { call, failure, ok2xx } from './types.js';

/** @typedef {import('./types.js').GatewayAdapter} GatewayAdapter */
/** @typedef {import('./types.js').GatewayContext} GatewayContext */
/** @typedef {import('./types.js').PaymentNews} PaymentNews */

const PAYPAL_LIVE = 'https://api-m.paypal.com';
const PAYPAL_SANDBOX = 'https://api-m.sandbox.paypal.com';

/** @param {Record<string, any>} keys */
const apiOf = (keys) => (keys.sandbox === true ? PAYPAL_SANDBOX : PAYPAL_LIVE);

/** PayPal's sign-in tokens, kept in memory until shortly before they expire (SR-3-2): by PayPal host, client id and secret. */
const tokens = new Map();
/** A kept token is dropped this long before PayPal says it ends. */
const TOKEN_MARGIN_MS = 60_000;
/** At most this many tokens are kept (one per connected app); the oldest goes first. */
const TOKENS_MAX = 500;

/** Forget every kept token (tests). */
export const forgetTokens = () => tokens.clear();

/** @param {Record<string, any>} keys */
const tokenKey = (keys) => `${apiOf(keys)}|${keys.clientId}|${sha256Hex(String(keys.secret))}`;

/**
 * A new access token for the merchant's app (client credentials, always asked of PayPal): `expiresIn` seconds.
 * @param {Record<string, any>} keys
 * @param {GatewayContext} ctx
 */
const signIn = async (keys, ctx) => {
	const answer = await call(ctx, `${apiOf(keys)}/v1/oauth2/token`, {
		method: 'POST',
		headers: {
			authorization: `Basic ${Buffer.from(`${keys.clientId}:${keys.secret}`).toString('base64')}`,
			'content-type': 'application/x-www-form-urlencoded',
		},
		body: formBody({ grant_type: 'client_credentials' }),
	});
	return ok2xx(answer.status) && typeof answer.json?.access_token === 'string'
		? { ok: true, token: /** @type {string} */ (answer.json.access_token), expiresIn: Number(answer.json.expires_in) }
		: { ok: false, status: answer.status };
};

/**
 * An access token for the merchant's app, or not ok. One is kept for each app until shortly before it expires, so a
 * flood of notices does not become a flood of sign-ins at PayPal (SR-3-2); `fresh` asks PayPal again.
 * @param {Record<string, any>} keys
 * @param {GatewayContext} ctx
 * @param {boolean} [fresh]
 * @returns {Promise<{ ok: true, token: string, kept: boolean } | { ok: false, status: number }>}
 */
const tokenOf = async (keys, ctx, fresh = false) => {
	const key = tokenKey(keys);
	const kept = tokens.get(key);
	if (!fresh && kept && ctx.now() < kept.until) return { ok: true, token: kept.token, kept: true };
	tokens.delete(key);
	const made = await signIn(keys, ctx);
	if (!made.ok) return made;
	if (Number.isFinite(made.expiresIn) && made.expiresIn * 1000 > TOKEN_MARGIN_MS) {
		if (tokens.size >= TOKENS_MAX) tokens.delete(tokens.keys().next().value);
		tokens.set(key, { token: made.token, until: ctx.now() + made.expiresIn * 1000 - TOKEN_MARGIN_MS });
	}
	return { ok: true, token: made.token, kept: false };
};

/**
 * A JSON call with an access token (a kept one; when PayPal refuses it, one new sign-in and one more try).
 * @param {Record<string, any>} keys
 * @param {GatewayContext} ctx
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @param {string} [requestId] PayPal-Request-Id (idempotency)
 */
const api = async (keys, ctx, method, path, body, requestId) => {
	/** @param {string} token */
	const send = (token) =>
		call(ctx, `${apiOf(keys)}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
				...(requestId ? { 'paypal-request-id': requestId } : {}),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const token = await tokenOf(keys, ctx);
	if (!token.ok) return { status: token.status, json: null, text: '' };
	const answer = await send(token.token);
	if (answer.status !== 401 || !token.kept) return answer;
	const again = await tokenOf(keys, ctx, true);
	return again.ok ? send(again.token) : answer;
};

/** @param {any} links @param {string[]} rels */
const linkOf = (links, rels) =>
	(Array.isArray(links) ? links : []).find((link) => rels.includes(link?.rel) && typeof link?.href === 'string')?.href;

/**
 * What an order (after capture) says about its payment.
 * @param {any} order
 * @param {string} paymentId
 * @returns {PaymentNews}
 */
const orderNews = (order, paymentId) => {
	const unit = order?.purchase_units?.[0] ?? {};
	const capture = unit?.payments?.captures?.[0];
	const currency = String(capture?.amount?.currency_code ?? unit?.amount?.currency_code ?? '');
	const value = capture?.amount?.value ?? unit?.amount?.value;
	const outcome =
		capture?.status === 'COMPLETED'
			? 'paid'
			: capture?.status === 'DECLINED' || capture?.status === 'FAILED'
				? 'failed'
				: order?.status === 'VOIDED'
					? 'canceled'
					: 'pending';
	return {
		kind: 'payment',
		paymentId,
		ref: String(order?.id ?? ''),
		outcome,
		amount: fromDecimal(value, currency) ?? undefined,
		currency,
		capture: typeof capture?.id === 'string' ? capture.id : null,
	};
};

/** The headers PayPal signs a notice with. */
const NOTICE_HEADERS = [
	'paypal-auth-algo',
	'paypal-cert-url',
	'paypal-transmission-id',
	'paypal-transmission-sig',
	'paypal-transmission-time',
];

/**
 * Whether a notice's certificate address is https on PayPal's own `paypal.com` hosts, without a sign-in part or a port.
 * @param {string} text
 */
const paypalCertUrl = (text) => {
	try {
		const url = new URL(text);
		return (
			url.protocol === 'https:' &&
			url.username === '' &&
			url.password === '' &&
			url.port === '' &&
			(url.hostname === 'paypal.com' || url.hostname.endsWith('.paypal.com'))
		);
	} catch {
		return false;
	}
};

/** @type {GatewayAdapter} */
export const paypal = {
	id: 'paypal',
	addresses: ['notice'],
	violation: (keys) => {
		if (!isObject(keys)) return 'Enter the client id, the secret and the webhook id.';
		for (const name of ['clientId', 'secret', 'webhookId'])
			if (typeof keys[name] !== 'string' || keys[name].trim() === '') return `Missing: ${name}.`;
		if (keys.sandbox !== undefined && typeof keys.sandbox !== 'boolean') return 'sandbox is true or false.';
		return null;
	},
	// the keys are tested with a new sign-in, never a kept token
	test: async (keys, ctx) => {
		const token = await signIn(keys, ctx);
		return token.ok ? { ok: true } : { ok: false, message: failure('PayPal', Number(token.status)) };
	},
	start: async ({ payment, urls, keys }, ctx) => {
		const answer = await api(
			keys,
			ctx,
			'POST',
			'/v2/checkout/orders',
			{
				intent: 'CAPTURE',
				purchase_units: [
					{
						reference_id: payment.id,
						custom_id: payment.id,
						...(payment.description ? { description: payment.description.slice(0, 127) } : {}),
						amount: { currency_code: payment.currency, value: toDecimal(payment.amount, payment.currency) },
					},
				],
				payment_source: {
					paypal: {
						experience_context: {
							return_url: urls.return,
							cancel_url: urls.cancel,
							user_action: 'PAY_NOW',
							shipping_preference: 'NO_SHIPPING',
						},
					},
				},
			},
			`ss-${payment.id}`,
		);
		const url = linkOf(answer.json?.links, ['payer-action', 'approve']);
		if (!ok2xx(answer.status) || !url) return { kind: 'error', message: failure('PayPal', answer.status) };
		return { kind: 'redirect', url, ref: String(answer.json.id) };
	},
	// the payer approved on PayPal's page: capture the order (server to server); an order captured before is read back.
	// The order of a payment the merchant canceled is never captured, so PayPal takes no money for it.
	returned: async (_incoming, payment, keys, ctx) => ({ news: (await paypal.status?.(payment, keys, ctx)) ?? null }),
	status: async (payment, keys, ctx) => {
		if (!payment.gatewayRef) return null;
		const ref = encodeURIComponent(payment.gatewayRef);
		const order = await api(keys, ctx, 'GET', `/v2/checkout/orders/${ref}`);
		if (!ok2xx(order.status)) return null;
		if (order.json?.status !== 'APPROVED' || payment.status === 'voided') return orderNews(order.json, payment.id);
		const captured = await api(keys, ctx, 'POST', `/v2/checkout/orders/${ref}/capture`, {}, `ss-${payment.id}-capture`);
		return ok2xx(captured.status) ? orderNews(captured.json, payment.id) : null;
	},
	notice: async (incoming, keys, ctx) => {
		const header = (/** @type {string} */ name) => (incoming.headers.get(name) ?? '').trim();
		// nothing reaches PayPal (and spends the merchant's PayPal calls) unless the notice carries all five signature
		// headers and names a certificate on PayPal's own host (SR-3-2)
		if (NOTICE_HEADERS.some((name) => header(name) === '') || !paypalCertUrl(header('paypal-cert-url'))) return { ok: false };
		/** @type {any} */
		let event;
		try {
			event = JSON.parse(incoming.rawBody);
		} catch {
			return { ok: false };
		}
		const verified = await api(keys, ctx, 'POST', '/v1/notifications/verify-webhook-signature', {
			auth_algo: header('paypal-auth-algo'),
			cert_url: header('paypal-cert-url'),
			transmission_id: header('paypal-transmission-id'),
			transmission_sig: header('paypal-transmission-sig'),
			transmission_time: header('paypal-transmission-time'),
			webhook_id: keys.webhookId,
			webhook_event: event,
		});
		if (!ok2xx(verified.status) || verified.json?.verification_status !== 'SUCCESS') return { ok: false };
		const resource = event?.resource ?? {};
		const type = String(event?.event_type ?? '');
		if (type === 'PAYMENT.CAPTURE.COMPLETED' || type === 'PAYMENT.CAPTURE.DENIED' || type === 'PAYMENT.CAPTURE.DECLINED') {
			const currency = String(resource.amount?.currency_code ?? '');
			return {
				ok: true,
				news: [
					{
						kind: 'payment',
						paymentId: typeof resource.custom_id === 'string' ? resource.custom_id : null,
						ref: resource.supplementary_data?.related_ids?.order_id ?? null,
						outcome: type === 'PAYMENT.CAPTURE.COMPLETED' ? 'paid' : 'failed',
						amount: fromDecimal(resource.amount?.value, currency) ?? undefined,
						currency,
						capture: typeof resource.id === 'string' ? resource.id : null,
					},
				],
			};
		}
		if (type.startsWith('BILLING.SUBSCRIPTION.'))
			return {
				ok: true,
				news: [
					{
						kind: 'subscription',
						subscriptionId: typeof resource.custom_id === 'string' ? resource.custom_id : null,
						ref: String(resource.id ?? ''),
						status: resource.status ?? null,
					},
				],
			};
		return { ok: true, news: [] };
	},
	refund: async ({ payment, amount, reason, refundId }, keys, ctx) => {
		if (!payment.captureRef) return { ok: false, message: 'PayPal has not confirmed this payment.' };
		const answer = await api(
			keys,
			ctx,
			'POST',
			`/v2/payments/captures/${encodeURIComponent(payment.captureRef)}/refund`,
			{
				amount: { value: toDecimal(amount, payment.currency), currency_code: payment.currency },
				...(reason ? { note_to_payer: reason.slice(0, 255) } : {}),
			},
			refundId,
		);
		if (!ok2xx(answer.status) || !['COMPLETED', 'PENDING'].includes(answer.json?.status))
			return { ok: false, message: failure('PayPal', answer.status) };
		return { ok: true, ref: String(answer.json.id) };
	},
	subscribe: async ({ subscription, keys, urls }, ctx) => {
		const answer = await api(
			keys,
			ctx,
			'POST',
			'/v1/billing/subscriptions',
			{
				plan_id: subscription.plan,
				custom_id: subscription.id,
				...(subscription.customer.email ? { subscriber: { email_address: subscription.customer.email } } : {}),
				application_context: {
					return_url: urls.return,
					cancel_url: urls.cancel,
					user_action: 'SUBSCRIBE_NOW',
					shipping_preference: 'NO_SHIPPING',
				},
			},
			`ss-${subscription.id}`,
		);
		const url = linkOf(answer.json?.links, ['approve']);
		if (!ok2xx(answer.status) || !url) return { kind: 'error', message: failure('PayPal', answer.status) };
		return { kind: 'redirect', url, ref: String(answer.json.id) };
	},
	subscriptionStatus: async (subscription, keys, ctx) => {
		if (!subscription.gatewayRef) return null;
		const answer = await api(keys, ctx, 'GET', `/v1/billing/subscriptions/${encodeURIComponent(subscription.gatewayRef)}`);
		if (!ok2xx(answer.status)) return null;
		return {
			kind: 'subscription',
			subscriptionId: subscription.id,
			ref: subscription.gatewayRef,
			status: answer.json?.status ?? null,
		};
	},
	// PayPal needs a reason: the merchant's own (P11)
	cancelSubscription: async (subscription, keys, ctx, reason) => {
		const answer = await api(
			keys,
			ctx,
			'POST',
			`/v1/billing/subscriptions/${encodeURIComponent(String(subscription.gatewayRef))}/cancel`,
			{ reason: reason.slice(0, 128) },
		);
		return ok2xx(answer.status) ? { ok: true } : { ok: false, message: failure('PayPal', answer.status) };
	},
};
