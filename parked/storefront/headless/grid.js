/**
 * Mode B core of `grid`: an item listing driven by the URL query (search, filters, sort, page). Every page has a real
 * URL (`?page=3`), so the renderer can always print crawlable `<a href>` pagination and enhance it to infinite
 * scroll or "load more". Actions that change the query resolve to the new query string for the URL.
 */
import { cardConfig, cardView } from '../core/card.js';
import { pageWindow } from '../core/query.js';
import { int, oneOf } from '../core/util.js';
import { createCore, emitter, fail, ok } from './kit.js';
import { createListing, listingConfig } from './listing.js';

export const PAGINATION = Object.freeze(/** @type {const} */ (['infinite', 'load_more', 'links']));

/** @param {import('./kit.js').Options} [options] */
export const createGrid = (options = {}) => {
	const config = options.config ?? {};
	const listing = listingConfig(config);
	const api = createListing(listing, options);
	const card = cardConfig(config.card);
	const columns = /** @type {Record<string, unknown>} */ (config.columns ?? {});
	const emit = emitter(options.emit);
	const core = createCore(
		{
			status: /** @type {'idle' | 'loading' | 'ready' | 'error'} */ ('idle'),
			items: /** @type {import('../core/card.js').CardView[]} */ ([]),
			total: /** @type {number | null} */ (null),
			pages: /** @type {number | null} */ (null),
			query: api.parse(''),
			search: '',
			hasMore: false,
			appending: false,
			first: 0,
			next: /** @type {string | null} */ (null),
			error: /** @type {string | null} */ (null),
			links: /** @type {{ prev: string | null, next: string | null, pages: Array<{ page: number, search: string } | null> }} */ ({
				prev: null,
				next: null,
				pages: [],
			}),
			sorts: listing.sorts,
			pagination: oneOf(config.pagination, PAGINATION, 'infinite'),
			columns: {
				mobile: int(columns.mobile, 2, 1, 4),
				tablet: int(columns.tablet, 3, 1, 6),
				desktop: int(columns.desktop, 4, 1, 8),
			},
			ratio: card.ratio,
			cycleMs: card.cycle ? card.cycleMs : 0,
			prefix: listing.prefix,
			locale: listing.source.locale,
			pageId: listing.source.pageId,
		},
		options,
	);
	let run = 0;

	/**
	 * @param {import('../core/query.js').Query} query
	 * @param {boolean} append
	 */
	const load = async (query, append) => {
		const id = (run += 1);
		const before = core.get();
		core.set(append ? { appending: true, error: null } : { status: 'loading', query, error: null });
		const result = await api.page(query, { cursor: append ? before.next : null });
		if (id !== run) return fail('superseded');
		if (!result.ok) {
			core.set({ status: 'error', appending: false, error: core.t('storefront.error') });
			return result;
		}
		const cards = result.value.items.map((item) => cardView(item, card));
		// a continuation page may leave out the total: keep what the first page said
		const total = result.value.total ?? (append ? before.total : null);
		const pages = result.value.pages ?? (append ? before.pages : null);
		const more = result.value.next !== null || (pages !== null && query.page < pages);
		/** @param {number} page */
		const link = (page) => ({ page, search: api.search({ ...query, page }, before.search) });
		const links = {
			prev: query.page > 1 ? link(query.page - 1).search : null,
			next: more ? link(query.page + 1).search : null,
			pages: pages === null ? [] : pageWindow(query.page, pages).map((n) => (n === null ? null : link(n))),
		};
		core.set({
			status: 'ready',
			query,
			items: append ? [...before.items, ...cards] : cards,
			first: append ? before.items.length : 0,
			total,
			pages,
			next: result.value.next,
			hasMore: more,
			links,
			appending: false,
		});
		return ok({ search: core.get().search });
	};

	/** @param {import('../core/query.js').Query} query */
	const go = (query) => {
		core.set({ search: api.search(query, core.get().search) });
		return load(query, false);
	};

	return core.expose(
		{
			/**
			 * First load: page data (when the source is the page) and the current query string.
			 * @param {{ search?: string, data?: unknown }} [input]
			 */
			start: async ({ search = '', data } = {}) => {
				if (data !== undefined) api.source.provide(data);
				core.set({ search });
				return load(api.parse(search), false);
			},
			/** The URL changed (back/forward, filters). @param {string} search */
			setSearch: async (search) => {
				if (search === core.get().search && core.get().status !== 'idle') return ok({ search });
				core.set({ search });
				return load(api.parse(search), false);
			},
			/** @param {string} sort */
			sortBy: async (sort) => {
				if (!listing.sorts.includes(/** @type {any} */ (sort))) return fail('invalid_sort');
				return go({ ...core.get().query, sort: /** @type {any} */ (sort), page: 1 });
			},
			/** @param {number} page */
			goTo: async (page) => go({ ...core.get().query, page: int(page, 1, 1, core.get().pages ?? 10_000) }),
			/** Infinite scroll / "load more": append the next page; the URL then points at it. */
			loadMore: async () => {
				const state = core.get();
				if (!state.hasMore || state.appending || state.status !== 'ready') return fail('nothing_more');
				const query = { ...state.query, page: state.query.page + 1 };
				core.set({ search: api.search(query, state.search) });
				const result = await load(query, true);
				if (result.ok) emit('action', { action: 'load_more' });
				return result;
			},
		},
		(input) =>
			typeof input === 'object' &&
			input !== null &&
			'sort' in input &&
			!listing.sorts.includes(/** @type {any} */ (input).sort)
				? [{ path: '/sort', code: 'invalid_sort', message: core.t('storefront.error') }]
				: [],
	);
};
