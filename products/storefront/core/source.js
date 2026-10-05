/**
 * Where an element's data comes from (pure part): the merchant's public JSON file, data embedded in the page, or a
 * Single Solution product's public read API (Catalog items, Deals' deals page, Site Search). The pack declares the
 * products it reads (`manifest.reads`); the Loader hands each element an API client per product active on the
 * website, bound to its base URL and the website's `pk_` key (F.18) — no key is ever configured.
 */
import { fieldMap } from './items.js';
import { isObject, oneOf, safeUrl, str } from './util.js';

/** Source kinds. `api` is the public read API of a Single Solution product (Catalog, Deals, Search). */
export const SOURCE_KINDS = Object.freeze(/** @type {const} */ (['page', 'json', 'api']));
/** Products the pack reads (`manifest.reads`). */
export const READ_PRODUCTS = Object.freeze(/** @type {const} */ (['catalog', 'search', 'deals']));
/** Default id of the `<script type="application/json">` holding page data. */
export const PAGE_DATA_ID = 'ss-items';

/**
 * @typedef {object} SourceConfig
 * @property {typeof SOURCE_KINDS[number]} kind
 * @property {string | null} url JSON file URL (https or same-site relative; `json` only)
 * @property {typeof READ_PRODUCTS[number]} product the product an `api` source reads
 * @property {string} pageId
 * @property {string | null} currency fallback ISO 4217 code for items without one
 * @property {string} locale BCP 47 tag ('' = the page's language)
 * @property {import('./items.js').FieldMap} fields
 */

/**
 * @param {Record<string, unknown>} config element configuration
 * @param {typeof SOURCE_KINDS[number]} [fallback]
 * @param {typeof READ_PRODUCTS[number]} [product] the product an `api` source reads by default
 * @returns {SourceConfig}
 */
export const sourceConfig = (config, fallback = 'page', product = 'catalog') => {
	const kind = oneOf(config.source, SOURCE_KINDS, fallback);
	const url = safeUrl(config.source_url, { src: true });
	const currency = str(config.currency, '', 3);
	return {
		kind: kind === 'json' && url === null ? 'page' : kind,
		url,
		product: oneOf(config.source_product, READ_PRODUCTS, product),
		pageId: /^[A-Za-z][\w-]{0,63}$/.test(str(config.page_data_id)) ? str(config.page_data_id) : PAGE_DATA_ID,
		currency: /^[A-Z]{3}$/.test(currency) ? currency : null,
		locale: /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(str(config.locale)) ? str(config.locale) : '',
		fields: fieldMap(config.fields),
	};
};

/**
 * A product API URL: `<base><path>?<params>` (empty values dropped).
 * @param {string} base
 * @param {string} path
 * @param {Record<string, string | number | null | undefined>} params
 */
export const apiUrl = (base, path, params) => {
	const query = new URLSearchParams();
	for (const [name, value] of Object.entries(params))
		if (value !== null && value !== undefined && value !== '') query.set(name, String(value));
	const text = query.toString();
	return `${base.replace(/\/+$/, '')}${path}${text ? `?${text}` : ''}`;
};

/**
 * Catalog list parameters for a listing query (Part E §5 reads: `limit`, `sort`, `q`, `filter[key]`, plus `page` for
 * crawlable page links and `cursor` to continue an infinite list).
 * @param {import('./query.js').Query} query
 * @param {{ size: number, cursor?: string | null }} options
 */
export const catalogParams = (query, { size, cursor = null }) => {
	/** @type {Record<string, string | number | null>} */
	const params = {
		limit: size,
		sort: query.sort === 'relevance' ? null : query.sort,
		q: query.q,
		cursor,
		page: cursor ? null : query.page,
	};
	for (const [key, values] of Object.entries(query.filters)) params[`filter[${key}]`] = values.join(',');
	if (query.min !== null) params['filter[price_min]'] = query.min;
	if (query.max !== null) params['filter[price_max]'] = query.max;
	return params;
};

/**
 * Facet counts in a Catalog list response (`facets: [{ key, values: [{ value, count }], range? }]`).
 * @param {unknown} value
 * @returns {import('./query.js').FacetCount[]}
 */
export const facetCountsOf = (value) =>
	(Array.isArray(value) ? value : [])
		.filter(isObject)
		.slice(0, 20)
		.map((facet) => ({
			key: str(facet.key, '', 64),
			values: (Array.isArray(facet.values) ? facet.values : [])
				.filter((v) => isObject(v) && typeof v.value === 'string' && Number.isInteger(v.count))
				.slice(0, 50)
				.map((v) => ({ value: v.value.slice(0, 100), count: v.count })),
			range:
				isObject(facet.range) && Number.isInteger(facet.range.min) && Number.isInteger(facet.range.max)
					? { min: facet.range.min, max: facet.range.max }
					: null,
		}));
