/**
 * Mode B headless core of the `success_page` element: the order confirmation with next steps that follow the real
 * order (`POST /v1/success-views` with the order's access token, or `GET /v1/success-views/:id` for a signed-in shopper),
 * and the shopper's cancel while the order is unconfirmed (when the website allows it).
 */
import { formatMoney } from '../core/money.js';
import { createTranslator } from './strings.js';
import { createStore, errorText } from './store.js';

/**
 * @typedef {object} SuccessState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {Record<string, any> | null} view
 * @property {string | null} totalText
 * @property {string | null} error
 */

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: import('./store.js').CheckoutClient,
 *   order: { id: string, token?: string | null }, emit?: (name: string, data: Record<string, unknown>) => void }} options
 */
export const createSuccessPage = ({ strings = {}, client, order, emit = () => {} }) => {
	const t = createTranslator(strings);
	const locale = strings['checkout.locale'] || 'en';
	/** @type {ReturnType<typeof createStore<SuccessState>>} */
	const store = createStore(/** @type {SuccessState} */ ({ status: 'idle', view: null, totalText: null, error: null }));
	const access = { orderId: order.id, ...(order.token ? { token: order.token } : {}) };
	/** @param {import('./store.js').Result<any>} result */
	const show = (result) => {
		if (!result.ok) {
			store.set({ status: 'error', error: errorText(t, result.error.code) });
			return result;
		}
		const view = result.value;
		store.set({
			status: 'ready',
			view,
			totalText: formatMoney(view.order.totals.total, view.order.currency, locale),
			error: null,
		});
		return result;
	};

	const actions = Object.freeze({
		load: async () => {
			store.set({ status: 'loading' });
			const result = show(
				await (order.token
					? client.post('/v1/success-views', access)
					: client.get(`/v1/success-views/${encodeURIComponent(order.id)}`)),
			);
			if (result.ok) emit('success_page.shown', { status: result.value.order.status });
			return result;
		},
		/** Cancel an unconfirmed order. */
		cancel: async () => {
			const result = await client.post(`/v1/orders/${encodeURIComponent(order.id)}/cancel`, access);
			if (!result.ok) {
				store.set({ error: errorText(t, result.error.code) });
				return result;
			}
			emit('success_page.cancelled', {});
			return actions.load();
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
