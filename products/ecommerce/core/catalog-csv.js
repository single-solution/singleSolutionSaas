/**
 * The catalog's CSV files (PLAN 0.8.8 Admin tools): products and stock out (one row per variant), products in (rows
 * of one product share its id or slug; a product is updated when its id, one of its SKUs or its slug is known, else
 * created), and orders out (one row per order line). Prices are decimals of the shop's currency in the files and minor
 * units inside. Empty cells keep a value (name, price, stock …) or clear it (texts, lists, the "was" price, cost,
 * grade); a column left out keeps the value. Import never deletes variants. No I/O.
 * @module
 */
import { isObject, slugify } from './catalog.js';
import { fromDecimal, toDecimal } from './money.js';

/** @typedef {import('./model.js').ProductRecord} ProductRecord */
/** @typedef {import('./model.js').VariantRecord} VariantRecord */
/** @typedef {import('./model.js').OrderRecord} OrderRecord */
/** @typedef {import('./catalog.js').FieldError} FieldError */
/** @typedef {import('./csv.js').Cell} Cell */

/** Most data rows of an import. */
export const MAX_IMPORT_ROWS = 5000;
/** Option columns: option1_name, option1_value … */
export const OPTION_COLUMNS = 3;
/** A location's stock column: `stock@<location id>`. */
export const LOCATION_COLUMN = 'stock@';

/** Columns of the products file (location stock columns follow). */
export const PRODUCT_COLUMNS = Object.freeze([
	'product_id',
	'slug',
	'name',
	'status',
	'kind',
	'categories',
	'brand',
	'tags',
	'summary',
	'description',
	'seo_title',
	'seo_description',
	'track_stock',
	'variant_id',
	'sku',
	...Array.from({ length: OPTION_COLUMNS }, (_, i) => [`option${i + 1}_name`, `option${i + 1}_value`]).flat(),
	'price',
	'compare_at_price',
	'cost',
	'stock',
	'grade',
	'active',
]);

/**
 * @typedef {object} CsvLookups
 * @property {string} currency
 * @property {ReadonlyMap<string, string>} categorySlugs category id → slug
 * @property {ReadonlyMap<string, string>} brandSlugs brand id → slug
 * @property {string[]} locationIds
 */

/**
 * The products file's header (with a stock column per location when multi-location stock is on).
 * @param {string[]} locationIds
 */
export const productHeader = (locationIds) => [...PRODUCT_COLUMNS, ...locationIds.map((id) => `${LOCATION_COLUMN}${id}`)];

/**
 * One row per variant.
 * @param {Iterable<ProductRecord>} products
 * @param {CsvLookups} lookups
 * @returns {Cell[][]}
 */
export const productRows = (products, { currency, categorySlugs, brandSlugs, locationIds }) => {
	/** @type {Cell[][]} */
	const rows = [];
	/** @param {number | null} amount */
	const money = (amount) => (amount === null ? '' : toDecimal(amount, currency));
	for (const product of products)
		for (const variant of product.variants) {
			const options = Array.from({ length: OPTION_COLUMNS }, (_, i) => {
				const axis = product.options[i];
				return axis ? [axis.name, variant.options[axis.name] ?? ''] : ['', ''];
			}).flat();
			rows.push([
				product.id,
				product.slug,
				product.name,
				product.status,
				product.kind,
				product.categoryIds.map((id) => categorySlugs.get(id) ?? id).join('|'),
				product.brandId ? (brandSlugs.get(product.brandId) ?? product.brandId) : '',
				product.tags.join('|'),
				product.summary,
				product.description,
				product.seo.title,
				product.seo.description,
				product.trackStock,
				variant.id,
				variant.sku,
				...options,
				money(variant.price),
				money(variant.compareAtPrice),
				money(variant.cost),
				variant.stock,
				variant.grade ?? '',
				variant.active,
				...locationIds.map((id) => variant.locations[id] ?? 0),
			]);
		}
	return rows;
};

/** Columns of the orders file. */
export const ORDER_COLUMNS = Object.freeze([
	'number',
	'placed_at',
	'status',
	'customer',
	'city',
	'product',
	'variant',
	'sku',
	'quantity',
	'unit_price',
	'discount',
	'total',
	'currency',
	'payment_method',
	'payment_state',
]);

/**
 * One row per order line.
 * @param {Iterable<OrderRecord>} orders
 * @returns {Cell[][]}
 */
export const orderRows = (orders) => {
	/** @type {Cell[][]} */
	const rows = [];
	for (const order of orders) {
		const currency = order.totals.currency;
		for (const line of order.lines)
			rows.push([
				order.number,
				new Date(order.placedAt).toISOString(),
				order.status,
				order.customer.name,
				order.address?.city ?? '',
				line.name,
				line.variantName,
				line.sku,
				line.quantity,
				toDecimal(line.unitPrice, currency),
				toDecimal(line.discount, currency),
				toDecimal(line.total, currency),
				currency,
				order.payment.method,
				order.payment.state,
			]);
	}
	return rows;
};

// ------------------------------------------------------------------------------------------------------- import

/**
 * What one row says about its variant (undefined = keep).
 * @typedef {object} VariantRow
 * @property {string} [id]
 * @property {string} [sku]
 * @property {Record<string, string>} [options]
 * @property {number} [price]
 * @property {number | null} [compareAtPrice]
 * @property {number | null} [cost]
 * @property {number} [stock]
 * @property {Record<string, number>} [locations]
 * @property {string | null} [grade]
 * @property {boolean} [active]
 */

/**
 * One product of an import: its rows, how to find it, and the product fields the file gives (as API input).
 * @typedef {object} ImportGroup
 * @property {string} key
 * @property {number} line the first row's line
 * @property {string | null} productId
 * @property {string} slug explicit or made from the name ('' when neither)
 * @property {string[]} skus
 * @property {Record<string, any>} fields product fields in API shape (categories and brand still as slugs)
 * @property {string[] | undefined} categories slugs or ids (undefined = keep)
 * @property {string | null | undefined} brand slug, id or name (null = none, undefined = keep)
 * @property {Array<{ line: number, variant: VariantRow }>} rows
 */

/** @param {string} value */
const flag = (value) => {
	const v = value.toLowerCase();
	if (['true', 'yes', '1'].includes(v)) return true;
	if (['false', 'no', '0'].includes(v)) return false;
	return null;
};

/** @param {string} value @param {string} currency */
const amountOf = (value, currency) => (/^0+(\.0+)?$/.test(value) ? 0 : fromDecimal(value, currency));

/**
 * Read the rows of a products file into products.
 * @param {{ header: string[], records: Array<{ line: number, values: Record<string, string> }> }} file
 * @param {{ currency: string, locationIds: ReadonlySet<string> }} context
 * @returns {{ groups: ImportGroup[], errors: Array<FieldError & { line: number }> }}
 */
export const importGroups = ({ header, records }, { currency, locationIds }) => {
	/** @type {Array<FieldError & { line: number }>} */
	const errors = [];
	const has = (/** @type {string} */ column) => header.includes(column);
	if (!has('name') && !has('slug') && !has('product_id') && !has('sku'))
		return { groups: [], errors: [{ line: 1, path: '', message: 'The file needs a name, slug, product_id or sku column.' }] };
	const locationColumns = header.filter((column) => column.startsWith(LOCATION_COLUMN));
	for (const column of locationColumns)
		if (!locationIds.has(column.slice(LOCATION_COLUMN.length)))
			errors.push({ line: 1, path: `/${column}`, message: 'There is no such location.' });
	/** @type {Map<string, ImportGroup>} */
	const groups = new Map();
	for (const { line, values } of records) {
		/** @param {string} path @param {string} message */
		const fail = (path, message) => errors.push({ line, path: `/${path}`, message });
		const productId = values.product_id || null;
		const slug = values.slug || slugify(values.name ?? '');
		const sku = values.sku ?? '';
		const key = productId ?? (slug || (sku ? `sku:${sku}` : ''));
		if (!key) {
			fail('name', 'Give the product a name, slug or SKU.');
			continue;
		}
		/** @type {VariantRow} */
		const variant = {};
		if (values.variant_id) variant.id = values.variant_id;
		if (has('sku')) variant.sku = sku;
		/** @type {Record<string, string>} */
		const options = {};
		let optionColumns = false;
		for (let i = 1; i <= OPTION_COLUMNS; i += 1) {
			if (!has(`option${i}_name`)) continue;
			optionColumns = true;
			const name = values[`option${i}_name`] ?? '';
			const value = values[`option${i}_value`] ?? '';
			if (name && value) options[name] = value;
			else if (name || value) fail(`option${i}_value`, 'Give both the option name and its value.');
		}
		if (optionColumns) variant.options = options;
		if (values.price) {
			const price = amountOf(values.price, currency);
			if (price === null) fail('price', `This is not a price in ${currency}.`);
			else variant.price = price;
		}
		for (const [column, name] of /** @type {const} */ ([
			['compare_at_price', 'compareAtPrice'],
			['cost', 'cost'],
		])) {
			if (!has(column)) continue;
			const text = values[column] ?? '';
			const amount = text ? amountOf(text, currency) : null;
			if (text && amount === null) fail(column, `This is not a price in ${currency}.`);
			else variant[name] = amount;
		}
		if (values.stock) {
			if (!/^\d{1,10}$/.test(values.stock)) fail('stock', 'Stock is a whole number from 0.');
			else variant.stock = Number(values.stock);
		}
		if (locationColumns.length > 0) {
			/** @type {Record<string, number>} */
			const locations = {};
			for (const column of locationColumns) {
				const text = values[column] ?? '';
				if (!text) continue;
				if (!/^\d{1,10}$/.test(text)) fail(column, 'Stock is a whole number from 0.');
				else locations[column.slice(LOCATION_COLUMN.length)] = Number(text);
			}
			if (Object.keys(locations).length > 0) variant.locations = locations;
		}
		if (has('grade')) variant.grade = values.grade || null;
		if (values.active) {
			const active = flag(values.active);
			if (active === null) fail('active', 'Active is true or false.');
			else variant.active = active;
		}

		let group = groups.get(key);
		if (!group) {
			/** @type {Record<string, any>} */
			const fields = {};
			if (values.name) fields.name = values.name;
			if (values.slug) fields.slug = values.slug;
			for (const column of ['status', 'kind']) if (values[column]) fields[column] = values[column];
			for (const column of ['summary', 'description']) if (has(column)) fields[column] = values[column] ?? '';
			if (has('tags'))
				fields.tags = (values.tags ?? '')
					.split('|')
					.map((tag) => tag.trim())
					.filter(Boolean);
			if (has('seo_title') || has('seo_description'))
				fields.seo = {
					...(has('seo_title') ? { title: values.seo_title ?? '' } : {}),
					...(has('seo_description') ? { description: values.seo_description ?? '' } : {}),
				};
			if (values.track_stock) {
				const track = flag(values.track_stock);
				if (track === null) fail('track_stock', 'Track stock is true or false.');
				else fields.trackStock = track;
			}
			group = {
				key,
				line,
				productId,
				slug,
				skus: [],
				fields,
				categories: has('categories')
					? (values.categories ?? '')
							.split('|')
							.map((part) => part.trim())
							.filter(Boolean)
					: undefined,
				brand: has('brand') ? values.brand || null : undefined,
				rows: [],
			};
			groups.set(key, group);
		}
		if (sku) group.skus.push(sku);
		group.rows.push({ line, variant });
	}
	return { groups: [...groups.values()], errors };
};

/**
 * Whether a row names this variant: its id, else its SKU, else its options.
 * @param {VariantRow} row
 * @param {VariantRecord} variant
 */
const names = (row, variant) => {
	if (row.id) return row.id === variant.id;
	if (row.sku) return row.sku === variant.sku;
	if (row.options && Object.keys(row.options).length > 0)
		return JSON.stringify(Object.entries(row.options).sort()) === JSON.stringify(Object.entries(variant.options).sort());
	return false;
};

/**
 * The API input of a group (for the catalog's product check) and the stock to set on variants that already existed.
 * @param {ImportGroup} group
 * @param {ProductRecord | null} existing
 * @param {{ categoryIds: ReadonlyMap<string, string>, brandIds: ReadonlyMap<string, string> }} lookups slug, id or
 *   lowercase name → id
 * @returns {{ ok: true, input: Record<string, any>, stock: Map<string, { stock?: number, locations?: Record<string, number> }> }
 *   | { ok: false, errors: Array<FieldError & { line: number }> }}
 */
export const importInput = (group, existing, lookups) => {
	/** @type {Array<FieldError & { line: number }>} */
	const errors = [];
	/** @type {Record<string, any>} */
	const input = { ...group.fields };
	if (!existing && input.name === undefined)
		errors.push({ line: group.line, path: '/name', message: 'A new product needs a name.' });
	if (group.categories !== undefined) {
		input.categoryIds = group.categories.map(
			(ref) => lookups.categoryIds.get(ref) ?? lookups.categoryIds.get(ref.toLowerCase()),
		);
		group.categories.forEach((ref, index) => {
			if (!input.categoryIds[index])
				errors.push({ line: group.line, path: '/categories', message: `There is no category ${ref}.` });
		});
	}
	if (group.brand !== undefined) {
		input.brandId =
			group.brand === null ? null : (lookups.brandIds.get(group.brand) ?? lookups.brandIds.get(group.brand.toLowerCase()));
		if (input.brandId === undefined)
			errors.push({ line: group.line, path: '/brand', message: `There is no brand ${group.brand}.` });
	}
	/** @type {Map<string, { stock?: number, locations?: Record<string, number> }>} */
	const stock = new Map();
	/** @type {Array<Record<string, any>>} */
	const variants = (existing?.variants ?? []).map((variant) => ({ id: variant.id }));
	for (const { line, variant: row } of group.rows) {
		const found = existing?.variants.find((variant) => names(row, variant));
		if (row.id && !found) {
			errors.push({ line, path: '/variant_id', message: 'This variant is not part of the product.' });
			continue;
		}
		const { stock: units, locations, ...rest } = row;
		if (found) {
			const entry = /** @type {Record<string, any>} */ (variants.find((variant) => variant.id === found.id));
			Object.assign(entry, rest, { id: found.id });
			if (units !== undefined || locations !== undefined)
				stock.set(found.id, { ...(units === undefined ? {} : { stock: units }), ...(locations ? { locations } : {}) });
		} else {
			if (rest.price === undefined) errors.push({ line, path: '/price', message: 'A new variant needs a price.' });
			variants.push({ ...rest, ...(units === undefined ? {} : { stock: units }), ...(locations ? { locations } : {}) });
		}
	}
	// option axes from every variant's options, in the order they appear
	if (variants.some((variant) => isObject(variant.options))) {
		/** @type {Array<{ name: string, values: string[] }>} */
		const axes = [];
		const all = variants.map((variant) =>
			isObject(variant.options)
				? /** @type {Record<string, string>} */ (variant.options)
				: (existing?.variants.find((v) => v.id === variant.id)?.options ?? {}),
		);
		for (const options of all)
			for (const [name, value] of Object.entries(options)) {
				let axis = axes.find((a) => a.name === name);
				if (!axis) {
					axis = { name, values: [] };
					axes.push(axis);
				}
				if (!axis.values.includes(value)) axis.values.push(value);
			}
		input.options = axes;
	}
	input.variants = variants;
	return errors.length > 0 ? { ok: false, errors } : { ok: true, input, stock };
};
