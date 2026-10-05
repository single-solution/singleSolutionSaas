/**
 * HTTP routes of the `config` module: merchant console (website subscriptions, merchant-wide app defaults,
 * templates) and admin console (platform policies, admin overrides, locks). Thin adapters over the service.
 * Admin writes (overrides, locks, rollbacks, platform policies) need the staff permission `platform.config.write`.
 * @module
 */
import { created, defineRoute, ok } from '../../infra/http.js';

/** @typedef {import('./service.js').ConfigService} ConfigService */
/** @typedef {import('../../infra/http.js').RequestContext} RequestContext */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */

const CONSOLE = /** @type {import('../../infra/http.js').AuthMode[]} */ (['merchant', 'staff']);
const SUB = '/v1/merchants/:merchantId/websites/:websiteId/subscriptions/:subscriptionId/config';
const MERCHANT_APP = '/v1/merchants/:merchantId/apps/:appId/config';
const TEMPLATES = '/v1/merchants/:merchantId/config/templates';
const ADMIN_SUB = '/v1/admin/subscriptions/:subscriptionId/config';
const PLATFORM = '/v1/admin/config/platform/:appId';

/**
 * Route parameters (every route declares the ones it reads).
 * @param {RequestContext} c
 */
const P = (c) =>
	/** @type {{ merchantId: string, websiteId: string, subscriptionId: string, appId: string, templateId: string, scheduleId: string, experimentId: string }} */ (
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
 * Per-website write check for template application (website-scoped grants).
 * @param {RequestContext} c
 */
const canWriteWebsite = (c) => (/** @type {string} */ websiteId) => {
	try {
		c.authorize('config.write', { merchantId: P(c).merchantId, websiteId });
		return true;
	} catch {
		return false;
	}
};

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
		idempotent: false,
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
	defineRoute({
		method: 'GET',
		path: `${SUB}/schedules`,
		auth: CONSOLE,
		permission: 'config.read',
		handler: async (c) =>
			ok(
				await service.listSchedules({
					target: { subscriptionId: P(c).subscriptionId },
					level: 'website',
					scope: subScope(c),
				}),
			),
	}),
	defineRoute({
		method: 'POST',
		path: `${SUB}/schedules`,
		auth: CONSOLE,
		permission: 'config.write',
		handler: async (c) => {
			const { reason, rest } = split(c.body);
			const change = typeof rest.change === 'object' && rest.change !== null ? rest.change : {};
			return created(
				await service.schedule({
					change: { ...change, target: { subscriptionId: P(c).subscriptionId }, level: 'website', reason },
					at: rest.at,
					scope: subScope(c),
					...meta(c),
				}),
			);
		},
	}),
	defineRoute({
		method: 'DELETE',
		path: `${SUB}/schedules/:scheduleId`,
		auth: CONSOLE,
		permission: 'config.write',
		handler: async (c) =>
			ok(
				await service.cancelSchedule({
					merchantId: P(c).merchantId,
					scheduleId: P(c).scheduleId,
					scope: subScope(c),
					...meta(c),
				}),
			),
	}),
	defineRoute({
		method: 'GET',
		path: `${SUB}/experiments`,
		auth: CONSOLE,
		permission: 'config.read',
		handler: async (c) => ok(await service.listExperiments({ subscriptionId: P(c).subscriptionId, scope: subScope(c) })),
	}),
	defineRoute({
		method: 'POST',
		path: `${SUB}/experiments`,
		auth: CONSOLE,
		permission: 'config.write',
		handler: async (c) =>
			created(
				await service.createExperiment({
					subscriptionId: P(c).subscriptionId,
					experiment: c.body,
					scope: subScope(c),
					...meta(c),
				}),
			),
	}),
	defineRoute({
		method: 'POST',
		path: `${SUB}/experiments/:experimentId/start`,
		auth: CONSOLE,
		permission: 'config.write',
		handler: async (c) =>
			ok(
				await service.startExperiment({
					subscriptionId: P(c).subscriptionId,
					experimentId: P(c).experimentId,
					scope: subScope(c),
					...meta(c),
				}),
			),
	}),
	defineRoute({
		method: 'POST',
		path: `${SUB}/experiments/:experimentId/stop`,
		auth: CONSOLE,
		permission: 'config.write',
		handler: async (c) =>
			ok(
				await service.stopExperiment({
					subscriptionId: P(c).subscriptionId,
					experimentId: P(c).experimentId,
					applyVariant: split(c.body).rest.applyVariant,
					scope: subScope(c),
					...meta(c),
				}),
			),
	}),

	// ---------------------------------------------------------------- merchant-wide defaults for an app
	defineRoute({
		method: 'GET',
		path: MERCHANT_APP,
		auth: CONSOLE,
		permission: 'config.read',
		handler: async (c) =>
			ok(await service.getLayer({ target: { merchantId: P(c).merchantId, appId: P(c).appId }, level: 'merchant' })),
	}),
	defineRoute({
		method: 'PATCH',
		path: MERCHANT_APP,
		auth: CONSOLE,
		permission: 'config.write',
		handler: async (c) => {
			const { reason, change } = split(c.body);
			return ok(
				await service.applyChange({
					target: { merchantId: P(c).merchantId, appId: P(c).appId },
					level: 'merchant',
					change,
					reason,
					...meta(c),
				}),
			);
		},
	}),
	defineRoute({
		method: 'GET',
		path: `${MERCHANT_APP}/history`,
		auth: CONSOLE,
		permission: 'config.read',
		handler: async (c) =>
			ok(await service.history({ merchantId: P(c).merchantId, appId: P(c).appId }, { level: 'merchant', ...pageOf(c) })),
	}),
	defineRoute({
		method: 'POST',
		path: `${MERCHANT_APP}/rollback`,
		auth: CONSOLE,
		permission: 'config.write',
		handler: async (c) => {
			const { reason, rest } = split(c.body);
			return ok(
				await service.rollback({
					target: { merchantId: P(c).merchantId, appId: P(c).appId },
					level: 'merchant',
					version: rest.version,
					reason,
					...meta(c),
				}),
			);
		},
	}),

	// ---------------------------------------------------------------- templates
	defineRoute({
		method: 'GET',
		path: TEMPLATES,
		auth: CONSOLE,
		permission: 'config.read',
		handler: async (c) => ok(await service.listTemplates({ merchantId: P(c).merchantId, appId: c.query.appId ?? null })),
	}),
	defineRoute({
		method: 'POST',
		path: TEMPLATES,
		auth: CONSOLE,
		permission: 'config.write',
		handler: async (c) => {
			const { rest } = split(c.body);
			return created(
				await service.saveTemplate({
					merchantId: P(c).merchantId,
					appId: rest.appId,
					name: rest.name,
					settings: rest.settings,
					...meta(c),
				}),
			);
		},
	}),
	defineRoute({
		method: 'GET',
		path: `${TEMPLATES}/:templateId`,
		auth: CONSOLE,
		permission: 'config.read',
		handler: async (c) => ok(await service.getTemplate({ merchantId: P(c).merchantId, templateId: P(c).templateId })),
	}),
	defineRoute({
		method: 'PUT',
		path: `${TEMPLATES}/:templateId`,
		auth: CONSOLE,
		permission: 'config.write',
		handler: async (c) => {
			const { rest } = split(c.body);
			return ok(
				await service.updateTemplate({
					merchantId: P(c).merchantId,
					templateId: P(c).templateId,
					name: rest.name,
					settings: rest.settings,
					version: rest.version,
					...meta(c),
				}),
			);
		},
	}),
	defineRoute({
		method: 'POST',
		path: `${TEMPLATES}/:templateId/apply`,
		auth: CONSOLE,
		permission: 'config.write',
		handler: async (c) =>
			ok(
				await service.applyTemplate({
					merchantId: P(c).merchantId,
					templateId: P(c).templateId,
					websiteIds: split(c.body).rest.websiteIds,
					canWrite: canWriteWebsite(c),
					...meta(c),
				}),
			),
	}),
	defineRoute({
		method: 'POST',
		path: `${TEMPLATES}/:templateId/push`,
		auth: CONSOLE,
		permission: 'config.write',
		handler: async (c) =>
			ok(
				await service.pushTemplate({
					merchantId: P(c).merchantId,
					templateId: P(c).templateId,
					all: split(c.body).rest.all === true,
					canWrite: canWriteWebsite(c),
					...meta(c),
				}),
			),
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
			const lvl = level ?? 'admin';
			const target =
				lvl === 'merchant' ? await merchantTargetOf(service, P(c).subscriptionId) : { subscriptionId: P(c).subscriptionId };
			return ok(
				await service.applyChange({
					target,
					level: lvl,
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

/**
 * The merchant/app target of a subscription (staff locks on merchant-wide defaults).
 * @param {ConfigService} service
 * @param {string} subscriptionId
 */
const merchantTargetOf = async (service, subscriptionId) => {
	const { merchantId, appId } = await service.describeSubscription(subscriptionId);
	return { merchantId, appId };
};
