/**
 * The catalog part's queries in the merchant database (PLAN 0.8.8 Catalog): the indexes (unique slugs per website;
 * an attribute's slug is unique per category it is for, E45; unique unit numbers, listing orders), loading what a product check needs, finding products by id or slug, free
 * slugs, SKUs in use, and rewriting a product's fields in a transaction (a concurrent stock hold by an order makes it
 * retry, so a product edit never undoes one). `price` and `inStock` are recomputed by the ledger's `refreshProducts`.
 * @module
 */
import { createId } from '@ss/contracts';
import { contentChanged, freeSlug, slugify } from '../core/catalog.js';
import { categoryTypeKey, elementsOf, typeOf, typeTree } from '../core/item-types.js';
import { sameMeaning } from '../core/measure.js';
import { COLLECTIONS, ID_PREFIX } from '../core/model.js';
import { refreshProducts } from './ledger.js';

/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('mongodb').ClientSession} Session */
/** @typedef {import('../core/model.js').ProductRecord} ProductRecord */
/** @typedef {import('../core/model.js').CategoryRecord} CategoryRecord */
/** @typedef {import('../core/model.js').BrandRecord} BrandRecord */
/** @typedef {import('../core/model.js').AttributeRecord} AttributeRecord */
/** @typedef {import('../core/model.js').LocationRecord} LocationRecord */
/** @typedef {import('../core/catalog.js').CatalogRules} CatalogRules */

/** Merchant database indexes of this part. @type {import('@ss/app-kit').IndexDefinition[]} */
export const INDEXES = [
	{ collection: COLLECTIONS.products, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{
		collection: COLLECTIONS.products,
		keys: { websiteId: 1, slug: 1 },
		name: 'by_slug',
		unique: true,
		partialFilterExpression: { slug: { $type: 'string' } },
	},
	{ collection: COLLECTIONS.products, keys: { websiteId: 1, 'variants.sku': 1 }, name: 'by_sku' },
	{ collection: COLLECTIONS.products, keys: { websiteId: 1, 'variants.id': 1 }, name: 'by_variant' },
	{ collection: COLLECTIONS.products, keys: { websiteId: 1, status: 1, publishedAt: -1, id: -1 }, name: 'newest' },
	{ collection: COLLECTIONS.products, keys: { websiteId: 1, status: 1, price: 1, id: 1 }, name: 'by_price' },
	{ collection: COLLECTIONS.products, keys: { websiteId: 1, status: 1, sold: -1, id: -1 }, name: 'top' },
	{ collection: COLLECTIONS.products, keys: { websiteId: 1, status: 1, ordered: -1, id: -1 }, name: 'top_ordered' },
	{ collection: COLLECTIONS.products, keys: { websiteId: 1, status: 1, 'rating.average': -1, id: -1 }, name: 'by_rating' },
	{ collection: COLLECTIONS.products, keys: { websiteId: 1, status: 1, name: 1, id: 1 }, name: 'by_name' },
	{ collection: COLLECTIONS.products, keys: { websiteId: 1, categoryIds: 1 }, name: 'by_category' },
	{ collection: COLLECTIONS.products, keys: { websiteId: 1, brandId: 1 }, name: 'by_brand' },
	{ collection: COLLECTIONS.products, keys: { websiteId: 1, createdAt: -1, id: -1 }, name: 'staff_list' },
	{ collection: COLLECTIONS.products, keys: { websiteId: 1, status: 1, updatedAt: -1, id: -1 }, name: 'updated' },
	{ collection: COLLECTIONS.products, keys: { websiteId: 1, featured: 1, status: 1 }, name: 'by_featured' },
	{ collection: COLLECTIONS.products, keys: { websiteId: 1, stockState: 1 }, name: 'by_stock_state' },
	{ collection: COLLECTIONS.products, keys: { websiteId: 1, grades: 1 }, name: 'by_grade' },
	{ collection: COLLECTIONS.products, keys: { websiteId: 1, 'variants.grade': 1, status: 1 }, name: 'by_variant_grade' },
	{ collection: COLLECTIONS.products, keys: { websiteId: 1, previousSlugs: 1 }, name: 'by_previous_slug' },
	{ collection: COLLECTIONS.categories, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{
		collection: COLLECTIONS.categories,
		keys: { websiteId: 1, slug: 1 },
		name: 'by_slug',
		unique: true,
		partialFilterExpression: { slug: { $type: 'string' } },
	},
	{ collection: COLLECTIONS.categories, keys: { websiteId: 1, parentId: 1 }, name: 'by_parent' },
	{ collection: COLLECTIONS.categories, keys: { websiteId: 1, previousSlugs: 1 }, name: 'by_previous_slug' },
	{ collection: COLLECTIONS.brands, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{
		collection: COLLECTIONS.brands,
		keys: { websiteId: 1, slug: 1 },
		name: 'by_slug',
		unique: true,
		partialFilterExpression: { slug: { $type: 'string' } },
	},
	{ collection: COLLECTIONS.attributes, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	// the same slug once per category and once for every category (E45; `categoryId: null` also matches an attribute saved
	// without one, so the kit's index rule replaces the older `by_slug` with no backfill)
	{
		collection: COLLECTIONS.attributes,
		keys: { websiteId: 1, categoryId: 1, slug: 1 },
		name: 'by_category_slug',
		unique: true,
		partialFilterExpression: { slug: { $type: 'string' } },
	},
	{ collection: COLLECTIONS.sizeCharts, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{ collection: COLLECTIONS.landings, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{
		collection: COLLECTIONS.landings,
		keys: { websiteId: 1, categoryId: 1, brandId: 1, 'facet.field': 1, 'facet.value': 1 },
		name: 'by_combination',
		unique: true,
	},
	// the landing pages indexed before, by combination: they stay indexed while they have any product (SEO audit G7.7)
	{ collection: COLLECTIONS.landingIndex, keys: { websiteId: 1, key: 1 }, name: 'by_key', unique: true },
	{ collection: COLLECTIONS.locations, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{ collection: COLLECTIONS.serials, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	// every number of a unit names it alone: its serial and each value by unit field (dynamic model §2)
	{ collection: COLLECTIONS.serials, keys: { websiteId: 1, keys: 1 }, name: 'by_key', unique: true },
	{ collection: COLLECTIONS.serials, keys: { websiteId: 1, serial: 1 }, name: 'by_serial' },
	{ collection: COLLECTIONS.serials, keys: { websiteId: 1, productId: 1, variantId: 1, status: 1 }, name: 'by_variant' },
];

/** Without the ids that tie a record to its website and merchant (and the database's own). */
export const NO_KEYS = Object.freeze({ projection: { _id: 0, websiteId: 0, merchantId: 0 } });

/** @param {unknown} error */
export const isDuplicate = (error) => typeof error === 'object' && error !== null && /** @type {any} */ (error).code === 11000;

/**
 * Every record of a small catalog collection (categories, brands, attributes, locations), in order.
 * @template T
 * @param {WebsiteData} data
 * @param {string} collection
 * @returns {Promise<T[]>}
 */
const allOf = async (data, collection) =>
	/** @type {T[]} */ (
		await data
			.collection(collection)
			.find({ websiteId: data.websiteId }, NO_KEYS)
			.sort({ sort: 1, name: 1, id: 1 })
			.limit(5000)
			.toArray()
	);

/** @param {WebsiteData} data @returns {Promise<CategoryRecord[]>} */
export const categoriesOf = (data) => allOf(data, COLLECTIONS.categories);
/** @param {WebsiteData} data @returns {Promise<BrandRecord[]>} */
export const brandsOf = (data) => allOf(data, COLLECTIONS.brands);
/** @param {WebsiteData} data @returns {Promise<AttributeRecord[]>} */
export const attributesOf = (data) => allOf(data, COLLECTIONS.attributes);
/** @param {WebsiteData} data @returns {Promise<LocationRecord[]>} */
export const locationsOf = (data) => allOf(data, COLLECTIONS.locations);

/**
 * The categories given and every one above them, as item types read them (`core/item-types.js` `typeTree`).
 * @param {WebsiteData} data @param {string[]} ids
 */
const typeTreeOf = async (data, ids) => {
	const categories = data.collection(COLLECTIONS.categories);
	const projection = { _id: 0, id: 1, path: 1, typeKey: 1 };
	/** @param {string[]} wanted */
	const read = async (wanted) =>
		wanted.length === 0
			? []
			: /** @type {Array<{ id: string, path?: string[], typeKey?: string | null }>} */ (
					await categories.find({ websiteId: data.websiteId, id: { $in: wanted } }, { projection }).toArray()
				);
	const first = await read([...new Set(ids)]);
	const known = new Set(first.map((category) => category.id));
	const above = [...new Set(first.flatMap((category) => category.path ?? []))].filter((id) => !known.has(id));
	return typeTree([...first, ...(await read(above))]);
};

/**
 * The item type of each product given, by id (`core/item-types.js` `typeOf`); the categories are read only when the
 * merchant has types (else every product has the built-in type of its kind).
 * @param {WebsiteData} data
 * @param {ReadonlyArray<{ id: string, kind: string, typeKey?: string | null, categoryIds: string[] }>} products
 * @param {ReadonlyArray<import('../core/item-types.js').ItemType>} types the merchant's
 * @returns {Promise<Map<string, import('../core/item-types.js').ItemType>>}
 */
export const productTypes = async (data, products, types) => {
	const tree =
		types.length > 0
			? await typeTreeOf(
					data,
					products.flatMap((product) => product.categoryIds.slice(0, 1)),
				)
			: new Map();
	return new Map(products.map((product) => [product.id, typeOf(product, types, tree)]));
};

/**
 * The products sold in a unit of their own as a query names them (`core/catalog-query.js` `MeasuredScope`): the
 * keys of the merchant's types with a measure and the categories whose type is one of them; null when no type has
 * one. Whatever the Sell in any unit switch: their stock counts thousandths of their unit.
 * @param {WebsiteData} data
 * @param {ReadonlyArray<import('../core/item-types.js').ItemType>} types the merchant's
 * @returns {Promise<import('../core/catalog-query.js').MeasuredScope | null>}
 */
export const measuredScope = async (data, types) => {
	const keys = types.filter((type) => type.kind === 'physical' && type.elements.measure).map((type) => type.key);
	if (keys.length === 0) return null;
	const rows = await data
		.collection(COLLECTIONS.categories)
		.find({ websiteId: data.websiteId }, { projection: { _id: 0, id: 1, path: 1, typeKey: 1 } })
		.limit(5000)
		.toArray();
	const tree = typeTree(
		rows.map((row) => ({ id: String(row.id), path: (row.path ?? []).map(String), typeKey: row.typeKey ?? null })),
	);
	return { keys, categoryIds: [...tree.keys()].filter((id) => keys.includes(categoryTypeKey(id, types, tree))) };
};

/**
 * The products given that have units in stock.
 * @param {WebsiteData} data @param {string[]} productIds
 * @returns {Promise<Set<string>>}
 */
export const stockedUnits = async (data, productIds) =>
	productIds.length === 0
		? new Set()
		: new Set(
				(
					await data
						.collection(COLLECTIONS.serials)
						.distinct('productId', { websiteId: data.websiteId, productId: { $in: productIds }, status: 'in_stock' })
				).map(String),
			);

/**
 * The units of the products given whose item type numbers them (`core/item-types.js`, the `units` element while Grades
 * and serials is on): when they get their numbers, the stage they are needed before and their unit fields (the active
 * ones the type names, in its order; none: plain serial numbers). Products whose type numbers no units are left out.
 * @param {WebsiteData} data @param {string[]} productIds
 * @param {{ types: ReadonlyArray<import('../core/item-types.js').ItemType>, has: (feature: string) => boolean }} context
 *   the merchant's item types and the switched-on features
 * @returns {Promise<Map<string, import('../core/item-types.js').UnitRules>>}
 */
export const unitRulesOf = async (data, productIds, { types, has }) => {
	/** @type {Map<string, import('../core/item-types.js').UnitRules>} */
	const out = new Map();
	if (productIds.length === 0 || !has('grades_serials') || !types.some((type) => type.elements.units)) return out;
	const { websiteId } = data;
	const [products, fields] = await Promise.all([
		data
			.collection(COLLECTIONS.products)
			.find({ websiteId, id: { $in: productIds } }, { projection: { _id: 0, id: 1, kind: 1, typeKey: 1, categoryIds: 1 } })
			.toArray(),
		/** @type {Promise<AttributeRecord[]>} */ (
			/** @type {unknown} */ (
				data.collection(COLLECTIONS.attributes).find({ websiteId, on: 'unit', active: true }, NO_KEYS).toArray()
			)
		),
	]);
	const typed = await productTypes(
		data,
		products.map((row) => ({
			id: String(row.id),
			kind: String(row.kind),
			typeKey: row.typeKey ?? null,
			categoryIds: (row.categoryIds ?? []).map(String),
		})),
		types,
	);
	const byId = new Map(fields.map((field) => [field.id, field]));
	for (const [id, type] of typed) {
		const units = elementsOf(type, has).units;
		if (units)
			out.set(id, {
				capture: units.capture,
				requiredBefore: units.requiredBefore,
				fields: units.fieldIds.flatMap((fieldId) => byId.get(fieldId) ?? []),
			});
	}
	return out;
};

/**
 * The units sold to orders, with their values: order id → serial → values by unit field (a plain serial has none).
 * @param {WebsiteData} data @param {string[]} orderIds
 * @returns {Promise<Map<string, Map<string, Record<string, string[]>>>>}
 */
export const unitsOfOrders = async (data, orderIds) => {
	/** @type {Map<string, Map<string, Record<string, string[]>>>} */
	const out = new Map(orderIds.map((id) => [id, new Map()]));
	if (orderIds.length === 0) return out;
	const rows = await data
		.collection(COLLECTIONS.serials)
		.find(
			{ websiteId: data.websiteId, orderId: { $in: orderIds } },
			{ projection: { _id: 0, orderId: 1, serial: 1, values: 1 } },
		)
		.toArray();
	for (const row of rows) out.get(String(row.orderId))?.set(String(row.serial), row.values ?? {});
	return out;
};

/**
 * Every field whose values live on units, orders or customers, in their order, to check, name and show their values
 * (fields switched off too: their values stay readable).
 * @param {WebsiteData} data @param {'unit' | 'order' | 'customer'} on
 * @returns {Promise<AttributeRecord[]>}
 */
export const fieldsOn = async (data, on) =>
	/** @type {AttributeRecord[]} */ (
		/** @type {unknown} */ (
			await data
				.collection(COLLECTIONS.attributes)
				.find({ websiteId: data.websiteId, on }, NO_KEYS)
				.sort({ sort: 1, name: 1, id: 1 })
				.toArray()
		)
	);

/**
 * The merchant fields printed documents read (`core/invoice.js` `DocumentFields`): the unit, order, customer, product
 * and variant fields, the values of the orders' units, the field values of the orders' customers, and the specs and
 * variant attributes of the lines' products (an invoice's field columns, E26).
 * @param {WebsiteData} data
 * @param {ReadonlyArray<{ id: string, lines: ReadonlyArray<{ serials: string[], productId: string }>,
 *   customer: { customerId?: string } }>} orders
 * @returns {Promise<import('../core/invoice.js').DocumentFields>}
 */
export const documentFieldsOf = async (data, orders) => {
	const withUnits = orders.filter((order) => order.lines.some((line) => line.serials.length > 0)).map((order) => order.id);
	const customerIds = [...new Set(orders.flatMap((order) => (order.customer.customerId ? [order.customer.customerId] : [])))];
	const productIds = [...new Set(orders.flatMap((order) => order.lines.map((line) => line.productId)))];
	const [list, units, customers, products] = await Promise.all([
		data
			.collection(COLLECTIONS.attributes)
			.find({ websiteId: data.websiteId, on: { $in: ['unit', 'order', 'customer', 'product', 'variant'] } }, NO_KEYS)
			.sort({ sort: 1, name: 1, id: 1 })
			.toArray(),
		unitsOfOrders(data, withUnits),
		customerIds.length > 0
			? data
					.collection(COLLECTIONS.customers)
					.find({ websiteId: data.websiteId, id: { $in: customerIds } }, { projection: { _id: 0, id: 1, fields: 1 } })
					.toArray()
			: Promise.resolve([]),
		// the lines' products' field values, for an invoice's field columns (E26)
		productIds.length > 0
			? data
					.collection(COLLECTIONS.products)
					.find(
						{ websiteId: data.websiteId, id: { $in: productIds } },
						{ projection: { _id: 0, id: 1, specs: 1, variants: { id: 1, attributes: 1 } } },
					)
					.toArray()
			: Promise.resolve([]),
	]);
	return {
		list: /** @type {AttributeRecord[]} */ (/** @type {unknown} */ (list)),
		units,
		customers: new Map(customers.map((row) => [String(row.id), row.fields ?? {}])),
		products: new Map(
			products.map((row) => [
				String(row.id),
				{
					specs: row.specs ?? {},
					variants: new Map(
						(Array.isArray(row.variants) ? row.variants : []).map((/** @type {any} */ variant) => [
							String(variant.id),
							variant.attributes ?? {},
						]),
					),
				},
			]),
		),
	};
};

/**
 * What saving the item types list must keep (`core/item-types.js` `typeChangeProblems`): the shop's fields by id (where
 * their values live), the type keys its products and categories name, the keys of the
 * types (as saved) whose items have units in stock and, when the save changes how a type's items are measured, the
 * keys of the types whose items have any stock.
 * @param {WebsiteData} data
 * @param {ReadonlyArray<import('../core/item-types.js').ItemType>} saved
 * @param {ReadonlyArray<import('../core/item-types.js').ItemType>} [next] the list being saved
 */
export const typeUses = async (data, saved, next = saved) => {
	const { websiteId } = data;
	const named = { websiteId, typeKey: { $type: 'string' } };
	const measureChanged = saved.some((type) => {
		const after = next.find((entry) => entry.key === type.key);
		return after !== undefined && !sameMeaning(type.elements.measure, after.elements.measure);
	});
	const [fields, productKeys, categoryKeys, categories, stockedIds, withStock] = await Promise.all([
		data
			.collection(COLLECTIONS.attributes)
			.find({ websiteId }, { projection: { _id: 0, id: 1, on: 1 } })
			.toArray(),
		data.collection(COLLECTIONS.products).distinct('typeKey', named),
		data.collection(COLLECTIONS.categories).distinct('typeKey', named),
		data
			.collection(COLLECTIONS.categories)
			.find({ websiteId }, { projection: { _id: 0, id: 1, path: 1, typeKey: 1 } })
			.limit(5000)
			.toArray(),
		data.collection(COLLECTIONS.serials).distinct('productId', { websiteId, status: 'in_stock' }),
		measureChanged
			? data
					.collection(COLLECTIONS.products)
					.find(
						{ websiteId, kind: 'physical', variants: { $elemMatch: { stock: { $gt: 0 } } } },
						{ projection: { _id: 0, kind: 1, typeKey: 1, categoryIds: 1 } },
					)
					.toArray()
			: Promise.resolve([]),
	]);
	const stocked =
		stockedIds.length > 0
			? await data
					.collection(COLLECTIONS.products)
					.find({ websiteId, id: { $in: stockedIds } }, { projection: { _id: 0, kind: 1, typeKey: 1, categoryIds: 1 } })
					.toArray()
			: [];
	const tree = typeTree(
		categories.map((row) => ({ id: String(row.id), path: (row.path ?? []).map(String), typeKey: row.typeKey ?? null })),
	);
	/** @param {Array<Record<string, any>>} rows */
	const keysOf = (rows) =>
		new Set(
			rows.map(
				(row) =>
					typeOf(
						{ kind: String(row.kind), typeKey: row.typeKey ?? null, categoryIds: (row.categoryIds ?? []).map(String) },
						saved,
						tree,
					).key,
			),
		);
	return {
		fields: new Map(fields.map((row) => [String(row.id), { on: String(row.on) }])),
		named: new Set([...productKeys, ...categoryKeys].map(String)),
		stocked: keysOf(stocked),
		withStock: keysOf(withStock),
	};
};

/**
 * What a product check needs.
 * @param {WebsiteData} data
 * @param {{ variants: boolean, locations: boolean, grades: boolean, digital: boolean, bookings: boolean, parcels: boolean,
 *   gradeKeys: string[], gradeTypes: ReadonlyMap<string, ReadonlyArray<string>>,
 *   types: ReadonlyArray<import('../core/item-types.js').ItemType> }} switches
 * @returns {Promise<CatalogRules>}
 */
export const loadRules = async (data, switches) => {
	const [categories, brands, attributes, locations] = await Promise.all([
		data
			.collection(COLLECTIONS.categories)
			.find({ websiteId: data.websiteId }, { projection: { _id: 0, id: 1, path: 1, typeKey: 1 } })
			.toArray(),
		data.collection(COLLECTIONS.brands).distinct('id', { websiteId: data.websiteId }),
		attributesOf(data),
		switches.locations ? data.collection(COLLECTIONS.locations).distinct('id', { websiteId: data.websiteId }) : [],
	]);
	return {
		variants: switches.variants,
		locations: switches.locations,
		grades: switches.grades,
		digital: switches.digital,
		bookings: switches.bookings,
		parcels: switches.parcels,
		gradeKeys: new Set(switches.gradeKeys),
		gradeTypes: switches.gradeTypes,
		locationIds: new Set(locations.map(String)),
		categoryIds: new Set(categories.map((category) => String(category.id))),
		categoryPaths: new Map(categories.map((category) => [String(category.id), (category.path ?? []).map(String)])),
		categoryTypes: new Map(categories.map((category) => [String(category.id), category.typeKey ?? null])),
		types: switches.types,
		brandIds: new Set(brands.map(String)),
		attributes: new Map(attributes.map((attribute) => [attribute.id, attribute])),
		newId: (prefix) => createId(prefix),
	};
};

/**
 * A record by id, or by slug when the reference is not an id of that kind.
 * @template T
 * @param {WebsiteData} data
 * @param {string} collection
 * @param {string} ref
 * @param {string} prefix the id prefix of the collection's records
 * @param {Session} [session]
 * @returns {Promise<T | null>}
 */
const findByRef = async (data, collection, ref, prefix, session) =>
	/** @type {T | null} */ (
		await data
			.collection(collection)
			.findOne(
				{ websiteId: data.websiteId, ...(ref.startsWith(`${prefix}_`) ? { id: ref } : { slug: ref }) },
				{ ...NO_KEYS, session },
			)
	);

/**
 * A product by id or slug.
 * @param {WebsiteData} data @param {string} ref @param {Session} [session]
 * @returns {Promise<ProductRecord | null>}
 */
export const findProduct = (data, ref, session) => findByRef(data, COLLECTIONS.products, ref, ID_PREFIX.product, session);

/**
 * A product or category by id, by slug in any case, or by an earlier slug (E13): `moved` when found by an earlier slug.
 * @template T
 * @param {WebsiteData} data
 * @param {string} collection
 * @param {string} ref
 * @param {string} prefix
 * @returns {Promise<{ record: T, moved: boolean } | null>}
 */
export const findBySlugHistory = async (data, collection, ref, prefix) => {
	const key = ref.startsWith(`${prefix}_`) ? ref : ref.toLowerCase();
	const found = await findByRef(data, collection, key, prefix);
	if (found) return { record: /** @type {T} */ (found), moved: false };
	if (key.startsWith(`${prefix}_`)) return null;
	const old = await data.collection(collection).findOne({ websiteId: data.websiteId, previousSlugs: key }, NO_KEYS);
	return old ? { record: /** @type {T} */ (old), moved: true } : null;
};

/**
 * The first free slug for a record of a collection, from the wanted slug or else the name.
 * @param {WebsiteData} data
 * @param {string} collection
 * @param {{ slug: string, name: string, exceptId?: string | null, fallback: string, scope?: Record<string, unknown> }} wanted
 *   `scope`: where the slug must be free (an attribute's category, E45); the whole website by default
 * @returns {Promise<string>}
 */
export const freeSlugIn = async (data, collection, { slug, name, exceptId = null, fallback, scope = {} }) => {
	const base = slug || slugify(name) || fallback;
	const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const taken = await data
		.collection(collection)
		.find(
			{
				websiteId: data.websiteId,
				slug: { $regex: `^${escaped}(-\\d+)?$` },
				...scope,
				...(exceptId ? { id: { $ne: exceptId } } : {}),
			},
			{ projection: { _id: 0, slug: 1 } },
		)
		.toArray();
	return freeSlug(
		base,
		taken.map((doc) => String(doc.slug)),
	);
};

/**
 * Whether a slug is used by another record of the collection (within `scope`: an attribute's category, E45).
 * @param {WebsiteData} data @param {string} collection @param {string} slug @param {string | null} exceptId
 * @param {Session} [session] @param {Record<string, unknown>} [scope]
 */
export const slugTaken = async (data, collection, slug, exceptId, session, scope = {}) =>
	(await data
		.collection(collection)
		.countDocuments(
			{ websiteId: data.websiteId, slug, ...scope, ...(exceptId ? { id: { $ne: exceptId } } : {}) },
			{ session },
		)) > 0;

/**
 * The SKUs among `skus` already used by another product of the website.
 * @param {WebsiteData} data @param {string[]} skus @param {string | null} exceptId @param {Session} [session]
 * @returns {Promise<string[]>}
 */
export const skusTaken = async (data, skus, exceptId, session) => {
	const wanted = skus.filter(Boolean);
	if (wanted.length === 0) return [];
	const found = await data
		.collection(COLLECTIONS.products)
		.find(
			{ websiteId: data.websiteId, 'variants.sku': { $in: wanted }, ...(exceptId ? { id: { $ne: exceptId } } : {}) },
			{ projection: { _id: 0, 'variants.sku': 1 }, session },
		)
		.toArray();
	const used = new Set(found.flatMap((doc) => doc.variants.map((/** @type {any} */ v) => v.sku)));
	return wanted.filter((sku) => used.has(sku));
};

/**
 * Rewrite a product in a transaction: read it, let `change` compute what to set (or refuse), write it with
 * `publishedAt` set the first time it is active, and recompute its price and availability. A concurrent write (an
 * order taking stock) aborts and retries the whole step.
 * @template R
 * @param {WebsiteData} data
 * @param {string} id
 * @param {(product: ProductRecord, session: Session) => Promise<{ set: Record<string, unknown>, result: R } | { refuse: R }>} change
 * @param {{ now: number }} clock
 * @returns {Promise<{ found: false } | { found: true, before: ProductRecord, product: ProductRecord | null, result: R, changed: boolean }>}
 */
export const rewriteProduct = (data, id, change, { now }) =>
	data.transaction(async (session) => {
		const products = data.collection(COLLECTIONS.products);
		const before = /** @type {ProductRecord | null} */ (
			await products.findOne({ websiteId: data.websiteId, id }, { ...NO_KEYS, session })
		);
		if (!before) return { found: false };
		const outcome = await change(before, session);
		if ('refuse' in outcome) return { found: true, before, product: null, result: outcome.refuse, changed: false };
		/** @type {Record<string, unknown>} */
		const set = { ...outcome.set };
		if (set.status === 'active' && !before.publishedAt) set.publishedAt = new Date(now);
		// what its page shows changed: the sitemap's lastmod (G8.4)
		if (contentChanged(before, set)) set.contentUpdatedAt = new Date(now);
		await products.updateOne({ websiteId: data.websiteId, id }, { $set: set }, { session });
		await refreshProducts(data, [id], session);
		const product = /** @type {ProductRecord} */ (
			await products.findOne({ websiteId: data.websiteId, id }, { ...NO_KEYS, session })
		);
		return { found: true, before, product, result: outcome.result, changed: true };
	});

/**
 * Products by id (any status), in the order asked.
 * @param {WebsiteData} data @param {string[]} ids
 * @returns {Promise<ProductRecord[]>}
 */
export const productsByIds = async (data, ids) => {
	const found = /** @type {ProductRecord[]} */ (
		await data
			.collection(COLLECTIONS.products)
			.find({ websiteId: data.websiteId, id: { $in: ids } }, NO_KEYS)
			.toArray()
	);
	const byId = new Map(found.map((product) => [product.id, product]));
	return ids.map((id) => byId.get(id)).filter((product) => product !== undefined);
};

/**
 * Products grouped by their category lists, for counts (active products shoppers may see).
 * @param {WebsiteData} data
 * @param {Record<string, unknown>} [visible] conditions that leave hidden products out (E1)
 * @returns {Promise<Array<{ categoryIds: string[], count: number }>>}
 */
export const categoryGroups = async (data, visible = {}) =>
	(
		await data
			.collection(COLLECTIONS.products)
			.aggregate([
				{ $match: { websiteId: data.websiteId, status: 'active', ...visible } },
				{ $group: { _id: '$categoryIds', count: { $sum: 1 } } },
			])
			.toArray()
	).map((row) => ({ categoryIds: Array.isArray(row._id) ? row._id.map(String) : [], count: Number(row.count) }));
