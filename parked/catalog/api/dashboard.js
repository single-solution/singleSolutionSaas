/**
 * Dashboard data and routes (SSO sessions) and catalog stats. Writes from the dashboard (stock adjustments, status
 * changes, imports) go through the same services as the API and are audited with the session's actor (staff when
 * launched as admin).
 */
import { created, defineRoute, ok, paginate, problem } from '@ss/app-kit';
import { statusDef } from '../core/items.js';
import { isId, isObject } from '../core/text.js';
import { requestKey } from './catalog.js';
import { sessionView } from './session.js';

/** @typedef {import('./catalog.js').Site} Site */

/** Rows per dashboard page. */
export const DASHBOARD_PAGE = 50;
/** Dashboard roles that may change data. */
export const DASHBOARD_WRITE_ROLES = Object.freeze(['merchant', 'platform_admin']);

/** Export parameters a download link may carry (item filters as for `GET /v1/items`). */
const EXPORT_PARAM = /^(?:q|filter\[[A-Za-z_.]{1,40}\])$/;
const MAX_EXPORT_PARAMS = 20;
const MAX_EXPORT_VALUE = 200;

/**
 * The export parameters of a link request (`{ params?: { 'filter[status]': 'active', q: '…' } }`), or null when invalid.
 * @param {unknown} body
 * @returns {Record<string, string> | null}
 */
export const exportParamsOf = (body) => {
	if (body === undefined || body === null) return {};
	if (!isObject(body)) return null;
	const params = /** @type {Record<string, unknown>} */ (body).params ?? {};
	if (!isObject(params)) return null;
	const entries = Object.entries(params);
	if (entries.length > MAX_EXPORT_PARAMS) return null;
	for (const [key, value] of entries)
		if (!EXPORT_PARAM.test(key) || typeof value !== 'string' || value.length > MAX_EXPORT_VALUE) return null;
	return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : 1)));
};

/**
 * The CSV download response of an export.
 * @param {string} csv
 */
const csvDownload = (csv) =>
	new Response(csv, {
		status: 200,
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': 'attachment; filename="catalog.csv"',
			'cache-control': 'no-store',
		},
	});

/**
 * The audited actor of a dashboard session.
 * @param {any} session app-kit session
 */
export const dashboardActor = (session) => {
	const view = sessionView(session);
	return { type: view.kind === 'admin' ? 'staff' : 'merchant', id: view.user ?? 'unknown' };
};

/**
 * @param {import('./routes.js').Catalog} catalog
 */
export const createDashboardApi = (catalog) => {
	const { product, items, variants, transfer, feeds, siteOf } = catalog;

	/**
	 * Catalog stats (`GET /v1/catalog-stats`, dashboard overview).
	 * @param {Site} site
	 */
	const stats = async (site) => {
		const { statuses } = site.settings.items;
		/** @type {Record<string, number>} */
		const byStatus = {};
		for (const status of statuses) byStatus[status.key] = await site.repos.items.count({ deletedAt: null, status: status.key });
		const threshold = site.settings.variants.low_stock_threshold;
		return {
			items: {
				total: await site.repos.items.count({ deletedAt: null }),
				limit: site.settings.items.max_items,
				byStatus,
				deleted: await site.repos.items.count({ deletedAt: { $ne: null } }),
				outOfStock: await site.repos.items.count({ deletedAt: null, inStock: false }),
				lowStock: await site.repos.items.count({
					deletedAt: null,
					variants: { $elemMatch: { quantity: { $gt: 0, $lte: threshold }, status: 'active' } },
				}),
			},
			attributes: await site.repos.attributes.count(),
			collections: await site.repos.collections.count(),
			brands: await site.repos.brands.count(),
			pendingEvents: await site.repos.items.count({ outboxAt: { $type: 'date' } }),
			currency: site.settings.currencyOf(null),
		};
	};

	/** Dashboard session → site (null = pick a website). @param {any} ctx */
	const dashboardSite = async (ctx) => (ctx.websiteId && ctx.entitlement ? siteOf(ctx.websiteId, ctx.entitlement.doc) : null);
	const noWebsite = () => problem('bad_request', 'Open the dashboard for a website.');

	const routes = () => [
		defineRoute({
			method: 'GET',
			path: '/v1/dashboard/overview',
			auth: 'launch',
			element: 'items',
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				return s ? ok(await stats(s)) : noWebsite();
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/due-work',
			auth: 'launch',
			element: 'items',
			roles: [...DASHBOARD_WRITE_ROLES],
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				return s ? ok(await catalog.due.runDue(s)) : noWebsite();
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/variants/:id/stock',
			auth: 'launch',
			element: 'variants',
			roles: [...DASHBOARD_WRITE_ROLES],
			idempotent: true,
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				if (!s) return noWebsite();
				const result = await variants.adjust(s, ctx.params.id, ctx.body, { key: requestKey(catalog, ctx) });
				if (!result.ok) return problem(result.reason, result.detail ?? result.reason);
				await product.audit
					.record({
						websiteId: s.websiteId,
						actor: dashboardActor(ctx.session),
						action: 'stock.adjusted',
						target: { variantId: ctx.params.id },
					})
					.catch(() => undefined);
				return ok({ id: ctx.params.id, quantity: result.variant.quantity });
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/items/:id/status',
			auth: 'launch',
			element: 'items',
			roles: [...DASHBOARD_WRITE_ROLES],
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				if (!s) return noWebsite();
				const result = await items.update(
					s,
					ctx.params.id,
					{ status: ctx.body?.status },
					{ actor: dashboardActor(ctx.session), exposeCost: true },
				);
				return result.ok
					? ok({ id: ctx.params.id, status: result.item.status })
					: problem(result.reason, result.detail ?? result.reason);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/imports',
			auth: 'launch',
			element: 'import_export',
			roles: [...DASHBOARD_WRITE_ROLES],
			maxBodyBytes: 3_900_000,
			idempotent: true,
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				if (!s) return noWebsite();
				const result = await transfer.run(s, ctx.body, {
					key: requestKey(catalog, ctx),
					actor: dashboardActor(ctx.session),
					exposeCost: true,
				});
				return result.ok
					? ok(result.report)
					: problem(
							result.reason,
							result.detail ?? result.reason,
							result.errors ? { errors: result.errors.map((e) => ({ ...e, message: e.code })) } : {},
						);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/dashboard/exports',
			auth: 'launch',
			element: 'import_export',
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				if (!s) return noWebsite();
				const result = await transfer.exportItems(s, ctx.query, { exposeCost: true });
				if (!result.ok) return problem(result.reason, result.detail ?? result.reason);
				return csvDownload(result.csv);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/exports:link',
			auth: 'launch',
			element: 'import_export',
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				if (!s) return noWebsite();
				const params = exportParamsOf(ctx.body);
				if (!params)
					return problem('validation_failed', 'The export parameters are not valid.', {
						errors: [{ path: '/params', code: 'params_invalid', message: 'params invalid' }],
					});
				const link = catalog.app.exportLinks.issue({ websiteId: s.websiteId, kind: 'items', params });
				const url = new URL(`/v1/dashboard/exports/${link.token}`, ctx.request.url).toString();
				return created({ url, expiresAt: link.expiresAt }, { headers: { 'cache-control': 'no-store' } });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/dashboard/exports/:token',
			auth: 'none',
			handler: async (ctx) => {
				const link = catalog.app.exportLinks.verify(ctx.params.token);
				if (!link.ok)
					return problem(
						'unauthorized',
						link.reason === 'expired' ? 'This download link has expired.' : 'This download link is not valid.',
						{ headers: { 'cache-control': 'no-store' } },
					);
				const s = await catalog.siteFor(link.websiteId);
				if (!s || !s.settings.enabled('import_export'))
					return problem('element_disabled', 'Import & export is not enabled for this website.', {
						headers: { 'cache-control': 'no-store' },
					});
				const result = await transfer.exportItems(s, link.params, { exposeCost: true });
				if (!result.ok) return problem(result.reason, result.detail ?? result.reason);
				return csvDownload(result.csv);
			},
		}),
	];

	return Object.freeze({ stats, routes, feeds });
};

/**
 * @typedef {object} DashboardData
 * @property {boolean} canWrite
 * @property {string} websiteId
 * @property {import('./settings.js').Settings} settings
 * @property {() => Promise<Record<string, any>>} stats
 * @property {(query: { status?: string, cursor?: string }) => Promise<{ items: Array<Record<string, any>>, nextCursor: string | null }>} items
 * @property {(id: string) => Promise<Record<string, any> | null>} item
 * @property {() => Promise<Array<Record<string, any>>>} feeds
 */

/**
 * @param {{ catalog: import('./routes.js').Catalog, site: Site, canWrite: boolean }} input
 * @returns {DashboardData}
 */
export const liveDashboard = ({ catalog, site, canWrite }) => {
	const api = createDashboardApi(catalog);
	return {
		canWrite,
		websiteId: site.websiteId,
		settings: site.settings,
		stats: () => api.stats(site),
		items: async ({ status, cursor }) => {
			const query = status ? { 'filter[status]': status } : {};
			/** @type {ReturnType<typeof paginate>} */
			let page;
			try {
				page = paginate(
					{ cursor, limit: String(DASHBOARD_PAGE) },
					{ defaultLimit: DASHBOARD_PAGE, maxLimit: DASHBOARD_PAGE },
				);
			} catch {
				return { items: [], nextCursor: null };
			}
			const result = await catalog.items.list(site, query, { owner: true, after: page.after, fetchLimit: page.fetchLimit });
			if (!result.ok) return { items: [], nextCursor: null };
			const body = page.page(result.items, (item) => catalog.items.cursorKey(item, result.spec));
			await catalog.due.settle(site, body.items);
			return {
				items: await Promise.all(body.items.map((item) => catalog.items.owner(site, item, { exposeCost: true }))),
				nextCursor: body.nextCursor,
			};
		},
		item: async (id) => {
			const item = isId(id) ? await site.repos.items.get(id) : null;
			if (!item) return null;
			await catalog.due.settle(site, [item]);
			return catalog.items.owner(site, item, { exposeCost: true });
		},
		feeds: async () => catalog.feeds.list(site),
	};
};

/**
 * @typedef {{ state: 'signin' } | { state: 'pick_website' | 'not_subscribed', session: any }
 *   | { state: 'ready', session: any, data: DashboardData, portalLink: string | null }} DashboardContext
 */

/**
 * Resolve a dashboard request: session → website → data.
 * @param {{ catalog: import('./routes.js').Catalog, sessionId: string | undefined, website?: string | null }} input
 * @returns {Promise<DashboardContext>}
 */
export const resolveDashboard = async ({ catalog, sessionId, website = null }) => {
	const { product, siteOf, app } = catalog;
	const session = sessionId ? await product.launch.session(sessionId) : null;
	if (!session) return { state: 'signin' };
	const scope = session.scope ?? {};
	const allowed = [scope.websiteId, ...(Array.isArray(scope.websiteIds) ? scope.websiteIds : [])].filter(
		(/** @type {unknown} */ id) => typeof id === 'string' && id.length > 0,
	);
	const websiteId = website && allowed.includes(website) ? website : allowed[0];
	if (!websiteId) return { state: 'pick_website', session };
	const result = await product.entitlements.forWebsite(websiteId);
	if (!result.ok || !product.entitlements.can(result.doc, 'items')) return { state: 'not_subscribed', session };
	const site = await siteOf(websiteId, result.doc);
	return {
		state: 'ready',
		session,
		data: liveDashboard({ catalog, site, canWrite: DASHBOARD_WRITE_ROLES.includes(session.role) }),
		portalLink: `${app.product.portal.baseUrl}/websites/${encodeURIComponent(websiteId)}/subscriptions/${encodeURIComponent(result.doc.subscriptionId)}`,
	};
};

/** Labels of item statuses (for pages). @param {import('./settings.js').Settings} settings @param {string} key */
export const statusLabel = (settings, key) => statusDef(settings.items.statuses, key).label;
