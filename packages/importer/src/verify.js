/**
 * `ss-import verify` (PLAN 0.8.10 Migration, cut-over step 6): compares what `read` found with what each product holds.
 * Per target: the records read with the records an import wrote and the product holds (`GET <product>/v1/import/status`
 * `imported`; after a final pass with prune they are equal) and, where the mapping names one, the product's count
 * route (K4), which must equal the records the product holds (`collections`). Per product: the verification sums the mapping's steps added up (order totals per status, stock units,
 * points balances …) with the product's own (`status.totals`).
 * @module
 */
import { callProduct, targetOf } from './http.js';
import { readManifest } from './send.js';

/** @typedef {import('./http.js').ProductTarget} ProductTarget */
/**
 * @typedef {object} VerifyStep
 * @property {string} product
 * @property {string} collection
 * @property {number} expected records `read` wrote
 * @property {number | null} imported records an import wrote that the product holds
 * @property {number | null} stored every record of the collection (the merchant's own too)
 * @property {number | null} counted the product's count route, when the mapping names one
 * @property {boolean} match
 */
/** @typedef {{ product: string, key: string, expected: number, actual: number | null, match: boolean }} VerifyTotal */
/** @typedef {{ ok: boolean, steps: VerifyStep[], totals: VerifyTotal[] }} VerifyReport */

/**
 * @param {{ dir: string, products: Record<string, ProductTarget>, fetch?: typeof globalThis.fetch }} options
 * @returns {Promise<VerifyReport>}
 */
export const verify = async ({ dir, products, fetch = globalThis.fetch }) => {
	const manifest = await readManifest(dir);
	/** @type {Map<string, { collections: Record<string, number>, imported: Record<string, number>, totals: Record<string, number> }>} */
	const statuses = new Map();
	/** @param {string} product */
	const statusOf = async (product) => {
		const found = statuses.get(product);
		if (found) return found;
		const status = await callProduct(fetch, targetOf(products, product), 'GET', '/v1/import/status');
		const read = {
			collections: status?.collections ?? {},
			imported: status?.imported ?? {},
			totals: status?.totals ?? {},
		};
		statuses.set(product, read);
		return read;
	};
	/** @param {unknown} value */
	const countOf = (value) => (typeof value === 'number' ? value : null);
	/** @type {VerifyStep[]} */
	const steps = [];
	for (const target of manifest.targets) {
		const status = await statusOf(target.product);
		const stored = countOf(status.collections[target.collection]);
		const imported = countOf(status.imported[target.collection]);
		const counted = target.countPath
			? Number((await callProduct(fetch, targetOf(products, target.product), 'GET', target.countPath))?.count)
			: null;
		steps.push({
			product: target.product,
			collection: target.collection,
			expected: target.records,
			imported,
			stored,
			counted,
			// the count route counts what the product holds (the merchant's own records and the staff member who runs the
			// migration too): it must equal the records the product says it holds
			match: imported === target.records && (counted === null || counted === (stored ?? target.records)),
		});
	}
	/** @type {VerifyTotal[]} */
	const totals = [];
	for (const [product, sums] of Object.entries(manifest.totals ?? {})) {
		const status = await statusOf(product);
		for (const [key, expected] of Object.entries(sums)) {
			const actual = countOf(status.totals[key]);
			totals.push({ product, key, expected, actual, match: actual === expected });
		}
	}
	return { ok: steps.every((step) => step.match) && totals.every((total) => total.match), steps, totals };
};
