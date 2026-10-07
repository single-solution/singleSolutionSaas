/**
 * Mode B headless core of the `items` element: an item listing with sorts, filters (collection, brand, facets, price
 * range, stock), cursor pages and display texts (price, compare-at price, availability) — framework-agnostic and
 * DOM-free. `client` is the element's Mode C client with the website's `pk_` key. The default renderer
 * (ui/items.js) and any merchant-built UI use exactly this core.
 */
import { formatMoney } from '../core/money.js';
import { createTranslator } from './strings.js';
import { createStore, refused } from './store.js';

/**
 * @typedef {object} ItemCard
 * @property {string} id
 * @property {string} slug
 * @property {string} title
 * @property {string} url
 * @property {string | null} brand
 * @property {string | null} priceText "from" text when variants differ
 * @property {string | null} compareText
 * @property {string} availabilityText
 * @property {boolean} inStock
 * @property {{ url: string, srcset: string | null, alt: string } | null} image
 */
/**
 * @typedef {object} ItemsFilter
 * @property {string | null} collectionId
 * @property {string | null} brandId
 * @property {Readonly<Record<string, readonly string[]>>} facets
 * @property {number | null} priceMin
 * @property {number | null} priceMax
 * @property {boolean | null} inStock
 */
/**
 * @typedef {object} ItemsState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {ReadonlyArray<ItemCard>} items
 * @property {string} sort
 * @property {readonly string[]} sorts
 * @property {ItemsFilter} filter
 * @property {string | null} cursor
 * @property {boolean} hasMore
 * @property {boolean} loadingMore
 * @property {string | null} error
 */

const FILTER_NAMES = Object.freeze(['collectionId', 'brandId', 'priceMin', 'priceMax', 'inStock']);

/**
 * Display card of a public item view.
 * @param {Record<string, any>} item
 * @param {{ t: ReturnType<typeof createTranslator>, locale: string }} context
 * @returns {ItemCard}
 */
export const cardOf = (item, { t, locale }) => {
	const prices = (item.variants ?? []).filter((/** @type {any} */ v) => v.purchasable !== false);
	const compare = prices.find((/** @type {any} */ v) => typeof v.compareAtPrice === 'number' && v.compareAtPrice > v.price);
	const min = typeof item.priceMin === 'number' ? formatMoney(item.priceMin, item.currency, locale) : null;
	const image = (item.media ?? []).find((/** @type {any} */ m) => m.kind === 'image' && m.url);
	return {
		id: item.id,
		slug: item.slug,
		title: item.title,
		url: item.url,
		brand: item.brand?.name ?? null,
		priceText: min ? (item.priceMax > item.priceMin ? t('catalog.price.from', { price: min }) : min) : null,
		compareText: compare ? formatMoney(compare.compareAtPrice, item.currency, locale) : null,
		availabilityText: t(item.inStock ? 'catalog.availability.in_stock' : 'catalog.availability.sold_out'),
		inStock: item.inStock === true,
		image: image ? { url: image.url, srcset: image.srcset ?? null, alt: image.alt ?? item.title } : null,
	};
};

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: import('./store.js').CatalogClient,
 *   emit?: (name: string, data: Record<string, unknown>) => void }} options
 */
export const createItems = ({ config = {}, strings = {}, client, emit = () => {} }) => {
	const t = createTranslator(strings);
	const locale = strings['catalog.locale'] || 'en';
	const sorts = Array.isArray(config.sorts) && config.sorts.length > 0 ? config.sorts : ['newest'];
	const store = createStore(
		/** @type {ItemsState} */ ({
			status: 'idle',
			items: [],
			sort: typeof config.default_sort === 'string' && sorts.includes(config.default_sort) ? config.default_sort : sorts[0],
			sorts,
			filter: { collectionId: null, brandId: null, facets: {}, priceMin: null, priceMax: null, inStock: null },
			cursor: null,
			hasMore: false,
			loadingMore: false,
			error: null,
		}),
	);

	/** @param {string | null} cursor */
	const query = (cursor) => {
		const { filter, sort } = store.get();
		/** @type {Record<string, string | number | boolean | undefined>} */
		const out = {
			sort,
			limit: typeof config.page_size === 'number' ? config.page_size : undefined,
			cursor: cursor ?? undefined,
			'filter[collectionId]': filter.collectionId ?? undefined,
			'filter[brandId]': filter.brandId ?? undefined,
			'filter[priceMin]': filter.priceMin ?? undefined,
			'filter[priceMax]': filter.priceMax ?? undefined,
			'filter[inStock]': filter.inStock ?? undefined,
			lang: strings['catalog.lang'] || undefined,
		};
		for (const [key, values] of Object.entries(filter.facets))
			if (values.length > 0) out[`filter[attr.${key}]`] = values.join(',');
		return out;
	};

	/** @param {boolean} append */
	const fetchPage = async (append) => {
		const result = await client.get('/v1/items', { query: query(append ? store.get().cursor : null) });
		if (!result.ok) {
			store.set({ status: append ? store.get().status : 'error', loadingMore: false, error: t('catalog.error.load_failed') });
			return result;
		}
		const cards = (result.value.items ?? []).map((/** @type {any} */ item) => cardOf(item, { t, locale }));
		store.set({
			status: 'ready',
			items: append ? [...store.get().items, ...cards] : cards,
			cursor: result.value.nextCursor ?? null,
			hasMore: result.value.hasMore === true,
			loadingMore: false,
			error: null,
		});
		return result;
	};

	const actions = Object.freeze({
		/**
		 * Load the first page (optionally with a filter).
		 * @param {Partial<ItemsFilter>} [filter]
		 */
		load: async (filter = {}) => {
			store.set({ status: 'loading', filter: { ...store.get().filter, ...filter }, cursor: null, error: null });
			const result = await fetchPage(false);
			if (result.ok) emit('viewed', { count: store.get().items.length });
			return result;
		},
		/** @param {string} sort */
		setSort: async (sort) => {
			if (!store.get().sorts.includes(sort)) return refused('sort_invalid');
			store.set({ sort, cursor: null });
			return fetchPage(false);
		},
		/**
		 * @param {'collectionId' | 'brandId' | 'priceMin' | 'priceMax' | 'inStock'} name
		 * @param {string | number | boolean | null} value
		 */
		setFilter: async (name, value) => {
			if (!FILTER_NAMES.includes(name)) return refused('filter_invalid');
			store.set({ filter: { ...store.get().filter, [name]: value }, cursor: null });
			return fetchPage(false);
		},
		/**
		 * Facet selection (e.g. from the `attributes` element's `actions.selection()`).
		 * @param {Record<string, readonly string[]>} facets
		 */
		setFacets: async (facets) => {
			store.set({ filter: { ...store.get().filter, facets: { ...facets } }, cursor: null });
			return fetchPage(false);
		},
		loadMore: async () => {
			const state = store.get();
			if (!state.hasMore || state.loadingMore) return refused('no_more');
			store.set({ loadingMore: true });
			return fetchPage(true);
		},
		/** @param {string} itemId */
		select: (itemId) => {
			const item = store.get().items.find((card) => card.id === itemId);
			if (item) emit('selected', { itemId });
			return item ? { ok: true, value: item } : refused('not_found');
		},
	});

	return Object.freeze({
		/** @returns {ItemsState} */
		state: () => store.get(),
		actions,
		subscribe: store.subscribe,
		/** @param {unknown} input @returns {Array<{ path: string, code: string, message: string }>} */
		validate: (input) => {
			const value = /** @type {Record<string, unknown>} */ (input ?? {});
			return ['priceMin', 'priceMax']
				.filter(
					(name) =>
						value[name] !== undefined &&
						value[name] !== null &&
						!(Number.isSafeInteger(value[name]) && /** @type {number} */ (value[name]) >= 0),
				)
				.map((name) => ({ path: `/${name}`, code: 'amount_invalid', message: t('catalog.error.amount_invalid') }));
		},
		strings,
		t,
		destroy: store.destroy,
	});
};
