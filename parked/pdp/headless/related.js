/**
 * Mode B core of the `related` element: a rail or grid of related items from the page data (`related`), or from a
 * merchant JSON list URL filled with the item's fields (`{id}`, `{brand}`, `{category}`), narrowed by the strategy
 * (as given, same brand, same category) and capped. No catalog needed.
 * @module
 */
import { formatMoney } from '../core/display.js';
import { normaliseItem } from '../core/item.js';
import { RELATED_STRATEGIES, selectRelated } from '../core/page.js';
import { bool, fillUrl, int, isHttpsUrl, isObject, oneOf, text } from '../core/util.js';
import { createItemElement, instance, ok } from './base.js';

export const RELATED_LAYOUTS = Object.freeze(/** @type {const} */ (['rail', 'grid']));

/** @param {Record<string, unknown>} config */
export const relatedSettings = (config) => ({
	strategy: oneOf(config.strategy, RELATED_STRATEGIES, 'provided'),
	count: int(config.count, 1, 24, 4),
	layout: oneOf(config.layout, RELATED_LAYOUTS, 'rail'),
	showPrice: bool(config.show_price, true),
	listUrl: text(config.list_url, 1000),
});

/**
 * @param {import('./base.js').ElementOptions} options
 */
export const createRelated = (options) => {
	const settings = relatedSettings(options.config ?? {});
	/** @param {import('../core/item.js').Item | null} item @param {readonly import('../core/item.js').RelatedItem[]} list @param {string} locale */
	const cards = (item, list, locale) =>
		Object.freeze(
			item
				? selectRelated(item, list, settings).map((entry) =>
						Object.freeze({
							...entry,
							priceText: settings.showPrice ? formatMoney(entry.price, entry.currency || item.currency, { locale }) : '',
						}),
					)
				: [],
		);
	const core = createItemElement({
		...options,
		prefix: 'related',
		extra: { ...settings, items: cards(null, [], '') },
		usable: (item) => item.title !== '' || item.id !== '',
		derive: (item, locale) => ({ items: cards(item, item?.related ?? [], locale) }),
	});
	const { store } = core;
	const actions = {
		...core.actions,
		/**
		 * Read the item, then the related list from `list_url` when configured.
		 * @param {import('./base.js').ItemSource} [source]
		 */
		load: async (source = {}) => {
			const result = await core.actions.load(source);
			const item = store.get().item;
			if (!item || settings.listUrl === '' || !source.fetchJson) return result;
			const url = fillUrl(settings.listUrl, {
				...source.context?.params,
				id: item.id,
				brand: item.brand,
				category: item.category,
			});
			if (!isHttpsUrl(url)) return result;
			try {
				const json = await source.fetchJson(url);
				const list = normaliseItem({ related: Array.isArray(json) ? json : isObject(json) ? json.items : [] }).related;
				store.set({ items: cards(item, list, store.get().locale) });
			} catch {
				core.emit('source_failed', {});
			}
			return result;
		},
		/**
		 * The visitor opened a related item.
		 * @param {number} index
		 */
		open: async (index) => {
			const entry = store.get().items[index];
			if (entry) core.emit('clicked', { index, ...(entry.id ? { itemId: entry.id } : {}) });
			return ok(index);
		},
	};
	return instance({ ...core, actions, strings: options.strings ?? {} });
};
