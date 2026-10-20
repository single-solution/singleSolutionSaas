/**
 * The payments service (PLAN 0.8.7): creating payments and links, starting a payment on its gateway, applying what a
 * gateway confirmed (signed notices, returns asked server to server, status checks), refunds, the merchant's
 * confirmation of a manual payment (its manual payment methods, fixed-choices P1), the merchant's cancel, subscriptions, and the payment events. There is no background work: an unconfirmed payment is asked
 * again when the merchant reads it (PLAN 0.8.4), and events are the kit's (PLAN 0.8.10 K5): sent to the merchant
 * through Notifications right after (`after()`) the request that made them, retried on later requests for that website.
 * @module
 */
import { problem } from '@ss/app-kit';
import { originAllowed } from '@ss/protocol';
import {
	CUSTOM_GATEWAY_CONNECTIONS,
	GATEWAY_CONNECTIONS,
	GATEWAY_FEATURES,
	GATEWAYS,
	gatewaysFor,
	adapterOf,
	isCustomGateway,
	isGateway,
	orderedWays,
	takesCurrency,
} from '../core/gateways.js';
import { methodReady } from '../core/methods.js';
import { MIN_CHECKOUT_MINUTES } from '../core/limits.js';
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
 * verified `SS-Sign-In`, PLAN 0.8.10 K2), or the server.
 * @typedef {{ kind: string, id: string, name?: string, role?: string }} Actor
 */

/** A pending payment is asked of its gateway again at most this often. */
const RECHECK_MS = 30_000;
/** A refund reserved before its gateway call is taken to be of a process that is gone after this long (SR-3-3). */
const REFUND_RESERVATION_MS = 300_000;

/** The server token as an actor (when a server-token call names no acting user). */
export const SERVER_ACTOR = Object.freeze({ kind: 'server', id: 'server', name: 'Server' });

/** The name recorded for an actor (`by` in histories and refunds). @param {Actor} actor */
const nameOf = (actor) => actor.name ?? actor.id;

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
		// an id's parts are the path's segments (a custom gateway's generic:<key> → generic/<key>)
		notify: `${s.base}/v1/gateways/${gateway.replace(':', '/')}/${s.websiteId}`,
	});

	/**
	 * The website's custom gateways (P4): each connection `generic_1` … `generic_5` that holds a usable value, by its id
	 * `generic:<key>` (a key used twice counts once, the first).
	 * @param {Site} s
	 * @returns {Promise<Array<{ id: string, keys: Record<string, any> }>>}
	 */
	const customsOf = async (s) => {
		/** @type {Array<{ id: string, keys: Record<string, any> }>} */
		const found = [];
		for (const name of CUSTOM_GATEWAY_CONNECTIONS) {
			const value = await product.connections.value(s.websiteId, name);
			if (typeof value !== 'object' || value === null || gateways.generic.violation(value) !== null) continue;
			const keys = /** @type {Record<string, any>} */ (value);
			const id = `generic:${keys.slug}`;
			if (!found.some((entry) => entry.id === id)) found.push({ id, keys });
		}
		return found;
	};

	/**
	 * A gateway's keys (decrypted), or null; a custom gateway's are its own connection's.
	 * @param {Site} s @param {string} gateway
	 * @returns {Promise<Record<string, any> | null>}
	 */
	const keysOf = async (s, gateway) => {
		if (isCustomGateway(gateway)) return (await customsOf(s)).find((entry) => entry.id === gateway)?.keys ?? null;
		const adapter = adapterOf(gateway);
		const connection = GATEWAY_CONNECTIONS[adapter];
		if (connection === null) return null;
		const value = await product.connections.value(s.websiteId, connection);
		return typeof value === 'object' && value !== null && gateways[adapter].violation(value) === null ? value : null;
	};

	/**
	 * The website's manual payment methods while Manual payment methods is on (the saved list, else today's bank transfer).
	 * @param {Site} s
	 * @returns {Promise<import('../core/methods.js').ManualMethod[]>}
	 */
	const methodsOf = async (s) =>
		s.on.includes('manual_payments') ? await product.lists.get(s.websiteId, 'manual_methods') : [];

	/**
	 * A manual payment method of the website by its key (Manual payment methods on), or null.
	 * @param {Site} s @param {string | null} key
	 */
	const methodOf = async (s, key) =>
		key === null || isGateway(key) ? null : ((await methodsOf(s)).find((method) => method.key === key) ?? null);

	/**
	 * The ways a payer may pay now for a currency: the gateways switched on, connected and taking the currency, then the
	 * manual methods that are ready for it (see `methodReady`), in the merchant's order with their preferred way first
	 * (P5, see `orderedWays`); `only` narrows them (a payment link's own choice).
	 * @param {Site} s @param {string} currency @param {readonly string[] | null} [only]
	 * @returns {Promise<string[]>} gateway ids and manual methods' keys
	 */
	const available = async (s, currency, only = null) => {
		/** @type {Set<string>} */
		const ready = new Set();
		for (const gateway of GATEWAYS) {
			if (gateway === 'generic' || !s.on.includes(GATEWAY_FEATURES[gateway])) continue;
			if (await keysOf(s, gateway)) ready.add(gateway);
		}
		const picked = (/** @type {string} */ id) => only === null || only.length === 0 || only.includes(id);
		// the merchant's custom gateways, each with its own currencies (P4)
		const customs = s.on.includes(GATEWAY_FEATURES.generic)
			? (await customsOf(s))
					.filter((entry) => picked(entry.id) && takesCurrency(entry.id, currency, genericCurrencies(entry.keys)))
					.map((entry) => entry.id)
			: [];
		const manual = (await methodsOf(s))
			.filter((method) => picked(method.key) && methodReady(method, currency).ready)
			.map((method) => method.key);
		const { methodOrder, preferredMethod } = await product.settings.values(s.websiteId, 'payment_api');
		return orderedWays(
			[...gatewaysFor({ on: s.on, ready: (gateway) => ready.has(gateway), currency, only }), ...customs, ...manual],
			{
				order: Array.isArray(methodOrder) ? methodOrder : [],
				preferred: preferredMethod,
			},
		);
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
	 * Refuse a return or cancel address that is not on the website (422 at its field).
	 * @param {Site} s @param {{ returnUrl: string | null, cancelUrl: string | null }} input
	 */
	const checkReturns = (s, input) => {
		for (const field of /** @type {const} */ (['returnUrl', 'cancelUrl']))
			if (!allowedReturn(s, input[field]))
				throw problem('validation_failed', `${field} must be on https://${s.domain} (or a local address while testing).`, {
					errors: [{ path: `/${field}`, message: 'not on the website', code: 'origin' }],
				});
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
	 * @param {{ amount: number, currency: string, gateway: string | null, description: string, reference: string,
	 *   customer: import('../core/payments.js').Customer, metadata: Record<string, string>,
	 *   answers: Array<{ label: string, value: string }>, returnUrl: string | null, cancelUrl: string | null,
	 *   expiresAt?: Date | null }} input checked by `checkPaymentInput` (a link's answers: `checkLinkAnswers`)
	 * @param {{ source: 'api' | 'link', linkId?: string | null }} from
	 */
	const createPayment = async (s, input, { source, linkId = null }) => {
		checkReturns(s, input);
		if (input.gateway !== null) {
			if (isGateway(input.gateway) && !isCustomGateway(input.gateway) && !takesCurrency(input.gateway, input.currency))
				throw problem('currency_not_supported', `${input.gateway} does not take ${input.currency}.`);
			if (!(await available(s, input.currency)).includes(input.gateway))
				throw problem(
					'gateway_not_ready',
					`${input.gateway} is off, not connected or not ready for ${input.currency} on this website.`,
				);
		} else if ((await available(s, input.currency)).length === 0)
			throw problem(
				'gateway_not_ready',
				`No gateway or manual payment method is ready for ${input.currency}: switch one on and set it up.`,
			);
		const method = await methodOf(s, input.gateway);
		const custom = isCustomGateway(input.gateway) ? await keysOf(s, input.gateway) : null;
		return s.store.payments.add({
			...input,
			expiresAt: input.expiresAt ?? null,
			manual: method ? { name: method.name, kind: method.kind } : null,
			gatewayName: custom ? String(custom.name) : null,
			source,
			linkId,
		});
	};

	/**
	 * Send the payer on to the gateway: a redirect or a form (kept, so reopening the page goes to the same checkout),
	 * or, for a manual payment method, nothing (its page shows the method's details, accounts and instructions).
	 * @param {Site} s @param {PaymentRecord} payment @param {string} gateway a gateway id or a manual method's key
	 * @returns {Promise<{ ok: true, payment: PaymentRecord } | { ok: false }>}
	 */
	const start = async (s, payment, gateway) => {
		if (payment.gateway === gateway && (payment.checkout || payment.manual)) return { ok: true, payment };
		// once a gateway has a checkout, the payer goes on there until it fails or the payer cancels
		if (payment.status === 'pending' && payment.checkout && payment.gateway !== gateway) return { ok: false };
		if (!(await available(s, payment.currency)).includes(gateway)) return { ok: false };
		if (!isGateway(gateway)) {
			const method = await methodOf(s, gateway);
			if (!method) return { ok: false };
			const changed = await s.store.payments.change(
				payment.id,
				['pending', 'failed', 'canceled'],
				{
					gateway,
					manual: { name: method.name, kind: method.kind },
					status: 'pending',
					checkout: null,
					gatewayRef: null,
				},
				{ event: 'started', detail: gateway },
			);
			return changed ? { ok: true, payment: changed } : { ok: false };
		}
		const keys = /** @type {Record<string, any>} */ (await keysOf(s, gateway));
		const adapter = gateways[adapterOf(gateway)];
		// an unpaid checkout ends when the caller said (a shop passes its order's payment window), else after the
		// merchant's hours (links and API payments that name no end), within the gateway's own longest (P9)
		const { checkoutExpiryHours } = await product.settings.values(s.websiteId, 'payment_api');
		const wanted = payment.expiresAt ? new Date(payment.expiresAt).getTime() : now() + Number(checkoutExpiryHours) * 3_600_000;
		const longest = now() + (adapter.maxExpiryHours ?? Number.POSITIVE_INFINITY) * 3_600_000;
		const started = await adapter.start(
			{
				payment: { ...payment, websiteId: s.websiteId },
				keys,
				urls: urlsOf(s, gateway, payment.id),
				expiresAt: Math.min(Math.max(wanted, now() + MIN_CHECKOUT_MINUTES * 60_000), longest),
			},
			ctx,
		);
		if (started.kind === 'error') return { ok: false };
		const checkout =
			started.kind === 'redirect'
				? { kind: started.kind, url: started.url }
				: { kind: started.kind, action: started.action, fields: started.fields };
		const changed = await s.store.payments.change(
			payment.id,
			['pending', 'failed', 'canceled'],
			{
				gateway,
				manual: null,
				gatewayName: isCustomGateway(gateway) ? String(keys.name) : null,
				status: 'pending',
				gatewayRef: started.ref,
				checkout: /** @type {any} */ (checkout),
			},
			{ event: 'started', detail: gateway },
		);
		return changed ? { ok: true, payment: changed } : { ok: false };
	};

	/**
	 * What follows a payment becoming paid: its link counts it, and the merchant is told (`payment.paid`). Money for a
	 * payment the merchant canceled is not counted on its link, and its history says it is to be refunded (K-13).
	 * @param {Site} s @param {PaymentRecord} paid
	 * @returns {Promise<PaymentRecord>}
	 */
	const settle = async (s, paid) => {
		const after = paid.voidedAt
			? ((await s.store.payments.change(
					paid.id,
					['paid'],
					{},
					{ event: 'refund_due', detail: 'paid after the merchant canceled it' },
				)) ?? paid)
			: paid;
		if (after.linkId && !after.voidedAt) await s.store.links.countPaid(after.linkId);
		await emit(s, 'payment.paid', paymentEventData(view(s, after)));
		return after;
	};

	/**
	 * Apply what a gateway confirmed about a payment of this website. A payment becomes paid only for its own amount and
	 * currency (a mismatch is recorded and changes nothing); a confirmation that arrives twice changes nothing. Money for
	 * a payment the merchant canceled is recorded too (the payer paid), with a history entry saying it is to be refunded:
	 * the payment answers `refundDue: true`, also in its `payment.paid` event, and never verifies an order (K-13).
	 * @param {Site} s @param {string} gateway @param {import('../adapters/gateways/types.js').PaymentNews} news @param {string} via
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
				['pending', 'failed', 'canceled', 'voided'],
				{
					status: 'paid',
					paidAt: new Date(now()),
					...(news.capture ? { captureRef: news.capture } : {}),
					...(news.ref && !payment.gatewayRef ? { gatewayRef: news.ref } : {}),
				},
				{ event: 'paid', detail: via },
			);
			return paid ? settle(s, paid) : payment;
		}
		if (news.outcome === 'failed' || news.outcome === 'canceled') {
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
		const status = mirrorStatus(gateway, news.status);
		/** @type {Partial<SubscriptionRecord>} */
		const set = {};
		if (news.ref && news.ref !== found.gatewayRef) set.gatewayRef = news.ref;
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
	 * @param {Site} s @param {string} gateway @param {News[]} news @param {string} via
	 */
	const apply = async (s, gateway, news, via) => {
		for (const item of news)
			if (item.kind === 'payment') await applyPayment(s, gateway, item, via);
			else if (gateway === 'stripe' || gateway === 'paypal') await applySubscription(s, gateway, item);
	};

	/**
	 * The merchant cancels a payment it no longer wants, for example because its order was canceled or expired (K-13):
	 * the payment becomes `voided`, its pay page and the payer's retry are closed, a bank transfer takes no proof, and
	 * the gateway's own page is stopped where the gateway allows it (Stripe expires the Checkout Session; PayPal's
	 * order is never captured). Money that still arrives is recorded with `refundDue`. A payment already paid is not
	 * canceled (409 `already_paid`, with the payment): refund it instead. Canceling it again changes nothing.
	 * @param {Site} s @param {PaymentRecord} payment @param {string} reason @param {Actor} by
	 * @returns {Promise<PaymentRecord>}
	 */
	const voidPayment = async (s, payment, reason, by) => {
		if (payment.status === 'voided') return payment;
		if (!['pending', 'failed', 'canceled'].includes(payment.status))
			throw problem('already_paid', 'This payment was paid: refund it instead.', {
				extensions: { payment: view(s, payment) },
			});
		const voided = await s.store.payments.change(
			payment.id,
			['pending', 'failed', 'canceled'],
			{ status: 'voided', voidedAt: new Date(now()), checkout: null },
			{ event: 'voided', detail: reason || 'canceled by the merchant', by: nameOf(by) },
		);
		// it changed meanwhile (paid, or canceled by another call): judged again as it is now
		if (!voided) return voidPayment(s, /** @type {PaymentRecord} */ (await s.store.payments.get(payment.id)), reason, by);
		const gateway = payment.gateway;
		const adapter = isGateway(gateway) && payment.gatewayRef ? gateways[adapterOf(gateway)] : null;
		const keys = adapter?.expire ? await keysOf(s, /** @type {string} */ (gateway)) : null;
		if (!adapter?.expire || !keys) return voided;
		const stopped = await adapter.expire({ ...payment, websiteId: s.websiteId }, keys, ctx);
		return (
			(await s.store.payments.change(
				payment.id,
				['voided'],
				{},
				stopped.ok
					? { event: 'stopped', detail: `${gateway} checkout closed` }
					: {
							event: 'not_stopped',
							detail: `${gateway} did not stop it (${stopped.message ?? 'refused'}): money that still arrives is to be refunded`,
						},
			)) ?? voided
		);
	};

	/**
	 * Ask the gateway about a pending payment (no more than every 30 seconds): how an unconfirmed payment is rechecked
	 * without timers (PLAN 0.8.4).
	 * @param {Site} s @param {PaymentRecord} payment
	 * @returns {Promise<PaymentRecord>}
	 */
	const recheck = async (s, payment) => {
		if (payment.status !== 'pending' || !isGateway(payment.gateway) || !payment.gatewayRef) return payment;
		const adapter = gateways[adapterOf(payment.gateway)];
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
	 * others (PayFast Pakistan, JazzCash, Easypaisa, Rapid Gateway, the generic adapter without a refund address, and
	 * every manual payment method) are recorded: the merchant returns the money themselves.
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
		const gateway = payment.gateway;
		const keys = isGateway(gateway) ? await keysOf(s, gateway) : null;
		if (isGateway(gateway) && !keys) throw problem('gateway_not_ready', `${gateway} is not connected for this website.`);
		// reserved here first, with the same compare-and-swap as the refund itself, so two refunds at once reach the
		// gateway once; removed again when the gateway does not take it (SR-3-3)
		const reserved = await s.store.payments.reserveRefund(
			payment.id,
			payment.refunded,
			{ id: refundId, amount: checked.amount, at: new Date(now()) },
			new Date(now() - REFUND_RESERVATION_MS),
		);
		if (!reserved) throw problem('conflict', 'The payment changed meanwhile or another refund is on its way; read it again.');
		/** @type {import('../adapters/gateways/types.js').Refunded} */
		let done = { ok: true, manual: true };
		try {
			if (isGateway(gateway) && keys)
				done = await gateways[adapterOf(gateway)].refund(
					{ payment: { ...payment, websiteId: s.websiteId }, amount: checked.amount, reason, refundId },
					keys,
					ctx,
				);
		} catch (error) {
			await s.store.payments.releaseRefund(payment.id, refundId);
			throw error;
		}
		if (!done.ok) {
			await s.store.payments.releaseRefund(payment.id, refundId);
			throw problem('gateway_failed', done.message);
		}
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
	 * The payer's proof of a manual payment is in the merchant's storage: recorded with the payment's reference, and told
	 * to the merchant (`payment.proof_uploaded`, PLAN 0.8.10 P3).
	 * @param {Site} s @param {PaymentRecord} payment
	 * @param {{ key: string, type: string, size: number }} proof @param {string} reference
	 * @returns {Promise<boolean>} false when the payment changed meanwhile
	 */
	const recordProof = async (s, payment, proof, reference) => {
		const changed = await s.store.payments.change(
			payment.id,
			['pending'],
			{ proof: { ...proof, at: new Date(now()) } },
			{ event: 'proof', ...(reference ? { reference } : {}) },
		);
		if (!changed) return false;
		await emit(s, 'payment.proof_uploaded', paymentEventData(view(s, changed)));
		return true;
	};

	/**
	 * The merchant confirms the money of a manual payment arrived (a transfer, cash on delivery or at pickup …), with its
	 * reference and a note (PLAN 0.8.10 P3). Money that arrives after the merchant canceled the payment is confirmed too,
	 * and is then to be refunded (`refundDue`, K-13).
	 * @param {Site} s @param {PaymentRecord} payment @param {Actor} by
	 * @param {{ reference: string, note: string }} input
	 */
	const confirmManual = async (s, payment, by, { reference, note }) => {
		if (!payment.manual || (payment.status !== 'pending' && payment.status !== 'voided'))
			throw problem('conflict', 'Only a pending manual payment can be confirmed.');
		const paid = await s.store.payments.change(
			payment.id,
			['pending', 'voided'],
			{ status: 'paid', paidAt: new Date(now()) },
			{
				event: 'paid',
				detail: 'confirmed',
				by: nameOf(by),
				...(reference ? { reference } : {}),
				...(note ? { note } : {}),
			},
		);
		if (!paid) throw problem('conflict', 'The payment changed meanwhile; read it again.');
		return settle(s, paid);
	};

	/**
	 * Start a gateway-managed subscription.
	 * @param {Site} s
	 * @param {{ gateway: 'stripe' | 'paypal', plan: string, customer: import('../core/payments.js').Customer, reference: string,
	 *   returnUrl: string, cancelUrl: string | null }} input checked by `checkSubscriptionInput`
	 */
	const subscribe = async (s, input) => {
		checkReturns(s, input);
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
	 * Cancel a subscription at its gateway, with the merchant's reason (sent to gateways that take one, kept in the
	 * history).
	 * @param {Site} s @param {SubscriptionRecord} subscription @param {Actor} by @param {string} reason
	 */
	const cancelSubscription = async (s, subscription, by, reason) => {
		if (subscription.status === 'canceled' || subscription.status === 'expired')
			throw problem('conflict', 'The subscription has already ended.');
		const keys = await keysOf(s, subscription.gateway);
		if (!keys) throw problem('gateway_not_ready', `${subscription.gateway} is not connected for this website.`);
		const done = await gateways[subscription.gateway].cancelSubscription?.(subscription, keys, ctx, reason);
		if (!done?.ok) throw problem('gateway_failed', done?.message ?? 'The gateway refused.');
		const updated = /** @type {SubscriptionRecord} */ (
			await s.store.subscriptions.update(
				subscription.id,
				{ status: 'canceled' },
				{ event: 'canceled', detail: reason, by: nameOf(by) },
			)
		);
		await emit(s, 'subscription.updated', { subscription: subscriptionView(updated) });
		return updated;
	};

	return Object.freeze({
		site,
		view,
		payUrl,
		linkUrl,
		keysOf,
		methodsOf,
		methodOf,
		available,
		allowedReturn,
		createPayment,
		start,
		applyPayment,
		apply,
		recheck,
		voidPayment,
		refund,
		recordProof,
		confirmManual,
		subscribe,
		recheckSubscription,
		cancelSubscription,
	});
};

/** @typedef {ReturnType<typeof createService>} Service */
