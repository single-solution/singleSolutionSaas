/**
 * The catalog's admin tools (PLAN 0.8.8 Admin tools, Catalog SEO): CSV export of products and stock, of orders (one
 * row per line, or per order, with the order list's filters, E36) and of customers (E36), CSV import of products (a dry
 * run lists every row's problems first) and price and stock updates by CSV (E36 `mode=update`: stale rows fail, the
 * rest are changed), bulk actions on many products, and AI copy (suggestions written with the merchant's own AI key,
 * never saved by themselves). Each route exists for the merchant's server and for the admin widgets (ticket:
 * `csv.run`, `bulk.run`, `catalog.edit`).
 * @module
 */
import { createId } from '@ss/contracts';
import { defineRoute, problem } from '@ss/app-kit';
import {
	NO_ID,
	attributesOf,
	brandsOf,
	categoriesOf,
	freeSlugIn,
	locationsOf,
	productsByIds,
	rewriteProduct,
	stockedUnits,
} from '../adapters/catalog-store.js';
import { LIMITS, changedPrice, changedStock, checkPriceChange, checkProduct, productType, summarize } from '../core/catalog.js';
import { checkTags } from '../core/customer-segments.js';
import { fieldApplies } from '../core/fields.js';
import { typeByKey } from '../core/item-types.js';
import { sameMeaning } from '../core/measure.js';
import { aiPrompt, checkAiRequest, readSuggestions } from '../core/catalog-ai.js';
import {
	CUSTOMER_COLUMNS,
	FIELD_COLUMN,
	MAX_IMPORT_ROWS,
	ORDER_COLUMNS,
	ORDER_TOTAL_COLUMNS,
	customerRows,
	fieldColumns,
	fieldHeader,
	importGroups,
	importInput,
	orderRows,
	orderTotalRows,
	productHeader,
	productRows,
	updateRows,
	updatedVariants,
} from '../core/catalog-csv.js';
import { parseCsv, recordsOf, toCsv } from '../core/csv.js';
import { specsOf } from '../core/catalog-views.js';
import { typeOf, typeTree } from '../core/item-types.js';
import { nextPreviousSlugs } from '../core/links.js';
import { COLLECTIONS, ID_PREFIX } from '../core/model.js';
import { orderFilters, orderQuery } from '../core/orders.js';
import { phoneSearchOf } from '../core/guests.js';
import { createFulfilmentStore } from '../adapters/fulfilment-store.js';
import { bodyOf, refuse, STAFF_LIMITS } from './catalog-common.js';
import { phoneRulesOf } from './guests.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./catalog-common.js').CatalogCommon} CatalogCommon */
/** @typedef {import('../core/model.js').ProductRecord} ProductRecord */
/** @typedef {import('../core/model.js').OrderRecord} OrderRecord */
/** @typedef {import('../core/model.js').VariantRecord} VariantRecord */
/** @typedef {import('../core/catalog-csv.js').RowProblem} RowProblem */
/** @typedef {import('../core/catalog-csv.js').ImportGroup} ImportGroup */
/** @typedef {import('../core/catalog-csv.js').UpdateRow} UpdateRow */
/** @typedef {{ stale: UpdateRow[], next: ReturnType<typeof updatedVariants> }} UpdateOutcome */
/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */

/** Most products of an export, of orders and of customers. */
const MAX_EXPORT_PRODUCTS = 20_000;
const MAX_EXPORT_ORDERS = 10_000;
const MAX_EXPORT_CUSTOMERS = 20_000;
/** Most products of one bulk action. */
const MAX_BULK = 500;
/** Largest import body. */
const IMPORT_BYTES = 8 * 1024 * 1024;

const BULK_ACTIONS = Object.freeze([
	'status',
	'price',
	'stock',
	'add_category',
	'remove_category',
	'brand',
	'add_tags',
	'remove_tags',
	'item_type',
	'compare_at_price',
	'field',
]);
/** Bulk actions whose change is checked like an API change of the product (E23). */
const CHECKED_ACTIONS = Object.freeze(['brand', 'add_tags', 'remove_tags', 'item_type', 'compare_at_price', 'field']);

/** Where the product check names a field value: `/specs/<id>` or `/variants/<n>/attributes/<id>`. */
const FIELD_PATH = /^\/(?:specs|variants\/(\d+)\/attributes)\/([^/]+)$/;

/**
 * A CSV file answer.
 * @param {string} name @param {string} csv
 */
export const csvFile = (name, csv) =>
	new Response(csv, {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="${name}"`,
			'cache-control': 'no-store',
		},
	});

/**
 * @param {Product} product
 * @param {Service} service
 * @param {CatalogCommon} common
 */
export const createCatalogTools = (product, service, common) => {
	const { now } = product;

	/** @param {Site} s */
	const delimiterOf = async (s) => ((await s.values('csv')).delimiter === ';' ? ';' : ',');

	/**
	 * The field columns of the fields on `on` (E22), inactive ones too (their values stay readable).
	 * @param {WebsiteData} data @param {ReadonlyArray<import('../core/model.js').AttributeRecord['on']>} on
	 */
	const columnsOn = async (data, on) => fieldColumns(await attributesOf(data), on);

	// ------------------------------------------------------------------------------------------------- export

	/** GET …/csv/products. @param {any} ctx */
	const exportProducts = async (ctx) => {
		const { s, data } = await common.open(ctx);
		const products = /** @type {ProductRecord[]} */ (
			await data
				.collection(COLLECTIONS.products)
				.find({ websiteId: data.websiteId }, NO_ID)
				.sort({ createdAt: 1, id: 1 })
				.limit(MAX_EXPORT_PRODUCTS)
				.toArray()
		);
		const [categories, brands, locations, fields] = await Promise.all([
			categoriesOf(data),
			brandsOf(data),
			locationsOf(data),
			columnsOn(data, ['product', 'variant']),
		]);
		const locationIds = s.has('multi_location') ? locations.map((location) => location.id) : [];
		const measured = await measuredOf(s, categories);
		const rows = productRows(products, {
			currency: s.currency,
			categorySlugs: new Map(categories.map((c) => [c.id, c.slug])),
			brandSlugs: new Map(brands.map((b) => [b.id, b.slug])),
			locationIds,
			measured,
			fields,
			categories: new Map(categories.map((c) => [c.id, c])),
		});
		await service.log(ctx, 'csv.products_exported', 'products', {
			label: 'products.csv',
			detail: `${products.length} products`,
		});
		return csvFile('products.csv', toCsv(productHeader(locationIds, fields), rows, { delimiter: await delimiterOf(s) }));
	};

	/**
	 * GET …/csv/orders with the order list's filters (status, role, paymentState, paymentMethod, from, to, q): one row
	 * per order line, or per order with `per=order` (E36).
	 * @param {any} ctx
	 */
	const exportOrders = async (ctx) => {
		const per = ctx.query.per ?? '';
		if (!['', 'line', 'order'].includes(per)) throw refuse([{ path: '/per', message: 'Per is line or order.' }]);
		const filters = orderFilters(ctx.query);
		if (!filters.ok) throw refuse([{ path: `/${filters.field}`, message: filters.message }]);
		const { s, data } = await common.open(ctx);
		if (filters.value.q) filters.value.phoneDigits = phoneSearchOf(filters.value.q, await phoneRulesOf(s));
		const filter = { websiteId: data.websiteId, ...orderQuery(filters.value) };
		const orders = data.collection(COLLECTIONS.orders);
		if ((await orders.countDocuments(filter, { limit: MAX_EXPORT_ORDERS + 1 })) > MAX_EXPORT_ORDERS)
			throw refuse([{ path: '/from', message: `More than ${MAX_EXPORT_ORDERS} orders: choose shorter dates.` }]);
		const found = /** @type {OrderRecord[]} */ (await orders.find(filter, NO_ID).sort({ placedAt: 1, id: 1 }).toArray());
		const fields = await columnsOn(data, ['order']);
		await service.log(ctx, 'csv.orders_exported', 'orders', { label: 'orders.csv', detail: `${found.length} orders` });
		const delimiter = await delimiterOf(s);
		return csvFile(
			'orders.csv',
			per === 'order'
				? toCsv([...ORDER_TOTAL_COLUMNS, ...fieldHeader(fields)], orderTotalRows(found, fields), { delimiter })
				: toCsv([...ORDER_COLUMNS, ...fieldHeader(fields)], orderRows(found, fields), { delimiter }),
		);
	};

	/** GET …/csv/customers (E36): every customer record, A to Z, with their orders and what they spent. @param {any} ctx */
	const exportCustomers = async (ctx) => {
		const { s, data } = await common.open(ctx);
		const customers = /** @type {import('../core/model.js').CustomerRecord[]} */ (
			await data
				.collection(COLLECTIONS.customers)
				.find({ websiteId: data.websiteId }, NO_ID)
				.sort({ name: 1, userId: 1 })
				.limit(MAX_EXPORT_CUSTOMERS)
				.toArray()
		);
		const [spent, fields] = await Promise.all([
			createFulfilmentStore(data).orders.spent(customers),
			columnsOn(data, ['customer']),
		]);
		await service.log(ctx, 'csv.customers_exported', 'customers', {
			label: 'customers.csv',
			detail: `${customers.length} customers`,
		});
		return csvFile(
			'customers.csv',
			toCsv([...CUSTOMER_COLUMNS, ...fieldHeader(fields)], customerRows(customers, spent, s.currency, fields), {
				delimiter: await delimiterOf(s),
			}),
		);
	};

	// ------------------------------------------------------------------------------------------------- import

	/**
	 * Whether a product is sold in a unit of its own (its item type's measure, whatever the feature: its stock is counted
	 * in it), so CSV files give its stock in units.
	 * @param {Site} s @param {Array<{ id: string, path?: string[], typeKey?: string | null }>} categories
	 * @returns {Promise<(product: { kind: string, typeKey?: string | null, categoryIds: ReadonlyArray<string> }) => boolean>}
	 */
	const measuredOf = async (s, categories) => {
		const types = await s.list('item_types');
		const tree = typeTree(categories);
		return (product) => Boolean(typeOf(product, types, tree).elements.measure);
	};

	/**
	 * Plan an import: every product of the file found or new, checked like an API change; the product check's refusals of
	 * values the file's field columns give are reported at their column (E22).
	 * @param {Site} s @param {WebsiteData} data @param {ImportGroup[]} groups
	 * @param {ReadonlyArray<import('../core/catalog-csv.js').FieldColumn>} fields the product and variant field columns
	 */
	const plan = async (s, data, groups, fields) => {
		const rules = await common.rulesOf(s, data);
		const [categories, brands] = await Promise.all([categoriesOf(data), brandsOf(data)]);
		const measured = await measuredOf(s, categories);
		const categoryById = new Map(categories.map((c) => [c.id, c]));
		/** @type {Map<string, string>} */
		const categoryIds = new Map();
		for (const c of categories) categoryIds.set(c.id, c.id).set(c.slug, c.id);
		/** @type {Map<string, string>} */
		const brandIds = new Map();
		for (const b of brands) brandIds.set(b.id, b.id).set(b.slug, b.id).set(b.name.toLowerCase(), b.id);
		const index = await data
			.collection(COLLECTIONS.products)
			.find({ websiteId: data.websiteId }, { projection: { _id: 0, id: 1, slug: 1, 'variants.sku': 1 } })
			.toArray();
		/** @type {Map<string, string>} */
		const bySku = new Map();
		/** @type {Map<string, string>} */
		const bySlug = new Map();
		for (const row of index) {
			bySlug.set(String(row.slug), String(row.id));
			for (const variant of row.variants) if (variant.sku) bySku.set(String(variant.sku), String(row.id));
		}
		const ids = new Set(index.map((row) => String(row.id)));
		/** @type {RowProblem[]} */
		const errors = [];
		/** @type {Array<{ group: ImportGroup, id: string | null, input: Record<string, any>, stock: Map<string, { stock?: number, locations?: Record<string, number> }>, fields: import('../core/catalog.js').ProductFields }>} */
		const plans = [];
		/** @type {Map<string, string>} sku → group key */
		const fileSkus = new Map();
		/** @type {Map<string, ProductRecord>} */
		const existing = new Map(
			(
				await productsByIds(
					data,
					[
						...new Set(
							groups.map((g) => g.productId ?? g.skus.map((sku) => bySku.get(sku)).find(Boolean) ?? bySlug.get(g.slug)),
						),
					].filter((id) => typeof id === 'string'),
				)
			).map((p) => [p.id, p]),
		);
		/** @type {Array<{ group: ImportGroup, id: string | null }>} */
		const resolved = [];
		for (const group of groups) {
			/** @param {string} path @param {RowProblem['code']} code @param {string} message @param {Record<string, string>} [values] */
			const fail = (path, code, message, values) =>
				errors.push({ line: group.line, path, message, code, ...(values ? { values } : {}) });
			const owners = new Set(group.skus.map((sku) => bySku.get(sku)).filter(Boolean));
			/** @type {string | null} */
			let id = group.productId;
			if (id && !ids.has(id)) {
				fail('/product_id', 'unknown_product', 'There is no such product.');
				continue;
			}
			if (!id && owners.size > 1) {
				fail('/sku', 'skus_of_two', 'These SKUs belong to different products.');
				continue;
			}
			id ??= /** @type {string | undefined} */ ([...owners][0]) ?? bySlug.get(group.slug) ?? null;
			for (const sku of group.skus) {
				const owner = bySku.get(sku);
				if (owner && owner !== id) fail('/sku', 'sku_taken', `Another product already uses the SKU ${sku}.`, { sku });
				if (fileSkus.has(sku) && fileSkus.get(sku) !== group.key)
					fail('/sku', 'sku_twice', `The SKU ${sku} is in two products of the file.`, { sku });
				fileSkus.set(sku, group.key);
			}
			// rows of one product (say, one row per SKU) make one product
			const known = id === null ? undefined : resolved.find((entry) => entry.id === id);
			if (known)
				known.group = {
					...known.group,
					skus: [...known.group.skus, ...group.skus],
					rows: [...known.group.rows, ...group.rows],
				};
			else resolved.push({ group, id });
		}
		for (const { group, id } of resolved) {
			/** @param {string} path @param {RowProblem['code']} code @param {string} message @param {Record<string, string>} [values] */
			const fail = (path, code, message, values) =>
				errors.push({ line: group.line, path, message, code, ...(values ? { values } : {}) });
			const before = id ? (existing.get(id) ?? null) : null;
			const built = importInput(group, before, {
				categoryIds,
				brandIds,
				fields,
				categories: categoryById,
				// the product as the file gives it, over what it was: its item type says whether it is measured
				measured: (input) =>
					measured({
						kind: input.kind ?? before?.kind ?? 'physical',
						typeKey: input.typeKey === undefined ? (before?.typeKey ?? null) : input.typeKey,
						categoryIds: input.categoryIds ?? before?.categoryIds ?? [],
					}),
			});
			if (!built.ok) {
				errors.push(...built.errors);
				continue;
			}
			errors.push(...built.problems);
			const checked = checkProduct(built.input, rules, before);
			if (!checked.ok) {
				for (const error of checked.errors) {
					const match = FIELD_PATH.exec(error.path);
					const field = match ? rules.attributes.get(String(match[2])) : undefined;
					if (match && field && built.given.has(field.id))
						errors.push({
							line: match[1] === undefined ? group.line : (built.lines[Number(match[1])] ?? group.line),
							path: `/${FIELD_COLUMN}${field.slug}`,
							message: error.message,
							code: 'field_value',
							values: { field: field.slug },
						});
					else fail(error.path, 'invalid', error.message);
				}
				continue;
			}
			if (built.problems.length > 0) continue;
			if (rules.locations)
				for (const [variantId, units] of built.stock)
					if (units.stock !== undefined && !units.locations)
						fail('/stock', 'stock_per_location', `Give the stock of variant ${variantId} per location (stock@ columns).`);
			const slug = checked.value.slug;
			if (slug && bySlug.has(slug) && bySlug.get(slug) !== id)
				fail('/slug', 'slug_taken', 'Another product already uses this slug.');
			plans.push({ group, id: before ? before.id : null, input: built.input, stock: built.stock, fields: checked.value });
		}
		return { rules, plans, errors };
	};

	/**
	 * Price and stock updates (E36 `mode=update`): each row's variant gets its price, stock and sold-out flag, unless the
	 * row's `updated_at` is older than its product's (someone changed the product since the export) or the row is
	 * not valid; those rows are reported as failed and the rest are changed. A dry run changes nothing.
	 * @param {any} ctx @param {Site} s @param {WebsiteData} data @param {string[][]} table @param {boolean} dryRun
	 */
	const updateProducts = async (ctx, s, data, table, dryRun) => {
		const locationIds = s.has('multi_location') ? (await locationsOf(data)).map((location) => location.id) : [];
		const read = updateRows(recordsOf(table), { currency: s.currency, locationIds: new Set(locationIds) });
		if (!read.ok) throw refuse([{ path: '/csv', message: read.message }]);
		const measured = await measuredOf(s, await categoriesOf(data));
		const failed = [...read.failed];
		/** @param {UpdateRow} row @param {string} path @param {RowProblem['code']} code @param {string} message */
		const fail = (row, path, code, message) => void failed.push({ line: row.line, path, message, code });
		// the product of each row, by its variant id, else its SKU
		const found =
			/** @type {Array<{ id: string, kind: string, typeKey?: string | null, categoryIds: string[],
			 *   variants: Array<{ id: string, sku: string }> }>} */ (
				read.rows.length === 0
					? []
					: await data
							.collection(COLLECTIONS.products)
							.find(
								{
									websiteId: data.websiteId,
									$or: [
										{ 'variants.id': { $in: read.rows.map((row) => row.variantId).filter(Boolean) } },
										{ 'variants.sku': { $in: read.rows.map((row) => row.sku).filter(Boolean) } },
									],
								},
								{
									projection: {
										_id: 0,
										id: 1,
										kind: 1,
										typeKey: 1,
										categoryIds: 1,
										'variants.id': 1,
										'variants.sku': 1,
									},
								},
							)
							.toArray()
			);
		/** @type {Map<string, string>} */
		const byVariant = new Map();
		/** @type {Map<string, string[]>} */
		const bySku = new Map();
		for (const item of found)
			for (const variant of item.variants) {
				byVariant.set(variant.id, item.id);
				if (variant.sku) bySku.set(variant.sku, [...(bySku.get(variant.sku) ?? []), item.id]);
			}
		/** @type {Map<string, UpdateRow[]>} product id → its rows */
		const groups = new Map();
		for (const row of read.rows) {
			const owners = row.variantId ? [byVariant.get(row.variantId)].filter(Boolean) : (bySku.get(row.sku ?? '') ?? []);
			if (owners.length !== 1) {
				const path = row.variantId ? '/variant_id' : '/sku';
				if (owners.length > 1) fail(row, path, 'sku_ambiguous', 'More than one product has this SKU: use variant_id.');
				else fail(row, path, 'unknown_variant', 'There is no such variant.');
				continue;
			}
			const productId = /** @type {string} */ (owners[0]);
			if (row.productId && row.productId !== productId) {
				fail(row, '/product_id', 'not_its_variant', 'This variant is not part of the product.');
				continue;
			}
			groups.set(productId, [...(groups.get(productId) ?? []), row]);
		}
		/** @type {ProductRecord[]} */
		const before = [];
		/** @type {string[]} */
		const written = [];
		let updated = 0;
		for (const [id, rows] of groups) {
			// a retried transaction runs the change again: what it found is kept from its last run only
			const done = await rewriteProduct(
				data,
				id,
				/** @returns {Promise<{ set: Record<string, unknown>, result: UpdateOutcome } | { refuse: UpdateOutcome }>} */
				async (current) => {
					const at = new Date(current.updatedAt).getTime();
					const next = updatedVariants(
						current,
						rows.filter((row) => row.updatedAt >= at),
						measured(current),
					);
					const outcome = { stale: rows.filter((row) => row.updatedAt < at), next };
					return next.changed > 0 && !dryRun ? { set: { variants: next.variants }, result: outcome } : { refuse: outcome };
				},
				{ now: now() },
			);
			if (!done.found) {
				for (const row of rows) fail(row, '/variant_id', 'unknown_variant', 'There is no such variant.');
				continue;
			}
			for (const row of done.result.stale)
				fail(row, '/updated_at', 'stale', 'The product changed after this file was exported: export it again.');
			failed.push(...done.result.next.failed);
			updated += done.result.next.changed;
			if (done.changed) {
				before.push(done.before);
				written.push(id);
			}
		}
		failed.sort((a, b) => a.line - b.line);
		if (!dryRun) {
			await service.log(ctx, 'csv.products_updated', `${written.length} products`, {
				label: `${written.length} products`,
				detail: `${updated} variants changed, ${failed.length} rows failed`,
			});
			await common.changed(s, before, written);
		}
		return { dryRun, mode: 'update', rows: table.length - 1, updated, failed };
	};

	/** POST …/csv/products `{ csv, dryRun }` (`?mode=update`: price and stock updates, E36). @param {any} ctx */
	const importProducts = async (ctx) => {
		const mode = ctx.query.mode ?? '';
		if (!['', 'import', 'update'].includes(mode)) throw refuse([{ path: '/mode', message: 'The mode is import or update.' }]);
		const body = bodyOf(ctx);
		if (typeof body.csv !== 'string' || body.csv.trim() === '') throw refuse([{ path: '/csv', message: 'Send the CSV text.' }]);
		const dryRun = body.dryRun !== false;
		const { s, data } = await common.open(ctx);
		const parsed = parseCsv(body.csv, { delimiter: await delimiterOf(s), maxRows: MAX_IMPORT_ROWS });
		if (!parsed.ok)
			throw refuse([
				{
					path: '/csv',
					message: {
						too_many_rows: `A file has at most ${MAX_IMPORT_ROWS} rows.`,
						unterminated_quote: 'A quoted cell is not closed.',
						empty: 'The file is empty.',
					}[parsed.code],
				},
			]);
		if (mode === 'update') return updateProducts(ctx, s, data, parsed.rows, dryRun);
		const locationIds = s.has('multi_location') ? (await locationsOf(data)).map((location) => location.id) : [];
		const fields = await columnsOn(data, ['product', 'variant']);
		const read = importGroups(recordsOf(parsed.rows), {
			currency: s.currency,
			locationIds: new Set(locationIds),
			fieldSlugs: new Set(fields.map((column) => column.slug)),
		});
		const planned = read.errors.some((error) => error.line === 1) ? null : await plan(s, data, read.groups, fields);
		const errors = [...read.errors, ...(planned?.errors ?? [])].sort((a, b) => a.line - b.line);
		const creating = planned?.plans.filter((p) => p.id === null).length ?? 0;
		const updating = planned?.plans.filter((p) => p.id !== null).length ?? 0;
		if (dryRun) return { dryRun: true, rows: parsed.rows.length - 1, created: creating, updated: updating, errors };
		if (errors.length > 0 || !planned)
			throw problem('validation_failed', `${errors.length} problems in the file: nothing was imported.`, {
				errors: errors.map((error) => ({ path: `/csv/${error.line}${error.path}`, message: error.message, code: 'invalid' })),
			});
		/** @type {ProductRecord[]} */
		const before = [];
		/** @type {string[]} */
		const written = [];
		for (const item of planned.plans) {
			if (item.id === null) {
				const fields = item.fields;
				const id = createId(ID_PREFIX.product);
				const slug =
					fields.slug ||
					(await freeSlugIn(data, COLLECTIONS.products, {
						slug: '',
						name: fields.name,
						fallback: id.slice(4).toLowerCase(),
					}));
				await data.collection(COLLECTIONS.products).insertOne({
					id,
					...fields,
					slug,
					media: [],
					sold: 0,
					ordered: 0,
					rating: { average: 0, count: 0 },
					...summarize(fields.variants, fields.trackStock),
					previousSlugs: [],
					publishedAt: fields.status === 'active' ? new Date(now()) : null,
					contentUpdatedAt: new Date(now()),
				});
				written.push(id);
				continue;
			}
			const done = await rewriteProduct(
				data,
				item.id,
				async (current) => {
					const checked = checkProduct(item.input, planned.rules, current);
					if (!checked.ok) throw refuse(checked.errors);
					const variants = checked.value.variants.map((variant) => {
						const units = item.stock.get(variant.id);
						if (!units) return variant;
						if (units.locations) {
							const locations = { ...variant.locations, ...units.locations };
							return { ...variant, locations, stock: Object.values(locations).reduce((a, b) => a + b, 0) };
						}
						return { ...variant, stock: units.stock ?? variant.stock };
					});
					const slug =
						checked.value.slug ||
						(await freeSlugIn(data, COLLECTIONS.products, {
							slug: '',
							name: checked.value.name,
							exceptId: current.id,
							fallback: current.id.slice(4).toLowerCase(),
						}));
					// a changed slug is kept as an earlier one, as an edit keeps it (E13)
					const previousSlugs = nextPreviousSlugs(current.previousSlugs, current.slug, slug);
					return { set: { ...checked.value, slug, variants, previousSlugs }, result: null };
				},
				{ now: now() },
			);
			if (done.found) {
				before.push(done.before);
				written.push(item.id);
			}
		}
		await service.log(ctx, 'csv.products_imported', `${written.length} products`, {
			label: `${written.length} products`,
			detail: `${creating} created, ${updating} updated`,
		});
		await common.changed(s, before, written);
		return { dryRun: false, rows: parsed.rows.length - 1, created: creating, updated: updating, errors: [] };
	};

	// ---------------------------------------------------------------------------------------------------- bulk

	/**
	 * The API change a checked bulk action (E23) makes to one product (null: nothing to change), and what the product's
	 * own check then says: brand `{ brandId }` (null: none), tags added or removed `{ tags }`, item type `{ typeKey }`
	 * (null: its category's), the compare-at price of every variant `{ compareAt: { mode: set, value } | { mode: clear }
	 * | { mode: percent, value } }` (percent above its price) and any product or variant field `{ field, value }` (its
	 * id, or its slug: the field defined for the product's category, else the one for every category; null clears it).
	 * @param {string} action @param {Record<string, any>} body
	 * @param {import('../core/catalog.js').CatalogRules} rules
	 * @returns {(item: ProductRecord) => Record<string, unknown> | null}
	 */
	const checkedChange = (action, body, rules) => {
		if (action === 'brand') {
			const brandId = body.brandId === null || body.brandId === '' ? null : body.brandId;
			if (brandId !== null && (typeof brandId !== 'string' || !rules.brandIds.has(brandId)))
				throw refuse([{ path: '/brandId', message: 'Pick an existing brand, or null for none.' }]);
			return (item) => (item.brandId === brandId ? null : { brandId });
		}
		if (action === 'add_tags' || action === 'remove_tags') {
			const tags = checkTags(body.tags);
			if (!tags.ok || tags.value.length === 0)
				throw refuse([{ path: '/tags', message: tags.ok ? 'Give tags.' : tags.message }]);
			return action === 'add_tags'
				? (item) => {
						const next = [...item.tags, ...tags.value.filter((tag) => !item.tags.includes(tag))];
						return next.length === item.tags.length ? null : { tags: next };
					}
				: (item) =>
						item.tags.some((tag) => tags.value.includes(tag))
							? { tags: item.tags.filter((tag) => !tags.value.includes(tag)) }
							: null;
		}
		if (action === 'item_type') {
			const typeKey = body.typeKey === null || body.typeKey === '' ? null : body.typeKey;
			if (typeKey !== null && (typeof typeKey !== 'string' || !typeByKey(typeKey, rules.types)))
				throw refuse([{ path: '/typeKey', message: 'Pick one of your item types, or null for the category’s.' }]);
			return (item) => ((item.typeKey ?? null) === typeKey ? null : { typeKey });
		}
		if (action === 'compare_at_price') {
			const compareAt = typeof body.compareAt === 'object' && body.compareAt !== null ? body.compareAt : {};
			const { mode, value } = compareAt;
			const amount = Number.isSafeInteger(value) && value >= 0;
			const percent = typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1000;
			if (!(mode === 'clear' || (mode === 'set' && amount) || (mode === 'percent' && percent)))
				throw refuse([
					{
						path: '/compareAt',
						message:
							'Give { mode: set, value } in minor units, { mode: percent, value } (above 0, up to 1000) or { mode: clear }.',
					},
				]);
			/** @param {VariantRecord} variant */
			const next = (variant) =>
				mode === 'clear' ? null : mode === 'set' ? value : Math.round((variant.price * (100 + value)) / 100);
			return (item) =>
				item.variants.every((variant) => (variant.compareAtPrice ?? null) === next(variant))
					? null
					: { variants: item.variants.map((variant) => ({ id: variant.id, compareAtPrice: next(variant) })) };
		}
		// any product or variant field
		const ref = typeof body.field === 'string' ? body.field : '';
		const byId = rules.attributes.get(ref);
		const named = (byId ? [byId] : [...rules.attributes.values()].filter((field) => field.slug === ref)).filter(
			(field) => field.on === 'product' || field.on === 'variant',
		);
		if (named.length === 0) throw refuse([{ path: '/field', message: 'Name a product or variant field by its id or slug.' }]);
		if (body.value === undefined) throw refuse([{ path: '/value', message: 'Give the value, or null to clear it.' }]);
		const value = body.value === '' ? null : body.value;
		/** @param {ProductRecord} item the field for the product: by its category, nearest first, else for every category */
		const fieldOf = (item) => {
			const lineage = item.categoryIds.flatMap((id) => [id, ...(rules.categoryPaths.get(id) ?? [])]);
			return (
				lineage.map((id) => named.find((field) => field.categoryId === id)).find(Boolean) ??
				named.find((field) => !field.categoryId && fieldApplies(field, lineage)) ??
				named.find((field) => !field.categoryId) ??
				null
			);
		};
		/** @param {Record<string, unknown>} values @param {string} id */
		const withValue = (values, id) => {
			const out = { ...values };
			if (value === null) delete out[id];
			else out[id] = value;
			return out;
		};
		return (item) => {
			const field = fieldOf(item);
			if (!field) return null;
			if (field.on === 'product') {
				const specs = withValue(item.specs ?? {}, field.id);
				return JSON.stringify(specs) === JSON.stringify(item.specs ?? {}) ? null : { specs };
			}
			return {
				variants: item.variants.map((variant) => ({
					id: variant.id,
					attributes: withValue(variant.attributes ?? {}, field.id),
				})),
			};
		};
	};

	/**
	 * POST …/products/bulk `{ ids, action, status | price | stock (+ locationId) | categoryId | brandId | tags | typeKey |
	 * compareAt | field + value }`: `refused` lists the products the product's own check refused a change (E23), with why.
	 * @param {any} ctx
	 */
	const bulk = async (ctx) => {
		const body = bodyOf(ctx);
		const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter((id) => typeof id === 'string'))] : [];
		if (ids.length === 0 || ids.length > MAX_BULK || ids.length !== body.ids.length)
			throw refuse([{ path: '/ids', message: `Give 1 to ${MAX_BULK} different product ids.` }]);
		const action = String(body.action ?? '');
		if (!BULK_ACTIONS.includes(action))
			throw refuse([{ path: '/action', message: `The action is one of ${BULK_ACTIONS.join(', ')}.` }]);
		const { s, data } = await common.open(ctx);
		/** @type {(product: ProductRecord) => Record<string, unknown> | null} null = nothing to change */
		let change;
		/** @type {Array<{ id: string, path: string, message: string }>} */
		const refused = [];
		if (CHECKED_ACTIONS.includes(action)) {
			const rules = await common.rulesOf(s, data);
			const input = checkedChange(action, body, rules);
			const stocked = action === 'item_type' ? await stockedUnits(data, ids) : new Set();
			change = (item) => {
				const given = input(item);
				if (!given) return null;
				const checked = checkProduct(given, rules, item);
				const fail = (/** @type {string} */ path, /** @type {string} */ message) => {
					refused.push({ id: item.id, path, message });
					return null;
				};
				if (!checked.ok) return fail(checked.errors[0]?.path ?? '', checked.errors[0]?.message ?? 'Refused.');
				if (action === 'item_type') {
					// units in stock were numbered by its item type, and its stock is counted in its type's unit of measure
					const [before, after] = [productType(item, rules), productType(checked.value, rules)];
					if (before.key !== after.key && stocked.has(item.id))
						return fail(
							'/typeKey',
							'This product has units in stock: its item type cannot change until they are sold or removed.',
						);
					if (!sameMeaning(before.elements.measure, after.elements.measure) && item.variants.some((v) => v.stock > 0))
						return fail(
							'/typeKey',
							'This product has stock counted in its unit of measure: its item type cannot change how it is measured until its stock is 0.',
						);
				}
				return Object.fromEntries(Object.keys(given).map((key) => [key, /** @type {any} */ (checked.value)[key]]));
			};
		} else if (action === 'status') {
			if (!['draft', 'active', 'archived'].includes(body.status))
				throw refuse([{ path: '/status', message: 'Status is draft, active or archived.' }]);
			// a draft without variants (an imported shell, CA-2) stays off sale until it has one
			change = (item) =>
				item.status === body.status || (body.status === 'active' && item.variants.length === 0)
					? null
					: { status: body.status };
		} else if (action === 'price') {
			const price = checkPriceChange(body.price);
			if (!price)
				throw refuse([
					{
						path: '/price',
						message: 'Give { mode: percent, value } (−100 to 1000) or { mode: fixed, value } in minor units.',
					},
				]);
			change = (item) => ({
				variants: item.variants.map((variant) => ({ ...variant, price: changedPrice(variant.price, price) })),
			});
		} else if (action === 'stock') {
			if (!Number.isSafeInteger(body.stock) || body.stock < 0 || body.stock > LIMITS.stock)
				throw refuse([{ path: '/stock', message: 'Stock is a whole number from 0.' }]);
			const locationId = typeof body.locationId === 'string' && body.locationId ? body.locationId : null;
			if (s.has('multi_location')) {
				if (
					!locationId ||
					!(await data.collection(COLLECTIONS.locations).findOne({ websiteId: data.websiteId, id: locationId }))
				)
					throw refuse([{ path: '/locationId', message: 'Name an existing location.' }]);
			} else if (locationId) throw refuse([{ path: '/locationId', message: 'Switch on Multi-location stock first.' }]);
			change = (item) => ({
				variants: item.variants.map((variant) => ({
					...variant,
					.../** @type {object} */ (
						changedStock({ stock: variant.stock, locations: variant.locations ?? {} }, { set: body.stock, locationId })
					),
				})),
			});
		} else {
			const categoryId = String(body.categoryId ?? '');
			if (!(await data.collection(COLLECTIONS.categories).findOne({ websiteId: data.websiteId, id: categoryId })))
				throw refuse([{ path: '/categoryId', message: 'Pick an existing category.' }]);
			change =
				action === 'add_category'
					? (item) =>
							item.categoryIds.includes(categoryId) || item.categoryIds.length >= LIMITS.categories
								? null
								: { categoryIds: [...item.categoryIds, categoryId] }
					: (item) =>
							item.categoryIds.includes(categoryId)
								? { categoryIds: item.categoryIds.filter((id) => id !== categoryId) }
								: null;
		}
		/** @type {ProductRecord[]} */
		const before = [];
		/** @type {string[]} */
		const missing = [];
		let changed = 0;
		for (const id of ids) {
			const done = await rewriteProduct(
				data,
				id,
				async (item) => {
					const set = change(item);
					return set ? { set, result: null } : { refuse: null };
				},
				{ now: now() },
			);
			if (!done.found) missing.push(id);
			else if (done.changed) {
				changed += 1;
				before.push(done.before);
			}
		}
		await service.log(ctx, `products.bulk_${action}`, `${changed} products`, {
			label: `${changed} products`,
			detail: `${action.replace('_', ' ')}: ${changed} of ${ids.length} changed`,
		});
		await common.changed(s, before);
		// a product's change is tried again when its transaction is: each product is listed once
		const once = [...new Map(refused.map((entry) => [entry.id, entry])).values()];
		return { matched: ids.length - missing.length, changed, missing, refused: once };
	};

	// ------------------------------------------------------------------------------------------------- AI copy

	/** POST …/products/:id/ai-copy `{ fields, tone?, language? }` → `{ suggestions }`. @param {any} ctx */
	const aiCopy = async (ctx) => {
		const request = checkAiRequest(ctx.body);
		if (!request.ok) throw refuse([{ path: request.path, message: request.message }]);
		const { s, data } = await common.open(ctx);
		const item = /** @type {ProductRecord | null} */ (
			await data.collection(COLLECTIONS.products).findOne({ websiteId: data.websiteId, id: String(ctx.params.id) }, NO_ID)
		);
		if (!item) throw problem('not_found', 'There is no such product.');
		const connection = await product.connections.value(s.websiteId, 'ai');
		if (!connection) throw problem('ai_not_connected', 'Connect your AI provider first (Connections).');
		const settings = await s.values('ai_copy');
		const [categories, attributes] = await Promise.all([categoriesOf(data), attributesOf(data)]);
		const brand = item.brandId
			? await data.collection(COLLECTIONS.brands).findOne({ websiteId: data.websiteId, id: item.brandId })
			: null;
		const { system, prompt } = aiPrompt(
			{
				name: item.name,
				summary: item.summary,
				description: item.description,
				brand: brand ? String(brand.name) : null,
				categories: categories.filter((c) => item.categoryIds.includes(c.id)).map((c) => c.name),
				specs: specsOf(item, new Map(attributes.map((a) => [a.id, a]))),
				options: item.options,
				kind: item.kind,
			},
			{
				fields: request.value.fields,
				tone: request.value.tone || String(settings.tone ?? ''),
				language: request.value.language || String(settings.language ?? ''),
				words: Number(settings.words ?? 150),
			},
		);
		const answer = await product.ai.write(connection, { system, prompt, maxTokens: 1500 });
		if (!answer.ok) {
			if (answer.code === 'not_connected')
				throw problem('ai_not_connected', 'The AI connection is incomplete: check Connections.');
			throw problem(
				'ai_failed',
				answer.code === 'rate_limited' ? 'The AI provider is busy: try again soon.' : 'The AI provider did not answer.',
			);
		}
		const suggestions = readSuggestions(answer.text, request.value.fields);
		if (!suggestions) throw problem('ai_failed', 'The AI provider gave no usable text.');
		return { suggestions };
	};

	return [
		// CSV
		defineRoute({
			method: 'GET',
			path: '/v1/csv/products',
			auth: 'server',
			feature: 'csv',
			rateLimit: STAFF_LIMITS,
			handler: exportProducts,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/csv/products',
			auth: 'server',
			feature: 'csv',
			maxBodyBytes: IMPORT_BYTES,
			rateLimit: STAFF_LIMITS,
			handler: importProducts,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/csv/orders',
			auth: 'server',
			feature: 'csv',
			rateLimit: STAFF_LIMITS,
			handler: exportOrders,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/csv/customers',
			auth: 'server',
			feature: 'csv',
			rateLimit: STAFF_LIMITS,
			handler: exportCustomers,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/csv/products',
			auth: 'ticket',
			permission: 'csv.run',
			rateLimit: STAFF_LIMITS,
			handler: exportProducts,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/csv/products',
			auth: 'ticket',
			permission: 'csv.run',
			maxBodyBytes: IMPORT_BYTES,
			rateLimit: STAFF_LIMITS,
			handler: importProducts,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/csv/orders',
			auth: 'ticket',
			permission: 'csv.run',
			rateLimit: STAFF_LIMITS,
			handler: exportOrders,
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/csv/customers',
			auth: 'ticket',
			permission: 'csv.run',
			rateLimit: STAFF_LIMITS,
			handler: exportCustomers,
		}),

		// bulk actions
		defineRoute({
			method: 'POST',
			path: '/v1/products/bulk',
			auth: 'server',
			feature: 'bulk_actions',
			rateLimit: STAFF_LIMITS,
			handler: bulk,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/products/bulk',
			auth: 'ticket',
			permission: 'bulk.run',
			rateLimit: STAFF_LIMITS,
			handler: bulk,
		}),

		// AI copy
		defineRoute({
			method: 'POST',
			path: '/v1/products/:id/ai-copy',
			auth: 'server',
			feature: 'ai_copy',
			rateLimit: STAFF_LIMITS,
			handler: aiCopy,
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/products/:id/ai-copy',
			auth: 'ticket',
			feature: 'ai_copy',
			permission: 'catalog.edit',
			rateLimit: STAFF_LIMITS,
			handler: aiCopy,
		}),
	];
};
