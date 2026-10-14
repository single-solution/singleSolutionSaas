/**
 * The Redirects feature's records in the merchant database (through the kit's tenant guard):
 *
 * - `ss_growth_redirects`: the rules, one per `from` (unique index), `{ id, from, match, to, code, note }`.
 * - `ss_growth_redirect_versions`: one document per website, `{ version }`, a new random id on every change of the
 *   rules. It is the rule list's ETag: the website's server asks with `If-None-Match` and a 304 costs one read of this
 *   document, never of the rules.
 *
 * Every change runs in one transaction that reads the rules, checks the change against them (the caller's `plan`),
 * writes it and sets a new version; two changes at once both write the version document, so the second is run again on
 * what the first wrote (no rule set is ever checked against a stale copy).
 * @module
 */
import { createId } from '@ss/contracts';
import { MAX_RULES } from '../core/redirects.js';

/** @typedef {import('@ss/app-kit').WebsiteData} WebsiteData */
/** @typedef {import('../core/redirects.js').Rule} Rule */
/**
 * @typedef {{ create?: Rule[], update?: Rule[], remove?: string[] }} Writes rules to add, to replace (by id) and to
 *   delete (by id)
 */

const RULES = 'redirects';
const VERSIONS = 'redirect_versions';

/** Merchant database indexes of the rules and their version. @type {import('@ss/app-kit').IndexDefinition[]} */
export const REDIRECT_INDEXES = [
	{ collection: RULES, keys: { websiteId: 1, from: 1 }, name: 'by_from', unique: true },
	{ collection: RULES, keys: { websiteId: 1, createdAt: -1, id: -1 }, name: 'newest' },
	{ collection: VERSIONS, keys: { websiteId: 1 }, name: 'by_website', unique: true },
];

const FIELDS = { projection: { _id: 0, id: 1, from: 1, match: 1, to: 1, code: 1, note: 1, createdAt: 1, updatedAt: 1 } };

/** @param {string} text */
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {WebsiteData} data the guarded merchant database of one website
 * @param {{ merchantId: string }} context
 */
export const createRedirectStore = (data, { merchantId }) => {
	const rules = data.collection(RULES);
	const versions = data.collection(VERSIONS);
	const websiteId = data.websiteId;

	/**
	 * The filter of a list or count request: `q`, text in `from`, `to` or the note (any letter case); `code`, one answer.
	 * @param {{ q?: string, code?: number }} query
	 * @returns {Record<string, unknown>}
	 */
	const listFilter = ({ q, code }) => {
		const pattern = q ? { $regex: escapeRegex(q), $options: 'i' } : null;
		return {
			websiteId,
			...(code ? { code } : {}),
			...(pattern ? { $or: [{ from: pattern }, { to: pattern }, { note: pattern }] } : {}),
		};
	};

	/**
	 * Every rule, A to Z by `from` (one read: the batch holds the most a website may have).
	 * @param {import('mongodb').ClientSession} [session]
	 * @returns {Promise<Rule[]>}
	 */
	const all = async (session) =>
		/** @type {Rule[]} */ (
			/** @type {unknown} */ (
				await rules
					.find({ websiteId }, { ...FIELDS, sort: { from: 1 }, batchSize: MAX_RULES + 1, ...(session ? { session } : {}) })
					.toArray()
			)
		);

	return Object.freeze({
		all,

		/**
		 * The version of the rules: a new random id on every change; null while they never changed.
		 * @returns {Promise<string | null>}
		 */
		version: async () => {
			const found = await versions.findOne({ websiteId }, { projection: { _id: 0, version: 1 } });
			return typeof found?.version === 'string' ? found.version : null;
		},

		/**
		 * The rules that may answer a path: those whose `from` is the path or a path above it (one read).
		 * @param {string[]} paths the path and every path above it
		 * @returns {Promise<Rule[]>}
		 */
		candidates: async (paths) =>
			/** @type {Rule[]} */ (/** @type {unknown} */ (await rules.find({ websiteId, from: { $in: paths } }, FIELDS).toArray())),

		/**
		 * A page of rules, newest first.
		 * @param {{ after: unknown, limit: number, q?: string, code?: number }} query `after`: the cursor's
		 *   `[createdAt, id]`
		 * @returns {Promise<Rule[]>}
		 */
		page: async ({ after, limit, q, code }) => {
			const filter = listFilter({ q, code });
			if (Array.isArray(after) && after.length === 2) {
				const at = new Date(String(after[0]));
				filter.$and = [{ $or: [{ createdAt: { $lt: at } }, { createdAt: at, id: { $lt: String(after[1]) } }] }];
			}
			return /** @type {Rule[]} */ (
				/** @type {unknown} */ (await rules.find(filter, FIELDS).sort({ createdAt: -1, id: -1 }).limit(limit).toArray())
			);
		},

		/**
		 * The collection and filter of the list's counts (`GET /v1/redirects/count`, `/counts?by=`).
		 * @param {{ q?: string, code?: number }} query
		 */
		countSource: (query) => ({ collection: rules, filter: listFilter(query) }),

		/**
		 * Change the rules in one transaction: read them all, let `plan` check the change against them, write what it
		 * answers and set a new version (nothing is written, and the version stays, when `plan` refuses or writes nothing).
		 * Written rules keep the id and times `plan` gives them.
		 * @template {{ ok: boolean, writes?: Writes }} T
		 * @param {(current: Rule[]) => T} plan
		 * @returns {Promise<T>}
		 */
		change: (plan) =>
			data.transaction(async (session) => {
				const outcome = plan(await all(session));
				const { create = [], update = [], remove = [] } = outcome.ok ? (outcome.writes ?? {}) : {};
				if (create.length + update.length + remove.length === 0) return outcome;
				const gone = [...remove, ...update.map((rule) => rule.id)];
				if (gone.length > 0) await rules.deleteMany({ websiteId, id: { $in: gone } }, { session });
				const docs = [...create, ...update].map(({ id, from, match, to, code, note, createdAt, updatedAt }) => ({
					id,
					from,
					match,
					to,
					code,
					note,
					createdAt,
					updatedAt,
				}));
				if (docs.length > 0) await rules.insertMany(docs, { session });
				await versions.updateOne(
					{ websiteId },
					{ $set: { version: createId('rdv') }, $setOnInsert: { merchantId } },
					{ upsert: true, session },
				);
				return outcome;
			}),
	});
};

/** @typedef {ReturnType<typeof createRedirectStore>} RedirectStore */
