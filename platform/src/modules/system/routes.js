/**
 * HTTP routes of the `system` module: thin adapters from requests to the service.
 * @module
 */
import { defineRoute, ok, paginate, problem } from '../../infra/http.js';
import { AUDIT_SCOPE, parseAuditQuery } from './ops.js';
import { validateNotice } from './core/info.js';

/** @typedef {import('./service.js').SystemService} SystemService */

/**
 * @param {SystemService} service
 */
export const systemRoutes = (service) => [
	defineRoute({
		method: 'GET',
		path: '/v1/system/info',
		auth: 'public',
		rateLimit: { limit: 120, windowMs: 60_000 },
		handler: async () => ok(await service.info(), { headers: { 'cache-control': 'public, max-age=30' } }),
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/system/whoami',
		auth: ['staff', 'merchant', 'product', 'websiteKey'],
		handler: (ctx) =>
			ok({
				authMode: ctx.authMode,
				actor: ctx.actor,
				...(ctx.session
					? {
							session: {
								id: ctx.session.id,
								kind: ctx.session.kind,
								mfa: ctx.session.mfa,
								expiresAt: ctx.session.expiresAt,
							},
						}
					: {}),
				...(ctx.website
					? {
							website: {
								websiteId: ctx.website.websiteId,
								kind: ctx.website.kind,
								env: ctx.website.env,
								scopes: ctx.website.scopes,
							},
						}
					: {}),
			}),
	}),
	defineRoute({
		method: 'PUT',
		path: '/v1/system/notice',
		auth: 'staff',
		permission: 'platform.settings.write',
		handler: async (ctx) => {
			const checked = validateNotice(ctx.body);
			if (!checked.ok) return problem('validation_failed', 'The notice is invalid.', { errors: checked.errors });
			const actor = /** @type {import('../../infra/rbac.js').Actor} */ (ctx.actor);
			return ok({ notice: await service.setNotice({ notice: checked.value, actor, requestId: ctx.requestId, ip: ctx.ip }) });
		},
	}),
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
		path: '/v1/admin/system/health',
		auth: 'staff',
		permission: 'platform.jobs.read',
		handler: async () => ok(await service.health()),
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
	defineRoute({
		method: 'GET',
		path: '/v1/admin/audit/verification',
		auth: 'staff',
		permission: 'platform.audit.read',
		rateLimit: { limit: 10, windowMs: 60_000 },
		handler: async (ctx) => {
			const scope = ctx.query.scope ?? '';
			if (!AUDIT_SCOPE.test(scope)) return problem('bad_request', 'scope must be global or merchant:<merchantId>');
			return ok(await service.verifyAudit(scope));
		},
	}),
];
