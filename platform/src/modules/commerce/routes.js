/**
 * HTTP routes of the `commerce` module: thin adapters from requests to the service.
 *
 * - Product (F.9, `auth: 'product'`): `GET /v1/product/entitlements`, `POST /v1/product/usage`.
 * - Consoles (`merchant` or `admin`): subscriptions, element switches, plan, pause/resume/cancel (until PLAN 0.12 step
 *   5); the billing summary, usage and receipts of a merchant. Subscription routes authorise after the lookup with the
 *   subscription's website. Every route that shows a merchant's money runs the check first (PLAN 0.5.7).
 * - Admin: add credits (receipt), a merchant's day charges, all receipts, charges by day / merchant / product, merchants
 *   that need attention, and the billing of the merchants on a page.
 * @module
 */
import { defineRoute, ok, created, problem } from '../../infra/http.js';
import {
	checkDayRange,
	checkElementSwitch,
	checkPlanChange,
	checkReceipt,
	checkReason,
	checkSubscribe,
	checkUsageBatch,
} from './core/validate.js';

/** @typedef {import('./service.js').CommerceService} CommerceService */
/** @typedef {import('../../infra/http.js').RequestContext} RequestContext */

/** @param {RequestContext} c */
const callerOf = (c) => ({ actor: /** @type {any} */ (c.actor), requestId: c.requestId, ip: c.ip });

/** @param {{ path: string, message: string }[]} errors @param {string} detail */
const invalid = (errors, detail) => problem('validation_failed', detail, { errors });

/**
 * Merchant users act only on their own merchant (checked before any lookup, so ids of other merchants never leak).
 * @param {RequestContext} c
 */
const ownMerchant = (c) => {
	const actor = c.actor;
	if (actor?.type === 'merchant' && actor.merchantId !== c.params.merchantId) throw problem('forbidden', 'Not your merchant.');
};

/**
 * @param {CommerceService} service
 * @param {() => number} now the Portal clock
 */
export const commerceRoutes = (service, now) => {
	/**
	 * Load a subscription of the path merchant and authorise `permission` on its website.
	 * @param {RequestContext} c @param {string} permission
	 */
	const authorisedSubscription = async (c, permission) => {
		ownMerchant(c);
		const sub = await service.getSubscription(c.params.subscriptionId ?? '', c.params.merchantId);
		c.authorize(permission, { merchantId: sub.merchantId, websiteId: sub.websiteId });
		return sub;
	};

	/**
	 * @param {'pause' | 'resume' | 'cancel'} action
	 */
	const lifecycle = (action) =>
		defineRoute({
			method: 'POST',
			path: `/v1/merchants/:merchantId/subscriptions/:subscriptionId/${action}`,
			auth: ['merchant', 'admin'],
			handler: async (c) => {
				const checked = checkReason(c.body, action === 'cancel' ? 'merchant_cancelled' : 'merchant_request');
				if (!checked.ok) return invalid(checked.errors, 'The request is invalid.');
				const sub = await authorisedSubscription(c, 'products_on_websites.write');
				return ok({
					subscription: await service[action]({
						subscriptionId: sub.subscriptionId,
						merchantId: sub.merchantId,
						reason: checked.value.reason,
						...callerOf(c),
					}),
				});
			},
		});

	return [
		// ---------------------------------------------------------------- product (F.9)
		defineRoute({
			method: 'GET',
			path: '/v1/product/entitlements',
			auth: 'product',
			rateLimit: { limit: 600, windowMs: 60_000 },
			handler: async (c) => {
				const websiteId = c.query.websiteId;
				if (!websiteId) return invalid([{ path: '/websiteId', message: 'websiteId is required' }], 'websiteId is required.');
				const app = /** @type {{ appId: string }} */ (c.app);
				return ok({ document: await service.documentFor({ websiteId, appId: app.appId }) });
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/product/usage',
			auth: 'product',
			idempotent: true,
			rateLimit: { limit: 600, windowMs: 60_000 },
			handler: async (c) => {
				const checked = checkUsageBatch(c.body);
				if (!checked.ok) return invalid(checked.errors, 'The usage batch is invalid.');
				const app = /** @type {{ appId: string }} */ (c.app);
				return ok(await service.recordUsage({ appId: app.appId, records: checked.value }));
			},
		}),

		// ---------------------------------------------------------------- merchant console
		defineRoute({
			method: 'GET',
			path: '/v1/merchants/:merchantId/subscriptions',
			auth: ['merchant', 'admin'],
			permission: 'products_on_websites.read',
			resource: (c) => ({ merchantId: c.params.merchantId ?? null, websiteId: c.query.websiteId ?? null }),
			handler: async (c) => ({
				items: await service.subscriptionsOfMerchant(c.params.merchantId ?? '', { websiteId: c.query.websiteId ?? null }),
			}),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/merchants/:merchantId/websites/:websiteId/subscriptions',
			auth: ['merchant', 'admin'],
			permission: 'products_on_websites.write',
			idempotent: true,
			handler: async (c) => {
				const checked = checkSubscribe(c.body);
				if (!checked.ok) return invalid(checked.errors, 'The subscription request is invalid.');
				const subscription = await service.subscribe({
					websiteId: c.params.websiteId ?? '',
					merchantId: c.params.merchantId ?? '',
					appId: checked.value.appId,
					planCode: checked.value.planCode,
					...callerOf(c),
				});
				return created({ subscription });
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/merchants/:merchantId/subscriptions/:subscriptionId',
			auth: ['merchant', 'admin'],
			handler: async (c) => ({ subscription: await authorisedSubscription(c, 'products_on_websites.read') }),
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/merchants/:merchantId/subscriptions/:subscriptionId/elements/:elementKey',
			auth: ['merchant', 'admin'],
			handler: async (c) => {
				const checked = checkElementSwitch(c.params.elementKey ?? '', c.body);
				if (!checked.ok) return invalid(checked.errors, 'The element switch is invalid.');
				const sub = await authorisedSubscription(c, 'features.write');
				return ok({
					subscription: await service.setElement({
						subscriptionId: sub.subscriptionId,
						merchantId: sub.merchantId,
						...checked.value,
						...callerOf(c),
					}),
				});
			},
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/merchants/:merchantId/subscriptions/:subscriptionId/plan',
			auth: ['merchant', 'admin'],
			handler: async (c) => {
				const checked = checkPlanChange(c.body);
				if (!checked.ok) return invalid(checked.errors, 'The plan change is invalid.');
				const sub = await authorisedSubscription(c, 'products_on_websites.write');
				return ok({
					subscription: await service.changePlan({
						subscriptionId: sub.subscriptionId,
						merchantId: sub.merchantId,
						planCode: checked.value.planCode,
						...callerOf(c),
					}),
				});
			},
		}),
		lifecycle('pause'),
		lifecycle('resume'),
		lifecycle('cancel'),
		defineRoute({
			method: 'GET',
			path: '/v1/merchants/:merchantId/billing',
			auth: ['merchant', 'admin'],
			permission: 'billing.read',
			handler: async (c) => service.billingSummary(c.params.merchantId ?? ''),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/merchants/:merchantId/usage',
			auth: ['merchant', 'admin'],
			permission: 'billing.read',
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
			permission: 'billing.read',
			handler: async (c) => ({
				items: await service.receiptsOf(c.params.merchantId ?? '', { forAdmin: c.actor?.type === 'admin' }),
			}),
		}),

		// ---------------------------------------------------------------- admin console
		defineRoute({
			method: 'POST',
			path: '/v1/admin/merchants/:merchantId/receipts',
			auth: 'admin',
			permission: 'credits.add',
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
			permission: 'billing.read',
			handler: async (c) => ({ items: await service.dayChargesOf(c.params.merchantId ?? '') }),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/billing/merchants',
			auth: 'admin',
			permission: 'billing.read',
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
			permission: 'billing.read',
			handler: async () => ({ items: await service.attention() }),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/billing/receipts',
			auth: 'admin',
			permission: 'billing.read',
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
			permission: 'billing.read',
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
