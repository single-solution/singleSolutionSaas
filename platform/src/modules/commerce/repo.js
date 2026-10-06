/**
 * Data access of the `commerce` module (its own collections only). Merchant-scoped collections are reached with
 * `forMerchant(merchantId)` whenever the merchant is known; lookups by a global id (product calls, admin operations) use the
 * explicit `acrossMerchants()` view with an exact-id filter.
 * @module
 */
import { isDuplicateKey } from '../../infra/util.js';
import {
	ACCOUNTS,
	ALERTS,
	COUNTERS,
	DOCUMENTS,
	LEDGER,
	PAUSES,
	SPEND_POLICIES,
	SUBSCRIPTIONS,
	TIMELINE,
	USAGE,
} from './schema.js';

/** @typedef {import('../../infra/modules.js').ModuleContext} ModuleContext */
/** @typedef {import('../../infra/db.js').MutableOps} MutableOps */
/** @typedef {import('../../infra/db.js').ReadOps} ReadOps */
/** @typedef {Record<string, any>} Doc */

/**
 * @param {ModuleContext} ctx
 */
export const createCommerceRepo = (ctx) => {
	/** @param {string} name */
	const tenant = (name) => /** @type {import('../../infra/db.js').TenantRepository} */ (ctx.collection(name));
	const subscriptions = tenant(SUBSCRIPTIONS);
	const timeline = tenant(TIMELINE);
	const pauses = tenant(PAUSES);
	const documents = tenant(DOCUMENTS);
	const usage = tenant(USAGE);
	const counters = tenant(COUNTERS);
	const ledger = tenant(LEDGER);
	const accounts = tenant(ACCOUNTS);
	const policies = tenant(SPEND_POLICIES);
	const alerts = /** @type {ReadOps} */ (ctx.collection(ALERTS));
	/** @param {string} m */
	const subsOf = (m) => /** @type {MutableOps} */ (subscriptions.forMerchant(m));

	return Object.freeze({
		isDuplicateKey,
		// ---- subscriptions
		/** @param {string} id @returns {Promise<Doc | null>} */
		subscriptionById: (id) => subscriptions.acrossMerchants().findOne({ _id: id }),
		/** @param {string} merchantId @param {string} id @returns {Promise<Doc | null>} */
		subscriptionOf: (merchantId, id) => subsOf(merchantId).findOne({ merchantId, _id: id }),
		/** @param {string} websiteId @param {string} appId @returns {Promise<Doc | null>} */
		liveSubscription: (websiteId, appId) => subscriptions.acrossMerchants().findOne({ websiteId, appId, live: true }),
		/** @param {string} appId @returns {Promise<Doc[]>} */
		liveSubscriptionsOfApp: (appId) => subscriptions.acrossMerchants().find({ appId, live: true }).sort({ _id: 1 }).toArray(),
		/** @param {string} websiteId @returns {Promise<Doc[]>} */
		subscriptionsForWebsite: (websiteId) =>
			subscriptions.acrossMerchants().find({ websiteId }).sort({ createdAt: 1, _id: 1 }).toArray(),
		/**
		 * @param {string} merchantId
		 * @param {{ websiteId?: string | null, live?: boolean }} [filter]
		 * @returns {Promise<Doc[]>}
		 */
		subscriptionsOfMerchant: (merchantId, { websiteId = null, live } = {}) =>
			subsOf(merchantId)
				.find({ merchantId, ...(websiteId ? { websiteId } : {}), ...(live === true ? { live: true } : {}) })
				.sort({ createdAt: 1, _id: 1 })
				.toArray(),
		/** @param {Doc} doc */
		insertSubscription: (doc) => subsOf(doc.merchantId).insertOne(doc),
		/**
		 * Optimistic update guarded by `rev`; returns the updated document or null when `rev` moved.
		 * @param {Doc} sub
		 * @param {Doc} update update operators (rev is incremented here)
		 * @returns {Promise<Doc | null>}
		 */
		updateSubscription: (sub, update) =>
			subsOf(sub.merchantId).findOneAndUpdate(
				{ merchantId: sub.merchantId, _id: sub._id, rev: sub.rev },
				{ ...update, $inc: { ...(update.$inc ?? {}), rev: 1 } },
				{ returnDocument: 'after' },
			),
		/**
		 * Subscriptions with an unsettled complete hour before `target`, in (merchantId, _id) order after `after`.
		 * @param {{ target: Date, after: { merchantId: string, id: string } | null, merchantId?: string | null, limit: number }} input
		 * @returns {Promise<Doc[]>}
		 */
		dueForSettlement: ({ target, after, merchantId = null, limit }) =>
			subscriptions
				.acrossMerchants()
				.find({
					settlementDone: false,
					settledThrough: { $lt: target },
					...(merchantId ? { merchantId } : {}),
					...(after
						? { $or: [{ merchantId: { $gt: after.merchantId } }, { merchantId: after.merchantId, _id: { $gt: after.id } }] }
						: {}),
				})
				.sort({ merchantId: 1, _id: 1 })
				.limit(limit)
				.toArray(),
		/**
		 * Move the settlement cursor forward (never backwards); independent of `rev` so it never races holds.
		 * @param {Doc} sub @param {Date} cursor @param {boolean} done
		 */
		advanceCursor: (sub, cursor, done) =>
			subsOf(sub.merchantId).updateOne(
				{ merchantId: sub.merchantId, _id: sub._id, settledThrough: { $lte: cursor } },
				{ $set: { settledThrough: cursor, settlementDone: done } },
			),
		/** @param {string | null} after @param {number} limit @returns {Promise<Doc[]>} */
		subscriptionsAfter: (after, limit) =>
			subscriptions
				.acrossMerchants()
				.find(after ? { _id: { $gt: after } } : {})
				.sort({ _id: 1 })
				.limit(limit)
				.toArray(),

		// ---- timeline
		/** @param {Doc} sub @param {Date} at @param {string[]} elements */
		appendTimeline: (sub, at, elements) =>
			timeline.forMerchant(sub.merchantId).insertOne({ subscriptionId: sub._id, websiteId: sub.websiteId, at, elements }),
		/** @param {string} merchantId @param {string} subscriptionId @returns {Promise<Doc | null>} */
		lastTimeline: (merchantId, subscriptionId) =>
			timeline.forMerchant(merchantId).findOne({ merchantId, subscriptionId }, { sort: { at: -1, _id: -1 } }),
		/**
		 * The snapshot in effect at `from` plus every snapshot in `(from, to]`, ascending.
		 * @param {string} merchantId @param {string} subscriptionId @param {Date} from @param {Date} to
		 * @returns {Promise<Doc[]>}
		 */
		timelineWindow: async (merchantId, subscriptionId, from, to) => {
			const ops = timeline.forMerchant(merchantId);
			const before = await ops.findOne({ merchantId, subscriptionId, at: { $lte: from } }, { sort: { at: -1, _id: -1 } });
			const within = await ops
				.find({ merchantId, subscriptionId, at: { $gt: from, $lte: to } })
				.sort({ at: 1, _id: 1 })
				.toArray();
			return before ? [before, ...within] : within;
		},

		// ---- pauses
		/** @param {Doc} sub @param {string} reason @param {Date} from */
		openPause: async (sub, reason, from) => {
			const ops = /** @type {MutableOps} */ (pauses.forMerchant(sub.merchantId));
			const open = await ops.findOne({ merchantId: sub.merchantId, subscriptionId: sub._id, reason, to: null });
			if (!open) await ops.insertOne({ subscriptionId: sub._id, reason, from, to: null });
		},
		/** @param {Doc} sub @param {string | null} reason null = every open pause @param {Date} to */
		closePauses: (sub, reason, to) =>
			/** @type {MutableOps} */ (pauses.forMerchant(sub.merchantId)).updateMany(
				{ merchantId: sub.merchantId, subscriptionId: sub._id, to: null, ...(reason ? { reason } : {}) },
				{ $set: { to } },
			),
		/** @param {string} merchantId @param {string} subscriptionId @param {Date} from @param {Date} to @returns {Promise<Doc[]>} */
		pausesOverlapping: (merchantId, subscriptionId, from, to) =>
			pauses
				.forMerchant(merchantId)
				.find({ merchantId, subscriptionId, from: { $lt: to }, $or: [{ to: null }, { to: { $gt: from } }] })
				.sort({ from: 1 })
				.toArray(),

		// ---- documents
		/** @param {string} merchantId @param {string} subscriptionId @returns {Promise<Doc | null>} */
		documentOf: (merchantId, subscriptionId) => documents.forMerchant(merchantId).findOne({ merchantId, _id: subscriptionId }),
		/**
		 * Write a document state; `expectedVersion` null = first write. Returns false on a lost race.
		 * @param {string} merchantId @param {string} subscriptionId @param {number | null} expectedVersion @param {Doc} fields
		 */
		writeDocument: async (merchantId, subscriptionId, expectedVersion, fields) => {
			const ops = /** @type {MutableOps} */ (documents.forMerchant(merchantId));
			if (expectedVersion === null) {
				try {
					await ops.insertOne({ _id: subscriptionId, ...fields });
					return true;
				} catch (error) {
					if (isDuplicateKey(error)) return false;
					throw error;
				}
			}
			const res = await ops.updateOne({ merchantId, _id: subscriptionId, version: expectedVersion }, { $set: fields });
			return res.matchedCount === 1;
		},
		/** @param {string} merchantId @param {string} subscriptionId */
		deleteDocument: (merchantId, subscriptionId) =>
			/** @type {MutableOps} */ (documents.forMerchant(merchantId)).deleteOne({ merchantId, _id: subscriptionId }),

		// ---- usage
		/** @param {string} merchantId @param {Doc} record */
		insertUsage: (merchantId, record) => usage.forMerchant(merchantId).insertOne(record),
		/**
		 * Authoritative quantity per unit in one hour, from the records.
		 * @param {string} merchantId @param {string} subscriptionId @param {Date} bucket
		 * @returns {Promise<Record<string, number>>}
		 */
		usageInBucket: async (merchantId, subscriptionId, bucket) => {
			const rows = await usage
				.forMerchant(merchantId)
				.aggregate([
					{ $match: { merchantId, subscriptionId, bucket } },
					{ $group: { _id: '$unit', quantity: { $sum: '$quantity' } } },
				])
				.toArray();
			return Object.fromEntries(rows.map((r) => [String(r._id), Number(r.quantity)]));
		},
		/** @param {string} merchantId @param {string} subscriptionId @param {string} unit @param {Date} hour @param {number} quantity */
		incCounter: async (merchantId, subscriptionId, unit, hour, quantity) => {
			const ops = /** @type {MutableOps} */ (counters.forMerchant(merchantId));
			const _id = `${subscriptionId}:${unit}:${hour.toISOString()}`;
			const run = () =>
				ops.updateOne(
					{ merchantId, _id },
					{ $inc: { quantity }, $setOnInsert: { subscriptionId, unit, hour } },
					{ upsert: true },
				);
			try {
				await run();
			} catch (error) {
				if (!isDuplicateKey(error)) throw error;
				await run(); // concurrent upsert of the same counter
			}
		},
		/** @param {string} merchantId @param {string} subscriptionId @param {string} unit @param {Date} hour @param {number} quantity */
		setCounter: (merchantId, subscriptionId, unit, hour, quantity) =>
			/** @type {MutableOps} */ (counters.forMerchant(merchantId)).updateOne(
				{ merchantId, _id: `${subscriptionId}:${unit}:${hour.toISOString()}` },
				{ $set: { quantity }, $setOnInsert: { subscriptionId, unit, hour } },
				{ upsert: true },
			),
		/**
		 * Σ counters per unit for hours in `[from, to)`.
		 * @param {string} merchantId @param {string} subscriptionId @param {readonly string[]} units @param {Date} from @param {Date} to
		 * @returns {Promise<Record<string, number>>}
		 */
		countersBetween: async (merchantId, subscriptionId, units, from, to) => {
			if (units.length === 0) return {};
			const rows = await counters
				.forMerchant(merchantId)
				.aggregate([
					{ $match: { merchantId, subscriptionId, unit: { $in: [...units] }, hour: { $gte: from, $lt: to } } },
					{ $group: { _id: '$unit', quantity: { $sum: '$quantity' } } },
				])
				.toArray();
			return Object.fromEntries(rows.map((r) => [String(r._id), Number(r.quantity)]));
		},

		// ---- ledger and accounts
		/** @param {string} merchantId */
		ledgerOf: (merchantId) => ledger.forMerchant(merchantId),
		/** @param {string} merchantId */
		accountOps: (merchantId) => /** @type {MutableOps} */ (accounts.forMerchant(merchantId)),
		/** @param {string | null} after @param {number} limit @returns {Promise<Doc[]>} */
		accountsAfter: (after, limit) =>
			accounts
				.acrossMerchants()
				.find(after ? { _id: { $gt: after } } : {})
				.sort({ _id: 1 })
				.limit(limit)
				.toArray(),

		// ---- spend policies
		/** @param {string} merchantId @returns {Promise<Doc[]>} */
		policiesOf: (merchantId) => policies.forMerchant(merchantId).find({ merchantId }).sort({ createdAt: 1, _id: 1 }).toArray(),
		/** @param {string} merchantId */
		policyOps: (merchantId) => /** @type {MutableOps} */ (policies.forMerchant(merchantId)),

		// ---- alerts
		/** @param {Doc} alert */
		insertAlert: (alert) => alerts.insertOne(alert),
		/** @param {{ merchantId?: string | null, limit: number }} query @returns {Promise<Doc[]>} */
		listAlerts: ({ merchantId = null, limit }) =>
			alerts
				.find(merchantId ? { merchantId } : {})
				.sort({ at: -1, _id: -1 })
				.limit(limit)
				.toArray(),
	});
};
/** @typedef {ReturnType<typeof createCommerceRepo>} CommerceRepo */
