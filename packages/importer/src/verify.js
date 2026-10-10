/**
 * `ss-import verify`: compares what `read` found with what each product holds: the record count of every import
 * collection (`GET <product>/v1/import/status`) and, where the mapping names one, the product's count route (K4).
 * @module
 */
import { callProduct, readManifest, targetOf } from './send.js';

/** @typedef {import('./send.js').ProductTarget} ProductTarget */
/**
 * @typedef {object} VerifyStep
 * @property {string} product
 * @property {string} collection
 * @property {number} expected records `read` wrote
 * @property {number | null} imported the product's import status
 * @property {number | null} counted the product's count route, when the mapping names one
 * @property {boolean} match
 */
/** @typedef {{ ok: boolean, steps: VerifyStep[] }} VerifyReport */

/**
 * @param {{ dir: string, products: Record<string, ProductTarget>, fetch?: typeof globalThis.fetch }} options
 * @returns {Promise<VerifyReport>}
 */
export const verify = async ({ dir, products, fetch = globalThis.fetch }) => {
	const manifest = await readManifest(dir);
	/** @type {Map<string, Record<string, number>>} */
	const statuses = new Map();
	/** @type {VerifyStep[]} */
	const steps = [];
	for (const step of manifest.steps) {
		const target = targetOf(products, step.product);
		if (!statuses.has(step.product)) {
			const status = await callProduct(fetch, target, 'GET', '/v1/import/status');
			statuses.set(step.product, status?.collections ?? {});
		}
		const imported = statuses.get(step.product)?.[step.collection];
		const counted = step.countPath ? Number((await callProduct(fetch, target, 'GET', step.countPath))?.count) : null;
		const importedCount = typeof imported === 'number' ? imported : null;
		steps.push({
			product: step.product,
			collection: step.collection,
			expected: step.records,
			imported: importedCount,
			counted,
			match: importedCount === step.records && (counted === null || counted === step.records),
		});
	}
	return { ok: steps.every((step) => step.match), steps };
};
