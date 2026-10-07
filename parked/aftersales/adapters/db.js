/**
 * Repositories over the merchant's own database (Part E §7), reached through app-kit `data.forWebsite(websiteId)`:
 * collections are prefixed `ss_aftersales_`, every query pins `websiteId` (app-kit's tenant guard rejects any that does
 * not) and inserts are stamped with `websiteId`, `merchantId`, `env`, `createdAt`, `updatedAt` and `schemaVersion`.
 *
 * - `purchases`: what customers bought and may claim against (from order events or the API), one per order.
 * - `claims`: claims with their lines, photos, history, notes, refunds and restock decisions.
 * - `messages`: the customer–staff conversation of each claim.
 * - `photos`: upload slots in the merchant's bucket; pending ones expire (TTL).
 * - `serials`: units by serial number across orders.
 * - `grades`: the Grades tier of items and variants (from `grades.tier_assigned@1`).
 * - `stock`: the last known on-hand quantity per item / variant (from `inventory.changed@1`), for restock events.
 * - `restocks`: one record per restocked claim line (unique: the exactly-once guard).
 * - `refunds`: every refund recorded on a claim.
 * @module
 */

export const SCHEMA_VERSION = 1;

/**
 * Index definitions (websiteId first everywhere except TTL), created idempotently by app-kit on first use.
 * @type {Array<{ collection: string, keys: Record<string, 1 | -1>, name: string, unique?: boolean, expireAfterSeconds?: number,
 *   partialFilterExpression?: Record<string, unknown> }>}
 */
export const INDEXES = [
	{ collection: 'purchases', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{
		collection: 'purchases',
		keys: { websiteId: 1, orderId: 1 },
		name: 'website_order',
		unique: true,
		partialFilterExpression: { orderId: { $type: 'string' } },
	},
	{ collection: 'purchases', keys: { websiteId: 1, number: 1 }, name: 'website_number' },
	{ collection: 'purchases', keys: { websiteId: 1, customerKeys: 1, placedAt: -1, id: -1 }, name: 'website_customer' },
	{ collection: 'purchases', keys: { websiteId: 1, placedAt: -1, id: -1 }, name: 'website_time' },
	{ collection: 'claims', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{ collection: 'claims', keys: { websiteId: 1, status: 1, submittedAt: -1, id: -1 }, name: 'website_status_time' },
	{ collection: 'claims', keys: { websiteId: 1, submittedAt: -1, id: -1 }, name: 'website_time' },
	{ collection: 'claims', keys: { websiteId: 1, purchaseId: 1, submittedAt: -1 }, name: 'website_purchase' },
	{ collection: 'claims', keys: { websiteId: 1, customerKeys: 1, submittedAt: -1, id: -1 }, name: 'website_customer' },
	{ collection: 'claims', keys: { websiteId: 1, 'lines.serial': 1 }, name: 'website_serial' },
	{ collection: 'claims', keys: { websiteId: 1, dueAt: 1 }, name: 'website_due' },
	{ collection: 'messages', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{ collection: 'messages', keys: { websiteId: 1, claimId: 1, at: 1, id: 1 }, name: 'website_claim_time' },
	{ collection: 'photos', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{
		collection: 'photos',
		keys: { purgeAt: 1 },
		name: 'pending_expiry',
		expireAfterSeconds: 0,
		partialFilterExpression: { status: 'pending' },
	},
	{ collection: 'serials', keys: { websiteId: 1, key: 1, ref: 1 }, name: 'website_key_ref', unique: true },
	{ collection: 'serials', keys: { websiteId: 1, key: 1, soldAt: -1 }, name: 'website_key_time' },
	{ collection: 'serials', keys: { websiteId: 1, purchaseId: 1 }, name: 'website_purchase' },
	{ collection: 'serials', keys: { websiteId: 1, registeredAt: -1, id: -1 }, name: 'website_time' },
	{ collection: 'grades', keys: { websiteId: 1, itemId: 1, variant: 1 }, name: 'website_item_variant', unique: true },
	{ collection: 'stock', keys: { websiteId: 1, itemId: 1, variant: 1 }, name: 'website_item_variant', unique: true },
	{ collection: 'restocks', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{ collection: 'restocks', keys: { websiteId: 1, at: -1, id: -1 }, name: 'website_time' },
	{ collection: 'refunds', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{ collection: 'refunds', keys: { websiteId: 1, claimId: 1, at: -1 }, name: 'website_claim' },
	{ collection: 'refunds', keys: { websiteId: 1, at: -1, id: -1 }, name: 'website_time' },
];

/**
 * Lazy, versioned migrations (app-kit runs them once per website under a lock).
 * @type {Array<{ version: number, name: string, up: (scope: any) => Promise<void> }>}
 */
export const MIGRATIONS = [];

/** Fields the repositories never return. */
const INTERNAL = new Set(['_id', 'websiteId', 'merchantId', 'env', 'schemaVersion', 'createdAt', 'updatedAt', 'purgeAt']);

/**
 * @param {Record<string, any> | null} doc
 * @returns {any}
 */
const strip = (doc) => (doc ? Object.fromEntries(Object.entries(doc).filter(([key]) => !INTERNAL.has(key))) : null);

/** @param {unknown} error */
export const isDuplicateKey = (error) => /** @type {{ code?: number }} */ (error)?.code === 11000;

/**
 * Keyset filter on `(field, id)` descending: documents strictly after the cursor `[value, id]`.
 * @param {string} field
 * @param {unknown} after
 * @param {1 | -1} [direction]
 * @returns {Record<string, unknown>}
 */
const keyset = (field, after, direction = -1) => {
	if (!Array.isArray(after) || after.length !== 2) return {};
	const [value, id] = after;
	const op = direction === -1 ? '$lt' : '$gt';
	return { $or: [{ [field]: { [op]: value } }, { [field]: value, id: { [op]: id } }] };
};

/**
 * @typedef {object} Scope app-kit website data scope (guarded collections)
 * @property {string} websiteId
 * @property {(name: string) => any} collection
 */

/**
 * Repositories of one website.
 * @param {Scope} scope
 * @param {{ stamp?: { merchantId?: string, env?: string } }} [options] `stamp` is added to upserted documents
 *   (app-kit stamps plain inserts itself)
 */
export const createRepositories = (scope, { stamp = {} } = {}) => {
	const { websiteId } = scope;
	const purchases = scope.collection('purchases');
	const claims = scope.collection('claims');
	const messages = scope.collection('messages');
	const photos = scope.collection('photos');
	const serials = scope.collection('serials');
	const grades = scope.collection('grades');
	const stock = scope.collection('stock');
	const restocks = scope.collection('restocks');
	const refunds = scope.collection('refunds');
	/** @param {Record<string, unknown>} doc */
	const onInsert = (doc) => ({ ...doc, websiteId, ...stamp, schemaVersion: SCHEMA_VERSION });
	/** @param {any} cursor */
	const all = async (cursor) => (await cursor.toArray()).map(strip);

	return Object.freeze({
		purchases: Object.freeze({
			/** @param {string} id */
			get: async (id) => strip(await purchases.findOne({ websiteId, id })),
			/** @param {string} orderId */
			byOrder: async (orderId) => strip(await purchases.findOne({ websiteId, orderId })),
			/**
			 * Purchases of an order number or id (guest access), newest first.
			 * @param {{ number: string | null, orderId: string | null }} query
			 */
			forAccess: async ({ number, orderId }) =>
				all(purchases.find({ websiteId, ...(orderId ? { orderId } : { number }) }, { sort: { placedAt: -1 }, limit: 5 })),
			/**
			 * Create or update the purchase of an order (one per order id).
			 * @param {string} orderId
			 * @param {{ insert: Record<string, unknown>, set: Record<string, unknown> }} change
			 */
			upsertOrder: async (orderId, { insert, set }) =>
				strip(
					await purchases.findOneAndUpdate(
						{ websiteId, orderId },
						{ $setOnInsert: onInsert({ ...insert, orderId }), ...(Object.keys(set).length > 0 ? { $set: set } : {}) },
						{ upsert: true, returnDocument: 'after' },
					),
				),
			/**
			 * Insert a purchase (false when one with this id exists).
			 * @param {Record<string, unknown>} doc
			 */
			insert: async (doc) => {
				try {
					await purchases.insertOne(doc);
					return true;
				} catch (error) {
					if (isDuplicateKey(error)) return false;
					throw error;
				}
			},
			/** @param {string} id @param {Record<string, unknown>} set */
			update: async (id, set) => {
				await purchases.updateOne({ websiteId, id }, { $set: set });
			},
			/**
			 * Newest first.
			 * @param {{ customerKey?: string, orderId?: string, after?: unknown, fetchLimit: number }} query
			 */
			list: async ({ customerKey, orderId, after = null, fetchLimit }) =>
				all(
					purchases.find(
						{
							websiteId,
							...(customerKey ? { customerKeys: customerKey } : {}),
							...(orderId ? { orderId } : {}),
							...keyset('placedAt', after),
						},
						{ sort: { placedAt: -1, id: -1 }, limit: fetchLimit },
					),
				),
			/**
			 * Lines refunded outside after-sales, applied once per event.
			 * @param {string} id
			 * @param {string} eventId
			 * @param {Array<Record<string, unknown>>} lines the purchase lines with refunded quantities
			 */
			applyRefundEvent: async (id, eventId, lines) => {
				const result = await purchases.updateOne(
					{ websiteId, id, refundEvents: { $ne: eventId } },
					{ $set: { lines }, $push: { refundEvents: { $each: [eventId], $slice: -100 } } },
				);
				return (result.modifiedCount ?? 0) > 0;
			},
			/** @param {string} id @param {number} amount */
			addRefunded: async (id, amount) => {
				await purchases.updateOne({ websiteId, id }, { $inc: { refundedAmount: amount } });
			},
		}),

		claims: Object.freeze({
			/** @param {Record<string, unknown>} doc */
			insert: async (doc) => {
				try {
					await claims.insertOne(doc);
					return true;
				} catch (error) {
					if (isDuplicateKey(error)) return false;
					throw error;
				}
			},
			/** @param {string} id */
			get: async (id) => strip(await claims.findOne({ websiteId, id })),
			/**
			 * Newest first (oldest first for the queue's `oldest` sort).
			 * @param {{ statuses?: string[], type?: string, purchaseId?: string, customerKey?: string, assignee?: string,
			 *   after?: unknown, fetchLimit: number, oldest?: boolean }} query
			 */
			list: async ({ statuses, type, purchaseId, customerKey, assignee, after = null, fetchLimit, oldest = false }) => {
				const direction = oldest ? 1 : -1;
				return all(
					claims.find(
						{
							websiteId,
							...(statuses ? { status: { $in: statuses } } : {}),
							...(type ? { type } : {}),
							...(purchaseId ? { purchaseId } : {}),
							...(customerKey ? { customerKeys: customerKey } : {}),
							...(assignee ? { assignee } : {}),
							...keyset('submittedAt', after, direction),
						},
						{ sort: { submittedAt: direction, id: direction }, limit: fetchLimit },
					),
				);
			},
			/** @param {string} purchaseId */
			forPurchase: async (purchaseId) =>
				all(claims.find({ websiteId, purchaseId }, { sort: { submittedAt: -1 }, limit: 500 })),
			/** @param {string} serial registry key */
			forSerial: async (serial) =>
				all(claims.find({ websiteId, 'lines.serial': serial }, { sort: { submittedAt: -1 }, limit: 20 })),
			/**
			 * Claims of a customer in one of the statuses (limits).
			 * @param {string} customerKey
			 * @param {string[]} statuses
			 */
			countFor: async (customerKey, statuses) =>
				claims.countDocuments({ websiteId, customerKeys: customerKey, status: { $in: statuses } }),
			/**
			 * Move a claim from `from` (compare-and-set) and append the history entry.
			 * @param {string} id
			 * @param {string} from
			 * @param {Record<string, unknown>} set
			 * @param {Record<string, unknown>} entry
			 */
			transition: async (id, from, set, entry) =>
				strip(
					await claims.findOneAndUpdate(
						{ websiteId, id, status: from },
						{ $set: set, $push: { history: entry } },
						{ returnDocument: 'after' },
					),
				),
			/**
			 * Append a note while the claim has fewer than `max`.
			 * @param {string} id
			 * @param {Record<string, unknown>} note
			 * @param {number} max
			 */
			addNote: async (id, note, max) =>
				strip(
					await claims.findOneAndUpdate(
						{ websiteId, id, [`notes.${max - 1}`]: { $exists: false } },
						{ $push: { notes: note }, $set: { updatedAt: note.at } },
						{ returnDocument: 'after' },
					),
				),
			/** @param {string} id @param {string | null} assignee @param {string} at */
			assign: async (id, assignee, at) =>
				strip(
					await claims.findOneAndUpdate(
						{ websiteId, id },
						{ $set: { assignee, updatedAt: at } },
						{ returnDocument: 'after' },
					),
				),
			/**
			 * Record a refund once, only while the refunded amount is still `expected` (compare-and-set).
			 * @param {string} id
			 * @param {Record<string, any> & { id: string, amount: number }} refund
			 * @param {number} expected
			 */
			addRefund: async (id, refund, expected) =>
				strip(
					await claims.findOneAndUpdate(
						{ websiteId, id, refundedAmount: expected, 'refunds.id': { $ne: refund.id } },
						{ $push: { refunds: refund }, $inc: { refundedAmount: refund.amount }, $set: { updatedAt: refund.at } },
						{ returnDocument: 'after' },
					),
				),
			/**
			 * Decide a line's restock once (true when this call decided it).
			 * @param {string} id
			 * @param {string} lineId
			 * @param {boolean} restock
			 * @param {string} at
			 */
			decideRestock: async (id, lineId, restock, at) => {
				const result = await claims.updateOne(
					{ websiteId, id, lines: { $elemMatch: { lineId, restock: null } } },
					{ $set: { 'lines.$.restock': restock, 'lines.$.restockedAt': at, updatedAt: at } },
				);
				return (result.modifiedCount ?? 0) > 0;
			},
			/** Claims per status. @returns {Promise<Record<string, number>>} */
			countByStatus: async () => {
				const rows = await claims
					.aggregate([{ $match: { websiteId } }, { $group: { _id: '$status', count: { $sum: 1 } } }])
					.toArray();
				return Object.fromEntries(rows.map((/** @type {{ _id: string, count: number }} */ row) => [row._id, row.count]));
			},
			/** Claims past their first-response due time. @param {string} now ISO */
			countOverdue: async (now) => claims.countDocuments({ websiteId, dueAt: { $lt: now } }),
		}),

		messages: Object.freeze({
			/** @param {Record<string, unknown>} doc */
			insert: async (doc) => {
				try {
					await messages.insertOne(doc);
					return true;
				} catch (error) {
					if (isDuplicateKey(error)) return false;
					throw error;
				}
			},
			/** @param {string} id */
			get: async (id) => strip(await messages.findOne({ websiteId, id })),
			/**
			 * Oldest first.
			 * @param {string} claimId
			 * @param {{ after?: unknown, fetchLimit: number }} page
			 */
			list: async (claimId, { after = null, fetchLimit }) =>
				all(messages.find({ websiteId, claimId, ...keyset('at', after, 1) }, { sort: { at: 1, id: 1 }, limit: fetchLimit })),
			/** @param {string} claimId */
			count: async (claimId) => messages.countDocuments({ websiteId, claimId }),
			/** @param {string} id @param {boolean} notified */
			setNotified: async (id, notified) => {
				await messages.updateOne({ websiteId, id }, { $set: { notified } });
			},
		}),

		photos: Object.freeze({
			/** @param {Record<string, unknown>} doc */
			insert: async (doc) => {
				await photos.updateOne({ websiteId, id: doc.id }, { $setOnInsert: onInsert(doc) }, { upsert: true });
			},
			/** @param {string} id */
			get: async (id) => strip(await photos.findOne({ websiteId, id })),
			/**
			 * Attach pending photos to a claim (they stop expiring).
			 * @param {string[]} ids
			 * @param {string} claimId
			 */
			attach: async (ids, claimId) => {
				await photos.updateMany(
					{ websiteId, id: { $in: ids }, status: 'pending' },
					{ $set: { status: 'attached', claimId }, $unset: { purgeAt: '' } },
				);
			},
		}),

		serials: Object.freeze({
			/**
			 * Register a unit (one record per serial and order or purchase; a repeat refreshes it).
			 * @param {Record<string, any> & { key: string, ref: string }} doc
			 */
			upsert: async (doc) => {
				const { id, registeredAt, ...rest } = doc;
				await serials.updateOne(
					{ websiteId, key: doc.key, ref: doc.ref },
					{ $setOnInsert: onInsert({ id, registeredAt }), $set: rest },
					{ upsert: true },
				);
				return strip(await serials.findOne({ websiteId, key: doc.key, ref: doc.ref }));
			},
			/** Units with this key, most recently sold first. @param {string} key */
			find: async (key) => all(serials.find({ websiteId, key }, { sort: { soldAt: -1 }, limit: 10 })),
			/** @param {string} purchaseId */
			forPurchase: async (purchaseId) => all(serials.find({ websiteId, purchaseId }, { limit: 1000 })),
			/**
			 * Newest first.
			 * @param {{ orderId?: string, itemId?: string, after?: unknown, fetchLimit: number }} query
			 */
			list: async ({ orderId, itemId, after = null, fetchLimit }) =>
				all(
					serials.find(
						{
							websiteId,
							...(orderId ? { orderId } : {}),
							...(itemId ? { itemId } : {}),
							...keyset('registeredAt', after),
						},
						{ sort: { registeredAt: -1, id: -1 }, limit: fetchLimit },
					),
				),
		}),

		grades: Object.freeze({
			/**
			 * The tier of an item or variant (null removes it).
			 * @param {string} itemId
			 * @param {string | null} variantId
			 * @param {string | null} tier
			 */
			set: async (itemId, variantId, tier) => {
				const variant = variantId ?? '';
				if (tier === null) await grades.deleteOne({ websiteId, itemId, variant });
				else
					await grades.updateOne(
						{ websiteId, itemId, variant },
						{ $set: { tier }, $setOnInsert: onInsert({ itemId, variant }) },
						{ upsert: true },
					);
			},
			/**
			 * The variant's tier, else the item's.
			 * @param {string} itemId
			 * @param {string | null} variantId
			 * @returns {Promise<string | null>}
			 */
			of: async (itemId, variantId) => {
				const rows = await grades.find({ websiteId, itemId, variant: { $in: [variantId ?? '', ''] } }).toArray();
				const exact = rows.find((/** @type {any} */ row) => row.variant === (variantId ?? ''));
				return (exact ?? rows[0])?.tier ?? null;
			},
		}),

		stock: Object.freeze({
			/**
			 * @param {string} itemId
			 * @param {string | null} variantId
			 * @param {{ quantity: number, available: number | null, at: string }} level
			 */
			set: async (itemId, variantId, level) => {
				await stock.updateOne(
					{ websiteId, itemId, variant: variantId ?? '' },
					{ $set: level, $setOnInsert: onInsert({ itemId, variant: variantId ?? '' }) },
					{ upsert: true },
				);
			},
			/**
			 * @param {string} itemId
			 * @param {string | null} variantId
			 * @returns {Promise<{ quantity: number, available: number | null } | null>}
			 */
			get: async (itemId, variantId) => {
				const doc = await stock.findOne({ websiteId, itemId, variant: variantId ?? '' });
				return doc ? { quantity: doc.quantity, available: doc.available ?? null } : null;
			},
		}),

		restocks: Object.freeze({
			/**
			 * Record a restocked line once (false when it was already recorded).
			 * @param {Record<string, unknown> & { id: string }} doc
			 */
			insert: async (doc) => {
				try {
					await restocks.insertOne(doc);
					return true;
				} catch (error) {
					if (isDuplicateKey(error)) return false;
					throw error;
				}
			},
			/** @param {string} id @param {Record<string, unknown>} set */
			update: async (id, set) => {
				await restocks.updateOne({ websiteId, id }, { $set: set });
			},
			/**
			 * Newest first.
			 * @param {{ claimId?: string, after?: unknown, fetchLimit: number }} query
			 */
			list: async ({ claimId, after = null, fetchLimit }) =>
				all(
					restocks.find(
						{ websiteId, ...(claimId ? { claimId } : {}), ...keyset('at', after) },
						{ sort: { at: -1, id: -1 }, limit: fetchLimit },
					),
				),
		}),

		refunds: Object.freeze({
			/** @param {Record<string, unknown> & { id: string }} doc */
			insert: async (doc) => {
				await refunds.updateOne({ websiteId, id: doc.id }, { $setOnInsert: onInsert(doc) }, { upsert: true });
			},
			/** @param {string} id @param {Record<string, unknown>} set */
			update: async (id, set) => {
				await refunds.updateOne({ websiteId, id }, { $set: set });
			},
			/**
			 * Newest first.
			 * @param {{ claimId?: string, after?: unknown, fetchLimit: number }} query
			 */
			list: async ({ claimId, after = null, fetchLimit }) =>
				all(
					refunds.find(
						{ websiteId, ...(claimId ? { claimId } : {}), ...keyset('at', after) },
						{ sort: { at: -1, id: -1 }, limit: fetchLimit },
					),
				),
			/** Total refunded per currency. @returns {Promise<Record<string, number>>} */
			totals: async () => {
				const rows = await refunds
					.aggregate([{ $match: { websiteId } }, { $group: { _id: '$currency', amount: { $sum: '$amount' } } }])
					.toArray();
				return Object.fromEntries(rows.map((/** @type {{ _id: string, amount: number }} */ row) => [row._id, row.amount]));
			},
		}),
	});
};

/** @typedef {ReturnType<typeof createRepositories>} Repositories */

/**
 * Repositories for a website through app-kit (indexes and migrations are applied by app-kit on first use).
 * @param {{ data: { forWebsite: (websiteId: string, stamp?: { merchantId?: string, env?: string }) => Promise<Scope> } }} product
 * @returns {(websiteId: string, stamp?: { merchantId?: string, env?: string }) => Promise<Repositories>}
 */
export const repositoriesFor =
	(product) =>
	async (websiteId, stamp = {}) =>
		createRepositories(await product.data.forWebsite(websiteId, stamp), { stamp });
