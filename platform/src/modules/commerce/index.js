/**
 * The `commerce` module: subscriptions (website × app), element switches, signed entitlement documents, usage and
 * quotas, the append-only hash-chained ledger, staff credits, hourly settlement, nightly reconciliation and spend
 * caps. All money is integer millicredits (PLAN §7, F.1).
 *
 * Settlement (F.19) happens lazily before balance and meter reads, as throttled background work after any request
 * (product usage reports, heartbeats, console loads: at most every {@link SETTLEMENT_INTERVAL_MS}), and as the first
 * step of the daily cron, which catches up whatever is left.
 * @module
 */
import { defineModule } from '../../infra/modules.js';
import { commerceRoutes } from './routes.js';
import { collections } from './schema.js';
import { createCommerceService } from './service.js';

/** At most one opportunistic settlement pass per this interval across instances. */
export const SETTLEMENT_INTERVAL_MS = 5 * 60_000;
/** Time budget of one opportunistic settlement pass. */
export const SETTLEMENT_BUDGET_MS = 3_000;

export const commerceModule = defineModule({
	name: 'commerce',
	collections,
	service: (ctx) => createCommerceService(ctx),
	routes: (ctx) => commerceRoutes(ctx.service('commerce')),
	crons: (ctx) => ({
		settlement: async ({ deadline, signal }) => ctx.service('commerce').runSettlement({ deadline, signal }),
		reconciliation: async ({ deadline, signal }) => ctx.service('commerce').runReconciliation({ deadline, signal }),
	}),
	background: (ctx) => ({
		'commerce.settlement': {
			intervalMs: SETTLEMENT_INTERVAL_MS,
			budgetMs: SETTLEMENT_BUDGET_MS,
			run: async ({ deadline }) => ctx.service('commerce').runSettlement({ deadline, marginMs: 0 }),
		},
	}),
});
