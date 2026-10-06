/**
 * In-memory stores — development and tests only (serverless instances do not share memory, so replay protection,
 * idempotency and rate limits are per-instance here). Production uses `createMongoStores`.
 * @module
 */

/** @typedef {import('./types.js').Stores} Stores */
/** @typedef {import('./types.js').QueuedUsage} QueuedUsage */
/** @typedef {import('./types.js').StoredResponse} StoredResponse */

/**
 * @param {() => number} now
 * @returns {import('./types.js').ReplayStore}
 */
const memoryReplay = (now) => {
	/** @type {Map<string, number>} */
	const entries = new Map();
	return Object.freeze({
		seen: async (id, expiresAtMs) => {
			const existing = entries.get(id);
			if (existing !== undefined && existing > now()) return true;
			entries.set(id, expiresAtMs);
			return false;
		},
		forget: async (id) => {
			entries.delete(id);
		},
	});
};

/**
 * Create the full set of in-memory stores.
 * @param {{ now?: () => number }} [options]
 * @returns {Stores & { usageRecords: () => QueuedUsage[] }}
 */
export const createMemoryStores = ({ now = Date.now } = {}) => {
	/** @type {Map<string, Record<string, unknown>>} */
	const burned = new Map();
	/** @type {Map<string, import('./types.js').EntitlementCacheEntry>} */
	const entitlements = new Map();
	/** @type {Map<string, QueuedUsage & { nextAttemptAt: number, leaseUntil: number, leaseOwner: string | null, expireAt: number | null }>} */
	const usage = new Map();
	/** @type {Set<string>} */
	const revoked = new Set();
	/** @type {{ cursor: string | null, syncedAt: number | null }} */
	let revocationMeta = { cursor: null, syncedAt: null };
	/** @type {Map<string, { data: Record<string, unknown>, expiresAt: number }>} */
	const sessions = new Map();
	/** @type {Map<string, { fingerprint: string, expiresAt: number, response: StoredResponse | null }>} */
	const idempotency = new Map();
	/** @type {Map<string, { count: number, resetAt: number }>} */
	const windows = new Map();
	/** @type {{ jwks: unknown, fetchedAt: number } | null} */
	let portalKeys = null;
	/** @type {Map<string, { id: string, envelope: Record<string, unknown> | null, attempts: number, status: 'pending' | 'sent' | 'dead', lastError?: string, nextAttemptAt: number, leaseUntil: number, expireAt: number | null }>} */
	const outbox = new Map();

	/** @param {QueuedUsage & { expireAt: number | null }} record */
	const live = (record) => record.expireAt === null || record.expireAt > now();

	/** @param {QueuedUsage & Record<string, unknown>} record @returns {QueuedUsage} */
	const publicUsage = ({
		idempotencyKey,
		websiteId,
		subscriptionId,
		unit,
		quantity,
		occurredAt,
		attempts,
		status,
		lastError,
	}) => ({
		idempotencyKey,
		websiteId,
		subscriptionId,
		unit,
		quantity,
		occurredAt,
		attempts,
		status,
		...(lastError === undefined ? {} : { lastError }),
	});

	return {
		replay: memoryReplay(now),
		nonce: memoryReplay(now),
		burnedTokens: Object.freeze({
			burn: async (hash) => {
				if (burned.has(hash)) return false;
				burned.set(hash, { burnedAt: now() });
				return true;
			},
			isBurned: async (hash) => burned.has(hash),
			annotate: async (hash, data) => {
				burned.set(hash, { ...(burned.get(hash) ?? { burnedAt: now() }), ...data });
			},
			get: async (hash) => burned.get(hash) ?? null,
		}),
		entitlements: Object.freeze({
			get: async (websiteId) => entitlements.get(websiteId) ?? null,
			put: async (websiteId, entry) => {
				const existing = entitlements.get(websiteId);
				if (existing && existing.version > entry.version) return false;
				entitlements.set(websiteId, { ...entry });
				return true;
			},
			delete: async (websiteId) => {
				entitlements.delete(websiteId);
			},
		}),
		usageQueue: Object.freeze({
			enqueue: async (record) => {
				const existing = usage.get(record.idempotencyKey);
				if (existing && live(existing)) return { inserted: false };
				usage.set(record.idempotencyKey, {
					...record,
					attempts: 0,
					status: 'pending',
					nextAttemptAt: 0,
					leaseUntil: 0,
					leaseOwner: null,
					expireAt: null,
				});
				return { inserted: true };
			},
			lease: async ({ now: t, limit, leaseMs, owner }) => {
				/** @type {QueuedUsage[]} */
				const out = [];
				for (const record of usage.values()) {
					if (out.length >= limit) break;
					if (record.status !== 'pending' || record.nextAttemptAt > t || record.leaseUntil > t) continue;
					record.leaseUntil = t + leaseMs;
					record.leaseOwner = owner;
					out.push(publicUsage(record));
				}
				return out;
			},
			ack: async (keys, { now: t, retainMs }) => {
				for (const key of keys) {
					const record = usage.get(key);
					if (!record) continue;
					record.status = 'sent';
					record.leaseUntil = 0;
					record.expireAt = t + retainMs;
				}
			},
			retry: async (keys, { nextAttemptAt, error }) => {
				for (const key of keys) {
					const record = usage.get(key);
					if (!record || record.status !== 'pending') continue;
					record.attempts += 1;
					record.nextAttemptAt = nextAttemptAt;
					record.leaseUntil = 0;
					record.lastError = error;
				}
			},
			deadLetter: async (keys, { error }) => {
				for (const key of keys) {
					const record = usage.get(key);
					if (!record) continue;
					record.status = 'dead';
					record.leaseUntil = 0;
					record.lastError = error;
				}
			},
			stats: async () => {
				const out = { pending: 0, sent: 0, dead: 0 };
				for (const record of usage.values()) if (live(record)) out[record.status] += 1;
				return out;
			},
		}),
		eventOutbox: Object.freeze({
			enqueue: async ({ id, envelope }) => {
				const existing = outbox.get(id);
				if (existing && (existing.expireAt === null || existing.expireAt > now())) return { inserted: false };
				outbox.set(id, { id, envelope, attempts: 0, status: 'pending', nextAttemptAt: 0, leaseUntil: 0, expireAt: null });
				return { inserted: true };
			},
			lease: async ({ now: t, limit, leaseMs }) => {
				/** @type {import('./types.js').OutboxEvent[]} */
				const out = [];
				for (const record of outbox.values()) {
					if (out.length >= limit) break;
					if (record.status !== 'pending' || record.nextAttemptAt > t || record.leaseUntil > t || !record.envelope) continue;
					record.leaseUntil = t + leaseMs;
					out.push({
						id: record.id,
						envelope: record.envelope,
						attempts: record.attempts,
						status: record.status,
						...(record.lastError === undefined ? {} : { lastError: record.lastError }),
					});
				}
				return out;
			},
			ack: async (ids, { now: t, retainMs }) => {
				for (const id of ids) {
					const record = outbox.get(id);
					if (!record) continue;
					Object.assign(record, { status: 'sent', envelope: null, leaseUntil: 0, expireAt: t + retainMs });
				}
			},
			retry: async (ids, { nextAttemptAt, error }) => {
				for (const id of ids) {
					const record = outbox.get(id);
					if (!record || record.status !== 'pending') continue;
					Object.assign(record, { attempts: record.attempts + 1, nextAttemptAt, leaseUntil: 0, lastError: error });
				}
			},
			deadLetter: async (ids, { now: t, error, retainMs }) => {
				for (const id of ids) {
					const record = outbox.get(id);
					if (!record) continue;
					Object.assign(record, { status: 'dead', leaseUntil: 0, lastError: error, expireAt: t + retainMs });
				}
			},
			stats: async () => {
				const out = { pending: 0, sent: 0, dead: 0 };
				for (const record of outbox.values())
					if (record.expireAt === null || record.expireAt > now()) out[record.status] += 1;
				return out;
			},
		}),
		revocations: Object.freeze({
			get: async () => ({ keyIds: [...revoked], ...revocationMeta }),
			add: async (keyIds, meta = {}) => {
				for (const id of keyIds) revoked.add(id);
				revocationMeta = {
					cursor: meta.cursor === undefined ? revocationMeta.cursor : meta.cursor,
					syncedAt: meta.syncedAt === undefined ? revocationMeta.syncedAt : meta.syncedAt,
				};
			},
		}),
		sessions: Object.freeze({
			create: async (id, data, expiresAt) => {
				sessions.set(id, { data, expiresAt });
			},
			get: async (id) => {
				const entry = sessions.get(id);
				if (!entry) return null;
				if (entry.expiresAt <= now()) {
					sessions.delete(id);
					return null;
				}
				return entry.data;
			},
			delete: async (id) => {
				sessions.delete(id);
			},
		}),
		idempotency: Object.freeze({
			begin: async (key, fingerprint, expiresAt) => {
				const entry = idempotency.get(key);
				if (!entry || entry.expiresAt <= now()) {
					idempotency.set(key, { fingerprint, expiresAt, response: null });
					return { state: 'new' };
				}
				if (entry.fingerprint !== fingerprint) return { state: 'mismatch' };
				return entry.response ? { state: 'done', response: entry.response } : { state: 'pending' };
			},
			complete: async (key, response) => {
				const entry = idempotency.get(key);
				if (entry) entry.response = response;
			},
			release: async (key) => {
				idempotency.delete(key);
			},
		}),
		rateLimits: Object.freeze({
			hit: async (key, windowMs, t) => {
				const start = Math.floor(t / windowMs) * windowMs;
				const id = `${key}|${start}`;
				const entry = windows.get(id) ?? { count: 0, resetAt: start + windowMs };
				entry.count += 1;
				windows.set(id, entry);
				if (windows.size > 10_000) for (const [k, v] of windows) if (v.resetAt <= t) windows.delete(k);
				return { ...entry };
			},
		}),
		portalKeys: Object.freeze({
			get: async () => portalKeys,
			put: async (jwks, fetchedAt) => {
				portalKeys = { jwks, fetchedAt };
			},
		}),
		leases: (() => {
			const held = memoryReplay(now);
			return Object.freeze({
				acquire: async (/** @type {string} */ key, /** @type {number} */ ttlMs) => !(await held.seen(key, now() + ttlMs)),
			});
		})(),
		ping: async () => {},
		usageRecords: () => [...usage.values()].map((record) => publicUsage(record)),
	};
};
