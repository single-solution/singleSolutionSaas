/**
 * Sources service: Catalog item events and scheduled crawls of the website's own public JSON feed or sitemap.
 *
 * Crawls run in steps (the sweep job, or `POST /v1/sources/:key/crawl`): a JSON feed is fetched once per step and up
 * to a step's worth of records is indexed; a sitemap (or sitemap index) is read once per run, then a step fetches the
 * next `sources.pages_per_run` pages. Every fetch goes through app-kit `outbound.fetch` (public https only, DNS
 * answers vetted at connect time, same-origin redirects, deadline and size cap) and only URLs on the website's own
 * domain are fetched. When a run completes, documents of the source that the run did not see are removed.
 */
import { documentFromItem } from '../core/catalog.js';
import { crawledId, crawlSourcesOf, extractPage, hostAllowed, mapRecord, parseSitemap, recordsOf } from '../core/sources.js';

/** @typedef {import('./documents.js').Site} Site */
/** @typedef {import('../core/sources.js').CrawlSource} CrawlSource */

/** Records of a JSON feed indexed per step and page. */
export const RECORDS_PER_PAGE = 25;
/** Stale documents removed per step. */
const STALE_BATCH = 500;
const HOUR_MS = 3_600_000;

/**
 * @param {{ documents: import('./documents.js').DocumentsService, fetch: (url: string, init: Record<string, unknown>) => Promise<{ status: number, headers: Record<string, string>, body: Buffer }>,
 *   now: () => number, newId: (prefix: string) => string, userAgent: string }} deps
 */
export const createSourcesService = ({ documents, fetch, now, newId, userAgent }) => {
	/**
	 * Apply one Catalog item event.
	 * @param {Site} site
	 * @param {string} type event type
	 * @param {unknown} data
	 * @returns {Promise<'indexed' | 'removed' | 'skipped' | 'failed'>}
	 */
	const onItemEvent = async (site, type, data) => {
		const { sources, types } = site.settings;
		if (!site.settings.enabled('sources') || !sources.catalog_events || !types.has(sources.catalog_type)) return 'skipped';
		if (type.startsWith('item.deleted')) {
			const itemId = /** @type {any} */ (data)?.itemId;
			return typeof itemId === 'string' && (await documents.remove(site, itemId)) ? 'removed' : 'skipped';
		}
		const mapped = documentFromItem(data, { type: sources.catalog_type, urlTemplate: sources.catalog_url_template });
		if (!mapped) return 'skipped';
		if (mapped.action === 'remove') return (await documents.remove(site, mapped.id)) ? 'removed' : 'skipped';
		const result = await documents.upsert(site, mapped.document, { source: 'catalog' });
		return result.ok ? 'indexed' : 'failed';
	};

	/** @param {Site} site */
	const configured = (site) =>
		crawlSourcesOf(site.settings.sources.crawl_sources, {
			domain: site.settings.domain,
			max: site.settings.sources.max_crawl_sources,
			types: site.settings.types,
		});

	/**
	 * Fetch a URL of a source (bounded); null with a reason on failure.
	 * @param {Site} site
	 * @param {string} url
	 * @param {string} accept
	 * @returns {Promise<{ ok: true, text: string, contentType: string } | { ok: false, reason: string }>}
	 */
	const get = async (site, url, accept) => {
		if (!hostAllowed(url, site.settings.domain)) return { ok: false, reason: 'url_not_allowed' };
		try {
			const response = await fetch(url, {
				method: 'GET',
				headers: { accept, 'user-agent': userAgent },
				timeoutMs: site.settings.sources.fetch_timeout_seconds * 1000,
				maxBytes: site.settings.sources.max_fetch_kb * 1024,
			});
			if (response.status < 200 || response.status >= 300) return { ok: false, reason: `http_${response.status}` };
			return { ok: true, text: response.body.toString('utf8'), contentType: String(response.headers['content-type'] ?? '') };
		} catch (error) {
			return { ok: false, reason: String(/** @type {any} */ (error)?.code ?? 'fetch_failed') };
		}
	};

	/**
	 * Fields of a crawled page for its document type (title, description, headings, body when the type has them).
	 * @param {ReturnType<typeof extractPage>} page
	 * @param {import('../core/schema.js').TypeDef} type
	 */
	const pageFields = (page, type) => {
		const keys = new Set(type.fields.map((field) => field.key));
		/** @type {Record<string, unknown>} */
		const out = {};
		if (keys.has('title')) out.title = page.title;
		if (keys.has('description')) out.description = page.description;
		if (keys.has('headings')) out.headings = page.headings;
		if (keys.has('body')) out.body = page.body;
		return out;
	};

	/**
	 * Finish a run: remove what the run did not see and schedule the next one.
	 * @param {Site} site
	 * @param {CrawlSource} source
	 * @param {Record<string, any>} state
	 */
	const finish = async (site, source, state) => {
		let removed = 0;
		if ((state.indexed ?? 0) > 0) {
			for (const id of await site.repos.documents.staleOf(`crawl:${source.key}`, state.run, STALE_BATCH)) {
				if (await documents.remove(site, id)) removed += 1;
			}
		}
		const done = {
			status: 'ok',
			run: state.run,
			pending: [],
			offset: state.offset ?? 0,
			total: state.total ?? 0,
			indexed: state.indexed ?? 0,
			failed: state.failed ?? 0,
			removed,
			error: null,
			finishedAt: new Date(now()),
			nextRunAt: new Date(now() + source.everyHours * HOUR_MS),
		};
		await site.repos.crawls.set(source.key, done);
		return done;
	};

	/**
	 * Record a failed run (retried at the next interval).
	 * @param {Site} site
	 * @param {CrawlSource} source
	 * @param {string} reason
	 */
	const fail = async (site, source, reason) => {
		const state = {
			status: 'failed',
			error: reason,
			pending: [],
			offset: 0,
			finishedAt: new Date(now()),
			nextRunAt: new Date(now() + source.everyHours * HOUR_MS),
		};
		await site.repos.crawls.set(source.key, state);
		return state;
	};

	/**
	 * Index one batch of records or pages.
	 * @param {Site} site
	 * @param {Array<Record<string, unknown> | null>} inputs
	 * @param {CrawlSource} source
	 * @param {string} run
	 */
	const indexAll = async (site, inputs, source, run) => {
		let indexed = 0;
		let failed = 0;
		for (const input of inputs) {
			if (!input) continue;
			const result = await documents.upsert(site, input, { source: `crawl:${source.key}`, crawlRun: run });
			if (result.ok) indexed += 1;
			else failed += 1;
			if (!result.ok && result.reason === 'quota_exhausted') break;
		}
		return { indexed, failed };
	};

	/**
	 * One step of a JSON feed run.
	 * @param {Site} site
	 * @param {CrawlSource} source
	 * @param {Record<string, any>} state
	 */
	const stepJson = async (site, source, state) => {
		const fetched = await get(site, source.url, 'application/json');
		if (!fetched.ok) return fail(site, source, fetched.reason);
		/** @type {unknown} */
		let json;
		try {
			json = JSON.parse(fetched.text);
		} catch {
			return fail(site, source, 'json_invalid');
		}
		const type = /** @type {import('../core/schema.js').TypeDef} */ (site.settings.types.get(source.type));
		const records = recordsOf(json, source.recordsPath).slice(0, site.settings.sources.max_pages);
		const size = site.settings.sources.pages_per_run * RECORDS_PER_PAGE;
		const offset = state.offset ?? 0;
		const slice = records.slice(offset, offset + size);
		const keys = type.fields.map((field) => field.key);
		const mapped = slice.map((record) => mapRecord(record, source, keys));
		const { indexed, failed } = await indexAll(site, mapped, source, state.run);
		const next = {
			...state,
			total: records.length,
			offset: offset + slice.length,
			indexed: (state.indexed ?? 0) + indexed,
			failed: (state.failed ?? 0) + failed + mapped.filter((input) => input === null).length,
		};
		if (next.offset >= records.length) return finish(site, source, next);
		await site.repos.crawls.set(source.key, next);
		return next;
	};

	/**
	 * The page URLs of a sitemap run (a sitemap index is followed one level).
	 * @param {Site} site
	 * @param {CrawlSource} source
	 * @returns {Promise<{ ok: true, urls: string[] } | { ok: false, reason: string }>}
	 */
	const sitemapUrls = async (site, source) => {
		const max = site.settings.sources.max_pages;
		const first = await get(site, source.url, 'application/xml, text/xml');
		if (!first.ok) return first;
		const parsed = parseSitemap(first.text, { max });
		const urls = [...parsed.urls];
		for (const child of parsed.sitemaps) {
			if (urls.length >= max) break;
			const fetched = await get(site, child, 'application/xml, text/xml');
			if (fetched.ok) urls.push(...parseSitemap(fetched.text, { max: max - urls.length }).urls);
		}
		return { ok: true, urls: [...new Set(urls.filter((url) => hostAllowed(url, site.settings.domain)))].slice(0, max) };
	};

	/**
	 * One step of a sitemap run.
	 * @param {Site} site
	 * @param {CrawlSource} source
	 * @param {Record<string, any>} state
	 */
	const stepSitemap = async (site, source, state) => {
		/** @type {Record<string, any>} */
		let current = state;
		if (!Array.isArray(current.pending) || current.pending.length === 0) {
			const found = await sitemapUrls(site, source);
			if (!found.ok) return fail(site, source, found.reason);
			current = { ...current, pending: found.urls, total: found.urls.length, offset: 0 };
			if (found.urls.length === 0) return finish(site, source, current);
		}
		const type = /** @type {import('../core/schema.js').TypeDef} */ (site.settings.types.get(source.type));
		const offset = current.offset ?? 0;
		const batch = current.pending.slice(offset, offset + site.settings.sources.pages_per_run);
		/** @type {Array<Record<string, unknown> | null>} */
		const inputs = [];
		let failed = 0;
		for (const url of batch) {
			const page = await get(site, url, 'text/html');
			if (!page.ok || !/html/i.test(page.contentType)) {
				failed += 1;
				continue;
			}
			const extracted = extractPage(page.text);
			const id = crawledId(source.key, url);
			if (extracted.noindex) {
				await documents.remove(site, id);
				continue;
			}
			inputs.push({ id, type: source.type, url, image: extracted.image, fields: pageFields(extracted, type) });
		}
		const result = await indexAll(site, inputs, source, current.run);
		/** @type {Record<string, any>} */
		const next = {
			...current,
			offset: offset + batch.length,
			indexed: (current.indexed ?? 0) + result.indexed,
			failed: (current.failed ?? 0) + failed + result.failed,
		};
		if (next.offset >= next.pending.length) return finish(site, source, next);
		await site.repos.crawls.set(source.key, next);
		return next;
	};

	/**
	 * Run one step of a source (a new run when the last one finished).
	 * @param {Site} site
	 * @param {CrawlSource} source
	 * @param {{ restart?: boolean }} [options]
	 */
	const step = async (site, source, { restart = false } = {}) => {
		const saved = (await site.repos.crawls.get(source.key)) ?? {};
		const running = saved.status === 'running' && !restart;
		const state = running
			? saved
			: {
					status: 'running',
					run: newId('run'),
					startedAt: new Date(now()),
					pending: [],
					offset: 0,
					total: 0,
					indexed: 0,
					failed: 0,
					error: null,
				};
		if (!running) await site.repos.crawls.set(source.key, { ...state, pending: [] });
		return source.kind === 'json' ? stepJson(site, source, state) : stepSitemap(site, source, state);
	};

	/**
	 * Sources due now: running ones, then ones whose next run time passed (or that never ran).
	 * @param {Site} site
	 */
	const due = async (site) => {
		const { sources } = configured(site);
		const states = new Map((await site.repos.crawls.list()).map((/** @type {any} */ s) => [s.key, s]));
		return sources.filter((source) => {
			const state = states.get(source.key);
			if (!state) return true;
			if (state.status === 'running') return true;
			return !(state.nextRunAt instanceof Date) || state.nextRunAt.getTime() <= now();
		});
	};

	/**
	 * The scheduled work of a website: one step per due source.
	 * @param {Site} site
	 */
	const runDue = async (site) => {
		if (!site.settings.enabled('sources')) return { crawled: 0 };
		let crawled = 0;
		for (const source of await due(site)) {
			await step(site, source);
			crawled += 1;
		}
		return { crawled };
	};

	/**
	 * Sources as the API and the dashboard show them (configuration and crawl state; never fetched content).
	 * @param {Site} site
	 */
	const list = async (site) => {
		const { sources, refused } = configured(site);
		const states = new Map((await site.repos.crawls.list()).map((/** @type {any} */ s) => [s.key, s]));
		/** @param {any} state */
		const view = (state) =>
			state
				? {
						status: state.status ?? null,
						total: state.total ?? 0,
						processed: state.offset ?? 0,
						indexed: state.indexed ?? 0,
						failed: state.failed ?? 0,
						removed: state.removed ?? 0,
						error: state.error ?? null,
						startedAt: state.startedAt instanceof Date ? state.startedAt.toISOString() : null,
						finishedAt: state.finishedAt instanceof Date ? state.finishedAt.toISOString() : null,
						nextRunAt: state.nextRunAt instanceof Date ? state.nextRunAt.toISOString() : null,
					}
				: null;
		return {
			catalog: { enabled: site.settings.sources.catalog_events, type: site.settings.sources.catalog_type },
			api: { enabled: site.settings.sources.api_upserts },
			items: [
				...sources.map((source) => ({
					key: source.key,
					kind: source.kind,
					url: source.url,
					type: source.type,
					everyHours: source.everyHours,
					allowed: true,
					reason: null,
					crawl: view(states.get(source.key)),
				})),
				...refused.map((entry) => ({
					key: entry.key,
					allowed: false,
					reason: entry.reason,
					crawl: view(states.get(entry.key)),
				})),
			],
		};
	};

	/**
	 * Start a new run of a source now and run its first step.
	 * @param {Site} site
	 * @param {string} key
	 */
	const crawlNow = async (site, key) => {
		const { sources, refused } = configured(site);
		const source = sources.find((s) => s.key === key);
		if (!source) {
			const reason = refused.find((entry) => entry.key === key)?.reason;
			return reason
				? { ok: /** @type {const} */ (false), reason: 'source_not_allowed', detail: reason }
				: { ok: /** @type {const} */ (false), reason: 'source_unknown', detail: 'No crawled source has this key.' };
		}
		await step(site, source, { restart: true });
		return { ok: /** @type {const} */ (true), value: (await list(site)).items.find((item) => item.key === key) };
	};

	return { onItemEvent, runDue, list, crawlNow, step };
};

/** @typedef {ReturnType<typeof createSourcesService>} SourcesService */
