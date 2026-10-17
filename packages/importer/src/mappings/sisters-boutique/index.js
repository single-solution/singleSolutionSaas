/**
 * The Sisters Boutique mapping (`ss-import read --mapping sisters-boutique`; PLAN 0.8.10 Migration, "Per store", SB):
 * SB's MongoDB (its Mongoose models, `packages/db/src/models` at 8f809d8) into Accounts and Ecommerce, in import order,
 * with SB's settings and lists for every product it uses. SB has no chat, reviews, returns, stock alerts or
 * wishlists, and no analytics collection: nothing goes to Chat or Growth records (Growth gets its settings).
 *
 * Order (each target's file is sent in the order it first appears):
 * 1. Accounts `roles` (the `member` role), Ecommerce `customers` (first reader of SB's customers, so the id map gives
 *    their `cus_` ids), Accounts `users` (members, staff, the users of invited requests), `requests` and `copies`;
 * 2. Ecommerce `size_charts` (with SB's built-in chart), `categories`, `brands`, `attributes`, `landings`, `products`
 *    (the built-in chart and the attributes' `multiple` are read off the products afterwards, into the files sent
 *    before them), `deals`, `orders` and `loyalty`.
 * @module
 */
import { defineMapping } from '../../mapping.js';
import { attributeFixStep, defaultChartStep, productStep, taxonomySteps } from './catalog.js';
import { dealStep } from './deals.js';
import { customerStep, loyaltyStep, orderStep } from './orders.js';
import { copyStep, invitedStep, memberStep, requestStep, roleSteps, staffStep } from './people.js';
import { readSettings } from './settings.js';

export {
	BY_HAND,
	FEATURES,
	PENDING,
	PORTAL_BY_HAND,
	PORTAL_CONNECTIONS_BY_HAND,
	STORE_DEFAULTS,
	readValues,
	settingsPlan,
} from './settings.js';
export { DEAL_HOURS_SHIFT_MINUTES, windowOf } from './deals.js';
export { DEFAULT_CHART_ID } from './catalog.js';
export { STATUSES, spread } from './orders.js';

/** The mapping of Sisters Boutique's database. */
export const SISTERS_BOUTIQUE_MAPPING = defineMapping({
	name: 'sisters-boutique',
	description:
		"Sisters Boutique (SB): members, staff, membership requests and activity into Accounts; catalog, offers, customers, orders and loyalty into Ecommerce; SB's settings for Accounts, Ecommerce, Notifications, Payments and Growth.",
	steps: [
		...roleSteps,
		customerStep,
		memberStep,
		staffStep,
		requestStep,
		invitedStep,
		copyStep,
		...taxonomySteps,
		productStep,
		defaultChartStep,
		attributeFixStep,
		dealStep,
		orderStep,
		loyaltyStep,
	],
	settings: readSettings,
});
