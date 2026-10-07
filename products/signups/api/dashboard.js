/**
 * Dashboard data (SSO pages): the views of a live website (service + merchant database).
 */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {ReturnType<typeof import('../core/views.js').customerView>} CustomerView */
/**
 * @typedef {object} DashboardData
 * @property {string | null} websiteId
 * @property {() => Promise<Record<string, number>>} overview
 * @property {(query: { email?: string, limit?: number }) => Promise<CustomerView[]>} customers
 * @property {() => Promise<Record<string, any>>} issuer
 * @property {(actor: { type: string, id?: string }) => Promise<import('./service.js').Outcome>} registerIssuer ask the
 *   Portal to make Signups the website's identity issuer
 * @property {() => Promise<number>} runDueDeletions execute the deletions whose cooling-off ended
 */

/** Customers listed per dashboard page. */
export const DASHBOARD_PAGE = 50;
/** Launch roles that may open the dashboard. */
export const DASHBOARD_ROLES = Object.freeze(['merchant', 'platform_admin']);
/** Launch roles that may change something from the dashboard (merchant launches and staff admin launches). */
export const DASHBOARD_WRITE_ROLES = Object.freeze(['merchant', 'platform_admin']);

/**
 * @param {{ service: import('./service.js').SignupsService, site: Site }} input
 * @returns {DashboardData}
 */
export const liveDashboard = ({ service, site }) => ({
	websiteId: site.websiteId,
	overview: () => service.overview(site),
	customers: async ({ email, limit = DASHBOARD_PAGE }) =>
		(
			await service.settleDeletions(
				site,
				/** @type {any[]} */ (await site.repos.customers.list({ fetchLimit: limit, ...(email ? { email } : {}) })),
			)
		).map((customer) => service.viewOf(site, customer)),
	issuer: () => service.issuer(site),
	registerIssuer: (actor) => service.registerIssuer(site, { actor }),
	runDueDeletions: () => service.runDueDeletions(site),
});

/**
 * @typedef {{ state: 'signin' } | { state: 'pick_website' | 'not_subscribed', session: Record<string, any> }
 *   | { state: 'ready', session: Record<string, any>, data: DashboardData, portalLink: string | null }} DashboardContext
 */

/**
 * What the dashboard shows for a session (launch exchanged at `/sso`).
 * @param {{ signups: import('./routes.js').Signups, sessionId: string | undefined | null, website?: string | null }} input
 * @returns {Promise<DashboardContext>}
 */
export const resolveDashboard = async ({ signups, sessionId, website = null }) => {
	const { product, service, siteOf, app } = signups;
	const session = sessionId ? await product.launch.session(sessionId) : null;
	if (!session) return { state: 'signin' };
	const scope = session.scope ?? {};
	const allowed = [scope.websiteId, ...(Array.isArray(scope.websiteIds) ? scope.websiteIds : [])].filter(
		(/** @type {unknown} */ id) => typeof id === 'string' && id.length > 0,
	);
	const websiteId = website && allowed.includes(website) ? website : allowed[0];
	if (!websiteId) return { state: 'pick_website', session };
	const result = await product.entitlements.forWebsite(websiteId);
	if (!result.ok || !product.entitlements.can(result.doc, 'profile')) return { state: 'not_subscribed', session };
	const site = await siteOf(websiteId, result.doc);
	return {
		state: 'ready',
		session,
		data: liveDashboard({ service, site }),
		portalLink: `${app.product.portal.baseUrl}/websites/${encodeURIComponent(websiteId)}/identity`,
	};
};
