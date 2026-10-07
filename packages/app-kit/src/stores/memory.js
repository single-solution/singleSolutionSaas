/**
 * In-memory product database store: development and tests only (serverless instances share no memory). Documents with
 * a numeric `expiresAt` (epoch ms) disappear once it has passed.
 * @module
 */

/** @typedef {import('./types.js').Store} Store */
/** @typedef {import('./types.js').Doc} Doc */
/** @typedef {import('./types.js').Filter} Filter */

/**
 * @param {Doc} doc
 * @param {Filter} filter
 * @returns {boolean}
 */
export const matches = (doc, filter) =>
	Object.entries(filter).every(([field, value]) => {
		const actual = doc[field];
		return Array.isArray(actual) ? actual.includes(value) : (actual ?? null) === value;
	});

/**
 * @param {{ now?: () => number }} [options]
 * @returns {Store}
 */
export const createMemoryStore = ({ now = Date.now } = {}) => {
	/** @type {Map<string, Map<string, Doc>>} */
	const collections = new Map();
	/** @type {Map<string, number>} */
	const replay = new Map();
	/** @type {Map<string, { count: number, resetAt: number }>} */
	const windows = new Map();

	/** @param {string} name */
	const col = (name) => {
		let found = collections.get(name);
		if (!found) {
			found = new Map();
			collections.set(name, found);
		}
		return found;
	};
	/** @param {Doc | undefined} doc */
	const live = (doc) => doc !== undefined && !(typeof doc.expiresAt === 'number' && doc.expiresAt <= now());

	return Object.freeze({
		get: async (collection, id) => {
			const doc = col(collection).get(id);
			return live(doc) ? structuredClone(/** @type {Doc} */ (doc)) : null;
		},
		put: async (collection, id, doc) => {
			col(collection).set(id, structuredClone(doc));
		},
		insert: async (collection, id, doc) => {
			if (live(col(collection).get(id))) return false;
			col(collection).set(id, structuredClone(doc));
			return true;
		},
		delete: async (collection, id) => {
			col(collection).delete(id);
		},
		list: async (collection, filter, { limit = 1000 } = {}) =>
			[...col(collection).values()]
				.filter((doc) => live(doc) && matches(doc, filter))
				.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
				.slice(0, limit)
				.map((doc) => structuredClone(doc)),
		deleteWhere: async (collection, filter) => {
			let count = 0;
			for (const [id, doc] of col(collection)) {
				if (!matches(doc, filter)) continue;
				col(collection).delete(id);
				count += 1;
			}
			return count;
		},
		seen: async (id, expiresAtMs) => {
			const existing = replay.get(id);
			if (existing !== undefined && existing > now()) return true;
			replay.set(id, expiresAtMs);
			return false;
		},
		forget: async (id) => {
			replay.delete(id);
		},
		hit: async (key, windowMs, t) => {
			const start = Math.floor(t / windowMs) * windowMs;
			const id = `${key}|${start}`;
			const entry = windows.get(id) ?? { count: 0, resetAt: start + windowMs };
			entry.count += 1;
			windows.set(id, entry);
			if (windows.size > 10_000) for (const [k, v] of windows) if (v.resetAt <= t) windows.delete(k);
			return { ...entry };
		},
	});
};
