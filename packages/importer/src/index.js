/**
 * @ss/importer — `ss-import` (PLAN 0.8.10 Migration): `read` a store database read only into NDJSON files and an id
 * map, `send` them to the products' import routes (dry run first), `verify` the counts. Never deployed.
 * @module
 */
export { defineMapping, hexOf, legacyId } from './mapping.js';
export { chunk, linesOf, toNdjson } from './ndjson.js';
export { IDMAP_FILE, MANIFEST_FILE, read } from './read.js';
export { send } from './send.js';
export { verify } from './verify.js';
export { MAPPINGS } from './mappings/index.js';
export { main, USAGE } from './cli.js';

/** @typedef {import('./mapping.js').Mapping} Mapping */
/** @typedef {import('./mapping.js').MappingStep} MappingStep */
/** @typedef {import('./mapping.js').MapContext} MapContext */
/** @typedef {import('./read.js').ReadManifest} ReadManifest */
/** @typedef {import('./send.js').SendReport} SendReport */
/** @typedef {import('./verify.js').VerifyReport} VerifyReport */
