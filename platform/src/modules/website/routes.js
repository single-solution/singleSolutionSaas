/**
 * HTTP routes of the `website` module: thin adapters from requests to the service.
 *
 * Console (merchant: own websites; Owner and Support: any; Finance: none):
 *   GET /v1/merchants/:merchantId/websites/:websiteId/settings · GET …/settings/changes ·
 *   PUT …/settings/:section { version, value }
 * Product (a client assertion; read only, only websites that have the product):
 *   GET /v1/product/websites/:websiteId/settings?since=
 * @module
 */
import { defineRoute, ok, problem } from '../../infra/http.js';
import { PERMISSIONS as P, can } from '../../infra/rbac.js';

/** @typedef {import('./service.js').WebsiteService} WebsiteService */
/** @typedef {import('../../infra/http.js').RequestContext} RequestContext */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */

/** The largest body a save takes (the document is at most 64 kB). */
const SAVE_BODY_BYTES = 96 * 1024;

/** @param {RequestContext} c */
const websiteOf = (c) => ({
	merchantId: /** @type {string} */ (c.params.merchantId),
	websiteId: /** @type {string} */ (c.params.websiteId),
});

/**
 * The body of a save: exactly `{ version, value }`, the version a whole number and the value an object.
 * @param {unknown} body
 * @returns {{ version: number, value: Record<string, unknown> }}
 */
export const parseSave = (body) => {
	/** @type {Array<{ path: string, message: string }>} */
	const errors = [];
	const input =
		typeof body === 'object' && body !== null && !Array.isArray(body) ? /** @type {Record<string, unknown>} */ (body) : null;
	if (!input) errors.push({ path: '', message: 'body must be a JSON object' });
	else {
		for (const key of Object.keys(input))
			if (key !== 'version' && key !== 'value') errors.push({ path: `/${key}`, message: 'unknown property' });
		if (!Number.isSafeInteger(input.version) || /** @type {number} */ (input.version) < 0)
			errors.push({ path: '/version', message: 'is the version you read (a whole number from 0)' });
		if (typeof input.value !== 'object' || input.value === null || Array.isArray(input.value))
			errors.push({ path: '/value', message: 'is the section as an object' });
	}
	if (errors.length > 0) throw problem('validation_failed', 'The request body is invalid.', { errors });
	return { version: /** @type {number} */ (input?.version), value: /** @type {Record<string, unknown>} */ (input?.value) };
};

/**
 * @param {WebsiteService} service
 */
export const websiteRoutes = (service) => [
	defineRoute({
		method: 'GET',
		path: '/v1/merchants/:merchantId/websites/:websiteId/settings',
		auth: ['merchant', 'admin'],
		permission: P.websiteSettingsRead,
		rateLimit: { limit: 120, windowMs: 60_000 },
		handler: async (c) => {
			const where = websiteOf(c);
			const answer = await service.get(where);
			return ok({ ...answer, can: { write: can(/** @type {Actor} */ (c.actor), P.websiteSettingsWrite, where) } });
		},
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/merchants/:merchantId/websites/:websiteId/settings/changes',
		auth: ['merchant', 'admin'],
		permission: P.websiteSettingsRead,
		rateLimit: { limit: 60, windowMs: 60_000 },
		handler: async (c) =>
			ok(
				await service.changes({
					...websiteOf(c),
					viewer: /** @type {Actor} */ (c.actor).type === 'admin' ? 'admin' : 'merchant',
				}),
			),
	}),
	defineRoute({
		method: 'PUT',
		path: '/v1/merchants/:merchantId/websites/:websiteId/settings/:section',
		auth: ['merchant', 'admin'],
		permission: P.websiteSettingsWrite,
		maxBodyBytes: SAVE_BODY_BYTES,
		rateLimit: { limit: 60, windowMs: 60_000 },
		handler: async (c) =>
			ok(
				await service.save({
					...websiteOf(c),
					section: /** @type {string} */ (c.params.section),
					...parseSave(c.body),
					actor: /** @type {Actor} */ (c.actor),
					requestId: c.requestId,
					ip: c.ip,
				}),
			),
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/product/websites/:websiteId/settings',
		auth: 'product',
		rateLimit: { limit: 600, windowMs: 60_000 },
		handler: async (c) => {
			const raw = c.query.since;
			const since = raw === undefined || raw === '' ? 0 : /^\d{1,15}$/.test(raw) ? Number(raw) : -1;
			if (since < 0) return problem('bad_request', 'since must be a whole number');
			const productId = /** @type {{ productId: string }} */ (c.product).productId;
			const answer = await service.forProduct({ productId, websiteId: /** @type {string} */ (c.params.websiteId), since });
			return ok(answer, { headers: { 'cache-control': 'no-store' } });
		},
	}),
];
