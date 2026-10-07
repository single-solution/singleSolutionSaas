/**
 * Data access of the `commerce` module (its own collections only). Merchant-scoped collections are reached with
 * `forMerchant(merchantId)` whenever the merchant is known; lookups by a global id (product calls, admin operations) use the
 * explicit `acrossMerchants()` view with an exact-id filter.
 * @module
 */
import { isDuplicateKey } from '../../infra/util.js';
import { ACCOUNTS, BILLING, COUNTERS, DOCUMENTS, HISTORY, LEDGER, PRICE_LISTS, SUBSCRIPTIONS, USAGE } from './schema.js';

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
	const documents = tenant(DOCUMENTS);
	const usage = tenant(USAGE);
	const counters = tenant(COUNTERS);
	const ledger = tenant(LEDGER);
	const accounts = tenant(ACCOUNTS);
	const history = tenant(HISTORY);
	const billing = tenant(BILLING);
	const priceLists = /** @type {ReadOps} */ (ctx.collection(PRICE_LISTS));
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
		/** Every merchant's ledger, for admin lists (exact filters only). */
		allLedgers: () => ledger.acrossMerchants(),
		/** @param {string} merchantId */
		accountOps: (merchantId) => /** @type {MutableOps} */ (accounts.forMerchant(merchantId)),

		// ---- money histories (PLAN 0.5.7 a)
		/** @param {Doc} doc */
		insertPriceList: (doc) => priceLists.insertOne(doc),
		/** @param {readonly string[]} appIds @param {Date} to @returns {Promise<Doc[]>} */
		priceListsOf: (appIds, to) =>
			appIds.length === 0
				? Promise.resolve([])
				: priceLists
						.find({ appId: { $in: [...appIds] }, at: { $lte: to } })
						.sort({ at: 1, _id: 1 })
						.toArray(),
		/**
		 * Append to a merchant's history; a `key` makes it happen once (false when it already did).
		 * @param {string} merchantId @param {Doc} doc
		 */
		appendHistory: async (merchantId, doc) => {
			try {
				await history.forMerchant(merchantId).insertOne(doc);
				return true;
			} catch (error) {
				if (doc.key && isDuplicateKey(error)) return false;
				throw error;
			}
		},
		/** @param {string} merchantId @param {Date} to @returns {Promise<Doc[]>} */
		historyOf: (merchantId, to) =>
			history
				.forMerchant(merchantId)
				.find({ merchantId, at: { $lte: to } })
				.sort({ at: 1, _id: 1 })
				.toArray(),

		// ---- billing state
		/** @param {string} merchantId @returns {Promise<Doc | null>} */
		billingOf: (merchantId) => billing.forMerchant(merchantId).findOne({ merchantId, _id: merchantId }),
		/**
		 * Conditional update of a merchant's billing state (`expect` fields must still hold); creates it when `expect` is
		 * null. False when another check got there first.
		 * @param {string} merchantId @param {Doc | null} expect @param {Doc} set
		 */
		updateBilling: async (merchantId, expect, set) => {
			const ops = /** @type {MutableOps} */ (billing.forMerchant(merchantId));
			if (expect === null) {
				try {
					await ops.insertOne({ _id: merchantId, ...set });
					return true;
				} catch (error) {
					if (isDuplicateKey(error)) return false;
					throw error;
				}
			}
			const res = await ops.updateOne({ merchantId, _id: merchantId, ...expect }, { $set: set });
			return res.matchedCount === 1;
		},
		/** @param {readonly string[]} states @param {number} limit @returns {Promise<Doc[]>} */
		billingInStates: (states, limit) =>
			billing
				.acrossMerchants()
				.find({ state: { $in: [...states] } })
				.sort({ merchantId: 1 })
				.limit(limit)
				.toArray(),
	});
};
/** @typedef {ReturnType<typeof createCommerceRepo>} CommerceRepo */
