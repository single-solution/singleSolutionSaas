/**
 * The product database store (PLAN 0.4.8). One small document store backs everything the kit keeps in the product's
 * own database: the Portal connection and keys, switches, settings, widget texts and theme, connections, Recent
 * changes, cached status, revoked token ids, business.json copies, widget last-seen times, dashboard sessions, replay
 * records and rate-limit counters. It never holds business data.
 *
 * `createMemoryStore` is for development and tests; `createMongoStore` is the production store.
 * @module
 */

/**
 * The collections the kit uses. Per-website documents carry `websiteId`.
 * @typedef {'state' | 'switches' | 'settings' | 'connections' | 'changes' | 'status' | 'revoked' | 'business'
 *   | 'widget' | 'sessions'} Collection
 */

/** @typedef {Record<string, any>} Doc */

/**
 * Equality filter on top-level fields; a field holding an array matches when it contains the value.
 * @typedef {Record<string, string | number | boolean | null>} Filter
 */

/**
 * @typedef {object} Store
 * @property {(collection: Collection, id: string) => Promise<Doc | null>} get
 * @property {(collection: Collection, id: string, doc: Doc) => Promise<void>} put insert or replace
 * @property {(collection: Collection, id: string, doc: Doc) => Promise<boolean>} insert insert if absent (false when it exists)
 * @property {(collection: Collection, id: string) => Promise<void>} delete
 * @property {(collection: Collection, filter: Filter, options?: { limit?: number }) => Promise<Doc[]>} list newest
 *   `at` first
 * @property {(collection: Collection, filter: Filter) => Promise<number>} deleteWhere
 * @property {(id: string, expiresAtMs: number) => Promise<boolean>} seen records an id; true when already recorded
 * @property {(id: string) => Promise<void>} forget
 * @property {(key: string, windowMs: number, now: number) => Promise<{ count: number, resetAt: number }>} hit
 *   fixed-window counter
 */

export {};
