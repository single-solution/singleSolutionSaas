/**
 * @ss/app-kit — the kit every product is built on. See README.md and API.md.
 */
export { configFromEnv } from './config.js';
export { createProduct } from './product.js';
export { defineRoute } from './http/routes.js';
export { ok, created, noContent, problem, paginate } from './http/results.js';
export { toNextRoute } from './http/next.js';
export { createLogger, noopLogger } from './logger.js';
export { createMongoStore } from './stores/mongo.js';
export { createMemoryStore } from './stores/memory.js';
export { createHttpMessaging } from './adapters/http.js';
export { createSmtpMessaging } from './adapters/smtp.js';
export { formatText } from './text.js';

/** @typedef {import('./product.js').ProductOptions} ProductOptions */
/** @typedef {import('./http/routes.js').RouteDefinition} RouteDefinition */
/** @typedef {import('./http/handler.js').RequestContext} RequestContext */
/** @typedef {import('./connections.js').ConnectionDefinition} ConnectionDefinition */
/** @typedef {import('./data.js').WebsiteData} WebsiteData */
/** @typedef {import('./data.js').IndexDefinition} IndexDefinition */
/** @typedef {import('./stores/types.js').Store} Store */
/** @typedef {import('./logger.js').Logger} Logger */
