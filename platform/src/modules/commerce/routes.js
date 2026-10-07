/**
 * HTTP routes of the `commerce` module: thin adapters from requests to the service.
 *
 * - Product (PLAN 0.4.12, `auth: 'product'`): `PUT /v1/product/prices`, `PUT /v1/product/websites/:websiteId/features`,
 *   `GET /v1/product/websites/:websiteId/status`.
 * - Consoles (`merchant` or `admin`): the products on a website (list; add and remove for Owner and Support); the
 *   billing summary, usage and receipts of a merchant. Every route that shows a merchant's money runs the check first
 *   (PLAN 0.5.7).
 * - Admin: add credits (receipt), a merchant's day charges, all receipts, charges by day / merchant / product, merchants
 *   that need attention, and the billing of the merchants on a page.
 * @module
 */
import { defineRoute, ok, created, problem } from '../../infra/http.js';
import { PERMISSIONS as P } from '../../infra/rbac.js';
import { checkAddProduct, checkDayRange, checkReceipt } from './core/validate.js';

/** @typedef {import('./service.js').CommerceService} CommerceService */
/** @typedef {import('../../infra/http.js').RequestContext} RequestContext */

/** @param {RequestContext} c */
const callerOf = (c) => ({ actor: /** @type {any} */ (c.actor), requestId: c.requestId, ip: c.ip });

/** @param {{ path: string, message: string }[]} errors @param {string} detail */
const invalid = (errors, detail) => problem('validation_failed', detail, { errors });

/** @param {RequestContext} c */
const productOf = (c) => /** @type {{ productId: string }} */ (c.product).productId;

/**
 * @param {CommerceService} service
 * @param {() => number} now the Portal clock
 */
export const commerceRoutes = (service, now) => {
	return [
		// ---------------------------------------------------------------- product (PLAN 0.4.12)
		defineRoute({
			method: 'PUT',
			path: '/v1/product/prices',
			auth: 'product',
			maxBodyBytes: 256 * 1024,
			rateLimit: { limit: 60, windowMs: 60_000 },
			handler: async (c) =>
				ok(await service.recordPriceList({ productId: productOf(c), prices: c.body, requestId: c.requestId, ip: c.ip })),
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/product/websites/:websiteId/features',
			auth: 'product',
			maxBodyBytes: 64 * 1024,
			rateLimit: { limit: 600, windowMs: 60_000 },
			handler: async (c) =>
				ok(
					await service.acceptFeatures({
						productId: productOf(c),
						websiteId: c.params.websiteId ?? '',
						body: c.body,
						requestId: c.requestId,
						ip: c.ip,
					}),
				),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/product/websites/:websiteId/status',
			auth: 'product',
			rateLimit: { limit: 6000, windowMs: 60_000 },
			handler: async (c) => ok(await service.statusFor({ productId: productOf(c), websiteId: c.params.websiteId ?? '' })),
		}),

		// ---------------------------------------------------------------- products on a website
		defineRoute({
			method: 'GET',
			path: '/v1/merchants/:merchantId/websites/:websiteId/products',
			auth: ['merchant', 'admin'],
			permission: P.productsOnWebsitesRead,
			handler: async (c) => ({
				items: await service.productsForWebsite(c.params.merchantId ?? '', c.params.websiteId ?? ''),
			}),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/merchants/:merchantId/websites/:websiteId/products',
			auth: ['admin', 'merchant'],
			permission: P.productsOnWebsitesWrite,
			idempotent: true,
			handler: async (c) => {
				const checked = checkAddProduct(c.body);
				if (!checked.ok) return invalid(checked.errors, 'The request is invalid.');
				return created({
					product: await service.addProduct({
						merchantId: c.params.merchantId ?? '',
						websiteId: c.params.websiteId ?? '',
						productId: checked.value.productId,
						...callerOf(c),
					}),
				});
			},
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/merchants/:merchantId/websites/:websiteId/products/:productId',
			auth: ['admin', 'merchant'],
			permission: P.productsOnWebsitesWrite,
			handler: async (c) =>
				ok(
					await service.removeProduct({
						merchantId: c.params.merchantId ?? '',
						websiteId: c.params.websiteId ?? '',
						productId: c.params.productId ?? '',
						...callerOf(c),
					}),
				),
		}),

		// ---------------------------------------------------------------- money
		defineRoute({
			method: 'GET',
			path: '/v1/merchants/:merchantId/billing',
			auth: ['merchant', 'admin'],
			permission: P.billingRead,
			handler: async (c) => service.billingSummary(c.params.merchantId ?? ''),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/merchants/:merchantId/usage',
			auth: ['merchant', 'admin'],
			permission: P.billingRead,
			resource: (c) => ({ merchantId: c.params.merchantId ?? null, websiteId: c.query.websiteId ?? null }),
			handler: async (c) => {
				const checked = checkDayRange(c.query, now());
				if (!checked.ok) return invalid(checked.errors, 'The usage range is invalid.');
				return service.usage(c.params.merchantId ?? '', checked.value);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/merchants/:merchantId/receipts',
			auth: ['merchant', 'admin'],
			permission: P.billingRead,
			handler: async (c) => ({
				items: await service.receiptsOf(c.params.merchantId ?? '', { forAdmin: c.actor?.type === 'admin' }),
			}),
		}),

		// ---------------------------------------------------------------- admin console
		defineRoute({
			method: 'POST',
			path: '/v1/admin/merchants/:merchantId/receipts',
			auth: 'admin',
			permission: P.creditsAdd,
			idempotent: true,
			handler: async (c) => {
				const checked = checkReceipt(c.body);
				if (!checked.ok) return invalid(checked.errors, 'The receipt is invalid.');
				return created(await service.addReceipt({ merchantId: c.params.merchantId ?? '', ...checked.value, ...callerOf(c) }));
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/merchants/:merchantId/day-charges',
			auth: 'admin',
			permission: P.billingRead,
			handler: async (c) => ({ items: await service.dayChargesOf(c.params.merchantId ?? '') }),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/billing/merchants',
			auth: 'admin',
			permission: P.billingRead,
			handler: async (c) => {
				const ids = String(c.query.ids ?? '')
					.split(',')
					.filter((id) => /^mer_[a-z0-9]+$/.test(id));
				return { items: await service.billingSummaries(ids) };
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/billing/attention',
			auth: 'admin',
			permission: P.billingRead,
			handler: async () => ({ items: await service.attention() }),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/billing/receipts',
			auth: 'admin',
			permission: P.billingRead,
			handler: async (c) => {
				const checked = checkDayRange(c.query, now());
				if (!checked.ok) return invalid(checked.errors, 'The filter is invalid.');
				return { items: await service.allReceipts(checked.value) };
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/billing/charges',
			auth: 'admin',
			permission: P.billingRead,
			handler: async (c) => {
				const by = c.query.by ?? 'day';
				if (by !== 'day' && by !== 'merchant' && by !== 'product')
					return invalid([{ path: '/by', message: 'by must be day, merchant or product' }], 'The grouping is invalid.');
				const checked = checkDayRange(c.query, now());
				if (!checked.ok) return invalid(checked.errors, 'The range is invalid.');
				return service.charges({ from: checked.value.from, to: checked.value.to, by });
			},
		}),
	];
};
