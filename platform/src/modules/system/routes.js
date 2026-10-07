/**
 * HTTP routes of the `system` module: thin adapters from requests to the service. Settings are Owner only; Activity
 * and Overview follow the rights table (PLAN 0.2).
 * @module
 */
import { defineRoute, ok, paginate, problem } from '../../infra/http.js';
import { PERMISSIONS as P } from '../../infra/rbac.js';
import { parseActivityQuery } from './activity.js';

/** @typedef {import('./service.js').SystemService} SystemService */
/** @typedef {import('../../infra/http.js').RequestContext} RequestContext */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */

/** @param {RequestContext} ctx */
const who = (ctx) => ({ actor: /** @type {Actor} */ (ctx.actor), requestId: ctx.requestId, ip: ctx.ip });

/**
 * One Activity page for a viewer.
 * @param {SystemService} service
 * @param {RequestContext} ctx
 * @param {{ type: 'admin' | 'merchant', merchantId?: string }} viewer
 * @param {{ merchantId?: string, actorId?: string }} [fixed] filters the route imposes
 */
const activityPage = async (service, ctx, viewer, fixed = {}) => {
	const checked = parseActivityQuery(/** @type {Record<string, string | undefined>} */ ({ ...ctx.query }));
	if (!checked.ok) return problem('validation_failed', 'The Activity filters are invalid.', { errors: checked.errors });
	const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url }, { defaultLimit: 50 });
	const after = page.after;
	const before =
		Array.isArray(after) && after.length === 2 && typeof after[0] === 'string' && typeof after[1] === 'string'
			? { at: after[0], id: after[1] }
			: null;
	const { items } = await service.activity.list({
		viewer,
		...(viewer.type === 'admin' ? checked.value : { from: checked.value.from, to: checked.value.to }),
		...fixed,
		before,
		limit: page.fetchLimit,
	});
	return page.respond(items, (e) => [e.at, e.activityId]);
};

/**
 * @param {SystemService} service
 */
export const systemRoutes = (service) => [
	// ---- public branding (sign-in page, consoles, product dashboards)
	defineRoute({
		method: 'GET',
		path: '/v1/branding',
		auth: 'public',
		rateLimit: { limit: 120, windowMs: 60_000 },
		handler: async () => ok(await service.publicBranding(), { headers: { 'cache-control': 'public, max-age=60' } }),
	}),
	defineRoute({
		method: 'GET',
		path: '/branding/logo',
		auth: 'public',
		handler: () => service.logoResponse(),
	}),
	// ---- Settings (Owner)
	defineRoute({
		method: 'GET',
		path: '/v1/admin/settings',
		auth: 'admin',
		permission: P.settingsPortalWrite,
		handler: async () => ok(await service.settings()),
	}),
	defineRoute({
		method: 'PUT',
		path: '/v1/admin/settings/mail',
		auth: 'admin',
		permission: P.settingsPortalWrite,
		handler: async (ctx) =>
			ok(await service.setMail({ mail: /** @type {Record<string, unknown>} */ (ctx.body ?? {}).mail ?? null, ...who(ctx) })),
	}),
	defineRoute({
		method: 'POST',
		path: '/v1/admin/settings/mail/test',
		auth: 'admin',
		permission: P.settingsPortalWrite,
		rateLimit: { limit: 10, windowMs: 60 * 60_000 },
		handler: async (ctx) => ok(await service.sendTestMail(who(ctx))),
	}),
	defineRoute({
		method: 'PUT',
		path: '/v1/admin/settings/branding',
		auth: 'admin',
		permission: P.settingsPortalWrite,
		handler: async (ctx) => ok(await service.setBranding({ body: ctx.body, ...who(ctx) })),
	}),
	defineRoute({
		method: 'PUT',
		path: '/v1/admin/settings/branding/logo',
		auth: 'admin',
		permission: P.settingsPortalWrite,
		maxBodyBytes: 400 * 1024,
		handler: async (ctx) => ok(await service.setLogo({ logo: ctx.body ?? null, ...who(ctx) })),
	}),
	defineRoute({
		method: 'DELETE',
		path: '/v1/admin/settings/branding/logo',
		auth: 'admin',
		permission: P.settingsPortalWrite,
		handler: async (ctx) => ok(await service.setLogo({ logo: null, ...who(ctx) })),
	}),
	defineRoute({
		method: 'PUT',
		path: '/v1/admin/settings/support',
		auth: 'admin',
		permission: P.settingsPortalWrite,
		handler: async (ctx) => ok(await service.setSupport({ body: ctx.body, ...who(ctx) })),
	}),
	defineRoute({
		method: 'PUT',
		path: '/v1/admin/settings/security',
		auth: 'admin',
		permission: P.settingsPortalWrite,
		handler: async (ctx) => ok(await service.setSecurity({ body: ctx.body, ...who(ctx) })),
	}),
	// ---- Overview and Activity
	defineRoute({
		method: 'GET',
		path: '/v1/admin/overview',
		auth: 'admin',
		permission: P.overviewRead,
		handler: async () => ok(await service.overview()),
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/admin/activity',
		auth: 'admin',
		permission: P.activityRead,
		handler: (ctx) => activityPage(service, ctx, { type: 'admin' }),
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/merchants/:merchantId/activity',
		auth: ['merchant', 'admin'],
		permission: P.activityRead,
		handler: (ctx) => {
			const actor = /** @type {Actor} */ (ctx.actor);
			const merchantId = /** @type {string} */ (ctx.params.merchantId);
			return actor.type === 'merchant'
				? activityPage(service, ctx, { type: 'merchant', merchantId })
				: activityPage(service, ctx, { type: 'admin' }, { merchantId });
		},
	}),
	defineRoute({
		// My account: the signed-in admin's own activity
		method: 'GET',
		path: '/v1/me/activity',
		auth: 'admin',
		handler: (ctx) => activityPage(service, ctx, { type: 'admin' }, { actorId: /** @type {Actor} */ (ctx.actor).id }),
	}),
];
