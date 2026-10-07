/**
 * Dashboard data (SSO pages): the views of a live website (service + merchant database).
 */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').LoyaltyService} LoyaltyService */
/** @typedef {ReturnType<typeof import('../core/views.js').memberView>} MemberView */
/** @typedef {ReturnType<typeof import('../core/views.js').transactionView>} TransactionView */
/**
 * @typedef {object} DashboardData
 * @property {boolean} canWrite
 * @property {string | null} websiteId
 * @property {import('./settings.js').Settings} settings
 * @property {() => Promise<Record<string, any>>} overview
 * @property {(query: { q?: string, limit?: number }) => Promise<MemberView[]>} members
 * @property {(customerId: string) => Promise<{ member: MemberView, history: TransactionView[] } | null>} member
 */

/** Members listed per dashboard page. */
export const DASHBOARD_PAGE = 50;

/**
 * @param {{ service: LoyaltyService, site: Site, canWrite: boolean }} input
 * @returns {DashboardData}
 */
export const liveDashboard = ({ service, site, canWrite }) => ({
	canWrite,
	websiteId: site.websiteId,
	settings: site.settings,
	overview: () => service.overview(site),
	members: async ({ q = '', limit = DASHBOARD_PAGE }) =>
		(await site.repos.members.list({ fetchLimit: limit, prefix: q })).map(
			(/** @type {import("../core/member.js").Member} */ member) => service.view(site, member),
		),
	member: async (customerId) => {
		const member = await service.member(site, customerId);
		if (!member) return null;
		return {
			member: service.view(site, member),
			history: await service.history(site, { customerId, fetchLimit: DASHBOARD_PAGE }),
		};
	},
});

/** Dashboard roles that may change data (merchant launches and staff admin launches). */
export const DASHBOARD_WRITE_ROLES = Object.freeze(['merchant', 'platform_admin']);

/**
 * @typedef {{ state: 'signin' } | { state: 'pick_website' | 'not_subscribed', session: Record<string, any> }
 *   | { state: 'ready', session: Record<string, any>, data: DashboardData, portalLink: string | null }} DashboardContext
 */

/**
 * What the dashboard shows for a session (launch exchanged at `/sso`).
 * @param {{ loyalty: import('./routes.js').Loyalty, sessionId: string | undefined | null, website?: string | null }} input
 * @returns {Promise<DashboardContext>}
 */
export const resolveDashboard = async ({ loyalty, sessionId, website = null }) => {
	const { product, service, siteOf, app } = loyalty;
	const session = sessionId ? await product.launch.session(sessionId) : null;
	if (!session) return { state: 'signin' };
	const scope = session.scope ?? {};
	const allowed = [scope.websiteId, ...(Array.isArray(scope.websiteIds) ? scope.websiteIds : [])].filter(
		(/** @type {unknown} */ id) => typeof id === 'string' && id.length > 0,
	);
	const websiteId = website && allowed.includes(website) ? website : allowed[0];
	if (!websiteId) return { state: 'pick_website', session };
	const result = await product.entitlements.forWebsite(websiteId);
	if (!result.ok || !product.entitlements.can(result.doc, 'earn_rules')) return { state: 'not_subscribed', session };
	const site = await siteOf(websiteId, result.doc);
	return {
		state: 'ready',
		session,
		data: liveDashboard({ service, site, canWrite: DASHBOARD_WRITE_ROLES.includes(session.role) }),
		portalLink: `${app.product.portal.baseUrl}/websites/${encodeURIComponent(websiteId)}/subscriptions/${encodeURIComponent(result.doc.subscriptionId)}`,
	};
};
