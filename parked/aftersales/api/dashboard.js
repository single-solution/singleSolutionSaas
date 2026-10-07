/** Dashboard data (SSO pages): the views of a live website (service + merchant database). */
import { sessionView } from './session.js';

/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').AftersalesService} AftersalesService */
/**
 * @typedef {object} DashboardData
 * @property {boolean} canWrite
 * @property {string | null} websiteId
 * @property {import('./settings.js').Settings} settings
 * @property {() => Promise<{ byStatus: Record<string, number>, byKind: Record<string, number>, overdue: number,
 *   refunded: Record<string, number> }>} overview
 * @property {(statuses: string[] | null) => Promise<Array<ReturnType<typeof import('../core/views.js').ownerClaimView>>>} claims
 * @property {(raw: string) => Promise<Record<string, any> | null>} serial
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
 * @param {{ service: AftersalesService, site: Site, canWrite: boolean }} input
 * @returns {DashboardData}
 */
export const liveDashboard = ({ service, site, canWrite }) => ({
	canWrite,
	websiteId: site.websiteId,
	settings: site.settings,
	overview: () => service.overview(site),
	claims: async (statuses) => {
		const views = await service.viewsFor(site);
		const rows = await site.repos.claims.list({ ...(statuses ? { statuses } : {}), fetchLimit: DASHBOARD_PAGE });
		return rows.map((/** @type {any} */ row) => views.owner(row));
	},
	serial: async (raw) => {
		const result = await service.lookupSerial(site, raw);
		return result.ok ? { ...result.serial, claims: result.claims, cover: result.entry?.windows ?? {} } : null;
	},
});

/**
 * @typedef {{ state: 'signin' } | { state: 'pick_website' | 'not_subscribed', session: Record<string, any> }
 *   | { state: 'ready', session: Record<string, any>, data: DashboardData, portalLink: string | null }} DashboardContext
 */

/**
 * What the dashboard shows for a session (launch exchanged at `/sso`).
 * @param {{ aftersales: import('./routes.js').Aftersales, sessionId: string | undefined | null, website?: string | null }} input
 * @returns {Promise<DashboardContext>}
 */
export const resolveDashboard = async ({ aftersales, sessionId, website = null }) => {
	const { product, service, siteOf, app } = aftersales;
	const session = sessionId ? await product.launch.session(sessionId) : null;
	if (!session) return { state: 'signin' };
	const scope = session.scope ?? {};
	const allowed = [scope.websiteId, ...(Array.isArray(scope.websiteIds) ? scope.websiteIds : [])].filter(
		(/** @type {unknown} */ id) => typeof id === 'string' && id.length > 0,
	);
	const websiteId = website && allowed.includes(website) ? website : allowed[0];
	if (!websiteId) return { state: 'pick_website', session };
	const result = await product.entitlements.forWebsite(websiteId);
	if (!result.ok || !product.entitlements.can(result.doc, 'claims')) return { state: 'not_subscribed', session };
	const site = await siteOf(websiteId, result.doc);
	return {
		state: 'ready',
		session,
		data: liveDashboard({ service, site, canWrite: DASHBOARD_WRITE_ROLES.includes(session.role) }),
		portalLink: `${app.product.portal.baseUrl}/websites/${encodeURIComponent(websiteId)}/subscriptions/${encodeURIComponent(result.doc.subscriptionId)}`,
	};
};
