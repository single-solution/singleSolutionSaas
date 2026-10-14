/**
 * Landing pages, listing SEO and glossary pages (PLAN 0.8.10 E15). Landing pages (feature `landing_pages`) are a
 * category, brand and grade combination with its own copy; with the setting `auto` (E43) every category and brand
 * (and grade) combination with enough products and variants in stock is an automatic landing page without a record,
 * its copy from the patterns `autoTitle` and `autoDescription` (a stored landing page wins), in the listing reads and
 * the sitemaps (judged on read: one aggregation per read, never stored); for the merchant's server (`/v1/landings…`, server token)
 * and the catalog admin widget (`/v1/admin/landings…`, ticket with `catalog.edit`), with AI copy suggestions (with
 * `ai_copy`). `GET /v1/seo/listing` answers the heading, title, description, introduction, FAQs, canonical address,
 * JSON-LD and robots of any listing the site renders: `index` only for a category (and its pages, unless the `seo`
 * setting `pagedListings` says otherwise) and for an indexable landing page, `noindex` for any other filter. Glossary
 * pages explain an attribute or a grade, with the merchant's title and description patterns when they have no copy of
 * their own (SG-20), per category too (E45: `/v1/seo/attributes/:category/:slug` and `/v1/seo/grades/:category/:key`
 * read the category's own definition first, then the one for every category, and `{category}` in the address
 * templates is the category's slug). Indexable landing pages and glossary pages are listed in the sitemaps; once the
 * attribute address is set, every active attribute's page is (SG-20).
 * @module
 */
import { createId } from '@ss/contracts';
import { created, defineRoute, problem } from '@ss/app-kit';
import { NO_ID, attributesOf, brandsOf, categoriesOf, findBySlugHistory, isDuplicate } from '../adapters/catalog-store.js';
import { checkLandingAiRequest, landingPrompt, readSuggestions } from '../core/catalog-ai.js';
import { siteAddress } from '../core/catalog-content.js';
import { listOf, shopFilter } from '../core/catalog-query.js';
import { withDescendants } from '../core/catalog-taxonomy.js';
import {
	NO_STOCK,
	checkLanding,
	comboKey,
	comboStock,
	isAutomatic,
	isIndexable,
	landingFor,
	landingLink,
	stockOf,
	stockStages,
} from '../core/landings.js';
import { absolute } from '../core/links.js';
import { COLLECTIONS, ID_PREFIX } from '../core/model.js';
import {
	categoryJsonLd,
	faqJsonLd,
	fillTemplate,
	fillTitle,
	metaDescription,
	pageName,
	patternText,
	robotsOf,
	scriptJson,
} from '../core/seo.js';
import { gradesByKey, gradesFor } from '../core/grades.js';
import { hiddenFor } from './catalog-visibility.js';
import { SEO_LIMITS, SERVER_LIMITS } from './service.js';
import { storeNameOf, trailOf } from './seo-reads.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./catalog-media.js').Media} Media */
/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/model.js').LandingRecord} LandingRecord */
/** @typedef {import('../core/model.js').CategoryRecord} CategoryRecord */
/** @typedef {import('../core/model.js').BrandRecord} BrandRecord */
/** @typedef {import('../core/model.js').ProductRecord} ProductRecord */
/** @typedef {import('../core/grades.js').Grade} Grade */

/** @type {Array<{ limit: number, windowSeconds: number, per?: 'website' | 'visitor' }>} */
const RATE = [...SERVER_LIMITS];
/**
 * The reads the merchant's server makes while rendering pages: their own higher window (SG-31).
 * @type {Array<{ limit: number, windowSeconds: number, per?: 'website' | 'visitor' }>}
 */
const READ_RATE = [...SEO_LIMITS];
/** Values of an attribute a glossary pattern's `{values}` names. */
const PATTERN_VALUES = 5;
/** At most this many landing pages per website. */
const MAX_LANDINGS = 2000;
/** Products in a listing's ItemList. */
const LIST_ITEMS = 20;
/** Most combinations of a saved product looked at for an AI-written automatic landing page (E43). */
const MAX_AUTO_TRIES = 5;
/** Most rows of the stock of every combination (E43): products in stock, by grade. */
const MAX_STOCK_ROWS = 50_000;
/** Listing parameters that are not filters (they keep a category or landing page indexable). */
const NOT_FILTERS = new Set(['category', 'brand', 'grade', 'page', 'limit', 'cursor']);

/**
 * @param {Product} product
 * @param {Service} service
 * @param {Media} media
 */
export const createLandings = (product, service, media) => {
	/**
	 * What a landing page names, read once.
	 * @param {Site} s @param {WebsiteData} data
	 */
	const namesOf = async (s, data) => {
		const [categories, brands, gradeList] = await Promise.all([
			categoriesOf(data),
			brandsOf(data),
			s.has('grades_serials') ? s.list('grades') : Promise.resolve([]),
		]);
		return {
			categories,
			byCategory: new Map(categories.map((c) => [c.id, c])),
			byBrand: new Map(brands.map((b) => [b.id, b])),
			/** every grade key (a category's own entries only where no entry is for every category) */
			grades: /** @type {Map<string, Grade>} */ (gradesByKey(gradeList)),
			/**
			 * The grades as a category defines them, then the ones for every category (E45).
			 * @param {string | null} categoryId
			 */
			gradesIn: (categoryId) => /** @type {Map<string, Grade>} */ (gradesFor(gradeList, [categoryId])),
			gradeList: /** @type {Grade[]} */ (gradeList),
		};
	};

	/**
	 * The products of a listing (a category with those below it, a brand, a grade) shoppers may see.
	 * @param {Site} s @param {Awaited<ReturnType<typeof namesOf>>} names
	 * @param {{ categoryId: string | null, brandId: string | null, grade: string | null }} combination
	 * @param {boolean} inStock
	 */
	const filterOf = async (s, names, { categoryId, brandId, grade }, inStock) => ({
		websiteId: s.websiteId,
		...shopFilter(
			{
				q: '',
				category: null,
				brands: [],
				minPrice: null,
				maxPrice: null,
				inStock,
				attributes: [],
				grades: grade ? [grade] : [],
				sort: 'newest',
				featured: false,
				deal: null,
				page: null,
				count: false,
			},
			{
				categoryIds: categoryId ? withDescendants(categoryId, names.categories) : null,
				brandIds: brandId ? [brandId] : null,
				attributes: new Map(),
				hidden: await hiddenFor(s),
			},
		),
	});

	/**
	 * A landing page's address on the merchant's website.
	 * @param {Site} s @param {Awaited<ReturnType<typeof namesOf>>} names
	 * @param {{ categoryId: string | null, brandId: string | null, grade: string | null }} landing
	 */
	const urlOf = async (s, names, landing) => {
		const category = landing.categoryId ? names.byCategory.get(landing.categoryId) : undefined;
		const { landingUrl } = await s.values('landing_pages');
		return landingLink(
			String(landingUrl),
			{
				categoryUrl: category ? await media.categoryUrl(s, category) : '',
				category: category?.slug ?? '',
				brand: landing.brandId ? (names.byBrand.get(landing.brandId)?.slug ?? '') : '',
				grade: landing.grade ?? '',
			},
			s.domain,
		);
	};

	/**
	 * What a combination has in stock (shoppers may see): its products, their sellable variants (of the grade) and the
	 * lowest price, in one aggregation (E43, SG-10).
	 * @param {Site} s @param {WebsiteData} data @param {Awaited<ReturnType<typeof namesOf>>} names
	 * @param {{ categoryId: string | null, brandId: string | null, grade: string | null }} combination
	 */
	const stockOfCombo = async (s, data, names, combination) =>
		stockOf(
			await data
				.collection(COLLECTIONS.products)
				.aggregate([{ $match: await filterOf(s, names, combination, true) }, ...stockStages(combination.grade)], {
					maxTimeMS: 5000,
				})
				.toArray(),
		);

	/**
	 * The stock of every combination at once (E43): one aggregation over the products in stock.
	 * @param {Site} s @param {WebsiteData} data @param {Awaited<ReturnType<typeof namesOf>>} names
	 */
	const stockTable = async (s, data, names) =>
		comboStock(
			await data
				.collection(COLLECTIONS.products)
				.aggregate(
					[
						{ $match: await filterOf(s, names, { categoryId: null, brandId: null, grade: null }, true) },
						...stockStages(),
						{ $limit: MAX_STOCK_ROWS },
					],
					{ maxTimeMS: 10_000 },
				)
				.toArray(),
			(id) => names.byCategory.get(id)?.path ?? [],
		);

	/**
	 * The `landing_pages` settings that decide indexing (SG-10, E43): stored pages set to Automatic need
	 * `landingMinProducts` products in stock, automatic ones `autoMinProducts`; while `auto` is on, both also need
	 * `autoMinInStockVariants` variants in stock (off, stored pages are judged as before).
	 * @param {Site} s
	 */
	const rulesOf = async (s) => {
		const settings = await s.values('landing_pages');
		const mode = String(settings.auto ?? 'off');
		const minVariants = Number(settings.autoMinInStockVariants ?? 3);
		return {
			settings,
			mode,
			stored: { minProducts: Number(settings.landingMinProducts ?? 3), minVariants: mode === 'off' ? 0 : minVariants },
			auto: { minProducts: Number(settings.autoMinProducts ?? 2), minVariants },
		};
	};

	/**
	 * A landing page with its address, products and variants in stock and whether it is indexed now.
	 * @param {Site} s @param {WebsiteData} data @param {Awaited<ReturnType<typeof namesOf>>} names @param {LandingRecord} landing
	 * @param {import('../core/landings.js').ComboStock} [known] its stock when already read
	 */
	const viewOf = async (s, data, names, landing, known) => {
		const stock = known ?? (await stockOfCombo(s, data, names, landing));
		const { stored, auto, mode } = await rulesOf(s);
		// a page stored for a combination that is automatic is never indexed less than without it (E43)
		const minimum = isAutomatic(mode, landing)
			? { ...stored, minProducts: Math.min(stored.minProducts, auto.minProducts) }
			: stored;
		return {
			...landing,
			url: await urlOf(s, names, landing),
			inStock: stock.products,
			inStockVariants: stock.variants,
			indexed: isIndexable(landing, stock, minimum),
		};
	};

	/**
	 * The copy of an automatic landing page (E43): the `autoTitle` and `autoDescription` patterns with the names of its
	 * category, brand and grade, what is in stock and its lowest price.
	 * @param {Site} s
	 * @param {{ category: string, brand: string, grade: string, storeName: string }} names
	 * @param {import('../core/landings.js').ComboStock} stock
	 */
	const autoCopyOf = async (s, names, stock) => {
		const [{ settings }, { money }] = await Promise.all([rulesOf(s), s.format()]);
		const values = {
			...names,
			products: String(stock.products),
			variants: String(stock.variants),
			price: stock.minPrice === null ? '' : money(stock.minPrice, s.currency),
		};
		return {
			name:
				fillTemplate(String(settings.autoTitle ?? '{category} {brand} {grade}'), values) ||
				[names.category, names.brand, names.grade].filter(Boolean).join(' '),
			description: patternText(settings.autoDescription, values),
		};
	};

	/** @param {Array<{ path: string, message: string }>} errors */
	const refuse = (errors) =>
		problem('validation_failed', errors[0]?.message ?? 'The request is not valid.', {
			errors: errors.map((error) => ({ ...error, code: 'invalid' })),
		});

	/**
	 * Check what a landing page names exists.
	 * @param {Awaited<ReturnType<typeof namesOf>>} names @param {Omit<LandingRecord, 'id'>} value
	 */
	const checkNames = (names, value) => {
		if (value.categoryId && !names.byCategory.has(value.categoryId))
			throw refuse([{ path: '/categoryId', message: 'Pick an existing category.' }]);
		if (value.brandId && !names.byBrand.has(value.brandId))
			throw refuse([{ path: '/brandId', message: 'Pick an existing brand.' }]);
		if (value.grade && !names.grades.has(value.grade))
			throw refuse([{ path: '/grade', message: 'Pick a grade of your grades list.' }]);
	};

	/** @param {any} ctx */
	const open = async (ctx) => {
		const s = await service.site(ctx);
		return { s, data: await s.data() };
	};

	/**
	 * A landing page by id, or 404.
	 * @param {WebsiteData} data @param {string} id
	 * @returns {Promise<LandingRecord>}
	 */
	const landingOf = async (data, id) => {
		const found = await data.collection(COLLECTIONS.landings).findOne({ websiteId: data.websiteId, id }, NO_ID);
		if (!found) throw problem('not_found', 'There is no such landing page.');
		return /** @type {LandingRecord} */ (/** @type {unknown} */ (found));
	};

	/** @param {unknown} error */
	const clash = (error) =>
		isDuplicate(error) ? problem('conflict', 'A landing page for this category, brand and grade already exists.') : error;

	const landings = {
		/** GET ?category=&brand=&grade=&q=. @param {any} ctx */
		list: async (ctx) => {
			const { s, data } = await open(ctx);
			const names = await namesOf(s, data);
			/** @type {Record<string, unknown>} */
			const filter = { websiteId: data.websiteId };
			if (ctx.query.category) filter.categoryId = String(ctx.query.category);
			if (ctx.query.brand) filter.brandId = String(ctx.query.brand);
			if (ctx.query.grade) filter.grade = String(ctx.query.grade);
			const rows = /** @type {LandingRecord[]} */ (
				await data.collection(COLLECTIONS.landings).find(filter, NO_ID).sort({ id: 1 }).limit(MAX_LANDINGS).toArray()
			);
			const q = String(ctx.query.q ?? '')
				.trim()
				.toLowerCase();
			const shown = q
				? rows.filter((row) =>
						[
							row.h1,
							row.title,
							names.byCategory.get(row.categoryId ?? '')?.name,
							names.byBrand.get(row.brandId ?? '')?.name,
						]
							.filter(Boolean)
							.some((text) => String(text).toLowerCase().includes(q)),
					)
				: rows;
			// several pages: the stock of every combination in one aggregation (E43)
			const table = shown.length > 1 ? await stockTable(s, data, names) : null;
			return {
				items: await Promise.all(
					shown.map((row) => viewOf(s, data, names, row, table ? (table.get(comboKey(row)) ?? NO_STOCK) : undefined)),
				),
			};
		},
		/** @param {any} ctx */
		read: async (ctx) => {
			const { s, data } = await open(ctx);
			return viewOf(s, data, await namesOf(s, data), await landingOf(data, String(ctx.params.id)));
		},
		/** @param {any} ctx */
		create: async (ctx) => {
			const { s, data } = await open(ctx);
			const checked = checkLanding(ctx.body, null);
			if (!checked.ok) throw refuse(checked.errors);
			const names = await namesOf(s, data);
			checkNames(names, checked.value);
			if ((await data.collection(COLLECTIONS.landings).countDocuments({ websiteId: data.websiteId })) >= MAX_LANDINGS)
				throw problem('conflict', `A website has at most ${MAX_LANDINGS} landing pages.`);
			/** @type {LandingRecord} */
			const record = { id: createId(ID_PREFIX.landing), ...checked.value };
			await data
				.collection(COLLECTIONS.landings)
				.insertOne({ ...record })
				.catch((error) => {
					throw clash(error);
				});
			await service.log(ctx, 'landing.created', record.id, { label: record.h1 || record.title || record.id });
			// read back, so the answer has its times like every other read
			return created(await viewOf(s, data, names, await landingOf(data, record.id)));
		},
		/** @param {any} ctx */
		update: async (ctx) => {
			const { s, data } = await open(ctx);
			const existing = await landingOf(data, String(ctx.params.id));
			const checked = checkLanding(ctx.body, existing);
			if (!checked.ok) throw refuse(checked.errors);
			const names = await namesOf(s, data);
			checkNames(names, checked.value);
			await data
				.collection(COLLECTIONS.landings)
				.updateOne({ websiteId: data.websiteId, id: existing.id }, { $set: checked.value })
				.catch((error) => {
					throw clash(error);
				});
			await service.log(ctx, 'landing.updated', existing.id, {
				label: checked.value.h1 || checked.value.title || existing.id,
			});
			return viewOf(s, data, names, await landingOf(data, existing.id));
		},
		/** @param {any} ctx */
		remove: async (ctx) => {
			const { data } = await open(ctx);
			const existing = await landingOf(data, String(ctx.params.id));
			await data.collection(COLLECTIONS.landings).deleteOne({ websiteId: data.websiteId, id: existing.id });
			await service.log(ctx, 'landing.deleted', existing.id, { label: existing.h1 || existing.title || existing.id });
			return undefined;
		},
		/** POST …/ai-copy `{ fields?, tone?, language? }` → `{ suggestions }`. @param {any} ctx */
		aiCopy: async (ctx) => {
			const request = checkLandingAiRequest(ctx.body);
			if (!request.ok) throw refuse([{ path: request.path, message: request.message }]);
			const { s, data } = await open(ctx);
			if (!s.has('landing_pages')) throw problem('feature_off', 'Landing pages are switched off.');
			const landing = await landingOf(data, String(ctx.params.id));
			const connection = await product.connections.value(s.websiteId, 'ai');
			if (!connection) throw problem('ai_not_connected', 'Connect your AI provider first (Connections).');
			const names = await namesOf(s, data);
			const sample = await data
				.collection(COLLECTIONS.products)
				.find(await filterOf(s, names, landing, false), { projection: { _id: 0, name: 1 } })
				.sort({ sold: -1, id: 1 })
				.limit(20)
				.toArray();
			const settings = await s.values('ai_copy');
			const { system, prompt, limits } = landingPrompt(
				{
					category: landing.categoryId ? (names.byCategory.get(landing.categoryId)?.name ?? null) : null,
					brand: landing.brandId ? (names.byBrand.get(landing.brandId)?.name ?? null) : null,
					grade: landing.grade ? (names.gradesIn(landing.categoryId).get(landing.grade)?.label ?? landing.grade) : null,
					products: sample.map((row) => String(row.name)),
				},
				{
					fields: request.value.fields,
					tone: request.value.tone || String(settings.tone ?? ''),
					language: request.value.language || String(settings.language ?? ''),
				},
			);
			const answer = await product.ai.write(connection, { system, prompt, maxTokens: 1500 });
			if (!answer.ok)
				throw problem(
					answer.code === 'not_connected' ? 'ai_not_connected' : 'ai_failed',
					answer.code === 'rate_limited' ? 'The AI provider is busy: try again soon.' : 'The AI provider did not answer.',
				);
			const suggestions = readSuggestions(answer.text, request.value.fields, limits);
			if (!suggestions) throw problem('ai_failed', 'The AI provider gave no usable text.');
			return { suggestions };
		},
	};

	/**
	 * GET /v1/seo/listing?category=&brand=&grade=&page=&…: what a listing page puts in its head (E15).
	 * @param {any} ctx
	 */
	const listing = async (ctx) => {
		const { s, data } = await open(ctx);
		const names = await namesOf(s, data);
		const [settings, business, hidden] = await Promise.all([s.values('seo'), s.business(), hiddenFor(s)]);
		/** @type {CategoryRecord | null} */
		let category = null;
		if (ctx.query.category) {
			const found = await findBySlugHistory(data, COLLECTIONS.categories, String(ctx.query.category), ID_PREFIX.category);
			const record = /** @type {CategoryRecord | undefined} */ (found?.record);
			if (!found || !record || hidden.unlisted.has(record.id)) throw problem('not_found', 'There is no such category.');
			if (found.moved) return { moved: { kind: 'category', slug: record.slug, url: await media.categoryUrl(s, record) } };
			category = record;
		}
		const brandRefs = listOf(ctx.query.brand);
		const gradeKeys = listOf(ctx.query.grade);
		const brand =
			brandRefs.length === 1
				? ([...names.byBrand.values()].find((b) => b.id === brandRefs[0] || b.slug === brandRefs[0]) ?? null)
				: null;
		// a grade as the category defines it, then the one for every category (E45)
		const grade =
			gradeKeys.length === 1 ? (names.gradesIn(category?.id ?? null).get(/** @type {string} */ (gradeKeys[0])) ?? null) : null;
		const page = /^\d{1,3}$/.test(String(ctx.query.page ?? '')) ? Math.max(1, Number(ctx.query.page)) : 1;
		const otherFilters = Object.keys(ctx.query).some((key) => !NOT_FILTERS.has(key) && ctx.query[key] !== '');
		const exact =
			!otherFilters &&
			brandRefs.length === (brand ? 1 : 0) &&
			gradeKeys.length === (grade ? 1 : 0) &&
			(brand === null || brand.status !== 'hidden');
		const combination = { categoryId: category?.id ?? null, brandId: brand?.id ?? null, grade: grade?.key ?? null };
		const landing =
			exact && s.has('landing_pages') && (brand || grade)
				? landingFor(
						/** @type {LandingRecord[]} */ (
							await data
								.collection(COLLECTIONS.landings)
								.find({ websiteId: data.websiteId, ...combination }, NO_ID)
								.limit(1)
								.toArray()
						),
						combination,
					)
				: null;
		const view = landing ? await viewOf(s, data, names, landing) : null;
		const storeName = storeNameOf(settings, business);
		// no stored page: an automatic one while the combination has enough in stock (E43)
		const rules = await rulesOf(s);
		const shown = category === null || !hidden.categoryIds.includes(category.id);
		const autoStock =
			!landing && exact && shown && s.has('landing_pages') && isAutomatic(rules.mode, combination)
				? await stockOfCombo(s, data, names, combination)
				: null;
		const automatic =
			autoStock && isIndexable({ indexable: 'auto' }, autoStock, rules.auto)
				? {
						url: await urlOf(s, names, combination),
						stock: autoStock,
						copy: await autoCopyOf(
							s,
							{ category: category?.name ?? '', brand: brand?.name ?? '', grade: grade?.label ?? '', storeName },
							autoStock,
						),
					}
				: null;
		const categoryIndexable =
			category !== null &&
			!hidden.categoryIds.includes(category.id) &&
			!category.seo.noindex &&
			brand === null &&
			grade === null &&
			exact;
		const indexed = categoryIndexable || (view?.indexed === true && exact) || automatic !== null;
		const pageUrl = view
			? view.url
			: automatic
				? automatic.url
				: category
					? await media.categoryUrl(s, category)
					: `https://${s.domain}/`;
		const canonicalBase =
			category?.seo.canonicalUrl && !view && !automatic ? absolute(category.seo.canonicalUrl, s.domain) : pageUrl;
		// pages after the first: indexed with their own address, or not indexed with the first page as canonical (SG-21)
		const pagedOut = page > 1 && settings.pagedListings === 'noindex';
		const canonical =
			page > 1 && !pagedOut ? `${canonicalBase}${canonicalBase.includes('?') ? '&' : '?'}page=${page}` : canonicalBase;
		const h1 =
			landing?.h1 ||
			automatic?.copy.name ||
			[category?.name, brand?.name, grade?.label].filter(Boolean).join(' ') ||
			business.name;
		// a category's own page takes the merchant's category patterns (SG-5, SG-21)
		const own = category && !brand && !grade && !landing ? category : null;
		const parent = own ? names.byCategory.get(own.path.at(-1) ?? '') : undefined;
		const patternNames = { name: own?.name ?? '', category: parent?.name ?? '', storeName };
		const title = fillTitle(String(settings.titleTemplate), {
			name:
				landing?.title ||
				automatic?.copy.name ||
				(category && !brand && !grade ? category.seo.title : '') ||
				(own ? pageName(settings.categoryTitle, patternNames) : '') ||
				h1,
			business: storeName,
		});
		const description = metaDescription(
			landing?.description,
			automatic?.copy.description,
			category?.seo.description,
			own ? patternText(settings.categoryDescription, patternNames) : '',
			category?.content?.summary,
			category?.description,
			brand?.seo.description,
			brand?.description,
			settings.defaultDescription,
		);
		const intro = landing?.intro || category?.content?.summary || category?.description || '';
		const faqs = landing ? landing.faqs : (category?.faqs ?? []);
		const items = await data
			.collection(COLLECTIONS.products)
			.find(await filterOf(s, names, combination, false), {
				projection: { _id: 0, id: 1, slug: 1, name: 1, categoryIds: 1, brandId: 1 },
			})
			.sort({ publishedAt: -1, id: -1 })
			.limit(LIST_ITEMS)
			.toArray();
		const image = category?.image ? await media.mediaUrl(s, category.image.key) : siteAddress(settings.defaultImage) || null;
		const jsonLd = categoryJsonLd({
			name: h1,
			description,
			url: canonical,
			image: image ? absolute(image, s.domain) : null,
			trail: await trailOf(s, data, media, category, view !== null || automatic !== null, business.name),
			items: await Promise.all(
				items.map(async (row) => ({ name: String(row.name), url: await media.productUrl(s, /** @type {any} */ (row)) })),
			),
			faqs,
		});
		return {
			h1,
			title,
			description,
			intro,
			faqs,
			canonical,
			robots: indexed && !pagedOut ? robotsOf(category?.seo) : 'noindex, follow',
			landing: view
				? {
						id: view.id,
						url: view.url,
						indexed: view.indexed,
						inStock: view.inStock,
						inStockVariants: view.inStockVariants,
						automatic: false,
					}
				: automatic
					? {
							id: null,
							url: automatic.url,
							indexed: true,
							inStock: automatic.stock.products,
							inStockVariants: automatic.stock.variants,
							automatic: true,
						}
					: null,
			jsonLd: scriptJson(jsonLd),
		};
	};

	/**
	 * A glossary page's address (`attributeUrl` or `gradeUrl`) with `{slug}` or `{key}` and `{category}` (the category's
	 * slug, E45); null without a template, or when it names `{category}` and the page has none.
	 * @param {Site} s @param {'attributeUrl' | 'gradeUrl'} setting @param {Record<string, string>} values
	 */
	const glossaryUrl = async (s, setting, values) => {
		const template = String((await s.values('landing_pages'))[setting] ?? '');
		if (!template || (template.includes('{category}') && !values.category)) return null;
		let filled = template;
		for (const [name, value] of Object.entries(values)) filled = filled.replaceAll(`{${name}}`, encodeURIComponent(value));
		return absolute(filled, s.domain);
	};

	/**
	 * The category of a glossary read's `:category` (id, slug or an earlier slug), or 404; null without one.
	 * @param {Site} s @param {WebsiteData} data @param {unknown} ref
	 * @returns {Promise<CategoryRecord | null>}
	 */
	const glossaryCategory = async (s, data, ref) => {
		if (ref === undefined) return null;
		const found = await findBySlugHistory(data, COLLECTIONS.categories, String(ref), ID_PREFIX.category);
		const record = /** @type {CategoryRecord | undefined} */ (found?.record);
		if (!record || (await hiddenFor(s)).unlisted.has(record.id)) throw problem('not_found', 'There is no such category.');
		return record;
	};

	/**
	 * Whether a definition for every category (an attribute's or a grade's, with its categories, [] = all) applies to a
	 * category or one above it.
	 * @param {{ categoryIds?: string[] }} record @param {CategoryRecord} category
	 */
	const appliesTo = (record, category) =>
		(record.categoryIds ?? []).length === 0 ||
		(record.categoryIds ?? []).some((id) => id === category.id || category.path.includes(id));

	/**
	 * The head of a glossary page: its own SEO copy, else the merchant's patterns (`pattern`, attributes; SG-20).
	 * @param {Site} s
	 * @param {{ name: string, url: string | null, seo: { title: string, description: string, body: string, faqs: Array<{ question: string, answer: string }> } | undefined, fallback: string,
	 *   pattern?: { title: unknown, description: unknown, values: Record<string, string> } }} page
	 */
	const glossaryHead = async (s, { name, url, seo, fallback, pattern }) => {
		const [settings, business] = await Promise.all([s.values('seo'), s.business()]);
		const storeName = storeNameOf(settings, business);
		const values = { name, storeName, ...pattern?.values };
		const description = metaDescription(
			seo?.description,
			seo?.body,
			fallback,
			patternText(pattern?.description, values),
			settings.defaultDescription,
		);
		const at = url ?? `https://${s.domain}/`;
		return {
			title: fillTitle(String(settings.titleTemplate), {
				// the title pattern takes the same placeholders as the description ({unit}, {values}, {category}; E45)
				name: seo?.title || patternText(pattern?.title, values) || name,
				business: storeName,
			}),
			description,
			body: seo?.body ?? '',
			faqs: seo?.faqs ?? [],
			canonical: url,
			robots: url ? 'index, follow' : 'noindex, follow',
			jsonLd: scriptJson({
				'@context': 'https://schema.org',
				'@graph': [
					{ '@type': 'DefinedTerm', '@id': `${at}#term`, name, description, ...(url ? { url } : {}) },
					faqJsonLd(seo?.faqs, at),
				].filter((node) => node !== null),
			}),
		};
	};

	/**
	 * GET /v1/seo/attributes/:slug and /v1/seo/attributes/:category/:slug (E45): with a category, the attribute defined
	 * for it first, then the one for every category that applies to it; without, the one for every category first.
	 * @param {any} ctx
	 */
	const attributeGlossary = async (ctx) => {
		const { s, data } = await open(ctx);
		const ref = String(ctx.params.slug);
		const category = await glossaryCategory(s, data, ctx.params.category);
		const named = (await attributesOf(data)).filter(
			(row) => row.active !== false && (row.slug === ref.toLowerCase() || row.id === ref),
		);
		const attribute = category
			? (named.find((row) => row.categoryId === category.id) ??
				named.find((row) => !row.categoryId && appliesTo(row, category)))
			: (named.find((row) => !row.categoryId) ?? named[0]);
		if (!attribute) throw problem('not_found', 'There is no such attribute.');
		// the page's category: the one read, else the attribute's own
		const page =
			category ??
			(attribute.categoryId
				? /** @type {CategoryRecord | null} */ (
						(await data
							.collection(COLLECTIONS.categories)
							.findOne({ websiteId: data.websiteId, id: attribute.categoryId }, NO_ID)) ?? null
					)
				: null);
		const slug = attribute.slug ?? attribute.id;
		const values = attribute.choices ?? [];
		const settings = await s.values('landing_pages');
		return {
			name: attribute.name,
			slug,
			unit: attribute.unit ?? '',
			values,
			categoryId: attribute.categoryId,
			category: page ? { id: page.id, slug: page.slug, name: page.name } : null,
			...(await glossaryHead(s, {
				name: attribute.name,
				url: await glossaryUrl(s, 'attributeUrl', { slug, category: page?.slug ?? '' }),
				seo: attribute.seo,
				fallback: '',
				pattern: {
					title: settings.attributeTitle,
					description: settings.attributeDescription,
					values: {
						unit: attribute.unit ?? '',
						category: page?.name ?? '',
						values: values
							.slice(0, PATTERN_VALUES)
							.map((value) => value.label)
							.join(', '),
					},
				},
			})),
		};
	};

	/**
	 * GET /v1/seo/grades/:key and /v1/seo/grades/:category/:key (E45): with a category, the grade as it defines it
	 * first, then the one for every category that applies to it.
	 * @param {any} ctx
	 */
	const gradeGlossary = async (ctx) => {
		const { s, data } = await open(ctx);
		const list = s.has('grades_serials') ? await s.list('grades') : [];
		const category = await glossaryCategory(s, data, ctx.params.category);
		const key = String(ctx.params.key);
		const grade = category ? gradesFor(list, [category.id]).get(key) : gradesByKey(list).get(key);
		if (!grade || grade.active === false || (category && grade.categoryId !== category.id && !appliesTo(grade, category)))
			throw problem('not_found', 'There is no such grade.');
		const page =
			category ??
			(grade.categoryId
				? /** @type {CategoryRecord | null} */ (
						(await data
							.collection(COLLECTIONS.categories)
							.findOne({ websiteId: data.websiteId, id: grade.categoryId }, NO_ID)) ?? null
					)
				: null);
		return {
			key: grade.key,
			label: grade.label,
			gradeDescription: grade.description,
			color: grade.color ?? '',
			condition: grade.condition ?? null,
			content: grade.content ?? { summary: '', bullets: [] },
			categoryId: grade.categoryId ?? null,
			categoryIds: grade.categoryIds ?? [],
			category: page ? { id: page.id, slug: page.slug, name: page.name } : null,
			...(await glossaryHead(s, {
				name: grade.label,
				url: await glossaryUrl(s, 'gradeUrl', { key: grade.key, category: page?.slug ?? '' }),
				seo: grade.seo,
				fallback: grade.description,
			})),
		};
	};

	/**
	 * The glossary pages of the sitemaps (E45, SG-20): every active attribute once the attribute address is set, and
	 * grades with their own text once the grade address is set; with `{category}` in the address, a definition for one
	 * category at its category, one for every category at each category it names (none named: no page), each address
	 * once, categories hidden from shoppers left out.
	 * @param {Site} s @param {WebsiteData} data @param {Awaited<ReturnType<typeof namesOf>>} names
	 * @returns {Promise<string[]>}
	 */
	const glossaryPages = async (s, data, names) => {
		const settings = await s.values('landing_pages');
		const hidden = await hiddenFor(s);
		/** @type {Set<string>} */
		const urls = new Set();
		/**
		 * @param {'attributeUrl' | 'gradeUrl'} setting @param {Record<string, string>} values
		 * @param {{ categoryId?: string | null, categoryIds?: string[] }} record
		 */
		const add = async (setting, values, record) => {
			const template = String(settings[setting] ?? '');
			if (!template) return;
			const own = record.categoryId ? names.byCategory.get(record.categoryId) : undefined;
			/** @type {Array<CategoryRecord | undefined>} */
			const places = record.categoryId
				? [own]
				: template.includes('{category}')
					? (record.categoryIds ?? []).map((id) => names.byCategory.get(id))
					: [undefined];
			for (const place of places) {
				if (place === undefined && (record.categoryId || template.includes('{category}'))) continue;
				if (place && hidden.unlisted.has(place.id)) continue;
				const url = await glossaryUrl(s, setting, { ...values, category: place?.slug ?? '' });
				if (url) urls.add(url);
			}
		};
		for (const attribute of await attributesOf(data))
			if (attribute.active !== false) await add('attributeUrl', { slug: attribute.slug ?? attribute.id }, attribute);
		for (const grade of names.gradeList)
			if (grade.active !== false && (grade.seo?.body || grade.seo?.description))
				await add('gradeUrl', { key: grade.key }, grade);
		return [...urls];
	};

	/**
	 * The indexable landing pages and the glossary pages, for the sitemaps.
	 * @param {Site} s @param {WebsiteData} data
	 * @returns {Promise<Array<{ loc: string, lastmod: Date | null }>>}
	 */
	const sitemapPages = async (s, data) => {
		if (!s.has('landing_pages')) return [];
		const names = await namesOf(s, data);
		const rows = /** @type {Array<LandingRecord & { updatedAt?: Date }>} */ (
			await data
				.collection(COLLECTIONS.landings)
				.find({ websiteId: data.websiteId }, NO_ID)
				.sort({ id: 1 })
				.limit(MAX_LANDINGS)
				.toArray()
		);
		// the stock of every combination, read once for the stored and the automatic pages (E43)
		const [table, rules, hidden] = await Promise.all([stockTable(s, data, names), rulesOf(s), hiddenFor(s)]);
		/** @type {Array<{ loc: string, lastmod: Date | null }>} */
		const out = [];
		for (const row of rows) {
			if (row.indexable === 'no') continue;
			const view = await viewOf(s, data, names, row, table.get(comboKey(row)) ?? NO_STOCK);
			if (view.indexed) out.push({ loc: view.url, lastmod: row.updatedAt ?? null });
		}
		const stored = new Set(rows.map(comboKey));
		if (rules.mode !== 'off')
			for (const [key, stock] of table) {
				if (stored.has(key)) continue;
				const [categoryId = '', brandId = '', grade = ''] = key.split('|');
				const combination = { categoryId: categoryId || null, brandId: brandId || null, grade: grade || null };
				if (!isAutomatic(rules.mode, combination) || !isIndexable({ indexable: 'auto' }, stock, rules.auto)) continue;
				if (hidden.unlisted.has(categoryId) || hidden.categoryIds.includes(categoryId)) continue;
				out.push({ loc: await urlOf(s, names, combination), lastmod: null });
			}
		for (const loc of await glossaryPages(s, data, names)) out.push({ loc, lastmod: null });
		return out;
	};

	/**
	 * With `auto` on and `autoCopy` at `ai` (E43): when staff save a product, write the AI copy of one of its automatic
	 * landing pages that has no record yet (its categories with its brand, and with `category_brand_grade` its grades),
	 * kept as a landing page set to Automatic that staff can edit. One per save, after at most a few stock reads; nothing
	 * without AI copy on and the merchant's own AI key, or when the provider gives nothing usable (the formula stays).
	 * @param {Site} s @param {ProductRecord} item
	 * @returns {Promise<string | null>} the new landing page's id
	 */
	const writeAutoLanding = async (s, item) => {
		if (!s.has('landing_pages') || !s.has('ai_copy') || !item.brandId || item.status !== 'active') return null;
		const rules = await rulesOf(s);
		if (rules.mode === 'off' || rules.settings.autoCopy !== 'ai') return null;
		const connection = await product.connections.value(s.websiteId, 'ai');
		if (!connection) return null;
		const data = await s.data();
		const grades =
			rules.mode === 'category_brand_grade'
				? [...new Set(item.variants.filter((v) => v.active && v.grade).map((v) => /** @type {string} */ (v.grade)))]
				: [];
		const combinations = item.categoryIds
			.flatMap((categoryId) =>
				[null, ...grades].map((grade) => ({ categoryId, brandId: /** @type {string} */ (item.brandId), grade })),
			)
			.slice(0, MAX_AUTO_TRIES);
		const stored = new Set(
			(
				await data
					.collection(COLLECTIONS.landings)
					.find(
						{ websiteId: data.websiteId, $or: combinations },
						{ projection: { _id: 0, categoryId: 1, brandId: 1, grade: 1 } },
					)
					.toArray()
			).map((row) => comboKey(/** @type {any} */ (row))),
		);
		const hidden = await hiddenFor(s);
		const names = await namesOf(s, data);
		for (const combination of combinations) {
			if (stored.has(comboKey(combination)) || hidden.categoryIds.includes(combination.categoryId)) continue;
			if (!isIndexable({ indexable: 'auto' }, await stockOfCombo(s, data, names, combination), rules.auto)) continue;
			if ((await data.collection(COLLECTIONS.landings).countDocuments({ websiteId: data.websiteId })) >= MAX_LANDINGS)
				return null;
			const settings = await s.values('ai_copy');
			const { system, prompt, limits } = landingPrompt(
				{
					category: names.byCategory.get(combination.categoryId)?.name ?? null,
					brand: names.byBrand.get(combination.brandId)?.name ?? null,
					grade: combination.grade
						? (names.gradesIn(combination.categoryId).get(combination.grade)?.label ?? combination.grade)
						: null,
					products: [item.name],
				},
				{
					fields: ['h1', 'title', 'description', 'intro', 'faqs'],
					tone: String(settings.tone ?? ''),
					language: String(settings.language ?? ''),
				},
			);
			const answer = await product.ai.write(connection, { system, prompt, maxTokens: 1500 });
			const suggestions = answer.ok ? readSuggestions(answer.text, Object.keys(limits), limits) : null;
			if (!suggestions) return null;
			const checked = checkLanding({ ...combination, ...suggestions, indexable: 'auto' }, null);
			if (!checked.ok) return null;
			/** @type {LandingRecord} */
			const record = { id: createId(ID_PREFIX.landing), ...checked.value };
			const written = await data
				.collection(COLLECTIONS.landings)
				.insertOne({ ...record })
				.then(() => true)
				.catch((error) => {
					if (isDuplicate(error)) return false;
					throw error;
				});
			if (!written) return null;
			await service.log(s.ctx, 'landing.created', record.id, {
				label: record.h1 || record.title || record.id,
				detail: 'Automatic landing page written with AI copy',
			});
			return record.id;
		}
		return null;
	};

	const routes = [
		defineRoute({
			method: 'GET',
			path: '/v1/landings',
			auth: 'server',
			feature: 'landing_pages',
			rateLimit: READ_RATE,
			handler: landings.list,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/landings',
			auth: 'server',
			feature: 'landing_pages',
			idempotent: true,
			rateLimit: RATE,
			handler: landings.create,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/landings/:id',
			auth: 'server',
			feature: 'landing_pages',
			rateLimit: READ_RATE,
			handler: landings.read,
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/landings/:id',
			auth: 'server',
			feature: 'landing_pages',
			rateLimit: RATE,
			handler: landings.update,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/landings/:id',
			auth: 'server',
			feature: 'landing_pages',
			rateLimit: RATE,
			handler: landings.remove,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/landings/:id/ai-copy',
			auth: 'server',
			feature: 'ai_copy',
			rateLimit: RATE,
			handler: landings.aiCopy,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/landings',
			auth: 'ticket',
			permission: 'catalog.edit',
			feature: 'landing_pages',
			rateLimit: RATE,
			handler: landings.list,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/landings',
			auth: 'ticket',
			permission: 'catalog.edit',
			feature: 'landing_pages',
			idempotent: true,
			rateLimit: RATE,
			handler: landings.create,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/landings/:id',
			auth: 'ticket',
			permission: 'catalog.edit',
			feature: 'landing_pages',
			rateLimit: RATE,
			handler: landings.read,
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/admin/landings/:id',
			auth: 'ticket',
			permission: 'catalog.edit',
			feature: 'landing_pages',
			rateLimit: RATE,
			handler: landings.update,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/admin/landings/:id',
			auth: 'ticket',
			permission: 'catalog.edit',
			feature: 'landing_pages',
			rateLimit: RATE,
			handler: landings.remove,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/landings/:id/ai-copy',
			auth: 'ticket',
			permission: 'catalog.edit',
			feature: 'ai_copy',
			rateLimit: RATE,
			handler: landings.aiCopy,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/seo/listing',
			auth: 'server',
			feature: 'seo',
			rateLimit: READ_RATE,
			handler: listing,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/seo/attributes/:slug',
			auth: 'server',
			feature: 'landing_pages',
			rateLimit: READ_RATE,
			handler: attributeGlossary,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/seo/attributes/:category/:slug',
			auth: 'server',
			feature: 'landing_pages',
			rateLimit: READ_RATE,
			handler: attributeGlossary,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/seo/grades/:key',
			auth: 'server',
			feature: 'landing_pages',
			rateLimit: READ_RATE,
			handler: gradeGlossary,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/seo/grades/:category/:key',
			auth: 'server',
			feature: 'landing_pages',
			rateLimit: READ_RATE,
			handler: gradeGlossary,
		}),
	];

	return { routes, sitemapPages, writeAutoLanding };
};
