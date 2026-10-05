/**
 * Repositories over the merchant's own database (Part E §7), reached through app-kit `data.forWebsite(websiteId)`:
 * collections are prefixed `ss_catalog_`, every query pins `websiteId` (app-kit's tenant guard rejects any that does
 * not) and inserts are stamped with `websiteId`, `merchantId`, `env`, `createdAt`, `updatedAt` and `schemaVersion`.
 *
 * - `items`: one document per item with its variants and media embedded (atomic stock and price changes, one read
 *   per item page), the denormalised rollups (price range, stock, facets) and a transactional **event outbox**: the
 *   standard events of a change are pushed onto the item in the same single-document write, then published through
 *   the kit's durable outbox and pulled; the sweep job republishes anything left (same idempotency keys).
 *   Writes are compare-and-set on `version`.
 *   With "SKUs unique across the catalog" on, a live item also carries `skuKeys` (its normalised SKUs) under a unique
 *   partial index, so two concurrent writes can never both claim one SKU (the loser gets E11000 → `sku_taken`);
 *   otherwise `skuKeys` is null and outside the index.
 * - `attributes`, `collections`, `brands`: the taxonomy.
 * - `stock_moves`: stock taken by reservations and orders (one per order), so order events are applied once.
 * @module
 */
import { skuKeysOf } from '../core/variants.js';

export const SCHEMA_VERSION = 1;

export const COLLECTIONS = Object.freeze({
	items: 'items',
	attributes: 'attributes',
	collections: 'collections',
	brands: 'brands',
	stockMoves: 'stock_moves',
});

/**
 * Index definitions (websiteId first everywhere), created idempotently by app-kit on first use.
 * @type {Array<{ collection: string, keys: Record<string, 1 | -1>, name: string, unique?: boolean, partialFilterExpression?: Record<string, unknown> }>}
 */
export const INDEXES = [
	{ collection: 'items', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{ collection: 'items', keys: { websiteId: 1, slug: 1 }, name: 'website_slug', unique: true },
	{
		collection: 'items',
		keys: { websiteId: 1, externalId: 1 },
		name: 'website_external',
		unique: true,
		partialFilterExpression: { externalId: { $type: 'string' } },
	},
	{ collection: 'items', keys: { websiteId: 1, previousSlugs: 1 }, name: 'website_previous_slugs' },
	{ collection: 'items', keys: { websiteId: 1, 'variants.id': 1 }, name: 'website_variant' },
	{ collection: 'items', keys: { websiteId: 1, 'variants.sku': 1 }, name: 'website_sku' },
	{
		collection: 'items',
		keys: { websiteId: 1, skuKeys: 1 },
		name: 'website_sku_unique',
		unique: true,
		// only arrays holding strings are indexed: null (setting off, deleted item) and [] never collide
		partialFilterExpression: { skuKeys: { $type: 'string' } },
	},
	{ collection: 'items', keys: { websiteId: 1, 'media.id': 1 }, name: 'website_media' },
	{ collection: 'items', keys: { websiteId: 1, deletedAt: 1, createdAt: -1, id: -1 }, name: 'website_newest' },
	{ collection: 'items', keys: { websiteId: 1, deletedAt: 1, updatedAt: -1, id: -1 }, name: 'website_updated' },
	{ collection: 'items', keys: { websiteId: 1, deletedAt: 1, titleSort: 1, id: 1 }, name: 'website_title' },
	{ collection: 'items', keys: { websiteId: 1, deletedAt: 1, sortPriceLow: 1, id: 1 }, name: 'website_price_low' },
	{ collection: 'items', keys: { websiteId: 1, deletedAt: 1, sortPriceHigh: -1, id: -1 }, name: 'website_price_high' },
	{ collection: 'items', keys: { websiteId: 1, collectionIds: 1, createdAt: -1, id: -1 }, name: 'website_collection' },
	{ collection: 'items', keys: { websiteId: 1, brandId: 1, createdAt: -1, id: -1 }, name: 'website_brand' },
	{ collection: 'items', keys: { websiteId: 1, facets: 1 }, name: 'website_facets' },
	{ collection: 'items', keys: { websiteId: 1, searchTokens: 1 }, name: 'website_search' },
	{ collection: 'items', keys: { websiteId: 1, status: 1, createdAt: -1 }, name: 'website_status' },
	{
		collection: 'items',
		keys: { websiteId: 1, nextTransitionAt: 1 },
		name: 'website_transition',
		partialFilterExpression: { nextTransitionAt: { $type: 'date' } },
	},
	{
		collection: 'items',
		keys: { websiteId: 1, outboxAt: 1 },
		name: 'website_outbox',
		partialFilterExpression: { outboxAt: { $type: 'date' } },
	},
	{ collection: 'attributes', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{ collection: 'attributes', keys: { websiteId: 1, key: 1 }, name: 'website_key', unique: true },
	{ collection: 'collections', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{ collection: 'collections', keys: { websiteId: 1, slug: 1 }, name: 'website_slug', unique: true },
	{ collection: 'collections', keys: { websiteId: 1, parentId: 1, position: 1 }, name: 'website_parent' },
	{ collection: 'brands', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{ collection: 'brands', keys: { websiteId: 1, slug: 1 }, name: 'website_slug', unique: true },
	{ collection: 'stock_moves', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{
		collection: 'stock_moves',
		keys: { websiteId: 1, orderId: 1 },
		name: 'website_order',
		unique: true,
		partialFilterExpression: { orderId: { $type: 'string' } },
	},
	{ collection: 'stock_moves', keys: { websiteId: 1, status: 1, expiresAt: 1 }, name: 'website_expiry' },
];

/** Name of the unique index that reserves SKUs (`skuKeys`). */
export const SKU_INDEX = 'website_sku_unique';

/**
 * Lazy, versioned migrations (app-kit runs them once per website under a lock).
 * @type {Array<{ version: number, name: string, up: (scope: any) => Promise<void> }>}
 */
export const MIGRATIONS = [
	{
		version: 1,
		name: 'sku_keys',
		// reserve the SKUs of live items written before `skuKeys`; an SKU another item already holds (possible while the
		// setting was off) stays unreserved, and the write-time check still reports it
		up: async (scope) => {
			const items = scope.collection(COLLECTIONS.items);
			const cursor = items.find(
				{ websiteId: scope.websiteId, deletedAt: null, skuKeys: { $exists: false }, 'variants.sku': { $type: 'string' } },
				{ projection: { _id: 1, variants: 1 }, sort: { _id: 1 } }, // the oldest item keeps a shared SKU
			);
			for await (const doc of cursor) {
				const keys = skuKeysOf(doc.variants ?? []);
				try {
					await items.updateOne(
						{ websiteId: scope.websiteId, _id: doc._id, skuKeys: { $exists: false } },
						{ $set: { skuKeys: keys.length > 0 ? keys : null } },
					);
				} catch (error) {
					if (!isDuplicateKey(error)) throw error;
				}
			}
		},
	},
];

/** Fields a compare-and-set write never sets (the outbox moves with $push / $pull; the rest is stamped once). */
const UNWRITABLE = new Set(['outbox', '_id', 'websiteId', 'merchantId', 'env', 'schemaVersion', 'createdAt']);

/** Fields the repositories never return to callers outside the service. */
const INTERNAL = new Set(['_id', 'websiteId', 'merchantId', 'env', 'schemaVersion']);

/**
 * @param {Record<string, any> | null} doc
 * @returns {any}
 */
export const strip = (doc) => (doc ? Object.fromEntries(Object.entries(doc).filter(([key]) => !INTERNAL.has(key))) : null);

/** @param {unknown} error */
export const isDuplicateKey = (error) => /** @type {{ code?: number }} */ (error)?.code === 11000;

/**
 * The SKU of a duplicate-key error on the SKU index (null for any other error).
 * @param {unknown} error
 * @returns {string | null}
 */
export const duplicateSkuOf = (error) => {
	if (!isDuplicateKey(error)) return null;
	const { keyPattern, keyValue, message } =
		/** @type {{ keyPattern?: Record<string, unknown>, keyValue?: Record<string, unknown>, message?: string }} */ (error);
	if (!(keyPattern && 'skuKeys' in keyPattern) && !String(message ?? '').includes(SKU_INDEX)) return null;
	return typeof keyValue?.skuKeys === 'string' ? keyValue.skuKeys : '';
};

/**
 * @typedef {object} Scope app-kit website data scope (guarded collections)
 * @property {string} websiteId
 * @property {(name: string) => any} collection
 */

/**
 * A small CRUD repository keyed by `id` with one more unique field.
 * @param {any} collection guarded collection
 * @param {string} websiteId
 * @param {() => Date} at
 */
const taxonomy = (collection, websiteId, at) => ({
	/** @param {string} id */
	get: async (id) => strip(await collection.findOne({ websiteId, id })),
	/** @param {string} field @param {string} value */
	by: async (field, value) => strip(await collection.findOne({ websiteId, [field]: value })),
	/** @param {{ sort?: Record<string, 1 | -1>, limit?: number, filter?: Record<string, unknown> }} [options] */
	list: async ({ sort = { position: 1, id: 1 }, limit = 5000, filter = {} } = {}) =>
		(
			await collection
				.find({ ...filter, websiteId })
				.sort(sort)
				.limit(limit)
				.toArray()
		).map(strip),
	count: async () => collection.countDocuments({ websiteId }),
	/** @param {Record<string, unknown>} doc */
	insert: async (doc) => {
		const now = at();
		await collection.insertOne({ ...doc, createdAt: now, updatedAt: now });
		return strip({ ...doc, createdAt: now, updatedAt: now });
	},
	/** @param {string} id @param {Record<string, unknown>} fields */
	update: async (id, fields) =>
		strip(
			await collection.findOneAndUpdate(
				{ websiteId, id },
				{ $set: { ...fields, updatedAt: at() } },
				{ returnDocument: 'after' },
			),
		),
	/** @param {string} id */
	remove: async (id) => (await collection.deleteOne({ websiteId, id })).deletedCount === 1,
	/** @param {Array<{ id: string, fields: Record<string, unknown> }>} changes */
	updateMany: async (changes) => {
		for (const change of changes)
			await collection.updateOne({ websiteId, id: change.id }, { $set: { ...change.fields, updatedAt: at() } });
	},
});

/**
 * Repositories of one website.
 * @param {Scope} scope
 * @param {{ now?: () => number }} [options]
 */
export const createRepositories = (scope, { now = Date.now } = {}) => {
	const { websiteId } = scope;
	const at = () => new Date(now());
	const items = scope.collection(COLLECTIONS.items);
	const moves = scope.collection(COLLECTIONS.stockMoves);
	return Object.freeze({
		websiteId,
		items: Object.freeze({
			/** @param {string} id */
			get: async (id) => strip(await items.findOne({ websiteId, id })),
			/** @param {string} slug */
			bySlug: async (slug) => strip(await items.findOne({ websiteId, slug })),
			/** @param {string} slug */
			byPreviousSlug: async (slug) => strip(await items.findOne({ websiteId, previousSlugs: slug, deletedAt: null })),
			/** @param {string} externalId */
			byExternalId: async (externalId) => strip(await items.findOne({ websiteId, externalId })),
			/** @param {string} variantId */
			byVariant: async (variantId) => strip(await items.findOne({ websiteId, 'variants.id': variantId })),
			/** @param {string} sku */
			bySku: async (sku) => strip(await items.findOne({ websiteId, 'variants.sku': sku, deletedAt: null })),
			/** @param {string} mediaId */
			byMedia: async (mediaId) => strip(await items.findOne({ websiteId, 'media.id': mediaId })),
			/**
			 * @param {{ filter: Record<string, unknown>, sort: Record<string, 1 | -1>, fetchLimit: number, skip?: number }} query
			 */
			list: async ({ filter, sort, fetchLimit, skip = 0 }) =>
				(
					await items
						.find({ ...filter, websiteId })
						.sort(sort)
						.skip(skip)
						.limit(fetchLimit)
						.toArray()
				).map(strip),
			/**
			 * Lowest and highest price of the items matching a filter.
			 * @param {Record<string, unknown>} filter
			 * @returns {Promise<{ min: number, max: number } | null>}
			 */
			priceRange: async (filter) => {
				const [row] = await items
					.aggregate([
						{ $match: { ...filter, websiteId } },
						{ $group: { _id: null, min: { $min: '$priceMin' }, max: { $max: '$priceMax' } } },
					])
					.toArray();
				return row && typeof row.min === 'number' && typeof row.max === 'number' ? { min: row.min, max: row.max } : null;
			},
			/** @param {Record<string, unknown>} filter */
			count: async (filter = {}) => items.countDocuments({ ...filter, websiteId }),
			/** @param {Record<string, unknown>} filter */
			exists: async (filter) => (await items.findOne({ ...filter, websiteId }, { projection: { _id: 1 } })) !== null,
			/** @param {Record<string, unknown>} doc */
			insert: async (doc) => {
				await items.insertOne(doc);
				return strip(doc);
			},
			/**
			 * Compare-and-set write of an item (every field but the outbox), pushing its new outbox entries.
			 * @param {Record<string, any>} doc the new state (with `version` = previous + 1)
			 * @param {number} expectedVersion
			 * @param {Array<Record<string, unknown>>} entries
			 * @returns {Promise<boolean>} false when the item changed meanwhile
			 */
			write: async (doc, expectedVersion, entries) => {
				const fields = Object.fromEntries(Object.entries(doc).filter(([key]) => !UNWRITABLE.has(key)));
				const update = {
					$set: { ...fields, ...(entries.length > 0 ? { outboxAt: doc.updatedAt } : {}) },
					...(entries.length > 0 ? { $push: { outbox: { $each: entries } } } : {}),
				};
				const result = await items.updateOne({ websiteId, id: doc.id, version: expectedVersion }, update);
				return result.matchedCount === 1;
			},
			/**
			 * Remove published outbox entries (and the outbox marker once empty).
			 * @param {string} id
			 * @param {string[]} keys
			 */
			acknowledge: async (id, keys) => {
				await items.updateOne({ websiteId, id }, { $pull: { outbox: { key: { $in: keys } } } });
				await items.updateOne({ websiteId, id, outbox: { $size: 0 } }, { $unset: { outboxAt: '' } });
			},
			/** Items with outbox entries older than `before`. @param {Date} before @param {number} limit */
			pendingOutbox: async (before, limit) =>
				(
					await items
						.find({ websiteId, outboxAt: { $lte: before } })
						.sort({ outboxAt: 1 })
						.limit(limit)
						.toArray()
				).map(strip),
			/** Items whose scheduled visibility changes by `before`. @param {Date} before @param {number} limit */
			dueTransitions: async (before, limit) =>
				(
					await items
						.find({ websiteId, nextTransitionAt: { $lte: before } })
						.sort({ nextTransitionAt: 1 })
						.limit(limit)
						.toArray()
				).map(strip),
			/**
			 * Facet counts over the public items matching a filter.
			 * @param {Record<string, unknown>} filter
			 * @param {{ scan: number, prefixes: string[] }} options
			 * @returns {Promise<Array<{ token: string, count: number }>>}
			 */
			facetCounts: async (filter, { scan, prefixes }) => {
				const rows = await items
					.aggregate([
						{ $match: { ...filter, websiteId } },
						{ $limit: scan },
						{ $project: { _id: 0, facets: 1 } },
						{ $unwind: '$facets' },
						{ $group: { _id: '$facets', count: { $sum: 1 } } },
						{ $sort: { count: -1, _id: 1 } },
						{ $limit: 5000 },
					])
					.toArray();
				return rows
					.map((/** @type {any} */ row) => ({ token: String(row._id), count: Number(row.count) }))
					.filter((/** @type {{ token: string, count: number }} */ row) =>
						prefixes.some((prefix) => row.token.startsWith(`${prefix}:`)),
					);
			},
		}),
		attributes: Object.freeze(taxonomy(scope.collection(COLLECTIONS.attributes), websiteId, at)),
		collections: Object.freeze(taxonomy(scope.collection(COLLECTIONS.collections), websiteId, at)),
		brands: Object.freeze(taxonomy(scope.collection(COLLECTIONS.brands), websiteId, at)),
		moves: Object.freeze({
			/** @param {string} id */
			get: async (id) => strip(await moves.findOne({ websiteId, id })),
			/** @param {string} orderId */
			byOrder: async (orderId) => strip(await moves.findOne({ websiteId, orderId })),
			/** @param {Record<string, unknown>} doc @returns {Promise<boolean>} false when it already exists */
			insert: async (doc) => {
				try {
					const stamp = at();
					await moves.insertOne({ ...doc, createdAt: stamp, updatedAt: stamp });
					return true;
				} catch (error) {
					if (isDuplicateKey(error)) return false;
					throw error;
				}
			},
			/**
			 * Move a stock move from one status to another (compare-and-set on the status).
			 * @param {string} id
			 * @param {string} from
			 * @param {Record<string, unknown>} fields
			 */
			transition: async (id, from, fields) =>
				(await moves.updateOne({ websiteId, id, status: from }, { $set: { ...fields, updatedAt: at() } })).modifiedCount ===
				1,
			/** @param {string} id @param {string} eventId @param {Record<string, unknown>} fields */
			addRefund: async (id, eventId, fields = {}) =>
				(
					await moves.updateOne(
						{ websiteId, id, refunds: { $ne: eventId } },
						{ $push: { refunds: eventId }, $set: { ...fields, updatedAt: at() } },
					)
				).modifiedCount === 1,
			/** @param {Date} before @param {number} limit */
			expired: async (before, limit) =>
				(
					await moves
						.find({ websiteId, status: 'held', expiresAt: { $lte: before } })
						.sort({ expiresAt: 1 })
						.limit(limit)
						.toArray()
				).map(strip),
		}),
	});
};

/** @typedef {ReturnType<typeof createRepositories>} Repositories */

/**
 * Repositories factory over the app-kit product (indexes and migrations are applied lazily by app-kit).
 * @param {any} product
 * @param {{ now?: () => number }} [options]
 * @returns {(websiteId: string, stamp?: { merchantId?: string, env?: string }) => Promise<Repositories>}
 */
export const repositoriesFor =
	(product, { now = Date.now } = {}) =>
	async (websiteId, stamp = {}) =>
		createRepositories(await product.data.forWebsite(websiteId, stamp), { now });
