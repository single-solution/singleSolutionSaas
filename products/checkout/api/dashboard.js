/**
 * Dashboard data (SSO pages): the views of the open website (merchant database).
 */
import { orderView } from '../core/orders.js';

/** Dashboard roles that may change data. */
export const DASHBOARD_WRITE_ROLES = Object.freeze(['merchant', 'platform_admin']);

/** Orders listed per dashboard page. */
export const DASHBOARD_PAGE = 50;

/**
 * @typedef {object} DashboardData
 * @property {boolean} canWrite
 * @property {string | null} websiteId
 * @property {import('./settings.js').Settings} settings
 * @property {() => Promise<{ orders: number, open: number, currencies: Array<{ currency: string, orders: number, revenue: number }> }>} overview
 * @property {(query: { status?: string | null }) => Promise<Array<ReturnType<typeof orderView>>>} orders
 * @property {(id: string) => Promise<ReturnType<typeof orderView> | null>} order
 * @property {() => Promise<Record<string, unknown>>} integrations
 */

/** Statuses counted as revenue (never cancelled or refunded orders). */
const REVENUE = new Set(['confirmed', 'completed']);
const OPEN = new Set(['pending_payment', 'awaiting_confirmation']);

/**
 * KPIs from the per-status / currency summary.
 * @param {Array<{ _id: { status: string, currency: string }, count: number, total: number }>} rows
 */
export const kpisOf = (rows) => {
	/** @type {Map<string, { currency: string, orders: number, revenue: number }>} */
	const byCurrency = new Map();
	let orders = 0;
	let open = 0;
	for (const row of rows) {
		orders += row.count;
		if (OPEN.has(row._id.status)) open += row.count;
		const entry = byCurrency.get(row._id.currency) ?? { currency: row._id.currency, orders: 0, revenue: 0 };
		if (REVENUE.has(row._id.status)) {
			entry.orders += row.count;
			entry.revenue += row.total;
		}
		byCurrency.set(row._id.currency, entry);
	}
	return { orders, open, currencies: [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency)) };
};

/**
 * @param {{ application: import('./routes.js').Application, site: import('./context.js').Site, canWrite: boolean }} input
 * @returns {DashboardData}
 */
export const liveDashboard = ({ application, site, canWrite }) => ({
	canWrite,
	websiteId: site.websiteId,
	settings: site.settings,
	overview: async () =>
		kpisOf(/** @type {any} */ (await site.repos.orders.summary(new Date(application.app.now() - 30 * 86_400_000)))),
	orders: async ({ status = null }) =>
		(
			await Promise.all(
				(await site.repos.orders.list({ after: null, fetchLimit: DASHBOARD_PAGE, status })).map((/** @type {any} */ order) =>
					application.orders.expireIfDue(site, order),
				),
			)
		).map((order) => orderView(order)),
	order: async (id) => {
		const stored = await site.repos.orders.get(id);
		const order = stored ? await application.orders.expireIfDue(site, stored) : null;
		return order
			? {
					...orderView(order),
					proofs: (order.proofs ?? [])
						.filter((/** @type {any} */ p) => p.status === 'submitted')
						.map((/** @type {any} */ p) => ({ id: p.id, submittedAt: p.submittedAt, reference: p.reference ?? null })),
				}
			: null;
	},
	integrations: () => application.integrationStatus(site),
});

/**
 * @typedef {{ state: 'signin' } | { state: 'pick_website' | 'not_subscribed', session: Record<string, any> }
 *   | { state: 'ready', session: Record<string, any>, data: DashboardData, portalLink: string | null }} DashboardContext
 */

/**
 * What the dashboard shows for a session (launch exchanged at `/sso`).
 * @param {{ application: import('./routes.js').Application, sessionId: string | undefined | null, website?: string | null }} input
 * @returns {Promise<DashboardContext>}
 */
export const resolveDashboard = async ({ application, sessionId, website = null }) => {
	const { product, siteOf, app } = application;
	const session = sessionId ? await product.launch.session(sessionId) : null;
	if (!session) return { state: 'signin' };
	const scope = session.scope ?? {};
	const allowed = [scope.websiteId, ...(Array.isArray(scope.websiteIds) ? scope.websiteIds : [])].filter(
		(/** @type {unknown} */ id) => typeof id === 'string' && id.length > 0,
	);
	const websiteId = website && allowed.includes(website) ? website : allowed[0];
	if (!websiteId) return { state: 'pick_website', session };
	const result = await product.entitlements.forWebsite(websiteId);
	if (!result.ok || !product.entitlements.can(result.doc, 'place_order')) return { state: 'not_subscribed', session };
	const site = await siteOf(websiteId, result.doc);
	return {
		state: 'ready',
		session,
		data: liveDashboard({ application, site, canWrite: DASHBOARD_WRITE_ROLES.includes(session.role) }),
		portalLink: `${app.product.portal.baseUrl}/websites/${encodeURIComponent(websiteId)}/subscriptions/${encodeURIComponent(result.doc.subscriptionId)}`,
	};
};
