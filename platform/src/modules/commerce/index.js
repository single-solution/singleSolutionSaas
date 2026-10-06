/**
 * The `commerce` module: subscriptions (website × app), element switches, signed entitlement documents, usage and
 * quotas, the append-only hash-chained ledger, staff credits, hourly settlement, reconciliation and spend caps. All
 * money is integer millicredits (PLAN §7, F.1).
 *
 * Settlement is computed when read (F.19: no cron): a merchant's complete hours are settled — idempotently, per
 * `periodKey` — before its balance, meter and statement are read (merchant console, admin views), when a product
 * fetches an entitlement document or reports usage for one of its websites, and before a subscription change; spend
 * limits and low-balance holds are evaluated at the same moments, so the document a product fetches reflects a hold.
 * Staff can also run `settlement` and `reconciliation` on demand (admin operations, bounded and resumable).
 * @module
 */
import { defineModule } from '../../infra/modules.js';
import { commerceRoutes } from './routes.js';
import { collections } from './schema.js';
import { createCommerceService } from './service.js';

export const commerceModule = defineModule({
	name: 'commerce',
	collections,
	service: (ctx) => createCommerceService(ctx),
	routes: (ctx) => commerceRoutes(ctx.service('commerce')),
	operations: (ctx) => ({
		settlement: async ({ deadline, signal }) => ctx.service('commerce').runSettlement({ deadline, signal }),
		reconciliation: async ({ deadline, signal }) => ctx.service('commerce').runReconciliation({ deadline, signal }),
	}),
});
