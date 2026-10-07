/**
 * Mode B headless core of the `badges` element (Part E §4): offers for a set of items — card badges, product-page
 * pills, strike-through prices, countdowns and low-stock notes — as state, actions, subscribe, validate and strings.
 * Framework-agnostic and DOM-free. `client.offers(body)` is the element's Mode C call (`POST /v1/offers:evaluate`
 * with the website's `pk_` key and, when signed in, the shopper's `SS-Identity`); the default renderer
 * (ui/badges.js) and any merchant-built UI use exactly this core.
 */
import { conditionNotes, countdownText, moneyFormatter, rewardText } from './format.js';
import { createTranslator } from './strings.js';

/** @typedef {{ type?: string, title?: string, status?: number, detail?: string, code?: string }} Problem */
/**
 * @template T
 * @typedef {{ ok: true, value: T } | { ok: false, problem?: Problem, error?: Problem }} Result
 */
/** @typedef {{ itemId: string, variantId?: string, unitAmount?: number, quantity?: number }} ItemRef */
/**
 * @typedef {object} OfferView one item of `POST /v1/offers:evaluate`
 * @property {string} itemId
 * @property {string | null} variantId
 * @property {string} currency
 * @property {number} unitAmount
 * @property {number} price
 * @property {number} discount
 * @property {number} percentOff
 * @property {{ label: string | null, tone: string, reward: Record<string, any> } | null} badge
 * @property {Array<{ dealId: string, kind: string, name: string, label: string | null, tone: string, reward: Record<string, any>, conditions: Record<string, any>, conditional: boolean }>} pills
 * @property {{ endsAt: string } | null} countdown
 * @property {Array<{ id: string, stockLeft: number | null }>} deals
 * @property {{ token: string, expiresAt: string } | null} [lock]
 */
/** @typedef {{ offers: (body: { items: ItemRef[], currency?: string, lock?: boolean }) => Promise<Result<{ currency: string, items: OfferView[] }>> }} BadgesClient */
/**
 * @typedef {object} ItemState
 * @property {string} key `itemId` or `itemId:variantId`
 * @property {OfferView} offer
 * @property {boolean} discounted
 * @property {string | null} badgeText
 * @property {string} tone
 * @property {string} priceText
 * @property {string | null} compareAtText
 * @property {string | null} strikeText the configured strike-through form (compare_at / percent / savings)
 * @property {Array<{ dealId: string, text: string, notes: string[], tone: string, conditional: boolean }>} pills
 * @property {{ endsAt: string, text: string } | null} countdown
 * @property {string | null} lowStockText
 */
/**
 * @typedef {object} BadgesState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {ReadonlyArray<ItemState>} items
 * @property {string | null} error
 */

/** `itemId` or `itemId:variantId`. @param {{ itemId: string, variantId?: string | null }} ref */
export const itemKey = (ref) => (ref.variantId ? `${ref.itemId}:${ref.variantId}` : ref.itemId);

/**
 * Adapt an `@ss/web/element` API client (`createElementApi`) to the badges client.
 * @param {{ post: (path: string, body: unknown) => Promise<any> }} api
 * @returns {BadgesClient}
 */
export const badgesClient = (api) => ({ offers: (body) => api.post('/v1/offers:evaluate', body) });

/**
 * @param {{ config?: Record<string, unknown>, strings?: Record<string, string>, client: BadgesClient, identity?: unknown,
 *   emit?: (name: string, data: Record<string, unknown>) => void, now?: () => number }} options
 */
export const createBadges = ({ config = {}, strings = {}, client, emit = () => {}, now = Date.now }) => {
	const t = createTranslator(strings);
	const locale = strings['deals.locale'] || 'en';
	const strike = typeof config.strike_format === 'string' ? config.strike_format : 'compare_at';
	const lowStockBelow = typeof config.low_stock_below === 'number' ? config.low_stock_below : 0;
	/** @type {Set<(state: BadgesState) => void>} */
	const listeners = new Set();
	let destroyed = false;
	/** @type {BadgesState} */
	let state = Object.freeze({ status: 'idle', items: [], error: null });
	/** @param {Partial<BadgesState>} patch */
	const set = (patch) => {
		if (destroyed) return;
		state = Object.freeze({ ...state, ...patch });
		for (const listener of listeners) listener(state);
	};

	/**
	 * @param {OfferView} offer
	 * @param {number} at
	 * @returns {ItemState}
	 */
	const describe = (offer, at) => {
		const money = moneyFormatter(locale, offer.currency);
		const discounted = offer.discount > 0 && offer.price < offer.unitAmount;
		const badge = offer.badge;
		const compareAtText = discounted ? money(offer.unitAmount) : null;
		const strikeText = !discounted
			? null
			: strike === 'percent'
				? t('price.percent', { percent: offer.percentOff })
				: strike === 'savings'
					? t('price.savings', { amount: money(offer.unitAmount - offer.price) })
					: compareAtText;
		const stock = offer.deals.map((d) => d.stockLeft).filter((/** @type {number | null} */ s) => s !== null);
		const fewest = stock.length > 0 ? Math.min(.../** @type {number[]} */ (stock)) : null;
		const endsAt = offer.countdown?.endsAt ?? null;
		return {
			key: itemKey({ itemId: offer.itemId, variantId: offer.variantId }),
			offer,
			discounted,
			badgeText: badge ? (badge.label ?? rewardText(t, badge.reward, money)) : null,
			tone: badge?.tone ?? 'neutral',
			priceText: money(offer.price),
			compareAtText,
			strikeText,
			pills: offer.pills.map((p) => ({
				dealId: p.dealId,
				text: p.label ?? rewardText(t, p.reward, money),
				notes: conditionNotes(t, p.conditions ?? {}, money),
				tone: p.tone,
				conditional: p.conditional,
			})),
			countdown: endsAt ? { endsAt, text: countdownText(t, Date.parse(endsAt) - at) } : null,
			lowStockText:
				fewest !== null && lowStockBelow > 0 && fewest > 0 && fewest <= lowStockBelow
					? t('stock.low', { count: fewest })
					: null,
		};
	};

	/** @param {Problem | undefined} problem */
	const message = (problem) => (problem?.code === 'rate_limited' ? t('badges.error.busy') : t('badges.error'));

	/** @type {ItemRef[]} */
	let requested = [];
	/** @type {string | undefined} */
	let currency;

	/**
	 * @param {unknown} input
	 * @returns {Array<{ path: string, code: string, message: string }>}
	 */
	const validate = (input) => {
		if (!Array.isArray(input) || input.length === 0) return [{ path: '', code: 'items_invalid', message: t('badges.error') }];
		return input.flatMap((ref, index) =>
			ref && typeof ref === 'object' && typeof ref.itemId === 'string' && ref.itemId.length > 0
				? []
				: [{ path: `/${index}/itemId`, code: 'required', message: t('badges.error') }],
		);
	};

	/**
	 * Load offers for items (card grid, product page).
	 * @param {ItemRef[]} items
	 * @param {{ currency?: string, lock?: boolean }} [options]
	 * @returns {Promise<Result<{ currency: string, items: OfferView[] }>>}
	 */
	const load = async (items, options = {}) => {
		const problems = validate(items);
		if (problems.length > 0) {
			const problem = { code: 'validation_failed', title: 'Invalid items', status: 0 };
			set({ status: 'error', error: message(problem) });
			return { ok: false, problem };
		}
		requested = items;
		currency = options.currency;
		set({ status: 'loading', error: null });
		const result = await client.offers({
			items,
			...(options.currency ? { currency: options.currency } : {}),
			...(options.lock ? { lock: true } : {}),
		});
		if (result.ok) {
			const at = now();
			const described = result.value.items.map((offer) => describe(offer, at));
			set({ status: 'ready', items: described, error: null });
			emit('badges.viewed', { items: described.length, discounted: described.filter((i) => i.discounted).length });
		} else set({ status: 'error', error: message(result.error ?? result.problem) });
		return result;
	};

	const actions = Object.freeze({
		load,
		/** Reload the last request (e.g. after a countdown ended). */
		refresh: async () => load(requested, currency ? { currency } : {}),
		/**
		 * Recompute countdown copy (call it every second from a timer you own; the core never schedules timers).
		 * @param {number} [at]
		 */
		tick: (at = now()) => {
			if (state.status !== 'ready') return { ok: true, value: { expired: 0 } };
			let expired = 0;
			const items = state.items.map((item) => {
				if (!item.countdown) return item;
				const left = Date.parse(item.countdown.endsAt) - at;
				if (left <= 0) expired += 1;
				return { ...item, countdown: { endsAt: item.countdown.endsAt, text: countdownText(t, left) } };
			});
			set({ items });
			return { ok: true, value: { expired } };
		},
		/**
		 * The state of one item.
		 * @param {{ itemId: string, variantId?: string | null }} ref
		 */
		item: (ref) => state.items.find((item) => item.key === itemKey(ref)) ?? null,
	});

	return Object.freeze({
		/** @returns {BadgesState} immutable snapshot */
		state: () => state,
		actions,
		/**
		 * @param {(state: BadgesState) => void} listener
		 * @returns {() => void}
		 */
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		validate,
		strings,
		t,
		destroy: () => {
			destroyed = true;
			listeners.clear();
		},
	});
};
