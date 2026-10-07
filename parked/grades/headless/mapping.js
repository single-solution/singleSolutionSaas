/**
 * Mode B headless core of the `mapping` element: how an item's (or variant's) tier reads in the external vocabularies
 * the merchant chose to display ("Condition: Used"), and the structured-data properties of the current tier for
 * sites that build their own Offer JSON-LD.
 */
import { readableValue } from '../core/mapping.js';
import { isId } from '../core/text.js';
import { ID_PROBLEM, badgeOf, createStore, errorMessage } from './store.js';
import { createTranslator } from './strings.js';

/**
 * @typedef {object} MappingState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {string | null} itemId
 * @property {string | null} variantId
 * @property {import('./store.js').Badge | null} tier
 * @property {ReadonlyArray<{ key: string, name: string, value: string, text: string }>} rows displayed vocabularies
 * @property {Readonly<Record<string, string>>} offer structured-data properties of the current tier
 * @property {string | null} error
 */

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: import('./store.js').ElementClient,
 *   emit?: import('./store.js').Emit }} options
 */
export const createConditions = ({ strings = {}, client, emit = () => {} }) => {
	const t = createTranslator(strings);
	const store = createStore(
		/** @type {MappingState} */ ({
			status: 'idle',
			itemId: null,
			variantId: null,
			tier: null,
			rows: [],
			offer: {},
			error: null,
		}),
	);
	/** @type {Record<string, any> | null} */
	let view = null;

	/** @param {unknown} value */
	const validate = (value) =>
		value === undefined || value === null || isId(value)
			? []
			: [{ path: '/itemId', code: ID_PROBLEM, message: t('grades.error.id_invalid') }];

	/** @param {string | null} variantId */
	const derive = (variantId) => {
		if (!view) return { tier: null, rows: [], offer: {} };
		const entry =
			(variantId ? view.variants.find((/** @type {any} */ row) => row.variantId === variantId) : null) ??
			view.item ??
			view.tiers[0] ??
			null;
		if (!entry) return { tier: null, rows: [], offer: {} };
		const rows = view.vocabularies
			.filter((/** @type {any} */ v) => v.display && typeof entry.values[v.key] === 'string')
			.map((/** @type {any} */ v) => ({
				key: v.key,
				name: v.name,
				value: entry.values[v.key],
				text: readableValue(entry.values[v.key]),
			}));
		return { tier: badgeOf(entry.tier, t), rows, offer: entry.offer ?? {} };
	};

	/** @param {{ itemId: string, variantId?: string | null }} input */
	const load = async ({ itemId, variantId = null }) => {
		const problems = [...validate(itemId ?? ''), ...validate(variantId)];
		if (problems.length > 0) {
			store.set({ status: 'error', error: problems[0]?.message ?? null });
			return { ok: false, error: { code: 'validation_failed' } };
		}
		store.set({ status: 'loading', error: null, itemId, variantId });
		const result = await client.get(`/v1/condition-mappings/items/${encodeURIComponent(itemId)}`);
		if (!result.ok) {
			store.set({ status: 'error', error: errorMessage(t, strings, 'mapping', result.error) });
			return result;
		}
		view = result.value;
		store.set({ status: 'ready', ...derive(variantId) });
		return { ok: true, value: store.get() };
	};

	/** @param {string | null} variantId */
	const selectVariant = async (variantId) => {
		if (variantId !== null && !isId(variantId)) return { ok: false, error: { code: 'validation_failed' } };
		store.set({ variantId, ...derive(variantId) });
		emit('mapping.variant_selected', { variantId, tier: store.get().tier?.key ?? null });
		return { ok: true, value: store.get() };
	};

	return {
		state: store.get,
		actions: { load, selectVariant },
		subscribe: store.subscribe,
		validate,
		strings,
		destroy: store.destroy,
	};
};
