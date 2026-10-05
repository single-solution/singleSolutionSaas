/**
 * Mode B headless core of the `place_order` element: the server's quote of the checkout (`POST /v1/quotes`) and the
 * placement (`POST /v1/orders`). One Idempotency-Key is kept for a submission and reused on retries (a double click or
 * a flaky network never places two orders); it changes only when the checkout changes. The totals shown are always
 * the server's; `expectedTotal` lets the server answer `total_changed` when they moved.
 */
import { formatMoney } from '../core/money.js';
import { createTranslator } from './strings.js';
import { createStore, errorText, newKey } from './store.js';

/**
 * @typedef {object} PlaceState
 * @property {'idle' | 'quoting' | 'ready' | 'placing' | 'placed' | 'error'} status
 * @property {Record<string, any> | null} quote
 * @property {Array<{ label: string, amount: string }>} rows display rows of the totals
 * @property {string | null} totalText
 * @property {Record<string, any> | null} order the placed order (with `accessToken` for guests)
 * @property {string | null} error
 * @property {string | null} errorCode
 */

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: import('./store.js').CheckoutClient,
 *   emit?: (name: string, data: Record<string, unknown>) => void, newKey?: () => string }} options
 */
export const createPlaceOrder = ({ strings = {}, client, emit = () => {}, newKey: makeKey = newKey }) => {
	const t = createTranslator(strings);
	const locale = strings['checkout.locale'] || 'en';
	/** @type {ReturnType<typeof createStore<PlaceState>>} */
	const store = createStore(
		/** @type {PlaceState} */ ({
			status: 'idle',
			quote: null,
			rows: [],
			totalText: null,
			order: null,
			error: null,
			errorCode: null,
		}),
	);
	let key = makeKey();
	let lastBody = '';

	/** @param {Record<string, any>} totals @param {string} currency */
	const rowsOf = (totals, currency) => {
		const money = (/** @type {number} */ n) => formatMoney(n, currency, locale);
		return [
			{ label: t('place_order.subtotal'), amount: money(totals.subtotal) },
			...(totals.itemDiscount > 0 ? [{ label: t('place_order.deals'), amount: `−${money(totals.itemDiscount)}` }] : []),
			...(totals.couponDiscount > 0 ? [{ label: t('place_order.coupons'), amount: `−${money(totals.couponDiscount)}` }] : []),
			{ label: t('place_order.shipping'), amount: money(totals.shipping - totals.shippingDiscount) },
			...(totals.surcharge > 0 ? [{ label: t('place_order.surcharge'), amount: money(totals.surcharge) }] : []),
			...(totals.loyalty > 0 ? [{ label: t('place_order.loyalty'), amount: `−${money(totals.loyalty)}` }] : []),
		];
	};
	/** @param {Record<string, any>} quote */
	const showQuote = (quote) =>
		store.set({
			status: 'ready',
			quote,
			rows: rowsOf(quote.totals, quote.currency),
			totalText: formatMoney(quote.totals.total, quote.currency, locale),
			error: null,
			errorCode: null,
		});

	const actions = Object.freeze({
		/** Quote the checkout (cart, delivery, payment, codes, points). @param {Record<string, unknown>} body */
		quote: async (body) => {
			store.set({ status: 'quoting' });
			const result = await client.post('/v1/quotes', body);
			if (!result.ok) {
				store.set({
					status: 'error',
					error: errorText(t, result.error.code),
					errorCode: result.error.code ?? 'request_failed',
				});
				return result;
			}
			showQuote(result.value);
			return result;
		},
		/** Place the order. @param {Record<string, unknown>} body the checkout (form payload, payment method, consents …) */
		place: async (body) => {
			const quote = store.get().quote;
			const payload = { ...body, ...(quote ? { expectedTotal: quote.totals.total } : {}) };
			const text = JSON.stringify(payload);
			if (text !== lastBody) {
				if (lastBody !== '') key = makeKey();
				lastBody = text;
			}
			store.set({ status: 'placing', error: null, errorCode: null });
			const result = await client.post('/v1/orders', payload, { idempotencyKey: key });
			if (!result.ok) {
				const code = result.error.code ?? 'request_failed';
				const totals = /** @type {any} */ (result.error).totals;
				if (code === 'total_changed' && totals && quote) showQuote({ ...quote, totals });
				store.set({ status: 'error', error: errorText(t, code), errorCode: code });
				return result;
			}
			store.set({ status: 'placed', order: result.value });
			emit('place_order.placed', { status: result.value.status });
			key = makeKey();
			lastBody = '';
			return result;
		},
	});

	return Object.freeze({
		state: store.get,
		actions,
		subscribe: store.subscribe,
		validate: () => [],
		strings,
		destroy: store.destroy,
	});
};
