/**
 * Mode B headless core of the `signin_gate` element: does this checkout need the shopper to sign in
 * (`GET /v1/signin-gate`), are they signed in (the website's identity, sent as `SS-Identity` by the runtime), and the
 * sign-in link with the way back. Placement enforces the same rule on the server.
 */
import { createTranslator } from './strings.js';
import { createStore, errorText } from './store.js';

/**
 * @typedef {object} GateState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {boolean} required
 * @property {boolean} signedIn
 * @property {string | null} signinUrl
 * @property {string | null} message
 */

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: import('./store.js').CheckoutClient,
 *   emit?: (name: string, data: Record<string, unknown>) => void }} options
 */
export const createSigninGate = ({ strings = {}, client, emit = () => {} }) => {
	const t = createTranslator(strings);
	/** @type {ReturnType<typeof createStore<GateState>>} */
	const store = createStore(
		/** @type {GateState} */ ({ status: 'idle', required: false, signedIn: false, signinUrl: null, message: null }),
	);

	const actions = Object.freeze({
		/** @param {{ returnTo?: string, paymentMethod?: string, total?: number }} [context] */
		check: async (context = {}) => {
			store.set({ status: 'loading' });
			const query = {
				...(context.returnTo ? { return: context.returnTo } : {}),
				...(context.paymentMethod ? { paymentMethod: context.paymentMethod } : {}),
				...(Number.isInteger(context.total) ? { total: context.total } : {}),
			};
			const result = await client.get('/v1/signin-gate', { query });
			if (!result.ok) {
				store.set({ status: 'error', message: errorText(t, result.error.code) });
				return result;
			}
			const { required, signedIn, signinUrl } = result.value;
			store.set({
				status: 'ready',
				required,
				signedIn,
				signinUrl,
				message: required && !signedIn ? t('signin.required') : signedIn ? t('signin.signed_in') : null,
			});
			if (required && !signedIn) emit('signin_gate.prompted', {});
			return result;
		},
	});

	return Object.freeze({
		state: store.get,
		actions,
		subscribe: store.subscribe,
		validate: () =>
			store.get().required && !store.get().signedIn
				? [{ path: '', code: 'identity_required', message: t('signin.required') }]
				: [],
		strings,
		destroy: store.destroy,
	});
};
