/**
 * @ss/cli — developer tooling for Single Solution products: `ss app init`, `ss app validate`, `ss app assets`. The
 * programmatic API mirrors the commands; `validateProject` is also used by system tests and products.
 * @module
 */
export { main, USAGE, VERSION } from './cli.js';
export {
	initApp,
	checkInitOptions,
	fill,
	globalNameOf,
	insideWorkspace,
	TEMPLATES_DIR,
	PRODUCT_ID,
	DEFAULT_BASE_URL,
} from './init.js';
export {
	validateProject,
	formatValidation,
	ANATOMY,
	ENV_NAMES,
	IMPORT_POLICY,
	PACKAGE_WIRING,
	MAX_SERVER_ENTRIES,
	checkAnatomy,
	checkImports,
	checkCorePure,
	checkStrings,
	checkEnvExample,
	checkCrons,
	checkRoutes,
	checkPackageWiring,
	checkServerShape,
	checkAssets,
	serverEntries,
	layerOf,
	packageOf,
	resolveImport,
} from './validate/index.js';
export { lex, findImports, findCssReferences, findDomGlobals, findStringKeys, findRoutes, DOM_GLOBALS } from './validate/scan.js';
export { scanRoutes, WIDGET_MODULE } from './routes.js';
export { renderOpenapi, KIT_API_ROUTES } from './openapi.js';
export { writeAssets, assetStates, renderWidgetModule, renderProjectOpenapi, OPENAPI_FILE, WIDGET_ENTRY } from './assets.js';
export { loadManifest, resolvePointer } from './manifest.js';
export { projectFiles } from './project.js';

/** @typedef {import('./manifest.js').Problem} Problem */
/** @typedef {import('./validate/index.js').ValidationReport} ValidationReport */
/** @typedef {import('./routes.js').ScannedRoute} ScannedRoute */
