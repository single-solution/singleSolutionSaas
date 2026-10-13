/**
 * The `import` feature (PLAN 0.8.10 K10, Migration): what the kit's import routes take into Ecommerce, with the
 * product's own checks in import mode (given ids, past times, history and given numbers allowed; nothing sent, no
 * events or alerts, no stock held), `finish`, which recomputes what the shop derives (products' price, stock state,
 * sold and rating; customers' order and RTO counts; loyalty balances; serial statuses; order counters), and the sums
 * `ss-import verify` compares. The catalog's part is `imports-catalog.js`; the shoppers' and orders' `imports-orders.js`
 * (its finish runs after the catalog's).
 * @module
 */
import { catalogImports } from './imports-catalog.js';
import { orderImports } from './imports-orders.js';

/**
 * What the import checks read of the website (built in `product.js` on the kit's product). The business.json copy
 * (its `country` gives national phone numbers their calling code, K12) comes with each call's check context
 * (`ctx.business()`, read once per call).
 * @typedef {object} ImportDeps
 * @property {(websiteId: string, name: string) => Promise<unknown>} list a list setting (`order_flow`, `grades` …)
 * @property {(websiteId: string, feature: string) => Promise<Record<string, unknown>>} settings a feature's settings
 * @property {(websiteId: string) => Promise<string[]>} featuresOn the switched-on features
 * @property {() => number} now
 */
/**
 * One part of the import: its collections, its part of `finish` and its verification sums.
 * @typedef {object} ImportPart
 * @property {Record<string, import('@ss/app-kit').ImportCollection>} collections
 * @property {(ctx: any) => Promise<Record<string, unknown>>} finish
 * @property {(ctx: any) => Promise<Record<string, number>>} totals
 */

/**
 * The kit's `imports` option.
 * @param {ImportDeps} deps
 * @returns {import('@ss/app-kit').ImportOptions}
 */
export const createImportOptions = (deps) => {
	const parts = [catalogImports(deps), orderImports(deps)];
	return {
		collections: Object.assign({}, ...parts.map((part) => part.collections)),
		finish: async (ctx) => {
			/** @type {Record<string, unknown>} */
			const summary = {};
			for (const part of parts) Object.assign(summary, await part.finish(ctx));
			return summary;
		},
		totals: async (ctx) => {
			/** @type {Record<string, number>} */
			const sums = {};
			for (const part of parts) Object.assign(sums, await part.totals(ctx));
			return sums;
		},
	};
};
