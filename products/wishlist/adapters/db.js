/**
 * Repositories over the merchant's own database (Part E §7), reached through app-kit `data.forWebsite(websiteId)`:
 * collections are prefixed `ss_wishlist_`, every query pins `websiteId` (app-kit's tenant guard rejects any that does
 * not) and inserts are stamped with `websiteId`, `merchantId`, `env`, `createdAt`, `updatedAt`, `schemaVersion`.
 *
 * - `lists` — one document per list with its entries embedded (bounded by `lists.max_items_per_list`), owned by a
 *   customer (login subject) or a guest (random guest id). Entry changes are compare-and-set on `rev`, so concurrent
 *   writers never lose an add or a removal; at most one default list per owner (partial unique index); guest lists
 *   expire (TTL on `expiresAt`, pushed forward on every change); share links are stored as token hashes only.
 * - `stock` — the last known availability and price of each item (for restocks reported without a previous value).
 * - `notifications` — one record per published signal (unique per change and customer), kept for the dashboard.
 * @module
 */

export const SCHEMA_VERSION = 1;

export const COLLECTIONS = Object.freeze({ lists: 'lists', stock: 'stock', notifications: 'notifications' });

/** How often a compare-and-set entry change is retried after losing a race. */
export const CAS_ATTEMPTS = 5;

/**
 * Index definitions (websiteId first everywhere, TTL indexes single-field), created by app-kit on first use.
 * @type {Array<{ collection: string, keys: Record<string, 1 | -1>, name: string, unique?: boolean,
 *   partialFilterExpression?: Record<string, unknown>, expireAfterSeconds?: number }>}
 */
export const INDEXES = /** @type {any} */ ([
	{ collection: 'lists', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{ collection: 'lists', keys: { websiteId: 1, ownerKind: 1, ownerId: 1, createdOn: 1 }, name: 'website_owner' },
	{
		collection: 'lists',
		keys: { websiteId: 1, ownerKind: 1, ownerId: 1 },
		name: 'website_owner_default',
		unique: true,
		partialFilterExpression: { isDefault: true },
	},
	{
		collection: 'lists',
		keys: { websiteId: 1, 'share.tokenHash': 1 },
		name: 'website_share',
		unique: true,
		partialFilterExpression: { 'share.tokenHash': { $type: 'string' } },
	},
	{ collection: 'lists', keys: { websiteId: 1, 'items.itemId': 1, notify: 1 }, name: 'website_item' },
	{ collection: 'lists', keys: { websiteId: 1, createdOn: -1, id: -1 }, name: 'website_time' },
	{ collection: 'lists', keys: { expiresAt: 1 }, name: 'ttl', expireAfterSeconds: 0 },
	{ collection: 'stock', keys: { websiteId: 1, itemKey: 1 }, name: 'website_item', unique: true },
	{ collection: 'notifications', keys: { websiteId: 1, key: 1 }, name: 'website_key', unique: true },
	{ collection: 'notifications', keys: { websiteId: 1, at: -1, id: -1 }, name: 'website_time' },
	{ collection: 'notifications', keys: { websiteId: 1, ownerId: 1 }, name: 'website_owner' },
	{ collection: 'notifications', keys: { expiresAt: 1 }, name: 'ttl', expireAfterSeconds: 0 },
]);

/** Lazy, versioned migrations (app-kit runs them once per website under a lock). */
export const MIGRATIONS = /** @type {Array<{ version: number, name: string, up: (scope: any) => Promise<void> }>} */ ([]);

/** Fields the repositories never return. */
const INTERNAL = new Set(['_id', 'websiteId', 'merchantId', 'env', 'schemaVersion', 'createdAt', 'updatedAt']);

/**
 * @param {Record<string, any> | null} doc
 * @returns {any}
 */
const strip = (doc) => (doc ? Object.fromEntries(Object.entries(doc).filter(([key]) => !INTERNAL.has(key))) : null);

/** @param {unknown} error */
export const isDuplicateKey = (error) => /** @type {{ code?: number }} */ (error)?.code === 11000;

/**
 * @typedef {object} Scope app-kit website data scope (guarded collections)
 * @property {string} websiteId
 * @property {(name: string) => any} collection
 */

/** @typedef {{ kind: 'customer' | 'guest', id: string }} Owner */

/**
 * Repositories of one website.
 * @param {Scope} scope
 * @param {{ now?: () => number, stamp?: { merchantId?: string, env?: string } }} [options] `stamp` is added to upserted
 *   documents (app-kit stamps plain inserts itself)
 */
export const createRepositories = (scope, { now = Date.now, stamp = {} } = {}) => {
	const { websiteId } = scope;
	if (typeof websiteId !== 'string' || websiteId.length === 0) throw new TypeError('websiteId is required');
	const lists = scope.collection(COLLECTIONS.lists);
	const stock = scope.collection(COLLECTIONS.stock);
	const notifications = scope.collection(COLLECTIONS.notifications);
	/** @param {Owner} owner */
	const ownerFilter = (owner) => ({ websiteId, ownerKind: owner.kind, ownerId: owner.id });
	const iso = () => new Date(now()).toISOString();

	return Object.freeze({
		websiteId,
		lists: Object.freeze({
			/** @param {string} id */
			get: async (id) => strip(await lists.findOne({ websiteId, id })),
			/**
			 * Every list of an owner: the default list first, then oldest first.
			 * @param {Owner} owner
			 * @param {number} limit
			 */
			ofOwner: async (owner, limit) =>
				(await lists.find(ownerFilter(owner), { sort: { isDefault: -1, createdOn: 1, id: 1 }, limit }).toArray()).map(strip),
			/** @param {Owner} owner */
			countOfOwner: async (owner) => lists.countDocuments(ownerFilter(owner)),
			/** @param {Owner} owner */
			defaultOf: async (owner) => strip(await lists.findOne({ ...ownerFilter(owner), isDefault: true })),
			/**
			 * Newest first, from a compound cursor `[createdOn, id]`; `owner` narrows to one owner.
			 * @param {{ owner?: Owner | null, after?: unknown, fetchLimit: number }} query
			 */
			page: async ({ owner = null, after, fetchLimit }) => {
				const [on, id] = Array.isArray(after) ? after : [];
				const range =
					typeof on === 'string' && typeof id === 'string'
						? { $or: [{ createdOn: { $lt: on } }, { createdOn: on, id: { $lt: id } }] }
						: {};
				return (
					await lists
						.find(
							{ ...(owner ? ownerFilter(owner) : { websiteId }), ...range },
							{ sort: { createdOn: -1, id: -1 }, limit: fetchLimit },
						)
						.toArray()
				).map(strip);
			},
			/**
			 * Insert a list. False when it would be a second default list of the owner (a concurrent first add).
			 * @param {import('../core/views.js').StoredList & { rev: number, expiresAt?: Date | null }} list
			 */
			insert: async (list) => {
				try {
					await lists.insertOne({ ...list });
					return true;
				} catch (error) {
					if (isDuplicateKey(error)) return false;
					throw error;
				}
			},
			/**
			 * Replace a list's entries if nobody changed it since `rev` was read (compare-and-set).
			 * @param {string} id
			 * @param {number} rev
			 * @param {import('../core/lists.js').Entry[]} items
			 * @param {Record<string, unknown>} [set] more fields (e.g. a guest list's new expiry)
			 */
			replaceItems: async (id, rev, items, set = {}) => {
				const result = await lists.updateOne(
					{ websiteId, id, rev },
					{ $set: { items, touchedOn: iso(), ...set }, $inc: { rev: 1 } },
				);
				return (result.matchedCount ?? 0) > 0;
			},
			/**
			 * Update list fields (name, notify, share, expiry).
			 * @param {string} id
			 * @param {Record<string, unknown>} set
			 */
			update: async (id, set) =>
				strip(
					await lists.findOneAndUpdate(
						{ websiteId, id },
						{ $set: { ...set, touchedOn: iso() }, $inc: { rev: 1 } },
						{ returnDocument: 'after' },
					),
				),
			/** @param {string} id */
			remove: async (id) => ((await lists.deleteOne({ websiteId, id })).deletedCount ?? 0) > 0,
			/** @param {Owner} owner */
			removeOwner: async (owner) => (await lists.deleteMany(ownerFilter(owner))).deletedCount ?? 0,
			/** @param {string} tokenHash */
			byShare: async (tokenHash) => strip(await lists.findOne({ websiteId, 'share.tokenHash': tokenHash })),
			/**
			 * Customer lists holding an item whose owner opted in to signals.
			 * @param {string} itemId
			 * @param {number} limit
			 */
			optedInWith: async (itemId, limit) =>
				(
					await lists
						.find({ websiteId, 'items.itemId': itemId, notify: true, ownerKind: 'customer' }, { sort: { id: 1 }, limit })
						.toArray()
				).map(strip),
			/**
			 * Set fields on every entry of an item (latest price, stock) across all lists.
			 * @param {{ itemId: string, variantId: string | null }} item a variant change touches that variant and variant-less entries
			 * @param {Record<string, unknown>} fields entry field → value
			 */
			setOnEntries: async ({ itemId, variantId }, fields) => {
				const set = Object.fromEntries(Object.entries(fields).map(([key, value]) => [`items.$[e].${key}`, value]));
				const filter =
					variantId === null ? { 'e.itemId': itemId } : { 'e.itemId': itemId, 'e.variantId': { $in: [variantId, null] } };
				const result = await lists.updateMany(
					{ websiteId, 'items.itemId': itemId },
					{ $set: set },
					{ arrayFilters: [filter] },
				);
				return result.modifiedCount ?? 0;
			},
			/**
			 * Mark entries as signaled (cool-down, reference price).
			 * @param {string} listId
			 * @param {string[]} entryIds
			 * @param {Record<string, unknown>} fields
			 */
			markEntries: async (listId, entryIds, fields) => {
				const set = Object.fromEntries(Object.entries(fields).map(([key, value]) => [`items.$[e].${key}`, value]));
				await lists.updateOne({ websiteId, id: listId }, { $set: set }, { arrayFilters: [{ 'e.id': { $in: entryIds } }] });
			},
			/** Counts for the dashboard. */
			stats: async () => {
				const [row] = await lists
					.aggregate([
						{ $match: { websiteId } },
						{
							$group: {
								_id: null,
								lists: { $sum: 1 },
								customerLists: { $sum: { $cond: [{ $eq: ['$ownerKind', 'customer'] }, 1, 0] } },
								guestLists: { $sum: { $cond: [{ $eq: ['$ownerKind', 'guest'] }, 1, 0] } },
								items: { $sum: { $size: { $ifNull: ['$items', []] } } },
								optedIn: { $sum: { $cond: ['$notify', 1, 0] } },
								shared: { $sum: { $cond: [{ $eq: [{ $type: '$share.tokenHash' }, 'string'] }, 1, 0] } },
							},
						},
					])
					.toArray();
				return {
					lists: row?.lists ?? 0,
					customerLists: row?.customerLists ?? 0,
					guestLists: row?.guestLists ?? 0,
					items: row?.items ?? 0,
					optedIn: row?.optedIn ?? 0,
					shared: row?.shared ?? 0,
				};
			},
			/**
			 * The most saved items.
			 * @param {number} limit
			 */
			topItems: async (limit) =>
				(
					await lists
						.aggregate([
							{ $match: { websiteId } },
							{ $unwind: '$items' },
							{
								$group: {
									_id: '$items.itemId',
									saves: { $sum: 1 },
									title: { $first: '$items.title' },
								},
							},
							{ $sort: { saves: -1, _id: 1 } },
							{ $limit: limit },
						])
						.toArray()
				).map((/** @type {any} */ row) => ({ itemId: row._id, title: row.title ?? null, saves: row.saves })),
		}),
		stock: Object.freeze({
			/** @param {string} itemKey */
			get: async (itemKey) => strip(await stock.findOne({ websiteId, itemKey })),
			/**
			 * @param {string} itemKey
			 * @param {Record<string, unknown>} set
			 */
			put: async (itemKey, set) => {
				await stock.updateOne(
					{ websiteId, itemKey },
					{ $set: { ...set, at: iso() }, $setOnInsert: { ...stamp, schemaVersion: SCHEMA_VERSION } },
					{ upsert: true },
				);
			},
		}),
		notifications: Object.freeze({
			/**
			 * Record a signal under a unique key (first write wins): true when this call recorded it.
			 * @param {Record<string, unknown> & { key: string }} record
			 */
			record: async (record) => {
				const result = await notifications.updateOne(
					{ websiteId, key: record.key },
					{ $setOnInsert: { ...stamp, schemaVersion: SCHEMA_VERSION, ...record } },
					{ upsert: true },
				);
				return (result.upsertedCount ?? 0) > 0;
			},
			/**
			 * Newest first, from a compound cursor `[at, id]`.
			 * @param {{ after?: unknown, fetchLimit: number }} query
			 */
			page: async ({ after, fetchLimit }) => {
				const [at, id] = Array.isArray(after) ? after : [];
				const range =
					typeof at === 'string' && typeof id === 'string' ? { $or: [{ at: { $lt: at } }, { at, id: { $lt: id } }] } : {};
				return (
					await notifications.find({ websiteId, ...range }, { sort: { at: -1, id: -1 }, limit: fetchLimit }).toArray()
				).map(strip);
			},
			/** @param {string} ownerId */
			ofOwner: async (ownerId) => (await notifications.find({ websiteId, ownerId }, { limit: 10_000 }).toArray()).map(strip),
			/** @param {string} ownerId */
			removeOwner: async (ownerId) => (await notifications.deleteMany({ websiteId, ownerId })).deletedCount ?? 0,
		}),
	});
};

/** @typedef {ReturnType<typeof createRepositories>} Repositories */

/**
 * Repositories of a website through app-kit (`data.forWebsite`), stamped with the merchant and environment.
 * @param {{ data: { forWebsite: (websiteId: string, stamp?: { merchantId?: string, env?: string }) => Promise<Scope> | Scope } }} product
 * @param {{ now?: () => number }} [options]
 */
export const repositoriesFor =
	(product, { now = Date.now } = {}) =>
	/**
	 * @param {string} websiteId
	 * @param {{ merchantId?: string, env?: string }} [stamp]
	 */
	async (websiteId, stamp = {}) =>
		createRepositories(await product.data.forWebsite(websiteId, stamp), { now, stamp });
