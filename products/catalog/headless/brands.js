/**
 * Mode B headless core of the `brands` element: the visible brands (optionally of one collection) with logos, and
 * the selected brand. DOM-free.
 */
import { createTranslator } from './strings.js';
import { createStore, refused } from './store.js';

/**
 * @typedef {object} BrandsState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {ReadonlyArray<{ id: string, slug: string, name: string, logo: { url: string | null, alt: string | null } | null, selected: boolean }>} brands
 * @property {string | null} selectedId
 * @property {string | null} error
 */

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: import('./store.js').CatalogClient,
 *   emit?: (name: string, data: Record<string, unknown>) => void }} options
 */
export const createBrands = ({ strings = {}, client, emit = () => {} }) => {
	const t = createTranslator(strings);
	const store = createStore(/** @type {BrandsState} */ ({ status: 'idle', brands: [], selectedId: null, error: null }));

	const actions = Object.freeze({
		/** @param {{ collectionId?: string | null }} [scope] only brands usable in this collection */
		load: async ({ collectionId = null } = {}) => {
			store.set({ status: 'loading', error: null });
			const result = await client.get('/v1/brands');
			if (!result.ok) {
				store.set({ status: 'error', error: t('catalog.error.load_failed') });
				return result;
			}
			const brands = (result.value.items ?? [])
				.filter(
					(/** @type {any} */ b) => !collectionId || b.collectionIds.length === 0 || b.collectionIds.includes(collectionId),
				)
				.map((/** @type {any} */ b) => ({ id: b.id, slug: b.slug, name: b.name, logo: b.logo ?? null, selected: false }));
			store.set({ status: 'ready', brands, selectedId: null });
			return result;
		},
		/** @param {string | null} id null clears */
		select: (id) => {
			if (id !== null && !store.get().brands.some((b) => b.id === id)) return refused('not_found');
			store.set({ selectedId: id, brands: store.get().brands.map((b) => ({ ...b, selected: b.id === id })) });
			emit('selected', { brandId: id });
			return { ok: true, value: id };
		},
	});

	return Object.freeze({
		/** @returns {BrandsState} */
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
