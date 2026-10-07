/**
 * Repositories over the merchant's own database (Part E §7), reached through app-kit `data.forWebsite(websiteId)`:
 * collections are prefixed `ss_loyalty_`, every query pins `websiteId` (app-kit's tenant guard rejects any that does
 * not) and inserts are stamped with `websiteId`, `merchantId`, `env`, `createdAt`, `updatedAt` and `schemaVersion`.
 *
 * - `members`: one document per customer identity — the unit of consistency (optimistic `version`).
 * - `transactions`: the append-only ledger (insert-only; one entry per `sourceKey`, unique).
 * - `orders`: order snapshots from `order.placed@1` (lines, amounts) and their completion / refunds.
 * - `redemptions`: checkout redemptions and their lifecycle (applied → returned).
 * - `referrals`: one referral per referee.
 * @module
 */
import { MEMBER_SCHEMA_VERSION, normaliseMember } from '../core/member.js';

export const COLLECTIONS = Object.freeze({
	members: 'members',
	transactions: 'transactions',
	orders: 'orders',
	redemptions: 'redemptions',
	referrals: 'referrals',
});

/**
 * Index definitions (websiteId first everywhere), created idempotently by app-kit on first use of a website.
 * @type {Array<{ collection: string, keys: Record<string, 1 | -1>, name: string, unique?: boolean, partialFilterExpression?: Record<string, unknown> }>}
 */
export const INDEXES = /** @type {any} */ ([
	{ collection: 'members', keys: { websiteId: 1, customerId: 1 }, name: 'website_customer', unique: true },
	{
		collection: 'members',
		keys: { websiteId: 1, referralCode: 1 },
		name: 'website_referral_code',
		unique: true,
		partialFilterExpression: { referralCode: { $type: 'string' } },
	},
	{ collection: 'members', keys: { websiteId: 1, 'lots.earnedAt': 1 }, name: 'website_lot_earned' },
	{ collection: 'members', keys: { websiteId: 1, 'tier.reviewAt': 1 }, name: 'website_tier_review' },
	{ collection: 'transactions', keys: { websiteId: 1, sourceKey: 1 }, name: 'website_source', unique: true },
	{ collection: 'transactions', keys: { websiteId: 1, customerId: 1, occurredAt: -1, id: -1 }, name: 'website_customer_time' },
	{ collection: 'transactions', keys: { websiteId: 1, occurredAt: -1, id: -1 }, name: 'website_time' },
	{ collection: 'transactions', keys: { websiteId: 1, 'source.orderId': 1, kind: 1 }, name: 'website_order_kind' },
	{ collection: 'orders', keys: { websiteId: 1, orderId: 1 }, name: 'website_order', unique: true },
	{ collection: 'redemptions', keys: { websiteId: 1, id: 1 }, name: 'website_redemption', unique: true },
	{ collection: 'redemptions', keys: { websiteId: 1, orderId: 1 }, name: 'website_redemption_order' },
	{ collection: 'redemptions', keys: { websiteId: 1, customerId: 1, createdAt: -1 }, name: 'website_redemption_customer' },
	{ collection: 'referrals', keys: { websiteId: 1, refereeId: 1 }, name: 'website_referee', unique: true },
	{ collection: 'referrals', keys: { websiteId: 1, referrerId: 1, status: 1, rewardedAt: 1 }, name: 'website_referrer_status' },
]);

/**
 * Lazy, versioned migrations (app-kit runs them once per website under a lock).
 * @type {Array<{ version: number, name: string, up: (scope: any) => Promise<void> }>}
 */
export const MIGRATIONS = [
	{
		version: 1,
		name: 'member_defaults',
		up: async (scope) => {
			await scope
				.collection(COLLECTIONS.members)
				.updateMany(
					{ websiteId: scope.websiteId, debt: { $exists: false } },
					{ $set: { debt: 0, lots: [], journal: [], buckets: {}, ruleUsage: {}, version: 0 } },
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
export const isDuplicateKey = (error) => /** @type {{ code?: number }} */ (error)?.code === 11000;

/** Mutable member fields written on every versioned save. */
const MEMBER_FIELDS = Object.freeze([
	'balance',
	'debt',
	'lots',
	'lifetime',
	'buckets',
	'ruleUsage',
	'tier',
	'orders',
	'joinedAt',
	'referralCode',
	'referredBy',
	'journal',
]);

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
	const members = scope.collection(COLLECTIONS.members);
	const transactions = scope.collection(COLLECTIONS.transactions);
	const orders = scope.collection(COLLECTIONS.orders);
	const redemptions = scope.collection(COLLECTIONS.redemptions);
	const referrals = scope.collection(COLLECTIONS.referrals);

	/**
	 * Standard fields of a document created by an upsert.
	 * @param {Record<string, unknown>} doc
	 */
	const onInsert = (doc) => ({ ...stamp, createdAt: new Date(now()), schemaVersion: MEMBER_SCHEMA_VERSION, ...doc });
	/** @param {Record<string, any> | null} doc */
	const toMember = (doc) => (doc ? normaliseMember(/** @type {any} */ (strip(doc)), now()) : null);

	return Object.freeze({
		websiteId,
		members: Object.freeze({
			/** @param {string} customerId */
			get: async (customerId) => toMember(await members.findOne({ websiteId, customerId })),
			/**
			 * Insert a new member (version 1). False when another writer created it first.
			 * @param {import('../core/member.js').Member} member
			 */
			insert: async (member) => {
				try {
					await members.insertOne({ ...member, version: 1 });
					return true;
				} catch (error) {
					if (isDuplicateKey(error)) return false;
					throw error;
				}
			},
			/**
			 * Optimistic save: applies only when the stored version is still `version`.
			 * @param {number} version
			 * @param {import('../core/member.js').Member} member
			 */
			save: async (version, member) => {
				/** @type {Record<string, unknown>} */
				const set = { version: version + 1 };
				for (const field of MEMBER_FIELDS) set[field] = /** @type {any} */ (member)[field];
				const result = await members.updateOne({ websiteId, customerId: member.customerId, version }, { $set: set });
				return (result.matchedCount ?? 0) > 0;
			},
			/** @param {string} code */
			byReferralCode: async (code) => toMember(await members.findOne({ websiteId, referralCode: code })),
			/**
			 * Members by customer id (ascending), optionally by id prefix.
			 * @param {{ after?: string | null, fetchLimit: number, prefix?: string }} page
			 * @returns {Promise<import('../core/member.js').Member[]>}
			 */
			list: async ({ after, fetchLimit, prefix = '' }) => {
				/** @type {Record<string, unknown>} */
				const range = {};
				if (prefix) Object.assign(range, { $gte: prefix, $lt: `${prefix}￿` });
				if (after && (!range.$gte || after >= /** @type {string} */ (range.$gte))) range.$gt = after;
				const filter = Object.keys(range).length > 0 ? { websiteId, customerId: range } : { websiteId };
				const docs = await members.find(filter, { sort: { customerId: 1 }, limit: fetchLimit }).toArray();
				return docs.map((/** @type {any} */ doc) => /** @type {import('../core/member.js').Member} */ (toMember(doc)));
			},
			/**
			 * Members holding a lot earned at or before `until` (ISO) — the expiry scan pre-filter.
			 * @param {string} until
			 * @param {{ after?: string | null, limit: number }} page
			 * @returns {Promise<import('../core/member.js').Member[]>}
			 */
			withLotsEarnedBy: async (until, { after = null, limit }) =>
				(
					await members
						.find(
							{ websiteId, 'lots.earnedAt': { $lte: until }, ...(after ? { customerId: { $gt: after } } : {}) },
							{ sort: { customerId: 1 }, limit },
						)
						.toArray()
				).map((/** @type {any} */ doc) => /** @type {import('../core/member.js').Member} */ (toMember(doc))),
			/**
			 * Members whose tier review date has passed.
			 * @param {string} at ISO
			 * @param {{ after?: string | null, limit: number }} page
			 * @returns {Promise<import('../core/member.js').Member[]>}
			 */
			dueForTierReview: async (at, { after = null, limit }) =>
				(
					await members
						.find(
							{ websiteId, 'tier.reviewAt': { $lte: at }, ...(after ? { customerId: { $gt: after } } : {}) },
							{ sort: { customerId: 1 }, limit },
						)
						.toArray()
				).map((/** @type {any} */ doc) => /** @type {import('../core/member.js').Member} */ (toMember(doc))),
			/** Count and outstanding points. */
			stats: async () => {
				const [row] = await members
					.aggregate([
						{ $match: { websiteId } },
						{ $group: { _id: null, count: { $sum: 1 }, outstanding: { $sum: '$balance' } } },
					])
					.toArray();
				return { count: row?.count ?? 0, outstanding: row?.outstanding ?? 0 };
			},
		}),
		transactions: Object.freeze({
			/**
			 * Append a ledger entry (idempotent on `sourceKey`): true when this call stored it.
			 * @param {import('../core/member.js').Transaction} tx
			 */
			append: async (tx) => {
				const result = await transactions.updateOne(
					{ websiteId, sourceKey: tx.sourceKey },
					{ $setOnInsert: onInsert({ ...tx }) },
					{ upsert: true },
				);
				return (result.upsertedCount ?? 0) > 0;
			},
			/** @param {string} sourceKey */
			bySourceKey: async (sourceKey) => strip(await transactions.findOne({ websiteId, sourceKey })),
			/**
			 * Newest first. `after` is the cursor `<occurredAt>|<id>` of the last entry of the previous page.
			 * @param {{ customerId?: string, after?: string | null, fetchLimit: number, kinds?: string[] }} page
			 * @returns {Promise<import('../core/member.js').Transaction[]>}
			 */
			list: async ({ customerId, after, fetchLimit, kinds }) => {
				/** @type {Record<string, unknown>} */
				const filter = { websiteId, ...(customerId ? { customerId } : {}), ...(kinds ? { kind: { $in: kinds } } : {}) };
				if (typeof after === 'string' && after.includes('|')) {
					const [at, id] = /** @type {[string, string]} */ (after.split('|'));
					filter.$or = [{ occurredAt: { $lt: at } }, { occurredAt: at, id: { $lt: id } }];
				}
				const docs = await transactions.find(filter, { sort: { occurredAt: -1, id: -1 }, limit: fetchLimit }).toArray();
				return docs.map((/** @type {any} */ doc) => /** @type {import('../core/member.js').Transaction} */ (strip(doc)));
			},
			/**
			 * Signed points per kind for an order.
			 * @param {string} orderId
			 * @returns {Promise<Record<string, number>>}
			 */
			sumsForOrder: async (orderId) => {
				const rows = await transactions
					.aggregate([
						{ $match: { websiteId, 'source.orderId': orderId } },
						{ $group: { _id: '$kind', points: { $sum: '$points' } } },
					])
					.toArray();
				return Object.fromEntries(rows.map((/** @type {any} */ row) => [row._id, row.points]));
			},
			/**
			 * Earned / redeemed points since an instant (KPIs).
			 * @param {string} since ISO
			 */
			totalsSince: async (since) => {
				const rows = await transactions
					.aggregate([
						{ $match: { websiteId, occurredAt: { $gte: since } } },
						{ $group: { _id: '$kind', points: { $sum: '$points' }, count: { $sum: 1 } } },
					])
					.toArray();
				return Object.fromEntries(rows.map((/** @type {any} */ row) => [row._id, { points: row.points, count: row.count }]));
			},
		}),
		orders: Object.freeze({
			/** @param {string} orderId */
			get: async (orderId) => strip(await orders.findOne({ websiteId, orderId })),
			/**
			 * Store the snapshot of `order.placed@1` (first one wins); returns the stored order.
			 * @param {import('../core/earn.js').OrderSnapshot & { placedAt: string }} snapshot
			 */
			recordPlaced: async (snapshot) => {
				await orders.updateOne(
					{ websiteId, orderId: snapshot.orderId },
					{
						$setOnInsert: onInsert({ refunds: [], completedAt: null, cancelledAt: null }),
						$set: { snapshot, placedAt: snapshot.placedAt },
					},
					{ upsert: true },
				);
				return strip(await orders.findOne({ websiteId, orderId: snapshot.orderId }));
			},
			/**
			 * @param {string} orderId
			 * @param {'completedAt' | 'cancelledAt'} field
			 * @param {string} at ISO
			 */
			mark: async (orderId, field, at) => {
				await orders.updateOne({ websiteId, orderId, [field]: null }, { $set: { [field]: at } });
				await orders.updateOne(
					{ websiteId, orderId },
					{
						$setOnInsert: onInsert({
							snapshot: null,
							placedAt: null,
							refunds: [],
							completedAt: null,
							cancelledAt: null,
							[field]: at,
						}),
					},
					{ upsert: true },
				);
				return strip(await orders.findOne({ websiteId, orderId }));
			},
			/**
			 * Claim the next step of an order's reversal (compare-and-set on the claimed totals). A claim is executed as a
			 * ledger movement keyed by its `to`, so a crash after the claim is completed by the next delivery.
			 * @param {string} orderId
			 * @param {{ from: number, to: number, spendFrom: number, spendTo: number, at: string }} claim
			 * @returns {Promise<boolean>}
			 */
			claimReversal: async (orderId, claim) => {
				const result = await orders.updateOne(
					{
						websiteId,
						orderId,
						reversedTo: claim.from === 0 ? { $in: [0, null] } : claim.from,
						reversedSpend: claim.spendFrom === 0 ? { $in: [0, null] } : claim.spendFrom,
					},
					{ $set: { reversedTo: claim.to, reversedSpend: claim.spendTo }, $push: { reversals: claim } },
				);
				return (result.matchedCount ?? 0) > 0;
			},
			/**
			 * Record a refund once per event id; returns the order.
			 * @param {string} orderId
			 * @param {{ eventId: string, amount: number, at: string }} refund
			 */
			addRefund: async (orderId, refund) => {
				await orders.updateOne(
					{ websiteId, orderId },
					{ $setOnInsert: onInsert({ snapshot: null, placedAt: null, completedAt: null, cancelledAt: null, refunds: [] }) },
					{ upsert: true },
				);
				await orders.updateOne(
					{ websiteId, orderId, 'refunds.eventId': { $ne: refund.eventId } },
					{ $push: { refunds: refund } },
				);
				return strip(await orders.findOne({ websiteId, orderId }));
			},
		}),
		redemptions: Object.freeze({
			/**
			 * Store a redemption (first write wins for an id): true when this call stored it.
			 * @param {Record<string, unknown> & { id: string }} doc
			 */
			insert: async (doc) => {
				const result = await redemptions.updateOne(
					{ websiteId, id: doc.id },
					{ $setOnInsert: onInsert(doc) },
					{ upsert: true },
				);
				return (result.upsertedCount ?? 0) > 0;
			},
			/** @param {string} id */
			get: async (id) => strip(await redemptions.findOne({ websiteId, id })),
			/**
			 * Move a redemption from one of `from` to a new status (compare-and-set).
			 * @param {string} id
			 * @param {string[]} from
			 * @param {Record<string, unknown>} set
			 */
			transition: async (id, from, set) => {
				const result = await redemptions.updateOne({ websiteId, id, status: { $in: from } }, { $set: set });
				return (result.matchedCount ?? 0) > 0;
			},
			/** @param {string} orderId */
			byOrder: async (orderId) =>
				(await redemptions.find({ websiteId, orderId }, { sort: { createdAt: 1 } }).toArray()).map(strip),
			/** Active (applied) redemptions count (KPIs). */
			countApplied: async () => redemptions.countDocuments({ websiteId, status: 'applied' }),
		}),
		referrals: Object.freeze({
			/**
			 * @param {Record<string, unknown> & { refereeId: string }} doc
			 * @returns {Promise<boolean>} false when the referee was already referred
			 */
			insert: async (doc) => {
				try {
					await referrals.insertOne(doc);
					return true;
				} catch (error) {
					if (isDuplicateKey(error)) return false;
					throw error;
				}
			},
			/** @param {string} refereeId */
			byReferee: async (refereeId) => strip(await referrals.findOne({ websiteId, refereeId })),
			/**
			 * Rewarded referrals of a referrer, optionally since an instant.
			 * @param {string} referrerId
			 * @param {string | null} [since]
			 */
			countRewarded: async (referrerId, since = null) =>
				referrals.countDocuments({
					websiteId,
					referrerId,
					status: 'rewarded',
					...(since ? { rewardedAt: { $gte: since } } : {}),
				}),
			/**
			 * Close a pending referral (compare-and-set).
			 * @param {string} refereeId
			 * @param {Record<string, unknown>} set
			 */
			close: async (refereeId, set) => {
				const result = await referrals.updateOne({ websiteId, refereeId, status: 'pending' }, { $set: set });
				return (result.matchedCount ?? 0) > 0;
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
