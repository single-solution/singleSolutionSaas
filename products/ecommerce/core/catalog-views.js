/**
 * What shoppers and staff see of the catalog (PLAN 0.8.8 Shopper widgets: the product grid and the product page;
 * Admin widgets: products and catalog): product cards, the product page's data and the staff's product rows. Shoppers
 * never see exact stock counts, costs or draft products; image and page addresses are made by the caller and passed
 * in. No I/O.
 * @module
 */
import { summarize, variantInStock, variantName } from './catalog.js';

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
 * @property {{ id: string, name: string } | null} brand
 * @property {string[]} grades
 * @property {number} variantCount
 */

/**
 * A product card (grid, search results, wishlist, compare, Chat).
 * @param {ProductRecord} product
 * @param {{ currency: string, image: string | null, url: string, brand: { id: string, name: string } | null,
 *   grades: ReadonlyMap<string, Grade> }} context
 * @returns {Card}
 */
export const cardOf = (product, { currency, image, url, brand, grades }) => ({
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
			name: attribute.name,
			value,
			unit: attribute.unit,
			comparable: attribute.comparable,
		}));

/**
 * The product page's data.
 * @param {ProductRecord} product
 * @param {{ currency: string, url: string, media: Array<{ url: string | null, alt: string, type: string }>,
 *   brand: { id: string, slug: string, name: string } | null, breadcrumb: Array<{ id: string, slug: string, name: string, url: string }>,
 *   attributes: ReadonlyMap<string, AttributeRecord>, grades: ReadonlyMap<string, Grade> }} context
 */
export const pageOf = (product, { currency, url, media, brand, breadcrumb, attributes, grades }) => {
	const variants = product.variants
		.filter((variant) => variant.active)
		.map((variant) => {
			const grade = variant.grade ? (grades.get(variant.grade) ?? null) : null;
			return {
				id: variant.id,
				name: variantName(product.options, variant.options),
				sku: variant.sku,
				options: variant.options,
				price: variant.price,
				compareAtPrice:
					variant.compareAtPrice !== null && variant.compareAtPrice > variant.price ? variant.compareAtPrice : null,
				inStock: variantInStock(variant, product.trackStock),
				grade: grade ? { key: grade.key, label: grade.label, description: grade.description } : null,
			};
		});
	return {
		id: product.id,
		slug: product.slug,
		name: product.name,
		kind: product.kind,
		summary: product.summary,
		description: product.description,
		price: product.price,
		compareAtPrice: compareAtOf(product),
		currency,
		inStock: product.inStock,
		url,
		media,
		options: product.options,
		variants,
		specs: specsOf(product, attributes),
		brand,
		breadcrumb,
		tags: product.tags,
		rating: product.rating ?? { average: 0, count: 0 },
		booking: product.kind === 'booking' && product.booking ? { durationMinutes: product.booking.durationMinutes } : null,
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
		updatedAt: product.updatedAt,
	};
};

/**
 * The whole product for staff (read without the database's own fields), with its images' addresses.
 * @param {ProductRecord} product
 * @param {{ media: Array<string | null> }} context
 */
export const staffProductOf = (product, { media }) => ({
	...product,
	...summarize(product.variants, product.trackStock),
	media: product.media.map((item, index) => ({ ...item, url: media[index] ?? null })),
});
