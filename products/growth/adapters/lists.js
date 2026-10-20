/**
 * Growth's merchant lists (`core/lists.js`) in the product database: kept per website in the kit's settings collection
 * (so a removed website's lists go with its settings), checked by `checkList` on every save, read back through
 * `readList` (an entry that no longer passes is left out; a list never saved reads as its defaults). The kit serves
 * them at `GET|PUT /v1/lists/:list` and to the dashboard's Settings, and records each save in Recent changes and the
 * activity log.
 *
 * The page script's events read the goals and funnels on every batch, so an instance keeps each list it read for
 * {@link KEEP_MS} (a save on the same instance replaces it at once; another instance sees it within that time).
 * @module
 */
import { LISTS, checkList, readList } from '../core/lists.js';

/** How long an instance keeps a list it read for the hot paths (ms). */
export const KEEP_MS = 30_000;
/** Most lists an instance keeps. */
const KEPT = 2_000;

/** @typedef {import('../core/lists.js').ListName} ListName */

/**
 * @param {{ store: import('@ss/app-kit').Store, now: () => number }} options
 */
export const createLists = ({ store, now }) => {
	/** @param {string} websiteId @param {string} name */
	const idOf = (websiteId, name) => `${websiteId}|growth|list.${name}`;
	/** @type {Map<string, { at: number, value: any[] }>} */
	const kept = new Map();

	/**
	 * A list as the code reads it.
	 * @param {string} websiteId
	 * @param {ListName} name
	 * @returns {Promise<any[]>}
	 */
	const get = async (websiteId, name) => {
		const doc = await store.get('settings', idOf(websiteId, name));
		const value = readList(name, doc?.value);
		kept.delete(idOf(websiteId, name));
		if (kept.size >= KEPT) kept.delete(/** @type {string} */ (kept.keys().next().value));
		kept.set(idOf(websiteId, name), { at: now(), value });
		return value;
	};

	return Object.freeze({
		get,
		/**
		 * A list for the hot paths (the page script's events): the one this instance read in the last {@link KEEP_MS}, else
		 * read now.
		 * @param {string} websiteId
		 * @param {ListName} name
		 */
		recent: async (websiteId, name) => {
			const found = kept.get(idOf(websiteId, name));
			return found && now() - found.at < KEEP_MS ? found.value : get(websiteId, name);
		},
		/**
		 * Check and save a list whole.
		 * @param {string} websiteId
		 * @param {ListName} name
		 * @param {unknown} value
		 */
		save: async (websiteId, name, value) => {
			const checked = checkList(name, value);
			if (!checked.ok) return checked;
			await store.put('settings', idOf(websiteId, name), {
				websiteId,
				kind: 'growth',
				key: `list.${name}`,
				value: checked.value,
				at: now(),
			});
			kept.set(idOf(websiteId, name), { at: now(), value: checked.value });
			return checked;
		},
	});
};

/** @typedef {ReturnType<typeof createLists>} Lists */

/**
 * The lists as the kit serves them (`GET|PUT /v1/lists/:list`, the dashboard's Settings).
 * @param {Lists} lists
 */
export const kitLists = (lists) =>
	Object.fromEntries(
		/** @type {ListName[]} */ (Object.keys(LISTS)).map((name) => [
			name,
			{
				feature: LISTS[name].feature,
				title: LISTS[name].title,
				...(LISTS[name].fieldPermissions ? { fieldPermissions: LISTS[name].fieldPermissions } : {}),
				get: (/** @type {string} */ websiteId) => lists.get(websiteId, name),
				save: (/** @type {string} */ websiteId, /** @type {unknown} */ value) => lists.save(websiteId, name, value),
			},
		]),
	);
