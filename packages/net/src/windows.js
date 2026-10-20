/**
 * Rate-limit counters kept in this instance's memory: what the Portal and every product count with while their shared
 * limit store is down, so a limit never switches off with the store (it only becomes per instance).
 * @module
 */

/**
 * Fixed-window counters, the same windows the shared stores keep (`hit` answers `{ count, resetAt }`), with a bounded
 * number of counters: when over the bound, the expired ones go first, then the least recently hit.
 * @param {{ maxEntries?: number }} [options]
 * @returns {{ hit: (key: string, windowMs: number, now: number) => { count: number, resetAt: number } }}
 */
export const createLocalWindows = ({ maxEntries = 10_000 } = {}) => {
	/** @type {Map<string, { count: number, resetAt: number }>} */
	const windows = new Map();
	return {
		hit: (key, windowMs, now) => {
			const start = Math.floor(now / windowMs) * windowMs;
			const id = `${key}|${start}`;
			const entry = windows.get(id) ?? { count: 0, resetAt: start + windowMs };
			entry.count += 1;
			// last in the map = most recently hit
			windows.delete(id);
			windows.set(id, entry);
			if (windows.size > maxEntries) {
				for (const [other, window] of windows) if (window.resetAt <= now) windows.delete(other);
				for (const other of windows.keys()) {
					if (windows.size <= maxEntries) break;
					windows.delete(other);
				}
			}
			return { ...entry };
		},
	};
};
