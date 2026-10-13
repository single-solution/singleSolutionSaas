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

/** A meta description is cut to this many characters. */
const DESCRIPTION_LENGTH = 160;

/** Condition → schema.org `OfferItemCondition`. */
const CONDITION_URL = Object.freeze({
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

/** A word that only separates others in a title (`|`, `-`, `·` …). */
const SEPARATOR = /^[|\-–—·:/,•]+$/;

/**
 * A merchant's pattern filled (SG-5, SG-21): each `{placeholder}` of `values` replaced; empty brackets, and separators
 * left at either end or doubled by an empty value, are dropped; spaces collapsed. Other text stays as typed.
 * @param {string} template
 * @param {Record<string, string>} values
 */
export const fillTemplate = (template, values) => {
	let text = String(template ?? '');
	for (const [key, value] of Object.entries(values)) text = text.replaceAll(`{${key}}`, value);
	/** @type {string[]} */
	const words = [];
	for (const word of text
		.replace(/\(\s*\)|\[\s*\]/g, ' ')
		.split(/\s+/)
		.filter(Boolean)) {
		const last = words.at(-1);
		if (SEPARATOR.test(word) && (last === undefined || SEPARATOR.test(last))) continue;
		words.push(word);
	}
	while (words.length > 0 && SEPARATOR.test(/** @type {string} */ (words.at(-1)))) words.pop();
	return words.join(' ');
};

/**
 * A page title from the merchant's pattern (`{name} | {business}`; `{storeName}` is the same name). An empty pattern
 * is the name alone.
 * @param {string} template
 * @param {{ name: string, business: string }} values `business`: the SEO brand name, else the business name
 */
export const fillTitle = (template, { name, business }) =>
	fillTemplate(String(template || '{name}'), { name, business, storeName: business }) || name;

/**
 * The page's part of the title (`{name}` of the title pattern) from the `productTitle` or `categoryTitle` pattern
 * (SG-5): `{name}`, `{brand}`, `{category}` and `{storeName}`; the name alone when the pattern is empty or fills to
 * nothing.
 * @param {unknown} template
 * @param {{ name: string, brand?: string, category?: string, storeName: string }} values
 */
export const pageName = (template, { name, brand = '', category = '', storeName }) =>
	fillTemplate(String(template || '{name}'), { name, brand, category, storeName }) || name;

/**
 * A description from the `productDescription` or `categoryDescription` pattern (SG-5, SG-21), or '' when there is none.
 * @param {unknown} template
 * @param {Record<string, string>} values
 */
export const patternText = (template, values) => (template ? fillTemplate(String(template), values) : '');

/**
 * The first text that is not empty, as a meta description.
 * @param {...unknown} texts
 */
export const metaDescription = (...texts) => {
	const found = texts.find((text) => typeof text === 'string' && text.trim() !== '');
	return clip(found ?? '', DESCRIPTION_LENGTH);
};

/**
 * Whether a variant can be bought now (a variant marked sold out cannot, E9).
 * @param {Pick<ProductRecord, 'trackStock'>} product
 * @param {Pick<VariantRecord, 'stock' | 'soldOut'>} variant
 */
export const variantInStock = (product, variant) => variant.soldOut !== true && (!product.trackStock || variant.stock > 0);

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
const breadcrumbJsonLd = (trail) => ({
	'@type': 'BreadcrumbList',
	itemListElement: trail.map((step, index) => ({ '@type': 'ListItem', position: index + 1, name: step.name, item: step.url })),
});

/** schema.org `variesBy` properties for option names shoppers commonly use (others are named as they are). */
const VARIES_BY = Object.freeze(
	/** @type {Record<string, string>} */ ({
		size: `${SCHEMA}/size`,
		colour: `${SCHEMA}/color`,
		color: `${SCHEMA}/color`,
		material: `${SCHEMA}/material`,
		pattern: `${SCHEMA}/pattern`,
	}),
);

/**
 * @typedef {object} ProductPage
 * @property {ProductRecord} product
 * @property {string} url the canonical product page
 * @property {string[]} images absolute image addresses
 * @property {string} description
 * @property {string | null} brand brand name
 * @property {string} currency
 * @property {(variant: VariantRecord) => Condition | ''} condition the condition of a variant (its grade's, E10)
 * @property {string} seller the business name
 * @property {Array<{ name: string, url: string }>} trail home and categories, without the product
 * @property {(variant: VariantRecord) => string} [variantUrl] a variant's page (E13)
 * @property {(variant: VariantRecord) => string | null} [variantImage] a variant's first photo (E6)
 * @property {{ fee: number, freeOver?: number, country: string } | null} [shipping] the default delivery fee, free
 *   from `freeOver` (0 = never; E16, SG-2)
 * @property {{ days: number, country: string } | null} [returns] the return window (E16)
 * @property {Array<{ name: string, rating: number, title: string, body: string, at: Date | string | null }>} [reviews]
 *   approved reviews shown as review nodes (E16)
 */

/**
 * The delivery fee of one item at a price: free from the free-delivery amount (0 = never free), as the cart charges it
 * (SG-2).
 * @param {{ fee: number, freeOver?: number }} shipping
 * @param {number} price
 */
export const shippingFee = ({ fee, freeOver = 0 }, price) => (freeOver > 0 && price >= freeOver ? 0 : fee);

/**
 * The offer details of a product's offer: shipping at the offer's price and the return policy (E16, SG-2).
 * @param {Pick<ProductPage, 'currency' | 'shipping' | 'returns'>} page
 * @param {number} price
 */
const offerExtras = ({ currency, shipping, returns }, price) => ({
	shippingDetails: shipping
		? {
				'@type': 'OfferShippingDetails',
				shippingRate: { '@type': 'MonetaryAmount', value: toDecimal(shippingFee(shipping, price), currency), currency },
				...(shipping.country ? { shippingDestination: { '@type': 'DefinedRegion', addressCountry: shipping.country } } : {}),
			}
		: null,
	hasMerchantReturnPolicy: returns
		? compact({
				'@type': 'MerchantReturnPolicy',
				applicableCountry: returns.country,
				returnPolicyCategory: `${SCHEMA}/${returns.days > 0 ? 'MerchantReturnFiniteReturnWindow' : 'MerchantReturnNotPermitted'}`,
				merchantReturnDays: returns.days > 0 ? returns.days : null,
			})
		: null,
});

/**
 * `FAQPage` of a page's questions, or null.
 * @param {Array<{ question: string, answer: string }> | undefined} faqs
 * @param {string} url
 */
export const faqJsonLd = (faqs, url) =>
	faqs && faqs.length > 0
		? {
				'@type': 'FAQPage',
				'@id': `${url}#faq`,
				mainEntity: faqs.map((faq) => ({
					'@type': 'Question',
					name: faq.question,
					acceptedAnswer: { '@type': 'Answer', text: faq.answer },
				})),
			}
		: null;

/**
 * Product structured data as a JSON-LD graph (E16): a `ProductGroup` with each active variant as a `Product` (its own
 * condition by grade, offer, shipping and return policy) when there are several, else one `Product`; the rating and
 * review nodes; the `BreadcrumbList`; and a `FAQPage` of the product's questions.
 * @param {ProductPage} page
 */
export const productJsonLd = (page) => {
	const { product, url, images, description, brand, currency, seller, trail } = page;
	const variants = activeVariants(product);
	/** @param {VariantRecord} variant */
	const offerOf = (variant) =>
		compact({
			'@type': 'Offer',
			url: page.variantUrl?.(variant) ?? url,
			price: toDecimal(variant.price, currency),
			priceCurrency: currency,
			availability: `${SCHEMA}/${variantInStock(product, variant) ? 'InStock' : 'OutOfStock'}`,
			itemCondition: (() => {
				const condition = page.condition(variant);
				return condition ? CONDITION_URL[condition] : '';
			})(),
			seller: seller ? { '@type': 'Organization', name: seller } : null,
			...offerExtras(page, variant.price),
		});
	const rating =
		product.rating.count > 0
			? {
					'@type': 'AggregateRating',
					ratingValue: Math.round(product.rating.average * 10) / 10,
					reviewCount: product.rating.count,
					bestRating: 5,
					worstRating: 1,
				}
			: null;
	const reviews = (page.reviews ?? []).map((review) =>
		compact({
			'@type': 'Review',
			name: review.title,
			reviewBody: review.body,
			datePublished: review.at ? new Date(review.at).toISOString().slice(0, 10) : '',
			author: { '@type': 'Person', name: review.name },
			reviewRating: { '@type': 'Rating', ratingValue: review.rating, bestRating: 5, worstRating: 1 },
		}),
	);
	const shared = {
		description,
		image: images,
		brand: brand ? { '@type': 'Brand', name: brand } : null,
		aggregateRating: rating,
		review: reviews,
	};
	/** @type {Record<string, unknown>} */
	let node;
	if (variants.length > 1) {
		node = compact({
			'@type': 'ProductGroup',
			'@id': `${url}#product`,
			name: product.name,
			url,
			productGroupID: product.id,
			variesBy: product.options.map((axis) => VARIES_BY[axis.name.toLowerCase()] ?? axis.name),
			...shared,
			hasVariant: variants.map((variant) =>
				compact({
					'@type': 'Product',
					name: variantLabel(variant) ? `${product.name} - ${variantLabel(variant)}` : product.name,
					sku: variant.sku,
					image: page.variantImage?.(variant) ?? '',
					...Object.fromEntries(
						Object.entries(variant.options ?? {}).flatMap(([axis, value]) => {
							const property = VARIES_BY[axis.toLowerCase()];
							return property ? [[property.slice(SCHEMA.length + 1), value]] : [];
						}),
					),
					offers: offerOf(variant),
				}),
			),
		});
	} else {
		const sole = variants[0];
		node = compact({
			'@type': 'Product',
			'@id': `${url}#product`,
			name: product.name,
			url,
			sku: sole?.sku ?? '',
			...shared,
			offers: sole ? offerOf(sole) : null,
		});
	}
	return {
		'@context': SCHEMA,
		'@graph': [node, breadcrumbJsonLd([...trail, { name: product.name, url }]), faqJsonLd(product.faqs, url)].filter(
			(entry) => entry !== null,
		),
	};
};

/**
 * `CollectionPage` of a category or landing page, with its `ItemList` of products, its `BreadcrumbList` and a
 * `FAQPage` of its questions, as a JSON-LD graph (E15, E16).
 * @param {{ name: string, description: string, url: string, image: string | null, trail: Array<{ name: string, url: string }>,
 *   items?: Array<{ name: string, url: string }>, faqs?: Array<{ question: string, answer: string }> }} page
 *   `trail`: home and the ancestors, without the page itself
 */
export const categoryJsonLd = ({ name, description, url, image, trail, items = [], faqs = [] }) => ({
	'@context': SCHEMA,
	'@graph': [
		compact({ '@type': 'CollectionPage', '@id': `${url}#page`, name, description, url, image }),
		items.length > 0
			? {
					'@type': 'ItemList',
					'@id': `${url}#items`,
					itemListElement: items.map((item, index) => ({
						'@type': 'ListItem',
						position: index + 1,
						url: item.url,
						name: item.name,
					})),
				}
			: null,
		breadcrumbJsonLd([...trail, { name, url }]),
		faqJsonLd(faqs, url),
	].filter((entry) => entry !== null),
});

/**
 * The robots value of a page: `index, follow` unless its SEO fields say otherwise.
 * @param {{ noindex?: boolean, nofollow?: boolean } | undefined} seo
 */
export const robotsOf = (seo) => `${seo?.noindex ? 'noindex' : 'index'}, ${seo?.nofollow ? 'nofollow' : 'follow'}`;

/** The start of a sitemap file (with the image extension, E16). */
export const SITEMAP_HEAD =
	'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n';
/** The end of a sitemap file. */
export const SITEMAP_FOOT = '</urlset>\n';

/**
 * One address of a sitemap, with its images (E16).
 * @param {{ loc: string, lastmod: Date | string | null | undefined, images?: string[] }} entry
 */
export const sitemapEntry = ({ loc, lastmod, images = [] }) => {
	const date = lastmod ? new Date(lastmod) : null;
	const when = date && !Number.isNaN(date.getTime()) ? `<lastmod>${date.toISOString()}</lastmod>` : '';
	const pictures = images.map((image) => `<image:image><image:loc>${escapeXml(image)}</image:loc></image:image>`).join('');
	return `<url><loc>${escapeXml(loc)}</loc>${when}${pictures}</url>\n`;
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
 * The address of one file of a split sitemap on the merchant's website: the sitemap address with `file=<name>` (E16).
 * @param {string} base the sitemap address (`/sitemap.xml` or an https address)
 * @param {string} domain
 * @param {string} file `categories`, `landings` or `products-<n>`
 */
export const sitemapFileUrl = (base, domain, file) => {
	const path = String(base || '/sitemap.xml');
	const absolute = /^https:\/\//.test(path) ? path : `https://${domain}${path.startsWith('/') ? '' : '/'}${path}`;
	return `${absolute}${absolute.includes('?') ? '&' : '?'}file=${encodeURIComponent(file)}`;
};

/**
 * The files of a sitemap index (E16): the categories, the landing and glossary pages, and the products in files of at
 * most `size` addresses each. Empty parts have no file.
 * @param {{ categories: number, landings: number, products: number, size: number }} counts
 * @returns {string[]}
 */
export const sitemapFiles = ({ categories, landings, products, size }) => [
	...(categories > 0 ? ['categories'] : []),
	...(landings > 0 ? ['landings'] : []),
	...Array.from({ length: Math.ceil(products / size) }, (_, index) => `products-${index + 1}`),
];
