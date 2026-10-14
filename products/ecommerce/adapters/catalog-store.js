/**
 * The catalog part's queries in the merchant database (PLAN 0.8.8 Catalog): the indexes (unique slugs per website;
 * an attribute's slug is unique per category it is for, E45; unique serial numbers, listing orders), loading what a product check needs, finding products by id or slug, free
 * slugs, SKUs in use, and rewriting a product's fields in a transaction (a concurrent stock hold by an order makes it
 * retry, so a product edit never undoes one). `price` and `inStock` are recomputed by the ledger's `refreshProducts`.
 * @module
 */
import { createId } from '@ss/contracts';
import { freeSlug, slugify } from '../core/catalog.js';
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
		keys: { websiteId: 1, categoryId: 1, brandId: 1, grade: 1 },
		name: 'by_combination',
		unique: true,
	},
	{ collection: COLLECTIONS.locations, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{ collection: COLLECTIONS.serials, keys: { websiteId: 1, id: 1 }, name: 'by_id', unique: true },
	{ collection: COLLECTIONS.serials, keys: { websiteId: 1, serial: 1 }, name: 'by_serial', unique: true },
	{ collection: COLLECTIONS.serials, keys: { websiteId: 1, productId: 1, variantId: 1, status: 1 }, name: 'by_variant' },
];

/** Without the database's own fields. */
export const NO_ID = Object.freeze({ projection: { _id: 0, websiteId: 0, merchantId: 0 } });

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
			.find({ websiteId: data.websiteId }, NO_ID)
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
 * What a product check needs.
 * @param {WebsiteData} data
 * @param {{ variants: boolean, locations: boolean, grades: boolean, digital: boolean, bookings: boolean, gradeKeys: string[] }} switches
 * @returns {Promise<CatalogRules>}
 */
export const loadRules = async (data, switches) => {
	const [categories, brands, attributes, locations] = await Promise.all([
		data.collection(COLLECTIONS.categories).distinct('id', { websiteId: data.websiteId }),
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
		gradeKeys: new Set(switches.gradeKeys),
		locationIds: new Set(locations.map(String)),
		categoryIds: new Set(categories.map(String)),
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
				{ ...NO_ID, session },
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
	const old = await data.collection(collection).findOne({ websiteId: data.websiteId, previousSlugs: key }, NO_ID);
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
			await products.findOne({ websiteId: data.websiteId, id }, { ...NO_ID, session })
		);
		if (!before) return { found: false };
		const outcome = await change(before, session);
		if ('refuse' in outcome) return { found: true, before, product: null, result: outcome.refuse, changed: false };
		/** @type {Record<string, unknown>} */
		const set = { ...outcome.set };
		if (set.status === 'active' && !before.publishedAt) set.publishedAt = new Date(now);
		await products.updateOne({ websiteId: data.websiteId, id }, { $set: set }, { session });
		await refreshProducts(data, [id], session);
		const product = /** @type {ProductRecord} */ (
			await products.findOne({ websiteId: data.websiteId, id }, { ...NO_ID, session })
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
			.find({ websiteId: data.websiteId, id: { $in: ids } }, NO_ID)
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
