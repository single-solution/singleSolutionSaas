/**
 * Listing configuration and queries shared by `grid` and `filters`: both read the same URL parameters, so they stay in
 * step without talking to each other. Local sources are filtered, counted and paged in core; `api` sources ask the
 * Catalog product's public read API (`GET /v1/items`).
 */
import { facetCountsOf, catalogParams, sourceConfig } from '../core/source.js';
import { FACET_KEY, RESERVED, SORTS, applyQuery, facetsOf, parseQuery, toSearch } from '../core/query.js';
import { int, oneOf, str, strings } from '../core/util.js';
import { ok } from './kit.js';
import { createSource } from './source.js';

/**
 * @param {Record<string, unknown>} config
 */
export const listingConfig = (config) => {
	const sorts = /** @type {import('../core/query.js').Sort[]} */ (
		strings(config.sort_options, 5, 20).filter((s) => SORTS.includes(/** @type {any} */ (s)))
	);
	const available = sorts.length > 0 ? sorts : [...SORTS];
	const prefix = str(config.param_prefix, '', 9);
	/** @type {import('../core/query.js').Facet[]} */
	const facets = facetsOf(config.facets);
	for (const key of strings(config.filter_keys, 20, 64))
		if (FACET_KEY.test(key) && !RESERVED.includes(key) && !facets.some((f) => f.key === key))
			facets.push({ key, label: '', type: key === 'in_stock' ? 'toggle' : 'values', multi: true });
	return {
		source: sourceConfig(config),
		size: int(config.page_size, 24, 1, 100),
		sorts: available,
		sort: oneOf(config.default_sort, available, available[0] ?? 'relevance'),
		prefix: /^([a-z][a-z0-9]{0,7}_)?$/.test(prefix) ? prefix : '',
		facets,
	};
};

/** @typedef {ReturnType<typeof listingConfig>} ListingConfig */

/**
 * @param {ListingConfig} listing
 * @param {{ fetch?: typeof fetch }} [deps]
 */
export const createListing = (listing, deps = {}) => {
	const source = createSource(listing.source, deps);
	const { prefix, facets, sorts, sort } = listing;
	return {
		source,
		/** @param {string} search */
		parse: (search) => parseQuery(search, { prefix, facets, sorts, sort }),
		/** @param {import('../core/query.js').Query} query @param {string} [base] */
		search: (query, base = '') => toSearch(query, { prefix, base, sort, facets }),
		/**
		 * One page of results.
		 * @param {import('../core/query.js').Query} query
		 * @param {{ cursor?: string | null, size?: number }} [options]
		 * @returns {Promise<import('./kit.js').Result<{ items: import('../core/items.js').Item[], total: number | null, pages: number | null, facets: import('../core/query.js').FacetCount[], next: string | null }>>}
		 */
		page: async (query, { cursor = null, size = listing.size } = {}) => {
			if (listing.source.kind === 'api') {
				const result = await source.api('/v1/items', catalogParams(query, { size, cursor }));
				if (!result.ok) return result;
				const body = /** @type {Record<string, any>} */ (result.value ?? {});
				const total = Number.isSafeInteger(body.total) ? body.total : null;
				const next = typeof (body.next ?? body.nextCursor) === 'string' ? String(body.next ?? body.nextCursor) : null;
				return ok({
					items: source.itemsOf(body),
					total,
					pages: total === null ? null : Math.max(1, Math.ceil(total / size)),
					facets: facetCountsOf(body.facets),
					next,
				});
			}
			const all = await source.all();
			if (!all.ok) return all;
			const result = applyQuery(all.value, query, { size, facets, locale: listing.source.locale });
			return ok({ ...result, next: null });
		},
	};
};
