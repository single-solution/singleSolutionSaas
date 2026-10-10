/**
 * The payments service (PLAN 0.8.7): creating payments and links, starting a payment on its gateway, applying what a
 * gateway confirmed (signed notices, returns asked server to server, status checks), refunds, bank-transfer
 * confirmation, subscriptions, and the payment events. There is no background work: an unconfirmed payment is asked
 * again when the merchant reads it (PLAN 0.8.4), and events are the kit's (PLAN 0.8.10 K5): sent to the merchant
 * through Notifications right after (`after()`) the request that made them, retried on later requests for that website.
 * @module
 */
import { problem } from '@ss/app-kit';
import { originAllowed } from '@ss/protocol';
import { GATEWAY_CONNECTIONS, GATEWAY_FEATURES, gatewaysFor, takesCurrency } from '../core/gateways.js';
import {
	mirrorStatus,
	paymentEventData,
	paymentView,
	refundAmount,
	statusAfterRefund,
	subscriptionView,
} from '../core/payments.js';
import { genericCurrencies } from '../adapters/gateways/index.js';
import { createStore } from '../adapters/store.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('../adapters/store.js').Store} Store */
/** @typedef {import('../adapters/store.js').PaymentRecord} PaymentRecord */
/** @typedef {import('../adapters/store.js').SubscriptionRecord} SubscriptionRecord */
/** @typedef {import('../core/gateways.js').Gateway} Gateway */
/** @typedef {import('../adapters/gateways/types.js').News} News */
/** @typedef {import('../adapters/gateways/types.js').Started} Started */
/**
 * A website while serving it: its store, switched-on features, domain, the product's own address, and the request's
 * `after()` (events are forwarded right after it).
 * @typedef {{ websiteId: string, merchantId: string | null, domain: string, store: Store, on: string[], base: string,
 *   after: (task: () => Promise<unknown>) => void }} Site
 */
/**
 * Who did it: a member of the merchant's staff (a ticket's user, or the acting user a server-token call names with
 * `SS-Actor-*` headers, PLAN 0.8.10 K2), or the server.
 * @typedef {{ kind: string, id: string, name?: string, role?: string }} Actor
 */

/** A pending payment is asked of its gateway again at most this often. */
const RECHECK_MS = 30_000;

/** The server token as an actor (when a server-token call names no acting user). */
export const SERVER_ACTOR = Object.freeze({ kind: 'server', id: 'server', name: 'Server' });

/** The name recorded for an actor (`by` in histories and refunds). @param {Actor} actor */
export const nameOf = (actor) => actor.name ?? actor.id;

/**
 * @param {Product} product
 */
export const createService = (product) => {
	const { now, gateways } = product;
	const ctx = { send: product.send, now };

	/**
	 * The website as the service sees it.
	 * @param {{ websiteId: string, merchantId: string | null, domain: string, base: string,
	 *   after: (task: () => Promise<unknown>) => void }} input
	 * @returns {Promise<Site>}
	 */
	const site = async ({ websiteId, merchantId, domain, base, after }) => ({
		websiteId,
		merchantId,
		domain,
		store: createStore(await product.data.forWebsite(websiteId, merchantId ? { merchantId } : {}), { now }),
		on: await product.featuresOn(websiteId),
		base: product.address() ?? base,
		after,
	});

	/** @param {Site} s @param {string} id */
	const payUrl = (s, id) => `${s.base}/pay/${s.websiteId}/${id}`;
	/** @param {Site} s @param {string} id */
	const linkUrl = (s, id) => `${s.base}/l/${s.websiteId}/${id}`;
	/** @param {Site} s @param {PaymentRecord} payment */
	const view = (s, payment) => paymentView(payment, payUrl(s, payment.id));

	/**
	 * Where the payer comes back to and the gateway sends notices to.
	 * @param {Site} s @param {string} gateway @param {string} id payment or subscription id
	 */
	const urlsOf = (s, gateway, id) => ({
		return: `${s.base}/return/${gateway}/${s.websiteId}/${id}`,
		cancel: `${s.base}/return/cancel/${s.websiteId}/${id}`,
		notify: `${s.base}/v1/gateways/${gateway}/${s.websiteId}`,
	});

	/**
	 * A gateway's keys (decrypted), or null.
	 * @param {Site} s @param {Exclude<Gateway, 'bank_transfer'>} gateway
	 * @returns {Promise<Record<string, any> | null>}
	 */
	const keysOf = async (s, gateway) => {
		const value = await product.connections.value(s.websiteId, /** @type {string} */ (GATEWAY_CONNECTIONS[gateway]));
		return typeof value === 'object' && value !== null && gateways[gateway].violation(value) === null ? value : null;
	};

	/**
	 * The gateways a payer may use now for a currency (switched on, connected, taking the currency).
	 * @param {Site} s @param {string} currency @param {readonly string[] | null} [only]
	 * @returns {Promise<Gateway[]>}
	 */
	const available = async (s, currency, only = null) => {
		/** @type {Set<string>} */
		const ready = new Set();
		/** @type {string[]} */
		let own = [];
		for (const gateway of /** @type {const} */ ([
			'stripe',
			'paypal',
			'payfast',
			'payfast_pk',
			'jazzcash',
			'easypaisa',
			'rapid',
			'generic',
		])) {
			if (!s.on.includes(GATEWAY_FEATURES[gateway])) continue;
			const keys = await keysOf(s, gateway);
			if (keys) ready.add(gateway);
			if (gateway === 'generic') own = genericCurrencies(keys);
		}
		if (s.on.includes('bank_transfer')) {
			const bank = await product.settings.values(s.websiteId, 'bank_transfer');
			if (String(bank.accountNumber ?? '') !== '' || String(bank.iban ?? '') !== '') ready.add('bank_transfer');
		}
		return gatewaysFor({ on: s.on, ready: (gateway) => ready.has(gateway), currency, own, only });
	};

	/**
	 * Whether an address the payer is sent back to belongs to the website (its exact https domain, or a local origin
	 * while testing, PLAN 0.8.1).
	 * @param {Site} s @param {string | null} url
	 */
	const allowedReturn = (s, url) => {
		if (url === null) return true;
		try {
			const target = new URL(url);
			return !target.username && !target.password && originAllowed({ origin: target.origin, domain: s.domain });
		} catch {
			return false;
		}
	};

	/**
	 * Record an event on the kit (`payments.<type>`: listed by the API, sent through Notifications right after the
	 * request, retried on later ones).
	 * @param {Site} s @param {import('../core/payments.js').EVENT_TYPES[number]} type @param {Record<string, unknown>} data
	 */
	const emit = (s, type, data) =>
		product.events.emit({ websiteId: s.websiteId, merchantId: s.merchantId, after: s.after }, type, data);

	/**
	 * Create a payment (API or a payment link).
	 * @param {Site} s
	 * @param {{ amount: number, currency: string, gateway: Gateway | null, description: string, reference: string,
	 *   customer: import('../core/payments.js').Customer, metadata: Record<string, string>, returnUrl: string | null,
	 *   cancelUrl: string | null }} input checked by `checkPaymentInput`
	 * @param {{ source: 'api' | 'link', linkId?: string | null }} from
	 */
	const createPayment = async (s, input, { source, linkId = null }) => {
		for (const field of /** @type {const} */ (['returnUrl', 'cancelUrl']))
			if (!allowedReturn(s, input[field]))
				throw problem('validation_failed', `${field} must be on https://${s.domain} (or a local address while testing).`, {
					errors: [{ path: `/${field}`, message: 'not on the website', code: 'origin' }],
				});
		if (input.gateway !== null) {
			if (!takesCurrency(input.gateway, input.currency))
				throw problem('currency_not_supported', `${input.gateway} does not take ${input.currency}.`);
			if (!(await available(s, input.currency)).includes(input.gateway))
				throw problem('gateway_not_ready', `${input.gateway} is off or not connected for this website.`);
		} else if ((await available(s, input.currency)).length === 0)
			throw problem('gateway_not_ready', `No gateway is ready for ${input.currency}: switch one on and connect it.`);
		return s.store.payments.add({ ...input, gateway: input.gateway, source, linkId });
	};

	/**
	 * Send the payer on to the gateway: a redirect or a form (kept, so reopening the page goes to the same checkout),
	 * or, for a bank transfer, nothing (its page shows the bank details).
	 * @param {Site} s @param {PaymentRecord} payment @param {Gateway} gateway
	 * @returns {Promise<{ ok: true, payment: PaymentRecord } | { ok: false, message: string }>}
	 */
	const start = async (s, payment, gateway) => {
		if (payment.gateway === gateway && (payment.checkout || gateway === 'bank_transfer')) return { ok: true, payment };
		// once a gateway has a checkout, the payer goes on there until it fails or the payer cancels
		if (payment.status === 'pending' && payment.checkout && payment.gateway !== gateway)
			return { ok: false, message: 'not_pending' };
		if (!(await available(s, payment.currency)).includes(gateway)) return { ok: false, message: 'gateway_not_ready' };
		if (gateway === 'bank_transfer') {
			const changed = await s.store.payments.change(
				payment.id,
				['pending', 'failed', 'cancelled'],
				{ gateway, status: 'pending', checkout: null, gatewayRef: null },
				{ event: 'started', detail: gateway },
			);
			return changed ? { ok: true, payment: changed } : { ok: false, message: 'not_pending' };
		}
		const keys = /** @type {Record<string, any>} */ (await keysOf(s, gateway));
		const started = await gateways[gateway].start(
			{ payment: { ...payment, websiteId: s.websiteId }, keys, urls: urlsOf(s, gateway, payment.id) },
			ctx,
		);
		if (started.kind === 'error') return { ok: false, message: started.message };
		const checkout =
			started.kind === 'redirect'
				? { kind: started.kind, url: started.url }
				: { kind: started.kind, action: started.action, fields: started.fields };
		const changed = await s.store.payments.change(
			payment.id,
			['pending', 'failed', 'cancelled'],
			{ gateway, status: 'pending', gatewayRef: started.ref, checkout: /** @type {any} */ (checkout) },
			{ event: 'started', detail: gateway },
		);
		return changed ? { ok: true, payment: changed } : { ok: false, message: 'not_pending' };
	};

	/**
	 * Apply what a gateway confirmed about a payment of this website. A payment becomes paid only for its own amount and
	 * currency (a mismatch is recorded and changes nothing); a confirmation that arrives twice changes nothing.
	 * @param {Site} s @param {Gateway} gateway @param {import('../adapters/gateways/types.js').PaymentNews} news @param {string} via
	 * @returns {Promise<PaymentRecord | null>} the payment after it, or null when it is not this website's
	 */
	const applyPayment = async (s, gateway, news, via) => {
		const payment = news.paymentId ? await s.store.payments.get(news.paymentId) : null;
		// the payer may have tried another gateway since: a confirmation from any gateway the payment was started on counts
		const tried = payment?.history.some((entry) => entry.event === 'started' && entry.detail === gateway);
		if (!payment || (payment.gateway !== gateway && !tried)) return null;
		if (news.outcome === 'paid') {
			if (news.amount !== payment.amount || news.currency !== payment.currency) {
				const noted = await s.store.payments.change(
					payment.id,
					[payment.status],
					{},
					{
						event: 'mismatch',
						detail: `${gateway} confirmed ${news.amount ?? '?'} ${news.currency ?? '?'}`,
					},
				);
				return noted ?? payment;
			}
			const paid = await s.store.payments.change(
				payment.id,
				['pending', 'failed', 'cancelled'],
				{
					status: 'paid',
					paidAt: new Date(now()),
					...(news.capture ? { captureRef: news.capture } : {}),
					...(news.ref && !payment.gatewayRef ? { gatewayRef: news.ref } : {}),
				},
				{ event: 'paid', detail: via },
			);
			if (!paid) return payment;
			if (paid.linkId) await s.store.links.countPaid(paid.linkId);
			await emit(s, 'payment.paid', paymentEventData(view(s, paid)));
			return paid;
		}
		if (news.outcome === 'failed' || news.outcome === 'cancelled') {
			const changed = await s.store.payments.change(
				payment.id,
				['pending'],
				{ status: news.outcome },
				{ event: news.outcome, detail: via },
			);
			if (!changed) return payment;
			if (news.outcome === 'failed') await emit(s, 'payment.failed', paymentEventData(view(s, changed)));
			return changed;
		}
		return payment;
	};

	/**
	 * Apply what a gateway says about a subscription (its status, mirrored).
	 * @param {Site} s @param {'stripe' | 'paypal'} gateway @param {import('../adapters/gateways/types.js').SubscriptionNews} news
	 * @returns {Promise<SubscriptionRecord | null>}
	 */
	const applySubscription = async (s, gateway, news) => {
		const found =
			(news.subscriptionId ? await s.store.subscriptions.get(news.subscriptionId) : null) ??
			(news.ref ? await s.store.subscriptions.byRef(news.ref) : null);
		if (!found || found.gateway !== gateway) return null;
		const status = mirrorStatus(gateway, news.status) ?? (news.status === 'active' ? 'active' : null);
		/** @type {Partial<SubscriptionRecord>} */
		const set = {};
		if (news.ref && news.ref !== found.gatewayRef && !news.ref.startsWith('cs_')) set.gatewayRef = news.ref;
		if (status && status !== found.status) set.status = status;
		if (Object.keys(set).length === 0) return found;
		const updated = await s.store.subscriptions.update(
			found.id,
			set,
			set.status ? { event: set.status, detail: gateway } : null,
		);
		if (updated && set.status) await emit(s, 'subscription.updated', { subscription: subscriptionView(updated) });
		return updated;
	};

	/**
	 * Apply everything a notice said.
	 * @param {Site} s @param {Gateway} gateway @param {News[]} news @param {string} via
	 */
	const apply = async (s, gateway, news, via) => {
		for (const item of news)
			if (item.kind === 'payment') await applyPayment(s, gateway, item, via);
			else if (gateway === 'stripe' || gateway === 'paypal') await applySubscription(s, gateway, item);
	};

	/**
	 * Ask the gateway about a pending payment (no more than every 30 seconds): how an unconfirmed payment is rechecked
	 * without timers (PLAN 0.8.4).
	 * @param {Site} s @param {PaymentRecord} payment
	 * @returns {Promise<PaymentRecord>}
	 */
	const recheck = async (s, payment) => {
		if (payment.status !== 'pending' || !payment.gateway || payment.gateway === 'bank_transfer' || !payment.gatewayRef)
			return payment;
		const adapter = gateways[payment.gateway];
		if (!adapter.status || now() - new Date(payment.updatedAt).getTime() < RECHECK_MS) return payment;
		const keys = await keysOf(s, payment.gateway);
		if (!keys) return payment;
		const news = await adapter.status({ ...payment, websiteId: s.websiteId }, keys, ctx);
		const after = news ? await applyPayment(s, payment.gateway, news, 'checked with the gateway') : null;
		// touch it, so the next read waits again
		return after && after !== payment ? after : ((await s.store.payments.change(payment.id, ['pending'], {})) ?? payment);
	};

	/**
	 * Refund a payment (all of what is left when `amount` is undefined). Gateways with a refund API refund there; the
	 * others (PayFast Pakistan, JazzCash, Easypaisa, Rapid Gateway, bank transfer, the generic adapter without a refund
	 * address) are recorded: the merchant returns the money themselves.
	 * @param {Site} s @param {PaymentRecord} payment @param {{ amount: unknown, reason: unknown }} input @param {Actor} by
	 * @returns {Promise<PaymentRecord>}
	 */
	const refund = async (s, payment, input, by) => {
		const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 200) : '';
		const checked = refundAmount(payment, input.amount);
		if (!checked.ok)
			throw checked.code === 'not_refundable'
				? problem('not_refundable', checked.message)
				: problem('validation_failed', checked.message, {
						errors: [{ path: '/amount', message: checked.message, code: 'amount' }],
					});
		const refundId = `rfd_${payment.id.slice(4)}_${payment.refunds.length + 1}`;
		const gateway = /** @type {Gateway} */ (payment.gateway);
		/** @type {import('../adapters/gateways/types.js').Refunded} */
		let done = { ok: true, manual: true };
		if (gateway !== 'bank_transfer') {
			const keys = await keysOf(s, gateway);
			if (!keys) throw problem('gateway_not_ready', `${gateway} is not connected for this website.`);
			done = await gateways[gateway].refund(
				{ payment: { ...payment, websiteId: s.websiteId }, amount: checked.amount, reason, refundId },
				keys,
				ctx,
			);
		}
		if (!done.ok) throw problem('gateway_failed', done.message);
		const refunded = await s.store.payments.addRefund(
			payment.id,
			payment.refunded,
			{
				id: refundId,
				amount: checked.amount,
				reason,
				manual: done.manual === true,
				by: nameOf(by),
				at: new Date(now()),
				gatewayRef: done.manual ? null : done.ref,
			},
			statusAfterRefund(payment, checked.amount),
		);
		if (!refunded) throw problem('conflict', 'The payment changed meanwhile; read it again.');
		await emit(
			s,
			'payment.refunded',
			paymentEventData(view(s, refunded), { refund: { id: refundId, amount: checked.amount } }),
		);
		return refunded;
	};

	/**
	 * The merchant confirms a bank transfer arrived.
	 * @param {Site} s @param {PaymentRecord} payment @param {Actor} by
	 */
	const confirmTransfer = async (s, payment, by) => {
		if (payment.gateway !== 'bank_transfer' || payment.status !== 'pending')
			throw problem('conflict', 'Only a pending bank transfer can be confirmed.');
		const paid = await s.store.payments.change(
			payment.id,
			['pending'],
			{ status: 'paid', paidAt: new Date(now()) },
			{ event: 'paid', detail: 'transfer confirmed', by: nameOf(by) },
		);
		if (!paid) throw problem('conflict', 'The payment changed meanwhile; read it again.');
		if (paid.linkId) await s.store.links.countPaid(paid.linkId);
		await emit(s, 'payment.paid', paymentEventData(view(s, paid)));
		return paid;
	};

	/**
	 * Start a gateway-managed subscription.
	 * @param {Site} s
	 * @param {{ gateway: 'stripe' | 'paypal', plan: string, customer: import('../core/payments.js').Customer, reference: string,
	 *   returnUrl: string, cancelUrl: string | null }} input checked by `checkSubscriptionInput`
	 */
	const subscribe = async (s, input) => {
		for (const field of /** @type {const} */ (['returnUrl', 'cancelUrl']))
			if (!allowedReturn(s, input[field]))
				throw problem('validation_failed', `${field} must be on https://${s.domain} (or a local address while testing).`, {
					errors: [{ path: `/${field}`, message: 'not on the website', code: 'origin' }],
				});
		const keys = s.on.includes(input.gateway) ? await keysOf(s, input.gateway) : null;
		if (!keys) throw problem('gateway_not_ready', `${input.gateway} is off or not connected for this website.`);
		const subscription = await s.store.subscriptions.add(input);
		const started = /** @type {Started} */ (
			await gateways[input.gateway].subscribe?.({ subscription, keys, urls: urlsOf(s, input.gateway, subscription.id) }, ctx)
		);
		if (started.kind !== 'redirect') {
			await s.store.subscriptions.update(subscription.id, { status: 'expired' }, { event: 'failed', detail: input.gateway });
			throw problem('gateway_failed', started.kind === 'error' ? started.message : 'The gateway refused.');
		}
		return /** @type {SubscriptionRecord} */ (
			await s.store.subscriptions.update(subscription.id, { gatewayRef: started.ref, checkoutUrl: started.url })
		);
	};

	/**
	 * Ask the gateway about a subscription (when the payer comes back).
	 * @param {Site} s @param {SubscriptionRecord} subscription
	 */
	const recheckSubscription = async (s, subscription) => {
		const keys = await keysOf(s, subscription.gateway);
		const news = keys ? await gateways[subscription.gateway].subscriptionStatus?.(subscription, keys, ctx) : null;
		return news ? ((await applySubscription(s, subscription.gateway, news)) ?? subscription) : subscription;
	};

	/**
	 * Cancel a subscription at its gateway.
	 * @param {Site} s @param {SubscriptionRecord} subscription @param {Actor} by
	 */
	const cancelSubscription = async (s, subscription, by) => {
		if (subscription.status === 'cancelled' || subscription.status === 'expired')
			throw problem('conflict', 'The subscription has already ended.');
		const keys = await keysOf(s, subscription.gateway);
		if (!keys) throw problem('gateway_not_ready', `${subscription.gateway} is not connected for this website.`);
		const done = await gateways[subscription.gateway].cancelSubscription?.(subscription, keys, ctx);
		if (!done?.ok) throw problem('gateway_failed', done?.message ?? 'The gateway refused.');
		const updated = /** @type {SubscriptionRecord} */ (
			await s.store.subscriptions.update(subscription.id, { status: 'cancelled' }, { event: 'cancelled', by: nameOf(by) })
		);
		await emit(s, 'subscription.updated', { subscription: subscriptionView(updated) });
		return updated;
	};

	return Object.freeze({
		site,
		view,
		payUrl,
		linkUrl,
		urlsOf,
		keysOf,
		available,
		allowedReturn,
		createPayment,
		start,
		applyPayment,
		apply,
		recheck,
		refund,
		confirmTransfer,
		subscribe,
		recheckSubscription,
		cancelSubscription,
	});
};

/** @typedef {ReturnType<typeof createService>} Service */
