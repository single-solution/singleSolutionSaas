/**
 * @ss/importer — `ss-import` (PLAN 0.8.10 Migration): `read` a store database read only into NDJSON files, an id map
 * and the website's settings, `send` them to the products' settings API and import routes (dry run first; prune on the
 * final pass), `verify` the counts and sums. Never deployed.
 * @module
 */
export { defineMapping, hexOf, legacyId } from './mapping.js';
export { DEFAULT_KEY, compareKeyTexts, keyPayloadOf, keyTextOf, keyValuesOf } from './keys.js';
export { chunk, linesOf, toNdjson } from './ndjson.js';
export { IDMAP_FILE, MANIFEST_FILE, SETTINGS_FILE, read } from './read.js';
export { applySettings, mergePlans } from './settings.js';
export { pruneCalls, send } from './send.js';
export { verify } from './verify.js';
export { MAPPINGS } from './mappings/index.js';
export { main, USAGE } from './cli.js';

/** @typedef {import('./mapping.js').Mapping} Mapping */
/** @typedef {import('./mapping.js').MappingStep} MappingStep */
/** @typedef {import('./mapping.js').MapContext} MapContext */
/** @typedef {import('./mapping.js').SettingsPlan} SettingsPlan */
/** @typedef {import('./read.js').ReadManifest} ReadManifest */
/** @typedef {import('./send.js').SendReport} SendReport */
/** @typedef {import('./settings.js').SettingsReport} SettingsReport */
/** @typedef {import('./verify.js').VerifyReport} VerifyReport */
