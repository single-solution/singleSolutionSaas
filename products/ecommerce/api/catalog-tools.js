/**
 * The catalog's admin tools (PLAN 0.8.8 Admin tools, Catalog SEO): CSV export of products and stock and of orders,
 * CSV import of products (a dry run lists every row's problems first), bulk actions on many products, and AI copy
 * (suggestions written with the merchant's own AI key, never saved by themselves). Each route exists for the
 * merchant's server and for the admin widgets (ticket: `csv.run`, `bulk.run`, `catalog.edit`).
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
} from '../adapters/catalog-store.js';
import { LIMITS, changedPrice, changedStock, checkPriceChange, checkProduct, summarize } from '../core/catalog.js';
import { aiPrompt, checkAiRequest, readSuggestions } from '../core/catalog-ai.js';
import {
	MAX_IMPORT_ROWS,
	ORDER_COLUMNS,
	importGroups,
	importInput,
	orderRows,
	productHeader,
	productRows,
} from '../core/catalog-csv.js';
import { parseCsv, recordsOf, toCsv } from '../core/csv.js';
import { specsOf } from '../core/catalog-views.js';
import { COLLECTIONS, ID_PREFIX } from '../core/model.js';
import { bodyOf, refuse, STAFF_LIMITS } from './catalog-common.js';

/** @typedef {import('../adapters/product.js').Product} Product */
/** @typedef {import('./service.js').Service} Service */
/** @typedef {import('./service.js').Site} Site */
/** @typedef {import('./catalog-common.js').CatalogCommon} CatalogCommon */
/** @typedef {import('../core/model.js').ProductRecord} ProductRecord */
/** @typedef {import('../core/model.js').OrderRecord} OrderRecord */
/** @typedef {import('../core/catalog.js').FieldError} FieldError */
/** @typedef {import('../core/catalog-csv.js').ImportGroup} ImportGroup */
/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */

/** Most products of an export, and of orders. */
export const MAX_EXPORT_PRODUCTS = 20_000;
export const MAX_EXPORT_ORDERS = 10_000;
/** Most products of one bulk action. */
export const MAX_BULK = 500;
/** Largest import body. */
const IMPORT_BYTES = 8 * 1024 * 1024;

const BULK_ACTIONS = Object.freeze(['status', 'price', 'stock', 'add_category', 'remove_category']);

/**
 * A CSV file answer.
 * @param {string} name @param {string} csv
 */
const csvFile = (name, csv) =>
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
		const [categories, brands, locations] = await Promise.all([categoriesOf(data), brandsOf(data), locationsOf(data)]);
		const locationIds = s.has('multi_location') ? locations.map((location) => location.id) : [];
		const rows = productRows(products, {
			currency: s.currency,
			categorySlugs: new Map(categories.map((c) => [c.id, c.slug])),
			brandSlugs: new Map(brands.map((b) => [b.id, b.slug])),
			locationIds,
		});
		await service.log(ctx, 'csv.products_exported', 'products');
		return csvFile('products.csv', toCsv(productHeader(locationIds), rows, { delimiter: await delimiterOf(s) }));
	};

	/** GET …/csv/orders?from=&to=&status=. @param {any} ctx */
	const exportOrders = async (ctx) => {
		const { s, data } = await common.open(ctx);
		/** @type {Record<string, unknown>} */
		const placedAt = {};
		for (const [name, op] of /** @type {const} */ ([
			['from', '$gte'],
			['to', '$lt'],
		])) {
			if (!ctx.query[name]) continue;
			const at = Date.parse(ctx.query[name]);
			if (!Number.isFinite(at)) throw refuse([{ path: `/${name}`, message: 'Give a date (ISO 8601).' }]);
			placedAt[op] = new Date(at);
		}
		/** @type {Record<string, unknown>} */
		const filter = { websiteId: data.websiteId, ...(Object.keys(placedAt).length > 0 ? { placedAt } : {}) };
		if (ctx.query.status) filter.status = String(ctx.query.status);
		const orders = data.collection(COLLECTIONS.orders);
		if ((await orders.countDocuments(filter, { limit: MAX_EXPORT_ORDERS + 1 })) > MAX_EXPORT_ORDERS)
			throw refuse([{ path: '/from', message: `More than ${MAX_EXPORT_ORDERS} orders: choose shorter dates.` }]);
		const found = /** @type {OrderRecord[]} */ (await orders.find(filter, NO_ID).sort({ placedAt: 1, id: 1 }).toArray());
		await service.log(ctx, 'csv.orders_exported', 'orders');
		return csvFile('orders.csv', toCsv(ORDER_COLUMNS, orderRows(found), { delimiter: await delimiterOf(s) }));
	};

	// ------------------------------------------------------------------------------------------------- import

	/**
	 * Plan an import: every product of the file found or new, checked like an API change.
	 * @param {Site} s @param {WebsiteData} data @param {ImportGroup[]} groups
	 */
	const plan = async (s, data, groups) => {
		const rules = await common.rulesOf(s, data);
		const [categories, brands] = await Promise.all([categoriesOf(data), brandsOf(data)]);
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
		/** @type {Array<FieldError & { line: number }>} */
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
		for (const group of groups) {
			/** @param {string} path @param {string} message */
			const fail = (path, message) => errors.push({ line: group.line, path, message });
			const owners = new Set(group.skus.map((sku) => bySku.get(sku)).filter(Boolean));
			let id = group.productId;
			if (id && !ids.has(id)) {
				fail('/product_id', 'There is no such product.');
				continue;
			}
			if (!id && owners.size > 1) {
				fail('/sku', 'These SKUs belong to different products.');
				continue;
			}
			id ??= /** @type {string | undefined} */ ([...owners][0]) ?? bySlug.get(group.slug) ?? null;
			for (const sku of group.skus) {
				const owner = bySku.get(sku);
				if (owner && owner !== id) fail('/sku', `Another product already uses the SKU ${sku}.`);
				if (fileSkus.has(sku) && fileSkus.get(sku) !== group.key)
					fail('/sku', `The SKU ${sku} is in two products of the file.`);
				fileSkus.set(sku, group.key);
			}
			const before = id ? (existing.get(id) ?? null) : null;
			const built = importInput(group, before, { categoryIds, brandIds });
			if (!built.ok) {
				errors.push(...built.errors);
				continue;
			}
			const checked = checkProduct(built.input, rules, before);
			if (!checked.ok) {
				for (const error of checked.errors) fail(error.path, error.message);
				continue;
			}
			if (rules.locations)
				for (const [variantId, units] of built.stock)
					if (units.stock !== undefined && !units.locations)
						fail('/stock', `Give the stock of variant ${variantId} per location (stock@ columns).`);
			const slug = checked.value.slug;
			if (slug && bySlug.has(slug) && bySlug.get(slug) !== id) fail('/slug', 'Another product already uses this slug.');
			plans.push({ group, id: before ? before.id : null, input: built.input, stock: built.stock, fields: checked.value });
		}
		return { rules, plans, errors };
	};

	/** POST …/csv/products `{ csv, dryRun }`. @param {any} ctx */
	const importProducts = async (ctx) => {
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
		const locationIds = s.has('multi_location') ? (await locationsOf(data)).map((location) => location.id) : [];
		const read = importGroups(recordsOf(parsed.rows), { currency: s.currency, locationIds: new Set(locationIds) });
		const planned = read.errors.some((error) => error.line === 1) ? null : await plan(s, data, read.groups);
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
					rating: { average: 0, count: 0 },
					...summarize(fields.variants, fields.trackStock),
					publishedAt: fields.status === 'active' ? new Date(now()) : null,
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
					return { set: { ...checked.value, slug, variants }, result: null };
				},
				{ now: now() },
			);
			if (done.found) {
				before.push(done.before);
				written.push(item.id);
			}
		}
		await service.log(ctx, 'csv.products_imported', `${written.length} products`);
		await common.changed(s, before, written);
		return { dryRun: false, rows: parsed.rows.length - 1, created: creating, updated: updating, errors: [] };
	};

	// ---------------------------------------------------------------------------------------------------- bulk

	/** POST …/products/bulk `{ ids, action, status | price | stock (+ locationId) | categoryId }`. @param {any} ctx */
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
		if (action === 'status') {
			if (!['draft', 'active', 'archived'].includes(body.status))
				throw refuse([{ path: '/status', message: 'Status is draft, active or archived.' }]);
			change = (item) => (item.status === body.status ? null : { status: body.status });
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
		await service.log(ctx, `products.bulk_${action}`, `${changed} products`);
		await common.changed(s, before);
		return { matched: ids.length - missing.length, changed, missing };
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
