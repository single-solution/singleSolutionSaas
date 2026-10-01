/**
 * HTTP routes of the `system` module: thin adapters from requests to the service.
 * @module
 */
import { defineRoute, ok, problem } from '../../infra/http.js';
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
];
