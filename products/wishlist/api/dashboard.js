/**
 * Dashboard data (SSO pages): the views of a live website (merchant database).
 */
import { listView, notificationView } from '../core/views.js';

/** Rows listed per dashboard page. */
export const DASHBOARD_PAGE = 50;
/** Most saved items shown on the overview. */
export const TOP_ITEMS = 10;

/**
 * @typedef {{ lists: number, customerLists: number, guestLists: number, items: number, optedIn: number, shared: number }} Stats
 * @typedef {object} DashboardData
 * @property {string | null} websiteId
 * @property {() => Promise<{ stats: Stats, topItems: Array<{ itemId: string, title: string | null, saves: number }> }>} overview
 * @property {() => Promise<Array<ReturnType<typeof listView>>>} lists
 * @property {() => Promise<Array<ReturnType<typeof notificationView>>>} notifications
 */

/**
 * @param {{ site: import('./lists.js').Site }} input
 * @returns {DashboardData}
 */
export const liveDashboard = ({ site }) => ({
	websiteId: site.websiteId,
	overview: async () => ({ stats: await site.repos.lists.stats(), topItems: await site.repos.lists.topItems(TOP_ITEMS) }),
	lists: async () =>
		(await site.repos.lists.page({ fetchLimit: DASHBOARD_PAGE })).map((/** @type {any} */ list) =>
			listView(list, { reveal: true }),
		),
	notifications: async () =>
		(await site.repos.notifications.page({ fetchLimit: DASHBOARD_PAGE })).map((/** @type {any} */ record) =>
			notificationView(record),
		),
});

/**
 * @typedef {{ state: 'signin' } | { state: 'pick_website' | 'not_subscribed', session: Record<string, any> }
 *   | { state: 'ready', session: Record<string, any>, data: DashboardData }} DashboardContext
 */

/**
 * What the dashboard shows for a session (launch exchanged at `/sso`).
 * @param {{ wishlist: import('./service.js').Wishlist, sessionId: string | undefined | null, website?: string | null }} input
 * @returns {Promise<DashboardContext>}
 */
export const resolveDashboard = async ({ wishlist, sessionId, website = null }) => {
	const { product, siteOf } = wishlist;
	const session = sessionId ? await product.launch.session(sessionId) : null;
	if (!session) return { state: 'signin' };
	const scope = session.scope ?? {};
	const allowed = [scope.websiteId, ...(Array.isArray(scope.websiteIds) ? scope.websiteIds : [])].filter(
		(/** @type {unknown} */ id) => typeof id === 'string' && id.length > 0,
	);
	const websiteId = website && allowed.includes(website) ? website : allowed[0];
	if (!websiteId) return { state: 'pick_website', session };
	const result = await product.entitlements.forWebsite(websiteId);
	if (!result.ok || !product.entitlements.can(result.doc, 'lists')) return { state: 'not_subscribed', session };
	return { state: 'ready', session, data: liveDashboard({ site: await siteOf(websiteId, result.doc) }) };
};
