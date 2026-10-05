/**
 * Mode B headless core of the `offer_apply` element: coupon codes and automatic deals for a cart, through the Coupons
 * and Deals products (`POST /v1/offers:check`). The products decide what applies and whether offers combine; this core
 * keeps the codes the shopper entered and shows what they save.
 */
import { formatMoney } from '../core/money.js';
import { createTranslator } from './strings.js';
import { createStore, errorText } from './store.js';

const CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * @typedef {object} OfferState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {string} code typed code
 * @property {string[]} codes applied codes
 * @property {Array<{ text: string }>} deals
 * @property {Array<{ code: string, text: string }>} applied
 * @property {string | null} error
 * @property {number} maxCodes
 */

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: import('./store.js').CheckoutClient,
 *   cartId?: string | null, emit?: (name: string, data: Record<string, unknown>) => void }} options
 */
export const createOfferApply = ({ config = {}, strings = {}, client, cartId = null, emit = () => {} }) => {
	const t = createTranslator(strings);
	const locale = strings['checkout.locale'] || 'en';
	const maxCodes = Number.isInteger(config.max_codes) ? config.max_codes : 1;
	/** @type {ReturnType<typeof createStore<OfferState>>} */
	const store = createStore(
		/** @type {OfferState} */ ({ status: 'idle', code: '', codes: [], deals: [], applied: [], error: null, maxCodes }),
	);
	let cart = cartId;

	/** @param {string[]} codes */
	const check = async (codes) => {
		if (!cart) return { ok: /** @type {const} */ (false), error: { code: 'cart_empty' } };
		store.set({ status: 'loading', error: null });
		const result = await client.post('/v1/offers:check', { cartId: cart, codes });
		if (!result.ok) {
			store.set({ status: 'error', error: errorText(t, result.error.code) });
			return result;
		}
		const { totals, deals, codes: found } = result.value;
		const money = (/** @type {number} */ n) => formatMoney(n, totals.currency, locale);
		const rejected = found.rejected.find((/** @type {any} */ r) => codes.includes(r.code));
		store.set({
			status: rejected ? 'error' : 'ready',
			codes: found.applied.map((/** @type {any} */ a) => a.code),
			applied: found.applied.map((/** @type {any} */ a) => ({
				code: a.code,
				text: t('offers.applied', { code: a.code, amount: money(a.discount) }),
			})),
			deals: deals.map((/** @type {any} */ d) => ({ text: t('offers.deal', { name: d.name, amount: money(d.amount) }) })),
			error: rejected
				? t(`offers.reason.${rejected.reason}`) === `offers.reason.${rejected.reason}`
					? t('offers.reason.not_eligible')
					: t(`offers.reason.${rejected.reason}`)
				: null,
		});
		return result;
	};

	const actions = Object.freeze({
		/** @param {string} id */
		setCart: async (id) => {
			cart = id;
			return check(store.get().codes);
		},
		/** @param {string} code */
		setCode: async (code) => {
			store.set({ code });
			return { ok: /** @type {const} */ (true), value: code };
		},
		apply: async () => {
			const code = store.get().code.trim();
			if (!CODE.test(code)) {
				store.set({ status: 'error', error: t('offers.reason.code_invalid') });
				return { ok: /** @type {const} */ (false), error: { code: 'code_invalid' } };
			}
			const codes = [...store.get().codes.filter((c) => c.toUpperCase() !== code.toUpperCase()), code].slice(-maxCodes);
			const result = await check(codes);
			if (result.ok && store.get().codes.length > 0) {
				store.set({ code: '' });
				emit('offer_apply.applied', { codes: store.get().codes.length });
			}
			return result;
		},
		/** @param {string} code */
		remove: async (code) => check(store.get().codes.filter((c) => c !== code)),
	});

	return Object.freeze({
		state: store.get,
		actions,
		subscribe: store.subscribe,
		validate: (/** @type {unknown} */ input) =>
			typeof input === 'string' && CODE.test(input.trim())
				? []
				: [{ path: '/code', code: 'code_invalid', message: t('offers.reason.code_invalid') }],
		strings,
		/** Codes for placement. */
		codes: () => store.get().codes,
		destroy: store.destroy,
	});
};
