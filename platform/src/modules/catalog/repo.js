/**
 * Data access of the `catalog` module (its own collections only). Manifests are stored as canonical JSON strings
 * (feature schemas may use keys MongoDB treats specially) and parsed on read.
 * @module
 */
import { isDuplicateKey } from '../../infra/util.js';

/** @typedef {import('../../infra/db.js').MutableOps} MutableOps */
/** @typedef {import('@ss/contracts').Manifest} Manifest */
/** @typedef {import('./core/lifecycle.js').AppStatus} AppStatus */
/** @typedef {import('./core/lifecycle.js').VersionStatus} VersionStatus */

/**
 * @typedef {object} AppDoc
 * @property {string} _id appId
 * @property {string} slug
 * @property {'service' | 'pack'} kind
 * @property {AppStatus} status
 * @property {Date | null} sunsetAt
 * @property {{ production: { baseUrl: string } | null, staging: { baseUrl: string } | null }} environments
 * @property {number} currentVersion
 * @property {number | null} pendingVersion
 * @property {number} latestVersion highest version number allocated
 * @property {{ lastHeartbeatAt: Date | null, lastSeenAt?: Date | null, version: string | null, status: string | null, queues: Record<string, number> | null } | null} health
 * @property {string} createdBy
 * @property {Date} [createdAt]
 * @property {Date} [updatedAt]
 */

/**
 * @typedef {object} VersionDoc
 * @property {string} _id
 * @property {string} appId
 * @property {number} version
 * @property {string} manifestJson canonical JSON
 * @property {string} manifestHash SHA-256 hex of the canonical JSON
 * @property {string} productVersion manifest `product.version`
 * @property {VersionStatus} status
 * @property {'registration' | 'refresh' | 'upload'} source
 * @property {unknown} diff
 * @property {boolean} breaking
 * @property {Array<{ path: string, sha256: string, size: number, contentType?: string }> | null} assets packs only
 * @property {{ kid: string, alg: string, sig: string } | null} signature packs only
 * @property {string} submittedBy
 * @property {{ by: string, at: Date, reason: string | null } | null} review
 * @property {Date} [createdAt]
 */

/**
 * @typedef {object} KeyDoc
 * @property {string} _id
 * @property {string} appId
 * @property {string} kid
 * @property {import('@ss/protocol').PublicJwk} publicJwk
 * @property {string} thumbprint
 * @property {'active' | 'revoked'} status
 * @property {Date | null} notAfter
 * @property {string} source `registration` | `rotation` | `upload`
 * @property {{ at: Date, by: string, reason: string } | null} revoked
 * @property {Date} [createdAt]
 */

/** @param {string} appId @param {number} version */
export const versionId = (appId, version) => `${appId}:${version}`;
/** @param {string} appId @param {string} kid */
export const keyId = (appId, kid) => `${appId}:${kid}`;

/**
 * @param {{ apps: MutableOps, versions: MutableOps, keys: MutableOps, launches: MutableOps }} collections
 */
export const createCatalogRepo = ({ apps, versions, keys, launches }) =>
	Object.freeze({
		// --- apps
		/** @param {string} appId @returns {Promise<AppDoc | null>} */
		app: async (appId) => /** @type {AppDoc | null} */ (await apps.findOne({ _id: appId })),
		/** @param {string} slug @returns {Promise<AppDoc | null>} */
		appBySlug: async (slug) => /** @type {AppDoc | null} */ (await apps.findOne({ slug })),
		/**
		 * @param {AppDoc} doc
		 * @returns {Promise<boolean>} false when the slug is taken
		 */
		insertApp: async (doc) => {
			try {
				await apps.insertOne(doc);
				return true;
			} catch (error) {
				if (isDuplicateKey(error)) return false;
				throw error;
			}
		},
		/**
		 * Conditional update (optimistic: `expect` fields must still match).
		 * @param {string} appId
		 * @param {Record<string, unknown>} expect
		 * @param {Record<string, unknown>} update
		 * @returns {Promise<AppDoc | null>} the updated document, or null when the condition failed
		 */
		updateApp: async (appId, expect, update) =>
			/** @type {AppDoc | null} */ (
				await apps.findOneAndUpdate({ _id: appId, ...expect }, update, { returnDocument: 'after' })
			),
		/**
		 * Reserve the next version number.
		 * @param {string} appId
		 * @returns {Promise<number | null>}
		 */
		nextVersion: async (appId) => {
			const doc = await apps.findOneAndUpdate({ _id: appId }, { $inc: { latestVersion: 1 } }, { returnDocument: 'after' });
			return doc ? Number(doc.latestVersion) : null;
		},
		/**
		 * @param {{ status?: string[], kind?: string, after?: string | null, limit: number }} query
		 * @returns {Promise<AppDoc[]>}
		 */
		listApps: async ({ status, kind, after, limit }) =>
			/** @type {AppDoc[]} */ (
				await apps
					.find(
						{
							...(status ? { status: { $in: status } } : {}),
							...(kind ? { kind } : {}),
							...(after ? { _id: { $gt: after } } : {}),
						},
						{ sort: { _id: 1 }, limit },
					)
					.toArray()
			),

		// --- versions
		/** @param {VersionDoc} doc */
		insertVersion: async (doc) => {
			await versions.insertOne(doc);
		},
		/** @param {string} appId @param {number} version @returns {Promise<VersionDoc | null>} */
		version: async (appId, version) =>
			/** @type {VersionDoc | null} */ (await versions.findOne({ _id: versionId(appId, version) })),
		/** @param {Array<{ appId: string, version: number }>} refs @returns {Promise<VersionDoc[]>} */
		versionsByRef: async (refs) =>
			refs.length === 0
				? []
				: /** @type {VersionDoc[]} */ (
						await versions.find({ _id: { $in: refs.map((r) => versionId(r.appId, r.version)) } }).toArray()
					),
		/** @param {string} appId @param {{ before?: number | null, limit: number }} page @returns {Promise<VersionDoc[]>} */
		listVersions: async (appId, { before, limit }) =>
			/** @type {VersionDoc[]} */ (
				await versions
					.find(
						{ appId, ...(before ? { version: { $lt: before } } : {}) },
						{ sort: { version: -1 }, limit, projection: { manifestJson: 0 } },
					)
					.toArray()
			),
		/**
		 * @param {string} appId
		 * @param {number} version
		 * @param {VersionStatus} from
		 * @param {Record<string, unknown>} set
		 * @returns {Promise<boolean>}
		 */
		setVersionStatus: async (appId, version, from, set) =>
			(await versions.updateOne({ _id: versionId(appId, version), status: from }, { $set: set })).modifiedCount === 1,

		// --- keys
		/** @param {KeyDoc} doc @returns {Promise<boolean>} false when the kid exists */
		insertKey: async (doc) => {
			try {
				await keys.insertOne(doc);
				return true;
			} catch (error) {
				if (isDuplicateKey(error)) return false;
				throw error;
			}
		},
		/** @param {string} appId @returns {Promise<KeyDoc[]>} */
		keys: async (appId) => /** @type {KeyDoc[]} */ (await keys.find({ appId }, { sort: { createdAt: 1, _id: 1 } }).toArray()),
		/** @param {string} appId @param {Date} notAfter */
		limitActiveKeys: async (appId, notAfter) => {
			await keys.updateMany({ appId, status: 'active', notAfter: null }, { $set: { notAfter } });
		},
		/** @param {string} appId @param {string} kid @param {{ at: Date, by: string, reason: string }} revoked */
		revokeKey: async (appId, kid, revoked) =>
			(await keys.updateOne({ _id: keyId(appId, kid), status: 'active' }, { $set: { status: 'revoked', revoked } }))
				.modifiedCount === 1,

		// --- launches
		/** @param {{ _id: string, appId: string, kind: string, subject: string, merchantId: string | null, actor: string | null, expireAt: Date }} doc */
		insertLaunch: async (doc) => {
			await launches.insertOne(doc);
		},
		/** @param {string} appId @param {string} jti */
		launch: async (appId, jti) => launches.findOne({ _id: jti, appId }),
	});
/** @typedef {ReturnType<typeof createCatalogRepo>} CatalogRepo */
