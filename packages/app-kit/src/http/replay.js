/**
 * Idempotent-replay bodies live in the merchant's own database, never in the product's control store: collection
 * `ss_<slug>_idempotency` (`{ websiteId, key, body, expireAt }`, unique `(websiteId, key)`, TTL 24 h). The control
 * store only keeps the HMAC'd key and fingerprint, the status and an allowlisted subset of headers.
 * @module
 */

/** Unprefixed collection name (→ `ss_<slug>_idempotency`). */
export const REPLAY_COLLECTION = 'idempotency';
/** How long a replay body is kept. */
export const REPLAY_TTL_MS = 24 * 60 * 60_000;
/** Response headers kept for a replay (everything else, e.g. cookies or per-request headers, is dropped). */
export const REPLAY_HEADERS = Object.freeze([
	'content-type',
	'content-language',
	'location',
	'link',
	'etag',
	'last-modified',
	'cache-control',
]);

/** @type {import('../data.js').IndexDefinition[]} */
const INDEXES = [
	{ collection: REPLAY_COLLECTION, keys: { websiteId: 1, key: 1 }, unique: true, name: 'key' },
	{ collection: REPLAY_COLLECTION, keys: { expireAt: 1 }, expireAfterSeconds: 0, name: 'ttl' },
];

/**
 * @param {Record<string, string>} headers
 * @returns {Record<string, string>} the allowlisted subset (lower-case names)
 */
export const replayHeaders = (headers) => {
	/** @type {Record<string, string>} */
	const out = {};
	for (const [name, value] of Object.entries(headers)) {
		const lower = name.toLowerCase();
		if (REPLAY_HEADERS.includes(lower)) out[lower] = value;
	}
	return out;
};

/**
 * @param {unknown} error
 * @returns {boolean}
 */
const isDuplicateKey = (error) => typeof error === 'object' && error !== null && /** @type {any} */ (error).code === 11000;

/**
 * @param {{ data: { forWebsite: (websiteId: string, stamp?: { merchantId?: string, env?: 'live' | 'test' }) => Promise<import('../data.js').WebsiteData> },
 *   now: () => number, logger: import('../logger.js').Logger }} options
 */
export const createReplayBodies = ({ data, now, logger }) => {
	/** @type {Set<string>} websites whose indexes were ensured by this instance */
	const indexed = new Set();

	/**
	 * @param {string} websiteId
	 * @param {{ merchantId?: string, env?: 'live' | 'test' }} stamp
	 */
	const collectionOf = async (websiteId, stamp) => {
		const scope = await data.forWebsite(websiteId, stamp);
		if (!indexed.has(websiteId)) {
			await scope.ensureIndexes(INDEXES.map((def) => ({ ...def })));
			indexed.add(websiteId);
		}
		return scope.collection(REPLAY_COLLECTION);
	};

	return Object.freeze({
		/**
		 * Store a body; false when it could not be stored (the replay then answers 409).
		 * @param {{ websiteId: string, stamp?: { merchantId?: string, env?: 'live' | 'test' }, key: string, body: string }} input
		 * @returns {Promise<boolean>}
		 */
		put: async ({ websiteId, stamp = {}, key, body }) => {
			try {
				const collection = await collectionOf(websiteId, stamp);
				const expireAt = new Date(now() + REPLAY_TTL_MS);
				try {
					await collection.insertOne({ websiteId, key, body, expireAt });
				} catch (error) {
					if (!isDuplicateKey(error)) throw error;
					await collection.updateOne({ websiteId, key }, { $set: { body, expireAt } });
				}
				return true;
			} catch (error) {
				logger.warn('idempotent replay body not stored', { websiteId, error });
				return false;
			}
		},
		/**
		 * @param {{ websiteId: string, stamp?: { merchantId?: string, env?: 'live' | 'test' }, key: string }} input
		 * @returns {Promise<string | null>}
		 */
		get: async ({ websiteId, stamp = {}, key }) => {
			try {
				const collection = await collectionOf(websiteId, stamp);
				const doc = await collection.findOne({ websiteId, key });
				if (!doc || typeof doc.body !== 'string') return null;
				if (doc.expireAt instanceof Date && doc.expireAt.getTime() <= now()) return null;
				return doc.body;
			} catch (error) {
				logger.warn('idempotent replay body unavailable', { websiteId, error });
				return null;
			}
		},
	});
};
