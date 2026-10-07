/**
 * Mode B headless core of the `resolver` element: the pure resolver running in the page (no network, no metering) on
 * a published configurator's public view (`GET /v1/configurators/:id` with the website's `pk_` key, or the
 * `configurator` of `GET /v1/widgets/:id`). Same core, same rules, same results as the evaluate API — for sites that
 * re-resolve on every hover or keystroke. DOM-free; the element shape of Part E §4.
 */
import { compileSchema } from '../core/compile.js';
import { checkSelection, resolve } from '../core/resolve.js';
import { parseSchema } from '../core/schema.js';
import { createTranslator } from './strings.js';

/**
 * @typedef {object} ResolverState
 * @property {'idle' | 'ready' | 'error'} status
 * @property {string | null} configuratorId
 * @property {import('../core/resolve.js').Resolution | null} resolution
 * @property {{ code: string, detail?: string } | null} problem
 */

/**
 * @param {{ config?: Record<string, unknown>, strings?: Record<string, string>, configurator?: { id: string, schema: unknown } | null,
 *   now?: () => number, emit?: (name: string, data: Record<string, unknown>) => void }} options
 *   `config` = the resolver element's feature values; `now` = the clock for time-based rules
 */
export const createResolver = ({ config = {}, strings = {}, configurator = null, now = () => Date.now(), emit = () => {} }) => {
	const t = createTranslator(strings);
	/** @type {Set<(state: ResolverState) => void>} */
	const listeners = new Set();
	let destroyed = false;
	/** @type {import('../core/compile.js').Compiled | null} */
	let compiled = null;
	/** @type {ResolverState} */
	let state = Object.freeze({ status: 'idle', configuratorId: null, resolution: null, problem: null });
	/** @param {Partial<ResolverState>} patch */
	const set = (patch) => {
		if (destroyed) return;
		state = Object.freeze({ ...state, ...patch });
		for (const listener of listeners) listener(state);
	};
	const options = () => ({
		inStock: /** @type {any} */ (config.in_stock),
		tieBreak: /** @type {any} */ (config.tie_break),
		partial: /** @type {any} */ (config.partial),
		fallback: /** @type {any} */ (config.fallback),
		maxSteps: typeof config.max_steps === 'number' ? config.max_steps : undefined,
		now: now(),
	});

	const actions = Object.freeze({
		/**
		 * Load (and compile) a configurator's public view.
		 * @param {{ id: string, schema: unknown }} view
		 */
		load: async (view) => {
			const parsed = parseSchema(view?.schema);
			const built = parsed.ok ? compileSchema(parsed.schema) : null;
			if (!built?.ok) {
				compiled = null;
				set({
					status: 'error',
					configuratorId: null,
					problem: { code: 'invalid_configurator', detail: t('resolver.error.invalid') },
				});
				return { ok: /** @type {const} */ (false), problem: { code: 'invalid_configurator' } };
			}
			compiled = built.compiled;
			set({ status: 'ready', configuratorId: view.id, resolution: null, problem: null });
			return { ok: /** @type {const} */ (true), value: { id: view.id } };
		},
		/**
		 * Resolve a partial selection.
		 * @param {import('../core/resolve.js').ResolveInput} input
		 */
		resolve: async (input) => {
			if (!compiled) return { ok: /** @type {const} */ (false), problem: { code: 'not_loaded' } };
			const result = resolve(compiled, input, options());
			if (result.ok) {
				set({ resolution: result, problem: null });
				emit('resolver.resolved', { exact: result.exact, inStock: result.inStock });
				return { ok: /** @type {const} */ (true), value: result };
			}
			set({ resolution: null, problem: { code: result.problem.code, detail: result.problem.detail } });
			return { ok: /** @type {const} */ (false), problem: result.problem };
		},
		/**
		 * Check a selection exactly as given (what a quote needs).
		 * @param {{ selection?: Record<string, unknown>, quantity?: number }} input
		 */
		check: async (input) =>
			compiled
				? { ok: /** @type {const} */ (true), value: checkSelection(compiled, input, options()) }
				: { ok: /** @type {const} */ (false), problem: { code: 'not_loaded' } },
	});

	if (configurator) void actions.load(configurator);

	return Object.freeze({
		/** @returns {ResolverState} */
		state: () => state,
		actions,
		/** @param {(state: ResolverState) => void} listener */
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		/**
		 * @param {unknown} input `{ selection?, changed?, quantity? }`
		 * @returns {Array<{ path: string, code: string, message: string }>}
		 */
		validate: (input) => {
			const value = /** @type {Record<string, unknown>} */ (input ?? {});
			/** @type {Array<{ path: string, code: string, message: string }>} */
			const problems = [];
			if (
				value.selection !== undefined &&
				(value.selection === null || typeof value.selection !== 'object' || Array.isArray(value.selection))
			)
				problems.push({ path: '/selection', code: 'type', message: t('resolver.error.invalid') });
			if (
				value.quantity !== undefined &&
				!(Number.isSafeInteger(value.quantity) && /** @type {number} */ (value.quantity) >= 1)
			)
				problems.push({ path: '/quantity', code: 'range', message: t('resolver.error.invalid') });
			return problems;
		},
		strings,
		destroy: () => {
			destroyed = true;
			listeners.clear();
		},
	});
};
