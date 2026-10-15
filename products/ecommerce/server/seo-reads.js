/**
 * Catalog reads shared by the SEO, feeds, llms.txt and Chat lookup routes: the `seo` settings a page follows, an active
 * product or a category by id or slug, brands and categories by id, a category's trail from the home page, the name in
 * titles, and streaming a long text answer (sitemaps and feeds) so its size never matters. Every query pins `websiteId`.
 * @module
 */
import { problem } from '@ss/app-kit';
import { SEO_DEFAULTS } from '../adapters/product.js';
import { siteAddress } from '../core/catalog-content.js';
import { absolute } from '../core/links.js';
import { COLLECTIONS } from '../core/model.js';
import { pageName, pageTitle } from '../core/seo.js';

/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/model.js').ProductRecord} ProductRecord */
/** @typedef {import('../core/model.js').CategoryRecord} CategoryRecord */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./catalog-media.js').Media} Media */

/** At most this many categories are read at once (trees, product types). */
const MAX_CATEGORIES = 5000;

/**
 * The `seo` settings a page's SEO follows: the merchant's while the SEO feature is on; else the schema's defaults, so
 * every shop with a catalog gets best-practice SEO (baseline SEO with the catalog; the priced SEO feature is the SEO
 * product: the merchant's own patterns, site settings, automatic copy, IndexNow, landing and glossary pages).
 * @param {Site} s
 * @returns {Promise<Readonly<Record<string, any>>>}
 */
export const seoSettingsOf = async (s) => (s.has('seo') ? s.values('seo') : SEO_DEFAULTS);

/**
 * The newest of some times as ISO 8601 text, or null without any (an answer's `lastModified`, SEO audit G10).
 * @param {unknown[]} times
 * @returns {string | null}
 */
export const newestOf = (times) => {
	const valid = times
		.map((time) => (time instanceof Date || typeof time === 'string' ? new Date(time).getTime() : NaN))
		.filter((at) => Number.isFinite(at));
	return valid.length > 0 ? new Date(Math.max(...valid)).toISOString() : null;
};

/**
 * The name `{business}` and `{storeName}` stand for in titles and descriptions: the `seo` setting `brandName`, else the
 * business name (SG-5).
 * @param {Record<string, unknown>} settings the `seo` settings
 * @param {{ name: string }} business
 */
export const storeNameOf = (settings, business) => String(settings.brandName ?? '').trim() || business.name;

/** @typedef {{ name: string, seo: { title: string, titleMode: 'template' | 'as_written' } }} TitledRecord */

/** A website's page titles, read once per request. @type {WeakMap<Site, Promise<PageTitles>>} */
const titles = new WeakMap();

/**
 * How the SEO answers title a product's, category's and brand's page (G6), for the titles staff's SEO scores judge
 * (E42): its own SEO title as written (`as_written`), else the title pattern around its own title or, without one, its
 * page part (`productTitle` or `categoryTitle`) filled with its name (the facts a pattern takes from other records —
 * brand, category, prices — are left out).
 * @typedef {{ product: (record: TitledRecord) => string, category: (record: TitledRecord) => string,
 *   brand: (record: TitledRecord) => string }} PageTitles
 * @param {Site} s
 * @returns {Promise<PageTitles>}
 */
export const pageTitlesOf = (s) => {
	let found = titles.get(s);
	if (!found) {
		found = (async () => {
			const settings = await seoSettingsOf(s);
			const storeName = storeNameOf(settings, await s.business());
			/** @param {TitledRecord} record @param {unknown} pattern */
			const titleOf = (record, pattern) =>
				pageTitle(String(settings.titleTemplate), {
					own: record.seo.title,
					mode: record.seo.titleMode,
					name: pageName(pattern, { name: record.name, storeName }),
					business: storeName,
				});
			return Object.freeze({
				product: (/** @type {TitledRecord} */ record) => titleOf(record, settings.productTitle),
				category: (/** @type {TitledRecord} */ record) => titleOf(record, settings.categoryTitle),
				brand: (/** @type {TitledRecord} */ record) => titleOf(record, ''),
			});
		})();
		titles.set(s, found);
	}
	return found;
};

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
 * Categories by id (in no particular order).
 * @param {WebsiteData} data
 * @param {string[]} ids
 * @returns {Promise<CategoryRecord[]>}
 */
const categoriesById = async (data, ids) =>
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

/**
 * The seo setting `defaultImage` as an absolute address (a path is on the website), or null without one: the social
 * image of a page without its own.
 * @param {Record<string, unknown>} settings the `seo` settings
 * @param {string} domain
 */
export const defaultImageOf = (settings, domain) => {
	const address = siteAddress(settings.defaultImage);
	return address ? absolute(address, domain) : null;
};
