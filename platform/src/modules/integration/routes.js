/**
 * HTTP routes of the `integration` module: thin adapters from requests to the service.
 *
 * `POST /v1/events` is `public` at the HTTP layer because sendBeacon cannot send headers: the service verifies the
 * website key itself (header or body), with the same checks as the `websiteKey` authenticator.
 * @module
 */
import { createHash } from 'node:crypto';
import { accepted, defineRoute, ok } from '../../infra/http.js';
import { MAX_BATCH_BYTES } from './core/events.js';

/** @typedef {import('./service.js').IntegrationService} IntegrationService */
/** @typedef {import('../../infra/http.js').RequestContext} RequestContext */

/** Body cap of ingest routes: the batch limit plus room for the key, identity token and JSON framing. */
const INGEST_MAX_BODY = MAX_BATCH_BYTES + 16 * 1024;

/**
 * Rate-limit subject of `POST /v1/events`: the presented key (hashed), so each website key has its own budget.
 * @param {RequestContext} ctx
 */
const ingestSubject = (ctx) => {
	let key = ctx.headers.get('authorization') ?? '';
	if (!key) {
		try {
			const body = JSON.parse(ctx.rawBody);
			key = typeof body?.key === 'string' ? body.key : '';
		} catch {
			key = '';
		}
	}
	return key ? `key:${createHash('sha256').update(key).digest('hex')}` : `ip:${ctx.ip ?? 'unknown'}`;
};

/**
 * @param {RequestContext} ctx
 */
const listQuery = (ctx) => ({
	cursor: ctx.query.cursor ?? null,
	limit: ctx.query.limit,
	...(ctx.query.status ? { status: ctx.query.status } : {}),
});

/**
 * @param {RequestContext} ctx
 */
const auditContext = (ctx) => ({
	actor: /** @type {import('../../infra/rbac.js').Actor} */ (ctx.actor),
	requestId: ctx.requestId,
	ip: ctx.ip,
});

/**
 * @param {IntegrationService} service
 */
export const integrationRoutes = (service) => [
	defineRoute({
		method: 'POST',
		path: '/v1/events',
		auth: 'public',
		rawBody: true,
		cors: true,
		idempotent: false,
		maxBodyBytes: INGEST_MAX_BODY,
		rateLimit: { limit: 600, windowMs: 60_000, key: ingestSubject },
		handler: async (ctx) => {
			const { body, headers } = await service.ingestRequest({ rawBody: ctx.rawBody, headers: ctx.headers, defer: ctx.defer });
			return ok(body, { status: 202, headers });
		},
	}),
	defineRoute({
		method: 'POST',
		path: '/v1/product/events',
		auth: 'product',
		idempotent: 'optional',
		maxBodyBytes: INGEST_MAX_BODY,
		handler: async (ctx) => {
			const body = /** @type {Record<string, unknown> | undefined} */ (ctx.body);
			return accepted(
				await service.publishFromProduct({
					appId: /** @type {{ appId: string }} */ (ctx.app).appId,
					events: body && typeof body === 'object' ? body.events : undefined,
					defer: ctx.defer,
				}),
			);
		},
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/product/deliveries',
		auth: 'product',
		handler: async (ctx) =>
			ok(await service.deliveryLog({ appId: /** @type {{ appId: string }} */ (ctx.app).appId, ...listQuery(ctx) })),
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/merchants/:merchantId/websites/:websiteId/deliveries',
		auth: ['merchant', 'staff'],
		permission: 'websites.read',
		handler: async (ctx) =>
			ok(
				await service.deliveryLog({
					websiteId: ctx.params.websiteId,
					merchantId: ctx.params.merchantId,
					...listQuery(ctx),
				}),
			),
	}),
	defineRoute({
		method: 'POST',
		path: '/v1/merchants/:merchantId/websites/:websiteId/deliveries/:deliveryId/replay',
		auth: ['merchant', 'staff'],
		permission: 'websites.write',
		handler: async (ctx) =>
			ok(
				await service.replay(String(ctx.params.deliveryId), {
					...auditContext(ctx),
					merchantId: ctx.params.merchantId,
					websiteId: ctx.params.websiteId,
				}),
			),
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/admin/deliveries',
		auth: 'staff',
		permission: 'platform.jobs.read',
		resource: () => ({}),
		handler: async (ctx) =>
			ok(
				await service.deliveryLog({
					...(ctx.query.websiteId ? { websiteId: ctx.query.websiteId } : {}),
					...(ctx.query.appId ? { appId: ctx.query.appId } : {}),
					...listQuery(ctx),
				}),
			),
	}),
	defineRoute({
		method: 'POST',
		path: '/v1/admin/deliveries/:deliveryId/replay',
		auth: 'staff',
		permission: 'platform.jobs.manage',
		resource: () => ({}),
		handler: async (ctx) => ok(await service.replay(String(ctx.params.deliveryId), auditContext(ctx))),
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/admin/dead-letters',
		auth: 'staff',
		permission: 'platform.jobs.read',
		resource: () => ({}),
		handler: async (ctx) =>
			ok(
				await service.deadLetters({
					...(ctx.query.websiteId ? { websiteId: ctx.query.websiteId } : {}),
					...(ctx.query.appId ? { appId: ctx.query.appId } : {}),
					cursor: ctx.query.cursor ?? null,
					limit: ctx.query.limit,
				}),
			),
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/admin/integration/metrics',
		auth: 'staff',
		permission: 'platform.jobs.read',
		resource: () => ({}),
		handler: async (ctx) =>
			ok(
				await service.metrics({
					...(ctx.query.websiteId ? { websiteId: ctx.query.websiteId } : {}),
					...(ctx.query.appId ? { appId: ctx.query.appId } : {}),
				}),
			),
	}),
];
