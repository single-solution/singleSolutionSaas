/**
 * Mode B core of `filters`: facets with counts (disjunctive: a facet's counts ignore its own selection), a price
 * range and active-filter chips, all kept in the URL query string the grid also reads. Every change resolves to the
 * new query string (page reset to 1) for the renderer to push into the history.
 */
import { digitsOf } from '../core/items.js';
import { hasFilters } from '../core/query.js';
import { bool, int, oneOf } from '../core/util.js';
import { createCore, emitter, fail, ok } from './kit.js';
import { createListing, listingConfig } from './listing.js';

export const LAYOUTS = Object.freeze(/** @type {const} */ (['sidebar', 'sheet', 'top_bar']));

/**
 * @typedef {object} FacetView
 * @property {string} key
 * @property {string} label
 * @property {'values' | 'range' | 'toggle'} type
 * @property {boolean} multi
 * @property {Array<{ value: string, count: number, selected: boolean }>} values
 * @property {{ min: number, max: number } | null} range
 */

/** @param {import('./kit.js').Options} [options] */
export const createFilters = (options = {}) => {
	const config = options.config ?? {};
	const listing = listingConfig({
		filter_keys: ['brand'],
		...config,
		facets: config.facets ?? [{ key: 'brand' }, { key: 'price' }],
	});
	const api = createListing(listing, options);
	const maxValues = int(config.max_values, 20, 1, 50);
	const emit = emitter(options.emit);
	const core = createCore(
		{
			status: /** @type {'idle' | 'loading' | 'ready' | 'error'} */ ('idle'),
			facets: /** @type {FacetView[]} */ ([]),
			query: api.parse(''),
			search: '',
			active: /** @type {Array<{ key: string, value: string }>} */ ([]),
			filtered: false,
			layout: oneOf(config.layout, LAYOUTS, 'sidebar'),
			counts: bool(config.show_counts, true),
			open: false,
			currency: listing.source.currency,
			digits: digitsOf(listing.source.currency),
			error: /** @type {string | null} */ (null),
			pageId: listing.source.pageId,
		},
		options,
	);
	let run = 0;

	/** @param {import('../core/query.js').Query} query */
	const load = async (query) => {
		const id = (run += 1);
		core.set({ status: 'loading', query, error: null });
		const result = await api.page({ ...query, page: 1 }, { size: 1 });
		if (id !== run) return fail('superseded');
		if (!result.ok) {
			core.set({ status: 'error', error: core.t('storefront.error') });
			return result;
		}
		const currency = listing.source.currency ?? result.value.items[0]?.currency ?? null;
		core.set({
			status: 'ready',
			currency,
			digits: digitsOf(currency),
			facets: listing.facets.map((facet) => {
				const counted = result.value.facets.find((entry) => entry.key === facet.key);
				const selected = query.filters[facet.key] ?? [];
				const values = (counted?.values ?? []).slice(0, maxValues);
				for (const value of selected) if (!values.some((entry) => entry.value === value)) values.push({ value, count: 0 });
				return {
					...facet,
					values: values.map((entry) => ({ ...entry, selected: selected.includes(entry.value) })),
					range: counted?.range ?? null,
				};
			}),
			active: Object.entries(query.filters).flatMap(([key, values]) => values.map((value) => ({ key, value }))),
			filtered: hasFilters(query),
		});
		return ok({ search: core.get().search });
	};

	/** @param {import('../core/query.js').Query} query @param {string} what */
	const change = async (query, what) => {
		const next = { ...query, page: 1 };
		core.set({ search: api.search(next, core.get().search) });
		emit('action', { action: what });
		return load(next);
	};

	return core.expose(
		{
			/** @param {{ search?: string, data?: unknown }} [input] */
			start: async ({ search = '', data } = {}) => {
				if (data !== undefined) api.source.provide(data);
				core.set({ search });
				return load(api.parse(search));
			},
			/** @param {string} search */
			setSearch: async (search) => {
				if (search === core.get().search && core.get().status !== 'idle') return ok({ search });
				core.set({ search });
				return load(api.parse(search));
			},
			/** Select or unselect a value (single-select facets replace). @param {string} key @param {string} value */
			toggle: async (key, value) => {
				const facet = listing.facets.find((entry) => entry.key === key);
				if (!facet || typeof value !== 'string' || value === '' || value.length > 100) return fail('invalid_filter');
				const query = core.get().query;
				const current = query.filters[key] ?? [];
				const values = current.includes(value)
					? current.filter((entry) => entry !== value)
					: facet.multi
						? [...current, value]
						: [value];
				const filters = { ...query.filters, [key]: values };
				if (values.length === 0) delete filters[key];
				return change({ ...query, filters }, 'filter');
			},
			/** Price range in minor units (null clears a bound). @param {number | null} min @param {number | null} max */
			setRange: async (min, max) => {
				/** @param {unknown} v */
				const bound = (v) => (Number.isSafeInteger(v) && /** @type {number} */ (v) >= 0 ? /** @type {number} */ (v) : null);
				const [low, high] = [bound(min), bound(max)];
				if (low !== null && high !== null && low > high) return fail('invalid_range');
				return change({ ...core.get().query, min: low, max: high }, 'price');
			},
			/** Clear one facet, or everything. @param {string} [key] */
			clear: async (key) => {
				const query = core.get().query;
				if (key === undefined) return change({ ...query, filters: {}, min: null, max: null }, 'clear');
				if (key === 'price') return change({ ...query, min: null, max: null }, 'clear');
				const filters = { ...query.filters };
				delete filters[key];
				return change({ ...query, filters }, 'clear');
			},
			/** The sheet layout's panel. @param {boolean} open */
			setOpen: async (open) => {
				core.set({ open: open === true });
				return ok(open === true);
			},
		},
		(input) => {
			const range = /** @type {{ min?: unknown, max?: unknown }} */ (typeof input === 'object' && input !== null ? input : {});
			return typeof range.min === 'number' && typeof range.max === 'number' && range.min > range.max
				? [{ path: '/min', code: 'invalid_range', message: core.t('filters.invalid_range') }]
				: [];
		},
	);
};
