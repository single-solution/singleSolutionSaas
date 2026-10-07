/**
 * Shopping and marketing feeds (pure): one row per purchasable variant of every public item in the feed's scope,
 * built from a fixed set of source fields and mapped onto the feed's fields by the settings (`feeds.feeds[].mapping`,
 * else the format's standard mapping). Condition values (e.g. grades) map through `feeds.condition_map`. The private
 * cost is not a source field, so no mapping can publish it.
 * @module
 */
import { formatMajor } from './money.js';
import { toCsv } from './csv.js';
import { availabilityOf } from './variants.js';
import { itemUrl, localized } from './views.js';
import { mediaUrl, orderedMedia } from './media.js';
import { fill } from './text.js';

export const FEED_FORMATS = Object.freeze(/** @type {const} */ (['google_xml', 'csv', 'tsv', 'json']));

export const CONTENT_TYPES = Object.freeze({
	google_xml: 'application/xml; charset=utf-8',
	csv: 'text/csv; charset=utf-8',
	tsv: 'text/tab-separated-values; charset=utf-8',
	json: 'application/json; charset=utf-8',
});

/** The source fields a mapping may use (plus attr.<key>, custom.<key>, option.<key>, templates and =constants). */
export const SOURCE_FIELDS = Object.freeze([
	'id',
	'item_id',
	'item_group_id',
	'variant_id',
	'sku',
	'title',
	'description',
	'url',
	'image',
	'additional_images',
	'price',
	'sale_price',
	'amount',
	'sale_amount',
	'currency',
	'availability',
	'quantity',
	'brand',
	'condition',
	'gtin',
	'mpn',
	'product_type',
	'type',
	'kind',
]);

/** @type {Readonly<Record<string, Array<{ target: string, source: string }>>>} */
const GOOGLE = Object.freeze({
	google_xml: [
		{ target: 'g:id', source: 'id' },
		{ target: 'g:item_group_id', source: 'item_group_id' },
		{ target: 'title', source: 'title' },
		{ target: 'description', source: 'description' },
		{ target: 'link', source: 'url' },
		{ target: 'g:image_link', source: 'image' },
		{ target: 'g:additional_image_link', source: 'additional_images' },
		{ target: 'g:availability', source: 'availability' },
		{ target: 'g:price', source: 'price' },
		{ target: 'g:sale_price', source: 'sale_price' },
		{ target: 'g:brand', source: 'brand' },
		{ target: 'g:condition', source: 'condition' },
		{ target: 'g:gtin', source: 'gtin' },
		{ target: 'g:mpn', source: 'mpn' },
		{ target: 'g:product_type', source: 'product_type' },
	],
});
const FLAT = Object.freeze(
	[
		'id',
		'item_group_id',
		'title',
		'description',
		'url',
		'image',
		'availability',
		'price',
		'sale_price',
		'brand',
		'condition',
		'gtin',
		'mpn',
		'product_type',
	].map((name) => ({ target: name === 'url' ? 'link' : name === 'image' ? 'image_link' : name, source: name })),
);

/**
 * The mapping of a feed (its own, else the format's standard one).
 * @param {{ format: string, mapping?: Array<{ target: string, source: string }> }} feed
 */
export const mappingOf = (feed) =>
	feed.mapping && feed.mapping.length > 0 ? feed.mapping : feed.format === 'google_xml' ? (GOOGLE.google_xml ?? []) : [...FLAT];

/**
 * Whether a mapping source can be resolved (checked when listing feeds).
 * @param {string} source
 */
export const sourceValid = (source) =>
	source.startsWith('=') ||
	source.includes('{') ||
	SOURCE_FIELDS.includes(source) ||
	/^(attr|custom|option)\.[a-z][a-z0-9_]*$/.test(source);

/**
 * @typedef {object} FeedContext
 * @property {string} domain
 * @property {string} urlTemplate
 * @property {{ trackInventory: boolean, backorders: 'deny' | 'allow', lowStock: number }} stock
 * @property {import('./media.js').MediaSettings} media
 * @property {(item: Record<string, any>) => string | null} currencyOf
 * @property {(currency: string | null) => number} exponentOf
 * @property {(id: string | null) => string | null} brandName
 * @property {(item: Record<string, any>) => string | null} productType
 * @property {{ source: string, map: Array<{ from: string, to: string }>, fallback: string }} condition
 * @property {string[]} publicCustom keys of public custom fields
 */

/**
 * @param {Record<string, any>} item
 * @param {Record<string, any>} variant
 * @param {string} source `attr.x` / `custom.x` / `option.x`
 * @param {string[]} publicCustom
 */
const dynamicValue = (item, variant, source, publicCustom) => {
	const [kind, key = ''] = source.split('.');
	if (kind === 'option') return variant.options?.[key] ?? null;
	if (kind === 'custom') return publicCustom.includes(key) ? (item.custom?.[key] ?? null) : null;
	return item.attributes?.[key] ?? null;
};

/**
 * Source fields of one variant row.
 * @param {Record<string, any>} item
 * @param {Record<string, any>} variant
 * @param {{ multi: boolean, context: FeedContext }} options
 * @returns {Record<string, string>}
 */
export const sourceRow = (item, variant, { multi, context }) => {
	const currency = context.currencyOf(item);
	const exponent = context.exponentOf(currency);
	const text = localized(item, null);
	const availability = availabilityOf(/** @type {any} */ (variant), context.stock).state;
	const media = orderedMedia(item.media ?? []);
	const forVariant = media.filter((m) => m.variantIds.length === 0 || m.variantIds.includes(variant.id));
	const urls = forVariant.map((m) => mediaUrl(m, { baseUrl: context.media.storage_base_url })).filter(Boolean);
	const money = (/** @type {number} */ amount) =>
		currency ? `${formatMajor(amount, exponent)} ${currency}` : formatMajor(amount, exponent);
	const onSale = typeof variant.compareAtPrice === 'number' && variant.compareAtPrice > variant.price;
	const raw = context.condition.source
		? dynamicValue(item, variant, context.condition.source, Object.keys(item.custom ?? {}))
		: null;
	const condition = context.condition.map.find((m) => m.from === String(raw ?? ''))?.to ?? context.condition.fallback;
	const base = itemUrl(item, { template: context.urlTemplate, domain: context.domain });
	return {
		id: variant.sku ?? variant.id,
		item_id: item.id,
		item_group_id: multi ? item.id : '',
		variant_id: variant.id,
		sku: variant.sku ?? '',
		title: variant.title && multi ? `${text.title} – ${variant.title}`.slice(0, 150) : text.title.slice(0, 150),
		description: (text.description ?? text.summary ?? text.title).slice(0, 5000),
		url: multi ? `${base}${base.includes('?') ? '&' : '?'}variant=${encodeURIComponent(variant.id)}` : base,
		image: /** @type {string} */ (urls[0] ?? ''),
		additional_images: urls.slice(1, 11).join(','),
		price: money(onSale ? variant.compareAtPrice : variant.price),
		sale_price: onSale ? money(variant.price) : '',
		amount: formatMajor(onSale ? variant.compareAtPrice : variant.price, exponent),
		sale_amount: onSale ? formatMajor(variant.price, exponent) : '',
		currency: currency ?? '',
		availability:
			availability === 'sold_out' || availability === 'unavailable'
				? 'out_of_stock'
				: availability === 'backorder'
					? 'backorder'
					: 'in_stock',
		quantity: String(Math.max(0, variant.quantity)),
		brand: context.brandName(item.brandId ?? null) ?? '',
		condition,
		gtin: variant.barcode ?? '',
		mpn: variant.sku ?? '',
		product_type: context.productType(item) ?? '',
		type: item.type,
		kind: '',
	};
};

/**
 * Resolve one mapping source for a row.
 * @param {string} source
 * @param {Record<string, string>} row
 * @param {{ item: Record<string, any>, variant: Record<string, any>, publicCustom: string[] }} raw
 */
export const resolveSource = (source, row, raw) => {
	if (source.startsWith('=')) return source.slice(1);
	if (source.includes('{')) return fill(source, row);
	if (Object.hasOwn(row, source)) return row[source] ?? '';
	const value = dynamicValue(raw.item, raw.variant, source, raw.publicCustom);
	return Array.isArray(value) ? value.join(',') : value === null || value === undefined ? '' : String(value);
};

/**
 * Feed rows (`{ target: value }`) for the items, bounded by `maxRows`.
 * @param {ReadonlyArray<Record<string, any>>} items public items in scope
 * @param {{ format: string, include_out_of_stock?: boolean, mapping?: Array<{ target: string, source: string }> }} feed
 * @param {FeedContext & { maxRows: number }} context
 * @returns {{ rows: Array<Array<[string, string]>>, truncated: boolean }}
 */
export const feedRows = (items, feed, context) => {
	const mapping = mappingOf(feed).filter((m) => sourceValid(m.source));
	/** @type {Array<Array<[string, string]>>} */
	const rows = [];
	for (const item of items) {
		const variants = (item.variants ?? []).filter((/** @type {any} */ v) => v.status !== 'inactive');
		for (const variant of variants) {
			const row = sourceRow(item, variant, { multi: variants.length > 1, context });
			if (feed.include_out_of_stock === false && row.availability === 'out_of_stock') continue;
			if (rows.length >= context.maxRows) return { rows, truncated: true };
			rows.push(
				mapping.map((m) => [m.target, resolveSource(m.source, row, { item, variant, publicCustom: context.publicCustom })]),
			);
		}
	}
	return { rows, truncated: false };
};

/** @param {string} text */
const xml = (text) =>
	text
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');

/**
 * Serialise feed rows in the feed's format.
 * @param {{ format: string, key: string, name: string }} feed
 * @param {Array<Array<[string, string]>>} rows
 * @param {{ domain: string, generatedAt: string }} meta
 * @returns {string}
 */
export const renderFeed = (feed, rows, { domain, generatedAt }) => {
	if (feed.format === 'json')
		return JSON.stringify({
			feed: { key: feed.key, name: feed.name, generatedAt },
			items: rows.map((row) => Object.fromEntries(row.filter(([, value]) => value !== ''))),
		});
	if (feed.format === 'csv' || feed.format === 'tsv') {
		const header = rows[0]?.map(([target]) => target) ?? [];
		if (feed.format === 'csv')
			return toCsv(
				header,
				rows.map((row) => row.map(([, value]) => value)),
			);
		const clean = (/** @type {string} */ value) => value.replace(/[\t\r\n]+/g, ' ');
		return (
			[header, ...rows.map((row) => row.map(([, value]) => value))].map((cells) => cells.map(clean).join('\t')).join('\n') +
			'\n'
		);
	}
	const items = rows
		.map(
			(row) =>
				`<item>${row
					.filter(([, value]) => value !== '')
					.flatMap(([target, value]) =>
						target === 'g:additional_image_link' ? value.split(',').map((url) => [target, url]) : [[target, value]],
					)
					.map(([target, value]) => {
						// only the g: namespace is declared: any other prefix becomes part of the element name
						const name = String(target).startsWith('g:') ? String(target) : String(target).replace(/:/g, '_');
						return `<${name}>${xml(/** @type {string} */ (value))}</${name}>`;
					})
					.join('')}</item>`,
		)
		.join('\n');
	return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel><title>${xml(feed.name)}</title><link>https://${xml(domain)}/</link><description>${xml(feed.name)}</description>\n${items}\n</channel></rss>\n`;
};
