/**
 * Shared atomic stores on the control-plane database, used by the HTTP layer and the protocol verifiers. Each is
 * one collection with a unique `_id` and a TTL index on `expireAt` (declared in `infra/schema.js`), so every
 * serverless instance sees the same state (F.5: "replay/nonce stores in production are one shared atomic TTL store").
 * @module
 */
import { isDuplicateKey } from './util.js';

/** @typedef {import('./db.js').MutableOps} MutableOps */

/**
 * @typedef {{ status: number, headers: Array<[string, string]>, body: string }} StoredResponse
 * @typedef {{ status: number, headers: Array<[string, string]>, body: string | null }} IdempotentOutcome a stored
 *   response, or only its status (`body: null`) for no-store routes
 * @typedef {{ state: 'new' } | { state: 'pending' } | { state: 'mismatch' } | { state: 'done', response: IdempotentOutcome }} IdempotencyBegin
 */

/**
 * Replay store (`@ss/protocol` interface `{ seen(id, expiresAtMs) → boolean }`; true = already seen). The TTL
 * monitor runs about once a minute, so an expired record that still exists is taken over atomically.
 * @param {MutableOps} repo
 * @param {{ now?: () => number }} [options]
 */
export const createReplayStore = (repo, { now = Date.now } = {}) =>
	Object.freeze({
		/**
		 * @param {string} id
		 * @param {number} expiresAtMs
		 * @returns {Promise<boolean>}
		 */
		seen: async (id, expiresAtMs) => {
			try {
				await repo.insertOne({ _id: id, expireAt: new Date(expiresAtMs) });
				return false;
			} catch (error) {
				if (!isDuplicateKey(error)) throw error;
			}
			const taken = await repo.updateOne(
				{ _id: id, expireAt: { $lte: new Date(now()) } },
				{ $set: { expireAt: new Date(expiresAtMs) } },
			);
			return taken.modifiedCount === 0;
		},
	});

/**
 * Idempotency records: `begin` claims a key (or reports pending / mismatch / the stored outcome), `complete`
 * stores the outcome (the full response, or only the status with `body: null`), `release` forgets a key whose
 * request failed with a 5xx (so the retry runs). Fingerprints are keyed HMACs computed by the HTTP layer.
 * @param {MutableOps} repo
 * @param {{ now?: () => number }} [options]
 */
export const createIdempotencyStore = (repo, { now = Date.now } = {}) =>
	Object.freeze({
		/**
		 * @param {string} key
		 * @param {string} fingerprint
		 * @param {number} expiresAtMs
		 * @returns {Promise<IdempotencyBegin>}
		 */
		begin: async (key, fingerprint, expiresAtMs) => {
			const fresh = { fingerprint, response: null, expireAt: new Date(expiresAtMs) };
			try {
				await repo.insertOne({ _id: key, ...fresh });
				return { state: 'new' };
			} catch (error) {
				if (!isDuplicateKey(error)) throw error;
			}
			const taken = await repo.replaceOne({ _id: key, expireAt: { $lte: new Date(now()) } }, fresh);
			if (/** @type {any} */ (taken).modifiedCount === 1) return { state: 'new' };
			const doc = await repo.findOne({ _id: key });
			if (!doc) return { state: 'pending' };
			if (doc.fingerprint !== fingerprint) return { state: 'mismatch' };
			return doc.response
				? { state: 'done', response: /** @type {IdempotentOutcome} */ (doc.response) }
				: { state: 'pending' };
		},
		/**
		 * @param {string} key
		 * @param {IdempotentOutcome} response
		 */
		complete: async (key, response) => {
			await repo.updateOne({ _id: key }, { $set: { response } });
		},
		/** @param {string} key */
		release: async (key) => {
			await repo.deleteOne({ _id: key });
		},
	});
/** @typedef {ReturnType<typeof createIdempotencyStore>} IdempotencyStore */

/**
 * Fixed-window rate-limit counters (`_id = key|windowStart`), expiring one minute after their window.
 * @param {MutableOps} repo
 */
export const createRateLimitStore = (repo) =>
	Object.freeze({
		/**
		 * @param {string} key
		 * @param {number} windowMs
		 * @param {number} t
		 * @returns {Promise<{ count: number, resetAt: number }>}
		 */
		hit: async (key, windowMs, t) => {
			const start = Math.floor(t / windowMs) * windowMs;
			const doc = await repo.findOneAndUpdate(
				{ _id: `${key}|${start}` },
				{ $inc: { count: 1 }, $setOnInsert: { expireAt: new Date(start + windowMs + 60_000) } },
				{ upsert: true, returnDocument: 'after' },
			);
			return { count: Number(doc?.count ?? 1), resetAt: start + windowMs };
		},
	});
/** @typedef {ReturnType<typeof createRateLimitStore>} RateLimitStore */
