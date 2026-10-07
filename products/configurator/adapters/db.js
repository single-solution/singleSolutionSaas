/**
 * Repositories over the merchant's own database (Part E §7), reached through app-kit `data.forWebsite(websiteId)`:
 * collections are prefixed `ss_configurator_`, every query pins `websiteId` (app-kit's tenant guard rejects any that
 * does not) and inserts are stamped with `websiteId`, `merchantId`, `env`, `createdAt`, `updatedAt` and
 * `schemaVersion`.
 *
 * - `configurators`: one document per configurator — its schema, status and `version` (optimistic concurrency).
 * - `items`: catalog item snapshots and stock figures from item.* / inventory.changed@1 events (catalog link only).
 * @module
 */

export const COLLECTIONS = Object.freeze({ configurators: 'configurators', items: 'items' });

/** Schema version of the stored documents. */
export const SCHEMA_VERSION = 1;

/**
 * Index definitions (websiteId first everywhere), created idempotently by app-kit on first use of a website.
 * @type {Array<{ collection: string, keys: Record<string, 1 | -1>, name: string, unique?: boolean, partialFilterExpression?: Record<string, unknown> }>}
 */
export const INDEXES = /** @type {any} */ ([
	{ collection: 'configurators', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{
		collection: 'configurators',
		keys: { websiteId: 1, key: 1 },
		name: 'website_key',
		unique: true,
		partialFilterExpression: { key: { $type: 'string' } },
	},
	{ collection: 'configurators', keys: { websiteId: 1, status: 1, id: 1 }, name: 'website_status_id' },
	{ collection: 'items', keys: { websiteId: 1, itemId: 1 }, name: 'website_item', unique: true },
]);

/** Lazy, versioned migrations (app-kit runs them once per website under a lock). None yet. */
/** @type {Array<{ version: number, name: string, up: (scope: any) => Promise<void> }>} */
export const MIGRATIONS = [];

/** Fields the repositories never return. */
const INTERNAL = new Set(['_id', 'websiteId', 'merchantId', 'env', 'schemaVersion', 'createdAt', 'updatedAt']);

/** app-kit stamps Dates; records carry ISO strings. @param {unknown} value */
const iso = (value) => (value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : null);

/**
 * @param {Record<string, any> | null} doc
 * @returns {Record<string, any> | null}
 */
const strip = (doc) => (doc ? Object.fromEntries(Object.entries(doc).filter(([key]) => !INTERNAL.has(key))) : null);

/** @param {unknown} error */
export const isDuplicateKey = (error) => /** @type {{ code?: number }} */ (error)?.code === 11000;

/** @typedef {import('../core/views.js').ConfiguratorRecord} ConfiguratorRecord */
/** @typedef {import('../core/catalog.js').CatalogItem} CatalogItem */

/**
 * @typedef {object} Scope app-kit website data scope (guarded collections)
 * @property {string} websiteId
 * @property {(name: string) => any} collection
 */

/**
 * Repositories of one website.
 * @param {Scope} scope
 * @param {{ stamp?: { merchantId?: string, env?: string } }} [options] `stamp` is added to upserted documents (app-kit
 *   stamps plain inserts itself)
 */
export const createRepositories = (scope, { stamp = {} } = {}) => {
	const { websiteId } = scope;
	if (typeof websiteId !== 'string' || websiteId.length === 0) throw new TypeError('websiteId is required');
	const configurators = scope.collection(COLLECTIONS.configurators);
	const items = scope.collection(COLLECTIONS.items);
	/** @param {Record<string, any> | null} doc */
	const toRecord = (doc) =>
		doc
			? /** @type {ConfiguratorRecord} */ ({ ...strip(doc), createdAt: iso(doc.createdAt), updatedAt: iso(doc.updatedAt) })
			: null;

	return Object.freeze({
		websiteId,
		configurators: Object.freeze({
			/**
			 * Insert a new configurator. False when its key is taken.
			 * @param {ConfiguratorRecord} record
			 */
			insert: async (record) => {
				try {
					await configurators.insertOne({ ...record, schemaVersion: SCHEMA_VERSION });
					return true;
				} catch (error) {
					if (isDuplicateKey(error)) return false;
					throw error;
				}
			},
			/**
			 * Optimistic replace: applies only when the stored version is still `version`.
			 * @param {number} version
			 * @param {ConfiguratorRecord} record
			 * @returns {Promise<'ok' | 'conflict' | 'key_taken'>}
			 */
			save: async (version, record) => {
				try {
					const result = await configurators.updateOne(
						{ websiteId, id: record.id, version },
						{
							$set: {
								key: record.key,
								name: record.name,
								status: record.status,
								version: record.version,
								schema: record.schema,
								updatedAt: record.updatedAt,
								publishedAt: record.publishedAt,
							},
						},
					);
					return (result.matchedCount ?? 0) > 0 ? 'ok' : 'conflict';
				} catch (error) {
					if (isDuplicateKey(error)) return 'key_taken';
					throw error;
				}
			},
			/** @param {string} id */
			byId: async (id) => toRecord(await configurators.findOne({ websiteId, id })),
			/** @param {string} key */
			byKey: async (key) => toRecord(await configurators.findOne({ websiteId, key })),
			/**
			 * Configurators by id (ascending), optionally by status.
			 * @param {{ after?: string | null, fetchLimit: number, status?: string | null }} page
			 * @returns {Promise<ConfiguratorRecord[]>}
			 */
			list: async ({ after = null, fetchLimit, status = null }) =>
				(
					await configurators
						.find(
							{ websiteId, ...(status ? { status } : {}), ...(after ? { id: { $gt: after } } : {}) },
							{ sort: { id: 1 }, limit: fetchLimit },
						)
						.toArray()
				).map((/** @type {any} */ doc) => /** @type {ConfiguratorRecord} */ (toRecord(doc))),
			/** Active (draft + published) configurators. */
			countActive: async () => configurators.countDocuments({ websiteId, status: { $ne: 'archived' } }),
			/** Configurators per status. @returns {Promise<Record<string, number>>} */
			countByStatus: async () => {
				const rows = await configurators
					.aggregate([{ $match: { websiteId } }, { $group: { _id: '$status', count: { $sum: 1 } } }])
					.toArray();
				return Object.fromEntries(rows.map((/** @type {{ _id: string, count: number }} */ row) => [row._id, row.count]));
			},
		}),
		items: Object.freeze({
			/** @param {string} itemId @returns {Promise<(CatalogItem & { revision: number }) | null>} */
			get: async (itemId) => /** @type {any} */ (strip(await items.findOne({ websiteId, itemId }))),
			/**
			 * Store an item: insert at revision 1, or replace when the stored revision is still `revision`.
			 * @param {number} revision 0 = new
			 * @param {CatalogItem} item
			 * @returns {Promise<boolean>} false on a concurrent write (retry)
			 */
			put: async (revision, item) => {
				if (revision === 0) {
					try {
						await items.insertOne({ ...item, revision: 1, schemaVersion: SCHEMA_VERSION });
						return true;
					} catch (error) {
						if (isDuplicateKey(error)) return false;
						throw error;
					}
				}
				const { itemId, ...fields } = item;
				const result = await items.updateOne(
					{ websiteId, itemId, revision },
					{ $set: { ...fields, revision: revision + 1, ...stamp } },
				);
				return (result.matchedCount ?? 0) > 0;
			},
			/**
			 * Items by id (ascending).
			 * @param {{ after?: string | null, fetchLimit: number }} page
			 * @returns {Promise<CatalogItem[]>}
			 */
			list: async ({ after = null, fetchLimit }) =>
				(
					await items
						.find({ websiteId, ...(after ? { itemId: { $gt: after } } : {}) }, { sort: { itemId: 1 }, limit: fetchLimit })
						.toArray()
				).map((/** @type {any} */ doc) => /** @type {CatalogItem} */ (strip(doc))),
			count: async () => items.countDocuments({ websiteId }),
		}),
	});
};

/** @typedef {ReturnType<typeof createRepositories>} Repositories */

/**
 * Repositories of a website through app-kit (pooled connection to the merchant's database).
 * @param {{ data: { forWebsite: (websiteId: string, stamp?: Record<string, unknown>) => Promise<Scope> } }} product
 */
export const repositoriesFor =
	(product) =>
	/** @param {string} websiteId @param {{ merchantId?: string, env?: string }} [stamp] */
	async (websiteId, stamp = {}) =>
		createRepositories(await product.data.forWebsite(websiteId, stamp), { stamp });
