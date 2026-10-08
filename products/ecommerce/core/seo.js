/**
 * Catalog SEO (PLAN 0.8.8: meta and structured data, sitemaps): page titles and descriptions, schema.org JSON-LD for
 * product and category pages, and sitemap XML. The merchant's site serves all of it on its own domain from the
 * product's API (PLAN 0.4.10). Only values the shop really has are emitted — never an invented rating, price or
 * condition. Every text that goes into XML is escaped, and JSON-LD comes as text that can never close its
 * `<script>` element. Pure functions, no I/O.
 * @module
 */
import { toDecimal } from './money.js';

/** @typedef {import('./model.js').ProductRecord} ProductRecord */
/** @typedef {import('./model.js').VariantRecord} VariantRecord */
/** @typedef {'new' | 'used' | 'refurbished'} Condition */

const SCHEMA = 'https://schema.org';

/** At most this many addresses in one sitemap file (the sitemaps.org limit). */
export const SITEMAP_LIMIT = 50_000;
/** A meta description is cut to this many characters. */
export const DESCRIPTION_LENGTH = 160;

/** Condition → schema.org `OfferItemCondition`. */
export const CONDITION_URL = Object.freeze({
	new: `${SCHEMA}/NewCondition`,
	used: `${SCHEMA}/UsedCondition`,
	refurbished: `${SCHEMA}/RefurbishedCondition`,
});

/**
 * Characters XML 1.0 does not allow (control characters other than tab and line breaks, lone surrogates, U+FFFE/F).
 */
const NOT_XML =
	// eslint-disable-next-line no-control-regex
	/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Text safe inside an XML element or attribute.
 * @param {unknown} value
 */
export const escapeXml = (value) =>
	String(value ?? '')
		.replace(NOT_XML, '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');

/**
 * JSON for a `<script type="application/ld+json">` element: `<`, `>`, `&`, U+2028 and U+2029 escaped, so the text can
 * never close the element (`</script>`) or start a comment, whatever the merchant typed.
 * @param {unknown} node
 */
export const scriptJson = (node) =>
	JSON.stringify(node)
		.replace(/</g, '\\u003c')
		.replace(/>/g, '\\u003e')
		.replace(/&/g, '\\u0026')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');

/**
 * Plain text on one line, cut at a word to at most `max` characters (an ellipsis marks a cut).
 * @param {unknown} value
 * @param {number} max
 */
export const clip = (value, max) => {
	const text = String(value ?? '')
		.replace(/\s+/g, ' ')
		.trim();
	if (text.length <= max) return text;
	const cut = text.slice(0, Math.max(0, max - 1));
	const space = cut.lastIndexOf(' ');
	return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

/**
 * A page title from the merchant's pattern (`{name} | {business}`). An empty pattern is the name alone.
 * @param {string} template
 * @param {{ name: string, business: string }} values
 */
export const fillTitle = (template, { name, business }) => {
	const filled = String(template || '{name}')
		.replaceAll('{name}', name)
		.replaceAll('{business}', business)
		.replace(/\s+/g, ' ')
		.trim();
	return filled || name;
};

/**
 * The first text that is not empty, as a meta description.
 * @param {...unknown} texts
 */
export const metaDescription = (...texts) => {
	const found = texts.find((text) => typeof text === 'string' && text.trim() !== '');
	return clip(found ?? '', DESCRIPTION_LENGTH);
};

/**
 * Whether a variant can be bought now.
 * @param {Pick<ProductRecord, 'trackStock'>} product
 * @param {Pick<VariantRecord, 'stock'>} variant
 */
export const variantInStock = (product, variant) => !product.trackStock || variant.stock > 0;

/**
 * The condition of a variant: physical goods with a grade take the merchant's setting, other physical goods are new;
 * digital goods and bookings have none ('').
 * @param {Pick<ProductRecord, 'kind'>} product
 * @param {Pick<VariantRecord, 'grade'>} variant
 * @param {Condition} graded
 * @returns {Condition | ''}
 */
export const conditionOf = (product, variant, graded) => {
	if (product.kind !== 'physical') return '';
	return variant.grade ? graded : 'new';
};

/**
 * The variants shown and sold.
 * @param {Pick<ProductRecord, 'variants'>} product
 */
export const activeVariants = (product) => product.variants.filter((variant) => variant.active);

/**
 * Option values of a variant as one label (`Red / 128 GB`).
 * @param {Pick<VariantRecord, 'options'>} variant
 */
export const variantLabel = (variant) => Object.values(variant.options ?? {}).join(' / ');

/**
 * Drop empty members (undefined, null, '' and empty lists) of a JSON-LD node, one level deep.
 * @param {Record<string, unknown>} node
 */
const compact = (node) =>
	Object.fromEntries(
		Object.entries(node).filter(
			([, value]) => value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0),
		),
	);

/**
 * `BreadcrumbList` of a page: its trail from the home page.
 * @param {Array<{ name: string, url: string }>} trail
 */
export const breadcrumbJsonLd = (trail) => ({
	'@type': 'BreadcrumbList',
	itemListElement: trail.map((step, index) => ({ '@type': 'ListItem', position: index + 1, name: step.name, item: step.url })),
});

/**
 * @typedef {object} ProductPage
 * @property {ProductRecord} product
 * @property {string} url the canonical product page
 * @property {string[]} images absolute image addresses
 * @property {string} description
 * @property {string | null} brand brand name
 * @property {string} currency
 * @property {Condition} graded the condition of graded items
 * @property {string} seller the business name
 * @property {Array<{ name: string, url: string }>} trail home and categories, without the product
 */

/**
 * `Product` with one `Offer` per active variant, plus its `BreadcrumbList`, as a JSON-LD graph.
 * @param {ProductPage} page
 */
export const productJsonLd = ({ product, url, images, description, brand, currency, graded, seller, trail }) => {
	const variants = activeVariants(product);
	const single = variants.length === 1;
	const conditions = new Set(variants.map((variant) => conditionOf(product, variant, graded)));
	const [sole] = [...conditions];
	const offers = variants.map((variant) => {
		const condition = conditionOf(product, variant, graded);
		return compact({
			'@type': 'Offer',
			url,
			sku: variant.sku,
			name: single ? '' : variantLabel(variant),
			price: toDecimal(variant.price, currency),
			priceCurrency: currency,
			availability: `${SCHEMA}/${variantInStock(product, variant) ? 'InStock' : 'OutOfStock'}`,
			itemCondition: condition ? CONDITION_URL[condition] : '',
			seller: seller ? { '@type': 'Organization', name: seller } : null,
		});
	});
	const node = compact({
		'@type': 'Product',
		'@id': `${url}#product`,
		name: product.name,
		description,
		url,
		image: images,
		sku: single ? variants[0]?.sku : '',
		brand: brand ? { '@type': 'Brand', name: brand } : null,
		itemCondition: conditions.size === 1 && sole ? CONDITION_URL[sole] : '',
		aggregateRating:
			product.rating.count > 0
				? {
						'@type': 'AggregateRating',
						ratingValue: Math.round(product.rating.average * 10) / 10,
						reviewCount: product.rating.count,
						bestRating: 5,
						worstRating: 1,
					}
				: null,
		offers: single ? offers[0] : offers,
	});
	return { '@context': SCHEMA, '@graph': [node, breadcrumbJsonLd([...trail, { name: product.name, url }])] };
};

/**
 * `CollectionPage` of a category, plus its `BreadcrumbList`, as a JSON-LD graph.
 * @param {{ name: string, description: string, url: string, image: string | null, trail: Array<{ name: string, url: string }> }} page
 *   `trail`: home and the ancestors, without the category
 */
export const categoryJsonLd = ({ name, description, url, image, trail }) => ({
	'@context': SCHEMA,
	'@graph': [
		compact({ '@type': 'CollectionPage', '@id': `${url}#page`, name, description, url, image }),
		breadcrumbJsonLd([...trail, { name, url }]),
	],
});

/** The start of a sitemap file. */
export const SITEMAP_HEAD =
	'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
/** The end of a sitemap file. */
export const SITEMAP_FOOT = '</urlset>\n';

/**
 * One address of a sitemap.
 * @param {{ loc: string, lastmod: Date | string | null | undefined }} entry
 */
export const sitemapEntry = ({ loc, lastmod }) => {
	const date = lastmod ? new Date(lastmod) : null;
	const when = date && !Number.isNaN(date.getTime()) ? `<lastmod>${date.toISOString()}</lastmod>` : '';
	return `<url><loc>${escapeXml(loc)}</loc>${when}</url>\n`;
};

/**
 * A sitemap index pointing at the pages of a large sitemap.
 * @param {string[]} locs
 */
export const sitemapIndex = (locs) =>
	`<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${locs
		.map((loc) => `<sitemap><loc>${escapeXml(loc)}</loc></sitemap>\n`)
		.join('')}</sitemapindex>\n`;

/**
 * The address of one page of a split sitemap on the merchant's website.
 * @param {string} base the sitemap address (`/sitemap.xml` or an https address)
 * @param {string} domain
 * @param {number} page 1-based
 */
export const sitemapPageUrl = (base, domain, page) => {
	const path = String(base || '/sitemap.xml');
	const absolute = /^https:\/\//.test(path) ? path : `https://${domain}${path.startsWith('/') ? '' : '/'}${path}`;
	return `${absolute}${absolute.includes('?') ? '&' : '?'}page=${page}`;
};

/**
 * Which slice of the categories and the products one sitemap page holds (categories first, then products).
 * @param {{ categories: number, products: number, page: number, size?: number }} input
 * @returns {{ pages: number, categories: { skip: number, limit: number }, products: { skip: number, limit: number } }}
 */
export const sitemapSlice = ({ categories, products, page, size = SITEMAP_LIMIT }) => {
	const total = categories + products;
	const pages = Math.max(1, Math.ceil(total / size));
	const start = (page - 1) * size;
	const end = Math.min(total, start + size);
	const catEnd = Math.min(end, categories);
	const categorySlice = start < categories ? { skip: start, limit: catEnd - start } : { skip: 0, limit: 0 };
	const productStart = Math.max(start, categories) - categories;
	const productSlice = end > categories ? { skip: productStart, limit: end - categories - productStart } : { skip: 0, limit: 0 };
	return { pages, categories: categorySlice, products: productSlice };
};
