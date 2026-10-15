/**
 * The dashboard's Atlas Search check (PLAN 0.8.10 E14): `GET /v1/dashboard/websites/:websiteId/search-index` answers
 * whether the shop or Chat searches with Atlas (the `catalog` settings `search` and `chatSearch`, SF-13), the
 * `searchIndex` and whether the index answered the last time a shop or Chat search used it (`adapters/search-state.js`),
 * so Overview ticks the index in its setup list, or lists it under Needs you while it is missing, while either is
 * `atlas`. Setup only: no business data. `server/routes.js` mounts it next to the dashboard's list routes.
 * @module
 */
import { defineRoute } from '@ss/app-kit';

/** The index Atlas Search uses when the `searchIndex` setting is empty (as `server/catalog-search.js`). */
const DEFAULT_INDEX = 'ss_ecommerce_products_search';

/**
 * What the check answers.
 * @typedef {{ search: 'basic' | 'atlas', index: string, state: { missing: boolean, at: string, message: string } | null }}
 *   SearchIndexAnswer `state` null: no Atlas search has run yet; `at` is when the state last changed (ISO 8601)
 */

/**
 * @param {import('../adapters/product.js').Product} product
 * @returns {import('@ss/app-kit').RouteDefinition[]}
 */
export const createDashboardSearch = (product) => [
	defineRoute({
		method: 'GET',
		path: '/v1/dashboard/websites/:websiteId/search-index',
		auth: 'dashboard',
		/** @returns {Promise<SearchIndexAnswer>} */
		handler: async (ctx) => {
			const websiteId = String(ctx.params.websiteId);
			const [catalog, state] = await Promise.all([
				product.settings.values(websiteId, 'catalog'),
				product.searchState.get(websiteId),
			]);
			return {
				search: catalog.search === 'atlas' || catalog.chatSearch === 'atlas' ? 'atlas' : 'basic',
				index: String(catalog.searchIndex || DEFAULT_INDEX),
				state: state
					? { missing: state.missing === true, at: new Date(state.at).toISOString(), message: String(state.message ?? '') }
					: null,
			};
		},
	}),
];
