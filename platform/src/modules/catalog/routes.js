/**
 * HTTP routes of the `catalog` module: thin adapters from requests to the service.
 *
 * Admin:    GET  /v1/admin/products · GET /v1/admin/products/:productId · GET /v1/admin/products/:productId/websites ·
 *           POST /v1/admin/products (Add product) · POST /v1/admin/products/:productId/reconnect ·
 *           POST /v1/admin/products/:productId/status · POST /v1/admin/products/:productId/launch (Open as admin)
 * Merchant: POST /v1/merchants/:merchantId/websites/:websiteId/products/:productId/launch
 * Product:  POST /v1/product/launch/consume · GET /v1/product/directory/:productId · GET /v1/product/websites
 * @module
 */
import { defineRoute, ok, created, problem } from '../../infra/http.js';
import { PERMISSIONS as P } from '../../infra/rbac.js';
import { parseAdminLaunch, parseConnect, parseConsume, parseStatus } from './core/input.js';

/** @typedef {import('./service.js').CatalogService} CatalogService */
/** @typedef {import('../../infra/http.js').RequestContext} RequestContext */
/** @typedef {import('../../infra/rbac.js').Actor} Actor */
/** @typedef {import('../../infra/auth.js').Session} Session */

/**
 * @template T
 * @param {import('./core/input.js').Parsed<T>} parsed
 * @returns {T}
 */
const valid = (parsed) => {
	if (!parsed.ok) throw problem('validation_failed', 'The request body is invalid.', { errors: parsed.errors });
	return parsed.value;
};

/** @param {RequestContext} c */
const audited = (c) => ({ actor: /** @type {Actor} */ (c.actor), requestId: c.requestId, ip: c.ip });

/** @param {RequestContext} c */
const productOf = (c) => /** @type {{ productId: string }} */ (c.product).productId;

/**
 * @param {CatalogService} service
 * @param {() => any} commerce
 */
export const catalogRoutes = (service, commerce) => [
	// ---------------------------------------------------------------- admin: Products
	defineRoute({
		method: 'GET',
		path: '/v1/admin/products',
		auth: 'admin',
		permission: P.productsRead,
		handler: async (c) => {
			const status = c.query.status;
			if (status !== undefined && status !== 'active' && status !== 'inactive')
				return problem('bad_request', 'status must be active or inactive');
			const items = await service.listProducts(status ? { status } : {});
			const numbers = /** @type {Map<string, Record<string, unknown>>} */ (
				new Map(
					(await commerce().allProductNumbers()).map((/** @type {Record<string, any>} */ n) => [String(n.productId), n]),
				)
			);
			return ok({
				items: items.map((p) => ({
					...p,
					websites: numbers.get(p.productId)?.websites ?? 0,
					earnedThisMonth: numbers.get(p.productId)?.earnedThisMonth ?? 0,
				})),
			});
		},
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/admin/products/:productId',
		auth: 'admin',
		permission: P.productsRead,
		handler: async (c) => ok(await service.productDetail(/** @type {string} */ (c.params.productId))),
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/admin/products/:productId/websites',
		auth: 'admin',
		permission: P.productsRead,
		handler: async (c) => {
			const productId = /** @type {string} */ (c.params.productId);
			await service.getProduct(productId);
			return ok(await commerce().productWebsitesView({ productId, cursor: c.query.cursor ?? null }));
		},
	}),
	defineRoute({
		method: 'POST',
		path: '/v1/admin/products',
		auth: 'admin',
		permission: P.productsManage,
		idempotent: true, // the stored response never carries the connect secret
		rateLimit: { limit: 20, windowMs: 60_000 },
		handler: async (c) => {
			const { url, secret } = valid(parseConnect(c.body, { urlRequired: true }));
			return created({ product: await service.connect({ url: /** @type {string} */ (url), secret, ...audited(c) }) });
		},
	}),
	defineRoute({
		method: 'POST',
		path: '/v1/admin/products/:productId/reconnect',
		auth: 'admin',
		permission: P.productsManage,
		rateLimit: { limit: 20, windowMs: 60_000 },
		handler: async (c) => {
			const { url, secret } = valid(parseConnect(c.body, { urlRequired: false }));
			return ok({
				product: await service.reconnect({
					productId: /** @type {string} */ (c.params.productId),
					url,
					secret,
					...audited(c),
				}),
			});
		},
	}),
	defineRoute({
		method: 'POST',
		path: '/v1/admin/products/:productId/status',
		auth: 'admin',
		permission: P.productsManage,
		handler: async (c) =>
			ok({
				product: await service.setStatus({
					productId: /** @type {string} */ (c.params.productId),
					...valid(parseStatus(c.body)),
					...audited(c),
				}),
			}),
	}),
	defineRoute({
		method: 'POST',
		path: '/v1/admin/products/:productId/launch',
		auth: 'admin',
		permission: P.dashboardsOpen,
		rateLimit: { limit: 60, windowMs: 60_000 },
		handler: async (c) => {
			const { websiteId } = valid(parseAdminLaunch(c.body));
			// Open as admin with no website is Owner only (PLAN 0.2 rights table: Products row)
			if (websiteId === null) c.authorize(P.productsManage, {});
			return ok(
				await service.adminLaunch({
					productId: /** @type {string} */ (c.params.productId),
					websiteId,
					session: /** @type {Session} */ (c.session),
					...audited(c),
				}),
			);
		},
	}),

	// ---------------------------------------------------------------- merchant: Open
	defineRoute({
		method: 'POST',
		path: '/v1/merchants/:merchantId/websites/:websiteId/products/:productId/launch',
		auth: 'merchant',
		permission: P.dashboardsOpen,
		rateLimit: { limit: 60, windowMs: 60_000 },
		handler: async (c) =>
			ok(
				await service.merchantLaunch({
					merchantId: /** @type {string} */ (c.params.merchantId),
					websiteId: /** @type {string} */ (c.params.websiteId),
					productId: /** @type {string} */ (c.params.productId),
					session: /** @type {Session} */ (c.session),
					...audited(c),
				}),
			),
	}),

	// ---------------------------------------------------------------- product API (PLAN 0.4.12)
	defineRoute({
		method: 'POST',
		path: '/v1/product/launch/consume',
		auth: 'product',
		maxBodyBytes: 4 * 1024,
		rateLimit: { limit: 600, windowMs: 60_000 },
		handler: async (c) => ok(await service.consumeLaunch({ productId: productOf(c), ...valid(parseConsume(c.body)) })),
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/product/directory/:productId',
		auth: 'product',
		rateLimit: { limit: 600, windowMs: 60_000 },
		handler: async (c) => ok(await service.directory(/** @type {string} */ (c.params.productId))),
	}),
	defineRoute({
		method: 'GET',
		path: '/v1/product/websites',
		auth: 'product',
		rateLimit: { limit: 600, windowMs: 60_000 },
		handler: async (c) => ok(await commerce().websitesOfProduct({ productId: productOf(c), cursor: c.query.cursor ?? null })),
	}),
];
