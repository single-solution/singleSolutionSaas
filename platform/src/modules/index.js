/**
 * The module registry: every control-plane module is listed here once. The API catch-all route mounts the routes
 * of every module; collections, problem codes and ports are collected from this list.
 * Add a module by appending it — modules never import each other (they use `ctx.service(name)`).
 * @module
 */
import { systemModule } from './system/index.js';
import { catalogModule } from './catalog/index.js';
import { identityModule } from './identity/index.js';
import { commerceModule } from './commerce/index.js';

/** @type {ReadonlyArray<Readonly<import('../infra/modules.js').ModuleDefinition>>} */
export const modules = Object.freeze([systemModule, catalogModule, identityModule, commerceModule]);
