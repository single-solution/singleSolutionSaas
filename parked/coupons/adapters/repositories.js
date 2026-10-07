/**
 * Repositories over the merchant's own database (Part E §7), reached through app-kit `data.forWebsite(websiteId)`:
 * collections are prefixed `ss_coupons_`, every query pins `websiteId` (app-kit's tenant guard rejects any that does
 * not) and inserts are stamped with `websiteId`, `merchantId`, `env`, `createdAt`, `updatedAt` and `schemaVersion`.
 *
 * Concurrency: usage limits are **atomic conditional counters** — a claim is one `updateOne` with `taken < max` in the
 * filter and `$inc: { taken: 1 }`, so the database serialises concurrent checkouts and never hands out more uses than
 * the limit. Per-customer and per-device counters are upserts on a unique key (a lost race surfaces as a duplicate key
 * and is retried once). Reservation state moves only by compare-and-set on `status`.
 *
 * - `coupons`: definitions + global counters (`counters.taken`, `counters.redeemed`), optimistic `version`.
 * - `codes`: one document per code with its own counters (`taken`, `redeemed`, `maxUses`).
 * - `reservations`: checkout reservations and their lifecycle (pending → reserved → redeemed | released | expired).
 * - `usage`: per-customer / per-device counters (subject hashed in `key`).
 * - `velocity`: fixed-window counters of checks, failures and reservations (TTL).
 * - `blocks`: the blocklist (soft-deleted).
 * @module
 */

export const COLLECTIONS = Object.freeze({
	coupons: 'coupons',
	codes: 'codes',
	reservations: 'reservations',
	usage: 'usage',
	velocity: 'velocity',
	blocks: 'blocks',
});

/** Schema version of documents written by this release. */
export const SCHEMA_VERSION = 1;

/**
 * Index definitions (websiteId first everywhere; the TTL index is the single-field exception), created idempotently by
 * app-kit on first use of a website.
 */
export const INDEXES = /** @type {any} */ ([
	{ collection: 'coupons', keys: { websiteId: 1, id: 1 }, name: 'website_coupon', unique: true },
	{ collection: 'coupons', keys: { websiteId: 1, status: 1, id: 1 }, name: 'website_status_coupon' },
	{ collection: 'codes', keys: { websiteId: 1, code: 1 }, name: 'website_code', unique: true },
	{ collection: 'codes', keys: { websiteId: 1, couponId: 1, code: 1 }, name: 'website_coupon_code' },
	{ collection: 'reservations', keys: { websiteId: 1, id: 1 }, name: 'website_reservation', unique: true },
	{ collection: 'reservations', keys: { websiteId: 1, orderId: 1 }, name: 'website_order' },
	{ collection: 'reservations', keys: { websiteId: 1, status: 1, expiresAt: 1 }, name: 'website_status_expiry' },
	{ collection: 'reservations', keys: { websiteId: 1, codes: 1, status: 1, expiresAt: 1 }, name: 'website_code_status' },
	{ collection: 'reservations', keys: { websiteId: 1, status: 1, redeemedAt: -1, id: -1 }, name: 'website_redeemed' },
	{ collection: 'reservations', keys: { websiteId: 1, customerId: 1 }, name: 'website_customer' },
	{ collection: 'usage', keys: { websiteId: 1, couponId: 1, kind: 1, key: 1 }, name: 'website_usage', unique: true },
	{ collection: 'velocity', keys: { websiteId: 1, key: 1, window: 1 }, name: 'website_velocity', unique: true },
	{ collection: 'velocity', keys: { expireAt: 1 }, name: 'velocity_ttl', expireAfterSeconds: 0 },
	{ collection: 'blocks', keys: { websiteId: 1, id: 1 }, name: 'website_block', unique: true },
	{
		collection: 'blocks',
		keys: { websiteId: 1, kind: 1, value: 1 },
		name: 'website_block_value',
		unique: true,
		partialFilterExpression: { deletedAt: { $type: 'null' } },
	},
]);

/**
 * Lazy, versioned migrations (app-kit runs them once per website under a lock).
 * @type {Array<{ version: number, name: string, up: (scope: any) => Promise<void> }>}
 */
export const MIGRATIONS = [
	{
		version: 1,
		name: 'coupon_counters',
		up: async (scope) => {
			await scope
				.collection(COLLECTIONS.coupons)
				.updateMany(
					{ websiteId: scope.websiteId, counters: { $exists: false } },
					{ $set: { counters: { taken: 0, redeemed: 0 }, codeCount: 0, version: 1 } },
				);
		},
	},
];

/** Fields the repositories never return. */
const INTERNAL = new Set(['_id', 'websiteId', 'merchantId', 'env', 'schemaVersion']);

/**
 * @param {Record<string, any> | null} doc
 * @returns {Record<string, any> | null}
 */
const strip = (doc) => (doc ? Object.fromEntries(Object.entries(doc).filter(([key]) => !INTERNAL.has(key))) : null);

/** @param {unknown} error */
export const isDuplicateKey = (error) => {
	const code = /** @type {{ code?: number, writeErrors?: Array<{ code?: number }> }} */ (error)?.code;
	return code === 11000;
};

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
	const coupons = scope.collection(COLLECTIONS.coupons);
	const codes = scope.collection(COLLECTIONS.codes);
	const reservations = scope.collection(COLLECTIONS.reservations);
	const usage = scope.collection(COLLECTIONS.usage);
	const velocity = scope.collection(COLLECTIONS.velocity);
	const blocks = scope.collection(COLLECTIONS.blocks);

	/**
	 * Standard fields of a document created by an upsert.
	 * @param {Record<string, unknown>} doc
	 */
	const onInsert = (doc) => ({ ...stamp, createdAt: new Date(now()), schemaVersion: SCHEMA_VERSION, ...doc });
	/** @param {{ matchedCount?: number }} result */
	const matched = (result) => (result.matchedCount ?? 0) > 0;
	/**
	 * Insert, false on a duplicate key.
	 * @param {any} collection
	 * @param {Record<string, unknown>} doc
	 */
	const insertOnce = async (collection, doc) => {
		try {
			await collection.insertOne(doc);
			return true;
		} catch (error) {
			if (isDuplicateKey(error)) return false;
			throw error;
		}
	};

	return Object.freeze({
		websiteId,
		coupons: Object.freeze({
			/** @param {Record<string, unknown> & { id: string }} doc */
			insert: (doc) => insertOnce(coupons, { ...doc, counters: { taken: 0, redeemed: 0 }, codeCount: 0, version: 1 }),
			/** @param {string} id */
			get: async (id) => strip(await coupons.findOne({ websiteId, id })),
			/**
			 * Coupons by id (ascending), optionally of one status.
			 * @param {{ after?: string | null, fetchLimit: number, status?: string | null }} page
			 */
			list: async ({ after = null, fetchLimit, status = null }) =>
				(
					await coupons
						.find(
							{ websiteId, ...(status ? { status } : {}), ...(after ? { id: { $gt: after } } : {}) },
							{ sort: { id: 1 }, limit: fetchLimit },
						)
						.toArray()
				).map(strip),
			/** Coupons that are not archived. */
			countActive: () => coupons.countDocuments({ websiteId, status: { $ne: 'archived' } }),
			/**
			 * Optimistic update of editable fields.
			 * @param {string} id
			 * @param {number} version
			 * @param {Record<string, unknown>} set
			 * @param {string[]} [unset]
			 */
			save: async (id, version, set, unset = []) =>
				matched(
					await coupons.updateOne(
						{ websiteId, id, version },
						{
							$set: { ...set, version: version + 1 },
							...(unset.length > 0 ? { $unset: Object.fromEntries(unset.map((key) => [key, ''])) } : {}),
						},
					),
				),
			/**
			 * Claim one use of the coupon (global limit; `max` null = count only).
			 * @param {string} id
			 * @param {number | null} max
			 */
			claim: async (id, max) =>
				matched(
					await coupons.updateOne(
						{ websiteId, id, status: 'active', ...(max === null ? {} : { 'counters.taken': { $lt: max } }) },
						{ $inc: { 'counters.taken': 1 } },
					),
				),
			/** @param {string} id */
			unclaim: async (id) =>
				matched(await coupons.updateOne({ websiteId, id, 'counters.taken': { $gt: 0 } }, { $inc: { 'counters.taken': -1 } })),
			/**
			 * Count redemptions (±1); returns the updated coupon.
			 * @param {string} id
			 * @param {1 | -1} delta
			 */
			redeemed: async (id, delta) =>
				strip(
					await coupons.findOneAndUpdate(
						{ websiteId, id, ...(delta < 0 ? { 'counters.redeemed': { $gt: 0 } } : {}) },
						{ $inc: { 'counters.redeemed': delta } },
						{ returnDocument: 'after' },
					),
				),
			/** @param {string} id @param {number} n */
			addCodes: async (id, n) => matched(await coupons.updateOne({ websiteId, id }, { $inc: { codeCount: n } })),
		}),
		codes: Object.freeze({
			/**
			 * Insert codes; codes that already exist are reported back (to be regenerated).
			 * @param {Array<Record<string, unknown> & { code: string }>} docs
			 * @returns {Promise<{ inserted: number, duplicates: string[] }>}
			 */
			insertMany: async (docs) => {
				if (docs.length === 0) return { inserted: 0, duplicates: [] };
				const prepared = docs.map((doc) => ({ taken: 0, redeemed: 0, status: 'active', ...doc }));
				try {
					const result = await codes.insertMany(prepared, { ordered: false });
					return { inserted: result.insertedCount ?? prepared.length, duplicates: [] };
				} catch (error) {
					const failures = /** @type {{ writeErrors?: any[] | any, insertedCount?: number, result?: any }} */ (error);
					const writeErrors = [failures.writeErrors ?? []].flat();
					if (writeErrors.length === 0 || !writeErrors.every((entry) => (entry?.code ?? entry?.err?.code) === 11000))
						throw error;
					const duplicates = writeErrors.map(
						(entry) => /** @type {string} */ (prepared[entry.index ?? entry.err?.index]?.code),
					);
					return { inserted: prepared.length - duplicates.length, duplicates };
				}
			},
			/** @param {string} code */
			get: async (code) => strip(await codes.findOne({ websiteId, code })),
			/**
			 * Codes of a coupon (ascending).
			 * @param {string} couponId
			 * @param {{ after?: string | null, fetchLimit: number }} page
			 */
			byCoupon: async (couponId, { after = null, fetchLimit }) =>
				(
					await codes
						.find(
							{ websiteId, couponId, ...(after ? { code: { $gt: after } } : {}) },
							{ sort: { code: 1 }, limit: fetchLimit },
						)
						.toArray()
				).map(strip),
			/** @param {string} code @param {string} status */
			setStatus: async (code, status) => matched(await codes.updateOne({ websiteId, code }, { $set: { status } })),
			/**
			 * Claim one use of a code (`max` null = count only).
			 * @param {string} code
			 * @param {number | null} max
			 */
			claim: async (code, max) =>
				matched(
					await codes.updateOne(
						{ websiteId, code, status: 'active', ...(max === null ? {} : { taken: { $lt: max } }) },
						{ $inc: { taken: 1 } },
					),
				),
			/** @param {string} code */
			unclaim: async (code) => matched(await codes.updateOne({ websiteId, code, taken: { $gt: 0 } }, { $inc: { taken: -1 } })),
			/**
			 * Count redemptions (±1); returns the updated code.
			 * @param {string} code
			 * @param {1 | -1} delta
			 */
			redeemed: async (code, delta) =>
				strip(
					await codes.findOneAndUpdate(
						{ websiteId, code, ...(delta < 0 ? { redeemed: { $gt: 0 } } : {}) },
						{ $inc: { redeemed: delta } },
						{ returnDocument: 'after' },
					),
				),
		}),
		reservations: Object.freeze({
			/** @param {Record<string, unknown> & { id: string }} doc */
			insert: (doc) => insertOnce(reservations, doc),
			/** @param {string} id */
			get: async (id) => strip(await reservations.findOne({ websiteId, id })),
			/**
			 * Move a reservation from one of `from` to a new state (compare-and-set).
			 * @param {string} id
			 * @param {readonly string[]} from
			 * @param {Record<string, unknown>} set
			 */
			transition: async (id, from, set) =>
				matched(await reservations.updateOne({ websiteId, id, status: { $in: [...from] } }, { $set: set })),
			/** @param {string} id @param {string} key */
			addClaim: async (id, key) => matched(await reservations.updateOne({ websiteId, id }, { $addToSet: { claims: key } })),
			/** Remove a claim; true only for the caller that removed it. @param {string} id @param {string} key */
			dropClaim: async (id, key) =>
				matched(await reservations.updateOne({ websiteId, id, claims: key }, { $pull: { claims: key } })),
			/** Mark a code's redemption as counted; true for the first caller only. @param {string} id @param {string} code */
			count: async (id, code) =>
				matched(await reservations.updateOne({ websiteId, id, counted: { $ne: code } }, { $addToSet: { counted: code } })),
			/** Undo `count`; true for the caller that removed it. @param {string} id @param {string} code */
			uncount: async (id, code) =>
				matched(await reservations.updateOne({ websiteId, id, counted: code }, { $pull: { counted: code } })),
			/** @param {string} orderId */
			byOrder: async (orderId) =>
				(await reservations.find({ websiteId, orderId }, { sort: { createdAt: 1 }, limit: 50 }).toArray()).map(strip),
			/**
			 * Open reservations past their expiry (optionally holding one code, or of one customer / device).
			 * @param {string} at ISO
			 * @param {{ code?: string, customerId?: string, deviceId?: string, limit: number }} options
			 */
			expired: async (at, { code, customerId, deviceId, limit }) =>
				(
					await reservations
						.find(
							{
								websiteId,
								...(code ? { codes: code } : {}),
								...(customerId || deviceId
									? {
											$or: [...(customerId ? [{ customerId }] : []), ...(deviceId ? [{ deviceId }] : [])],
										}
									: {}),
								status: { $in: ['pending', 'reserved'] },
								expiresAt: { $lt: at },
							},
							{ sort: { expiresAt: 1 }, limit },
						)
						.toArray()
				).map(strip),
			/**
			 * Redemptions, newest first. `after` is the cursor `<redeemedAt>|<id>`.
			 * @param {{ after?: string | null, fetchLimit: number, statuses?: string[] }} page
			 */
			redemptions: async ({ after = null, fetchLimit, statuses = ['redeemed'] }) => {
				/** @type {Record<string, unknown>} */
				const filter = { websiteId, status: { $in: statuses }, redeemedAt: { $type: 'string' } };
				if (typeof after === 'string' && after.includes('|')) {
					const [at, id] = /** @type {[string, string]} */ (after.split('|'));
					filter.$or = [{ redeemedAt: { $lt: at } }, { redeemedAt: at, id: { $lt: id } }];
				}
				return (await reservations.find(filter, { sort: { redeemedAt: -1, id: -1 }, limit: fetchLimit }).toArray()).map(
					strip,
				);
			},
			/**
			 * Record a refund once per event id; returns the reservation.
			 * @param {string} id
			 * @param {{ eventId: string, amount: number }} refund
			 */
			addRefund: async (id, refund) => {
				await reservations.updateOne(
					{ websiteId, id, 'refunds.eventId': { $ne: refund.eventId } },
					{ $push: { refunds: refund } },
				);
				return strip(await reservations.findOne({ websiteId, id }));
			},
			/** Open (reserved) reservations. */
			/** Reservations still holding uses at `at` (lapsed ones count as expired before they are touched). @param {string} at ISO */
			countOpen: (at) => reservations.countDocuments({ websiteId, status: 'reserved', expiresAt: { $gte: at } }),
			/**
			 * Redeemed reservations per currency in a window (report).
			 * @param {string} from ISO
			 * @param {string} to ISO
			 */
			ordersBetween: async (from, to) =>
				(
					await reservations
						.aggregate([
							{ $match: { websiteId, status: 'redeemed', redeemedAt: { $gte: from, $lte: to } } },
							{
								$group: {
									_id: '$cart.currency',
									count: { $sum: 1 },
									discount: { $sum: { $add: ['$totals.discount', '$totals.shippingDiscount'] } },
									revenue: { $sum: '$totals.total' },
								},
							},
						])
						.toArray()
				).map((/** @type {any} */ row) => ({
					currency: row._id,
					count: row.count,
					discount: row.discount,
					revenue: row.revenue,
				})),
			/**
			 * Redeemed codes in a window (report).
			 * @param {string} from ISO
			 * @param {string} to ISO
			 */
			codesBetween: async (from, to) =>
				(
					await reservations
						.aggregate([
							{ $match: { websiteId, status: 'redeemed', redeemedAt: { $gte: from, $lte: to } } },
							{ $unwind: '$coupons' },
							{
								$group: {
									_id: { couponId: '$coupons.couponId', code: '$coupons.code', currency: '$cart.currency' },
									redemptions: { $sum: 1 },
									discount: { $sum: { $add: ['$coupons.discount', '$coupons.shippingDiscount'] } },
								},
							},
							{ $sort: { redemptions: -1 } },
							{ $limit: 1000 },
						])
						.toArray()
				).map((/** @type {any} */ row) => ({
					couponId: row._id.couponId,
					code: row._id.code,
					currency: row._id.currency,
					redemptions: row.redemptions,
					discount: row.discount,
				})),
			/**
			 * Redemptions undone (released after redemption) in a window.
			 * @param {string} from ISO
			 * @param {string} to ISO
			 */
			releasedBetween: (from, to) =>
				reservations.countDocuments({
					websiteId,
					status: 'released',
					redeemedAt: { $type: 'string' },
					releasedAt: { $gte: from, $lte: to },
				}),
		}),
		usage: Object.freeze({
			/**
			 * Claim one use for a subject (customer or device) of a coupon, at most `max`.
			 * @param {{ couponId: string, kind: string, key: string, customerId?: string | null, max: number }} claim
			 */
			claim: async ({ couponId, kind, key, customerId = null, max }) => {
				for (let attempt = 0; attempt < 2; attempt += 1) {
					try {
						const result = await usage.updateOne(
							{ websiteId, couponId, kind, key, taken: { $lt: max } },
							{ $inc: { taken: 1 }, $setOnInsert: onInsert(kind === 'customer' && customerId ? { customerId } : {}) },
							{ upsert: true },
						);
						return matched(result) || (result.upsertedCount ?? 0) > 0;
					} catch (error) {
						if (!isDuplicateKey(error)) throw error;
					}
				}
				return false;
			},
			/** @param {{ couponId: string, kind: string, key: string }} claim */
			unclaim: async ({ couponId, kind, key }) =>
				matched(await usage.updateOne({ websiteId, couponId, kind, key, taken: { $gt: 0 } }, { $inc: { taken: -1 } })),
			/** @param {{ couponId: string, kind: string, key: string }} claim */
			get: async ({ couponId, kind, key }) => strip(await usage.findOne({ websiteId, couponId, kind, key })),
		}),
		velocity: Object.freeze({
			/**
			 * Count one event in a fixed window; returns the count after it.
			 * @param {string} key
			 * @param {number} window window start (ms)
			 * @param {number} expireAt ms
			 */
			hit: async (key, window, expireAt) => {
				for (let attempt = 0; attempt < 2; attempt += 1) {
					try {
						const doc = await velocity.findOneAndUpdate(
							{ websiteId, key, window },
							{ $inc: { count: 1 }, $setOnInsert: onInsert({ expireAt: new Date(expireAt) }) },
							{ upsert: true, returnDocument: 'after' },
						);
						return Number(doc?.count ?? 1);
					} catch (error) {
						if (!isDuplicateKey(error)) throw error;
					}
				}
				return Number.MAX_SAFE_INTEGER;
			},
			/** @param {string} key @param {number} window */
			count: async (key, window) => Number((await velocity.findOne({ websiteId, key, window }))?.count ?? 0),
		}),
		blocks: Object.freeze({
			/** @param {Record<string, unknown> & { id: string }} doc */
			insert: (doc) => insertOnce(blocks, { ...doc, deletedAt: null }),
			/** @param {{ after?: string | null, fetchLimit: number }} page */
			list: async ({ after = null, fetchLimit }) =>
				(
					await blocks
						.find(
							{ websiteId, deletedAt: null, ...(after ? { id: { $gt: after } } : {}) },
							{ sort: { id: 1 }, limit: fetchLimit },
						)
						.toArray()
				).map(strip),
			count: () => blocks.countDocuments({ websiteId, deletedAt: null }),
			/**
			 * Entries matching any of the given subjects.
			 * @param {Array<{ kind: string, value: string }>} subjects
			 */
			matching: async (subjects) =>
				subjects.length === 0
					? []
					: (
							await blocks
								.find(
									{ websiteId, deletedAt: null, $or: subjects.map(({ kind, value }) => ({ kind, value })) },
									{ limit: 10 },
								)
								.toArray()
						).map(strip),
			/** Soft delete. @param {string} id @param {string} at ISO */
			remove: async (id, at) =>
				matched(await blocks.updateOne({ websiteId, id, deletedAt: null }, { $set: { deletedAt: at } })),
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
