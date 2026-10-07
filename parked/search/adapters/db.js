/**
 * Repositories over the merchant's own database (Part E §7), reached through app-kit `data.forWebsite(websiteId)`:
 * collections are prefixed `ss_search_`, every query pins `websiteId` (app-kit's tenant guard rejects any that does
 * not) and every index starts with `websiteId`.
 *
 * - `documents`: the index. One document per searchable item with its fields, the terms of every searchable field
 *   (`fieldTerms`) and their union `terms` — the multikey index `{ websiteId, terms }` is the portable engine's
 *   inverted index — plus `suggest` (Atlas autocomplete text). Atlas Search indexes this same collection.
 * - `terms`: the vocabulary (`df` documents with the term, `pdf` documents with it in a public field) with trigrams
 *   for typo candidates; prefix completions are range scans on `{ websiteId, term }`.
 * - `queries`: analytics, one row per website, day and normalised query (counts only), expiring with the retention.
 * - `counters`: daily indexing quota counters (expiring).
 * - `crawls`: the state of each crawled source (progress, last result).
 * - `engine`: the Atlas Search state shown in the dashboard.
 * @module
 */
import { HIT_PROJECTION } from '../core/atlas.js';
import { trigrams } from '../core/text.js';

export const SCHEMA_VERSION = 1;

export const COLLECTIONS = Object.freeze({
	documents: 'documents',
	terms: 'terms',
	queries: 'queries',
	counters: 'counters',
	crawls: 'crawls',
	engine: 'engine',
});

/**
 * Index definitions (websiteId first, TTL indexes single-field), created idempotently by app-kit on first use.
 * @type {Array<{ collection: string, keys: Record<string, 1 | -1>, name: string, unique?: boolean, expireAfterSeconds?: number }>}
 */
export const INDEXES = [
	{ collection: 'documents', keys: { websiteId: 1, id: 1 }, name: 'website_id', unique: true },
	{ collection: 'documents', keys: { websiteId: 1, terms: 1 }, name: 'website_terms' },
	{ collection: 'documents', keys: { websiteId: 1, status: 1, updatedAt: -1 }, name: 'website_recent' },
	{ collection: 'documents', keys: { websiteId: 1, source: 1, crawlRun: 1 }, name: 'website_source' },
	{ collection: 'terms', keys: { websiteId: 1, term: 1 }, name: 'website_term', unique: true },
	{ collection: 'terms', keys: { websiteId: 1, grams: 1 }, name: 'website_grams' },
	{ collection: 'queries', keys: { websiteId: 1, day: 1, q: 1 }, name: 'website_day_query', unique: true },
	{ collection: 'queries', keys: { expireAt: 1 }, name: 'expire', expireAfterSeconds: 0 },
	{ collection: 'counters', keys: { websiteId: 1, key: 1 }, name: 'website_key', unique: true },
	{ collection: 'counters', keys: { expireAt: 1 }, name: 'expire', expireAfterSeconds: 0 },
	{ collection: 'crawls', keys: { websiteId: 1, key: 1 }, name: 'website_key', unique: true },
	{ collection: 'engine', keys: { websiteId: 1, key: 1 }, name: 'website_key', unique: true },
];

/** @type {Array<{ version: number, name: string, up: (scope: any) => Promise<void> }>} */
export const MIGRATIONS = [];

/** Fields the repositories never return. */
const INTERNAL = new Set(['_id', 'websiteId', 'merchantId', 'env', 'schemaVersion']);

/**
 * @param {Record<string, any> | null} doc
 * @returns {any}
 */
export const strip = (doc) => (doc ? Object.fromEntries(Object.entries(doc).filter(([key]) => !INTERNAL.has(key))) : null);

/** @param {unknown} error */
export const isDuplicateKey = (error) => /** @type {{ code?: number }} */ (error)?.code === 11000;

/**
 * @typedef {object} Scope app-kit website data scope (guarded collections)
 * @property {string} websiteId
 * @property {(name: string) => any} collection
 */

/** Vocabulary entries read per lookup. */
const VOCABULARY_SCAN = 200;

/**
 * Repositories of one website.
 * @param {Scope} scope
 * @param {{ now?: () => number, stamp?: { merchantId?: string, env?: string } }} [options]
 */
export const createRepositories = (scope, { now = Date.now, stamp = {} } = {}) => {
	const { websiteId } = scope;
	const at = () => new Date(now());
	const documents = scope.collection(COLLECTIONS.documents);
	const terms = scope.collection(COLLECTIONS.terms);
	const queries = scope.collection(COLLECTIONS.queries);
	const counters = scope.collection(COLLECTIONS.counters);
	const crawls = scope.collection(COLLECTIONS.crawls);
	const engine = scope.collection(COLLECTIONS.engine);
	const insertStamp = {
		...(stamp.merchantId ? { merchantId: stamp.merchantId } : {}),
		...(stamp.env ? { env: stamp.env } : {}),
	};
	/** @param {any[]} rows */
	const vocabulary = (rows) =>
		rows.map((row) => ({ term: String(row.term), df: Number(row.df ?? 0), pdf: Number(row.pdf ?? 0) }));

	/**
	 * Add or remove terms from the vocabulary counters (one bulk update per direction; new terms inserted, races on
	 * insert resolved by an increment).
	 * @param {string[]} list
	 * @param {readonly string[]} publicList
	 * @param {1 | -1} by
	 */
	const count = async (list, publicList, by) => {
		if (list.length === 0) return;
		const pub = new Set(publicList);
		const privateOnly = list.filter((term) => !pub.has(term));
		const publicTerms = list.filter((term) => pub.has(term));
		if (by === 1) {
			const existing = new Set(
				(await terms.find({ websiteId, term: { $in: list } }, { projection: { term: 1 } }).toArray()).map(
					(/** @type {any} */ row) => row.term,
				),
			);
			const fresh = list.filter((term) => !existing.has(term));
			if (fresh.length > 0) {
				try {
					await terms.insertMany(
						fresh.map((term) => ({ term, df: 0, pdf: 0, len: [...term].length, grams: trigrams(term), ...insertStamp })),
						{ ordered: false },
					);
				} catch (error) {
					if (!isDuplicateKey(error) && !(/** @type {any} */ (error)?.writeErrors)) throw error;
				}
			}
		}
		if (publicTerms.length > 0)
			await terms.updateMany({ websiteId, term: { $in: publicTerms } }, { $inc: { df: by, pdf: by } });
		if (privateOnly.length > 0) await terms.updateMany({ websiteId, term: { $in: privateOnly } }, { $inc: { df: by } });
	};

	return Object.freeze({
		websiteId,
		documents: Object.freeze({
			/** @param {string} id */
			get: async (id) => strip(await documents.findOne({ websiteId, id })),
			/** Active documents by id (for pinned results). @param {string[]} ids */
			activeByIds: async (ids) =>
				ids.length === 0
					? []
					: (
							await documents
								.find({ websiteId, id: { $in: ids }, status: 'active' }, { projection: HIT_PROJECTION })
								.toArray()
						).map(strip),
			/**
			 * Create or replace a document; returns the previous terms (null when new).
			 * @param {Record<string, any>} doc analysed document (without the tenant fields)
			 * @returns {Promise<{ terms: string[], publicTerms: string[] } | null>}
			 */
			upsert: async (doc) => {
				const { id, ...rest } = doc;
				const fields = Object.fromEntries(Object.entries(rest).filter(([key]) => key !== 'createdAt'));
				const previous = await documents.findOneAndUpdate(
					{ websiteId, id },
					{ $set: { ...fields, id }, $setOnInsert: { createdAt: at(), schemaVersion: SCHEMA_VERSION, ...insertStamp } },
					{ upsert: true, returnDocument: 'before', projection: { terms: 1, publicTerms: 1 } },
				);
				return previous ? { terms: previous.terms ?? [], publicTerms: previous.publicTerms ?? [] } : null;
			},
			/** @param {string} id @returns {Promise<{ terms: string[], publicTerms: string[] } | null>} */
			remove: async (id) => {
				const previous = await documents.findOneAndDelete({ websiteId, id }, { projection: { terms: 1, publicTerms: 1 } });
				return previous ? { terms: previous.terms ?? [], publicTerms: previous.publicTerms ?? [] } : null;
			},
			/** @param {Record<string, unknown>} [filter] */
			count: async (filter = {}) => documents.countDocuments({ ...filter, websiteId }),
			/**
			 * A page of documents ordered by id.
			 * @param {{ after?: string | null, limit: number, type?: string | null, source?: string | null }} query
			 */
			list: async ({ after = null, limit, type = null, source = null }) =>
				(
					await documents
						.find(
							{
								websiteId,
								...(after ? { id: { $gt: after } } : {}),
								...(type ? { type } : {}),
								...(source ? { source } : {}),
							},
							{ projection: { ...HIT_PROJECTION, status: 1, createdAt: 1 } },
						)
						.sort({ id: 1 })
						.limit(limit)
						.toArray()
				).map(strip),
			/**
			 * Candidates of the portable engine: active documents of the searched types containing any of the terms.
			 * @param {{ terms: string[], types: string[], limit: number }} query
			 */
			candidates: async ({ terms: list, types, limit }) =>
				list.length === 0
					? []
					: (
							await documents
								.find(
									{ websiteId, terms: { $in: list }, status: 'active', type: { $in: types } },
									{ projection: { ...HIT_PROJECTION, fieldTerms: 1 } },
								)
								.limit(limit)
								.toArray()
						).map(strip),
			/** Recently updated active documents. @param {{ types: string[], limit: number }} query */
			recent: async ({ types, limit }) =>
				(
					await documents
						.find({ websiteId, status: 'active', type: { $in: types } }, { projection: HIT_PROJECTION })
						.sort({ status: 1, updatedAt: -1 })
						.limit(limit)
						.toArray()
				).map(strip),
			/**
			 * Documents of a source left from earlier crawl runs.
			 * @param {string} source
			 * @param {string} run
			 * @param {number} limit
			 */
			staleOf: async (source, run, limit) =>
				(
					await documents
						.find({ websiteId, source, crawlRun: { $ne: run } }, { projection: { id: 1 } })
						.limit(limit)
						.toArray()
				).map((/** @type {any} */ row) => String(row.id)),
			/** Raw collection handle for the Atlas engine (see adapters/atlas.js). */
			guarded: documents,
		}),
		vocabulary: Object.freeze({
			/** @param {string[]} list */
			lookup: async (list) =>
				list.length === 0
					? []
					: vocabulary(
							await terms
								.find({ websiteId, term: { $in: list } }, { projection: { term: 1, df: 1, pdf: 1 } })
								.limit(VOCABULARY_SCAN)
								.toArray(),
						),
			/** Terms starting with a prefix (index range scan). @param {string} prefix @param {{ publicOnly: boolean }} options */
			prefixed: async (prefix, { publicOnly }) =>
				prefix === ''
					? []
					: vocabulary(
							await terms
								.find(
									{
										websiteId,
										term: { $gte: prefix, $lt: `${prefix}￿` },
										...(publicOnly ? { pdf: { $gt: 0 } } : { df: { $gt: 0 } }),
									},
									{ projection: { term: 1, df: 1, pdf: 1 } },
								)
								.sort({ term: 1 })
								.limit(VOCABULARY_SCAN)
								.toArray(),
						),
			/**
			 * Terms sharing the most trigrams with a word, within the length window of its typo budget (longer words too
			 * when the word is still being typed).
			 * @param {string} term
			 * @param {number} edits
			 * @param {{ publicOnly: boolean, limit: number, prefix?: boolean }} options
			 */
			similar: async (term, edits, { publicOnly, limit, prefix = false }) => {
				const grams = trigrams(term);
				const length = [...term].length;
				return vocabulary(
					await terms
						.aggregate([
							{
								$match: {
									websiteId,
									grams: { $in: grams },
									len: { $gte: Math.max(1, length - edits), $lte: length + edits + (prefix ? 20 : 0) },
									...(publicOnly ? { pdf: { $gt: 0 } } : { df: { $gt: 0 } }),
								},
							},
							{ $limit: 5000 },
							{ $project: { _id: 0, term: 1, df: 1, pdf: 1, shared: { $size: { $setIntersection: ['$grams', grams] } } } },
							{ $sort: { shared: -1, df: -1, term: 1 } },
							{ $limit: limit },
						])
						.toArray(),
				);
			},
			/** @param {ReturnType<typeof import('../core/indexing.js').vocabularyChange>} change */
			apply: async (change) => {
				await count(change.add, change.addPublic, 1);
				await count(change.remove, change.removePublic, -1);
				// terms no document uses any more leave the vocabulary right away (no cleanup pass)
				if (change.remove.length > 0) await terms.deleteMany({ websiteId, term: { $in: change.remove }, df: { $lte: 0 } });
				// public flag moves for terms that stay in the document
				const stayPublic = change.addPublic.filter((term) => !change.add.includes(term));
				if (stayPublic.length > 0) await terms.updateMany({ websiteId, term: { $in: stayPublic } }, { $inc: { pdf: 1 } });
				const leavePublic = change.removePublic.filter((term) => !change.remove.includes(term));
				if (leavePublic.length > 0) await terms.updateMany({ websiteId, term: { $in: leavePublic } }, { $inc: { pdf: -1 } });
			},
			/** @returns {Promise<number>} */
			size: async () => terms.countDocuments({ websiteId }),
		}),
		queries: Object.freeze({
			/**
			 * Count one search of a query on a day.
			 * @param {{ day: string, q: string, results: number, expireAt: Date }} input
			 */
			record: async ({ day, q, results, expireAt }) =>
				queries.updateOne(
					{ websiteId, day, q },
					{
						$inc: { searches: 1, zero: results === 0 ? 1 : 0 },
						$max: { results },
						$set: { expireAt },
						$setOnInsert: { clicks: 0, createdAt: at(), schemaVersion: SCHEMA_VERSION, ...insertStamp },
					},
					{ upsert: true },
				),
			/** Count a result click. @param {{ day: string, q: string, expireAt: Date }} input */
			click: async ({ day, q, expireAt }) =>
				queries.updateOne(
					{ websiteId, day, q },
					{
						$inc: { clicks: 1 },
						$set: { expireAt },
						$setOnInsert: {
							searches: 0,
							zero: 0,
							results: 0,
							createdAt: at(),
							schemaVersion: SCHEMA_VERSION,
							...insertStamp,
						},
					},
					{ upsert: true },
				),
			/**
			 * Per query totals since a day.
			 * @param {string} fromDay
			 * @param {{ limit: number, sort: 'searches' | 'zero', minSearches?: number, withResults?: boolean, prefix?: string }} options
			 */
			totals: async (fromDay, { limit, sort, minSearches = 0, withResults = false }) =>
				(
					await queries
						.aggregate([
							{ $match: { websiteId, day: { $gte: fromDay } } },
							{ $limit: 100_000 },
							{
								$group: {
									_id: '$q',
									searches: { $sum: '$searches' },
									zero: { $sum: '$zero' },
									clicks: { $sum: '$clicks' },
									results: { $max: '$results' },
								},
							},
							{
								$match: {
									searches: { $gte: minSearches },
									...(withResults ? { results: { $gt: 0 } } : {}),
									...(sort === 'zero' ? { zero: { $gt: 0 } } : {}),
								},
							},
							{ $sort: sort === 'zero' ? { zero: -1, _id: 1 } : { searches: -1, _id: 1 } },
							{ $limit: limit },
						])
						.toArray()
				).map((/** @type {any} */ row) => ({
					q: String(row._id),
					searches: Number(row.searches),
					zero: Number(row.zero),
					clicks: Number(row.clicks),
					results: Number(row.results),
				})),
			/** Daily totals since a day. @param {string} fromDay */
			daily: async (fromDay) =>
				(
					await queries
						.aggregate([
							{ $match: { websiteId, day: { $gte: fromDay } } },
							{ $limit: 100_000 },
							{
								$group: {
									_id: '$day',
									searches: { $sum: '$searches' },
									zero: { $sum: '$zero' },
									clicks: { $sum: '$clicks' },
								},
							},
							{ $sort: { _id: 1 } },
						])
						.toArray()
				).map((/** @type {any} */ row) => ({
					day: String(row._id),
					searches: Number(row.searches),
					zero: Number(row.zero),
					clicks: Number(row.clicks),
				})),
		}),
		counters: Object.freeze({
			/**
			 * Add to a counter and return the new value.
			 * @param {string} key
			 * @param {number} by
			 * @param {Date} expireAt
			 */
			add: async (key, by, expireAt) => {
				const doc = await counters.findOneAndUpdate(
					{ websiteId, key },
					{ $inc: { n: by }, $set: { expireAt }, $setOnInsert: { createdAt: at(), schemaVersion: SCHEMA_VERSION } },
					{ upsert: true, returnDocument: 'after' },
				);
				return Number(doc?.n ?? by);
			},
			/** @param {string} key */
			get: async (key) => Number((await counters.findOne({ websiteId, key }))?.n ?? 0),
		}),
		crawls: Object.freeze({
			/** @param {string} key */
			get: async (key) => strip(await crawls.findOne({ websiteId, key })),
			list: async () => (await crawls.find({ websiteId }).sort({ key: 1 }).limit(100).toArray()).map(strip),
			/** @param {string} key @param {Record<string, unknown>} fields */
			set: async (key, fields) =>
				crawls.updateOne(
					{ websiteId, key },
					{ $set: { ...fields, key }, $setOnInsert: { createdAt: at(), schemaVersion: SCHEMA_VERSION } },
					{ upsert: true },
				),
		}),
		engine: Object.freeze({
			get: async () => strip(await engine.findOne({ websiteId, key: 'atlas' })),
			/** @param {Record<string, unknown>} fields */
			set: async (fields) =>
				engine.updateOne(
					{ websiteId, key: 'atlas' },
					{ $set: { ...fields, key: 'atlas' }, $setOnInsert: { createdAt: at(), schemaVersion: SCHEMA_VERSION } },
					{ upsert: true },
				),
		}),
	});
};

/** @typedef {ReturnType<typeof createRepositories>} Repositories */

/**
 * Repositories factory over the app-kit product (indexes and migrations are applied lazily by app-kit).
 * @param {any} product
 * @param {{ now?: () => number }} [options]
 * @returns {(websiteId: string, stamp?: { merchantId?: string, env?: string }) => Promise<Repositories>}
 */
export const repositoriesFor =
	(product, { now = Date.now } = {}) =>
	async (websiteId, stamp = {}) =>
		createRepositories(await product.data.forWebsite(websiteId, stamp), { now, stamp });
