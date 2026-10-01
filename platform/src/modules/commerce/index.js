/**
 * The `commerce` module: subscriptions (website × app), element switches, signed entitlement documents, usage and
 * quotas, the append-only hash-chained ledger, staff credits, hourly settlement, nightly reconciliation and spend
 * caps. All money is integer millicredits (PLAN §7, F.1).
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
	crons: (ctx) => ({
		settlement: async ({ deadline, signal }) => ctx.service('commerce').runSettlement({ deadline, signal }),
		reconciliation: async ({ deadline, signal }) => ctx.service('commerce').runReconciliation({ deadline, signal }),
	}),
});
