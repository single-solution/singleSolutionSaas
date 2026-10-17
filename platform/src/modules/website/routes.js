/**
 * HTTP routes of the `website` module: thin adapters from requests to the service.
 *
 * Console (merchant: own websites; Owner and Support: any; Finance: none):
 *   GET /v1/merchants/:merchantId/websites/:websiteId/settings · GET …/settings/changes ·
 *   PUT …/settings/:section { version, value }
 * Connections and links (Data and files; merchant: own websites; Owner and Support: any; Finance: none; every change
 * after a fresh confirmation of the person's password, and a code while two-step is on):
 *   GET …/connections · PUT …/connections/:name { value, password, … } · POST …/connections/:name/remove ·
 *   POST …/links/:callee/:caller/regenerate · POST …/links/:callee/:caller/switch { on }
 * Product (a client assertion; read only, only websites that have the product):
 *   GET /v1/product/websites/:websiteId/settings?since= · GET /v1/product/websites/:websiteId/connections ·
 *   PUT /v1/product/websites/:websiteId/connections/:name/health { version, ok, message? }
 * @module
 */
import { validateConnectionHealth } from '@ss/contracts';
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

/** The body of a connection save: the value, the confirmation and (an Owner) the product database names. */
const SAVE_CONNECTION_KEYS = new Set(['value', 'names', 'password', 'code', 'recoveryCode']);

/**
 * @param {unknown} body
 * @param {Set<string>} allowed
 * @returns {Record<string, unknown>}
 */
const objectBody = (body, allowed) => {
	const input =
		typeof body === 'object' && body !== null && !Array.isArray(body) ? /** @type {Record<string, unknown>} */ (body) : null;
	if (!input)
		throw problem('validation_failed', 'The request body is invalid.', {
			errors: [{ path: '', message: 'body must be a JSON object' }],
		});
	const errors = Object.keys(input)
		.filter((key) => !allowed.has(key))
		.map((key) => ({ path: `/${key}`, message: 'unknown property' }));
	if (errors.length > 0) throw problem('validation_failed', 'The request body is invalid.', { errors });
	return input;
};

/**
 * @param {WebsiteService} service
 * @param {() => any} identity the identity service (a fresh confirmation of the signed-in person)
 */
export const websiteRoutes = (service, identity) => {
	/**
	 * A fresh confirmation of the signed-in person, whoever the session is: a stolen session changes no connection.
	 * @param {RequestContext} c
	 * @param {Record<string, unknown>} body
	 */
	const confirm = (c, body) =>
		identity().confirmPerson({
			kind: c.authMode === 'admin' ? 'admin' : 'merchant',
			id: /** @type {import('../../infra/auth.js').Session} */ (c.session).subject,
			body,
			meta: { requestId: c.requestId, ip: c.ip },
		});
	/**
	 * The connections of the website as the console shows them (never a value), with whether this person may change them.
	 * @param {RequestContext} c
	 */
	const viewFor = async (c) => {
		const where = websiteOf(c);
		return {
			...(await service.connectionsView(where)),
			can: { write: can(/** @type {Actor} */ (c.actor), P.connectionsWrite, where) },
		};
	};
	/** @param {RequestContext} c */
	const audited = (c) => ({ actor: /** @type {Actor} */ (c.actor), requestId: c.requestId, ip: c.ip });
	return [
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
			path: '/v1/merchants/:merchantId/websites/:websiteId/connections',
			auth: ['merchant', 'admin'],
			permission: P.connectionsRead,
			rateLimit: { limit: 120, windowMs: 60_000 },
			handler: async (c) => ok(await viewFor(c)),
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/merchants/:merchantId/websites/:websiteId/connections/:name',
			auth: ['merchant', 'admin'],
			permission: P.connectionsWrite,
			idempotent: 'no-store',
			maxBodyBytes: 16 * 1024,
			rateLimit: { limit: 30, windowMs: 60_000 },
			handler: async (c) => {
				const body = objectBody(c.body, SAVE_CONNECTION_KEYS);
				if (!('value' in body))
					throw problem('validation_failed', 'The request body is invalid.', {
						errors: [{ path: '/value', message: 'is required' }],
					});
				await confirm(c, body);
				await service.saveConnection({
					...websiteOf(c),
					name: /** @type {string} */ (c.params.name),
					value: body.value,
					...('names' in body ? { names: body.names } : {}),
					...audited(c),
				});
				return ok(await viewFor(c));
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/merchants/:merchantId/websites/:websiteId/connections/:name/remove',
			auth: ['merchant', 'admin'],
			permission: P.connectionsWrite,
			idempotent: 'no-store',
			maxBodyBytes: 4 * 1024,
			rateLimit: { limit: 30, windowMs: 60_000 },
			handler: async (c) => {
				await confirm(c, objectBody(c.body, SAVE_CONNECTION_KEYS));
				await service.removeConnection({ ...websiteOf(c), name: /** @type {string} */ (c.params.name), ...audited(c) });
				return ok(await viewFor(c));
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/merchants/:merchantId/websites/:websiteId/links/:callee/:caller/regenerate',
			auth: ['merchant', 'admin'],
			permission: P.connectionsWrite,
			idempotent: 'no-store',
			maxBodyBytes: 4 * 1024,
			rateLimit: { limit: 30, windowMs: 60_000 },
			handler: async (c) => {
				await confirm(c, objectBody(c.body, SAVE_CONNECTION_KEYS));
				await service.regenerateLink({
					...websiteOf(c),
					callee: /** @type {string} */ (c.params.callee),
					caller: /** @type {string} */ (c.params.caller),
					...audited(c),
				});
				return ok(await viewFor(c));
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/merchants/:merchantId/websites/:websiteId/links/:callee/:caller/switch',
			auth: ['merchant', 'admin'],
			permission: P.connectionsWrite,
			idempotent: 'no-store',
			maxBodyBytes: 4 * 1024,
			rateLimit: { limit: 30, windowMs: 60_000 },
			handler: async (c) => {
				const body = objectBody(c.body, new Set([...SAVE_CONNECTION_KEYS, 'on']));
				if (typeof body.on !== 'boolean')
					throw problem('validation_failed', 'The request body is invalid.', {
						errors: [{ path: '/on', message: 'is on (true) or off (false)' }],
					});
				await confirm(c, body);
				await service.switchLink({
					...websiteOf(c),
					callee: /** @type {string} */ (c.params.callee),
					caller: /** @type {string} */ (c.params.caller),
					on: body.on,
					...audited(c),
				});
				return ok(await viewFor(c));
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/product/websites/:websiteId/connections',
			auth: 'product',
			rateLimit: { limit: 120, windowMs: 60_000 },
			handler: async (c) => {
				const productId = /** @type {{ productId: string }} */ (c.product).productId;
				const answer = await service.connectionsForProduct({
					productId,
					websiteId: /** @type {string} */ (c.params.websiteId),
				});
				return ok(answer, { headers: { 'cache-control': 'no-store' } });
			},
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/product/websites/:websiteId/connections/:name/health',
			auth: 'product',
			maxBodyBytes: 4 * 1024,
			rateLimit: { limit: 120, windowMs: 60_000 },
			handler: async (c) => {
				const checked = validateConnectionHealth(c.body);
				if (!checked.ok)
					throw problem('validation_failed', 'The health report is invalid.', {
						errors: checked.problems.map((p) => ({ path: p.path, message: p.message })),
					});
				const productId = /** @type {{ productId: string }} */ (c.product).productId;
				return ok(
					await service.reportConnectionHealth({
						productId,
						websiteId: /** @type {string} */ (c.params.websiteId),
						name: /** @type {string} */ (c.params.name),
						...checked.value,
					}),
				);
			},
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
};
