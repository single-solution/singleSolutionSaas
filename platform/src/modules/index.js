/**
 * The module registry: every control-plane module is listed here once. The API catch-all route mounts the routes
 * of every module; collections, jobs, crons, migrations, problem codes and ports are collected from this list.
 * Add a module by appending it — modules never import each other (they use `ctx.service(name)`).
 * @module
 */
import { systemModule } from './system/index.js';
import { integrationModule } from './integration/index.js';
import { catalogModule } from './catalog/index.js';
import { identityModule } from './identity/index.js';
import { configModule } from './config/index.js';
import { connectorsModule } from './connectors/index.js';
import { commerceModule } from './commerce/index.js';

/** @type {ReadonlyArray<Readonly<import('../infra/modules.js').ModuleDefinition>>} */
export const modules = Object.freeze([
	systemModule,
	integrationModule,
	catalogModule,
	identityModule,
	configModule,
	connectorsModule,
	commerceModule,
]);
