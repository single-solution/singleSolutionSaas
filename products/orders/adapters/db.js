/**
 * Repositories over the merchant's own database (Part E §7), reached through app-kit `data.forWebsite(websiteId)`:
 * collections are prefixed `ss_orders_`, every query pins `websiteId` (app-kit's tenant guard refuses any that does
 * not) and inserts are stamped with `websiteId`, `merchantId`, `env`, `createdAt`, `updatedAt` and `schemaVersion`.
 * Personal data (customer contact, addresses, message recipients) lives only here.
 *
 * - `orders`: one document per order with its lines, timeline, fulfilment, the append-only `payments` / `refunds`
 *   ledger with denormalised `paid` / `refunded` sums (guarded inside the same write, so a refund never exceeds what
 *   was received), risk flags and a transactional **outbox** (`pending`): the events and messages a change causes are
 *   pushed in the same single-document write, then delivered and pulled; the sweep job retries leftovers.
 * - `counters`: gap-free sequences (order and invoice numbers).
 * - `risk_profiles`: per customer key (customer id, subject, e-mail, phone digits): blocked flag and RTO count.
 * - `messages`: customer status messages (claim-before-send, retries).
 * @module
 */

export const COLLECTIONS = Object.freeze({
	orders: 'orders',
	counters: 'counters',
	profiles: 'risk_profiles',
	messages: 'messages',
});

/**
 * Index definitions (websiteId first everywhere), created idempotently by app-kit on first use.
 * @type {Array<{ collection: string, keys: Record<string, 1 | -1>, name: string, unique?: boolean, partialFilterExpression?: Record<string, unknown> }>}
 */
export const INDEXES = [
	{ collection: 'orders', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{ collection: 'orders', keys: { websiteId: 1, number: 1 }, name: 'website_number', unique: true },
	{
		collection: 'orders',
		keys: { websiteId: 1, source: 1, externalId: 1 },
		name: 'website_external',
		unique: true,
		partialFilterExpression: { externalId: { $type: 'string' } },
	},
	{
		collection: 'orders',
		keys: { websiteId: 1, invoiceNumber: 1 },
		name: 'website_invoice',
		unique: true,
		partialFilterExpression: { invoiceNumber: { $type: 'string' } },
	},
	{ collection: 'orders', keys: { websiteId: 1, placedAt: -1, id: -1 }, name: 'website_placed' },
	{ collection: 'orders', keys: { websiteId: 1, status: 1, placedAt: -1, id: -1 }, name: 'website_status' },
	{ collection: 'orders', keys: { websiteId: 1, customerKeys: 1, status: 1 }, name: 'website_customer_keys' },
	{ collection: 'orders', keys: { websiteId: 1, customerSubject: 1, placedAt: -1, id: -1 }, name: 'website_subject' },
	{ collection: 'orders', keys: { websiteId: 1, customerEmail: 1, placedAt: -1, id: -1 }, name: 'website_email' },
	{ collection: 'orders', keys: { websiteId: 1, customerPhone: 1, placedAt: -1, id: -1 }, name: 'website_phone' },
	{ collection: 'orders', keys: { websiteId: 1, 'lines.serials': 1 }, name: 'website_serials' },
	{ collection: 'orders', keys: { websiteId: 1, 'risk.review': 1, placedAt: -1 }, name: 'website_review' },
	{
		collection: 'orders',
		keys: { websiteId: 1, expiresAt: 1 },
		name: 'website_expiry',
		partialFilterExpression: { expiresAt: { $type: 'date' } },
	},
	{
		collection: 'orders',
		keys: { websiteId: 1, pendingAt: 1 },
		name: 'website_pending',
		partialFilterExpression: { pendingAt: { $type: 'date' } },
	},
	{ collection: 'counters', keys: { websiteId: 1, key: 1 }, name: 'website_key', unique: true },
	{ collection: 'risk_profiles', keys: { websiteId: 1, key: 1 }, name: 'website_key', unique: true },
	{ collection: 'risk_profiles', keys: { websiteId: 1, blocked: 1, updatedAt: -1 }, name: 'website_blocked' },
	{ collection: 'messages', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{ collection: 'messages', keys: { websiteId: 1, state: 1, nextAttemptAt: 1 }, name: 'website_due' },
	{ collection: 'messages', keys: { websiteId: 1, orderId: 1, createdAt: -1 }, name: 'website_order' },
	{ collection: 'messages', keys: { websiteId: 1, createdAt: -1, id: -1 }, name: 'website_created' },
];

/** @type {Array<{ version: number, name: string, up: (scope: any) => Promise<void> }>} */
export const MIGRATIONS = [];

/** Fields the repositories never return. */
const INTERNAL = new Set(['_id', 'websiteId', 'merchantId', 'env', 'schemaVersion']);

/**
 * @param {Record<string, any> | null | undefined} doc
 * @returns {any}
 */
export const strip = (doc) => (doc ? Object.fromEntries(Object.entries(doc).filter(([key]) => !INTERNAL.has(key))) : null);

/** @param {unknown} error */
export const isDuplicateKey = (error) => /** @type {{ code?: number }} */ (error)?.code === 11000;

/**
 * Repositories of one website.
 * @param {{ websiteId: string, collection: (name: string) => any }} scope app-kit website data scope
 * @param {{ now: () => number }} options
 */
export const createRepositories = (scope, { now }) => {
	const { websiteId } = scope;
	const orders = scope.collection(COLLECTIONS.orders);
	const counters = scope.collection(COLLECTIONS.counters);
	const profiles = scope.collection(COLLECTIONS.profiles);
	const messages = scope.collection(COLLECTIONS.messages);
	const at = () => new Date(now());
	/** @param {Record<string, unknown>} filter */
	const pin = (filter) => ({ ...filter, websiteId });

	return Object.freeze({
		websiteId,
		orders: Object.freeze({
			/** @param {string} id */
			get: async (id) => strip(await orders.findOne(pin({ id }))),
			/** @param {string} number */
			byNumber: async (number) => strip(await orders.findOne(pin({ number }))),
			/** @param {string} source @param {string} externalId */
			byExternal: async (source, externalId) => strip(await orders.findOne(pin({ source, externalId }))),
			/**
			 * @param {Record<string, unknown>} doc
			 * @returns {Promise<{ ok: true } | { ok: false, duplicate: string }>}
			 */
			insert: async (doc) => {
				try {
					await orders.insertOne({ ...doc });
					return { ok: true };
				} catch (error) {
					if (!isDuplicateKey(error)) throw error;
					const pattern = Object.keys(/** @type {any} */ (error).keyPattern ?? {});
					return {
						ok: false,
						duplicate: pattern.includes('number') ? 'number' : pattern.includes('externalId') ? 'external' : 'id',
					};
				}
			},
			/**
			 * Compare-and-set update: the filter adds the guard (status, version, money) to the id.
			 * @param {string} id
			 * @param {Record<string, unknown>} guard
			 * @param {Record<string, unknown> | Record<string, unknown>[]} update
			 * @returns {Promise<any>} the updated order, or null when the guard failed
			 */
			change: async (id, guard, update) =>
				strip(await orders.findOneAndUpdate(pin({ ...guard, id }), update, { returnDocument: 'after' })),
			/**
			 * A keyset page sorted newest first (`after` = [placedAt ISO, id]).
			 * @param {Record<string, unknown>} filter
			 * @param {{ after: unknown, limit: number }} page
			 */
			page: async (filter, { after, limit }) => {
				const cursor =
					Array.isArray(after) && after.length === 2
						? {
								$or: [
									{ placedAt: { $lt: new Date(String(after[0])) } },
									{ placedAt: new Date(String(after[0])), id: { $lt: String(after[1]) } },
								],
							}
						: {};
				const query = Object.keys(cursor).length > 0 ? { $and: [filter, cursor] } : filter;
				return (await orders.find(pin(query)).sort({ placedAt: -1, id: -1 }).limit(limit).toArray()).map(strip);
			},
			/** @param {string[]} ids */
			many: async (ids) => {
				const found = [];
				for (const id of ids) {
					const doc = strip(await orders.findOne(pin({ id })));
					if (doc) found.push(doc);
				}
				return found;
			},
			/** @param {Record<string, unknown>} filter */
			count: async (filter) => orders.countDocuments(pin(filter)),
			/** @param {string[]} keys @param {string[]} statuses */
			countOpen: async (keys, statuses) =>
				keys.length === 0 || statuses.length === 0
					? 0
					: orders.countDocuments(pin({ customerKeys: { $in: keys }, status: { $in: statuses } })),
			/** @param {Date} before @param {number} limit */
			dueExpiry: async (before, limit) =>
				(
					await orders
						.find(pin({ expiresAt: { $lte: before } }))
						.sort({ expiresAt: 1 })
						.limit(limit)
						.toArray()
				).map(strip),
			/** @param {Date} before @param {number} limit */
			pendingOutbox: async (before, limit) =>
				(
					await orders
						.find(pin({ pendingAt: { $lte: before } }))
						.sort({ pendingAt: 1 })
						.limit(limit)
						.toArray()
				).map(strip),
			/**
			 * Remove delivered outbox entries (and the outbox marker once empty).
			 * @param {string} id
			 * @param {string[]} keys
			 */
			pull: async (id, keys) => {
				await orders.updateOne(pin({ id }), { $pull: { pending: { key: { $in: keys } } } });
				await orders.updateOne(pin({ id, pending: { $size: 0 } }), { $set: { pendingAt: null } });
			},
			/** @param {string} serial @param {string} excludeId */
			holdersOf: async (serial, excludeId) =>
				(
					await orders
						.find(pin({ 'lines.serials': serial, id: { $ne: excludeId } }), {
							projection: { id: 1, number: 1, status: 1 },
						})
						.limit(20)
						.toArray()
				).map(strip),
			/** @param {string} serial */
			bySerial: async (serial) =>
				(
					await orders
						.find(pin({ 'lines.serials': serial }))
						.sort({ placedAt: -1 })
						.limit(20)
						.toArray()
				).map(strip),
			/**
			 * Counts and money per status and currency (one aggregation).
			 * @param {Record<string, unknown>} filter
			 */
			totals: async (filter) =>
				orders
					.aggregate([
						{ $match: pin(filter) },
						{
							$group: {
								_id: { status: '$status', currency: '$currency' },
								orders: { $sum: 1 },
								total: { $sum: '$amounts.total' },
								paid: { $sum: '$paid' },
								refunded: { $sum: '$refunded' },
							},
						},
					])
					.toArray(),
			/**
			 * Ledger entries across orders (reconciliation): one row per payment or refund in the period.
			 * @param {{ from: Date | null, to: Date | null, kind: 'payment' | 'refund' | null, method: string | null, limit: number }} query
			 */
			ledger: async ({ from, to, kind, method, limit }) => {
				/** @type {Record<string, unknown>} */
				const range = {};
				if (from) range.$gte = from;
				if (to) range.$lt = to;
				const entryMatch = {
					...(Object.keys(range).length > 0 ? { 'entry.at': range } : {}),
					...(kind ? { 'entry.kind': kind } : {}),
					...(method ? { 'entry.method': method } : {}),
				};
				return orders
					.aggregate([
						{ $match: pin({}) },
						{
							$project: {
								id: 1,
								number: 1,
								currency: 1,
								entries: {
									$concatArrays: [
										{
											$map: {
												input: { $ifNull: ['$payments', []] },
												as: 'p',
												in: { $mergeObjects: ['$$p', { kind: 'payment' }] },
											},
										},
										{
											$map: {
												input: { $ifNull: ['$refunds', []] },
												as: 'r',
												in: { $mergeObjects: ['$$r', { kind: 'refund' }] },
											},
										},
									],
								},
							},
						},
						{ $unwind: '$entries' },
						{ $project: { _id: 0, orderId: '$id', number: 1, currency: 1, entry: '$entries' } },
						{ $match: entryMatch },
						{ $sort: { 'entry.at': -1 } },
						{ $limit: limit },
					])
					.toArray();
			},
		}),
		counters: Object.freeze({
			/** @param {string} key @returns {Promise<number>} the next value (1, 2, …) */
			next: async (key) => {
				const doc = await counters.findOneAndUpdate(
					pin({ key }),
					{ $inc: { value: 1 } },
					{ upsert: true, returnDocument: 'after' },
				);
				return Number(doc?.value ?? 1);
			},
		}),
		profiles: Object.freeze({
			/** @param {string[]} keys */
			byKeys: async (keys) =>
				keys.length === 0 ? [] : (await profiles.find(pin({ key: { $in: keys } })).toArray()).map(strip),
			/**
			 * @param {string} key
			 * @param {Record<string, unknown>} fields
			 */
			set: async (key, fields) =>
				strip(
					await profiles.findOneAndUpdate(
						pin({ key }),
						{ $set: { ...fields, updatedAt: at() }, $setOnInsert: { rtoCount: 0 } },
						{ upsert: true, returnDocument: 'after' },
					),
				),
			/** @param {string} key */
			addRto: async (key) =>
				profiles.updateOne(pin({ key }), { $inc: { rtoCount: 1 }, $setOnInsert: { blocked: false } }, { upsert: true }),
			/** @param {{ after: unknown, limit: number }} page */
			blocked: async ({ after, limit }) =>
				(
					await profiles
						.find(pin({ blocked: true, ...(typeof after === 'string' ? { key: { $gt: after } } : {}) }))
						.sort({ key: 1 })
						.limit(limit)
						.toArray()
				).map(strip),
			countBlocked: async () => profiles.countDocuments(pin({ blocked: true })),
		}),
		messages: Object.freeze({
			/** @param {string} id */
			get: async (id) => strip(await messages.findOne(pin({ id }))),
			/** @param {Record<string, unknown>} doc @returns {Promise<boolean>} false when it exists already */
			insert: async (doc) => {
				try {
					await messages.insertOne({ ...doc });
					return true;
				} catch (error) {
					if (isDuplicateKey(error)) return false;
					throw error;
				}
			},
			/**
			 * Claim a message for sending (state pending or failed and due) until `leaseUntil`.
			 * @param {string} id
			 * @param {Date} leaseUntil
			 */
			claim: async (id, leaseUntil) =>
				strip(
					await messages.findOneAndUpdate(
						pin({ id, state: { $in: ['pending', 'retry'] }, nextAttemptAt: { $lte: at() } }),
						{ $set: { state: 'sending', nextAttemptAt: leaseUntil }, $inc: { attempts: 1 } },
						{ returnDocument: 'after' },
					),
				),
			/** @param {string} id @param {Record<string, unknown>} fields */
			settle: async (id, fields) => messages.updateOne(pin({ id, state: 'sending' }), { $set: fields }),
			/** @param {string} id */
			requeue: async (id) =>
				messages.updateOne(pin({ id, state: { $in: ['failed', 'retry'] } }), {
					$set: { state: 'retry', nextAttemptAt: at(), attempts: 0 },
				}),
			/** @param {Date} before @param {number} limit */
			due: async (before, limit) =>
				(
					await messages
						.find(pin({ state: { $in: ['pending', 'retry', 'sending'] }, nextAttemptAt: { $lte: before } }))
						.sort({ nextAttemptAt: 1 })
						.limit(limit)
						.toArray()
				).map(strip),
			/** @param {Record<string, unknown>} filter @param {{ after: unknown, limit: number }} page */
			page: async (filter, { after, limit }) => {
				const cursor =
					Array.isArray(after) && after.length === 2
						? {
								$or: [
									{ createdAt: { $lt: new Date(String(after[0])) } },
									{ createdAt: new Date(String(after[0])), id: { $lt: String(after[1]) } },
								],
							}
						: {};
				const query = Object.keys(cursor).length > 0 ? { $and: [filter, cursor] } : filter;
				return (await messages.find(pin(query)).sort({ createdAt: -1, id: -1 }).limit(limit).toArray()).map(strip);
			},
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
