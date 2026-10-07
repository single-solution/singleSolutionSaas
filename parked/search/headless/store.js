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
 * @typedef {object} SearchClient the Mode C client (`@ss/web/element` ElementApi subset)
 * @property {(path: string, options?: { query?: Record<string, string | number | boolean | undefined> }) => Promise<Result<any>>} get
 * @property {(path: string, body?: unknown) => Promise<Result<any>>} [post]
 */
/**
 * @typedef {object} KeyValueStorage the visitor's own browser storage (the renderer passes a `localStorage` wrapper)
 * @property {(key: string) => string | null} get
 * @property {(key: string, value: string) => void} set
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

/**
 * A successful result.
 * @template T
 * @param {T} value
 * @returns {{ ok: true, value: T }}
 */
export const done = (value) => ({ ok: true, value });

/**
 * A storage that never fails (private windows and blocked storage simply remember nothing).
 * @param {KeyValueStorage | null | undefined} storage
 * @returns {KeyValueStorage}
 */
export const safeStorage = (storage) => ({
	get: (key) => {
		try {
			return storage?.get(key) ?? null;
		} catch {
			return null;
		}
	},
	set: (key, value) => {
		try {
			storage?.set(key, value);
		} catch {
			// storage full or blocked: nothing is remembered
		}
	},
});
