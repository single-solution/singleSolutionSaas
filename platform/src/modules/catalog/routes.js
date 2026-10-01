/**
 * HTTP routes of the `catalog` module: thin adapters from requests to the service.
 *
 * Public:   GET  /v1/catalog/products · GET /v1/catalog/products/:slug
 * Merchant: POST /v1/merchants/:merchantId/apps/:appId/launch
 * Staff:    /v1/admin/apps… (register, packs, list, detail, versions, refresh, review, lifecycle, environments, keys,
 *           launch)
 * Product:  POST /v1/product/heartbeat · /v1/product/keys/rotate · /v1/product/launch/consume (F.9)
 * @module
 */
import { created, defineRoute, ok, paginate, problem } from '../../infra/http.js';
import {
	parseConsume,
	parseEnvironments,
	parseLifecycle,
	parseMerchantLaunch,
	parseReason,
	parseRegistration,
	parseRotate,
	parseStaffLaunch,
} from './core/input.js';

/** @typedef {import('./service.js').CatalogService} CatalogService */
/** @typedef {import('../../infra/http.js').RequestContext} RequestContext */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */

/**
 * @template T
 * @param {import('./core/input.js').Parsed<T>} parsed
 * @returns {T}
 */
const valid = (parsed) => {
	if (!parsed.ok) throw problem('validation_failed', 'The request body is invalid.', { errors: parsed.errors });
	return parsed.value;
};

/** @param {RequestContext} ctx */
const audited = (ctx) => ({ actor: /** @type {Actor} */ (ctx.actor), requestId: ctx.requestId, ip: ctx.ip });

/** @param {string} value */
const versionParam = (value) => {
	if (!/^[1-9][0-9]{0,8}$/.test(value)) throw problem('not_found', 'No such version.');
	return Number(value);
};

const STATUSES = new Set(['pending', 'active', 'deprecated', 'retired']);

/**
 * @param {CatalogService} service
 * @param {{ commerce: () => any }} deps lazily resolved optional services
 */
export const catalogRoutes = (service, deps) => [
	// ---------------------------------------------------------------- public catalog
	defineRoute({
		method: 'GET',
		path: '/v1/catalog/products',
		auth: 'public',
		rateLimit: { limit: 120, windowMs: 60_000 },
		handler: async (ctx) => {
			const kind = ctx.query.kind;
			if (kind !== undefined && kind !== 'service' && kind !== 'pack')
				return problem('bad_request', 'kind must be service or pack');
			return ok(
				{ items: await service.activeProducts(kind ? { kind } : {}) },
				{ headers: { 'cache-control': 'public, max-age=60' } },
			);
		},
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/catalog/products/:slug',
		auth: 'public',
		rateLimit: { limit: 240, windowMs: 60_000 },
		handler: async (ctx) =>
			ok(await service.productDetail(ctx.params.slug ?? ''), { headers: { 'cache-control': 'public, max-age=60' } }),
	}),

	// ---------------------------------------------------------------- merchant launch
	defineRoute({
		method: 'POST',
		path: '/v1/merchants/:merchantId/apps/:appId/launch',
		auth: 'merchant',
		permission: 'subscriptions.read',
		resource: (ctx) => {
			const body = /** @type {any} */ (ctx.body);
			return {
				merchantId: ctx.params.merchantId ?? null,
				websiteId: typeof body?.websiteId === 'string' ? body.websiteId : null,
			};
		},
		idempotent: 'optional',
		rateLimit: { limit: 60, windowMs: 60_000 },
		handler: async (ctx) => {
			const { websiteId } = valid(parseMerchantLaunch(ctx.body));
			const actor = /** @type {Actor} */ (ctx.actor);
			const merchantId = /** @type {string} */ (ctx.params.merchantId);
			const appId = /** @type {string} */ (ctx.params.appId);
			const commerce = deps.commerce();
			/** @type {unknown[] | undefined} */
			let subscriptions;
			if (websiteId && commerce && typeof commerce.subscriptionsForWebsite === 'function') {
				const all = await commerce.subscriptionsForWebsite(websiteId);
				subscriptions = (Array.isArray(all) ? all : (all?.items ?? []))
					.filter((/** @type {any} */ s) => s?.appId === appId && s?.merchantId === merchantId)
					.map((/** @type {any} */ s) => ({ subscriptionId: s.subscriptionId, websiteId: s.websiteId, status: s.status }));
			}
			// a staff member impersonating this merchant user opens the product as an impersonation (audit banner)
			const via = actor.via?.id;
			const launch = await service.issueLaunch({
				kind: via ? 'impersonate' : 'merchant',
				appId,
				subject: actor.id,
				user: { id: actor.id, roles: [...(actor.roles ?? [])] },
				scope: { merchantId, ...(websiteId ? { websiteId } : {}) },
				...(subscriptions ? { subscriptions } : {}),
				...(via ? { actor: via } : {}),
				requestId: ctx.requestId,
				ip: ctx.ip,
			});
			return ok({ url: launch.url, expiresAt: launch.expiresAt });
		},
	}),

	// ---------------------------------------------------------------- staff
	defineRoute({
		method: 'POST',
		path: '/v1/admin/apps/register',
		auth: 'staff',
		permission: 'platform.apps.manage',
		rateLimit: { limit: 20, windowMs: 60_000 },
		handler: async (ctx) => created(await service.registerService({ ...valid(parseRegistration(ctx.body)), ...audited(ctx) })),
	}),
	defineRoute({
		method: 'POST',
		path: '/v1/admin/packs',
		auth: 'staff',
		permission: 'platform.apps.manage',
		maxBodyBytes: 1024 * 1024,
		rateLimit: { limit: 30, windowMs: 60_000 },
		handler: async (ctx) => {
			const result = await service.uploadPack({ body: ctx.body, ...audited(ctx) });
			return result.changed ? created(result) : ok(result);
		},
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/admin/apps',
		auth: 'staff',
		permission: 'platform.apps.read',
		handler: async (ctx) => {
			const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
			const status = ctx.query.status ? ctx.query.status.split(',') : undefined;
			if (status?.some((s) => !STATUSES.has(s)))
				return problem('bad_request', 'status must be pending, active, deprecated or retired');
			const kind = ctx.query.kind;
			if (kind !== undefined && kind !== 'service' && kind !== 'pack')
				return problem('bad_request', 'kind must be service or pack');
			const items = await service.listApps({
				...(status ? { status } : {}),
				...(kind ? { kind } : {}),
				after: typeof page.after === 'string' ? page.after : null,
				limit: page.fetchLimit,
			});
			return page.respond(items, (item) => item.appId);
		},
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/admin/apps/:appId',
		auth: 'staff',
		permission: 'platform.apps.read',
		handler: async (ctx) => ok(await service.appDetail(/** @type {string} */ (ctx.params.appId))),
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/admin/apps/:appId/versions',
		auth: 'staff',
		permission: 'platform.apps.read',
		handler: async (ctx) => {
			const page = paginate({ cursor: ctx.query.cursor, limit: ctx.query.limit, url: ctx.request.url });
			const items = await service.listVersions(/** @type {string} */ (ctx.params.appId), {
				before: typeof page.after === 'number' ? page.after : null,
				limit: page.fetchLimit,
			});
			return page.respond(items, (item) => item.version);
		},
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/admin/apps/:appId/versions/:version',
		auth: 'staff',
		permission: 'platform.apps.read',
		handler: async (ctx) =>
			ok(await service.versionDetail(/** @type {string} */ (ctx.params.appId), versionParam(ctx.params.version ?? ''))),
	}),
	defineRoute({
		method: 'POST',
		path: '/v1/admin/apps/:appId/refresh',
		auth: 'staff',
		permission: 'platform.apps.manage',
		rateLimit: { limit: 30, windowMs: 60_000 },
		handler: async (ctx) =>
			ok(await service.refreshManifest({ appId: /** @type {string} */ (ctx.params.appId), ...audited(ctx) })),
	}),
	defineRoute({
		method: 'POST',
		path: '/v1/admin/apps/:appId/versions/:version/approve',
		auth: 'staff',
		permission: 'platform.apps.review',
		handler: async (ctx) =>
			ok(
				await service.reviewVersion({
					appId: /** @type {string} */ (ctx.params.appId),
					version: versionParam(ctx.params.version ?? ''),
					action: 'approve',
					...valid(parseReason(ctx.body, { reasonRequired: false })),
					...audited(ctx),
				}),
			),
	}),
	defineRoute({
		method: 'POST',
		path: '/v1/admin/apps/:appId/versions/:version/reject',
		auth: 'staff',
		permission: 'platform.apps.review',
		handler: async (ctx) =>
			ok(
				await service.reviewVersion({
					appId: /** @type {string} */ (ctx.params.appId),
					version: versionParam(ctx.params.version ?? ''),
					action: 'reject',
					...valid(parseReason(ctx.body, { reasonRequired: true })),
					...audited(ctx),
				}),
			),
	}),
	defineRoute({
		method: 'POST',
		path: '/v1/admin/apps/:appId/lifecycle',
		auth: 'staff',
		permission: 'platform.apps.review',
		handler: async (ctx) =>
			ok(
				await service.setLifecycle({
					appId: /** @type {string} */ (ctx.params.appId),
					...valid(parseLifecycle(ctx.body)),
					...audited(ctx),
				}),
			),
	}),
	defineRoute({
		method: 'PUT',
		path: '/v1/admin/apps/:appId/environments',
		auth: 'staff',
		permission: 'platform.apps.manage',
		handler: async (ctx) =>
			ok(
				await service.setEnvironments({
					appId: /** @type {string} */ (ctx.params.appId),
					...valid(parseEnvironments(ctx.body)),
					...audited(ctx),
				}),
			),
	}),
	defineRoute({
		method: 'POST',
		path: '/v1/admin/apps/:appId/keys/:kid/revoke',
		auth: 'staff',
		permission: 'platform.apps.manage',
		handler: async (ctx) => {
			const { reason } = valid(parseReason(ctx.body, { reasonRequired: true }));
			return ok(
				await service.revokeKey({
					appId: /** @type {string} */ (ctx.params.appId),
					kid: /** @type {string} */ (ctx.params.kid),
					reason: /** @type {string} */ (reason),
					...audited(ctx),
				}),
			);
		},
	}),
	defineRoute({
		method: 'POST',
		path: '/v1/admin/apps/:appId/launch',
		auth: 'staff',
		permission: 'platform.launch.admin',
		idempotent: 'optional',
		rateLimit: { limit: 60, windowMs: 60_000 },
		handler: async (ctx) => {
			const input = valid(parseStaffLaunch(ctx.body));
			const actor = /** @type {Actor} */ (ctx.actor);
			if (input.kind === 'impersonate') ctx.authorize('platform.impersonate');
			if (input.kind === 'merchant') return problem('forbidden', 'Staff open products as admin or by impersonation.');
			const user = { id: actor.id, roles: [...(actor.roles ?? [])] };
			const impersonated = input.kind === 'impersonate';
			if (impersonated && !input.subject) return problem('validation_failed', 'subject (the impersonated user) is required.');
			const launch = await service.issueLaunch({
				kind: /** @type {any} */ (input.kind),
				appId: /** @type {string} */ (ctx.params.appId),
				subject: impersonated ? /** @type {string} */ (input.subject) : actor.id,
				user: impersonated ? { id: /** @type {string} */ (input.subject) } : user,
				scope: {
					...(input.merchantId ? { merchantId: input.merchantId } : {}),
					...(input.websiteId ? { websiteId: input.websiteId } : {}),
					...(input.partnerId ? { partnerId: input.partnerId } : {}),
					...(input.developerId ? { developerId: input.developerId } : {}),
				},
				actor: actor.id,
				...(input.impersonationSeconds === undefined ? {} : { impersonationSeconds: input.impersonationSeconds }),
				environment: input.environment,
				requestId: ctx.requestId,
				ip: ctx.ip,
			});
			return ok({ url: launch.url, expiresAt: launch.expiresAt });
		},
	}),

	// ---------------------------------------------------------------- product API (F.9)
	defineRoute({
		method: 'POST',
		path: '/v1/product/heartbeat',
		auth: 'product',
		idempotent: false,
		maxBodyBytes: 16 * 1024,
		rateLimit: { limit: 30, windowMs: 60_000 },
		handler: async (ctx) =>
			ok(await service.recordHeartbeat({ appId: /** @type {{ appId: string }} */ (ctx.app).appId, body: ctx.body })),
	}),
	defineRoute({
		method: 'POST',
		path: '/v1/product/keys/rotate',
		auth: 'product',
		idempotent: 'optional',
		maxBodyBytes: 16 * 1024,
		rateLimit: { limit: 10, windowMs: 60 * 60_000 },
		handler: async (ctx) =>
			ok(
				await service.rotateKey({
					appId: /** @type {{ appId: string }} */ (ctx.app).appId,
					...valid(parseRotate(ctx.body)),
					requestId: ctx.requestId,
				}),
			),
	}),
	defineRoute({
		method: 'POST',
		path: '/v1/product/launch/consume',
		auth: 'product',
		idempotent: false,
		maxBodyBytes: 4 * 1024,
		rateLimit: { limit: 600, windowMs: 60_000 },
		handler: async (ctx) =>
			ok(
				await service.consumeLaunch({
					appId: /** @type {{ appId: string }} */ (ctx.app).appId,
					...valid(parseConsume(ctx.body)),
				}),
			),
	}),
];
