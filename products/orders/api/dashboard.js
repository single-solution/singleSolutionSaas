/**
 * Dashboard data and routes (SSO sessions), order stats and the element views of the Loader's element stub.
 *
 * Dashboards show the same views for a live website (service + merchant database) and for demo launches (sandbox
 * orders built in memory with the real core — nothing is stored, nothing can be changed). Writes from the dashboard
 * (status moves, payments, refunds, fulfilment, serials, reviews, bulk) go through the same services as the API, with
 * the session's actor as `staff` (audited, impersonation included).
 */
import { defineRoute, ok, paginate, problem } from '@ss/app-kit';
import { formatMoney } from '../core/money.js';
import { isRevenue, revenueStatuses } from '../core/lifecycle.js';
import { netRevenue, summarize } from '../core/ledger.js';
import { validateOrder } from '../core/orders.js';
import { emptyFulfilment } from '../core/fulfilment.js';
import { idList, isId } from '../core/text.js';
import { filterOf } from './bulk.js';
import { labelsFor } from './context.js';
import { sessionView } from './session.js';
import { settingsFrom } from './settings.js';

/** @typedef {import('./context.js').Site} Site */

/** Rows per dashboard page. */
export const DASHBOARD_PAGE = 50;
/** Dashboard roles that may change data (demo sessions are read-only). */
export const DASHBOARD_WRITE_ROLES = Object.freeze(['merchant', 'platform_admin', 'impersonate']);

/**
 * The audited actor of a dashboard session (always `staff` in lifecycle terms).
 * @param {any} session app-kit session
 * @returns {import('./context.js').Actor}
 */
export const dashboardActor = (session) => {
	const view = sessionView(session);
	return { type: 'staff', id: view.actor ?? view.user ?? 'unknown' };
};

/**
 * Order stats: counts per status, open orders, the review queue and net revenue per currency — revenue statuses only,
 * net of refunds (A11: one definition everywhere).
 * @param {import('../core/lifecycle.js').Matrix} matrix
 * @param {Array<{ _id: { status: string, currency: string }, orders: number, total: number, paid: number, refunded: number }>} groups
 */
export const statsOf = (matrix, groups) => {
	/** @type {Record<string, number>} */
	const byStatus = {};
	/** @type {Record<string, { revenue: number, orders: number, paid: number, refunded: number }>} */
	const byCurrency = {};
	let orders = 0;
	for (const group of groups) {
		const { status, currency } = group._id;
		byStatus[status] = (byStatus[status] ?? 0) + group.orders;
		orders += group.orders;
		const sums = (byCurrency[currency] ??= { revenue: 0, orders: 0, paid: 0, refunded: 0 });
		sums.paid += group.paid;
		sums.refunded += group.refunded;
		if (isRevenue(matrix, status)) {
			sums.revenue += Math.max(0, group.total - group.refunded);
			sums.orders += group.orders;
		}
	}
	const open = matrix.statuses.filter((s) => s.open).reduce((sum, s) => sum + (byStatus[s.key] ?? 0), 0);
	return { orders, open, byStatus, byCurrency, revenueStatuses: revenueStatuses(matrix) };
};

/**
 * Page context of the element stub is not needed: the views are per customer.
 * @param {import('./routes.js').Orders} orders
 */
export const createDashboardApi = (orders) => {
	const { product, lifecycle, ledger, bulk, documents, blocklist, siteOf, deps } = orders;

	/** @param {Site} site */
	const stats = async (site) => ({
		...statsOf(site.settings.matrix, await site.repos.orders.totals({})),
		review: await site.repos.orders.count({ 'risk.review': 'pending' }),
	});

	/**
	 * A text-only view model for the element stub (title, body, items ≤ 50).
	 * @param {Site} site
	 * @param {string} element
	 * @param {{ subject: string, email?: string | null, phone?: string | null } | null} identity
	 */
	const elementView = async (site, element, identity) => {
		const labels = labelsFor(deps, site);
		const { t } = labels;
		const title = t(`view.${element}`);
		if (!identity) return { title, body: t('view.sign_in') };
		const recent = await site.repos.orders.page(lifecycle.customerFilter(site, identity), { after: null, limit: 10 });
		if (recent.length === 0) return { title, body: t('view.no_orders') };
		if (element === 'fulfilment') {
			const shipped = recent.filter(
				(/** @type {any} */ o) => o.fulfilment?.trackingNumber && site.settings.fulfilment.show_tracking_to_customer,
			);
			if (shipped.length === 0) return { title, body: t('view.no_tracking') };
			return {
				title,
				items: shipped.map((/** @type {any} */ o) => ({
					text: t('view.tracking_item', {
						number: o.number,
						carrier: o.fulfilment.carrierName ?? '',
						tracking: o.fulfilment.trackingNumber,
					}),
					...(o.fulfilment.trackingUrl ? { href: o.fulfilment.trackingUrl } : {}),
				})),
			};
		}
		return {
			title,
			items: recent.map((/** @type {any} */ o) => ({
				text: t('view.order_item', {
					number: o.number,
					status: labels.statusLabel(o.status),
					total: formatMoney(o.amounts.total, o.currency, labels.lang),
				}),
			})),
		};
	};

	/** Dashboard session → site (null = pick a website). @param {any} ctx */
	const dashboardSite = async (ctx) => (ctx.websiteId && ctx.entitlement ? siteOf(ctx.websiteId, ctx.entitlement.doc) : null);
	const noWebsite = () => problem('bad_request', 'Open the dashboard for a website.');

	/**
	 * @param {any} result a service failure
	 */
	const failed = (result) =>
		problem(result.reason, result.detail ?? result.reason.replace(/_/g, ' '), {
			...(result.errors
				? { errors: result.errors.map((/** @type {any} */ e) => ({ ...e, message: e.code.replace(/_/g, ' ') })) }
				: {}),
		});

	/**
	 * A dashboard write: the session's site, the staff actor, the service call.
	 * @param {string} path
	 * @param {string} element
	 * @param {(site: Site, ctx: any, actor: import('./context.js').Actor) => Promise<any>} run
	 */
	const write = (path, element, run) =>
		defineRoute({
			method: 'POST',
			path,
			auth: 'launch',
			element,
			roles: [...DASHBOARD_WRITE_ROLES],
			idempotent: 'optional',
			handler: async (ctx) => {
				const site = await dashboardSite(ctx);
				if (!site) return noWebsite();
				const result = await run(site, ctx, dashboardActor(ctx.session));
				if (!result.ok) return failed(result);
				return ok(
					result.order
						? { id: result.order.id, status: result.order.status, version: result.order.version }
						: (result.report ?? result.entry ?? {}),
				);
			},
		});

	/**
	 * A dashboard HTML print view.
	 * @param {string} path
	 * @param {string} element
	 * @param {(site: Site, ctx: any) => Promise<string | null>} render
	 */
	const print = (path, element, render) =>
		defineRoute({
			method: 'GET',
			path,
			auth: 'launch',
			element,
			handler: async (ctx) => {
				const site = await dashboardSite(ctx);
				if (!site) return noWebsite();
				const html = await render(site, ctx);
				if (html === null) return problem('not_found', 'Nothing to print.');
				return new Response(html, { status: 200, headers: HTML_VIEW_HEADERS });
			},
		});

	const routes = () => [
		defineRoute({
			method: 'GET',
			path: '/v1/dashboard/overview',
			auth: 'launch',
			element: 'lifecycle',
			handler: async (ctx) => {
				const site = await dashboardSite(ctx);
				return site ? ok(await stats(site)) : noWebsite();
			},
		}),
		write('/v1/dashboard/orders/:id/transitions', 'lifecycle', (site, ctx, actor) =>
			lifecycle.move(site, String(ctx.params.id), ctx.body?.status, { actor, reason: ctx.body?.reason, note: ctx.body?.note }),
		),
		write('/v1/dashboard/orders/:id/fulfilment', 'fulfilment', (site, ctx, actor) =>
			lifecycle.fulfil(site, String(ctx.params.id), ctx.body, actor),
		),
		write('/v1/dashboard/orders/:id/serials', 'serials', (site, ctx, actor) =>
			lifecycle.setSerials(site, String(ctx.params.id), ctx.body, actor),
		),
		write('/v1/dashboard/orders/:id/payments', 'ledger', (site, ctx, actor) =>
			ledger.pay(site, String(ctx.params.id), ctx.body, actor),
		),
		write('/v1/dashboard/orders/:id/refunds', 'ledger', (site, ctx, actor) =>
			ledger.refund(site, String(ctx.params.id), ctx.body, actor),
		),
		write('/v1/dashboard/orders/:id/review', 'risk', (site, ctx, actor) =>
			lifecycle.review(site, String(ctx.params.id), ctx.body, actor),
		),
		write('/v1/dashboard/order-batches', 'bulk', (site, ctx, actor) => bulk.batch(site, ctx.body, actor)),
		write('/v1/dashboard/blocklist', 'risk', (site, ctx, actor) => blocklist.block(site, ctx.body, actor)),
		print('/v1/dashboard/orders/:id/invoice', 'invoices', async (site, ctx) => {
			const order = isId(ctx.params.id) ? await site.repos.orders.get(ctx.params.id) : null;
			return order
				? (await documents.invoice(site, order, ctx.query.kind === 'internal' ? 'internal' : 'customer')).html
				: null;
		}),
		print('/v1/dashboard/packing-slips', 'print', async (site, ctx) => {
			const ids = idList(ctx.query.ids, site.settings.print.max_orders_per_print);
			return ids ? documents.packingSlips(site, await site.repos.orders.many(ids)) : null;
		}),
		print('/v1/dashboard/pick-lists', 'print', async (site, ctx) => {
			const ids = idList(ctx.query.ids, site.settings.print.max_orders_per_print);
			return ids ? documents.pickList(site, await site.repos.orders.many(ids)) : null;
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/dashboard/order-exports',
			auth: 'launch',
			element: 'bulk',
			handler: async (ctx) => {
				const site = await dashboardSite(ctx);
				if (!site) return noWebsite();
				const result = await bulk.exportCsv(site, ctx.query);
				if (!result.ok) return failed(result);
				return new Response(result.csv, {
					status: 200,
					headers: {
						'content-type': 'text/csv; charset=utf-8',
						'content-disposition': 'attachment; filename="orders.csv"',
						'cache-control': 'no-store',
					},
				});
			},
		}),
	];

	return Object.freeze({ stats, elementView, routes, product });
};

/** Headers of the printable views (same policy as the API's). */
export const HTML_VIEW_HEADERS = Object.freeze({
	'content-type': 'text/html; charset=utf-8',
	'cache-control': 'no-store',
	'content-security-policy':
		"default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; form-action 'none'",
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'no-referrer',
});

/**
 * @typedef {object} DashboardData
 * @property {boolean} demo
 * @property {boolean} canWrite
 * @property {string | null} websiteId
 * @property {import('./settings.js').Settings} settings
 * @property {ReturnType<typeof labelsFor>} labels
 * @property {() => Promise<Record<string, any>>} stats
 * @property {(query: Record<string, string | undefined>) => Promise<{ items: Array<Record<string, any>>, nextCursor: string | null }>} orders
 * @property {(id: string) => Promise<Record<string, any> | null>} order
 * @property {(query: Record<string, string | undefined>) => Promise<{ items: Array<Record<string, any>>, totals: Record<string, any> }>} ledger
 * @property {() => Promise<Array<Record<string, any>>>} reviews
 */

/**
 * @param {Site} site
 * @param {Record<string, any>} order
 * @returns {Record<string, any>}
 */
const ownerRow = (site, order) => ({
	...order,
	revenue: isRevenue(site.settings.matrix, order.status),
	money: summarize(order),
	netRevenue: netRevenue(order, isRevenue(site.settings.matrix, order.status)),
	next: site.settings.matrix.transitions.filter((t) => t.from === order.status && t.actors.includes('staff')).map((t) => t.to),
});

/**
 * @param {{ orders: import('./routes.js').Orders, site: Site, canWrite: boolean }} input
 * @returns {DashboardData}
 */
export const liveDashboard = ({ orders, site, canWrite }) => {
	const api = createDashboardApi(orders);
	return {
		demo: false,
		canWrite,
		websiteId: site.websiteId,
		settings: site.settings,
		labels: labelsFor(orders.deps, site),
		stats: () => api.stats(site),
		orders: async (query) => {
			const filter = filterOf(query) ?? {};
			/** @type {ReturnType<typeof paginate>} */
			let page;
			try {
				page = paginate(
					{ cursor: query.cursor, limit: String(DASHBOARD_PAGE) },
					{ defaultLimit: DASHBOARD_PAGE, maxLimit: DASHBOARD_PAGE },
				);
			} catch {
				return { items: [], nextCursor: null };
			}
			const items = await site.repos.orders.page(filter, { after: page.after, limit: page.fetchLimit });
			const body = page.page(items, (o) => [new Date(o.placedAt).toISOString(), o.id]);
			return { items: body.items.map((o) => ownerRow(site, o)), nextCursor: body.nextCursor };
		},
		order: async (id) => {
			const order = isId(id) ? await site.repos.orders.get(id) : null;
			return order ? ownerRow(site, order) : null;
		},
		ledger: async (query) => {
			const result = await orders.ledger.entries(site, query);
			return result.ok ? { items: result.items, totals: result.totals } : { items: [], totals: {} };
		},
		reviews: async () =>
			(await site.repos.orders.page({ 'risk.review': 'pending' }, { after: null, limit: DASHBOARD_PAGE })).map(
				(/** @type {any} */ o) => ownerRow(site, o),
			),
	};
};

/**
 * Sandbox data: a few orders in different statuses built with the real core and the default settings.
 * @param {{ now: number, strings: Record<string, Record<string, string>> }} input
 * @returns {DashboardData}
 */
export const demoDashboard = ({ now, strings }) => {
	const settings = settingsFrom({
		can: () => true,
		config: () => ({}),
		domain: 'shop.example.com',
		website: { currency: 'EUR', language: 'en' },
	});
	/** @type {Array<[string, string, number, number, string]>} number, status, unit amount, quantity, title */
	const script = [
		['000101', 'awaiting_confirmation', 4900, 1, 'Linen shirt'],
		['000102', 'confirmed', 1500, 2, 'Yoga class (60 min)'],
		['000103', 'dispatched', 12900, 1, 'Camping tent'],
		['000104', 'delivered', 990, 3, 'Photo presets pack'],
		['000105', 'cancelled', 3500, 1, 'Desk lamp'],
	];
	const site = /** @type {Site} */ ({ websiteId: 'web_demo', settings, repos: /** @type {any} */ ({}) });
	const rows = script.map(([number, status, unit, quantity, title], index) => {
		const checked = validateOrder(
			{
				number,
				currency: 'EUR',
				customer: { name: `Customer ${index + 1}` },
				payment: { method: index === 0 ? 'cod' : 'card', status: index === 0 ? 'unpaid' : 'paid' },
				lines: [{ title, sku: `DEMO-${index + 1}`, quantity, unitAmount: unit }],
			},
			{ maxLines: 10, defaultCurrency: 'EUR' },
		);
		const draft = /** @type {any} */ (checked).draft;
		const at = new Date(now - index * 86_400_000);
		return ownerRow(site, {
			...draft,
			id: `ord_demo${index}`,
			source: 'dashboard',
			status,
			placedAt: at,
			paid: draft.payment.paidAmount,
			refunded: 0,
			payments: [],
			refunds: [],
			timeline: [{ status, at, actor: { type: 'system', id: 'demo' } }],
			fulfilment: emptyFulfilment(),
			risk: { flags: [], review: 'none', advance: 0 },
			version: 1,
		});
	});
	const deps = /** @type {any} */ ({ strings });
	return {
		demo: true,
		canWrite: false,
		websiteId: null,
		settings,
		labels: labelsFor(deps, site),
		stats: async () => ({
			...statsOf(
				settings.matrix,
				rows.map((r) => ({
					_id: { status: r.status, currency: r.currency },
					orders: 1,
					total: r.amounts.total,
					paid: r.paid,
					refunded: 0,
				})),
			),
			review: 0,
		}),
		orders: async ({ status }) => ({ items: rows.filter((r) => !status || r.status === status), nextCursor: null }),
		order: async (id) => rows.find((r) => r.id === id) ?? null,
		ledger: async () => ({ items: [], totals: {} }),
		reviews: async () => [],
	};
};

/**
 * @typedef {{ state: 'signin' } | { state: 'pick_website' | 'not_subscribed', session: any }
 *   | { state: 'ready', session: any, data: DashboardData, portalLink: string | null }} DashboardContext
 */

/**
 * Resolve a dashboard request: session → website → data.
 * @param {{ orders: import('./routes.js').Orders, sessionId: string | undefined, website?: string | null, now?: number }} input
 * @returns {Promise<DashboardContext>}
 */
export const resolveDashboard = async ({ orders, sessionId, website = null, now = Date.now() }) => {
	const { product, siteOf, app } = orders;
	const session = sessionId ? await product.launch.session(sessionId) : null;
	if (!session) return { state: 'signin' };
	if (session.role === 'demo')
		return { state: 'ready', session, data: demoDashboard({ now, strings: app.strings }), portalLink: null };
	const scope = session.scope ?? {};
	const allowed = [scope.websiteId, ...(Array.isArray(scope.websiteIds) ? scope.websiteIds : [])].filter(
		(/** @type {unknown} */ id) => typeof id === 'string' && id.length > 0,
	);
	const websiteId = website && allowed.includes(website) ? website : allowed[0];
	if (!websiteId) return { state: 'pick_website', session };
	const result = await product.entitlements.forWebsite(websiteId);
	if (!result.ok || !product.entitlements.can(result.doc, 'lifecycle')) return { state: 'not_subscribed', session };
	const site = await siteOf(websiteId, result.doc);
	return {
		state: 'ready',
		session,
		data: liveDashboard({ orders, site, canWrite: DASHBOARD_WRITE_ROLES.includes(session.role) }),
		portalLink: `${app.portalUrl.replace(/\/+$/, '')}/websites/${encodeURIComponent(websiteId)}/subscriptions/${encodeURIComponent(result.doc.subscriptionId)}`,
	};
};
