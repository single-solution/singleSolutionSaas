/** Dashboard data (SSO pages): the views of a live website (service + merchant database). */
import { mappingProblems } from '../core/mapping.js';
import { inspectionView, unitView } from './inspections.js';
import { sessionView } from './session.js';

/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').GradesService} GradesService */

/**
 * @typedef {object} DashboardData
 * @property {boolean} canWrite
 * @property {string | null} websiteId
 * @property {import('./settings.js').Settings} settings
 * @property {Array<{ vocabulary: string, tier: string, problem: string }>} mappingProblems
 * @property {() => Promise<Awaited<ReturnType<GradesService['overview']>>>} overview
 * @property {() => Promise<Array<ReturnType<typeof unitView>>>} units
 * @property {() => Promise<Array<ReturnType<typeof inspectionView>>>} inspections
 */

/** Rows listed per dashboard page. */
export const DASHBOARD_PAGE = 50;

/** Dashboard roles that may change data. */
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
 * @param {{ service: GradesService, site: Site, canWrite: boolean }} input
 * @returns {DashboardData}
 */
export const liveDashboard = ({ service, site, canWrite }) => ({
	canWrite,
	websiteId: site.websiteId,
	settings: site.settings,
	mappingProblems: mappingProblems(site.settings.vocabularies),
	overview: () => service.overview(site),
	units: async () =>
		(await site.repos.units.list({ after: null, fetchLimit: DASHBOARD_PAGE })).map((/** @type {any} */ row) => unitView(row)),
	inspections: async () =>
		(await site.repos.inspections.list({ after: null, fetchLimit: DASHBOARD_PAGE })).map((/** @type {any} */ row) =>
			inspectionView(row),
		),
});

/**
 * @typedef {{ state: 'signin' } | { state: 'pick_website' | 'not_subscribed', session: Record<string, any> }
 *   | { state: 'ready', session: Record<string, any>, data: DashboardData, portalLink: string | null }} DashboardContext
 */

/**
 * What the dashboard shows for a session (launch exchanged at `/sso`).
 * @param {{ grades: import('./routes.js').Grades, sessionId: string | undefined | null, website?: string | null }} input
 * @returns {Promise<DashboardContext>}
 */
export const resolveDashboard = async ({ grades, sessionId, website = null }) => {
	const { product, service, siteOf, app } = grades;
	const session = sessionId ? await product.launch.session(sessionId) : null;
	if (!session) return { state: 'signin' };
	const scope = session.scope ?? {};
	const allowed = [scope.websiteId, ...(Array.isArray(scope.websiteIds) ? scope.websiteIds : [])].filter(
		(/** @type {unknown} */ id) => typeof id === 'string' && id.length > 0,
	);
	const websiteId = website && allowed.includes(website) ? website : allowed[0];
	if (!websiteId) return { state: 'pick_website', session };
	const result = await product.entitlements.forWebsite(websiteId);
	if (!result.ok || !product.entitlements.can(result.doc, 'tiers')) return { state: 'not_subscribed', session };
	const site = await siteOf(websiteId, result.doc);
	return {
		state: 'ready',
		session,
		data: liveDashboard({ service, site, canWrite: DASHBOARD_WRITE_ROLES.includes(session.role) }),
		portalLink: `${app.product.portal.baseUrl}/websites/${encodeURIComponent(websiteId)}/subscriptions/${encodeURIComponent(result.doc.subscriptionId)}`,
	};
};
