/**
 * @ss/cli — developer tooling for SSPS v1 products: `ss app init`, `ss app validate`, `ss dev` (local Portal
 * emulator), `ss certify`. The programmatic API mirrors the commands.
 * @module
 */
export { main, USAGE, VERSION, SESSION_FILE } from './cli.js';
export { initApp, checkInitOptions, fill, TEMPLATES_DIR, INIT_KINDS } from './init.js';
export {
	validateProject,
	formatValidation,
	ANATOMY,
	IMPORT_POLICY,
	checkAnatomy,
	checkImports,
	checkDomFree,
	checkColours,
	checkStringKeys,
	checkModules,
	checkServiceContract,
	checkEventSchemas,
	layerOf,
	packageOf,
	resolveImport,
} from './validate/index.js';
export {
	lex,
	findImports,
	findDomGlobals,
	findColours,
	findStringKeys,
	findExports,
	colourLiterals,
	DOM_GLOBALS,
} from './validate/scan.js';
export { loadManifest, resolvePointer } from './manifest.js';
export { normaliseFixture, DEFAULT_PORTAL_URL, DEFAULT_PRODUCT_URL } from './emulator/fixture.js';
export { createPortal, portalError, DEFAULT_ENTITLEMENT_TTL_SECONDS, KEY_ROTATION_OVERLAP_SECONDS } from './emulator/portal.js';
export { createEmulatorServer } from './emulator/server.js';
export { simulateSettlement, formatSettlement } from './emulator/settle.js';
export { createDatabaseResolver, withDatabase } from './emulator/mongo.js';
export { buildEnvelope, SAMPLE_DATA, withVersion } from './emulator/events.js';
export { runCertification, formatReport, certificationFixture, problemShapeError, nextCursorOf } from './certify/index.js';

/** @typedef {import('./manifest.js').Problem} Problem */
/** @typedef {import('./validate/index.js').ValidationReport} ValidationReport */
/** @typedef {import('./emulator/portal.js').Portal} Portal */
/** @typedef {import('./certify/index.js').CertificationReport} CertificationReport */
