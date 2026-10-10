/**
 * Payments' routes (the kit adds its own: connect, notices, tickets, data rights, widget config, `/sso` and the
 * dashboard API). Every browser-token, server-token and ticket route belongs to one feature; `openapi.json` is
 * generated from these definitions (`ss app assets`), so `method`, `path`, `auth`, `feature` and `permission` stay
 * string literals. Public routes: the widget script, the docs, the hosted link and pay pages, the payer's return from a
 * gateway and the gateways' signed notices. Every website route sends due payment events right after it answers.
 * Public entry `./routes` of this package: `product.handler(createRoutes(product))`.
 * @module
 */
import { isId } from '@ss/contracts';
import { created, defineRoute, formatText, paginate, problem } from '@ss/app-kit';
import { GATEWAY_FEATURES, isGateway } from '../core/gateways.js';
import { formatMoney, fromDecimal } from '../core/money.js';
import {
	PAYMENT_STATUSES,
	SUBSCRIPTION_STATUSES,
	checkCustomer,
	checkLinkInput,
	checkPaymentInput,
	checkSubscriptionInput,
	isConfirmedFor,
	linkView,
	subscriptionView,
} from '../core/payments.js';
import { PROOF_TYPES } from '../core/widgets.js';
import { strings } from '../adapters/product.js';
import { formFields } from '../adapters/util.js';
import { renderDocs } from './docs.js';
import {
	PAGE_HEADERS,
	PAY_SCRIPT,
	gatewayName,
	renderBankPage,
	renderChoicePage,
	renderGatewayForm,
	renderLinkPage,
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

/** @param {string} field @param {string} message @param {string} [code] */
const invalid = (field, message, code = 'invalid') =>
	problem('validation_failed', message, { errors: [{ path: `/${field}`, message, code }] });

/** @param {string} body @param {number} [status] */
const html = (body, status = 200) => new Response(body, { status, headers: PAGE_HEADERS });

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
	 * The website of a token or ticket request; due events are sent right after the answer.
	 * @param {any} ctx
	 * @returns {Promise<Site>}
	 */
	const siteOf = async (ctx) => {
		const s = await service.site({
			websiteId: ctx.websiteId,
			merchantId: ctx.merchantId,
			domain: ctx.status.domain,
			base: new URL(ctx.request.url).origin,
		});
		ctx.after(() => service.drain(s));
		return s;
	};

	/**
	 * The website a public page or a gateway names: it must exist, be served and have its merchant database.
	 * @param {any} ctx
	 * @param {string} websiteId
	 * @returns {Promise<Site | null>}
	 */
	const publicSite = async (ctx, websiteId) => {
		if (!isId(websiteId, 'web')) return null;
		const serving = await product.serving(websiteId);
		if (!serving.ok || (await product.connections.value(websiteId, 'database')) === null) return null;
		const s = await service.site({
			websiteId,
			merchantId: serving.status.merchantId,
			domain: serving.status.domain,
			base: new URL(ctx.request.url).origin,
		});
		ctx.after(() => service.drain(s));
		return s;
	};

	/** Who acts: the member of the merchant's staff in the ticket, or the server. @param {any} ctx */
	const actorOf = (ctx) =>
		ctx.ticket ? { kind: 'staff', id: String(ctx.ticket.user.id), name: String(ctx.ticket.user.name) } : SERVER_ACTOR;

	/**
	 * Write an activity-log entry for what the merchant's staff or server did.
	 * @param {any} ctx @param {string} action @param {string} target
	 */
	const log = (ctx, action, target) =>
		product.activity.record(
			{ websiteId: ctx.websiteId, merchantId: ctx.merchantId, after: ctx.after },
			{ actor: actorOf(ctx), action, target },
		);

	/** @param {string} websiteId */
	const lookOf = async (websiteId) => {
		const theme = await product.settings.theme(websiteId);
		return { texts: await product.settings.texts(websiteId), theme };
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
	 * The gateways a payer may pick, with the names they see.
	 * @param {Site} s @param {Record<string, string>} texts @param {string} currency @param {readonly string[] | null} [only]
	 */
	const choices = async (s, texts, currency, only = null) => {
		const list = await service.available(s, currency, only);
		const keys = list.includes('generic') ? await service.keysOf(s, 'generic') : null;
		return list.map((id) => ({ id, name: gatewayName(texts, id, String(keys?.name ?? '')) }));
	};

	/**
	 * One page of payments (`?cursor=&limit=&status=&q=`), newest first.
	 * @param {any} ctx
	 */
	const listPayments = async (ctx) => {
		const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 25 });
		const s = await siteOf(ctx);
		const status = /** @type {readonly string[]} */ (PAYMENT_STATUSES).includes(ctx.query.status)
			? ctx.query.status
			: undefined;
		const q = typeof ctx.query.q === 'string' && ctx.query.q.trim() !== '' ? ctx.query.q : undefined;
		const rows = await s.store.payments.list({ after: page.after, limit: page.fetchLimit, status, q });
		return page.respond(
			rows.map((payment) => service.view(s, payment)),
			(view) => [view.createdAt, view.id],
		);
	};

	/** @param {any} ctx */
	const readPayment = async (ctx) => {
		const s = await siteOf(ctx);
		return service.view(s, await service.recheck(s, await paymentOf(s, ctx.params.id)));
	};

	/** @param {any} ctx */
	const refundPayment = async (ctx) => {
		const s = await siteOf(ctx);
		const body = typeof ctx.body === 'object' && ctx.body !== null ? ctx.body : {};
		const refunded = await service.refund(s, await paymentOf(s, ctx.params.id), body, actorOf(ctx));
		await log(ctx, 'payment.refunded', refunded.id);
		return created(service.view(s, refunded));
	};

	/** @param {any} ctx */
	const confirmPayment = async (ctx) => {
		const s = await siteOf(ctx);
		const paid = await service.confirmTransfer(s, await paymentOf(s, ctx.params.id), actorOf(ctx));
		await log(ctx, 'payment.transfer_confirmed', paid.id);
		return service.view(s, paid);
	};

	/** A presigned link to a bank-transfer proof (5 minutes). @param {any} ctx */
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

	/** @param {any} ctx */
	const cancelSubscription = async (ctx) => {
		const s = await siteOf(ctx);
		const found = isId(ctx.params.id, 'sub') ? await s.store.subscriptions.get(ctx.params.id) : null;
		if (!found) throw problem('not_found', 'No such subscription.');
		const cancelled = await service.cancelSubscription(s, found, actorOf(ctx));
		await log(ctx, 'subscription.cancelled', cancelled.id);
		return subscriptionView(cancelled);
	};

	/**
	 * A payment link of the website that is active and on, or null.
	 * @param {Site} s @param {unknown} id
	 */
	const activeLink = async (s, id) => {
		if (!s.on.includes('payment_links') || !isId(id, 'link')) return null;
		const link = await s.store.links.get(id);
		return link?.active ? link : null;
	};

	/**
	 * A payment from a link, with what the payer entered.
	 * @param {Site} s
	 * @param {import('../adapters/store.js').LinkRecord} link
	 * @param {{ amount: unknown, gateway: unknown, name: unknown, email: unknown }} input
	 * @returns {Promise<{ ok: true, payment: import('../adapters/store.js').PaymentRecord } | { ok: false, field: string, key: string, values?: Record<string, string> }>}
	 */
	const payLink = async (s, link, input) => {
		const amount = link.amount ?? fromDecimal(input.amount, link.currency);
		if (amount === null || (link.amount === null && amount < Number(link.minAmount ?? 1)))
			return { ok: false, field: 'amount', key: 'link.invalidAmount' };
		const customer = checkCustomer({ name: input.name ?? '', email: input.email ?? '' });
		if (!customer.ok) return { ok: false, field: 'email', key: 'link.invalidEmail' };
		const gateways = await service.available(s, link.currency, link.gateways);
		if (!isGateway(input.gateway) || !gateways.includes(input.gateway))
			return { ok: false, field: 'gateway', key: 'link.invalidMethod' };
		const payment = await service.createPayment(
			s,
			{
				amount,
				currency: link.currency,
				gateway: input.gateway,
				description: link.title,
				reference: link.reference,
				customer: customer.value,
				metadata: {},
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
		const look = s ? await lookOf(websiteId) : { texts: strings };
		if (!s) return html(renderResultPage({ ...look, state: 'unavailable' }), 404);
		const found = isId(paymentId, 'pay') ? await s.store.payments.get(paymentId) : null;
		if (!found) return html(renderResultPage({ ...look, state: 'notFound' }), 404);
		let payment = await service.recheck(s, found);
		const business = (await product.business(websiteId)).name;
		const result = { ...look, business, amount: payment.amount, currency: payment.currency };
		const back = payment.returnUrl ? withParam(payment.returnUrl, 'ss_payment', payment.id) : null;
		if (payment.status === 'paid' || payment.status === 'partially_refunded')
			return html(renderResultPage({ ...result, state: 'paid', backUrl: back }));
		if (payment.status === 'refunded') return html(renderResultPage({ ...result, state: 'refunded', backUrl: back }));
		if (payment.status === 'failed' || payment.status === 'cancelled')
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
		if (payment.gateway === 'bank_transfer') {
			const bank = await product.settings.values(websiteId, 'bank_transfer');
			const storage = bank.proofUpload === true ? await product.connections.storage(websiteId) : null;
			return html(
				renderBankPage({
					...look,
					business,
					amount: payment.amount,
					currency: payment.currency,
					reference: payment.reference || payment.id,
					bank: {
						accountTitle: String(bank.accountTitle ?? ''),
						bankName: String(bank.bankName ?? ''),
						accountNumber: String(bank.accountNumber ?? ''),
						iban: String(bank.iban ?? ''),
						instructions: String(bank.instructions ?? ''),
					},
					proof: storage
						? { action: `/pay/${websiteId}/${payment.id}/proof`, maxBytes: Number(bank.proofMaxMb) * 1_048_576 }
						: null,
					uploaded: payment.proof !== null,
				}),
			);
		}
		const checkout = /** @type {NonNullable<typeof payment.checkout>} */ (payment.checkout);
		if (checkout.kind === 'redirect') return seeOther(checkout.url);
		const keys = payment.gateway === 'generic' ? await service.keysOf(s, 'generic') : null;
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
	 * The payer picked a gateway, or tries again after a failed or cancelled attempt.
	 * @param {any} ctx
	 */
	const payPick = async (ctx) => {
		const { websiteId, paymentId } = ctx.params;
		const s = await publicSite(ctx, websiteId);
		if (!s) return html(renderResultPage({ texts: strings, state: 'unavailable' }), 404);
		const payment = isId(paymentId, 'pay') ? await s.store.payments.get(paymentId) : null;
		if (!payment) return html(renderResultPage({ ...(await lookOf(websiteId)), state: 'notFound' }), 404);
		const form = Object.fromEntries(formFields(ctx.rawBody));
		if (form.retry === '1' && (payment.status === 'failed' || payment.status === 'cancelled'))
			await s.store.payments.change(
				payment.id,
				['failed', 'cancelled'],
				{ status: 'pending', gateway: null, checkout: null },
				{ event: 'retried' },
			);
		else if (isGateway(form.gateway) && payment.status === 'pending' && payment.gateway === null) {
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
	 * The payer came back from a gateway (or cancelled there).
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
				{ status: 'cancelled' },
				{ event: 'cancelled', detail: 'by the payer' },
			);
			return seeOther(
				payment.cancelUrl ? withParam(payment.cancelUrl, 'ss_payment', payment.id) : `/pay/${websiteId}/${payment.id}`,
			);
		}
		if (payment.gateway === gateway && gateway !== 'bank_transfer' && isGateway(gateway)) {
			const adapter = product.gateways[/** @type {Exclude<Gateway, 'bank_transfer'>} */ (gateway)];
			const keys = await service.keysOf(s, /** @type {Exclude<Gateway, 'bank_transfer'>} */ (gateway));
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
				if (answer.news) await service.applyPayment(s, /** @type {Gateway} */ (gateway), answer.news, 'payer returned');
			}
		}
		const after = /** @type {import('../adapters/store.js').PaymentRecord} */ (await s.store.payments.get(payment.id));
		if (after.returnUrl && after.status !== 'failed') return seeOther(withParam(after.returnUrl, 'ss_payment', after.id));
		return seeOther(`/pay/${websiteId}/${after.id}`);
	};

	/**
	 * A gateway's signed notice (webhook, ITN, callback), checked with the website's keys for that gateway.
	 * @param {Exclude<Gateway, 'bank_transfer' | 'jazzcash' | 'easypaisa'>} gateway
	 */
	const notice = (gateway) => async (/** @type {any} */ ctx) => {
		const s = await publicSite(ctx, ctx.params.websiteId);
		if (!s || !s.on.includes(GATEWAY_FEATURES[gateway]))
			return problem('not_found', 'Notices are not received for this website.');
		const keys = await service.keysOf(s, gateway);
		const adapter = product.gateways[gateway];
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
	 * The bank-transfer proof upload of a payer: a presigned PUT into the merchant's storage, then its confirmation.
	 * @param {'presign' | 'done'} step
	 */
	const proofUpload = (step) => async (/** @type {any} */ ctx) => {
		const { websiteId, paymentId } = ctx.params;
		const s = await publicSite(ctx, websiteId);
		const payment = s && isId(paymentId, 'pay') ? await s.store.payments.get(paymentId) : null;
		if (!s || !payment || payment.gateway !== 'bank_transfer' || payment.status !== 'pending' || payment.proof !== null)
			return problem('not_found', 'No proof can be uploaded for this payment.');
		const bank = await product.settings.values(websiteId, 'bank_transfer');
		const storage =
			bank.proofUpload === true && s.on.includes('bank_transfer') ? await product.connections.storage(websiteId) : null;
		if (!storage) return problem('storage_not_connected', 'Proofs cannot be uploaded for this website.');
		const body = typeof ctx.body === 'object' && ctx.body !== null ? ctx.body : {};
		const prefix = `payments/proofs/${payment.id}.`;
		if (step === 'presign') {
			const extension = Object.hasOwn(PROOF_TYPES, body.type)
				? PROOF_TYPES[/** @type {keyof typeof PROOF_TYPES} */ (body.type)]
				: null;
			if (!extension) return invalid('type', 'Upload a JPEG, PNG or WebP photo or a PDF.');
			const max = Number(bank.proofMaxMb) * 1_048_576;
			if (!Number.isSafeInteger(body.size) || body.size < 1 || body.size > max)
				return invalid('size', `The largest proof is ${bank.proofMaxMb} MB.`);
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
		const head = await storage.headObject({ key: body.key });
		if (!head.exists) return invalid('key', 'The proof was not uploaded.');
		await s.store.payments.change(
			payment.id,
			['pending'],
			{ proof: { key: body.key, type: String(head.contentType ?? ''), size: head.size, at: new Date(product.now()) } },
			{ event: 'proof' },
		);
		return { uploaded: true };
	};

	/**
	 * The hosted page of a payment link: GET shows it, POST makes the payment and sends the payer on.
	 * @param {'show' | 'pay'} step
	 */
	const linkPage = (step) => async (/** @type {any} */ ctx) => {
		const { websiteId, linkId } = ctx.params;
		const s = await publicSite(ctx, websiteId);
		const look = s ? await lookOf(websiteId) : { texts: strings };
		const link = s ? await activeLink(s, linkId) : null;
		if (!s || !link) return html(renderResultPage({ ...look, state: 'notFound' }), 404);
		const business = (await product.business(websiteId)).name;
		const gateways = await choices(s, look.texts, link.currency, link.gateways);
		const action = `/l/${websiteId}/${link.id}`;
		if (step === 'show') return html(renderLinkPage({ ...look, business, link, gateways, action }));
		const form = Object.fromEntries(formFields(ctx.rawBody));
		const made = await payLink(s, link, { amount: form.amount, gateway: form.gateway, name: form.name, email: form.email });
		if (made.ok) return seeOther(`/pay/${websiteId}/${made.payment.id}`);
		const error = formatText(/** @type {Record<string, string>} */ (look.texts)[made.key] ?? made.key, {
			min: formatMoney(Number(link.minAmount ?? 1), link.currency),
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
		defineRoute({ method: 'GET', path: '/v1/payments', auth: 'server', feature: 'payment_api', handler: listPayments }),
		defineRoute({ method: 'GET', path: '/v1/payments/:id', auth: 'server', feature: 'payment_api', handler: readPayment }),
		defineRoute({
			method: 'POST',
			path: '/v1/payments/:id/verify',
			auth: 'server',
			feature: 'payment_api',
			rateLimit: SERVER_LIMITS,
			handler: async (ctx) => {
				const body = typeof ctx.body === 'object' && ctx.body !== null ? ctx.body : {};
				const s = await siteOf(ctx);
				const payment = await service.recheck(s, await paymentOf(s, ctx.params.id));
				return { verified: isConfirmedFor(payment, body), payment: service.view(s, payment) };
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/events',
			auth: 'server',
			feature: 'payment_api',
			handler: async (ctx) => {
				const page = paginate(
					{ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url },
					{ defaultLimit: 25 },
				);
				const s = await siteOf(ctx);
				const rows = await s.store.events.list({ after: page.after, limit: page.fetchLimit });
				return page.respond(
					rows.map((event) => ({
						id: event.id,
						type: `payments.${event.type}`,
						data: event.data,
						delivery: event.delivery,
						createdAt: new Date(event.createdAt).toISOString(),
					})),
					(view) => [view.createdAt, view.id],
				);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/payments/:id/confirm',
			auth: 'server',
			feature: 'bank_transfer',
			handler: confirmPayment,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/payments/:id/proof',
			auth: 'server',
			feature: 'bank_transfer',
			handler: proofLink,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/payments/:id/refunds',
			auth: 'server',
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
			feature: 'payment_links',
			idempotent: true,
			rateLimit: SERVER_LIMITS,
			handler: async (ctx) => {
				const checked = checkLinkInput(ctx.body);
				if (!checked.ok) return invalid(checked.field, checked.message);
				const s = await siteOf(ctx);
				if (!service.allowedReturn(s, checked.value.returnUrl))
					return invalid(
						'returnUrl',
						`returnUrl must be on https://${s.domain} (or a local address while testing).`,
						'origin',
					);
				const link = await s.store.links.add(checked.value);
				return created(linkView(link, service.linkUrl(s, link.id)));
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/links',
			auth: 'server',
			feature: 'payment_links',
			handler: async (ctx) => {
				const page = paginate(
					{ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url },
					{ defaultLimit: 25 },
				);
				const s = await siteOf(ctx);
				const rows = await s.store.links.list({ after: page.after, limit: page.fetchLimit });
				return page.respond(
					rows.map((link) => linkView(link, service.linkUrl(s, link.id))),
					(view) => [view.createdAt, view.id],
				);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/links/:id',
			auth: 'server',
			feature: 'payment_links',
			handler: async (ctx) => {
				const s = await siteOf(ctx);
				const link = isId(ctx.params.id, 'link') ? await s.store.links.get(ctx.params.id) : null;
				return link ? linkView(link, service.linkUrl(s, link.id)) : problem('not_found', 'No such link.');
			},
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/links/:id',
			auth: 'server',
			feature: 'payment_links',
			handler: async (ctx) => {
				if (typeof ctx.body?.active !== 'boolean') return invalid('active', 'active is true or false.');
				const s = await siteOf(ctx);
				const link = isId(ctx.params.id, 'link') ? await s.store.links.setActive(ctx.params.id, ctx.body.active) : null;
				return link ? linkView(link, service.linkUrl(s, link.id)) : problem('not_found', 'No such link.');
			},
		}),

		// ------------------------------------------------------------------------------------------- subscriptions
		defineRoute({
			method: 'POST',
			path: '/v1/subscriptions',
			auth: 'server',
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
			feature: 'subscriptions',
			handler: listSubscriptions,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/subscriptions/:id',
			auth: 'server',
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
					amount: body.amount,
					gateway: body.gateway,
					name: body.customer?.name,
					email: body.customer?.email,
				});
				if (!made.ok) return invalid(made.field, strings[/** @type {keyof typeof strings} */ (made.key)] ?? made.key);
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
			path: '/v1/gateways/generic/:websiteId',
			auth: 'none',
			rawBody: true,
			rateLimit: NOTICE_LIMITS,
			handler: notice('generic'),
		}),

		// public docs: no sign-in, no tokens
		defineRoute({
			method: 'GET',
			path: '/docs',
			auth: 'none',
			handler: (ctx) =>
				new Response(renderDocs({ base: product.address() ?? new URL(ctx.request.url).origin }), {
					headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
				}),
		}),
	];
};
