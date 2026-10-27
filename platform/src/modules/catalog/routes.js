/**
 * HTTP routes of the `catalog` module: thin adapters from requests to the service.
 *
 * Admin:    GET  /v1/admin/products · GET /v1/admin/products/:productId · GET /v1/admin/products/:productId/websites ·
 *           POST /v1/admin/products (Add product) · POST /v1/admin/products/:productId/reconnect ·
 *           POST /v1/admin/products/:productId/status · POST /v1/admin/products/:productId/launch (Open as admin)
 * Merchant: POST /v1/merchants/:merchantId/websites/:websiteId/products/:productId/launch
 * Setup:    GET /v1/merchants/:merchantId/websites/:websiteId/setup[?fresh=1|download=1] · PUT …/setup/profile ·
 *           GET|POST …/setup/links · DELETE …/setup/links/:linkId (merchant: own; Owner, Support) ·
 *           POST …/setup/features { productId, feature } (Owner, Support) ·
 *           POST /v1/setup/shared { key } (public, rate-limited, noindex)
 * Product:  POST /v1/product/launch/consume · GET /v1/product/directory · GET /v1/product/directory/:productId ·
 *           GET /v1/product/websites
 * @module
 */
import { defineRoute, ok, created, problem } from '../../infra/http.js';
import { PERMISSIONS as P } from '../../infra/rbac.js';
import { parseAdminLaunch, parseConnect, parseConsume, parseStatus } from './core/input.js';
import { parseProfile } from './core/advisor.js';
import { parseShareLink, parseSwitchOn } from './core/setup.js';

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

/** The merchant and website a Setup sheet route names. @param {RequestContext} c */
const websiteOf = (c) => ({
	merchantId: /** @type {string} */ (c.params.merchantId),
	websiteId: /** @type {string} */ (c.params.websiteId),
});

/** Answers of a shared Setup sheet: never indexed, never cached, no referrer. */
const SHARED_HEADERS = Object.freeze({ 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer' });

/**
 * @param {CatalogService} service
 * @param {() => any} commerce
 * @param {() => { confirmPerson: (input: { kind: 'admin' | 'merchant', id: string, body: Record<string, unknown>, meta: { requestId?: string | null, ip?: string | null } }) => Promise<unknown> }} identity
 */
export const catalogRoutes = (service, commerce, identity) => {
	/**
	 * A fresh confirmation of the signed-in person: a stolen session must not open a product dashboard.
	 * @param {RequestContext} c
	 * @param {Record<string, unknown>} body
	 */
	const confirm = (c, body) =>
		identity().confirmPerson({
			kind: c.authMode === 'admin' ? 'admin' : 'merchant',
			id: /** @type {Session} */ (c.session).subject,
			body,
			meta: { requestId: c.requestId, ip: c.ip },
		});

	return [
		// ---------------------------------------------------------------- Docs hub (public, PLAN §10 B1, B2)
		defineRoute({
			method: 'GET',
			path: '/v1/docs',
			auth: 'public',
			rateLimit: { limit: 120, windowMs: 60_000 },
			handler: async () => ok({ items: await service.docsList() }),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/docs/openapi.json',
			auth: 'public',
			rateLimit: { limit: 120, windowMs: 60_000 },
			handler: async () => ok(await service.catalogOpenapi()),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/docs/:productId',
			auth: 'public',
			rateLimit: { limit: 120, windowMs: 60_000 },
			handler: async (c) => ok(await service.docsProduct(/** @type {string} */ (c.params.productId))),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/docs/:productId/openapi.json',
			auth: 'public',
			rateLimit: { limit: 120, windowMs: 60_000 },
			handler: async (c) => ok(await service.productOpenapi(/** @type {string} */ (c.params.productId))),
		}),

		// ---------------------------------------------------------------- catalog products (merchants and admins for Add product)
		defineRoute({
			method: 'GET',
			path: '/v1/products',
			auth: ['merchant', 'admin'],
			permission: P.productsRead,
			handler: async (c) => {
				const status = c.query.status ?? 'active';
				if (status !== 'active' && status !== 'inactive') return problem('bad_request', 'status must be active or inactive');
				const items = await service.listProducts({ status });
				return ok({
					items: items.map((p) => ({
						productId: p.productId,
						name: p.name,
						status: p.status,
						features: /** @type {any} */ (p).features,
					})),
				});
			},
		}),

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
			idempotent: 'no-store',
			rateLimit: { limit: 60, windowMs: 60_000 },
			handler: async (c) => {
				const body =
					typeof c.body === 'object' && c.body !== null && !Array.isArray(c.body)
						? /** @type {Record<string, unknown>} */ (c.body)
						: {};
				const { password, code, recoveryCode, ...rest } = body;
				const { websiteId } = valid(parseAdminLaunch(rest));
				await confirm(c, { password, code, recoveryCode });
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
			idempotent: 'no-store',
			rateLimit: { limit: 60, windowMs: 60_000 },
			handler: async (c) => {
				const body =
					typeof c.body === 'object' && c.body !== null && !Array.isArray(c.body)
						? /** @type {Record<string, unknown>} */ (c.body)
						: {};
				await confirm(c, body);
				return ok(
					await service.merchantLaunch({
						merchantId: /** @type {string} */ (c.params.merchantId),
						websiteId: /** @type {string} */ (c.params.websiteId),
						productId: /** @type {string} */ (c.params.productId),
						session: /** @type {Session} */ (c.session),
						...audited(c),
					}),
				);
			},
		}),

		// ---------------------------------------------------------------- Setup sheets (merchant: own; Owner and Support)
		defineRoute({
			method: 'GET',
			path: '/v1/merchants/:merchantId/websites/:websiteId/setup',
			auth: ['merchant', 'admin'],
			permission: P.tokensManage,
			rateLimit: { limit: 60, windowMs: 60_000 },
			handler: async (c) => {
				const download = c.query.download === '1';
				const { sheet, domain } = await service.setup.sheet({
					...websiteOf(c),
					fresh: c.query.fresh === '1',
					download,
					...audited(c),
				});
				return ok(
					sheet,
					download ? { headers: { 'content-disposition': `attachment; filename="setup-${domain}.json"` } } : {},
				);
			},
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/merchants/:merchantId/websites/:websiteId/setup/profile',
			auth: ['merchant', 'admin'],
			permission: P.tokensManage,
			maxBodyBytes: 8 * 1024,
			rateLimit: { limit: 30, windowMs: 60_000 },
			handler: async (c) =>
				ok(await service.setup.saveProfile({ ...websiteOf(c), profile: valid(parseProfile(c.body ?? {})), ...audited(c) })),
		}),
		// the advisor's Switch on: features on/off is Owner or Support (the product checks the admin again)
		defineRoute({
			method: 'POST',
			path: '/v1/merchants/:merchantId/websites/:websiteId/setup/features',
			auth: 'admin',
			permission: P.dashboardsOpen,
			maxBodyBytes: 1024,
			rateLimit: { limit: 30, windowMs: 60_000 },
			handler: async (c) =>
				ok(await service.setup.switchOn({ ...websiteOf(c), ...valid(parseSwitchOn(c.body)), ...audited(c) })),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/merchants/:merchantId/websites/:websiteId/setup/links',
			auth: ['merchant', 'admin'],
			permission: P.tokensManage,
			handler: async (c) => ok(await service.setup.listLinks(websiteOf(c))),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/merchants/:merchantId/websites/:websiteId/setup/links',
			auth: ['merchant', 'admin'],
			permission: P.tokensManage,
			idempotent: 'no-store', // the answer carries the link's key
			rateLimit: { limit: 20, windowMs: 60_000 },
			handler: async (c) =>
				created(await service.setup.createLink({ ...websiteOf(c), ...valid(parseShareLink(c.body ?? {})), ...audited(c) })),
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/merchants/:merchantId/websites/:websiteId/setup/links/:linkId',
			auth: ['merchant', 'admin'],
			permission: P.tokensManage,
			handler: async (c) =>
				ok({
					link: await service.setup.revokeLink({
						...websiteOf(c),
						linkId: /** @type {string} */ (c.params.linkId),
						...audited(c),
					}),
				}),
		}),
		// a shared Setup sheet: the link's key in the body (it is in the address fragment of the page, never in a URL)
		defineRoute({
			method: 'POST',
			path: '/v1/setup/shared',
			auth: 'public',
			maxBodyBytes: 1024,
			rateLimit: { limit: 30, windowMs: 60_000 },
			handler: async (c) => {
				const body = /** @type {Record<string, unknown>} */ (typeof c.body === 'object' && c.body !== null ? c.body : {});
				return ok(await service.setup.shared({ key: body.key, requestId: c.requestId, ip: c.ip }), {
					headers: { ...SHARED_HEADERS },
				});
			},
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
			path: '/v1/product/directory',
			auth: 'product',
			rateLimit: { limit: 600, windowMs: 60_000 },
			handler: async () => ok(await service.directoryList()),
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
			handler: async (c) =>
				ok(await commerce().websitesOfProduct({ productId: productOf(c), cursor: c.query.cursor ?? null })),
		}),
	];
};
