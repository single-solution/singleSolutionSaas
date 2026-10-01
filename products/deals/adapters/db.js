/**
 * Repositories over the merchant's own database (Part E §7), reached through app-kit `data.forWebsite(websiteId)`:
 * collections are prefixed `ss_deals_`, every query pins `websiteId` (app-kit's tenant guard rejects any that does
 * not), and inserts are stamped with `websiteId`, `merchantId`, `env`, `createdAt`, `updatedAt` and `schemaVersion`.
 *
 * - `deals`: the website's deals (optimistic `version`; DELETE archives).
 * - `items`: the synced catalog mirror (API, `item.*`, `price.changed@1`, `inventory.changed@1`); soft-deleted.
 * - `quotes`: evaluated carts awaiting commit (TTL on `purgeAt`).
 * - `applications`: committed quotes (one per quote and per order) — the reporting ledger.
 * - `counters`: committed uses and units per deal (atomic, limit-guarded increments).
 * - `customer_usage`: committed uses per deal and customer (per-customer limits).
 * @module
 */

export const COLLECTIONS = Object.freeze({
	deals: 'deals',
	items: 'items',
	quotes: 'quotes',
	applications: 'applications',
	counters: 'counters',
	customerUsage: 'customer_usage',
});

/** Document schema version written by this release. */
export const SCHEMA_VERSION = 1;

/**
 * Index definitions (websiteId first everywhere; the TTL index is single-field), created idempotently by app-kit on
 * first use of a website.
 * @type {Array<{ collection: string, keys: Record<string, 1 | -1>, name: string, unique?: boolean, expireAfterSeconds?: number, partialFilterExpression?: Record<string, unknown> }>}
 */
export const INDEXES = /** @type {any} */ ([
	{ collection: 'deals', keys: { websiteId: 1, id: 1 }, name: 'website_deal', unique: true },
	{ collection: 'deals', keys: { websiteId: 1, status: 1, kind: 1 }, name: 'website_status_kind' },
	{ collection: 'items', keys: { websiteId: 1, itemId: 1 }, name: 'website_item', unique: true },
	{ collection: 'items', keys: { websiteId: 1, collections: 1 }, name: 'website_collections' },
	{ collection: 'items', keys: { websiteId: 1, brand: 1 }, name: 'website_brand' },
	{ collection: 'items', keys: { websiteId: 1, 'variants.variantId': 1 }, name: 'website_variant' },
	{ collection: 'quotes', keys: { websiteId: 1, id: 1 }, name: 'website_quote', unique: true },
	{ collection: 'quotes', keys: { purgeAt: 1 }, name: 'quote_ttl', expireAfterSeconds: 0 },
	{ collection: 'applications', keys: { websiteId: 1, quoteId: 1 }, name: 'website_application_quote', unique: true },
	{ collection: 'applications', keys: { websiteId: 1, orderId: 1 }, name: 'website_application_order', unique: true },
	{ collection: 'applications', keys: { websiteId: 1, committedAt: -1 }, name: 'website_application_time' },
	{ collection: 'applications', keys: { websiteId: 1, 'deals.dealId': 1, committedAt: -1 }, name: 'website_application_deal' },
	{ collection: 'counters', keys: { websiteId: 1, dealId: 1 }, name: 'website_counter', unique: true },
	{
		collection: 'customer_usage',
		keys: { websiteId: 1, dealId: 1, customerId: 1 },
		name: 'website_deal_customer',
		unique: true,
		// anonymised rows (customerId null) leave the uniqueness of identified customers
		partialFilterExpression: { customerId: { $type: 'string' } },
	},
	{ collection: 'customer_usage', keys: { websiteId: 1, customerId: 1 }, name: 'website_customer' },
]);

/**
 * Lazy, versioned migrations (app-kit runs them once per website under a lock).
 * @type {Array<{ version: number, name: string, up: (scope: any) => Promise<void> }>}
 */
export const MIGRATIONS = [
	{
		version: 1,
		name: 'deal_defaults',
		up: async (scope) => {
			await scope
				.collection(COLLECTIONS.deals)
				.updateMany({ websiteId: scope.websiteId, version: { $exists: false } }, { $set: { version: 1 } });
		},
	},
];

/** @typedef {Record<string, any>} Doc a stored document without internal fields */

/** Fields the repositories never return. */
const INTERNAL = new Set(['_id', 'websiteId', 'merchantId', 'env', 'schemaVersion']);

/**
 * @param {Record<string, any> | null} doc
 * @returns {Doc | null}
 */
export const strip = (doc) => (doc ? Object.fromEntries(Object.entries(doc).filter(([key]) => !INTERNAL.has(key))) : null);

/**
 * A copy without some keys.
 * @param {Record<string, any>} doc
 * @param {string[]} keys
 * @returns {Record<string, any>}
 */
export const omit = (doc, keys) => Object.fromEntries(Object.entries(doc).filter(([key]) => !keys.includes(key)));

/** @param {unknown} error */
export const isDuplicateKey = (error) => /** @type {{ code?: number }} */ (error)?.code === 11000;

/** @param {Date | string | null | undefined} value */
const iso = (value) => (value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : undefined);

/**
 * @typedef {object} Scope app-kit website data scope (guarded collections)
 * @property {string} websiteId
 * @property {(name: string) => any} collection
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
	const deals = scope.collection(COLLECTIONS.deals);
	const items = scope.collection(COLLECTIONS.items);
	const quotes = scope.collection(COLLECTIONS.quotes);
	const applications = scope.collection(COLLECTIONS.applications);
	const counters = scope.collection(COLLECTIONS.counters);
	const customerUsage = scope.collection(COLLECTIONS.customerUsage);
	/** Standard fields of a document created by an upsert. */
	const onInsert = () => ({ ...stamp, createdAt: new Date(now()), schemaVersion: SCHEMA_VERSION });
	/**
	 * @param {Record<string, any> | null} doc
	 * @returns {Doc | null}
	 */
	const toDeal = (doc) => {
		const out = strip(doc);
		if (!out) return null;
		return { ...out, createdAt: iso(out.createdAt), updatedAt: iso(out.updatedAt) };
	};
	/** @param {Record<string, any>} doc @returns {Doc} */
	const dealDoc = (doc) => /** @type {Doc} */ (toDeal(doc));
	/** @param {Record<string, any>} doc @returns {Doc} */
	const plain = (doc) => /** @type {Doc} */ (strip(doc));

	return Object.freeze({
		websiteId,
		deals: Object.freeze({
			/** @param {string} id @returns {Promise<Doc | null>} */
			get: async (id) => toDeal(await deals.findOne({ websiteId, id })),
			/**
			 * Page by id. `status` filters (default: not archived).
			 * @param {{ after?: string | null, fetchLimit: number, status?: string | null, kind?: string | null }} query
			 * @returns {Promise<Doc[]>}
			 */
			list: async ({ after = null, fetchLimit, status = null, kind = null }) =>
				(
					await deals
						.find({
							websiteId,
							...(status ? { status } : { status: { $ne: 'archived' } }),
							...(kind ? { kind } : {}),
							...(after ? { id: { $gt: after } } : {}),
						})
						.sort({ id: 1 })
						.limit(fetchLimit)
						.toArray()
				).map(dealDoc),
			/** Every deal that is not archived (the engine's input). @returns {Promise<Doc[]>} */
			live: async () =>
				(
					await deals
						.find({ websiteId, status: { $ne: 'archived' } })
						.sort({ id: 1 })
						.toArray()
				).map(dealDoc),
			/** @param {string[]} ids any status (locks of archived deals) @returns {Promise<Doc[]>} */
			byIds: async (ids) =>
				ids.length === 0 ? [] : (await deals.find({ websiteId, id: { $in: ids } }).toArray()).map(dealDoc),
			/** @param {string} kind */
			countOpen: (kind) => deals.countDocuments({ websiteId, kind, status: { $ne: 'archived' } }),
			/** @param {Record<string, any>} deal */
			insert: async (deal) => {
				await deals.insertOne({ ...deal });
			},
			/**
			 * Replace the editable fields when the stored version matches (optimistic concurrency).
			 * @param {Record<string, any>} deal the new state (its `version` is the expected stored version)
			 * @returns {Promise<boolean>}
			 */
			replace: async (deal) => {
				const { version, id } = deal;
				const fields = omit(deal, ['version', 'id', 'createdAt', 'updatedAt']);
				const result = await deals.updateOne({ websiteId, id, version }, { $set: { ...fields, version: version + 1 } });
				return (result.matchedCount ?? 0) > 0;
			},
		}),
		items: Object.freeze({
			/** @param {string} itemId @returns {Promise<Doc | null>} */
			get: async (itemId) => strip(await items.findOne({ websiteId, itemId, deletedAt: null })),
			/** @param {string[]} itemIds @returns {Promise<Doc[]>} */
			getMany: async (itemIds) =>
				itemIds.length === 0
					? []
					: (await items.find({ websiteId, itemId: { $in: [...new Set(itemIds)] }, deletedAt: null }).toArray()).map(plain),
			/**
			 * @param {{ after?: string | null, fetchLimit: number, filter?: Record<string, unknown>, inStock?: boolean }} query
			 * @returns {Promise<Doc[]>}
			 */
			list: async ({ after = null, fetchLimit, filter = {}, inStock = false }) => {
				const and = [
					...(Object.keys(filter).length > 0 ? [filter] : []),
					...(inStock ? [{ $or: [{ stock: null }, { stock: { $gt: 0 } }] }] : []),
					...(after ? [{ itemId: { $gt: after } }] : []),
				];
				const docs = await items
					.find({ websiteId, deletedAt: null, ...(and.length > 0 ? { $and: and } : {}) })
					.sort({ itemId: 1 })
					.limit(fetchLimit)
					.toArray();
				return docs.map(plain);
			},
			/**
			 * Upsert a full item (fields not sent keep their stored value only for stock/location data).
			 * @param {Record<string, any>} item normalised (core/validate.js#catalogItem)
			 */
			upsert: async (item) => {
				const { itemId, ...fields } = item;
				await items.updateOne(
					{ websiteId, itemId },
					{ $set: { ...fields, deletedAt: null }, $setOnInsert: { ...onInsert(), itemId } },
					{ upsert: true },
				);
			},
			/**
			 * Merge some fields (events carry partial data).
			 * @param {string} itemId
			 * @param {Record<string, any>} fields
			 */
			merge: async (itemId, fields) => {
				const defaults = Object.fromEntries(
					Object.entries({ collections: [], attributes: {}, variants: [] }).filter(([key]) => !(key in fields)),
				);
				await items.updateOne(
					{ websiteId, itemId },
					{ $set: { ...fields, deletedAt: null }, $setOnInsert: { ...onInsert(), itemId, ...defaults } },
					{ upsert: true },
				);
			},
			/**
			 * Price of an item or one of its variants (`price.changed@1`).
			 * @param {{ itemId: string, variantId?: string | null, amount: number, currency: string }} input
			 */
			setPrice: async ({ itemId, variantId = null, amount, currency }) => {
				if (variantId) {
					const result = await items.updateOne(
						{ websiteId, itemId, 'variants.variantId': variantId },
						{ $set: { 'variants.$.price': amount, currency } },
					);
					if ((result.matchedCount ?? 0) > 0) return;
					await items.updateOne(
						{ websiteId, itemId },
						{
							$push: { variants: { variantId, title: null, price: amount, cost: null, stock: null, attributes: {} } },
							$set: { currency },
							$setOnInsert: { ...onInsert(), itemId, collections: [], attributes: {}, deletedAt: null },
						},
						{ upsert: true },
					);
					return;
				}
				await items.updateOne(
					{ websiteId, itemId },
					{
						$set: { price: amount, currency },
						$setOnInsert: { ...onInsert(), itemId, collections: [], attributes: {}, variants: [], deletedAt: null },
					},
					{ upsert: true },
				);
			},
			/**
			 * Stock at one location (`inventory.changed@1`); the item's `stock` is the sum over locations.
			 * @param {{ itemId: string, variantId?: string | null, locationId?: string | null, quantity: number }} input
			 */
			setStock: async ({ itemId, variantId = null, locationId = null, quantity }) => {
				const doc = await items.findOne({ websiteId, itemId });
				const key = `${variantId ?? '_'}|${locationId ?? '_'}`;
				/** @type {Record<string, number>} */
				const locations = { ...(doc?.locations ?? {}), [key]: quantity };
				const sum = (/** @type {string | null} */ variant) =>
					Object.entries(locations)
						.filter(([k]) => variant === null || k.startsWith(`${variant}|`))
						.reduce((acc, [, q]) => acc + Math.max(0, q), 0);
				/** @type {Record<string, unknown>} */
				const set = { locations, stock: sum(null) };
				if (
					variantId &&
					Array.isArray(doc?.variants) &&
					doc.variants.some((/** @type {any} */ v) => v.variantId === variantId)
				)
					set.variants = doc.variants.map((/** @type {any} */ v) =>
						v.variantId === variantId ? { ...v, stock: sum(variantId) } : v,
					);
				await items.updateOne(
					{ websiteId, itemId },
					{
						$set: set,
						$setOnInsert: {
							...onInsert(),
							itemId,
							collections: [],
							attributes: {},
							...(set.variants ? {} : { variants: [] }),
							deletedAt: null,
						},
					},
					{ upsert: true },
				);
			},
			/**
			 * Soft delete.
			 * @param {string} itemId
			 * @returns {Promise<boolean>}
			 */
			remove: async (itemId) => {
				const result = await items.updateOne(
					{ websiteId, itemId, deletedAt: null },
					{ $set: { deletedAt: new Date(now()) } },
				);
				return (result.matchedCount ?? 0) > 0;
			},
		}),
		quotes: Object.freeze({
			/** @param {Record<string, any>} quote */
			insert: async (quote) => {
				await quotes.insertOne({ ...quote });
			},
			/** @param {string} id @returns {Promise<Doc | null>} */
			get: async (id) => strip(await quotes.findOne({ websiteId, id })),
			/**
			 * Claim an open quote for an order (single winner).
			 * @param {string} id
			 * @param {string} orderId
			 * @returns {Promise<boolean>}
			 */
			claim: async (id, orderId) => {
				const result = await quotes.updateOne({ websiteId, id, status: 'open' }, { $set: { status: 'committing', orderId } });
				return (result.matchedCount ?? 0) > 0;
			},
			/** @param {string} id @param {string} status */
			setStatus: async (id, status) => {
				await quotes.updateOne({ websiteId, id }, { $set: { status } });
			},
			countOpen: () => quotes.countDocuments({ websiteId, status: 'open', expiresAt: { $gt: new Date(now()) } }),
		}),
		applications: Object.freeze({
			/** @param {Record<string, any>} application */
			insert: async (application) => {
				try {
					await applications.insertOne({ ...application });
					return true;
				} catch (error) {
					if (isDuplicateKey(error)) return false;
					throw error;
				}
			},
			/** @param {string} orderId @returns {Promise<Doc | null>} */
			byOrder: async (orderId) => strip(await applications.findOne({ websiteId, orderId })),
			/** @param {string} quoteId @returns {Promise<Doc | null>} */
			byQuote: async (quoteId) => strip(await applications.findOne({ websiteId, quoteId })),
			/**
			 * Mark released (single winner).
			 * @param {string} quoteId
			 * @returns {Promise<boolean>}
			 */
			release: async (quoteId) => {
				const result = await applications.updateOne(
					{ websiteId, quoteId, status: 'committed' },
					{ $set: { status: 'released', releasedAt: new Date(now()) } },
				);
				return (result.matchedCount ?? 0) > 0;
			},
			/**
			 * Committed applications in a window (reporting).
			 * @param {{ from: Date, to: Date, dealId?: string | null }} query
			 */
			summary: async ({ from, to, dealId = null }) => {
				const match = {
					websiteId,
					status: 'committed',
					committedAt: { $gte: from, $lt: to },
					...(dealId ? { 'deals.dealId': dealId } : {}),
				};
				const [totals] = await applications
					.aggregate([
						{ $match: match },
						{
							$group: {
								_id: null,
								orders: { $sum: 1 },
								withDeals: { $sum: { $cond: [{ $gt: [{ $size: '$deals' }, 0] }, 1, 0] } },
								subtotal: { $sum: '$subtotal' },
								discount: { $sum: '$discountTotal' },
								subtotalWithDeals: { $sum: { $cond: [{ $gt: [{ $size: '$deals' }, 0] }, '$subtotal', 0] } },
								cost: { $sum: { $ifNull: ['$cost', 0] } },
								costKnown: { $sum: { $cond: [{ $eq: ['$costKnown', true] }, 1, 0] } },
							},
						},
					])
					.toArray();
				const byDeal = await applications
					.aggregate([
						{ $match: match },
						{ $unwind: '$deals' },
						...(dealId ? [{ $match: { 'deals.dealId': dealId } }] : []),
						{
							$group: {
								_id: '$deals.dealId',
								kind: { $first: '$deals.kind' },
								uses: { $sum: 1 },
								units: { $sum: '$deals.units' },
								discount: { $sum: '$deals.amount' },
								revenue: { $sum: '$total' },
							},
						},
						{ $sort: { discount: -1, _id: 1 } },
						{ $limit: 200 },
					])
					.toArray();
				return { totals: totals ?? null, byDeal };
			},
		}),
		counters: Object.freeze({
			/** @param {string[]} dealIds @returns {Promise<Record<string, { uses: number, units: number }>>} */
			forDeals: async (dealIds) => {
				if (dealIds.length === 0) return {};
				const docs = await counters.find({ websiteId, dealId: { $in: dealIds } }).toArray();
				return Object.fromEntries(docs.map((/** @type {any} */ d) => [d.dealId, { uses: d.uses ?? 0, units: d.units ?? 0 }]));
			},
			/**
			 * Count one use and `units`, unless that would exceed `totalUses` / `stockUnits`.
			 * @param {{ dealId: string, units: number, totalUses: number | null, stockUnits: number | null }} input
			 * @returns {Promise<{ ok: boolean, uses?: number, units?: number }>}
			 */
			increment: async ({ dealId, units, totalUses, stockUnits }) => {
				const filter = {
					websiteId,
					dealId,
					...(totalUses !== null ? { uses: { $lte: totalUses - 1 } } : {}),
					...(stockUnits !== null ? { units: { $lte: stockUnits - units } } : {}),
				};
				if ((totalUses !== null && totalUses < 1) || (stockUnits !== null && stockUnits < units)) return { ok: false };
				try {
					const doc = await counters.findOneAndUpdate(
						filter,
						{ $inc: { uses: 1, units }, $setOnInsert: { ...onInsert() } },
						{ upsert: true, returnDocument: 'after' },
					);
					return { ok: true, uses: doc?.uses ?? 1, units: doc?.units ?? units };
				} catch (error) {
					if (isDuplicateKey(error)) return { ok: false };
					throw error;
				}
			},
			/** @param {{ dealId: string, units: number }} input */
			decrement: async ({ dealId, units }) => {
				await counters.updateOne({ websiteId, dealId }, { $inc: { uses: -1, units: -units } });
			},
		}),
		customerUsage: Object.freeze({
			/** @param {string} customerId @param {string[]} dealIds @returns {Promise<Record<string, number>>} */
			forCustomer: async (customerId, dealIds) => {
				if (dealIds.length === 0) return {};
				const docs = await customerUsage.find({ websiteId, customerId, dealId: { $in: dealIds } }).toArray();
				return Object.fromEntries(docs.map((/** @type {any} */ d) => [d.dealId, d.uses ?? 0]));
			},
			/**
			 * @param {{ dealId: string, customerId: string, limit: number | null }} input
			 * @returns {Promise<boolean>}
			 */
			increment: async ({ dealId, customerId, limit }) => {
				if (limit !== null && limit < 1) return false;
				try {
					await customerUsage.updateOne(
						{ websiteId, dealId, customerId, ...(limit !== null ? { uses: { $lte: limit - 1 } } : {}) },
						{ $inc: { uses: 1 }, $setOnInsert: { ...onInsert() } },
						{ upsert: true },
					);
					return true;
				} catch (error) {
					if (isDuplicateKey(error)) return false;
					throw error;
				}
			},
			/** @param {{ dealId: string, customerId: string }} input */
			decrement: async ({ dealId, customerId }) => {
				await customerUsage.updateOne({ websiteId, dealId, customerId }, { $inc: { uses: -1 } });
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
