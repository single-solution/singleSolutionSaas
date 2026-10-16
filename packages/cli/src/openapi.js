/**
 * `openapi.json` generated from the routes (PLAN 0.4.13): every browser-token, server-token and ticket route of the
 * product, plus the API routes the kit serves for every product (widget config, tickets, data rights, the permission
 * list, the settings API and the activity log, PLAN 0.8.10 K1, K9, each with its auth) and, for a manifest with the
 * feature `import`, the kit's import routes (K10). Each operation names its auth (`x-ss-auth`), its feature
 * (`x-ss-feature`: one key, or a list when any of them is enough) and, for ticket routes, its permission
 * (`x-ss-permission`). Server-token operations take the optional `SS-Actor-*` headers (K2); visitor (browser-token)
 * operations also take the server token with `SS-Visitor-IP` (K3). Errors are RFC 9457 problems whose `type` ends with
 * a stable code.
 *
 * What each call takes and answers comes from the API descriptions: the product's `schemas/api.json` and the kit's own
 * (`@ss/app-kit/api`): summary and description, query parameters, the JSON request body, the success status with its
 * JSON answer, and the shared schemas (`components.schemas`). A route without a description answers "2XX Success".
 * @module
 */
import { PRODUCT_UNAVAILABLE_REASONS } from '@ss/contracts';
import { isObject } from './fsutil.js';
import { KIT_API, KIT_ROUTES, kitImportRoutesOf } from './api.js';

/** @typedef {import('./routes.js').ScannedRoute} ScannedRoute */
/** @typedef {import('@ss/app-kit/api').ApiDescription} ApiDescription */
/** @typedef {import('@ss/app-kit/api').ApiEntry} ApiEntry */

/** What a repeated `Idempotency-Key` does. */
const IDEMPOTENCY_TEXT =
	'A key of your own per request: the same request again within 24 hours gets the first answer (Idempotent-Replayed: true); another request with it answers 409 duplicate_request.';

/** An error answer (RFC 9457) as the kit renders it. */
const PROBLEM = Object.freeze({
	type: 'object',
	description:
		'An error (RFC 9457, application/problem+json). The last segment of type is a stable code, for example validation_failed.',
	required: ['type', 'title', 'status'],
	properties: {
		type: { type: 'string', description: 'https://<product>/problems/<code>' },
		title: { type: 'string' },
		status: { type: 'integer' },
		detail: { type: 'string' },
		instance: { type: 'string', description: 'The path of the request.' },
		requestId: { type: 'string', description: 'Quote it when you contact support.' },
		reason: { type: 'string', enum: [...PRODUCT_UNAVAILABLE_REASONS], description: 'product_unavailable only.' },
		errors: {
			type: 'array',
			description: 'validation_failed: what is wrong, field by field.',
			items: {
				type: 'object',
				required: ['path', 'message'],
				properties: {
					path: { type: 'string', description: 'JSON Pointer of the field, for example /amount.' },
					message: { type: 'string' },
					keyword: { type: 'string' },
					code: { type: 'string' },
				},
			},
		},
	},
});

/**
 * The shared schemas of a description.
 * @param {ApiDescription} api
 * @returns {Record<string, unknown>}
 */
const sharedOf = (api) => (isObject(api.$schemas) ? api.$schemas : {});

/** Headers of the acting user on server-token calls (K2). */
const ACTOR_PARAMETERS = Object.freeze(['SSActorId', 'SSActorName', 'SSActorRole', 'SSActorEmail']);

/** Auth modes documented in the API reference and their security schemes. */
const SCHEMES = Object.freeze({
	browser: 'browserToken',
	server: 'serverToken',
	ticket: 'ticket',
});

/**
 * @param {unknown} manifest
 * @returns {{ name: string, version: string, base: string, featureOf: Map<string, string> }}
 */
const manifestFacts = (manifest) => {
	const m = isObject(manifest) ? manifest : {};
	const endpoints = isObject(m.endpoints) ? m.endpoints : {};
	const permissions = Array.isArray(m.permissions) ? m.permissions : [];
	return {
		name: typeof m.name === 'string' ? m.name : 'Product',
		version: typeof m.version === 'string' ? m.version : '0.0.0',
		base: typeof endpoints.base === 'string' ? endpoints.base : '/',
		featureOf: new Map(
			permissions
				.filter((p) => isObject(p) && typeof p.key === 'string' && typeof p.feature === 'string')
				.map((p) => [/** @type {string} */ (p.key), /** @type {string} */ (p.feature)]),
		),
	};
};

/**
 * The route entries of a description by key.
 * @param {ApiDescription} api
 * @returns {Record<string, ApiEntry>}
 */
const entriesOf = (api) =>
	/** @type {Record<string, ApiEntry>} */ (
		Object.fromEntries(Object.entries(api).filter(([key, entry]) => key !== '$schemas' && isObject(entry)))
	);

/**
 * The query or header parameters an entry describes (each property of its `query` or `headers` schema).
 * @param {unknown} query
 * @param {'query' | 'header'} [where]
 */
const queryParameters = (query, where = 'query') => {
	if (!isObject(query) || !isObject(query.properties)) return [];
	const required = Array.isArray(query.required) ? query.required : [];
	return Object.entries(query.properties).map(([name, schema]) => ({
		name,
		in: where,
		required: required.includes(name),
		...(isObject(schema) && typeof schema.description === 'string' ? { description: schema.description } : {}),
		schema,
	}));
};

/**
 * The JSON request body an entry describes (required when the schema requires a member).
 * @param {unknown} body
 */
const requestBody = (body) =>
	body === undefined
		? {}
		: {
				requestBody: {
					required: isObject(body) && Array.isArray(body.required) && body.required.length > 0,
					content: { 'application/json': { schema: body } },
				},
			};

/** Descriptions of success statuses. */
const STATUS_TEXT = Object.freeze({ 200: 'Success', 201: 'Created', 202: 'Accepted', 204: 'No content' });

/**
 * The success answer of an operation: the described status and JSON answer, else any 2xx.
 * @param {ApiEntry | undefined} entry
 */
const success = (entry) => {
	if (entry === undefined) return { '2XX': { description: 'Success (JSON)' } };
	const status = entry.status ?? 200;
	return {
		[status]: {
			description: STATUS_TEXT[/** @type {keyof typeof STATUS_TEXT} */ (status)] ?? 'Success',
			...(entry.response === undefined ? {} : { content: { 'application/json': { schema: entry.response } } }),
		},
	};
};

/**
 * The OpenAPI 3.1 document of a product.
 * @param {{ manifest: unknown, routes: readonly ScannedRoute[], api?: ApiDescription }} input `api`: the product's
 *   `schemas/api.json`
 * @returns {Record<string, unknown>}
 */
export const renderOpenapi = ({ manifest, routes, api = {} }) => {
	const { name, version, base, featureOf } = manifestFacts(manifest);
	/** @type {Map<string, Record<string, unknown>>} */
	const paths = new Map();
	const own = routes.filter((route) => Object.hasOwn(SCHEMES, route.auth));
	const ownKeys = new Set(own.map((route) => `${route.method} ${route.path}`));
	const kit = [...KIT_ROUTES, ...kitImportRoutesOf(manifest)].filter((route) => !ownKeys.has(`${route.method} ${route.path}`));
	const documented = [...own, ...kit];
	const descriptions = { ...entriesOf(KIT_API), ...entriesOf(api) };
	for (const route of documented) {
		const params = [...route.path.matchAll(/:([A-Za-z_][\w]*)/g)].map((match) => match[1] ?? '');
		const openPath = route.path.replace(/:([A-Za-z_][\w]*)/g, '{$1}');
		const scanned = /** @type {Partial<ScannedRoute>} */ (route);
		const feature = scanned.feature ?? (scanned.permission ? featureOf.get(scanned.permission) : undefined);
		const key = `${route.method} ${route.path}`;
		const entry = Object.hasOwn(descriptions, key) ? descriptions[key] : undefined;
		const operation = {
			...(entry?.summary ? { summary: entry.summary } : {}),
			...(entry?.description ? { description: entry.description } : {}),
			'x-ss-auth': route.auth,
			...(feature ? { 'x-ss-feature': feature } : {}),
			...(scanned.permission ? { 'x-ss-permission': scanned.permission } : {}),
			security: [{ [SCHEMES[/** @type {keyof typeof SCHEMES} */ (route.auth)]]: [] }],
			...(route.auth === 'browser' ? { security: [{ browserToken: [] }, { serverToken: [] }] } : {}),
			parameters: [
				...params.map((param) => ({ name: param, in: 'path', required: true, schema: { type: 'string' } })),
				...queryParameters(entry?.query),
				...queryParameters(entry?.headers, 'header'),
				...(scanned.idempotent
					? [
							{
								name: 'Idempotency-Key',
								in: 'header',
								required: false,
								description: IDEMPOTENCY_TEXT,
								schema: { type: 'string', maxLength: 255 },
							},
						]
					: []),
				...(route.auth === 'browser' ? [{ $ref: '#/components/parameters/SSVisitorIp' }] : []),
				...(route.auth === 'server' || route.auth === 'browser'
					? ACTOR_PARAMETERS.map((name) => ({ $ref: `#/components/parameters/${name}` }))
					: []),
			],
			...requestBody(entry?.body),
			responses: {
				...success(entry),
				default: {
					description: 'Problem (RFC 9457) with a stable code',
					content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
				},
			},
		};
		paths.set(openPath, { ...paths.get(openPath), [route.method.toLowerCase()]: operation });
	}
	return {
		openapi: '3.1.0',
		info: { title: `${name} API`, version },
		servers: [{ url: base }],
		paths: Object.fromEntries(
			[...paths.keys()].sort().map((key) => {
				const operations = /** @type {Record<string, unknown>} */ (paths.get(key));
				return [
					key,
					Object.fromEntries(
						Object.keys(operations)
							.sort()
							.map((method) => [method, operations[method]]),
					),
				];
			}),
		),
		components: {
			securitySchemes: {
				browserToken: {
					type: 'http',
					scheme: 'bearer',
					description: "The website's browser token: visitor routes, from https://<exact domain> or a local origin.",
				},
				serverToken: {
					type: 'http',
					scheme: 'bearer',
					description:
						"The website's server token: the merchant's server only, never with an Origin header. It also reaches every visitor route, acting for the visitor named by SS-Visitor-IP and, for a signed-in shopper, SS-Sign-In (their Accounts sign-in, checked for this website; a wrong, expired or foreign one is 401 invalid_sign_in).",
				},
				ticket: {
					type: 'http',
					scheme: 'bearer',
					description: 'A ticket from POST /v1/tickets: admin widgets, only from the origin it names.',
				},
			},
			parameters: {
				SSVisitorIp: {
					name: 'SS-Visitor-IP',
					in: 'header',
					required: false,
					description:
						"With the server token: the visitor's IP address (required on writes, else 400 visitor_ip_required). These calls count in their own window of 3,000 requests per minute per route per website, plus the per-visitor limits.",
					schema: { type: 'string', maxLength: 45 },
				},
				SSActorId: {
					name: 'SS-Actor-Id',
					in: 'header',
					required: false,
					description: 'With the server token: the member of your staff the call acts for (1–64 of A–Z a–z 0–9 _ . : @ -).',
					schema: { type: 'string', pattern: '^[A-Za-z0-9_.:@-]{1,64}$' },
				},
				SSActorName: {
					name: 'SS-Actor-Name',
					in: 'header',
					required: false,
					description: "The acting member's name, percent-encoded UTF-8, at most 120 characters (with SS-Actor-Id).",
					schema: { type: 'string' },
				},
				SSActorRole: {
					name: 'SS-Actor-Role',
					in: 'header',
					required: false,
					description: "The acting member's role, percent-encoded UTF-8, at most 40 characters.",
					schema: { type: 'string' },
				},
				SSActorEmail: {
					name: 'SS-Actor-Email',
					in: 'header',
					required: false,
					description: "The acting member's email address.",
					schema: { type: 'string', maxLength: 320 },
				},
			},
			schemas: Object.fromEntries(
				Object.entries({ ...sharedOf(KIT_API), ...sharedOf(api), Problem: PROBLEM }).sort(([a], [b]) => a.localeCompare(b)),
			),
		},
	};
};
