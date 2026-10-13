/**
 * `ss-import send`: posts what `read` wrote to the products (PLAN 0.8.10 K10), in import order, with each product's
 * server token. First the website's settings and lists (`settings.json` and the per-store table, through the settings
 * API, K1; see `settings.js`), then each target's file to `POST <product>/v1/import/<collection>` (`?dryRun=1` for a
 * dry run), NDJSON cut into calls of at most 1,000 records and 4 MB. A failed record is reported with its file line;
 * nothing stops on it. With `prune` (the final pass, IMP-22), each target then sends the keys of every record it holds
 * — sorted, at most 1,000 a call, each call a range of keys — to `POST <product>/v1/import/<collection>/prune`, so the
 * records an import wrote earlier and the store deleted since go too (a dry run says which). After a real run,
 * `POST <product>/v1/import/finish` recomputes each product's derived values. Re-runs are safe: the products find
 * records by their keys. `only` sends some targets (`<product>.<collection>`; pre-imports before the freeze).
 * @module
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { IMPORT_LIMITS } from '@ss/contracts';
import { callProduct, targetOf } from './http.js';
import { compareKeyTexts, keyPayloadOf, keyTextOf, keyValuesOf } from './keys.js';
import { MANIFEST_FILE } from './read.js';
import { chunk, linesOf } from './ndjson.js';
import { applySettings, mergePlans } from './settings.js';

/** @typedef {import('./read.js').ReadManifest} ReadManifest */
/** @typedef {import('./read.js').TargetReport} TargetReport */
/** @typedef {import('./http.js').ProductTarget} ProductTarget */
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
 * @property {{ removed: number, keys: string[] }} [pruned] what prune removed (or would remove on a dry run); `keys`:
 *   the first 1,000
 */
/**
 * @typedef {{ dryRun: boolean, ok: boolean, settings: import('./settings.js').SettingsReport, steps: SendStep[],
 *   finished: Array<{ product: string, summary: Record<string, unknown> }> }} SendReport
 */

/** Most removed keys a report lists per target. */
const LISTED_KEYS = 1000;

/**
 * Read the folder's manifest.
 * @param {string} dir
 * @returns {Promise<ReadManifest>}
 */
export const readManifest = async (dir) => JSON.parse(await readFile(path.join(dir, MANIFEST_FILE), 'utf8'));

/** @param {number} ms */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The prune calls of a target: the keys of its records sorted and cut into ranges (the first from the start, the last to
 * the end; one call with nothing to keep when the file is empty).
 * @param {TargetReport} target
 * @param {Array<{ text: string }>} lines
 * @returns {Array<Record<string, unknown>>}
 */
export const pruneCalls = (target, lines) => {
	/** @type {Map<string, string | number | Record<string, string | number>>} */
	const keys = new Map();
	for (const { text } of lines) {
		const values = keyValuesOf(JSON.parse(text), target.key);
		if (values !== null) keys.set(keyTextOf(values), keyPayloadOf(target.key, values));
	}
	const sorted = [...keys.keys()].sort(compareKeyTexts);
	if (sorted.length === 0) return [{ keep: [] }];
	/** @type {Array<Record<string, unknown>>} */
	const calls = [];
	for (let start = 0; start < sorted.length; start += IMPORT_LIMITS.records) {
		const part = sorted.slice(start, start + IMPORT_LIMITS.records);
		const end = start + part.length;
		calls.push({
			keep: part.map((text) => keys.get(text)),
			...(start > 0 ? { after: keys.get(/** @type {string} */ (sorted[start - 1])) } : {}),
			...(end < sorted.length ? { through: keys.get(/** @type {string} */ (part.at(-1))) } : {}),
		});
	}
	return calls;
};

/**
 * Send the folder's settings and files to the products.
 * @param {{ dir: string, products: Record<string, ProductTarget>, dryRun?: boolean, prune?: boolean,
 *   only?: ReadonlyArray<string>, settings?: import('./mapping.js').SettingsPlan, fetch?: typeof globalThis.fetch,
 *   sleep?: (ms: number) => Promise<void> }} options `settings`: the per-store table, over what `read` took
 * @returns {Promise<SendReport>}
 */
export const send = async ({
	dir,
	products,
	dryRun = false,
	prune = false,
	only,
	settings,
	fetch = globalThis.fetch,
	sleep = wait,
}) => {
	const manifest = await readManifest(dir);
	const targets = manifest.targets.filter((target) => !only || only.includes(`${target.product}.${target.collection}`));
	for (const target of targets) targetOf(products, target.product);
	const read = manifest.settings ? JSON.parse(await readFile(path.join(dir, manifest.settings), 'utf8')) : null;
	const chosen = new Set(targets.map((target) => target.product));
	const plan = Object.fromEntries(
		Object.entries(mergePlans([read, settings])).filter(([product]) => !only || chosen.has(product)),
	);
	const settingsReport = await applySettings({ plan, products, dryRun, fetch, sleep });
	/** @type {SendStep[]} */
	const steps = [];
	for (const target of targets) {
		const product = targetOf(products, target.product);
		const lines = linesOf(await readFile(path.join(dir, target.file), 'utf8'));
		const calls = chunk(lines);
		/** @type {SendStep} */
		const report = {
			product: target.product,
			collection: target.collection,
			file: target.file,
			calls: calls.length,
			inserted: 0,
			updated: 0,
			failed: [],
		};
		for (const call of calls) {
			const answer = await callProduct(fetch, product, 'POST', `/v1/import/${target.collection}${dryRun ? '?dryRun=1' : ''}`, {
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
		if (prune) {
			const pruned = { removed: 0, keys: /** @type {string[]} */ ([]) };
			for (const body of pruneCalls(target, lines))
				for (;;) {
					const answer = await callProduct(
						fetch,
						product,
						'POST',
						`/v1/import/${target.collection}/prune${dryRun ? '?dryRun=1' : ''}`,
						{ body: JSON.stringify(body), type: 'application/json' },
					);
					pruned.removed += Number(answer?.removed ?? 0);
					for (const key of Array.isArray(answer?.keys) ? answer.keys : [])
						if (pruned.keys.length < LISTED_KEYS) pruned.keys.push(String(key));
					if (dryRun || answer?.more !== true) break;
				}
			report.pruned = pruned;
		}
		steps.push(report);
	}
	/** @type {SendReport['finished']} */
	const finished = [];
	if (!dryRun)
		for (const name of chosen)
			finished.push({
				product: name,
				summary: (await callProduct(fetch, targetOf(products, name), 'POST', '/v1/import/finish')) ?? {},
			});
	return {
		dryRun,
		ok: steps.every((step) => step.failed.length === 0) && settingsReport.refused.length === 0,
		settings: settingsReport,
		steps,
		finished,
	};
};
