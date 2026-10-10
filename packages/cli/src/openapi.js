/**
 * `openapi.json` generated from the routes (PLAN 0.4.13): every browser-token, server-token and ticket route of the
 * product, plus the API routes the kit serves for every product (tickets, data rights, the permission list, the
 * settings API and the activity log, PLAN 0.8.10 K1, K9). Each operation names its auth (`x-ss-auth`), its feature
 * (`x-ss-feature`: one key, or a list when any of them is enough) and, for ticket routes, its permission
 * (`x-ss-permission`). Server-token operations take the optional `SS-Actor-*` headers (K2); visitor (browser-token)
 * operations also take the server token with `SS-Visitor-IP` (K3). Errors are RFC 9457 problems with a stable `code`.
 * @module
 */
import { isObject } from './fsutil.js';

/** @typedef {import('./routes.js').ScannedRoute} ScannedRoute */
/** @typedef {{ method: string, path: string, auth: string, idempotent?: boolean, summary: string }} KitRoute */

/** API routes the kit serves for every product (server token, no feature). */
const KIT_API_ROUTES = Object.freeze(
	/** @type {KitRoute[]} */ ([
		{ method: 'POST', path: '/v1/tickets', auth: 'server', summary: 'Ticket for an admin widget (15 minutes)' },
		{ method: 'POST', path: '/v1/data-rights/export', auth: 'server', summary: "Export one user's records" },
		{ method: 'POST', path: '/v1/data-rights/delete', auth: 'server', summary: "Delete one user's records" },
		{ method: 'GET', path: '/v1/permissions', auth: 'server', summary: "This product's permissions (for Accounts roles)" },
		{ method: 'GET', path: '/v1/features', auth: 'server', summary: 'Features with on/off and hourly price' },
		{ method: 'GET', path: '/v1/settings', auth: 'server', summary: 'Settings schemas, and values of switched-on features' },
		{ method: 'PUT', path: '/v1/settings/:key', auth: 'server', summary: 'Save one setting (<feature>.<setting>, { value })' },
		{ method: 'DELETE', path: '/v1/settings/:key', auth: 'server', summary: 'Reset one setting to the default' },
		{ method: 'GET', path: '/v1/texts', auth: 'server', summary: 'Widget texts' },
		{ method: 'PUT', path: '/v1/texts/:key', auth: 'server', summary: 'Save one widget text ({ value })' },
		{ method: 'DELETE', path: '/v1/texts/:key', auth: 'server', summary: 'Reset one widget text to English' },
		{ method: 'GET', path: '/v1/theme', auth: 'server', summary: "The widgets' theme" },
		{ method: 'PUT', path: '/v1/theme', auth: 'server', summary: 'Save theme fields (null resets one)' },
		{ method: 'GET', path: '/v1/format', auth: 'server', summary: 'The Format of money and dates' },
		{ method: 'PUT', path: '/v1/format', auth: 'server', summary: 'Save Format fields (null resets one)' },
		{ method: 'GET', path: '/v1/lists/:list', auth: 'server', summary: 'A list setting ({ value })' },
		{ method: 'PUT', path: '/v1/lists/:list', auth: 'server', summary: 'Save a whole list setting ({ value })' },
		{ method: 'GET', path: '/v1/connections', auth: 'server', summary: 'Connections (state and last 4 characters only)' },
		{ method: 'PUT', path: '/v1/connections/:name', auth: 'server', summary: 'Save a connection ({ value }), tested live' },
		{ method: 'DELETE', path: '/v1/connections/:name', auth: 'server', summary: 'Remove a connection' },
		{ method: 'POST', path: '/v1/connections/:name/test', auth: 'server', summary: 'Test a connection again' },
		{ method: 'GET', path: '/v1/activity', auth: 'server', summary: 'The activity log, newest first' },
		{ method: 'GET', path: '/v1/activity/count', auth: 'server', summary: 'Count the activity log' },
		{ method: 'GET', path: '/v1/activity/counts', auth: 'server', summary: 'Count the activity log by action, actor or kind' },
	]),
);

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
 * The OpenAPI 3.1 document of a product.
 * @param {{ manifest: unknown, routes: readonly ScannedRoute[] }} input
 * @returns {Record<string, unknown>}
 */
export const renderOpenapi = ({ manifest, routes }) => {
	const { name, version, base, featureOf } = manifestFacts(manifest);
	/** @type {Map<string, Record<string, unknown>>} */
	const paths = new Map();
	const documented = [...routes.filter((route) => Object.hasOwn(SCHEMES, route.auth)), ...KIT_API_ROUTES];
	for (const route of documented) {
		const params = [...route.path.matchAll(/:([A-Za-z_][\w]*)/g)].map((match) => match[1] ?? '');
		const openPath = route.path.replace(/:([A-Za-z_][\w]*)/g, '{$1}');
		const scanned = /** @type {Partial<ScannedRoute>} */ (route);
		const feature = scanned.feature ?? (scanned.permission ? featureOf.get(scanned.permission) : undefined);
		const summary = /** @type {Partial<KitRoute>} */ (route).summary;
		const operation = {
			...(summary ? { summary } : {}),
			'x-ss-auth': route.auth,
			...(feature ? { 'x-ss-feature': feature } : {}),
			...(scanned.permission ? { 'x-ss-permission': scanned.permission } : {}),
			security: [{ [SCHEMES[/** @type {keyof typeof SCHEMES} */ (route.auth)]]: [] }],
			...(route.auth === 'browser' ? { security: [{ browserToken: [] }, { serverToken: [] }] } : {}),
			parameters: [
				...params.map((param) => ({ name: param, in: 'path', required: true, schema: { type: 'string' } })),
				...(route.idempotent
					? [{ name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', maxLength: 255 } }]
					: []),
				...(route.auth === 'browser' ? [{ $ref: '#/components/parameters/SSVisitorIp' }] : []),
				...(route.auth === 'server' || route.auth === 'browser'
					? ACTOR_PARAMETERS.map((name) => ({ $ref: `#/components/parameters/${name}` }))
					: []),
			],
			responses: {
				'2XX': { description: 'Success (JSON)' },
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
						"The website's server token: the merchant's server only, never with an Origin header. It also reaches every visitor route, acting for the visitor named by SS-Visitor-IP (and SS-Sign-In).",
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
					description: "The acting member's e-mail address.",
					schema: { type: 'string', maxLength: 320 },
				},
			},
			schemas: {
				Problem: {
					type: 'object',
					required: ['type', 'title', 'status'],
					properties: {
						type: { type: 'string' },
						title: { type: 'string' },
						status: { type: 'integer' },
						code: { type: 'string' },
						detail: { type: 'string' },
					},
				},
			},
		},
	};
};
