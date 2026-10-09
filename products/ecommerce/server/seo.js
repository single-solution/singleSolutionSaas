/**
 * Catalog SEO (meta and structured data, sitemaps), product feeds, llms.txt, the shop's policies and the lookups other
 * products call (Chat's shop tools, the customer orders of Accounts and Chat). Everything that must appear on the
 * merchant's domain is served by the merchant's site from these server-token routes (PLAN 0.4.10); the docs give the
 * snippets. Read-only; no personal data is kept, so there is nothing to export or delete.
 * @module
 */
import { defineRoute, problem } from '@ss/app-kit';
import { GOOGLE_FOOT, MAX_FEED_ROWS, META_HEADER, feedRows, googleHead, googleItem, metaLine } from '../core/feeds.js';
import { buildLlmsTxt, MAX_LLMS_CATEGORIES, treeOrder } from '../core/llms.js';
import { COLLECTIONS } from '../core/model.js';
import { formatMoney } from '../core/money.js';
import {
	SITEMAP_FOOT,
	SITEMAP_HEAD,
	categoryJsonLd,
	fillTitle,
	metaDescription,
	productJsonLd,
	scriptJson,
	sitemapEntry,
	sitemapIndex,
	sitemapPageUrl,
	sitemapSlice,
} from '../core/seo.js';
import { createMedia } from './catalog-media.js';
import { createChatLookup } from './chat-lookup.js';
import { SERVER_LIMITS, VISITOR_LIMITS } from './service.js';
import {
	activeProduct,
	allCategories,
	brandNames,
	categoriesById,
	categoryByRef,
	lineage,
	streamed,
	trailOf,
} from './seo-reads.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('../core/model.js').ProductRecord} ProductRecord */
/** @typedef {import('../core/model.js').CategoryRecord} CategoryRecord */

/** The rate limits of these routes. @type {Array<{ limit: number, windowSeconds: number, per?: 'website' | 'visitor' }>} */
const SERVER_RATE = [...SERVER_LIMITS];
/** @type {Array<{ limit: number, windowSeconds: number, per?: 'website' | 'visitor' }>} */
const VISITOR_RATE = [...VISITOR_LIMITS];

/** At most this many images per product in structured data. */
const MAX_IMAGES = 10;
/** Sitemap text is sent in pieces of about this many characters. */
const CHUNK = 16_384;
/** Products are read in batches of this size while writing sitemaps and feeds. */
const BATCH = 200;
/** The llms.txt section names (the llms.txt convention's structure, not shop wording). */
const LLMS_HEADINGS = Object.freeze({ categories: 'Categories', products: 'Products', policies: 'Policies' });

/** What the feeds and sitemaps read of a product. */
const LISTING_FIELDS = Object.freeze({
	_id: 0,
	id: 1,
	slug: 1,
	name: 1,
	kind: 1,
	summary: 1,
	description: 1,
	categoryIds: 1,
	brandId: 1,
	media: 1,
	variants: 1,
	trackStock: 1,
	price: 1,
	inStock: 1,
	updatedAt: 1,
});

/**
 * The shop's policy texts (`checkout` settings).
 * @param {Site} s
 */
const policiesOf = async (s) => {
	const values = await s.values('checkout');
	return {
		shipping: String(values.policyShipping),
		returns: String(values.policyReturns),
		privacy: String(values.policyPrivacy),
		terms: String(values.policyTerms),
	};
};

/**
 * @param {Product} product
 * @param {Service} service
 * @returns {import('./routes.js').Area}
 */
export const createSeo = (product, service) => {
	const media = createMedia(product);

	/**
	 * A page number from `?page=` (1 when absent), or 404 past the last page.
	 * @param {unknown} value
	 */
	const pageOf = (value) => {
		if (value === undefined || value === null || value === '') return 1;
		const n = typeof value === 'string' && /^\d{1,6}$/.test(value) ? Number(value) : 0;
		if (n < 1) throw problem('bad_request', 'page must be a whole number from 1.');
		return n;
	};

	/** @param {any} ctx */
	const productSeo = async (ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const item = await activeProduct(data, ctx.params.ref);
		const [settings, business] = await Promise.all([s.values('seo'), s.business()]);
		const url = await media.productUrl(s, item);
		const images = [];
		for (const file of item.media.slice(0, MAX_IMAGES)) {
			const address = await media.mediaUrl(s, file.key);
			if (address) images.push(address);
		}
		const [primary] = await categoriesById(data, item.categoryIds.slice(0, 1));
		const brand = item.brandId ? ((await brandNames(data, [item.brandId])).get(item.brandId) ?? null) : null;
		const description = metaDescription(item.seo?.description, item.summary, item.description);
		const jsonLd = productJsonLd({
			product: item,
			url,
			images,
			description,
			brand,
			currency: s.currency,
			graded: settings.gradedCondition,
			seller: business.name,
			trail: await trailOf(s, data, media, primary ?? null, true, business.name),
		});
		return {
			title: fillTitle(String(settings.titleTemplate), { name: item.seo?.title || item.name, business: business.name }),
			description,
			canonical: url,
			image: images[0] ?? null,
			jsonLd: scriptJson(jsonLd),
		};
	};

	/** @param {any} ctx */
	const categorySeo = async (ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const category = await categoryByRef(data, ctx.params.ref);
		const [settings, business] = await Promise.all([s.values('seo'), s.business()]);
		const url = await media.categoryUrl(s, category);
		const image = category.image ? await media.mediaUrl(s, category.image.key) : null;
		const description = metaDescription(category.seo?.description, category.description, category.name);
		const jsonLd = categoryJsonLd({
			name: category.name,
			description,
			url,
			image,
			trail: await trailOf(s, data, media, category, false, business.name),
		});
		return {
			title: fillTitle(String(settings.titleTemplate), {
				name: category.seo?.title || category.name,
				business: business.name,
			}),
			description,
			canonical: url,
			image,
			jsonLd: scriptJson(jsonLd),
		};
	};

	/** @param {any} ctx */
	const sitemap = async (ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const asked = ctx.query.page;
		const page = pageOf(asked);
		const filter = { websiteId: data.websiteId, status: 'active' };
		const [categories, products] = await Promise.all([
			data.collection(COLLECTIONS.categories).countDocuments({ websiteId: data.websiteId }),
			data.collection(COLLECTIONS.products).countDocuments(filter),
		]);
		const slice = sitemapSlice({ categories, products, page });
		if (page > slice.pages) throw problem('not_found', 'There is no such sitemap page.');
		if (slice.pages > 1 && (asked === undefined || asked === '')) {
			const { sitemapUrl } = await s.values('seo');
			const locs = Array.from({ length: slice.pages }, (_, index) => sitemapPageUrl(String(sitemapUrl), s.domain, index + 1));
			return new Response(sitemapIndex(locs), { headers: { 'content-type': 'application/xml; charset=utf-8' } });
		}
		async function* pieces() {
			yield SITEMAP_HEAD;
			if (slice.categories.limit > 0) {
				const rows = data
					.collection(COLLECTIONS.categories)
					.find({ websiteId: data.websiteId }, { projection: { _id: 0, id: 1, slug: 1, updatedAt: 1 } })
					.sort({ id: 1 })
					.skip(slice.categories.skip)
					.limit(slice.categories.limit)
					.batchSize(BATCH * 5);
				let chunk = '';
				for await (const row of rows) {
					chunk += sitemapEntry({ loc: await media.categoryUrl(s, /** @type {any} */ (row)), lastmod: row.updatedAt });
					if (chunk.length > CHUNK) {
						yield chunk;
						chunk = '';
					}
				}
				if (chunk) yield chunk;
			}
			if (slice.products.limit > 0) {
				const rows = data
					.collection(COLLECTIONS.products)
					.find(filter, { projection: { _id: 0, id: 1, slug: 1, updatedAt: 1 } })
					.sort({ id: 1 })
					.skip(slice.products.skip)
					.limit(slice.products.limit)
					.batchSize(BATCH * 5);
				let chunk = '';
				for await (const row of rows) {
					chunk += sitemapEntry({ loc: await media.productUrl(s, /** @type {any} */ (row)), lastmod: row.updatedAt });
					if (chunk.length > CHUNK) {
						yield chunk;
						chunk = '';
					}
				}
				if (chunk) yield chunk;
			}
			yield SITEMAP_FOOT;
		}
		return streamed(pieces(), 'application/xml; charset=utf-8');
	};

	/**
	 * The feed rows of every active product, in batches.
	 * @param {Site} s
	 */
	const feedBatches = async function* (s) {
		const data = await s.data();
		const [settings, categories, brands] = await Promise.all([s.values('feeds'), allCategories(data), brandNames(data)]);
		const byId = new Map(categories.map((category) => [category.id, category]));
		const withImages = settings.items !== 'all';
		const rows = data
			.collection(COLLECTIONS.products)
			.find(
				{
					websiteId: data.websiteId,
					status: 'active',
					...(withImages ? { 'media.0': { $exists: true } } : {}),
					...(settings.includeOutOfStock === false ? { inStock: true } : {}),
				},
				{ projection: LISTING_FIELDS },
			)
			.sort({ id: 1 })
			.batchSize(BATCH);
		let count = 0;
		/** @type {import('../core/feeds.js').FeedRow[]} */
		let batch = [];
		for await (const row of rows) {
			const item = /** @type {ProductRecord} */ (/** @type {unknown} */ (row));
			const primary = byId.get(item.categoryIds[0] ?? '');
			const image = (await media.mediaUrl(s, item.media[0]?.key)) ?? '';
			const made = feedRows(item, {
				link: await media.productUrl(s, item),
				image,
				brand: item.brandId ? (brands.get(item.brandId) ?? '') : '',
				productType: primary
					? lineage(primary, byId)
							.map((step) => step.name)
							.join(' > ')
					: '',
				currency: s.currency,
				graded: settings.gradedCondition,
				skuAs: settings.skuAs,
				includeOutOfStock: settings.includeOutOfStock !== false,
			}).slice(0, MAX_FEED_ROWS - count);
			count += made.length;
			batch.push(...made);
			if (batch.length >= BATCH) {
				yield batch;
				batch = [];
			}
			if (count >= MAX_FEED_ROWS) break;
		}
		if (batch.length > 0) yield batch;
	};

	/** @param {any} ctx */
	const googleFeed = async (ctx) => {
		const s = await service.site(ctx);
		const business = await s.business();
		async function* pieces() {
			yield googleHead({ title: business.name, link: `https://${s.domain}/`, description: business.name });
			for await (const batch of feedBatches(s)) yield batch.map(googleItem).join('');
			yield GOOGLE_FOOT;
		}
		return streamed(pieces(), 'application/xml; charset=utf-8');
	};

	/** @param {any} ctx */
	const metaFeed = async (ctx) => {
		const s = await service.site(ctx);
		async function* pieces() {
			yield META_HEADER;
			for await (const batch of feedBatches(s)) yield batch.map(metaLine).join('');
		}
		return streamed(pieces(), 'text/csv; charset=utf-8');
	};

	/** @param {any} ctx */
	const llmsTxt = async (ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const [settings, business, categories] = await Promise.all([s.values('llms_txt'), s.business(), allCategories(data)]);
		const count = Math.max(0, Math.min(200, Number(settings.products)));
		const top =
			count === 0
				? []
				: /** @type {ProductRecord[]} */ (
						await data
							.collection(COLLECTIONS.products)
							.find(
								{ websiteId: data.websiteId, status: 'active' },
								{ projection: { _id: 0, id: 1, slug: 1, name: 1, summary: 1, price: 1 } },
							)
							.sort({ sold: -1, publishedAt: -1, id: 1 })
							.limit(count)
							.toArray()
					);
		const ordered = treeOrder(categories).slice(0, MAX_LLMS_CATEGORIES);
		const policies = settings.policies === false ? null : await policiesOf(s);
		const text = buildLlmsTxt({
			name: business.name,
			description: String(settings.description),
			home: `https://${s.domain}/`,
			categories: await Promise.all(
				ordered.map(async (category) => ({
					name: category.name,
					url: await media.categoryUrl(s, category),
					description: category.seo?.description || category.description,
					depth: category.depth,
				})),
			),
			products: await Promise.all(
				top.map(async (item) => ({
					name: item.name,
					url: await media.productUrl(s, item),
					price: formatMoney(item.price, s.currency),
					summary: item.summary,
				})),
			),
			policies: policies
				? [
						{ title: 'Delivery', text: policies.shipping },
						{ title: 'Returns', text: policies.returns },
						{ title: 'Privacy', text: policies.privacy },
						{ title: 'Terms', text: policies.terms },
					]
				: [],
			headings: LLMS_HEADINGS,
		});
		return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
	};

	/** @param {any} ctx */
	const policies = async (ctx) => policiesOf(await service.site(ctx));

	const lookup = createChatLookup(product, service, media);

	return {
		routes: [
			defineRoute({
				method: 'GET',
				path: '/v1/seo/products/:ref',
				auth: 'server',
				feature: 'seo',
				rateLimit: SERVER_RATE,
				handler: productSeo,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/seo/categories/:ref',
				auth: 'server',
				feature: 'seo',
				rateLimit: SERVER_RATE,
				handler: categorySeo,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/seo/sitemap.xml',
				auth: 'server',
				feature: 'seo',
				rateLimit: SERVER_RATE,
				handler: sitemap,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/feeds/products.xml',
				auth: 'server',
				feature: 'feeds',
				rateLimit: SERVER_RATE,
				handler: googleFeed,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/feeds/products.csv',
				auth: 'server',
				feature: 'feeds',
				rateLimit: SERVER_RATE,
				handler: metaFeed,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/llms.txt',
				auth: 'server',
				feature: 'llms_txt',
				rateLimit: SERVER_RATE,
				handler: llmsTxt,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/shop/policies',
				auth: 'browser',
				feature: 'checkout',
				rateLimit: VISITOR_RATE,
				handler: policies,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/policies',
				auth: 'server',
				feature: 'checkout',
				rateLimit: SERVER_RATE,
				handler: policies,
			}),
			...lookup.routes,
		],
	};
};
