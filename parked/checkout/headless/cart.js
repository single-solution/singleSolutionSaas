/**
 * Mode B headless core of the `cart` element: load / create a cart, add lines, change quantities, remove, reconcile and
 * merge a guest cart after sign-in — framework-agnostic and DOM-free. `client` is the element's Mode C client (the
 * website's `pk_` key; the shopper from `SS-Identity`). Prices always come from the server; the host persists the cart
 * id it gets back (`state().cart.id`) wherever it likes.
 */
import { formatMoney } from '../core/money.js';
import { createTranslator } from './strings.js';
import { createStore, errorText } from './store.js';

/**
 * @typedef {object} CartState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {Record<string, any> | null} cart the cart view (`GET /v1/carts/:id`)
 * @property {string | null} subtotalText
 * @property {string[]} notices what changed (price, quantity, unavailable), for the shopper
 * @property {string | null} error
 * @property {string | null} errorCode
 * @property {number} maxQuantity
 */

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: import('./store.js').CheckoutClient,
 *   emit?: (name: string, data: Record<string, unknown>) => void }} options
 */
export const createCart = ({ config = {}, strings = {}, client, emit = () => {} }) => {
	const t = createTranslator(strings);
	const locale = strings['checkout.locale'] || 'en';
	const maxQuantity = Number.isInteger(config.max_quantity_per_line) ? config.max_quantity_per_line : 10;
	/** @type {ReturnType<typeof createStore<CartState>>} */
	const store = createStore(
		/** @type {CartState} */ ({
			status: 'idle',
			cart: null,
			subtotalText: null,
			notices: [],
			error: null,
			errorCode: null,
			maxQuantity,
		}),
	);

	/** @param {{ kind: string, title: string, from?: number | null, to?: number | null }} change @param {string} currency */
	const notice = (change, currency) =>
		change.kind === 'price'
			? t('cart.notice.price', { title: change.title, price: formatMoney(Number(change.to), currency, locale) })
			: change.kind === 'quantity'
				? t('cart.notice.quantity', { title: change.title, quantity: Number(change.to) })
				: t(`cart.notice.${change.kind === 'removed' ? 'removed' : 'unavailable'}`, { title: change.title });

	/**
	 * @param {Promise<import('./store.js').Result<any>>} pending
	 * @param {string} [event]
	 */
	const apply = async (pending, event) => {
		store.set({ status: 'loading', error: null, errorCode: null });
		const result = await pending;
		if (!result.ok) {
			store.set({ status: 'error', error: errorText(t, result.error.code), errorCode: result.error.code ?? 'request_failed' });
			return result;
		}
		const cart = result.value;
		store.set({
			status: 'ready',
			cart,
			subtotalText: cart.currency ? formatMoney(cart.subtotalAmount, cart.currency, locale) : null,
			notices: (cart.changes ?? []).map((/** @type {any} */ change) => notice(change, cart.currency ?? 'XXX')),
		});
		if (event) emit(event, { lines: cart.lines.length, quantity: cart.quantity });
		return result;
	};
	const id = () => store.get().cart?.id;
	/** @param {string} path */
	const at = (path) => `/v1/carts/${encodeURIComponent(String(id()))}${path}`;

	const actions = Object.freeze({
		/** Load an existing cart, or create one when `cartId` is empty / unknown. @param {string | null} [cartId] */
		load: async (cartId = null) => {
			if (cartId) {
				const result = await apply(client.get(`/v1/carts/${encodeURIComponent(cartId)}`));
				if (result.ok && result.value.status === 'open') return result;
			}
			return apply(client.post('/v1/carts', {}), 'cart.created');
		},
		/** @param {{ itemId: string, variantId?: string, quantity?: number, note?: string }} line */
		add: async (line) => {
			if (!id()) await actions.load();
			return apply(client.post(at('/lines'), line), 'cart.line_added');
		},
		/** @param {string} lineId @param {number} quantity */
		setQuantity: async (lineId, quantity) =>
			apply(
				client.patch(at(`/lines/${encodeURIComponent(lineId)}`), {
					quantity: Math.max(0, Math.min(maxQuantity, Math.floor(quantity))),
				}),
				'cart.updated',
			),
		/** @param {string} lineId */
		remove: async (lineId) => apply(client.delete(at(`/lines/${encodeURIComponent(lineId)}`)), 'cart.line_removed'),
		reconcile: async () => apply(client.post(at('/reconcile'), {})),
		/** After sign-in: merge this guest cart into the shopper's cart. */
		merge: async () => apply(client.post(at('/merge'), {}), 'cart.merged'),
	});

	return Object.freeze({
		state: store.get,
		actions,
		subscribe: store.subscribe,
		/** @param {unknown} input `{ quantity }` */
		validate: (input) => {
			const q = /** @type {any} */ (input)?.quantity;
			return Number.isInteger(q) && q >= 0 && q <= maxQuantity
				? []
				: [{ path: '/quantity', code: 'quantity_invalid', message: t('cart.error.quantity') }];
		},
		strings,
		destroy: store.destroy,
	});
};
