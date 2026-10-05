/**
 * Mode B headless core of the `fulfilment` element: a guest tracking lookup by order number and the e-mail or phone
 * used at checkout (POST /v1/tracking-lookups) — status, timeline, carrier, tracking number and link. No personal
 * data comes back. DOM-free.
 */
import { createTranslator } from './strings.js';
import { createStore, refused } from './store.js';

/**
 * @typedef {object} TrackingState
 * @property {'idle' | 'loading' | 'ready' | 'not_found' | 'error'} status
 * @property {string} number
 * @property {string} contact
 * @property {Record<string, any> | null} result
 * @property {string | null} error
 */

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: import('./store.js').OrdersClient,
 *   emit?: (name: string, data: Record<string, unknown>) => void }} options
 */
export const createTracking = ({ strings = {}, client, emit = () => {} }) => {
	const t = createTranslator(strings);
	const store = createStore(
		/** @type {TrackingState} */ ({ status: 'idle', number: '', contact: '', result: null, error: null }),
	);

	/** @param {{ number?: string, contact?: string }} [input] */
	const validate = (input = store.get()) => [
		...(String(input.number ?? '').trim() === ''
			? [{ path: '/number', code: 'required', message: t('tracking.number_required') }]
			: []),
		...(String(input.contact ?? '').trim() === ''
			? [{ path: '/contact', code: 'required', message: t('tracking.contact_required') }]
			: []),
	];

	const actions = Object.freeze({
		/** @param {string} value */
		setNumber: (value) => {
			store.set({ number: String(value).slice(0, 64) });
			return { ok: true, value: store.get().number };
		},
		/** @param {string} value */
		setContact: (value) => {
			store.set({ contact: String(value).slice(0, 320) });
			return { ok: true, value: store.get().contact };
		},
		lookup: async () => {
			const problems = validate();
			if (problems.length > 0) {
				store.set({ error: problems[0]?.message ?? null });
				return refused('validation_failed');
			}
			const { number, contact } = store.get();
			store.set({ status: 'loading', error: null });
			const result = await client.post('/v1/tracking-lookups', { number: number.trim(), contact: contact.trim() });
			if (!result.ok) {
				const notFound = result.error.code === 'not_found';
				store.set({
					status: notFound ? 'not_found' : 'error',
					result: null,
					error: t(notFound ? 'tracking.not_found' : 'tracking.error'),
				});
				return result;
			}
			store.set({ status: 'ready', result: result.value });
			emit('looked_up', { status: result.value.status });
			return result;
		},
		reset: () => {
			store.set({ status: 'idle', result: null, error: null });
			return { ok: true, value: null };
		},
	});

	return Object.freeze({
		/** @returns {TrackingState} */
		state: () => store.get(),
		actions,
		subscribe: store.subscribe,
		validate,
		strings,
		t,
		destroy: store.destroy,
	});
};
