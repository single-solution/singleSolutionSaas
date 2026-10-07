/**
 * Mode B headless core of the `checkout_form` element: the form schema from the server (`GET /v1/checkout-form`), the
 * shopper's values, local required / length checks for instant feedback, and the server's validation
 * (`POST /v1/checkout-form:validate`, the same rules placement applies). DOM-free; every field, order, label and
 * autocomplete token comes from the website's settings.
 */
import { createTranslator } from './strings.js';
import { createStore, errorText } from './store.js';

/**
 * @typedef {object} FormState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {Record<string, any> | null} form resolved form (contact, address, custom fields, delivery methods)
 * @property {{ country: string | null, contact: Record<string, any>, address: Record<string, any>, custom: Record<string, any>,
 *   deliveryMethod: string | null, pickupLocation: string | null }} values
 * @property {Record<string, string>} errors JSON pointer → message
 * @property {boolean} needsAddress
 * @property {Array<Record<string, any>>} savedAddresses
 * @property {string | null} error
 */

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: import('./store.js').CheckoutClient,
 *   emit?: (name: string, data: Record<string, unknown>) => void }} options
 */
export const createCheckoutForm = ({ strings = {}, client, emit = () => {} }) => {
	const t = createTranslator(strings);
	/** @type {ReturnType<typeof createStore<FormState>>} */
	const store = createStore(
		/** @type {FormState} */ ({
			status: 'idle',
			form: null,
			values: { country: null, contact: {}, address: {}, custom: {}, deliveryMethod: null, pickupLocation: null },
			errors: {},
			needsAddress: false,
			savedAddresses: [],
			error: null,
		}),
	);
	/** @param {Record<string, any> | null} form @param {string | null} key */
	const needsAddress = (form, key) =>
		Boolean(form?.deliveryMethods?.find((/** @type {any} */ m) => m.key === key)?.requires_address);

	/**
	 * Local checks (required, length) — the server repeats every check.
	 * @param {unknown} input values
	 * @returns {Array<{ path: string, code: string, message: string }>}
	 */
	const validate = (input) => {
		const form = store.get().form;
		const values = /** @type {FormState['values']} */ (input ?? store.get().values);
		if (!form) return [];
		/** @type {Array<{ path: string, code: string, message: string }>} */
		const problems = [];
		/** @param {string} group @param {any[]} fields @param {Record<string, any>} given */
		const check = (group, fields, given) => {
			for (const field of fields) {
				const value = given?.[field.key];
				const empty = value === undefined || value === null || value === '' || (field.kind === 'checkbox' && value !== true);
				if (field.required && empty)
					problems.push({ path: `/${group}/${field.key}`, code: 'required', message: t('checkout_form.error.required') });
				else if (typeof value === 'string' && value.length > field.max_length)
					problems.push({ path: `/${group}/${field.key}`, code: 'too_long', message: t('checkout_form.error.too_long') });
			}
		};
		check('contact', form.contact, values.contact);
		check('custom', form.custom, values.custom);
		if (needsAddress(form, values.deliveryMethod)) check('address', form.address, values.address);
		if (!values.deliveryMethod)
			problems.push({ path: '/deliveryMethod', code: 'required', message: t('checkout_form.error.delivery') });
		return problems;
	};

	/** @param {Partial<FormState['values']>} patch */
	const setValues = (patch) => {
		const values = { ...store.get().values, ...patch };
		store.set({ values, needsAddress: needsAddress(store.get().form, values.deliveryMethod) });
		return { ok: /** @type {const} */ (true), value: values };
	};

	const actions = Object.freeze({
		/** @param {string | null} [country] */
		load: async (country = null) => {
			store.set({ status: 'loading', error: null });
			const result = await client.get('/v1/checkout-form', { query: country ? { country } : {} });
			if (!result.ok) {
				store.set({ status: 'error', error: errorText(t, result.error.code) });
				return result;
			}
			const form = result.value;
			const values = store.get().values;
			const deliveryMethod = form.deliveryMethods.some((/** @type {any} */ m) => m.key === values.deliveryMethod)
				? values.deliveryMethod
				: (form.deliveryMethods[0]?.key ?? null);
			store.set({
				status: 'ready',
				form,
				values: { ...values, country: form.country, deliveryMethod },
				needsAddress: needsAddress(form, deliveryMethod),
			});
			return result;
		},
		/** Saved addresses of a signed-in shopper. */
		loadAddresses: async () => {
			const result = await client.get('/v1/addresses');
			if (result.ok) store.set({ savedAddresses: result.value.items });
			return result;
		},
		/** @param {'contact' | 'address' | 'custom'} group @param {string} key @param {unknown} value */
		setField: async (group, key, value) => {
			const current = store.get().values;
			const errors = { ...store.get().errors };
			delete errors[`/${group}/${key}`];
			store.set({ errors });
			return setValues({ [group]: { ...current[group], [key]: value } });
		},
		/** @param {string} country */
		setCountry: async (country) => {
			setValues({ country });
			return actions.load(country);
		},
		/** @param {string} key */
		setDelivery: async (key) => {
			emit('checkout_form.delivery_selected', { method: key });
			return setValues({ deliveryMethod: key });
		},
		/** @param {string} key */
		setPickup: async (key) => setValues({ pickupLocation: key }),
		/** Fill the address from a saved one. @param {string} id */
		useAddress: async (id) => {
			const saved = store.get().savedAddresses.find((entry) => entry.id === id);
			return saved ? setValues({ address: { ...saved.address } }) : { ok: false, error: { code: 'not_found' } };
		},
		/** Local checks, then the server's. */
		check: async () => {
			const local = validate(store.get().values);
			if (local.length > 0) {
				store.set({ errors: Object.fromEntries(local.map((p) => [p.path, p.message])) });
				return { ok: false, error: { code: 'validation_failed' } };
			}
			const result = await client.post('/v1/checkout-form:validate', store.get().values);
			if (!result.ok) return result;
			const errors = Object.fromEntries(
				result.value.errors.map((/** @type {any} */ e) => [
					e.path,
					t(`checkout_form.error.${e.code}`) === `checkout_form.error.${e.code}`
						? e.message
						: t(`checkout_form.error.${e.code}`),
				]),
			);
			store.set({ errors });
			return result.value.valid
				? { ok: true, value: result.value.values }
				: { ok: false, error: { code: 'validation_failed' } };
		},
	});

	return Object.freeze({
		state: store.get,
		actions,
		subscribe: store.subscribe,
		validate,
		strings,
		/** The values in the shape placement takes (`POST /v1/orders`). */
		payload: () => {
			const { values } = store.get();
			return {
				...(values.country ? { country: values.country } : {}),
				contact: values.contact,
				...(store.get().needsAddress ? { address: values.address } : {}),
				custom: values.custom,
				deliveryMethod: values.deliveryMethod,
				...(values.pickupLocation ? { pickupLocation: values.pickupLocation } : {}),
			};
		},
		destroy: store.destroy,
	});
};
