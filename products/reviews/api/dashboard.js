/**
 * Dashboard data (SSO pages): the views of a live website (service + merchant database).
 */
import { sessionView } from './session.js';

/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').ReviewsService} ReviewsService */
/** @typedef {import('../core/views.js').OwnerReview} OwnerReview */
/**
 * @typedef {object} DashboardData
 * @property {boolean} canWrite
 * @property {string | null} websiteId
 * @property {import('./settings.js').Settings} settings
 * @property {() => Promise<{ reviews: Record<string, number>, questions: { pending: number, unanswered: number },
 *   requests: Record<string, number>, delivery: Record<string, number> }>} overview
 * @property {(status: 'pending' | 'approved' | 'rejected') => Promise<OwnerReview[]>} reviews
 * @property {(status: 'pending' | 'published') => Promise<Array<Record<string, any>>>} questions
 */

/** Rows listed per dashboard page. */
export const DASHBOARD_PAGE = 50;

/** Dashboard roles that may change data (merchant launches and staff admin launches). */
export const DASHBOARD_WRITE_ROLES = Object.freeze(['merchant', 'platform_admin']);

/**
 * The audited actor of a dashboard session (staff when launched as admin).
 * @param {any} session app-kit session
 * @returns {{ type: string, id: string }}
 */
export const dashboardActor = (session) => {
	const view = sessionView(session);
	return { type: view.kind === 'admin' ? 'staff' : 'merchant', id: view.user ?? 'unknown' };
};

/**
 * @param {{ service: ReviewsService, site: Site, canWrite: boolean }} input
 * @returns {DashboardData}
 */
export const liveDashboard = ({ service, site, canWrite }) => ({
	canWrite,
	websiteId: site.websiteId,
	settings: site.settings,
	overview: () => service.overview(site),
	reviews: async (status) => {
		const views = await service.viewsFor(site);
		const rows = await site.repos.reviews.list({
			filter: { statuses: [status] },
			sort: { submittedAt: -1, id: -1 },
			after: null,
			fetchLimit: DASHBOARD_PAGE,
		});
		return rows.map((/** @type {any} */ row) => views.owner(row));
	},
	questions: async (status) => {
		const views = await service.viewsFor(site);
		const rows = await site.repos.questions.list({ statuses: [status], fetchLimit: DASHBOARD_PAGE });
		return rows.map((/** @type {any} */ row) => views.question(row, true));
	},
});

/**
 * @typedef {{ state: 'signin' } | { state: 'pick_website' | 'not_subscribed', session: Record<string, any> }
 *   | { state: 'ready', session: Record<string, any>, data: DashboardData, portalLink: string | null }} DashboardContext
 */

/**
 * What the dashboard shows for a session (launch exchanged at `/sso`).
 * @param {{ reviews: import('./routes.js').Reviews, sessionId: string | undefined | null, website?: string | null }} input
 * @returns {Promise<DashboardContext>}
 */
export const resolveDashboard = async ({ reviews, sessionId, website = null }) => {
	const { product, service, siteOf, app } = reviews;
	const session = sessionId ? await product.launch.session(sessionId) : null;
	if (!session) return { state: 'signin' };
	const scope = session.scope ?? {};
	const allowed = [scope.websiteId, ...(Array.isArray(scope.websiteIds) ? scope.websiteIds : [])].filter(
		(/** @type {unknown} */ id) => typeof id === 'string' && id.length > 0,
	);
	const websiteId = website && allowed.includes(website) ? website : allowed[0];
	if (!websiteId) return { state: 'pick_website', session };
	const result = await product.entitlements.forWebsite(websiteId);
	if (!result.ok || !product.entitlements.can(result.doc, 'collection')) return { state: 'not_subscribed', session };
	const site = await siteOf(websiteId, result.doc);
	return {
		state: 'ready',
		session,
		data: liveDashboard({ service, site, canWrite: DASHBOARD_WRITE_ROLES.includes(session.role) }),
		portalLink: `${app.product.portal.baseUrl}/websites/${encodeURIComponent(websiteId)}/subscriptions/${encodeURIComponent(result.doc.subscriptionId)}`,
	};
};
