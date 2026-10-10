/**
 * Atlas Search for the shop and Chat (PLAN 0.8.10 E14): with the `catalog` setting `search` at `atlas`, a search runs
 * `$search` on the merchant's own index first (filtered on the website and active products, K11), then the listing's
 * other filters, ranked by score unless a sort is asked for. When the stage fails (the database is not Atlas or the
 * index is missing) the caller answers with the basic search, and the website's search state says the index is
 * missing until a search works again (Overview shows it).
 * @module
 */
import { brandsOf, categoriesOf } from '../adapters/catalog-store.js';
import { sortDocument } from '../core/catalog-query.js';
import { COLLECTIONS } from '../core/model.js';
import { namesMatching, searchStage } from '../core/search.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/catalog-query.js').Sort} Sort */

/**
 * @param {Product} product
 */
export const createCatalogSearch = (product) => {
	/**
	 * Whether searches of this website go to Atlas Search.
	 * @param {Site} s
	 * @param {string} q
	 */
	const useAtlas = async (s, q) => q.trim() !== '' && (await s.values('catalog')).search === 'atlas';

	/**
	 * Run a search on Atlas: the matching products of one page (and, when asked, their total and facets in the same
	 * pipeline). `{ ok: false }` when the stage failed.
	 * @param {Site} s
	 * @param {WebsiteData} data
	 * @param {string} q
	 * @param {{ match: Record<string, unknown>, sort: Sort | null, skip: number, limit: number, count?: boolean,
	 *   facets?: Record<string, unknown[]> | null, project?: Record<string, 0 | 1> }} options
	 * @returns {Promise<{ ok: true, items: any[], total: number | null, facets: any } | { ok: false }>}
	 */
	const run = async (s, data, q, { match, sort, skip, limit, count = false, facets = null, project = { _id: 0 } }) => {
		const { searchIndex } = await s.values('catalog');
		const [brands, categories] = await Promise.all([brandsOf(data), categoriesOf(data)]);
		const stage = searchStage(q, {
			index: String(searchIndex || 'ss_ecommerce_products_search'),
			websiteId: data.websiteId,
			brandIds: namesMatching(q, brands),
			categoryIds: namesMatching(q, categories),
		});
		const order = sort ? sortDocument(sort) : { score: -1, id: 1 };
		// an inclusive projection leaves the score out by itself; an exclusive one must name it
		const inclusive = Object.entries(project).some(([key, value]) => key !== '_id' && value === 1);
		const pipeline = [
			stage,
			{ $match: match },
			{ $addFields: { score: { $meta: 'searchScore' } } },
			{
				$facet: {
					items: [
						{ $sort: order },
						{ $skip: skip },
						{ $limit: limit },
						{ $project: inclusive ? project : { ...project, score: 0 } },
					],
					...(count ? { total: [{ $count: 'n' }] } : {}),
					...(facets ?? {}),
				},
			},
		];
		try {
			const [raw] = await data.collection(COLLECTIONS.products).aggregate(pipeline).toArray();
			await product.searchState.set(s.websiteId, false);
			return {
				ok: true,
				items: raw?.items ?? [],
				total: count ? Number(raw?.total?.[0]?.n ?? 0) : null,
				facets: raw ?? null,
			};
		} catch (error) {
			const code = /** @type {any} */ (error)?.codeName ?? /** @type {any} */ (error)?.code ?? 'error';
			await product.searchState.set(s.websiteId, true, String(code).slice(0, 80));
			s.ctx.log?.warn?.('atlas search failed', { code: String(code) });
			return { ok: false };
		}
	};

	return Object.freeze({ useAtlas, run });
};

/** @typedef {ReturnType<typeof createCatalogSearch>} CatalogSearch */
