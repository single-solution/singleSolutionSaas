/**
 * Store interfaces. Every store is async-capable; the in-memory implementations are for development and tests, the
 * MongoDB implementations (`createMongoStores`) live in the product's own small control database — never in a
 * merchant database — and hold ids, hashes and short-lived state only.
 * @module
 */

/**
 * Replay/nonce store (shape of `@ss/protocol` `ReplayStore`, plus `forget`).
 * @typedef {object} ReplayStore
 * @property {(id: string, expiresAtMs: number) => Promise<boolean>} seen true when already recorded (a replay)
 * @property {(id: string) => Promise<void>} forget remove an id (used when processing failed and must be retried)
 */

/**
 * One-time registration token burns.
 * @typedef {object} BurnedTokenStore
 * @property {(tokenHash: string) => Promise<boolean>} burn atomically burn; false when already burned
 * @property {(tokenHash: string) => Promise<boolean>} isBurned
 * @property {(tokenHash: string, data: Record<string, unknown>) => Promise<void>} annotate attach registration details
 * @property {(tokenHash: string) => Promise<Record<string, unknown> | null>} get
 */

/**
 * @typedef {object} EntitlementCacheEntry
 * @property {string} token signed entitlement document (compact JWS)
 * @property {number} version document version (monotonic)
 * @property {number} fetchedAt epoch ms of the successful Portal fetch
 */

/**
 * Signed entitlement documents per website (re-verified whenever read back).
 * @typedef {object} EntitlementStore
 * @property {(websiteId: string) => Promise<EntitlementCacheEntry | null>} get
 * @property {(websiteId: string, entry: EntitlementCacheEntry) => Promise<boolean>} put keeps the newest version; false when older
 * @property {(websiteId: string) => Promise<void>} delete
 */

/**
 * @typedef {object} UsageRecord
 * @property {string} idempotencyKey
 * @property {string} websiteId
 * @property {string} subscriptionId
 * @property {string} unit
 * @property {number} quantity
 * @property {string} occurredAt ISO-8601
 */

/**
 * @typedef {UsageRecord & { attempts: number, status: 'pending' | 'sent' | 'dead', lastError?: string }} QueuedUsage
 */

/**
 * Durable usage queue; `idempotencyKey` is unique for the lifetime of the record (including after it was sent).
 * @typedef {object} UsageQueueStore
 * @property {(record: UsageRecord) => Promise<{ inserted: boolean }>} enqueue
 * @property {(options: { now: number, limit: number, leaseMs: number, owner: string }) => Promise<QueuedUsage[]>} lease
 * @property {(keys: string[], options: { now: number, retainMs: number }) => Promise<void>} ack mark sent (kept for dedupe)
 * @property {(keys: string[], options: { now: number, nextAttemptAt: number, error: string }) => Promise<void>} retry
 * @property {(keys: string[], options: { now: number, error: string }) => Promise<void>} deadLetter
 * @property {() => Promise<{ pending: number, sent: number, dead: number }>} stats
 */

/**
 * Website-key revocations (keyIds) plus the Portal sync cursor.
 * @typedef {object} RevocationStore
 * @property {() => Promise<{ keyIds: string[], cursor: string | null, syncedAt: number | null }>} get
 * @property {(keyIds: string[], meta?: { cursor?: string | null, syncedAt?: number }) => Promise<void>} add
 */

/**
 * Product dashboard sessions created from verified launches.
 * @typedef {object} SessionStore
 * @property {(id: string, data: Record<string, unknown>, expiresAtMs: number) => Promise<void>} create
 * @property {(id: string) => Promise<Record<string, unknown> | null>} get
 * @property {(id: string) => Promise<void>} delete
 */

/**
 * @typedef {{ status: number, headers: Record<string, string>, body: string }} StoredResponse
 */

/**
 * Idempotency-Key records for POST replay.
 * @typedef {object} IdempotencyStore
 * @property {(key: string, fingerprint: string, expiresAtMs: number) => Promise<{ state: 'new' } | { state: 'pending' } | { state: 'mismatch' } | { state: 'done', response: StoredResponse }>} begin
 * @property {(key: string, response: StoredResponse) => Promise<void>} complete
 * @property {(key: string) => Promise<void>} release
 */

/**
 * Fixed-window counters.
 * @typedef {object} RateLimitStore
 * @property {(key: string, windowMs: number, now: number) => Promise<{ count: number, resetAt: number }>} hit
 */

/**
 * Last successfully fetched Portal JWKS (public keys only), so a cold instance can verify during a Portal outage.
 * @typedef {object} PortalKeyStore
 * @property {() => Promise<{ jwks: unknown, fetchedAt: number } | null>} get
 * @property {(jwks: unknown, fetchedAt: number) => Promise<void>} put
 */

/**
 * @typedef {object} Stores
 * @property {ReplayStore} replay
 * @property {ReplayStore} nonce
 * @property {BurnedTokenStore} burnedTokens
 * @property {EntitlementStore} entitlements
 * @property {UsageQueueStore} usageQueue
 * @property {RevocationStore} revocations
 * @property {SessionStore} sessions
 * @property {IdempotencyStore} idempotency
 * @property {RateLimitStore} rateLimits
 * @property {PortalKeyStore} portalKeys
 * @property {() => Promise<void>} [ping] readiness check of the backing database
 */

export {};
