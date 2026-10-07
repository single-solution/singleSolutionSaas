/**
 * HTTP routes of the `system` module: thin adapters from requests to the service.
 * @module
 */
import { defineRoute, ok, paginate, problem } from '../../infra/http.js';
import { parseAuditQuery } from './ops.js';

/** @typedef {import('./service.js').SystemService} SystemService */

/**
 * @param {SystemService} service
 */
export const systemRoutes = (service) => [
	defineRoute({
		method: 'GET',
		path: '/v1/admin/system/settings',
		auth: 'staff',
		permission: 'platform.settings.write',
		handler: async () => ok(await service.settings()),
	}),
	defineRoute({
		method: 'PUT',
		path: '/v1/admin/system/settings/mail',
		auth: 'staff',
		permission: 'platform.settings.write',
		handler: async (ctx) =>
			ok(
				await service.setMail({
					mail: /** @type {Record<string, unknown>} */ (ctx.body ?? {}).mail ?? null,
					actor: /** @type {import('../../infra/rbac.js').Actor} */ (ctx.actor),
					requestId: ctx.requestId,
					ip: ctx.ip,
				}),
			),
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/admin/audit',
		auth: 'staff',
		permission: 'platform.audit.read',
		handler: async (ctx) => {
			const checked = parseAuditQuery(/** @type {Record<string, string | undefined>} */ ({ ...ctx.query }));
			if (!checked.ok) return problem('validation_failed', 'The audit query is invalid.', { errors: checked.errors });
			const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 50 });
			const after = page.after;
			const before =
				Array.isArray(after) && after.length === 2 && typeof after[0] === 'string' && typeof after[1] === 'string'
					? { at: after[0], id: after[1] }
					: null;
			const items = await service.auditEntries({ ...checked.value, before, limit: page.fetchLimit });
			return page.respond(items, (e) => [e.at, e.auditId]);
		},
	}),
];
