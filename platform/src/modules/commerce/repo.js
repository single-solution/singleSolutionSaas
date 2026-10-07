/**
 * Data access of the `commerce` module (its own collections only). Merchant-scoped collections are reached with
 * `forMerchant(merchantId)` whenever the merchant is known; lookups by a global id (product calls, admin operations) use the
 * explicit `acrossMerchants()` view with an exact-id filter.
 * @module
 */
import { isDuplicateKey } from '../../infra/util.js';
import { ACCOUNTS, BILLING, HISTORY, LEDGER, PRICE_LISTS, PRODUCTS } from './schema.js';

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
	const products = tenant(PRODUCTS);
	const ledger = tenant(LEDGER);
	const accounts = tenant(ACCOUNTS);
	const history = tenant(HISTORY);
	const billing = tenant(BILLING);
	const priceLists = /** @type {ReadOps} */ (ctx.collection(PRICE_LISTS));

	return Object.freeze({
		isDuplicateKey,
		// ---- products on websites
		/** @param {string} merchantId */
		productsOf: (merchantId) => /** @type {MutableOps} */ (products.forMerchant(merchantId)),
		/** Every merchant's products on websites, for lookups by a global id (exact filters only). */
		allProducts: () => /** @type {MutableOps} */ (products.acrossMerchants()),

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
		/** @param {string} productId @returns {Promise<Doc | null>} the last accepted price list */
		lastPriceList: (productId) => priceLists.findOne({ productId }, { sort: { version: -1 } }),
		/** @param {string} productId @returns {Promise<string[]>} every feature key the product ever priced */
		knownFeatures: async (productId) =>
			(
				await priceLists
					.aggregate([{ $match: { productId } }, { $unwind: '$features' }, { $group: { _id: '$features.key' } }])
					.toArray()
			).map((row) => String(row._id)),
		/** @param {readonly string[]} productIds @param {Date} to @returns {Promise<Doc[]>} */
		priceListsOf: (productIds, to) =>
			productIds.length === 0
				? Promise.resolve([])
				: priceLists
						.find({ productId: { $in: [...productIds] }, at: { $lte: to } })
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
