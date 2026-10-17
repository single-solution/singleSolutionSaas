/**
 * Notifications' routes (the kit adds its own: connect, notices, tickets, data rights, widget config, `/sso`, the
 * dashboard API with its list twin of `webhook_urls`, the settings API and the activity reads). Every browser-token, server-token and ticket route belongs
 * to one feature; `openapi.json` is generated from these definitions (`ss app assets`), so `method`, `path`, `auth`,
 * `feature` and `permission` stay string literals. Every website route sends due messages and webhook events right
 * after it answers (`drain`). Who acts is the ticket's member of staff, else the signed-in staff member of a server-token
 * call, else the server (PLAN 0.8.10 K2).
 * Public entry `./routes` of this package: `product.handler(createRoutes(product))`.
 * @module
 */
import { timingSafeEqual } from 'node:crypto';
import { isId } from '@ss/contracts';
import { normalizeEmail } from '@ss/contracts/email';
import { TEMPLATE_KEY, TEXT_LIMITS } from '@ss/contracts/templates';
import { actorOf, countHandlers, created, defineRoute, noContent, ok, paginate, problem } from '@ss/app-kit';
import { CHANNELS, CHANNEL_FEATURES, checkRecipient, normalizePhone } from '../core/channels.js';
import { gatewayRepliesOf, isOptOut, repliesOf } from '../core/inbound.js';
import { logFilters } from '../core/log.js';
import { verifyMeta, verifyTwilio } from '../adapters/signatures.js';
import {
	checkDefaults,
	checkTemplate,
	checkValueNames,
	checkValues,
	isAccountKey,
	isTitled,
	languageOfSegment,
	templateView,
} from '../core/templates.js';
import { MAX_DELAY_DAYS, MAX_TEMPLATES } from '../core/limits.js';
import { checkSendAt } from '../core/timing.js';
import { checkForwardedEvent } from '../core/webhooks.js';
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

/** Who acts when neither a ticket nor the the verified `SS-Sign-In` names a member of the merchant's staff. */
const SERVER = Object.freeze({ kind: 'server', id: 'server', name: 'Server' });
/** @typedef {{ kind: 'merchant' | 'admin' | 'user' | 'server', id: string, name: string, role?: string }} Who */
/**
 * Who a dashboard session is, as Recent changes and the activity log name them.
 * @param {{ kind: 'merchant' | 'admin', subject: string, name: string, role?: string }} session
 * @returns {Who}
 */
const sessionWho = (session) => ({
	kind: session.kind,
	id: session.subject,
	name: session.name,
	...(session.role ? { role: session.role } : {}),
});

/**
 * Template writes of the merchant's server: they share the settings API's counter of 60 writes per minute per website
 * (PLAN 0.8.10 K1 and N4; the kit's bucket name).
 */
const TEMPLATE_WRITE_LIMITS = [
	{ limit: 60, windowSeconds: 60, per: /** @type {const} */ ('website'), bucket: 'kit-settings-writes' },
];

/** Fields the delivery log is counted by (`GET /v1/messages/counts?by=`). */
const MESSAGE_COUNT_FIELDS = Object.freeze({ status: 'status', channel: 'channel', template: 'template', source: 'source' });

/**
 * Whether two texts are the same, in constant time.
 * @param {string} given @param {string} expected
 */
const sameText = (given, expected) => {
	const a = Buffer.from(given);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
};

/** @param {string} field @param {string} message @param {string} [code] */
const invalid = (field, message, code = 'invalid') =>
	problem('validation_failed', message, { errors: [{ path: `/${field}`, message, code }] });

/**
 * The short detail of a saved template in the activity log: how it is sent, never its words.
 * @param {import('../core/templates.js').Template} template
 */
const templateDetail = (template) =>
	[
		template.required ? 'Required' : 'Optional',
		template.urgent ? 'urgent' : 'not urgent',
		...(template.providerTemplate ? [`WhatsApp template ${template.providerTemplate}`] : []),
		...(template.buttons?.length ? [`${template.buttons.length} button${template.buttons.length === 1 ? '' : 's'}`] : []),
		...(template.sensitive ? ['values hidden in the delivery log'] : []),
	].join(', ');

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
		if (typeof body.template !== 'string' || !TEMPLATE_KEY.test(body.template))
			return invalid('template', 'Name the template key.');
		const to = checkRecipient(body.to);
		if (!to.ok) return invalid(to.field, 'The recipient is not valid.');
		// a product's message names its long values (up to 50,000 characters each)
		const longValues = checkValueNames(body.longValues);
		if (!longValues.ok) return invalid('longValues', 'longValues lists up to 50 value names.');
		const values = checkValues(body.values, longValues.value);
		if (!values.ok)
			return invalid(
				'values',
				'values must map up to 50 names to text or numbers of at most 1000 characters (50000 for a value named in longValues), 100000 in all.',
			);
		const secretValues = checkValueNames(body.secretValues);
		if (!secretValues.ok) return invalid('secretValues', 'secretValues lists up to 50 value names.');
		if (body.required !== undefined && typeof body.required !== 'boolean')
			return invalid('required', 'required is true or false.');
		if (body.language !== undefined && languageOfSegment(body.language) === null)
			return invalid('language', 'Use a language code such as en, fr or pt-BR.');
		// a template key whose website template is used when the website has none of its own for the send's key
		if (
			body.fallbackTemplate !== undefined &&
			(typeof body.fallbackTemplate !== 'string' ||
				!TEMPLATE_KEY.test(body.fallbackTemplate) ||
				body.fallbackTemplate === body.template)
		)
			return invalid('fallbackTemplate', 'fallbackTemplate is another template key.');
		// a product's message carries its default words (parity P1), checked as a template the merchant saves
		const defaults = checkDefaults(body.defaults, body.template, longValues.value);
		if (!defaults.ok) return invalid(defaults.field, defaults.message);
		const s = await siteOf(ctx);
		const owner = await product.defaults.ownerOf(body.template);
		if (owner === null && longValues.value.length > 0)
			return invalid('longValues', 'Only the messages of products have long values.');
		if (!s.on.includes('send_api') && owner === null)
			return problem('feature_off', 'Your own template keys need the Merchant send API feature (send_api).');
		/** @type {number | null} */
		let sendAt = null;
		if (body.sendAt !== undefined) {
			if (!s.on.includes('delayed_send')) return problem('feature_off', 'A later send time needs the Delayed send feature.');
			const checked = checkSendAt(body.sendAt, now(), MAX_DELAY_DAYS);
			if (!checked.ok) return invalid('sendAt', `sendAt must be an ISO-8601 time at most ${MAX_DELAY_DAYS} days ahead.`);
			sendAt = checked.at;
		}
		const result = await sending.accept(s, {
			channel,
			template: body.template,
			content: null,
			to: to.value,
			values: values.value,
			secretValues: secretValues.value,
			required: body.required === true,
			language: body.language ?? to.value.language,
			sendAt,
			source: 'api',
			defaults: defaults.value,
			fallbackTemplate: body.fallbackTemplate ?? null,
			longValues: longValues.value,
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
		const rows = await s.store.messages.list({ after: page.after, limit: page.fetchLimit, ...logFilters(ctx.query) });
		return page.respond(rows.map(messageView), (message) => [message.createdAt, message.id]);
	};

	/** The delivery log's counts: the list's own filters (`?status=&channel=&to=`), counted (PLAN 0.8.10 K4). */
	const messageCounts = countHandlers({
		source: async (ctx) => (await siteOf(ctx)).store.messages.countSource(logFilters(ctx.query)),
		by: MESSAGE_COUNT_FIELDS,
	});

	/**
	 * The long values a product declares for its message (they go only in a template's text), when its list can be read
	 * now; none for the merchant's own keys.
	 * @param {string} key
	 * @returns {Promise<string[]>}
	 */
	const longValuesOf = async (key) => {
		if ((await product.defaults.ownerOf(key)) === null) return [];
		const listed = await product.defaults.all().catch(() => null);
		return listed?.messages.find((message) => message.key === key)?.longValues ?? [];
	};

	/**
	 * Templates: list, save and delete (dashboard, the template editor widget and the merchant's server). The server's
	 * routes work per channel while its feature is on (PLAN 0.8.10 N4). A product's message is checked with its long
	 * values.
	 * @param {'dashboard' | 'widget' | 'server'} via
	 */
	const templateHandlers = (via) => {
		/** @param {any} ctx */
		const storeOf = async (ctx) => (via === 'dashboard' ? createStore(await ctx.data(), { now }) : (await siteOf(ctx)).store);
		/**
		 * Whether the merchant's server may use a channel's templates now: its feature is on.
		 * @param {any} ctx
		 * @param {Channel} channel
		 */
		const channelOn = async (ctx, channel) =>
			via !== 'server' || (await product.featuresOn(ctx.websiteId)).includes(CHANNEL_FEATURES[channel]);
		/** @param {Channel} channel */
		const channelOff = (channel) =>
			problem('feature_off', `The ${CHANNEL_FEATURES[channel]} feature is off: its templates cannot be changed.`);
		/**
		 * Every change is an activity entry by who made it — the dashboard's session, a server call's acting user (else the
		 * server), the widget's staff member — so the website's audit trail has them all; dashboard and server changes are
		 * a Recent change too. The template's key, channel and language are its label; the detail names the change, never
		 * the words.
		 * @param {any} ctx
		 * @param {{ change: 'saved' | 'deleted', key: string, channel: string, language: string, detail?: string }} input
		 */
		const record = async (ctx, { change, key, channel, language, detail }) => {
			const label = `${key} (${channel}, ${language || 'default'})`;
			const actor = ctx.actor;
			/** @type {Who | null} who a dashboard or server change is (the widget's staff member is no Recent change) */
			const who =
				via === 'dashboard'
					? sessionWho(ctx.session)
					: via === 'server'
						? actor
							? { kind: 'user', id: actor.id, name: actor.name, ...(actor.role ? { role: actor.role } : {}) }
							: SERVER
						: null;
			if (who)
				await product.recentChanges.record({
					websiteId: ctx.websiteId,
					who,
					what: 'templates',
					detail: `Template ${label}: ${change}`,
				});
			await product.activity.record(
				{ websiteId: ctx.websiteId, merchantId: ctx.merchantId, after: ctx.after },
				{
					actor: who ?? actorOf(ctx, SERVER),
					action: `template.${change}`,
					target: `${key}/${channel}/${language || 'default'}`,
					label,
					...(detail ? { detail } : {}),
				},
			);
		};
		return {
			/** @param {any} ctx */
			list: async (ctx) => {
				const items = await (await storeOf(ctx)).templates.list();
				const on = via === 'server' ? await product.featuresOn(ctx.websiteId) : null;
				return {
					items: items
						.filter((template) => on === null || on.includes(CHANNEL_FEATURES[template.channel]))
						.map(templateView),
				};
			},
			/** @param {any} ctx */
			save: async (ctx) => {
				const key = typeof ctx.body?.key === 'string' ? ctx.body.key : '';
				const checked = checkTemplate(ctx.body, await longValuesOf(key));
				if (!checked.ok) return invalid(checked.field, checked.message);
				if (!(await channelOn(ctx, checked.value.channel))) return channelOff(checked.value.channel);
				const saved = await (await storeOf(ctx)).templates.save(checked.value);
				if (saved === 'full') return problem('validation_failed', `A website can have at most ${MAX_TEMPLATES} templates.`);
				const t = checked.value;
				await record(ctx, {
					change: 'saved',
					key: t.key,
					channel: t.channel,
					language: t.language,
					detail: templateDetail(t),
				});
				// the template as saved, with the time the database stamped
				return templateView(saved);
			},
			/** @param {any} ctx */
			remove: async (ctx) => {
				const language = languageOfSegment(ctx.params.language);
				if (language === null || !CHANNELS.includes(ctx.params.channel)) return problem('not_found', 'No such template.');
				if (!(await channelOn(ctx, ctx.params.channel))) return channelOff(ctx.params.channel);
				const store = await storeOf(ctx);
				if (!(await store.templates.remove(ctx.params.key, ctx.params.channel, language)))
					return problem('not_found', 'No such template.');
				await record(ctx, { change: 'deleted', key: ctx.params.key, channel: ctx.params.channel, language });
				return noContent();
			},
		};
	};
	/**
	 * Switch a product's message off on a channel, or on again (dashboard; parity P1): a switched-off message is skipped,
	 * never sent. Accounts' messages are always sent. A Recent change and an activity entry by the session when it changed.
	 * @param {any} ctx
	 */
	const switchMessage = async (ctx) => {
		const { key, channel } = ctx.params;
		if (!CHANNELS.includes(channel) || !TEMPLATE_KEY.test(key)) return problem('not_found', 'No such message.');
		if ((await product.defaults.ownerOf(key)) === null)
			return invalid('key', 'Only the messages of products can be switched off: delete your own template instead.');
		if (isAccountKey(key))
			return invalid('key', 'Sign-in messages are always sent: switch the sign-in method off in Accounts instead.');
		const body = typeof ctx.body === 'object' && ctx.body !== null ? ctx.body : {};
		if (typeof body.off !== 'boolean') return invalid('off', 'off is true or false.');
		const store = createStore(await ctx.data(), { now });
		if (await store.off.set(key, channel, body.off)) {
			const who = sessionWho(ctx.session);
			const change = body.off ? 'switched off' : 'switched on';
			await product.recentChanges.record({
				websiteId: ctx.websiteId,
				who,
				what: 'templates',
				detail: `Message ${key} (${channel}): ${change}`,
			});
			await product.activity.record(
				{ websiteId: ctx.websiteId, merchantId: ctx.merchantId, after: ctx.after },
				{
					actor: who,
					action: body.off ? 'message.switched_off' : 'message.switched_on',
					target: `${key}/${channel}`,
					label: `${key} (${channel})`,
				},
			);
		}
		return { key, channel, off: body.off };
	};

	const dashboardTemplates = templateHandlers('dashboard');
	const widgetTemplates = templateHandlers('widget');
	const serverTemplates = templateHandlers('server');

	/**
	 * A website a public page or a provider names: it must exist, be served and have its merchant database. An old status
	 * copy is fetched again right after the response (K-19).
	 * @param {any} ctx
	 * @param {string} websiteId
	 * @returns {Promise<{ ok: true, merchantId: string } | { ok: false }>}
	 */
	const publicSite = async (ctx, websiteId) => {
		if (!isId(websiteId, 'web')) return { ok: false };
		const serving = await product.serving(websiteId, { after: ctx.after });
		if (!serving.ok || (await product.connections.value(websiteId, 'database')) === null) return { ok: false };
		return { ok: true, merchantId: serving.status.merchantId };
	};

	/**
	 * The hosted unsubscribe page: GET asks, POST unsubscribes.
	 * @param {'ask' | 'unsubscribe'} step
	 */
	const unsubscribePage = (step) => async (/** @type {any} */ ctx) => {
		const { websiteId, code } = ctx.params;
		const found = await publicSite(ctx, websiteId);
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
		// the topic the link names (a message with a topic): one-click unsubscribes from it only (fixed-choices N2)
		const choices = await sending.choicesOf(s, address);
		const named = typeof ctx.query.topic === 'string' ? ctx.query.topic : null;
		const topic = choices.topics.some((entry) => entry.id === named) ? named : null;
		if (step === 'ask') {
			const business = (await product.business(websiteId)).name;
			return new Response(
				renderUnsubscribePage({
					texts,
					theme,
					state: 'ask',
					business,
					action: `/unsubscribe/${websiteId}/${code}`,
					// the link's topic is offered unticked; opening the page changes nothing
					topics: choices.topics.map((entry) => ({ ...entry, subscribed: entry.subscribed && entry.id !== topic })),
				}),
				{ headers: PAGE_HEADERS },
			);
		}
		const form = new URLSearchParams(typeof ctx.rawBody === 'string' ? ctx.rawBody : '');
		if (form.get('action') === 'save') {
			const keep = form.getAll('topic').filter((id) => choices.topics.some((entry) => entry.id === id));
			await sending.choose(s, address, keep);
			return new Response(renderUnsubscribePage({ texts, theme, state: 'saved' }), { headers: PAGE_HEADERS });
		}
		// one-click (List-Unsubscribe=One-Click) from a topic's link leaves that topic only; the page's "all" button and a
		// link without a topic leave every optional message
		const oneClick = form.get('List-Unsubscribe') === 'One-Click';
		await sending.unsubscribe(s, address, 'link', oneClick ? topic : null);
		return new Response(renderUnsubscribePage({ texts, theme, state: oneClick && topic ? 'saved' : 'done' }), {
			headers: PAGE_HEADERS,
		});
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
			runtime: true,
			feature: 'email',
			idempotent: true,
			rateLimit: SEND_LIMITS,
			handler: sendHandler('email'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/messages/sms',
			auth: 'server',
			runtime: true,
			feature: 'sms',
			idempotent: true,
			rateLimit: SEND_LIMITS,
			handler: sendHandler('sms'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/messages/whatsapp',
			auth: 'server',
			runtime: true,
			feature: 'whatsapp',
			idempotent: true,
			rateLimit: SEND_LIMITS,
			handler: sendHandler('whatsapp'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/messages/push',
			auth: 'server',
			runtime: true,
			feature: 'browser_push',
			idempotent: true,
			rateLimit: SEND_LIMITS,
			handler: sendHandler('push'),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/messages/staff-push',
			auth: 'server',
			runtime: true,
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
			runtime: true,
			feature: 'webhooks',
			idempotent: true,
			rateLimit: SEND_LIMITS,
			handler: async (ctx) => {
				const checked = checkForwardedEvent(ctx.body);
				if (!checked.ok) return invalid(checked.field, checked.message);
				const s = await siteOf(ctx);
				return ok({ queued: await sending.relay(s, checked.value) }, { status: 202 });
			},
		}),
		// the delivery log for the merchant's server, and its counts with the same filters
		defineRoute({
			method: 'GET',
			path: '/v1/messages',
			auth: 'server',
			permission: 'log.read',
			feature: 'send_api',
			handler: listMessages,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/messages/count',
			auth: 'server',
			permission: 'log.read',
			feature: 'send_api',
			handler: messageCounts.count,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/messages/counts',
			auth: 'server',
			permission: 'log.read',
			feature: 'send_api',
			handler: messageCounts.counts,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/messages/:id',
			auth: 'server',
			permission: 'log.read',
			feature: 'send_api',
			handler: async (ctx) => {
				const message = await (await siteOf(ctx)).store.messages.get(ctx.params.id);
				return message ? messageView(message) : problem('not_found', 'No such message.');
			},
		}),

		// templates for the merchant's server (PLAN 0.8.10 N4): each channel's templates while its feature is on
		defineRoute({
			method: 'GET',
			path: '/v1/templates',
			auth: 'server',
			permission: 'templates.edit',
			feature: ['email', 'sms', 'whatsapp', 'browser_push', 'staff_push'],
			handler: serverTemplates.list,
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/templates',
			auth: 'server',
			permission: 'templates.edit',
			feature: ['email', 'sms', 'whatsapp', 'browser_push', 'staff_push'],
			rateLimit: TEMPLATE_WRITE_LIMITS,
			handler: serverTemplates.save,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/templates/:key/:channel/:language',
			auth: 'server',
			permission: 'templates.edit',
			feature: ['email', 'sms', 'whatsapp', 'browser_push', 'staff_push'],
			rateLimit: TEMPLATE_WRITE_LIMITS,
			handler: serverTemplates.remove,
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
			method: 'GET',
			path: '/v1/admin/messages/count',
			auth: 'ticket',
			permission: 'log.read',
			handler: messageCounts.count,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/messages/counts',
			auth: 'ticket',
			permission: 'log.read',
			handler: messageCounts.counts,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/messages',
			auth: 'ticket',
			permission: 'messages.send',
			idempotent: true,
			rateLimit: SEND_LIMITS,
			handler: async (ctx) => {
				const body = ctx.body ?? {};
				if (!CHANNELS.includes(body.channel)) return invalid('channel', `Pick one of ${CHANNELS.join(', ')}.`);
				const channel = /** @type {Channel} */ (body.channel);
				// transactional (required and urgent, the default) or marketing (optional: unsubscribes, quiet hours and send
				// limits apply), fixed-choices N9
				const kind = body.kind ?? 'transactional';
				if (kind !== 'transactional' && kind !== 'marketing') return invalid('kind', 'kind is transactional or marketing.');
				const s = await siteOf(ctx);
				const topic = body.topic ?? null;
				if (
					topic !== null &&
					(kind !== 'marketing' || !(await product.lists.topics(ctx.websiteId)).some((entry) => entry.id === topic))
				)
					return invalid('topic', 'A marketing message may name one of your unsubscribe topics.');
				const id = typeof body.to === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(body.to) ? body.to : null;
				const to = {
					email: channel === 'email' ? normalizeEmail(body.to) : null,
					phone: channel === 'sms' || channel === 'whatsapp' ? normalizePhone(body.to) : null,
					subscriberId: channel === 'push' ? id : null,
					staffId: channel === 'staff_push' ? id : null,
					language: null,
					timeZone: null,
				};
				if (!to.email && !to.phone && !to.subscriberId && !to.staffId)
					return invalid(
						'to',
						channel === 'email'
							? 'Enter an email address.'
							: channel === 'push' || channel === 'staff_push'
								? 'Enter the subscriber or staff id.'
								: 'Enter a phone number with its country code.',
					);
				// a saved template with sample values (the template editor's test send), else the words typed now
				const template = body.template;
				/** @type {Awaited<ReturnType<typeof sending.accept>>} */
				let result;
				if (template !== undefined) {
					if (typeof template !== 'string' || !TEMPLATE_KEY.test(template))
						return invalid('template', 'Name the template key.');
					const values = checkValues(body.values);
					if (!values.ok)
						return invalid('values', 'values must map up to 50 names to text or numbers (at most 1000 characters).');
					const language = body.language === undefined ? null : languageOfSegment(body.language);
					if (body.language !== undefined && language === null)
						return invalid('language', 'Use a language code such as en, fr or pt-BR.');
					result = await sending.accept(s, {
						channel,
						template,
						content: null,
						to: { ...to, language: language || null },
						values: values.value,
						secretValues: [],
						required: false,
						language: language || null,
						sendAt: null,
						source: 'staff',
						defaults: {},
						fallbackTemplate: null,
						longValues: [],
					});
				} else {
					const text = typeof body.text === 'string' ? body.text.trim() : '';
					const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
					if (text.length === 0 || text.length > 4096)
						return invalid('text', 'Write the message (at most 4096 characters).');
					const titled = isTitled(channel);
					if (titled && (subject.length === 0 || subject.length > 200 || /[\r\n]/.test(subject)))
						return invalid('subject', 'Write the subject or title (one line, at most 200 characters).');
					if (text.length > TEXT_LIMITS[channel])
						return invalid('text', `Write the message (at most ${TEXT_LIMITS[channel]} characters).`);
					result = await sending.accept(s, {
						channel,
						template: null,
						content: { subject: titled ? subject : '', text },
						to,
						values: {},
						secretValues: [],
						required: kind === 'transactional',
						topic,
						language: null,
						sendAt: null,
						source: 'staff',
						defaults: {},
						fallbackTemplate: null,
						longValues: [],
					});
				}
				if (!result.ok) return result.problem;
				await product.activity.record(
					{ websiteId: ctx.websiteId, merchantId: ctx.merchantId, after: ctx.after },
					{
						actor: actorOf(ctx, SERVER),
						action: 'message.sent',
						target: result.message.id,
						// codes, never sentences (N10): the screens word them; a one-off message has no template key
						label: template ?? result.message.id,
						detail: `channel=${channel}${template === undefined ? ` kind=${kind}` : ''} status=${result.message.status}`,
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

		// ------------------------------------------- dashboard: the products' messages and their defaults (parity P1)
		defineRoute({
			method: 'GET',
			path: '/v1/dashboard/websites/:websiteId/messages',
			auth: 'dashboard',
			handler: async (ctx) => {
				const store = createStore(await ctx.data(), { now });
				// the products come from the Portal's directory: without it (never read here) they are not known yet
				const [listed, off] = await Promise.all([product.defaults.all().catch(() => null), store.off.list()]);
				if (!listed) return problem('portal_unreachable', 'The Portal cannot be reached to list the products. Try again.');
				return { items: listed.messages, off, products: listed.products, unavailable: listed.unavailable };
			},
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/dashboard/websites/:websiteId/messages/:key/:channel',
			auth: 'dashboard',
			handler: switchMessage,
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
				const found = await publicSite(ctx, websiteId);
				if (!found.ok || !(await product.featuresOn(websiteId)).includes(channel))
					return problem('not_found', 'Replies are not received for this website.');
				const value = await product.connections.value(websiteId, channel);
				const v = typeof value === 'object' && value !== null ? value : {};
				// any gateway (fixed-choices N4): its own token in the reply address, and the merchant's mapping
				const token = typeof ctx.query.token === 'string' ? ctx.query.token : '';
				const signatureOk =
					v.provider === 'http'
						? typeof v.inboundToken === 'string' && v.inboundToken.length >= 16 && sameText(token, v.inboundToken)
						: v.provider === 'twilio'
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
				const keywords = await product.lists.stopKeywords(websiteId);
				const s = await sending.site({ websiteId, merchantId: found.merchantId, base: new URL(ctx.request.url).origin });
				ctx.after(() => sending.drain(s));
				const replies =
					v.provider === 'http'
						? gatewayRepliesOf(ctx.rawBody, { from: String(v.inboundFrom ?? ''), text: String(v.inboundText ?? '') })
						: repliesOf(v.provider === 'twilio' ? 'twilio' : 'meta', ctx.rawBody);
				for (const reply of replies) {
					const phone = normalizePhone(reply.from);
					if (phone && isOptOut(reply.text, keywords)) await sending.unsubscribe(s, phone, 'keyword');
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
				const found = await publicSite(ctx, ctx.params.websiteId);
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
