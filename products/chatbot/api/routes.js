/**
 * Route table: app-kit's standard resources (entitlement, config, events, strings, health, data export/anonymise,
 * the .well-known endpoints, /sso and — in development — the certification probes) plus the Chatbot Mode C API and
 * the dashboard API (SSO sessions). The cron route lives in jobs/ and is added by the composition root.
 *
 * Every product route is gated by its element (403 element_disabled in every mode). POSTs that create or move state
 * require an Idempotency-Key (app-kit stores and replays the response). Browser (`pk_`) routes identify the customer
 * from `SS-Identity`: the website's own login token (app-kit identity, `identity: 'optional'`), else the guest's
 * marker token; `sk_` routes act for the merchant's server. Handlers are thin: rules live in core/.
 */
import { created, defineRoute, noContent, ok, paginate, problem, standardRoutes } from '@ss/app-kit';
import { conversationView, messageView, validatePatch } from '../core/conversation.js';
import { matchFlow, stepFlow, validateFlow } from '../core/flows.js';
import { validateAgent } from '../core/inbox.js';
import { validateEntry } from '../core/knowledge.js';
import { leakCheck, moderateInbound, moderateOutbound } from '../core/moderation.js';
import { checkCondition } from '../core/rules.js';
import { parametersOf, toolSchemas } from '../core/tools.js';
import { HOUR_MS, iso, monthKey } from '../core/time.js';
import { repositoriesFor } from '../adapters/db.js';
import { DASHBOARD_WRITE_ROLES } from './dashboard.js';
import { createEventHandlers } from './events.js';
import { createNoteHandler } from './notes.js';
import { failed, invalid } from './reply.js';
import { createChatbotService } from './service.js';
import { sessionView } from './session.js';
import { settingsForDoc } from './settings.js';

/** @typedef {import('../adapters/platform.js').ChatbotApp} ChatbotApp */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').Owner} Owner */

/** Header carrying the customer on `pk_` requests (login token or guest marker). */
export const IDENTITY_HEADER = 'ss-identity';

/**
 * Days of an ISO-8601 day duration from the manifest's `retention` (`P180D`); 30 when absent or malformed.
 * @param {unknown} duration
 */
export const retentionDays = (duration) => {
	const match = typeof duration === 'string' ? /^P(\d{1,5})D$/.exec(duration) : null;
	return match ? Number(match[1]) : 30;
};

/** Cursor `<at>|<id>` of a row. @param {string} field */
const cursorOn = (field) => (/** @type {any} */ row) => `${field.split('.').reduce((v, k) => v?.[k], row)}|${row.id}`;

/**
 * The application (service + site resolution) shared by the routes, the event consumers, the jobs and the dashboard.
 * @param {ChatbotApp} app
 */
export const createChatbot = (app) => {
	const { product } = app;
	const repoFor = repositoriesFor(product, { now: app.now });
	const service = createChatbotService({
		publish: (event) => product.portal.publishEvent(event),
		recordUsage: (usage) => product.usage.record(usage),
		audit: (entry) => product.audit.record(entry),
		ai: (websiteId) => product.connectors.ai(websiteId),
		outbound: app.outbound,
		tokens: app.tokens,
		hash: app.hash,
		randomBytes: app.randomBytes,
		now: app.now,
		strings: app.strings,
		log: product.context?.logger,
		retention: {
			orders: retentionDays(product.manifest.retention?.orders),
			customers: retentionDays(product.manifest.retention?.customers),
			visitors: retentionDays(product.manifest.retention?.visitors),
		},
	});
	/**
	 * @param {string} websiteId
	 * @param {any} doc
	 * @param {string | null} domain
	 * @returns {Promise<Site>}
	 */
	const siteOf = async (websiteId, doc, domain) => {
		await app.registry.remember(websiteId);
		return {
			websiteId,
			domain: domain ?? (typeof doc.domain === 'string' ? doc.domain : null),
			settings: settingsForDoc(product, doc),
			repos: await repoFor(websiteId, { merchantId: doc.merchantId, env: doc.env }),
		};
	};
	/** Site from the entitlement (null without an active subscription or with the window off). @param {string} websiteId */
	const siteFor = async (websiteId) => {
		const result = await product.entitlements.forWebsite(websiteId);
		if (!result.ok || !product.entitlements.can(result.doc, 'window')) return null;
		return siteOf(websiteId, result.doc, null);
	};
	return { app, product, service, siteOf, siteFor };
};

/** @typedef {ReturnType<typeof createChatbot>} Chatbot */

/**
 * @param {Chatbot} chatbot
 */
export const buildRoutes = (chatbot) => {
	const { app, product, service, siteOf } = chatbot;
	/** @param {any} ctx */
	const site = (ctx) => siteOf(ctx.websiteId, ctx.entitlement.doc, ctx.website?.domain ?? null);

	/**
	 * Who is asking. `pk_`: the verified login token (`ctx.identity`), else the guest marker; `sk_`: the merchant's
	 * server may name a customer (`customerId` in the body or query).
	 * @param {any} ctx
	 * @returns {Owner}
	 */
	const ownerOf = (ctx) => {
		if (ctx.website?.kind === 'pk') {
			if (ctx.identity)
				return {
					customerId: ctx.identity.subject,
					visitorId: null,
					identity: { subject: ctx.identity.subject, email: ctx.identity.email ?? null },
				};
			const visitorId = app.tokens.verifyMarker(ctx.headers.get(IDENTITY_HEADER), ctx.websiteId);
			return { customerId: null, visitorId, identity: null };
		}
		const named =
			typeof ctx.body?.customerId === 'string' && ctx.body.customerId
				? ctx.body.customerId
				: typeof ctx.query.customerId === 'string' && ctx.query.customerId
					? ctx.query.customerId
					: null;
		return { customerId: named, visitorId: null, identity: named ? { subject: named, email: null } : null };
	};
	const isServer = (/** @type {any} */ ctx) => ctx.website?.kind === 'sk';
	/** Website routes: `pk` (browser, identity optional) or `sk` (server). @param {string} element @param {'sk' | 'any'} [keys] */
	const website = (element, keys = 'any') => ({
		auth: /** @type {const} */ ('website'),
		element,
		...(keys === 'sk' ? { keyKind: /** @type {const} */ ('sk') } : { identity: /** @type {const} */ ('optional') }),
	});
	/**
	 * A conversation the caller may use (servers: any of the website; browsers: their own).
	 * @param {any} ctx
	 * @param {Site} s
	 * @param {string} id
	 */
	const conversationFor = async (ctx, s, id) => {
		const conversation = await s.repos.conversations.get(id);
		if (!conversation) return null;
		if (isServer(ctx)) return conversation;
		return service.owns(conversation, ownerOf(ctx)) ? conversation : null;
	};
	const audienceOf = (/** @type {any} */ ctx) =>
		isServer(ctx) ? /** @type {const} */ ('team') : /** @type {const} */ ('customer');
	/** @param {any} ctx @param {Site} s @param {any} c */
	const viewOf = (ctx, s, c) => conversationView(c, audienceOf(ctx), { guestLimit: s.settings.window.guest_message_limit });
	const notFound = () => problem('not_found', 'No such conversation.');

	/**
	 * Per-visitor message rate (`window.messages_per_minute`, per website configuration) as an app-kit dynamic route
	 * limit: browsers are limited per customer / guest marker, servers per conversation; agent and bot replies posted
	 * by the merchant's server are not limited.
	 */
	const messageRate = Object.freeze({
		windowMs: 60_000,
		/** @param {any} ctx */
		limit: (ctx) => {
			const author = ctx.body?.author;
			if (isServer(ctx) && (author === 'agent' || author === 'bot')) return Number.POSITIVE_INFINITY;
			return settingsForDoc(product, ctx.entitlement.doc).window.messages_per_minute;
		},
		/** @param {any} ctx */
		key: (ctx) => {
			const owner = isServer(ctx) ? null : ownerOf(ctx);
			return `w:${ctx.websiteId}|${owner?.customerId ?? owner?.visitorId ?? `c:${ctx.params.id}`}`;
		},
	});

	/** Dashboard session → site (null = pick a website / demo). @param {any} ctx */
	const dashboardSite = async (ctx) => (ctx.websiteId && ctx.entitlement ? site(ctx) : null);
	/** Dashboard actor. @param {any} ctx */
	const dashboardActor = (ctx) => {
		const view = sessionView(ctx.session);
		return view.actor
			? { type: /** @type {const} */ ('staff'), id: view.actor, name: null }
			: {
					type: view.kind === 'admin' ? /** @type {const} */ ('staff') : /** @type {const} */ ('merchant'),
					id: view.user ?? 'unknown',
					name: ctx.session?.user?.email ?? null,
				};
	};
	/** The dashboard user's agent record (created on first reply when the inbox is on). @param {Site} s @param {any} ctx */
	const dashboardAgent = async (s, ctx) => {
		if (!s.settings.inbox) return null;
		const actor = dashboardActor(ctx);
		const userId = String(actor.id);
		const existing = await s.repos.agents.byUser(userId);
		if (existing) return existing;
		if ((await s.repos.agents.count()) >= s.settings.inbox.max_agents) return null;
		const agent = {
			id: `agt_${app.hash(`user:${userId}`)}`,
			userId,
			name: actor.name ?? userId,
			email: actor.name && actor.name.includes('@') ? actor.name : null,
			teams: [],
			status: 'online',
			active: true,
			maxConcurrent: null,
			deletedAt: null,
		};
		await s.repos.agents.insert(agent);
		return (await s.repos.agents.byUser(userId)) ?? agent;
	};

	// shared handlers for website and dashboard routes ───────────────────────────────────────────────────────
	/** @param {any} ctx @param {Site} s @param {any} conversation @param {import('./service.js').Actor} actor @param {string | null} agentId */
	const replyAsAgent = async (ctx, s, conversation, actor, agentId) => {
		const result = await service.agentMessage(s, conversation, {
			text: ctx.body?.text,
			key: ctx.idempotencyKey,
			actor,
			agentId,
		});
		if (!result.ok) return failed(result);
		return created({
			message: messageView(result.message, 'team'),
			conversation: conversationView(result.conversation, 'team'),
		});
	};
	/** @param {any} ctx @param {Site} s @param {any} conversation @param {import('./service.js').Actor} actor */
	const patchAs = async (ctx, s, conversation, actor) => {
		const teams = (s.settings.inbox?.teams ?? [{ key: 'support' }]).map((/** @type {any} */ t) => t.key);
		const problems = validatePatch(ctx.body, {
			allowedTags: s.settings.inbox?.tags ?? [],
			teams,
			snoozeMaxMs: (s.settings.inbox?.snooze_max_hours ?? 168) * HOUR_MS,
			now: app.now(),
		});
		if (problems.length > 0) return invalid(problems);
		const result = await service.patch(s, conversation, ctx.body, {
			actor,
			key: ctx.idempotencyKey ?? `patch:${ctx.requestId}`,
		});
		return result.ok ? ok(conversationView(result.conversation, 'team')) : failed(result);
	};
	const noteAs = createNoteHandler({ service });

	return [
		...standardRoutes(product),
		defineRoute({ method: 'GET', path: '/v1/session', auth: 'launch', handler: (ctx) => ok(sessionView(ctx.session)) }),

		// ── window: conversations and messages ──────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/conversations',
			...website('window'),
			handler: async (ctx) => {
				const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
				const s = await site(ctx);
				const status =
					typeof ctx.query.status === 'string' && ctx.query.status ? ctx.query.status.split(',').slice(0, 5) : null;
				if (!isServer(ctx)) {
					const owner = ownerOf(ctx);
					/** @type {Array<Record<string, string>>} */
					const owners = [
						...(owner.customerId ? [{ customerId: owner.customerId }] : []),
						...(owner.visitorId ? [{ visitorId: owner.visitorId }] : []),
					];
					if (owners.length === 0) return page.respond([]);
					const historyOff = Boolean(owner.customerId) && !s.settings.window.persistent_history;
					const items = await s.repos.conversations.list({
						owners,
						status: historyOff ? ['open', 'pending', 'snoozed'] : status,
						after: typeof page.after === 'string' ? page.after : null,
						fetchLimit: page.fetchLimit,
					});
					return page.respond(
						items.map((/** @type {any} */ c) => viewOf(ctx, s, c)),
						cursorOn('lastMessageAt'),
					);
				}
				const items = await s.repos.conversations.list({
					customerId: typeof ctx.query.customerId === 'string' ? ctx.query.customerId : null,
					status,
					assignee: typeof ctx.query.assignee === 'string' ? ctx.query.assignee : null,
					team: typeof ctx.query.team === 'string' ? ctx.query.team : null,
					after: typeof page.after === 'string' ? page.after : null,
					fetchLimit: page.fetchLimit,
				});
				return page.respond(
					items.map((/** @type {any} */ c) => viewOf(ctx, s, c)),
					cursorOn('lastMessageAt'),
				);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/conversations',
			...website('window'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const body = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {};
				let owner = ownerOf(ctx);
				/** @type {{ token: string, expiresAt: string } | null} */
				let marker = null;
				if (!isServer(ctx) && !owner.customerId && !owner.visitorId) {
					const visitorId = `vis_${app.hash(`visitor:${ctx.websiteId}:${ctx.idempotencyKey}`)}`;
					owner = { ...owner, visitorId };
					marker = app.tokens.issueMarker({ websiteId: ctx.websiteId, visitorId, days: s.settings.window.guest_token_days });
				}
				if (
					body.text !== undefined &&
					(typeof body.text !== 'string' || [...body.text].length > s.settings.window.max_message_length)
				)
					return invalid([{ path: '/text', code: 'invalid' }]);
				if (
					isServer(ctx) &&
					body.customerId !== undefined &&
					(typeof body.customerId !== 'string' || body.customerId.length > 255)
				)
					return invalid([{ path: '/customerId', code: 'invalid' }]);
				const started = await service.start(s, {
					owner,
					text: typeof body.text === 'string' && body.text.trim() ? body.text : null,
					context: body.context,
					language: typeof body.language === 'string' ? body.language : null,
					subject: isServer(ctx) && typeof body.subject === 'string' ? body.subject.slice(0, 200) : null,
					contact: null,
					...(isServer(ctx) && body.custom && typeof body.custom === 'object' && !Array.isArray(body.custom)
						? { custom: body.custom }
						: {}),
					key: ctx.idempotencyKey,
					enforceOpenLimit: !isServer(ctx),
				});
				if (!started.ok) return failed(started);
				let conversation = started.conversation;
				/** @type {any[]} */
				const messages = started.messages.map((/** @type {any} */ m) => messageView(m, audienceOf(ctx)));
				/** @type {Record<string, unknown>} */
				const extra = {};
				if (started.created && started.text) {
					const sent = await service.customerMessage(s, conversation, {
						text: started.text,
						key: `${ctx.idempotencyKey}:first`,
						owner,
					});
					if (!sent.ok) return failed(sent);
					conversation = sent.conversation;
					extra.message = messageView(sent.message, audienceOf(ctx));
					extra.replies = sent.replies.map((/** @type {any} */ m) => messageView(m, audienceOf(ctx))).filter(Boolean);
				}
				return created(
					{
						conversation: viewOf(ctx, s, conversation),
						messages: messages.filter(Boolean),
						...extra,
						...(marker ? { marker } : {}),
					},
					{ location: `/v1/conversations/${conversation.id}` },
				);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/conversations:claim',
			auth: 'website',
			element: 'window',
			keyKind: 'pk',
			identity: 'required',
			handler: async (ctx) => {
				const visitorId = app.tokens.verifyMarker(ctx.body?.marker, ctx.websiteId);
				if (!visitorId) return problem('invalid_marker', 'The guest marker is invalid or expired.');
				const claimed = await service.claim(await site(ctx), visitorId, /** @type {any} */ (ctx.identity).subject);
				return ok({ claimed });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/conversations/:id',
			...website('window'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const conversation = await conversationFor(ctx, s, ctx.params.id);
				return conversation ? ok(viewOf(ctx, s, conversation)) : notFound();
			},
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/conversations/:id',
			...website('window', 'sk'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const conversation = await s.repos.conversations.get(ctx.params.id);
				if (!conversation) return notFound();
				return patchAs(ctx, s, conversation, { type: 'api', id: ctx.website.keyId });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/conversations/:id/messages',
			...website('window'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const conversation = await conversationFor(ctx, s, ctx.params.id);
				if (!conversation) return notFound();
				const audience = audienceOf(ctx);
				const since =
					typeof ctx.query.since === 'string' && !Number.isNaN(Date.parse(ctx.query.since))
						? new Date(ctx.query.since).toISOString()
						: null;
				const before = typeof ctx.query.before === 'string' ? ctx.query.before.slice(0, 64) : null;
				const limit = Math.min(
					100,
					Math.max(
						1,
						Number.parseInt(String(ctx.query.limit ?? s.settings.window.history_page_size), 10) ||
							s.settings.window.history_page_size,
					),
				);
				const page = await service.messages(s, conversation, { since, before, limit, audience });
				const headers = { etag: page.etag, 'cache-control': 'private, no-cache' };
				if (!before && ctx.headers.get('if-none-match') === page.etag) return ok(undefined, { status: 304, headers });
				return ok({ ...page, conversation: viewOf(ctx, s, conversation) }, { headers });
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/conversations/:id/messages',
			...website('window'),
			rateLimit: messageRate,
			handler: async (ctx) => {
				const s = await site(ctx);
				const conversation = await conversationFor(ctx, s, ctx.params.id);
				if (!conversation) return notFound();
				const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
				if (isServer(ctx) && (body.author === 'agent' || body.author === 'bot')) {
					if (!s.settings.inbox && body.author === 'agent')
						return problem('element_disabled', "Element 'inbox' is not enabled for this website.");
					return replyAsAgent(
						ctx,
						s,
						conversation,
						{
							type: 'api',
							id: ctx.website.keyId,
							name: typeof body.authorName === 'string' ? body.authorName.slice(0, 80) : null,
						},
						typeof body.agentId === 'string' ? body.agentId : null,
					);
				}
				const owner = isServer(ctx)
					? {
							customerId: conversation.customerId,
							visitorId: conversation.visitorId,
							identity: conversation.customerId ? { subject: conversation.customerId, email: null } : null,
						}
					: ownerOf(ctx);
				const result = await service.customerMessage(s, conversation, {
					text: body.text,
					action: body.action,
					key: ctx.idempotencyKey,
					owner,
				});
				if (!result.ok) return failed(result);
				const audience = audienceOf(ctx);
				return created({
					message: messageView(result.message, audience),
					replies: result.replies.map((/** @type {any} */ m) => messageView(m, audience)).filter(Boolean),
					conversation: viewOf(ctx, s, result.conversation),
				});
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/conversations/:id/read',
			...website('window'),
			idempotent: 'optional',
			handler: async (ctx) => {
				const s = await site(ctx);
				const conversation = await conversationFor(ctx, s, ctx.params.id);
				if (!conversation) return notFound();
				return ok(viewOf(ctx, s, await service.markRead(s, conversation, audienceOf(ctx))));
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/conversations/:id/close',
			...website('window'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const conversation = await conversationFor(ctx, s, ctx.params.id);
				if (!conversation) return notFound();
				const result = await service.close(s, conversation, {
					actor: isServer(ctx)
						? { type: 'api', id: ctx.website.keyId }
						: { type: 'customer', id: conversation.customerId ?? conversation.visitorId },
					reason: isServer(ctx) ? 'api' : 'customer',
					key: ctx.idempotencyKey,
				});
				return ok({
					conversation: viewOf(ctx, s, result.conversation),
					messages: result.messages.map((m) => messageView(m, audienceOf(ctx))).filter(Boolean),
				});
			},
		}),

		// ── inbox: notes, agents, summary, canned replies ───────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/conversations/:id/notes',
			...website('inbox', 'sk'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const conversation = await s.repos.conversations.get(ctx.params.id);
				if (!conversation) return notFound();
				return ok({
					items: (await s.repos.messages.notes(conversation.id)).map((/** @type {any} */ m) => messageView(m, 'team')),
				});
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/conversations/:id/notes',
			...website('inbox', 'sk'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const conversation = await s.repos.conversations.get(ctx.params.id);
				if (!conversation) return notFound();
				return noteAs(
					ctx,
					s,
					conversation,
					{ type: 'api', id: ctx.website.keyId },
					typeof ctx.body?.agentId === 'string' ? ctx.body.agentId : null,
				);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/agents',
			...website('inbox', 'sk'),
			handler: async (ctx) => {
				const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
				const s = await site(ctx);
				const items = await s.repos.agents.list({
					after: typeof page.after === 'string' ? page.after : null,
					fetchLimit: page.fetchLimit,
				});
				return page.respond(items, (/** @type {any} */ a) => a.id);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/agents',
			...website('inbox', 'sk'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const teams = (s.settings.inbox?.teams ?? []).map((/** @type {any} */ t) => t.key);
				const problems = validateAgent(ctx.body, { teams });
				if (problems.length > 0) return invalid(problems);
				if ((await s.repos.agents.count()) >= /** @type {any} */ (s.settings.inbox).max_agents)
					return problem('limit_reached', 'The agent limit of your plan is reached.');
				const agent = {
					id: `agt_${app.hash(`agent:${ctx.websiteId}:${ctx.idempotencyKey}`)}`,
					name: ctx.body.name.trim(),
					email: ctx.body.email ?? null,
					teams: ctx.body.teams ?? [],
					status: ctx.body.status ?? 'offline',
					active: ctx.body.active ?? true,
					maxConcurrent: ctx.body.maxConcurrent ?? null,
					...(ctx.body.userId ? { userId: ctx.body.userId } : {}),
					deletedAt: null,
				};
				if (!(await s.repos.agents.insert(agent)) && !(await s.repos.agents.get(agent.id)))
					return problem('conflict', 'This user is already an agent.');
				return created(await s.repos.agents.get(agent.id), { location: `/v1/agents/${agent.id}` });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/agents/:id',
			...website('inbox', 'sk'),
			handler: async (ctx) => {
				const agent = await (await site(ctx)).repos.agents.get(ctx.params.id);
				return agent ? ok(agent) : problem('not_found', 'No such agent.');
			},
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/agents/:id',
			...website('inbox', 'sk'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const problems = validateAgent(ctx.body, {
					partial: true,
					teams: (s.settings.inbox?.teams ?? []).map((/** @type {any} */ t) => t.key),
				});
				if (problems.length > 0) return invalid(problems);
				const agent = await s.repos.agents.update(ctx.params.id, ctx.body);
				return agent ? ok(agent) : problem('not_found', 'No such agent.');
			},
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/agents/:id',
			...website('inbox', 'sk'),
			handler: async (ctx) =>
				(await (await site(ctx)).repos.agents.remove(ctx.params.id, iso(app.now())))
					? noContent()
					: problem('not_found', 'No such agent.'),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/inbox',
			...website('inbox', 'sk'),
			handler: async (ctx) => ok(await service.inboxSummary(await site(ctx))),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/inbox/canned-replies',
			...website('inbox', 'sk'),
			handler: async (ctx) => {
				const s = await site(ctx);
				return ok({
					items: (s.settings.inbox?.canned_replies ?? []).map((/** @type {any} */ r) => ({
						key: r.key,
						title: r.title ?? r.key,
						body: r.body,
						language: r.language ?? null,
					})),
				});
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/inbox/canned-replies:render',
			...website('inbox', 'sk'),
			idempotent: false,
			handler: async (ctx) => {
				const s = await site(ctx);
				if (typeof ctx.body?.key !== 'string' || typeof ctx.body?.conversationId !== 'string')
					return invalid([{ path: '/key', code: 'required' }]);
				const conversation = await s.repos.conversations.get(ctx.body.conversationId);
				if (!conversation) return notFound();
				const result = await service.canned(s, conversation, {
					key: ctx.body.key,
					agentId: typeof ctx.body.agentId === 'string' ? ctx.body.agentId : null,
				});
				return result.ok ? ok({ text: result.text }) : failed(result);
			},
		}),

		// ── handoff ─────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/handoffs',
			...website('handoff', 'sk'),
			handler: async (ctx) => {
				const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
				const s = await site(ctx);
				const items = await s.repos.conversations.list({
					waiting: true,
					after: typeof page.after === 'string' ? page.after : null,
					fetchLimit: page.fetchLimit,
				});
				return page.respond(
					items.map((/** @type {any} */ c) => conversationView(c, 'team')),
					cursorOn('lastMessageAt'),
				);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/handoffs',
			...website('handoff'),
			handler: async (ctx) => {
				const s = await site(ctx);
				if (typeof ctx.body?.conversationId !== 'string') return invalid([{ path: '/conversationId', code: 'required' }]);
				const conversation = await conversationFor(ctx, s, ctx.body.conversationId);
				if (!conversation) return notFound();
				const team = isServer(ctx) && typeof ctx.body.team === 'string' ? ctx.body.team : null;
				const reason =
					typeof ctx.body.reason === 'string' && ctx.body.reason
						? ctx.body.reason.slice(0, 120)
						: isServer(ctx)
							? 'api'
							: 'customer_request';
				const result = await service.requestHandoff(s, conversation, { reason, team, key: ctx.idempotencyKey });
				if (!result.ok) return failed(result);
				return created({
					conversation: viewOf(ctx, s, result.conversation),
					messages: result.messages.map((m) => messageView(m, audienceOf(ctx))).filter(Boolean),
				});
			},
		}),

		// ── ai_replies ──────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/assistant',
			...website('ai_replies', 'sk'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const ai = /** @type {Record<string, any>} */ (s.settings.ai);
				const month = monthKey(app.now(), s.settings.timeZone);
				const used = await s.repos.counters.get(`tokens:${month}`);
				/** @type {{ provider: string | null, model: string | null, connected: boolean }} */
				let connector = { provider: null, model: null, connected: false };
				try {
					const adapter = await product.connectors.ai(ctx.websiteId);
					connector = { provider: adapter.provider, model: adapter.model ?? null, connected: true };
				} catch {
					// not connected or the Portal is unreachable: the status says so
				}
				return ok({
					connector,
					model: ai.model || connector.model || ai.default_models[connector.provider ?? 'openai'] || null,
					month,
					tokensUsed: used,
					monthlyBudget: ai.monthly_token_budget,
					remaining: ai.monthly_token_budget > 0 ? Math.max(0, ai.monthly_token_budget - used) : null,
					tokensPerConversation: ai.tokens_per_conversation,
					maxToolRounds: ai.max_tool_rounds,
					tools: toolSchemas({
						config: s.settings.tools,
						identified: true,
						knowledge: Boolean(s.settings.knowledge),
						handoff: Boolean(s.settings.handoff),
						t: service.translator('en'),
					}).map((t) => t.name),
				});
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/assistant:preview',
			...website('ai_replies', 'sk'),
			handler: async (ctx) => {
				const s = await site(ctx);
				if (typeof ctx.body?.text !== 'string' || !ctx.body.text.trim())
					return invalid([{ path: '/text', code: 'required' }]);
				const language = typeof ctx.body.language === 'string' ? ctx.body.language : s.settings.window.default_language;
				const conversation = /** @type {any} */ ({
					id: `preview_${app.hash(ctx.idempotencyKey)}`,
					tokens: 0,
					toolCalls: 0,
					context: null,
					ai: { failures: 0, paused: false },
					contact: null,
				});
				const result = await service.assistant.answer(s, {
					conversation,
					text: ctx.body.text,
					language,
					identity: null,
					history: [],
					t: service.translator(language),
					meterKey: `preview:${ctx.idempotencyKey}`,
				});
				return ok({
					replies: result.bubbles,
					failure: result.failure,
					usage: result.usage,
					tools: result.tools,
					passages: result.passages,
					dontKnow: result.dontKnow,
				});
			},
		}),

		// ── knowledge ───────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/knowledge-entries',
			...website('knowledge', 'sk'),
			handler: async (ctx) => {
				const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
				const items = await (
					await site(ctx)
				).repos.entries.list({ after: typeof page.after === 'string' ? page.after : null, fetchLimit: page.fetchLimit });
				return page.respond(items, (/** @type {any} */ e) => e.id);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/knowledge-entries',
			...website('knowledge', 'sk'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const problems = validateEntry(ctx.body);
				if (problems.length > 0) return invalid(problems);
				const result = await createEntry(s, ctx.body, `entry:${ctx.idempotencyKey}`);
				return result.ok ? created(result.entry, { location: `/v1/knowledge-entries/${result.entry.id}` }) : failed(result);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/knowledge-entries:batch',
			...website('knowledge', 'sk'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const items = Array.isArray(ctx.body?.items) ? ctx.body.items.slice(0, 100) : null;
				if (!items) return invalid([{ path: '/items', code: 'required' }]);
				const results = [];
				for (const [index, item] of items.entries()) {
					const problems = validateEntry(item);
					if (problems.length > 0) {
						results.push({ index, status: 'invalid', errors: problems });
						continue;
					}
					const result = await createEntry(s, item, `entry:${ctx.idempotencyKey}:${index}`);
					results.push(
						result.ok
							? { index, status: 'created', id: result.entry.id }
							: { index, status: 'rejected', reason: result.reason },
					);
				}
				return ok({ results });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/knowledge-entries/:id',
			...website('knowledge', 'sk'),
			handler: async (ctx) => {
				const entry = await (await site(ctx)).repos.entries.get(ctx.params.id);
				return entry ? ok(entry) : problem('not_found', 'No such entry.');
			},
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/knowledge-entries/:id',
			...website('knowledge', 'sk'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const problems = validateEntry(ctx.body, { partial: true });
				if (problems.length > 0) return invalid(problems);
				const set = Object.fromEntries(Object.entries(ctx.body).filter(([key]) => key !== 'id'));
				const entry = await s.repos.entries.update(ctx.params.id, set);
				if (!entry) return problem('not_found', 'No such entry.');
				await service.knowledge.indexEntry(s, entry);
				return ok(entry);
			},
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/knowledge-entries/:id',
			...website('knowledge', 'sk'),
			handler: async (ctx) => {
				const s = await site(ctx);
				if (!(await s.repos.entries.remove(ctx.params.id, iso(app.now())))) return problem('not_found', 'No such entry.');
				await s.repos.chunks.removeSource('faq', ctx.params.id);
				return noContent();
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/knowledge-sources',
			...website('knowledge', 'sk'),
			handler: async (ctx) => ok({ items: await service.knowledge.sources(await site(ctx)) }),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/knowledge-sources/:id/refresh',
			...website('knowledge', 'sk'),
			idempotent: 'optional',
			handler: async (ctx) => {
				const s = await site(ctx);
				const source = (s.settings.knowledge?.sources ?? []).find((/** @type {any} */ src) => src.id === ctx.params.id);
				if (!source) return problem('not_found', 'No such source in the configuration.');
				const result = await service.knowledge.refreshSource(s, source);
				return result.ok
					? ok({ id: source.id, chunks: result.chunks, title: result.title })
					: problem('source_failed', `The page could not be fetched (${result.code}).`);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/knowledge:search',
			...website('knowledge', 'sk'),
			idempotent: false,
			handler: async (ctx) => {
				if (typeof ctx.body?.query !== 'string' || !ctx.body.query.trim())
					return invalid([{ path: '/query', code: 'required' }]);
				const topK = Number.isInteger(ctx.body.topK) ? Math.min(20, Math.max(1, ctx.body.topK)) : undefined;
				return ok({
					items: await service.knowledge.search(await site(ctx), ctx.body.query.slice(0, 1000), topK ? { topK } : {}),
				});
			},
		}),

		// ── flows ───────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/flows',
			...website('flows', 'sk'),
			handler: async (ctx) => {
				const flows = (await site(ctx)).settings.flows?.flows ?? [];
				return ok({ items: flows.map((/** @type {any} */ flow) => ({ ...flow, diagnostics: validateFlow(flow) })) });
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/flows:check',
			...website('flows', 'sk'),
			idempotent: false,
			handler: (ctx) => {
				if (ctx.body?.condition !== undefined)
					return typeof ctx.body.condition === 'string'
						? ok(checkCondition(ctx.body.condition, 'flow'))
						: invalid([{ path: '/condition', code: 'invalid' }]);
				const flow = ctx.body?.flow;
				if (!flow || typeof flow !== 'object' || !Array.isArray(flow.nodes))
					return invalid([{ path: '/flow', code: 'required' }]);
				return ok(validateFlow(flow));
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/flows:simulate',
			...website('flows', 'sk'),
			idempotent: false,
			handler: async (ctx) => {
				const s = await site(ctx);
				const flows = /** @type {Record<string, any>} */ (s.settings.flows);
				const flow = ctx.body?.flow ?? (flows.flows ?? []).find((/** @type {any} */ f) => f.id === ctx.body?.flowId);
				if (!flow || !Array.isArray(flow.nodes)) return problem('unknown_flow', 'Give a flow or a configured flowId.');
				const diagnostics = validateFlow(flow);
				if (!diagnostics.ok) return ok({ diagnostics, steps: [] });
				const inputs = Array.isArray(ctx.body.inputs) ? ctx.body.inputs.slice(0, 50) : [];
				const t = service.translator(s.settings.window.default_language);
				/** @type {any} */
				let state = null;
				const steps = [];
				const options = {
					maxSteps: flows.max_steps_per_turn,
					unmatched: flows.unmatched_input,
					exitKeywords: flows.exit_keywords,
					now: app.now(),
					timeZone: s.settings.timeZone,
					invalidAnswer: t('flows.invalid_answer'),
				};
				const context = typeof ctx.body.context === 'object' && ctx.body.context ? ctx.body.context : {};
				const deps = {
					runAi: async (/** @type {string} */ prompt) => `[ai_step] ${prompt}`,
					runTool: async (/** @type {string} */ name) => ({ ok: true, output: `[tool] ${name}` }),
				};
				const first = await stepFlow({ flow, state: null, input: { kind: 'start' }, context, options }, deps);
				steps.push({ input: null, outputs: first.outputs, effects: first.effects, state: first.state });
				state = first.state;
				for (const input of inputs) {
					if (!state) break;
					const next = await stepFlow(
						{ flow, state, input: typeof input === 'string' ? { kind: 'text', text: input } : input, context, options },
						deps,
					);
					steps.push({ input, outputs: next.outputs, effects: next.effects, state: next.state });
					state = next.state;
				}
				return ok({
					diagnostics,
					steps,
					matchesStart: Boolean(
						matchFlow(
							[flow],
							{ entry: 'start', path: context?.page?.path ?? '' },
							{ context, now: app.now(), timeZone: s.settings.timeZone },
						),
					),
				});
			},
		}),

		// ── tools ───────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/tools',
			...website('tools', 'sk'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const tools = /** @type {Record<string, any>} */ (s.settings.tools);
				return ok({
					builtIn: {
						orderLookup: tools.order_lookup,
						guestOrderLookup: tools.guest_order_lookup,
						knowledgeSearch: tools.knowledge_search,
						escalate: tools.escalate,
					},
					items: (tools.custom ?? []).map((/** @type {any} */ tool) => ({
						name: tool.name,
						description: tool.description,
						url: tool.url,
						parameters: parametersOf(tool),
						allowAi: tool.allow_ai !== false,
						allowFlows: tool.allow_flows !== false,
						timeoutMs: tool.timeout_ms ?? 8000,
					})),
					signingKeyVersion: tools.signing_key_version,
				});
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/tools/:name/invoke',
			...website('tools', 'sk'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const tool = (s.settings.tools?.custom ?? []).find((/** @type {any} */ t) => t.name === ctx.params.name);
				if (!tool) return problem('unknown_tool', 'No such webhook tool in the configuration.');
				const args = ctx.body?.arguments && typeof ctx.body.arguments === 'object' ? ctx.body.arguments : {};
				const result = await service.assistant.executeTool(
					{
						...s,
						settings: {
							...s.settings,
							tools: { .../** @type {any} */ (s.settings.tools), custom: [{ ...tool, allow_ai: true }] },
						},
					},
					{ conversation: null, identity: null, t: service.translator('en'), meterKey: `invoke:${ctx.idempotencyKey}` },
					{ id: 'invoke', name: tool.name, arguments: args },
				);
				return ok({ ok: result.ok, output: result.content });
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/tools:signing-secret',
			...website('tools', 'sk'),
			idempotent: false,
			handler: async (ctx) => {
				const s = await site(ctx);
				const version = Number(s.settings.tools?.signing_key_version ?? 1);
				return ok({
					version,
					secret: app.tokens.toolSecret(ctx.websiteId, version),
					header: 'ss-chatbot-signature',
					algorithm: 'HMAC-SHA256',
					signed: 'ss-chatbot-tool.v1.<t>.<body>',
				});
			},
		}),

		// ── proactive ───────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/proactive',
			...website('proactive'),
			handler: async (ctx) => {
				const rules = (await site(ctx)).settings.proactive?.rules ?? [];
				return ok({
					items: rules
						.filter((/** @type {any} */ r) => isServer(ctx) || r.enabled !== false)
						.map((/** @type {any} */ r) => (isServer(ctx) ? r : { id: r.id, delaySeconds: r.delay_seconds ?? 0 })),
				});
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/proactive:evaluate',
			...website('proactive'),
			idempotent: false,
			handler: async (ctx) => {
				const s = await site(ctx);
				const owner = ownerOf(ctx);
				const anon =
					typeof ctx.body?.visitorId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(ctx.body.visitorId)
						? ctx.body.visitorId
						: null;
				const visitorKey = owner.customerId
					? `c:${owner.customerId}`
					: owner.visitorId
						? `v:${owner.visitorId}`
						: anon
							? `a:${anon}`
							: null;
				const sessionId = typeof ctx.body?.sessionId === 'string' ? ctx.body.sessionId.slice(0, 64) : null;
				const message = await service.proactive(s, {
					visitorKey,
					sessionId,
					context: ctx.body?.context,
					identified: Boolean(owner.customerId),
					owner,
				});
				return ok({ message });
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/proactive:dismiss',
			...website('proactive'),
			idempotent: 'optional',
			handler: async (ctx) => {
				const s = await site(ctx);
				const owner = ownerOf(ctx);
				const anon =
					typeof ctx.body?.visitorId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(ctx.body.visitorId)
						? ctx.body.visitorId
						: null;
				const visitorKey = owner.customerId
					? `c:${owner.customerId}`
					: owner.visitorId
						? `v:${owner.visitorId}`
						: anon
							? `a:${anon}`
							: null;
				if (typeof ctx.body?.ruleId !== 'string') return invalid([{ path: '/ruleId', code: 'required' }]);
				if (visitorKey) await service.dismissProactive(s, visitorKey, ctx.body.ruleId.slice(0, 40));
				return ok({ dismissed: Boolean(visitorKey) });
			},
		}),

		// ── lead_capture ────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/leads',
			...website('lead_capture', 'sk'),
			handler: async (ctx) => {
				const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
				const items = await (
					await site(ctx)
				).repos.leads.list({ after: typeof page.after === 'string' ? page.after : null, fetchLimit: page.fetchLimit });
				return page.respond(items, cursorOn('at'));
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/leads/:id',
			...website('lead_capture', 'sk'),
			handler: async (ctx) => {
				const lead = await (await site(ctx)).repos.leads.get(ctx.params.id);
				return lead ? ok(lead) : problem('not_found', 'No such lead.');
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/leads',
			...website('lead_capture'),
			handler: async (ctx) => {
				const s = await site(ctx);
				const body = ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body) ? ctx.body : {};
				const conversation =
					typeof body.conversationId === 'string' ? await conversationFor(ctx, s, body.conversationId) : null;
				if (typeof body.conversationId === 'string' && !conversation) return notFound();
				const owner =
					isServer(ctx) && conversation
						? { customerId: conversation.customerId, visitorId: conversation.visitorId, identity: null }
						: ownerOf(ctx);
				const rest = Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'customerId'));
				const result = await service.lead(s, { body: rest, owner, key: ctx.idempotencyKey, conversation });
				return result.ok ? created(result.lead, { location: `/v1/leads/${result.lead.id}` }) : failed(result);
			},
		}),

		// ── csat ────────────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/ratings',
			...website('csat', 'sk'),
			handler: async (ctx) => {
				const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
				const s = await site(ctx);
				const items = await s.repos.ratings.list({
					after: typeof page.after === 'string' ? page.after : null,
					fetchLimit: page.fetchLimit,
				});
				const view = page.page(items, cursorOn('at'));
				const since =
					typeof ctx.query.since === 'string' && !Number.isNaN(Date.parse(ctx.query.since))
						? ctx.query.since
						: iso(app.now() - 30 * 24 * HOUR_MS);
				const link = page.link(view.nextCursor);
				return ok({ ...view, summary: await service.csatSummary(s, since) }, link ? { headers: { link } } : {});
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/ratings',
			...website('csat'),
			handler: async (ctx) => {
				const s = await site(ctx);
				if (typeof ctx.body?.conversationId !== 'string') return invalid([{ path: '/conversationId', code: 'required' }]);
				const conversation = await conversationFor(ctx, s, ctx.body.conversationId);
				if (!conversation) return notFound();
				const result = await service.rate(s, conversation, ctx.body);
				return result.ok ? created(result.rating) : failed(result);
			},
		}),

		// ── transcripts ─────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/transcripts',
			...website('transcripts', 'sk'),
			handler: async (ctx) => {
				const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
				const s = await site(ctx);
				const items = await s.repos.conversations.list({
					status: ['resolved', 'closed'],
					after: typeof page.after === 'string' ? page.after : null,
					fetchLimit: page.fetchLimit,
				});
				return page.respond(
					items.map((/** @type {any} */ c) => ({
						conversationId: c.id,
						status: c.status,
						openedAt: c.openedAt,
						closedAt: c.closedAt,
						messages: c.counts.messages,
						lastMessageAt: c.last.at,
						id: c.id,
					})),
					cursorOn('lastMessageAt'),
				);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/transcripts/:conversationId',
			...website('transcripts'),
			handler: async (ctx) => {
				const s = await site(ctx);
				if (!isServer(ctx) && !s.settings.transcripts.customer_download)
					return problem('forbidden', 'Transcript downloads are not enabled.');
				const conversation = await conversationFor(ctx, s, ctx.params.conversationId);
				if (!conversation) return notFound();
				const format = ctx.query.format === 'text' ? 'text' : 'json';
				const transcript = await service.transcript(s, conversation, { format, audience: audienceOf(ctx) });
				if (format === 'text')
					return new Response(/** @type {string} */ (transcript), {
						status: 200,
						headers: {
							'content-type': 'text/plain; charset=utf-8',
							'content-disposition': `attachment; filename="transcript-${conversation.id}.txt"`,
							...(ctx.headers.get('origin') && !isServer(ctx)
								? { 'access-control-allow-origin': /** @type {string} */ (ctx.headers.get('origin')), vary: 'Origin' }
								: {}),
						},
					});
				return ok(transcript);
			},
		}),

		// ── moderation ──────────────────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'POST',
			path: '/v1/moderation:check',
			...website('moderation', 'sk'),
			idempotent: false,
			handler: async (ctx) => {
				const s = await site(ctx);
				if (typeof ctx.body?.text !== 'string') return invalid([{ path: '/text', code: 'required' }]);
				const text = ctx.body.text.slice(0, 8000);
				const labels = service.assistant.labelsOf(service.translator(s.settings.window.default_language));
				if (ctx.body.direction === 'outbound') {
					const result = moderateOutbound(text, s.settings.moderation, {
						labels,
						websiteDomain: s.domain,
						presentAsHuman: Boolean(s.settings.ai?.present_as_human),
					});
					return ok({ direction: 'outbound', allowed: result.ok, text: result.text, reason: result.reason });
				}
				const result = moderateInbound(text, s.settings.moderation, labels);
				return ok(
					result.ok
						? {
								direction: 'inbound',
								allowed: true,
								text: result.text,
								redacted: result.redacted,
								masked: result.masked,
								leak: leakCheck(text).reason,
							}
						: { direction: 'inbound', allowed: false, reason: result.reason },
				);
			},
		}),

		// ── dashboard (SSO session) ─────────────────────────────────────────────────────────────────────────
		defineRoute({
			method: 'GET',
			path: '/v1/dashboard/overview',
			auth: 'launch',
			element: 'window',
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				return s ? ok(await service.overview(s)) : problem('bad_request', 'Open the dashboard for a website.');
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/dashboard/conversations/:id',
			auth: 'launch',
			element: 'window',
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				if (!s) return problem('bad_request', 'Open the dashboard for a website.');
				const conversation = await s.repos.conversations.get(ctx.params.id);
				if (!conversation) return notFound();
				const since =
					typeof ctx.query.since === 'string' && !Number.isNaN(Date.parse(ctx.query.since))
						? new Date(ctx.query.since).toISOString()
						: null;
				const page = await service.messages(s, conversation, { since, limit: 100, audience: 'team' });
				if (ctx.headers.get('if-none-match') === page.etag)
					return ok(undefined, { status: 304, headers: { etag: page.etag } });
				return ok({ ...page, conversation: conversationView(conversation, 'team') }, { headers: { etag: page.etag } });
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/conversations/:id/messages',
			auth: 'launch',
			element: 'inbox',
			roles: [...DASHBOARD_WRITE_ROLES],
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				if (!s) return problem('bad_request', 'Open the dashboard for a website.');
				const conversation = await s.repos.conversations.get(ctx.params.id);
				if (!conversation) return notFound();
				const agent = await dashboardAgent(s, ctx);
				return replyAsAgent(ctx, s, conversation, dashboardActor(ctx), agent?.id ?? null);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/conversations/:id/notes',
			auth: 'launch',
			element: 'inbox',
			roles: [...DASHBOARD_WRITE_ROLES],
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				if (!s) return problem('bad_request', 'Open the dashboard for a website.');
				const conversation = await s.repos.conversations.get(ctx.params.id);
				if (!conversation) return notFound();
				const agent = await dashboardAgent(s, ctx);
				return noteAs(ctx, s, conversation, dashboardActor(ctx), agent?.id ?? null);
			},
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/dashboard/conversations/:id',
			auth: 'launch',
			element: 'window',
			roles: [...DASHBOARD_WRITE_ROLES],
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				if (!s) return problem('bad_request', 'Open the dashboard for a website.');
				const conversation = await s.repos.conversations.get(ctx.params.id);
				if (!conversation) return notFound();
				return patchAs(ctx, s, conversation, dashboardActor(ctx));
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/knowledge-entries',
			auth: 'launch',
			element: 'knowledge',
			roles: [...DASHBOARD_WRITE_ROLES],
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				if (!s) return problem('bad_request', 'Open the dashboard for a website.');
				const problems = validateEntry(ctx.body);
				if (problems.length > 0) return invalid(problems);
				const result = await createEntry(s, ctx.body, `entry:dashboard:${ctx.idempotencyKey}`);
				return result.ok ? created(result.entry) : failed(result);
			},
		}),
	];

	/**
	 * Create and index a FAQ entry (idempotent per key; bounded by `knowledge.max_entries`).
	 * @param {Site} s
	 * @param {Record<string, any>} body
	 * @param {string} key
	 * @returns {Promise<{ ok: true, entry: any } | { ok: false, reason: string }>}
	 */
	async function createEntry(s, body, key) {
		const id = `kbe_${app.hash(`${s.websiteId}:${key}`)}`;
		const existing = await s.repos.entries.get(id);
		if (existing) return { ok: true, entry: existing };
		if ((await s.repos.entries.count()) >= /** @type {any} */ (s.settings.knowledge).max_entries)
			return { ok: false, reason: 'limit_reached' };
		const entry = {
			id,
			question: body.question.trim(),
			answer: body.answer.trim(),
			tags: body.tags ?? [],
			enabled: body.enabled ?? true,
			priority: body.priority ?? 0,
			deletedAt: null,
		};
		await s.repos.entries.insert(entry);
		await service.knowledge.indexEntry(s, entry);
		return { ok: true, entry: await s.repos.entries.get(id) };
	}
};

/**
 * Register the event consumers (app-kit dedupes deliveries on the event id).
 * @param {Chatbot} chatbot
 */
export const wireEvents = (chatbot) => {
	for (const [type, handler] of Object.entries(createEventHandlers(chatbot))) chatbot.product.events.on(type, handler);
	return chatbot;
};
