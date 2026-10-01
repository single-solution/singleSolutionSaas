/**
 * Repositories over the merchant's own database (Part E §7), reached through app-kit `data.forWebsite(websiteId)`:
 * collections are prefixed `ss_grades_`, every query pins `websiteId` (app-kit's tenant guard rejects any that does
 * not) and inserts are stamped with `websiteId`, `merchantId`, `env`, `createdAt`, `updatedAt` and `schemaVersion`.
 *
 * - `items`: per item the catalog snapshot (from `item.*@1`, `known: true`) or a bare external id, and the rollup of
 *   tiers it is offered in (assignments + available units) that filters and badges read.
 * - `assignments`: the tier of an item or of one of its variants (unique per item + variant).
 * - `units`: individually graded units (a serial, a lot, a room…) with their tier and report link (hash only).
 * - `inspections`: checklist results, score and suggested tier per inspection of a unit.
 * - `photos`: inspection photo slots in the merchant's bucket; pending slots expire (TTL).
 * @module
 */

export const SCHEMA_VERSION = 1;

export const COLLECTIONS = Object.freeze({
	items: 'items',
	assignments: 'assignments',
	units: 'units',
	inspections: 'inspections',
	photos: 'photos',
});

/**
 * Index definitions (websiteId first everywhere except TTL), created idempotently by app-kit on first use.
 * @type {Array<{ collection: string, keys: Record<string, 1 | -1>, name: string, unique?: boolean, expireAfterSeconds?: number,
 *   partialFilterExpression?: Record<string, unknown> }>}
 */
export const INDEXES = [
	{ collection: 'items', keys: { websiteId: 1, itemId: 1 }, name: 'website_item', unique: true },
	{ collection: 'items', keys: { websiteId: 1, tiers: 1, itemId: 1 }, name: 'website_tiers_item' },
	// MongoDB cannot index two arrays in one key: collection listings use (collections, itemId) and filter tiers
	{ collection: 'items', keys: { websiteId: 1, collections: 1, itemId: 1 }, name: 'website_collection_item' },
	{ collection: 'assignments', keys: { websiteId: 1, itemId: 1, variantKey: 1 }, name: 'website_item_variant', unique: true },
	{ collection: 'assignments', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{ collection: 'assignments', keys: { websiteId: 1, tier: 1, itemId: 1, variantKey: 1 }, name: 'website_tier_item' },
	{ collection: 'units', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{
		collection: 'units',
		keys: { websiteId: 1, serial: 1 },
		name: 'website_serial',
		unique: true,
		partialFilterExpression: { serial: { $type: 'string' } },
	},
	{
		collection: 'units',
		keys: { websiteId: 1, 'report.tokenHash': 1 },
		name: 'website_report_token',
		unique: true,
		partialFilterExpression: { 'report.tokenHash': { $type: 'string' } },
	},
	{ collection: 'units', keys: { websiteId: 1, deletedAt: 1, addedAt: -1, id: -1 }, name: 'website_time' },
	{ collection: 'units', keys: { websiteId: 1, itemId: 1, deletedAt: 1, addedAt: -1, id: -1 }, name: 'website_item_time' },
	{ collection: 'units', keys: { websiteId: 1, tier: 1, deletedAt: 1, addedAt: -1, id: -1 }, name: 'website_tier_time' },
	{ collection: 'inspections', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{ collection: 'inspections', keys: { websiteId: 1, unitId: 1, startedAt: -1, id: -1 }, name: 'website_unit_time' },
	{ collection: 'inspections', keys: { websiteId: 1, status: 1, startedAt: -1, id: -1 }, name: 'website_status_time' },
	{ collection: 'inspections', keys: { websiteId: 1, startedAt: -1, id: -1 }, name: 'website_time' },
	{ collection: 'photos', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{ collection: 'photos', keys: { websiteId: 1, inspectionId: 1, item: 1 }, name: 'website_inspection' },
	{
		collection: 'photos',
		keys: { purgeAt: 1 },
		name: 'pending_expiry',
		expireAfterSeconds: 0,
		partialFilterExpression: { status: 'pending' },
	},
];

/**
 * Lazy, versioned migrations (app-kit runs them once per website under a lock).
 * @type {Array<{ version: number, name: string, up: (scope: any) => Promise<void> }>}
 */
export const MIGRATIONS = [
	{
		version: 1,
		name: 'unit_availability',
		up: async (scope) => {
			await scope
				.collection(COLLECTIONS.units)
				.updateMany({ websiteId: scope.websiteId, available: { $exists: false } }, { $set: { available: true } });
		},
	},
];

/** Fields the repositories never return. */
const INTERNAL = new Set(['_id', 'websiteId', 'merchantId', 'env', 'schemaVersion', 'createdAt', 'updatedAt', 'purgeAt']);

/**
 * @param {Record<string, any> | null | undefined} doc
 * @returns {any}
 */
const strip = (doc) => (doc ? Object.fromEntries(Object.entries(doc).filter(([key]) => !INTERNAL.has(key))) : null);

/**
 * @param {any} doc
 * @returns {any}
 */
const stripRow = (doc) => strip(doc);

/** @param {unknown} error */
export const isDuplicateKey = (error) => /** @type {{ code?: number }} */ (error)?.code === 11000;

/**
 * Keyset filter on `(field, id)` descending: documents strictly before the cursor `<value>|<id>`.
 * @param {string} field
 * @param {unknown} after
 * @returns {Record<string, unknown>}
 */
export const beforePair = (field, after) => {
	const [value, id, extra] = typeof after === 'string' ? after.split('|') : [];
	return value && id && extra === undefined ? { $or: [{ [field]: { $lt: value } }, { [field]: value, id: { $lt: id } }] } : {};
};

/**
 * Keyset filter on `(a, b)` ascending: documents strictly after the cursor `<a>|<b>`.
 * @param {string} a
 * @param {string} b
 * @param {unknown} after
 * @returns {Record<string, unknown>}
 */
export const afterPair = (a, b, after) => {
	const [first, second, extra] = typeof after === 'string' ? after.split('|') : [];
	return first && second && extra === undefined ? { $or: [{ [a]: { $gt: first } }, { [a]: first, [b]: { $gt: second } }] } : {};
};

/**
 * @typedef {object} Scope app-kit website data scope (guarded collections)
 * @property {string} websiteId
 * @property {(name: string) => GuardedCollection} collection
 */

/**
 * The subset of an app-kit guarded collection the repositories use (cursors resolve to plain documents).
 * @typedef {Record<string, any> & {
 *   find: (filter: Record<string, unknown>, options?: Record<string, unknown>) => { toArray: () => Promise<any[]> },
 *   aggregate: (pipeline: Array<Record<string, unknown>>) => { toArray: () => Promise<any[]> },
 *   distinct: (field: string, filter: Record<string, unknown>) => Promise<unknown[]> }} GuardedCollection
 */

/**
 * Repositories of one website.
 * @param {Scope} scope
 * @param {{ now?: () => number, stamp?: { merchantId?: string, env?: string } }} [options] `stamp` is added to upserted
 *   documents (app-kit stamps plain inserts itself)
 */
export const createRepositories = (scope, { now = Date.now, stamp = {} } = {}) => {
	const { websiteId } = scope;
	if (typeof websiteId !== 'string' || websiteId.length === 0) throw new TypeError('websiteId is required');
	const items = scope.collection(COLLECTIONS.items);
	const assignments = scope.collection(COLLECTIONS.assignments);
	const units = scope.collection(COLLECTIONS.units);
	const inspections = scope.collection(COLLECTIONS.inspections);
	const photos = scope.collection(COLLECTIONS.photos);
	const onInsert = () => ({ ...stamp, createdAt: new Date(now()), schemaVersion: SCHEMA_VERSION });
	const liveUnits = { websiteId, deletedAt: null };

	return Object.freeze({
		websiteId,
		items: Object.freeze({
			/** @param {string} itemId */
			get: async (itemId) => strip(await items.findOne({ websiteId, itemId })),
			/** @param {string[]} itemIds */
			getMany: async (itemIds) =>
				itemIds.length === 0
					? []
					: (await items.find({ websiteId, itemId: { $in: itemIds } }, { limit: itemIds.length }).toArray()).map(stripRow),
			/**
			 * Store a catalog snapshot (only the fields given), reviving a deleted item.
			 * @param {string} itemId
			 * @param {Record<string, unknown>} patch
			 */
			upsertSnapshot: async (itemId, patch) => {
				await items.updateOne(
					{ websiteId, itemId },
					{
						$set: { ...patch, known: true, deletedAt: null, syncedAt: new Date(now()).toISOString() },
						$setOnInsert: { ...onInsert(), itemId, tiers: [] },
					},
					{ upsert: true },
				);
			},
			/**
			 * Make sure a standalone item exists (no catalog snapshot).
			 * @param {string} itemId
			 */
			ensure: async (itemId) => {
				await items.updateOne(
					{ websiteId, itemId },
					{ $setOnInsert: { ...onInsert(), itemId, known: false, deletedAt: null, tiers: [] } },
					{ upsert: true },
				);
			},
			/** @param {string} itemId */
			markDeleted: async (itemId) => {
				const result = await items.updateOne(
					{ websiteId, itemId },
					{ $set: { deletedAt: new Date(now()).toISOString(), tiers: [] } },
				);
				return (result.matchedCount ?? 0) > 0;
			},
			/**
			 * @param {string} itemId
			 * @param {string[]} tiers best first
			 */
			setTiers: async (itemId, tiers) => {
				await items.updateOne({ websiteId, itemId, deletedAt: null }, { $set: { tiers } });
			},
			/**
			 * Items offered in at least one tier, by id.
			 * @param {{ after: string | null, fetchLimit: number }} page
			 */
			listGraded: async ({ after, fetchLimit }) =>
				(
					await items
						.find(
							{ websiteId, deletedAt: null, 'tiers.0': { $exists: true }, ...(after ? { itemId: { $gt: after } } : {}) },
							{ sort: { itemId: 1 }, limit: fetchLimit },
						)
						.toArray()
				).map(stripRow),
			/**
			 * Items per tier (optionally in one collection).
			 * @param {string | null} collection
			 * @returns {Promise<Map<string, number>>}
			 */
			tierCounts: async (collection) => {
				const rows = await items
					.aggregate([
						{ $match: { websiteId, deletedAt: null, ...(collection ? { collections: collection } : {}) } },
						{ $unwind: '$tiers' },
						{ $group: { _id: '$tiers', count: { $sum: 1 } } },
					])
					.toArray();
				return new Map(rows.map((/** @type {{ _id: string, count: number }} */ row) => [row._id, row.count]));
			},
			/**
			 * Item ids offered in any of the tiers (optionally in one collection), by id.
			 * @param {{ tiers: string[], collection: string | null, after: string | null, fetchLimit: number }} input
			 */
			idsInTiers: async ({ tiers, collection, after, fetchLimit }) =>
				(
					await items
						.find(
							{
								websiteId,
								deletedAt: null,
								tiers: { $in: tiers },
								...(collection ? { collections: collection } : {}),
								...(after ? { itemId: { $gt: after } } : {}),
							},
							{ sort: { itemId: 1 }, limit: fetchLimit, projection: { itemId: 1, tiers: 1 } },
						)
						.toArray()
				).map((/** @type {{ itemId: string, tiers: string[] }} */ row) => ({ itemId: row.itemId, tiers: row.tiers })),
			/** Items of the website (graded, catalog-known, deleted). */
			counts: async () => {
				const [graded, known] = await Promise.all([
					items.countDocuments({ websiteId, deletedAt: null, 'tiers.0': { $exists: true } }),
					items.countDocuments({ websiteId, deletedAt: null, known: true }),
				]);
				return { graded, known };
			},
		}),
		assignments: Object.freeze({
			/**
			 * Set the tier of an item or variant. Returns the previous assignment (null when new).
			 * @param {{ id: string, itemId: string, variantId: string | null, variantKey: string, tier: string, note: string | null,
			 *   source: string, actor: { type: string, id?: string } }} input
			 */
			upsert: async ({ id, itemId, variantId, variantKey, tier, note, source, actor }) => {
				const at = new Date(now()).toISOString();
				const before = await assignments.findOneAndUpdate(
					{ websiteId, itemId, variantKey },
					{
						$set: { tier, note, source, actor, assignedAt: at },
						$setOnInsert: { ...onInsert(), id, itemId, variantId, variantKey },
					},
					{ upsert: true, returnDocument: 'before' },
				);
				return strip(before);
			},
			/** @param {string} id */
			get: async (id) => strip(await assignments.findOne({ websiteId, id })),
			/** @param {string} itemId */
			forItem: async (itemId) =>
				(await assignments.find({ websiteId, itemId }, { sort: { variantKey: 1 }, limit: 1001 }).toArray()).map(stripRow),
			/**
			 * A page of assignments by (itemId, variantKey).
			 * @param {{ itemId?: string | null, tier?: string | null, after: string | null, fetchLimit: number }} page
			 */
			list: async ({ itemId = null, tier = null, after, fetchLimit }) =>
				(
					await assignments
						.find(
							{
								websiteId,
								...(itemId ? { itemId } : {}),
								...(tier ? { tier } : {}),
								...afterPair('itemId', 'variantKey', after),
							},
							{ sort: { itemId: 1, variantKey: 1 }, limit: fetchLimit },
						)
						.toArray()
				).map(stripRow),
			/** @param {string} id */
			remove: async (id) => strip(await assignments.findOneAndDelete({ websiteId, id })),
			/**
			 * Remove the catalog-sourced assignments of an item except the given variant keys.
			 * @param {string} itemId
			 * @param {string[]} keep
			 */
			pruneCatalog: async (itemId, keep) => {
				const result = await assignments.deleteMany({ websiteId, itemId, source: 'catalog', variantKey: { $nin: keep } });
				return result.deletedCount ?? 0;
			},
			/** @returns {Promise<Map<string, number>>} */
			countByTier: async () => {
				const rows = await assignments
					.aggregate([{ $match: { websiteId } }, { $group: { _id: '$tier', count: { $sum: 1 } } }])
					.toArray();
				return new Map(rows.map((/** @type {{ _id: string, count: number }} */ row) => [row._id, row.count]));
			},
		}),
		units: Object.freeze({
			/**
			 * @param {Record<string, any> & { id: string }} doc
			 * @returns {Promise<'created' | 'replay' | 'duplicate'>}
			 */
			insert: async (doc) => {
				try {
					await units.insertOne({ ...doc, deletedAt: null });
					return 'created';
				} catch (error) {
					if (!isDuplicateKey(error)) throw error;
					return (await units.findOne({ websiteId, id: doc.id })) ? 'replay' : 'duplicate';
				}
			},
			/** @param {string} id */
			get: async (id) => strip(await units.findOne({ ...liveUnits, id })),
			/**
			 * A page of units, newest first.
			 * @param {{ itemId?: string | null, tier?: string | null, after: string | null, fetchLimit: number }} page
			 */
			list: async ({ itemId = null, tier = null, after, fetchLimit }) =>
				(
					await units
						.find(
							{ ...liveUnits, ...(itemId ? { itemId } : {}), ...(tier ? { tier } : {}), ...beforePair('addedAt', after) },
							{ sort: { addedAt: -1, id: -1 }, limit: fetchLimit },
						)
						.toArray()
				).map(stripRow),
			/**
			 * Apply a change; the unit after it (null when absent).
			 * @param {string} id
			 * @param {Record<string, unknown>} set
			 * @returns {Promise<'ok' | 'missing' | 'duplicate'>}
			 */
			update: async (id, set) => {
				try {
					const result = await units.updateOne({ ...liveUnits, id }, { $set: set });
					return (result.matchedCount ?? 0) > 0 ? 'ok' : 'missing';
				} catch (error) {
					if (!isDuplicateKey(error)) throw error;
					return 'duplicate';
				}
			},
			/** @param {string} id */
			softDelete: async (id) => {
				const result = await units.updateOne(
					{ ...liveUnits, id },
					{ $set: { deletedAt: new Date(now()).toISOString(), serial: null, report: null } },
				);
				return (result.matchedCount ?? 0) > 0;
			},
			/** @param {string} itemId */
			countForItem: async (itemId) => units.countDocuments({ ...liveUnits, itemId }),
			/**
			 * Tiers of the item's available units.
			 * @param {string} itemId
			 * @returns {Promise<string[]>}
			 */
			tiersForItem: async (itemId) =>
				(await units.distinct('tier', { ...liveUnits, itemId, available: true })).filter(
					(/** @type {unknown} */ tier) => typeof tier === 'string',
				),
			/** @param {string} tokenHash */
			byReportToken: async (tokenHash) => strip(await units.findOne({ ...liveUnits, 'report.tokenHash': tokenHash })),
			/** @returns {Promise<Map<string, number>>} */
			countByTier: async () => {
				const rows = await units
					.aggregate([{ $match: liveUnits }, { $group: { _id: '$tier', count: { $sum: 1 } } }])
					.toArray();
				return new Map(rows.map((/** @type {{ _id: string | null, count: number }} */ row) => [row._id ?? '', row.count]));
			},
		}),
		inspections: Object.freeze({
			/** @param {Record<string, any> & { id: string }} doc @returns {Promise<'created' | 'replay'>} */
			insert: async (doc) => {
				try {
					await inspections.insertOne({ ...doc });
					return 'created';
				} catch (error) {
					if (!isDuplicateKey(error)) throw error;
					return 'replay';
				}
			},
			/** @param {string} id */
			get: async (id) => strip(await inspections.findOne({ websiteId, id })),
			/**
			 * Compare-and-set update of a draft.
			 * @param {string} id
			 * @param {Record<string, unknown>} set
			 */
			updateDraft: async (id, set) => {
				const result = await inspections.updateOne({ websiteId, id, status: 'draft' }, { $set: set });
				return (result.matchedCount ?? 0) > 0;
			},
			/**
			 * A page of inspections, newest first.
			 * @param {{ unitId?: string | null, status?: string | null, after: string | null, fetchLimit: number }} page
			 */
			list: async ({ unitId = null, status = null, after, fetchLimit }) =>
				(
					await inspections
						.find(
							{
								websiteId,
								...(unitId ? { unitId } : {}),
								...(status ? { status } : {}),
								...beforePair('startedAt', after),
							},
							{ sort: { startedAt: -1, id: -1 }, limit: fetchLimit },
						)
						.toArray()
				).map(stripRow),
			/** @returns {Promise<{ draft: number, completed: number }>} */
			countByStatus: async () => {
				const [draft, completed] = await Promise.all([
					inspections.countDocuments({ websiteId, status: 'draft' }),
					inspections.countDocuments({ websiteId, status: 'completed' }),
				]);
				return { draft, completed };
			},
		}),
		photos: Object.freeze({
			/** @param {Record<string, any> & { id: string }} doc */
			insert: async (doc) => {
				try {
					await photos.insertOne({ ...doc });
					return 'created';
				} catch (error) {
					if (!isDuplicateKey(error)) throw error;
					return 'replay';
				}
			},
			/** @param {string} id */
			get: async (id) => strip(await photos.findOne({ websiteId, id })),
			/** @param {string} inspectionId */
			forInspection: async (inspectionId) =>
				(await photos.find({ websiteId, inspectionId }, { sort: { item: 1, addedAt: 1 }, limit: 500 }).toArray()).map(
					stripRow,
				),
			/**
			 * Photo slots (any status) of one checklist item.
			 * @param {string} inspectionId
			 * @param {string} item
			 */
			countForItem: async (inspectionId, item) => photos.countDocuments({ websiteId, inspectionId, item }),
			/**
			 * @param {string} id
			 * @param {Record<string, unknown>} set
			 */
			update: async (id, set) => {
				await photos.updateOne({ websiteId, id }, { $set: set });
			},
			/** @param {string} id */
			remove: async (id) => {
				await photos.deleteOne({ websiteId, id });
			},
		}),
	});
};

/** @typedef {ReturnType<typeof createRepositories>} Repositories */

/**
 * Repositories for a website through app-kit (indexes and migrations are applied by app-kit on first use).
 * @param {{ data: { forWebsite: (websiteId: string, stamp?: { merchantId?: string, env?: string }) => Promise<Scope> } }} product
 * @param {{ now?: () => number }} [options]
 * @returns {(websiteId: string, stamp?: { merchantId?: string, env?: string }) => Promise<Repositories>}
 */
export const repositoriesFor =
	(product, options = {}) =>
	async (websiteId, stamp = {}) =>
		createRepositories(await product.data.forWebsite(websiteId, stamp), { ...options, stamp });
