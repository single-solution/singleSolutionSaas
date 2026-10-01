/**
 * HTTP routes of the `commerce` module: thin adapters from requests to the service.
 *
 * - Product (F.9, `auth: 'product'`): `GET /v1/product/entitlements`, `POST /v1/product/usage`.
 * - Merchant console (`merchant` or `staff`): subscriptions, element switches, plan, pause/resume/cancel, balance,
 *   meter, statement, spend policies. Subscription routes authorise after the lookup with the subscription's website.
 * - Admin (`staff`): credits, adjustments, refunds, ledger + verification, force settlement, reconciliation, alerts.
 * @module
 */
import { defineRoute, ok, created, noContent, paginate, problem } from '../../infra/http.js';
import {
	checkElementSwitch,
	checkCreditOperation,
	checkPlanChange,
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
	if (actor?.type === 'merchant_user' && actor.merchantId !== c.params.merchantId)
		throw problem('forbidden', 'Not your merchant.');
};

/**
 * @param {CommerceService} service
 */
export const commerceRoutes = (service) => {
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
			auth: ['merchant', 'staff'],
			handler: async (c) => {
				const checked = checkReason(c.body, action === 'cancel' ? 'merchant_cancelled' : 'merchant_request');
				if (!checked.ok) return invalid(checked.errors, 'The request is invalid.');
				const sub = await authorisedSubscription(c, 'subscriptions.manage');
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

	/**
	 * @param {'credit' | 'adjustment' | 'refund'} kind
	 * @param {string} segment
	 */
	const staffCredit = (kind, segment) =>
		defineRoute({
			method: 'POST',
			path: `/v1/admin/merchants/:merchantId/${segment}`,
			auth: 'staff',
			permission: 'platform.credits.adjust',
			handler: async (c) => {
				const checked = checkCreditOperation(kind, c.body);
				if (!checked.ok) return invalid(checked.errors, 'The credit operation is invalid.');
				const input = { merchantId: c.params.merchantId ?? '', ...checked.value, ...callerOf(c) };
				const out =
					kind === 'credit'
						? await service.addCredits(input)
						: kind === 'adjustment'
							? await service.adjust(input)
							: await service.refund(input);
				return out.duplicate ? ok(out) : created(out);
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
			auth: ['merchant', 'staff'],
			permission: 'subscriptions.read',
			resource: (c) => ({ merchantId: c.params.merchantId ?? null, websiteId: c.query.websiteId ?? null }),
			handler: async (c) => ({
				items: await service.subscriptionsOfMerchant(c.params.merchantId ?? '', { websiteId: c.query.websiteId ?? null }),
			}),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/merchants/:merchantId/websites/:websiteId/subscriptions',
			auth: ['merchant', 'staff'],
			permission: 'subscriptions.manage',
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
			auth: ['merchant', 'staff'],
			handler: async (c) => ({ subscription: await authorisedSubscription(c, 'subscriptions.read') }),
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/merchants/:merchantId/subscriptions/:subscriptionId/elements/:elementKey',
			auth: ['merchant', 'staff'],
			handler: async (c) => {
				const checked = checkElementSwitch(c.params.elementKey ?? '', c.body);
				if (!checked.ok) return invalid(checked.errors, 'The element switch is invalid.');
				const sub = await authorisedSubscription(c, 'subscriptions.manage');
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
			auth: ['merchant', 'staff'],
			handler: async (c) => {
				const checked = checkPlanChange(c.body);
				if (!checked.ok) return invalid(checked.errors, 'The plan change is invalid.');
				const sub = await authorisedSubscription(c, 'subscriptions.manage');
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
			path: '/v1/merchants/:merchantId/balance',
			auth: ['merchant', 'staff'],
			permission: 'billing.read',
			handler: async (c) => service.balance(c.params.merchantId ?? ''),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/merchants/:merchantId/meter',
			auth: ['merchant', 'staff'],
			permission: 'billing.read',
			handler: async (c) => service.meter(c.params.merchantId ?? ''),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/merchants/:merchantId/statement',
			auth: ['merchant', 'staff'],
			permission: 'billing.read',
			resource: (c) => ({ merchantId: c.params.merchantId ?? null, websiteId: c.query.websiteId ?? null }),
			handler: async (c) => service.statementForQuery(c.params.merchantId ?? '', c.query),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/merchants/:merchantId/spend-policies',
			auth: ['merchant', 'staff'],
			permission: 'billing.read',
			handler: async (c) => ({ items: await service.listPolicies(c.params.merchantId ?? '') }),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/merchants/:merchantId/spend-policies',
			auth: ['merchant', 'staff'],
			permission: 'billing.manage',
			handler: async (c) => created({ policy: await service.createPolicy(c.params.merchantId ?? '', c.body, callerOf(c)) }),
		}),
		defineRoute({
			method: 'PUT',
			path: '/v1/merchants/:merchantId/spend-policies/:policyId',
			auth: ['merchant', 'staff'],
			permission: 'billing.manage',
			handler: async (c) => ({
				policy: await service.updatePolicy(c.params.merchantId ?? '', c.params.policyId ?? '', c.body, callerOf(c)),
			}),
		}),
		defineRoute({
			method: 'DELETE',
			path: '/v1/merchants/:merchantId/spend-policies/:policyId',
			auth: ['merchant', 'staff'],
			permission: 'billing.manage',
			handler: async (c) => {
				await service.deletePolicy(c.params.merchantId ?? '', c.params.policyId ?? '', callerOf(c));
				return noContent();
			},
		}),

		// ---------------------------------------------------------------- admin console
		staffCredit('credit', 'credits'),
		staffCredit('adjustment', 'adjustments'),
		staffCredit('refund', 'refunds'),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/merchants/:merchantId/ledger',
			auth: 'staff',
			permission: 'platform.finance.read',
			handler: async (c) => {
				const page = paginate(
					{ cursor: c.query.cursor, limit: c.query.limit, url: c.request.url },
					{ defaultLimit: 100, maxLimit: 500 },
				);
				const afterSeq = typeof page.after === 'number' ? page.after : null;
				const items = await service.ledgerEntries(c.params.merchantId ?? '', { afterSeq, limit: page.fetchLimit });
				return page.respond(items, (e) => e.seq);
			},
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/merchants/:merchantId/ledger/verification',
			auth: 'staff',
			permission: 'platform.finance.read',
			handler: async (c) => service.verifyChain(c.params.merchantId ?? ''),
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/commerce/settlement',
			auth: 'staff',
			permission: 'platform.jobs.manage',
			handler: async (c) => {
				const body = /** @type {Record<string, unknown> | undefined} */ (c.body);
				const merchantId = typeof body?.merchantId === 'string' ? body.merchantId : null;
				return ok({ stats: await service.runSettlement({ merchantId }) });
			},
		}),
		defineRoute({
			method: 'POST',
			path: '/v1/admin/commerce/reconciliation',
			auth: 'staff',
			permission: 'platform.jobs.manage',
			handler: async () => ok({ stats: await service.runReconciliation() }),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/commerce/reconciliation',
			auth: 'staff',
			permission: 'platform.finance.read',
			handler: async () => ({ items: await service.reconciliationReports() }),
		}),
		defineRoute({
			method: 'GET',
			path: '/v1/admin/commerce/alerts',
			auth: 'staff',
			permission: 'platform.finance.read',
			handler: async (c) => ({ items: await service.alerts({ merchantId: c.query.merchantId ?? null }) }),
		}),
	];
};
