/**
 * Route table: app-kit's standard resources (entitlement, config, events, strings, health, data export/anonymise,
 * the .well-known endpoints, /sso and — in development — the certification probes) plus the Site Search Mode C API,
 * the overlay's element-stub views and the dashboard API (SSO sessions).
 *
 * Keys: `pk_` keys (browsers, domain-locked) search, get suggestions and count clicks — rate limited per website
 * (`index.search_rate_per_minute`), with public cache headers, and private fields are never matched or returned.
 * `sk_` keys (the merchant's server) also read and write documents, run crawls and read analytics
 * (`index.api_rate_per_minute`). Every route is gated by its element (403 element_disabled in every mode); POSTs that
 * create or move state require an Idempotency-Key. Every search is metered (unit `query`).
 */
import { defineRoute, ok, created, noContent, paginate, problem, standardRoutes } from '@ss/app-kit';
import { ID } from '../core/schema.js';
import { repositoriesFor } from '../adapters/db.js';
import { createDashboardApi } from './dashboard.js';
import { createDocumentsService, MAX_BATCH } from './documents.js';
import { createEngines } from './engine.js';
import { createSearchService } from './search.js';
import { sessionView } from './session.js';
import { settingsForDoc } from './settings.js';
import { createSourcesService } from './sources.js';

/** @typedef {import('../adapters/platform.js').SearchApp} SearchApp */
/** @typedef {import('./documents.js').Site} Site */

/**
 * Field problems → RFC 9457 `validation_failed`.
 * @param {Array<{ path: string, code: string }>} errors
 */
export const invalidProblem = (errors) =>
	problem('validation_failed', 'The request is not valid.', {
		errors: errors.map((e) => ({ path: e.path, code: e.code, message: e.code.replace(/_/g, ' ') })),
	});

/**
 * Map a service failure to a problem.
 * @param {import('./documents.js').Failure} result
 */
export const failure = (result) => {
	if (result.reason === 'validation_failed' && result.errors) return invalidProblem(result.errors);
	return problem(result.reason, result.detail ?? result.reason.replace(/_/g, ' '));
};

/**
 * The application (services + site resolution) shared by the routes, the event consumers, the job and the dashboard.
 * @param {SearchApp} app
 * @param {{ atlasRunner?: any, atlasProbe?: any }} [options] test doubles for the Atlas driver calls
 */
export const createSearchApp = (app, options = {}) => {
	const { product } = app;
	const repoFor = repositoriesFor(product, { now: app.now });
	const log = product.context?.logger ?? null;
	const engines = createEngines({ now: app.now, log, ...options });
	const documents = createDocumentsService({ now: app.now, newId: app.newId });
	const search = createSearchService({
		engines,
		now: app.now,
		log,
		record: (websiteId, quantity) => {
			void Promise.resolve(
				product.usage.record({ websiteId, unit: 'query', quantity, idempotencyKey: `query:${app.newId('qry')}` }),
			).catch(() => undefined);
		},
	});
	const sources = createSourcesService({
		documents,
		fetch: (url, init) => product.outbound.fetch(url, init),
		now: app.now,
		newId: app.newId,
		userAgent: `SingleSolution-SiteSearch/${product.manifest.product.version}`,
	});
	/**
	 * @param {string} websiteId
	 * @param {any} doc
	 * @returns {Promise<Site>}
	 */
	const siteOf = async (websiteId, doc) => {
		await app.registry.remember(websiteId);
		return {
			websiteId,
			settings: settingsForDoc(product, doc),
			repos: await repoFor(websiteId, { merchantId: doc.merchantId, env: doc.env }),
		};
	};
	/**
	 * Site of a website from its entitlement (null without an active subscription or with the index off).
	 * @param {string} websiteId
	 * @returns {Promise<Site | null>}
	 */
	const siteFor = async (websiteId) => {
		const result = await product.entitlements.forWebsite(websiteId);
		if (!result.ok || !product.entitlements.can(result.doc, 'index')) return null;
		return siteOf(websiteId, result.doc);
	};
	/**
	 * Scheduled work of one website: crawl steps, the Atlas index state, vocabulary cleanup.
	 * @param {Site} site
	 * @param {{ deadline?: number }} [options] no crawl step is started after `deadline` (epoch ms)
	 */
	const sweepSite = async (site, { deadline } = {}) => {
		const crawled = await sources.runDue(site, deadline === undefined ? {} : { deadline });
		const atlas = site.settings.index.engine === 'portable' ? null : await engines.atlasStatus(site, { refresh: true });
		const cleaned = await site.repos.vocabulary.cleanup();
		return { ...crawled, atlas: atlas?.state ?? 'disabled', termsRemoved: cleaned };
	};
	return { app, product, engines, documents, search, sources, siteOf, siteFor, sweepSite };
};

/** @typedef {ReturnType<typeof createSearchApp>} SearchProduct */

/**
 * @param {SearchProduct} searchApp
 */
export const buildRoutes = (searchApp) => {
	const { product, documents, search, sources, siteOf } = searchApp;
	/** @param {any} ctx */
	const isServer = (ctx) => ctx.website?.kind === 'sk';
	const dashboard = createDashboardApi(searchApp);

	/** Rate limits: browsers share one window per website; servers another. */
	const rateLimit = {
		windowMs: 60_000,
		bucket: 'search',
		key: (/** @type {any} */ ctx) => `w:${ctx.websiteId}:${ctx.website?.kind ?? 'x'}`,
		limit: (/** @type {any} */ ctx) => {
			const config = product.entitlements.config(ctx.entitlement?.doc, 'index') ?? {};
			const pick = (/** @type {string} */ name, /** @type {number} */ fallback) =>
				Number.isSafeInteger(config[name]) ? config[name] : fallback;
			return isServer(ctx) ? pick('api_rate_per_minute', 600) : pick('search_rate_per_minute', 600);
		},
	};

	/**
	 * A website-key route gated by its element.
	 * @param {{ method: 'GET' | 'POST' | 'DELETE', path: string, element: string, skOnly?: boolean,
	 *   idempotent?: boolean | 'optional', maxBodyBytes?: number, handler: (ctx: any, site: Site) => Promise<any> }} spec
	 */
	const route = ({ method, path, element, skOnly = false, idempotent, maxBodyBytes, handler }) =>
		defineRoute({
			method,
			path,
			auth: 'website',
			element,
			...(skOnly ? { keyKind: /** @type {const} */ ('sk') } : {}),
			...(idempotent === undefined ? {} : { idempotent }),
			...(maxBodyBytes ? { maxBodyBytes } : {}),
			rateLimit,
			handler: async (ctx) => handler(ctx, await siteOf(ctx.websiteId, ctx.entitlement.doc)),
		});

	/** @param {any} ctx @param {Site} s @returns {Record<string, string>} */
	const cacheFor = (ctx, s) =>
		isServer(ctx) || s.settings.index.cache_seconds === 0
			? { 'cache-control': 'no-store' }
			: { 'cache-control': `public, max-age=${s.settings.index.cache_seconds}`, vary: 'origin, authorization' };

	/** Document writes need the `sources` element and `sources.api_upserts`. @param {Site} s */
	const writesRefused = (s) =>
		!s.settings.enabled('sources')
			? problem('element_disabled', "Document writes need the 'sources' element.")
			: !s.settings.sources.api_upserts
				? problem('writes_disabled', 'Document writes with sk_ keys are turned off (sources.api_upserts).')
				: null;

	/**
	 * Run a search and shape the reply.
	 * @param {any} ctx
	 * @param {Site} s
	 * @param {{ explain?: boolean }} [options]
	 */
	const runSearch = async (ctx, s, { explain = false } = {}) => {
		const result = await search.search(s, { ...ctx.query, explain }, { owner: isServer(ctx) });
		if (!result.ok) return failure(result);
		void result.counted.catch(() => undefined);
		return ok(result.value, { headers: explain ? { 'cache-control': 'no-store' } : cacheFor(ctx, s) });
	};

	return [
		...standardRoutes(product),
		defineRoute({ method: 'GET', path: '/v1/session', auth: 'launch', handler: (ctx) => ok(sessionView(ctx.session)) }),

		// ── index ───────────────────────────────────────────────────────────────────────────────────────────────
		route({ method: 'GET', path: '/v1/search', element: 'index', handler: (ctx, s) => runSearch(ctx, s) }),
		route({
			method: 'GET',
			path: '/v1/documents',
			element: 'index',
			skOnly: true,
			handler: async (ctx, s) => {
				const type = typeof ctx.query.type === 'string' && s.settings.types.has(ctx.query.type) ? ctx.query.type : null;
				const source = typeof ctx.query.source === 'string' && ctx.query.source.length <= 80 ? ctx.query.source : null;
				const page = paginate(
					{ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url },
					{ defaultLimit: 20, maxLimit: 100 },
				);
				const after = Array.isArray(page.after) ? String(page.after[0]) : typeof page.after === 'string' ? page.after : null;
				const items = await documents.list(s, { after, fetchLimit: page.fetchLimit, type, source });
				return page.respond(items, (item) => [item.id]);
			},
		}),
		route({
			method: 'POST',
			path: '/v1/documents',
			element: 'index',
			skOnly: true,
			handler: async (ctx, s) => {
				const refused = writesRefused(s);
				if (refused) return refused;
				const result = await documents.upsert(s, ctx.body, { source: 'api', generateId: true });
				if (!result.ok) return failure(result);
				const body = { ...result.document, ...(result.ignored.length > 0 ? { ignoredFields: result.ignored } : {}) };
				return result.created
					? created(body, { location: `/v1/documents/${encodeURIComponent(result.document.id)}` })
					: ok(body);
			},
		}),
		route({
			method: 'POST',
			path: '/v1/documents:batch',
			element: 'index',
			skOnly: true,
			maxBodyBytes: 8_000_000,
			handler: async (ctx, s) => {
				const refused = writesRefused(s);
				if (refused) return refused;
				const list = ctx.body?.documents;
				if (!Array.isArray(list) || list.length === 0 || list.length > MAX_BATCH)
					return invalidProblem([{ path: '/documents', code: `between_1_and_${MAX_BATCH}` }]);
				return ok({ results: await documents.batch(s, list, { source: 'api' }) });
			},
		}),
		route({
			method: 'GET',
			path: '/v1/documents/:id',
			element: 'index',
			skOnly: true,
			handler: async (ctx, s) => {
				if (!ID.test(ctx.params.id)) return problem('not_found', 'No such document.');
				const doc = await documents.get(s, ctx.params.id);
				return doc ? ok(doc, { headers: { 'cache-control': 'no-store' } }) : problem('not_found', 'No such document.');
			},
		}),
		route({
			method: 'DELETE',
			path: '/v1/documents/:id',
			element: 'index',
			skOnly: true,
			handler: async (ctx, s) => {
				const refused = writesRefused(s);
				if (refused) return refused;
				if (!ID.test(ctx.params.id) || !(await documents.remove(s, ctx.params.id)))
					return problem('not_found', 'No such document.');
				return noContent();
			},
		}),
		route({
			method: 'GET',
			path: '/v1/index-status',
			element: 'index',
			skOnly: true,
			handler: async (ctx, s) =>
				ok(await dashboard.indexStatus(s, { refresh: ctx.query.refresh === 'true' }), {
					headers: { 'cache-control': 'no-store' },
				}),
		}),

		// ── sources ─────────────────────────────────────────────────────────────────────────────────────────────
		route({
			method: 'GET',
			path: '/v1/sources',
			element: 'sources',
			skOnly: true,
			handler: async (_ctx, s) => ok(await sources.list(s), { headers: { 'cache-control': 'no-store' } }),
		}),
		route({
			method: 'POST',
			path: '/v1/sources/:key/crawl',
			element: 'sources',
			skOnly: true,
			handler: async (ctx, s) => {
				const result = await sources.crawlNow(s, ctx.params.key);
				return result.ok ? ok(result.value) : problem(result.reason, result.detail);
			},
		}),

		// ── ranking ─────────────────────────────────────────────────────────────────────────────────────────────
		route({
			method: 'GET',
			path: '/v1/ranking',
			element: 'ranking',
			skOnly: true,
			handler: async (_ctx, s) =>
				ok(
					{
						fieldBoosts: [...s.settings.rank.weights].map(([field, weight]) => ({ field, weight })),
						synonyms: s.settings.ranking.synonyms,
						typoTolerance: s.settings.rank.typo,
						typoMinLength: s.settings.rank.typoMin,
						typoTwoEditsLength: s.settings.rank.typoTwo,
						maxEdits: s.settings.rank.maxEdits,
						prefixMatching: s.settings.rank.prefix,
						matchMode: s.settings.rank.mode,
						stopwords: [...s.settings.rank.stopwords],
						documentBoostWeight: s.settings.rank.boostWeight,
						pinned: s.settings.ranking.pinned,
					},
					{ headers: { 'cache-control': 'no-store' } },
				),
		}),
		route({
			method: 'GET',
			path: '/v1/ranking:explain',
			element: 'ranking',
			skOnly: true,
			handler: (ctx, s) => runSearch(ctx, s, { explain: true }),
		}),

		// ── suggestions ─────────────────────────────────────────────────────────────────────────────────────────
		route({
			method: 'GET',
			path: '/v1/suggestions',
			element: 'suggestions',
			handler: async (ctx, s) => {
				const result = await search.suggest(s, ctx.query, { owner: isServer(ctx) });
				return result.ok ? ok(result.value, { headers: cacheFor(ctx, s) }) : failure(result);
			},
		}),

		// ── analytics ───────────────────────────────────────────────────────────────────────────────────────────
		route({
			method: 'GET',
			path: '/v1/search-analytics',
			element: 'analytics',
			skOnly: true,
			handler: async (ctx, s) => {
				const result = await search.report(s, ctx.query);
				return result.ok ? ok(result.value, { headers: { 'cache-control': 'no-store' } }) : failure(result);
			},
		}),
		route({
			method: 'POST',
			path: '/v1/search-clicks',
			element: 'analytics',
			idempotent: 'optional',
			handler: async (ctx, s) => {
				const result = await search.click(s, ctx.body);
				return result.ok ? ok(result.value) : failure(result);
			},
		}),

		// ── overlay (the Loader's element stub, Mode A without a UI bundle) ──────────────────────────────────────
		route({
			method: 'GET',
			path: '/v1/elements/overlay/view',
			element: 'overlay',
			handler: async (_ctx, s) => ok(dashboard.overlayView(s, null), { headers: { 'cache-control': 'no-store' } }),
		}),
		route({
			method: 'POST',
			path: '/v1/elements/overlay/actions/search',
			element: 'overlay',
			idempotent: 'optional',
			handler: async (ctx, s) => {
				const q = ctx.body?.fields?.q ?? ctx.body?.q;
				const result = await search.search(
					s,
					{
						q: typeof q === 'string' ? q : '',
						limit: String(Math.min(s.settings.overlay.max_results, s.settings.index.max_page_size)),
					},
					{ owner: false },
				);
				if (!result.ok) return failure(result);
				void result.counted.catch(() => undefined);
				return ok(dashboard.overlayView(s, result.value), { headers: { 'cache-control': 'no-store' } });
			},
		}),

		// ── dashboard (SSO session) ─────────────────────────────────────────────────────────────────────────────
		...dashboard.routes(),
	];
};

/**
 * Register the event consumers (app-kit dedupes deliveries on the event id): Catalog item events keep the index in
 * step. Handlers never throw for bad data.
 * @param {SearchProduct} searchApp
 */
export const wireEvents = (searchApp) => {
	for (const type of ['item.created@1', 'item.updated@1', 'item.deleted@1'])
		searchApp.product.events.on(type, async (/** @type {any} */ event) => {
			if (typeof event?.websiteId !== 'string') return;
			const site = await searchApp.siteFor(event.websiteId);
			if (site) await searchApp.sources.onItemEvent(site, type, event.data ?? {});
		});
	return searchApp;
};
