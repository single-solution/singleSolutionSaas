/**
 * Dashboard data (SSO pages): the same views for a live website (merchant database) and for demo launches (sample
 * data in memory — nothing is stored, nothing can be changed).
 */
import { orderView } from '../core/orders.js';
import { settingsFrom } from './settings.js';

/** Dashboard roles that may change data (demo sessions are read-only). */
export const DASHBOARD_WRITE_ROLES = Object.freeze(['merchant', 'platform_admin', 'impersonate']);

/** Orders listed per dashboard page. */
export const DASHBOARD_PAGE = 50;

/**
 * @typedef {object} DashboardData
 * @property {boolean} demo
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
	demo: false,
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

/** A sample order of the demo. @param {number} now @param {string} id @param {string} status @param {string} method */
const sampleOrder = (now, id, status, method) =>
	orderView({
		id,
		number: id.slice(-6),
		status,
		placedAt: new Date(now - 3_600_000),
		expiresAt: status === 'pending_payment' ? new Date(now + 47 * 3_600_000) : null,
		currency: 'EUR',
		lines: [{ itemId: 'itm_demo', variantId: 'var_demo', title: 'Sample item', quantity: 2, unitAmount: 2500 }],
		totals: {
			currency: 'EUR',
			subtotal: 5000,
			itemDiscount: 0,
			couponDiscount: 500,
			shipping: 490,
			shippingDiscount: 0,
			surcharge: 0,
			loyalty: 0,
			tax: 0,
			total: 4990,
		},
		contact: { name: 'Sample shopper' },
		delivery: { key: 'standard', kind: 'ship', label: 'Delivery' },
		payment: {
			method,
			kind: 'manual',
			status: status === 'confirmed' ? 'paid' : 'unpaid',
			advance: 0,
			dueNow: method === 'bank_transfer' ? 4990 : 0,
			dueLater: method === 'cod' ? 4990 : 0,
		},
		timeline: [{ status, at: new Date(now - 3_600_000).toISOString() }],
	});

/** @param {{ now: number }} input @returns {DashboardData} */
export const demoDashboard = ({ now }) => {
	const list = [
		sampleOrder(now, 'ord_demo_000003', 'awaiting_confirmation', 'cod'),
		sampleOrder(now, 'ord_demo_000002', 'pending_payment', 'bank_transfer'),
		sampleOrder(now, 'ord_demo_000001', 'confirmed', 'bank_transfer'),
	];
	return {
		demo: true,
		canWrite: false,
		websiteId: null,
		settings: settingsFrom({ can: () => true, config: () => ({}), website: { currency: 'EUR' } }),
		overview: async () => ({ orders: 3, open: 2, currencies: [{ currency: 'EUR', orders: 1, revenue: 4990 }] }),
		orders: async ({ status = null }) => list.filter((order) => !status || order.status === status),
		order: async (id) => list.find((order) => order.id === id) ?? null,
		integrations: async () => ({ key: null, coupons: false, deals: false, loyalty: false, catalog: false }),
	};
};

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
	if (session.role === 'demo') return { state: 'ready', session, data: demoDashboard({ now: app.now() }), portalLink: null };
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
