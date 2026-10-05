/**
 * Dashboard data (SSO pages): the same views for a live website (service + merchant database) and for demo launches
 * (sample conversations built in memory with the real core — nothing is stored, nothing can be changed).
 */
import { conversationView, messageView, newConversation, summaryAfter } from '../core/conversation.js';
import { summarise } from '../core/csat.js';
import { DAY_MS, MINUTE_MS, iso } from '../core/time.js';
import { defaultSettings } from './settings.js';

/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').ChatbotService} ChatbotService */
/**
 * @typedef {object} DashboardData
 * @property {boolean} demo
 * @property {boolean} canWrite
 * @property {string | null} websiteId
 * @property {import('./settings.js').Settings} settings
 * @property {() => Promise<Record<string, any>>} overview
 * @property {(query: { status?: string | null }) => Promise<Array<Record<string, any>>>} conversations
 * @property {(id: string) => Promise<{ conversation: Record<string, any>, messages: Array<any>, notes: Array<any> } | null>} conversation
 * @property {() => Promise<Array<Record<string, any>>>} entries
 * @property {() => Promise<Array<Record<string, any>>>} sources
 */

/** Conversations listed per dashboard page. */
export const DASHBOARD_PAGE = 50;

/**
 * @param {{ service: ChatbotService, site: Site, canWrite: boolean }} input
 * @returns {DashboardData}
 */
export const liveDashboard = ({ service, site, canWrite }) => ({
	demo: false,
	canWrite,
	websiteId: site.websiteId,
	settings: site.settings,
	overview: () => service.overview(site),
	conversations: async ({ status = null }) =>
		(await site.repos.conversations.list({ status: status || null, fetchLimit: DASHBOARD_PAGE })).map((/** @type {any} */ c) =>
			conversationView(c, 'team'),
		),
	conversation: async (id) => {
		const conversation = await site.repos.conversations.get(id);
		if (!conversation) return null;
		const page = await site.repos.messages.page(id, { limit: 100 });
		const notes = await site.repos.messages.notes(id);
		return {
			conversation: conversationView(conversation, 'team'),
			messages: page.items.map((/** @type {any} */ m) => messageView(m, 'team')),
			notes: notes.map((/** @type {any} */ m) => messageView(m, 'team')),
		};
	},
	entries: async () => site.repos.entries.list({ fetchLimit: 200 }),
	sources: async () => service.knowledge.sources(site),
});

/**
 * Sandbox data: a few conversations replayed through the real core.
 * @param {{ now: number }} input
 * @returns {DashboardData}
 */
export const demoDashboard = ({ now }) => {
	const settings = defaultSettings();
	/** @type {Array<[string, string, Array<[string, string, number]>, Record<string, any>]>} id, language, [author, text, minutes ago], extra */
	const script = [
		[
			'cnv_demo_order',
			'en',
			[
				['customer', 'Hi, where is my order?', 40],
				['bot', 'Your order **1042** was shipped yesterday and should arrive tomorrow.', 39],
				['customer', 'Thanks!', 38],
			],
			{ status: 'resolved' },
		],
		[
			'cnv_demo_human',
			'es',
			[
				['customer', 'Hola, quiero hablar con una persona por favor', 12],
				['system', 'I’ve asked a member of our team to join this chat.', 12],
			],
			{ handoff: { at: iso(now - 12 * MINUTE_MS), reason: 'customer_request', team: 'support', offline: false } },
		],
		[
			'cnv_demo_lead',
			'en',
			[
				['customer', 'Do you ship to Canada?', 300],
				['bot', 'Yes — we ship worldwide. Delivery to Canada takes 5–8 business days.', 299],
			],
			{},
		],
	];
	const conversations = script.map(([id, language, steps, extra]) => {
		const opened = now - (steps[0]?.[2] ?? 0) * MINUTE_MS;
		let conversation = newConversation({
			id,
			at: iso(opened),
			customerId: null,
			visitorId: `vis_${id}`,
			language,
			priority: 'normal',
		});
		const messages = steps.map(([author, text, ago], index) => ({
			id: `msg_${id}_${index}`,
			conversationId: id,
			customerId: null,
			author: /** @type {any} */ (author),
			authorId: null,
			authorName: null,
			kind: author === 'system' ? 'event' : 'text',
			internal: false,
			body: text,
			payload: null,
			language,
			at: iso(now - ago * MINUTE_MS),
		}));
		conversation = { ...conversation, ...summaryAfter(conversation, messages), ...extra };
		return { conversation, messages };
	});
	return {
		demo: true,
		canWrite: false,
		websiteId: null,
		settings,
		overview: async () => ({
			open: conversations.filter((c) => c.conversation.status === 'open').length,
			waiting: conversations.filter((c) => c.conversation.handoff).length,
			recent: conversations.filter((c) => Date.parse(c.conversation.openedAt) >= now - DAY_MS).length,
			breaches: 0,
			tokens: 18_420,
			csat: summarise(
				[
					{ score: 5, scale: 5 },
					{ score: 4, scale: 5 },
					{ score: 2, scale: 5 },
				],
				settings.csat?.target ?? 0.85,
			),
			leads: 2,
			chunks: 36,
		}),
		conversations: async ({ status = null }) =>
			conversations
				.filter((c) => !status || c.conversation.status === status)
				.map((c) => conversationView(c.conversation, 'team')),
		conversation: async (id) => {
			const found = conversations.find((c) => c.conversation.id === id);
			return found
				? {
						conversation: conversationView(found.conversation, 'team'),
						messages: found.messages.map((m) => messageView(m, 'team')),
						notes: [],
					}
				: null;
		},
		entries: async () => [
			{
				id: 'kbe_demo_1',
				question: 'Do you ship internationally?',
				answer: 'Yes, worldwide. Delivery takes 5–8 business days.',
				enabled: true,
			},
			{
				id: 'kbe_demo_2',
				question: 'What is your return policy?',
				answer: 'Returns are free within 30 days of delivery.',
				enabled: true,
			},
		],
		sources: async () => [],
	};
};

/** Dashboard roles that may change data (demo sessions are read-only). */
export const DASHBOARD_WRITE_ROLES = Object.freeze(['merchant', 'platform_admin', 'impersonate']);

/**
 * @typedef {{ state: 'signin' } | { state: 'pick_website' | 'not_subscribed', session: Record<string, any> }
 *   | { state: 'ready', session: Record<string, any>, data: DashboardData, portalLink: string | null, aiConnected: boolean }} DashboardContext
 */

/**
 * What the dashboard shows for a session (launch exchanged at `/sso`).
 * @param {{ chatbot: import('./routes.js').Chatbot, sessionId: string | undefined | null, website?: string | null, now?: number }} input
 * @returns {Promise<DashboardContext>}
 */
export const resolveDashboard = async ({ chatbot, sessionId, website = null, now = Date.now() }) => {
	const { product, service, siteOf, app } = chatbot;
	const session = sessionId ? await product.launch.session(sessionId) : null;
	if (!session) return { state: 'signin' };
	if (session.role === 'demo')
		return { state: 'ready', session, data: demoDashboard({ now }), portalLink: null, aiConnected: false };
	const scope = session.scope ?? {};
	const allowed = [scope.websiteId, ...(Array.isArray(scope.websiteIds) ? scope.websiteIds : [])].filter(
		(/** @type {unknown} */ id) => typeof id === 'string' && id.length > 0,
	);
	const websiteId = website && allowed.includes(website) ? website : allowed[0];
	if (!websiteId) return { state: 'pick_website', session };
	const result = await product.entitlements.forWebsite(websiteId);
	if (!result.ok || !product.entitlements.can(result.doc, 'window')) return { state: 'not_subscribed', session };
	const site = await siteOf(websiteId, result.doc, null);
	return {
		state: 'ready',
		session,
		data: liveDashboard({ service, site, canWrite: DASHBOARD_WRITE_ROLES.includes(session.role) }),
		portalLink: `${app.portalUrl.replace(/\/+$/, '')}/websites/${encodeURIComponent(websiteId)}/subscriptions/${encodeURIComponent(result.doc.subscriptionId)}`,
		aiConnected: product.entitlements.can(result.doc, 'ai_replies'),
	};
};
