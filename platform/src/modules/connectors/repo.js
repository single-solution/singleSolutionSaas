/**
 * Data access of the `connectors` module (its own collections only). Every merchant operation goes through
 * `forMerchant(merchantId)`; only staff listings and internal checks by id use `acrossMerchants()`.
 * @module
 */
import { isDuplicateKey } from '../../infra/util.js';

/** @typedef {import('../../infra/db.js').TenantRepository} TenantRepository */
/** @typedef {import('../../infra/db.js').MutableOps} MutableOps */
/** @typedef {import('mongodb').Document} Document */

/**
 * @param {{ connectors: TenantRepository, assignments: TenantRepository }} repos
 */
export const createConnectorsRepo = ({ connectors, assignments }) => {
	/** @param {string} merchantId */
	const c = (merchantId) => /** @type {MutableOps} */ (connectors.forMerchant(merchantId));
	/** @param {string} merchantId */
	const a = (merchantId) => /** @type {MutableOps} */ (assignments.forMerchant(merchantId));
	const across = () => /** @type {MutableOps} */ (connectors.acrossMerchants());

	return Object.freeze({
		/**
		 * @param {string} merchantId
		 * @param {Document} doc
		 */
		insert: (merchantId, doc) => c(merchantId).insertOne(doc),
		/**
		 * @param {string} merchantId
		 * @param {string} connectorId
		 */
		get: (merchantId, connectorId) => c(merchantId).findOne({ merchantId, _id: connectorId }),
		/**
		 * Newest first, keyset after `[createdAtMs, id]`.
		 * @param {string} merchantId
		 * @param {{ kind?: string, status?: string, websiteId?: string, after?: [number, string] | null, limit: number }} query
		 */
		list: (merchantId, { kind, status, websiteId, after, limit }) => {
			/** @type {Document} */
			const filter = { merchantId };
			if (kind) filter.kind = kind;
			if (status) filter.status = status;
			if (websiteId) filter.websiteIds = websiteId;
			if (after) {
				const at = new Date(after[0]);
				filter.$or = [{ createdAt: { $lt: at } }, { createdAt: at, _id: { $lt: after[1] } }];
			}
			return c(merchantId).find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit).toArray();
		},
		/**
		 * Staff listing across merchants (callers strip secrets).
		 * @param {{ merchantId?: string, kind?: string, status?: string, after?: [number, string] | null, limit: number }} query
		 */
		listAcross: ({ merchantId, kind, status, after, limit }) => {
			/** @type {Document} */
			const filter = {};
			if (merchantId) filter.merchantId = merchantId;
			if (kind) filter.kind = kind;
			if (status) filter.status = status;
			if (after) {
				const at = new Date(after[0]);
				filter.$or = [{ createdAt: { $lt: at } }, { createdAt: at, _id: { $lt: after[1] } }];
			}
			return across()
				.find(filter, { projection: { sealed: 0 } })
				.sort({ createdAt: -1, _id: -1 })
				.limit(limit)
				.toArray();
		},
		/** @param {string} connectorId */
		findAcross: (connectorId) => across().findOne({ _id: connectorId }),
		/**
		 * Connectors attached to a website (any status).
		 * @param {string} merchantId
		 * @param {string} websiteId
		 */
		forWebsite: (merchantId, websiteId) => c(merchantId).find({ merchantId, websiteIds: websiteId }).toArray(),
		/**
		 * Compare-and-set on `version`; returns the updated document or null when it changed meanwhile.
		 * @param {string} merchantId
		 * @param {string} connectorId
		 * @param {number} version
		 * @param {Document} set
		 * @param {{ bump?: boolean }} [options]
		 */
		update: (merchantId, connectorId, version, set, { bump = true } = {}) =>
			c(merchantId).findOneAndUpdate(
				{ merchantId, _id: connectorId, version },
				{ $set: set, ...(bump ? { $inc: { version: 1 } } : {}) },
				{ returnDocument: 'after' },
			),
		/**
		 * @param {string} merchantId
		 * @param {string} connectorId
		 */
		remove: (merchantId, connectorId) => c(merchantId).deleteOne({ merchantId, _id: connectorId }),
		/**
		 * Claim (website, kind) for a connector; false when another connector holds it.
		 * @param {string} merchantId
		 * @param {{ websiteId: string, kind: string, connectorId: string }} input
		 */
		claim: async (merchantId, { websiteId, kind, connectorId }) => {
			try {
				await a(merchantId).insertOne({ _id: `${websiteId}:${kind}`, websiteId, kind, connectorId });
				return true;
			} catch (error) {
				if (!isDuplicateKey(error)) throw error;
				const held = await a(merchantId).findOne({ merchantId, _id: `${websiteId}:${kind}` });
				return held?.connectorId === connectorId;
			}
		},
		/**
		 * @param {string} merchantId
		 * @param {{ websiteId: string, kind: string, connectorId: string }} input
		 */
		release: (merchantId, { websiteId, kind, connectorId }) =>
			a(merchantId).deleteOne({ merchantId, _id: `${websiteId}:${kind}`, connectorId }),
		/**
		 * @param {string} merchantId
		 * @param {string} connectorId
		 */
		releaseAll: (merchantId, connectorId) => a(merchantId).deleteMany({ merchantId, connectorId }),
		/**
		 * The connector assigned to (website, kind), if any.
		 * @param {string} merchantId
		 * @param {string} websiteId
		 * @param {string} kind
		 */
		assigned: async (merchantId, websiteId, kind) => {
			const row = await a(merchantId).findOne({ merchantId, _id: `${websiteId}:${kind}` });
			return row ? c(merchantId).findOne({ merchantId, _id: row.connectorId }) : null;
		},
	});
};
/** @typedef {ReturnType<typeof createConnectorsRepo>} ConnectorsRepo */
