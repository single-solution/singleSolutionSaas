/**
 * Mode B headless core of the `wallet` element: state, actions, subscribe, validate, strings, destroy (Part E §4).
 * Framework-agnostic and DOM-free. `client` is the element's Mode C client (`GET /v1/wallet` with the website's `pk_`
 * key and the customer's wallet token), already scoped by the runtime; the default renderer (ui/wallet.js) and any
 * merchant-built UI use exactly this core.
 */
import { createTranslator } from './strings.js';

/** @typedef {{ type?: string, title?: string, status?: number, detail?: string, code?: string }} Problem */
/**
 * @template T
 * @typedef {{ ok: true, value: T } | { ok: false, problem: Problem }} Result
 */
/** @typedef {{ id: string, kind: string, points: number, occurredAt: string, reason: string | null }} HistoryItem */
/**
 * @typedef {object} WalletView `GET /v1/wallet`
 * @property {string} customerId
 * @property {number} balance
 * @property {{ key: string | null, name: string | null, metric: number, next: { key: string, name: string, remaining: number } | null } | null} tier
 * @property {{ points: number, expiresAt: string, expiresOn: string } | null} expiring
 * @property {{ showHistory: boolean, showTier: boolean }} display
 * @property {{ items: HistoryItem[], nextCursor: string | null, hasMore: boolean }} history
 */
/** @typedef {{ wallet: (query?: { cursor?: string | null }) => Promise<Result<WalletView>> }} WalletClient */
/**
 * @typedef {object} WalletState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {number} balance
 * @property {string} balanceText formatted with the catalog's locale and plural forms
 * @property {WalletView['tier']} tier
 * @property {WalletView['expiring']} expiring
 * @property {string | null} expiringText
 * @property {string | null} tierText
 * @property {string | null} nextTierText
 * @property {number | null} progress 0..100 towards the next tier
 * @property {ReadonlyArray<HistoryItem & { label: string, pointsText: string }>} history
 * @property {string | null} cursor
 * @property {boolean} hasMore
 * @property {boolean} showHistory
 * @property {boolean} showTier
 * @property {boolean} loadingMore
 * @property {string | null} error resolved, user-facing message
 */

/**
 * @param {{ config?: Record<string, unknown>, strings?: Record<string, string>, client: WalletClient, identity?: unknown,
 *   emit?: (name: string, data: Record<string, unknown>) => void }} options
 */
export const createWallet = ({ config = {}, strings = {}, client, emit = () => {} }) => {
	const t = createTranslator(strings);
	const locale = strings['wallet.locale'] || 'en';
	const numbers = new Intl.NumberFormat(locale);
	const dates = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });
	/** @param {number} count */
	const points = (count) =>
		t(Math.abs(count) === 1 ? 'wallet.points.one' : 'wallet.points.other', { count: numbers.format(count) });
	/** @type {Set<(state: WalletState) => void>} */
	const listeners = new Set();
	let destroyed = false;
	/** @type {WalletState} */
	let state = Object.freeze({
		status: 'idle',
		balance: 0,
		balanceText: points(0),
		tier: null,
		expiring: null,
		expiringText: null,
		tierText: null,
		nextTierText: null,
		progress: null,
		history: [],
		cursor: null,
		hasMore: false,
		showHistory: config.show_history !== false,
		showTier: config.show_tier !== false,
		loadingMore: false,
		error: null,
	});
	/** @param {Partial<WalletState>} patch */
	const set = (patch) => {
		if (destroyed) return;
		state = Object.freeze({ ...state, ...patch });
		for (const listener of listeners) listener(state);
	};
	/** @param {Problem} problem */
	const message = (problem) =>
		t(problem.code === 'identity_required' ? 'wallet.error.identity_required' : 'wallet.error.request_failed');

	/** @param {HistoryItem} item */
	const describe = (item) => ({
		...item,
		label: t(`wallet.kind.${item.kind}`),
		pointsText: `${item.points > 0 ? '+' : ''}${numbers.format(item.points)}`,
	});

	/** @param {WalletView} view @param {boolean} append */
	const apply = (view, append) => {
		const tier = view.tier;
		const next = tier?.next ?? null;
		const expiring = view.expiring;
		set({
			status: 'ready',
			balance: view.balance,
			balanceText: points(view.balance),
			tier,
			expiring,
			expiringText: expiring
				? t('wallet.expiring', {
						points: points(expiring.points),
						date: dates.format(new Date(`${expiring.expiresOn}T00:00:00Z`)),
					})
				: null,
			tierText: tier?.name ? t('wallet.tier', { tier: tier.name }) : null,
			nextTierText: next
				? t('wallet.tier.next', { remaining: numbers.format(next.remaining), tier: next.name })
				: tier
					? t('wallet.tier.top')
					: null,
			progress: next && tier ? Math.round((100 * tier.metric) / Math.max(1, tier.metric + next.remaining)) : tier ? 100 : null,
			history: append ? [...state.history, ...view.history.items.map(describe)] : view.history.items.map(describe),
			cursor: view.history.nextCursor,
			hasMore: view.history.hasMore,
			showHistory: view.display.showHistory,
			showTier: view.display.showTier,
			loadingMore: false,
			error: null,
		});
	};

	const actions = Object.freeze({
		/** @returns {Promise<Result<WalletView>>} */
		load: async () => {
			set({ status: 'loading', error: null });
			const result = await client.wallet();
			if (result.ok) {
				apply(result.value, false);
				emit('wallet.viewed', { balance: result.value.balance });
			} else set({ status: 'error', error: message(result.problem) });
			return result;
		},
		/** @returns {Promise<Result<WalletView>>} */
		loadMore: async () => {
			if (!state.hasMore || state.loadingMore) return { ok: false, problem: { code: 'no_more' } };
			set({ loadingMore: true });
			const result = await client.wallet({ cursor: state.cursor });
			if (result.ok) apply(result.value, true);
			else set({ loadingMore: false, error: message(result.problem) });
			return result;
		},
	});

	return Object.freeze({
		/** @returns {WalletState} immutable snapshot */
		state: () => state,
		actions,
		/**
		 * @param {(state: WalletState) => void} listener
		 * @returns {() => void}
		 */
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/**
		 * The wallet takes no user input; a cursor must be an opaque string.
		 * @param {unknown} input
		 * @returns {Array<{ path: string, code: string, message: string }>}
		 */
		validate: (input) =>
			input && typeof input === 'object' && 'cursor' in input && typeof input.cursor !== 'string'
				? [{ path: '/cursor', code: 'cursor_invalid', message: t('wallet.error.request_failed') }]
				: [],
		strings,
		t,
		/** Points formatted for display (locale and plural forms from the catalog). */
		formatPoints: points,
		destroy: () => {
			destroyed = true;
			listeners.clear();
		},
	});
};
