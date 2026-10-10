/**
 * Atlas Search (PLAN 0.8.10 E14): with the `catalog` setting `search` at `atlas`, shop and Chat searches start with a
 * `$search` stage on the merchant's own index — fuzzy autocomplete on the product name (at most one edit), text on the
 * tags and summary, and the brands and categories whose names match the words — filtered on the website (the tenant
 * guard requires an `equals` on `websiteId`, K11) and on active products, ranked by score; the listing's other filters
 * follow. When the stage fails (no Atlas, no index), the basic search answers instead. No I/O.
 * @module
 */

/** The index the docs ask the merchant to create on `ss_ecommerce_products` (Atlas Search, JSON editor). */
export const SEARCH_INDEX_DEFINITION = Object.freeze({
	mappings: {
		dynamic: false,
		fields: {
			websiteId: { type: 'token' },
			status: { type: 'token' },
			name: [
				{ type: 'autocomplete', tokenization: 'edgeGram', minGrams: 2, maxGrams: 15, foldDiacritics: true },
				{ type: 'string' },
			],
			summary: { type: 'string' },
			tags: { type: 'string' },
			brandId: { type: 'token' },
			categoryIds: { type: 'token' },
		},
	},
});

/** Longest search text sent to the index. */
const MAX_QUERY = 200;

/**
 * Brands or categories whose name contains every word of the search (case-insensitive), so their products rank.
 * @param {string} q
 * @param {ReadonlyArray<{ id: string, name: string }>} records
 * @returns {string[]}
 */
export const namesMatching = (q, records) => {
	const words = q.toLocaleLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return [];
	return records
		.filter((record) => {
			const name = record.name.toLocaleLowerCase();
			return words.every((word) => name.includes(word));
		})
		.map((record) => record.id)
		.slice(0, 50);
};

/**
 * The `$search` stage of a shop or Chat search.
 * @param {string} q the shopper's words
 * @param {{ index: string, websiteId: string, brandIds: string[], categoryIds: string[] }} context brands and categories
 *   whose names match the words
 */
export const searchStage = (q, { index, websiteId, brandIds, categoryIds }) => {
	const query = q.trim().slice(0, MAX_QUERY);
	/** @type {Record<string, unknown>[]} */
	const should = [
		{ autocomplete: { query, path: 'name', fuzzy: { maxEdits: 1 }, score: { boost: { value: 3 } } } },
		{ text: { query, path: ['name', 'tags', 'summary'], fuzzy: { maxEdits: 1 } } },
	];
	if (brandIds.length > 0) should.push({ in: { path: 'brandId', value: brandIds, score: { boost: { value: 2 } } } });
	if (categoryIds.length > 0) should.push({ in: { path: 'categoryIds', value: categoryIds } });
	return {
		$search: {
			index,
			compound: {
				filter: [{ equals: { path: 'websiteId', value: websiteId } }, { equals: { path: 'status', value: 'active' } }],
				should,
				minimumShouldMatch: 1,
			},
		},
	};
};
