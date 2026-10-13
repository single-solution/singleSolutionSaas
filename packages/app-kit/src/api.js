/**
 * API descriptions (`schemas/api.json` of a product; the kit's own routes in `kit-api.json`): what every call takes
 * and answers, in the JSON Schema subset of `api-schema.js`. `ss app assets` merges them into `openapi.json` and the
 * docs; the products' tests check every answer against them (`apiChecker`, from `@ss/app-kit/testing`), so a
 * description cannot drift from the code. Nothing here runs in production.
 *
 * The file is an object keyed `"<METHOD> <path as in defineRoute>"` (for example `"POST /v1/payments/:id/cancel"`),
 * each value `{ summary?, description?, query?, body?, response?, status? }`: `query`, `body` and `response` are
 * schemas (`query` an object schema whose properties are the query parameters), `status` the success status (default
 * 200; 204 has no `response`). The optional `"$schemas"` holds shared schemas by name, referenced as
 * `{ "$ref": "#/components/schemas/<Name>" }`; the kit's own shared schemas (`Count`, `Counts`, `Connection` …) may be
 * referenced too.
 * @module
 */
import KIT_API_JSON from './kit-api.json' with { type: 'json' };
import { SCHEMA_REF, schemaProblems, validateValue } from './api-schema.js';
import { isObject } from './util.js';

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

/** The kit's own routes (tickets, data rights, permissions, features, settings, texts, theme, Format, lists, connections, activity). */
export const KIT_API = /** @type {ApiDescription} */ (/** @type {unknown} */ (KIT_API_JSON));

/** Members of a route's entry. */
/** A request header's name, as the route's own headers are named (`SS-Guest`, `SS-Order-Key` …). */
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
export const API_ENTRY_MEMBERS = Object.freeze(['summary', 'description', 'query', 'headers', 'body', 'response', 'status']);
/** Methods a route may have. */
const METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const ROUTE_KEY = /^([A-Z]+) (\/\S*)$/;
const SCHEMA_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/** @param {string} token */
const escapeToken = (token) => token.replace(/~/g, '~0').replace(/\//g, '~1');

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

/**
 * One description from the kit's and a product's (the product's shared schemas next to the kit's).
 * @param {ApiDescription} kit
 * @param {ApiDescription} api
 * @returns {ApiDescription}
 */
export const mergeApi = (kit, api) => ({
	...Object.fromEntries(apiEntries(kit)),
	...Object.fromEntries(apiEntries(api)),
	$schemas: { ...sharedSchemas(kit), ...sharedSchemas(api) },
});

/**
 * Checks answers against an API description, for a product's tests: hand it every answer the tests see. Routes the
 * description does not name (pages, the dashboard API) and answers other than 2xx are not checked.
 *
 *   const api = apiChecker(apiJson); // schemas/api.json, plus the kit's routes
 *   api.assert({ method: 'GET', path: '/v1/payments/pay_…', status: 200, body }); // throws on a mismatch
 * @param {unknown} api the product's description (`schemas/api.json`)
 * @param {{ kit?: boolean }} [options] `kit: false` leaves out the kit's own routes
 */
export const apiChecker = (api, { kit = true } = {}) => {
	const base = kit ? sharedSchemas(KIT_API) : {};
	const invalid = checkApiDescription(api, { schemas: base });
	if (invalid.length > 0)
		throw new TypeError(
			`the API description is invalid:\n${invalid.map((problem) => `${problem.pointer}: ${problem.message}`).join('\n')}`,
		);
	const description = kit ? mergeApi(KIT_API, /** @type {ApiDescription} */ (api)) : /** @type {ApiDescription} */ (api);
	const schemas = sharedSchemas(description);
	const routes = apiEntries(description).map(([key, entry]) => {
		const route = /** @type {{ method: string, path: string }} */ (parseRouteKey(key));
		const segments = route.path.split('/').filter(Boolean);
		return {
			...route,
			segments,
			literals: segments.filter((segment) => !segment.startsWith(':')).length,
			entry: /** @type {ApiEntry} */ (entry),
		};
	});

	/**
	 * The described route of a request, or null (literal segments win over parameters).
	 * @param {string} method
	 * @param {string} path a path or an address (the query is ignored)
	 */
	const routeOf = (method, path) => {
		const parts = new URL(path, 'http://localhost').pathname.split('/').filter(Boolean);
		const found = routes
			.filter(
				(route) =>
					route.method === method.toUpperCase() &&
					route.segments.length === parts.length &&
					route.segments.every((segment, index) => segment.startsWith(':') || segment === parts[index]),
			)
			.sort((a, b) => b.literals - a.literals);
		return found[0] ?? null;
	};

	/**
	 * What is wrong with an answer (an empty list when it fits, or when nothing describes it).
	 * @param {{ method: string, path: string, status: number, body: unknown }} answer `body`: the parsed JSON, or
	 *   null/undefined when the answer had none
	 * @returns {string[]}
	 */
	const check = ({ method, path, status, body }) => {
		const route = routeOf(method, path);
		if (!route || status < 200 || status > 299) return [];
		const name = `${route.method} ${route.path} (${status})`;
		const expected = route.entry.status ?? 200;
		/** @type {string[]} */
		const out = [];
		if (status !== expected) out.push(`${name}: answered ${status}, described ${expected}`);
		const has = body !== null && body !== undefined;
		if (route.entry.response === undefined) {
			if (has) out.push(`${name}: answered a JSON body, but the description has no response`);
			return out;
		}
		// a JSON `null` is an answer when the description allows it (e.g. "no notice right now")
		if (body === null && validateValue(route.entry.response, null, { schemas }).length === 0) return out;
		if (!has) return [...out, `${name}: answered no JSON body, but the description has a response`];
		for (const problem of validateValue(route.entry.response, body, { schemas }))
			out.push(`${name}: ${problem.path || '(the body)'} ${problem.message}`);
		return out;
	};

	return Object.freeze({
		check,
		/**
		 * Throw when an answer does not fit its description (for a test helper's `call()`).
		 * @param {Parameters<typeof check>[0]} answer
		 */
		assert: (answer) => {
			const problems = check(answer);
			if (problems.length > 0) throw new Error(`the answer does not fit schemas/api.json:\n${problems.join('\n')}`);
		},
		/** The described route of a request, or null. @param {string} method @param {string} path */
		described: (method, path) => {
			const route = routeOf(method, path);
			return route ? `${route.method} ${route.path}` : null;
		},
	});
};

export { SCHEMA_REF, schemaProblems, validateValue };
