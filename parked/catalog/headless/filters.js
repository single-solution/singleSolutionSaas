/**
 * Mode B headless core of the `attributes` element: filter facets with counts (`GET /v1/attributes:facets`) and the
 * shopper's selection, which `selection()` hands to the `items` element (`items.actions.setFacets(...)`). Conditional
 * visibility from the attribute definitions is applied here: an attribute shown only for some brands or only when
 * another attribute has some values appears once that is selected. DOM-free.
 */
import { createTranslator } from './strings.js';
import { createStore, refused } from './store.js';

/**
 * @typedef {object} Facet
 * @property {string} key
 * @property {string} label
 * @property {string | null} unit
 * @property {Array<{ value: string, label: string, count: number, selected: boolean }>} values
 */
/**
 * @typedef {object} FiltersState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {ReadonlyArray<Facet>} facets the visible facets
 * @property {Readonly<Record<string, readonly string[]>>} selected
 * @property {number} count selected values
 * @property {string | null} error
 */

/**
 * Whether a facet's conditional visibility holds for a selection.
 * @param {{ visibility?: { type: string, brandIds?: string[], attributeKey?: string, values?: string[] } }} facet
 * @param {Readonly<Record<string, readonly string[]>>} selected
 * @param {string | null} brandId
 */
export const facetVisible = (facet, selected, brandId) => {
	const rule = facet.visibility ?? { type: 'always' };
	if (rule.type === 'brand') return brandId !== null && (rule.brandIds ?? []).includes(brandId);
	if (rule.type === 'attribute') return (selected[rule.attributeKey ?? ''] ?? []).some((v) => (rule.values ?? []).includes(v));
	return true;
};

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: import('./store.js').CatalogClient,
 *   emit?: (name: string, data: Record<string, unknown>) => void }} options
 */
export const createFilters = ({ strings = {}, client, emit = () => {} }) => {
	const t = createTranslator(strings);
	const store = createStore(/** @type {FiltersState} */ ({ status: 'idle', facets: [], selected: {}, count: 0, error: null }));
	/** @type {Array<Record<string, any>>} */
	let all = [];
	/** @type {string | null} */
	let brandId = null;

	/** @param {Readonly<Record<string, readonly string[]>>} selected */
	const settle = (selected) => {
		const visible = all.filter((facet) => facetVisible(facet, selected, brandId) && facet.values.length > 0);
		const keys = new Set(visible.map((facet) => facet.key));
		const kept = Object.fromEntries(Object.entries(selected).filter(([key, values]) => keys.has(key) && values.length > 0));
		store.set({
			facets: visible.map((facet) => ({
				key: facet.key,
				label: facet.label,
				unit: facet.unit ?? null,
				values: facet.values.map((/** @type {any} */ v) => ({ ...v, selected: (kept[facet.key] ?? []).includes(v.value) })),
			})),
			selected: kept,
			count: Object.values(kept).reduce((sum, values) => sum + values.length, 0),
		});
	};

	const actions = Object.freeze({
		/**
		 * Load the facets (optionally of a collection, for a brand).
		 * @param {{ collectionId?: string | null, brandId?: string | null }} [scope]
		 */
		load: async (scope = {}) => {
			brandId = scope.brandId ?? null;
			store.set({ status: 'loading', error: null });
			const result = await client.get('/v1/attributes:facets', {
				query: { 'filter[collectionId]': scope.collectionId ?? undefined, 'filter[brandId]': scope.brandId ?? undefined },
			});
			if (!result.ok) {
				store.set({ status: 'error', error: t('catalog.error.load_failed') });
				return result;
			}
			all = result.value.items ?? [];
			store.set({ status: 'ready' });
			settle(store.get().selected);
			return result;
		},
		/**
		 * Toggle one value.
		 * @param {string} key
		 * @param {string} value
		 */
		toggle: (key, value) => {
			const facet = store.get().facets.find((f) => f.key === key);
			if (!facet || !facet.values.some((v) => v.value === value)) return refused('value_invalid');
			const current = store.get().selected[key] ?? [];
			const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
			settle({ ...store.get().selected, [key]: next });
			emit('changed', { key, count: store.get().count });
			return { ok: true, value: store.get().selected };
		},
		clear: () => {
			settle({});
			emit('changed', { count: 0 });
			return { ok: true, value: {} };
		},
		/** The selection for `items.actions.setFacets`. */
		selection: () => ({ ...store.get().selected }),
	});

	return Object.freeze({
		/** @returns {FiltersState} */
		state: () => store.get(),
		actions,
		subscribe: store.subscribe,
		/** @returns {Array<{ path: string, code: string, message: string }>} */
		validate: () => [],
		strings,
		t,
		destroy: store.destroy,
	});
};
