/**
 * What shoppers may see of the catalog (PLAN 0.8.10 E1), judged on read: a hidden or coming-soon category hides its
 * products (and those of the categories below it), a hidden category is not listed, and a hidden brand hides its
 * products. Every shopper read, feed, sitemap, llms.txt and Chat lookup leaves them out. Read once per request.
 * @module
 */
import { COLLECTIONS } from '../core/model.js';

/** @typedef {import('./service.js').Site} Site */
/** @typedef {{ categoryIds: string[], brandIds: string[], unlisted: Set<string> }} Hidden */

/** At most this many categories and brands are read. */
const MAX_RECORDS = 5000;

/** @type {WeakMap<Site, Promise<Hidden>>} */
const cache = new WeakMap();

/**
 * The categories whose products are hidden (not active, or below one that is not), the hidden brands, and the
 * categories not listed at all (hidden, or below a hidden one).
 * @param {ReadonlyArray<{ id: string, path: string[], status: string }>} categories
 * @param {ReadonlyArray<{ id: string, status?: string }>} brands
 * @returns {Hidden}
 */
const hiddenOf = (categories, brands) => {
	const notActive = new Set(categories.filter((c) => c.status !== 'active').map((c) => c.id));
	const hidden = new Set(categories.filter((c) => c.status === 'hidden').map((c) => c.id));
	return {
		categoryIds: categories.filter((c) => notActive.has(c.id) || c.path.some((id) => notActive.has(id))).map((c) => c.id),
		brandIds: brands.filter((b) => b.status === 'hidden').map((b) => b.id),
		unlisted: new Set(categories.filter((c) => hidden.has(c.id) || c.path.some((id) => hidden.has(id))).map((c) => c.id)),
	};
};

/**
 * What a website's shoppers may not see, read once per request.
 * @param {Site} s
 * @returns {Promise<Hidden>}
 */
export const hiddenFor = (s) => {
	let found = cache.get(s);
	if (!found) {
		found = (async () => {
			const data = await s.data();
			const [categories, brands] = await Promise.all([
				data
					.collection(COLLECTIONS.categories)
					.find({ websiteId: data.websiteId }, { projection: { _id: 0, id: 1, path: 1, status: 1 } })
					.limit(MAX_RECORDS)
					.toArray(),
				data
					.collection(COLLECTIONS.brands)
					.find({ websiteId: data.websiteId, status: 'hidden' }, { projection: { _id: 0, id: 1, status: 1 } })
					.limit(MAX_RECORDS)
					.toArray(),
			]);
			return hiddenOf(
				categories.map((c) => ({ id: String(c.id), path: c.path, status: c.status })),
				brands.map((b) => ({ id: String(b.id), status: b.status })),
			);
		})();
		cache.set(s, found);
	}
	return found;
};

/**
 * Whether shoppers may see a product.
 * @param {{ categoryIds: string[], brandId: string | null }} product
 * @param {Hidden} hidden
 */
export const visible = (product, hidden) =>
	!product.categoryIds.some((id) => hidden.categoryIds.includes(id)) &&
	!(product.brandId !== null && hidden.brandIds.includes(product.brandId));

/**
 * The Mongo conditions that leave hidden products out (none when nothing is hidden).
 * @param {Hidden} hidden
 * @returns {Record<string, unknown>}
 */
export const visibleMatch = (hidden) => ({
	...(hidden.categoryIds.length > 0 ? { categoryIds: { $nin: hidden.categoryIds } } : {}),
	...(hidden.brandIds.length > 0 ? { brandId: { $nin: hidden.brandIds } } : {}),
});
