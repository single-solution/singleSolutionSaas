/**
 * `openapi.json` generated from the routes (PLAN 0.4.13): every browser-token, server-token and ticket route of the
 * product, plus the API routes the kit serves for every product (tickets, data rights and the permission list). Each operation names its
 * auth (`x-ss-auth`), its feature (`x-ss-feature`: one key, or a list when any of them is enough) and, for ticket routes, its permission (`x-ss-permission`).
 * Errors are RFC 9457 problems with a stable `code`.
 * @module
 */
import { isObject } from './fsutil.js';

/** @typedef {import('./routes.js').ScannedRoute} ScannedRoute */
/** @typedef {{ method: string, path: string, auth: string, idempotent?: boolean, summary: string }} KitRoute */

/** API routes the kit serves for every product (server token, no feature). */
export const KIT_API_ROUTES = Object.freeze(
	/** @type {KitRoute[]} */ ([
		{ method: 'POST', path: '/v1/tickets', auth: 'server', summary: 'Ticket for an admin widget (15 minutes)' },
		{ method: 'POST', path: '/v1/data-rights/export', auth: 'server', summary: "Export one user's records" },
		{ method: 'POST', path: '/v1/data-rights/delete', auth: 'server', summary: "Delete one user's records" },
		{ method: 'GET', path: '/v1/permissions', auth: 'server', summary: "This product's permissions (for Accounts roles)" },
	]),
);

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
			parameters: [
				...params.map((param) => ({ name: param, in: 'path', required: true, schema: { type: 'string' } })),
				...(route.idempotent
					? [{ name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', maxLength: 255 } }]
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
					description: "The website's server token: the merchant's server only, never with an Origin header.",
				},
				ticket: {
					type: 'http',
					scheme: 'bearer',
					description: 'A ticket from POST /v1/tickets: admin widgets, only from the origin it names.',
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
