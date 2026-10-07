/**
 * Repositories over the merchant's own database (Part E §7), reached through app-kit `data.forWebsite(websiteId)`:
 * collections are prefixed `ss_signups_`, every query pins `websiteId` (app-kit's tenant guard rejects any that does
 * not) and inserts are stamped with `websiteId`, `merchantId`, `env`, `createdAt`, `updatedAt` and `schemaVersion`.
 *
 * - `keys`: the website's sealed HMAC pepper and issuer signing keys (one document per generation).
 * - `challenges`: pending one-time codes and magic links (hashes only; TTL-purged a day after expiry).
 * - `counters` / `cooldowns`: fixed-window send and velocity counters, resend cooldowns (keys are HMACs; TTL-purged).
 * - `customers`: one document per customer (unique e-mail / phone / external id per website).
 * - `sessions`: signed-in devices with the current refresh-token hash and previous hashes (reuse detection).
 * - `consents`: append-only acceptance records; `data_requests`: export / deletion requests;
 *   `orders`: order summaries for the account pages; `risk_events`: blocked attempts and new-device sign-ins.
 * - `issuer_requests`: one document per website — the last request to become its identity issuer sent to the Portal
 *   (issuer, JWKS URL, audience, Portal status, time); no customer data.
 * @module
 */

export const COLLECTIONS = Object.freeze({
	keys: 'keys',
	challenges: 'challenges',
	counters: 'counters',
	cooldowns: 'cooldowns',
	customers: 'customers',
	sessions: 'sessions',
	consents: 'consents',
	dataRequests: 'data_requests',
	orders: 'orders',
	riskEvents: 'risk_events',
	issuerRequests: 'issuer_requests',
});

/**
 * Index definitions (websiteId first everywhere except single-field TTL indexes), created idempotently by app-kit.
 * @type {Array<{ collection: string, keys: Record<string, 1 | -1>, name: string, unique?: boolean,
 *   partialFilterExpression?: Record<string, unknown>, expireAfterSeconds?: number }>}
 */
export const INDEXES = /** @type {any} */ ([
	{ collection: 'keys', keys: { websiteId: 1, kind: 1, generation: 1 }, name: 'website_kind_generation', unique: true },
	{ collection: 'challenges', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{ collection: 'challenges', keys: { purgeAt: 1 }, name: 'purge', expireAfterSeconds: 0 },
	{ collection: 'counters', keys: { websiteId: 1, key: 1, windowStart: 1 }, name: 'website_key_window', unique: true },
	{ collection: 'counters', keys: { purgeAt: 1 }, name: 'purge', expireAfterSeconds: 0 },
	{ collection: 'cooldowns', keys: { websiteId: 1, key: 1 }, name: 'website_key', unique: true },
	{ collection: 'cooldowns', keys: { purgeAt: 1 }, name: 'purge', expireAfterSeconds: 0 },
	{ collection: 'customers', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{
		collection: 'customers',
		keys: { websiteId: 1, email: 1 },
		name: 'website_email',
		unique: true,
		partialFilterExpression: { email: { $type: 'string' } },
	},
	{
		collection: 'customers',
		keys: { websiteId: 1, phone: 1 },
		name: 'website_phone',
		unique: true,
		partialFilterExpression: { phone: { $type: 'string' } },
	},
	{
		collection: 'customers',
		keys: { websiteId: 1, externalId: 1 },
		name: 'website_external_id',
		unique: true,
		partialFilterExpression: { externalId: { $type: 'string' } },
	},
	{ collection: 'customers', keys: { websiteId: 1, createdAt: -1 }, name: 'website_created' },
	{ collection: 'sessions', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{ collection: 'sessions', keys: { websiteId: 1, customerId: 1, revokedAt: 1 }, name: 'website_customer' },
	{ collection: 'sessions', keys: { purgeAt: 1 }, name: 'purge', expireAfterSeconds: 0 },
	{ collection: 'consents', keys: { websiteId: 1, customerId: 1, acceptedAt: -1 }, name: 'website_customer_time' },
	{ collection: 'data_requests', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{ collection: 'data_requests', keys: { websiteId: 1, customerId: 1, createdAt: -1 }, name: 'website_customer' },
	{ collection: 'data_requests', keys: { websiteId: 1, status: 1, effectiveAt: 1 }, name: 'website_due' },
	{ collection: 'orders', keys: { websiteId: 1, orderId: 1 }, name: 'website_order', unique: true },
	{ collection: 'orders', keys: { websiteId: 1, customerId: 1, updatedAt: -1 }, name: 'website_customer' },
	{ collection: 'risk_events', keys: { websiteId: 1, occurredAt: -1, id: -1 }, name: 'website_time' },
	{ collection: 'risk_events', keys: { purgeAt: 1 }, name: 'purge', expireAfterSeconds: 0 },
	{ collection: 'issuer_requests', keys: { websiteId: 1 }, name: 'website', unique: true },
]);

/**
 * Lazy, versioned migrations (app-kit runs them once per website under a lock).
 * @type {Array<{ version: number, name: string, up: (scope: any) => Promise<void> }>}
 */
export const MIGRATIONS = [
	{
		version: 1,
		name: 'customer_defaults',
		up: async (scope) => {
			await scope
				.collection(COLLECTIONS.customers)
				.updateMany(
					{ websiteId: scope.websiteId, sessionVersion: { $exists: false } },
					{ $set: { sessionVersion: 0, knownDevices: [], consents: {}, signInCount: 0 } },
				);
		},
	},
];

/** Fields the repositories never return. */
const INTERNAL = new Set(['_id', 'websiteId', 'merchantId', 'env', 'schemaVersion', 'purgeAt']);

/**
 * @param {Record<string, any> | null} doc
 * @returns {any} the document without internal fields, or null
 */
export const strip = (doc) => (doc ? Object.fromEntries(Object.entries(doc).filter(([key]) => !INTERNAL.has(key))) : null);

/** @param {unknown} error */
export const isDuplicateKey = (error) => /** @type {{ code?: number }} */ (error)?.code === 11000;

/**
 * @typedef {object} Scope app-kit website data scope (guarded collections)
 * @property {string} websiteId
 * @property {(name: string) => any} collection
 */

/**
 * Repositories of one website.
 * @param {Scope} scope
 * @param {{ now?: () => number, stamp?: { merchantId?: string, env?: string } }} [options] `stamp` is added to upserted
 *   documents (app-kit stamps plain inserts itself)
 */
export const createRepositories = (scope, { now = Date.now, stamp = {} } = {}) => {
	const { websiteId } = scope;
	if (typeof websiteId !== 'string' || websiteId.length === 0) throw new TypeError('websiteId is required');
	const c = Object.fromEntries(Object.entries(COLLECTIONS).map(([key, name]) => [key, scope.collection(name)]));
	const keys = c.keys;
	const challenges = c.challenges;
	const counters = c.counters;
	const cooldowns = c.cooldowns;
	const customers = c.customers;
	const sessions = c.sessions;
	const consents = c.consents;
	const dataRequests = c.dataRequests;
	const orders = c.orders;
	const riskEvents = c.riskEvents;
	const issuerRequests = c.issuerRequests;
	/** Fields of a document created by an upsert. */
	const onInsert = () => ({ ...stamp, createdAt: new Date(now()), schemaVersion: 1 });
	const w = { websiteId };

	return Object.freeze({
		websiteId,
		keys: Object.freeze({
			/** @param {'pepper' | 'signing'} kind */
			list: async (kind) => (await keys.find({ ...w, kind }, { sort: { generation: 1 } }).toArray()).map(strip),
			/**
			 * Insert a key generation (false when another instance created it first).
			 * @param {Record<string, unknown>} doc
			 */
			insert: async (doc) => {
				try {
					await keys.insertOne(doc);
					return true;
				} catch (error) {
					if (isDuplicateKey(error)) return false;
					throw error;
				}
			},
			/** @param {'pepper' | 'signing'} kind @param {number} generation @param {Record<string, unknown>} sealed */
			reseal: async (kind, generation, sealed) => {
				await keys.updateOne({ ...w, kind, generation }, { $set: { sealed } });
			},
			/** @param {'pepper' | 'signing'} kind @param {number[]} generations */
			remove: async (kind, generations) =>
				generations.length === 0 ? 0 : (await keys.deleteMany({ ...w, kind, generation: { $in: generations } })).deletedCount,
		}),

		challenges: Object.freeze({
			/** @param {Record<string, unknown>} doc */
			insert: async (doc) => {
				await challenges.insertOne(doc);
			},
			/** @param {string} id */
			get: async (id) => strip(await challenges.findOne({ ...w, id })),
			/**
			 * Reserve one attempt atomically before comparing (parallel guesses can never exceed the budget).
			 * @param {string} id
			 * @param {Date} at
			 */
			reserveAttempt: async (id, at) =>
				strip(
					await challenges.findOneAndUpdate(
						{ ...w, id, consumedAt: null, expiresAt: { $gt: at }, $expr: { $lt: ['$attempts', '$maxAttempts'] } },
						{ $inc: { attempts: 1 } },
						{ returnDocument: 'after' },
					),
				),
			/**
			 * Consume once: only one of several parallel correct submissions wins.
			 * @param {string} id
			 * @param {Date} at
			 * @param {string} reason
			 */
			consume: async (id, at, reason = 'used') =>
				(await challenges.updateOne({ ...w, id, consumedAt: null }, { $set: { consumedAt: at, consumedReason: reason } }))
					.modifiedCount === 1,
			/** @param {string} id */
			remove: async (id) => {
				await challenges.deleteOne({ ...w, id });
			},
			/** Pending challenges of identity hashes (deletion clean-up). @param {string[]} identityKeys */
			removeForIdentities: async (identityKeys) =>
				identityKeys.length === 0
					? 0
					: (await challenges.deleteMany({ ...w, identityKey: { $in: identityKeys } })).deletedCount,
			/** Sends in a time range (dashboard KPIs). @param {Date} since */
			countSince: (since) => challenges.countDocuments({ ...w, createdAt: { $gte: since }, decoy: false }),
		}),

		counters: Object.freeze({
			/**
			 * Increment a fixed-window counter atomically and return the new count.
			 * @param {string} key
			 * @param {number} windowStart epoch ms
			 * @param {number} windowMs
			 */
			hit: async (key, windowStart, windowMs) => {
				const filter = { ...w, key, windowStart: new Date(windowStart) };
				const update = {
					$inc: { count: 1 },
					$setOnInsert: { ...onInsert(), purgeAt: new Date(windowStart + 2 * windowMs) },
				};
				for (let attempt = 0; ; attempt += 1) {
					try {
						const doc = await counters.findOneAndUpdate(filter, update, { upsert: true, returnDocument: 'after' });
						return /** @type {number} */ (doc?.count ?? 1);
					} catch (error) {
						if (!isDuplicateKey(error) || attempt > 0) throw error; // concurrent upsert: the retry updates
					}
				}
			},
			/**
			 * Current value of a counter (0 when absent).
			 * @param {string} key
			 * @param {number} windowStart
			 */
			peek: async (key, windowStart) =>
				/** @type {number} */ ((await counters.findOne({ ...w, key, windowStart: new Date(windowStart) }))?.count ?? 0),
			/**
			 * Add a member to a bounded distinct set; returns whether the member is in the set (false = the set is full).
			 * @param {string} key
			 * @param {string} member
			 * @param {number} windowStart
			 * @param {number} windowMs
			 * @param {number} max
			 */
			addDistinct: async (key, member, windowStart, windowMs, max) => {
				const filter = { ...w, key, windowStart: new Date(windowStart) };
				try {
					await counters.updateOne(
						{ ...filter, [`members.${max - 1}`]: { $exists: false } },
						{
							$addToSet: { members: member },
							$setOnInsert: { ...onInsert(), purgeAt: new Date(windowStart + 2 * windowMs) },
						},
						{ upsert: true },
					);
				} catch (error) {
					if (!isDuplicateKey(error)) throw error; // the set exists and is full
				}
				const doc = await counters.findOne(filter);
				return Array.isArray(doc?.members) && doc.members.includes(member);
			},
		}),

		cooldowns: Object.freeze({
			/**
			 * Start a cooldown unless one is running. Returns null when started, else the running cooldown's end.
			 * @param {string} key
			 * @param {number} untilMs
			 */
			start: async (key, untilMs) => {
				const at = new Date(now());
				try {
					const result = await cooldowns.updateOne(
						{ ...w, key, until: { $lte: at } },
						{ $set: { until: new Date(untilMs), purgeAt: new Date(untilMs + 60_000) }, $setOnInsert: onInsert() },
						{ upsert: true },
					);
					if (result.matchedCount === 1 || result.upsertedCount === 1) return null;
				} catch (error) {
					if (!isDuplicateKey(error)) throw error;
				}
				const doc = await cooldowns.findOne({ ...w, key });
				return doc?.until instanceof Date ? doc.until.getTime() : untilMs;
			},
			/** @param {string} key */
			release: async (key) => {
				await cooldowns.deleteOne({ ...w, key });
			},
		}),

		customers: Object.freeze({
			/** @param {string} id */
			get: async (id) => strip(await customers.findOne({ ...w, id })),
			/** @param {'email' | 'phone' | 'externalId'} field @param {string} value */
			findBy: async (field, value) => strip(await customers.findOne({ ...w, [field]: value })),
			/**
			 * Insert; null when an identifier is taken (unique index).
			 * @param {Record<string, unknown>} doc
			 */
			insert: async (doc) => {
				try {
					await customers.insertOne(doc);
					return strip(await customers.findOne({ ...w, id: doc.id }));
				} catch (error) {
					if (isDuplicateKey(error)) return null;
					throw error;
				}
			},
			/**
			 * `$set` fields; returns the updated customer, `null` when it does not exist, `'conflict'` on a unique clash.
			 * @param {string} id
			 * @param {Record<string, unknown>} set
			 * @param {Record<string, unknown>} [extra] other update operators (`$inc`, …)
			 */
			update: async (id, set, extra = {}) => {
				try {
					return strip(
						await customers.findOneAndUpdate(
							{ ...w, id },
							{ ...(Object.keys(set).length > 0 ? { $set: set } : {}), ...extra },
							{ returnDocument: 'after' },
						),
					);
				} catch (error) {
					if (isDuplicateKey(error)) return 'conflict';
					throw error;
				}
			},
			/**
			 * Newest first; `after` = last id of the previous page.
			 * @param {{ after?: string | null, fetchLimit: number, email?: string, phone?: string }} query
			 */
			list: async ({ after = null, fetchLimit, email, phone }) =>
				(
					await customers
						.find(
							{
								...w,
								...(after ? { id: { $lt: after } } : {}),
								...(email ? { email } : {}),
								...(phone ? { phone } : {}),
								status: { $ne: 'deleted' },
							},
							{ sort: { id: -1 }, limit: fetchLimit },
						)
						.toArray()
				).map(strip),
			/** @param {Record<string, unknown>} [filter] */
			count: (filter = {}) => customers.countDocuments({ ...w, ...filter }),
		}),

		sessions: Object.freeze({
			/** @param {Record<string, unknown>} doc */
			insert: async (doc) => {
				await sessions.insertOne(doc);
			},
			/** @param {string} id */
			get: async (id) => strip(await sessions.findOne({ ...w, id })),
			/**
			 * Rotate the refresh token: compare-and-set on the current hash.
			 * @param {string} id
			 * @param {string} currentHash
			 * @param {Record<string, unknown>} set new hash, timestamps, windows
			 * @param {number} keep previous hashes kept
			 */
			rotate: async (id, currentHash, set, keep) =>
				strip(
					await sessions.findOneAndUpdate(
						{ ...w, id, refreshHash: currentHash, revokedAt: null },
						{ $set: set, $push: { previousHashes: { $each: [currentHash], $slice: -keep } } },
						{ returnDocument: 'after' },
					),
				),
			/** Active (not revoked) sessions of a customer. @param {string} customerId */
			active: async (customerId) =>
				(await sessions.find({ ...w, customerId, revokedAt: null }, { sort: { lastUsedAt: -1 } }).toArray()).map(strip),
			/** @param {string} customerId @param {number} limit */
			recent: async (customerId, limit) =>
				(await sessions.find({ ...w, customerId }, { sort: { lastUsedAt: -1 }, limit }).toArray()).map(strip),
			/**
			 * @param {Record<string, unknown>} filter extra filter (`id`, `customerId`, …)
			 * @param {string} at
			 * @param {string} reason
			 */
			revoke: async (filter, at, reason) =>
				(await sessions.updateMany({ ...w, ...filter, revokedAt: null }, { $set: { revokedAt: at, revokeReason: reason } }))
					.modifiedCount,
			/** @param {string} since ISO */
			countActive: (since) => sessions.countDocuments({ ...w, revokedAt: null, expiresAt: { $gt: since } }),
		}),

		consents: Object.freeze({
			/** @param {Array<Record<string, unknown>>} docs */
			append: async (docs) => {
				if (docs.length > 0) await consents.insertMany(docs);
			},
			/** @param {string} customerId @param {number} limit */
			list: async (customerId, limit) =>
				(await consents.find({ ...w, customerId }, { sort: { acceptedAt: -1 }, limit }).toArray()).map(strip),
			/** @param {string} customerId */
			removeFor: async (customerId) => (await consents.deleteMany({ ...w, customerId })).deletedCount,
		}),

		dataRequests: Object.freeze({
			/** @param {Record<string, unknown>} doc */
			insert: async (doc) => {
				await dataRequests.insertOne(doc);
			},
			/** @param {string} id */
			get: async (id) => strip(await dataRequests.findOne({ ...w, id })),
			/** @param {string} customerId @param {number} limit */
			list: async (customerId, limit) =>
				(await dataRequests.find({ ...w, customerId }, { sort: { createdAt: -1 }, limit }).toArray()).map(strip),
			/** @param {string} customerId */
			pendingDeletion: async (customerId) =>
				strip(await dataRequests.findOne({ ...w, customerId, type: 'delete', status: 'pending' })),
			/**
			 * Compare-and-set the status of a pending request.
			 * @param {string} id
			 * @param {Record<string, unknown>} set
			 */
			close: async (id, set) =>
				(await dataRequests.updateOne({ ...w, id, status: 'pending' }, { $set: set })).modifiedCount === 1,
			/**
			 * Deletions due at `at` (ISO), optionally only of some customers.
			 * @param {string} at
			 * @param {number} limit
			 * @param {string[]} [customerIds]
			 */
			due: async (at, limit, customerIds) =>
				(
					await dataRequests
						.find(
							{
								...w,
								type: 'delete',
								status: 'pending',
								effectiveAt: { $lte: at },
								...(customerIds ? { customerId: { $in: customerIds } } : {}),
							},
							{ limit },
						)
						.toArray()
				).map(strip),
			/** @param {Record<string, unknown>} [filter] */
			count: (filter = {}) => dataRequests.countDocuments({ ...w, ...filter }),
		}),

		orders: Object.freeze({
			/**
			 * Merge an order event into its summary (idempotent: the same event sets the same fields).
			 * @param {string} orderId
			 * @param {Record<string, unknown>} set
			 */
			upsert: async (orderId, set) => {
				const run = () => orders.updateOne({ ...w, orderId }, { $set: set, $setOnInsert: onInsert() }, { upsert: true });
				try {
					await run();
				} catch (error) {
					if (!isDuplicateKey(error)) throw error;
					await run(); // concurrent first event of the same order
				}
			},
			/** @param {string} customerId @param {number} limit */
			forCustomer: async (customerId, limit) =>
				(await orders.find({ ...w, customerId }, { sort: { updatedAt: -1 }, limit }).toArray()).map(strip),
			/** @param {string} customerId */
			removeFor: async (customerId) => (await orders.deleteMany({ ...w, customerId })).deletedCount,
		}),

		riskEvents: Object.freeze({
			/** @param {Record<string, unknown>} doc */
			insert: async (doc) => {
				await riskEvents.insertOne(doc);
			},
			/** Newest first; `after` = `<occurredAt>|<id>` of the previous page. @param {{ after?: string | null, fetchLimit: number }} page */
			list: async ({ after = null, fetchLimit }) => {
				const [at, id] = typeof after === 'string' ? after.split('|') : [];
				const filter =
					at && id ? { ...w, $or: [{ occurredAt: { $lt: at } }, { occurredAt: at, id: { $lt: id } }] } : { ...w };
				return (await riskEvents.find(filter, { sort: { occurredAt: -1, id: -1 }, limit: fetchLimit }).toArray()).map(strip);
			},
		}),

		issuerRequest: Object.freeze({
			/** The last identity-issuer request sent to the Portal, or null. */
			get: async () => strip(await issuerRequests.findOne({ ...w })),
			/**
			 * Record the outcome of a request (one document per website).
			 * @param {{ issuer: string, jwksUrl: string, audience: string, status: string, requestedAt: string }} set
			 */
			save: async (set) => {
				const run = () => issuerRequests.updateOne({ ...w }, { $set: set, $setOnInsert: onInsert() }, { upsert: true });
				try {
					await run();
				} catch (error) {
					if (!isDuplicateKey(error)) throw error;
					await run(); // concurrent first request of the same website
				}
			},
		}),
	});
};

/** @typedef {ReturnType<typeof createRepositories>} Repositories */

/**
 * Repositories for a website through app-kit (indexes and migrations are applied by app-kit on first use).
 * @param {{ data: { forWebsite: (websiteId: string, stamp?: { merchantId?: string, env?: string }) => Promise<Scope> } }} product
 * @param {{ now?: () => number }} [options]
 * @returns {(websiteId: string, stamp?: { merchantId?: string, env?: string }) => Promise<Repositories>}
 */
export const repositoriesFor =
	(product, options = {}) =>
	async (websiteId, stamp = {}) =>
		createRepositories(await product.data.forWebsite(websiteId, stamp), { ...options, stamp });
