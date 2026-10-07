/**
 * Mode B headless core of the `deals_page` element (Part E §4): the website's live (and upcoming) deals with their
 * badges, conditions, countdowns and items — state, actions, subscribe, validate, strings. DOM-free. `client` calls
 * `GET /v1/deals-page` and `GET /v1/deals-page/{dealId}/items` with the website's `pk_` key (ported from the
 * ibrahimMobiles `/deals` page: selectable deal buttons, the active deal's details and its products).
 */
import { conditionNotes, countdownText, dateFormatter, moneyFormatter, rewardText } from './format.js';
import { createTranslator } from './strings.js';

/** @typedef {import('./badges.js').Problem} Problem */
/**
 * @template T
 * @typedef {import('./badges.js').Result<T>} Result
 */
/**
 * @typedef {object} DealCard `GET /v1/deals-page` item
 * @property {string} id
 * @property {string} kind
 * @property {string} name
 * @property {string | null} description
 * @property {{ label: string | null, tone: string }} badge
 * @property {Record<string, any>} reward
 * @property {{ active: boolean, activeUntil: string | null, nextStart: string | null, timeZone: string }} schedule
 * @property {number | null} stockLeft
 * @property {Record<string, any>} conditions
 * @property {string | null} currency
 * @property {DealItem[]} items preview
 * @property {boolean} moreItems
 */
/**
 * @typedef {object} DealItem
 * @property {string} itemId
 * @property {string | null} variantId
 * @property {string | null} title
 * @property {string | null} url
 * @property {string | null} image
 * @property {string} currency
 * @property {number} unitAmount
 * @property {number} price
 */
/** @typedef {{ items: DealCard[], nextCursor: string | null, hasMore: boolean }} DealsPageView */
/**
 * @typedef {{ page: (query?: { cursor?: string | null }) => Promise<Result<DealsPageView>>,
 *   items: (dealId: string, query?: { cursor?: string | null }) => Promise<Result<{ items: DealItem[], nextCursor: string | null, hasMore: boolean }>> }} DealsPageClient
 */
/**
 * @typedef {object} ItemView
 * @property {string} key
 * @property {string} title
 * @property {string | null} url
 * @property {string | null} image
 * @property {string} priceText
 * @property {string | null} compareAtText
 * @property {boolean} discounted
 */
/**
 * @typedef {object} CardView
 * @property {string} id
 * @property {string} kind
 * @property {string} name
 * @property {string | null} description
 * @property {string} badgeText
 * @property {string} tone
 * @property {string[]} notes
 * @property {boolean} active
 * @property {string | null} timeText "Ends …" / "Starts …"
 * @property {{ endsAt: string, text: string } | null} countdown
 * @property {string | null} stockText
 * @property {ReadonlyArray<ItemView>} items
 * @property {boolean} moreItems
 * @property {string | null} itemsCursor
 * @property {boolean} loadingItems
 */
/**
 * @typedef {object} DealsPageState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {ReadonlyArray<CardView>} deals
 * @property {string | null} activeDealId
 * @property {string | null} cursor
 * @property {boolean} hasMore
 * @property {boolean} loadingMore
 * @property {string | null} error
 */

/**
 * Adapt an `@ss/web/element` API client to the deals page client.
 * @param {{ get: (path: string) => Promise<any> }} api
 * @returns {DealsPageClient}
 */
export const dealsPageClient = (api) => ({
	page: (query = {}) => api.get(`/v1/deals-page${query.cursor ? `?cursor=${encodeURIComponent(query.cursor)}` : ''}`),
	items: (dealId, query = {}) =>
		api.get(
			`/v1/deals-page/${encodeURIComponent(dealId)}/items${query.cursor ? `?cursor=${encodeURIComponent(query.cursor)}` : ''}`,
		),
});

/**
 * @param {{ config?: Record<string, unknown>, strings?: Record<string, string>, client: DealsPageClient, identity?: unknown,
 *   emit?: (name: string, data: Record<string, unknown>) => void, now?: () => number }} options
 */
export const createDealsPage = ({ config = {}, strings = {}, client, emit = () => {}, now = Date.now }) => {
	const t = createTranslator(strings);
	const locale = strings['deals.locale'] || 'en';
	const countdownMs = (typeof config.countdown_within_hours === 'number' ? config.countdown_within_hours : 48) * 3_600_000;
	/** @type {Set<(state: DealsPageState) => void>} */
	const listeners = new Set();
	let destroyed = false;
	/** @type {DealsPageState} */
	let state = Object.freeze({
		status: 'idle',
		deals: [],
		activeDealId: null,
		cursor: null,
		hasMore: false,
		loadingMore: false,
		error: null,
	});
	/** @param {Partial<DealsPageState>} patch */
	const set = (patch) => {
		if (destroyed) return;
		state = Object.freeze({ ...state, ...patch });
		for (const listener of listeners) listener(state);
	};
	const message = () => t('deals_page.error');

	/** @param {DealItem} item */
	const itemView = (item) => {
		const money = moneyFormatter(locale, item.currency);
		const discounted = item.price < item.unitAmount;
		return {
			key: item.variantId ? `${item.itemId}:${item.variantId}` : item.itemId,
			title: item.title ?? item.itemId,
			url: item.url,
			image: item.image,
			priceText: money(item.price),
			compareAtText: discounted ? money(item.unitAmount) : null,
			discounted,
		};
	};

	/**
	 * @param {DealCard} deal
	 * @param {number} at
	 * @returns {CardView}
	 */
	const cardView = (deal, at) => {
		const money = moneyFormatter(locale, deal.currency ?? 'USD');
		const dates = dateFormatter(locale, deal.schedule.timeZone);
		const until = deal.schedule.activeUntil;
		const showCountdown = deal.schedule.active && until !== null && Date.parse(until) - at <= countdownMs;
		return {
			id: deal.id,
			kind: deal.kind,
			name: deal.name,
			description: deal.description,
			badgeText: deal.badge.label ?? rewardText(t, deal.reward, money),
			tone: deal.badge.tone,
			notes: conditionNotes(t, deal.conditions, money),
			active: deal.schedule.active,
			timeText: deal.schedule.active
				? until
					? t('deals_page.ends', { date: dates(until) })
					: null
				: deal.schedule.nextStart
					? t('deals_page.starts', { date: dates(deal.schedule.nextStart) })
					: null,
			countdown: showCountdown && until ? { endsAt: until, text: countdownText(t, Date.parse(until) - at) } : null,
			stockText: deal.stockLeft !== null ? t('stock.left', { count: deal.stockLeft }) : null,
			items: deal.items.map(itemView),
			moreItems: deal.moreItems,
			itemsCursor: null,
			loadingItems: false,
		};
	};

	/** @param {string} dealId @param {Partial<CardView>} patch */
	const patchDeal = (dealId, patch) => set({ deals: state.deals.map((d) => (d.id === dealId ? { ...d, ...patch } : d)) });

	/** @returns {Promise<Result<DealsPageView>>} */
	const load = async () => {
		set({ status: 'loading', error: null });
		const result = await client.page();
		if (result.ok) {
			const at = now();
			set({
				status: 'ready',
				deals: result.value.items.map((deal) => cardView(deal, at)),
				cursor: result.value.nextCursor,
				hasMore: result.value.hasMore,
				activeDealId: state.activeDealId ?? result.value.items[0]?.id ?? null,
			});
			emit('deals_page.viewed', { deals: result.value.items.length });
		} else set({ status: 'error', error: message() });
		return result;
	};

	const actions = Object.freeze({
		load,
		/** @returns {Promise<Result<DealsPageView>>} */
		loadMore: async () => {
			if (!state.hasMore || state.loadingMore) return { ok: false, problem: { code: 'no_more' } };
			set({ loadingMore: true });
			const result = await client.page({ cursor: state.cursor });
			if (result.ok) {
				const at = now();
				set({
					deals: [...state.deals, ...result.value.items.map((deal) => cardView(deal, at))],
					cursor: result.value.nextCursor,
					hasMore: result.value.hasMore,
					loadingMore: false,
				});
			} else set({ loadingMore: false, error: message() });
			return result;
		},
		/**
		 * Show one deal (the deal buttons of the page).
		 * @param {string} dealId
		 */
		select: (dealId) => {
			if (!state.deals.some((d) => d.id === dealId)) return { ok: false, problem: { code: 'not_found' } };
			set({ activeDealId: dealId });
			emit('deals_page.selected', { dealId });
			return { ok: true, value: { dealId } };
		},
		/**
		 * Load (more of) a deal's items.
		 * @param {string} dealId
		 */
		loadItems: async (dealId) => {
			const deal = state.deals.find((d) => d.id === dealId);
			if (!deal) return { ok: false, problem: { code: 'not_found' } };
			patchDeal(dealId, { loadingItems: true });
			const result = await client.items(dealId, { cursor: deal.itemsCursor });
			if (result.ok) {
				const current = state.deals.find((d) => d.id === dealId) ?? deal;
				const seen = new Set(deal.itemsCursor ? current.items.map((i) => i.key) : []);
				const fresh = result.value.items.map(itemView).filter((i) => !seen.has(i.key));
				patchDeal(dealId, {
					items: deal.itemsCursor ? [...current.items, ...fresh] : fresh,
					moreItems: result.value.hasMore,
					itemsCursor: result.value.nextCursor,
					loadingItems: false,
				});
			} else patchDeal(dealId, { loadingItems: false });
			return result;
		},
		/**
		 * Recompute countdowns (call from your own timer).
		 * @param {number} [at]
		 */
		tick: (at = now()) => {
			set({
				deals: state.deals.map((d) =>
					d.countdown
						? {
								...d,
								countdown: { endsAt: d.countdown.endsAt, text: countdownText(t, Date.parse(d.countdown.endsAt) - at) },
							}
						: d,
				),
			});
			return { ok: true, value: {} };
		},
	});

	return Object.freeze({
		/** @returns {DealsPageState} */
		state: () => state,
		actions,
		/**
		 * @param {(state: DealsPageState) => void} listener
		 * @returns {() => void}
		 */
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/**
		 * The page takes no free input; a selected deal id must be a non-empty string.
		 * @param {unknown} input
		 */
		validate: (input) =>
			input && typeof input === 'object' && 'dealId' in input && !(typeof input.dealId === 'string' && input.dealId.length > 0)
				? [{ path: '/dealId', code: 'required', message: t('deals_page.error') }]
				: [],
		strings,
		t,
		destroy: () => {
			destroyed = true;
			listeners.clear();
		},
	});
};
