/**
 * MongoDB Atlas Search on the merchant's database: detect whether the deployment has Atlas Search, manage the
 * product's search index (`listSearchIndexes` / `createSearchIndex`), and run `$search` queries.
 *
 * GAP: app-kit's guarded collection accepts only pipelines whose first stage is a `$match` on `websiteId`, but
 * `$search` must be the first stage, and the guard exposes no search-index management. Until app-kit offers
 * `scope.search(...)` / `scope.searchIndexes(...)`, this adapter reaches the driver collection behind the guarded one
 * through an unopened cursor (`cursor.client` + `cursor.namespace`, public driver getters) and keeps the tenant
 * rule itself: every `$search` built by `core/atlas.js` filters `websiteId` inside the search and is followed by a
 * `$match` on `websiteId`, and nothing else is done with the raw collection.
 * @module
 */
import { ATLAS_INDEX, atlasDefinition, classifyAtlasError, indexStateOf, pinsTenant } from '../core/atlas.js';

/**
 * The driver collection behind a guarded collection.
 * @param {any} guarded app-kit guarded collection
 * @param {string} websiteId
 * @returns {any}
 */
export const rawCollection = (guarded, websiteId) => {
	// GAP: see the module comment; the cursor is never iterated, so no query runs
	const cursor = guarded.find({ websiteId }, { limit: 1 });
	const { client, namespace } = cursor;
	void cursor.close();
	return client.db(namespace.db).collection(namespace.collection);
};

/**
 * @typedef {{ state: import('../core/atlas.js').ATLAS_STATES[number], detail: string | null, definition?: unknown }} AtlasStatus
 */

/**
 * Probe Atlas Search and make sure the product's index exists (created when missing and the database user may).
 * @param {any} collection driver collection
 * @param {{ create?: boolean }} [options]
 * @returns {Promise<AtlasStatus>}
 */
export const ensureAtlasIndex = async (collection, { create = true } = {}) => {
	/** @type {Array<Record<string, any>>} */
	let listed;
	try {
		listed = await collection.listSearchIndexes().toArray();
	} catch (error) {
		const state = classifyAtlasError(error);
		return { state, detail: errorDetail(error), ...(state === 'permission_denied' ? { definition: definitionFor() } : {}) };
	}
	const current = indexStateOf(listed);
	if (current !== 'missing' || !create) return { state: current, detail: null };
	try {
		await collection.createSearchIndex({ name: ATLAS_INDEX, definition: atlasDefinition() });
		return { state: 'building', detail: null };
	} catch (error) {
		const state = classifyAtlasError(error);
		// an index created meanwhile by another instance counts as building
		if (/already exists|duplicate/i.test(String(/** @type {any} */ (error)?.message ?? '')))
			return { state: 'building', detail: null };
		return {
			state: state === 'unavailable' ? 'unavailable' : state === 'permission_denied' ? 'permission_denied' : 'failed',
			detail: errorDetail(error),
			definition: definitionFor(),
		};
	}
};

/** What the merchant creates in Atlas when the product may not (name + definition, for the dashboard). */
export const definitionFor = () => ({ name: ATLAS_INDEX, definition: atlasDefinition() });

/**
 * A short, credential-free description of a driver error.
 * @param {unknown} error
 */
export const errorDetail = (error) => {
	const e = /** @type {{ codeName?: unknown, code?: unknown }} */ (error ?? {});
	return typeof e.codeName === 'string' ? e.codeName : typeof e.code === 'number' ? `code ${e.code}` : 'error';
};

/**
 * Run a `$search` pipeline built by `core/atlas.js`; refused (throws — a bug) unless it pins this website both inside
 * the search and in the following `$match`.
 * @param {any} collection driver collection
 * @param {Array<Record<string, unknown>>} pipeline
 * @param {string} websiteId
 * @param {{ maxTimeMS?: number }} [options]
 * @returns {Promise<Array<Record<string, any>>>}
 */
export const runSearch = async (collection, pipeline, websiteId, { maxTimeMS = 5000 } = {}) => {
	if (!pinsTenant(pipeline, websiteId)) throw new Error('tenant_guard: $search pipeline does not pin websiteId');
	return collection.aggregate(pipeline, { maxTimeMS }).toArray();
};
