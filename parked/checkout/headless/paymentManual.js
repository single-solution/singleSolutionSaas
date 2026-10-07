/**
 * Mode B headless core of the `payment_manual` element: the payment methods of the checkout — offered methods
 * (`GET /v1/payment-methods`) with their availability and surcharge for this checkout (from the `place_order` quote's
 * `paymentMethods`) — and the shopper's choice. DOM-free; whether a method is allowed is always the server's decision.
 */
import { formatMoney } from '../core/money.js';
import { createTranslator } from './strings.js';
import { createStore, errorText } from './store.js';

/**
 * @typedef {object} PaymentState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {Array<{ key: string, label: string, available: boolean, reason: string | null, surchargeText: string | null }>} methods
 * @property {Array<{ label: string, value: string }>} bankDetails
 * @property {string | null} selected
 * @property {string | null} error
 */

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: import('./store.js').CheckoutClient,
 *   emit?: (name: string, data: Record<string, unknown>) => void }} options
 */
export const createPaymentManual = ({ strings = {}, client, emit = () => {} }) => {
	const t = createTranslator(strings);
	const locale = strings['checkout.locale'] || 'en';
	/** @type {ReturnType<typeof createStore<PaymentState>>} */
	const store = createStore(
		/** @type {PaymentState} */ ({ status: 'idle', methods: [], bankDetails: [], selected: null, error: null }),
	);
	/** @type {Array<Record<string, any>>} */
	let offered = [];

	/**
	 * @param {Array<{ key: string, available: boolean, reason: string | null, surcharge: number }> | null} options quote options
	 * @param {string | null} currency
	 */
	const merge = (options, currency) => {
		const methods = offered.map((method) => {
			const option = options?.find((entry) => entry.key === method.key);
			return {
				key: method.key,
				label: t(`payment.method.${method.key}`),
				available: option ? option.available : true,
				reason: option?.reason ? t(`payment.reason.${option.reason}`) : null,
				surchargeText:
					option && option.surcharge > 0 && currency
						? t('payment.surcharge', { amount: formatMoney(option.surcharge, currency, locale) })
						: null,
			};
		});
		const selected =
			methods.find((m) => m.key === store.get().selected && m.available)?.key ?? methods.find((m) => m.available)?.key ?? null;
		store.set({ status: 'ready', methods, selected });
	};

	const actions = Object.freeze({
		load: async () => {
			store.set({ status: 'loading' });
			const result = await client.get('/v1/payment-methods');
			if (!result.ok) {
				store.set({ status: 'error', error: errorText(t, result.error.code) });
				return result;
			}
			offered = result.value.methods;
			store.set({ bankDetails: result.value.bankDetails });
			merge(null, null);
			return result;
		},
		/** Availability from a quote. @param {{ paymentMethods: any[], currency: string }} quote */
		applyQuote: async (quote) => {
			merge(quote.paymentMethods, quote.currency);
			return { ok: /** @type {const} */ (true), value: store.get().methods };
		},
		/** @param {string} key */
		select: async (key) => {
			const method = store.get().methods.find((m) => m.key === key);
			if (!method || !method.available) return { ok: /** @type {const} */ (false), error: { code: 'payment_unavailable' } };
			store.set({ selected: key });
			emit('payment_manual.selected', { method: key });
			return { ok: /** @type {const} */ (true), value: key };
		},
	});

	return Object.freeze({
		state: store.get,
		actions,
		subscribe: store.subscribe,
		validate: () =>
			store.get().selected ? [] : [{ path: '/paymentMethod', code: 'required', message: t('payment.error.required') }],
		strings,
		destroy: store.destroy,
	});
};
