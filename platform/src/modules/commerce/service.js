/**
 * Public service of the `commerce` module (INTERFACES.md): subscriptions, element switches, entitlement documents,
 * usage records, and credits and billing (PLAN 0.5: histories, the check, receipts, usage and billing views). Other
 * modules call it via `ctx.service('commerce')`; failures are thrown as RFC 9457 problems (`infra/http.js` `problem`).
 * @module
 */
import { createCommerceRepo } from './repo.js';
import { createBilling } from './services/billing.js';
import { createDeps } from './services/deps.js';
import { createLedger } from './services/ledger.js';
import { createSubscriptions } from './services/subscriptions.js';
import { createUsage } from './services/usage.js';

/** @typedef {import('../../infra/modules.js').ModuleContext} ModuleContext */

/**
 * @param {ModuleContext} ctx
 */
export const createCommerceService = (ctx) => {
	const repo = createCommerceRepo(ctx);
	const deps = createDeps(ctx);
	const ledger = createLedger({
		ctx,
		repo,
		onChainBroken: async (merchantId, message) => {
			ctx.logger.error('ledger chain broken', { merchantId, message });
		},
	});
	const subscriptions = createSubscriptions({ ctx, repo, deps });
	const billing = createBilling({ ctx, repo, deps, ledger });
	const usage = createUsage({ ctx, repo, deps, subscriptions });

	return {
		// subscriptions (until the switch to products on websites, PLAN 0.12 step 5)
		subscribe: subscriptions.subscribe,
		getSubscription: subscriptions.getSubscription,
		subscriptionsForWebsite: subscriptions.subscriptionsForWebsite,
		subscriptionsOfMerchant: subscriptions.subscriptionsOfMerchant,
		setElement: subscriptions.setElement,
		changePlan: subscriptions.changePlan,
		pause: subscriptions.pause,
		resume: subscriptions.resume,
		cancel: subscriptions.cancel,
		invalidate: subscriptions.invalidate,
		/** @param {string} websiteId */
		invalidateWebsite: async (websiteId) => {
			let count = 0;
			for (const sub of await repo.subscriptionsForWebsite(websiteId)) {
				if (!sub.live) continue;
				await subscriptions.refreshQuietly(sub);
				count += 1;
			}
			return { invalidated: count };
		},
		/** @param {string} appId */
		invalidateApp: async (appId) => {
			let count = 0;
			for (const sub of await repo.liveSubscriptionsOfApp(appId)) {
				await subscriptions.refreshQuietly(sub);
				count += 1;
			}
			return { invalidated: count };
		},
		/**
		 * Websites with a live subscription of an app (delivery recompiles them when the app's UI bundle changes).
		 * @param {string} appId
		 * @returns {Promise<string[]>}
		 */
		websitesOfApp: async (appId) => [
			...new Set((await repo.liveSubscriptionsOfApp(appId)).map((sub) => String(sub.websiteId))),
		],
		previewDocument: subscriptions.previewDocument,
		/** Resource needs of a website's live subscriptions (connectors resolve and the console Resources page). */
		resourceNeeds: subscriptions.resourceNeedsOf,
		/**
		 * Identity hook: a suspended merchant suspends every subscription, and suspended hours are never charged.
		 * @param {{ merchantId: string, status: 'active' | 'suspended' }} input
		 */
		onMerchantStatus: async (input) => {
			await billing.recordMerchantStatus(input.merchantId, input.status);
			return subscriptions.onMerchantStatus(input);
		},
		// documents and usage records
		documentFor: subscriptions.documentFor,
		/** @param {Parameters<typeof usage.recordUsage>[0]} input */
		recordUsage: usage.recordUsage,
		// credits and billing (PLAN 0.5)
		recordPriceList: billing.recordPriceList,
		recordProductAdded: billing.recordProductAdded,
		recordProductRemoved: billing.recordProductRemoved,
		recordSwitches: billing.recordSwitches,
		check: billing.check,
		billingSummary: billing.summary,
		billingSummaries: billing.summaries,
		usage: billing.usage,
		receiptsOf: billing.receiptsOf,
		dayChargesOf: billing.dayChargesOf,
		addReceipt: billing.addReceipt,
		attention: billing.attention,
		allReceipts: billing.allReceipts,
		charges: billing.charges,
		/** @param {string} merchantId */
		verifyChain: (merchantId) => ledger.verify(merchantId),
	};
};
/** @typedef {ReturnType<typeof createCommerceService>} CommerceService */
