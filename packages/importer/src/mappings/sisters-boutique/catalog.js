/**
 * Sisters Boutique's catalog into Ecommerce (PLAN 0.8.10 Migration steps 3 and 5, "Conversion rules" Catalog, "Per
 * store" Catalog): size charts (with SB's built-in women's chart, E5, SF-3), categories (inactive ones hidden, PL-12),
 * attributes one record per SB document (the definition for its category, E45; never merged by slug, CA-23), brands one
 * per slug (Ecommerce keeps brand slugs unique per website; SB keeps one per category set), SB's cached category × brand SEO
 * pages as landing pages with their effective copy (SG-30), and products with their variants, photos (storage keys of
 * the existing files, so addresses do not change), video, rich description, size chart and SEO. SB refers by slug and
 * per category; the steps note lookup tables so later steps find ids.
 * @module
 */
import {
	created,
	derivedId,
	faqsOf,
	hexKey,
	isObject,
	mediaKey,
	numberedTable,
	paisa,
	photoOf,
	seoOf,
	siteAddress,
	text,
	typeOfKey,
} from './common.js';

/** @typedef {import('../../mapping.js').MappingStep} MappingStep */
/** @typedef {import('../../mapping.js').MapContext} MapContext */

/** Lookup tables of the catalog. */
export const TABLES = Object.freeze({
	categorySlugs: 'category-slugs',
	brandInCategory: 'brand-in-category',
	attributeInCategory: 'attribute-in-category',
	attributeOptions: 'attribute-options',
	productInCategory: 'product-in-category',
	productBrand: 'product-brand',
});

/** The name every record of a numbered table is noted under too (a slug is never `*`). */
export const ALL = '*';
/** Every category, numbered (`*#n`), for the order lines' snapshots. */
export const CATEGORIES = numberedTable('categories');
/** Every brand (`*#n`) and the brands of each slug (`slug:<slug>#n`): SB keeps one brand per category set. */
export const BRANDS = numberedTable('brands');
/** The attributes of each slug (`slug:<slug>#n`): SB keeps one attribute per category. */
export const ATTRIBUTES = numberedTable('attributes');

/**
 * SB's built-in size chart, shown when a product's chain names none (`apps/web/src/lib/core/sizeChart.ts`:95-113); it
 * becomes a chart record and the `size_charts` setting `defaultChartId` (SF-3).
 */
export const DEFAULT_CHART_ID = derivedId('szc', 'default-womens-size-chart');
const DEFAULT_CHART = Object.freeze({
	id: DEFAULT_CHART_ID,
	name: "Standard Women's Size Guide",
	unit: 'in',
	columns: [
		{ key: 'bust', label: 'Bust' },
		{ key: 'waist', label: 'Waist' },
		{ key: 'hip', label: 'Hip' },
		{ key: 'kameez', label: 'Shirt Length' },
	],
	rows: [
		{ size: 'xs', label: 'XS (Extra Small)', values: { bust: '32', waist: '26', hip: '36', kameez: '38' } },
		{ size: 's', label: 'S (Small)', values: { bust: '35', waist: '28', hip: '38', kameez: '39' } },
		{ size: 'm', label: 'M (Medium)', values: { bust: '38', waist: '31', hip: '41', kameez: '40' } },
		{ size: 'l', label: 'L (Large)', values: { bust: '42', waist: '35', hip: '45', kameez: '41' } },
		{ size: 'xl', label: 'XL (Extra Large)', values: { bust: '46', waist: '39', hip: '49', kameez: '42' } },
	],
	fitAdvice:
		'Designed for a standard relaxed fit. Select your standard size or use our interactive size finder to match your body measurements.',
	notes: 'All measurements are body measurements in inches unless toggled to centimetres.',
	active: true,
});

/** SB's card positions → Ecommerce's (IMP-46). */
const CARDS = Object.freeze(/** @type {Record<string, string>} */ ({ 'image-overlay': 'image', 'title-chips': 'chips' }));

/**
 * A size chart's rows: values of the chart's columns only (SB shows only those), as text.
 * @param {Record<string, any>} doc
 */
const chartRows = (doc) => {
	const keys = new Set(
		(Array.isArray(doc.measurementKeys) ? doc.measurementKeys : []).map((/** @type {any} */ c) => text(c?.key)),
	);
	return (Array.isArray(doc.rows) ? doc.rows : []).filter(isObject).map((row) => ({
		size: text(row.sizeValue),
		label: text(row.label) || text(row.sizeValue),
		values: Object.fromEntries(
			Object.entries(isObject(row.values) ? row.values : {})
				.filter(([key, value]) => keys.has(key) && value !== null && value !== undefined && String(value).trim() !== '')
				.map(([key, value]) => [key, String(value).trim()]),
		),
	}));
};

/** The id of a size chart SB names, when it was imported (else none: SB falls back as Ecommerce does). */
const chartOf = (/** @type {unknown} */ id, /** @type {MapContext} */ ctx) => (hexKey(id) ? ctx.ref('sizecharts', id) : null);

/**
 * SB's structured copy (`{ summary, bullets: [{ text, icon }] }`) as Ecommerce's category content.
 * @param {unknown} content
 */
const contentOf = (content) =>
	isObject(content)
		? {
				summary: text(content.summary),
				bullets: (Array.isArray(content.bullets) ? content.bullets : [])
					.filter(isObject)
					.map((bullet) => ({ text: text(bullet.text), icon: text(bullet.icon) })),
			}
		: null;

/** @type {ReadonlyArray<MappingStep>} */
export const taxonomySteps = Object.freeze([
	{
		product: 'ecommerce',
		collection: 'size_charts',
		source: 'sizecharts',
		prefix: 'szc',
		map: (doc, ctx) => ({
			id: ctx.id('szc', doc._id),
			name: text(doc.name),
			unit: doc.unitPrimary === 'cm' ? 'cm' : 'in',
			columns: (Array.isArray(doc.measurementKeys) ? doc.measurementKeys : [])
				.filter(isObject)
				.map((column) => ({ key: text(column.key), label: text(column.label) })),
			rows: chartRows(doc),
			fitAdvice: text(doc.fitAdvice),
			notes: text(doc.notes),
			active: doc.isActive !== false,
			...created(doc.createdAt),
		}),
	},
	{
		product: 'ecommerce',
		collection: 'categories',
		source: 'categories',
		prefix: 'cat',
		lookups: {
			[TABLES.categorySlugs]: (record) => String(record.slug),
			[CATEGORIES.table]: (record) => CATEGORIES.keysOf(record),
		},
		map: (doc, ctx) => {
			const seo = seoOf(doc.seo);
			const content = contentOf(doc.content);
			const sizeChartId = chartOf(doc.defaultSizeChartId, ctx);
			return CATEGORIES.claim(
				{
					id: ctx.id('cat', doc._id),
					slug: text(doc.slug),
					name: text(doc.label),
					parentId: null,
					description: text(doc.description),
					...(Object.keys(seo).length > 0 ? { seo } : {}),
					sort: Number.isSafeInteger(doc.sortOrder) ? doc.sortOrder : Math.round(Number(doc.sortOrder) || 0),
					// SB's inactive categories are hidden (PL-12)
					status: doc.isActive === false ? 'hidden' : 'active',
					...(text(doc.icon) ? { icon: text(doc.icon) } : {}),
					...(content ? { content } : {}),
					faqs: faqsOf(doc.seo),
					...(sizeChartId ? { sizeChartId } : {}),
					...created(doc.createdAt),
				},
				[ALL],
				ctx,
			);
		},
	},
	{
		// one brand per slug: SB keeps one per category set, Ecommerce's slugs are unique per website (CA-11); the
		// categories are those of its active records, and it is active when one of them is
		product: 'ecommerce',
		collection: 'brands',
		source: 'brands',
		prefix: 'brd',
		mergeKey: (_doc, record) => String(record.slug),
		merge: (kept, next) => {
			const active = [kept, next].filter((brand) => brand.status === 'active');
			const from = active.length > 0 ? active : [kept, next];
			return {
				...kept,
				status: active.length > 0 ? 'active' : 'hidden',
				categoryIds: [...new Set(from.flatMap((brand) => /** @type {string[]} */ (brand.categoryIds)))],
				...(kept.seo || !next.seo ? {} : { seo: next.seo }),
				...(kept.sizeChartId || !next.sizeChartId ? {} : { sizeChartId: next.sizeChartId }),
			};
		},
		lookups: {
			[TABLES.brandInCategory]: (record, doc) =>
				(Array.isArray(doc.categorySlugs) ? doc.categorySlugs : []).map((slug) => `${text(slug)}/${String(record.slug)}`),
			[BRANDS.table]: (record) => BRANDS.keysOf(record),
		},
		map: (doc, ctx) => {
			const seo = seoOf(doc.seo);
			const sizeChartId = chartOf(doc.defaultSizeChartId, ctx);
			const slug = text(doc.slug);
			return BRANDS.claim(
				{
					id: ctx.id('brd', doc._id),
					slug,
					name: text(doc.name),
					status: doc.isActive === false ? 'hidden' : 'active',
					categoryIds: (Array.isArray(doc.categorySlugs) ? doc.categorySlugs : [])
						.map((category) => ctx.lookup(TABLES.categorySlugs, text(category)))
						.filter((id) => id !== null),
					...(Object.keys(seo).length > 0 ? { seo } : {}),
					...(sizeChartId ? { sizeChartId } : {}),
					...created(doc.createdAt),
				},
				[ALL, `slug:${slug}`],
				ctx,
			);
		},
	},
	{
		product: 'ecommerce',
		collection: 'attributes',
		source: 'attributes',
		prefix: 'att',
		// the attribute records take `multiple` from the products later (see `attributeFixStep`)
		mergeKey: (_doc, record) => String(record.id),
		lookups: {
			[TABLES.attributeInCategory]: (record, doc) => `${text(doc.categorySlug)}/${String(record.slug)}`,
			[TABLES.attributeOptions]: (record) =>
				/** @type {Array<{ value: string }>} */ (record.choices).map((choice) => `${String(record.id)}|${choice.value}`),
			[ATTRIBUTES.table]: (record) => ATTRIBUTES.keysOf(record),
		},
		map: (doc, ctx) => {
			const categoryId = ctx.lookup(TABLES.categorySlugs, text(doc.categorySlug));
			const slug = text(doc.slug);
			const visibility = doc.visibility?.type;
			const brandIds =
				visibility === 'brand'
					? (Array.isArray(doc.visibility.brandSlugs) ? doc.visibility.brandSlugs : [])
							.map((/** @type {unknown} */ brand) =>
								ctx.lookup(TABLES.brandInCategory, `${text(doc.categorySlug)}/${text(brand)}`),
							)
							.filter((/** @type {string | null} */ id) => id !== null)
					: [];
			const seo = isObject(doc.seo) ? doc.seo : null;
			return ATTRIBUTES.claim(
				{
					id: ctx.id('att', doc._id),
					slug,
					name: text(doc.label),
					type: 'choice',
					choices: (Array.isArray(doc.options) ? doc.options : [])
						.filter(isObject)
						.map((option) => ({ value: text(option.value), label: text(option.label) || text(option.value) })),
					...(text(doc.unit) ? { unit: text(doc.unit) } : {}),
					filterable: true,
					// the definition for its category (E45: the same slug once per category), applying to it alone
					...(categoryId ? { categoryId, categoryIds: [categoryId] } : { categoryIds: [] }),
					on: 'variant',
					multiple: false,
					// SB reads `attribute` visibility as always (IMP-46); brand visibility names the brands of the category
					visibility: brandIds.length > 0 ? { when: 'brands', ids: brandIds } : 'always',
					card: CARDS[doc.cardPosition] ?? 'chips',
					active: doc.isActive !== false,
					...(seo
						? { seo: { title: text(seo.title), description: text(seo.description), body: '', faqs: faqsOf(seo) } }
						: {}),
					...created(doc.createdAt),
				},
				[`slug:${slug}`],
				ctx,
			);
		},
	},
	{
		// SB's cached category × brand pages (`?brand=`) as landing pages with the copy SB shows (overrides first)
		product: 'ecommerce',
		collection: 'landings',
		source: 'seosurfaces',
		prefix: 'lnd',
		map: (doc, ctx) => {
			const category = text(doc.categorySlug);
			const categoryId = ctx.lookup(TABLES.categorySlugs, category);
			const brandId =
				ctx.lookup(TABLES.brandInCategory, `${category}/${text(doc.brandSlug)}`) ??
				BRANDS.all(`slug:${text(doc.brandSlug)}`, ctx)[0] ??
				null;
			if (!categoryId || !brandId) return null;
			return {
				id: ctx.id('lnd', doc._id),
				categoryId,
				brandId,
				h1: text(doc.headlineOverride) || text(doc.headline),
				title: text(doc.titleOverride) || text(doc.title),
				description: text(doc.descriptionOverride) || text(doc.description),
				intro: text(doc.introOverride) || text(doc.intro),
				// indexed while enough of its products are in stock (landing_pages.landingMinProducts, SG-10)
				indexable: 'auto',
				...created(doc.createdAt),
			};
		},
	},
]);

/**
 * A product's video (E4): a YouTube or other https address as an address (http made https), else an uploaded file's
 * key with its type.
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
const videoOf = (value) => {
	const raw = text(value);
	if (raw === '') return null;
	if (/^(https?:)?\/\//i.test(raw)) {
		const url = siteAddress(raw);
		return /(^|\.)(youtube\.com|youtu\.be)\//i.test(url.replace(/^https:\/\//i, '').replace(/^www\./i, ''))
			? { kind: 'youtube', id: url }
			: { kind: 'url', url };
	}
	const key = mediaKey(raw);
	return { kind: 'file', key, type: typeOfKey(key), size: 0 };
};

/**
 * What one product's variant attributes become (E7): the values keyed by the attribute's id in the product's category;
 * stale keys (not in the product's `attributeSlugs`, or with no attribute in its category) are cleared as SB's own
 * filter does (IMP-28); a product-only custom value keeps its label (SF-5).
 * @param {Record<string, any>} doc @param {MapContext} ctx
 */
const attributeRules = (doc, ctx) => {
	const category = text(doc.categorySlug);
	const allowed = Array.isArray(doc.attributeSlugs) ? new Set(doc.attributeSlugs.map(text)) : null;
	/** @param {string} slug */
	const idOf = (slug) => (allowed && !allowed.has(slug) ? null : ctx.lookup(TABLES.attributeInCategory, `${category}/${slug}`));
	/** @param {string} attributeId @param {string} value */
	const isChoice = (attributeId, value) => ctx.lookup(TABLES.attributeOptions, `${attributeId}|${value}`) !== null;
	const customs = isObject(doc.attributeCustomOptions) ? doc.attributeCustomOptions : {};
	/**
	 * A value as Ecommerce keeps it: a choice's value, else the custom option's label.
	 * @param {string} slug @param {string} attributeId @param {string} value @param {Record<string, any>} [variant]
	 */
	const valueOf = (slug, attributeId, value, variant) => {
		if (isChoice(attributeId, value)) return value;
		const custom = (Array.isArray(customs[slug]) ? customs[slug] : []).find(
			(/** @type {any} */ option) => text(option?.value) === value,
		);
		return text(custom?.label) || text(variant?.attributeDisplay?.[slug]) || value;
	};
	return { idOf, isChoice, valueOf, customs };
};

/**
 * A product's attribute setup (E7): per used attribute, its allowed choices, its own values (their labels) and the
 * value picked first.
 * @param {Record<string, any>} doc @param {ReturnType<typeof attributeRules>} rules
 * @param {Array<{ attributes: Record<string, string | string[]> }>} variants the mapped variants
 */
const setupOf = (doc, rules, variants) => {
	const slugs = Array.isArray(doc.attributeSlugs) ? doc.attributeSlugs.map(text) : [];
	const pool = isObject(doc.attributeOptionPool) ? doc.attributeOptionPool : {};
	const defaults = isObject(doc.attributeDefaults) ? doc.attributeDefaults : {};
	return slugs.flatMap((slug) => {
		const attributeId = rules.idOf(slug);
		if (!attributeId) return [];
		const values = [...new Set((Array.isArray(pool[slug]) ? pool[slug] : []).map(text))].filter((value) =>
			rules.isChoice(attributeId, value),
		);
		const customValues = [
			...new Set([
				...(Array.isArray(rules.customs[slug]) ? rules.customs[slug] : []).map(
					(/** @type {any} */ option) => text(option?.label) || text(option?.value),
				),
				...variants
					.flatMap((variant) => [variant.attributes[attributeId] ?? []].flat())
					.filter((value) => !rules.isChoice(attributeId, value)),
			]),
		].filter(Boolean);
		const picked = text(defaults[slug]) ? rules.valueOf(slug, attributeId, text(defaults[slug])) : '';
		return [
			{
				attributeId,
				values,
				customValues,
				defaultValue: values.includes(picked) || customValues.includes(picked) ? picked : null,
			},
		];
	});
};

/**
 * The products (E1–E16): status (archived, active, or a draft when hidden or without variants, CA-2), category and
 * brand (the brand of its category; SB keeps one per category set), photos, video, rich description, size chart, SEO
 * and FAQs; variants in paisa with their stock, sold-out flag, warranty and attribute values.
 * @type {MappingStep}
 */
export const productStep = {
	product: 'ecommerce',
	collection: 'products',
	source: 'products',
	prefix: 'prd',
	lookups: {
		[TABLES.productInCategory]: (record) =>
			/** @type {string[]} */ (record.categoryIds).map((id) => `${String(record.id)}|${id}`),
		[TABLES.productBrand]: (record) => (record.brandId ? `${String(record.id)}|${String(record.brandId)}` : null),
	},
	map: (doc, ctx) => {
		const category = text(doc.categorySlug);
		const categoryId = ctx.lookup(TABLES.categorySlugs, category);
		const brandSlug = text(doc.brandSlug);
		const brandId =
			ctx.lookup(TABLES.brandInCategory, `${category}/${brandSlug}`) ?? BRANDS.all(`slug:${brandSlug}`, ctx)[0] ?? null;
		const rules = attributeRules(doc, ctx);
		// SB's Google feed listed each variant as <product hex>_<variant hex> in the group <product hex>
		// (`packages/shared/src/seo/merchantFeed.ts`): kept as the feed ids, so Merchant Center keeps its items (E17)
		const productHex = hexKey(doc._id);
		const variants = (Array.isArray(doc.variants) ? doc.variants : []).filter(isObject).map((variant) => {
			/** @type {Record<string, string | string[]>} */
			const attributes = {};
			for (const [slug, raw] of Object.entries(isObject(variant.attributes) ? variant.attributes : {})) {
				const attributeId = rules.idOf(slug);
				if (!attributeId) continue;
				const values = [raw]
					.flat()
					.map((value) => text(value === null || value === undefined ? '' : String(value)))
					.filter(Boolean)
					.map((value) => rules.valueOf(slug, attributeId, value, variant));
				if (values.length > 0) attributes[attributeId] = Array.isArray(raw) ? values : /** @type {string} */ (values[0]);
			}
			const warrantyDays = Number(variant.warrantyDays);
			const variantHex = hexKey(variant._id);
			return {
				id: ctx.id('var', variant._id),
				...(productHex && variantHex ? { feedId: `${productHex}_${variantHex}` } : {}),
				price: paisa(variant.priceRupees),
				stock: Math.max(0, Math.round(Number(variant.quantity) || 0)),
				soldOut: variant.forceOutOfStock === true,
				...(Number.isSafeInteger(warrantyDays) && warrantyDays >= 0 ? { warrantyDays } : {}),
				attributes,
				active: true,
			};
		});
		const setup = setupOf(doc, rules, variants);
		const status = doc.isArchived === true ? 'archived' : doc.isActive === false || variants.length === 0 ? 'draft' : 'active';
		const seo = seoOf(doc.seo);
		const video = videoOf(doc.video);
		const sizeChartId = chartOf(doc.sizeChartId, ctx);
		return {
			id: ctx.id('prd', doc._id),
			slug: text(doc.slug),
			name: text(doc.name),
			status,
			...(productHex ? { feedGroupId: productHex } : {}),
			categoryIds: categoryId ? [categoryId] : [],
			brandId,
			featured: doc.isFeatured === true,
			media: (Array.isArray(doc.images) ? doc.images : []).map(photoOf).filter((photo) => photo !== null),
			...(video ? { video } : {}),
			...(text(doc.descriptionHtml) ? { descriptionHtml: text(doc.descriptionHtml) } : {}),
			variants,
			...(setup.length > 0 ? { attributeSetup: setup } : {}),
			...(sizeChartId ? { sizeChartId } : {}),
			...(typeof doc.hideSizeGuide === 'boolean' ? { hideSizeGuide: doc.hideSizeGuide } : {}),
			...(Object.keys(seo).length > 0 ? { seo } : {}),
			faqs: faqsOf(doc.seo),
			...created(doc.createdAt),
		};
	},
	sums: (record) => {
		const variants = /** @type {Array<{ stock: number }>} */ (record.variants);
		return {
			products: 1,
			...(record.status === 'archived' ? {} : { [`products.${record.status}`]: 1 }),
			variants: variants.length,
			'stock.units': variants.reduce((sum, variant) => sum + variant.stock, 0),
		};
	},
	countPath: '/v1/products/count',
};

/**
 * SB's built-in chart, once (it exists in SB's code only): read off the products after they are mapped, so the
 * products keep their id-map entries, and merged into one record of the size charts' file (sent before the products).
 * @type {MappingStep}
 */
export const defaultChartStep = {
	product: 'ecommerce',
	collection: 'size_charts',
	source: 'products',
	prefix: 'szc',
	mergeKey: () => DEFAULT_CHART_ID,
	map: () => structuredClone({ ...DEFAULT_CHART }),
};

/**
 * Attributes a variant holds several values of take several (SB allows a list on any attribute; Ecommerce only on
 * attributes marked `multiple`): read off the products and merged into the attribute records (sent before the
 * products).
 * @type {MappingStep}
 */
export const attributeFixStep = {
	product: 'ecommerce',
	collection: 'attributes',
	source: 'products',
	prefix: 'att',
	mergeKey: (_doc, record) => String(record.id),
	merge: (kept) => ({ ...kept, multiple: true }),
	map: (doc, ctx) => {
		const rules = attributeRules(doc, ctx);
		const ids = new Set(
			(Array.isArray(doc.variants) ? doc.variants : [])
				.filter(isObject)
				.flatMap((variant) =>
					Object.entries(isObject(variant.attributes) ? variant.attributes : {})
						.filter(([, value]) => Array.isArray(value) && value.length > 0)
						.map(([slug]) => rules.idOf(slug)),
				)
				.filter((id) => id !== null),
		);
		return [...ids].map((id) => ({ id, multiple: true }));
	},
};
