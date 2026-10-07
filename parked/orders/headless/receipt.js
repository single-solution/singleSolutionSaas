/**
 * Mode B headless core of the `invoices` element: the signed-in customer's printable receipt of one order, rendered on
 * the server (GET /v1/my-orders/{id}/receipt?format=json → `{ title, html }`). The renderer shows it in a sandboxed
 * frame and prints it. DOM-free.
 */
import { createTranslator } from './strings.js';
import { createStore, refused } from './store.js';

/**
 * @typedef {object} ReceiptState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {string | null} orderId
 * @property {string | null} title
 * @property {string | null} html
 * @property {string | null} error
 */

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: import('./store.js').OrdersClient,
 *   emit?: (name: string, data: Record<string, unknown>) => void }} options
 */
export const createReceipt = ({ strings = {}, client, emit = () => {} }) => {
	const t = createTranslator(strings);
	const store = createStore(
		/** @type {ReceiptState} */ ({ status: 'idle', orderId: null, title: null, html: null, error: null }),
	);

	const actions = Object.freeze({
		/** @param {string} orderId */
		load: async (orderId) => {
			if (typeof orderId !== 'string' || orderId === '') return refused('order_required');
			store.set({ status: 'loading', orderId, error: null });
			const result = await client.get(`/v1/my-orders/${encodeURIComponent(orderId)}/receipt`, { query: { format: 'json' } });
			if (!result.ok) {
				store.set({
					status: 'error',
					html: null,
					error: t(result.error.code === 'identity_required' ? 'receipt.sign_in' : 'receipt.error'),
				});
				return result;
			}
			store.set({ status: 'ready', title: result.value.title ?? null, html: result.value.html ?? null });
			emit('loaded', { orderId });
			return result;
		},
		clear: () => {
			store.set({ status: 'idle', orderId: null, title: null, html: null, error: null });
			return { ok: true, value: null };
		},
	});

	return Object.freeze({
		/** @returns {ReceiptState} */
		state: () => store.get(),
		actions,
		subscribe: store.subscribe,
		/** @returns {Array<{ path: string, code: string, message: string }>} */
		validate: () => [],
		strings,
		t,
		destroy: store.destroy,
	});
};
