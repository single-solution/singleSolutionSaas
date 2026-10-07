/** Dashboard data (SSO pages): the views of a live website (merchant database). */
import { analyticsOf } from './analytics.js';
import { messageView, subscriptionView } from '../core/views.js';

/** Rows listed per dashboard page. */
export const DASHBOARD_PAGE = 50;
/** Session roles that may act from the dashboard ("Send due now"). */
export const DASHBOARD_WRITE_ROLES = Object.freeze(['merchant', 'platform_admin']);

/**
 * @typedef {object} DashboardData
 * @property {string | null} websiteId
 * @property {number} windowDays
 * @property {boolean} canWrite the session may run the outbox ("Send due now")
 * @property {() => Promise<{ active: number, analytics: ReturnType<typeof import('../core/analytics.js').summarize> }>} overview
 * @property {() => Promise<Array<ReturnType<typeof subscriptionView>>>} subscriptions
 * @property {() => Promise<Array<ReturnType<typeof messageView>>>} messages
 */

/**
 * @param {{ site: import('./service.js').Site, now: () => number, canWrite?: boolean }} input
 * @returns {DashboardData}
 */
export const liveDashboard = ({ site, now, canWrite = false }) => ({
	websiteId: site.websiteId,
	windowDays: site.settings.analytics.defaultDays,
	canWrite: canWrite && site.settings.enabled('dispatch'),
	overview: async () => ({
		active: await site.repos.subscriptions.countActive(),
		analytics: await analyticsOf(site, site.settings.analytics.defaultDays, now()),
	}),
	subscriptions: async () =>
		(await site.repos.subscriptions.list({ fetchLimit: DASHBOARD_PAGE })).map((/** @type {any} */ sub) =>
			subscriptionView(sub),
		),
	messages: async () => (await site.repos.messages.list({ fetchLimit: DASHBOARD_PAGE })).map(messageView),
});

/**
 * @typedef {{ state: 'signin' } | { state: 'pick_website' | 'not_subscribed', session: Record<string, any> }
 *   | { state: 'ready', session: Record<string, any>, data: DashboardData }} DashboardContext
 */

/**
 * What the dashboard shows for a session (launch exchanged at `/sso`).
 * @param {{ alerts: import('./service.js').Alerts, sessionId: string | undefined | null, website?: string | null }} input
 * @returns {Promise<DashboardContext>}
 */
export const resolveDashboard = async ({ alerts, sessionId, website = null }) => {
	const { product, siteOf, deps } = alerts;
	const session = sessionId ? await product.launch.session(sessionId) : null;
	if (!session) return { state: 'signin' };
	const scope = session.scope ?? {};
	const allowed = [scope.websiteId, ...(Array.isArray(scope.websiteIds) ? scope.websiteIds : [])].filter(
		(/** @type {unknown} */ id) => typeof id === 'string' && id.length > 0,
	);
	const websiteId = website && allowed.includes(website) ? website : allowed[0];
	if (!websiteId) return { state: 'pick_website', session };
	const result = await product.entitlements.forWebsite(websiteId);
	if (!result.ok || !product.entitlements.can(result.doc, 'types')) return { state: 'not_subscribed', session };
	return {
		state: 'ready',
		session,
		data: liveDashboard({
			site: await siteOf(websiteId, result.doc),
			now: deps.now,
			canWrite: DASHBOARD_WRITE_ROLES.includes(session.role),
		}),
	};
};
