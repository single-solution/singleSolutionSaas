/**
 * Shared vocabularies (PLAN 0.0, 0.2, 0.4.12, 0.5.5).
 * @module
 */

/** The six products. Product ids are checked only against `PATTERNS.productId`, so other ids work in tests. */
export const PRODUCT_IDS = Object.freeze(
	/** @type {const} */ (['accounts', 'ecommerce', 'chat', 'notifications', 'payments', 'growth']),
);

/** Status of a product on a website, in check order: removed, suspended, stopped, grace, active. */
export const PRODUCT_STATUSES = Object.freeze(/** @type {const} */ (['active', 'grace', 'stopped', 'suspended', 'removed']));

/** Merchant status, in check order: suspended, stopped, grace, low balance, active. */
export const MERCHANT_STATUSES = Object.freeze(/** @type {const} */ (['active', 'low_balance', 'grace', 'stopped', 'suspended']));

/** Admin roles. */
export const ADMIN_ROLES = Object.freeze(/** @type {const} */ (['owner', 'support', 'finance']));

/** Admin roles that may open a product dashboard (the Portal refuses Finance launches). */
export const DASHBOARD_ROLES = Object.freeze(/** @type {const} */ (['owner', 'support']));

/** Notice types (the same list as `@ss/protocol` `NOTICE_TYPES`). */
export const NOTICE_TYPES = Object.freeze(
	/** @type {const} */ (['status.changed', 'token.revoked', 'sessions.revoked', 'website.deleted']),
);

/** Statuses for which a product refuses service; the `reason` of a `product_unavailable` problem. */
export const PRODUCT_UNAVAILABLE_REASONS = Object.freeze(/** @type {const} */ (['stopped', 'suspended', 'removed']));

/**
 * One call of a product's import route (PLAN 0.8.10 K10, Migration): NDJSON of at most this many records and bytes.
 * The importer splits its files to fit.
 */
export const IMPORT_LIMITS = Object.freeze({ records: 1000, bytes: 4 * 1024 * 1024 });

/** @typedef {typeof PRODUCT_IDS[number]} KnownProductId */
/** @typedef {typeof PRODUCT_STATUSES[number]} ProductStatus */
/** @typedef {typeof MERCHANT_STATUSES[number]} MerchantStatus */
/** @typedef {typeof ADMIN_ROLES[number]} AdminRole */
/** @typedef {typeof DASHBOARD_ROLES[number]} DashboardRole */
/** @typedef {typeof NOTICE_TYPES[number]} NoticeType */
/** @typedef {typeof PRODUCT_UNAVAILABLE_REASONS[number]} ProductUnavailableReason */
