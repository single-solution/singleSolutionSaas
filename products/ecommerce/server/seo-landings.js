/**
 * Landing pages, listing SEO and glossary pages (PLAN 0.8.10 E15). Landing pages (feature `landing_pages`) are a
 * category, brand and grade combination with its own copy, for the merchant's server (`/v1/landings…`, server token)
 * and the catalog admin widget (`/v1/admin/landings…`, ticket with `catalog.edit`), with AI copy suggestions (with
 * `ai_copy`). `GET /v1/seo/listing` answers the heading, title, description, introduction, FAQs, canonical address,
 * JSON-LD and robots of any listing the site renders: `index` only for a category (and its pages) and for an indexable
 * landing page, `noindex` for any other filter. Glossary pages explain an attribute or a grade. Indexable landing
 * pages and glossary pages are listed in the sitemaps.
 * @module
 */
import { createId } from '@ss/contracts';
import { created, defineRoute, problem } from '@ss/app-kit';
import { NO_ID, attributesOf, brandsOf, categoriesOf, findBySlugHistory, isDuplicate } from '../adapters/catalog-store.js';
import { checkLandingAiRequest, landingPrompt, readSuggestions } from '../core/catalog-ai.js';
import { siteAddress } from '../core/catalog-content.js';
import { listOf, shopFilter } from '../core/catalog-query.js';
import { withDescendants } from '../core/catalog-taxonomy.js';
import { checkLanding, isIndexable, landingFor, landingLink } from '../core/landings.js';
import { absolute } from '../core/links.js';
import { COLLECTIONS, ID_PREFIX } from '../core/model.js';
import { categoryJsonLd, faqJsonLd, fillTitle, metaDescription, robotsOf, scriptJson } from '../core/seo.js';
import { gradesByKey } from '../core/grades.js';
import { hiddenFor } from './catalog-visibility.js';
import { SERVER_LIMITS } from './service.js';
import { trailOf } from './seo-reads.js';

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
/** At most this many landing pages per website. */
const MAX_LANDINGS = 2000;
/** Products in a listing's ItemList. */
const LIST_ITEMS = 20;
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
		const [categories, brands, grades] = await Promise.all([
			categoriesOf(data),
			brandsOf(data),
			s.has('grades_serials') ? s.list('grades').then(gradesByKey) : Promise.resolve(new Map()),
		]);
		return {
			categories,
			byCategory: new Map(categories.map((c) => [c.id, c])),
			byBrand: new Map(brands.map((b) => [b.id, b])),
			grades: /** @type {Map<string, Grade>} */ (grades),
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
	 * A landing page with its address, products in stock and whether it is indexed now.
	 * @param {Site} s @param {WebsiteData} data @param {Awaited<ReturnType<typeof namesOf>>} names @param {LandingRecord} landing
	 */
	const viewOf = async (s, data, names, landing) => {
		const inStock = await data
			.collection(COLLECTIONS.products)
			.countDocuments(await filterOf(s, names, landing, true), { limit: 1000 });
		const { landingMinProducts } = await s.values('landing_pages');
		return {
			...landing,
			url: await urlOf(s, names, landing),
			inStock,
			indexed: isIndexable(landing, inStock, Number(landingMinProducts)),
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
			return { items: await Promise.all(shown.map((row) => viewOf(s, data, names, row))) };
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
			return created(await viewOf(s, data, names, record));
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
			return viewOf(s, data, names, { id: existing.id, ...checked.value });
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
					grade: landing.grade ? (names.grades.get(landing.grade)?.label ?? landing.grade) : null,
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
			if (found.moved) return { moved: { slug: record.slug, url: await media.categoryUrl(s, record) } };
			category = record;
		}
		const brandRefs = listOf(ctx.query.brand);
		const gradeKeys = listOf(ctx.query.grade);
		const brand =
			brandRefs.length === 1
				? ([...names.byBrand.values()].find((b) => b.id === brandRefs[0] || b.slug === brandRefs[0]) ?? null)
				: null;
		const grade = gradeKeys.length === 1 ? (names.grades.get(/** @type {string} */ (gradeKeys[0])) ?? null) : null;
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
		const categoryIndexable =
			category !== null &&
			!hidden.categoryIds.includes(category.id) &&
			category.seo?.noindex !== true &&
			brand === null &&
			grade === null &&
			exact;
		const indexed = categoryIndexable || (view?.indexed === true && exact);
		const pageUrl = view ? view.url : category ? await media.categoryUrl(s, category) : `https://${s.domain}/`;
		const canonicalBase = category?.seo?.canonicalUrl && !view ? absolute(category.seo.canonicalUrl, s.domain) : pageUrl;
		const canonical = page > 1 ? `${canonicalBase}${canonicalBase.includes('?') ? '&' : '?'}page=${page}` : canonicalBase;
		const h1 = landing?.h1 || [category?.name, brand?.name, grade?.label].filter(Boolean).join(' ') || business.name;
		const title = fillTitle(String(settings.titleTemplate), {
			name: landing?.title || (category && !brand && !grade ? category.seo?.title : '') || h1,
			business: business.name,
		});
		const description = metaDescription(
			landing?.description,
			category?.seo?.description,
			category?.content?.summary,
			category?.description,
			brand?.seo?.description,
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
			trail: await trailOf(s, data, media, category, view !== null, business.name),
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
			robots: indexed ? robotsOf(category?.seo) : 'noindex, follow',
			landing: view ? { id: view.id, url: view.url, indexed: view.indexed, inStock: view.inStock } : null,
			jsonLd: scriptJson(jsonLd),
		};
	};

	/**
	 * A glossary page's address (`attributeUrl` or `gradeUrl`), or null without one.
	 * @param {Site} s @param {'attributeUrl' | 'gradeUrl'} setting @param {string} placeholder @param {string} value
	 */
	const glossaryUrl = async (s, setting, placeholder, value) => {
		const template = String((await s.values('landing_pages'))[setting] ?? '');
		return template ? absolute(template.replaceAll(placeholder, encodeURIComponent(value)), s.domain) : null;
	};

	/**
	 * The head of a glossary page.
	 * @param {Site} s
	 * @param {{ name: string, url: string | null, seo: { title: string, description: string, body: string, faqs: Array<{ question: string, answer: string }> } | undefined, fallback: string }} page
	 */
	const glossaryHead = async (s, { name, url, seo, fallback }) => {
		const [settings, business] = await Promise.all([s.values('seo'), s.business()]);
		const description = metaDescription(seo?.description, seo?.body, fallback, settings.defaultDescription);
		const at = url ?? `https://${s.domain}/`;
		return {
			title: fillTitle(String(settings.titleTemplate), { name: seo?.title || name, business: business.name }),
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

	/** GET /v1/seo/attributes/:slug. @param {any} ctx */
	const attributeGlossary = async (ctx) => {
		const { s, data } = await open(ctx);
		const ref = String(ctx.params.slug);
		const attribute = (await attributesOf(data)).find(
			(row) => row.active !== false && (row.slug === ref.toLowerCase() || row.id === ref),
		);
		if (!attribute) throw problem('not_found', 'There is no such attribute.');
		const slug = attribute.slug ?? attribute.id;
		return {
			name: attribute.name,
			slug,
			unit: attribute.unit,
			values: (attribute.choices ?? []).map((choice) =>
				typeof choice === 'string' ? { value: choice, label: choice } : choice,
			),
			...(await glossaryHead(s, {
				name: attribute.name,
				url: await glossaryUrl(s, 'attributeUrl', '{slug}', slug),
				seo: attribute.seo,
				fallback: '',
			})),
		};
	};

	/** GET /v1/seo/grades/:key. @param {any} ctx */
	const gradeGlossary = async (ctx) => {
		const { s } = await open(ctx);
		const grades = s.has('grades_serials') ? gradesByKey(await s.list('grades')) : new Map();
		const grade = grades.get(String(ctx.params.key));
		if (!grade || grade.active === false) throw problem('not_found', 'There is no such grade.');
		return {
			key: grade.key,
			label: grade.label,
			gradeDescription: grade.description,
			color: grade.color ?? '',
			condition: grade.condition ?? null,
			content: grade.content ?? { summary: '', bullets: [] },
			categoryIds: grade.categoryIds ?? [],
			...(await glossaryHead(s, {
				name: grade.label,
				url: await glossaryUrl(s, 'gradeUrl', '{key}', grade.key),
				seo: grade.seo,
				fallback: grade.description,
			})),
		};
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
		/** @type {Array<{ loc: string, lastmod: Date | null }>} */
		const out = [];
		for (const row of rows) {
			if (row.indexable === 'no') continue;
			const view = await viewOf(s, data, names, row);
			if (view.indexed) out.push({ loc: view.url, lastmod: row.updatedAt ?? null });
		}
		/** @param {{ seo?: { body?: string, description?: string } }} record */
		const explained = (record) => Boolean(record.seo?.body || record.seo?.description);
		for (const attribute of await attributesOf(data)) {
			if (attribute.active === false || !explained(attribute)) continue;
			const url = await glossaryUrl(s, 'attributeUrl', '{slug}', attribute.slug ?? attribute.id);
			if (url) out.push({ loc: url, lastmod: null });
		}
		for (const grade of names.grades.values()) {
			if (grade.active === false || !explained(grade)) continue;
			const url = await glossaryUrl(s, 'gradeUrl', '{key}', grade.key);
			if (url) out.push({ loc: url, lastmod: null });
		}
		return out;
	};

	const routes = [
		defineRoute({
			method: 'GET',
			path: '/v1/landings',
			auth: 'server',
			feature: 'landing_pages',
			rateLimit: RATE,
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
			rateLimit: RATE,
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
		defineRoute({ method: 'GET', path: '/v1/seo/listing', auth: 'server', feature: 'seo', rateLimit: RATE, handler: listing }),
		defineRoute({
			method: 'GET',
			path: '/v1/seo/attributes/:slug',
			auth: 'server',
			feature: 'landing_pages',
			rateLimit: RATE,
			handler: attributeGlossary,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/seo/grades/:key',
			auth: 'server',
			feature: 'landing_pages',
			rateLimit: RATE,
			handler: gradeGlossary,
		}),
	];

	return { routes, sitemapPages };
};
