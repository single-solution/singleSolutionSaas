/**
 * HTTP routes of the `catalog` module: thin adapters from requests to the service.
 *
 * Public:   GET  /v1/catalog/products · GET /v1/catalog/products/:slug
 * Merchant: POST /v1/merchants/:merchantId/apps/:appId/launch
 * Staff:    POST /v1/admin/apps/connect (URL + connect secret) · POST /v1/admin/packs · GET /v1/admin/apps ·
 *           GET /v1/admin/apps/:appId · GET /v1/admin/apps/:appId/versions/:version · POST /v1/admin/apps/:appId/status · POST /v1/admin/apps/:appId/launch
 * Product:  POST /v1/product/launch/consume (F.9)
 * @module
 */
import { created, defineRoute, ok, paginate, problem } from '../../infra/http.js';
import { parseConsume, parseMerchantLaunch, parseStaffLaunch, parseStatus } from './core/input.js';

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

const STATUSES = new Set(['active', 'inactive']);

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
			const launch = await service.issueLaunch({
				kind: 'merchant',
				appId,
				subject: actor.id,
				user: { id: actor.id, roles: [...(actor.roles ?? [])] },
				scope: { merchantId, ...(websiteId ? { websiteId } : {}) },
				...(subscriptions ? { subscriptions } : {}),
				requestId: ctx.requestId,
				ip: ctx.ip,
			});
			return ok({ url: launch.url, expiresAt: launch.expiresAt });
		},
	}),

	// ---------------------------------------------------------------- staff
	defineRoute({
		method: 'POST',
		path: '/v1/admin/apps/connect',
		auth: 'staff',
		permission: 'platform.apps.manage',
		idempotent: true, // the stored response never carries the connect secret
		rateLimit: { limit: 20, windowMs: 60_000 },
		handler: async (ctx) => {
			const body = /** @type {Record<string, unknown>} */ (ctx.body ?? {});
			return created(await service.connectProduct({ url: body.url, secret: body.secret, ...audited(ctx) }));
		},
	}),
	defineRoute({
		method: 'POST',
		path: '/v1/admin/packs',
		auth: 'staff',
		permission: 'platform.apps.manage',
		idempotent: true,
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
			if (status?.some((s) => !STATUSES.has(s))) return problem('bad_request', 'status must be active or inactive');
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
		path: '/v1/admin/apps/:appId/versions/:version',
		auth: 'staff',
		permission: 'platform.apps.read',
		handler: async (ctx) => {
			const version = Number(ctx.params.version);
			if (!Number.isSafeInteger(version) || version < 1)
				throw problem('not_found', `No version ${String(ctx.params.version)}.`);
			return ok(await service.versionDetail(/** @type {string} */ (ctx.params.appId), version));
		},
	}),
	defineRoute({
		method: 'POST',
		path: '/v1/admin/apps/:appId/status',
		auth: 'staff',
		permission: 'platform.apps.manage',
		handler: async (ctx) =>
			ok(
				await service.setStatus({
					appId: /** @type {string} */ (ctx.params.appId),
					...valid(parseStatus(ctx.body)),
					...audited(ctx),
				}),
			),
	}),
	defineRoute({
		method: 'POST',
		path: '/v1/admin/apps/:appId/launch',
		auth: 'staff',
		permission: 'platform.launch.admin',
		rateLimit: { limit: 60, windowMs: 60_000 },
		handler: async (ctx) => {
			const input = valid(parseStaffLaunch(ctx.body));
			const actor = /** @type {Actor} */ (ctx.actor);
			// app-wide admin launches (scope.all) need platform.launch.admin AND the superadmin or admin staff role
			if (input.all && !(actor.roles ?? []).some((role) => role === 'superadmin' || role === 'admin'))
				return problem('forbidden', 'App-wide admin launches need the superadmin or admin role.');
			const launch = await service.issueLaunch({
				kind: 'admin',
				appId: /** @type {string} */ (ctx.params.appId),
				subject: actor.id,
				user: { id: actor.id, roles: [...(actor.roles ?? [])] },
				scope: {
					...(input.all ? { all: /** @type {const} */ (true) } : {}),
					...(input.merchantId ? { merchantId: input.merchantId } : {}),
					...(input.websiteId ? { websiteId: input.websiteId } : {}),
				},
				actor: actor.id,
				requestId: ctx.requestId,
				ip: ctx.ip,
			});
			return ok({ url: launch.url, expiresAt: launch.expiresAt });
		},
	}),

	// ---------------------------------------------------------------- product API (F.9)
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
