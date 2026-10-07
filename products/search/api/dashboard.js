/**
 * Dashboard data and routes (SSO sessions) and the index status (also `GET /v1/index-status`).
 *
 * Dashboards show the views of a live website (service + merchant database). Actions from the dashboard (crawl now,
 * crawl due sources, re-check Atlas) go through the same services as the API and are audited with the session's actor
 * (staff when launched as admin).
 */
import { defineRoute, ok, problem } from '@ss/app-kit';
import { dayOf } from '../core/analytics.js';
import { sessionView } from './session.js';

/** @typedef {import('./documents.js').Site} Site */

/** Dashboard roles that may act. */
export const DASHBOARD_WRITE_ROLES = Object.freeze(['merchant', 'platform_admin']);
/** Rows per dashboard page. */
export const DASHBOARD_PAGE = 50;

/**
 * The audited actor of a dashboard session.
 * @param {any} session app-kit session
 */
export const dashboardActor = (session) => {
	const view = sessionView(session);
	return { type: view.kind === 'admin' ? 'staff' : 'merchant', id: view.user ?? 'unknown' };
};

/**
 * @param {import('./routes.js').SearchProduct} searchApp
 */
export const createDashboardApi = (searchApp) => {
	const { product, engines, sources, siteOf } = searchApp;

	/**
	 * Index status: engine in use, Atlas state (and the index definition to create by hand when the database user may
	 * not), documents per type against the limit, vocabulary size and today's indexing quota.
	 * @param {Site} site
	 * @param {{ refresh?: boolean }} [options]
	 */
	const indexStatus = async (site, { refresh = false } = {}) => {
		const { index } = site.settings;
		const atlas = index.engine === 'portable' ? null : await engines.atlasStatus(site, { refresh });
		/** @type {Record<string, number>} */
		const byType = {};
		for (const type of site.settings.types.keys()) byType[type] = await site.repos.documents.count({ type });
		const day = dayOf(searchApp.app.now(), site.settings.timeZone);
		return {
			engine: {
				configured: index.engine,
				active: atlas?.state === 'ready' ? 'atlas' : 'portable',
				atlas: atlas
					? {
							state: atlas.state,
							detail: atlas.detail,
							checkedAt: atlas.checkedAt,
							...(atlas.definition ? { definition: atlas.definition } : {}),
						}
					: { state: 'disabled', detail: null, checkedAt: null },
			},
			documents: { total: await site.repos.documents.count(), limit: index.max_documents, byType },
			vocabulary: await site.repos.vocabulary.size(),
			quota: { day, used: await site.repos.counters.get(`upserts:${day}`), perDay: index.upserts_per_day },
		};
	};

	/** Dashboard session → site (null = no website in the session). @param {any} ctx */
	const dashboardSite = async (ctx) => (ctx.websiteId && ctx.entitlement ? siteOf(ctx.websiteId, ctx.entitlement.doc) : null);
	const noWebsite = () => problem('bad_request', 'Open the dashboard for a website.');

	const routes = () => [
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/sources/:key/crawl',
			auth: 'launch',
			element: 'sources',
			roles: [...DASHBOARD_WRITE_ROLES],
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				if (!s) return noWebsite();
				const result = await sources.crawlNow(s, ctx.params.key);
				if (!result.ok) return problem(result.reason, result.detail);
				await product.audit
					.record({
						websiteId: s.websiteId,
						actor: dashboardActor(ctx.session),
						action: 'source.crawled',
						target: { key: ctx.params.key },
					})
					.catch(() => undefined);
				return ok(result.value);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/crawl-due',
			auth: 'launch',
			element: 'sources',
			roles: [...DASHBOARD_WRITE_ROLES],
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				if (!s) return noWebsite();
				const result = await sources.runDue(s);
				await product.audit
					.record({
						websiteId: s.websiteId,
						actor: dashboardActor(ctx.session),
						action: 'sources.crawled_due',
						target: { crawled: result.crawled },
					})
					.catch(() => undefined);
				return ok(result);
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/dashboard/engine/check',
			auth: 'launch',
			element: 'index',
			roles: [...DASHBOARD_WRITE_ROLES],
			handler: async (ctx) => {
				const s = await dashboardSite(ctx);
				if (!s) return noWebsite();
				const status = await indexStatus(s, { refresh: true });
				await product.audit
					.record({
						websiteId: s.websiteId,
						actor: dashboardActor(ctx.session),
						action: 'engine.checked',
						target: { state: status.engine.atlas.state },
					})
					.catch(() => undefined);
				return ok(status);
			},
		}),
	];

	return { indexStatus, routes };
};

/**
 * @typedef {object} DashboardData
 * @property {boolean} canWrite
 * @property {string} websiteId
 * @property {import('./settings.js').Settings} settings
 * @property {() => Promise<Awaited<ReturnType<ReturnType<typeof createDashboardApi>['indexStatus']>>>} status
 * @property {(input: { cursor?: string | null }) => Promise<{ items: any[], nextCursor: string | null }>} documents
 * @property {(q: string) => Promise<import('../core/results.js').SearchResponse | null>} search
 * @property {() => Promise<any>} sources
 * @property {(days: number) => Promise<any | null>} analytics
 */

/**
 * Live dashboard data of a website.
 * @param {{ searchApp: import('./routes.js').SearchProduct, site: Site, canWrite: boolean }} input
 * @returns {DashboardData}
 */
export const liveDashboard = ({ searchApp, site, canWrite }) => {
	const api = createDashboardApi(searchApp);
	return {
		canWrite,
		websiteId: site.websiteId,
		settings: site.settings,
		status: () => api.indexStatus(site),
		documents: async ({ cursor = null }) => {
			const items = await searchApp.documents.list(site, {
				after: cursor,
				fetchLimit: DASHBOARD_PAGE + 1,
				type: null,
				source: null,
			});
			const page = items.slice(0, DASHBOARD_PAGE);
			return { items: page, nextCursor: items.length > DASHBOARD_PAGE ? (page.at(-1)?.id ?? null) : null };
		},
		search: async (q) => {
			const result = await searchApp.search.search(site, { q, limit: '20', track: '0', explain: true }, { owner: true });
			return result.ok ? result.value : null;
		},
		sources: () => searchApp.sources.list(site),
		analytics: async (days) => {
			if (!site.settings.enabled('analytics')) return null;
			const result = await searchApp.search.report(site, {
				days: String(Math.min(days, site.settings.analytics.retention_days)),
			});
			return result.ok ? result.value : null;
		},
	};
};

/**
 * @typedef {{ state: 'signin' } | { state: 'pick_website' | 'not_subscribed', session: any }
 *   | { state: 'ready', session: any, data: DashboardData, portalLink: string | null }} DashboardContext
 */

/**
 * Resolve a dashboard request: session → website → data.
 * @param {{ searchApp: import('./routes.js').SearchProduct, sessionId: string | undefined, website?: string | null }} input
 * @returns {Promise<DashboardContext>}
 */
export const resolveDashboard = async ({ searchApp, sessionId, website = null }) => {
	const { product, siteOf, app } = searchApp;
	const session = sessionId ? await product.launch.session(sessionId) : null;
	if (!session) return { state: 'signin' };
	const scope = session.scope ?? {};
	const allowed = [scope.websiteId, ...(Array.isArray(scope.websiteIds) ? scope.websiteIds : [])].filter(
		(/** @type {unknown} */ id) => typeof id === 'string' && id.length > 0,
	);
	const websiteId = website && allowed.includes(website) ? website : allowed[0];
	if (!websiteId) return { state: 'pick_website', session };
	const result = await product.entitlements.forWebsite(websiteId);
	if (!result.ok || !product.entitlements.can(result.doc, 'index')) return { state: 'not_subscribed', session };
	const site = await siteOf(websiteId, result.doc);
	return {
		state: 'ready',
		session,
		data: liveDashboard({ searchApp, site, canWrite: DASHBOARD_WRITE_ROLES.includes(session.role) }),
		portalLink: `${app.product.portal.baseUrl}/websites/${encodeURIComponent(websiteId)}/subscriptions/${encodeURIComponent(result.doc.subscriptionId)}`,
	};
};
