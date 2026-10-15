/**
 * `ss-import read`: reads a store database **read only** (find and nothing else) and writes, to a local folder, one
 * NDJSON file per target (a product's import collection: the records of every step into it, merged, oldest first),
 * the id map (`idmap.json`: `<source>/<hex>` → the key of the record it became, merged documents pointing at the record
 * they joined), the website's settings when the mapping reads them (`settings.json`) and `manifest.json` (what was
 * read, in import order, with the verification sums; `send` and `verify` work from it). The files make dry runs and
 * diffs possible and re-runs idempotent. A mapping reads no secret (keys and tokens are entered by hand in the products),
 * but the files hold store data: they stay out of the repository.
 *
 * A target's records stay in memory from its first step to its last (merges can reach back), then go to its file.
 * @module
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_KEY, keyTextOf, keyValuesOf } from './keys.js';
import { hexOf, legacyId } from './mapping.js';
import { toNdjson } from './ndjson.js';

/** @typedef {import('./mapping.js').Mapping} Mapping */
/** @typedef {import('./mapping.js').MappingStep} MappingStep */
/**
 * The part of a MongoDB database `read` uses (find only).
 * @typedef {{ collection: (name: string) => { find: (filter: Record<string, unknown>, options?: Record<string, unknown>) => AsyncIterable<Record<string, any>> } }} SourceDb
 */
/**
 * @typedef {object} StepReport
 * @property {string} product
 * @property {string} collection
 * @property {string} source
 * @property {string} file the target's NDJSON file, relative to the folder
 * @property {number} read source documents read
 * @property {number} records records this step added (what the product should hold of it)
 * @property {number} skipped documents the mapping left out
 * @property {number} merged records merged into an earlier one
 */
/**
 * @typedef {object} TargetReport
 * @property {string} product
 * @property {string} collection
 * @property {string[]} key the fields the product finds its records by
 * @property {string} file
 * @property {number} records records in the file
 * @property {string} [countPath]
 */
/**
 * @typedef {{ mapping: string, readAt: string, steps: StepReport[], targets: TargetReport[],
 *   totals: Record<string, Record<string, number>>, settings: string | null }} ReadManifest
 */

/** Name of the manifest `read` writes. */
export const MANIFEST_FILE = 'manifest.json';
/** Name of the id map `read` writes. */
export const IDMAP_FILE = 'idmap.json';
/** Name of the settings `read` writes (when the mapping reads them). */
export const SETTINGS_FILE = 'settings.json';

/** @param {string} file @param {unknown} value */
const writeJson = (file, value) => writeFile(file, `${JSON.stringify(value, null, '\t')}\n`);

/**
 * Read a store database into the folder.
 * @param {{ mapping: Mapping, db: SourceDb, dir: string, now?: () => number }} options
 * @returns {Promise<ReadManifest>}
 */
export const read = async ({ mapping, db, dir, now = Date.now }) => {
	await mkdir(dir, { recursive: true });
	/** @type {Map<string, string>} `<source>/<hex>` → record key */
	const idMap = new Map();
	/** @type {Map<string, Map<string, string>>} table → key → record key */
	const tables = new Map();
	const sourceKey = (/** @type {string} */ source, /** @type {unknown} */ sourceId) => `${source}/${hexOf(sourceId)}`;
	/** @type {import('./mapping.js').MapContext} */
	const ctx = Object.freeze({
		id: legacyId,
		ref: (source, sourceId) => {
			try {
				return idMap.get(sourceKey(source, sourceId)) ?? null;
			} catch {
				return null;
			}
		},
		lookup: (table, key) => tables.get(table)?.get(key) ?? null,
	});

	/**
	 * One target and what it holds while its steps run.
	 * @typedef {{ product: string, collection: string, key: string[], file: string, last: number, countPath?: string,
	 *   records: Map<string, { record: Record<string, unknown>, step: MappingStep }>, merges: Map<string, string> }} Target
	 */
	/** @type {Map<string, Target>} */
	const targets = new Map();
	for (const [index, step] of mapping.steps.entries()) {
		const name = `${step.product}.${step.collection}`;
		const found = targets.get(name);
		if (found) {
			found.last = index;
			found.countPath ??= step.countPath;
		} else
			targets.set(name, {
				product: step.product,
				collection: step.collection,
				key: [...(step.key ?? DEFAULT_KEY)],
				file: `${String(targets.size + 1).padStart(2, '0')}-${name}.ndjson`,
				last: index,
				...(step.countPath ? { countPath: step.countPath } : {}),
				records: new Map(),
				merges: new Map(),
			});
	}

	/**
	 * Everything that points at a record key points at another (a merge kept the newer record's key).
	 * @param {string} from @param {string} to
	 */
	const repoint = (from, to) => {
		for (const map of [idMap, ...tables.values()]) for (const [key, value] of map) if (value === from) map.set(key, to);
	};

	/** @type {Record<string, Record<string, number>>} */
	const totals = {};
	/** @type {StepReport[]} */
	const steps = [];
	for (const [index, step] of mapping.steps.entries()) {
		const target = /** @type {Target} */ (targets.get(`${step.product}.${step.collection}`));
		/** @param {unknown} record */
		const keyOf = (record) => {
			const values = keyValuesOf(record, target.key);
			if (values === null)
				throw new TypeError(
					`${target.file}: the mapping gave a record without ${target.key.join(',') === 'id' ? 'an id' : `its key (${target.key.join(', ')})`}`,
				);
			return keyTextOf(values);
		};
		/** @param {Record<string, unknown>} record @param {Record<string, any>} doc @param {string} key */
		const note = (record, doc, key) => {
			for (const [table, of] of Object.entries(step.lookups ?? {})) {
				const found = of(record, doc);
				if (found === null) continue;
				const entries = tables.get(table) ?? new Map();
				for (const name of [found].flat()) if (!entries.has(name)) entries.set(name, key);
				tables.set(table, entries);
			}
		};
		let readCount = 0;
		let added = 0;
		let skipped = 0;
		let merged = 0;
		for await (const doc of db.collection(step.source).find(step.filter ?? {}, { sort: { _id: 1 } })) {
			readCount += 1;
			const out = step.map(doc, ctx);
			const records = out === null ? [] : Array.isArray(out) ? out : [out];
			if (records.length === 0) {
				skipped += 1;
				continue;
			}
			for (const [position, record] of records.entries()) {
				let key = keyOf(record);
				const mergeKey = step.mergeKey ? step.mergeKey(doc, record) : null;
				const into = mergeKey === null ? undefined : target.merges.get(mergeKey);
				if (into !== undefined) {
					merged += 1;
					if (step.merge) {
						const kept = /** @type {{ record: Record<string, unknown>, step: MappingStep }} */ (target.records.get(into));
						const result = step.merge(kept.record, record, ctx);
						const next = keyOf(result);
						if (next !== into) {
							target.records.delete(into);
							for (const [name, value] of target.merges) if (value === into) target.merges.set(name, next);
							repoint(into, next);
						}
						target.records.set(next, { record: result, step: kept.step });
						key = next;
					} else key = into;
				} else {
					if (target.records.has(key)) throw new TypeError(`${target.file}: two records have the key ${key}`);
					target.records.set(key, { record, step });
					if (mergeKey !== null) target.merges.set(mergeKey, key);
					added += 1;
				}
				const source = sourceKey(step.source, doc._id);
				if (position === 0 && !idMap.has(source)) idMap.set(source, key);
				note(record, doc, key);
			}
		}
		if (index === target.last) {
			const kept = [...target.records.values()];
			for (const { record, step: by } of kept)
				if (by.sums)
					for (const [name, value] of Object.entries(by.sums(record))) {
						const sums = (totals[target.product] ??= {});
						sums[name] = (sums[name] ?? 0) + value;
					}
			await writeFile(path.join(dir, target.file), toNdjson(kept.map((entry) => entry.record)));
			target.records.clear();
			target.merges.clear();
		}
		steps.push({
			product: step.product,
			collection: step.collection,
			source: step.source,
			file: target.file,
			read: readCount,
			records: added,
			skipped,
			merged,
		});
	}
	const settings = mapping.settings ? await mapping.settings(db) : null;
	if (settings) await writeJson(path.join(dir, SETTINGS_FILE), settings);
	/** @type {ReadManifest} */
	const manifest = {
		mapping: mapping.name,
		readAt: new Date(now()).toISOString(),
		steps,
		targets: [...targets.values()].map((target) => ({
			product: target.product,
			collection: target.collection,
			key: target.key,
			file: target.file,
			records: steps.filter((step) => step.file === target.file).reduce((sum, step) => sum + step.records, 0),
			...(target.countPath ? { countPath: target.countPath } : {}),
		})),
		totals,
		settings: settings ? SETTINGS_FILE : null,
	};
	await writeJson(path.join(dir, IDMAP_FILE), Object.fromEntries(idMap));
	await writeJson(path.join(dir, MANIFEST_FILE), manifest);
	return manifest;
};
