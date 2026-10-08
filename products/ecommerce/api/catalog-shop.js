/**
 * The catalog for shoppers (PLAN 0.8.8 Shopper widgets: the product grid with filters and search, the product page):
 * browser-token routes under `/v1/shop/…`, open to guests. Only active products are shown, never exact stock counts or
 * costs. A listing's first page also carries the facet counts the filters show.
 * @module
 */
import { defineRoute, paginate, problem } from '@ss/app-kit';
import { NO_ID, attributesOf, brandsOf, categoriesOf, categoryGroups, findProduct } from '../adapters/catalog-store.js';
import {
	afterFilter,
	cursorKey,
	facetStage,
	facetsOf,
	readShopQuery,
	shopFilter,
	sortDocument,
	SORTS,
} from '../core/catalog-query.js';
import { categoryTree, withDescendants } from '../core/catalog-taxonomy.js';
import { cardOf, pageOf } from '../core/catalog-views.js';
import { COLLECTIONS } from '../core/model.js';
import { SHOP_LIMITS, refuse } from './catalog-common.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./catalog-common.js').CatalogCommon} CatalogCommon */
/** @typedef {import('../core/model.js').ProductRecord} ProductRecord */
/** @typedef {import('../core/model.js').BrandRecord} BrandRecord */
/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */

/** Most products on one page of a listing. */
const MAX_PAGE = 48;

/**
 * Product cards for any part that shows products (wishlist, compare, alerts, Chat lookups, feeds).
 * @param {CatalogCommon} common
 */
const createCards = (common) => {
	/**
	 * @param {Site} s
	 * @param {WebsiteData} data
	 * @param {ProductRecord[]} products
	 */
	return async (s, data, products) => {
		if (products.length === 0) return [];
		const brands = new Map((await brandsOf(data)).map((brand) => [brand.id, brand]));
		const grades = await common.gradesOf(s);
		return Promise.all(
			products.map(async (item) => {
				const brand = item.brandId ? brands.get(item.brandId) : undefined;
				return cardOf(item, {
					currency: s.currency,
					image: await common.media.mediaUrl(s, item.media?.[0]?.key),
					url: await common.media.productUrl(s, item),
					brand: brand ? { id: brand.id, name: brand.name } : null,
					grades,
				});
			}),
		);
	};
};

/**
 * @param {Product} product
 * @param {Service} service
 * @param {CatalogCommon} common
 */
export const createCatalogShop = (product, service, common) => {
	const cards = createCards(common);

	/** GET /v1/shop/products. @param {any} ctx */
	const listing = async (ctx) => {
		const { s, data } = await common.open(ctx);
		const { pageSize } = await s.values('catalog');
		const page = paginate(
			{ cursor: ctx.query.cursor, limit: ctx.query.limit },
			{ defaultLimit: Math.min(MAX_PAGE, Number(pageSize)), maxLimit: MAX_PAGE },
		);
		const read = readShopQuery(ctx.query);
		if (!read.ok) throw refuse(read.errors);
		const query = read.value;
		const [categories, brands, attributes] = await Promise.all([categoriesOf(data), brandsOf(data), attributesOf(data)]);
		/** @type {string[] | null} */
		let categoryIds = null;
		if (query.category) {
			const found = categories.find((c) => c.id === query.category || c.slug === query.category);
			categoryIds = found ? withDescendants(found.id, categories) : [];
		}
		const brandId = query.brand ? (brands.find((b) => b.id === query.brand || b.slug === query.brand)?.id ?? '') : null;
		const byAttribute = new Map(attributes.map((attribute) => [attribute.id, attribute]));
		const filter = { websiteId: data.websiteId, ...shopFilter(query, { categoryIds, brandId, attributes: byAttribute }) };
		const sort = /** @type {import('../core/catalog-query.js').Sort} */ (SORTS[query.sort]);
		const after = page.after === null ? null : afterFilter(sort, page.after);
		if (page.after !== null && !after) throw problem('bad_request', 'cursor is invalid');
		const products = data.collection(COLLECTIONS.products);
		const found = /** @type {ProductRecord[]} */ (
			await products
				.find(after ? { $and: [filter, after], websiteId: data.websiteId } : filter, NO_ID)
				.sort(sortDocument(sort))
				.limit(page.fetchLimit)
				.toArray()
		);
		const body = page.page(found, (item) => cursorKey(item, sort));
		let facets = null;
		if (page.after === null) {
			const filterable = attributes.filter((attribute) => attribute.filterable).map((attribute) => attribute.id);
			const [raw] = await products.aggregate([{ $match: filter }, facetStage(filterable)]).toArray();
			facets = facetsOf(raw, {
				categories: new Map(categories.map((c) => [c.id, c])),
				brands: new Map(brands.map((b) => [b.id, b])),
				attributes: new Map(attributes.filter((a) => a.filterable).map((a) => [a.id, a])),
				grades: await common.gradesOf(s),
			});
		}
		return { items: await cards(s, data, body.items), next: body.nextCursor, facets };
	};

	/** GET /v1/shop/products/:ref (id or slug). @param {any} ctx */
	const page = async (ctx) => {
		const { s, data } = await common.open(ctx);
		const item = await findProduct(data, String(ctx.params.ref));
		if (!item || item.status !== 'active') throw problem('not_found', 'There is no such product.');
		const [categories, attributes] = await Promise.all([categoriesOf(data), attributesOf(data)]);
		/** @type {BrandRecord | null} */
		const brand = item.brandId
			? /** @type {BrandRecord | null} */ (
					await data.collection(COLLECTIONS.brands).findOne({ websiteId: data.websiteId, id: item.brandId }, NO_ID)
				)
			: null;
		const byId = new Map(categories.map((c) => [c.id, c]));
		const main = item.categoryIds.map((id) => byId.get(id)).find((category) => category !== undefined);
		const trail = main ? [...main.path.map((id) => byId.get(id)), main].filter((c) => c !== undefined) : [];
		const urls = await common.mediaUrls(s, item);
		return pageOf(item, {
			currency: s.currency,
			url: await common.media.productUrl(s, item),
			media: item.media.map((file, index) => ({ url: urls[index] ?? null, alt: file.alt || item.name, type: file.type })),
			brand: brand ? { id: brand.id, slug: brand.slug, name: brand.name } : null,
			breadcrumb: await Promise.all(
				trail.map(async (c) => ({ id: c.id, slug: c.slug, name: c.name, url: await common.media.categoryUrl(s, c) })),
			),
			attributes: new Map(attributes.map((attribute) => [attribute.id, attribute])),
			grades: await common.gradesOf(s),
		});
	};

	/** GET /v1/shop/categories: the tree with product counts. @param {any} ctx */
	const categoryList = async (ctx) => {
		const { s, data } = await common.open(ctx);
		const categories = await categoriesOf(data);
		/** @type {Map<string, Record<string, unknown>>} */
		const extras = new Map();
		for (const category of categories)
			extras.set(category.id, {
				description: category.description,
				seo: category.seo,
				image: category.image ? { url: await common.media.mediaUrl(s, category.image.key), alt: category.image.alt } : null,
				url: await common.media.categoryUrl(s, category),
			});
		return { items: categoryTree(categories, await categoryGroups(data), (category) => extras.get(category.id) ?? {}) };
	};

	/** GET /v1/shop/brands: brands with their active products' count. @param {any} ctx */
	const brandList = async (ctx) => {
		const { s, data } = await common.open(ctx);
		const counts = new Map(
			(
				await data
					.collection(COLLECTIONS.products)
					.aggregate([
						{ $match: { websiteId: data.websiteId, status: 'active', brandId: { $type: 'string' } } },
						{ $group: { _id: '$brandId', count: { $sum: 1 } } },
					])
					.toArray()
			).map((row) => [String(row._id), Number(row.count)]),
		);
		const brands = await brandsOf(data);
		return {
			items: await Promise.all(
				brands.map(async (brand) => ({
					id: brand.id,
					slug: brand.slug,
					name: brand.name,
					description: brand.description,
					logo: brand.logo ? { url: await common.media.mediaUrl(s, brand.logo.key), alt: brand.logo.alt } : null,
					count: counts.get(brand.id) ?? 0,
				})),
			),
		};
	};

	return [
		defineRoute({
			method: 'GET',
			path: '/v1/shop/products',
			auth: 'browser',
			feature: 'catalog',
			rateLimit: SHOP_LIMITS,
			handler: listing,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/shop/products/:ref',
			auth: 'browser',
			feature: 'catalog',
			rateLimit: SHOP_LIMITS,
			handler: page,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/shop/categories',
			auth: 'browser',
			feature: 'catalog',
			rateLimit: SHOP_LIMITS,
			handler: categoryList,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/shop/brands',
			auth: 'browser',
			feature: 'catalog',
			rateLimit: SHOP_LIMITS,
			handler: brandList,
		}),
	];
};
