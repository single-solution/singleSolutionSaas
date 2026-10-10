/**
 * Whether a website's Atlas Search index answered the last time it was used (PLAN 0.8.10 E14): kept in the product
 * database next to the website's settings (so a removed website's state goes with them) and written only when it
 * changes, so Overview can show `Search index missing` until a search works again.
 * @module
 */

/** @typedef {{ missing: boolean, at: number, message: string }} SearchState */

/**
 * @param {{ store: import('@ss/app-kit').Store, now: () => number }} options
 */
export const createSearchState = ({ store, now }) => {
	/** @param {string} websiteId */
	const idOf = (websiteId) => `${websiteId}|ecommerce|state.search`;
	/** The last state written per website on this instance (saves a read before each write). @type {Map<string, boolean>} */
	const known = new Map();

	return Object.freeze({
		/**
		 * The last state, or null before the first Atlas search.
		 * @param {string} websiteId
		 * @returns {Promise<SearchState | null>}
		 */
		get: async (websiteId) => {
			const doc = await store.get('settings', idOf(websiteId));
			return doc && typeof doc.value === 'object' && doc.value !== null ? /** @type {SearchState} */ (doc.value) : null;
		},
		/**
		 * Record whether the index answered (written only when it changed).
		 * @param {string} websiteId
		 * @param {boolean} missing
		 * @param {string} [message] what the database said (no secrets: an error's code name)
		 */
		set: async (websiteId, missing, message = '') => {
			if (known.get(websiteId) === missing) return;
			known.set(websiteId, missing);
			await store.put('settings', idOf(websiteId), {
				websiteId,
				kind: 'ecommerce',
				key: 'state.search',
				value: { missing, at: now(), message },
				at: now(),
			});
		},
	});
};

/** @typedef {ReturnType<typeof createSearchState>} SearchStates */
