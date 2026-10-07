/**
 * Mode B headless core of the `loyalty_redeem` element: what a signed-in shopper can redeem on this cart, from the
 * Loyalty product (`POST /v1/loyalty:quote`), and the points chosen. The value comes off at placement, where the
 * Loyalty product takes the points (and gives them back if placement fails).
 */
import { formatMoney } from '../core/money.js';
import { createTranslator } from './strings.js';
import { createStore, errorText } from './store.js';

/**
 * @typedef {object} LoyaltyState
 * @property {'idle' | 'loading' | 'ready' | 'unavailable' | 'error'} status
 * @property {number} balance
 * @property {number} minPoints
 * @property {number} maxPoints
 * @property {number} points chosen
 * @property {string | null} valueText value of the chosen points
 * @property {string | null} message
 */

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: import('./store.js').CheckoutClient,
 *   cartId?: string | null, emit?: (name: string, data: Record<string, unknown>) => void }} options
 */
export const createLoyaltyRedeem = ({ strings = {}, client, cartId = null, emit = () => {} }) => {
	const t = createTranslator(strings);
	const locale = strings['checkout.locale'] || 'en';
	/** @type {ReturnType<typeof createStore<LoyaltyState>>} */
	const store = createStore(
		/** @type {LoyaltyState} */ ({
			status: 'idle',
			balance: 0,
			minPoints: 0,
			maxPoints: 0,
			points: 0,
			valueText: null,
			message: null,
		}),
	);
	/** @type {Record<string, any> | null} */
	let quote = null;

	/** @param {number} points */
	const valueOf = (points) => {
		const per = quote?.pointValue;
		if (!per || !per.points) return null;
		return formatMoney(Math.floor((points * per.value) / per.points), quote?.currency ?? 'XXX', locale);
	};

	const actions = Object.freeze({
		/** @param {string | null} [id] */
		load: async (id = cartId) => {
			store.set({ status: 'loading' });
			const result = await client.post('/v1/loyalty:quote', { cartId: id });
			if (!result.ok) {
				const code = result.error.code;
				store.set({
					status: code === 'identity_required' ? 'unavailable' : 'error',
					message: code === 'identity_required' ? t('loyalty.signin') : errorText(t, code),
				});
				return result;
			}
			quote = result.value;
			const q = result.value;
			store.set({
				status: q.allowed ? 'ready' : 'unavailable',
				balance: q.balance,
				minPoints: q.minPoints,
				maxPoints: q.maxPoints,
				points: 0,
				valueText: null,
				message: q.allowed ? t('loyalty.balance', { points: q.balance }) : t('loyalty.not_allowed'),
			});
			return result;
		},
		/** @param {number} points 0 = none */
		setPoints: async (points) => {
			const { minPoints, maxPoints } = store.get();
			const chosen = points <= 0 ? 0 : Math.min(maxPoints, Math.max(minPoints, Math.floor(points)));
			store.set({ points: chosen, valueText: chosen > 0 ? valueOf(chosen) : null });
			emit('loyalty_redeem.changed', { points: chosen });
			return { ok: /** @type {const} */ (true), value: chosen };
		},
		useMax: async () => actions.setPoints(store.get().maxPoints),
	});

	return Object.freeze({
		state: store.get,
		actions,
		subscribe: store.subscribe,
		validate: (/** @type {unknown} */ input) => {
			const { minPoints, maxPoints } = store.get();
			const n = Number(input);
			return n === 0 || (Number.isInteger(n) && n >= minPoints && n <= maxPoints)
				? []
				: [
						{
							path: '/loyaltyPoints',
							code: 'points_invalid',
							message: t('loyalty.error.range', { min: minPoints, max: maxPoints }),
						},
					];
		},
		strings,
		destroy: store.destroy,
	});
};
