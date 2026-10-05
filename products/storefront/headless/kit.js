/**
 * The shared shape of every storefront element core (Part E §4): an immutable state snapshot, actions that resolve
 * to results (never throw), subscribe, validate, strings and destroy. DOM-free; the clock and `fetch` are injected
 * (defaults: `Date.now` and the global `fetch`).
 */
import { createTranslator } from './strings.js';

/** @typedef {{ code: string, status?: number, detail?: string }} Problem */
/**
 * @template T
 * @typedef {{ ok: true, value: T } | { ok: false, problem: Problem }} Result
 */

/**
 * @template T
 * @param {T} value
 * @returns {Result<T>}
 */
export const ok = (value) => ({ ok: true, value });

/**
 * @param {string} code
 * @param {string} [detail]
 * @returns {{ ok: false, problem: Problem }}
 */
export const fail = (code, detail) => ({ ok: false, problem: detail ? { code, detail } : { code } });

/**
 * @typedef {object} Options what the Loader (or a developer) passes to an element factory
 * @property {Record<string, unknown>} [config] the element's configuration (from the signed entitlement document)
 * @property {Record<string, string>} [strings] the resolved string catalog
 * @property {unknown} [client] the runtime's Mode-C client (unused by packs: data comes from the configured source)
 * @property {Readonly<Record<string, import('./source.js').ReadClient>>} [clients] read-API clients of the products the
 *   pack reads (`manifest.reads`: catalog, search, deals), passed by the Loader when active on the website
 * @property {(verb: string, data?: Record<string, unknown>) => unknown} [emit] element UI events (`<key>.<verb>`)
 * @property {typeof fetch} [fetch]
 * @property {() => number} [now]
 */

/**
 * Build an element core around a state object.
 * @template {Record<string, any>} S
 * @param {S} initial
 * @param {Options} options
 */
export const createCore = (initial, { strings = {} }) => {
	/** @type {Set<(state: S) => void>} */
	const listeners = new Set();
	let state = Object.freeze({ ...initial });
	let destroyed = false;
	return {
		t: createTranslator(strings),
		strings,
		get: () => state,
		/** @param {Partial<S>} patch */
		set: (patch) => {
			if (destroyed) return;
			state = Object.freeze({ ...state, ...patch });
			for (const listener of listeners) listener(state);
		},
		/**
		 * @template {Record<string, (...args: any[]) => Promise<Result<any>>>} A
		 * @param {A} actions
		 * @param {(input: unknown) => Array<{ path: string, code: string, message: string }>} [validate]
		 */
		expose: (actions, validate = () => []) =>
			Object.freeze({
				/** @returns {Readonly<S>} */
				state: () => state,
				actions: Object.freeze(actions),
				/** @param {(state: S) => void} listener */
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				validate,
				strings,
				t: createTranslator(strings),
				destroy: () => {
					destroyed = true;
					listeners.clear();
				},
			}),
	};
};

/**
 * Safe event emitter: element UI events never break the element.
 * @param {Options['emit']} emit
 * @returns {(verb: string, data?: Record<string, unknown>) => void}
 */
export const emitter =
	(emit) =>
	(verb, data = {}) => {
		try {
			emit?.(verb, data);
		} catch {
			/* the host's problem, not the element's */
		}
	};
