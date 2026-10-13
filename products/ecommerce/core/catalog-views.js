/**
 * What shoppers and staff see of the catalog (PLAN 0.8.8 Shopper widgets: the product grid and the product page;
 * Admin widgets: products and catalog): product cards, the product page's data and the staff's product rows. Shoppers
 * never see exact stock counts, costs or draft products; image and page addresses are made by the caller and passed
 * in. No I/O.
 * @module
 */
import { summarize, valueLabel, variantInStock, variantName } from './catalog.js';
import { gradeView } from './grades.js';

/** @typedef {import('./model.js').ProductRecord} ProductRecord */
/** @typedef {import('./model.js').VariantRecord} VariantRecord */
/** @typedef {import('./model.js').AttributeRecord} AttributeRecord */
/** @typedef {import('./grades.js').Grade} Grade */

/**
 * The "was" price shown next to a price: the cheapest active variant's, when higher than its price.
 * @param {ProductRecord} product
 * @returns {number | null}
 */
export const compareAtOf = (product) => {
	const active = product.variants.filter((variant) => variant.active);
	const cheapest = active.reduce(
		(best, variant) => (best === null || variant.price < best.price ? variant : best),
		/** @type {VariantRecord | null} */ (null),
	);
	return cheapest && cheapest.compareAtPrice !== null && cheapest.compareAtPrice > cheapest.price
		? cheapest.compareAtPrice
		: null;
};

/**
 * The grade labels of a product's active variants, in the order of the grades list.
 * @param {ProductRecord} product
 * @param {ReadonlyMap<string, Grade>} grades
 */
const gradeLabels = (product, grades) => {
	const keys = new Set(product.variants.filter((v) => v.active && v.grade).map((v) => v.grade));
	return [...grades.values()].filter((grade) => keys.has(grade.key)).map((grade) => grade.label);
};

/**
 * @typedef {object} Card
 * @property {string} id
 * @property {string} slug
 * @property {string} name
 * @property {number} price
 * @property {number | null} compareAtPrice
 * @property {string} currency
 * @property {string | null} image
 * @property {string} url
 * @property {boolean} inStock
 * @property {{ average: number, count: number }} rating
 * @property {{ id: string, name: string, slug?: string } | null} brand
 * @property {string[]} grades
 * @property {number} variantCount
 * @property {number} priceMax the highest active variant price (E8)
 * @property {boolean} featured (E2)
 * @property {Array<{ url: string | null, alt: string }>} cardImages the first photo of up to 4 variants that look
 *   different (E6)
 * @property {CardVariant[]} [variants] the active variants, when the listing asks for them (SF-6)
 */

/**
 * A variant on a card (SF-6): what a website needs to draw its own cards (price ranges and "was" prices of its own
 * rule, attribute chips, a link to the variant it picks), never stock counts or costs.
 * @typedef {object} CardVariant
 * @property {string} id
 * @property {Record<string, string>} options
 * @property {Array<{ slug: string, name: string, label: string }>} attributes
 * @property {number} price
 * @property {number | null} compareAtPrice the "was" price when higher than the price
 * @property {boolean} inStock
 * @property {string | null} grade the grade's key
 * @property {string} url the variant's page (E13)
 */

/**
 * The active variants of a product as cards carry them (SF-6).
 * @param {ProductRecord} product
 * @param {{ attributes: ReadonlyMap<string, AttributeRecord>, variantUrls: ReadonlyMap<string, string>, url: string }} context
 * @returns {CardVariant[]}
 */
export const cardVariantsOf = (product, { attributes, variantUrls, url }) =>
	product.variants
		.filter((variant) => variant.active)
		.map((variant) => ({
			id: variant.id,
			options: variant.options ?? {},
			attributes: Object.entries(variant.attributes ?? {}).flatMap(([id, value]) => {
				const attribute = attributes.get(id);
				return attribute ? [{ slug: attribute.slug ?? id, name: attribute.name, label: valueLabel(attribute, value) }] : [];
			}),
			price: variant.price,
			compareAtPrice:
				variant.compareAtPrice !== null && variant.compareAtPrice > variant.price ? variant.compareAtPrice : null,
			inStock: variantInStock(variant, product.trackStock),
			grade: variant.grade ?? null,
			url: variantUrls.get(variant.id) ?? url,
		}));

/**
 * The variants whose first photos a card shows (E6): active variants with photos, one per photo (variants that share
 * their first photo look the same), at most 4.
 * @param {ProductRecord} product
 * @returns {Array<import('./model.js').MediaRecord>}
 */
export const cardPhotos = (product) => {
	/** @type {Array<import('./model.js').MediaRecord>} */
	const out = [];
	for (const variant of product.variants) {
		const first = variant.active ? variant.media?.[0] : undefined;
		if (first && !out.some((file) => file.key === first.key)) out.push(first);
		if (out.length === 4) break;
	}
	return out;
};

/**
 * How many units shoppers are told are left (E9): never, only at `low` or fewer, or always; 0 for a variant marked sold
 * out; null when not shown or stock is not tracked.
 * @param {Pick<VariantRecord, 'stock' | 'soldOut' | 'active'>} variant
 * @param {boolean} trackStock
 * @param {{ showStock: string, lowStockShown: number }} settings
 * @returns {number | null}
 */
export const stockLeftOf = (variant, trackStock, { showStock, lowStockShown }) => {
	if (!trackStock || showStock === 'none') return null;
	const left = variant.soldOut === true || !variant.active ? 0 : variant.stock;
	return showStock === 'always' || left <= lowStockShown ? left : null;
};

/**
 * A product card (grid, search results, wishlist, compare, Chat).
 * @param {ProductRecord} product
 * @param {{ currency: string, image: string | null, url: string, brand: { id: string, name: string, slug?: string } | null,
 *   grades: ReadonlyMap<string, Grade>, cardImages?: Array<{ url: string | null, alt: string }> }} context
 * @returns {Card}
 */
export const cardOf = (product, { currency, image, url, brand, grades, cardImages = [] }) => ({
	id: product.id,
	slug: product.slug,
	name: product.name,
	price: product.price,
	compareAtPrice: compareAtOf(product),
	currency,
	image,
	url,
	inStock: product.inStock,
	rating: product.rating ?? { average: 0, count: 0 },
	brand,
	grades: gradeLabels(product, grades),
	variantCount: product.variants.filter((variant) => variant.active).length,
	priceMax: summarize(product.variants, product.trackStock).priceMax,
	featured: product.featured === true,
	cardImages,
});

/**
 * The specs of a product as shown: attributes in their order, with their units.
 * @param {ProductRecord} product
 * @param {ReadonlyMap<string, AttributeRecord>} attributes
 */
export const specsOf = (product, attributes) =>
	Object.entries(product.specs ?? {})
		.filter(([id]) => attributes.has(id))
		.map(([id, value]) => ({ attribute: /** @type {AttributeRecord} */ (attributes.get(id)), value }))
		.sort((a, b) => a.attribute.sort - b.attribute.sort || a.attribute.name.localeCompare(b.attribute.name))
		.map(({ attribute, value }) => ({
			id: attribute.id,
			slug: attribute.slug ?? attribute.id,
			name: attribute.name,
			value,
			label: valueLabel(attribute, value),
			unit: attribute.unit,
			comparable: attribute.comparable,
		}));

/**
 * A photo as shoppers get it: its address, text, size and placeholder, and the addresses of its smaller copies.
 * @typedef {{ url: string | null, alt: string, type: string, width?: number, height?: number, blur?: string,
 *   sizes?: Partial<Record<'thumb' | 'card' | 'detail', string | null>> }} MediaView
 */

/**
 * The product page's data.
 * @param {ProductRecord} product
 * @param {object} context
 * @param {string} context.currency
 * @param {string} context.url
 * @param {MediaView[]} context.media
 * @param {{ id: string, slug: string, name: string } | null} context.brand
 * @param {Array<{ id: string, slug: string, name: string, url: string }>} context.breadcrumb
 * @param {ReadonlyMap<string, AttributeRecord>} context.attributes
 * @param {ReadonlyMap<string, Grade>} context.grades
 * @param {ReadonlyMap<string, MediaView[]>} [context.variantMedia] each variant's photos (E6)
 * @param {ReadonlyMap<string, string>} [context.variantUrls] each variant's page (E13)
 * @param {{ showStock: string, lowStockShown: number }} [context.stock] what shoppers are told of stock (E9)
 * @param {number | null} [context.warrantyDays] the `returns` setting (E12)
 * @param {ReturnType<typeof import('./size-charts.js').chartView> | null} [context.sizeChart] (E5)
 * @param {Record<string, unknown> | null} [context.video] (E4)
 */
export const pageOf = (product, context) => {
	const { currency, url, media, brand, breadcrumb, attributes, grades } = context;
	const stock = context.stock ?? { showStock: 'none', lowStockShown: 0 };
	const variants = product.variants
		.filter((variant) => variant.active)
		.map((variant) => {
			const grade = variant.grade ? (grades.get(variant.grade) ?? null) : null;
			return {
				id: variant.id,
				name: variantName(product.options, variant.options),
				sku: variant.sku,
				options: variant.options,
				attributes: Object.entries(variant.attributes ?? {}).flatMap(([id, value]) => {
					const attribute = attributes.get(id);
					return attribute
						? [{ id, slug: attribute.slug ?? id, name: attribute.name, value, label: valueLabel(attribute, value) }]
						: [];
				}),
				price: variant.price,
				compareAtPrice:
					variant.compareAtPrice !== null && variant.compareAtPrice > variant.price ? variant.compareAtPrice : null,
				inStock: variantInStock(variant, product.trackStock),
				soldOut: variant.soldOut === true,
				stockLeft: stockLeftOf(variant, product.trackStock, stock),
				grade: grade ? gradeView(grade) : null,
				warrantyDays: variant.warrantyDays ?? product.warrantyDays ?? grade?.warrantyDays ?? context.warrantyDays ?? null,
				media: context.variantMedia?.get(variant.id) ?? [],
				url: context.variantUrls?.get(variant.id) ?? url,
			};
		});
	return {
		id: product.id,
		slug: product.slug,
		name: product.name,
		kind: product.kind,
		summary: product.summary,
		description: product.description,
		descriptionHtml: product.descriptionHtml ?? '',
		price: product.price,
		priceMax: summarize(product.variants, product.trackStock).priceMax,
		compareAtPrice: compareAtOf(product),
		currency,
		inStock: product.inStock,
		featured: product.featured === true,
		url,
		media,
		video: context.video ?? null,
		options: product.options,
		variants,
		specs: specsOf(product, attributes),
		brand,
		breadcrumb,
		tags: product.tags,
		rating: product.rating ?? { average: 0, count: 0 },
		booking: product.kind === 'booking' && product.booking ? { durationMinutes: product.booking.durationMinutes } : null,
		sizeChart: context.sizeChart ?? null,
		faqs: product.faqs ?? [],
		seo: {
			title: product.seo.title || product.name,
			description: product.seo.description || product.summary,
		},
	};
};

/**
 * A row of the staff's product list.
 * @param {ProductRecord} product
 * @param {{ image: string | null }} context
 */
export const staffRowOf = (product, { image }) => {
	const active = product.variants.filter((variant) => variant.active);
	return {
		id: product.id,
		slug: product.slug,
		name: product.name,
		kind: product.kind,
		status: product.status,
		price: product.price,
		inStock: product.inStock,
		stock: active.reduce((sum, variant) => sum + variant.stock, 0),
		trackStock: product.trackStock,
		variantCount: product.variants.length,
		skus: product.variants.map((variant) => variant.sku).filter(Boolean),
		image,
		categoryIds: product.categoryIds,
		brandId: product.brandId,
		featured: product.featured === true,
		stockState: product.stockState ?? summarize(product.variants, product.trackStock).stockState,
		grades: product.grades ?? [],
		mediaCount: product.media.length,
		updatedAt: product.updatedAt,
	};
};

/**
 * The whole product for staff (read without the database's own fields), with the addresses of its images, its
 * variants' photos and its video file.
 * @param {ProductRecord} product
 * @param {{ media: Array<string | null>, variantMedia?: ReadonlyMap<string, Array<string | null>>, video?: string | null }} context
 */
export const staffProductOf = (product, { media, variantMedia = new Map(), video = null }) => ({
	...product,
	...summarize(product.variants, product.trackStock),
	media: product.media.map((item, index) => ({ ...item, url: media[index] ?? null })),
	variants: product.variants.map((variant) => ({
		...variant,
		media: (variant.media ?? []).map((item, index) => ({ ...item, url: variantMedia.get(variant.id)?.[index] ?? null })),
	})),
	...(product.video?.kind === 'file' ? { video: { ...product.video, url: video } } : {}),
});
