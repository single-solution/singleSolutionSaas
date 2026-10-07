/**
 * Dashboard data (SSO pages) for a live website (service + merchant database).
 */
import { conversationView, messageView } from '../core/conversation.js';

/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').ChatbotService} ChatbotService */
/**
 * @typedef {object} DashboardData
 * @property {boolean} canWrite
 * @property {string} websiteId
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

/** Dashboard roles that may change data. */
export const DASHBOARD_WRITE_ROLES = Object.freeze(['merchant', 'platform_admin']);

/**
 * @typedef {{ state: 'signin' } | { state: 'pick_website' | 'not_subscribed', session: Record<string, any> }
 *   | { state: 'ready', session: Record<string, any>, data: DashboardData, portalLink: string | null, aiConnected: boolean }} DashboardContext
 */

/**
 * What the dashboard shows for a session (launch exchanged at `/sso`).
 * @param {{ chatbot: import('./routes.js').Chatbot, sessionId: string | undefined | null, website?: string | null }} input
 * @returns {Promise<DashboardContext>}
 */
export const resolveDashboard = async ({ chatbot, sessionId, website = null }) => {
	const { product, service, siteOf, app } = chatbot;
	const session = sessionId ? await product.launch.session(sessionId) : null;
	if (!session) return { state: 'signin' };
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
		portalLink: `${app.product.portal.baseUrl}/websites/${encodeURIComponent(websiteId)}/subscriptions/${encodeURIComponent(result.doc.subscriptionId)}`,
		aiConnected: product.entitlements.can(result.doc, 'ai_replies'),
	};
};
