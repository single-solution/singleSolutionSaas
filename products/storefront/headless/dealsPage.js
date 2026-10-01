/**
 * Mode B core of `deals_page`: live deals with their badge, time left and item previews, from the Deals product's
 * public `GET /v1/deals-page` (the website's `pk_` key; cursor paging) or a JSON file / page data of the same shape.
 */
import { cardConfig, cardView } from '../core/card.js';
import { dealsOf, timeLeft } from '../core/deals.js';
import { sourceConfig } from '../core/source.js';
import { bool, int, oneOf } from '../core/util.js';
import { createCore, fail, ok } from './kit.js';
import { createSource, getJson } from './source.js';

/** @param {import('./kit.js').Options} [options] */
export const createDealsPage = (options = {}) => {
	const config = options.config ?? {};
	const source = sourceConfig(config);
	const api = createSource(source, options);
	const fetcher = options.fetch ?? ((...args) => globalThis.fetch(...args));
	const now = options.now ?? Date.now;
	const card = cardConfig(config.card);
	const size = int(config.page_size, 12, 1, 50);
	const countdown = bool(config.show_countdown, true);
	const core = createCore(
		{
			status: /** @type {'idle' | 'loading' | 'ready' | 'error'} */ ('idle'),
			deals: /** @type {Array<Omit<import('../core/deals.js').Deal, 'items'> & { left: ReturnType<typeof timeLeft>, items: import('../core/card.js').CardView[] }>} */ ([]),
			next: /** @type {string | null} */ (null),
			layout: oneOf(config.layout, /** @type {const} */ (['grid', 'list']), 'grid'),
			ratio: card.ratio,
			locale: source.locale,
			pageId: source.pageId,
			error: /** @type {string | null} */ (null),
		},
		options,
	);
	/** @param {unknown} json */
	const view = (json) =>
		dealsOf(json, { currency: source.currency, max: size }).map((deal) => ({
			...deal,
			left: countdown ? timeLeft(deal.endsAt, now()) : null,
			items: deal.items.map((item) => cardView(item, card)),
		}));
	/** @param {string | null} cursor */
	const load = async (cursor) => {
		core.set({ status: 'loading', error: null });
		const result =
			source.kind === 'api'
				? await api.api('/v1/deals-page', { limit: size, cursor })
				: source.kind === 'json' && source.url !== null
					? await getJson(fetcher, source.url)
					: ok(provided);
		if (!result.ok) {
			core.set({ status: 'error', error: core.t('storefront.error') });
			return result;
		}
		const body = /** @type {Record<string, unknown>} */ (result.value ?? {});
		core.set({
			status: 'ready',
			deals: [...(cursor ? core.get().deals : []), ...view(body)],
			next: source.kind === 'api' && typeof body.nextCursor === 'string' ? body.nextCursor : null,
		});
		return ok(core.get().deals.length);
	};
	/** @type {unknown} */
	let provided = [];
	return core.expose({
		/** @param {{ data?: unknown }} [input] */
		start: async ({ data } = {}) => {
			if (data !== undefined) provided = data;
			return load(null);
		},
		loadMore: async () => (core.get().next && core.get().status === 'ready' ? load(core.get().next) : fail('nothing_more')),
	});
};
