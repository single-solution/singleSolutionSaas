/**
 * Mode B headless core of the `policies_notice` element: the website's policies (`GET /v1/policies`) with links, and
 * the shopper's consents to the required ones (sent with placement as `consents`).
 */
import { createTranslator } from './strings.js';
import { createStore, errorText } from './store.js';

/**
 * @typedef {object} PoliciesState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {Array<{ key: string, label: string, url: string | null, required: boolean }>} items
 * @property {string[]} accepted
 * @property {string | null} error
 */

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: import('./store.js').CheckoutClient,
 *   emit?: (name: string, data: Record<string, unknown>) => void }} options
 */
export const createPoliciesNotice = ({ strings = {}, client, emit = () => {} }) => {
	const t = createTranslator(strings);
	/** @type {ReturnType<typeof createStore<PoliciesState>>} */
	const store = createStore(/** @type {PoliciesState} */ ({ status: 'idle', items: [], accepted: [], error: null }));
	const validate = () =>
		store
			.get()
			.items.filter((item) => item.required && !store.get().accepted.includes(item.key))
			.map((item) => ({
				path: `/consents/${item.key}`,
				code: 'required',
				message: t('policies.required', { label: item.label }),
			}));

	const actions = Object.freeze({
		load: async () => {
			store.set({ status: 'loading' });
			const result = await client.get('/v1/policies');
			if (!result.ok) {
				store.set({ status: 'error', error: errorText(t, result.error.code) });
				return result;
			}
			store.set({ status: 'ready', items: result.value.items });
			return result;
		},
		/** @param {string} key @param {boolean} accepted */
		setAccepted: async (key, accepted) => {
			const current = store.get().accepted.filter((k) => k !== key);
			store.set({ accepted: accepted ? [...current, key] : current });
			emit('policies_notice.changed', { accepted: store.get().accepted.length });
			return { ok: /** @type {const} */ (true), value: store.get().accepted };
		},
	});

	return Object.freeze({
		state: store.get,
		actions,
		subscribe: store.subscribe,
		validate,
		strings,
		consents: () => store.get().accepted,
		destroy: store.destroy,
	});
};
