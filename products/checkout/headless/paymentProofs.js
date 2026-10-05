/**
 * Mode B headless core of the `payment_proofs` element: upload a bank-transfer proof for an unpaid order. The server
 * signs a PUT to the merchant's own storage (content type and exact length signed), the file goes straight there with
 * the injected `upload` function (the host's `fetch`; no DOM here), then the server checks it arrived.
 */
import { createTranslator } from './strings.js';
import { createStore, errorText } from './store.js';

/**
 * @typedef {object} ProofState
 * @property {'idle' | 'uploading' | 'done' | 'error'} status
 * @property {string | null} reference
 * @property {string | null} message
 * @property {string | null} error
 */

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: import('./store.js').CheckoutClient,
 *   order: { id: string, token?: string | null },
 *   upload: (request: { method: string, url: string, headers: Record<string, string>, body: unknown }) => Promise<{ ok: boolean }>,
 *   emit?: (name: string, data: Record<string, unknown>) => void }} options
 */
export const createPaymentProofs = ({ config = {}, strings = {}, client, order, upload, emit = () => {} }) => {
	const t = createTranslator(strings);
	const types = Array.isArray(config.content_types) ? config.content_types : [];
	const maxBytes = Number.isInteger(config.max_bytes) ? config.max_bytes : 0;
	/** @type {ReturnType<typeof createStore<ProofState>>} */
	const store = createStore(/** @type {ProofState} */ ({ status: 'idle', reference: null, message: null, error: null }));
	const access = { orderId: order.id, ...(order.token ? { token: order.token } : {}) };

	/** @param {unknown} file `{ type, size }` */
	const validate = (file) => {
		const f = /** @type {{ type?: string, size?: number }} */ (file ?? {});
		if (types.length > 0 && !types.includes(String(f.type)))
			return [{ path: '/contentType', code: 'content_type_unsupported', message: t('proofs.error.type') }];
		if (maxBytes > 0 && Number(f.size) > maxBytes)
			return [{ path: '/size', code: 'too_large', message: t('proofs.error.size') }];
		return [];
	};

	const actions = Object.freeze({
		/** @param {string} reference */
		setReference: async (reference) => {
			store.set({ reference: reference.slice(0, 120) });
			return { ok: /** @type {const} */ (true), value: reference };
		},
		/** @param {{ type: string, size: number }} file the file (Blob / File); its bytes go to storage, not to Checkout */
		submit: async (file) => {
			const problems = validate(file);
			if (problems.length > 0) {
				store.set({ status: 'error', error: /** @type {any} */ (problems[0]).message });
				return { ok: /** @type {const} */ (false), error: { code: 'validation_failed' } };
			}
			store.set({ status: 'uploading', error: null });
			const reference = store.get().reference;
			const started = await client.post('/v1/payment-proofs', {
				...access,
				contentType: file.type,
				size: file.size,
				...(reference ? { reference } : {}),
			});
			if (!started.ok) {
				store.set({ status: 'error', error: errorText(t, started.error.code) });
				return started;
			}
			const sent = await upload({ ...started.value.upload, body: file });
			if (!sent.ok) {
				store.set({ status: 'error', error: t('proofs.error.upload') });
				return { ok: /** @type {const} */ (false), error: { code: 'upload_failed' } };
			}
			const done = await client.post(`/v1/payment-proofs/${encodeURIComponent(started.value.proofId)}/complete`, access);
			if (!done.ok) {
				store.set({ status: 'error', error: errorText(t, done.error.code) });
				return done;
			}
			store.set({ status: 'done', message: t('proofs.done') });
			emit('payment_proofs.submitted', {});
			return done;
		},
	});

	return Object.freeze({ state: store.get, actions, subscribe: store.subscribe, validate, strings, destroy: store.destroy });
};
