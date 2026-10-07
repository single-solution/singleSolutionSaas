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
 * @typedef {object} CheckoutClient the Mode C client (`@ss/web/element` ElementApi subset)
 * @property {(path: string, options?: { query?: Record<string, string | number | boolean | undefined> }) => Promise<Result<any>>} get
 * @property {(path: string, body?: unknown, options?: { idempotencyKey?: string }) => Promise<Result<any>>} post
 * @property {(path: string, body?: unknown) => Promise<Result<any>>} patch
 * @property {(path: string) => Promise<Result<any>>} delete
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
 * The shopper-facing text of a problem code (`checkout.error.<code>`, else the generic failure text).
 * @param {(key: string, params?: Record<string, string | number>) => string} t
 * @param {string | undefined} code
 */
export const errorText = (t, code) => {
	const key = `checkout.error.${code ?? 'request_failed'}`;
	const text = t(key);
	return text === key ? t('checkout.error.request_failed') : text;
};

/**
 * A fresh idempotency key (kept across retries of the same submission).
 * @returns {string}
 */
export const newKey = () => {
	const bytes = new Uint8Array(16);
	globalThis.crypto.getRandomValues(bytes);
	return `idk_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
};
