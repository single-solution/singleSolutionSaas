/**
 * Notifications' routes (the kit adds its own: connect, notices, tickets, data rights, widget config, `/sso` and the
 * dashboard API). Every browser-token, server-token and ticket route belongs to one feature; `openapi.json` is
 * generated from these definitions (`ss app assets`), so `method`, `path`, `auth`, `feature` and `permission` stay
 * string literals. Every website route sends due messages and webhook events right after it answers (`drain`).
 * Public entry `./routes` of this package: `product.handler(createRoutes(product))`.
 * @module
 */
import { isId } from '@ss/contracts';
import { created, defineRoute, noContent, ok, paginate, problem } from '@ss/app-kit';
import { CHANNELS, checkRecipient, normaliseEmail, normalisePhone } from '../core/channels.js';
import { isOptOut, repliesOf } from '../core/inbound.js';
import { verifyMeta, verifyTwilio } from '../adapters/signatures.js';
import { checkTemplate, checkValues, isProductKey, languageOfSegment, templateView } from '../core/templates.js';
import { checkSendAt } from '../core/timing.js';
import { strings } from '../adapters/product.js';
import { createStore } from '../adapters/store.js';
import { checkSubscription } from '../adapters/webpush.js';
import { renderDocs } from './docs.js';
import { PAGE_HEADERS, renderUnsubscribePage } from './pages.js';
import { createSending, messageView } from './sending.js';
import { WIDGET_SCRIPT } from './widget-script.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('../core/channels.js').Channel} Channel */

/** Rate limits of the send routes (code constants protecting our hosting). */
const SEND_LIMITS = [{ limit: 600, windowSeconds: 60, per: /** @type {const} */ ('website') }];
/** Rate limits of public pages and visitor routes. */
const VISITOR_LIMITS = [
	{ limit: 300, windowSeconds: 60, per: /** @type {const} */ ('website') },
	{ limit: 20, windowSeconds: 60, per: /** @type {const} */ ('visitor') },
];

/** Event types other products send through `POST /v1/events`: `<product id>.<event>`. */
const PRODUCT_EVENT = /^(?:accounts|ecommerce|chat|payments|growth)\.[a-z][a-z0-9_.]{0,62}$/;

/** @param {string} field @param {string} message @param {string} [code] */
const invalid = (field, message, code = 'invalid') =>
	problem('validation_failed', message, { errors: [{ path: `/${field}`, message, code }] });

/**
 * @param {Product} product
 */
export const createRoutes = (product) => {
	const sending = createSending(product);
	const { now } = product;

	/**
	 * The website of a request as sending sees it; due work is sent right after the answer.
	 * @param {any} ctx
	 */
	const siteOf = async (ctx) => {
		const s = await sending.site({
			websiteId: ctx.websiteId,
			merchantId: ctx.merchantId,
			base: new URL(ctx.request.url).origin,
		});
		ctx.after(() => sending.drain(s));
		return s;
	};

	/**
	 * `POST /v1/messages/<channel>`: send a template to a recipient (server token: products and the merchant's server).
	 * @param {Channel} channel
	 */
	const sendHandler = (channel) => async (/** @type {any} */ ctx) => {
		const body = typeof ctx.body === 'object' && ctx.body !== null ? ctx.body : {};
		if (typeof body.template !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(body.template))
			return invalid('template', 'Name the template key.');
		const to = checkRecipient(body.to);
		if (!to.ok) return invalid(to.field, 'The recipient is not valid.');
		const values = checkValues(body.values);
		if (!values.ok) return invalid('values', 'values must map up to 50 names to text or numbers (at most 1000 characters).');
		if (body.language !== undefined && languageOfSegment(body.language) === null)
			return invalid('language', 'Use a language code such as en, ur or pt-BR.');
		const s = await siteOf(ctx);
		if (!isProductKey(body.template) && !s.on.includes('send_api'))
			return problem('feature_off', 'Your own template keys need the Merchant send API feature (send_api).');
		/** @type {number | null} */
		let sendAt = null;
		if (body.sendAt !== undefined) {
			if (!s.on.includes('delayed_send')) return problem('feature_off', 'A later send time needs the Delayed send feature.');
			const { maxDelayDays } = await product.settings.values(ctx.websiteId, 'delayed_send');
			const checked = checkSendAt(body.sendAt, now(), Number(maxDelayDays));
			if (!checked.ok) return invalid('sendAt', `sendAt must be an ISO-8601 time at most ${maxDelayDays} days ahead.`);
			sendAt = checked.at;
		}
		const result = await sending.accept(s, {
			channel,
			template: body.template,
			content: null,
			to: to.value,
			values: values.value,
			language: body.language ?? to.value.language,
			sendAt,
			source: 'api',
		});
		if (!result.ok) return result.problem;
		return created(messageView(result.message));
	};

	/**
	 * One page of the delivery log (`?cursor=&limit=&status=&channel=&to=`), newest first.
	 * @param {any} ctx
	 */
	const listMessages = async (ctx) => {
		const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 25 });
		const s = await siteOf(ctx);
		const status = ['queued', 'retrying', 'sent', 'failed', 'skipped'].includes(ctx.query.status)
			? ctx.query.status
			: undefined;
		const channel = CHANNELS.includes(ctx.query.channel) ? ctx.query.channel : undefined;
		const address =
			typeof ctx.query.to === 'string'
				? (normaliseEmail(ctx.query.to) ?? normalisePhone(ctx.query.to) ?? ctx.query.to)
				: undefined;
		const rows = await s.store.messages.list({ after: page.after, limit: page.fetchLimit, status, channel, address });
		return page.respond(rows.map(messageView), (message) => [message.createdAt, message.id]);
	};

	/**
	 * Templates: list, save and delete (dashboard and the template editor widget).
	 * @param {'dashboard' | 'widget'} via
	 */
	const templateHandlers = (via) => {
		/** @param {any} ctx */
		const storeOf = async (ctx) => (via === 'widget' ? (await siteOf(ctx)).store : createStore(await ctx.data(), { now }));
		/** @param {any} ctx @param {string} detail */
		const record = async (ctx, detail) => {
			if (via === 'dashboard') {
				const session = ctx.session;
				await product.recentChanges.record({
					websiteId: ctx.websiteId,
					who: {
						kind: session.kind,
						id: session.subject,
						name: session.name,
						...(session.role ? { role: session.role } : {}),
					},
					what: 'templates',
					detail,
				});
			} else
				await product.activity.record(
					{ websiteId: ctx.websiteId, merchantId: ctx.merchantId, after: ctx.after },
					{
						actor: { kind: 'staff', id: ctx.ticket.user.id, name: ctx.ticket.user.name },
						action: 'template.saved',
						target: detail,
					},
				);
		};
		return {
			/** @param {any} ctx */
			list: async (ctx) => ({ items: (await (await storeOf(ctx)).templates.list()).map(templateView) }),
			/** @param {any} ctx */
			save: async (ctx) => {
				const checked = checkTemplate(ctx.body);
				if (!checked.ok) return invalid(checked.field, checked.message);
				const store = await storeOf(ctx);
				if ((await store.templates.save(checked.value)) === 'full')
					return problem('validation_failed', 'A website can have at most 1000 templates.');
				const t = checked.value;
				await record(ctx, `Template ${t.key} (${t.channel}, ${t.language || 'default'}): saved`);
				return templateView(t);
			},
			/** @param {any} ctx */
			remove: async (ctx) => {
				const language = languageOfSegment(ctx.params.language);
				if (language === null || !CHANNELS.includes(ctx.params.channel)) return problem('not_found', 'No such template.');
				const store = await storeOf(ctx);
				if (!(await store.templates.remove(ctx.params.key, ctx.params.channel, language)))
					return problem('not_found', 'No such template.');
				await record(ctx, `Template ${ctx.params.key} (${ctx.params.channel}, ${language || 'default'}): deleted`);
				return noContent();
			},
		};
	};
	const dashboardTemplates = templateHandlers('dashboard');
	const widgetTemplates = templateHandlers('widget');

	/**
	 * A website a public page or a provider names: it must exist, be served and have its merchant database.
	 * @param {string} websiteId
	 * @returns {Promise<{ ok: true, merchantId: string } | { ok: false }>}
	 */
	const publicSite = async (websiteId) => {
		if (!isId(websiteId, 'web')) return { ok: false };
		const serving = await product.serving(websiteId);
		if (!serving.ok || (await product.connections.value(websiteId, 'database')) === null) return { ok: false };
		return { ok: true, merchantId: serving.status.merchantId };
	};

	/**
	 * The hosted unsubscribe page: GET asks, POST unsubscribes.
	 * @param {'ask' | 'unsubscribe'} step
	 */
	const unsubscribePage = (step) => async (/** @type {any} */ ctx) => {
		const { websiteId, code } = ctx.params;
		const found = await publicSite(websiteId);
		if (!found.ok)
			return new Response(renderUnsubscribePage({ texts: strings, state: 'unavailable' }), {
				status: 404,
				headers: PAGE_HEADERS,
			});
		const texts = await product.settings.texts(websiteId);
		const theme = await product.settings.theme(websiteId);
		const s = await sending.site({ websiteId, merchantId: found.merchantId, base: new URL(ctx.request.url).origin });
		ctx.after(() => sending.drain(s));
		const address =
			typeof code === 'string' && /^[A-Za-z0-9_-]{24}$/.test(code) ? await s.store.recipients.addressOf(code) : null;
		if (!address)
			return new Response(renderUnsubscribePage({ texts, theme, state: 'invalid' }), { status: 404, headers: PAGE_HEADERS });
		if (step === 'ask') {
			const business = (await product.business(websiteId)).name;
			return new Response(
				renderUnsubscribePage({ texts, theme, state: 'ask', business, action: `/unsubscribe/${websiteId}/${code}` }),
				{ headers: PAGE_HEADERS },
			);
		}
		await sending.unsubscribe(s, address, 'link');
		return new Response(renderUnsubscribePage({ texts, theme, state: 'done' }), { headers: PAGE_HEADERS });
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

		// ------------------------------------------------------------------------------------------- the send API
		defineRoute({
			method: 'POST',
			path: '/v1/messages/email',
			auth: 'server',
			feature: 'email',
			idempotent: true,
			rateLimit: SEND_LIMITS,
			handler: sendHandler('email'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/messages/sms',
			auth: 'server',
			feature: 'sms',
			idempotent: true,
			rateLimit: SEND_LIMITS,
			handler: sendHandler('sms'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/messages/whatsapp',
			auth: 'server',
			feature: 'whatsapp',
			idempotent: true,
			rateLimit: SEND_LIMITS,
			handler: sendHandler('whatsapp'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/messages/push',
			auth: 'server',
			feature: 'browser_push',
			idempotent: true,
			rateLimit: SEND_LIMITS,
			handler: sendHandler('push'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/messages/staff-push',
			auth: 'server',
			feature: 'staff_push',
			idempotent: true,
			rateLimit: SEND_LIMITS,
			handler: sendHandler('staff_push'),
		}),
		// other products' events (for example payments.payment.paid) to the merchant's webhook URLs, signed here
		defineRoute({
			method: 'POST',
			path: '/v1/events',
			auth: 'server',
			feature: 'webhooks',
			idempotent: true,
			rateLimit: SEND_LIMITS,
			handler: async (ctx) => {
				const body = typeof ctx.body === 'object' && ctx.body !== null ? ctx.body : {};
				if (typeof body.type !== 'string' || !PRODUCT_EVENT.test(body.type))
					return invalid('type', 'Name the event as <product id>.<event>, for example payments.payment.paid.');
				if (
					typeof body.data !== 'object' ||
					body.data === null ||
					Array.isArray(body.data) ||
					JSON.stringify(body.data).length > 16_384
				)
					return invalid('data', 'data is an object of at most 16 kB of JSON.');
				const s = await siteOf(ctx);
				return ok({ queued: await sending.relay(s, body.type, body.data) }, { status: 202 });
			},
		}),
		// the delivery log for the merchant's server
		defineRoute({ method: 'GET', path: '/v1/messages', auth: 'server', feature: 'send_api', handler: listMessages }),
		defineRoute({
			method: 'GET',
			path: '/v1/messages/:id',
			auth: 'server',
			feature: 'send_api',
			handler: async (ctx) => {
				const message = await (await siteOf(ctx)).store.messages.get(ctx.params.id);
				return message ? messageView(message) : problem('not_found', 'No such message.');
			},
		}),

		// ------------------------------------------------------------------------------- browser push (visitors)
		defineRoute({
			method: 'POST',
			path: '/v1/push/subscriptions',
			auth: 'browser',
			feature: 'browser_push',
			rateLimit: VISITOR_LIMITS,
			handler: async (ctx) => {
				const subscription = checkSubscription(ctx.body?.subscription);
				if (!subscription) return invalid('subscription', 'Send the browser push subscription (PushSubscription.toJSON()).');
				const s = await siteOf(ctx);
				const subscriberId = await s.store.subscriptions.save({ kind: 'visitor', staffId: null, ...subscription });
				return created({ subscriberId });
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/push/subscriptions/remove',
			auth: 'browser',
			feature: 'browser_push',
			rateLimit: VISITOR_LIMITS,
			handler: async (ctx) => {
				const { subscriberId, endpoint } = ctx.body ?? {};
				if (typeof subscriberId !== 'string' || typeof endpoint !== 'string')
					return invalid('subscriberId', 'Send the subscriber id and the subscription endpoint.');
				await (await siteOf(ctx)).store.subscriptions.remove(subscriberId, endpoint);
				return noContent();
			},
		}),

		// ------------------------------------------------------------------------- admin widgets (tickets)
		defineRoute({ method: 'GET', path: '/v1/admin/messages', auth: 'ticket', permission: 'log.read', handler: listMessages }),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/messages',
			auth: 'ticket',
			permission: 'messages.send',
			idempotent: true,
			rateLimit: SEND_LIMITS,
			handler: async (ctx) => {
				const body = ctx.body ?? {};
				if (!['email', 'sms', 'whatsapp'].includes(body.channel)) return invalid('channel', 'Pick e-mail, SMS or WhatsApp.');
				const channel = /** @type {'email' | 'sms' | 'whatsapp'} */ (body.channel);
				const email = channel === 'email' ? normaliseEmail(body.to) : null;
				const phone = channel === 'email' ? null : normalisePhone(body.to);
				if (!email && !phone)
					return invalid(
						'to',
						channel === 'email' ? 'Enter an e-mail address.' : 'Enter a phone number with its country code.',
					);
				const text = typeof body.text === 'string' ? body.text.trim() : '';
				const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
				if (text.length === 0 || text.length > 4096) return invalid('text', 'Write the message (at most 4096 characters).');
				if (channel === 'email' && (subject.length === 0 || subject.length > 200 || /[\r\n]/.test(subject)))
					return invalid('subject', 'Write the subject (one line, at most 200 characters).');
				const s = await siteOf(ctx);
				const result = await sending.accept(s, {
					channel,
					template: null,
					content: { subject: channel === 'email' ? subject : '', text },
					to: { email, phone, subscriberId: null, staffId: null, language: null, timeZone: null },
					values: {},
					language: null,
					sendAt: null,
					source: 'staff',
				});
				if (!result.ok) return result.problem;
				await product.activity.record(
					{ websiteId: ctx.websiteId, merchantId: ctx.merchantId, after: ctx.after },
					{
						actor: { kind: 'staff', id: ctx.ticket.user.id, name: ctx.ticket.user.name },
						action: 'message.sent',
						target: result.message.id,
					},
				);
				return created(messageView(result.message));
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/templates',
			auth: 'ticket',
			permission: 'templates.edit',
			handler: widgetTemplates.list,
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/admin/templates',
			auth: 'ticket',
			permission: 'templates.edit',
			handler: widgetTemplates.save,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/admin/templates/:key/:channel/:language',
			auth: 'ticket',
			permission: 'templates.edit',
			handler: widgetTemplates.remove,
		}),
		// staff push: the ticket's user gets pushes in this browser
		defineRoute({
			method: 'POST',
			path: '/v1/admin/push/subscriptions',
			auth: 'ticket',
			permission: 'push.subscribe',
			handler: async (ctx) => {
				const subscription = checkSubscription(ctx.body?.subscription);
				if (!subscription) return invalid('subscription', 'Send the browser push subscription (PushSubscription.toJSON()).');
				const s = await siteOf(ctx);
				const subscriberId = await s.store.subscriptions.save({
					kind: 'staff',
					staffId: ctx.ticket.user.id,
					...subscription,
				});
				return created({ subscriberId });
			},
		}),

		// ---------------------------------------------------------------------------- dashboard: templates
		defineRoute({
			method: 'GET',
			path: '/v1/dashboard/websites/:websiteId/templates',
			auth: 'dashboard',
			handler: dashboardTemplates.list,
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/dashboard/websites/:websiteId/templates',
			auth: 'dashboard',
			handler: dashboardTemplates.save,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/dashboard/websites/:websiteId/templates/:key/:channel/:language',
			auth: 'dashboard',
			handler: dashboardTemplates.remove,
		}),

		// ------------------------------------------------------------------------------- hosted unsubscribe page
		defineRoute({
			method: 'GET',
			path: '/unsubscribe/:websiteId/:code',
			auth: 'none',
			rateLimit: VISITOR_LIMITS,
			handler: unsubscribePage('ask'),
		}),
		defineRoute({
			method: 'POST',
			path: '/unsubscribe/:websiteId/:code',
			auth: 'none',
			rawBody: true,
			rateLimit: VISITOR_LIMITS,
			handler: unsubscribePage('unsubscribe'),
		}),

		// ---------------------------------------------------- unsubscribe keywords (replies the provider forwards)
		defineRoute({
			method: 'POST',
			path: '/v1/inbound/:websiteId/:channel',
			auth: 'none',
			rawBody: true,
			rateLimit: [{ limit: 600, windowSeconds: 60, per: 'visitor' }],
			handler: async (ctx) => {
				const { websiteId, channel } = ctx.params;
				if (channel !== 'sms' && channel !== 'whatsapp') return problem('not_found', 'No such channel.');
				const found = await publicSite(websiteId);
				if (!found.ok || !(await product.featuresOn(websiteId)).includes(channel))
					return problem('not_found', 'Replies are not received for this website.');
				const value = await product.connections.value(websiteId, channel);
				const v = typeof value === 'object' && value !== null ? value : {};
				const signatureOk =
					v.provider === 'twilio'
						? verifyTwilio({
								url: ctx.request.url,
								params: new URLSearchParams(ctx.rawBody),
								signature: ctx.headers.get('x-twilio-signature'),
								authToken: String(v.secret),
							})
						: v.provider === 'meta' && typeof v.appSecret === 'string' && v.appSecret !== ''
							? verifyMeta({
									body: ctx.rawBody,
									signature: ctx.headers.get('x-hub-signature-256'),
									appSecret: v.appSecret,
								})
							: false;
				if (!signatureOk) return problem('unauthorized', 'The signature is not valid.');
				const { optOutKeywords } = await product.settings.values(websiteId, channel);
				const s = await sending.site({ websiteId, merchantId: found.merchantId, base: new URL(ctx.request.url).origin });
				ctx.after(() => sending.drain(s));
				for (const reply of repliesOf(v.provider === 'twilio' ? 'twilio' : 'meta', ctx.rawBody)) {
					const phone = normalisePhone(reply.from);
					if (phone && isOptOut(reply.text, optOutKeywords)) await sending.unsubscribe(s, phone, 'keyword');
				}
				return v.provider === 'twilio'
					? new Response('<Response/>', { headers: { 'content-type': 'text/xml; charset=utf-8' } })
					: noContent();
			},
		}),
		// the WhatsApp Cloud API checks the address once: it echoes hub.challenge when hub.verify_token matches
		defineRoute({
			method: 'GET',
			path: '/v1/inbound/:websiteId/whatsapp',
			auth: 'none',
			rateLimit: [{ limit: 60, windowSeconds: 60, per: 'visitor' }],
			handler: async (ctx) => {
				const found = await publicSite(ctx.params.websiteId);
				const value = found.ok ? await product.connections.value(ctx.params.websiteId, 'whatsapp') : null;
				const token = typeof value === 'object' && value !== null ? value.verifyToken : undefined;
				if (
					typeof token !== 'string' ||
					token === '' ||
					ctx.query['hub.mode'] !== 'subscribe' ||
					ctx.query['hub.verify_token'] !== token
				)
					return problem('forbidden', 'The verify token does not match.');
				return new Response(String(ctx.query['hub.challenge'] ?? ''), {
					headers: { 'content-type': 'text/plain; charset=utf-8' },
				});
			},
		}),

		// public docs: no sign-in, no tokens
		defineRoute({
			method: 'GET',
			path: '/docs',
			auth: 'none',
			handler: (ctx) =>
				new Response(renderDocs({ base: new URL(ctx.request.url).origin }), {
					headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
				}),
		}),
	];
};
