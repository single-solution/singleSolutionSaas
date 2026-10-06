/**
 * Repositories over the merchant's own database (Part E §7), reached through app-kit `data.forWebsite(websiteId)`:
 * collections are prefixed `ss_alerts_`, every query pins `websiteId` (app-kit's tenant guard rejects any that does
 * not) and inserts are stamped with `websiteId`, `merchantId`, `env`, `createdAt`, `updatedAt`, `schemaVersion`.
 *
 * - `subscriptions` — one per contact, type and target while active (partial unique index on `active: true`);
 *   claims are compare-and-set on `{ status: 'pending', cycle }`;
 * - `messages` — the outbox: one document per provider call (`queued → sending → sent | failed | cancelled`), claimed
 *   with a lease before any send (`findOneAndUpdate`), so instances never send the same message twice;
 * - `triggers` — one run per change (unique on the event id / Idempotency-Key), with `open` while more waiters remain;
 * - `items` — the last known stock (per location) and price of each target, versioned;
 * - `counters` — frequency caps and sign-up limits (atomic `$inc` below a limit, TTL);
 * - `suppressions` — unsubscribed contacts (keyed hashes only).
 * @module
 */
import { ACTIVE_STATUSES } from '../core/subscription.js';

export const SCHEMA_VERSION = 1;

export const COLLECTIONS = Object.freeze({
	subscriptions: 'subscriptions',
	messages: 'messages',
	triggers: 'triggers',
	items: 'items',
	counters: 'counters',
	suppressions: 'suppressions',
});

/**
 * Index definitions (websiteId first everywhere, TTL indexes single-field), created by app-kit on first use.
 * @type {Array<{ collection: string, keys: Record<string, 1 | -1>, name: string, unique?: boolean,
 *   partialFilterExpression?: Record<string, unknown>, expireAfterSeconds?: number }>}
 */
export const INDEXES = /** @type {any} */ ([
	{ collection: 'subscriptions', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{
		collection: 'subscriptions',
		keys: { websiteId: 1, contactKey: 1, type: 1, targetKey: 1 },
		name: 'website_active_contact_target',
		unique: true,
		partialFilterExpression: { active: true },
	},
	{
		collection: 'subscriptions',
		keys: { websiteId: 1, targetKey: 1, status: 1, rank: 1, subscribedAt: 1, id: 1 },
		name: 'website_waitlist',
	},
	{ collection: 'subscriptions', keys: { websiteId: 1, customerId: 1, subscribedAt: -1 }, name: 'website_customer' },
	{ collection: 'subscriptions', keys: { websiteId: 1, contactKey: 1, status: 1 }, name: 'website_contact_status' },
	{ collection: 'subscriptions', keys: { websiteId: 1, status: 1, claimedAt: 1 }, name: 'website_status_claimed' },
	{ collection: 'subscriptions', keys: { websiteId: 1, subscribedAt: -1, id: -1 }, name: 'website_time' },
	{ collection: 'subscriptions', keys: { expiresAt: 1 }, name: 'ttl', expireAfterSeconds: 0 },
	{ collection: 'messages', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{
		collection: 'messages',
		keys: { websiteId: 1, key: 1 },
		name: 'website_key',
		unique: true,
		partialFilterExpression: { key: { $type: 'string' } },
	},
	{
		collection: 'messages',
		keys: { websiteId: 1, batchKey: 1 },
		name: 'website_open_batch',
		unique: true,
		partialFilterExpression: { open: true },
	},
	{ collection: 'messages', keys: { websiteId: 1, status: 1, notBefore: 1 }, name: 'website_due' },
	{ collection: 'messages', keys: { websiteId: 1, 'items.subscriptionId': 1 }, name: 'website_item' },
	{ collection: 'messages', keys: { websiteId: 1, queuedAt: -1, id: -1 }, name: 'website_time' },
	{ collection: 'messages', keys: { expiresAt: 1 }, name: 'ttl', expireAfterSeconds: 0 },
	{ collection: 'triggers', keys: { websiteId: 1, key: 1 }, name: 'website_key', unique: true },
	{ collection: 'triggers', keys: { websiteId: 1, at: -1, id: -1 }, name: 'website_time' },
	{ collection: 'triggers', keys: { websiteId: 1, open: 1, at: 1 }, name: 'website_open' },
	{ collection: 'triggers', keys: { expiresAt: 1 }, name: 'ttl', expireAfterSeconds: 0 },
	{ collection: 'items', keys: { websiteId: 1, targetKey: 1 }, name: 'website_target', unique: true },
	{ collection: 'counters', keys: { websiteId: 1, key: 1 }, name: 'website_key', unique: true },
	{ collection: 'counters', keys: { expiresAt: 1 }, name: 'ttl', expireAfterSeconds: 0 },
	{ collection: 'suppressions', keys: { websiteId: 1, contactKey: 1 }, name: 'website_contact', unique: true },
]);

/**
 * Lazy, versioned migrations (app-kit runs them once per website under a lock).
 * @type {Array<{ version: number, name: string, up: (scope: any) => Promise<void> }>}
 */
export const MIGRATIONS = [
	{
		version: 1,
		name: 'subscription_defaults',
		up: async (scope) => {
			await scope
				.collection(COLLECTIONS.subscriptions)
				.updateMany({ websiteId: scope.websiteId, rank: { $exists: false } }, { $set: { rank: 0, cycle: 0 } });
		},
	},
];

/** Fields the repositories never return. */
const INTERNAL = new Set(['_id', 'websiteId', 'merchantId', 'env', 'schemaVersion', 'createdAt', 'updatedAt']);
/** Subscription statuses that expire (a claimed one is mid-delivery and settles first). */
const WAITING = new Set(['unconfirmed', 'pending']);

/**
 * @param {Record<string, any> | null} doc
 * @returns {any}
 */
const strip = (doc) => (doc ? Object.fromEntries(Object.entries(doc).filter(([key]) => !INTERNAL.has(key))) : null);

/** @param {unknown} error */
export const isDuplicateKey = (error) => /** @type {{ code?: number }} */ (error)?.code === 11000;

/**
 * Cursor filter of a newest-first listing on `<field>|<id>`.
 * @param {string} field
 * @param {unknown} after cursor `<value>|<id>`
 * @returns {Record<string, unknown>}
 */
const before = (field, after) => {
	if (typeof after !== 'string' || !after.includes('|')) return {};
	const index = after.lastIndexOf('|');
	const value = after.slice(0, index);
	const id = after.slice(index + 1);
	return { $or: [{ [field]: { $lt: value } }, { [field]: value, id: { $lt: id } }] };
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
	const subscriptions = scope.collection(COLLECTIONS.subscriptions);
	const messages = scope.collection(COLLECTIONS.messages);
	const triggers = scope.collection(COLLECTIONS.triggers);
	const items = scope.collection(COLLECTIONS.items);
	const counters = scope.collection(COLLECTIONS.counters);
	const suppressions = scope.collection(COLLECTIONS.suppressions);
	/** @param {Record<string, unknown>} doc */
	const onInsert = (doc) => ({ ...stamp, createdAt: new Date(now()), schemaVersion: SCHEMA_VERSION, ...doc });
	const active = { $in: [...ACTIVE_STATUSES] };
	/**
	 * Not past `expiresAt` (treated as gone before the TTL monitor deletes it; documents without one never expire).
	 * @returns {{ expiresAt: { $not: { $lte: Date } } }}
	 */
	const unexpired = () => ({ expiresAt: { $not: { $lte: new Date(now()) } } });
	/**
	 * A waiting subscription (unconfirmed / pending) past its `expiresAt` reads as `expired` (the TTL monitor deletes it
	 * later; `findActive` ends it for good when it is touched).
	 * @param {Record<string, any> | null} doc
	 */
	const isExpired = (doc) =>
		Boolean(doc) &&
		WAITING.has(/** @type {any} */ (doc).status) &&
		/** @type {any} */ (doc).expiresAt instanceof Date &&
		/** @type {any} */ (doc).expiresAt.getTime() <= now();
	/** @param {Record<string, any> | null} doc */
	const readSub = (doc) => (isExpired(doc) ? { ...strip(doc), status: 'expired' } : strip(doc));

	return Object.freeze({
		websiteId,
		subscriptions: Object.freeze({
			/** @param {string} id */
			get: async (id) => readSub(await subscriptions.findOne({ websiteId, id })),
			/**
			 * The active subscription of a contact for a type and target. One past its expiry is ended here (`expired`,
			 * no longer active) so a new subscription can take its place.
			 * @param {{ contactKey: string, type: string, targetKey: string }} key
			 */
			findActive: async ({ contactKey, type, targetKey }) => {
				const doc = await subscriptions.findOne({ websiteId, contactKey, type, targetKey, active: true });
				if (!isExpired(doc)) return strip(doc);
				await subscriptions.updateOne(
					{ websiteId, id: doc.id, active: true, status: doc.status },
					{ $set: { status: 'expired', endedAt: new Date(now()).toISOString() }, $unset: { active: '' } },
				);
				return null;
			},
			/**
			 * Insert a new subscription. False when an active one exists for the contact, type and target (a concurrent
			 * double submit).
			 * @param {import('../core/subscription.js').Subscription} sub
			 */
			insert: async (sub) => {
				try {
					await subscriptions.insertOne({ ...sub });
					return true;
				} catch (error) {
					if (isDuplicateKey(error)) return false;
					throw error;
				}
			},
			/**
			 * Update fields of an active subscription (re-subscribe).
			 * @param {string} id
			 * @param {Record<string, unknown>} set
			 */
			refresh: async (id, set) => {
				await subscriptions.updateOne({ websiteId, id, active: true }, { $set: set });
				return strip(await subscriptions.findOne({ websiteId, id }));
			},
			/**
			 * Newest first; `filter` narrows by customer, contact, status, type or target.
			 * @param {{ customerId?: string, contactKey?: string, status?: string, type?: string, targetKey?: string,
			 *   after?: unknown, fetchLimit: number }} query
			 */
			list: async ({ after, fetchLimit, ...filter }) => {
				const where = Object.fromEntries(Object.entries(filter).filter(([, value]) => typeof value === 'string' && value));
				const docs = await subscriptions
					.find(
						{ websiteId, ...where, ...before('subscribedAt', after) },
						{ sort: { subscribedAt: -1, id: -1 }, limit: fetchLimit },
					)
					.toArray();
				return docs.map(readSub);
			},
			countActive: async () => subscriptions.countDocuments({ websiteId, active: true, ...unexpired() }),
			/** @param {string} contactKey */
			countActiveForContact: async (contactKey) =>
				subscriptions.countDocuments({ websiteId, contactKey, active: true, ...unexpired() }),
			/**
			 * Pending subscriptions of targets, in waitlist order.
			 * @param {{ targetKeys: string[], types: string[], limit: number }} query
			 */
			pendingFor: async ({ targetKeys, types, limit }) =>
				(
					await subscriptions
						.find(
							{ websiteId, targetKey: { $in: targetKeys }, type: { $in: types }, status: 'pending', ...unexpired() },
							{ sort: { rank: 1, subscribedAt: 1, id: 1 }, limit },
						)
						.toArray()
				).map(strip),
			/**
			 * Claim a pending subscription for a new cycle (compare-and-set): null when someone else claimed it first.
			 * @param {string} id
			 * @param {number} cycle the cycle the caller saw
			 * @param {string} triggerId
			 */
			claim: async (id, cycle, triggerId) =>
				strip(
					await subscriptions.findOneAndUpdate(
						{ websiteId, id, status: 'pending', cycle, ...unexpired() },
						{
							$set: {
								status: 'claimed',
								cycle: cycle + 1,
								claimedAt: new Date(now()).toISOString(),
								claimedBy: triggerId,
							},
						},
						{ returnDocument: 'after' },
					),
				),
			/**
			 * Close a claimed cycle: notified (or pending again when `repeat`).
			 * @param {string} id
			 * @param {number} cycle
			 * @param {{ repeat: boolean, expiresAt: Date }} options
			 */
			markNotified: async (id, cycle, { repeat, expiresAt }) => {
				const at = new Date(now()).toISOString();
				const result = await subscriptions.updateOne(
					{ websiteId, id, status: 'claimed', cycle },
					repeat
						? { $set: { status: 'pending', notifiedAt: at, claimedAt: null } }
						: { $set: { status: 'notified', notifiedAt: at, endedAt: at, expiresAt }, $unset: { active: '' } },
				);
				return (result.matchedCount ?? 0) > 0;
			},
			/**
			 * Give a claimed cycle back (pending) or end it as failed.
			 * @param {string} id
			 * @param {number} cycle
			 * @param {{ fail: boolean, expiresAt?: Date }} options
			 */
			release: async (id, cycle, { fail, expiresAt }) => {
				const at = new Date(now()).toISOString();
				const result = await subscriptions.updateOne(
					{ websiteId, id, status: 'claimed', cycle },
					fail
						? { $set: { status: 'failed', endedAt: at, ...(expiresAt ? { expiresAt } : {}) }, $unset: { active: '' } }
						: { $set: { status: 'pending', claimedAt: null } },
				);
				return (result.matchedCount ?? 0) > 0;
			},
			/**
			 * Double opt-in confirmation (unconfirmed → pending).
			 * @param {string} id
			 * @param {Date} expiresAt
			 */
			confirm: async (id, expiresAt) =>
				strip(
					await subscriptions.findOneAndUpdate(
						{ websiteId, id, status: 'unconfirmed', ...unexpired() },
						{ $set: { status: 'pending', confirmedAt: new Date(now()).toISOString(), expiresAt } },
						{ returnDocument: 'after' },
					),
				),
			/**
			 * End active subscriptions (one, or every one of a contact).
			 * @param {{ id?: string, contactKey?: string }} which
			 * @param {Date} expiresAt
			 * @returns {Promise<number>}
			 */
			unsubscribe: async ({ id, contactKey }, expiresAt) => {
				const at = new Date(now()).toISOString();
				const result = await subscriptions.updateMany(
					{ websiteId, ...(id ? { id } : { contactKey }), status: active },
					{ $set: { status: 'unsubscribed', endedAt: at, expiresAt }, $unset: { active: '' } },
				);
				return result.modifiedCount ?? 0;
			},
			/**
			 * Claimed subscriptions whose claim is older than `before` (recovery after a crash).
			 * @param {string} beforeIso
			 * @param {number} limit
			 */
			staleClaims: async (beforeIso, limit) =>
				(
					await subscriptions
						.find({ websiteId, status: 'claimed', claimedAt: { $lt: beforeIso } }, { sort: { claimedAt: 1 }, limit })
						.toArray()
				).map(strip),
			/**
			 * Waiters ahead of a subscription in its waitlist.
			 * @param {{ type: string, targetKey: string, rank: number, subscribedAt: string, id: string }} sub
			 */
			ahead: async (sub) =>
				subscriptions.countDocuments({
					websiteId,
					type: sub.type,
					targetKey: sub.targetKey,
					status: 'pending',
					...unexpired(),
					$or: [
						{ rank: { $lt: sub.rank } },
						{ rank: sub.rank, subscribedAt: { $lt: sub.subscribedAt } },
						{ rank: sub.rank, subscribedAt: sub.subscribedAt, id: { $lt: sub.id } },
					],
				}),
			/**
			 * A waitlist in order (pending only), from a cursor `<rank>|<subscribedAt>|<id>`.
			 * @param {{ type: string, targetKey: string, after?: unknown, fetchLimit: number }} query
			 */
			waitlist: async ({ type, targetKey, after, fetchLimit }) => {
				/** @type {Record<string, unknown>} */
				let range = {};
				if (typeof after === 'string') {
					const [rank, at, id] = after.split('|');
					if (rank !== undefined && at !== undefined && id !== undefined)
						range = {
							$or: [
								{ rank: { $gt: Number(rank) } },
								{ rank: Number(rank), subscribedAt: { $gt: at } },
								{ rank: Number(rank), subscribedAt: at, id: { $gt: id } },
							],
						};
				}
				return (
					await subscriptions
						.find(
							{ websiteId, type, targetKey, status: 'pending', ...unexpired(), ...range },
							{ sort: { rank: 1, subscribedAt: 1, id: 1 }, limit: fetchLimit },
						)
						.toArray()
				).map(strip);
			},
			/**
			 * Counts by type and status of subscriptions created since an instant.
			 * @param {string} sinceIso
			 */
			statsSince: async (sinceIso) =>
				(
					await subscriptions
						.aggregate([
							{ $match: { websiteId, subscribedAt: { $gte: sinceIso } } },
							{ $group: { _id: { type: '$type', status: '$status' }, count: { $sum: 1 } } },
						])
						.toArray()
				).map((/** @type {any} */ row) => ({ type: row._id.type, status: row._id.status, count: row.count })),
			/**
			 * Daily sign-ups since an instant (UTC days of `subscribedAt`).
			 * @param {string} sinceIso
			 */
			dailySince: async (sinceIso) =>
				(
					await subscriptions
						.aggregate([
							{ $match: { websiteId, subscribedAt: { $gte: sinceIso } } },
							{ $group: { _id: { $substrBytes: ['$subscribedAt', 0, 10] }, count: { $sum: 1 } } },
						])
						.toArray()
				).map((/** @type {any} */ row) => ({ day: row._id, count: row.count })),
			/**
			 * Personal data of a subject (customer id or contact key).
			 * @param {{ customerId?: string, contactKey?: string }} subject
			 */
			ofSubject: async (subject) =>
				(await subscriptions.find({ websiteId, ...subject }, { limit: 10_000 }).toArray()).map(strip),
			/**
			 * Anonymise a subject: addresses and display data removed, active subscriptions ended.
			 * @param {{ customerId?: string, contactKey?: string }} subject
			 */
			anonymize: async (subject) => {
				const at = new Date(now()).toISOString();
				const result = await subscriptions.updateMany(
					{ websiteId, ...subject },
					{
						$set: { address: null, customerId: null, item: null, tier: null, anonymizedAt: at },
						$unset: { active: '' },
					},
				);
				await subscriptions.updateMany(
					{ websiteId, anonymizedAt: at, status: active },
					{ $set: { status: 'unsubscribed', endedAt: at } },
				);
				return result.modifiedCount ?? 0;
			},
		}),
		messages: Object.freeze({
			/** @param {string} id */
			get: async (id) => strip(await messages.findOne({ websiteId, id })),
			/**
			 * Queue a message under a unique key (first write wins): true when this call queued it.
			 * @param {Record<string, unknown> & { key: string }} doc
			 */
			queue: async (doc) => {
				const result = await messages.updateOne(
					{ websiteId, key: doc.key },
					{ $setOnInsert: onInsert(doc) },
					{ upsert: true },
				);
				return (result.upsertedCount ?? 0) > 0;
			},
			/**
			 * Add an alert to the contact's open batch (created when none is open). Idempotent per subscription cycle.
			 * @param {string} batchKey
			 * @param {Record<string, unknown> & { subscriptionId: string, cycle: number }} item
			 * @param {Record<string, unknown>} doc fields of a new batch message (without `items`, `batchKey`, `open`)
			 * @returns {Promise<boolean>} true when the item was added by this call
			 */
			addToBatch: async (batchKey, item, doc) => {
				for (let attempt = 0; attempt < 3; attempt += 1) {
					try {
						const result = await messages.updateOne(
							{
								websiteId,
								batchKey,
								open: true,
								items: { $not: { $elemMatch: { subscriptionId: item.subscriptionId, cycle: item.cycle } } },
							},
							{ $push: { items: item }, $setOnInsert: onInsert(doc) },
							{ upsert: true },
						);
						return (result.modifiedCount ?? 0) > 0 || (result.upsertedCount ?? 0) > 0;
					} catch (error) {
						if (!isDuplicateKey(error)) throw error;
						// the open batch already holds the item, or another writer opened it first: look again
						const open = await messages.findOne({ websiteId, batchKey, open: true });
						if (
							open?.items?.some(
								(/** @type {any} */ i) => i.subscriptionId === item.subscriptionId && i.cycle === item.cycle,
							)
						)
							return false;
					}
				}
				return false;
			},
			/**
			 * Claim the next due message (or one whose lease expired) for this instance — the claim-before-send step.
			 * @param {{ owner: string, leaseMs: number }} lease
			 */
			claimDue: async ({ owner, leaseMs }) => {
				const at = now();
				return strip(
					await messages.findOneAndUpdate(
						{
							websiteId,
							$or: [
								{ status: 'queued', notBefore: { $lte: at } },
								{ status: 'sending', leaseUntil: { $lt: at } },
							],
						},
						{
							$set: { status: 'sending', leaseOwner: owner, leaseUntil: at + leaseMs },
							$unset: { open: '' },
							$inc: { attempts: 1 },
						},
						{ sort: { notBefore: 1 }, returnDocument: 'after' },
					),
				);
			},
			/**
			 * Leave a claimed message: back to the queue, or a final status. Only the lease owner may (compare-and-set).
			 * @param {string} id
			 * @param {string} owner
			 * @param {Record<string, unknown>} set
			 * @param {{ refundAttempt?: boolean }} [options]
			 */
			settle: async (id, owner, set, { refundAttempt = false } = {}) => {
				const result = await messages.updateOne(
					{ websiteId, id, status: 'sending', leaseOwner: owner },
					{ $set: { ...set, leaseUntil: null }, ...(refundAttempt ? { $inc: { attempts: -1 } } : {}) },
				);
				return (result.matchedCount ?? 0) > 0;
			},
			/**
			 * The message holding an alert of a subscription cycle (recovery).
			 * @param {string} subscriptionId
			 * @param {number} cycle
			 */
			ofItem: async (subscriptionId, cycle) =>
				strip(await messages.findOne({ websiteId, items: { $elemMatch: { subscriptionId, cycle } } })),
			/**
			 * Cancel queued messages of a contact (unsubscribe).
			 * @param {string} contactKey
			 */
			cancelForContact: async (contactKey) => {
				const result = await messages.updateMany(
					{ websiteId, contactKey, status: 'queued' },
					{ $set: { status: 'cancelled', error: 'unsubscribed' }, $unset: { open: '' } },
				);
				return result.modifiedCount ?? 0;
			},
			/**
			 * Newest first.
			 * @param {{ status?: string, after?: unknown, fetchLimit: number }} query
			 */
			list: async ({ status, after, fetchLimit }) =>
				(
					await messages
						.find(
							{ websiteId, ...(status ? { status } : {}), ...before('queuedAt', after) },
							{ sort: { queuedAt: -1, id: -1 }, limit: fetchLimit },
						)
						.toArray()
				).map(strip),
			/** Messages due now (for the job summary). */
			countDue: async () => messages.countDocuments({ websiteId, status: 'queued', notBefore: { $lte: now() } }),
			/**
			 * Counts by channel and status since an instant (and alerts delivered).
			 * @param {string} sinceIso
			 */
			statsSince: async (sinceIso) =>
				(
					await messages
						.aggregate([
							{ $match: { websiteId, queuedAt: { $gte: sinceIso }, kind: 'alert' } },
							{
								$group: {
									_id: { channel: '$channel', status: '$status' },
									count: { $sum: 1 },
									alerts: { $sum: { $size: { $ifNull: ['$items', []] } } },
								},
							},
						])
						.toArray()
				).map((/** @type {any} */ row) => ({
					channel: row._id.channel,
					status: row._id.status,
					count: row.count,
					alerts: row.alerts,
				})),
			/**
			 * Daily sent messages since an instant.
			 * @param {string} sinceIso
			 */
			dailySentSince: async (sinceIso) =>
				(
					await messages
						.aggregate([
							{ $match: { websiteId, status: 'sent', kind: 'alert', sentAt: { $gte: sinceIso } } },
							{ $group: { _id: { $substrBytes: ['$sentAt', 0, 10] }, count: { $sum: 1 } } },
						])
						.toArray()
				).map((/** @type {any} */ row) => ({ day: row._id, count: row.count })),
			/**
			 * Addresses of a subject's messages are removed (export reads them first).
			 * @param {string} contactKey
			 */
			ofContact: async (contactKey) =>
				(await messages.find({ websiteId, contactKey }, { limit: 10_000 }).toArray()).map(strip),
			/** @param {string} contactKey */
			anonymize: async (contactKey) => {
				const result = await messages.updateMany(
					{ websiteId, contactKey },
					{ $set: { to: null, anonymizedAt: new Date(now()).toISOString() } },
				);
				await messages.updateMany(
					{ websiteId, contactKey, status: 'queued' },
					{ $set: { status: 'cancelled', error: 'anonymized' } },
				);
				return result.modifiedCount ?? 0;
			},
		}),
		triggers: Object.freeze({
			/**
			 * Start a trigger run under a unique key: `{ created: false, run }` when the run exists (redelivery).
			 * @param {string} key
			 * @param {Record<string, unknown>} doc
			 */
			begin: async (key, doc) => {
				const result = await triggers.updateOne(
					{ websiteId, key },
					{ $setOnInsert: onInsert({ ...doc, key }) },
					{ upsert: true },
				);
				return { created: (result.upsertedCount ?? 0) > 0, run: strip(await triggers.findOne({ websiteId, key })) };
			},
			/**
			 * @param {string} key
			 * @param {Record<string, unknown>} set
			 */
			finish: async (key, set) => {
				await triggers.updateOne({ websiteId, key }, { $set: set });
				return strip(await triggers.findOne({ websiteId, key }));
			},
			/** @param {string} id */
			get: async (id) => strip(await triggers.findOne({ websiteId, id })),
			/** @param {number} limit */
			open: async (limit) => (await triggers.find({ websiteId, open: true }, { sort: { at: 1 }, limit }).toArray()).map(strip),
			/**
			 * Newest first.
			 * @param {{ after?: unknown, fetchLimit: number }} query
			 */
			list: async ({ after, fetchLimit }) =>
				(
					await triggers
						.find({ websiteId, ...before('at', after) }, { sort: { at: -1, id: -1 }, limit: fetchLimit })
						.toArray()
				).map(strip),
		}),
		items: Object.freeze({
			/** @param {string} targetKey */
			get: async (targetKey) => strip(await items.findOne({ websiteId, targetKey })),
			/**
			 * Optimistic save (version compare-and-set; version 0 = insert).
			 * @param {string} targetKey
			 * @param {number} version
			 * @param {import('../core/triggers.js').ItemState} state
			 */
			save: async (targetKey, version, state) => {
				if (version === 0) {
					try {
						await items.insertOne({ targetKey, ...state, version: 1 });
						return true;
					} catch (error) {
						if (isDuplicateKey(error)) return false;
						throw error;
					}
				}
				const result = await items.updateOne({ websiteId, targetKey, version }, { $set: { ...state, version: version + 1 } });
				return (result.matchedCount ?? 0) > 0;
			},
		}),
		counters: Object.freeze({
			/**
			 * Take one unit of a counter below its limit (atomic): false when the limit is reached.
			 * @param {string} key
			 * @param {number} limit
			 * @param {Date} expiresAt
			 */
			take: async (key, limit, expiresAt) => {
				try {
					const result = await counters.updateOne(
						{ websiteId, key, count: { $lt: limit } },
						{ $inc: { count: 1 }, $setOnInsert: onInsert({ expiresAt }) },
						{ upsert: true },
					);
					return (result.modifiedCount ?? 0) > 0 || (result.upsertedCount ?? 0) > 0;
				} catch (error) {
					if (!isDuplicateKey(error)) throw error;
					// the counter exists: at its limit, or created concurrently — take one without upserting
					const retry = await counters.updateOne({ websiteId, key, count: { $lt: limit } }, { $inc: { count: 1 } });
					return (retry.modifiedCount ?? 0) > 0;
				}
			},
			/**
			 * Give a unit back (a reservation whose send did not happen).
			 * @param {string} key
			 */
			give: async (key) => {
				await counters.updateOne({ websiteId, key, count: { $gt: 0 } }, { $inc: { count: -1 } });
			},
		}),
		suppressions: Object.freeze({
			/** @param {string} contactKey */
			has: async (contactKey) => (await suppressions.countDocuments({ websiteId, contactKey })) > 0,
			/**
			 * @param {string} contactKey
			 * @param {string} reason
			 */
			add: async (contactKey, reason) => {
				await suppressions.updateOne(
					{ websiteId, contactKey },
					{ $setOnInsert: onInsert({ at: new Date(now()).toISOString(), reason }) },
					{ upsert: true },
				);
			},
			/** @param {string} contactKey */
			remove: async (contactKey) => {
				await suppressions.deleteOne({ websiteId, contactKey });
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
