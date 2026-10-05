/**
 * Data access of the `system` module (its own collections only).
 * @module
 */

/** @typedef {import('../../infra/db.js').MutableOps} MutableOps */
/** @typedef {import('./core/info.js').Notice} Notice */

/**
 * @param {MutableOps} settings
 */
export const createSystemRepo = (settings) =>
	Object.freeze({
		/** @returns {Promise<Notice | null>} */
		getNotice: async () => {
			const doc = await settings.findOne({ _id: 'notice' });
			return doc?.value ?? null;
		},
		/**
		 * Replace the notice; returns the previous one.
		 * @param {Notice | null} value
		 * @param {string} updatedBy
		 * @returns {Promise<Notice | null>}
		 */
		setNotice: async (value, updatedBy) => {
			const before = await settings.findOneAndUpdate(
				{ _id: 'notice' },
				{ $set: { value, updatedBy } },
				{ upsert: true, returnDocument: 'before' },
			);
			return before?.value ?? null;
		},
	});
