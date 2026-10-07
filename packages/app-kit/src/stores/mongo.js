/**
 * The production product database store on MongoDB (the product's own `MONGODB_URI`, never a merchant database).
 * Each collection is `<prefix><name>` (default prefix `kit_`). Indexes are created lazily and idempotently on first use:
 * `websiteId` on per-website collections, `subject` and `websiteIds` on sessions, and TTL indexes on `expireAt`.
 * Documents with a numeric `expiresAt` (epoch ms) are hidden once it has passed and removed by the TTL index.
 * @module
 */

import { omit } from '../util.js';

/** @typedef {import('mongodb').Db} Db */
/** @typedef {import('./types.js').Store} Store */
/** @typedef {import('./types.js').Doc} Doc */

const COLLECTIONS = Object.freeze([
	'state',
	'switches',
	'settings',
	'connections',
	'changes',
	'status',
	'revoked',
	'business',
	'widget',
	'sessions',
]);
const PER_WEBSITE = Object.freeze(['switches', 'settings', 'connections', 'status', 'business', 'widget']);

/**
 * @param {unknown} error
 * @returns {boolean}
 */
const isDuplicateKey = (error) => typeof error === 'object' && error !== null && /** @type {any} */ (error).code === 11000;

/**
 * @param {Doc | null} raw
 * @param {number} t
 * @returns {Doc | null}
 */
const fromMongo = (raw, t) => {
	if (!raw) return null;
	const doc = omit(raw, ['_id', 'expireAt']);
	if (typeof doc.expiresAt === 'number' && doc.expiresAt <= t) return null;
	return doc;
};

/**
 * @param {string} id
 * @param {Doc} doc
 * @returns {Doc}
 */
const toMongo = (id, doc) => ({
	...doc,
	_id: id,
	...(typeof doc.expiresAt === 'number' ? { expireAt: new Date(doc.expiresAt) } : {}),
});

/**
 * @param {{ db: Db, prefix?: string, now?: () => number }} options
 * @returns {Store & { ensureIndexes: () => Promise<void> }}
 */
export const createMongoStore = ({ db, prefix = 'kit_', now = Date.now }) => {
	if (!db || typeof db.collection !== 'function') throw new TypeError('createMongoStore needs a mongodb Db');
	/** @param {string} name */
	const col = (name) => db.collection(`${prefix}${name}`);
	/** @type {Promise<void> | undefined} */
	let ready;
	const ensureIndexes = () => {
		ready ??= (async () => {
			const ttl = { expireAfterSeconds: 0, name: 'ttl' };
			await Promise.all([
				...PER_WEBSITE.map((name) => col(name).createIndex({ websiteId: 1 }, { name: 'website' })),
				col('changes').createIndex({ websiteId: 1, at: -1 }, { name: 'website_at' }),
				col('sessions').createIndex({ subject: 1 }, { name: 'subject' }),
				col('sessions').createIndex({ websiteIds: 1 }, { name: 'websites' }),
				...['sessions', 'replay', 'rate'].map((name) => col(name).createIndex({ expireAt: 1 }, ttl)),
			]);
		})().catch((error) => {
			ready = undefined;
			throw error;
		});
		return ready;
	};
	/** @param {string} name */
	const check = (name) => {
		if (!COLLECTIONS.includes(name)) throw new TypeError(`unknown collection ${name}`);
		return col(name);
	};

	return Object.freeze({
		ensureIndexes,
		get: async (collection, id) => fromMongo(await check(collection).findOne(/** @type {any} */ ({ _id: id })), now()),
		put: async (collection, id, doc) => {
			await ensureIndexes();
			await check(collection).replaceOne(/** @type {any} */ ({ _id: id }), toMongo(id, doc), { upsert: true });
		},
		insert: async (collection, id, doc) => {
			await ensureIndexes();
			const c = check(collection);
			try {
				await c.insertOne(/** @type {any} */ (toMongo(id, doc)));
				return true;
			} catch (error) {
				if (!isDuplicateKey(error)) throw error;
			}
			// an expired document may still exist until the TTL monitor runs: take it over
			const taken = await c.replaceOne(/** @type {any} */ ({ _id: id, expiresAt: { $lte: now() } }), toMongo(id, doc));
			return taken.modifiedCount === 1;
		},
		delete: async (collection, id) => {
			await check(collection).deleteOne(/** @type {any} */ ({ _id: id }));
		},
		list: async (collection, filter, { limit = 1000 } = {}) => {
			const t = now();
			const rows = await check(collection)
				.find(/** @type {any} */ ({ ...filter, expiresAt: { $not: { $lte: t } } }))
				.sort({ at: -1, _id: 1 })
				.limit(limit)
				.toArray();
			return rows.map((row) => /** @type {Doc} */ (fromMongo(row, t)));
		},
		deleteWhere: async (collection, filter) => {
			const result = await check(collection).deleteMany(/** @type {any} */ ({ ...filter }));
			return result.deletedCount;
		},
		seen: async (id, expiresAtMs) => {
			await ensureIndexes();
			const c = col('replay');
			try {
				await c.insertOne(/** @type {any} */ ({ _id: id, expireAt: new Date(expiresAtMs) }));
				return false;
			} catch (error) {
				if (!isDuplicateKey(error)) throw error;
			}
			const taken = await c.updateOne(/** @type {any} */ ({ _id: id, expireAt: { $lte: new Date(now()) } }), {
				$set: { expireAt: new Date(expiresAtMs) },
			});
			return taken.modifiedCount === 0;
		},
		forget: async (id) => {
			await col('replay').deleteOne(/** @type {any} */ ({ _id: id }));
		},
		hit: async (key, windowMs, t) => {
			await ensureIndexes();
			const start = Math.floor(t / windowMs) * windowMs;
			const doc = await col('rate').findOneAndUpdate(
				/** @type {any} */ ({ _id: `${key}|${start}` }),
				{ $inc: { count: 1 }, $setOnInsert: { expireAt: new Date(start + windowMs + 60_000) } },
				{ upsert: true, returnDocument: 'after' },
			);
			return { count: Number(doc?.count ?? 1), resetAt: start + windowMs };
		},
	});
};
