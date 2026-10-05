/**
 * Sweeping stale presigned uploads (PLAN item 10e). A product that hands out presigned PUT slots keeps one record per
 * slot in the merchant's database (`data.forWebsite(...).collection(...)`). A slot that is never confirmed would leave
 * its object in the merchant's bucket forever once a TTL index removed the record, so the product marks each pending
 * record with a "stale at" date and a cron calls `sweepStaleUploads` per website: it deletes the object (when present)
 * and then the record (or marks it), bounded per run and safe to repeat.
 *
 * Pure: the collection, the storage connector and the clock are injected. Keys are the storage connector's relative
 * keys. Expected failures (storage down, a record that changed under us) are counted, never thrown.
 * @module
 */
import { isObject, kitError } from './util.js';

export const SWEEP_DEFAULT_LIMIT = 100;
export const SWEEP_MAX_LIMIT = 1000;

/**
 * @typedef {object} SweepStorage the part of the storage connector the sweep uses (relative keys)
 * @property {(input: { key: string }) => Promise<{ exists: boolean }>} headObject
 * @property {(input: { key: string }) => Promise<unknown>} deleteObject
 */

/**
 * @typedef {object} SweepCollection a guarded collection of `data.forWebsite(websiteId)` (or anything shaped like it)
 * @property {(filter: Record<string, unknown>, options?: Record<string, unknown>) => { toArray: () => Promise<any[]> }} find
 * @property {(filter: Record<string, unknown>) => Promise<{ deletedCount?: number }>} deleteOne
 * @property {(filter: Record<string, unknown>, update: Record<string, unknown>) => Promise<{ modifiedCount?: number }>} updateOne
 */

/**
 * @typedef {object} SweepResult
 * @property {number} scanned stale records read this run
 * @property {number} deleted records whose object existed and was deleted
 * @property {number} missing records that had no object (never uploaded, or already gone)
 * @property {number} failed records left for the next run (storage or database error)
 */

/**
 * @typedef {object} SweepInput
 * @property {SweepCollection} collection guarded collection holding one record per upload slot
 * @property {string} websiteId the website the collection is scoped to (pinned in every filter)
 * @property {SweepStorage | (() => Promise<SweepStorage>)} storage the storage connector, or a function resolving it (only
 *   called when there is something to sweep)
 * @property {() => number} [now] clock (ms)
 * @property {number} [olderThanMs] grace after the stale date before a record is swept (default 0)
 * @property {string} [field] the record's "stale at" date field (default `staleAt`)
 * @property {Record<string, unknown>} [filter] extra conditions, e.g. `{ status: 'pending' }`
 * @property {(record: any) => string | null | undefined} [keyOf] relative object key of a record (default `record.key`)
 * @property {number} [limit] records per run (default 100, at most 1000)
 * @property {Record<string, unknown> | null} [mark] `$set` applied instead of deleting the record (the stale field is
 *   removed so the record is not swept again)
 * @property {(record: any, outcome: { existed: boolean }) => void | Promise<void>} [onDeleted] after each cleaned record
 * @property {(record: any | null, error: unknown) => void} [onError] on each failure (record null: storage unresolved)
 */

/** @param {unknown} error */
const ignore = (error) => {
	void error;
};

/**
 * Delete the objects and records of stale presigned uploads of one website.
 * @param {SweepInput} input
 * @returns {Promise<SweepResult>}
 */
export const sweepStaleUploads = async ({
	collection,
	websiteId,
	storage,
	now = Date.now,
	olderThanMs = 0,
	field = 'staleAt',
	filter = {},
	keyOf = (record) => record?.key,
	limit = SWEEP_DEFAULT_LIMIT,
	mark = null,
	onDeleted = () => {},
	onError = ignore,
}) => {
	if (!collection || typeof collection.find !== 'function') throw kitError('invalid_argument', 'collection is required');
	if (typeof websiteId !== 'string' || websiteId.length === 0) throw kitError('invalid_argument', 'websiteId is required');
	if (!storage) throw kitError('invalid_argument', 'storage is required');
	if (typeof field !== 'string' || field.length === 0 || field === 'websiteId')
		throw kitError('invalid_argument', 'field must name the stale date field');
	if (!isObject(filter) || 'websiteId' in filter || field in filter)
		throw kitError('invalid_argument', 'filter may not set websiteId or the stale field');
	if (!Number.isFinite(olderThanMs) || olderThanMs < 0) throw kitError('invalid_argument', 'olderThanMs must be ≥ 0');
	if (mark !== null && (!isObject(mark) || 'websiteId' in mark || field in mark))
		throw kitError('invalid_argument', 'mark may not set websiteId or the stale field');
	const bound = Math.min(Math.max(1, Math.trunc(Number(limit) || SWEEP_DEFAULT_LIMIT)), SWEEP_MAX_LIMIT);

	const cutoff = new Date(now() - olderThanMs);
	const query = { ...filter, websiteId, [field]: { $lte: cutoff } };
	const records = await collection.find(query, { sort: { [field]: 1 }, limit: bound }).toArray();
	/** @type {SweepResult} */
	const result = { scanned: records.length, deleted: 0, missing: 0, failed: 0 };
	if (records.length === 0) return result;

	/** @type {SweepStorage} */
	let bucket;
	try {
		bucket = typeof storage === 'function' ? await storage() : storage;
	} catch (error) {
		onError(null, error);
		return { ...result, failed: records.length };
	}

	/**
	 * Delete the object (when present), then the record (or mark it).
	 * @param {any} record
	 * @returns {Promise<boolean>} whether the object existed
	 */
	const cleanOne = async (record) => {
		const key = keyOf(record);
		let existed = false;
		if (typeof key === 'string' && key.length > 0) {
			existed = (await bucket.headObject({ key })).exists === true;
			if (existed) await bucket.deleteObject({ key });
		}
		// compare-and-set: only a record that is still stale (and still matches the filter) is removed
		const same = { ...query, _id: record._id };
		if (mark) await collection.updateOne(same, { $set: { ...mark }, $unset: { [field]: '' } });
		else await collection.deleteOne(same);
		return existed;
	};

	for (const record of records) {
		/** @type {boolean} */
		let existed;
		try {
			existed = await cleanOne(record);
		} catch (error) {
			result.failed += 1;
			onError(record, error);
			continue;
		}
		if (existed) result.deleted += 1;
		else result.missing += 1;
		try {
			await onDeleted(record, { existed });
		} catch (error) {
			onError(record, error);
		}
	}
	return result;
};
