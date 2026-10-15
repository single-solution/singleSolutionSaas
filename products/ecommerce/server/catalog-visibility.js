/**
 * What shoppers may see of the catalog (PLAN 0.8.10 E1), judged on read: a hidden or coming-soon category hides its
 * products (and those of the categories below it), a hidden category is not listed, and a hidden brand hides its
 * products. Every shopper read, feed, sitemap, llms.txt and Chat lookup leaves them out. Read once per request. Also
 * where a retired product's address leads (E13, SEO audit G9).
 * @module
 */
import { NO_ID } from '../adapters/catalog-store.js';
import { COLLECTIONS } from '../core/model.js';

/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/model.js').ProductRecord} ProductRecord */
/** @typedef {import('../core/model.js').CategoryRecord} CategoryRecord */
/** @typedef {{ kind: 'product' | 'category', slug: string, url: string }} Moved */
/** @typedef {{ categoryIds: string[], brandIds: string[], unlisted: Set<string> }} Hidden */

/** At most this many categories and brands are read. */
const MAX_RECORDS = 5000;
/** At most this many replacements are followed from a retired product. */
const MAX_HOPS = 10;

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

/**
 * Where an archived product's address leads (E13, SEO audit G9): its replacement (`replacedBy`, followed through
 * archived replacements to the first active product shoppers may see, never round a loop), else with the `catalog`
 * setting `retiredUrl` at `category` its first category when shoppers may see it; null = nowhere (404). One hop for
 * the website's 308, never a chain.
 * @param {Site} s @param {WebsiteData} data @param {ProductRecord} item
 * @param {{ productUrl: (s: Site, item: ProductRecord) => Promise<string>,
 *   categoryUrl: (s: Site, category: CategoryRecord) => Promise<string> }} links
 * @returns {Promise<{ moved: Moved } | null>}
 */
export const retiredMove = async (s, data, item, links) => {
	if (item.status !== 'archived') return null;
	const [hidden, { retiredUrl }] = await Promise.all([hiddenFor(s), s.values('catalog')]);
	const products = data.collection(COLLECTIONS.products);
	const seen = new Set([item.id]);
	for (let next = item.replacedBy; next && !seen.has(next) && seen.size <= MAX_HOPS;) {
		seen.add(next);
		const found = /** @type {ProductRecord | null} */ (await products.findOne({ websiteId: data.websiteId, id: next }, NO_ID));
		if (found?.status === 'active' && visible(found, hidden))
			return { moved: { kind: 'product', slug: found.slug, url: await links.productUrl(s, found) } };
		next = found?.status === 'archived' ? found.replacedBy : null;
	}
	if (retiredUrl !== 'category') return null;
	const category = /** @type {CategoryRecord | null} */ (
		await data.collection(COLLECTIONS.categories).findOne({ websiteId: data.websiteId, id: item.categoryIds[0] ?? '' }, NO_ID)
	);
	return category && !hidden.unlisted.has(category.id)
		? { moved: { kind: 'category', slug: category.slug, url: await links.categoryUrl(s, category) } }
		: null;
};
