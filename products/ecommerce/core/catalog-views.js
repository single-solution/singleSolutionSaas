/**
 * What shoppers and staff see of the catalog (PLAN 0.8.8 Shopper widgets: the product grid and the product page;
 * Admin widgets: products and catalog): product cards, the product page's data and the staff's product rows. Shoppers
 * never see exact stock counts, costs or draft products; image and page addresses are made by the caller and passed
 * in. No I/O.
 * @module
 */
import { summarize, valueLabel, variantInStock, variantName } from './catalog.js';
import { gradeLabels } from './compare.js';
import { gradeView } from './grades.js';
import { levelOf } from './measure.js';

/** @typedef {import('./model.js').ProductRecord} ProductRecord */
/** @typedef {import('./model.js').VariantRecord} VariantRecord */
/** @typedef {import('./model.js').AttributeRecord} AttributeRecord */
/** @typedef {import('./grades.js').Grade} Grade */

/** @typedef {import('./promotions.js').ShownPrice} ShownPrice */
/** @typedef {(variant: VariantRecord) => ShownPrice} Shown a variant's shown price (`shownPrice`, G4) */

/**
 * A product's prices as shoppers are shown them (G4): the lowest shown price of its active variants with that variant's
 * struck-through price, and the highest shown price.
 * @param {ProductRecord} product
 * @param {Shown} shown
 * @returns {{ price: number, compareAtPrice: number | null, priceMax: number }}
 */
export const shownRange = (product, shown) => {
	const prices = product.variants.filter((variant) => variant.active).map(shown);
	const low = prices.reduce(
		(best, next) => (best === null || next.price < best.price ? next : best),
		/** @type {ShownPrice | null} */ (null),
	);
	return {
		price: low ? low.price : product.price,
		compareAtPrice: low ? low.was : null,
		priceMax: prices.length > 0 ? Math.max(...prices.map((found) => found.price)) : product.priceMax,
	};
};

/**
 * @typedef {object} Card
 * @property {string} id
 * @property {string} slug
 * @property {string} name
 * @property {number} price the lowest price shown (after automatic deals, G4)
 * @property {number | null} compareAtPrice that variant's struck-through price
 * @property {string} currency
 * @property {import('./measure.js').Measure | null} measure sold in a unit of its own (prices per unit)
 * @property {string | null} image
 * @property {{ width: number, height: number } | null} imageSize its photo's size (null: not known), for the image's
 *   width and height (G14)
 * @property {string} url
 * @property {boolean} inStock
 * @property {{ average: number, count: number }} rating
 * @property {{ id: string, name: string, slug?: string } | null} brand
 * @property {{ id: string, slug: string, name: string } | null} category its main category (the first of its
 *   categories that exists; null: in none), so a website can build its own product address
 * @property {string[]} grades
 * @property {number} variantCount
 * @property {number} priceMax the highest price shown of its active variants (E8)
 * @property {boolean} featured (E2)
 * @property {Array<{ url: string | null, alt: string, width?: number, height?: number }>} cardImages the first photo
 *   of up to 4 variants that look different (E6), with its size when known
 * @property {CardVariant[]} [variants] the active variants, when the listing asks for them (SF-6)
 */

/**
 * A variant on a card (SF-6): what a website needs to draw its own cards (price ranges and "was" prices of its own
 * rule, attribute chips, a link to the variant it picks), never stock counts or costs.
 * @typedef {object} CardVariant
 * @property {string} id
 * @property {Record<string, string>} options
 * @property {Array<{ slug: string, name: string, label: string }>} attributes
 * @property {number} price the price shown (after automatic deals, G4)
 * @property {number | null} compareAtPrice the struck-through price, when higher than the price
 * @property {boolean} inStock
 * @property {string | null} grade the grade's key
 * @property {string} url the variant's page (E13)
 */

/**
 * The active variants of a product as cards carry them (SF-6), at their shown prices (G4).
 * @param {ProductRecord} product
 * @param {{ attributes: ReadonlyMap<string, AttributeRecord>, variantUrls: ReadonlyMap<string, string>, url: string,
 *   shown: Shown }} context
 * @returns {CardVariant[]}
 */
export const cardVariantsOf = (product, { attributes, variantUrls, url, shown }) =>
	product.variants
		.filter((variant) => variant.active)
		.map((variant) => ({
			id: variant.id,
			options: variant.options,
			// the variant fields cards show (as chips or images)
			attributes: Object.entries(variant.attributes).flatMap(([id, value]) => {
				const attribute = attributes.get(id);
				return attribute && attribute.show.card !== 'none'
					? [{ slug: attribute.slug, name: attribute.name, label: valueLabel(attribute, value) }]
					: [];
			}),
			...(({ price, was }) => ({ price, compareAtPrice: was }))(shown(variant)),
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
		const first = variant.active ? variant.media[0] : undefined;
		if (first && !out.some((file) => file.key === first.key)) out.push(first);
		if (out.length === 4) break;
	}
	return out;
};

/**
 * How many units shoppers are told are left (E9): never, only at `low` or fewer, or always; 0 for a variant marked sold
 * out; null when not shown or stock is not tracked. An item sold in a unit of its own has its stock in
 * thousandths of its unit, and `low` counts its units (`core/measure.js`).
 * @param {Pick<VariantRecord, 'stock' | 'soldOut' | 'active'>} variant
 * @param {boolean} trackStock
 * @param {{ showStock: string, lowStockShown: number }} settings
 * @param {unknown} [measure] the item's measure (none: pieces)
 * @returns {number | null}
 */
export const stockLeftOf = (variant, trackStock, { showStock, lowStockShown }, measure = null) => {
	if (!trackStock || showStock === 'none') return null;
	const left = variant.soldOut || !variant.active ? 0 : variant.stock;
	return showStock === 'always' || left <= levelOf(lowStockShown, measure) ? left : null;
};

/**
 * A photo's size as pages give it to images (their width and height, so the page does not move while it loads, G14),
 * or null when it is not known.
 * @param {Pick<import('./model.js').MediaRecord, 'width' | 'height'> | null | undefined} file
 * @returns {{ width: number, height: number } | null}
 */
export const sizeOf = (file) =>
	file && Number.isSafeInteger(file.width) && Number.isSafeInteger(file.height)
		? { width: Number(file.width), height: Number(file.height) }
		: null;

/**
 * A product's main category as cards and the product page's trail name it: the first of its categories that exists.
 * @param {Pick<ProductRecord, 'categoryIds'>} product
 * @param {ReadonlyMap<string, { slug: string, name: string }>} categories by id
 * @returns {{ id: string, slug: string, name: string } | null}
 */
export const mainCategoryOf = (product, categories) => {
	for (const id of product.categoryIds) {
		const found = categories.get(id);
		if (found) return { id, slug: found.slug, name: found.name };
	}
	return null;
};

/**
 * A product card (grid and search results), at its shown prices (G4).
 * @param {ProductRecord} product
 * @param {{ currency: string, image: string | null, url: string, brand: { id: string, name: string, slug?: string } | null,
 *   grades: Parameters<typeof gradeLabels>[1], categories: ReadonlyMap<string, { path: string[], slug: string, name: string }>,
 *   cardImages?: Card['cardImages'], shown: Shown,
 *   measure?: import('./measure.js').Measure | null }} context `measure`: its type's, while Sell in any unit is on
 * @returns {Card}
 */
export const cardOf = (product, { currency, image, url, brand, grades, categories, cardImages = [], shown, measure = null }) => ({
	id: product.id,
	slug: product.slug,
	name: product.name,
	...shownRange(product, shown),
	currency,
	// sold in a unit of its own: prices are per unit, quantities thousandths of it (`core/measure.js`)
	measure,
	image,
	imageSize: image ? sizeOf(product.media[0]) : null,
	url,
	inStock: product.inStock,
	rating: product.rating,
	brand,
	category: mainCategoryOf(product, categories),
	grades: gradeLabels(product, grades, categories),
	variantCount: product.variants.filter((variant) => variant.active).length,
	featured: product.featured,
	cardImages,
});

/**
 * The specs of a product as shown: the product fields shown on its page, in their order, with their units (values of
 * fields shoppers do not see never leave staff answers).
 * @param {ProductRecord} product
 * @param {ReadonlyMap<string, AttributeRecord>} attributes
 */
export const specsOf = (product, attributes) =>
	Object.entries(product.specs)
		.filter(([id]) => attributes.get(id)?.show.page === true)
		.map(([id, value]) => ({ attribute: /** @type {AttributeRecord} */ (attributes.get(id)), value }))
		.sort((a, b) => a.attribute.sort - b.attribute.sort || a.attribute.name.localeCompare(b.attribute.name))
		.map(({ attribute, value }) => ({
			id: attribute.id,
			slug: attribute.slug,
			name: attribute.name,
			value,
			label: valueLabel(attribute, value),
			unit: attribute.unit,
			compare: attribute.show.compare,
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
 * @param {ReadonlyMap<string, MediaView[]>} context.variantMedia each variant's photos (E6)
 * @param {ReadonlyMap<string, string>} context.variantUrls each variant's page (E13)
 * @param {{ showStock: string, lowStockShown: number }} context.stock what shoppers are told of stock (E9)
 * @param {import('./durations.js').Duration | null} context.warrantyTime the `returns` setting (E12, E14)
 * @param {ReturnType<typeof import('./size-charts.js').chartView> | null} context.sizeChart (E5)
 * @param {Record<string, unknown> | null} context.video (E4)
 * @param {Shown} context.shown each variant's shown price (G4)
 * @param {{ key: string, kind: string }} context.type its item type (dynamic model §1)
 * @param {boolean} context.slots it is booked in time slots (its type's `slots`, while Services and bookings is on)
 * @param {import('./measure.js').Measure | null} context.measure it is sold in a unit of its own (its type's
 *   `measure`, while Sell in any unit is on)
 * @param {import('./measure.js').QuantityLimits} context.limits the quantities a shopper may buy (E4)
 */
export const pageOf = (product, context) => {
	const { currency, url, media, brand, breadcrumb, attributes, grades, shown } = context;
	const variants = product.variants
		.filter((variant) => variant.active)
		.map((variant) => {
			const grade = variant.grade ? (grades.get(variant.grade) ?? null) : null;
			const price = shown(variant);
			return {
				id: variant.id,
				name: variantName(product.options, variant.options),
				sku: variant.sku,
				options: variant.options,
				// the variant fields its page shows (a staff-only field's values stay in staff answers)
				attributes: Object.entries(variant.attributes).flatMap(([id, value]) => {
					const attribute = attributes.get(id);
					return attribute?.show.page
						? [{ id, slug: attribute.slug, name: attribute.name, value, label: valueLabel(attribute, value) }]
						: [];
				}),
				price: price.price,
				compareAtPrice: price.was,
				// the deal in the price, with what it takes off one unit (G4)
				deal: price.deal ? { ...price.deal, savings: price.savings } : null,
				inStock: variantInStock(variant, product.trackStock),
				soldOut: variant.soldOut,
				stockLeft: stockLeftOf(variant, product.trackStock, context.stock, context.measure),
				grade: grade ? gradeView(grade) : null,
				warrantyTime: variant.warrantyTime ?? product.warrantyTime ?? grade?.warrantyTime ?? context.warrantyTime,
				media: context.variantMedia.get(variant.id) ?? [],
				url: context.variantUrls.get(variant.id) ?? url,
			};
		});
	return {
		id: product.id,
		slug: product.slug,
		name: product.name,
		kind: product.kind,
		type: { key: context.type.key, kind: context.type.kind },
		// sold in a unit of its own: prices are per unit, quantities and stock thousandths of it
		measure: context.measure,
		// the quantities a shopper may buy: in pieces, or thousandths of the unit (E4)
		limits: context.limits,
		summary: product.summary,
		description: product.description,
		descriptionHtml: product.descriptionHtml,
		...shownRange(product, shown),
		currency,
		inStock: product.inStock,
		featured: product.featured,
		url,
		media,
		video: context.video,
		options: product.options,
		variants,
		specs: specsOf(product, attributes),
		brand,
		breadcrumb,
		tags: product.tags,
		rating: product.rating,
		booking: context.slots && product.booking ? { durationMinutes: product.booking.durationMinutes } : null,
		sizeChart: context.sizeChart,
		faqs: product.faqs,
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
		typeKey: product.typeKey ?? null,
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
		featured: product.featured,
		stockState: product.stockState,
		grades: product.grades,
		mediaCount: product.media.length,
		updatedAt: product.updatedAt,
	};
};

/**
 * The whole product for staff (read without the database's own fields), with the addresses of its images, its
 * variants' photos and its video file, and its item type (its own, its category's or the built-in one) with its
 * measure (its stock counts thousandths of the unit; null: pieces).
 * @param {ProductRecord} product
 * @param {{ media: Array<string | null>, variantMedia?: ReadonlyMap<string, Array<string | null>>, video?: string | null,
 *   type: { key: string, kind: string, elements?: { measure?: import('./measure.js').Measure | null } } }} context
 */
export const staffProductOf = (product, { media, variantMedia = new Map(), video = null, type }) => ({
	...product,
	typeKey: product.typeKey ?? null,
	type: { key: type.key, kind: type.kind, measure: type.elements?.measure ?? null },
	...summarize(product.variants, product.trackStock),
	media: product.media.map((item, index) => ({ ...item, url: media[index] ?? null })),
	variants: product.variants.map((variant) => ({
		...variant,
		media: variant.media.map((item, index) => ({ ...item, url: variantMedia.get(variant.id)?.[index] ?? null })),
	})),
	...(product.video?.kind === 'file' ? { video: { ...product.video, url: video } } : {}),
});
