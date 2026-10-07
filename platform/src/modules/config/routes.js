/**
 * HTTP routes of the `config` module: merchant console (website subscriptions) and admin console (platform policies,
 * admin overrides, locks). Thin adapters over the service.
 * Admin writes (overrides, locks, rollbacks, platform policies) need the staff permission `platform.config.write`.
 * @module
 */
import { defineRoute, ok } from '../../infra/http.js';

/** @typedef {import('./service.js').ConfigService} ConfigService */
/** @typedef {import('../../infra/http.js').RequestContext} RequestContext */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */

const CONSOLE = /** @type {import('../../infra/http.js').AuthMode[]} */ (['merchant', 'staff']);
const SUB = '/v1/merchants/:merchantId/websites/:websiteId/subscriptions/:subscriptionId/config';
const ADMIN_SUB = '/v1/admin/subscriptions/:subscriptionId/config';
const PLATFORM = '/v1/admin/config/platform/:appId';

/**
 * Route parameters (every route declares the ones it reads).
 * @param {RequestContext} c
 */
const P = (c) =>
	/** @type {{ merchantId: string, websiteId: string, subscriptionId: string, appId: string }} */ (
		/** @type {unknown} */ (c.params)
	);

/** @param {RequestContext} c */
const meta = (c) => ({ actor: /** @type {Actor} */ (c.actor), requestId: c.requestId, ip: c.ip });

/** @param {RequestContext} c */
const subScope = (c) => ({ merchantId: P(c).merchantId, websiteId: P(c).websiteId });

/**
 * `{ reason, level, version, ...ops }` of a body; a non-object body is passed on as the change (and rejected there).
 * @param {unknown} body
 * @returns {{ reason?: unknown, level?: any, change: unknown, rest: Record<string, any> }}
 */
const split = (body) => {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) return { change: body, rest: {} };
	const { reason, level, ...change } = /** @type {Record<string, any>} */ (body);
	return { reason, level, change, rest: /** @type {Record<string, any>} */ (body) };
};

/** @param {RequestContext} c */
const pageOf = (c) => ({
	cursor: c.query.cursor ?? null,
	limit: c.query.limit === undefined ? 20 : /^\d{1,3}$/.test(c.query.limit) ? Number(c.query.limit) : 0,
});

/**
 * @param {ConfigService} service
 */
export const configRoutes = (service) => [
	// ---------------------------------------------------------------- website subscription (merchant console)
	defineRoute({
		method: 'GET',
		path: SUB,
		auth: CONSOLE,
		permission: 'config.read',
		handler: async (c) => ok(await service.overview({ subscriptionId: P(c).subscriptionId, scope: subScope(c) })),
	}),
	defineRoute({
		method: 'PATCH',
		path: SUB,
		auth: CONSOLE,
		permission: 'config.write',
		handler: async (c) => {
			const { reason, change } = split(c.body);
			return ok(
				await service.applyChange({
					target: { subscriptionId: P(c).subscriptionId },
					level: 'website',
					change,
					reason,
					scope: subScope(c),
					...meta(c),
				}),
			);
		},
	}),
	defineRoute({
		method: 'GET',
		path: `${SUB}/history`,
		auth: CONSOLE,
		permission: 'config.read',
		handler: async (c) =>
			ok(
				await service.history(
					{ subscriptionId: P(c).subscriptionId },
					{ level: 'website', ...pageOf(c), scope: subScope(c) },
				),
			),
	}),
	defineRoute({
		method: 'POST',
		path: `${SUB}/rollback`,
		auth: CONSOLE,
		permission: 'config.write',
		handler: async (c) => {
			const { reason, rest } = split(c.body);
			return ok(
				await service.rollback({
					target: { subscriptionId: P(c).subscriptionId },
					level: 'website',
					version: rest.version,
					reason,
					scope: subScope(c),
					...meta(c),
				}),
			);
		},
	}),
	defineRoute({
		method: 'POST',
		path: `${SUB}/preview`,
		auth: CONSOLE,
		permission: 'config.write',
		handler: async (c) => {
			const { level, rest } = split(c.body);
			return ok(
				await service.preview({
					subscriptionId: P(c).subscriptionId,
					change: rest.change,
					level: level ?? 'website',
					actor: /** @type {Actor} */ (c.actor),
					scope: subScope(c),
				}),
			);
		},
	}),
	// ---------------------------------------------------------------- admin: overrides and locks per subscription
	defineRoute({
		method: 'GET',
		path: ADMIN_SUB,
		auth: 'staff',
		permission: 'config.read',
		handler: async (c) => ok(await service.overview({ subscriptionId: P(c).subscriptionId })),
	}),
	defineRoute({
		method: 'PATCH',
		path: ADMIN_SUB,
		auth: 'staff',
		permission: 'platform.config.write',
		handler: async (c) => {
			const { reason, level, change } = split(c.body);
			return ok(
				await service.applyChange({
					target: { subscriptionId: P(c).subscriptionId },
					level: level ?? 'admin',
					change,
					reason,
					...meta(c),
				}),
			);
		},
	}),
	defineRoute({
		method: 'PUT',
		path: `${ADMIN_SUB}/locks`,
		auth: 'staff',
		permission: 'platform.config.write',
		handler: async (c) => {
			const { reason, level, rest } = split(c.body);
			return ok(
				await service.applyChange({
					target: { subscriptionId: P(c).subscriptionId },
					level: level ?? 'admin',
					change: {
						locks: {
							...(rest.elements === undefined ? {} : { elements: rest.elements }),
							...(rest.features === undefined ? {} : { features: rest.features }),
						},
					},
					reason,
					...meta(c),
				}),
			);
		},
	}),
	defineRoute({
		method: 'GET',
		path: `${ADMIN_SUB}/history`,
		auth: 'staff',
		permission: 'config.read',
		handler: async (c) =>
			ok(
				await service.history(
					{ subscriptionId: P(c).subscriptionId },
					{ level: c.query.level === 'website' ? 'website' : 'admin', ...pageOf(c) },
				),
			),
	}),
	defineRoute({
		method: 'POST',
		path: `${ADMIN_SUB}/rollback`,
		auth: 'staff',
		permission: 'platform.config.write',
		handler: async (c) => {
			const { reason, level, rest } = split(c.body);
			return ok(
				await service.rollback({
					target: { subscriptionId: P(c).subscriptionId },
					level: level === 'website' ? 'website' : 'admin',
					version: rest.version,
					reason,
					...meta(c),
				}),
			);
		},
	}),

	// ---------------------------------------------------------------- admin: platform policies (an app across merchants)
	defineRoute({
		method: 'GET',
		path: PLATFORM,
		auth: 'staff',
		permission: 'platform.apps.read',
		handler: async (c) => ok(await service.getLayer({ target: { appId: P(c).appId }, level: 'platform' })),
	}),
	defineRoute({
		method: 'PATCH',
		path: PLATFORM,
		auth: 'staff',
		permission: 'platform.config.write',
		handler: async (c) => {
			const { reason, change } = split(c.body);
			return ok(await service.applyChange({ target: { appId: P(c).appId }, level: 'platform', change, reason, ...meta(c) }));
		},
	}),
	defineRoute({
		method: 'GET',
		path: `${PLATFORM}/history`,
		auth: 'staff',
		permission: 'platform.apps.read',
		handler: async (c) => ok(await service.history({ appId: P(c).appId }, { level: 'platform', ...pageOf(c) })),
	}),
	defineRoute({
		method: 'POST',
		path: `${PLATFORM}/rollback`,
		auth: 'staff',
		permission: 'platform.config.write',
		handler: async (c) => {
			const { reason, rest } = split(c.body);
			return ok(
				await service.rollback({
					target: { appId: P(c).appId },
					level: 'platform',
					version: rest.version,
					reason,
					...meta(c),
				}),
			);
		},
	}),
];
