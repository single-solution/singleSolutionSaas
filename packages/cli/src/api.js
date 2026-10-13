/**
 * A product's API description, `schemas/api.json` (the format is in README.md, "API descriptions"): what every
 * browser-token, server-token and ticket route takes and answers. `ss app assets` merges it into `openapi.json` with the
 * kit's own routes (described once in the kit, `@ss/app-kit/api`); `ss app validate` checks it against the routes
 * (`api.invalid`, `api.unknown`, `api.missing`); the product's tests check every answer against it
 * (`apiChecker` from `@ss/app-kit/testing`).
 * @module
 */
import { KIT_API, apiEntries, checkApiDescription, parseRouteKey, sharedSchemas } from '@ss/app-kit/api';
import { isObject, parseJson } from './fsutil.js';
import { problemOf } from './manifest.js';

/** @typedef {import('./manifest.js').Problem} Problem */
/** @typedef {import('./project.js').ProjectFiles} ProjectFiles */
/** @typedef {import('./routes.js').ScannedRoute} ScannedRoute */
/** @typedef {import('@ss/app-kit/api').ApiDescription} ApiDescription */

/** Project-relative path of the API description. */
export const API_FILE = 'schemas/api.json';
/** Auth modes of the routes `openapi.json` documents, and so `schemas/api.json` describes. */
export const DOCUMENTED_AUTH = Object.freeze(['browser', 'server', 'ticket']);

/** The API routes the kit serves for every product (server token, no feature), as its own description names them. */
export const KIT_ROUTES = Object.freeze(
	apiEntries(KIT_API).map(([key]) => ({
		.../** @type {{ method: string, path: string }} */ (parseRouteKey(key)),
		auth: 'server',
	})),
);

/** The kit's description: its routes and shared schemas. */
export { KIT_API };

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
 * The description against the routes: an entry names a documented route of `server/` (`api.unknown`, an error), and
 * every documented route has an entry (`api.missing`, a warning for now).
 * @param {ApiDescription} api
 * @param {readonly ScannedRoute[]} routes
 * @returns {Problem[]}
 */
export const checkApiRoutes = (api, routes) => {
	/** @type {Problem[]} */
	const problems = [];
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
					severity: 'warning',
					rule: 'api.missing',
					file: route.file,
					line: route.line,
					message: `${keyOf(route)} has no entry in ${API_FILE}: describe what it takes and answers`,
				}),
			);
	return problems;
};
