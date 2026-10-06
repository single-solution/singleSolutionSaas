/**
 * Public service of the `commerce` module (INTERFACES.md): subscriptions, element switches, entitlement documents,
 * usage, ledger, credits, settlement, reconciliation and spend caps. Other modules call it via
 * `ctx.service('commerce')`; failures are thrown as RFC 9457 problems (`infra/http.js` `problem`).
 * @module
 */
import { createCommerceRepo } from './repo.js';
import { createDeps } from './services/deps.js';
import { createLedger } from './services/ledger.js';
import { createMoney, entryView } from './services/money.js';
import { createReconciliation } from './services/reconciliation.js';
import { createSettlement } from './services/settlement.js';
import { createSubscriptions } from './services/subscriptions.js';
import { createUsage } from './services/usage.js';
import { createId } from '@ss/contracts';
import { problem } from '../../infra/http.js';
import { afterResponse } from '../../infra/request-scope.js';
import { checkStatementQuery } from './core/validate.js';

/** @typedef {import('../../infra/modules.js').ModuleContext} ModuleContext */

/**
 * @param {unknown} value
 * @returns {number}
 */
const instant = (value) =>
	value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : Number(value);

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
			await repo.insertAlert({
				_id: createId('alr', { randomBytes: ctx.randomBytes }),
				at: new Date(ctx.now()),
				kind: 'ledger_chain_broken',
				merchantId,
				subscriptionId: null,
				details: { message },
			});
			ctx.logger.error('ledger chain broken', { merchantId, message });
		},
	});
	const subscriptions = createSubscriptions({ ctx, repo, deps, ledger });
	const settlement = createSettlement({ ctx, repo, deps, ledger, subscriptions });
	const money = createMoney({ ctx, repo, deps, ledger, settlement });
	const usage = createUsage({ ctx, repo, deps, subscriptions });
	const reconciliation = createReconciliation({ ctx, repo, ledger, settlement });

	/**
	 * Settle the merchant of a website before reading or changing its money-relevant state (F.19: settlement on read).
	 * @param {unknown} websiteId
	 */
	const settleWebsite = async (websiteId) => {
		if (typeof websiteId !== 'string') return;
		const website = await Promise.resolve(deps.getWebsite(websiteId)).catch(() => null);
		if (website?.merchantId) await money.settleDue(String(website.merchantId));
	};
	/** @param {unknown} subscriptionId */
	const settleSubscription = async (subscriptionId) => {
		if (typeof subscriptionId !== 'string') return;
		const sub = await repo.subscriptionById(subscriptionId).catch(() => null);
		if (sub?.merchantId) await money.settleDue(String(sub.merchantId));
	};
	/**
	 * A subscription change settles the merchant's due hours first.
	 * @template {{ subscriptionId: string }} I
	 * @template R
	 * @param {(input: I) => Promise<R>} change
	 * @returns {(input: I) => Promise<R>}
	 */
	const settledFirst = (change) => async (input) => {
		await settleSubscription(input.subscriptionId);
		return change(input);
	};

	return {
		// subscriptions
		/** @type {typeof subscriptions.subscribe} */
		subscribe: async (input) => {
			await settleWebsite(input.websiteId);
			return subscriptions.subscribe(input);
		},
		getSubscription: subscriptions.getSubscription,
		subscriptionsForWebsite: subscriptions.subscriptionsForWebsite,
		subscriptionsOfMerchant: subscriptions.subscriptionsOfMerchant,
		setElement: settledFirst(subscriptions.setElement),
		changePlan: settledFirst(subscriptions.changePlan),
		pause: settledFirst(subscriptions.pause),
		resume: settledFirst(subscriptions.resume),
		cancel: settledFirst(subscriptions.cancel),
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
		onMerchantStatus: subscriptions.onMerchantStatus,
		// documents and usage
		/**
		 * The signed document of a subscription. The merchant is settled first, so a low-balance or spend-limit hold
		 * reaches the document a product fetches.
		 * @type {typeof subscriptions.documentFor}
		 */
		documentFor: async (input) => {
			await settleWebsite(input.websiteId);
			return subscriptions.documentFor(input);
		},
		/**
		 * Record a product's usage batch; the merchants it concerns are settled right after the response.
		 * @param {Parameters<typeof usage.recordUsage>[0]} input
		 */
		recordUsage: async (input) => {
			const out = await usage.recordUsage(input);
			for (const merchantId of out.merchants) afterResponse(() => money.settleDue(merchantId));
			return { results: out.results };
		},
		// money
		addCredits: money.addCredits,
		adjust: money.adjust,
		refund: money.refund,
		balance: money.balance,
		/**
		 * @param {string} merchantId
		 * @param {{ from: number | string | Date, to: number | string | Date, websiteId?: string | null }} range
		 */
		statement: (merchantId, { from, to, websiteId = null }) =>
			money.statement(merchantId, { from: instant(from), to: instant(to), websiteId }),
		/**
		 * Statement for console query parameters (`from`, `to` ISO dates or instants, optional `websiteId`); the default
		 * range is the current UTC month to now.
		 * @param {string} merchantId
		 * @param {Record<string, string | undefined>} query
		 */
		statementForQuery: (merchantId, query) => {
			const checked = checkStatementQuery(query, ctx.now());
			if (!checked.ok) throw problem('validation_failed', 'The statement range is invalid.', { errors: checked.errors });
			return money.statement(merchantId, checked.value);
		},
		meter: money.meter,
		listPolicies: money.listPolicies,
		createPolicy: money.createPolicy,
		updatePolicy: money.updatePolicy,
		deletePolicy: money.deletePolicy,
		/** @param {string} merchantId */
		verifyChain: (merchantId) => ledger.verify(merchantId),
		/** @param {string} merchantId @param {{ afterSeq?: number | null, limit?: number }} [page] */
		ledgerEntries: async (merchantId, { afterSeq = null, limit = 100 } = {}) =>
			(await ledger.entries(merchantId, { afterSeq, limit })).map(entryView),
		// operations (admin console) and settlement on read
		settleDue: money.settleDue,
		/**
		 * Settlement pass (all merchants, or `merchantId`), bounded by the operation deadline unless one is given.
		 * @param {Parameters<typeof settlement.runSettlement>[0]} [options]
		 */
		runSettlement: (options = {}) =>
			settlement.runSettlement({ deadline: ctx.now() + ctx.config.operationDeadlineMs, ...options }),
		/**
		 * Reconciliation chunk (resumes where the previous one stopped), bounded like {@link runSettlement}.
		 * @param {Parameters<typeof reconciliation.runReconciliation>[0]} [options]
		 */
		runReconciliation: (options = {}) =>
			reconciliation.runReconciliation({ deadline: ctx.now() + ctx.config.operationDeadlineMs, ...options }),
		/** @param {{ merchantId?: string | null, limit?: number }} [query] */
		alerts: async ({ merchantId = null, limit = 100 } = {}) =>
			(await repo.listAlerts({ merchantId, limit })).map((a) => ({
				alertId: a._id,
				at: new Date(a.at).toISOString(),
				kind: a.kind,
				merchantId: a.merchantId,
				subscriptionId: a.subscriptionId,
				details: a.details,
			})),
		/** @param {{ limit?: number }} [query] */
		reconciliationReports: async ({ limit = 30 } = {}) =>
			(await repo.listReports(limit)).map((r) => ({
				...r,
				reportId: r._id,
				at: new Date(r.at).toISOString(),
				_id: undefined,
			})),
	};
};
/** @typedef {ReturnType<typeof createCommerceService>} CommerceService */
