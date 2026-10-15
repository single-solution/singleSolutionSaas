/**
 * Public service of the `commerce` module (INTERFACES.md): products on websites, the price and feature reports and the
 * status response of the Product ↔ Portal contract, and credits and billing (PLAN 0.5: histories, the check, receipts,
 * usage and billing views). Other modules call it via `ctx.service('commerce')`; failures are thrown as RFC 9457
 * problems (`infra/http.js` `problem`).
 * @module
 */
import { productStatusOf } from './core/money.js';
import { createCommerceRepo } from './repo.js';
import { createBilling } from './services/billing.js';
import { createDeps } from './services/deps.js';
import { createLedger } from './services/ledger.js';
import { createProducts } from './services/products.js';

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
	// billing tells the products when a check finds grace or a stop; `products` exists by the time it is called
	const billing = createBilling({ ctx, repo, deps, ledger, statusChanged: (merchantId) => products.statusChanged(merchantId) });
	const products = createProducts({ ctx, repo, deps, billing });

	return {
		// products on websites (PLAN 0.5.9)
		addProduct: products.add,
		removeProduct: products.remove,
		productsForWebsite: products.listForWebsite,
		productOnWebsite: products.productOnWebsite,
		productsOnWebsite: products.productsOnWebsite,
		/** @param {string} websiteId products on the website now (not removed) */
		productsOnWebsiteCount: async (websiteId) => (await products.productsOnWebsite(websiteId)).length,
		merchantWebsitesWithProduct: products.merchantWebsitesWithProduct,
		/**
		 * Identity hook: a suspended merchant's products are suspended (never charged) and the products are told;
		 * resuming tells them too. Repeating it writes no second entry, so a repeated suspend or resume repairs one that
		 * failed; the products are told every time.
		 * @param {{ merchantId: string, status: 'active' | 'suspended' }} input
		 */
		onMerchantStatus: async (input) => {
			await billing.recordMerchantStatus(input.merchantId, input.status);
			await products.statusChanged(input.merchantId);
		},
		// the Product ↔ Portal contract (PLAN 0.4.12)
		recordPriceList: products.acceptPrices,
		/** @param {string} productId the last accepted price-list version (0 when none) */
		priceListVersion: async (productId) => Number((await repo.lastPriceList(productId))?.version ?? 0),
		/** @param {string} productId the last accepted price list, or null */
		currentPriceList: (productId) => repo.lastPriceList(productId),
		acceptFeatures: products.acceptFeatures,
		statusFor: products.statusFor,
		websitesOfProduct: products.websitesOfProduct,
		productWebsitesView: products.productWebsitesView,
		productNumbers: products.productNumbers,
		allProductNumbers: products.allProductNumbers,
		// credits and billing (PLAN 0.5)
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
		creditsAddedThisMonth: billing.creditsAddedThisMonth,
		/**
		 * The status the merchant's products on websites have now, after a check (0.5.5: low balance counts as active;
		 * a website's Setup sheet).
		 * @param {string} merchantId
		 * @returns {Promise<'active' | 'grace' | 'stopped' | 'suspended'>}
		 */
		productsStatus: async (merchantId) =>
			/** @type {'active' | 'grace' | 'stopped' | 'suspended'} */ (
				productStatusOf({ added: true, merchantStatus: (await billing.statusOf(merchantId)).status })
			),
		charges: billing.charges,
		/** @param {string} merchantId */
		verifyChain: (merchantId) => ledger.verify(merchantId),
	};
};
/** @typedef {ReturnType<typeof createCommerceService>} CommerceService */
