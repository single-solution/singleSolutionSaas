/**
 * Mode B headless core of the `payment_gateway` element (preview): start an online payment for an unpaid order with the
 * merchant's own gateway (`POST /v1/payments`), hand the redirect address to the host, and check the result on the
 * return page (`POST /v1/payments/:id/refresh`). DOM-free: the host performs the navigation.
 */
import { createTranslator } from './strings.js';
import { createStore, errorText } from './store.js';

/**
 * @typedef {object} GatewayState
 * @property {'idle' | 'starting' | 'redirect' | 'paid' | 'pending' | 'failed' | 'error'} status
 * @property {string | null} paymentId
 * @property {string | null} redirectUrl
 * @property {string | null} message
 * @property {string | null} error
 */

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: import('./store.js').CheckoutClient,
 *   order: { id: string, token?: string | null }, emit?: (name: string, data: Record<string, unknown>) => void }} options
 */
export const createPaymentGateway = ({ strings = {}, client, order, emit = () => {} }) => {
	const t = createTranslator(strings);
	/** @type {ReturnType<typeof createStore<GatewayState>>} */
	const store = createStore(
		/** @type {GatewayState} */ ({ status: 'idle', paymentId: null, redirectUrl: null, message: null, error: null }),
	);
	const access = { orderId: order.id, ...(order.token ? { token: order.token } : {}) };
	/** @param {string} status */
	const show = (status) => {
		const next = status === 'paid' ? 'paid' : status === 'failed' ? 'failed' : 'pending';
		store.set({ status: next, message: t(`gateway.status.${next}`) });
		if (next === 'paid') emit('payment_gateway.paid', {});
	};

	const actions = Object.freeze({
		/** @param {string} returnUrl an https page of this website */
		start: async (returnUrl) => {
			store.set({ status: 'starting', error: null });
			const result = await client.post('/v1/payments', { ...access, returnUrl });
			if (!result.ok) {
				store.set({ status: 'error', error: errorText(t, result.error.code) });
				return result;
			}
			store.set({ paymentId: result.value.paymentId, redirectUrl: result.value.redirectUrl });
			if (result.value.redirectUrl) store.set({ status: 'redirect' });
			else show(result.value.status);
			return result;
		},
		/** On the return page. @param {string} paymentId */
		check: async (paymentId) => {
			const result = await client.post(`/v1/payments/${encodeURIComponent(paymentId)}/refresh`, access);
			if (!result.ok) {
				store.set({ status: 'error', error: errorText(t, result.error.code) });
				return result;
			}
			store.set({ paymentId });
			show(result.value.status);
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
