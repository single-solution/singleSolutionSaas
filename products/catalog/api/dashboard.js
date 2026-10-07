/**
 * Dashboard data and routes (SSO sessions), catalog stats and the element views of the Loader's element stub.
 *
 * Dashboards show the same views for a live website (service + merchant database) and for demo launches (sandbox data
 * built in memory with the real core — nothing is stored, nothing can be changed). Writes from the dashboard (stock
 * adjustments, status changes, imports) go through the same services as the API and are audited with the session's
 * actor (staff when impersonating or launched as admin).
 */
import { created, defineRoute, ok, paginate, problem } from '@ss/app-kit';
import { formatMoney } from '../core/money.js';
import { ownerItem } from '../core/views.js';
import { statusDef } from '../core/items.js';
import { isId, isObject } from '../core/text.js';
import { settingsFrom } from './settings.js';
import { sessionView } from './session.js';
import { viewContext } from './items.js';

/** @typedef {import('./catalog.js').Site} Site */

/** Rows per dashboard page. */
export const DASHBOARD_PAGE = 50;
/** Dashboard roles that may change data (demo sessions are read-only). */
export const DASHBOARD_WRITE_ROLES = Object.freeze(['merchant', 'platform_admin', 'impersonate']);

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
	if (view.actor) return { type: 'staff', id: view.actor };
	return { type: view.kind === 'admin' ? 'staff' : 'merchant', id: view.user ?? 'unknown' };
};

/**
 * Page context of the element stub (`?ctx=` JSON: `{ path, itemId?, pageType? }`).
 * @param {unknown} raw
 * @returns {{ itemId: string | null, pageType: string | null }}
 */
export const stubContext = (raw) => {
	if (typeof raw !== 'string' || raw.length > 2048) return { itemId: null, pageType: null };
	try {
		const value = JSON.parse(raw);
		return {
			itemId: isObject(value) && isId(value.itemId) ? value.itemId : null,
			pageType: isObject(value) && typeof value.pageType === 'string' && value.pageType.length <= 40 ? value.pageType : null,
		};
	} catch {
		return { itemId: null, pageType: null };
	}
};

/**
 * @param {import('./routes.js').Catalog} catalog
 */
export const createDashboardApi = (catalog) => {
	const { product, items, variants, transfer, taxonomy, feeds, siteOf } = catalog;
	const t = (/** @type {string} */ key) => catalog.app.strings.en?.[key] ?? key;

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

	/**
	 * A text-only view model for the element stub (title, body, items with links; ≤ 50 items).
	 * @param {Site} site
	 * @param {string} element
	 * @param {unknown} rawContext
	 * @param {number} limit
	 */
	const elementView = async (site, element, rawContext, limit) => {
		const { itemId } = stubContext(rawContext);
		const locale = site.settings.language ?? 'en';
		const priceText = (/** @type {any} */ view) =>
			typeof view.priceMin === 'number' ? formatMoney(view.priceMin, view.currency, locale) : '';
		if (element === 'collections') {
			const list = await taxonomy.listCollections(site, { owner: false, tree: false });
			return {
				title: t('catalog.view.collections'),
				items: list
					.slice(0, 50)
					.map((/** @type {any} */ c) => ({ text: `${'— '.repeat(Math.max(0, c.depth - 1))}${c.title}` })),
			};
		}
		if (element === 'brands') {
			const list = await taxonomy.listBrands(site, { owner: false });
			return { title: t('catalog.view.brands'), items: list.slice(0, 50).map((/** @type {any} */ b) => ({ text: b.name })) };
		}
		if (element === 'attributes') {
			const facets = await taxonomy.facets(site, items.publicFilter(site), { collectionIds: null });
			return {
				title: t('catalog.view.filters'),
				items: facets.slice(0, 50).map((/** @type {any} */ f) => ({
					text: `${f.label}: ${f.values.map((/** @type {any} */ v) => `${v.label} (${v.count})`).join(', ')}`,
				})),
			};
		}
		if (element === 'variants' || element === 'media') {
			const item = itemId ? await items.find(site, itemId, { owner: false }) : null;
			if (!item)
				return {
					title: t(element === 'media' ? 'catalog.view.media' : 'catalog.view.options'),
					body: t('catalog.view.no_item'),
				};
			const view = /** @type {Record<string, any>} */ ((await items.publicViews(site, [item]))[0]);
			if (element === 'media')
				return {
					title: view.title,
					items: view.media
						.slice(0, 50)
						.filter((/** @type {any} */ m) => m.url)
						.map((/** @type {any} */ m) => ({ text: m.alt || view.title, href: m.url })),
				};
			return {
				title: view.title,
				items: view.variants.slice(0, 50).map((/** @type {any} */ v) => ({
					text: `${v.title ?? Object.values(v.options).join(' / ') ?? view.title} — ${formatMoney(v.price, view.currency, locale)} — ${t(`catalog.availability.${v.availability}`)}`,
				})),
			};
		}
		const listed = await items.list(site, {}, { owner: false, after: null, fetchLimit: limit });
		const views = listed.ok ? await items.publicViews(site, listed.items) : [];
		return {
			title: t('catalog.view.items'),
			...(views.length === 0 ? { body: t('catalog.view.empty') } : {}),
			items: views.map((view) => ({ text: [view.title, priceText(view)].filter(Boolean).join(' — '), href: view.url })),
		};
	};

	/** Dashboard session → site (null = pick a website / demo). @param {any} ctx */
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
			idempotent: 'optional',
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
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				if (!s) return noWebsite();
				const result = await variants.adjust(s, ctx.params.id, ctx.body, { key: ctx.idempotencyKey });
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
			idempotent: 'optional',
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
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				if (!s) return noWebsite();
				const result = await transfer.run(s, ctx.body, {
					key: ctx.idempotencyKey,
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
			idempotent: 'optional',
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

	return Object.freeze({ stats, elementView, routes, feeds });
};

/**
 * @typedef {object} DashboardData
 * @property {boolean} demo
 * @property {boolean} canWrite
 * @property {string | null} websiteId
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
		demo: false,
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
 * Sandbox data: a few items of different kinds built with the real core and the default settings.
 * @param {{ now: number }} input
 * @returns {DashboardData}
 */
export const demoDashboard = ({ now }) => {
	const settings = settingsFrom({
		can: () => true,
		config: () => ({}),
		domain: 'shop.example.com',
		website: { currency: 'EUR' },
		storage: false,
	});
	/** @type {Array<[string, string, string, number, number, string]>} slug, title, status, price, quantity, kind */
	const script = [
		['linen-shirt', 'Linen shirt', 'active', 4900, 12, 'physical'],
		['yoga-class', 'Yoga class (60 min)', 'active', 1500, 3, 'service'],
		['photo-presets', 'Photo presets pack', 'draft', 990, 0, 'digital'],
		['camping-tent', 'Camping tent (weekend rental)', 'active', 3500, 0, 'rental'],
	];
	const at = new Date(now);
	const rows = script.map(([slug, title, status, price, quantity], index) => ({
		id: `itm_demo${index}`,
		slug,
		title,
		type: 'item',
		status,
		variants: [
			{
				id: `var_demo${index}`,
				sku: `DEMO-${index + 1}`,
				barcode: null,
				title: null,
				options: {},
				price,
				compareAtPrice: null,
				cost: Math.round(price / 2),
				quantity,
				trackInventory: null,
				backorder: null,
				forceOutOfStock: false,
				status: 'active',
				mediaIds: [],
				position: 0,
				restockedAt: null,
			},
		],
		media: [],
		priceMin: price,
		priceMax: price,
		inStock: quantity > 0,
		available: quantity,
		version: 1,
		createdAt: at,
		updatedAt: at,
	}));
	const views = rows.map((row) =>
		ownerItem(row, { ...viewContext(/** @type {any} */ ({ settings }), { attributes: [], item: row }), exposeCost: true }),
	);
	return {
		demo: true,
		canWrite: false,
		websiteId: null,
		settings,
		stats: async () => ({
			items: {
				total: rows.length,
				limit: settings.items.max_items,
				byStatus: Object.fromEntries(
					settings.items.statuses.map((s) => [s.key, rows.filter((r) => r.status === s.key).length]),
				),
				deleted: 0,
				outOfStock: rows.filter((r) => !r.inStock).length,
				lowStock: rows.filter((r) => r.available > 0 && r.available <= settings.variants.low_stock_threshold).length,
			},
			attributes: 0,
			collections: 0,
			brands: 0,
			pendingEvents: 0,
			currency: 'EUR',
		}),
		items: async ({ status }) => ({ items: views.filter((v) => !status || v.status === status), nextCursor: null }),
		item: async (id) => views.find((v) => v.id === id) ?? null,
		feeds: async () => [],
	};
};

/**
 * @typedef {{ state: 'signin' } | { state: 'pick_website' | 'not_subscribed', session: any }
 *   | { state: 'ready', session: any, data: DashboardData, portalLink: string | null }} DashboardContext
 */

/**
 * Resolve a dashboard request: session → website → data.
 * @param {{ catalog: import('./routes.js').Catalog, sessionId: string | undefined, website?: string | null, now?: number }} input
 * @returns {Promise<DashboardContext>}
 */
export const resolveDashboard = async ({ catalog, sessionId, website = null, now = Date.now() }) => {
	const { product, siteOf, app } = catalog;
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
