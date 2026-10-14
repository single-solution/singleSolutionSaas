/**
 * `@ss/protocol/testing` — helpers for tests and single-process tools only, never for a deployable: an in-memory
 * replay store and the adapter of a replay store to the single-use `consume` of `verifyLaunch`.
 * @module
 */

/** @typedef {import('./assertion.js').ReplayStore} ReplayStore */

/**
 * In-memory replay store for tests. When full (after pruning expired ids) it fails closed and reports every new id
 * as seen, so memory cannot be exhausted by a flood of unique ids.
 * @param {{ now?: () => number, maxEntries?: number }} [options]
 * @returns {ReplayStore & { size: () => number }}
 */
export const createMemoryReplayStore = ({ now = Date.now, maxEntries = 100_000 } = {}) => {
	/** @type {Map<string, number>} */
	const entries = new Map();
	const prune = () => {
		const t = now();
		for (const [id, expiresAt] of entries) if (expiresAt <= t) entries.delete(id);
	};
	return Object.freeze({
		seen: (id, expiresAtMs) => {
			const t = now();
			const existing = entries.get(id);
			if (existing !== undefined && existing > t) return true;
			if (entries.size >= maxEntries) prune();
			if (entries.size >= maxEntries) return true;
			entries.set(id, expiresAtMs);
			return false;
		},
		size: () => entries.size,
	});
};

/**
 * Adapt a `ReplayStore` to the single-use `consume(jti, expiresAtMs) → boolean` shape used by `verifyLaunch`
 * (`true` = first use, token may proceed).
 * @param {ReplayStore} store
 * @param {string} [namespace] prefix so several token types can share one store
 * @returns {(jti: string, expiresAtMs: number) => Promise<boolean>}
 */
export const consumeWith =
	(store, namespace = 'launch') =>
	async (jti, expiresAtMs) =>
		!(await store.seen(`${namespace}|${jti}`, expiresAtMs));
