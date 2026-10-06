/**
 * @ss/app-kit — everything a service product needs to follow the Product Standard (SSPS v1). See README.md and API.md.
 */
export { createProduct } from './product.js';
export { CONTROL_DB_POOL_SIZE, DATABASE_URI_REQUIRED, configFromEnv, configProblems } from './env.js';
export { misconfiguredResponse } from './misconfigured.js';
export { createLogger, noopLogger, redact } from './logger.js';
export { createMemoryStores } from './stores/memory.js';
export { createMongoStores } from './stores/mongo.js';
export { createPortalClient } from './portal-client.js';
export { can, config, feature, featuresOf, resource, createEntitlements, STOPPED_STATES } from './entitlements.js';
export { createWebsiteKeys, scopeGranted } from './keys.js';
export { createLaunch, ROLE_OF_KIND } from './launch.js';
export { createUsage, backoffDelay } from './usage.js';
export { CLIENT_DB_POOL_SIZE, createData, guardFilter, guardPipeline, guardUpdate, planIndexes } from './data.js';
export { createConnectors, PAYMENTS_METHODS } from './connectors/index.js';
export { createS3Storage } from './connectors/storage.js';
export { createHttpConnector, createHttpAi, createHttpMessaging } from './connectors/http.js';
export { createSmtpMessaging, SMTP_PORTS } from './connectors/smtp.js';
export { createOutbox } from './outbox.js';
export { createBackground } from './background.js';
export { REPLAY_COLLECTION, REPLAY_HEADERS } from './http/replay.js';
export { presignUrl, signHeaders } from './connectors/sigv4.js';
export { createEvents, checkEvent, CONTROL_EVENTS } from './events.js';
export { createAudit } from './audit.js';
export { createHealth } from './health.js';
export { createIdentity, verifyIdentityToken, identityTokenOf, IDENTITY_HEADER, IDENTITY_MAX_AGE_MS } from './identity.js';
export { createPrivacy } from './privacy.js';
export { createRequestHandler } from './http/handler.js';
export { defineRoute } from './http/routes.js';
export { ok, created, noContent, problem, paginate, isProblem, RESERVED_PROBLEM_MEMBERS } from './http/results.js';
export { standardRoutes, resolveStrings } from './http/standard.js';
export { toNextRoute } from './http/next.js';
export { isKitError, collectionPrefix } from './util.js';
export { sweepStaleUploads, SWEEP_DEFAULT_LIMIT, SWEEP_MAX_LIMIT } from './uploads.js';

/** @typedef {import('./stores/types.js').Stores} Stores */
/** @typedef {import('./keys.js').WebsiteBinding} WebsiteBinding */
/** @typedef {import('./http/routes.js').RouteDefinition} RouteDefinition */
/** @typedef {import('./http/handler.js').RequestContext} RequestContext */
/** @typedef {import('./data.js').WebsiteData} WebsiteData */
/** @typedef {import('./data.js').IndexDefinition} IndexDefinition */
/** @typedef {import('./data.js').MigrationStep} MigrationStep */
/** @typedef {import('./logger.js').Logger} Logger */
/** @typedef {import('./identity.js').CustomerIdentity} CustomerIdentity */
/** @typedef {import('./product.js').ProductOptions} ProductOptions */
/** @typedef {import('./uploads.js').SweepInput} SweepInput */
/** @typedef {import('./uploads.js').SweepResult} SweepResult */
