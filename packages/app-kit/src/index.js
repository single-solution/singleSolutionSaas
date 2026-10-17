/**
 * @ss/app-kit — the kit every product is built on. See README.md and API.md.
 */
export { configFromEnv } from './config.js';
export { createProduct, createProductBase } from './product.js';
export { activityFilter } from './activity.js';
export { verifyIdentityToken } from './identity.js';
export { defineRoute } from './http/routes.js';
export { ok, created, noContent, problem, paginate } from './http/results.js';
export { toNextRoute } from './http/next.js';
export { createLogger } from './logger.js';
export { createMongoStore } from './stores/mongo.js';
export { createMemoryStore } from './stores/memory.js';
export { createSealer } from './sealing.js';
export { resealEach, sumCounts } from './reseal.js';
export { formatText } from './text.js';
export { actorOf } from './actor.js';
export { KIT_PERMISSIONS, checkStaff, grantedOf, grants } from './staff.js';
export { KIT_LINK_SCOPES } from './link-scopes.js';
export { countHandlers } from './counts.js';
export { KIT_GUIDE } from './guide.js';
export { apiAnchor, renderApiReference } from './api-reference.js';
export {
	docsBlock,
	docsFeatureSections,
	docsList,
	docsOperations,
	docsParagraph,
	docsRouteTable,
	operationFeatures,
	renderDocsPage,
} from './docs.js';
export { PRODUCT_DATABASE_OPTIONS } from './data.js';

/** @typedef {import('./product.js').ProductOptions} ProductOptions */
/** @typedef {import('./http/routes.js').RouteDefinition} RouteDefinition */
/** @typedef {import('./http/handler.js').RequestContext} RequestContext */
/** @typedef {import('./connections.js').ConnectionDefinition} ConnectionDefinition */
/** @typedef {import('./data.js').WebsiteData} WebsiteData */
/** @typedef {import('./data.js').IndexDefinition} IndexDefinition */
/** @typedef {import('./stores/types.js').Store} Store */
/** @typedef {import('./logger.js').Logger} Logger */
/** @typedef {import('./sealing.js').Sealer} Sealer */
/** @typedef {import('./reseal.js').ResealCounts} ResealCounts */
/** @typedef {import('./actor.js').ActingUser} ActingUser */
/** @typedef {import('./actor.js').Actor} Actor */
/** @typedef {import('./counts.js').CountField} CountField */
/** @typedef {import('./server-api.js').ListDefinition} ListDefinition */
/** @typedef {import('./imports.js').ImportCollection} ImportCollection */
/** @typedef {import('./imports.js').ImportOptions} ImportOptions */
/** @typedef {import('./identity.js').IdentityResult} IdentityResult */
/** @typedef {import('./docs.js').DocsGuide} DocsGuide */
/** @typedef {import('./docs.js').DocsRow} DocsRow */
/** @typedef {import('@ss/contracts').Format} Format */
