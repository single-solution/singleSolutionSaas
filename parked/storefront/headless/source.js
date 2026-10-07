/**
 * Data access of the storefront elements: page data handed over by the renderer (or a developer), a merchant's
 * public JSON file (fetched once per page view and kept in memory), or a product's public read API through the
 * element API client the Loader passes for it (`clients[<product>]`, F.18; a developer building their own UI passes
 * an `@ss/web` `createElementApi` client). Requests send no cookies, time out, and refuse bodies over 2 MB.
 */
import { MAX_ITEMS, fromCatalog, toItems } from '../core/items.js';
import { fail, ok } from './kit.js';

/** Largest response accepted. */
export const MAX_BYTES = 2 * 1024 * 1024;

/**
 * GET a JSON document.
 * @param {typeof fetch} fetcher
 * @param {string} url
 * @param {{ key?: string | null, timeoutMs?: number }} [options]
 * @returns {Promise<import('./kit.js').Result<unknown>>}
 */
export const getJson = async (fetcher, url, { key = null, timeoutMs = 8000 } = {}) => {
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), timeoutMs);
	try {
		const response = await fetcher(url, {
			headers: { accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
			credentials: 'omit',
			signal: abort.signal,
		});
		if (!response.ok) return { ok: false, problem: { code: 'source_failed', status: response.status } };
		if (Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) return fail('source_too_large');
		const text = await response.text();
		if (text.length > MAX_BYTES) return fail('source_too_large');
		return ok(JSON.parse(text));
	} catch (error) {
		return fail(error instanceof SyntaxError ? 'source_invalid' : 'source_unreachable');
	} finally {
		clearTimeout(timer);
	}
};

/**
 * @typedef {{ get: (path: string, options?: { query?: Record<string, string | number | boolean | undefined> }) =>
 *   Promise<{ ok: true, value: unknown } | { ok: false, error: { code: string, status?: number } }> }} ReadClient
 */

/**
 * @param {import('../core/source.js').SourceConfig} source
 * @param {{ fetch?: typeof fetch, max?: number, clients?: Readonly<Record<string, ReadClient>> }} [options]
 */
export const createSource = (
	source,
	{ fetch: fetcher = (...args) => globalThis.fetch(...args), max = MAX_ITEMS, clients = {} } = {},
) => {
	/** @type {import('../core/items.js').Item[] | null} */
	let provided = null;
	/** @type {Promise<import('./kit.js').Result<import('../core/items.js').Item[]>> | null} */
	let loaded = null;
	/** @param {unknown} json */
	const itemsOf = (json) =>
		toItems(source.kind === 'api' && source.product !== 'deals' ? fromCatalog(json) : json, source.fields, max).map((item) =>
			item.currency || !source.currency ? item : { ...item, currency: source.currency },
		);
	return {
		source,
		/** Page data (or data a developer already has). @param {unknown} json */
		provide: (json) => {
			provided = itemsOf(json);
		},
		/** Every item of a local source (page data or the JSON file). */
		all: async () => {
			if (provided) return ok(provided);
			if (source.kind !== 'json' || source.url === null) return ok([]);
			const url = source.url;
			loaded ??= getJson(fetcher, url).then((result) => (result.ok ? ok(itemsOf(result.value)) : result));
			const result = await loaded;
			if (!result.ok) loaded = null;
			return result;
		},
		/**
		 * A product API call (`api` sources) through the Loader's client for the source's product.
		 * @param {string} path
		 * @param {Record<string, string | number | null | undefined>} params
		 * @returns {Promise<import('./kit.js').Result<unknown>>}
		 */
		api: async (path, params) => {
			const client = Object.hasOwn(clients, source.product) ? clients[source.product] : undefined;
			if (!client) return fail('source_unavailable', `no ${source.product} client`);
			/** @type {Record<string, string | number>} */
			const query = {};
			for (const [name, value] of Object.entries(params))
				if (value !== null && value !== undefined && value !== '') query[name] = value;
			try {
				const result = await client.get(path, { query });
				return result.ok
					? ok(result.value)
					: {
							ok: false,
							problem: { code: 'source_failed', ...(result.error.status ? { status: result.error.status } : {}) },
						};
			} catch {
				return fail('source_unreachable');
			}
		},
		itemsOf,
	};
};

/** @typedef {ReturnType<typeof createSource>} Source */
