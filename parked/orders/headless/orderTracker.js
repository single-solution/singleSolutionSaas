/**
 * Mode B headless core of the `lifecycle` element: the signed-in customer's orders (GET /v1/my-orders, pages), one
 * order's detail with its timeline, tracking, payments and lines (GET /v1/my-orders/{id}), and cancellation while the
 * merchant allows it (POST /v1/my-orders/{id}/cancel). Needs the website's own login (`SS-Identity`). DOM-free.
 */
import { createTranslator } from './strings.js';
import { createStore, refused } from './store.js';

/**
 * @typedef {object} TrackerState
 * @property {'idle' | 'loading' | 'ready' | 'signed_out' | 'error'} status
 * @property {ReadonlyArray<Record<string, any>>} orders summaries
 * @property {string | null} nextCursor
 * @property {Record<string, any> | null} selected the open order's detail
 * @property {boolean} busy an action is running
 * @property {string | null} error
 * @property {string | null} notice
 */

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: import('./store.js').OrdersClient,
 *   emit?: (name: string, data: Record<string, unknown>) => void }} options
 */
export const createOrderTracker = ({ config = {}, strings = {}, client, emit = () => {} }) => {
	const t = createTranslator(strings);
	const store = createStore(
		/** @type {TrackerState} */ ({
			status: 'idle',
			orders: [],
			nextCursor: null,
			selected: null,
			busy: false,
			error: null,
			notice: null,
		}),
	);
	const pageSize = Number.isSafeInteger(config.customer_page_size) ? config.customer_page_size : 20;

	/** @param {{ code?: string }} error */
	const failed = (error) =>
		error.code === 'identity_required' || error.code === 'identity_invalid' || error.code === 'unauthorized'
			? store.set({ status: 'signed_out', busy: false, error: t('tracker.sign_in') })
			: store.set({ status: store.get().orders.length > 0 ? 'ready' : 'error', busy: false, error: t('tracker.error') });

	const actions = Object.freeze({
		load: async () => {
			store.set({ status: 'loading', error: null, notice: null });
			const result = await client.get('/v1/my-orders', { query: { limit: pageSize } });
			if (!result.ok) {
				failed(result.error);
				return result;
			}
			store.set({ status: 'ready', orders: result.value.items ?? [], nextCursor: result.value.nextCursor ?? null });
			emit('viewed', { count: (result.value.items ?? []).length });
			return result;
		},
		loadMore: async () => {
			const { nextCursor, orders } = store.get();
			if (!nextCursor) return refused('no_more');
			store.set({ busy: true });
			const result = await client.get('/v1/my-orders', { query: { limit: pageSize, cursor: nextCursor } });
			if (!result.ok) {
				failed(result.error);
				return result;
			}
			store.set({
				busy: false,
				orders: [...orders, ...(result.value.items ?? [])],
				nextCursor: result.value.nextCursor ?? null,
			});
			return result;
		},
		/** @param {string} id */
		select: async (id) => {
			if (!store.get().orders.some((o) => o.id === id)) return refused('not_found');
			store.set({ busy: true, error: null, notice: null });
			const result = await client.get(`/v1/my-orders/${encodeURIComponent(id)}`);
			if (!result.ok) {
				failed(result.error);
				return result;
			}
			store.set({ busy: false, selected: result.value });
			emit('opened', { orderId: id });
			return result;
		},
		close: () => {
			store.set({ selected: null, notice: null });
			return { ok: true, value: null };
		},
		cancel: async () => {
			const selected = store.get().selected;
			if (!selected) return refused('nothing_selected');
			if (!selected.canCancel) return refused('not_cancellable');
			store.set({ busy: true, error: null });
			const result = await client.post(`/v1/my-orders/${encodeURIComponent(selected.id)}/cancel`, {});
			if (!result.ok) {
				store.set({ busy: false, error: t('tracker.cancel_failed') });
				return result;
			}
			const updated = result.value;
			store.set({
				busy: false,
				selected: updated,
				notice: t('tracker.cancelled'),
				orders: store
					.get()
					.orders.map((o) =>
						o.id === updated.id ? { ...o, status: updated.status, statusLabel: updated.statusLabel, canCancel: false } : o,
					),
			});
			emit('cancelled', { orderId: updated.id });
			return result;
		},
	});

	return Object.freeze({
		/** @returns {TrackerState} */
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
