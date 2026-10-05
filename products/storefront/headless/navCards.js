/**
 * Mode B cores of `category_cards` and `brand_cards`: navigation cards from the merchant's configured list, or from a
 * JSON file / page data (`[{ title, url, image, count }]`).
 */
import { navCards } from '../core/nav.js';
import { recordsOf } from '../core/items.js';
import { sourceConfig } from '../core/source.js';
import { bool, int, oneOf } from '../core/util.js';
import { createCore, ok } from './kit.js';
import { getJson } from './source.js';

/**
 * @param {import('./kit.js').Options} options
 * @param {boolean} logos
 */
const createNav = (options, logos) => {
	const config = options.config ?? {};
	const source = sourceConfig(config);
	const max = int(config.max_cards, 24, 1, 48);
	const fetcher = options.fetch ?? ((...args) => globalThis.fetch(...args));
	const core = createCore(
		{
			status: /** @type {'idle' | 'loading' | 'ready' | 'error'} */ ('idle'),
			cards: navCards(config.cards, max),
			layout: oneOf(config.layout, /** @type {const} */ (['grid', 'rail']), 'grid'),
			columns: int(config.columns, logos ? 6 : 4, 1, 8),
			names: bool(config.show_names, true),
			counts: bool(config.show_counts, false),
			logos,
			pageId: source.pageId,
		},
		options,
	);
	return core.expose({
		/** @param {{ data?: unknown }} [input] */
		start: async ({ data } = {}) => {
			if (data !== undefined) core.set({ cards: navCards(recordsOf(data), max) });
			else if (source.kind === 'json' && source.url !== null) {
				core.set({ status: 'loading' });
				const result = await getJson(fetcher, source.url);
				if (!result.ok) {
					core.set({ status: 'error' });
					return result;
				}
				core.set({ cards: navCards(recordsOf(result.value), max) });
			}
			core.set({ status: 'ready' });
			return ok(core.get().cards.length);
		},
	});
};

/** @param {import('./kit.js').Options} [options] */
export const createCategoryCards = (options = {}) => createNav(options, false);

/** @param {import('./kit.js').Options} [options] */
export const createBrandCards = (options = {}) => createNav(options, true);
