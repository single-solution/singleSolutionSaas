/**
 * Data access of the `config` module (its own collections only). Merchant-owned targets go through
 * `forMerchant(merchantId)`; platform policies through the unscoped platform collections.
 * @module
 */
import { isDuplicateKey } from '../../infra/util.js';
import { LAYERS, GLOBAL_LAYERS, GLOBAL_VERSIONS, VERSIONS } from './schema.js';

/** @typedef {import('../../infra/db.js').MutableOps} MutableOps */
/** @typedef {import('../../infra/db.js').ReadOps} ReadOps */
/** @typedef {import('../../infra/db.js').TenantRepository} TenantRepository */
/** @typedef {import('mongodb').Document} Document */

/**
 * A storage location: the target key and the merchant that owns it (`null` = platform policy).
 * @typedef {{ key: string, merchantId: string | null }} Location
 */

/**
 * @param {import('../../infra/modules.js').ModuleContext} ctx
 */
export const createConfigRepo = (ctx) => {
	/** @type {TenantRepository} */
	const layers = ctx.collection(LAYERS);
	/** @type {TenantRepository} */
	const versions = ctx.collection(VERSIONS);
	/** @type {MutableOps} */
	const platformLayers = ctx.collection(GLOBAL_LAYERS);
	/** @type {ReadOps} */
	const platformVersions = ctx.collection(GLOBAL_VERSIONS);

	/** @param {Location} at */
	const pin = (at) => (at.merchantId === null ? {} : { merchantId: at.merchantId });
	/** @param {Location} at */
	const layerOps = (at) =>
		/** @type {MutableOps} */ (at.merchantId === null ? platformLayers : layers.forMerchant(at.merchantId));
	/** @param {Location} at */
	const versionOps = (at) =>
		/** @type {ReadOps} */ (at.merchantId === null ? platformVersions : versions.forMerchant(at.merchantId));

	return Object.freeze({
		/** @param {Location} at */
		getLayer: (at) => layerOps(at).findOne({ _id: at.key, ...pin(at) }),
		/**
		 * Several layers of one merchant (or platform) at once.
		 * @param {string | null} merchantId
		 * @param {string[]} keys
		 */
		getLayers: (merchantId, keys) =>
			layerOps({ key: '', merchantId })
				.find({ _id: { $in: keys }, ...(merchantId === null ? {} : { merchantId }) })
				.toArray(),
		/** @param {Location} at */
		latestVersion: async (at) => {
			const [doc] = await versionOps(at)
				.find({ targetKey: at.key, ...pin(at) })
				.sort({ version: -1 })
				.limit(1)
				.toArray();
			return doc ?? null;
		},
		/** @param {Location} at @param {number} version */
		getVersion: (at, version) => versionOps(at).findOne({ targetKey: at.key, version, ...pin(at) }),
		/**
		 * Append a version record. `false` when the version number is already taken.
		 * @param {Location} at
		 * @param {Document} record
		 */
		insertVersion: async (at, record) => {
			try {
				await versionOps(at).insertOne({ ...record, targetKey: at.key, ...pin(at) });
				return true;
			} catch (error) {
				if (isDuplicateKey(error)) return false;
				throw error;
			}
		},
		/**
		 * Newest-first version records older than `before` (a version number).
		 * @param {Location} at
		 * @param {{ before: number | null, limit: number }} page
		 */
		listVersions: (at, { before, limit }) =>
			versionOps(at)
				.find({ targetKey: at.key, ...pin(at), ...(before === null ? {} : { version: { $lt: before } }) })
				.sort({ version: -1 })
				.limit(limit)
				.toArray(),
		/**
		 * Move the materialised layer forward to `doc.version` (monotonic: never moves backwards).
		 * @param {Location} at
		 * @param {Document & { version: number }} doc
		 */
		writeLayer: async (at, doc) => {
			try {
				await layerOps(at).updateOne(
					{ _id: at.key, ...pin(at), version: { $lt: doc.version } },
					{ $set: { ...doc } },
					{ upsert: true },
				);
			} catch (error) {
				if (!isDuplicateKey(error)) throw error; // a newer version is already materialised
			}
		},
	});
};

/** @typedef {ReturnType<typeof createConfigRepo>} ConfigRepo */
