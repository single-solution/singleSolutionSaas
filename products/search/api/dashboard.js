/**
 * Dashboard data and routes (SSO sessions), the index status (also `GET /v1/index-status`) and the overlay's element
 * views for the Loader's element stub.
 *
 * Dashboards show the same views for a live website (service + merchant database) and for demo launches (sample
 * documents searched in memory with the real core — nothing is stored, nothing can be changed). Actions from the
 * dashboard (crawl now, crawl due sources, re-check Atlas) go through the same services as the API and are audited with the session's
 * actor (staff when impersonating or launched as admin).
 */
import { defineRoute, ok, problem } from '@ss/app-kit';
import { dayOf, reportOf } from '../core/analytics.js';
import { analyse } from '../core/indexing.js';
import { candidateTerms, expandTokens, idf, scoreDocuments } from '../core/portable.js';
import { planQuery } from '../core/query.js';
import { rankCandidates, searchResponse } from '../core/results.js';
import { matchableFields, validateDocument } from '../core/schema.js';
import { sessionView } from './session.js';
import { settingsFrom } from './settings.js';

/** @typedef {import('./documents.js').Site} Site */

/** Dashboard roles that may act (demo sessions are read-only). */
export const DASHBOARD_WRITE_ROLES = Object.freeze(['merchant', 'platform_admin', 'impersonate']);
/** Rows per dashboard page. */
export const DASHBOARD_PAGE = 50;

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
 * @param {import('./routes.js').SearchProduct} searchApp
 */
export const createDashboardApi = (searchApp) => {
	const { product, engines, sources, siteOf } = searchApp;
	const t = (/** @type {string} */ key) => searchApp.app.strings.en?.[key] ?? key;

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

	/**
	 * The overlay's view model for the element stub: a query field and a search action, then the results as links.
	 * @param {Site} site
	 * @param {import('../core/results.js').SearchResponse | null} results
	 */
	const overlayView = (site, results) => ({
		title: t('overlay.label'),
		fields: [{ name: 'q', type: 'text', label: t('overlay.input'), required: true }],
		actions: [{ action: 'search', label: t('overlay.submit') }],
		...(results
			? results.items.length > 0
				? {
						items: results.items
							.slice(0, Math.min(50, site.settings.overlay.max_results))
							.map((hit) => ({ text: hit.title || hit.id, ...(hit.url ? { href: hit.url } : {}) })),
					}
				: { body: t('overlay.empty') }
			: {}),
	});

	/** Dashboard session → site (null = pick a website / demo). @param {any} ctx */
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

	return { indexStatus, overlayView, routes };
};

/**
 * @typedef {object} DashboardData
 * @property {boolean} demo
 * @property {boolean} canWrite
 * @property {string | null} websiteId
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
		demo: false,
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

/** Sample documents of the demo dashboard (generic: an article, a guide, a listing, a product). */
const DEMO_DOCUMENTS = Object.freeze([
	{
		id: 'demo-1',
		type: 'item',
		url: '/items/demo-1',
		fields: {
			title: 'Linen shirt',
			brand: 'Acme',
			tags: ['summer', 'shirts'],
			description: 'Breathable linen in five colours.',
		},
		boost: 40,
	},
	{
		id: 'demo-2',
		type: 'item',
		url: '/items/demo-2',
		fields: { title: 'Wool sweater', brand: 'Northwind', tags: ['winter'], description: 'Warm merino wool.' },
		boost: 25,
	},
	{
		id: 'demo-3',
		type: 'page',
		url: '/help/returns',
		fields: {
			title: 'Returns and exchanges',
			description: 'How to return an order within 30 days.',
			body: 'Start a return from your account page.',
		},
		boost: 0,
	},
	{
		id: 'demo-4',
		type: 'page',
		url: '/guides/care',
		fields: { title: 'Caring for linen', description: 'Washing, drying and ironing linen.', headings: ['Washing', 'Ironing'] },
		boost: 5,
	},
	{
		id: 'demo-5',
		type: 'item',
		url: '/items/demo-5',
		fields: { title: 'Linen trousers', brand: 'Acme', tags: ['summer'], description: 'Relaxed fit.' },
		boost: 10,
	},
]);

/**
 * Demo dashboard data: sample documents analysed and searched in memory with the real core (nothing is stored).
 * @param {{ now?: number }} [options]
 * @returns {DashboardData}
 */
export const demoDashboard = ({ now = Date.now() } = {}) => {
	const settings = settingsFrom({ can: () => true, config: () => ({}), domain: 'demo.example.com' });
	const at = new Date(now);
	const docs = DEMO_DOCUMENTS.flatMap((input) => {
		const checked = validateDocument(input, { types: settings.types, maxFieldChars: settings.index.max_field_chars });
		if (!checked.ok) return [];
		const type = /** @type {import('../core/schema.js').TypeDef} */ (settings.types.get(checked.value.type));
		return [
			{
				...checked.value,
				...analyse(checked.value, type, { maxFieldChars: 10_000 }),
				status: 'active',
				source: 'demo',
				updatedAt: at,
			},
		];
	});
	/** @type {Map<string, { term: string, df: number, pdf: number }>} */
	const vocabulary = new Map();
	for (const doc of docs)
		for (const term of doc.terms) {
			const entry = vocabulary.get(term) ?? { term, df: 0, pdf: 0 };
			vocabulary.set(term, { term, df: entry.df + 1, pdf: entry.pdf + (doc.publicTerms.includes(term) ? 1 : 0) });
		}
	const entries = [...vocabulary.values()];
	const rows = [
		{ q: 'linen', searches: 42, zero: 0, clicks: 30, results: 3 },
		{ q: 'returns', searches: 17, zero: 0, clicks: 9, results: 1 },
		{ q: 'gift card', searches: 8, zero: 8, clicks: 0, results: 0 },
	];
	return {
		demo: true,
		canWrite: false,
		websiteId: null,
		settings,
		status: async () => ({
			engine: { configured: 'auto', active: 'portable', atlas: { state: 'unavailable', detail: null, checkedAt: null } },
			documents: {
				total: docs.length,
				limit: settings.index.max_documents,
				byType: Object.fromEntries([...settings.types.keys()].map((key) => [key, docs.filter((d) => d.type === key).length])),
			},
			vocabulary: entries.length,
			quota: { day: dayOf(now, null), used: 0, perDay: settings.index.upserts_per_day },
		}),
		documents: async () => ({
			items: docs.map((doc) => ({
				id: doc.id,
				type: doc.type,
				title: String(doc.fields.title ?? ''),
				url: doc.url,
				source: 'demo',
				updatedAt: at.toISOString(),
			})),
			nextCursor: null,
		}),
		search: async (q) => {
			const plan = planQuery(q, settings.rank, { maxChars: settings.index.max_query_chars });
			const allowed = matchableFields(settings.types, { owner: true });
			const expanded = expandTokens(
				plan,
				{ prefixes: plan.tokens.map(() => entries), typos: plan.tokens.map(() => entries) },
				{ owner: true },
			);
			const wanted = new Set(candidateTerms(expanded));
			const candidates = docs.filter((doc) => doc.terms.some((term) => wanted.has(term)));
			const { scored, relaxed } = scoreDocuments(candidates, expanded, {
				allowed,
				ranking: settings.rank,
				weightOfTerm: (term) => idf(vocabulary.get(term)?.df ?? 0, docs.length),
				mode: plan.mode,
			});
			return searchResponse({
				query: q,
				text: plan.text,
				ranked: rankCandidates(scored, { boostWeight: settings.rank.boostWeight }),
				offset: 0,
				limit: 20,
				maxResults: settings.index.max_results,
				types: settings.types,
				owner: true,
				engine: 'portable',
				relaxed,
				capped: false,
				explain: true,
			});
		},
		sources: async () => ({
			catalog: { enabled: true, type: 'item' },
			api: { enabled: true },
			items: [
				{
					key: 'help',
					kind: 'sitemap',
					url: 'https://demo.example.com/sitemap.xml',
					type: 'page',
					everyHours: 24,
					allowed: true,
					reason: null,
					crawl: {
						status: 'ok',
						total: 2,
						processed: 2,
						indexed: 2,
						failed: 0,
						removed: 0,
						error: null,
						startedAt: at.toISOString(),
						finishedAt: at.toISOString(),
						nextRunAt: null,
					},
				},
			],
		}),
		analytics: async (days) => {
			const report = reportOf(rows, { limit: 50 });
			return {
				from: dayOf(now, null),
				days,
				totals: report.totals,
				daily: [],
				top: report.top,
				zeroResults: report.zeroResults,
			};
		},
	};
};

/**
 * @typedef {{ state: 'signin' } | { state: 'pick_website' | 'not_subscribed', session: any }
 *   | { state: 'ready', session: any, data: DashboardData, portalLink: string | null }} DashboardContext
 */

/**
 * Resolve a dashboard request: session → website → data.
 * @param {{ searchApp: import('./routes.js').SearchProduct, sessionId: string | undefined, website?: string | null, now?: number }} input
 * @returns {Promise<DashboardContext>}
 */
export const resolveDashboard = async ({ searchApp, sessionId, website = null, now = Date.now() }) => {
	const { product, siteOf, app } = searchApp;
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
	if (!result.ok || !product.entitlements.can(result.doc, 'index')) return { state: 'not_subscribed', session };
	const site = await siteOf(websiteId, result.doc);
	return {
		state: 'ready',
		session,
		data: liveDashboard({ searchApp, site, canWrite: DASHBOARD_WRITE_ROLES.includes(session.role) }),
		portalLink: `${app.product.portal.baseUrl}/websites/${encodeURIComponent(websiteId)}/subscriptions/${encodeURIComponent(result.doc.subscriptionId)}`,
	};
};
