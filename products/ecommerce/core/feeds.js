/**
 * Product feeds (PLAN 0.8.8: sitemaps and product feeds): one row per active variant of every active product, written
 * as a Google Merchant Center RSS 2.0 feed (`g:` namespace) or a Meta (Facebook) catalog CSV. The merchant's site
 * serves them at its own addresses from the product's API (PLAN 0.4.10). The private cost is never a column. Pure
 * functions, no I/O.
 * @module
 */
import { activeVariants, conditionOf, escapeXml, variantInStock, variantLabel } from './seo.js';
import { toDecimal } from './money.js';

/** @typedef {import('./model.js').ProductRecord} ProductRecord */
/** @typedef {import('./seo.js').Condition} Condition */

/** At most this many rows in one feed (the rest are left out). */
export const MAX_FEED_ROWS = 100_000;
/** Longest title and description the catalogues take. */
const TITLE_LENGTH = 150;
const DESCRIPTION_LENGTH = 5000;

/**
 * One feed row (one variant).
 * @typedef {object} FeedRow
 * @property {string} id the variant id
 * @property {string} itemGroupId the product id when it has more than one variant, else ''
 * @property {string} title
 * @property {string} description
 * @property {string} link
 * @property {string} image
 * @property {string} price `10.50 USD` (the "was" price when on sale)
 * @property {string} salePrice the price on sale, else ''
 * @property {boolean} inStock
 * @property {Condition | ''} condition
 * @property {string} brand
 * @property {string} gtin
 * @property {string} mpn
 * @property {string} productType category path (`Phones > Android`)
 */

/**
 * @typedef {object} FeedContext
 * @property {string} link the product page
 * @property {string} image the main image address ('' = none)
 * @property {string} brand
 * @property {string} productType
 * @property {string} currency
 * @property {Condition} graded condition of graded items
 * @property {'none' | 'mpn' | 'gtin'} skuAs
 * @property {boolean} includeOutOfStock
 */

/**
 * Text on one line (feeds take no line breaks in titles) cut to `max` characters.
 * @param {string} value
 * @param {number} max
 */
const line = (value, max) => value.replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * The rows of one product.
 * @param {ProductRecord} product
 * @param {FeedContext} context
 * @returns {FeedRow[]}
 */
export const feedRows = (product, context) => {
	const variants = activeVariants(product);
	const many = variants.length > 1;
	const money = (/** @type {number} */ amount) => `${toDecimal(amount, context.currency)} ${context.currency}`;
	return variants
		.filter((variant) => context.includeOutOfStock || variantInStock(product, variant))
		.map((variant) => {
			const label = variantLabel(variant);
			const onSale = typeof variant.compareAtPrice === 'number' && variant.compareAtPrice > variant.price;
			const sku = variant.sku ?? '';
			return {
				id: variant.id,
				itemGroupId: many ? product.id : '',
				title: line(many && label ? `${product.name} - ${label}` : product.name, TITLE_LENGTH),
				description: (product.description || product.summary || product.name).trim().slice(0, DESCRIPTION_LENGTH),
				link: context.link,
				image: context.image,
				price: money(onSale ? /** @type {number} */ (variant.compareAtPrice) : variant.price),
				salePrice: onSale ? money(variant.price) : '',
				inStock: variantInStock(product, variant),
				condition: conditionOf(product, variant, context.graded),
				brand: context.brand,
				gtin: context.skuAs === 'gtin' ? sku : '',
				mpn: context.skuAs === 'mpn' ? sku : '',
				productType: context.productType,
			};
		});
};

/**
 * The start of a Google Merchant feed.
 * @param {{ title: string, link: string, description: string }} channel
 */
export const googleHead = ({ title, link, description }) =>
	`<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n<channel>\n` +
	`<title>${escapeXml(title)}</title>\n<link>${escapeXml(link)}</link>\n<description>${escapeXml(description)}</description>\n`;

/** The end of a Google Merchant feed. */
export const GOOGLE_FOOT = '</channel>\n</rss>\n';

/**
 * One `<item>` of a Google Merchant feed; empty fields are left out.
 * @param {FeedRow} row
 */
export const googleItem = (row) => {
	/** @type {Array<[string, string]>} */
	const fields = [
		['g:id', row.id],
		['g:item_group_id', row.itemGroupId],
		['title', row.title],
		['description', row.description],
		['link', row.link],
		['g:image_link', row.image],
		['g:availability', row.inStock ? 'in_stock' : 'out_of_stock'],
		['g:price', row.price],
		['g:sale_price', row.salePrice],
		['g:condition', row.condition],
		['g:brand', row.brand],
		['g:gtin', row.gtin],
		['g:mpn', row.mpn],
		['g:product_type', row.productType],
	];
	const body = fields
		.filter(([, value]) => value !== '')
		.map(([name, value]) => `<${name}>${escapeXml(value)}</${name}>`)
		.join('');
	return `<item>${body}</item>\n`;
};

/** The columns of a Meta catalog CSV. */
const META_COLUMNS = Object.freeze([
	'id',
	'title',
	'description',
	'availability',
	'condition',
	'price',
	'link',
	'image_link',
	'brand',
	'item_group_id',
]);

/**
 * One CSV cell (RFC 4180): quoted when it holds a comma, a quote or a line break.
 * @param {string} value
 */
export const csvCell = (value) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

/** The header line of a Meta catalog CSV. */
export const META_HEADER = `${META_COLUMNS.join(',')}\r\n`;

/**
 * One line of a Meta catalog CSV. Meta takes the sale price in its own column only with a separate `sale_price`;
 * this feed sends the price the shopper pays.
 * @param {FeedRow} row
 */
export const metaLine = (row) =>
	`${[
		row.id,
		row.title,
		row.description,
		row.inStock ? 'in stock' : 'out of stock',
		row.condition || 'new',
		row.salePrice || row.price,
		row.link,
		row.image,
		row.brand,
		row.itemGroupId,
	]
		.map(csvCell)
		.join(',')}\r\n`;
