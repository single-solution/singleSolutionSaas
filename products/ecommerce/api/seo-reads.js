/**
 * Catalog reads shared by the SEO, feeds, llms.txt and Chat lookup routes: an active product or a category by id or
 * slug, brands and categories by id, a category's trail from the home page, and streaming a long text answer
 * (sitemaps and feeds) so its size never matters. Every query pins `websiteId`.
 * @module
 */
import { problem } from '@ss/app-kit';
import { COLLECTIONS } from '../core/model.js';

/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/model.js').ProductRecord} ProductRecord */
/** @typedef {import('../core/model.js').CategoryRecord} CategoryRecord */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./catalog-media.js').Media} Media */

/** At most this many categories are read at once (trees, product types). */
const MAX_CATEGORIES = 5000;

/**
 * An id or slug from the path, or '' when it cannot be one.
 * @param {unknown} ref
 */
const refOf = (ref) => (typeof ref === 'string' && ref.length > 0 && ref.length <= 200 ? ref : '');

/**
 * An active product by id or slug, or 404 `not_found`.
 * @param {WebsiteData} data
 * @param {unknown} ref
 * @returns {Promise<ProductRecord>}
 */
export const activeProduct = async (data, ref) => {
	const key = refOf(ref);
	const found = key
		? /** @type {ProductRecord | null} */ (
				await data
					.collection(COLLECTIONS.products)
					.findOne(
						{ websiteId: data.websiteId, status: 'active', $or: [{ id: key }, { slug: key }] },
						{ projection: { _id: 0 } },
					)
			)
		: null;
	if (!found) throw problem('not_found', 'There is no such product.');
	return found;
};

/**
 * A category by id or slug, or 404 `not_found`.
 * @param {WebsiteData} data
 * @param {unknown} ref
 * @returns {Promise<CategoryRecord & { updatedAt?: Date }>}
 */
export const categoryByRef = async (data, ref) => {
	const key = refOf(ref);
	const found = key
		? /** @type {(CategoryRecord & { updatedAt?: Date }) | null} */ (
				await data
					.collection(COLLECTIONS.categories)
					.findOne({ websiteId: data.websiteId, $or: [{ id: key }, { slug: key }] }, { projection: { _id: 0 } })
			)
		: null;
	if (!found) throw problem('not_found', 'There is no such category.');
	return found;
};

/**
 * Categories by id (in no particular order).
 * @param {WebsiteData} data
 * @param {string[]} ids
 * @returns {Promise<CategoryRecord[]>}
 */
export const categoriesById = async (data, ids) =>
	ids.length === 0
		? []
		: /** @type {CategoryRecord[]} */ (
				await data
					.collection(COLLECTIONS.categories)
					.find({ websiteId: data.websiteId, id: { $in: [...new Set(ids)] } }, { projection: { _id: 0 } })
					.limit(MAX_CATEGORIES)
					.toArray()
			);

/**
 * Every category of the website (at most {@link MAX_CATEGORIES}).
 * @param {WebsiteData} data
 * @returns {Promise<CategoryRecord[]>}
 */
export const allCategories = async (data) =>
	/** @type {CategoryRecord[]} */ (
		await data
			.collection(COLLECTIONS.categories)
			.find({ websiteId: data.websiteId }, { projection: { _id: 0 } })
			.sort({ sort: 1, name: 1 })
			.limit(MAX_CATEGORIES)
			.toArray()
	);

/**
 * Brand id → name.
 * @param {WebsiteData} data
 * @param {Array<string | null>} [ids] only these (all when omitted)
 * @returns {Promise<Map<string, string>>}
 */
export const brandNames = async (data, ids) => {
	const wanted = ids ? [...new Set(ids.filter((id) => typeof id === 'string'))] : null;
	if (wanted && wanted.length === 0) return new Map();
	const rows = await data
		.collection(COLLECTIONS.brands)
		.find({ websiteId: data.websiteId, ...(wanted ? { id: { $in: wanted } } : {}) }, { projection: { _id: 0, id: 1, name: 1 } })
		.limit(MAX_CATEGORIES)
		.toArray();
	return new Map(rows.map((row) => [String(row.id), String(row.name)]));
};

/**
 * A category with its ancestors, root first, from a map of categories by id.
 * @param {CategoryRecord} category
 * @param {Map<string, CategoryRecord>} byId
 * @returns {CategoryRecord[]}
 */
export const lineage = (category, byId) => [
	...category.path.map((id) => byId.get(id)).filter((found) => found !== undefined),
	category,
];

/**
 * The breadcrumb trail of a category page: the home page, then each ancestor (without the category itself).
 * @param {Site} s
 * @param {WebsiteData} data
 * @param {Media} media
 * @param {CategoryRecord | null} category
 * @param {boolean} inclusive whether the category itself ends the trail
 * @param {string} home the home page's name
 */
export const trailOf = async (s, data, media, category, inclusive, home) => {
	const trail = [{ name: home, url: `https://${s.domain}/` }];
	if (!category) return trail;
	const ancestors = await categoriesById(data, category.path);
	const byId = new Map(ancestors.map((found) => [found.id, found]));
	const steps = lineage(category, byId).filter((step) => inclusive || step.id !== category.id);
	for (const step of steps) trail.push({ name: step.name, url: await media.categoryUrl(s, step) });
	return trail;
};

/**
 * A text answer written piece by piece (sitemaps and feeds can be large).
 * @param {AsyncIterable<string>} pieces
 * @param {string} type content type
 */
export const streamed = (pieces, type) => {
	const iterator = pieces[Symbol.asyncIterator]();
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream({
			async pull(controller) {
				const next = await iterator.next();
				if (next.done) controller.close();
				else controller.enqueue(encoder.encode(next.value));
			},
			async cancel() {
				await iterator.return?.();
			},
		}),
		{ headers: { 'content-type': type } },
	);
};
