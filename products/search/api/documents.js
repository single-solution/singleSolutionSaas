/**
 * Documents service: create, replace and remove index documents from any source (sk_ API, crawls, catalog events)
 * with the same validation, limits and analysis. A write checks the website's document limit (`index.max_documents`)
 * and daily indexing quota (`index.upserts_per_day`), analyses the document's fields and keeps the vocabulary
 * counters in step (only the terms that changed).
 */
import { dayOf, expiryOf } from '../core/analytics.js';
import { analyse, vocabularyChange } from '../core/indexing.js';
import { hitView, validateDocument } from '../core/schema.js';

/**
 * @typedef {object} Site
 * @property {string} websiteId
 * @property {import('./settings.js').Settings} settings
 * @property {import('../adapters/db.js').Repositories} repos
 */
/** @typedef {{ ok: false, reason: string, detail?: string, errors?: Array<{ path: string, code: string }> }} Failure */

/** Documents in one batch request. */
export const MAX_BATCH = 100;

/**
 * @param {{ now: () => number, newId: (prefix: string) => string }} deps
 */
export const createDocumentsService = ({ now, newId }) => {
	/**
	 * Count one indexing operation against the daily quota.
	 * @param {Site} site
	 * @returns {Promise<boolean>} false when the quota is used up
	 */
	const takeQuota = async (site) => {
		const day = dayOf(now(), site.settings.timeZone);
		const used = await site.repos.counters.add(`upserts:${day}`, 1, expiryOf(now(), 2));
		return used <= site.settings.index.upserts_per_day;
	};

	/**
	 * Create or replace a document.
	 * @param {Site} site
	 * @param {unknown} input
	 * @param {{ source: string, crawlRun?: string | null, generateId?: boolean }} options
	 * @returns {Promise<{ ok: true, created: boolean, document: import('../core/schema.js').Hit, ignored: string[] } | Failure>}
	 */
	const upsert = async (site, input, { source, crawlRun = null, generateId = false }) => {
		const { settings, repos } = site;
		const checked = validateDocument(input, {
			types: settings.types,
			maxFieldChars: settings.index.max_field_chars,
			...(generateId ? { newId: () => newId('doc') } : {}),
		});
		if (!checked.ok) return { ok: false, reason: 'validation_failed', errors: checked.errors };
		const doc = checked.value;
		const type = /** @type {import('../core/schema.js').TypeDef} */ (settings.types.get(doc.type));
		const exists = (await repos.documents.get(doc.id)) !== null;
		if (!exists && (await repos.documents.count()) >= settings.index.max_documents)
			return { ok: false, reason: 'limit_reached', detail: 'The index holds index.max_documents documents.' };
		if (!(await takeQuota(site)))
			return { ok: false, reason: 'quota_exhausted', detail: 'index.upserts_per_day is used up for today.' };
		const analysis = analyse(doc, type, { maxFieldChars: settings.index.max_field_chars });
		const stored = {
			...doc,
			status: 'active',
			...analysis,
			source,
			crawlRun,
			indexedAt: new Date(now()),
		};
		const previous = await repos.documents.upsert(stored);
		await repos.vocabulary.apply(vocabularyChange(previous, analysis));
		return {
			ok: true,
			created: previous === null,
			document: hitView({ ...stored, updatedAt: new Date(now()) }, type, { owner: true }),
			ignored: checked.ignored,
		};
	};

	/**
	 * Remove a document.
	 * @param {Site} site
	 * @param {string} id
	 */
	const remove = async (site, id) => {
		const previous = await site.repos.documents.remove(id);
		if (previous) await site.repos.vocabulary.apply(vocabularyChange(previous, null));
		return previous !== null;
	};

	/**
	 * Upsert several documents (each one independently).
	 * @param {Site} site
	 * @param {unknown[]} inputs
	 * @param {{ source: string }} options
	 */
	const batch = async (site, inputs, { source }) => {
		/** @type {Array<Record<string, unknown>>} */
		const results = [];
		for (const [index, input] of inputs.slice(0, MAX_BATCH).entries()) {
			const result = await upsert(site, input, { source, generateId: true });
			results.push(
				result.ok
					? { index, status: result.created ? 'created' : 'updated', id: result.document.id }
					: { index, status: 'failed', reason: result.reason, ...(result.errors ? { errors: result.errors } : {}) },
			);
		}
		return results;
	};

	/**
	 * A document as the merchant's server sees it.
	 * @param {Site} site
	 * @param {string} id
	 */
	const get = async (site, id) => {
		const doc = await site.repos.documents.get(id);
		return doc ? { ...hitView(doc, site.settings.types.get(String(doc.type)), { owner: true }), status: doc.status } : null;
	};

	/**
	 * A page of documents (owner view).
	 * @param {Site} site
	 * @param {{ after: string | null, fetchLimit: number, type: string | null, source: string | null }} query
	 */
	const list = async (site, query) =>
		(
			await site.repos.documents.list({ after: query.after, limit: query.fetchLimit, type: query.type, source: query.source })
		).map((/** @type {any} */ doc) => hitView(doc, site.settings.types.get(String(doc.type)), { owner: true }));

	return { upsert, remove, batch, get, list };
};

/** @typedef {ReturnType<typeof createDocumentsService>} DocumentsService */
