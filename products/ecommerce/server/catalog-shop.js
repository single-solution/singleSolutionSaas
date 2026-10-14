/**
 * The catalog for shoppers (PLAN 0.8.8 Shopper widgets: the product grid with filters and search, the product page;
 * PLAN 0.8.10 E1–E14): browser-token routes under `/v1/shop/…`, open to guests and to the merchant's server for pages
 * it renders (K3). Only active products of visible categories and brands are shown (E1), never costs; stock counts
 * only as the `catalog` settings allow (E9). A listing filters by several brands, grades and attribute values (one
 * active variant must match price, attributes, grade and stock together), by featured products and by a deal; it pages
 * by cursor or page number, can count its total, and its first page carries the facet counts; with `variants=1` each
 * card carries its active variants (SF-6). Searches go to Atlas Search when the website uses it (E14). Slugs are found in any case and by their earlier values, answering `moved`
 * (E13).
 * @module
 */
import { defineRoute, paginate, problem } from '@ss/app-kit';
import { NO_ID, attributesOf, brandsOf, categoriesOf, categoryGroups, findBySlugHistory } from '../adapters/catalog-store.js';
import { categoryTrail, dealsLiveNow, loadOffers } from '../adapters/promotions-store.js';
import {
	afterFilter,
	cursorKey,
	facetStage,
	facetsOf,
	listOf,
	readShopQuery,
	scopeFilter,
	shopFilter,
	sortDocument,
	SORTS,
} from '../core/catalog-query.js';
import { categoryTree, withDescendants } from '../core/catalog-taxonomy.js';
import { youtubeId } from '../core/catalog-content.js';
import { cardOf, cardPhotos, cardVariantsOf, pageOf } from '../core/catalog-views.js';
import { dealProductsFilter, productDeals } from '../core/deals.js';
import { gradesFor } from '../core/grades.js';
import { COLLECTIONS, ID_PREFIX } from '../core/model.js';
import { attributeValues } from '../core/promotions.js';
import { chartView, resolveSizeChart } from '../core/size-charts.js';
import { SHOP_LIMITS, refuse } from './catalog-common.js';
import { createCatalogSearch } from './catalog-search.js';
import { hiddenFor, visible } from './catalog-visibility.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./catalog-common.js').CatalogCommon} CatalogCommon */
/** @typedef {import('../core/model.js').ProductRecord} ProductRecord */
/** @typedef {import('../core/model.js').BrandRecord} BrandRecord */
/** @typedef {import('../core/model.js').CategoryRecord} CategoryRecord */
/** @typedef {import('../core/model.js').SizeChartRecord} SizeChartRecord */
/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */

/** Most products on one page of a listing (E8). */
const MAX_PAGE = 60;
/** A listing's total is exact up to this many products (E8). */
const TOTAL_CAP = 10_000;

/**
 * Product cards for any part that shows products (wishlist, compare, alerts, Chat lookups, feeds).
 * @param {CatalogCommon} common
 * @param {Service} service
 */
const createCards = (common, service) => {
	/**
	 * The live deals that cover each product (E18: cards carry `dealCount` and the first deal's badge); none while
	 * Deals is off.
	 * @param {Site} s @param {WebsiteData} data @param {ProductRecord[]} products
	 * @returns {Promise<Map<string, import('../core/model.js').DealRecord[]>>}
	 */
	const dealsOf = async (s, data, products) => {
		/** @type {Map<string, import('../core/model.js').DealRecord[]>} */
		const out = new Map();
		if (!s.has('deals')) return out;
		const now = service.now();
		const { deals } = await loadOffers(data, { now, deals: true });
		if (deals.length === 0) return out;
		const clock = await service.pricing(s);
		for (const item of products) {
			const categoryIds = await categoryTrail(data, item.categoryIds ?? []);
			out.set(
				item.id,
				productDeals(item, deals, {
					categoryIds,
					now,
					clock,
					attributes: (variant) => attributeValues(item, variant),
				}),
			);
		}
		return out;
	};

	/**
	 * The active variants of a card, with their pages (SF-6).
	 * @param {Site} s @param {ProductRecord} item @param {string} url
	 * @param {ReadonlyMap<string, import('../core/model.js').AttributeRecord>} attributes
	 */
	const variantsOf = async (s, item, url, attributes) => {
		/** @type {Map<string, string>} */
		const variantUrls = new Map();
		for (const variant of item.variants.filter((v) => v.active))
			variantUrls.set(variant.id, await common.media.variantUrl(s, item, variant, attributes));
		return cardVariantsOf(item, { attributes, variantUrls, url });
	};

	/**
	 * @param {Site} s
	 * @param {WebsiteData} data
	 * @param {ProductRecord[]} products
	 * @param {{ variants?: boolean }} [options] `variants`: each card carries its active variants (SF-6)
	 */
	return async (s, data, products, { variants = false } = {}) => {
		if (products.length === 0) return [];
		const brands = new Map((await brandsOf(data)).map((brand) => [brand.id, brand]));
		const gradeList = await common.gradeListOf(s);
		const deals = await dealsOf(s, data, products);
		const attributes = variants ? new Map((await attributesOf(data)).map((attribute) => [attribute.id, attribute])) : null;
		return Promise.all(
			products.map(async (item) => {
				const brand = item.brandId ? brands.get(item.brandId) : undefined;
				const main = item.media?.[0];
				const covering = deals.get(item.id) ?? [];
				const first = covering[0];
				const url = await common.media.productUrl(s, item);
				return {
					...cardOf(item, {
						currency: s.currency,
						image: await common.media.mediaUrl(s, main?.sizes?.card ?? main?.key),
						url,
						brand: brand ? { id: brand.id, name: brand.name, slug: brand.slug } : null,
						// each product's grades: its category's entries first (E45)
						grades: gradesFor(gradeList, item.categoryIds ?? []),
						cardImages: await Promise.all(
							cardPhotos(item).map(async (file) => ({
								url: await common.media.mediaUrl(s, file.sizes?.card ?? file.key),
								alt: file.alt || item.name,
							})),
						),
					}),
					...(attributes ? { variants: await variantsOf(s, item, url, attributes) } : {}),
					dealCount: covering.length,
					deal: first
						? {
								id: first.id,
								slug: first.slug,
								name: first.name,
								badgeLabel: first.badgeLabel,
								discountLabel: first.discountLabel,
								color: first.color,
							}
						: null,
				};
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
	const cards = createCards(common, service);
	const search = createCatalogSearch(product);

	/**
	 * The products a deal (by id or slug) is live for now, the products whose cards show it (SF-4): only a deal live now
	 * (switched on, dates, use limit, weekdays and hours, as the cart judges it) while Deals is on, and of its scope only
	 * the products with an active variant its conditions hold for (`dealProductsFilter`, the cart-only conditions left
	 * to the cart). Any other deal matches nothing.
	 * @param {Site} s @param {WebsiteData} data @param {string} ref @param {CategoryRecord[]} categories
	 */
	const dealFilter = async (s, data, ref, categories) => {
		const deal = s.has('deals')
			? (await dealsLiveNow(data, { now: service.now(), clock: await service.pricing(s) })).find(
					(candidate) => candidate.id === ref || (candidate.slug && candidate.slug === ref),
				)
			: undefined;
		if (!deal) return { id: { $in: [] } };
		/** @param {string} id */
		const below = (id) => withDescendants(id, categories);
		const scope = scopeFilter(
			{
				productIds: deal.scope?.productIds ?? [],
				categoryIds: deal.scope?.categoryIds ?? [],
				brandIds: deal.scope?.brandIds ?? [],
			},
			below,
		);
		const covered = dealProductsFilter(deal.conditions, below);
		return scope ? { $and: [scope, covered] } : covered;
	};

	/** GET /v1/shop/products. @param {any} ctx */
	const listing = async (ctx) => {
		const { s, data } = await common.open(ctx);
		const { pageSize, searchMatch } = await s.values('catalog');
		// pages by cursor like every other list (`nextCursor`, `hasMore`)
		const page = paginate(
			{ cursor: ctx.query.page ? null : ctx.query.cursor, limit: ctx.query.limit },
			{ defaultLimit: Math.min(MAX_PAGE, Number(pageSize)), maxLimit: MAX_PAGE },
		);
		const read = readShopQuery(ctx.query);
		if (!read.ok) throw refuse(read.errors);
		const query = read.value;
		// variants=1: each card carries its active variants, for websites that draw their own cards (SF-6)
		const withVariants = ctx.query.variants === '1' || ctx.query.variants === 'true';
		const [categories, brands, attributes, hidden] = await Promise.all([
			categoriesOf(data),
			brandsOf(data),
			attributesOf(data),
			hiddenFor(s),
		]);
		/** @type {string[] | null} */
		let categoryIds = null;
		/** @type {string | null} */
		let categoryId = null;
		if (query.category) {
			const wanted = query.category.toLowerCase();
			const found = categories.find((c) => c.id === query.category || c.slug === wanted);
			categoryIds = found ? withDescendants(found.id, categories) : [];
			categoryId = found?.id ?? null;
		}
		const brandIds =
			query.brands.length > 0
				? brands.filter((b) => query.brands.includes(b.id) || query.brands.includes(b.slug)).map((b) => b.id)
				: null;
		const byAttribute = new Map(attributes.map((attribute) => [attribute.id, attribute]));
		const resolved = {
			categoryIds,
			categoryId,
			brandIds,
			attributes: byAttribute,
			hidden,
			deal: query.deal ? await dealFilter(s, data, query.deal, categories) : null,
			match: searchMatch === 'phrase' ? /** @type {const} */ ('phrase') : /** @type {const} */ ('words'),
		};
		const sort = /** @type {import('../core/catalog-query.js').Sort} */ (SORTS[query.sort]);
		const filterable = attributes.filter((attribute) => attribute.filterable && attribute.active !== false);
		const names = {
			categories: new Map(categories.map((c) => [c.id, c])),
			brands: new Map(brands.map((b) => [b.id, b])),
			attributes: new Map(filterable.map((a) => [a.id, a])),
			// a category's listing names grades as that category defines them (E45)
			grades: gradesFor(await common.gradeListOf(s), [categoryId]),
		};
		const first = page.after === null && (query.page === null || query.page === 1);

		// Atlas Search first, when the website uses it; the basic search answers if it fails (E14)
		if (await search.useAtlas(s, query.q)) {
			const atlasAfter = Array.isArray(page.after) && page.after[0] === 'atlas' ? Number(page.after[1]) : null;
			if (page.after !== null && (atlasAfter === null || !Number.isSafeInteger(atlasAfter) || atlasAfter < 0))
				throw problem('bad_request', 'cursor is invalid');
			const offset = atlasAfter ?? ((query.page ?? 1) - 1) * page.limit;
			const found = await search.run(s, data, query.q, {
				match: { websiteId: data.websiteId, ...shopFilter({ ...query, q: '' }, resolved) },
				sort: ctx.query.sort ? sort : null,
				skip: offset,
				limit: page.fetchLimit,
				count: query.count,
				facets: first ? facetStage(filterable.map((attribute) => attribute.id)).$facet : null,
				project: { _id: 0, websiteId: 0, merchantId: 0 },
			});
			if (found.ok) {
				const items = /** @type {ProductRecord[]} */ (found.items);
				const body = page.page(items, (item) => ['atlas', offset + items.indexOf(item) + 1]);
				return {
					items: await cards(s, data, body.items, { variants: withVariants }),
					nextCursor: body.nextCursor,
					hasMore: body.hasMore,
					...(query.page === null ? {} : { page: query.page }),
					...(found.total === null ? {} : { total: Math.min(found.total, TOTAL_CAP), capped: found.total > TOTAL_CAP }),
					facets: first ? facetsOf(found.facets, names) : null,
				};
			}
		}

		const filter = { websiteId: data.websiteId, ...shopFilter(query, resolved) };
		const after = page.after === null ? null : afterFilter(sort, page.after);
		if (page.after !== null && !after) throw problem('bad_request', 'cursor is invalid');
		const products = data.collection(COLLECTIONS.products);
		const found = /** @type {ProductRecord[]} */ (
			await products
				.find(after ? { $and: [filter, after], websiteId: data.websiteId } : filter, NO_ID)
				.sort(sortDocument(sort))
				.skip(query.page === null ? 0 : (query.page - 1) * page.limit)
				.limit(page.fetchLimit)
				.toArray()
		);
		const body = page.page(found, (item) => cursorKey(item, sort));
		let facets = null;
		if (first) {
			const [raw] = await products.aggregate([{ $match: filter }, facetStage(filterable.map((a) => a.id))]).toArray();
			facets = facetsOf(raw, names);
		}
		/** @type {Record<string, unknown>} */
		const totals = {};
		if (query.count) {
			const n = await products.countDocuments(filter, { limit: TOTAL_CAP + 1 });
			Object.assign(totals, { total: Math.min(n, TOTAL_CAP), capped: n > TOTAL_CAP });
		}
		return {
			items: await cards(s, data, body.items, { variants: withVariants }),
			nextCursor: body.nextCursor,
			hasMore: body.hasMore,
			...(query.page === null ? {} : { page: query.page }),
			...totals,
			facets,
		};
	};

	/**
	 * A product's video as shoppers play it (E4).
	 * @param {Site} s @param {ProductRecord} item
	 */
	const videoOf = async (s, item) => {
		const video = item.video;
		if (!video) return null;
		if (video.kind === 'file') return { kind: 'file', url: await common.media.mediaUrl(s, video.key), type: video.type };
		if (video.kind === 'youtube')
			return { kind: 'youtube', id: video.id, url: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(video.id)}` };
		return { kind: 'url', url: video.url };
	};

	/**
	 * The size chart a product shows (E5; the website's default chart when nothing else names one, SF-3), or null.
	 * @param {Site} s @param {WebsiteData} data @param {ProductRecord} item @param {BrandRecord | null} brand
	 * @param {CategoryRecord[]} categories
	 */
	const sizeChartOf = async (s, data, item, brand, categories) => {
		if (!s.has('size_charts') || item.hideSizeGuide) return null;
		const charts = /** @type {SizeChartRecord[]} */ (
			await data
				.collection(COLLECTIONS.sizeCharts)
				.find({ websiteId: data.websiteId, active: true }, NO_ID)
				.limit(1000)
				.toArray()
		);
		const chart = resolveSizeChart(
			item,
			brand,
			new Map(categories.map((c) => [c.id, c])),
			new Map(charts.map((c) => [c.id, c])),
			String((await s.values('size_charts')).defaultChartId ?? '') || null,
		);
		return chart ? chartView(chart) : null;
	};

	/**
	 * A product's grades (its category's entries first, E45) with each condition video's address (a YouTube id becomes
	 * its embed address, a file key its storage address; E10).
	 * @param {Site} s @param {ProductRecord} item
	 */
	const gradesWithVideos = async (s, item) =>
		new Map(
			await Promise.all(
				[...gradesFor(await common.gradeListOf(s), item.categoryIds ?? []).entries()].map(
					async ([key, grade]) =>
						/** @type {[string, import('../core/grades.js').Grade]} */ ([
							key,
							{
								...grade,
								videoUrl: !grade.video
									? null
									: youtubeId(grade.video) === grade.video
										? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(grade.video)}`
										: await common.media.mediaUrl(s, grade.video),
							},
						]),
				),
			),
		);

	/** GET /v1/shop/products/:ref (id, slug in any case, or an earlier slug). @param {any} ctx */
	const page = async (ctx) => {
		const { s, data } = await common.open(ctx);
		const found = await findBySlugHistory(data, COLLECTIONS.products, String(ctx.params.ref), ID_PREFIX.product);
		const item = /** @type {ProductRecord | undefined} */ (found?.record);
		if (!found || !item) throw problem('not_found', 'There is no such product.');
		const [categories, attributes, hidden, settings] = await Promise.all([
			categoriesOf(data),
			attributesOf(data),
			hiddenFor(s),
			s.values('catalog'),
		]);
		const byId = new Map(categories.map((c) => [c.id, c]));
		if (item.status !== 'active') {
			// an archived product may lead to its category (E13)
			const category = byId.get(item.categoryIds[0] ?? '');
			if (item.status === 'archived' && settings.retiredUrl === 'category' && category && !hidden.unlisted.has(category.id))
				return { moved: { kind: 'category', slug: category.slug, url: await common.media.categoryUrl(s, category) } };
			throw problem('not_found', 'There is no such product.');
		}
		if (!visible(item, hidden)) throw problem('not_found', 'There is no such product.');
		if (found.moved) return { moved: { kind: 'product', slug: item.slug, url: await common.media.productUrl(s, item) } };
		/** @type {BrandRecord | null} */
		const brand = item.brandId
			? /** @type {BrandRecord | null} */ (
					await data.collection(COLLECTIONS.brands).findOne({ websiteId: data.websiteId, id: item.brandId }, NO_ID)
				)
			: null;
		const main = item.categoryIds.map((id) => byId.get(id)).find((category) => category !== undefined);
		const trail = main ? [...main.path.map((id) => byId.get(id)), main].filter((c) => c !== undefined) : [];
		const byAttribute = new Map(attributes.map((attribute) => [attribute.id, attribute]));
		const active = item.variants.filter((variant) => variant.active);
		const url = await common.media.productUrl(s, item);
		return pageOf(item, {
			currency: s.currency,
			url,
			media: await Promise.all(item.media.map((file) => common.mediaView(s, file, item.name))),
			brand: brand ? { id: brand.id, slug: brand.slug, name: brand.name } : null,
			breadcrumb: await Promise.all(
				trail.map(async (c) => ({ id: c.id, slug: c.slug, name: c.name, url: await common.media.categoryUrl(s, c) })),
			),
			attributes: byAttribute,
			grades: await gradesWithVideos(s, item),
			variantMedia: new Map(
				await Promise.all(
					active.map(
						async (variant) =>
							/** @type {[string, import('../core/catalog-views.js').MediaView[]]} */ ([
								variant.id,
								await Promise.all(variant.media.map((file) => common.mediaView(s, file, item.name))),
							]),
					),
				),
			),
			variantUrls: new Map(
				await Promise.all(
					active.map(
						async (variant) =>
							/** @type {[string, string]} */ ([variant.id, await common.media.variantUrl(s, item, variant, byAttribute)]),
					),
				),
			),
			stock: { showStock: String(settings.showStock ?? 'none'), lowStockShown: Number(settings.lowStockShown ?? 5) },
			warrantyDays: Number((await s.values('returns')).warrantyDays ?? 0) || null,
			sizeChart: await sizeChartOf(s, data, item, brand, categories),
			video: await videoOf(s, item),
		});
	};

	/** GET /v1/shop/categories?include=coming_soon: the tree with product counts (E1). @param {any} ctx */
	const categoryList = async (ctx) => {
		const { s, data } = await common.open(ctx);
		const comingSoon = listOf(ctx.query.include).includes('coming_soon');
		const [all, hidden] = await Promise.all([categoriesOf(data), hiddenFor(s)]);
		const shown = all.filter(
			(category) => !hidden.unlisted.has(category.id) && (comingSoon || !hidden.categoryIds.includes(category.id)),
		);
		const productsHidden = new Set(hidden.categoryIds);
		/** @type {Map<string, Record<string, unknown>>} */
		const extras = new Map();
		for (const category of shown)
			extras.set(category.id, {
				description: category.description,
				seo: category.seo,
				status: productsHidden.has(category.id) ? 'coming_soon' : 'active',
				icon: category.icon ?? '',
				content: category.content ?? { summary: '', bullets: [] },
				faqs: category.faqs ?? [],
				image: category.image ? { url: await common.media.mediaUrl(s, category.image.key), alt: category.image.alt } : null,
				url: await common.media.categoryUrl(s, category),
			});
		const visibleMatch = {
			...(hidden.categoryIds.length > 0 ? { categoryIds: { $nin: hidden.categoryIds } } : {}),
			...(hidden.brandIds.length > 0 ? { brandId: { $nin: hidden.brandIds } } : {}),
		};
		return {
			items: categoryTree(shown, await categoryGroups(data, visibleMatch), (category) => extras.get(category.id) ?? {}),
		};
	};

	/**
	 * GET /v1/shop/brands?category=: visible brands with their visible products' count; with a category, the brands
	 * that belong to it, an ancestor or a descendant ([] = every category) (E1).
	 * @param {any} ctx
	 */
	const brandList = async (ctx) => {
		const { s, data } = await common.open(ctx);
		const hidden = await hiddenFor(s);
		/** @type {Set<string> | null} */
		let related = null;
		if (ctx.query.category) {
			const categories = await categoriesOf(data);
			const wanted = String(ctx.query.category).toLowerCase();
			const found = categories.find((c) => c.id === ctx.query.category || c.slug === wanted);
			related = new Set(found ? [...withDescendants(found.id, categories), ...found.path] : []);
		}
		const counts = new Map(
			(
				await data
					.collection(COLLECTIONS.products)
					.aggregate([
						{
							$match: {
								websiteId: data.websiteId,
								status: 'active',
								brandId: { $type: 'string', ...(hidden.brandIds.length > 0 ? { $nin: hidden.brandIds } : {}) },
								...(hidden.categoryIds.length > 0 ? { categoryIds: { $nin: hidden.categoryIds } } : {}),
								...(related ? { categoryIds: { $in: [...related], $nin: hidden.categoryIds } } : {}),
							},
						},
						{ $group: { _id: '$brandId', count: { $sum: 1 } } },
					])
					.toArray()
			).map((row) => [String(row._id), Number(row.count)]),
		);
		const brands = (await brandsOf(data)).filter(
			(brand) =>
				brand.status !== 'hidden' &&
				(!related ||
					(brand.categoryIds ?? []).length === 0 ||
					(brand.categoryIds ?? []).some((id) => /** @type {Set<string>} */ (related).has(id))),
		);
		return {
			items: await Promise.all(
				brands.map(async (brand) => ({
					id: brand.id,
					slug: brand.slug,
					name: brand.name,
					description: brand.description,
					categoryIds: brand.categoryIds ?? [],
					seo: brand.seo,
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
