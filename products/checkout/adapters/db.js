/**
 * Repositories over the merchant's own database (Part E §7), reached through app-kit `data.forWebsite(websiteId)`:
 * collections are prefixed `ss_checkout_`, every query pins `websiteId` (app-kit's tenant guard refuses any that does
 * not) and inserts are stamped with `websiteId`, `merchantId`, `env`, `createdAt`, `updatedAt` and `schemaVersion`.
 *
 * Concurrency:
 * - stock is a conditional `$inc` (`available >= quantity` in the filter), so two checkouts racing for the last unit
 *   cannot both win; placement runs the decrements and the order insert in one transaction, or — on a database without
 *   transactions — in sequence with compensation (api/placement.js);
 * - carts and orders move by compare-and-set (`version`, `status` in the filter);
 * - an order's idempotency key and number are unique indexes, so a parallel duplicate surfaces as a duplicate key.
 *
 * - `items`: sellable items and variants (`available` = tracked stock, null = untracked).
 * - `carts`: carts and their priced lines.
 * - `orders`: placed orders with their totals snapshot, payments, refunds, proofs and timeline.
 * - `counters`: order number sequences.
 * - `addresses`: saved addresses of signed-in shoppers (by identity subject).
 * - `blocks`: shoppers who may not order (subject, e-mail, phone).
 * - `settings`: the sealed server key Checkout uses to call the merchant's other products.
 * @module
 */

/** Schema version of documents written by this release. */
export const SCHEMA_VERSION = 1;

export const INDEXES = /** @type {any} */ ([
	{ collection: 'items', keys: { websiteId: 1, itemId: 1 }, name: 'website_item', unique: true },
	{ collection: 'carts', keys: { websiteId: 1, id: 1 }, name: 'website_cart', unique: true },
	{ collection: 'carts', keys: { websiteId: 1, customerId: 1, status: 1 }, name: 'website_customer_status' },
	{ collection: 'carts', keys: { websiteId: 1, status: 1, abandonedAt: 1, updatedAt: 1 }, name: 'website_abandoned' },
	{ collection: 'carts', keys: { expireAt: 1 }, name: 'carts_ttl', expireAfterSeconds: 0 },
	{ collection: 'orders', keys: { websiteId: 1, id: 1 }, name: 'website_order', unique: true },
	{ collection: 'orders', keys: { websiteId: 1, idempotencyKey: 1 }, name: 'website_idempotency', unique: true },
	{ collection: 'orders', keys: { websiteId: 1, number: 1 }, name: 'website_number', unique: true },
	{ collection: 'orders', keys: { websiteId: 1, status: 1, expiresAt: 1 }, name: 'website_status_expiry' },
	{ collection: 'orders', keys: { websiteId: 1, customerId: 1, status: 1 }, name: 'website_customer_order' },
	{ collection: 'orders', keys: { websiteId: 1, 'customer.email': 1, status: 1 }, name: 'website_email_status' },
	{ collection: 'orders', keys: { websiteId: 1, 'customer.phone': 1, status: 1 }, name: 'website_phone_status' },
	{ collection: 'orders', keys: { websiteId: 1, placedAt: -1, id: -1 }, name: 'website_placed' },
	{ collection: 'counters', keys: { websiteId: 1, name: 1 }, name: 'website_counter', unique: true },
	{ collection: 'addresses', keys: { websiteId: 1, customerId: 1, id: 1 }, name: 'website_customer_address', unique: true },
	{ collection: 'blocks', keys: { websiteId: 1, kind: 1, value: 1 }, name: 'website_block', unique: true },
	{ collection: 'blocks', keys: { websiteId: 1, id: 1 }, name: 'website_block_id', unique: true },
	{ collection: 'settings', keys: { websiteId: 1, name: 1 }, name: 'website_setting', unique: true },
]);

/** Fields the repositories never return. */
const INTERNAL = new Set(['_id', 'websiteId', 'merchantId', 'env', 'schemaVersion']);

/**
 * @param {Record<string, any> | null} doc
 * @returns {any}
 */
export const strip = (doc) => (doc ? Object.fromEntries(Object.entries(doc).filter(([key]) => !INTERNAL.has(key))) : null);

/** @param {unknown} error */
export const isDuplicateKey = (error) => /** @type {{ code?: number }} */ (error)?.code === 11000;

/**
 * True when the database cannot run multi-document transactions (a standalone server, not a replica set).
 * @param {unknown} error
 */
export const isTransactionUnsupported = (error) => {
	const e = /** @type {{ code?: number, codeName?: string, message?: string }} */ (error);
	return (
		e?.code === 20 ||
		e?.codeName === 'IllegalOperation' ||
		/Transaction numbers are only allowed|transactions are not supported/i.test(String(e?.message ?? ''))
	);
};

/**
 * @typedef {object} Scope app-kit website data scope
 * @property {string} websiteId
 * @property {(name: string) => any} collection
 * @property {<T>(fn: (session: any) => Promise<T>) => Promise<T>} transaction
 */

/**
 * Repositories of one website.
 * @param {Scope} scope
 * @param {{ now?: () => number, stamp?: Record<string, unknown> }} [options]
 */
export const createRepositories = (scope, { now = Date.now, stamp = {} } = {}) => {
	const { websiteId } = scope;
	const items = scope.collection('items');
	const carts = scope.collection('carts');
	const orders = scope.collection('orders');
	const counters = scope.collection('counters');
	const addresses = scope.collection('addresses');
	const blocks = scope.collection('blocks');
	const settings = scope.collection('settings');
	const at = () => new Date(now());
	/** @param {Record<string, unknown>} doc */
	const onInsert = (doc) => ({ ...stamp, createdAt: at(), schemaVersion: SCHEMA_VERSION, ...doc });
	/** @param {any} [session] */
	const opts = (session) => (session ? { session } : {});

	return Object.freeze({
		websiteId,
		transaction: scope.transaction,

		items: Object.freeze({
			/** @param {string} itemId @param {any} [session] */
			get: async (itemId, session) => strip(await items.findOne({ websiteId, itemId }, opts(session))),
			/** @param {string[]} ids */
			getMany: async (ids) =>
				ids.length === 0
					? []
					: (await items.find({ websiteId, itemId: { $in: ids } }, { limit: ids.length }).toArray()).map(strip),
			/** @param {import('../core/items.js').Item} item */
			put: async (item) => {
				await items.replaceOne({ websiteId, itemId: item.itemId }, { ...item }, { upsert: true });
				return item;
			},
			/** @param {string} itemId */
			remove: async (itemId) => (await items.deleteOne({ websiteId, itemId })).deletedCount === 1,
			/** @param {{ after: string | null, fetchLimit: number }} page */
			list: async ({ after, fetchLimit }) =>
				(
					await items
						.find({ websiteId, ...(after ? { itemId: { $gt: after } } : {}) }, { sort: { itemId: 1 }, limit: fetchLimit })
						.toArray()
				).map(strip),
			/**
			 * Take `quantity` of a tracked variant, only if that much is available (atomic). Untracked variants pass.
			 * @param {{ itemId: string, variantId: string, quantity: number }} line
			 * @param {any} [session]
			 * @returns {Promise<'taken' | 'untracked' | 'insufficient'>}
			 */
			take: async (line, session) => {
				const result = await items.updateOne(
					{
						websiteId,
						itemId: line.itemId,
						variants: { $elemMatch: { variantId: line.variantId, available: { $gte: line.quantity } } },
					},
					{ $inc: { 'variants.$.available': -line.quantity } },
					opts(session),
				);
				if (result.modifiedCount === 1) return 'taken';
				const doc = await items.findOne(
					{ websiteId, itemId: line.itemId, variants: { $elemMatch: { variantId: line.variantId, available: null } } },
					{ ...opts(session), projection: { _id: 1 } },
				);
				return doc ? 'untracked' : 'insufficient';
			},
			/**
			 * Give `quantity` back to a tracked variant.
			 * @param {{ itemId: string, variantId: string, quantity: number }} line
			 * @param {any} [session]
			 */
			give: async (line, session) =>
				(
					await items.updateOne(
						{
							websiteId,
							itemId: line.itemId,
							variants: { $elemMatch: { variantId: line.variantId, available: { $type: 'number' } } },
						},
						{ $inc: { 'variants.$.available': line.quantity } },
						opts(session),
					)
				).modifiedCount === 1,
		}),

		carts: Object.freeze({
			/** @param {string} id */
			get: async (id) => strip(await carts.findOne({ websiteId, id })),
			/** @param {Record<string, any>} cart */
			insert: async (cart) => {
				await carts.insertOne({ ...cart, version: 1 });
				return { ...cart, version: 1 };
			},
			/**
			 * Save a changed cart if nobody changed it since it was read.
			 * @param {Record<string, any>} cart
			 * @returns {Promise<Record<string, any> | null>}
			 */
			save: async (cart) => {
				const { version, id, ...fields } = cart;
				const rest = Object.fromEntries(
					Object.entries(fields).filter(([name]) => name !== 'createdAt' && name !== 'updatedAt'),
				);
				const result = await carts.updateOne({ websiteId, id, version }, { $set: { ...rest, version: version + 1 } });
				return result.modifiedCount === 1 ? { ...cart, version: version + 1, updatedAt: at() } : null;
			},
			/** @param {string} subject */
			openFor: async (subject) =>
				strip(await carts.findOne({ websiteId, customerId: subject, status: 'open' }, { sort: { updatedAt: -1 } })),
			/** @param {{ after: string | null, fetchLimit: number }} page */
			list: async ({ after, fetchLimit }) =>
				(
					await carts
						.find({ websiteId, ...(after ? { id: { $lt: after } } : {}) }, { sort: { id: -1 }, limit: fetchLimit })
						.toArray()
				).map(strip),
			/** @param {Date} before @param {number} limit */
			abandonable: async (before, limit) =>
				(
					await carts
						.find(
							{ websiteId, status: 'open', abandonedAt: null, updatedAt: { $lte: before }, 'lines.0': { $exists: true } },
							{ limit, sort: { updatedAt: 1 } },
						)
						.toArray()
				).map(strip),
			/** @param {string} id @param {Date} when */
			markAbandoned: async (id, when) =>
				(await carts.updateOne({ websiteId, id, abandonedAt: null }, { $set: { abandonedAt: when } })).modifiedCount === 1,
			/** @param {string} id @param {string} status @param {Record<string, unknown>} [set] */
			setStatus: async (id, status, set = {}) =>
				(await carts.updateOne({ websiteId, id, status: 'open' }, { $set: { status, ...set }, $inc: { version: 1 } }))
					.modifiedCount === 1,
		}),

		orders: Object.freeze({
			/** @param {Record<string, any>} order @param {any} [session] */
			insert: async (order, session) => {
				await orders.insertOne({ ...order }, opts(session));
				return order;
			},
			/** @param {string} id */
			get: async (id) => strip(await orders.findOne({ websiteId, id })),
			/** @param {string} key hashed idempotency key */
			byIdempotency: async (key) => strip(await orders.findOne({ websiteId, idempotencyKey: key })),
			/**
			 * Move an order by compare-and-set on its status.
			 * @param {string} id
			 * @param {readonly string[]} from
			 * @param {{ set?: Record<string, unknown>, push?: Record<string, unknown>, filter?: Record<string, unknown>, arrayFilters?: Record<string, unknown>[] }} change
			 * @returns {Promise<Record<string, any> | null>} the order after the change, null when it was not in `from`
			 */
			transition: async (id, from, { set = {}, push = {}, filter = {}, arrayFilters }) => {
				const each = Object.fromEntries(Object.entries(push).map(([key, value]) => [key, { $each: [value].flat() }]));
				const doc = await orders.findOneAndUpdate(
					{ websiteId, id, status: { $in: [...from] }, ...filter },
					{
						...(Object.keys(set).length > 0 ? { $set: set } : {}),
						...(Object.keys(each).length > 0 ? { $push: each } : {}),
					},
					{ returnDocument: 'after', ...(arrayFilters ? { arrayFilters } : {}) },
				);
				return strip(doc);
			},
			/**
			 * Unconfirmed orders held by any of these identifiers.
			 * @param {{ subject?: string | null, email?: string | null, phone?: string | null }} who
			 * @param {readonly string[]} statuses
			 */
			countOpen: async (who, statuses) => {
				const keys = /** @type {const} */ (['subject', 'email', 'phone']);
				let max = 0;
				for (const key of keys) {
					const value = who[key];
					if (!value) continue;
					const field = key === 'subject' ? 'customerId' : `customer.${key}`;
					max = Math.max(max, await orders.countDocuments({ websiteId, [field]: value, status: { $in: [...statuses] } }));
				}
				return max;
			},
			/** @param {readonly string[]} statuses @param {Date} before @param {number} limit */
			expiring: async (statuses, before, limit) =>
				(
					await orders
						.find(
							{ websiteId, status: { $in: [...statuses] }, expiresAt: { $lte: before } },
							{ limit, sort: { expiresAt: 1 } },
						)
						.toArray()
				).map(strip),
			/** @param {{ after: [string, string] | null, fetchLimit: number, status?: string | null, subject?: string | null }} page */
			list: async ({ after, fetchLimit, status = null, subject = null }) => {
				/** @type {Record<string, any>} */
				const filter = { websiteId, ...(status ? { status } : {}), ...(subject ? { customerId: subject } : {}) };
				if (after) {
					const placedAt = new Date(after[0]);
					filter.$or = [{ placedAt: { $lt: placedAt } }, { placedAt, id: { $lt: after[1] } }];
				}
				return (await orders.find(filter, { sort: { placedAt: -1, id: -1 }, limit: fetchLimit }).toArray()).map(strip);
			},
			/** @param {Date} since */
			summary: async (since) =>
				orders
					.aggregate([
						{ $match: { websiteId, placedAt: { $gte: since } } },
						{
							$group: {
								_id: { status: '$status', currency: '$currency' },
								count: { $sum: 1 },
								total: { $sum: '$totals.total' },
							},
						},
					])
					.toArray(),
		}),

		counters: Object.freeze({
			/** @param {string} name @returns {Promise<number>} */
			next: async (name) => {
				const doc = await counters.findOneAndUpdate(
					{ websiteId, name },
					{ $inc: { value: 1 }, $setOnInsert: onInsert({}) },
					{ upsert: true, returnDocument: 'after' },
				);
				return /** @type {number} */ (doc?.value);
			},
		}),

		addresses: Object.freeze({
			/** @param {string} subject */
			list: async (subject) =>
				(await addresses.find({ websiteId, customerId: subject }, { sort: { usedAt: -1 }, limit: 20 }).toArray()).map(strip),
			/**
			 * Save (or refresh) an address; keeps at most `max` per shopper, dropping the least recently used.
			 * @param {string} subject
			 * @param {{ id: string, address: Record<string, unknown> }} entry
			 * @param {number} max
			 */
			save: async (subject, entry, max) => {
				await addresses.updateOne(
					{ websiteId, customerId: subject, id: entry.id },
					{ $set: { address: entry.address, usedAt: at() }, $setOnInsert: onInsert({}) },
					{ upsert: true },
				);
				const extra = await addresses
					.find({ websiteId, customerId: subject }, { sort: { usedAt: -1 }, skip: max, projection: { id: 1 } })
					.toArray();
				if (extra.length > 0)
					await addresses.deleteMany({
						websiteId,
						customerId: subject,
						id: { $in: extra.map((/** @type {any} */ doc) => doc.id) },
					});
			},
			/** @param {string} subject @param {string} id */
			remove: async (subject, id) => (await addresses.deleteOne({ websiteId, customerId: subject, id })).deletedCount === 1,
		}),

		blocks: Object.freeze({
			/** @param {{ after: string | null, fetchLimit: number }} page */
			list: async ({ after, fetchLimit }) =>
				(
					await blocks
						.find({ websiteId, ...(after ? { id: { $gt: after } } : {}) }, { sort: { id: 1 }, limit: fetchLimit })
						.toArray()
				).map(strip),
			/** @param {{ id: string, kind: string, value: string, note: string | null }} block */
			insert: async (block) => {
				try {
					await blocks.insertOne({ ...block });
					return true;
				} catch (error) {
					if (isDuplicateKey(error)) return false;
					throw error;
				}
			},
			/** @param {string} id */
			remove: async (id) => (await blocks.deleteOne({ websiteId, id })).deletedCount === 1,
			/** @param {Array<{ kind: string, value: string }>} candidates */
			matches: async (candidates) =>
				candidates.length > 0 &&
				(await blocks.countDocuments({ websiteId, $or: candidates.map(({ kind, value }) => ({ kind, value })) })) > 0,
		}),

		settings: Object.freeze({
			/** @param {string} name */
			get: async (name) => strip(await settings.findOne({ websiteId, name })),
			/** @param {string} name @param {Record<string, unknown>} value */
			put: async (name, value) => {
				await settings.updateOne({ websiteId, name }, { $set: { value }, $setOnInsert: onInsert({}) }, { upsert: true });
			},
			/** @param {string} name */
			remove: async (name) => (await settings.deleteOne({ websiteId, name })).deletedCount === 1,
		}),
	});
};

/** @typedef {ReturnType<typeof createRepositories>} Repositories */

/**
 * Repositories of a website through app-kit (`data.forWebsite`, indexes applied lazily on first use).
 * @param {any} product app-kit product
 * @param {{ now?: () => number }} [options]
 */
export const repositoriesFor =
	(product, { now = Date.now } = {}) =>
	/**
	 * @param {string} websiteId
	 * @param {{ merchantId?: string, env?: string }} [stamp]
	 */
	async (websiteId, stamp = {}) =>
		createRepositories(await product.data.forWebsite(websiteId, stamp), {
			now,
			stamp: Object.fromEntries(Object.entries(stamp).filter(([, value]) => value !== undefined)),
		});
