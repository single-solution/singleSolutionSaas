/**
 * Catalog SEO (meta and structured data, sitemaps), product feeds, llms.txt and llms-full.txt, the shop's policies,
 * landing and glossary pages (`./seo-landings.js`) and the lookups other products call (Chat's shop tools, the customer
 * orders of Accounts and Chat). Everything that must appear on the merchant's domain is served by the merchant's site
 * from these server-token routes (PLAN 0.4.10); the docs give the snippets. Only what shoppers may see is listed (PLAN
 * 0.8.10 E1); every link follows the URL templates (E13); slugs answer `moved` for the site's 308 (E13). Product
 * JSON-LD is a ProductGroup with its variants, conditions by grade, shipping and return policy, reviews and FAQs; the
 * sitemap becomes an index of files above `sitemapSize` addresses, with images (E16). Read-only.
 * @module
 */
import { defineRoute, problem } from '@ss/app-kit';
import { attributesOf, findBySlugHistory } from '../adapters/catalog-store.js';
import { mediaSignatureOk } from '../adapters/crypto.js';
import { htmlToText, siteAddress } from '../core/catalog-content.js';
import { lineageOf } from '../core/catalog-taxonomy.js';
import { specsOf } from '../core/catalog-views.js';
import { GOOGLE_FOOT, MAX_FEED_ROWS, META_HEADER, feedRows, googleHead, googleItem, metaLine } from '../core/feeds.js';
import { gradeCondition, gradesFor } from '../core/grades.js';
import { absolute } from '../core/links.js';
import { buildLlmsFull, buildLlmsTxt, MAX_LLMS_CATEGORIES, treeOrder } from '../core/llms.js';
import { SORTS, sortDocument } from '../core/catalog-query.js';
import { COLLECTIONS, ID_PREFIX } from '../core/model.js';
import { windowDays } from '../core/returns.js';
import { shownName } from '../core/reviews.js';
import {
	SITEMAP_FOOT,
	SITEMAP_HEAD,
	asWritten,
	categoryJsonLd,
	fillTemplate,
	metaDescription,
	pageName,
	pageTitle,
	patternText,
	productFacts,
	productJsonLd,
	robotsOf,
	scriptJson,
	sitemapEntry,
	sitemapFileUrl,
	sitemapFiles,
	sitemapIndex,
	variantLabel,
	writtenSummary,
} from '../core/seo.js';
import { createMedia } from './catalog-media.js';
import { hiddenFor, visible, visibleMatch } from './catalog-visibility.js';
import { createChatLookup } from './chat-lookup.js';
import { createAutoSeo } from './seo-auto.js';
import { createLandings } from './seo-landings.js';
import { policiesOf } from './policies.js';
import { SEO_LIMITS, VISITOR_LIMITS } from './service.js';
import { allCategories, brandNames, lineage, storeNameOf, streamed, trailOf } from './seo-reads.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('../core/model.js').ProductRecord} ProductRecord */
/** @typedef {import('../core/model.js').CategoryRecord} CategoryRecord */
/** @typedef {import('../core/model.js').VariantRecord} VariantRecord */
/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */

/**
 * The rate limits of these routes: the merchant's server reads them while rendering pages, so its own higher window
 * (SG-31). @type {Array<{ limit: number, windowSeconds: number, per?: 'website' | 'visitor' }>}
 */
const SERVER_RATE = [...SEO_LIMITS];
/** @type {Array<{ limit: number, windowSeconds: number, per?: 'website' | 'visitor' }>} */
const VISITOR_RATE = [...VISITOR_LIMITS];

/** At most this many images per product in structured data and sitemaps. */
const MAX_IMAGES = 10;
/** Sitemap text is sent in pieces of about this many characters. */
const CHUNK = 16_384;
/** Products are read in batches of this size while writing sitemaps and feeds. */
const BATCH = 200;
/** The signed link the media route answers lasts this long (the website fetches the file at once). */
const MEDIA_LINK_SECONDS = 300;
/** The longest storage key the media route takes. */
const MAX_KEY = 500;
/** Reviews shown as review nodes of a product. */
const REVIEW_NODES = 5;
/** Most products llms-full.txt reads. */
const MAX_FULL_PRODUCTS = 50_000;
/** The llms.txt section names (the llms.txt convention's structure, not shop wording). */
const LLMS_HEADINGS = Object.freeze({ categories: 'Categories', products: 'Products', policies: 'Policies', grades: 'Grades' });
/** The llms.txt names of the policies (the convention's structure). */
const POLICY_TITLES = Object.freeze({
	shipping: 'Delivery',
	returns: 'Returns',
	privacy: 'Privacy',
	terms: 'Terms',
	warranty: 'Warranty',
});

/** What the feeds and sitemaps read of a product. */
const LISTING_FIELDS = Object.freeze({
	_id: 0,
	id: 1,
	slug: 1,
	name: 1,
	kind: 1,
	summary: 1,
	description: 1,
	'seo.description': 1,
	categoryIds: 1,
	brandId: 1,
	media: 1,
	variants: 1,
	trackStock: 1,
	price: 1,
	priceMax: 1,
	inStock: 1,
	updatedAt: 1,
});

/**
 * The seo setting `defaultImage` as an absolute address (a path is on the website), or null without one: the social
 * image of a page without its own.
 * @param {Record<string, unknown>} settings the `seo` settings
 * @param {string} domain
 */
const defaultImageOf = (settings, domain) => {
	const address = siteAddress(settings.defaultImage);
	return address ? absolute(address, domain) : null;
};

/**
 * @param {Product} product
 * @param {Service} service
 * @returns {import('./routes.js').Area}
 */
export const createSeo = (product, service) => {
	const media = createMedia(product);
	const landings = createLandings(product, service, media);
	// SEO copy written when staff save a product or an attribute (E43)
	createAutoSeo(product, service, landings);

	/**
	 * The condition of a variant for structured data and feeds (E10), from the product's grades (the entries of its
	 * category or the nearest one above it first, E45).
	 * @param {Site} s @param {'used' | 'refurbished' | 'new'} graded
	 * @param {ReadonlyMap<string, CategoryRecord>} [known] every category by id, when the caller has read them
	 */
	const conditionsOf = async (s, graded, known) => {
		const list = s.has('grades_serials') ? await s.list('grades') : [];
		const categories =
			known ?? (list.length > 0 ? new Map((await allCategories(await s.data())).map((c) => [c.id, c])) : new Map());
		/** @type {Map<string, Map<string, import('../core/grades.js').Grade>>} the grades of each category list, read once */
		const read = new Map();
		/** @param {Pick<ProductRecord, 'categoryIds'>} item */
		const gradesOf = (item) => {
			const lineage = lineageOf(item.categoryIds, categories);
			const key = lineage.join(',');
			const found = read.get(key) ?? gradesFor(list, lineage);
			read.set(key, found);
			return found;
		};
		return {
			gradesOf,
			/** @param {Pick<ProductRecord, 'categoryIds'>} item @param {VariantRecord} variant */
			gradeOf: (item, variant) => (variant.grade ? gradesOf(item).get(variant.grade) : undefined),
			/** @param {Pick<ProductRecord, 'kind' | 'categoryIds'>} item @param {VariantRecord} variant */
			of: (item, variant) => gradeCondition(item, variant, gradesOf(item), graded),
		};
	};

	/**
	 * The delivery fee where no zone matches and the amount it is free from, to the business's country, for structured
	 * data and feeds (E16, E17, SG-2); null without delivery zones. No delivery days are kept yet, so structured data
	 * gives no shipping details (they need them; SEO audit G5.4).
	 * @param {Site} s
	 */
	const shippingOf = async (s) => {
		if (!s.has('delivery_zones')) return null;
		const [{ defaultFee, defaultFreeOver }, business] = await Promise.all([s.values('delivery_zones'), s.business()]);
		return {
			fee: Number(defaultFee ?? 0),
			freeOver: Number(defaultFreeOver ?? 0),
			country: String(business.country ?? ''),
			deliveryTime: null,
		};
	};

	/**
	 * Each item's return window for structured data (G5.1), with the business's country (no country: no policy), or
	 * null while Returns is off: physical goods as the cart decides it (the product's, else its grade's, else the
	 * `returns` setting); digital goods and bookings only when the product names its own (they are not claimed through
	 * returns).
	 * @param {Site} s @param {ProductRecord} item
	 * @param {{ gradeOf: (item: ProductRecord, variant: VariantRecord) => import('../core/grades.js').Grade | undefined }} conditions
	 * @param {string} country
	 */
	const returnsOf = async (s, item, conditions, country) => {
		if (!s.has('returns')) return null;
		const defaults = { returnDays: Number((await s.values('returns')).returnDays ?? 0), warrantyDays: 0 };
		return {
			country,
			/** @param {VariantRecord} variant */
			days: (variant) =>
				item.kind === 'physical'
					? windowDays('return', item, conditions.gradeOf(item, variant) ?? null, defaults)
					: item.returnDays,
		};
	};

	/**
	 * The addresses of a product's photos (at most {@link MAX_IMAGES}).
	 * @param {Site} s @param {ProductRecord} item
	 */
	const imagesOf = async (s, item) => {
		/** @type {string[]} */
		const out = [];
		for (const file of item.media.slice(0, MAX_IMAGES)) {
			const address = await media.stableUrl(s, file.key);
			if (address) out.push(address);
		}
		return out;
	};

	/**
	 * An active product shoppers may see by id, slug or an earlier slug; a `moved` answer, or 404 (E1, E13).
	 * @param {Site} s @param {WebsiteData} data @param {unknown} ref
	 * @returns {Promise<{ item: ProductRecord } | { moved: { kind: string, slug: string, url: string } }>}
	 */
	const productOf = async (s, data, ref) => {
		const found = typeof ref === 'string' ? await findBySlugHistory(data, COLLECTIONS.products, ref, ID_PREFIX.product) : null;
		const item = /** @type {ProductRecord | undefined} */ (found?.record);
		if (!found || !item) throw problem('not_found', 'There is no such product.');
		const hidden = await hiddenFor(s);
		if (item.status !== 'active') {
			const { retiredUrl } = await s.values('catalog');
			const [category] = /** @type {CategoryRecord[]} */ (
				await data
					.collection(COLLECTIONS.categories)
					.find({ websiteId: data.websiteId, id: item.categoryIds[0] ?? '' }, { projection: { _id: 0 } })
					.toArray()
			);
			if (item.status === 'archived' && retiredUrl === 'category' && category && !hidden.unlisted.has(category.id))
				return { moved: { kind: 'category', slug: category.slug, url: await media.categoryUrl(s, category) } };
			throw problem('not_found', 'There is no such product.');
		}
		if (!visible(item, hidden)) throw problem('not_found', 'There is no such product.');
		if (found.moved) return { moved: { kind: 'product', slug: item.slug, url: await media.productUrl(s, item) } };
		return { item };
	};

	/** GET /v1/seo/products/:ref. @param {any} ctx */
	const productSeo = async (ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const found = await productOf(s, data, ctx.params.ref);
		if ('moved' in found) return found;
		const { item } = found;
		const [settings, business, attributes, { money }] = await Promise.all([
			s.values('seo'),
			s.business(),
			attributesOf(data),
			s.format(),
		]);
		const url = await media.productUrl(s, item);
		const images = await imagesOf(s, item);
		const [primary] = /** @type {CategoryRecord[]} */ (
			await data
				.collection(COLLECTIONS.categories)
				.find({ websiteId: data.websiteId, id: item.categoryIds[0] ?? '' }, { projection: { _id: 0 } })
				.toArray()
		);
		const brand = item.brandId ? ((await brandNames(data, [item.brandId])).get(item.brandId) ?? null) : null;
		const conditions = await conditionsOf(s, settings.gradedCondition);
		// the merchant's patterns (SG-5, G6), with the product's facts as they are now: the page's part of the title, the
		// description when the product has none of its own nor a written summary, and the variants' names
		const names = {
			name: item.name,
			brand: brand ?? '',
			category: primary?.name ?? '',
			storeName: storeNameOf(settings, business),
			...productFacts(item, {
				money: (amount) => money(amount, s.currency),
				grades: conditions.gradesOf(item),
				specs: specsOf(item, new Map(attributes.map((attribute) => [attribute.id, attribute]))),
			}),
		};
		const description = metaDescription(
			asWritten(item.seo.description),
			writtenSummary(item.summary),
			patternText(settings.productDescription, names),
			item.description,
			asWritten(settings.defaultDescription),
		);
		const bySlug = new Map(attributes.map((row) => [String(row.id), { slug: row.slug ? String(row.slug) : undefined }]));
		/** @type {Map<string, string>} */
		const variantUrls = new Map();
		/** @type {Map<string, string | null>} */
		const variantImages = new Map();
		for (const variant of item.variants.filter((v) => v.active)) {
			variantUrls.set(variant.id, await media.variantUrl(s, item, variant, bySlug));
			variantImages.set(variant.id, variant.media?.[0] ? await media.stableUrl(s, variant.media[0].key) : null);
		}
		// reviewers are named as the reviews widget shows them (`nameFormat`), never by more (EN-2)
		const nameFormat = s.has('reviews') ? (await s.values('reviews')).nameFormat : 'full';
		const reviews = s.has('reviews')
			? await data
					.collection(COLLECTIONS.reviews)
					.find(
						{ websiteId: data.websiteId, productId: item.id, status: 'approved' },
						{ projection: { _id: 0, name: 1, rating: 1, title: 1, body: 1, createdAt: 1 } },
					)
					.sort({ createdAt: -1, id: -1 })
					.limit(REVIEW_NODES)
					.toArray()
			: [];
		const jsonLd = productJsonLd({
			product: item,
			url,
			images,
			description,
			brand,
			currency: s.currency,
			condition: (variant) => conditions.of(item, variant),
			seller: business.name,
			trail: await trailOf(s, data, media, primary ?? null, true, business.name),
			variantName: (variant) =>
				fillTemplate(String(settings.variantTitle), {
					name: item.name,
					brand: names.brand,
					options: variantLabel(variant),
					grade: conditions.gradeOf(item, variant)?.label ?? '',
				}),
			variantUrl: (variant) => variantUrls.get(variant.id) ?? url,
			variantImage: (variant) => variantImages.get(variant.id) ?? null,
			shipping: await shippingOf(s),
			returns: await returnsOf(s, item, conditions, String(business.country ?? '')),
			reviews: reviews.map((row) => ({
				name: shownName(String(row.name ?? ''), nameFormat),
				rating: Number(row.rating),
				title: String(row.title ?? ''),
				body: String(row.body ?? ''),
				at: row.createdAt ?? null,
			})),
			faqMarkup: settings.faqMarkup === true,
		});
		const ogImage = siteAddress(item.seo.ogImage);
		return {
			title: pageTitle(String(settings.titleTemplate), {
				own: item.seo.title,
				mode: item.seo.titleMode,
				name: pageName(settings.productTitle, names),
				business: names.storeName,
			}),
			description,
			canonical: item.seo.canonicalUrl ? absolute(item.seo.canonicalUrl, s.domain) : url,
			image: ogImage ? absolute(ogImage, s.domain) : (images[0] ?? defaultImageOf(settings, s.domain)),
			robots: robotsOf(item.seo),
			focusKeyword: item.seo.focusKeyword,
			jsonLd: scriptJson(jsonLd),
		};
	};

	/** GET /v1/seo/categories/:ref. @param {any} ctx */
	const categorySeo = async (ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const found =
			typeof ctx.params.ref === 'string'
				? await findBySlugHistory(data, COLLECTIONS.categories, ctx.params.ref, ID_PREFIX.category)
				: null;
		const category = /** @type {CategoryRecord | undefined} */ (found?.record);
		const hidden = await hiddenFor(s);
		if (!found || !category || hidden.unlisted.has(category.id)) throw problem('not_found', 'There is no such category.');
		if (found.moved) return { moved: { kind: 'category', slug: category.slug, url: await media.categoryUrl(s, category) } };
		const [settings, business, categories, { pageSize }] = await Promise.all([
			s.values('seo'),
			s.business(),
			allCategories(data),
			s.values('catalog'),
		]);
		const url = await media.categoryUrl(s, category);
		const image = category.image ? await media.stableUrl(s, category.image.key) : null;
		const parent = categories.find((c) => c.id === category.path.at(-1));
		const names = { name: category.name, category: parent?.name ?? '', storeName: storeNameOf(settings, business) };
		const description = metaDescription(
			asWritten(category.seo.description),
			patternText(settings.categoryDescription, names),
			category.content.summary,
			category.description,
			asWritten(settings.defaultDescription),
			category.name,
		);
		const below = categories.filter((c) => c.id === category.id || c.path.includes(category.id)).map((c) => c.id);
		const comingSoon = hidden.categoryIds.includes(category.id);
		const items = comingSoon
			? []
			: await data
					.collection(COLLECTIONS.products)
					.find(
						{ websiteId: data.websiteId, status: 'active', categoryIds: { $in: below }, ...visibleMatch(hidden) },
						{ projection: { _id: 0, id: 1, slug: 1, name: 1, categoryIds: 1, brandId: 1 } },
					)
					// the products of the category page's first page, as the grid shows them (newest first)
					.sort(sortDocument(/** @type {import('../core/catalog-query.js').Sort} */ (SORTS.newest)))
					.limit(Number(pageSize))
					.toArray();
		const canonical = category.seo.canonicalUrl ? absolute(category.seo.canonicalUrl, s.domain) : url;
		const jsonLd = categoryJsonLd({
			name: category.name,
			description,
			url,
			image,
			trail: await trailOf(s, data, media, category, false, business.name),
			items: await Promise.all(
				items.map(async (row) => ({ name: String(row.name), url: await media.productUrl(s, /** @type {any} */ (row)) })),
			),
			faqs: settings.faqMarkup === true ? category.faqs : [],
		});
		const ogImage = siteAddress(category.seo.ogImage);
		return {
			title: pageTitle(String(settings.titleTemplate), {
				own: category.seo.title,
				mode: category.seo.titleMode,
				name: pageName(settings.categoryTitle, names),
				business: names.storeName,
			}),
			description,
			canonical,
			image: ogImage ? absolute(ogImage, s.domain) : (image ?? defaultImageOf(settings, s.domain)),
			robots: comingSoon ? 'noindex, follow' : robotsOf(category.seo),
			status: comingSoon ? 'coming_soon' : 'active',
			jsonLd: scriptJson(jsonLd),
		};
	};

	/**
	 * What a sitemap lists, for one website and request (E1, E16): categories shoppers see, indexable landing and
	 * glossary pages, and active, visible products, leaving out pages marked noindex and pages whose canonical address
	 * is another page (G8; those are left out while the parts are written, so the counts that split the files may
	 * count them).
	 * @param {Site} s
	 */
	const sitemapParts = async (s) => {
		const data = await s.data();
		const hidden = await hiddenFor(s);
		const categoryFilter = {
			websiteId: data.websiteId,
			...(hidden.categoryIds.length > 0 ? { id: { $nin: hidden.categoryIds } } : {}),
			'seo.noindex': { $ne: true },
		};
		const productFilter = {
			websiteId: data.websiteId,
			status: 'active',
			...visibleMatch(hidden),
			'seo.noindex': { $ne: true },
		};
		const [categories, products, pages, { sitemapSize, sitemapUrl }] = await Promise.all([
			data.collection(COLLECTIONS.categories).countDocuments(categoryFilter),
			data.collection(COLLECTIONS.products).countDocuments(productFilter),
			landings.sitemapPages(s, data),
			s.values('seo'),
		]);
		return {
			data,
			categoryFilter,
			productFilter,
			counts: { categories, landings: pages.length, products },
			pages,
			size: Math.max(1000, Math.min(50_000, Number(sitemapSize) || 10_000)),
			sitemapUrl: String(sitemapUrl),
		};
	};

	/**
	 * The addresses of one part of a sitemap.
	 * @param {Site} s
	 * @param {Awaited<ReturnType<typeof sitemapParts>>} parts
	 * @param {'categories' | 'landings' | 'products'} part
	 * @param {{ skip: number, limit: number }} [range] products only
	 */
	async function* entriesOf(s, parts, part, range = { skip: 0, limit: 0 }) {
		const { data } = parts;
		/**
		 * Whether a page names itself as canonical (no canonical of its own, or its own address).
		 * @param {{ seo?: { canonicalUrl?: string } }} record @param {string} loc
		 */
		const canonical = (record, loc) => !record.seo?.canonicalUrl || absolute(record.seo.canonicalUrl, s.domain) === loc;
		if (part === 'landings') {
			yield parts.pages.map((page) => sitemapEntry(page)).join('');
			return;
		}
		const rows =
			part === 'categories'
				? data
						.collection(COLLECTIONS.categories)
						.find(parts.categoryFilter, { projection: { _id: 0, id: 1, slug: 1, updatedAt: 1, 'seo.canonicalUrl': 1 } })
						.sort({ id: 1 })
						.batchSize(BATCH * 5)
				: data
						.collection(COLLECTIONS.products)
						.find(parts.productFilter, {
							projection: {
								_id: 0,
								id: 1,
								slug: 1,
								categoryIds: 1,
								brandId: 1,
								updatedAt: 1,
								'seo.canonicalUrl': 1,
								media: { $slice: MAX_IMAGES },
								'variants.media.key': 1,
							},
						})
						.sort({ id: 1 })
						.skip(range.skip)
						.limit(range.limit)
						.batchSize(BATCH * 5);
		let chunk = '';
		for await (const row of rows) {
			const record = /** @type {any} */ (row);
			if (part === 'categories') {
				const loc = await media.categoryUrl(s, record);
				if (canonical(record, loc)) chunk += sitemapEntry({ loc, lastmod: record.updatedAt });
			} else {
				const loc = await media.productUrl(s, record);
				if (!canonical(record, loc)) continue;
				// the product's photos, then its variants' (E6), each once
				const keys = [
					...new Set([
						...(record.media ?? []).map((/** @type {any} */ file) => file.key),
						...(record.variants ?? []).flatMap((/** @type {any} */ variant) =>
							(variant.media ?? []).map((/** @type {any} */ file) => file.key),
						),
					]),
				].slice(0, MAX_IMAGES);
				/** @type {string[]} */
				const images = [];
				for (const key of keys) {
					const address = await media.stableUrl(s, key);
					if (address) images.push(address);
				}
				chunk += sitemapEntry({ loc, lastmod: record.updatedAt, images });
			}
			if (chunk.length > CHUNK) {
				yield chunk;
				chunk = '';
			}
		}
		if (chunk) yield chunk;
	}

	/**
	 * GET /v1/seo/sitemap.xml: one sitemap, or an index of files above `sitemapSize` addresses (E16).
	 * @param {any} ctx
	 */
	const sitemap = async (ctx) => {
		const s = await service.site(ctx);
		const parts = await sitemapParts(s);
		const total = parts.counts.categories + parts.counts.landings + parts.counts.products;
		if (total > parts.size) {
			const files = sitemapFiles({ ...parts.counts, size: parts.size });
			return new Response(sitemapIndex(files.map((file) => sitemapFileUrl(parts.sitemapUrl, s.domain, file))), {
				headers: { 'content-type': 'application/xml; charset=utf-8' },
			});
		}
		async function* pieces() {
			yield SITEMAP_HEAD;
			yield* entriesOf(s, parts, 'categories');
			yield* entriesOf(s, parts, 'landings');
			yield* entriesOf(s, parts, 'products', { skip: 0, limit: parts.counts.products });
			yield SITEMAP_FOOT;
		}
		return streamed(pieces(), 'application/xml; charset=utf-8');
	};

	/**
	 * GET /v1/seo/sitemaps/:file: one file of a sitemap index (`categories`, `landings`, `products-<n>`).
	 * @param {any} ctx
	 */
	const sitemapFile = async (ctx) => {
		const s = await service.site(ctx);
		const file = String(ctx.params.file).replace(/\.xml$/, '');
		const parts = await sitemapParts(s);
		const files = sitemapFiles({ ...parts.counts, size: parts.size });
		if (!files.includes(file)) throw problem('not_found', 'There is no such sitemap file.');
		const number = /^products-(\d+)$/.exec(file);
		async function* pieces() {
			yield SITEMAP_HEAD;
			if (number) yield* entriesOf(s, parts, 'products', { skip: (Number(number[1]) - 1) * parts.size, limit: parts.size });
			else yield* entriesOf(s, parts, /** @type {'categories' | 'landings'} */ (file));
			yield SITEMAP_FOOT;
		}
		return streamed(pieces(), 'application/xml; charset=utf-8');
	};

	/**
	 * The feed rows of every active product shoppers may see, in batches (E17).
	 * @param {Site} s
	 */
	const feedBatches = async function* (s) {
		const data = await s.data();
		const [settings, categories, brands, hidden, seo, format, attributes] = await Promise.all([
			s.values('feeds'),
			allCategories(data),
			brandNames(data),
			hiddenFor(s),
			s.has('seo') ? s.values('seo') : Promise.resolve({}),
			s.format(),
			data
				.collection(COLLECTIONS.attributes)
				.find({ websiteId: data.websiteId }, { projection: { _id: 0, id: 1, slug: 1 } })
				.toArray(),
		]);
		const byId = new Map(categories.map((category) => [category.id, category]));
		const conditions = await conditionsOf(
			s,
			settings.gradedCondition ?? /** @type {any} */ (seo).gradedCondition ?? 'used',
			byId,
		);
		const shipping = await shippingOf(s);
		const bySlug = new Map(attributes.map((row) => [String(row.id), { slug: row.slug ? String(row.slug) : undefined }]));
		const withImages = settings.items !== 'all';
		const rows = data
			.collection(COLLECTIONS.products)
			.find(
				{
					websiteId: data.websiteId,
					status: 'active',
					...visibleMatch(hidden),
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
			const image = (await media.stableUrl(s, item.media[0]?.key)) ?? '';
			/** @type {Map<string, { link: string, image: string }>} */
			const perVariant = new Map();
			for (const variant of item.variants.filter((v) => v.active))
				perVariant.set(variant.id, {
					link: await media.variantUrl(s, item, variant, bySlug),
					image: variant.media?.[0] ? ((await media.stableUrl(s, variant.media[0].key)) ?? '') : '',
				});
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
				condition: (variant) => conditions.of(item, variant),
				skuAs: settings.skuAs,
				includeOutOfStock: settings.includeOutOfStock !== false,
				googleCategory: String(settings.googleCategory ?? ''),
				gradeLabel: (variant) => (settings.gradeLabel === true ? (conditions.gradeOf(item, variant)?.label ?? '') : ''),
				shipping,
				title: String(settings.itemTitle ?? ''),
				description: settings.itemDescription === 'seo' ? 'seo' : 'body',
				identifierExists: settings.identifierExists === 'no' ? 'no' : 'auto',
				wholeUnits: format.format.wholeUnits === true,
				variantLink: (variant) => perVariant.get(variant.id)?.link ?? '',
				variantImage: (variant) => perVariant.get(variant.id)?.image ?? '',
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

	/**
	 * The categories shoppers see, in tree order.
	 * @param {Site} s @param {WebsiteData} data
	 */
	const shownCategories = async (s, data) => {
		const hidden = await hiddenFor(s);
		return treeOrder((await allCategories(data)).filter((category) => !hidden.categoryIds.includes(category.id)));
	};

	/** @param {any} ctx */
	const llmsTxt = async (ctx) => {
		const s = await service.site(ctx);
		const data = await s.data();
		const [settings, business, { money }, hidden] = await Promise.all([
			s.values('llms_txt'),
			s.business(),
			s.format(),
			hiddenFor(s),
		]);
		const count = Math.max(0, Math.min(200, Number(settings.products)));
		const top =
			count === 0
				? []
				: /** @type {ProductRecord[]} */ (
						await data
							.collection(COLLECTIONS.products)
							.find(
								{ websiteId: data.websiteId, status: 'active', ...visibleMatch(hidden) },
								{ projection: { _id: 0, id: 1, slug: 1, name: 1, summary: 1, price: 1, categoryIds: 1, brandId: 1 } },
							)
							.sort({ sold: -1, publishedAt: -1, id: 1 })
							.limit(count)
							.toArray()
					);
		const ordered = (await shownCategories(s, data)).slice(0, MAX_LLMS_CATEGORIES);
		const policies = settings.policies === false ? null : await policiesOf(s);
		const text = buildLlmsTxt({
			name: business.name,
			description: String(settings.description),
			home: `https://${s.domain}/`,
			categories: await Promise.all(
				ordered.map(async (category) => ({
					name: category.name,
					url: await media.categoryUrl(s, category),
					description: category.seo.description || category.description,
					depth: category.depth,
				})),
			),
			products: await Promise.all(
				top.map(async (item) => ({
					name: item.name,
					url: await media.productUrl(s, item),
					price: money(item.price, s.currency),
					summary: item.summary,
				})),
			),
			policies: policies
				? Object.entries(policies.policies).map(([key, value]) => ({
						title: POLICY_TITLES[/** @type {keyof typeof POLICY_TITLES} */ (key)],
						text: policies.format === 'html' ? htmlToText(String(value)) : String(value),
					}))
				: [],
			headings: LLMS_HEADINGS,
		});
		return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
	};

	/**
	 * GET /v1/llms-full.txt (E16): every product in stock with its price range, by category with its grades; served
	 * while the `llms_txt` setting `full` is on.
	 * @param {any} ctx
	 */
	const llmsFull = async (ctx) => {
		const s = await service.site(ctx);
		const settings = await s.values('llms_txt');
		if (settings.full !== true) throw problem('not_found', 'Switch on the full list in the llms.txt settings first.');
		const data = await s.data();
		const [business, { money }, hidden, ordered] = await Promise.all([
			s.business(),
			s.format(),
			hiddenFor(s),
			shownCategories(s, data),
		]);
		const gradeList = s.has('grades_serials') ? await s.list('grades') : [];
		const byCategoryId = new Map(ordered.map((category) => [category.id, category]));
		/** @type {Map<string, Array<{ name: string, url: string, price: string }>>} */
		const byCategory = new Map();
		const rows = data
			.collection(COLLECTIONS.products)
			.find(
				{ websiteId: data.websiteId, status: 'active', inStock: true, ...visibleMatch(hidden) },
				{ projection: { _id: 0, id: 1, slug: 1, name: 1, price: 1, priceMax: 1, categoryIds: 1, brandId: 1 } },
			)
			.sort({ name: 1, id: 1 })
			.limit(MAX_FULL_PRODUCTS)
			.batchSize(BATCH * 5);
		for await (const row of rows) {
			const item = /** @type {ProductRecord} */ (/** @type {unknown} */ (row));
			const low = money(item.price, s.currency);
			const high = item.priceMax !== undefined && item.priceMax > item.price ? money(item.priceMax, s.currency) : '';
			const key = item.categoryIds[0] ?? '';
			byCategory.set(key, [
				...(byCategory.get(key) ?? []),
				{ name: item.name, url: await media.productUrl(s, item), price: high ? `${low} – ${high}` : low },
			]);
		}
		const sections = await Promise.all(
			ordered.map(async (category) => ({
				name: category.name,
				url: await media.categoryUrl(s, category),
				// the grades as the category (or the nearest one above it) defines them (E45)
				grades: [...gradesFor(gradeList, lineageOf([category.id], byCategoryId)).values()]
					.filter(
						(grade) =>
							grade.active &&
							(grade.categoryIds.length === 0 ||
								grade.categoryIds.some((id) => id === category.id || category.path.includes(id))),
					)
					.map((grade) => grade.label),
				products: byCategory.get(category.id) ?? [],
			})),
		);
		const loose = [...byCategory.entries()]
			.filter(([id]) => !ordered.some((category) => category.id === id))
			.flatMap(([, list]) => list);
		const text = buildLlmsFull({
			name: business.name,
			description: String(settings.description),
			home: `https://${s.domain}/`,
			sections: [...sections, { name: LLMS_HEADINGS.products, url: null, grades: [], products: loose }],
			headings: { grades: LLMS_HEADINGS.grades },
		});
		return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
	};

	/**
	 * GET /v1/media?key=&signature= (G1): a fresh signed link (5 minutes) to a catalog file whose stable address
	 * Ecommerce gave (its signature matches the key), for the website's media route to fetch and serve; 404 for any other
	 * key, so no other file of the bucket can be read through it.
	 * @param {any} ctx
	 */
	const mediaFile = async (ctx) => {
		const s = await service.site(ctx);
		const key = typeof ctx.query.key === 'string' ? ctx.query.key : '';
		if (!key || key.length > MAX_KEY || !mediaSignatureOk(await product.secrets.get(s.websiteId), key, ctx.query.signature))
			throw problem('not_found', 'There is no such file.');
		const storage = await product.connections.storage(s.websiteId);
		if (!storage) throw problem('storage_not_connected', 'Connect your storage first (Connections).');
		const signed = storage.presignGet({ key, expiresIn: MEDIA_LINK_SECONDS });
		return { url: signed.url, expiresAt: signed.expiresAt };
	};

	/** GET /v1/policies and /v1/shop/policies: `{ format, <policy>… }`, empty ones left out (E3). @param {any} ctx */
	const policies = async (ctx) => {
		const { format, policies: filled } = await policiesOf(await service.site(ctx));
		return { format, ...filled };
	};

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
				path: '/v1/seo/sitemaps/:file',
				auth: 'server',
				feature: 'seo',
				rateLimit: SERVER_RATE,
				handler: sitemapFile,
			}),
			defineRoute({
				method: 'GET',
				path: '/v1/media',
				auth: 'server',
				feature: 'catalog',
				rateLimit: SERVER_RATE,
				handler: mediaFile,
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
				path: '/v1/llms-full.txt',
				auth: 'server',
				feature: 'llms_txt',
				rateLimit: SERVER_RATE,
				handler: llmsFull,
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
			...landings.routes,
			...lookup.routes,
		],
	};
};
