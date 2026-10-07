/**
 * CSV import and export (pure), ported from the store's variant bulk update (dry-run diff, blank cell = unchanged,
 * per-row errors, an optimistic guard so a concurrent change becomes a conflict) and widened to whole items: rows are
 * variants grouped by item (`item_id`, else `item_slug`), item-level columns update the item, variant columns update
 * the variant matched by `variant_id` or `sku` (or add one), `image_urls` adds media by URL, and `attr.<key>`,
 * `custom.<key>` and `option.<key>` columns address attributes, custom fields and option values.
 *
 * Prices in CSV are written in major units ("12.50") and converted with the currency's minor-unit exponent.
 * @module
 */
import { formatMajor, parseMajor } from './money.js';
import { parseCsv, recordsOf, toCsv } from './csv.js';
import { cleanText, isId, isKey, isSlug, issue, slugify } from './text.js';

export const ITEM_COLUMNS = Object.freeze([
	'item_id',
	'item_slug',
	'title',
	'type',
	'status',
	'brand',
	'collections',
	'tags',
	'summary',
	'external_id',
]);
export const VARIANT_COLUMNS = Object.freeze([
	'variant_id',
	'sku',
	'barcode',
	'options',
	'price',
	'compare_at_price',
	'cost',
	'quantity',
]);
export const OTHER_COLUMNS = Object.freeze(['currency', 'image_urls', 'description']);
const DYNAMIC = /^(attr|custom|option)\.([a-z][a-z0-9_]*)$/;
const TRUE = new Set(['true', 'yes', 'y', '1']);
const FALSE = new Set(['false', 'no', 'n', '0']);

/** @param {string} column */
export const knownColumn = (column) =>
	ITEM_COLUMNS.includes(column) || VARIANT_COLUMNS.includes(column) || OTHER_COLUMNS.includes(column) || DYNAMIC.test(column);

/**
 * @typedef {object} ImportRow
 * @property {number} line
 * @property {{ id: string | null, slug: string | null }} item
 * @property {Record<string, string>} values the non-blank cells of known columns
 */

/**
 * @typedef {object} ImportGroup
 * @property {string} key
 * @property {{ id: string | null, slug: string | null }} ref
 * @property {ImportRow[]} rows
 */

/**
 * Parse an import file into item groups (column mapping applied first: `{ "Their column": "our_column" }`).
 * @param {string} csv
 * @param {{ maxRows: number, mapping?: Record<string, string>, delimiter?: string }} options
 * @returns {{ ok: true, columns: string[], ignored: string[], groups: ImportGroup[], problems: Array<{ line: number, path: string, code: string }> }
 *   | { ok: false, code: string }}
 */
export const parseImport = (csv, { maxRows, mapping = {}, delimiter = ',' }) => {
	const parsed = parseCsv(csv, { delimiter, maxRows });
	if (!parsed.ok) return { ok: false, code: parsed.code };
	const lowered = Object.fromEntries(Object.entries(mapping).map(([from, to]) => [from.trim().toLowerCase(), to]));
	const [header = [], ...rest] = parsed.rows;
	const mapped = header.map((cell) => {
		const name = cell.trim().toLowerCase();
		return lowered[name] ?? name;
	});
	const { records } = recordsOf([mapped, ...rest]);
	const columns = [...new Set(mapped.filter(knownColumn))];
	const ignored = [...new Set(mapped.filter((name) => name && !knownColumn(name)))];
	if (!columns.includes('item_id') && !columns.includes('item_slug') && !columns.includes('title'))
		return { ok: false, code: 'item_column_required' };
	if (records.length === 0) return { ok: false, code: 'empty' };
	/** @type {Map<string, ImportGroup>} */
	const groups = new Map();
	/** @type {Array<{ line: number, path: string, code: string }>} */
	const problems = [];
	for (const record of records) {
		/** @type {Record<string, string>} */
		const values = {};
		for (const column of columns)
			if ((record.values[column] ?? '') !== '') values[column] = /** @type {string} */ (record.values[column]);
		const id = values.item_id ?? null;
		const slug = values.item_slug ?? (id ? null : values.title ? slugify(values.title) : null);
		if (id !== null && !isId(id)) problems.push({ line: record.line, path: '/item_id', code: 'id_invalid' });
		else if (id === null && (slug === null || !isSlug(slug)))
			problems.push({ line: record.line, path: '/item_slug', code: 'item_required' });
		else {
			const key = id ? `id:${id}` : `slug:${slug}`;
			const group = groups.get(key) ?? { key, ref: { id, slug }, rows: [] };
			group.rows.push({ line: record.line, item: { id, slug }, values });
			groups.set(key, group);
		}
	}
	return { ok: true, columns, ignored, groups: [...groups.values()], problems };
};

/**
 * @param {string} value
 * @param {string} separator
 */
const list = (value, separator) =>
	value
		.split(separator)
		.map((part) => part.trim())
		.filter(Boolean);

/**
 * Lookups the plan needs.
 * @typedef {object} PlanContext
 * @property {string} separator
 * @property {(currency: string | null) => number} exponentOf
 * @property {string | null} catalogCurrency
 * @property {(slug: string) => string | null} brandId
 * @property {(slug: string) => string | null} collectionId
 * @property {ReadonlyMap<string, import('./attributes.js').Attribute>} attributes by key
 * @property {boolean} includeCost
 */

/**
 * @param {string} raw
 * @param {import('./attributes.js').Attribute | undefined} attribute
 * @param {string} separator
 * @returns {{ value: unknown } | { code: string }}
 */
const attributeCell = (raw, attribute, separator) => {
	if (!attribute) return { code: 'attribute_unknown' };
	if (attribute.type === 'number') {
		const number = Number(raw);
		return Number.isFinite(number) ? { value: number } : { code: 'number_invalid' };
	}
	if (attribute.type === 'boolean') {
		const lower = raw.toLowerCase();
		return TRUE.has(lower) ? { value: true } : FALSE.has(lower) ? { value: false } : { code: 'boolean_invalid' };
	}
	if (attribute.type === 'multi_select') return { value: list(raw, separator) };
	return { value: raw };
};

/**
 * Turn one item group into an item write (fields as the API takes them) or row errors. Item-level cells come from
 * the first row that has them; every row with variant cells is one variant.
 * @param {ImportGroup} group
 * @param {Record<string, any> | null} current the stored item (null = create)
 * @param {PlanContext} context
 * @returns {{ errors: Array<{ line: number, path: string, code: string }>, item: Record<string, unknown>,
 *   variants: Array<{ line: number, id: string | null, fields: Record<string, unknown> }>, images: string[] }}
 */
export const planGroup = (group, current, context) => {
	/** @type {Array<{ line: number, path: string, code: string }>} */
	const errors = [];
	/** @type {Record<string, unknown>} */
	const item = {};
	/** @type {Record<string, unknown>} */
	const attributes = {};
	/** @type {Record<string, unknown>} */
	const custom = {};
	/** @type {string[]} */
	const images = [];
	const first = (/** @type {string} */ column) => group.rows.find((row) => row.values[column] !== undefined);
	for (const [column, field] of /** @type {const} */ ([
		['title', 'title'],
		['type', 'type'],
		['status', 'status'],
		['summary', 'summary'],
		['description', 'description'],
		['external_id', 'externalId'],
	])) {
		const row = first(column);
		if (row) item[field] = row.values[column];
	}
	if (group.ref.slug && !current) item.slug = group.ref.slug;
	const slugRow = first('item_slug');
	if (current && slugRow && group.ref.id) item.slug = slugRow.values.item_slug;
	const currencyRow = first('currency');
	const currency = currencyRow
		? /** @type {string} */ (currencyRow.values.currency).toUpperCase()
		: (current?.currency ?? context.catalogCurrency);
	if (currencyRow && currency !== context.catalogCurrency) item.currency = currency;
	const brandRow = first('brand');
	if (brandRow) {
		const id = context.brandId(/** @type {string} */ (brandRow.values.brand));
		if (id) item.brandId = id;
		else errors.push({ line: brandRow.line, path: '/brand', code: 'brand_unknown' });
	}
	const collectionsRow = first('collections');
	if (collectionsRow) {
		const ids = list(/** @type {string} */ (collectionsRow.values.collections), context.separator).map((slug) => {
			const id = context.collectionId(slug);
			if (!id) errors.push({ line: collectionsRow.line, path: '/collections', code: 'collection_unknown' });
			return id;
		});
		item.collectionIds = ids.filter(Boolean);
	}
	const tagsRow = first('tags');
	if (tagsRow) item.tags = list(/** @type {string} */ (tagsRow.values.tags), context.separator);
	for (const row of group.rows)
		for (const [column, raw] of Object.entries(row.values)) {
			const match = DYNAMIC.exec(column);
			if (!match || match[1] === 'option') continue;
			const key = /** @type {string} */ (match[2]);
			if (match[1] === 'custom') custom[key] ??= raw;
			else if (attributes[key] === undefined) {
				const cell = attributeCell(raw, context.attributes.get(key), context.separator);
				if ('code' in cell) errors.push({ line: row.line, path: `/${column}`, code: cell.code });
				else attributes[key] = cell.value;
			}
		}
	if (Object.keys(attributes).length > 0) item.attributes = attributes;
	if (Object.keys(custom).length > 0) item.custom = custom;
	const exponent = context.exponentOf(currency);
	/** @type {Array<{ line: number, id: string | null, fields: Record<string, unknown> }>} */
	const variants = [];
	for (const row of group.rows) {
		for (const url of row.values.image_urls ? list(row.values.image_urls, context.separator) : [])
			if (!images.includes(url)) images.push(url);
		const cells = Object.keys(row.values).filter((column) => VARIANT_COLUMNS.includes(column) || column.startsWith('option.'));
		if (cells.length === 0) continue;
		/** @type {Record<string, unknown>} */
		const fields = {};
		const known = /** @type {Array<Record<string, any>>} */ (current?.variants ?? []);
		// a row naming no variant addresses the only variant of a single-variant item
		const existing =
			!row.values.variant_id && !row.values.sku && known.length === 1
				? known[0]
				: known.find(
						(v) =>
							(row.values.variant_id && v.id === row.values.variant_id) || (row.values.sku && v.sku === row.values.sku),
					);
		if (row.values.variant_id && !existing) errors.push({ line: row.line, path: '/variant_id', code: 'variant_unknown' });
		if (row.values.sku !== undefined) fields.sku = row.values.sku;
		if (row.values.barcode !== undefined) fields.barcode = row.values.barcode;
		for (const [column, field] of /** @type {const} */ ([
			['price', 'price'],
			['compare_at_price', 'compareAtPrice'],
			['cost', 'cost'],
		])) {
			if (row.values[column] === undefined || (field === 'cost' && !context.includeCost)) continue;
			const amount = parseMajor(/** @type {string} */ (row.values[column]), exponent);
			if (amount === null) errors.push({ line: row.line, path: `/${column}`, code: 'amount_invalid' });
			else fields[field] = amount;
		}
		if (row.values.quantity !== undefined) {
			const quantity = Number(row.values.quantity.replace(/[\s,]/g, ''));
			if (!Number.isSafeInteger(quantity)) errors.push({ line: row.line, path: '/quantity', code: 'quantity_invalid' });
			else fields.quantity = quantity;
		}
		/** @type {Record<string, string>} */
		const options = { ...(existing?.options ?? {}) };
		let optionsGiven = false;
		if (row.values.options) {
			optionsGiven = true;
			for (const pair of list(row.values.options, context.separator)) {
				const [key, value] = pair.split('=').map((part) => part?.trim() ?? '');
				if (!key || !value || !isKey(key)) errors.push({ line: row.line, path: '/options', code: 'options_invalid' });
				else options[key] = value;
			}
		}
		for (const [column, raw] of Object.entries(row.values))
			if (column.startsWith('option.')) {
				optionsGiven = true;
				options[column.slice(7)] = raw;
			}
		if (optionsGiven) fields.options = options;
		if (!existing && fields.price === undefined) errors.push({ line: row.line, path: '/price', code: 'required' });
		variants.push({ line: row.line, id: existing?.id ?? null, fields });
	}
	if (!current && item.title === undefined) errors.push({ line: group.rows[0]?.line ?? 0, path: '/title', code: 'required' });
	if (item.title !== undefined && cleanText(item.title, 300) === null)
		errors.push({ line: group.rows[0]?.line ?? 0, path: '/title', code: 'text_invalid' });
	return { errors, item, variants, images };
};

/**
 * Field-level differences of a planned write (for the dry-run diff).
 * @param {Record<string, any> | null} current
 * @param {{ item: Record<string, unknown>, variants: Array<{ id: string | null, fields: Record<string, unknown> }>, images: string[] }} plan
 * @returns {Array<{ field: string, from: unknown, to: unknown, variantId?: string | null }>}
 */
export const diffOf = (current, plan) => {
	/** @type {Array<{ field: string, from: unknown, to: unknown, variantId?: string | null }>} */
	const out = [];
	for (const [field, to] of Object.entries(plan.item)) {
		const from = current?.[field] ?? null;
		if (field === 'attributes' || field === 'custom') {
			for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (to))) {
				const before = current?.[field]?.[key] ?? null;
				if (JSON.stringify(before) !== JSON.stringify(value)) out.push({ field: `${field}.${key}`, from: before, to: value });
			}
		} else if (JSON.stringify(from) !== JSON.stringify(to)) out.push({ field, from, to });
	}
	for (const variant of plan.variants) {
		const existing = variant.id ? (current?.variants ?? []).find((/** @type {any} */ v) => v.id === variant.id) : null;
		for (const [field, to] of Object.entries(variant.fields)) {
			const from = existing ? (existing[field] ?? null) : null;
			if (JSON.stringify(from) !== JSON.stringify(to))
				out.push({ field: `variant.${field}`, from, to, variantId: variant.id });
		}
	}
	const urls = new Set((current?.media ?? []).map((/** @type {any} */ m) => m.url));
	for (const url of plan.images) if (!urls.has(url)) out.push({ field: 'media', from: null, to: url });
	return out;
};

/**
 * Export rows: one per variant (an item without variants gets one row).
 * @param {ReadonlyArray<Record<string, any>>} items
 * @param {{ columns: readonly string[], separator: string, includeCost: boolean, brandSlug: (id: string | null) => string,
 *   collectionSlug: (id: string) => string | null, currencyOf: (item: Record<string, any>) => string | null,
 *   exponentOf: (currency: string | null) => number, mediaUrl: (media: Record<string, any>) => string | null }} context
 * @returns {string}
 */
export const exportCsv = (items, context) => {
	const columns = context.columns.filter((column) => context.includeCost || column !== 'cost');
	const money = (/** @type {number | null | undefined} */ amount, /** @type {number} */ exponent) =>
		typeof amount === 'number' ? formatMajor(amount, exponent) : '';
	const rows = items.flatMap((item) => {
		const currency = context.currencyOf(item);
		const exponent = context.exponentOf(currency);
		const variants = item.variants?.length > 0 ? item.variants : [null];
		return variants.map((/** @type {any} */ variant) =>
			columns.map((column) => {
				const dynamic = DYNAMIC.exec(column);
				if (dynamic) {
					const source = dynamic[1] === 'attr' ? item.attributes : dynamic[1] === 'custom' ? item.custom : variant?.options;
					const value = source?.[/** @type {string} */ (dynamic[2])];
					return Array.isArray(value) ? value.join(context.separator) : (value ?? '');
				}
				switch (column) {
					case 'item_id':
						return item.id;
					case 'item_slug':
						return item.slug;
					case 'title':
					case 'type':
					case 'status':
					case 'summary':
					case 'description':
						return item[column] ?? '';
					case 'external_id':
						return item.externalId ?? '';
					case 'brand':
						return context.brandSlug(item.brandId ?? null);
					case 'collections':
						return (item.collectionIds ?? []).map(context.collectionSlug).filter(Boolean).join(context.separator);
					case 'tags':
						return (item.tags ?? []).join(context.separator);
					case 'currency':
						return currency ?? '';
					case 'image_urls':
						return (item.media ?? []).map(context.mediaUrl).filter(Boolean).join(context.separator);
					case 'variant_id':
						return variant?.id ?? '';
					case 'sku':
					case 'barcode':
						return variant?.[column] ?? '';
					case 'options':
						return Object.entries(variant?.options ?? {})
							.map(([key, value]) => `${key}=${value}`)
							.join(context.separator);
					case 'price':
						return money(variant?.price, exponent);
					case 'compare_at_price':
						return money(variant?.compareAtPrice, exponent);
					case 'cost':
						return money(variant?.cost, exponent);
					case 'quantity':
						return variant ? variant.quantity : '';
					default:
						return '';
				}
			}),
		);
	});
	return toCsv(columns, rows);
};

/**
 * A blank template with the export columns.
 * @param {readonly string[]} columns
 */
export const templateCsv = (columns) => toCsv(columns, []);

/** @param {Array<{ line: number, path: string, code: string }>} errors */
export const rowProblems = (errors) => errors.map((error) => ({ ...issue(error.path, error.code), line: error.line }));
