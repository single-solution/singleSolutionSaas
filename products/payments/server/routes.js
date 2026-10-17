/**
 * Payments' routes (the kit adds its own: connect, notices, tickets, data rights, widget config, `/sso` and the
 * dashboard API). Every browser-token, server-token and ticket route belongs to one feature; `openapi.json` is
 * generated from these definitions (`ss app assets`), so `method`, `path`, `auth`, `feature` and `permission` stay
 * string literals. Public routes: the widget script, the docs, the hosted link and pay pages, the payer's return from a
 * gateway and the gateways' signed notices. Payment events are the kit's (PLAN 0.8.10 K5): every route that makes one,
 * public ones included, hands the kit its request's `after()`, so the event is forwarded right after the answer.
 * Public entry `./routes` of this package: `product.handler(createRoutes(product))`.
 * @module
 */
import { isId } from '@ss/contracts';
import { actorOf, countHandlers, created, defineRoute, formatText, paginate, problem } from '@ss/app-kit';
import { fromDecimal } from '@ss/contracts/format';
import { CUSTOM_GATEWAY_CONNECTIONS, GATEWAY_FEATURES, adapterOf, isCustomGateway, isGateway } from '../core/gateways.js';
import { PROOF_MAX_MB } from '../core/limits.js';
import { methodView } from '../core/methods.js';
import { gatewayAddresses } from '../core/snippets.js';
import { amountOf, decimalSignOf } from '../core/money.js';
import {
	PAYMENT_STATUSES,
	SUBSCRIPTION_STATUSES,
	checkCustomer,
	checkLinkAnswers,
	checkLinkInput,
	checkPaymentInput,
	checkSubscriptionInput,
	checkTransferInput,
	cleanText,
	isConfirmedFor,
	isPaymentMethod,
	isRefundDue,
	linkClosed,
	linkView,
	subscriptionView,
} from '../core/payments.js';
import { PROOF_TYPES } from '../core/widgets.js';
import { manifest, strings } from '../adapters/product.js';
import { createStore } from '../adapters/store.js';
import { formFields } from '../adapters/util.js';
import { renderDocs } from './docs.js';
import {
	PAGE_HEADERS,
	PAY_SCRIPT,
	gatewayName,
	renderChoicePage,
	renderGatewayForm,
	renderLinkPage,
	renderManualPage,
	renderResultPage,
} from './pages.js';
import { SERVER_ACTOR, createService } from './service.js';
import { WIDGET_SCRIPT } from './widget-script.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('../core/gateways.js').Gateway} Gateway */

/** Rate limits of the merchant's server routes (code constants protecting our hosting). */
const SERVER_LIMITS = [{ limit: 600, windowSeconds: 60, per: /** @type {const} */ ('website') }];
/** Rate limits of public pages and visitor routes. */
const VISITOR_LIMITS = [
	{ limit: 300, windowSeconds: 60, per: /** @type {const} */ ('website') },
	{ limit: 30, windowSeconds: 60, per: /** @type {const} */ ('visitor') },
];
/** Rate limits of the gateways' notices. */
const NOTICE_LIMITS = [{ limit: 600, windowSeconds: 60, per: /** @type {const} */ ('visitor') }];
/** A presigned proof upload or download lasts this long. */
const PROOF_SECONDS = 300;

/** The look of a page for a website that cannot be served: the English texts, no theme (it shows no amount). */
const NO_SITE_LOOK = Object.freeze({ texts: strings });

/** @param {string} field @param {string} message @param {string} [code] */
const invalid = (field, message, code = 'invalid') =>
	problem('validation_failed', message, { errors: [{ path: `/${field}`, message, code }] });

/** @param {string} body @param {number} [status] */
const html = (body, status = 200) => new Response(body, { status, headers: PAGE_HEADERS });

/**
 * An activity detail from its parts (data and the website's own words, never a sentence made in code; P11).
 * @param {...string} parts
 */
const details = (...parts) => parts.filter(Boolean).join(' · ');

/** @param {string} location */
const seeOther = (location) =>
	new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });

/**
 * An address with one more query parameter.
 * @param {string} url @param {string} name @param {string} value
 */
const withParam = (url, name, value) => {
	const target = new URL(url);
	target.searchParams.set(name, value);
	return target.toString();
};

/**
 * @param {Product} product
 */
export const createRoutes = (product) => {
	const service = createService(product);

	/**
	 * The website of a token or ticket request.
	 * @param {any} ctx
	 * @returns {Promise<Site>}
	 */
	const siteOf = (ctx) =>
		service.site({
			websiteId: ctx.websiteId,
			merchantId: ctx.merchantId,
			domain: ctx.status.domain,
			base: new URL(ctx.request.url).origin,
			after: ctx.after,
		});

	/**
	 * The website a public page or a gateway names: it must exist, be served and have its merchant database.
	 * @param {any} ctx
	 * @param {string} websiteId
	 * @returns {Promise<Site | null>}
	 */
	const publicSite = async (ctx, websiteId) => {
		if (!isId(websiteId, 'web')) return null;
		const serving = await product.serving(websiteId, { after: ctx.after });
		if (!serving.ok || (await product.connections.value(websiteId, 'database')) === null) return null;
		// a public page or a notice has no website token, but events (its own and older ones still due) are forwarded
		// right after it all the same, as after a token request
		const merchantId = serving.status.merchantId;
		ctx.after(() => product.events.drain(websiteId, merchantId));
		return service.site({
			websiteId,
			merchantId: serving.status.merchantId,
			domain: serving.status.domain,
			base: new URL(ctx.request.url).origin,
			after: ctx.after,
		});
	};

	/**
	 * Who acts (PLAN 0.8.10 K2): the ticket's member of the merchant's staff, else the acting user a server-token call
	 * names with verified `SS-Sign-In`, else the server.
	 * @param {any} ctx
	 */
	const who = (ctx) => actorOf(ctx, SERVER_ACTOR);

	/**
	 * Write an activity-log entry for what the merchant's staff or server did, with the target's label (the payment's
	 * reference, else its id) and a short plain-text detail (PLAN 0.8.10 K9).
	 * @param {any} ctx @param {string} action @param {string} target @param {string} label @param {string} detail
	 */
	const log = (ctx, action, target, label, detail) =>
		product.activity.record(
			{ websiteId: ctx.websiteId, merchantId: ctx.merchantId, after: ctx.after },
			{ actor: who(ctx), action, target, label, detail },
		);

	/**
	 * The look of the hosted pages: the website's texts and theme, and its Format for money (PLAN 0.8.10 K7) and for
	 * amounts payers type (its decimal sign, P6).
	 * @param {string} websiteId
	 */
	const lookOf = async (websiteId) => {
		const theme = await product.settings.theme(websiteId);
		const { money, format } = await product.format(websiteId);
		return { texts: await product.settings.texts(websiteId), theme, money, decimalSign: decimalSignOf(format.locale) };
	};

	/**
	 * A payment of the website, or 404.
	 * @param {Site} s @param {unknown} id
	 */
	const paymentOf = async (s, id) => {
		const payment = isId(id, 'pay') ? await s.store.payments.get(id) : null;
		if (!payment) throw problem('not_found', 'No such payment.');
		return payment;
	};

	/**
	 * The gateways and manual payment methods a payer may pick, with the names they see (a manual method's own name and
	 * its details).
	 * @param {Site} s @param {Record<string, string>} texts @param {string} currency @param {readonly string[] | null} [only]
	 * @returns {Promise<Array<{ id: string, name: string, details: string }>>}
	 */
	const choices = async (s, texts, currency, only = null) => {
		const list = await service.available(s, currency, only);
		const methods = new Map((await service.methodsOf(s)).map((method) => [method.key, method]));
		return Promise.all(
			list.map(async (id) => {
				const method = isGateway(id) ? undefined : methods.get(id);
				if (method) return { id, name: method.name, details: method.details };
				// a custom gateway by its own name (P4)
				const keys = isCustomGateway(id) ? await service.keysOf(s, id) : null;
				return { id, name: gatewayName(texts, id, String(keys?.name ?? '')), details: '' };
			}),
		);
	};

	/**
	 * The payments list's filters (`?status=&q=`), shared by the list and its counts; an unknown status or an empty
	 * search filters nothing.
	 * @param {any} ctx
	 * @returns {import('../adapters/store.js').PaymentQuery}
	 */
	const paymentQuery = (ctx) => ({
		status: /** @type {readonly string[]} */ (PAYMENT_STATUSES).includes(ctx.query.status) ? ctx.query.status : undefined,
		q: typeof ctx.query.q === 'string' && ctx.query.q.trim() !== '' ? ctx.query.q : undefined,
	});

	/**
	 * One page of payments (`?cursor=&limit=&status=&q=`), newest first.
	 * @param {any} ctx
	 */
	const listPayments = async (ctx) => {
		const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 25 });
		const s = await siteOf(ctx);
		const rows = await s.store.payments.list({ after: page.after, limit: page.fetchLimit, ...paymentQuery(ctx) });
		return page.respond(
			rows.map((payment) => service.view(s, payment)),
			(view) => [view.createdAt, view.id],
		);
	};

	/**
	 * Counts of the payments list (PLAN 0.8.10 K4): `/count` with the list's filters, `/counts?by=state|gateway` (`state`
	 * is the payment's status; `none` for a payment no gateway was picked for yet).
	 */
	const paymentCounts = countHandlers({
		source: async (ctx) => createStore(await ctx.data(), { now: product.now }).payments.counted(paymentQuery(ctx)),
		by: { state: 'status', gateway: 'gateway' },
	});

	/** @param {any} ctx */
	const readPayment = async (ctx) => {
		const s = await siteOf(ctx);
		return service.view(s, await service.recheck(s, await paymentOf(s, ctx.params.id)));
	};

	/** @param {any} ctx */
	const refundPayment = async (ctx) => {
		const s = await siteOf(ctx);
		const body = typeof ctx.body === 'object' && ctx.body !== null ? ctx.body : {};
		const refunded = await service.refund(s, await paymentOf(s, ctx.params.id), body, who(ctx));
		const refund = /** @type {import('../adapters/store.js').PaymentRecord['refunds'][number]} */ (refunded.refunds.at(-1));
		const { money } = await product.format(s.websiteId);
		const texts = await product.settings.texts(s.websiteId);
		// the detail is data and the website's own words (P11): the amount, a manual refund's mark, the reason
		await log(
			ctx,
			'payment.refunded',
			refunded.id,
			refunded.reference || refunded.id,
			details(money(refund.amount, refunded.currency), refund.manual ? (texts['admin.manual'] ?? '') : '', refund.reason),
		);
		return created(service.view(s, refunded));
	};

	/**
	 * The merchant confirms the money of a manual payment arrived: `{ reference?, note? }` are kept with the
	 * confirmation (PLAN 0.8.10 P3).
	 * @param {any} ctx
	 */
	const confirmPayment = async (ctx) => {
		const checked = checkTransferInput(ctx.body, { note: true });
		if (!checked.ok) return invalid(checked.field, checked.message);
		const s = await siteOf(ctx);
		const paid = await service.confirmManual(s, await paymentOf(s, ctx.params.id), who(ctx), checked.value);
		const { money } = await product.format(s.websiteId);
		const { reference } = checked.value;
		await log(
			ctx,
			'payment.manual_confirmed',
			paid.id,
			paid.reference || paid.id,
			`${paid.manual?.name ?? 'Payment'} of ${money(paid.amount, paid.currency)} confirmed${reference ? ` (reference ${reference})` : ''}`,
		);
		return service.view(s, paid);
	};

	/**
	 * The merchant's server or Ecommerce cancels a payment it no longer wants, for example because its order was
	 * canceled or expired (K-13): `{ reason? }` (at most 200 characters, kept in the history). Answers the payment.
	 * @param {any} ctx
	 */
	const cancelPayment = async (ctx) => {
		const reason = cleanText(ctx.body?.reason, 200);
		if (reason === null) return invalid('reason', 'reason is one line of at most 200 characters.');
		const s = await siteOf(ctx);
		const payment = await paymentOf(s, ctx.params.id);
		const voided = await service.voidPayment(s, payment, reason, who(ctx));
		// the detail is the merchant's own reason (P11)
		if (payment.status !== 'voided') await log(ctx, 'payment.voided', voided.id, voided.reference || voided.id, reason);
		return service.view(s, voided);
	};

	/**
	 * The manual payment methods as payers see them (`?currency=`: only that currency's accounts, and ready for it).
	 * @param {any} ctx
	 */
	const manualMethods = async (ctx) => {
		const currency = typeof ctx.query.currency === 'string' && ctx.query.currency !== '' ? ctx.query.currency : null;
		if (currency !== null && !/^[A-Z]{3}$/.test(currency))
			return invalid('currency', 'currency is an ISO 4217 code (USD, EUR …).');
		const methods = await product.lists.get(ctx.websiteId, 'manual_methods');
		return { methods: methods.map((method) => methodView(method, currency)) };
	};

	/** What each gateway's adapter says the merchant registers in its console (P12). */
	const declared = Object.freeze(
		Object.fromEntries(
			Object.entries(product.gateways).map(([gateway, adapter]) => [
				// custom gateways run on the generic adapter, each by its own key (P4)
				gateway === 'generic' ? 'generic:<key>' : gateway,
				adapter.addresses,
			]),
		),
	);

	/**
	 * The dashboard's Developers tab: each gateway's console addresses for this website, by its dashboard name (P12).
	 * @param {any} ctx
	 */
	const gatewayAddressList = async (ctx) => {
		const websiteId = String(ctx.params.websiteId);
		const base = product.address() ?? new URL(ctx.request.url).origin;
		const names = new Map(manifest.features.map((feature) => [feature.key, feature.name]));
		// the website's custom gateways (P4), each by its own key and name
		/** @type {Record<string, ReadonlyArray<'notice' | 'return'>>} */
		const own = { ...declared };
		delete own['generic:<key>'];
		for (const connection of CUSTOM_GATEWAY_CONNECTIONS) {
			const value = await product.connections.value(websiteId, connection);
			if (typeof value !== 'object' || value === null || product.gateways.generic.violation(value) !== null) continue;
			const keys = /** @type {Record<string, any>} */ (value);
			own[`generic:${keys.slug}`] = product.gateways.generic.addresses;
			names.set(`generic:${keys.slug}`, String(keys.name));
		}
		return {
			items: gatewayAddresses(base, websiteId, own).map((entry) => ({
				gateway: entry.gateway,
				name: names.get(entry.gateway) ?? names.get(GATEWAY_FEATURES[adapterOf(entry.gateway)]) ?? entry.gateway,
				urls: entry.urls,
			})),
		};
	};

	/** A presigned link to a payment's proof (5 minutes). @param {any} ctx */
	const proofLink = async (ctx) => {
		const s = await siteOf(ctx);
		const payment = await paymentOf(s, ctx.params.id);
		if (!payment.proof) throw problem('not_found', 'This payment has no proof.');
		const storage = await product.connections.storage(s.websiteId);
		if (!storage) throw problem('storage_not_connected', 'Storage not connected: connect it in the product dashboard.');
		const signed = storage.presignGet({ key: payment.proof.key, expiresIn: PROOF_SECONDS });
		return { url: signed.url, expiresAt: signed.expiresAt };
	};

	/** @param {any} ctx */
	const listSubscriptions = async (ctx) => {
		const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 25 });
		const s = await siteOf(ctx);
		const status = /** @type {readonly string[]} */ (SUBSCRIPTION_STATUSES).includes(ctx.query.status)
			? ctx.query.status
			: undefined;
		const rows = await s.store.subscriptions.list({ after: page.after, limit: page.fetchLimit, status });
		return page.respond(rows.map(subscriptionView), (view) => [view.createdAt, view.id]);
	};

	/**
	 * Cancel a subscription at its gateway: `{ reason? }` (one line of at most 128 characters, PayPal's limit). Without
	 * one, the website's text `subs.defaultReason` is the reason (P11): gateways that need a reason never get words made
	 * in code.
	 * @param {any} ctx
	 */
	const cancelSubscription = async (ctx) => {
		const given = cleanText(ctx.body?.reason, 128);
		if (given === null) return invalid('reason', 'reason is one line of at most 128 characters.');
		const s = await siteOf(ctx);
		const found = isId(ctx.params.id, 'sub') ? await s.store.subscriptions.get(ctx.params.id) : null;
		if (!found) throw problem('not_found', 'No such subscription.');
		const texts = await product.settings.texts(s.websiteId);
		const reason = given || cleanText(texts['subs.defaultReason'], 128) || found.plan;
		const canceled = await service.cancelSubscription(s, found, who(ctx), reason);
		await log(
			ctx,
			'subscription.canceled',
			canceled.id,
			canceled.reference || canceled.id,
			details(gatewayName(texts, canceled.gateway), canceled.plan, reason),
		);
		return subscriptionView(canceled);
	};

	/**
	 * A new payment link (API or the Payment links admin widget).
	 * @param {any} ctx
	 */
	const createLink = async (ctx) => {
		const checked = checkLinkInput(ctx.body);
		if (!checked.ok) return invalid(checked.field, checked.message);
		const s = await siteOf(ctx);
		if (!service.allowedReturn(s, checked.value.returnUrl))
			return invalid('returnUrl', `returnUrl must be on https://${s.domain} (or a local address while testing).`, 'origin');
		const link = await s.store.links.add(checked.value);
		const { money } = await product.format(s.websiteId);
		await log(
			ctx,
			'link.created',
			link.id,
			link.title,
			link.amount === null ? link.currency : money(link.amount, link.currency),
		);
		return created(linkView(link, service.linkUrl(s, link.id), product.now()));
	};

	/**
	 * One page of payment links (`?cursor=&limit=`), newest first.
	 * @param {any} ctx
	 */
	const listLinks = async (ctx) => {
		const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 25 });
		const s = await siteOf(ctx);
		const rows = await s.store.links.list({ after: page.after, limit: page.fetchLimit });
		return page.respond(
			rows.map((link) => linkView(link, service.linkUrl(s, link.id), product.now())),
			(view) => [view.createdAt, view.id],
		);
	};

	/** @param {any} ctx */
	const readLink = async (ctx) => {
		const s = await siteOf(ctx);
		const link = isId(ctx.params.id, 'link') ? await s.store.links.get(ctx.params.id) : null;
		return link ? linkView(link, service.linkUrl(s, link.id), product.now()) : problem('not_found', 'No such link.');
	};

	/**
	 * Turn a payment link off (its page is gone) or on again: `{ active }`.
	 * @param {any} ctx
	 */
	const switchLink = async (ctx) => {
		if (typeof ctx.body?.active !== 'boolean') return invalid('active', 'active is true or false.');
		const s = await siteOf(ctx);
		const link = isId(ctx.params.id, 'link') ? await s.store.links.setActive(ctx.params.id, ctx.body.active) : null;
		if (!link) return problem('not_found', 'No such link.');
		await log(ctx, link.active ? 'link.turned_on' : 'link.turned_off', link.id, link.title, '');
		return linkView(link, service.linkUrl(s, link.id), product.now());
	};

	/**
	 * A payment link of the website that is on, active and has not ended by itself (its date, its payments; P3), or null.
	 * @param {Site} s @param {unknown} id
	 */
	const activeLink = async (s, id) => {
		if (!s.on.includes('payment_links') || !isId(id, 'link')) return null;
		const link = await s.store.links.get(id);
		return link?.active && linkClosed(link, product.now()) === null ? link : null;
	};

	/**
	 * A payment from a link, with what the payer entered.
	 * @param {Site} s
	 * @param {import('../adapters/store.js').LinkRecord} link
	 * @param {{ amount: number | null, gateway: unknown, name: unknown, email: unknown, phone: unknown, answers: unknown }} input
	 *   `amount`: what the payer entered, in minor units (null when it is not an amount); `phone` and `answers` what the
	 *   link asks (P3)
	 * @returns {Promise<{ ok: true, payment: import('../adapters/store.js').PaymentRecord } |
	 *   { ok: false, field: string, key: string, label?: string }>}
	 */
	const payLink = async (s, link, input) => {
		const amount = link.amount ?? input.amount;
		if (amount === null || (link.amount === null && amount < Number(link.minAmount ?? 1)))
			return { ok: false, field: 'amount', key: 'link.invalidAmount' };
		const customer = checkCustomer({ name: input.name ?? '', email: input.email ?? '' });
		if (!customer.ok) return { ok: false, field: 'email', key: 'link.invalidEmail' };
		// what the link asks beyond the amount (P3)
		const asked = checkLinkAnswers(link, { phone: input.phone, answers: input.answers });
		if (!asked.ok)
			return asked.field === 'phone'
				? { ok: false, field: 'phone', key: 'link.invalidPhone' }
				: {
						ok: false,
						field: `answers/${asked.index}`,
						key: 'link.invalidAnswer',
						label: link.fields[Number(asked.index)]?.label ?? '',
					};
		const gateways = await service.available(s, link.currency, link.gateways);
		if (!isPaymentMethod(input.gateway) || !gateways.includes(input.gateway))
			return { ok: false, field: 'gateway', key: 'link.invalidMethod' };
		const payment = await service.createPayment(
			s,
			{
				amount,
				currency: link.currency,
				gateway: input.gateway,
				description: link.title,
				reference: link.reference,
				customer: { ...customer.value, ...(asked.phone ? { phone: asked.phone } : {}) },
				metadata: {},
				answers: asked.answers,
				returnUrl: link.returnUrl,
				cancelUrl: null,
			},
			{ source: 'link', linkId: link.id },
		);
		return { ok: true, payment };
	};

	/**
	 * The pay page of a payment: where it stands, or the next step.
	 * @param {any} ctx
	 */
	const payPage = async (ctx) => {
		const { websiteId, paymentId } = ctx.params;
		const s = await publicSite(ctx, websiteId);
		if (!s) return html(renderResultPage({ ...NO_SITE_LOOK, state: 'unavailable' }), 404);
		const look = await lookOf(websiteId);
		const found = isId(paymentId, 'pay') ? await s.store.payments.get(paymentId) : null;
		if (!found) return html(renderResultPage({ ...look, state: 'notFound' }), 404);
		let payment = await service.recheck(s, found);
		const business = (await product.business(websiteId)).name;
		const result = { ...look, business, amount: payment.amount, currency: payment.currency };
		const back = payment.returnUrl ? withParam(payment.returnUrl, 'ss_payment', payment.id) : null;
		if (payment.status === 'paid' || payment.status === 'partially_refunded')
			return html(renderResultPage({ ...result, state: isRefundDue(payment) ? 'refundDue' : 'paid', backUrl: back }));
		if (payment.status === 'refunded') return html(renderResultPage({ ...result, state: 'refunded', backUrl: back }));
		// the merchant canceled it: nobody pays it any more (K-13)
		if (payment.status === 'voided') return html(renderResultPage({ ...result, state: 'voided', backUrl: back }));
		if (payment.status === 'failed' || payment.status === 'canceled')
			return html(
				renderResultPage({ ...result, state: payment.status, retry: `/pay/${websiteId}/${payment.id}`, backUrl: back }),
			);
		if (payment.gateway === null) {
			const options = await choices(s, look.texts, payment.currency);
			return html(
				renderChoicePage({
					...look,
					business,
					amount: payment.amount,
					currency: payment.currency,
					description: payment.description,
					gateways: options,
					action: `/pay/${websiteId}/${payment.id}`,
				}),
			);
		}
		const started = await service.start(s, payment, payment.gateway);
		if (!started.ok) return html(renderResultPage({ ...result, state: 'error' }), 502);
		payment = started.payment;
		if (payment.manual) {
			const method = await service.methodOf(s, payment.gateway);
			// a method removed since: its name only (the merchant tells the payer the rest)
			const shown = method
				? methodView(method, payment.currency)
				: { ...payment.manual, details: '', instructions: '', proof: false, accounts: [] };
			const storage = shown.proof ? await product.connections.storage(websiteId) : null;
			return html(
				renderManualPage({
					...look,
					business,
					amount: payment.amount,
					currency: payment.currency,
					reference: payment.reference || payment.id,
					method: shown,
					proof: storage ? { action: `/pay/${websiteId}/${payment.id}/proof` } : null,
					uploaded: payment.proof !== null,
				}),
			);
		}
		const checkout = /** @type {NonNullable<typeof payment.checkout>} */ (payment.checkout);
		if (checkout.kind === 'redirect') return seeOther(checkout.url);
		const keys = isCustomGateway(payment.gateway) ? await service.keysOf(s, payment.gateway) : null;
		return html(
			renderGatewayForm({
				...look,
				business,
				amount: payment.amount,
				currency: payment.currency,
				gateway: gatewayName(look.texts, String(payment.gateway), String(keys?.name ?? '')),
				action: checkout.action,
				fields: checkout.fields,
			}),
		);
	};

	/**
	 * The payer picked a gateway, or tries again after a failed or canceled attempt.
	 * @param {any} ctx
	 */
	const payPick = async (ctx) => {
		const { websiteId, paymentId } = ctx.params;
		const s = await publicSite(ctx, websiteId);
		if (!s) return html(renderResultPage({ texts: strings, state: 'unavailable' }), 404);
		const payment = isId(paymentId, 'pay') ? await s.store.payments.get(paymentId) : null;
		if (!payment) return html(renderResultPage({ ...(await lookOf(websiteId)), state: 'notFound' }), 404);
		const form = Object.fromEntries(formFields(ctx.rawBody));
		if (form.retry === '1' && (payment.status === 'failed' || payment.status === 'canceled'))
			await s.store.payments.change(
				payment.id,
				['failed', 'canceled'],
				{ status: 'pending', gateway: null, checkout: null },
				{ event: 'retried' },
			);
		else if (isPaymentMethod(form.gateway) && payment.status === 'pending' && payment.gateway === null) {
			const started = await service.start(s, payment, form.gateway);
			if (!started.ok)
				return html(
					renderResultPage({
						...(await lookOf(websiteId)),
						state: 'error',
						amount: payment.amount,
						currency: payment.currency,
					}),
					502,
				);
		}
		return seeOther(`/pay/${websiteId}/${payment.id}`);
	};

	/**
	 * The payer came back from a gateway (or canceled there).
	 * @param {any} ctx
	 */
	const returned = async (ctx) => {
		const { gateway, websiteId, id } = ctx.params;
		const s = await publicSite(ctx, websiteId);
		if (!s) return html(renderResultPage({ texts: strings, state: 'unavailable' }), 404);
		const notFound = async () => html(renderResultPage({ ...(await lookOf(websiteId)), state: 'notFound' }), 404);
		if (isId(id, 'sub')) {
			const subscription = await s.store.subscriptions.get(id);
			if (!subscription) return notFound();
			if (gateway === 'cancel')
				return seeOther(withParam(subscription.cancelUrl ?? subscription.returnUrl, 'ss_subscription', id));
			const checked = await service.recheckSubscription(s, subscription);
			return seeOther(withParam(checked.returnUrl, 'ss_subscription', id));
		}
		const payment = isId(id, 'pay') ? await s.store.payments.get(id) : null;
		if (!payment) return notFound();
		if (gateway === 'cancel') {
			await s.store.payments.change(
				payment.id,
				['pending'],
				{ status: 'canceled' },
				{ event: 'canceled', detail: 'by the payer' },
			);
			return seeOther(
				payment.cancelUrl ? withParam(payment.cancelUrl, 'ss_payment', payment.id) : `/pay/${websiteId}/${payment.id}`,
			);
		}
		if (payment.gateway === gateway && isGateway(gateway)) {
			const adapter = product.gateways[adapterOf(gateway)];
			const keys = await service.keysOf(s, gateway);
			if (keys && adapter.returned) {
				const url = new URL(ctx.request.url);
				const answer = await adapter.returned(
					{ rawBody: ctx.rawBody, headers: ctx.headers, query: ctx.query, self: `${s.base}${url.pathname}` },
					{ ...payment, websiteId },
					keys,
					{ send: product.send, now: product.now },
				);
				if (answer.next && answer.next.kind === 'form') {
					const look = await lookOf(websiteId);
					return html(
						renderGatewayForm({
							...look,
							business: (await product.business(websiteId)).name,
							amount: payment.amount,
							currency: payment.currency,
							gateway: gatewayName(look.texts, gateway),
							action: answer.next.action,
							fields: answer.next.fields,
						}),
					);
				}
				if (answer.news) await service.applyPayment(s, gateway, answer.news, 'payer returned');
			}
		}
		const after = /** @type {import('../adapters/store.js').PaymentRecord} */ (await s.store.payments.get(payment.id));
		if (after.returnUrl && after.status !== 'failed') return seeOther(withParam(after.returnUrl, 'ss_payment', after.id));
		return seeOther(`/pay/${websiteId}/${after.id}`);
	};

	/**
	 * A gateway's signed notice (webhook, ITN, callback), checked with the website's keys for that gateway; a custom
	 * gateway's (`/v1/gateways/generic/:slug/…`) with its own connection's (P4).
	 * @param {Exclude<Gateway, 'jazzcash' | 'easypaisa' | 'generic'> | ((ctx: any) => string)} which the gateway, or how
	 *   to read it from the request
	 */
	const notice = (which) => async (/** @type {any} */ ctx) => {
		const gateway = typeof which === 'function' ? which(ctx) : which;
		const s = await publicSite(ctx, ctx.params.websiteId);
		if (!s || !isGateway(gateway) || !s.on.includes(GATEWAY_FEATURES[adapterOf(gateway)]))
			return problem('not_found', 'Notices are not received for this website.');
		const keys = await service.keysOf(s, gateway);
		const adapter = product.gateways[adapterOf(gateway)];
		if (!keys || !adapter.notice) return problem('not_found', 'Notices are not received for this website.');
		const checked = await adapter.notice({ rawBody: ctx.rawBody, headers: ctx.headers, query: ctx.query }, keys, {
			send: product.send,
			now: product.now,
		});
		if (!checked.ok) return problem('unauthorized', 'The notice is not signed by the gateway.');
		await service.apply(s, gateway, checked.news, `${gateway} notice`);
		return { received: true };
	};

	/**
	 * The proof upload of a payer of a manual payment whose method takes proofs: a presigned PUT into the merchant's
	 * storage, then its confirmation, which may name the payment's own `reference` (PLAN 0.8.10 P3).
	 * @param {'presign' | 'done'} step
	 */
	const proofUpload = (step) => async (/** @type {any} */ ctx) => {
		const { websiteId, paymentId } = ctx.params;
		const s = await publicSite(ctx, websiteId);
		const payment = s && isId(paymentId, 'pay') ? await s.store.payments.get(paymentId) : null;
		if (!s || !payment || !payment.manual || payment.status !== 'pending' || payment.proof !== null)
			return problem('not_found', 'No proof can be uploaded for this payment.');
		const method = await service.methodOf(s, payment.gateway);
		const storage = method?.proof === true ? await product.connections.storage(websiteId) : null;
		if (!storage) return problem('storage_not_connected', 'Proofs cannot be uploaded for this website.');
		const body = typeof ctx.body === 'object' && ctx.body !== null ? ctx.body : {};
		const prefix = `payments/proofs/${payment.id}.`;
		if (step === 'presign') {
			const extension = Object.hasOwn(PROOF_TYPES, body.type)
				? PROOF_TYPES[/** @type {keyof typeof PROOF_TYPES} */ (body.type)]
				: null;
			if (!extension) return invalid('type', 'Upload a JPEG, PNG or WebP photo or a PDF.');
			const max = PROOF_MAX_MB * 1_048_576;
			if (!Number.isSafeInteger(body.size) || body.size < 1 || body.size > max)
				return invalid('size', `The largest proof is ${PROOF_MAX_MB} MB.`);
			const signed = storage.presignPut({
				key: `${prefix}${extension}`,
				contentType: body.type,
				contentLength: body.size,
				expiresIn: PROOF_SECONDS,
			});
			return { upload: { method: signed.method, url: signed.url, headers: signed.headers }, key: signed.key };
		}
		if (
			typeof body.key !== 'string' ||
			!body.key.startsWith(prefix) ||
			!Object.values(PROOF_TYPES).includes(body.key.slice(prefix.length))
		)
			return invalid('key', 'Name the uploaded proof.');
		const checked = checkTransferInput(body);
		if (!checked.ok) return invalid(checked.field, checked.message);
		const head = await storage.headObject({ key: body.key });
		if (!head.exists) return invalid('key', 'The proof was not uploaded.');
		const proof = { key: body.key, type: String(head.contentType ?? ''), size: head.size };
		if (!(await service.recordProof(s, payment, proof, checked.value.reference)))
			return problem('not_found', 'No proof can be uploaded for this payment.');
		return { uploaded: true };
	};

	/**
	 * The hosted page of a payment link: GET shows it, POST makes the payment and sends the payer on.
	 * @param {'show' | 'pay'} step
	 */
	const linkPage = (step) => async (/** @type {any} */ ctx) => {
		const { websiteId, linkId } = ctx.params;
		const s = await publicSite(ctx, websiteId);
		if (!s) return html(renderResultPage({ ...NO_SITE_LOOK, state: 'notFound' }), 404);
		const look = await lookOf(websiteId);
		const link = await activeLink(s, linkId);
		if (!link) return html(renderResultPage({ ...look, state: 'notFound' }), 404);
		const business = (await product.business(websiteId)).name;
		const gateways = await choices(s, look.texts, link.currency, link.gateways);
		const action = `/l/${websiteId}/${link.id}`;
		if (step === 'show') return html(renderLinkPage({ ...look, business, link, gateways, action }));
		const form = Object.fromEntries(formFields(ctx.rawBody));
		// the payer types the amount with the decimal sign the page shows money with (P6)
		const made = await payLink(s, link, {
			amount: amountOf(form.amount, link.currency, look.decimalSign),
			gateway: form.gateway,
			name: form.name,
			email: form.email,
			phone: form.phone,
			answers: link.fields.map((_, index) => form[`field_${index}`] ?? ''),
		});
		if (made.ok) return seeOther(`/pay/${websiteId}/${made.payment.id}`);
		const error = formatText(look.texts[made.key] ?? made.key, {
			min: look.money(Number(link.minAmount ?? 1), link.currency),
			label: made.label ?? '',
		});
		return html(renderLinkPage({ ...look, business, link, gateways, action, error, values: form }), 422);
	};

	return [
		// the widgets' script: public and the same for every website (no token, no Origin needed)
		defineRoute({
			method: 'GET',
			path: '/widget.js',
			auth: 'none',
			handler: () =>
				new Response(WIDGET_SCRIPT, {
					headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=300' },
				}),
		}),
		// the hosted pages' script
		defineRoute({
			method: 'GET',
			path: '/pay.js',
			auth: 'none',
			handler: () =>
				new Response(PAY_SCRIPT, {
					headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=300' },
				}),
		}),

		// ------------------------------------------------------------------------------- the payment API (server)
		defineRoute({
			method: 'POST',
			path: '/v1/payments',
			auth: 'server',
			runtime: true,
			feature: 'payment_api',
			idempotent: true,
			rateLimit: SERVER_LIMITS,
			handler: async (ctx) => {
				const checked = checkPaymentInput(ctx.body);
				if (!checked.ok) return invalid(checked.field, checked.message);
				const s = await siteOf(ctx);
				const payment = await service.createPayment(s, checked.value, { source: 'api' });
				return created(service.view(s, payment));
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/payments',
			auth: 'server',
			permission: 'payments.read',
			feature: 'payment_api',
			handler: listPayments,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/payments/count',
			auth: 'server',
			permission: 'payments.read',
			feature: 'payment_api',
			handler: paymentCounts.count,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/payments/counts',
			auth: 'server',
			permission: 'payments.read',
			feature: 'payment_api',
			handler: paymentCounts.counts,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/payments/:id',
			auth: 'server',
			runtime: true,
			feature: 'payment_api',
			handler: readPayment,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/payments/:id/cancel',
			auth: 'server',
			runtime: true,
			feature: 'payment_api',
			rateLimit: SERVER_LIMITS,
			handler: cancelPayment,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/payments/:id/verify',
			auth: 'server',
			runtime: true,
			feature: 'payment_api',
			rateLimit: SERVER_LIMITS,
			handler: async (ctx) => {
				const body = typeof ctx.body === 'object' && ctx.body !== null ? ctx.body : {};
				const s = await siteOf(ctx);
				const payment = await service.recheck(s, await paymentOf(s, ctx.params.id));
				return { verified: isConfirmedFor(payment, body), payment: service.view(s, payment) };
			},
		}),
		// payment events (the kit's, PLAN 0.8.10 K5): `?since=&types=&cursor=&limit=`, newest first, and their counts
		defineRoute({
			method: 'GET',
			path: '/v1/events',
			auth: 'server',
			permission: 'payments.read',
			feature: 'payment_api',
			handler: (ctx) => product.events.list(ctx),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/events/count',
			auth: 'server',
			permission: 'payments.read',
			feature: 'payment_api',
			handler: (ctx) => product.events.count(ctx),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/events/counts',
			auth: 'server',
			permission: 'payments.read',
			feature: 'payment_api',
			handler: (ctx) => product.events.counts(ctx),
		}),
		// the manual payment methods as payers see them, for the merchant's server (fixed-choices P1, P2): each one's
		// words, whether it is ready and, with ?currency=, the accounts of that currency; Ecommerce reads it with its
		// pasted Payments token
		defineRoute({
			method: 'GET',
			path: '/v1/manual-methods',
			auth: 'server',
			runtime: true,
			feature: 'manual_payments',
			database: false,
			handler: manualMethods,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/payments/:id/confirm',
			auth: 'server',
			permission: 'payments.confirm',
			feature: 'manual_payments',
			handler: confirmPayment,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/payments/:id/proof',
			auth: 'server',
			permission: 'payments.confirm',
			feature: 'manual_payments',
			handler: proofLink,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/payments/:id/refunds',
			auth: 'server',
			permission: 'payments.refund',
			feature: 'refunds',
			idempotent: true,
			rateLimit: SERVER_LIMITS,
			handler: refundPayment,
		}),

		// ------------------------------------------------------------------------------------------ payment links
		defineRoute({
			method: 'POST',
			path: '/v1/links',
			auth: 'server',
			permission: 'links.manage',
			feature: 'payment_links',
			idempotent: true,
			rateLimit: SERVER_LIMITS,
			handler: createLink,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/links',
			auth: 'server',
			permission: 'links.read',
			feature: 'payment_links',
			handler: listLinks,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/links/:id',
			auth: 'server',
			permission: 'links.read',
			feature: 'payment_links',
			handler: readLink,
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/links/:id',
			auth: 'server',
			permission: 'links.manage',
			feature: 'payment_links',
			handler: switchLink,
		}),

		// ------------------------------------------------------------------------------------------- subscriptions
		defineRoute({
			method: 'POST',
			path: '/v1/subscriptions',
			auth: 'server',
			runtime: true,
			feature: 'subscriptions',
			idempotent: true,
			rateLimit: SERVER_LIMITS,
			handler: async (ctx) => {
				const checked = checkSubscriptionInput(ctx.body);
				if (!checked.ok) return invalid(checked.field, checked.message);
				const s = await siteOf(ctx);
				const subscription = await service.subscribe(s, checked.value);
				return created({ ...subscriptionView(subscription), checkoutUrl: subscription.checkoutUrl });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/subscriptions',
			auth: 'server',
			permission: 'subscriptions.read',
			feature: 'subscriptions',
			handler: listSubscriptions,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/subscriptions/:id',
			auth: 'server',
			runtime: true,
			feature: 'subscriptions',
			handler: async (ctx) => {
				const s = await siteOf(ctx);
				const found = isId(ctx.params.id, 'sub') ? await s.store.subscriptions.get(ctx.params.id) : null;
				return found ? subscriptionView(found) : problem('not_found', 'No such subscription.');
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/subscriptions/:id/cancel',
			auth: 'server',
			permission: 'subscriptions.cancel',
			feature: 'subscriptions',
			handler: cancelSubscription,
		}),

		// ------------------------------------------------------------------------------ the pay button (visitors)
		defineRoute({
			method: 'GET',
			path: '/v1/checkout/links/:id',
			auth: 'browser',
			feature: 'payment_links',
			rateLimit: VISITOR_LIMITS,
			handler: async (ctx) => {
				const s = await siteOf(ctx);
				const link = await activeLink(s, ctx.params.id);
				if (!link) return problem('not_found', 'No such link.');
				const texts = await product.settings.texts(s.websiteId);
				return {
					id: link.id,
					title: link.title,
					description: link.description,
					amount: link.amount,
					minAmount: link.minAmount,
					currency: link.currency,
					phone: link.phone,
					fields: link.fields,
					gateways: await choices(s, texts, link.currency, link.gateways),
				};
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/checkout/links/:id',
			auth: 'browser',
			feature: 'payment_links',
			rateLimit: VISITOR_LIMITS,
			handler: async (ctx) => {
				const s = await siteOf(ctx);
				const link = await activeLink(s, ctx.params.id);
				if (!link) return problem('not_found', 'No such link.');
				const body = typeof ctx.body === 'object' && ctx.body !== null ? ctx.body : {};
				const made = await payLink(s, link, {
					amount: fromDecimal(body.amount, link.currency),
					gateway: body.gateway,
					name: body.customer?.name,
					email: body.customer?.email,
					phone: body.customer?.phone,
					answers: body.answers,
				});
				if (!made.ok)
					return invalid(
						made.field,
						formatText(strings[/** @type {keyof typeof strings} */ (made.key)] ?? made.key, { label: made.label ?? '' }),
					);
				return created({ paymentId: made.payment.id, checkoutUrl: service.payUrl(s, made.payment.id) });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/checkout/payments/:id',
			auth: 'browser',
			feature: 'payment_api',
			rateLimit: VISITOR_LIMITS,
			handler: async (ctx) => {
				const s = await siteOf(ctx);
				const payment = await paymentOf(s, ctx.params.id);
				return {
					id: payment.id,
					status: payment.status,
					amount: payment.amount,
					currency: payment.currency,
					description: payment.description,
					checkoutUrl: service.payUrl(s, payment.id),
				};
			},
		}),

		// ------------------------------------------------------------------------- admin widgets (tickets)
		defineRoute({
			method: 'GET',
			path: '/v1/admin/payments',
			auth: 'ticket',
			permission: 'payments.read',
			handler: listPayments,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/payments/count',
			auth: 'ticket',
			permission: 'payments.read',
			handler: paymentCounts.count,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/payments/counts',
			auth: 'ticket',
			permission: 'payments.read',
			handler: paymentCounts.counts,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/payments/:id',
			auth: 'ticket',
			permission: 'payments.read',
			handler: readPayment,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/payments/:id/refunds',
			auth: 'ticket',
			permission: 'payments.refund',
			idempotent: true,
			handler: refundPayment,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/payments/:id/confirm',
			auth: 'ticket',
			permission: 'payments.confirm',
			handler: confirmPayment,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/payments/:id/proof',
			auth: 'ticket',
			permission: 'payments.confirm',
			handler: proofLink,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/links',
			auth: 'ticket',
			permission: 'links.read',
			handler: listLinks,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/dashboard/websites/:websiteId/gateway-addresses',
			auth: 'dashboard',
			handler: gatewayAddressList,
		}),
		// the manual payment methods a new link may offer (their keys and names)
		defineRoute({
			method: 'GET',
			path: '/v1/admin/manual-methods',
			auth: 'ticket',
			permission: 'links.manage',
			database: false,
			handler: async (ctx) => {
				const on = await product.featuresOn(ctx.websiteId);
				const methods = on.includes('manual_payments') ? await product.lists.get(ctx.websiteId, 'manual_methods') : [];
				return { methods: methods.map((method) => ({ key: method.key, name: method.name, kind: method.kind })) };
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/links',
			auth: 'ticket',
			permission: 'links.manage',
			idempotent: true,
			handler: createLink,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/links/:id',
			auth: 'ticket',
			permission: 'links.read',
			handler: readLink,
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/admin/links/:id',
			auth: 'ticket',
			permission: 'links.manage',
			handler: switchLink,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/subscriptions',
			auth: 'ticket',
			permission: 'subscriptions.read',
			handler: listSubscriptions,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/subscriptions/:id/cancel',
			auth: 'ticket',
			permission: 'subscriptions.cancel',
			handler: cancelSubscription,
		}),

		// ------------------------------------------------------------------------------- hosted pages (payers)
		defineRoute({
			method: 'GET',
			path: '/l/:websiteId/:linkId',
			auth: 'none',
			rateLimit: VISITOR_LIMITS,
			handler: linkPage('show'),
		}),
		defineRoute({
			method: 'POST',
			path: '/l/:websiteId/:linkId',
			auth: 'none',
			rawBody: true,
			rateLimit: VISITOR_LIMITS,
			handler: linkPage('pay'),
		}),
		defineRoute({
			method: 'GET',
			path: '/pay/:websiteId/:paymentId',
			auth: 'none',
			rateLimit: VISITOR_LIMITS,
			handler: payPage,
		}),
		defineRoute({
			method: 'POST',
			path: '/pay/:websiteId/:paymentId',
			auth: 'none',
			rawBody: true,
			rateLimit: VISITOR_LIMITS,
			handler: payPick,
		}),
		defineRoute({
			method: 'POST',
			path: '/pay/:websiteId/:paymentId/proof',
			auth: 'none',
			rateLimit: VISITOR_LIMITS,
			handler: proofUpload('presign'),
		}),
		defineRoute({
			method: 'POST',
			path: '/pay/:websiteId/:paymentId/proof/done',
			auth: 'none',
			rateLimit: VISITOR_LIMITS,
			handler: proofUpload('done'),
		}),
		// the payer coming back from a gateway: GET (PayFast Pakistan's signed answer in the query) or a form POST
		// (JazzCash, Easypaisa)
		defineRoute({
			method: 'GET',
			path: '/return/:gateway/:websiteId/:id',
			auth: 'none',
			rateLimit: VISITOR_LIMITS,
			handler: returned,
		}),
		defineRoute({
			method: 'POST',
			path: '/return/:gateway/:websiteId/:id',
			auth: 'none',
			rawBody: true,
			rateLimit: VISITOR_LIMITS,
			handler: returned,
		}),

		// --------------------------------------------------------------------------- the gateways' signed notices
		defineRoute({
			method: 'POST',
			path: '/v1/gateways/stripe/:websiteId',
			auth: 'none',
			rawBody: true,
			rateLimit: NOTICE_LIMITS,
			handler: notice('stripe'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/gateways/paypal/:websiteId',
			auth: 'none',
			rawBody: true,
			rateLimit: NOTICE_LIMITS,
			handler: notice('paypal'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/gateways/payfast/:websiteId',
			auth: 'none',
			rawBody: true,
			rateLimit: NOTICE_LIMITS,
			handler: notice('payfast'),
		}),
		// PayFast (Pakistan) calls its CHECKOUT_URL with the answer's fields in the query or a form body
		defineRoute({
			method: 'GET',
			path: '/v1/gateways/payfast_pk/:websiteId',
			auth: 'none',
			rateLimit: NOTICE_LIMITS,
			handler: notice('payfast_pk'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/gateways/payfast_pk/:websiteId',
			auth: 'none',
			rawBody: true,
			rateLimit: NOTICE_LIMITS,
			handler: notice('payfast_pk'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/gateways/rapid/:websiteId',
			auth: 'none',
			rawBody: true,
			rateLimit: NOTICE_LIMITS,
			handler: notice('rapid'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/gateways/generic/:slug/:websiteId',
			auth: 'none',
			rawBody: true,
			rateLimit: NOTICE_LIMITS,
			handler: notice((ctx) => `generic:${ctx.params.slug}`),
		}),

		// public docs: no sign-in, no tokens
		defineRoute({
			method: 'GET',
			path: '/docs',
			auth: 'none',
			handler: (ctx) =>
				new Response(renderDocs({ base: product.address() ?? new URL(ctx.request.url).origin, addresses: declared }), {
					headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
				}),
		}),
	];
};
