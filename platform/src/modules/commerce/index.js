/**
 * The `commerce` module: products on websites (added or removed, their switched-on features), the price and feature
 * reports and status responses of the Product ↔ Portal contract (PLAN 0.4.12), and credits and billing (PLAN 0.5):
 * price-list and switch histories, the pure money function, the append-only hash-chained ledger of receipts and day
 * charges, and the billing state per merchant. All money is integer millicredits.
 *
 * Nothing is scheduled (PLAN 0.10): a check runs when a product fetches a status and when a Portal page shows a merchant.
 * It charges the hours since the merchant was last settled, writes the day charges of complete UTC days, works out
 * low balance, grace and stop, tells the products when grace starts or they stop, and sends any due billing e-mail.
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
	routes: (ctx) => commerceRoutes(ctx.service('commerce'), ctx.now),
});
