/**
 * Dashboard data (SSO pages): the views of the open website (service + merchant database).
 */
import { itemView } from '../core/catalog.js';
import { configuratorView, publicView, summaryView } from '../core/views.js';

/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').ConfiguratorService} ConfiguratorService */
/**
 * @typedef {object} DashboardData
 * @property {boolean} canWrite
 * @property {string | null} websiteId
 * @property {import('./settings.js').Settings} settings
 * @property {() => Promise<{ configurators: Record<string, number>, catalogItems: number }>} overview
 * @property {() => Promise<Array<ReturnType<typeof summaryView>>>} list
 * @property {(id: string) => Promise<{ record: ReturnType<typeof configuratorView>, preview: ReturnType<typeof publicView> | null, problem: string | null } | null>} get
 * @property {() => Promise<Array<ReturnType<typeof itemView>>>} items
 */

/** Configurators / items listed per dashboard page. */
export const DASHBOARD_PAGE = 100;

/** Dashboard roles that may change data. */
export const DASHBOARD_WRITE_ROLES = Object.freeze(['merchant', 'platform_admin']);

/**
 * The audit actor of a dashboard session.
 * @param {{ kind: string, user: string | null }} view
 */
export const actorOf = (view) => ({ type: view.kind === 'admin' ? 'staff' : 'merchant', id: view.user ?? 'unknown' });

/**
 * @param {{ service: ConfiguratorService, site: Site, canWrite: boolean }} input
 * @returns {DashboardData}
 */
export const liveDashboard = ({ service, site, canWrite }) => ({
	canWrite,
	websiteId: site.websiteId,
	settings: site.settings,
	overview: () => service.overview(site),
	list: async () => (await site.repos.configurators.list({ fetchLimit: DASHBOARD_PAGE })).map(summaryView),
	get: async (id) => {
		const record = await service.find(site, id);
		if (!record) return null;
		const built = record.status === 'archived' ? null : await service.concrete(site, record);
		return {
			record: configuratorView(record),
			preview: built?.ok ? publicView(record, built.schema) : null,
			problem: built && !built.ok ? built.reason : null,
		};
	},
	items: async () => (await site.repos.items.list({ fetchLimit: DASHBOARD_PAGE })).map(itemView),
});

/**
 * @typedef {{ state: 'signin' } | { state: 'pick_website' | 'not_subscribed', session: Record<string, any> }
 *   | { state: 'ready', session: Record<string, any>, data: DashboardData, portalLink: string | null }} DashboardContext
 */

/**
 * What the dashboard shows for a session (launch exchanged at `/sso`).
 * @param {{ configurator: import('./routes.js').Configurator, sessionId: string | undefined | null, website?: string | null }} input
 * @returns {Promise<DashboardContext>}
 */
export const resolveDashboard = async ({ configurator, sessionId, website = null }) => {
	const { product, service, siteOf, app } = configurator;
	const session = sessionId ? await product.launch.session(sessionId) : null;
	if (!session) return { state: 'signin' };
	const scope = session.scope ?? {};
	const allowed = [scope.websiteId, ...(Array.isArray(scope.websiteIds) ? scope.websiteIds : [])].filter(
		(/** @type {unknown} */ id) => typeof id === 'string' && id.length > 0,
	);
	const websiteId = website && allowed.includes(website) ? website : allowed[0];
	if (!websiteId) return { state: 'pick_website', session };
	const result = await product.entitlements.forWebsite(websiteId);
	if (!result.ok || !product.entitlements.can(result.doc, 'schema')) return { state: 'not_subscribed', session };
	const site = await siteOf(websiteId, result.doc);
	return {
		state: 'ready',
		session,
		data: liveDashboard({ service, site, canWrite: DASHBOARD_WRITE_ROLES.includes(session.role) }),
		portalLink: `${app.product.portal.baseUrl}/websites/${encodeURIComponent(websiteId)}/subscriptions/${encodeURIComponent(result.doc.subscriptionId)}`,
	};
};
