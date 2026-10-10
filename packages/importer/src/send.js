/**
 * `ss-import send`: posts the files `read` wrote to the products' import routes (PLAN 0.8.10 K10), in import order,
 * with each product's server token: `POST <product>/v1/import/<collection>` (`?dryRun=1` for a dry run), NDJSON cut
 * into calls of at most 1,000 records and 4 MB. A failed record is reported with its file line; nothing stops on it.
 * After a real run, `POST <product>/v1/import/finish` recomputes each product's derived values. Re-runs are safe: the
 * products upsert by the given ids.
 * @module
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { MANIFEST_FILE } from './read.js';
import { chunk, linesOf } from './ndjson.js';

/** @typedef {import('./read.js').ReadManifest} ReadManifest */
/** @typedef {{ url: string, token: string }} ProductTarget the product's address and the website's server token */
/** @typedef {{ line: number, id: string | null, errors: Array<{ path: string, message: string }> }} FailedRecord */
/**
 * @typedef {object} SendStep
 * @property {string} product
 * @property {string} collection
 * @property {string} file
 * @property {number} calls
 * @property {number} inserted
 * @property {number} updated
 * @property {FailedRecord[]} failed lines of the file
 */
/** @typedef {{ dryRun: boolean, ok: boolean, steps: SendStep[], finished: Array<{ product: string, summary: Record<string, unknown> }> }} SendReport */

/**
 * An answer a product refused (not a failed record: the whole call).
 * @param {string} message
 * @param {Record<string, unknown>} details
 */
const importError = (message, details) => Object.assign(new Error(message), { name: 'ImportError', details });

/**
 * Read the folder's manifest.
 * @param {string} dir
 * @returns {Promise<ReadManifest>}
 */
export const readManifest = async (dir) => JSON.parse(await readFile(path.join(dir, MANIFEST_FILE), 'utf8'));

/**
 * The target of a product, or a clear error.
 * @param {Record<string, ProductTarget>} products
 * @param {string} product
 */
export const targetOf = (products, product) => {
	const target = products[product];
	if (!target) throw importError(`No address or server token for ${product}.`, { product });
	return target;
};

/**
 * A JSON call to a product with its server token.
 * @param {typeof globalThis.fetch} fetch
 * @param {ProductTarget} target
 * @param {string} method
 * @param {string} route
 * @param {{ body?: string, type?: string }} [init]
 */
export const callProduct = async (fetch, target, method, route, { body, type } = {}) => {
	const response = await fetch(`${target.url.replace(/\/+$/, '')}${route}`, {
		method,
		headers: {
			authorization: `Bearer ${target.token}`,
			accept: 'application/json',
			...(type ? { 'content-type': type } : {}),
		},
		...(body === undefined ? {} : { body }),
	});
	const text = await response.text();
	/** @type {any} */
	let json = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		json = null;
	}
	if (!response.ok)
		throw importError(`${method} ${route} answered ${response.status}${json?.detail ? `: ${json.detail}` : ''}`, {
			status: response.status,
			problem: json,
		});
	return json;
};

/**
 * Send the folder's files to the products.
 * @param {{ dir: string, products: Record<string, ProductTarget>, dryRun?: boolean, fetch?: typeof globalThis.fetch }} options
 * @returns {Promise<SendReport>}
 */
export const send = async ({ dir, products, dryRun = false, fetch = globalThis.fetch }) => {
	const manifest = await readManifest(dir);
	for (const step of manifest.steps) targetOf(products, step.product);
	/** @type {SendStep[]} */
	const steps = [];
	for (const step of manifest.steps) {
		const target = targetOf(products, step.product);
		const calls = chunk(linesOf(await readFile(path.join(dir, step.file), 'utf8')));
		/** @type {SendStep} */
		const report = {
			product: step.product,
			collection: step.collection,
			file: step.file,
			calls: calls.length,
			inserted: 0,
			updated: 0,
			failed: [],
		};
		for (const call of calls) {
			const answer = await callProduct(fetch, target, 'POST', `/v1/import/${step.collection}${dryRun ? '?dryRun=1' : ''}`, {
				body: call.body,
				type: 'application/x-ndjson',
			});
			report.inserted += Number(answer?.inserted ?? 0);
			report.updated += Number(answer?.updated ?? 0);
			for (const failed of Array.isArray(answer?.failed) ? answer.failed : [])
				report.failed.push({
					line: call.lines[failed.line - 1] ?? failed.line,
					id: failed.id ?? null,
					errors: failed.errors ?? [],
				});
		}
		steps.push(report);
	}
	/** @type {SendReport['finished']} */
	const finished = [];
	if (!dryRun)
		for (const product of [...new Set(manifest.steps.map((step) => step.product))])
			finished.push({
				product,
				summary: (await callProduct(fetch, targetOf(products, product), 'POST', '/v1/import/finish')) ?? {},
			});
	return { dryRun, ok: steps.every((step) => step.failed.length === 0), steps, finished };
};
