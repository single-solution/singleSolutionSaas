/**
 * Product feeds (PLAN 0.8.8: sitemaps and product feeds): one row per active variant of every active product, written
 * as a Google Merchant Center RSS 2.0 feed (`g:` namespace) or a Meta (Facebook) catalog CSV. The merchant's site
 * serves them at its own addresses from the product's API (PLAN 0.4.10). The private cost is never a column; a
 * variant priced 0 is never a row (the catalogs refuse free items). Pure functions, no I/O.
 * @module
 */
import {
	escapeXml,
	feedGroupId,
	feedItemId,
	fillTemplate,
	offeredVariants,
	shippingFee,
	variantInStock,
	variantLabel,
} from './seo.js';
import { toDecimal } from './money.js';

/** @typedef {import('./model.js').ProductRecord} ProductRecord */
/** @typedef {import('./seo.js').Condition} Condition */

/** At most this many rows in one feed (the rest are left out). */
export const MAX_FEED_ROWS = 100_000;
/** Longest title and description the catalogs take. */
const TITLE_LENGTH = 150;
const DESCRIPTION_LENGTH = 5000;

/**
 * One feed row (one variant).
 * @typedef {object} FeedRow
 * @property {string} id the variant's imported feed id, else the variant id
 * @property {string} itemGroupId the product's imported feed group id, else the product id when it has more than one
 *   variant, else '' (SG-24)
 * @property {string} title
 * @property {string} description
 * @property {string} link
 * @property {string} image
 * @property {string} price `10.50 USD`: the regular price (the struck-through one when on sale)
 * @property {string} salePrice the shown price when on sale (a deal, or a "was" price), else '' (G4)
 * @property {string} saleDates the sale's ISO 8601 interval (`start/end`) for a deal that holds all day and has an
 *   end, else ''
 * @property {boolean} inStock
 * @property {Condition | ''} condition
 * @property {string} brand
 * @property {string} gtin the variant's GTIN, else its SKU when `skuAs` is gtin
 * @property {string} mpn the variant's MPN, else its SKU when `skuAs` is mpn
 * @property {string} productType category path (`Home > Kitchen`)
 * @property {string} [googleCategory] the Google product category (E17)
 * @property {string[]} customLabels custom_label_0 to custom_label_4: the grade's label (E17, `gradeLabel`) as label 0,
 *   then the field values the merchant sends as labels ('' = none)
 * @property {string} color the field values sent as color, material, size and pattern ('' = none)
 * @property {string} material
 * @property {string} size
 * @property {string} pattern
 * @property {string} [shipping] the delivery fee (`2.50 USD`) for the business's country (E17), 0 from the free-delivery
 *   amount (SG-2)
 * @property {string} [shippingCountry]
 * @property {string} shippingWeight the variant's package weight (`180 g`) when its item type has packages, else ''
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
 * @property {(variant: import('./model.js').VariantRecord) => import('./promotions.js').ShownPrice} shown a variant's
 *   shown price (`shownPrice` with the deals that hold all day, G4)
 * @property {number} now the feed's read time (the start of a sale that names none)
 * @property {'none' | 'mpn' | 'gtin'} skuAs what the SKU is sent as for variants without their own GTIN or MPN
 * @property {boolean} includeOutOfStock
 * @property {string} [googleCategory]
 * @property {(variant: import('./model.js').VariantRecord) => string} [gradeLabel] the grade label for custom_label_0
 * @property {(variant: import('./model.js').VariantRecord) => import('./seo.js').FieldTarget[]} [values] the values of
 *   the fields the feeds send (`show.feeds`), the product's and the variant's
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
 * @property {boolean} [parcels] the product's item type has packages (`parcel`, dynamic model §1): rows send each
 *   variant's weight as the shipping weight
 */

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
 * The rows of one product.
 * @param {ProductRecord} product
 * @param {FeedContext} context
 * @returns {FeedRow[]}
 */
export const feedRows = (product, context) => {
	// the variants offered (active, priced above 0), as structured data has them, so both name the same items and group
	const variants = offeredVariants(product);
	const many = variants.length > 1;
	const money = (/** @type {number} */ amount) => feedMoney(amount, context.currency, context.wholeUnits === true);
	const body = product.description || product.summary || product.name;
	const description = (context.description === 'seo' ? product.seo.description || body : body)
		.trim()
		.slice(0, DESCRIPTION_LENGTH);
	return variants
		.filter((variant) => context.shown(variant).price > 0)
		.filter((variant) => context.includeOutOfStock || variantInStock(product, variant))
		.map((variant) => {
			const label = variantLabel(variant);
			const shown = context.shown(variant);
			const until = shown.was !== null && shown.sale?.until ? new Date(shown.sale.until) : null;
			const from = shown.sale?.from ? new Date(shown.sale.from) : new Date(context.now);
			// the variant's own GTIN and MPN first, else the SKU as the merchant says it is one (G5.6)
			const sku = variant.sku ?? '';
			const gtin = variant.gtin || (context.skuAs === 'gtin' ? sku : '');
			const mpn = variant.mpn || (context.skuAs === 'mpn' ? sku : '');
			const title = fillTemplate(context.title || '{name} - {variant}', {
				name: product.name,
				brand: context.brand,
				variant: many ? label : '',
				options: label,
			});
			return {
				id: feedItemId(variant),
				itemGroupId: feedGroupId(product, many),
				title: line(title || product.name, TITLE_LENGTH),
				description,
				link: context.variantLink?.(variant) ?? context.link,
				image: context.variantImage?.(variant) || context.image,
				price: money(shown.was ?? shown.price),
				salePrice: shown.was === null ? '' : money(shown.price),
				saleDates: until ? `${from.toISOString()}/${until.toISOString()}` : '',
				inStock: variantInStock(product, variant),
				condition: context.condition(variant),
				brand: context.brand,
				gtin,
				mpn,
				productType: context.productType,
				googleCategory: context.googleCategory ?? '',
				...fieldColumns(context.gradeLabel?.(variant) ?? '', context.values?.(variant) ?? []),
				shipping: context.shipping ? money(shippingFee(context.shipping, shown.price)) : '',
				shippingCountry: context.shipping?.country ?? '',
				shippingWeight: context.parcels && variant.parcel?.weightG ? `${variant.parcel.weightG} g` : '',
				identifierExists: context.identifierExists === 'no' && !gtin && !mpn ? 'no' : '',
			};
		});
};

/** The feed attributes field values may fill besides the custom labels. */
const FIELD_COLUMNS = Object.freeze(/** @type {const} */ (['color', 'material', 'size', 'pattern']));

/**
 * The custom labels and the color, material, size and pattern of a row: the grade's label first as custom label 0,
 * then each field value where the merchant sends it (the first value for a column wins; a value longer than the 100
 * characters a custom label takes is cut).
 * @param {string} gradeLabel
 * @param {import('./seo.js').FieldTarget[]} values
 */
const fieldColumns = (gradeLabel, values) => {
	const customLabels = ['', '', '', '', ''];
	customLabels[0] = gradeLabel;
	/** @type {Record<string, string>} */
	const named = { color: '', material: '', size: '', pattern: '' };
	for (const entry of values) {
		const label = /^custom_label_([0-4])$/.exec(entry.target);
		if (label) {
			const index = Number(label[1]);
			if (!customLabels[index]) customLabels[index] = line(entry.value, 100);
		} else if (entry.target in named && !named[entry.target]) named[entry.target] = line(entry.value, 100);
	}
	return {
		customLabels,
		color: named.color ?? '',
		material: named.material ?? '',
		size: named.size ?? '',
		pattern: named.pattern ?? '',
	};
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
		['g:sale_price_effective_date', row.saleDates],
		['g:condition', row.condition],
		['g:brand', row.brand],
		['g:gtin', row.gtin],
		['g:mpn', row.mpn],
		['g:identifier_exists', row.identifierExists ?? ''],
		['g:product_type', row.productType],
		['g:google_product_category', row.googleCategory ?? ''],
		['g:shipping_weight', row.shippingWeight],
		...FIELD_COLUMNS.map((name) => /** @type {[string, string]} */ ([`g:${name}`, row[name]])),
		...row.customLabels.map((label, index) => /** @type {[string, string]} */ ([`g:custom_label_${index}`, label])),
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
	'sale_price',
	'sale_price_effective_date',
	'link',
	'image_link',
	'brand',
	'gtin',
	'mpn',
	'item_group_id',
	'color',
	'material',
	'size',
	'pattern',
	'google_product_category',
	'shipping_weight',
	'custom_label_0',
	'custom_label_1',
	'custom_label_2',
	'custom_label_3',
	'custom_label_4',
]);

/**
 * One CSV cell (RFC 4180): quoted when it holds a comma, a quote or a line break.
 * @param {string} value
 */
export const csvCell = (value) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

/** The header line of a Meta catalog CSV. */
export const META_HEADER = `${META_COLUMNS.join(',')}\r\n`;

/**
 * One line of a Meta catalog CSV: the regular price, and the shown price and its dates when on sale (G4).
 * @param {FeedRow} row
 */
export const metaLine = (row) =>
	`${[
		row.id,
		row.title,
		row.description,
		row.inStock ? 'in stock' : 'out of stock',
		row.condition || 'new',
		row.price,
		row.salePrice,
		row.saleDates,
		row.link,
		row.image,
		row.brand,
		row.gtin,
		row.mpn,
		row.itemGroupId,
		row.color,
		row.material,
		row.size,
		row.pattern,
		row.googleCategory ?? '',
		row.shippingWeight,
		...row.customLabels,
	]
		.map(csvCell)
		.join(',')}\r\n`;
