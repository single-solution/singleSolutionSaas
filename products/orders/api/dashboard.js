/**
 * Dashboard data and routes (SSO sessions) and order stats.
 *
 * Writes from the dashboard (status moves, payments, refunds, fulfilment, serials, reviews, bulk) go through the same
 * services as the API, with the signed-in user as the `staff` actor (audited).
 */
import { defineRoute, ok, paginate, problem } from '@ss/app-kit';
import { isRevenue, revenueStatuses } from '../core/lifecycle.js';
import { netRevenue, summarize } from '../core/ledger.js';
import { idList, isId } from '../core/text.js';
import { filterOf } from './bulk.js';
import { labelsFor } from './context.js';
import { sessionView } from './session.js';

/** @typedef {import('./context.js').Site} Site */

/** Rows per dashboard page. */
export const DASHBOARD_PAGE = 50;
/** Dashboard roles that may change data. */
export const DASHBOARD_WRITE_ROLES = Object.freeze(['merchant', 'platform_admin']);

/**
 * The audited actor of a dashboard session (always `staff` in lifecycle terms).
 * @param {any} session app-kit session
 * @returns {import('./context.js').Actor}
 */
export const dashboardActor = (session) => {
	const view = sessionView(session);
	return { type: 'staff', id: view.user ?? 'unknown' };
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
 * @param {import('./routes.js').Orders} orders
 */
export const createDashboardApi = (orders) => {
	const { product, lifecycle, ledger, bulk, documents, blocklist, siteOf, processDue } = orders;

	/** @param {Site} site */
	const stats = async (site) => ({
		...statsOf(site.settings.matrix, await site.repos.orders.totals({})),
		review: await site.repos.orders.count({ 'risk.review': 'pending' }),
	});

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
	 * A dashboard write: the session's site, the staff actor, the service call. Writes that record money or blocks
	 * declare `idempotent: true` (a repeated Idempotency-Key answers 409 duplicate_request).
	 * @param {string} path
	 * @param {string} element
	 * @param {(site: Site, ctx: any, actor: import('./context.js').Actor) => Promise<any>} run
	 * @param {{ idempotent?: boolean }} [options]
	 */
	const write = (path, element, run, { idempotent = false } = {}) =>
		defineRoute({
			method: 'POST',
			path,
			auth: 'launch',
			element,
			roles: [...DASHBOARD_WRITE_ROLES],
			...(idempotent ? { idempotent } : {}),
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
		write(
			'/v1/dashboard/orders/:id/payments',
			'ledger',
			(site, ctx, actor) => ledger.pay(site, String(ctx.params.id), ctx.body, actor),
			{ idempotent: true },
		),
		write(
			'/v1/dashboard/orders/:id/refunds',
			'ledger',
			(site, ctx, actor) => ledger.refund(site, String(ctx.params.id), ctx.body, actor),
			{ idempotent: true },
		),
		write('/v1/dashboard/orders/:id/review', 'risk', (site, ctx, actor) =>
			lifecycle.review(site, String(ctx.params.id), ctx.body, actor),
		),
		// "Process due now": the website's expired statuses, left-behind outbox entries and due message retries (no timer)
		write('/v1/dashboard/due:run', 'lifecycle', async (site) => ({ ok: true, report: await processDue(site) })),
		write('/v1/dashboard/order-batches', 'bulk', (site, ctx, actor) => bulk.batch(site, ctx.body, actor), {
			idempotent: true,
		}),
		write('/v1/dashboard/blocklist', 'risk', (site, ctx, actor) => blocklist.block(site, ctx.body, actor), {
			idempotent: true,
		}),
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

	return Object.freeze({ stats, routes, product });
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
 * @typedef {{ state: 'signin' } | { state: 'pick_website' | 'not_subscribed', session: any }
 *   | { state: 'ready', session: any, data: DashboardData, portalLink: string | null }} DashboardContext
 */

/**
 * Resolve a dashboard request: session → website → data.
 * @param {{ orders: import('./routes.js').Orders, sessionId: string | undefined, website?: string | null }} input
 * @returns {Promise<DashboardContext>}
 */
export const resolveDashboard = async ({ orders, sessionId, website = null }) => {
	const { product, siteOf, app } = orders;
	const session = sessionId ? await product.launch.session(sessionId) : null;
	if (!session) return { state: 'signin' };
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
		portalLink: `${app.product.portal.baseUrl}/websites/${encodeURIComponent(websiteId)}/subscriptions/${encodeURIComponent(result.doc.subscriptionId)}`,
	};
};
