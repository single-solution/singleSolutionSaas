/**
 * `ss-import read`: reads a store database **read only** (find and nothing else) and writes, to a local folder, one
 * NDJSON file per mapping step (the records in the product's own shape, oldest first), the id map (`idmap.json`:
 * `<source>/<hex>` → the record id, merged documents pointing at the record they joined) and `manifest.json` (what was
 * read, in import order; `send` and `verify` work from it). The files make dry runs and diffs possible and re-runs
 * idempotent; secrets that must never touch the disk are sent by Phase 5's mapping straight to the products.
 * @module
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hexOf, legacyId } from './mapping.js';
import { toNdjson } from './ndjson.js';

/** @typedef {import('./mapping.js').Mapping} Mapping */
/**
 * The part of a MongoDB database `read` uses (find only).
 * @typedef {{ collection: (name: string) => { find: (filter: Record<string, unknown>, options?: Record<string, unknown>) => AsyncIterable<Record<string, any>> } }} SourceDb
 */
/**
 * @typedef {object} StepReport
 * @property {string} product
 * @property {string} collection
 * @property {string} source
 * @property {string} file the NDJSON file, relative to the folder
 * @property {number} read source documents read
 * @property {number} records records written (what the product should hold)
 * @property {number} skipped documents the mapping left out
 * @property {number} merged documents merged into an older one
 * @property {string} [countPath]
 */
/** @typedef {{ mapping: string, readAt: string, steps: StepReport[] }} ReadManifest */

/** Name of the manifest `read` writes. */
export const MANIFEST_FILE = 'manifest.json';
/** Name of the id map `read` writes. */
export const IDMAP_FILE = 'idmap.json';

/**
 * Read a store database into the folder.
 * @param {{ mapping: Mapping, db: SourceDb, dir: string, now?: () => number }} options
 * @returns {Promise<ReadManifest>}
 */
export const read = async ({ mapping, db, dir, now = Date.now }) => {
	await mkdir(dir, { recursive: true });
	/** @type {Map<string, string>} */
	const idMap = new Map();
	const keyOf = (/** @type {string} */ source, /** @type {unknown} */ sourceId) => `${source}/${hexOf(sourceId)}`;
	/** @type {import('./mapping.js').MapContext} */
	const ctx = Object.freeze({
		id: legacyId,
		ref: (source, sourceId) => {
			try {
				return idMap.get(keyOf(source, sourceId)) ?? null;
			} catch {
				return null;
			}
		},
	});
	/** @type {StepReport[]} */
	const steps = [];
	for (const [index, step] of mapping.steps.entries()) {
		const file = `${String(index + 1).padStart(2, '0')}-${step.product}.${step.collection}.ndjson`;
		/** @type {unknown[]} */
		const records = [];
		/** @type {Map<string, string>} */
		const kept = new Map();
		let readCount = 0;
		let skipped = 0;
		let merged = 0;
		for await (const doc of db.collection(step.source).find(step.filter ?? {}, { sort: { _id: 1 } })) {
			readCount += 1;
			const key = step.mergeKey ? step.mergeKey(doc) : null;
			const into = key === null ? undefined : kept.get(key);
			if (into !== undefined) {
				idMap.set(keyOf(step.source, doc._id), into);
				merged += 1;
				continue;
			}
			const record = step.map(doc, ctx);
			if (record === null) {
				skipped += 1;
				continue;
			}
			if (typeof record.id !== 'string') throw new TypeError(`${file}: the mapping gave a record without an id`);
			idMap.set(keyOf(step.source, doc._id), record.id);
			if (key !== null) kept.set(key, record.id);
			records.push(record);
		}
		await writeFile(path.join(dir, file), toNdjson(records));
		steps.push({
			product: step.product,
			collection: step.collection,
			source: step.source,
			file,
			read: readCount,
			records: records.length,
			skipped,
			merged,
			...(step.countPath ? { countPath: step.countPath } : {}),
		});
	}
	/** @type {ReadManifest} */
	const manifest = { mapping: mapping.name, readAt: new Date(now()).toISOString(), steps };
	await writeFile(path.join(dir, IDMAP_FILE), `${JSON.stringify(Object.fromEntries(idMap), null, '\t')}\n`);
	await writeFile(path.join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, '\t')}\n`);
	return manifest;
};
