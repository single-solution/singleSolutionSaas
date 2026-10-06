/**
 * Dashboard data (SSO pages): the same views for a live website (service + merchant database) and for demo launches
 * (sample configurators built in memory with the real core — nothing is stored, nothing can be changed).
 */
import { itemView } from '../core/catalog.js';
import { parseSchema } from '../core/schema.js';
import { configuratorView, publicView, summaryView } from '../core/views.js';
import { SAMPLES } from './samples.js';
import { settingsFrom } from './settings.js';

/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./service.js').ConfiguratorService} ConfiguratorService */
/** @typedef {import('../core/views.js').ConfiguratorRecord} ConfiguratorRecord */
/**
 * @typedef {object} DashboardData
 * @property {boolean} demo
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

/** Dashboard roles that may change data (demo sessions are read-only). */
export const DASHBOARD_WRITE_ROLES = Object.freeze(['merchant', 'platform_admin', 'impersonate']);

/**
 * The audit actor of a dashboard session.
 * @param {{ actor: string | null, kind: string, user: string | null }} view
 */
export const actorOf = (view) =>
	view.actor
		? { type: 'staff', id: view.actor }
		: { type: view.kind === 'admin' ? 'staff' : 'merchant', id: view.user ?? 'unknown' };

/**
 * @param {{ service: ConfiguratorService, site: Site, canWrite: boolean }} input
 * @returns {DashboardData}
 */
export const liveDashboard = ({ service, site, canWrite }) => ({
	demo: false,
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
 * Sandbox data: the sample configurators, every element on with product defaults.
 * @param {{ now: number }} input
 * @returns {DashboardData}
 */
export const demoDashboard = ({ now }) => {
	const at = new Date(now).toISOString();
	/** @type {ConfiguratorRecord[]} */
	const records = SAMPLES.flatMap((sample, index) => {
		const parsed = parseSchema(sample);
		return parsed.ok
			? [
					{
						id: `cfg_demo${index + 1}`,
						key: parsed.schema.key,
						name: parsed.schema.name,
						status: /** @type {const} */ ('published'),
						version: 1,
						schema: parsed.schema,
						createdAt: at,
						updatedAt: at,
						publishedAt: at,
					},
				]
			: [];
	});
	return {
		demo: true,
		canWrite: false,
		websiteId: null,
		settings: settingsFrom({ can: () => true, config: () => ({}) }),
		overview: async () => ({ configurators: { published: records.length }, catalogItems: 0 }),
		list: async () => records.map(summaryView),
		get: async (id) => {
			const record = records.find((candidate) => candidate.id === id || candidate.key === id);
			return record ? { record: configuratorView(record), preview: publicView(record, record.schema), problem: null } : null;
		},
		items: async () => [],
	};
};

/**
 * @typedef {{ state: 'signin' } | { state: 'pick_website' | 'not_subscribed', session: Record<string, any> }
 *   | { state: 'ready', session: Record<string, any>, data: DashboardData, portalLink: string | null }} DashboardContext
 */

/**
 * What the dashboard shows for a session (launch exchanged at `/sso`).
 * @param {{ configurator: import('./routes.js').Configurator, sessionId: string | undefined | null, website?: string | null, now?: number }} input
 * @returns {Promise<DashboardContext>}
 */
export const resolveDashboard = async ({ configurator, sessionId, website = null, now = Date.now() }) => {
	const { product, service, siteOf, app } = configurator;
	const session = sessionId ? await product.launch.session(sessionId) : null;
	if (!session) return { state: 'signin' };
	if (session.role === 'demo') return { state: 'ready', session, data: demoDashboard({ now }), portalLink: null };
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
