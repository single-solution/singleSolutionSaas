/**
 * Websites this deployment serves, for the scheduled job (expired reservations, usage flush). It holds website ids
 * only — no merchant data (Part E §7: platform-side storage is limited to ids and caches) — in the product's own
 * control database when one is configured (`ss_coupons_sites`), else in memory.
 */

/**
 * @param {{ collection?: { updateOne: Function, find: Function } | null }} [options]
 */
export const createSiteRegistry = ({ collection = null } = {}) => {
	/** @type {Set<string>} */
	const known = new Set();
	return Object.freeze({
		/** @param {string} websiteId */
		remember: async (websiteId) => {
			if (known.has(websiteId)) return;
			known.add(websiteId);
			if (collection) {
				try {
					await collection.updateOne(
						{ _id: websiteId },
						{ $setOnInsert: { _id: websiteId, firstSeenAt: new Date() } },
						{ upsert: true },
					);
				} catch {
					known.delete(websiteId); // retried on the next request
				}
			}
		},
		/** @returns {Promise<string[]>} */
		list: async () => {
			if (!collection) return [...known].sort();
			const docs = await collection.find({}, { projection: { _id: 1 } }).toArray();
			return [...new Set([...known, ...docs.map((/** @type {{ _id: string }} */ doc) => doc._id)])].sort();
		},
	});
};

/** @typedef {ReturnType<typeof createSiteRegistry>} SiteRegistry */
