/**
 * @ss/cli — developer tooling for SSPS v1 products: `ss app init`, `ss app validate`, `ss pack build | publish`,
 * `ss dev` (local Portal emulator), `ss certify`. The programmatic API mirrors the commands.
 * @module
 */
export { main, USAGE, VERSION, SESSION_FILE } from './cli.js';
export { renderAssets, writeAssets, ASSETS_FILE } from './assets.js';
export { initApp, checkInitOptions, fill, insideWorkspace, TEMPLATES_DIR, INIT_KINDS } from './init.js';
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
	checkServerShape,
	serverEntries,
	MAX_SERVER_ENTRIES,
	checkPackageWiring,
	PACKAGE_WIRING,
	checkEventSchemas,
	checkBudgets,
	checkStringSlices,
	budgetHeadroom,
	inStringSlice,
	layerOf,
	packageOf,
	resolveImport,
} from './validate/index.js';
export {
	lex,
	findImports,
	findDomGlobals,
	findColours,
	findCssReferences,
	findStringKeys,
	findExports,
	colourLiterals,
	DOM_GLOBALS,
} from './validate/scan.js';
export { loadManifest, resolvePointer } from './manifest.js';
export {
	BUNDLE_FORMAT,
	PACK_OUT_DIR,
	LANGUAGE_CATALOG,
	assetOf,
	buildPack,
	bundleModules,
	descriptorOf,
	elementModules,
	measurePack,
	moduleEntries,
	publishPack,
	stringAssets,
	writePack,
} from './pack/index.js';
export { normaliseFixture, DEFAULT_PORTAL_URL, DEFAULT_PRODUCT_URL } from './emulator/fixture.js';
export { createPortal, portalError, DEFAULT_ENTITLEMENT_TTL_SECONDS, KEY_ROTATION_OVERLAP_SECONDS } from './emulator/portal.js';
export { createEmulatorServer } from './emulator/server.js';
export { simulateSettlement, formatSettlement } from './emulator/settle.js';
export { createDatabaseResolver, withDatabase } from './emulator/mongo.js';
export { buildEnvelope, SAMPLE_DATA, sampleData, sampleFromSchema, withVersion } from './emulator/events.js';
export { runCertification, formatReport, certificationFixture, problemShapeError, nextCursorOf } from './certify/index.js';

/** @typedef {import('./manifest.js').Problem} Problem */
/** @typedef {import('./validate/index.js').ValidationReport} ValidationReport */
/** @typedef {import('./emulator/portal.js').Portal} Portal */
/** @typedef {import('./certify/index.js').CertificationReport} CertificationReport */
/** @typedef {import('./pack/index.js').Pack} Pack */
/** @typedef {import('./pack/index.js').PackAsset} PackAsset */
