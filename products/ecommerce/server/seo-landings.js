/**
 * Landing pages, listing SEO and glossary pages (PLAN 0.8.10 E15, dynamic model §6). Landing pages (feature
 * `landing_pages`) are a category, brand and facet combination (a facet: a grade or one value of a field shoppers
 * filter by, `attr.<slug>=` in a listing) with its own copy; with the setting `auto` (E43) every category and brand
 * combination (with `category_brand_facet` also with each value of the field `autoFacet`) with enough products and
 * variants in stock is an automatic landing page without a record, its copy from the patterns `autoTitle` and
 * `autoDescription` (a stored landing page wins), in the listing reads and the sitemaps (judged on read: one aggregation
 * per facet field per read, never stored; the sitemaps list at most `AUTO_LANDING_MAX_PAGES` of them, the most products in stock
 * first); for the merchant's server (`/v1/landings…`, server token)
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
import { NO_KEYS, attributesOf, brandsOf, categoriesOf, findBySlugHistory } from '../adapters/catalog-store.js';
import { checkLandingAiRequest, landingPrompt, readSuggestions } from '../core/catalog-ai.js';
import { siteAddress } from '../core/catalog-content.js';
import {
	attributeOf,
	fieldsNamed,
	listOf,
	readShopQuery,
	shopFilter,
	sortDocument,
	sortOf,
	storedValues,
} from '../core/catalog-query.js';
import { lineageOf, withDescendants } from '../core/catalog-taxonomy.js';
import {
	GRADE_FACET,
	NO_STOCK,
	checkLanding,
	comboKey,
	comboOfKey,
	comboQuery,
	comboStock,
	facetValues,
	isAutomatic,
	isIndexable,
	landingFor,
	landingLink,
	stockOf,
	stockStages,
} from '../core/landings.js';
import { absolute, withQuery } from '../core/links.js';
import {
	AUTO_LANDING_MAX_PAGES,
	AUTO_LANDING_MIN_PRODUCTS,
	LANDING_MIN_PRODUCTS,
	LANDING_MIN_VARIANTS,
	TOP_FIELD,
} from '../core/limits.js';
import { COLLECTIONS, ID_PREFIX, MAX_PAGE_SIZE, SORTS, TOTAL_CAP, isDuplicate } from '../core/model.js';
import {
	asWritten,
	categoryJsonLd,
	faqJsonLd,
	fillTemplate,
	fillTitle,
	hasOwnText,
	metaDescription,
	pageName,
	pageTitle,
	patternText,
	robotsOf,
	scriptJson,
	socialOf,
} from '../core/seo.js';
import { gradesByKey, gradesFor } from '../core/grades.js';
import { shownRange } from '../core/catalog-views.js';
import { listingHtml, say } from '../core/seo-html.js';
import { createCatalogCommon } from './catalog-common.js';
import { createListingFilter, createProductsPage } from './catalog-shop.js';
import { conditional } from './http-cache.js';
import { createShownPrices } from './shown-prices.js';
import { hiddenFor } from './catalog-visibility.js';
import { SEO_LIMITS, SERVER_LIMITS } from './service.js';
import { defaultImageOf, newestOf, seoSettingsOf, storeNameOf, trailOf } from './seo-reads.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./catalog-media.js').Media} Media */
/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/model.js').LandingRecord} LandingRecord */
/** @typedef {import('../core/model.js').LandingFacet} LandingFacet */
/** @typedef {import('../core/model.js').AttributeRecord} AttributeRecord */
/** @typedef {import('../core/landings.js').Combination} Combination */
/** @typedef {import('../core/landings.js').FacetPlace} FacetPlace */
/** @typedef {import('../core/model.js').CategoryRecord} CategoryRecord */
/** @typedef {import('../core/model.js').BrandRecord} BrandRecord */
/** @typedef {import('../core/model.js').ProductRecord} ProductRecord */
/** @typedef {import('../core/grades.js').Grade} Grade */

/** Values of an attribute a glossary pattern's `{values}` names. */
const PATTERN_VALUES = 5;
/** At most this many landing pages per website. */
const MAX_LANDINGS = 2000;
/** Most combinations of a saved product looked at for an AI-written automatic landing page (E43). */
const MAX_AUTO_TRIES = 5;
/** Most rows of the stock of every combination (E43): products in stock, by facet value. */
const MAX_STOCK_ROWS = 50_000;
/** At most this many landing pages are remembered as indexed (G7.7). */
const MAX_REMEMBERED = 10_000;
/** Most facet fields whose stock one read adds up (stored pages' fields and `autoFacet`). */
const MAX_FACET_FIELDS = 5;
/** Listing parameters that are not filters (they keep a category or landing page indexable). */
const NOT_FILTERS = new Set(['category', 'brand', 'grade', 'page', 'limit', 'cursor', 'html']);
/** Listing parameters that narrow nothing: an empty result with only these is a page, not a 404 (G7.4). */
const NOT_NARROWING = new Set(['category', 'page', 'limit', 'cursor', 'sort', 'html']);
/** Listing parameters a page's own address never carries: the category is the address, the rest only reads (G12). */
const NOT_IN_ADDRESS = new Set(['category', 'limit', 'cursor', 'html']);

/**
 * A filtered list's own address (G12: such a page is not indexed and names itself as canonical, never the category):
 * the page's address with its filters in one order (by name, `&` between them), page 1 and empty values left out.
 * @param {string} base the category's (or the home) page
 * @param {Record<string, unknown>} query the listing's query
 */
const filteredUrl = (base, query) => {
	const params = new URLSearchParams();
	for (const key of Object.keys(query).sort()) {
		const value = String(query[key] ?? '');
		if (value !== '' && !NOT_IN_ADDRESS.has(key) && !(key === 'page' && value === '1')) params.append(key, value);
	}
	return withQuery(base, params.toString());
};

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
		const [categories, brands, gradeList, attributeList, texts] = await Promise.all([
			categoriesOf(data),
			brandsOf(data),
			s.has('grades_serials') ? s.list('grades') : Promise.resolve([]),
			attributesOf(data),
			s.texts(),
		]);
		const byCategory = new Map(categories.map((c) => [c.id, c]));
		/** @type {Map<string, AttributeRecord>} */
		const attributes = new Map(attributeList.map((attribute) => [attribute.id, attribute]));
		/** @param {string | null} categoryId */
		const gradesIn = (categoryId) =>
			/** @type {Map<string, Grade>} */ (gradesFor(gradeList, lineageOf([categoryId], byCategory)));
		return {
			attributes,
			/**
			 * Where a facet field's values are: the grade, or the fields with its slug shoppers filter by; null for any
			 * other (a staff-only field never makes a page).
			 * @param {string} field
			 * @returns {FacetPlace | null}
			 */
			placeOf: (field) => {
				if (field === GRADE_FACET) return { grade: true };
				const named = fieldsNamed(attributes, field).filter((attribute) => attribute.slug === field);
				if (named.length === 0) return null;
				/** @param {string} on */
				const ids = (on) => named.filter((attribute) => attribute.on === on).map((attribute) => attribute.id);
				return { variantIds: ids('variant'), productIds: ids('product') };
			},
			/**
			 * A facet's value as stored (a number field's is a number).
			 * @param {LandingFacet} facet
			 */
			storedOf: (facet) => {
				if (facet.field === GRADE_FACET) return facet.value;
				const field = fieldsNamed(attributes, facet.field)[0];
				return storedValues(field, [facet.value])[0] ?? facet.value;
			},
			/**
			 * A facet's names on a page of a category: its field's (`grid.grade` for grades) and its value's (a grade's or a
			 * choice's label, yes or no, a number with its unit).
			 * @param {string | null} categoryId @param {LandingFacet | null} facet
			 */
			facetNames: (categoryId, facet) => {
				if (!facet) return { facet: '', value: '' };
				if (facet.field === GRADE_FACET)
					return {
						facet: String(texts['grid.grade'] ?? ''),
						value: gradesIn(categoryId).get(facet.value)?.label ?? facet.value,
					};
				const field = attributeOf(attributes, facet.field, lineageOf([categoryId], byCategory));
				if (!field) return { facet: facet.field, value: facet.value };
				const choice = field.choices.find((option) => option.value === facet.value);
				const value = choice
					? choice.label
					: field.type === 'yes_no'
						? String(texts[facet.value === 'true' ? 'shop.yes' : 'shop.no'] ?? facet.value)
						: field.type === 'number' && field.unit
							? `${facet.value} ${field.unit}`
							: facet.value;
				return { facet: field.name, value };
			},
			categories,
			byCategory,
			byBrand: new Map(brands.map((b) => [b.id, b])),
			/** every grade key (a category's own entries only where no entry is for every category) */
			grades: /** @type {Map<string, Grade>} */ (gradesByKey(gradeList)),
			/** The grades as a category (or the nearest one above it) defines them, then the ones for every category (E45). */
			gradesIn,
			gradeList: /** @type {Grade[]} */ (gradeList),
		};
	};

	const listingFilter = createListingFilter(service);
	const productsPage = createProductsPage(product, service, createCatalogCommon(product, service));
	const shownPrices = createShownPrices(service);

	/**
	 * The landing pages indexed before (G7.7), by combination key: all of them, or those of `keys`.
	 * @param {WebsiteData} data @param {string[]} [keys]
	 * @returns {Promise<Set<string>>}
	 */
	const memoryOf = async (data, keys) =>
		new Set(
			(
				await data
					.collection(COLLECTIONS.landingIndex)
					.find({ websiteId: data.websiteId, ...(keys ? { key: { $in: keys } } : {}) }, { projection: { _id: 0, key: 1 } })
					.limit(MAX_REMEMBERED)
					.toArray()
			).map((row) => String(row.key)),
		);

	/**
	 * Remember landing pages as indexed, or forget them (G7.7).
	 * @param {WebsiteData} data @param {Set<string>} memory updated too @param {string[]} keys @param {boolean} indexed
	 */
	const remember = async (data, memory, keys, indexed) => {
		if (keys.length === 0) return;
		const index = data.collection(COLLECTIONS.landingIndex);
		if (indexed)
			await index
				.insertMany(
					keys.map((key) => ({ key, at: new Date(service.now()) })),
					{ ordered: false },
				)
				.catch((/** @type {any} */ error) => {
					// another read remembered it at the same time
					if (!isDuplicate(error) && !(error?.writeErrors ?? []).every((/** @type {any} */ e) => e.code === 11000))
						throw error;
				});
		else await index.deleteMany({ websiteId: data.websiteId, key: { $in: keys } });
		for (const key of keys) {
			if (indexed) memory.add(key);
			else memory.delete(key);
		}
	};

	/**
	 * Whether a landing page set to Automatic (stored or automatic) is indexed (SG-10, G7.7): when it reaches the numbers
	 * (`meets`); once indexed, while it has any product shoppers may see, in stock or not, so its place in search results
	 * does not come and go with stock. Remembers a page newly indexed and forgets one that left the index.
	 * @param {Site} s @param {WebsiteData} data @param {Awaited<ReturnType<typeof namesOf>>} names
	 * @param {Combination} combination
	 * @param {boolean} meets @param {Set<string>} memory
	 */
	const judged = async (s, data, names, combination, meets, memory) => {
		const key = comboKey(combination);
		const before = memory.has(key);
		const indexed =
			meets ||
			(before &&
				(await data
					.collection(COLLECTIONS.products)
					.countDocuments(await filterOf(s, names, combination, false), { limit: 1 })) > 0);
		if (indexed !== before) await remember(data, memory, [key], indexed);
		return indexed;
	};

	/**
	 * The products of a listing (a category with those below it, a brand, a facet value) shoppers may see.
	 * @param {Site} s @param {Awaited<ReturnType<typeof namesOf>>} names
	 * @param {Combination} combination
	 * @param {boolean} inStock
	 */
	const filterOf = async (s, names, { categoryId, brandId, facet }, inStock) => ({
		websiteId: s.websiteId,
		...shopFilter(
			{
				q: '',
				category: null,
				brands: [],
				minPrice: null,
				maxPrice: null,
				inStock,
				attributes: facet && facet.field !== GRADE_FACET ? [{ id: facet.field, values: [facet.value] }] : [],
				grades: facet?.field === GRADE_FACET ? [facet.value] : [],
				sort: 'newest',
				featured: false,
				deal: null,
				page: null,
				count: false,
			},
			{
				categoryIds: categoryId ? withDescendants(categoryId, names.categories) : null,
				brandIds: brandId ? [brandId] : null,
				attributes: names.attributes,
				hidden: await hiddenFor(s),
				// the brands hidden in the category or one above it (parity P3-12)
				brandsOut: categoryId
					? [...names.byBrand.values()]
							.filter((brand) =>
								[categoryId, ...(names.byCategory.get(categoryId)?.path ?? [])].some((id) =>
									(brand.hiddenIn ?? []).includes(id),
								),
							)
							.map((brand) => brand.id)
					: [],
			},
		),
	});

	/**
	 * A landing page's address on the merchant's website.
	 * @param {Site} s @param {Awaited<ReturnType<typeof namesOf>>} names
	 * @param {Combination} landing
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
				facet: landing.facet,
			},
			s.domain,
		);
	};

	/**
	 * What a combination has in stock (shoppers may see): its products, their sellable variants (of the facet value)
	 * and the lowest price, in one aggregation (E43, SG-10).
	 * @param {Site} s @param {WebsiteData} data @param {Awaited<ReturnType<typeof namesOf>>} names
	 * @param {Combination} combination
	 */
	const stockOfCombo = async (s, data, names, combination) => {
		const place = combination.facet ? names.placeOf(combination.facet.field) : null;
		const only = combination.facet && place ? { place, stored: names.storedOf(combination.facet) } : null;
		return stockOf(
			await data
				.collection(COLLECTIONS.products)
				.aggregate([{ $match: await filterOf(s, names, combination, true) }, ...stockStages({ only })], {
					maxTimeMS: 5000,
				})
				.toArray(),
		);
	};

	/**
	 * The stock of every combination at once (E43): one aggregation over the products in stock per facet field (none:
	 * one, for the categories and brands), at most a few fields.
	 * @param {Site} s @param {WebsiteData} data @param {Awaited<ReturnType<typeof namesOf>>} names
	 * @param {ReadonlyArray<string>} fields the facet fields the combinations name
	 */
	const stockTable = async (s, data, names, fields) => {
		const places = [...new Set(fields)]
			.map((field) => ({ field, place: names.placeOf(field) }))
			.filter((entry) => entry.place !== null)
			.slice(0, MAX_FACET_FIELDS);
		const match = { $match: await filterOf(s, names, { categoryId: null, brandId: null, facet: null }, true) };
		/** @type {Map<string, import('../core/landings.js').ComboStock>} */
		const table = new Map();
		for (const { field, place } of places.length > 0 ? places : [{ field: null, place: null }]) {
			const rows = await data
				.collection(COLLECTIONS.products)
				.aggregate([match, ...stockStages({ group: place }), { $limit: MAX_STOCK_ROWS }], { maxTimeMS: 10_000 })
				.toArray();
			const stocks = comboStock(rows, (id) => names.byCategory.get(id)?.path ?? [], {
				field,
				hiddenIn: (id) => names.byBrand.get(id)?.hiddenIn ?? [],
			});
			for (const [key, stock] of stocks) if (!table.has(key)) table.set(key, stock);
		}
		return table;
	};

	/**
	 * The `landing_pages` settings that decide indexing (SG-10, E43): stored pages set to Automatic need
	 * `LANDING_MIN_PRODUCTS` products in stock, automatic ones `AUTO_LANDING_MIN_PRODUCTS`; while `auto` is on, both also need
	 * `LANDING_MIN_VARIANTS` variants in stock (off, stored pages are judged as before); which combinations are
	 * automatic (`auto`, `autoFacet`) and how many the sitemaps list (`AUTO_LANDING_MAX_PAGES`).
	 * @param {Site} s
	 */
	const rulesOf = async (s) => {
		const settings = await s.values('landing_pages');
		const mode = String(settings.auto ?? 'off');
		const autoFacet = mode === 'category_brand_facet' ? String(settings.autoFacet ?? '') : '';
		const minVariants = LANDING_MIN_VARIANTS;
		return {
			settings,
			mode,
			autoFacet,
			maxPages: AUTO_LANDING_MAX_PAGES,
			/** @param {Combination} combination */
			automatic: (combination) => isAutomatic({ auto: mode, autoFacet }, combination),
			stored: { minProducts: LANDING_MIN_PRODUCTS, minVariants: mode === 'off' ? 0 : minVariants },
			auto: { minProducts: AUTO_LANDING_MIN_PRODUCTS, minVariants },
		};
	};

	/**
	 * A landing page with its address, products and variants in stock and whether it is indexed now (once indexed, while
	 * it has any product, G7.7).
	 * @param {Site} s @param {WebsiteData} data @param {Awaited<ReturnType<typeof namesOf>>} names @param {LandingRecord} landing
	 * @param {import('../core/landings.js').ComboStock} [known] its stock when already read
	 * @param {Set<string>} [memory] the pages indexed before, when already read
	 */
	const viewOf = async (s, data, names, landing, known, memory) => {
		const stock = known ?? (await stockOfCombo(s, data, names, landing));
		const { stored, auto, automatic } = await rulesOf(s);
		// a page stored for a combination that is automatic is never indexed less than without it (E43)
		const minimum = automatic(landing) ? { ...stored, minProducts: Math.min(stored.minProducts, auto.minProducts) } : stored;
		const meets = isIndexable(landing, stock, minimum);
		return {
			...landing,
			url: await urlOf(s, names, landing),
			inStock: stock.products,
			inStockVariants: stock.variants,
			indexed:
				landing.indexable === 'auto'
					? await judged(s, data, names, landing, meets, memory ?? (await memoryOf(data, [comboKey(landing)])))
					: meets,
		};
	};

	/**
	 * The copy of an automatic landing page (E43): the `autoTitle` and `autoDescription` patterns with the names of its
	 * category, brand, facet field and value, what is in stock and its lowest price.
	 * @param {Site} s
	 * @param {{ category: string, brand: string, facet: string, value: string, storeName: string }} names
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
				fillTemplate(String(settings.autoTitle ?? '{category} {brand} {value}'), values) ||
				[names.category, names.brand, names.value].filter(Boolean).join(' '),
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
		if (value.facet?.field === GRADE_FACET && !names.grades.has(value.facet.value))
			throw refuse([{ path: '/facet/value', message: 'Pick a grade of your grades list.' }]);
		if (value.facet && value.facet.field !== GRADE_FACET && !names.placeOf(value.facet.field))
			throw refuse([{ path: '/facet/field', message: 'Pick grade, or the slug of a field shoppers filter by.' }]);
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
		const found = await data.collection(COLLECTIONS.landings).findOne({ websiteId: data.websiteId, id }, NO_KEYS);
		if (!found) throw problem('not_found', 'There is no such landing page.');
		return /** @type {LandingRecord} */ (/** @type {unknown} */ (found));
	};

	/** @param {unknown} error */
	const clash = (error) =>
		isDuplicate(error) ? problem('conflict', 'A landing page for this category, brand and facet already exists.') : error;

	const landings = {
		/** GET ?category=&brand=&facet=&value=&q=. @param {any} ctx */
		list: async (ctx) => {
			const { s, data } = await open(ctx);
			const names = await namesOf(s, data);
			/** @type {Record<string, unknown>} */
			const filter = { websiteId: data.websiteId };
			if (ctx.query.category) filter.categoryId = String(ctx.query.category);
			if (ctx.query.brand) filter.brandId = String(ctx.query.brand);
			if (ctx.query.facet) filter['facet.field'] = String(ctx.query.facet);
			if (ctx.query.value) filter['facet.value'] = String(ctx.query.value);
			const rows = /** @type {LandingRecord[]} */ (
				await data.collection(COLLECTIONS.landings).find(filter, NO_KEYS).sort({ id: 1 }).limit(MAX_LANDINGS).toArray()
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
			// several pages: the stock of every combination in one aggregation per facet field (E43)
			const table =
				shown.length > 1
					? await stockTable(
							s,
							data,
							names,
							shown.flatMap((row) => (row.facet ? [row.facet.field] : [])),
						)
					: null;
			const memory = await memoryOf(data, shown.map(comboKey));
			return {
				items: await Promise.all(
					shown.map((row) =>
						viewOf(s, data, names, row, table ? (table.get(comboKey(row)) ?? NO_STOCK) : undefined, memory),
					),
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
				.sort({ [TOP_FIELD]: -1, id: 1 })
				.limit(20)
				.toArray();
			const settings = await s.values('ai_copy');
			const { system, prompt, limits } = landingPrompt(
				{
					category: landing.categoryId ? (names.byCategory.get(landing.categoryId)?.name ?? null) : null,
					brand: landing.brandId ? (names.byBrand.get(landing.brandId)?.name ?? null) : null,
					facet: landing.facet ? names.facetNames(landing.categoryId, landing.facet) : null,
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
	 * The grid's core as plain HTML (G3): the page's products as links with their first photo (with its size) and the
	 * price shown, as cards show them, and the links to the previous and next pages, in the website's words and format.
	 * @param {Site} s @param {WebsiteData} data @param {ProductRecord[]} items
	 * @param {{ prev: string | null, next: string | null }} pages
	 */
	const gridHtml = async (s, data, items, pages) => {
		const [texts, { money }, prices] = await Promise.all([s.texts(), s.format(), shownPrices(s, data)]);
		/** @param {string} key @param {Record<string, string | number>} [values] */
		const t = (key, values) => say(String(texts[key] ?? ''), values);
		/** @param {number} amount */
		const written = (amount) => money(amount, s.currency);
		return listingHtml({
			items: await Promise.all(
				items.map(async (item) => {
					const range = shownRange(item, prices.of(item));
					const main = item.media[0];
					const photo = main ? await media.stableUrl(s, main.sizes?.card ?? main.key) : null;
					return {
						name: item.name,
						url: await media.productUrl(s, item),
						price:
							range.priceMax > range.price
								? t('shop.priceRange', { min: written(range.price), max: written(range.priceMax) })
								: written(range.price),
						was: range.compareAtPrice !== null && range.priceMax <= range.price ? written(range.compareAtPrice) : '',
						image:
							main && photo
								? {
										url: photo,
										alt: main.alt || item.name,
										...(main.width && main.height ? { width: main.width, height: main.height } : {}),
									}
								: null,
					};
				}),
			),
			...pages,
			words: { pages: t('grid.pages'), prev: t('grid.prevPage'), next: t('grid.nextPage') },
		});
	};

	/**
	 * GET /v1/seo/listing?category=&brand=&grade=&attr.<slug>=&page=&…: what a listing page puts in its head (E15): a
	 * category, one brand and one facet (one grade, or one value of a field shoppers filter by) is a landing page.
	 * @param {any} ctx
	 */
	const listing = async (ctx) => {
		const { s, data } = await open(ctx);
		const names = await namesOf(s, data);
		const [settings, business, hidden] = await Promise.all([seoSettingsOf(s), s.business(), hiddenFor(s)]);
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
		// the facet: one grade as the category defines it, then the one for every category (E45), or one value of a field
		// shoppers filter by, named by its slug
		const fieldKeys = Object.keys(ctx.query).filter((key) => key.startsWith('attr.') && ctx.query[key] !== '');
		/** @type {LandingFacet | null} */
		let facet = null;
		if (gradeKeys.length === 1 && fieldKeys.length === 0) {
			const grade = names.gradesIn(category?.id ?? null).get(/** @type {string} */ (gradeKeys[0]));
			if (grade) facet = { field: GRADE_FACET, value: grade.key };
		} else if (gradeKeys.length === 0 && fieldKeys.length === 1) {
			const slug = String(fieldKeys[0]).slice(5);
			const values = listOf(ctx.query[String(fieldKeys[0])]);
			if (values.length === 1 && !names.attributes.has(slug) && names.placeOf(slug))
				facet = { field: slug, value: /** @type {string} */ (values[0]) };
		}
		const facetKey = facet && facet.field !== GRADE_FACET ? `attr.${facet.field}` : null;
		const page = /^\d{1,3}$/.test(String(ctx.query.page ?? '')) ? Math.max(1, Number(ctx.query.page)) : 1;
		const filters = Object.keys(ctx.query).filter((key) => !NOT_FILTERS.has(key) && key !== facetKey && ctx.query[key] !== '');
		const named = brandRefs.length === (brand ? 1 : 0) && gradeKeys.length + fieldKeys.length === (facet ? 1 : 0);
		const exact = filters.length === 0 && named && (brand === null || brand.status !== 'hidden');
		// the grid's order: newest first, or the sort asked for (a sorted list is not indexed, but its items are known)
		const sortKey = String(ctx.query.sort ?? '');
		const sorted = Object.hasOwn(SORTS, sortKey) ? sortOf(/** @type {keyof typeof SORTS} */ (sortKey)) : null;
		const itemsKnown = named && filters.every((key) => key === 'sort' && sorted !== null);
		/** @type {Combination} */
		const combination = { categoryId: category?.id ?? null, brandId: brand?.id ?? null, facet };
		const facetNames = names.facetNames(combination.categoryId, facet);
		const landing =
			exact && s.has('landing_pages') && (brand || facet)
				? landingFor(
						/** @type {LandingRecord[]} */ (
							await data
								.collection(COLLECTIONS.landings)
								.find({ websiteId: data.websiteId, ...comboQuery(combination) }, NO_KEYS)
								.limit(1)
								.toArray()
						),
						combination,
					)
				: null;
		const memory = await memoryOf(data, [comboKey(combination)]);
		const view = landing ? await viewOf(s, data, names, landing, undefined, memory) : null;
		const storeName = storeNameOf(settings, business);
		// no stored page: an automatic one while the combination has enough in stock, or was indexed and still has a
		// product (E43, G7.7)
		const rules = await rulesOf(s);
		const shown = category === null || !hidden.categoryIds.includes(category.id);
		const autoStock =
			!landing && exact && shown && s.has('landing_pages') && rules.automatic(combination)
				? await stockOfCombo(s, data, names, combination)
				: null;
		const automatic =
			autoStock &&
			(await judged(s, data, names, combination, isIndexable({ indexable: 'auto' }, autoStock, rules.auto), memory))
				? {
						url: await urlOf(s, names, combination),
						stock: autoStock,
						copy: await autoCopyOf(
							s,
							{ category: category?.name ?? '', brand: brand?.name ?? '', ...facetNames, storeName },
							autoStock,
						),
					}
				: null;
		// the products the page lists, counted as the grid counts them (the same filter): its total, and a 404 for an empty
		// result of a filter, for a filter it cannot read and for a page past the end (G7.4; a search finding nothing,
		// and a stored landing page with its own copy, are pages)
		const read = readShopQuery({ ...ctx.query, category: category?.id ?? '' });
		const counted = read.ok ? await listingFilter(s, data, read.value) : null;
		const total = counted
			? await data.collection(COLLECTIONS.products).countDocuments(counted.filter, { limit: TOTAL_CAP + 1 })
			: 0;
		const limit = /^\d{1,2}$/.test(String(ctx.query.limit ?? ''))
			? Math.min(MAX_PAGE_SIZE, Math.max(1, Number(ctx.query.limit)))
			: Number((await s.values('catalog')).pageSize);
		const narrowed = Object.keys(ctx.query).some((key) => !NOT_NARROWING.has(key) && ctx.query[key] !== '');
		const searched = String(ctx.query.q ?? '').trim() !== '';
		const missing = !searched && !view && (!read.ok || (page > 1 && (page - 1) * limit >= total) || (narrowed && total === 0));
		const categoryIndexable =
			category !== null &&
			!hidden.categoryIds.includes(category.id) &&
			!category.seo.noindex &&
			brand === null &&
			facet === null &&
			exact &&
			// an empty category without text of its own is a thin page (G7.1)
			(total > 0 || hasOwnText(category) || settings.emptyCategories === 'index');
		const indexed = !missing && (categoryIndexable || (view?.indexed === true && exact && shown) || automatic !== null);
		const pageUrl = view
			? view.url
			: automatic
				? automatic.url
				: category
					? await media.categoryUrl(s, category)
					: `https://${s.domain}/`;
		const canonicalBase =
			category?.seo.canonicalUrl && !view && !automatic ? absolute(category.seo.canonicalUrl, s.domain) : pageUrl;
		// pages after the first keep their own address as canonical, indexed or not (pagedListings; SG-21, G7: Google asks
		// never to name page 1 as the canonical of page 2); a filtered list names itself (G12)
		const pagedOut = page > 1 && settings.pagedListings === 'noindex';
		/** The address of a page of this list (page 1: without a page number). @param {number} n */
		const pageAddress = (n) =>
			!exact
				? filteredUrl(pageUrl, { ...ctx.query, page: String(n) })
				: n > 1
					? withQuery(canonicalBase, `page=${n}`)
					: canonicalBase;
		const canonical = pageAddress(page);
		const h1 =
			landing?.h1 ||
			automatic?.copy.name ||
			[category?.name, brand?.name, facetNames.value].filter(Boolean).join(' ') ||
			business.name;
		// a category's own page takes the merchant's category patterns (SG-5, SG-21)
		const own = category && !brand && !facet && !landing ? category : null;
		const parent = own ? names.byCategory.get(own.path.at(-1) ?? '') : undefined;
		const patternNames = { name: own?.name ?? '', category: parent?.name ?? '', storeName };
		// a brand's own page: the listing by the brand alone
		const brandPage = brand && !category && !facet && !landing ? brand : null;
		// own titles: the landing page's, else the category's or the brand's on its own page (with its titleMode, G6)
		const titled = own ?? brandPage;
		const title = pageTitle(String(settings.titleTemplate), {
			own: landing?.title || (titled?.seo.title ?? ''),
			mode: landing?.title ? 'template' : (titled?.seo.titleMode ?? 'template'),
			name: automatic?.copy.name || (own ? pageName(settings.categoryTitle, patternNames) : '') || h1,
			business: storeName,
		});
		const description = metaDescription(
			asWritten(landing?.description),
			automatic?.copy.description,
			asWritten(category?.seo.description),
			own ? patternText(settings.categoryDescription, patternNames) : '',
			category?.content.summary,
			category?.description,
			asWritten(brand?.seo.description),
			brand?.description,
			asWritten(settings.defaultDescription),
		);
		const intro = landing?.intro || category?.content.summary || category?.description || '';
		const faqs = landing ? landing.faqs : (category?.faqs ?? []);
		// the products this page of the grid shows, in its order: its ItemList (a list with other filters gives none: it is
		// not indexed, and its items are the grid's to find), and with html=1 the grid's core (G3)
		const html = ctx.query.html === '1';
		const shownItems = /** @type {ProductRecord[]} */ (
			counted && total > 0 && (itemsKnown || html)
				? await data
						.collection(COLLECTIONS.products)
						.find(counted.filter, NO_KEYS)
						.sort(sortDocument(sorted ?? /** @type {import('../core/catalog-query.js').Sort} */ (SORTS.newest)))
						.skip((page - 1) * limit)
						.limit(limit)
						.toArray()
				: []
		);
		const items = itemsKnown ? shownItems : [];
		const image = category?.image ? await media.stableUrl(s, category.image.key) : siteAddress(settings.defaultImage) || null;
		const jsonLd = categoryJsonLd({
			name: h1,
			description,
			url: canonical,
			image: image ? absolute(image, s.domain) : null,
			trail: await trailOf(s, data, media, category, view !== null || automatic !== null, business.name),
			items: await Promise.all(
				items.map(async (row) => ({ name: String(row.name), url: await media.productUrl(s, /** @type {any} */ (row)) })),
			),
			faqs: settings.faqMarkup === true ? faqs : [],
		});
		return {
			h1,
			title,
			description,
			intro,
			faqs,
			canonical,
			robots: indexed && !pagedOut ? robotsOf(category?.seo) : 'noindex, follow',
			total: Math.min(total, TOTAL_CAP),
			empty: total === 0,
			status: missing ? 404 : 200,
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
			...socialOf({
				type: 'website',
				url: canonical,
				siteName: storeName,
				title,
				description,
				image: image ? absolute(image, s.domain) : null,
				imageAlt: category?.image?.alt || h1,
			}),
			jsonLd: scriptJson(jsonLd),
			// the newest change of the page (its category, its stored landing page, the products it shows), for the
			// website's own Last-Modified (G10)
			lastModified: newestOf([
				/** @type {{ updatedAt?: Date } | null} */ (category)?.updatedAt,
				/** @type {{ updatedAt?: Date } | null} */ (landing)?.updatedAt,
				...shownItems.map((item) => item.contentUpdatedAt),
			]),
			...(html
				? {
						html: await gridHtml(s, data, shownItems, {
							prev: page > 1 && !missing ? pageAddress(page - 1) : null,
							next: page * limit < total ? pageAddress(page + 1) : null,
						}),
					}
				: {}),
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
	 * @param {{ categoryIds: string[] }} record @param {CategoryRecord} category
	 */
	const appliesTo = (record, category) =>
		record.categoryIds.length === 0 || record.categoryIds.some((id) => id === category.id || category.path.includes(id));

	/**
	 * The products a glossary page lists, with `products=1` (none otherwise): one page of the shop listing's own cards
	 * (paged, counted, sorted and with variants as it reads limit, cursor, page, count, sort and variants), of the
	 * page's category and what the page names: the products that carry a field (one of its values with `value`), or have
	 * a variant of a grade. A field only staff see lists none.
	 * @param {any} ctx @param {Site} s @param {WebsiteData} data
	 * @param {{ category: CategoryRecord | null, attribute?: { id: string }, grade?: { key: string } }} page
	 */
	const glossaryProducts = async (ctx, s, data, page) => {
		const asked = ctx.query.products;
		if (asked !== '1' && asked !== 'true') return {};
		return {
			products: await productsPage(s, data, ctx.query, {
				facets: false,
				query: (read) => ({
					...read,
					// a glossary page is not a search
					q: '',
					category: page.category?.id ?? null,
					attributes: page.attribute
						? [
								...read.attributes.filter((a) => a.id !== page.attribute?.id),
								{ id: page.attribute.id, values: listOf(ctx.query.value) },
							]
						: read.attributes,
					grades: page.grade ? [page.grade.key] : read.grades,
				}),
			}),
		};
	};

	/**
	 * The head of a glossary page: its own SEO copy, else the merchant's patterns (`pattern`, attributes and grades;
	 * SG-20).
	 * @param {Site} s
	 * @param {{ name: string, url: string | null, seo: { title: string, description: string, body: string, faqs: Array<{ question: string, answer: string }> } | undefined, fallback: string,
	 *   pattern?: { title: unknown, description: unknown, values: Record<string, string> } }} page
	 */
	const glossaryHead = async (s, { name, url, seo, fallback, pattern }) => {
		const [settings, business] = await Promise.all([seoSettingsOf(s), s.business()]);
		const storeName = storeNameOf(settings, business);
		const values = { name, storeName, ...pattern?.values };
		const description = metaDescription(
			asWritten(seo?.description),
			seo?.body,
			fallback,
			patternText(pattern?.description, values),
			asWritten(settings.defaultDescription),
		);
		const at = url ?? `https://${s.domain}/`;
		const title = fillTitle(String(settings.titleTemplate), {
			// the title pattern takes the same placeholders as the description ({unit}, {values}, {category}; E45)
			name: seo?.title || patternText(pattern?.title, values) || name,
			business: storeName,
		});
		const image = defaultImageOf(settings, s.domain);
		return {
			title,
			description,
			...socialOf({ type: 'website', url, siteName: storeName, title, description, image, imageAlt: name }),
			body: seo?.body ?? '',
			faqs: seo?.faqs ?? [],
			canonical: url,
			// a page made only from patterns is thin: indexed only with text of its own (G7.2)
			robots: url && seo?.body ? 'index, follow' : 'noindex, follow',
			jsonLd: scriptJson({
				'@context': 'https://schema.org',
				'@graph': [
					{ '@type': 'DefinedTerm', '@id': `${at}#term`, name, description, ...(url ? { url } : {}) },
					settings.faqMarkup === true ? faqJsonLd(seo?.faqs, at) : null,
				].filter((node) => node !== null),
			}),
		};
	};

	/**
	 * GET /v1/seo/attributes/:slug and /v1/seo/attributes/:category/:slug (E45): with a category, the attribute defined
	 * for it or the nearest category above it first, then the one for every category that applies to it; without, the
	 * one for every category first.
	 * @param {any} ctx
	 */
	const attributeGlossary = async (ctx) => {
		const { s, data } = await open(ctx);
		const ref = String(ctx.params.slug);
		const category = await glossaryCategory(s, data, ctx.params.category);
		const named = (await attributesOf(data)).filter((row) => row.active && (row.slug === ref.toLowerCase() || row.id === ref));
		const lineage = category ? lineageOf([category.id], new Map([[category.id, category]])) : [];
		const attribute = category
			? (lineage.map((id) => named.find((row) => row.categoryId === id)).find(Boolean) ??
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
							.findOne({ websiteId: data.websiteId, id: attribute.categoryId }, NO_KEYS)) ?? null
					)
				: null);
		const slug = attribute.slug;
		const values = attribute.choices;
		const settings = await s.values('landing_pages');
		return {
			name: attribute.name,
			slug,
			unit: attribute.unit,
			values,
			categoryId: attribute.categoryId,
			category: page ? { id: page.id, slug: page.slug, name: page.name } : null,
			...(await glossaryProducts(ctx, s, data, { category: page, attribute })),
			...(await glossaryHead(s, {
				name: attribute.name,
				url: await glossaryUrl(s, 'attributeUrl', { slug, category: page?.slug ?? '' }),
				seo: attribute.seo,
				fallback: '',
				pattern: {
					title: settings.attributeTitle,
					description: settings.attributeDescription,
					values: {
						unit: attribute.unit,
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
	 * GET /v1/seo/grades/:key and /v1/seo/grades/:category/:key (E45): with a category, the grade as it or the nearest
	 * category above it defines it first, then the one for every category that applies to it.
	 * @param {any} ctx
	 */
	const gradeGlossary = async (ctx) => {
		const { s, data } = await open(ctx);
		const list = s.has('grades_serials') ? await s.list('grades') : [];
		const category = await glossaryCategory(s, data, ctx.params.category);
		const key = String(ctx.params.key);
		const lineage = category ? lineageOf([category.id], new Map([[category.id, category]])) : [];
		const grade = category ? gradesFor(list, lineage).get(key) : gradesByKey(list).get(key);
		const defined = Boolean(grade?.categoryId && lineage.includes(grade.categoryId));
		if (!grade || grade.active === false || (category && !defined && !appliesTo(grade, category)))
			throw problem('not_found', 'There is no such grade.');
		const page =
			category ??
			(grade.categoryId
				? /** @type {CategoryRecord | null} */ (
						(await data
							.collection(COLLECTIONS.categories)
							.findOne({ websiteId: data.websiteId, id: grade.categoryId }, NO_KEYS)) ?? null
					)
				: null);
		const patterns = await s.values('landing_pages');
		return {
			key: grade.key,
			label: grade.label,
			gradeDescription: grade.description,
			color: grade.color,
			condition: grade.condition,
			content: grade.content,
			categoryId: grade.categoryId,
			categoryIds: grade.categoryIds,
			category: page ? { id: page.id, slug: page.slug, name: page.name } : null,
			...(await glossaryProducts(ctx, s, data, { category: page, grade })),
			...(await glossaryHead(s, {
				name: grade.label,
				url: await glossaryUrl(s, 'gradeUrl', { key: grade.key, category: page?.slug ?? '' }),
				seo: grade.seo,
				fallback: grade.description,
				pattern: {
					title: patterns.gradeTitle,
					description: patterns.gradeDescription,
					values: { category: page?.name ?? '' },
				},
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
		 * @param {{ categoryId: string | null, categoryIds: string[] }} record
		 */
		const add = async (setting, values, record) => {
			const template = String(settings[setting] ?? '');
			if (!template) return;
			const own = record.categoryId ? names.byCategory.get(record.categoryId) : undefined;
			/** @type {Array<CategoryRecord | undefined>} */
			const places = record.categoryId
				? [own]
				: template.includes('{category}')
					? record.categoryIds.map((id) => names.byCategory.get(id))
					: [undefined];
			for (const place of places) {
				if (place === undefined && (record.categoryId || template.includes('{category}'))) continue;
				if (place && hidden.unlisted.has(place.id)) continue;
				const url = await glossaryUrl(s, setting, { ...values, category: place?.slug ?? '' });
				if (url) urls.add(url);
			}
		};
		// only pages with text of their own (G7.2), as they are indexed
		for (const attribute of await attributesOf(data))
			if (attribute.active && attribute.seo.body) await add('attributeUrl', { slug: attribute.slug }, attribute);
		for (const grade of names.gradeList) if (grade.active && grade.seo.body) await add('gradeUrl', { key: grade.key }, grade);
		return [...urls];
	};

	/**
	 * The indexed landing pages and the glossary pages, for the sitemaps: stored pages, automatic ones (reaching the
	 * numbers, or indexed before and still with a product, G7.7), dated by the newest content change of their products
	 * in stock (a stored page's own change when newer, G8.4).
	 * @param {Site} s @param {WebsiteData} data
	 * @returns {Promise<Array<{ loc: string, lastmod: Date | null }>>}
	 */
	const sitemapPages = async (s, data) => {
		if (!s.has('landing_pages')) return [];
		const names = await namesOf(s, data);
		const rows = /** @type {Array<LandingRecord & { updatedAt?: Date }>} */ (
			await data
				.collection(COLLECTIONS.landings)
				.find({ websiteId: data.websiteId }, NO_KEYS)
				.sort({ id: 1 })
				.limit(MAX_LANDINGS)
				.toArray()
		);
		const [rules, hidden, memory] = await Promise.all([rulesOf(s), hiddenFor(s), memoryOf(data)]);
		// the stock of every combination, read once for the stored and the automatic pages (E43): one aggregation per
		// facet field they name
		const table = await stockTable(s, data, names, [
			...rows.flatMap((row) => (row.facet ? [row.facet.field] : [])),
			...(rules.autoFacet ? [rules.autoFacet] : []),
		]);
		/** @param {Date | null | undefined} a @param {Date | null} b */
		const newest = (a, b) => (a && (!b || a > b) ? a : b);
		/** @type {Array<{ loc: string, lastmod: Date | null }>} */
		const out = [];
		for (const row of rows) {
			if (row.indexable === 'no') continue;
			// as its own head judges it: a hidden category's page is not found, and one whose category's products or whose
			// brand shoppers cannot see is not indexed (Google wants only indexable pages in a sitemap)
			if (row.categoryId && (hidden.unlisted.has(row.categoryId) || hidden.categoryIds.includes(row.categoryId))) continue;
			if (row.brandId && hidden.brandIds.includes(row.brandId)) continue;
			const stock = table.get(comboKey(row)) ?? NO_STOCK;
			const view = await viewOf(s, data, names, row, stock, memory);
			if (view.indexed) out.push({ loc: view.url, lastmod: newest(row.updatedAt, stock.lastmod) });
		}
		if (rules.mode !== 'off') {
			const stored = new Set(rows.map(comboKey));
			// the combinations with stock, and those indexed before that have none in stock now
			const keys = new Set([...table.keys(), ...[...memory].filter((key) => !table.has(key))]);
			/** @type {Array<{ key: string, combination: Combination, stock: import('../core/landings.js').ComboStock, meets: boolean }>} */
			const candidates = [];
			for (const key of keys) {
				if (stored.has(key)) continue;
				const combination = comboOfKey(key);
				const categoryId = combination.categoryId ?? '';
				if (!rules.automatic(combination)) continue;
				if (hidden.unlisted.has(categoryId) || hidden.categoryIds.includes(categoryId)) continue;
				const stock = table.get(key) ?? NO_STOCK;
				const meets = isIndexable({ indexable: 'auto' }, stock, rules.auto);
				if (meets || memory.has(key)) candidates.push({ key, combination, stock, meets });
			}
			// at most AUTO_LANDING_MAX_PAGES, the most products (then variants) in stock first, so the read stays bounded
			candidates.sort(
				(a, b) =>
					b.stock.products - a.stock.products ||
					b.stock.variants - a.stock.variants ||
					(a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
			);
			/** @type {string[]} */
			const fresh = [];
			let listed = 0;
			for (const { key, combination, stock, meets } of candidates) {
				if (listed >= rules.maxPages) break;
				// below the numbers: kept while it still has a product (else forgotten)
				if (!meets && !(await judged(s, data, names, combination, false, memory))) continue;
				if (meets && !memory.has(key)) fresh.push(key);
				out.push({ loc: await urlOf(s, names, combination), lastmod: stock.lastmod });
				listed += 1;
			}
			// the pages indexed for the first time, remembered at once
			await remember(data, memory, fresh, true);
		}
		for (const loc of await glossaryPages(s, data, names)) out.push({ loc, lastmod: null });
		return out;
	};

	/**
	 * With `auto` on and `autoCopy` at `ai` (E43): when staff save a product, write the AI copy of one of its automatic
	 * landing pages that has no record yet (its categories with its brand, and with `category_brand_facet` its values of
	 * the field `autoFacet`),
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
		const names = await namesOf(s, data);
		const place = rules.autoFacet ? names.placeOf(rules.autoFacet) : null;
		const active = item.variants.filter((v) => v.active);
		/** the product's values of the field `autoFacet` */
		const values = !place
			? []
			: 'grade' in place
				? facetValues(active.map((v) => v.grade))
				: facetValues(
						[
							...active.flatMap((v) => place.variantIds.map((id) => v.attributes?.[id])),
							...place.productIds.map((id) => item.specs?.[id]),
						].flat(),
					);
		/** @type {Array<Combination & { categoryId: string, brandId: string }>} */
		const combinations = item.categoryIds
			.flatMap((categoryId) =>
				[null, ...values.map((value) => ({ field: rules.autoFacet, value }))].map((facet) => ({
					categoryId,
					brandId: /** @type {string} */ (item.brandId),
					facet,
				})),
			)
			.slice(0, MAX_AUTO_TRIES);
		const stored = new Set(
			(
				await data
					.collection(COLLECTIONS.landings)
					.find(
						{ websiteId: data.websiteId, $or: combinations.map(comboQuery) },
						{ projection: { _id: 0, categoryId: 1, brandId: 1, facet: 1 } },
					)
					.toArray()
			).map((row) => comboKey({ categoryId: row.categoryId ?? null, brandId: row.brandId ?? null, facet: row.facet ?? null })),
		);
		const hidden = await hiddenFor(s);
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
					facet: combination.facet ? names.facetNames(combination.categoryId, combination.facet) : null,
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
			permission: 'catalog.edit',
			feature: 'landing_pages',
			rateLimit: SEO_LIMITS,
			handler: landings.list,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/landings',
			auth: 'server',
			permission: 'catalog.edit',
			feature: 'landing_pages',
			idempotent: true,
			rateLimit: SERVER_LIMITS,
			handler: landings.create,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/landings/:id',
			auth: 'server',
			permission: 'catalog.edit',
			feature: 'landing_pages',
			rateLimit: SEO_LIMITS,
			handler: landings.read,
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/landings/:id',
			auth: 'server',
			permission: 'catalog.edit',
			feature: 'landing_pages',
			rateLimit: SERVER_LIMITS,
			handler: landings.update,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/landings/:id',
			auth: 'server',
			permission: 'catalog.edit',
			feature: 'landing_pages',
			rateLimit: SERVER_LIMITS,
			handler: landings.remove,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/landings/:id/ai-copy',
			auth: 'server',
			permission: 'catalog.edit',
			feature: 'ai_copy',
			rateLimit: SERVER_LIMITS,
			handler: landings.aiCopy,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/landings',
			auth: 'ticket',
			permission: 'catalog.edit',
			feature: 'landing_pages',
			rateLimit: SERVER_LIMITS,
			handler: landings.list,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/landings',
			auth: 'ticket',
			permission: 'catalog.edit',
			feature: 'landing_pages',
			idempotent: true,
			rateLimit: SERVER_LIMITS,
			handler: landings.create,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/landings/:id',
			auth: 'ticket',
			permission: 'catalog.edit',
			feature: 'landing_pages',
			rateLimit: SERVER_LIMITS,
			handler: landings.read,
		}),
		defineRoute({
			method: 'PATCH',
			path: '/v1/admin/landings/:id',
			auth: 'ticket',
			permission: 'catalog.edit',
			feature: 'landing_pages',
			rateLimit: SERVER_LIMITS,
			handler: landings.update,
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/admin/landings/:id',
			auth: 'ticket',
			permission: 'catalog.edit',
			feature: 'landing_pages',
			rateLimit: SERVER_LIMITS,
			handler: landings.remove,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/landings/:id/ai-copy',
			auth: 'ticket',
			permission: 'catalog.edit',
			feature: 'ai_copy',
			rateLimit: SERVER_LIMITS,
			handler: landings.aiCopy,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/seo/listing',
			auth: 'server',
			runtime: true,
			feature: 'catalog',
			rateLimit: SEO_LIMITS,
			handler: conditional(listing, service.now),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/seo/attributes/:slug',
			auth: 'server',
			runtime: true,
			feature: 'landing_pages',
			rateLimit: SEO_LIMITS,
			handler: conditional(attributeGlossary, service.now),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/seo/attributes/:category/:slug',
			auth: 'server',
			runtime: true,
			feature: 'landing_pages',
			rateLimit: SEO_LIMITS,
			handler: conditional(attributeGlossary, service.now),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/seo/grades/:key',
			auth: 'server',
			runtime: true,
			feature: 'landing_pages',
			rateLimit: SEO_LIMITS,
			handler: conditional(gradeGlossary, service.now),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/seo/grades/:category/:key',
			auth: 'server',
			runtime: true,
			feature: 'landing_pages',
			rateLimit: SEO_LIMITS,
			handler: conditional(gradeGlossary, service.now),
		}),
	];

	return { routes, sitemapPages, writeAutoLanding };
};
