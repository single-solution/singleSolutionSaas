/**
 * Mode B cores of `cards` (a section of item cards, e.g. one collection) and `trending_band` (a strip of trending or
 * featured items). Both pick a few items from the configured source and expose card view models; the renderer adds
 * the rotating attribute chips.
 */
import { cardConfig, cardView } from '../core/card.js';
import { SORTS } from '../core/query.js';
import { STRATEGIES, pickItems } from '../core/select.js';
import { sourceConfig } from '../core/source.js';
import { int, oneOf, str, strings } from '../core/util.js';
import { createCore, fail, ok } from './kit.js';
import { createSource } from './source.js';

/**
 * @param {import('./kit.js').Options} options
 * @param {{ strategy: typeof STRATEGIES[number], layouts: readonly string[], count: number }} defaults
 */
const createSection = (options, defaults) => {
	const config = options.config ?? {};
	const source = createSource(sourceConfig(config), options);
	const card = cardConfig(config.card);
	const rule = {
		strategy: oneOf(config.strategy, STRATEGIES, defaults.strategy),
		collection: str(config.collection, '', 100),
		ids: strings(config.item_ids, 48, 128),
		attribute: str(config.featured_attribute, 'featured', 64) || 'featured',
		count: int(config.count, defaults.count, 1, 48),
		sort: oneOf(config.sort, SORTS, 'relevance'),
		locale: source.source.locale,
	};
	const core = createCore(
		{
			status: /** @type {'idle' | 'loading' | 'ready' | 'error'} */ ('idle'),
			items: /** @type {import('../core/card.js').CardView[]} */ ([]),
			layout: oneOf(config.layout, defaults.layouts, /** @type {string} */ (defaults.layouts[0])),
			ratio: card.ratio,
			cycleMs: card.cycle ? card.cycleMs : 0,
			locale: rule.locale,
			pageId: source.source.pageId,
			error: /** @type {string | null} */ (null),
		},
		options,
	);
	const load = async () => {
		core.set({ status: 'loading', error: null });
		const result =
			source.source.kind === 'api'
				? await source
						.api('/v1/items', {
							limit: rule.strategy === 'manual' ? null : rule.count,
							'filter[collection]': rule.collection,
							'filter[id]': rule.strategy === 'manual' ? rule.ids.join(',') : null,
							sort: rule.strategy === 'newest' ? 'newest' : rule.strategy === 'rank' ? 'trending' : null,
						})
						.then((r) => (r.ok ? ok(source.itemsOf(r.value)) : r))
				: await source.all();
		if (!result.ok) {
			core.set({ status: 'error', error: core.t('storefront.error') });
			return result;
		}
		const items = pickItems(result.value, rule).map((item) => cardView(item, card));
		core.set({ status: 'ready', items });
		return ok({ count: items.length });
	};
	return core.expose({
		/** @param {{ data?: unknown }} [input] */
		start: async ({ data } = {}) => {
			if (data !== undefined) source.provide(data);
			return load();
		},
		reload: async () => (core.get().status === 'loading' ? fail('busy') : load()),
	});
};

/** @param {import('./kit.js').Options} [options] */
export const createCards = (options = {}) => createSection(options, { strategy: 'source', layouts: ['grid', 'rail'], count: 8 });

/** @param {import('./kit.js').Options} [options] */
export const createTrendingBand = (options = {}) =>
	createSection(options, { strategy: 'rank', layouts: ['strip', 'marquee'], count: 8 });
