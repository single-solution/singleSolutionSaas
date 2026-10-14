/**
 * The catalog's CSV files (PLAN 0.8.8 Admin tools): products and stock out (one row per variant), products in (rows
 * of one product share its id or slug; a product is updated when its id, one of its SKUs or its slug is known, else
 * created), orders out (one row per order line, or per order, E36) and customers out (E36). Price and stock updates
 * (E36 `mode=update`) change only the price, stock and sold-out flag of the variants they name, and only from rows whose
 * `updated_at` is not older than the product's. Prices are decimals of the shop's currency in the files and minor
 * units inside. Empty cells keep a value (name, price, stock …) or clear it (texts, lists, the "was" price, cost,
 * grade, GTIN, MPN); a column left out keeps the value. Import never deletes variants. No I/O.
 * @module
 */
import { LIMITS, isObject, slugify } from './catalog.js';
import { fromDecimal, toDecimal } from './money.js';
import { spentKey } from './orders.js';

/** @typedef {import('./model.js').ProductRecord} ProductRecord */
/** @typedef {import('./model.js').VariantRecord} VariantRecord */
/** @typedef {import('./model.js').OrderRecord} OrderRecord */
/** @typedef {import('./model.js').CustomerRecord} CustomerRecord */
/** @typedef {import('./csv.js').Cell} Cell */

/** Most data rows of an import. */
export const MAX_IMPORT_ROWS = 5000;
/** Option columns: option1_name, option1_value … */
const OPTION_COLUMNS = 3;
/** A location's stock column: `stock@<location id>`. */
const LOCATION_COLUMN = 'stock@';

/** Columns of the products file (location stock columns follow). */
const PRODUCT_COLUMNS = Object.freeze([
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
	'gtin',
	'mpn',
	...Array.from({ length: OPTION_COLUMNS }, (_, i) => [`option${i + 1}_name`, `option${i + 1}_value`]).flat(),
	'price',
	'compare_at_price',
	'cost',
	'stock',
	'grade',
	'active',
]);

/** Columns after the location stock columns: what a price and stock update (E36) reads besides price and stock. */
const UPDATE_COLUMNS = Object.freeze(['sold_out', 'updated_at']);

/**
 * Why a row of a products file fails (PLAN 0.4.10: the widgets show `customersAdmin.csvProblem.<code>`, never the
 * English `message`): `columns` the header names no product (line 1); `unknown_location` (a `stock@` column);
 * `no_name` a row names no product; `option_pair` an option without its value or name; `not_price` (`currency`);
 * `not_stock`; `not_true_false`; `new_product_name` a new product has no name; `unknown_category` (`category`);
 * `unknown_brand` (`brand`); `not_its_variant` the variant is not the product's; `new_variant_price` a new variant has no
 * price; `stock_per_location` stock without the `stock@` columns; `unknown_product`; `skus_of_two` the row's SKUs belong
 * to two products; `sku_taken` and `sku_twice` (`sku`) another product or another product of the file has the SKU;
 * `slug_taken`; `invalid` the product check refused the field `path` names. A price and stock update (E36) adds
 * `no_variant`, `no_updated_at`, `unknown_variant`, `sku_ambiguous` (use `variant_id`) and `stale` (the product changed
 * after the export).
 */
export const CSV_PROBLEMS = Object.freeze(
	/** @type {const} */ ([
		'columns',
		'unknown_location',
		'no_name',
		'option_pair',
		'not_price',
		'not_stock',
		'not_true_false',
		'new_product_name',
		'unknown_category',
		'unknown_brand',
		'not_its_variant',
		'new_variant_price',
		'stock_per_location',
		'unknown_product',
		'skus_of_two',
		'sku_taken',
		'sku_twice',
		'slug_taken',
		'invalid',
		'no_variant',
		'no_updated_at',
		'unknown_variant',
		'sku_ambiguous',
		'stale',
	]),
);
/**
 * A problem of one row of a CSV file: its line (1 is the header), the column (or the field) as a JSON pointer, the
 * English message, and its code with the values its words take.
 * @typedef {{ line: number, path: string, message: string, code: typeof CSV_PROBLEMS[number],
 *   values?: Record<string, string> }} RowProblem
 */

/**
 * @typedef {object} CsvLookups
 * @property {string} currency
 * @property {ReadonlyMap<string, string>} categorySlugs category id → slug
 * @property {ReadonlyMap<string, string>} brandSlugs brand id → slug
 * @property {string[]} locationIds
 */

/**
 * The products file's header (with a stock column per location when multi-location stock is on, then the sold-out
 * flag and the product's `updated_at`).
 * @param {string[]} locationIds
 */
export const productHeader = (locationIds) => [
	...PRODUCT_COLUMNS,
	...locationIds.map((id) => `${LOCATION_COLUMN}${id}`),
	...UPDATE_COLUMNS,
];

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
				variant.gtin ?? '',
				variant.mpn ?? '',
				...options,
				money(variant.price),
				money(variant.compareAtPrice),
				money(variant.cost),
				variant.stock,
				variant.grade ?? '',
				variant.active,
				...locationIds.map((id) => variant.locations[id] ?? 0),
				variant.soldOut,
				product.updatedAt ? new Date(product.updatedAt).toISOString() : '',
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

/** Columns of the orders file with one row per order (E36 `per=order`). */
export const ORDER_TOTAL_COLUMNS = Object.freeze([
	'number',
	'placed_at',
	'status',
	'customer',
	'city',
	'lines',
	'units',
	'subtotal',
	'discount',
	'delivery',
	'fee',
	'tax',
	'total',
	'currency',
	'payment_method',
	'payment_state',
	'paid',
	'refunded',
]);

/**
 * One row per order (E36 `per=order`).
 * @param {Iterable<OrderRecord>} orders
 * @returns {Cell[][]}
 */
export const orderTotalRows = (orders) => {
	/** @type {Cell[][]} */
	const rows = [];
	for (const order of orders) {
		const { totals } = order;
		const currency = totals.currency;
		/** @param {number | undefined} amount */
		const money = (amount) => toDecimal(Number(amount ?? 0), currency);
		rows.push([
			order.number,
			new Date(order.placedAt).toISOString(),
			order.status,
			order.customer.name,
			order.address?.city ?? '',
			order.lines.length,
			order.lines.reduce((sum, line) => sum + line.quantity, 0),
			money(totals.subtotal),
			money(totals.discount),
			money(totals.delivery),
			money(totals.fee),
			money(totals.tax),
			money(totals.total),
			currency,
			order.payment.method,
			order.payment.state,
			money(order.payment.paid),
			money(order.payment.refunded),
		]);
	}
	return rows;
};

/** Columns of the customers file (E36). */
export const CUSTOMER_COLUMNS = Object.freeze([
	'user_id',
	'customer_id',
	'name',
	'email',
	'phone',
	'city',
	'guest',
	'orders',
	'spent',
	'currency',
	'blocked',
	'blocked_reason',
	'returned_parcels',
	'note',
	'last_order_at',
]);

/**
 * One row per customer record, with the orders they placed and what they paid (paid − refunded), as the customer list
 * shows them.
 * @param {Iterable<CustomerRecord>} customers
 * @param {ReadonlyMap<string, { total: number, count: number }>} spent what they spent, by `spentKey` (`core/orders.js`:
 *   a member by user id, a guest by customer id)
 * @param {string} currency
 * @returns {Cell[][]}
 */
export const customerRows = (customers, spent, currency) => {
	/** @type {Cell[][]} */
	const rows = [];
	for (const customer of customers) {
		const paid = spent.get(spentKey(customer)) ?? { total: 0, count: 0 };
		rows.push([
			customer.userId ?? '',
			customer.id ?? '',
			customer.name,
			customer.email,
			customer.phone,
			customer.city ?? '',
			customer.guest === true,
			paid.count,
			paid.total < 0 ? -Number(toDecimal(-paid.total, currency)) : toDecimal(paid.total, currency),
			currency,
			customer.blocked === true,
			customer.blockedReason ?? '',
			customer.rtoCount ?? 0,
			customer.note ?? '',
			customer.lastOrderAt ? new Date(customer.lastOrderAt).toISOString() : '',
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
 * @property {string} [gtin] '' = none
 * @property {string} [mpn] '' = none
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
 * @returns {{ groups: ImportGroup[], errors: RowProblem[] }}
 */
export const importGroups = ({ header, records }, { currency, locationIds }) => {
	/** @type {RowProblem[]} */
	const errors = [];
	const has = (/** @type {string} */ column) => header.includes(column);
	if (!has('name') && !has('slug') && !has('product_id') && !has('sku'))
		return {
			groups: [],
			errors: [{ line: 1, path: '', message: 'The file needs a name, slug, product_id or sku column.', code: 'columns' }],
		};
	const locationColumns = header.filter((column) => column.startsWith(LOCATION_COLUMN));
	for (const column of locationColumns)
		if (!locationIds.has(column.slice(LOCATION_COLUMN.length)))
			errors.push({ line: 1, path: `/${column}`, message: 'There is no such location.', code: 'unknown_location' });
	/** @type {Map<string, ImportGroup>} */
	const groups = new Map();
	for (const { line, values } of records) {
		/** @param {string} path @param {RowProblem['code']} code @param {string} message @param {Record<string, string>} [words] */
		const fail = (path, code, message, words) =>
			errors.push({ line, path: `/${path}`, message, code, ...(words ? { values: words } : {}) });
		const productId = values.product_id || null;
		const slug = values.slug || slugify(values.name ?? '');
		const sku = values.sku ?? '';
		const key = productId ?? (slug || (sku ? `sku:${sku}` : ''));
		if (!key) {
			fail('name', 'no_name', 'Give the product a name, slug or SKU.');
			continue;
		}
		/** @type {VariantRow} */
		const variant = {};
		if (values.variant_id) variant.id = values.variant_id;
		if (has('sku')) variant.sku = sku;
		for (const column of /** @type {const} */ (['gtin', 'mpn'])) if (has(column)) variant[column] = values[column] ?? '';
		/** @type {Record<string, string>} */
		const options = {};
		let optionColumns = false;
		for (let i = 1; i <= OPTION_COLUMNS; i += 1) {
			if (!has(`option${i}_name`)) continue;
			optionColumns = true;
			const name = values[`option${i}_name`] ?? '';
			const value = values[`option${i}_value`] ?? '';
			if (name && value) options[name] = value;
			else if (name || value) fail(`option${i}_value`, 'option_pair', 'Give both the option name and its value.');
		}
		if (optionColumns) variant.options = options;
		if (values.price) {
			const price = amountOf(values.price, currency);
			if (price === null) fail('price', 'not_price', `This is not a price in ${currency}.`, { currency });
			else variant.price = price;
		}
		for (const [column, name] of /** @type {const} */ ([
			['compare_at_price', 'compareAtPrice'],
			['cost', 'cost'],
		])) {
			if (!has(column)) continue;
			const text = values[column] ?? '';
			const amount = text ? amountOf(text, currency) : null;
			if (text && amount === null) fail(column, 'not_price', `This is not a price in ${currency}.`, { currency });
			else variant[name] = amount;
		}
		if (values.stock) {
			if (!/^\d{1,10}$/.test(values.stock)) fail('stock', 'not_stock', 'Stock is a whole number from 0.');
			else variant.stock = Number(values.stock);
		}
		if (locationColumns.length > 0) {
			/** @type {Record<string, number>} */
			const locations = {};
			for (const column of locationColumns) {
				const text = values[column] ?? '';
				if (!text) continue;
				if (!/^\d{1,10}$/.test(text)) fail(column, 'not_stock', 'Stock is a whole number from 0.');
				else locations[column.slice(LOCATION_COLUMN.length)] = Number(text);
			}
			if (Object.keys(locations).length > 0) variant.locations = locations;
		}
		if (has('grade')) variant.grade = values.grade || null;
		if (values.active) {
			const active = flag(values.active);
			if (active === null) fail('active', 'not_true_false', 'Active is true or false.');
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
				if (track === null) fail('track_stock', 'not_true_false', 'Track stock is true or false.');
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
 *   | { ok: false, errors: RowProblem[] }}
 */
export const importInput = (group, existing, lookups) => {
	/** @type {RowProblem[]} */
	const errors = [];
	/** @type {Record<string, any>} */
	const input = { ...group.fields };
	if (!existing && input.name === undefined)
		errors.push({ line: group.line, path: '/name', message: 'A new product needs a name.', code: 'new_product_name' });
	if (group.categories !== undefined) {
		input.categoryIds = group.categories.map(
			(ref) => lookups.categoryIds.get(ref) ?? lookups.categoryIds.get(ref.toLowerCase()),
		);
		group.categories.forEach((ref, index) => {
			if (!input.categoryIds[index])
				errors.push({
					line: group.line,
					path: '/categories',
					message: `There is no category ${ref}.`,
					code: 'unknown_category',
					values: { category: ref },
				});
		});
	}
	if (group.brand !== undefined) {
		input.brandId =
			group.brand === null ? null : (lookups.brandIds.get(group.brand) ?? lookups.brandIds.get(group.brand.toLowerCase()));
		if (input.brandId === undefined)
			errors.push({
				line: group.line,
				path: '/brand',
				message: `There is no brand ${group.brand}.`,
				code: 'unknown_brand',
				values: { brand: String(group.brand) },
			});
	}
	/** @type {Map<string, { stock?: number, locations?: Record<string, number> }>} */
	const stock = new Map();
	/** @type {Array<Record<string, any>>} */
	const variants = (existing?.variants ?? []).map((variant) => ({ id: variant.id }));
	for (const { line, variant: row } of group.rows) {
		const found = existing?.variants.find((variant) => names(row, variant));
		if (row.id && !found) {
			errors.push({ line, path: '/variant_id', message: 'This variant is not part of the product.', code: 'not_its_variant' });
			continue;
		}
		const { stock: units, locations, ...rest } = row;
		if (found) {
			const entry = /** @type {Record<string, any>} */ (variants.find((variant) => variant.id === found.id));
			Object.assign(entry, rest, { id: found.id });
			if (units !== undefined || locations !== undefined)
				stock.set(found.id, { ...(units === undefined ? {} : { stock: units }), ...(locations ? { locations } : {}) });
		} else {
			if (rest.price === undefined)
				errors.push({ line, path: '/price', message: 'A new variant needs a price.', code: 'new_variant_price' });
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

// ------------------------------------------------------------------------------------------------ update (E36)

/**
 * One row of a price and stock update: the variant it names and what to set (undefined = keep).
 * @typedef {object} UpdateRow
 * @property {number} line
 * @property {string | null} productId
 * @property {string | null} variantId
 * @property {string | null} sku
 * @property {number} updatedAt the product's `updated_at` the row was made from, epoch ms
 * @property {number} [price]
 * @property {number} [stock]
 * @property {Record<string, number>} [locations]
 * @property {boolean} [soldOut]
 */

/**
 * Read the rows of a price and stock update (E36 `mode=update`): each row names a variant (`variant_id`, else `sku`)
 * and gives the `updated_at` of its product from the export; `price`, `stock` (with multi-location stock, the
 * `stock@<location id>` columns) and `sold_out` are set when their cell is not empty. Every other column is ignored. A
 * header without `updated_at` or without a way to name variants refuses the file; a bad row is one failed row.
 * @param {{ header: string[], records: Array<{ line: number, values: Record<string, string> }> }} file
 * @param {{ currency: string, locationIds: ReadonlySet<string> }} context `locationIds`: empty without multi-location
 *   stock
 * @returns {{ ok: false, message: string } | { ok: true, rows: UpdateRow[], failed: RowProblem[] }}
 */
export const updateRows = ({ header, records }, { currency, locationIds }) => {
	const has = (/** @type {string} */ column) => header.includes(column);
	if (!has('updated_at')) return { ok: false, message: 'The file needs the updated_at column of a products export.' };
	if (!has('variant_id') && !has('sku')) return { ok: false, message: 'The file needs a variant_id or sku column.' };
	const locationColumns = header.filter((column) => column.startsWith(LOCATION_COLUMN));
	const unknown = locationColumns.find((column) => !locationIds.has(column.slice(LOCATION_COLUMN.length)));
	if (unknown) return { ok: false, message: `There is no location ${unknown.slice(LOCATION_COLUMN.length)}.` };
	/** @type {UpdateRow[]} */
	const rows = [];
	/** @type {RowProblem[]} */
	const failed = [];
	for (const { line, values } of records) {
		let bad = false;
		/** @param {string} path @param {RowProblem['code']} code @param {string} message @param {Record<string, string>} [words] */
		const fail = (path, code, message, words) => {
			bad = true;
			failed.push({ line, path: `/${path}`, message, code, ...(words ? { values: words } : {}) });
		};
		const variantId = values.variant_id || null;
		const sku = values.sku || null;
		if (!variantId && !sku) {
			fail('variant_id', 'no_variant', 'Name the variant (variant_id or sku).');
			continue;
		}
		const updatedAt = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(values.updated_at ?? '')
			? Date.parse(values.updated_at ?? '')
			: Number.NaN;
		if (Number.isNaN(updatedAt)) {
			fail('updated_at', 'no_updated_at', 'Give the updated_at of a products export.');
			continue;
		}
		/** @type {UpdateRow} */
		const row = { line, productId: values.product_id || null, variantId, sku, updatedAt };
		if (values.price) {
			const price = amountOf(values.price, currency);
			if (price === null) fail('price', 'not_price', `This is not a price in ${currency}.`, { currency });
			else row.price = price;
		}
		if (values.stock) {
			if (locationIds.size > 0) fail('stock', 'stock_per_location', 'Give the stock per location (stock@ columns).');
			else if (!/^\d{1,10}$/.test(values.stock) || Number(values.stock) > LIMITS.stock)
				fail('stock', 'not_stock', 'Stock is a whole number from 0.');
			else row.stock = Number(values.stock);
		}
		/** @type {Record<string, number>} */
		const locations = {};
		for (const column of locationColumns) {
			const text = values[column] ?? '';
			if (!text) continue;
			if (!/^\d{1,10}$/.test(text) || Number(text) > LIMITS.stock)
				fail(column, 'not_stock', 'Stock is a whole number from 0.');
			else locations[column.slice(LOCATION_COLUMN.length)] = Number(text);
		}
		if (Object.keys(locations).length > 0) row.locations = locations;
		if (values.sold_out) {
			const soldOut = flag(values.sold_out);
			if (soldOut === null) fail('sold_out', 'not_true_false', 'Sold out is true or false.');
			else row.soldOut = soldOut;
		}
		if (!bad) rows.push(row);
	}
	return { ok: true, rows, failed };
};

/**
 * A product after the update rows that name its variants (rows naming no variant of it fail). Only `price`, `stock`,
 * `locations` and `soldOut` of variants change.
 * @param {ProductRecord} product
 * @param {UpdateRow[]} rows
 * @returns {{ variants: VariantRecord[], changed: number, failed: RowProblem[] }}
 */
export const updatedVariants = (product, rows) => {
	const variants = product.variants.map((variant) => ({ ...variant, locations: { ...variant.locations } }));
	/** @type {RowProblem[]} */
	const failed = [];
	let changed = 0;
	for (const row of rows) {
		const variant = variants.find((v) => (row.variantId ? v.id === row.variantId : v.sku === row.sku));
		if (!variant) {
			failed.push({
				line: row.line,
				path: row.variantId ? '/variant_id' : '/sku',
				message: 'There is no such variant.',
				code: 'unknown_variant',
			});
			continue;
		}
		const before = JSON.stringify([variant.price, variant.stock, variant.locations, variant.soldOut]);
		if (row.price !== undefined) variant.price = row.price;
		if (row.stock !== undefined) variant.stock = row.stock;
		if (row.locations) {
			Object.assign(variant.locations, row.locations);
			variant.stock = Object.values(variant.locations).reduce((a, b) => a + b, 0);
		}
		if (row.soldOut !== undefined) variant.soldOut = row.soldOut;
		if (JSON.stringify([variant.price, variant.stock, variant.locations, variant.soldOut]) !== before) changed += 1;
	}
	return { variants, changed, failed };
};
