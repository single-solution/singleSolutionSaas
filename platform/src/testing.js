/**
 * `@ss/platform/testing` — the one entry point for system tests that run the REAL Portal in process (the `e2e/`
 * workspace): the composition root, the production module list and the module factories (to point outbound calls at
 * loopback hosts), configuration, TOTP for the two-step code, the Mongo client cache and a small HTTP driver of the
 * Portal API (`createPortalClient`). Nothing else of the Portal's internals is public; add to this list rather than
 * importing deep paths.
 * @module
 */
export { createPortal } from './portal.js';
export { SESSIONS, loadConfig, loadEnv } from './infra/config.js';
export { createSystemStore, testSystemState } from './infra/system.js';
export { totpCode } from './infra/auth.js';
export { closeMongoClients } from './infra/db.js';
export { modules } from './modules/index.js';
export { systemModule } from './modules/system/index.js';
export { createCatalogModule } from './modules/catalog/index.js';
export { createIdentityModule } from './modules/identity/index.js';
export { commerceModule } from './modules/commerce/index.js';
export { createPortalClient } from './infra/client.js';
