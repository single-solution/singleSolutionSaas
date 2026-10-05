/**
 * HTTP routes of the `connectors` module: thin adapters to the service.
 *
 * - Merchant console (`auth: 'merchant'`, permissions `connectors.read` / `connectors.manage`): CRUD, test, rotate,
 *   rollback, revoke, assign, website resource status. Staff reach these only by impersonation (audited `via`).
 * - Admin console (`auth: 'staff'`, `platform.merchants.read`): list and status only — never previews or secrets.
 * - Product API (`auth: 'product'`): `POST /v1/product/resources/resolve` (F.9), rate limited per app + website.
 *
 * Routes whose bodies carry credentials (create, rotate) use `idempotent: 'no-store'`: the store keeps only the
 * status and an HMAC fingerprint, so a retry with the same key answers 409 `idempotency_replay_no_body` instead of
 * running twice. The resolve route, whose response carries credentials, is not idempotency-recorded.
 * @module
 */
import { created, defineRoute, noContent, ok, paginate, problem } from '../../infra/http.js';
import { isObject } from '../../infra/util.js';

/** @typedef {import('./service.js').ConnectorsService} ConnectorsService */
/** @typedef {import('../../infra/http.js').RequestContext} RequestContext */

const BASE = '/v1/merchants/:merchantId/connectors';
const ONE = `${BASE}/:connectorId`;
const KIND = /^[a-z]{2,16}$/;
const STATUS = /^(connected|missing|failing|revoked)$/;

/** @param {RequestContext} ctx */
const caller = (ctx) => ({
	actor: /** @type {import('../../infra/rbac.js').Actor} */ (ctx.actor),
	requestId: ctx.requestId,
	ip: ctx.ip,
});
/** @param {RequestContext} ctx */
const body = (ctx) => {
	if (!isObject(ctx.body)) throw problem('bad_request', 'Send a JSON object.');
	return /** @type {Record<string, unknown>} */ (ctx.body);
};
/**
 * @param {RequestContext} ctx
 * @param {string} name
 * @param {RegExp} pattern
 */
const filter = (ctx, name, pattern) => {
	const value = ctx.query[name];
	if (value === undefined || value === '') return undefined;
	if (!pattern.test(value)) throw problem('bad_request', `${name} is invalid`);
	return value;
};
/** @param {{ createdAt: string | null, connectorId: string }} item */
const keyOf = (item) => [Date.parse(String(item.createdAt)), item.connectorId];

/**
 * Rate-limit key for resolve: app + website from the raw body (the JSON body is parsed after the limiter).
 * @param {RequestContext} ctx
 */
const resolveKey = (ctx) => {
	let websiteId = 'unknown';
	try {
		const parsed = JSON.parse(ctx.rawBody);
		if (isObject(parsed) && typeof parsed.websiteId === 'string' && /^web_[0-9a-z]{10,64}$/.test(parsed.websiteId))
			websiteId = parsed.websiteId;
	} catch {
		// counted under "unknown"
	}
	return `app:${ctx.app?.appId ?? 'none'}|${websiteId}`;
};

/**
 * @param {ConnectorsService} service
 */
export const connectorsRoutes = (service) => [
	defineRoute({
		method: 'GET',
		path: BASE,
		auth: 'merchant',
		permission: 'connectors.read',
		handler: async (ctx) => {
			const page = paginate({ cursor: ctx.query.cursor ?? null, limit: ctx.query.limit ?? null, url: ctx.request.url });
			const items = await service.list({
				merchantId: ctx.params.merchantId ?? '',
				kind: filter(ctx, 'kind', KIND),
				status: filter(ctx, 'status', STATUS),
				websiteId: filter(ctx, 'websiteId', /^web_[0-9a-z]{10,64}$/),
				after: page.after,
				limit: page.fetchLimit,
			});
			return page.respond(items, keyOf);
		},
	}),
	defineRoute({
		method: 'POST',
		path: BASE,
		auth: 'merchant',
		permission: 'connectors.manage',
		idempotent: 'no-store',
		maxBodyBytes: 64 * 1024,
		rateLimit: { limit: 30, windowMs: 60_000 },
		handler: async (ctx) => {
			const b = body(ctx);
			const result = await service.create({
				merchantId: ctx.params.merchantId ?? '',
				kind: b.kind,
				provider: b.provider,
				label: b.label,
				credentials: b.credentials,
				websiteIds: b.websiteIds,
				...caller(ctx),
			});
			return created(result, {
				location: `/v1/merchants/${ctx.params.merchantId}/connectors/${result.connector.connectorId}`,
			});
		},
	}),
	defineRoute({
		method: 'GET',
		path: ONE,
		auth: 'merchant',
		permission: 'connectors.read',
		handler: async (ctx) =>
			ok({
				connector: await service.get({ merchantId: ctx.params.merchantId ?? '', connectorId: ctx.params.connectorId ?? '' }),
			}),
	}),
	defineRoute({
		method: 'PATCH',
		path: ONE,
		auth: 'merchant',
		permission: 'connectors.manage',
		handler: async (ctx) =>
			ok(
				await service.update({
					merchantId: ctx.params.merchantId ?? '',
					connectorId: ctx.params.connectorId ?? '',
					label: body(ctx).label,
					...caller(ctx),
				}),
			),
	}),
	defineRoute({
		method: 'DELETE',
		path: ONE,
		auth: 'merchant',
		permission: 'connectors.manage',
		handler: async (ctx) => {
			await service.remove({
				merchantId: ctx.params.merchantId ?? '',
				connectorId: ctx.params.connectorId ?? '',
				...caller(ctx),
			});
			return noContent();
		},
	}),
	defineRoute({
		method: 'POST',
		path: `${ONE}/test`,
		auth: 'merchant',
		permission: 'connectors.manage',
		idempotent: 'optional',
		rateLimit: { limit: 20, windowMs: 60_000 },
		handler: async (ctx) =>
			ok(
				await service.test({
					merchantId: ctx.params.merchantId ?? '',
					connectorId: ctx.params.connectorId ?? '',
					...caller(ctx),
				}),
			),
	}),
	defineRoute({
		method: 'POST',
		path: `${ONE}/rotate`,
		auth: 'merchant',
		permission: 'connectors.manage',
		idempotent: 'no-store',
		maxBodyBytes: 64 * 1024,
		rateLimit: { limit: 20, windowMs: 60_000 },
		handler: async (ctx) =>
			ok(
				await service.rotate({
					merchantId: ctx.params.merchantId ?? '',
					connectorId: ctx.params.connectorId ?? '',
					credentials: body(ctx).credentials,
					...caller(ctx),
				}),
			),
	}),
	defineRoute({
		method: 'POST',
		path: `${ONE}/rollback`,
		auth: 'merchant',
		permission: 'connectors.manage',
		handler: async (ctx) =>
			ok(
				await service.rollback({
					merchantId: ctx.params.merchantId ?? '',
					connectorId: ctx.params.connectorId ?? '',
					...caller(ctx),
				}),
			),
	}),
	defineRoute({
		method: 'POST',
		path: `${ONE}/revoke`,
		auth: 'merchant',
		permission: 'connectors.manage',
		handler: async (ctx) => {
			const reason = isObject(ctx.body) && typeof ctx.body.reason === 'string' ? ctx.body.reason.slice(0, 500) : null;
			return ok(
				await service.revoke({
					merchantId: ctx.params.merchantId ?? '',
					connectorId: ctx.params.connectorId ?? '',
					reason,
					...caller(ctx),
				}),
			);
		},
	}),
	defineRoute({
		method: 'PUT',
		path: `${ONE}/websites`,
		auth: 'merchant',
		permission: 'connectors.manage',
		handler: async (ctx) =>
			ok(
				await service.assign({
					merchantId: ctx.params.merchantId ?? '',
					connectorId: ctx.params.connectorId ?? '',
					websiteIds: body(ctx).websiteIds,
					...caller(ctx),
				}),
			),
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/merchants/:merchantId/websites/:websiteId/resources',
		auth: 'merchant',
		permission: 'connectors.read',
		handler: async (ctx) =>
			ok(await service.websiteResources({ merchantId: ctx.params.merchantId ?? '', websiteId: ctx.params.websiteId ?? '' })),
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/admin/connectors',
		auth: 'staff',
		permission: 'platform.merchants.read',
		handler: async (ctx) => {
			const page = paginate({ cursor: ctx.query.cursor ?? null, limit: ctx.query.limit ?? null, url: ctx.request.url });
			const items = await service.adminList({
				merchantId: filter(ctx, 'merchantId', /^mer_[0-9a-z]{10,64}$/),
				kind: filter(ctx, 'kind', KIND),
				status: filter(ctx, 'status', STATUS),
				after: page.after,
				limit: page.fetchLimit,
			});
			return page.respond(items, keyOf);
		},
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/admin/connectors/:connectorId',
		auth: 'staff',
		permission: 'platform.merchants.read',
		handler: async (ctx) => ok({ connector: await service.adminGet(ctx.params.connectorId ?? '') }),
	}),
	defineRoute({
		method: 'POST',
		path: '/v1/product/resources/resolve',
		auth: 'product',
		idempotent: false,
		maxBodyBytes: 4 * 1024,
		rateLimit: { limit: 60, windowMs: 60_000, key: resolveKey },
		handler: async (ctx) => {
			const b = body(ctx);
			return ok(
				await service.resolve({
					appId: /** @type {{ appId: string }} */ (ctx.app).appId,
					websiteId: b.websiteId,
					kind: b.kind,
					requestId: ctx.requestId,
					ip: ctx.ip,
				}),
			);
		},
	}),
];
