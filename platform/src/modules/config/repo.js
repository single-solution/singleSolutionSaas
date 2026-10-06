/**
 * Data access of the `config` module (its own collections only). Merchant-owned targets go through
 * `forMerchant(merchantId)`; platform policies through the unscoped platform collections.
 * @module
 */
import { isDuplicateKey } from '../../infra/util.js';
import { EXPERIMENTS, LAYERS, GLOBAL_LAYERS, GLOBAL_VERSIONS, SCHEDULES, TEMPLATES, VERSIONS } from './schema.js';

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
	/** @type {TenantRepository} */
	const templates = ctx.collection(TEMPLATES);
	/** @type {TenantRepository} */
	const schedules = ctx.collection(SCHEDULES);
	/** @type {TenantRepository} */
	const experiments = ctx.collection(EXPERIMENTS);

	/** @param {Location} at */
	const pin = (at) => (at.merchantId === null ? {} : { merchantId: at.merchantId });
	/** @param {Location} at */
	const layerOps = (at) =>
		/** @type {MutableOps} */ (at.merchantId === null ? platformLayers : layers.forMerchant(at.merchantId));
	/** @param {Location} at */
	const versionOps = (at) =>
		/** @type {ReadOps} */ (at.merchantId === null ? platformVersions : versions.forMerchant(at.merchantId));
	/** @param {string} merchantId */
	const tpl = (merchantId) => /** @type {MutableOps} */ (templates.forMerchant(merchantId));
	/** @param {string} merchantId */
	const sch = (merchantId) => /** @type {MutableOps} */ (schedules.forMerchant(merchantId));
	/** @param {string} merchantId */
	const exp = (merchantId) => /** @type {MutableOps} */ (experiments.forMerchant(merchantId));

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
		/** @param {Location} at @param {string} changeKey */
		findByChangeKey: (at, changeKey) => versionOps(at).findOne({ targetKey: at.key, changeKey, ...pin(at) }),
		/**
		 * Append a version record. `false` when the version number (or change key) is already taken.
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

		// templates
		/** @param {string} merchantId @param {Document} doc */
		insertTemplate: (merchantId, doc) => tpl(merchantId).insertOne(doc),
		/** @param {string} merchantId @param {string} templateId */
		getTemplate: (merchantId, templateId) => tpl(merchantId).findOne({ _id: templateId, merchantId }),
		/** @param {string} templateId */
		findTemplateAnyMerchant: (templateId) =>
			/** @type {MutableOps} */ (templates.acrossMerchants()).findOne({ _id: templateId }),
		/** @param {string} merchantId @param {string | null} appId */
		listTemplates: (merchantId, appId) =>
			tpl(merchantId)
				.find({ merchantId, ...(appId ? { appId } : {}) })
				.sort({ createdAt: -1 })
				.limit(200)
				.toArray(),
		/**
		 * @param {string} merchantId
		 * @param {string} templateId
		 * @param {number} fromVersion
		 * @param {Document} set
		 */
		updateTemplate: (merchantId, templateId, fromVersion, set) =>
			tpl(merchantId).findOneAndUpdate({ _id: templateId, merchantId, version: fromVersion }, { $set: set }),
		/**
		 * @param {string} merchantId
		 * @param {string} templateId
		 * @param {string} websiteId
		 * @param {Document} application
		 */
		recordApplication: (merchantId, templateId, websiteId, application) =>
			tpl(merchantId).updateOne({ _id: templateId, merchantId }, { $set: { [`applications.${websiteId}`]: application } }),

		// schedules
		/** @param {string} merchantId @param {Document} doc */
		insertSchedule: (merchantId, doc) => sch(merchantId).insertOne(doc),
		/** @param {string} merchantId @param {string} scheduleId */
		getSchedule: (merchantId, scheduleId) => sch(merchantId).findOne({ _id: scheduleId, merchantId }),
		/** @param {string} merchantId @param {string} key */
		listSchedules: (merchantId, key) =>
			sch(merchantId).find({ merchantId, targetKey: key }).sort({ at: 1 }).limit(200).toArray(),
		/**
		 * Scheduled changes of a merchant whose time has come and that are not finished, oldest first.
		 * @param {string} merchantId @param {Date} now @param {number} limit
		 */
		dueSchedules: (merchantId, now, limit) =>
			sch(merchantId)
				.find({ merchantId, status: { $in: ['pending', 'applying'] }, at: { $lte: now } })
				.sort({ at: 1 })
				.limit(limit)
				.toArray(),
		/**
		 * Atomic status transition; returns the updated document or null when `from` did not match.
		 * @param {string} merchantId
		 * @param {string} scheduleId
		 * @param {string[]} from
		 * @param {Document} set
		 */
		transitionSchedule: (merchantId, scheduleId, from, set) =>
			sch(merchantId).findOneAndUpdate({ _id: scheduleId, merchantId, status: { $in: from } }, { $set: set }),

		// experiments
		/** @param {string} merchantId @param {Document} doc */
		insertExperiment: (merchantId, doc) => exp(merchantId).insertOne(doc),
		/** @param {string} merchantId @param {string} experimentId */
		getExperiment: (merchantId, experimentId) => exp(merchantId).findOne({ _id: experimentId, merchantId }),
		/** @param {string} merchantId @param {string} subscriptionId @param {string} [status] */
		listExperiments: (merchantId, subscriptionId, status) =>
			exp(merchantId)
				.find({ merchantId, subscriptionId, ...(status ? { status } : {}) })
				.sort({ createdAt: -1 })
				.limit(200)
				.toArray(),
		/**
		 * @param {string} merchantId
		 * @param {string} experimentId
		 * @param {string[]} from
		 * @param {Document} set
		 * @returns {Promise<Document | null | 'conflict'>} `'conflict'` when another experiment already runs on the element
		 */
		transitionExperiment: async (merchantId, experimentId, from, set) => {
			try {
				return await exp(merchantId).findOneAndUpdate(
					{ _id: experimentId, merchantId, status: { $in: from } },
					{ $set: set },
				);
			} catch (error) {
				if (isDuplicateKey(error)) return 'conflict';
				throw error;
			}
		},
	});
};

/** @typedef {ReturnType<typeof createConfigRepo>} ConfigRepo */
