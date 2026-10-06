/**
 * Production stores on the product's own control database (NOT a merchant database). Every collection has the
 * indexes it needs (unique `_id`, TTL on `expireAt`) created lazily and idempotently on first use. Documents hold
 * ids, hashes (HMACs), signed documents and counters — never merchant or customer payloads — with one bounded
 * exception: the event outbox holds an event envelope until it is delivered (the envelope is dropped on success;
 * dead-lettered events keep it for at most 7 days).
 * @module
 */

/** @typedef {import('mongodb').Db} Db */
/** @typedef {import('./types.js').Stores} Stores */
/** @typedef {import('./types.js').QueuedUsage} QueuedUsage */

/**
 * @param {unknown} error
 * @returns {boolean}
 */
const isDuplicateKey = (error) => typeof error === 'object' && error !== null && /** @type {any} */ (error).code === 11000;

/**
 * Create MongoDB-backed stores.
 * @param {{ db: Db, prefix?: string, now?: () => number }} options `prefix` namespaces the collections (default `ss_kit_`)
 * @returns {Stores & { ensureIndexes: () => Promise<void>, collections: Record<string, string> }}
 */
export const createMongoStores = ({ db, prefix = 'ss_kit_', now = Date.now }) => {
	if (!db || typeof db.collection !== 'function') throw new TypeError('createMongoStores needs a mongodb Db');
	const names = Object.freeze({
		replay: `${prefix}replay`,
		nonce: `${prefix}nonce`,
		entitlements: `${prefix}entitlements`,
		usageQueue: `${prefix}usage_queue`,
		eventOutbox: `${prefix}event_outbox`,
		revocations: `${prefix}revocations`,
		state: `${prefix}state`,
		sessions: `${prefix}sessions`,
		idempotency: `${prefix}idempotency`,
		rateLimits: `${prefix}rate_limits`,
	});
	/** @param {string} name */
	const col = (name) => db.collection(name);

	/** @type {Promise<void> | undefined} */
	let ready;
	let leaseSeq = 0;
	const ensureIndexes = () => {
		ready ??= (async () => {
			const ttl = { expireAfterSeconds: 0 };
			await Promise.all([
				col(names.replay).createIndex({ expireAt: 1 }, { ...ttl, name: 'ttl' }),
				col(names.nonce).createIndex({ expireAt: 1 }, { ...ttl, name: 'ttl' }),
				col(names.entitlements).createIndex({ expireAt: 1 }, { ...ttl, name: 'ttl' }),
				col(names.usageQueue).createIndex({ status: 1, nextAttemptAt: 1 }, { name: 'due' }),
				col(names.usageQueue).createIndex({ websiteId: 1, status: 1, nextAttemptAt: 1 }, { name: 'due_website' }),
				col(names.usageQueue).createIndex({ expireAt: 1 }, { ...ttl, name: 'ttl' }),
				col(names.usageQueue).createIndex({ leaseToken: 1 }, { name: 'lease', sparse: true }),
				col(names.eventOutbox).createIndex({ status: 1, nextAttemptAt: 1 }, { name: 'due' }),
				col(names.eventOutbox).createIndex({ websiteId: 1, status: 1, nextAttemptAt: 1 }, { name: 'due_website' }),
				col(names.eventOutbox).createIndex({ expireAt: 1 }, { ...ttl, name: 'ttl' }),
				col(names.eventOutbox).createIndex({ leaseToken: 1 }, { name: 'lease', sparse: true }),
				col(names.sessions).createIndex({ expireAt: 1 }, { ...ttl, name: 'ttl' }),
				col(names.idempotency).createIndex({ expireAt: 1 }, { ...ttl, name: 'ttl' }),
				col(names.rateLimits).createIndex({ expireAt: 1 }, { ...ttl, name: 'ttl' }),
			]);
		})().catch((error) => {
			ready = undefined;
			throw error;
		});
		return ready;
	};

	/**
	 * @param {string} name
	 * @returns {import('./types.js').ReplayStore}
	 */
	const replayStore = (name) =>
		Object.freeze({
			seen: async (id, expiresAtMs) => {
				await ensureIndexes();
				const c = col(name);
				try {
					await c.insertOne(/** @type {any} */ ({ _id: id, expireAt: new Date(expiresAtMs) }));
					return false;
				} catch (error) {
					if (!isDuplicateKey(error)) throw error;
				}
				// The TTL monitor runs about once a minute: an expired record may still exist. Take it over atomically.
				const taken = await c.updateOne(/** @type {any} */ ({ _id: id, expireAt: { $lte: new Date(now()) } }), {
					$set: { expireAt: new Date(expiresAtMs) },
				});
				return taken.modifiedCount === 0;
			},
			forget: async (id) => {
				await col(name).deleteOne(/** @type {any} */ ({ _id: id }));
			},
		});

	return {
		collections: names,
		ensureIndexes,
		ping: async () => {
			await db.command({ ping: 1 });
		},
		replay: replayStore(names.replay),
		nonce: replayStore(names.nonce),
		settings: Object.freeze({
			get: async (id) => {
				const doc = await col(names.state).findOne(/** @type {any} */ ({ _id: `setting:${id}` }));
				return doc ? /** @type {Record<string, any>} */ (doc.value) : null;
			},
			insert: async (id, value) => {
				try {
					await col(names.state).insertOne(/** @type {any} */ ({ _id: `setting:${id}`, value, at: new Date(now()) }));
					return true;
				} catch (error) {
					if (isDuplicateKey(error)) return false;
					throw error;
				}
			},
			put: async (id, value) => {
				await col(names.state).replaceOne(
					/** @type {any} */ ({ _id: `setting:${id}` }),
					/** @type {any} */ ({ value, at: new Date(now()) }),
					{ upsert: true },
				);
			},
			delete: async (id) => {
				await col(names.state).deleteOne(/** @type {any} */ ({ _id: `setting:${id}` }));
			},
		}),
		entitlements: Object.freeze({
			get: async (websiteId) => {
				const doc = await col(names.entitlements).findOne(/** @type {any} */ ({ _id: websiteId }));
				if (!doc) return null;
				return { token: String(doc.token), version: Number(doc.version), fetchedAt: Number(doc.fetchedAt) };
			},
			put: async (websiteId, entry) => {
				await ensureIndexes();
				try {
					const result = await col(names.entitlements).updateOne(
						/** @type {any} */ ({ _id: websiteId, version: { $lte: entry.version } }),
						{
							$set: {
								token: entry.token,
								version: entry.version,
								fetchedAt: entry.fetchedAt,
								// kept a little past the offline grace; documents past it can never be served
								expireAt: new Date(now() + 8 * 24 * 60 * 60_000),
							},
						},
						{ upsert: true },
					);
					return result.matchedCount + result.upsertedCount > 0;
				} catch (error) {
					if (isDuplicateKey(error)) return false; // a newer version exists
					throw error;
				}
			},
			delete: async (websiteId) => {
				await col(names.entitlements).deleteOne(/** @type {any} */ ({ _id: websiteId }));
			},
		}),
		usageQueue: Object.freeze({
			enqueue: async (record) => {
				await ensureIndexes();
				try {
					await col(names.usageQueue).insertOne(
						/** @type {any} */ ({
							_id: record.idempotencyKey,
							...record,
							status: 'pending',
							attempts: 0,
							nextAttemptAt: new Date(0),
							leaseUntil: new Date(0),
							createdAt: new Date(now()),
						}),
					);
					return { inserted: true };
				} catch (error) {
					if (isDuplicateKey(error)) return { inserted: false };
					throw error;
				}
			},
			lease: async ({ now: t, limit, leaseMs, owner, websiteId }) => {
				await ensureIndexes();
				const c = col(names.usageQueue);
				const at = new Date(t);
				const due = {
					...(websiteId ? { websiteId } : {}),
					status: 'pending',
					nextAttemptAt: { $lte: at },
					leaseUntil: { $lte: at },
				};
				const candidates = await c
					.find(/** @type {any} */ (due), { projection: { _id: 1 } })
					.sort({ nextAttemptAt: 1 })
					.limit(limit)
					.toArray();
				if (candidates.length === 0) return [];
				leaseSeq += 1;
				const leaseToken = `${owner}:${t}:${leaseSeq}`;
				await c.updateMany(/** @type {any} */ ({ ...due, _id: { $in: candidates.map((doc) => doc._id) } }), {
					$set: { leaseUntil: new Date(t + leaseMs), leaseToken },
				});
				const leased = await c.find(/** @type {any} */ ({ leaseToken })).toArray();
				return leased.map((doc) => ({
					idempotencyKey: String(doc._id),
					websiteId: doc.websiteId,
					subscriptionId: doc.subscriptionId,
					unit: doc.unit,
					quantity: doc.quantity,
					occurredAt: doc.occurredAt,
					attempts: doc.attempts,
					status: doc.status,
					...(doc.lastError === undefined ? {} : { lastError: doc.lastError }),
				}));
			},
			ack: async (keys, { now: t, retainMs }) => {
				if (keys.length === 0) return;
				await col(names.usageQueue).updateMany(/** @type {any} */ ({ _id: { $in: keys } }), {
					$set: { status: 'sent', sentAt: new Date(t), expireAt: new Date(t + retainMs), leaseUntil: new Date(0) },
					$unset: { leaseToken: '' },
				});
			},
			retry: async (keys, { nextAttemptAt, error }) => {
				if (keys.length === 0) return;
				await col(names.usageQueue).updateMany(/** @type {any} */ ({ _id: { $in: keys }, status: 'pending' }), {
					$set: { nextAttemptAt: new Date(nextAttemptAt), leaseUntil: new Date(0), lastError: error },
					$inc: { attempts: 1 },
					$unset: { leaseToken: '' },
				});
			},
			deadLetter: async (keys, { now: t, error }) => {
				if (keys.length === 0) return;
				await col(names.usageQueue).updateMany(/** @type {any} */ ({ _id: { $in: keys } }), {
					$set: { status: 'dead', deadAt: new Date(t), lastError: error, leaseUntil: new Date(0) },
					$unset: { leaseToken: '' },
				});
			},
			stats: async () => {
				const rows = await col(names.usageQueue)
					.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }])
					.toArray();
				const out = { pending: 0, sent: 0, dead: 0 };
				for (const row of rows) if (row._id in out) out[/** @type {'pending'} */ (row._id)] = row.n;
				return out;
			},
		}),
		eventOutbox: Object.freeze({
			enqueue: async ({ id, envelope }) => {
				await ensureIndexes();
				try {
					await col(names.eventOutbox).insertOne(
						/** @type {any} */ ({
							_id: id,
							...(typeof envelope.websiteId === 'string' ? { websiteId: envelope.websiteId } : {}),
							envelope,
							status: 'pending',
							attempts: 0,
							nextAttemptAt: new Date(0),
							leaseUntil: new Date(0),
							createdAt: new Date(now()),
						}),
					);
					return { inserted: true };
				} catch (error) {
					if (isDuplicateKey(error)) return { inserted: false };
					throw error;
				}
			},
			lease: async ({ now: t, limit, leaseMs, owner, websiteId }) => {
				await ensureIndexes();
				const c = col(names.eventOutbox);
				const at = new Date(t);
				const due = {
					...(websiteId ? { websiteId } : {}),
					status: 'pending',
					nextAttemptAt: { $lte: at },
					leaseUntil: { $lte: at },
				};
				const candidates = await c
					.find(/** @type {any} */ (due), { projection: { _id: 1 } })
					.sort({ nextAttemptAt: 1 })
					.limit(limit)
					.toArray();
				if (candidates.length === 0) return [];
				leaseSeq += 1;
				const leaseToken = `${owner}:${t}:${leaseSeq}`;
				await c.updateMany(/** @type {any} */ ({ ...due, _id: { $in: candidates.map((doc) => doc._id) } }), {
					$set: { leaseUntil: new Date(t + leaseMs), leaseToken },
				});
				const leased = await c.find(/** @type {any} */ ({ leaseToken })).toArray();
				return leased.map((doc) => ({
					id: String(doc._id),
					envelope: doc.envelope,
					attempts: doc.attempts,
					status: doc.status,
					...(doc.lastError === undefined ? {} : { lastError: doc.lastError }),
				}));
			},
			ack: async (ids, { now: t, retainMs }) => {
				if (ids.length === 0) return;
				await col(names.eventOutbox).updateMany(/** @type {any} */ ({ _id: { $in: ids } }), {
					$set: { status: 'sent', sentAt: new Date(t), expireAt: new Date(t + retainMs), leaseUntil: new Date(0) },
					$unset: { leaseToken: '', envelope: '' },
				});
			},
			retry: async (ids, { nextAttemptAt, error }) => {
				if (ids.length === 0) return;
				await col(names.eventOutbox).updateMany(/** @type {any} */ ({ _id: { $in: ids }, status: 'pending' }), {
					$set: { nextAttemptAt: new Date(nextAttemptAt), leaseUntil: new Date(0), lastError: error },
					$inc: { attempts: 1 },
					$unset: { leaseToken: '' },
				});
			},
			deadLetter: async (ids, { now: t, error, retainMs }) => {
				if (ids.length === 0) return;
				await col(names.eventOutbox).updateMany(/** @type {any} */ ({ _id: { $in: ids } }), {
					$set: {
						status: 'dead',
						deadAt: new Date(t),
						lastError: error,
						leaseUntil: new Date(0),
						expireAt: new Date(t + retainMs),
					},
					$unset: { leaseToken: '' },
				});
			},
			stats: async () => {
				const rows = await col(names.eventOutbox)
					.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }])
					.toArray();
				const out = { pending: 0, sent: 0, dead: 0 };
				for (const row of rows) if (row._id in out) out[/** @type {'pending'} */ (row._id)] = row.n;
				return out;
			},
		}),
		revocations: Object.freeze({
			get: async () => {
				const [ids, meta] = await Promise.all([
					col(names.revocations)
						.find({}, { projection: { _id: 1 } })
						.toArray(),
					col(names.state).findOne(/** @type {any} */ ({ _id: 'revocations' })),
				]);
				return {
					keyIds: ids.map((doc) => String(doc._id)),
					cursor: meta?.cursor ?? null,
					syncedAt: typeof meta?.syncedAt === 'number' ? meta.syncedAt : null,
				};
			},
			add: async (keyIds, meta = {}) => {
				if (keyIds.length > 0) {
					await col(names.revocations).bulkWrite(
						keyIds.map((id) => ({
							updateOne: {
								filter: /** @type {any} */ ({ _id: id }),
								update: { $setOnInsert: { revokedAt: new Date(now()) } },
								upsert: true,
							},
						})),
						{ ordered: false },
					);
				}
				/** @type {Record<string, unknown>} */
				const set = {};
				if (meta.cursor !== undefined) set.cursor = meta.cursor;
				if (meta.syncedAt !== undefined) set.syncedAt = meta.syncedAt;
				if (Object.keys(set).length > 0) {
					await col(names.state).updateOne(/** @type {any} */ ({ _id: 'revocations' }), { $set: set }, { upsert: true });
				}
			},
		}),
		sessions: Object.freeze({
			create: async (id, data, expiresAtMs) => {
				await ensureIndexes();
				await col(names.sessions).insertOne(/** @type {any} */ ({ _id: id, data, expireAt: new Date(expiresAtMs) }));
			},
			get: async (id) => {
				const doc = await col(names.sessions).findOne(/** @type {any} */ ({ _id: id, expireAt: { $gt: new Date(now()) } }));
				return doc ? /** @type {Record<string, unknown>} */ (doc.data) : null;
			},
			delete: async (id) => {
				await col(names.sessions).deleteOne(/** @type {any} */ ({ _id: id }));
			},
		}),
		idempotency: Object.freeze({
			begin: async (key, fingerprint, expiresAtMs) => {
				await ensureIndexes();
				const c = col(names.idempotency);
				const fresh = { _id: key, fingerprint, response: null, expireAt: new Date(expiresAtMs) };
				try {
					await c.insertOne(/** @type {any} */ (fresh));
					return { state: 'new' };
				} catch (error) {
					if (!isDuplicateKey(error)) throw error;
				}
				const taken = await c.replaceOne(/** @type {any} */ ({ _id: key, expireAt: { $lte: new Date(now()) } }), fresh);
				if (taken.modifiedCount === 1) return { state: 'new' };
				const doc = await c.findOne(/** @type {any} */ ({ _id: key }));
				if (!doc) return { state: 'pending' };
				if (doc.fingerprint !== fingerprint) return { state: 'mismatch' };
				return doc.response ? { state: 'done', response: doc.response } : { state: 'pending' };
			},
			complete: async (key, response) => {
				await col(names.idempotency).updateOne(/** @type {any} */ ({ _id: key }), { $set: { response } });
			},
			release: async (key) => {
				await col(names.idempotency).deleteOne(/** @type {any} */ ({ _id: key }));
			},
		}),
		portalKeys: Object.freeze({
			get: async () => {
				const doc = await col(names.state).findOne(/** @type {any} */ ({ _id: 'portal_jwks' }));
				return doc ? { jwks: doc.jwks, fetchedAt: Number(doc.fetchedAt) } : null;
			},
			put: async (jwks, fetchedAt) => {
				await col(names.state).updateOne(
					/** @type {any} */ ({ _id: 'portal_jwks' }),
					{ $set: { jwks, fetchedAt } },
					{ upsert: true },
				);
			},
		}),
		rateLimits: Object.freeze({
			hit: async (key, windowMs, t) => {
				await ensureIndexes();
				const start = Math.floor(t / windowMs) * windowMs;
				const doc = await col(names.rateLimits).findOneAndUpdate(
					/** @type {any} */ ({ _id: `${key}|${start}` }),
					{ $inc: { count: 1 }, $setOnInsert: { expireAt: new Date(start + windowMs + 60_000) } },
					{ upsert: true, returnDocument: 'after' },
				);
				return { count: Number(doc?.count ?? 1), resetAt: start + windowMs };
			},
		}),
	};
};
