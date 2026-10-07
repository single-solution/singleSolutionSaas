/**
 * The tiny state container every headless element is built on (Part E §4): immutable snapshots, change listeners,
 * and a destroy switch after which nothing changes or notifies. DOM-free.
 */

/**
 * @typedef {{ code?: string, status?: number, detail?: string, errors?: Array<{ path: string, code: string }> }} Problem
 */
/**
 * @template T
 * @typedef {{ ok: true, value: T } | { ok: false, error: Problem }} Result
 */
/**
 * @typedef {object} CatalogClient the Mode C client (`@ss/web/element` ElementApi subset)
 * @property {(path: string, options?: { query?: Record<string, string | number | boolean | undefined> }) => Promise<Result<any>>} get
 */

/**
 * @template {object} S
 * @param {S} initial
 */
export const createStore = (initial) => {
	/** @type {Set<(state: S) => void>} */
	const listeners = new Set();
	let state = Object.freeze({ ...initial });
	let destroyed = false;
	return {
		/** @returns {S} */
		get: () => state,
		/** @param {Partial<S>} patch */
		set: (patch) => {
			if (destroyed) return;
			state = Object.freeze({ ...state, ...patch });
			for (const listener of listeners) listener(state);
		},
		/**
		 * @param {(state: S) => void} listener
		 * @returns {() => void}
		 */
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		destroy: () => {
			destroyed = true;
			listeners.clear();
		},
		isDestroyed: () => destroyed,
	};
};

/**
 * A failed result.
 * @param {string} code
 * @returns {{ ok: false, error: Problem }}
 */
export const refused = (code) => ({ ok: false, error: { code } });
