/**
 * A product's API description, `schemas/api.json` (the format is in README.md, "API descriptions"): what every
 * browser-token, server-token and ticket route takes and answers. `ss app assets` merges it into `openapi.json` with the
 * kit's own routes (described once in the kit, `@ss/app-kit/api`); `ss app validate` checks it against the routes
 * (`api.invalid`, `api.unknown`, `api.missing`); the product's tests check every answer against it
 * (`apiChecker` from `@ss/app-kit/testing`).
 * @module
 */
import {
	KIT_API,
	KIT_IMPORT_ROUTES,
	KIT_ROUTES,
	apiEntries,
	checkApiDescription,
	parseRouteKey,
	sharedSchemas,
} from '@ss/app-kit/api';
import { isObject, parseJson } from './fsutil.js';
import { problemOf } from './manifest.js';

/** @typedef {import('./manifest.js').Problem} Problem */
/** @typedef {import('./project.js').ProjectFiles} ProjectFiles */
/** @typedef {import('./routes.js').ScannedRoute} ScannedRoute */
/** @typedef {import('@ss/app-kit/api').ApiDescription} ApiDescription */

/** Project-relative path of the API description. */
export const API_FILE = 'schemas/api.json';
/** Auth modes of the routes `openapi.json` documents, and so `schemas/api.json` describes. */
const DOCUMENTED_AUTH = Object.freeze(['browser', 'server', 'ticket']);

/** The kit's description (its routes and shared schemas) and the routes it serves for every product, with their auth. */
export { KIT_API, KIT_ROUTES };

/**
 * The import routes the kit serves for a product whose manifest has the feature `import` (it passes `imports`); the
 * product describes them in its own `schemas/api.json`.
 * @param {unknown} manifest
 * @returns {ReadonlyArray<import('@ss/app-kit/api').KitRoute>}
 */
export const kitImportRoutesOf = (manifest) =>
	isObject(manifest) &&
	Array.isArray(manifest.features) &&
	manifest.features.some((feature) => isObject(feature) && feature.key === 'import')
		? KIT_IMPORT_ROUTES
		: [];

/**
 * @typedef {object} LoadedApi
 * @property {ApiDescription} api the description (`{}` when there is none or it is not a JSON object)
 * @property {boolean} present the file exists
 * @property {Problem[]} problems `api.invalid`
 */

/**
 * Read and check `schemas/api.json`.
 * @param {ProjectFiles} files
 * @returns {Promise<LoadedApi>}
 */
export const loadApi = async (files) => {
	if (!files.set.has(API_FILE)) return { api: {}, present: false, problems: [] };
	const parsed = parseJson(await files.read(API_FILE));
	const value = parsed.ok ? parsed.value : null;
	const problems = parsed.ok
		? checkApiDescription(value, { schemas: sharedSchemas(KIT_API) }).map(({ pointer, message }) =>
				problemOf({ rule: 'api.invalid', file: API_FILE, pointer, message }),
			)
		: [problemOf({ rule: 'api.invalid', file: API_FILE, message: parsed.message })];
	return { api: isObject(value) ? /** @type {ApiDescription} */ (value) : {}, present: true, problems };
};

/** @param {{ method: string, path: string }} route */
const keyOf = (route) => `${route.method} ${route.path}`;

/** A route with every parameter alike. @param {{ method: string, path: string }} route */
const shapeOf = (route) => keyOf({ method: route.method, path: route.path.replace(/:[^/]+/g, ':') });

/**
 * The description against the routes: an entry names a documented route of `server/` or an import route the kit
 * serves for the product (`api.unknown`, an error), and every one of them has an entry (`api.missing`).
 * @param {ApiDescription} api
 * @param {readonly ScannedRoute[]} scanned
 * @param {unknown} [manifest] the product's manifest (with the feature `import`, the kit's import routes are its own)
 * @returns {Problem[]}
 */
export const checkApiRoutes = (api, scanned, manifest) => {
	/** @type {Problem[]} */
	const problems = [];
	const own = new Set(scanned.map(keyOf));
	/** @type {ReadonlyArray<{ method: string, path: string, auth: string, file?: string, line?: number }>} */
	const routes = [...scanned, ...kitImportRoutesOf(manifest).filter((route) => !own.has(keyOf(route)))];
	const documented = new Set(routes.filter((route) => DOCUMENTED_AUTH.includes(route.auth)).map(keyOf));
	const kit = new Set(KIT_ROUTES.map(keyOf));
	const described = new Set(apiEntries(api).map(([key]) => key));
	for (const key of described) {
		const route = parseRouteKey(key);
		if (route === null || documented.has(key)) continue;
		const twin = routes.find((other) => shapeOf(other) === shapeOf(route));
		const message = kit.has(key)
			? `${key} is a route of the kit, which describes it itself`
			: twin === undefined
				? `${key}: no such route in server/`
				: !DOCUMENTED_AUTH.includes(twin.auth)
					? `${key} is a public route (auth ${twin.auth}): openapi.json documents browser, server and ticket routes only`
					: `${key}: the route is written '${keyOf(twin)}' in server/`;
		problems.push(
			problemOf({ rule: 'api.unknown', file: API_FILE, pointer: `/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, message }),
		);
	}
	for (const route of routes)
		if (documented.has(keyOf(route)) && !described.has(keyOf(route)))
			problems.push(
				problemOf({
					rule: 'api.missing',
					...(route.file === undefined
						? { file: API_FILE }
						: { file: route.file, ...(route.line === undefined ? {} : { line: route.line }) }),
					message: `${keyOf(route)} has no entry in ${API_FILE}: describe what it takes and answers${
						route.file === undefined ? ' (the kit serves it for the feature import)' : ''
					}`,
				}),
			);
	return problems;
};
