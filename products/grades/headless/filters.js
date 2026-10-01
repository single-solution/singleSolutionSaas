/**
 * Mode B headless core of the `filters` element: tier options of a listing with counts, the shopper's selection (one
 * or several tiers), the query value to put in the page URL (`param=value`) and the matching item ids page by page.
 * The listing itself stays the website's: it reacts to `filters.changed` or reads `itemIds`.
 */
import { isId, isKey } from '../core/text.js';
import { ID_PROBLEM, badgeOf, createStore, errorMessage } from './store.js';
import { createTranslator } from './strings.js';

/**
 * @typedef {import('./store.js').Badge & { count: number | null, countText: string | null, selected: boolean }} FilterOption
 */

/**
 * @typedef {object} FiltersState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {string} param URL parameter name
 * @property {boolean} multiSelect
 * @property {string | null} collection
 * @property {ReadonlyArray<FilterOption>} options
 * @property {ReadonlyArray<string>} selected tier keys, best first
 * @property {string} queryValue `a,b` ('' = no filter)
 * @property {ReadonlyArray<string>} itemIds matching items loaded so far
 * @property {string | null} cursor
 * @property {boolean} hasMore
 * @property {boolean} applying
 * @property {string | null} error
 */

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: import('./store.js').ElementClient,
 *   emit?: import('./store.js').Emit }} options
 */
export const createTierFilter = ({ config = {}, strings = {}, client, emit = () => {} }) => {
	const t = createTranslator(strings);
	const numbers = new Intl.NumberFormat(strings['grades.locale'] || 'en');
	const store = createStore(
		/** @type {FiltersState} */ ({
			status: 'idle',
			param: typeof config.param_name === 'string' ? config.param_name : 'tier',
			multiSelect: config.multi_select !== false,
			collection: null,
			options: [],
			selected: [],
			queryValue: '',
			itemIds: [],
			cursor: null,
			hasMore: false,
			applying: false,
			error: null,
		}),
	);
	/** @type {Array<Record<string, any>>} */
	let raw = [];

	/** @param {ReadonlyArray<string>} selected */
	const optionsOf = (selected) =>
		raw.map((option) => ({
			...badgeOf(option, t),
			count: typeof option.count === 'number' ? option.count : null,
			countText: typeof option.count === 'number' ? numbers.format(option.count) : null,
			selected: selected.includes(String(option.key)),
		}));

	/** @param {ReadonlyArray<string>} selected */
	const select = (selected) => {
		const order = raw.map((option) => String(option.key));
		const sorted = [...new Set(selected)]
			.filter((key) => order.includes(key))
			.sort((a, b) => order.indexOf(a) - order.indexOf(b));
		store.set({
			selected: sorted,
			queryValue: sorted.join(','),
			options: optionsOf(sorted),
			itemIds: [],
			cursor: null,
			hasMore: false,
		});
		emit('filters.changed', { param: store.get().param, tiers: sorted });
		return { ok: /** @type {const} */ (true), value: store.get() };
	};

	/** @param {{ collection?: unknown, selected?: unknown }} input */
	const validate = ({ collection, selected }) => [
		...(collection === undefined || collection === null || isId(collection)
			? []
			: [{ path: '/collection', code: ID_PROBLEM, message: t('grades.error.id_invalid') }]),
		...(selected === undefined || (Array.isArray(selected) && selected.every(isKey))
			? []
			: [{ path: '/selected', code: 'tier_invalid', message: t('grades.error.tier_invalid') }]),
	];

	/**
	 * Load the options; `selected` restores a selection (e.g. read from the page URL).
	 * @param {{ collection?: string | null, selected?: string[] }} [input]
	 */
	const load = async ({ collection = null, selected = [] } = {}) => {
		const problems = validate({ collection, selected });
		if (problems.length > 0) {
			store.set({ status: 'error', error: problems[0]?.message ?? null });
			return { ok: false, error: { code: 'validation_failed' } };
		}
		store.set({ status: 'loading', error: null, collection });
		const result = await client.get('/v1/tier-filters', { query: collection ? { collection } : {} });
		if (!result.ok) {
			store.set({ status: 'error', error: errorMessage(t, strings, 'filters', result.error) });
			return result;
		}
		raw = result.value.options;
		store.set({ status: 'ready', param: result.value.param, multiSelect: result.value.multiSelect });
		const chosen = result.value.multiSelect ? selected : selected.slice(0, 1);
		store.set({ selected: [], options: optionsOf([]) });
		return chosen.length > 0 ? select(chosen) : { ok: true, value: store.get() };
	};

	/**
	 * Turn a tier on or off (single-select replaces the selection).
	 * @param {string} key
	 */
	const toggle = async (key) => {
		const { selected, multiSelect } = store.get();
		if (!raw.some((option) => option.key === key)) return { ok: false, error: { code: 'not_found' } };
		const next = selected.includes(key) ? selected.filter((k) => k !== key) : multiSelect ? [...selected, key] : [key];
		return select(next);
	};

	const clear = async () => select([]);

	/**
	 * Load (the next page of) the items matching the selection.
	 * @param {{ more?: boolean }} [options]
	 */
	const apply = async ({ more = false } = {}) => {
		const state = store.get();
		if (state.selected.length === 0) return { ok: true, value: state };
		store.set({ applying: true, error: null });
		const result = await client.get('/v1/tier-filters/items', {
			query: {
				tier: state.queryValue,
				...(state.collection ? { collection: state.collection } : {}),
				...(more && state.cursor ? { cursor: state.cursor } : {}),
			},
		});
		if (!result.ok) {
			store.set({ applying: false, error: errorMessage(t, strings, 'filters', result.error) });
			return result;
		}
		const ids = result.value.items.map((/** @type {{ itemId: string }} */ row) => row.itemId);
		store.set({
			applying: false,
			itemIds: more ? [...state.itemIds, ...ids] : ids,
			cursor: result.value.nextCursor,
			hasMore: result.value.hasMore,
		});
		emit('filters.applied', { tiers: [...state.selected], count: store.get().itemIds.length });
		return { ok: true, value: store.get() };
	};

	return {
		state: store.get,
		actions: { load, toggle, clear, apply, loadMore: () => apply({ more: true }) },
		subscribe: store.subscribe,
		validate,
		strings,
		destroy: store.destroy,
	};
};
