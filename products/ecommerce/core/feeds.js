/**
 * Product feeds (PLAN 0.8.8: sitemaps and product feeds): one row per active variant of every active product, written
 * as a Google Merchant Center RSS 2.0 feed (`g:` namespace) or a Meta (Facebook) catalog CSV. The merchant's site
 * serves them at its own addresses from the product's API (PLAN 0.4.10). The private cost is never a column; a
 * variant priced 0 is never a row (the catalogues refuse free items). Pure functions, no I/O.
 * @module
 */
import { activeVariants, escapeXml, fillTemplate, shippingFee, variantInStock, variantLabel } from './seo.js';
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
 * @property {string} itemGroupId the product id when it has more than one variant, else ''; with legacy item ids the
 *   product's imported id on every row (SG-24)
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
 * @property {string} productType category path (`Home > Kitchen`)
 * @property {string} [googleCategory] the Google product category (E17)
 * @property {string} [customLabel0] the grade's label (E17)
 * @property {string} [shipping] the delivery fee (`2.50 USD`) for the business's country (E17), 0 from the free-delivery
 *   amount (SG-2)
 * @property {string} [shippingCountry]
 * @property {'no' | ''} [identifierExists] `no` when the row has no GTIN and no MPN and the setting says so (SG-22)
 */

/**
 * @typedef {object} FeedContext
 * @property {string} link the product page
 * @property {string} image the main image address ('' = none)
 * @property {string} brand
 * @property {string} productType
 * @property {string} currency
 * @property {(variant: import('./model.js').VariantRecord) => Condition | ''} condition the condition of a variant (its
 *   grade's, else the setting for graded items; E10)
 * @property {'none' | 'mpn' | 'gtin'} skuAs
 * @property {boolean} includeOutOfStock
 * @property {'variant' | 'legacy'} [itemId] legacy: `<product hex>_<variant hex>` of imported ids (E17)
 * @property {string} [googleCategory]
 * @property {(variant: import('./model.js').VariantRecord) => string} [gradeLabel] the grade label for custom_label_0
 * @property {{ fee: number, freeOver?: number, country: string } | null} [shipping] the default delivery fee, free from
 *   `freeOver` (0 = never; SG-2)
 * @property {boolean} [wholeUnits] amounts without minor units (K7, E17)
 * @property {(variant: import('./model.js').VariantRecord) => string} [variantLink] a variant's page (E13)
 * @property {(variant: import('./model.js').VariantRecord) => string} [variantImage] a variant's first photo (E6)
 * @property {string} [title] the item title pattern (`{name} - {variant}` when not given; SG-3): `{name}`, `{brand}`,
 *   `{variant}` (the option values, on products with several variants) and `{options}` (the option values)
 * @property {'body' | 'seo'} [description] the product's description (else summary) first, or its SEO description
 *   first (SG-23)
 * @property {'auto' | 'no'} [identifierExists] `no`: rows without GTIN and MPN say so (SG-22)
 */

/** Imported ids: a prefix and an ObjectId's 24 hex digits. */
const IMPORTED = /^[a-z]+_([0-9a-f]{24})$/;

/**
 * A feed item id: the variant id, or with `legacy` the `<product hex>_<variant hex>` of imported ids (E17); a variant
 * whose ids were not imported keeps its own id.
 * @param {string} productId
 * @param {string} variantId
 * @param {'variant' | 'legacy'} mode
 */
export const feedItemId = (productId, variantId, mode) => {
	if (mode !== 'legacy') return variantId;
	const product = IMPORTED.exec(productId)?.[1];
	const variant = IMPORTED.exec(variantId)?.[1];
	return product && variant ? `${product}_${variant}` : variantId;
};

/**
 * An amount as feeds take it: decimals and the currency code, or whole units (rounded half up) with `wholeUnits`.
 * @param {number} amount
 * @param {string} currency
 * @param {boolean} whole
 */
export const feedMoney = (amount, currency, whole) => {
	const decimal = toDecimal(amount, currency);
	return `${whole ? String(Math.round(Number(decimal))) : decimal} ${currency}`;
};

/**
 * Text on one line (feeds take no line breaks in titles) cut to `max` characters.
 * @param {string} value
 * @param {number} max
 */
const line = (value, max) => value.replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * The item group of a product's rows: the product id when it has several variants; with legacy item ids, the
 * product's imported id (`<hex>`) on every row, as the shop's earlier feed sent it (SG-24).
 * @param {string} productId
 * @param {boolean} many
 * @param {'variant' | 'legacy'} mode
 */
export const feedGroupId = (productId, many, mode) => {
	if (mode !== 'legacy') return many ? productId : '';
	return IMPORTED.exec(productId)?.[1] ?? productId;
};

/**
 * The rows of one product.
 * @param {ProductRecord} product
 * @param {FeedContext} context
 * @returns {FeedRow[]}
 */
export const feedRows = (product, context) => {
	const variants = activeVariants(product);
	const many = variants.length > 1;
	const mode = context.itemId ?? 'variant';
	const money = (/** @type {number} */ amount) => feedMoney(amount, context.currency, context.wholeUnits === true);
	const body = product.description || product.summary || product.name;
	const description = (context.description === 'seo' ? product.seo.description || body : body)
		.trim()
		.slice(0, DESCRIPTION_LENGTH);
	return variants
		.filter((variant) => variant.price > 0 && (context.includeOutOfStock || variantInStock(product, variant)))
		.map((variant) => {
			const label = variantLabel(variant);
			const onSale = typeof variant.compareAtPrice === 'number' && variant.compareAtPrice > variant.price;
			const sku = variant.sku ?? '';
			const gtin = context.skuAs === 'gtin' ? sku : '';
			const mpn = context.skuAs === 'mpn' ? sku : '';
			const title = fillTemplate(context.title || '{name} - {variant}', {
				name: product.name,
				brand: context.brand,
				variant: many ? label : '',
				options: label,
			});
			return {
				id: feedItemId(product.id, variant.id, mode),
				itemGroupId: feedGroupId(product.id, many, mode),
				title: line(title || product.name, TITLE_LENGTH),
				description,
				link: context.variantLink?.(variant) ?? context.link,
				image: context.variantImage?.(variant) || context.image,
				price: money(onSale ? /** @type {number} */ (variant.compareAtPrice) : variant.price),
				salePrice: onSale ? money(variant.price) : '',
				inStock: variantInStock(product, variant),
				condition: context.condition(variant),
				brand: context.brand,
				gtin,
				mpn,
				productType: context.productType,
				googleCategory: context.googleCategory ?? '',
				customLabel0: context.gradeLabel?.(variant) ?? '',
				shipping: context.shipping ? money(shippingFee(context.shipping, variant.price)) : '',
				shippingCountry: context.shipping?.country ?? '',
				identifierExists: context.identifierExists === 'no' && !gtin && !mpn ? 'no' : '',
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
		['g:identifier_exists', row.identifierExists ?? ''],
		['g:product_type', row.productType],
		['g:google_product_category', row.googleCategory ?? ''],
		['g:custom_label_0', row.customLabel0 ?? ''],
	];
	const body = fields
		.filter(([, value]) => value !== '')
		.map(([name, value]) => `<${name}>${escapeXml(value)}</${name}>`)
		.join('');
	const shipping =
		row.shipping && row.shippingCountry
			? `<g:shipping><g:country>${escapeXml(row.shippingCountry)}</g:country><g:price>${escapeXml(row.shipping)}</g:price></g:shipping>`
			: '';
	return `<item>${body}${shipping}</item>\n`;
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
	'google_product_category',
	'custom_label_0',
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
		row.googleCategory ?? '',
		row.customLabel0 ?? '',
	]
		.map(csvCell)
		.join(',')}\r\n`;
