/**
 * API descriptions (`schemas/api.json` of a product; the kit's own routes in `kit-api.json`): what every call takes
 * and answers, in the JSON Schema subset of `api-schema.js`. `ss app assets` merges them into `openapi.json` and the
 * docs; the products' tests check every answer against them (`apiChecker`, from `@ss/app-kit/testing`), so a
 * description cannot drift from the code. Nothing here runs in production.
 *
 * The file is an object keyed `"<METHOD> <path as in defineRoute>"` (for example `"POST /v1/payments/:id/cancel"`),
 * each value `{ summary?, description?, query?, headers?, body?, response?, status? }`: `query`, `headers`, `body` and
 * `response` are schemas (`query` and `headers` object schemas whose properties are the query parameters and the
 * request headers the route reads), `status` the success status (default
 * 200; 204 has no `response`). The optional `"$schemas"` holds shared schemas by name, referenced as
 * `{ "$ref": "#/components/schemas/<Name>" }`; the kit's own shared schemas (`Count`, `Counts`, `Connection` …) may be
 * referenced too.
 * @module
 */
import { isObject } from '@ss/contracts/util';
import KIT_API_JSON from './kit-api.json' with { type: 'json' };
import { escapeToken, schemaProblems } from './api-schema.js';

/** @typedef {import('./api-schema.js').Schema} Schema */
/** @typedef {import('./api-schema.js').NamedSchemas} NamedSchemas */
/**
 * @typedef {object} ApiEntry
 * @property {string} [summary]
 * @property {string} [description]
 * @property {Schema} [query] an object schema: its properties are the query parameters
 * @property {Schema} [headers] an object schema: its properties are the request headers the route reads
 * @property {Schema} [body] the JSON request body
 * @property {Schema} [response] the JSON answer on success
 * @property {number} [status] the success status (default 200)
 */
/** @typedef {{ $schemas?: Record<string, Schema> } & Record<string, unknown>} ApiDescription */
/** @typedef {{ pointer: string, message: string }} ApiProblem `pointer`: JSON Pointer into the description */

/**
 * The kit's own routes (widget config, tickets, data rights, permissions, features, settings, texts, theme, Format,
 * lists, connections, activity).
 */
export const KIT_API = /** @type {ApiDescription} */ (/** @type {unknown} */ (KIT_API_JSON));

/** A request header's name, as the route's own headers are named (`SS-Guest`, `SS-Order-Key` …). */
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
/** Members of a route's entry. */
const API_ENTRY_MEMBERS = Object.freeze(['summary', 'description', 'query', 'headers', 'body', 'response', 'status']);
/** Methods a route may have. */
const METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const ROUTE_KEY = /^([A-Z]+) (\/\S*)$/;
const SCHEMA_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/**
 * The method and path of a route key (`"GET /v1/payments/:id"`), or null.
 * @param {string} key
 * @returns {{ method: string, path: string } | null}
 */
export const parseRouteKey = (key) => {
	const match = ROUTE_KEY.exec(key);
	return match && METHODS.includes(/** @type {string} */ (match[1]))
		? { method: /** @type {string} */ (match[1]), path: /** @type {string} */ (match[2]) }
		: null;
};

/**
 * The route a key names, with every parameter alike (`GET /v1/payments/:`), to find two keys for one route.
 * @param {{ method: string, path: string }} route
 */
const routeId = ({ method, path }) =>
	`${method} /${path
		.split('/')
		.filter(Boolean)
		.map((segment) => (segment.startsWith(':') ? ':' : segment))
		.join('/')}`;

/**
 * The route entries of a description (every key but `$schemas`).
 * @param {unknown} api
 * @returns {Array<[string, unknown]>}
 */
export const apiEntries = (api) => (isObject(api) ? Object.entries(api).filter(([key]) => key !== '$schemas') : []);

/**
 * The shared schemas of a description.
 * @param {unknown} api
 * @returns {Record<string, Schema>}
 */
export const sharedSchemas = (api) =>
	isObject(api) && isObject(api.$schemas) ? /** @type {Record<string, Schema>} */ (api.$schemas) : {};

/** Kit routes whose auth is not the server token. */
const KIT_ROUTE_AUTH = Object.freeze({ 'GET /v1/widget/config': 'browser', 'GET /v1/widget/admin/config': 'ticket' });

/**
 * A documented route the kit serves: its method, path and auth (`browser`, `server` or `ticket`), and its feature when
 * it has one.
 * @typedef {{ method: string, path: string, auth: string, feature?: string }} KitRoute
 */

/** The routes the kit serves for every product, as `kit-api.json` describes them, with their auth (no feature). */
export const KIT_ROUTES = /** @type {ReadonlyArray<KitRoute>} */ (
	Object.freeze(
		apiEntries(KIT_API).map(([key]) =>
			Object.freeze({
				.../** @type {{ method: string, path: string }} */ (parseRouteKey(key)),
				auth: KIT_ROUTE_AUTH[/** @type {keyof typeof KIT_ROUTE_AUTH} */ (key)] ?? 'server',
			}),
		),
	)
);

/**
 * The import routes (PLAN 0.8.10 K10) the kit serves for a product that passes `imports` (its manifest has the feature
 * `import`): server token, feature `import`. The product describes them in its own `schemas/api.json` (its
 * collections, its finish and its totals).
 */
export const KIT_IMPORT_ROUTES = /** @type {ReadonlyArray<KitRoute>} */ (
	Object.freeze(
		[
			['POST', '/v1/import/:collection'],
			['POST', '/v1/import/:collection/prune'],
			['POST', '/v1/import/finish'],
			['GET', '/v1/import/status'],
		].map(([method, path]) => Object.freeze({ method, path, auth: 'server', feature: 'import' })),
	)
);

/**
 * What is wrong with an API description: its shape, its route keys, its entries' members and their schemas (in the
 * subset, every `$ref` resolving to a shared schema of its own or of `schemas`).
 * @param {unknown} api
 * @param {{ schemas?: NamedSchemas }} [options] shared schemas defined elsewhere (the kit's), which the description may
 *   reference but not define again
 * @returns {ApiProblem[]}
 */
export const checkApiDescription = (api, { schemas: base = {} } = {}) => {
	if (!isObject(api)) return [{ pointer: '', message: 'the API description is a JSON object' }];
	/** @type {ApiProblem[]} */
	const out = [];
	/** @param {string} pointer @param {string} message */
	const fail = (pointer, message) => void out.push({ pointer, message });
	const own = api.$schemas;
	if (own !== undefined && !isObject(own)) fail('/$schemas', '$schemas maps names to shared schemas');
	const named = sharedSchemas(api);
	const schemas = { ...base, ...named };
	/** @param {unknown} schema @param {string} at */
	const checkSchema = (schema, at) =>
		schemaProblems(schema, { schemas, at }).forEach((problem) => fail(problem.path, problem.message));
	for (const [name, schema] of Object.entries(named)) {
		const at = `/$schemas/${escapeToken(name)}`;
		if (!SCHEMA_NAME.test(name)) fail(at, 'a shared schema name is a letter, then letters, digits, _ . - (at most 64)');
		else if (Object.hasOwn(base, name)) fail(at, `'${name}' is a shared schema of the kit: reference it, or use another name`);
		checkSchema(schema, at);
	}
	/** @type {Map<string, string>} */
	const seen = new Map();
	for (const [key, entry] of apiEntries(api)) {
		const at = `/${escapeToken(key)}`;
		const route = parseRouteKey(key);
		if (!route) {
			fail(at, `keys are '<METHOD> <path>' as in defineRoute (${METHODS.join(', ')}), or $schemas`);
			continue;
		}
		const id = routeId(route);
		const twin = seen.get(id);
		if (twin !== undefined) fail(at, `the same route as '${twin}'`);
		seen.set(id, key);
		if (!isObject(entry)) {
			fail(at, 'an entry is a JSON object');
			continue;
		}
		for (const member of Object.keys(entry))
			if (!API_ENTRY_MEMBERS.includes(member))
				fail(`${at}/${escapeToken(member)}`, `an entry has ${API_ENTRY_MEMBERS.join(', ')}`);
		for (const member of ['summary', 'description'])
			if (entry[member] !== undefined && typeof entry[member] !== 'string') fail(`${at}/${member}`, `${member} is a text`);
		const status = entry.status ?? 200;
		if (!Number.isInteger(status) || /** @type {number} */ (status) < 200 || /** @type {number} */ (status) > 299)
			fail(`${at}/status`, 'status is the success status, 200–299');
		if (status === 204 && entry.response !== undefined) fail(`${at}/response`, 'a 204 answer has no body: leave response out');
		if (entry.query !== undefined) {
			const query = entry.query;
			if (!isObject(query) || query.type !== 'object' || !isObject(query.properties))
				fail(`${at}/query`, 'query is an object schema whose properties are the query parameters');
			checkSchema(query, `${at}/query`);
		}
		if (entry.headers !== undefined) {
			const headers = entry.headers;
			if (!isObject(headers) || headers.type !== 'object' || !isObject(headers.properties))
				fail(`${at}/headers`, 'headers is an object schema whose properties are the request headers');
			else
				for (const name of Object.keys(headers.properties))
					if (!HEADER_NAME.test(name))
						fail(
							`${at}/headers/${escapeToken(name)}`,
							'a header name is a letter, then letters, digits and - (at most 64)',
						);
			checkSchema(headers, `${at}/headers`);
		}
		for (const member of ['body', 'response']) if (entry[member] !== undefined) checkSchema(entry[member], `${at}/${member}`);
	}
	return out;
};

export { validateValue } from './api-schema.js';
