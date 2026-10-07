/**
 * @ss/cli — developer tooling for SSPS v1 products: `ss app init`, `ss app validate`, `ss app assets`,
 * `ss pack build`. The programmatic API mirrors the commands.
 * @module
 */
export { main, USAGE, VERSION } from './cli.js';
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
	checkStringSlices,
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
	moduleEntries,
	stringAssets,
	writePack,
} from './pack/index.js';

/** @typedef {import('./manifest.js').Problem} Problem */
/** @typedef {import('./validate/index.js').ValidationReport} ValidationReport */
/** @typedef {import('./pack/index.js').Pack} Pack */
/** @typedef {import('./pack/index.js').PackAsset} PackAsset */
