/**
 * Mode B headless core of the `capture` element — the "Notify me" form: state, actions, subscribe, validate,
 * strings, destroy (Part E §4). Framework-agnostic and DOM-free; the default renderer (ui/notifyMe.js) and any
 * merchant-built UI use exactly this core. `client` is the element's Mode C client (`GET /v1/alert-types`,
 * `POST /v1/subscriptions`, `DELETE /v1/subscriptions/{id}` with the website's `pk_` key and, when the shopper is signed
 * in on the website, their own login token as `SS-Identity`).
 */
import { CHANNELS, addressFor, fieldOf } from '../core/contact.js';
import { createTranslator } from './strings.js';

/** @typedef {{ type?: string, title?: string, status?: number, detail?: string, code?: string, errors?: Array<{ path: string, code: string }> }} Problem */
/**
 * @template T
 * @typedef {{ ok: true, value: T } | { ok: false, problem: Problem }} Result
 */
/**
 * @typedef {object} NotifyMeClient
 * @property {() => Promise<Result<{ items: Array<{ type: string, name: string, priceDrop?: { allowTarget: boolean } }>,
 *   capture: { channels: string[], requireConsent: boolean, doubleOptIn: boolean, allowEntry: boolean } }>>} alertTypes
 * @property {(body: Record<string, unknown>) => Promise<Result<Record<string, any>>>} subscribe
 * @property {(id: string) => Promise<Result<Record<string, any>>>} unsubscribe
 */
/**
 * @typedef {object} NotifyMeState
 * @property {'idle' | 'loading' | 'ready' | 'submitting' | 'subscribed' | 'unsubscribed' | 'error'} status
 * @property {string[]} types types the website offers (filtered by `config.types` when given)
 * @property {string | null} type
 * @property {string[]} channels
 * @property {string} channel
 * @property {string} email
 * @property {string} phone
 * @property {boolean} consent
 * @property {string} targetAmount minor units typed by the shopper (price drop only)
 * @property {boolean} allowTarget
 * @property {boolean} requireConsent
 * @property {boolean} allowEntry
 * @property {boolean} identified the shopper is signed in on the website (their address comes from the login)
 * @property {Record<string, any> | null} subscription
 * @property {string | null} message resolved, user-facing status or error text
 * @property {Record<string, string>} errors field → message
 */

/**
 * Adapt an `@ss/web/element` API client (`createElementApi`) to the element's client.
 * @param {{ get: (path: string) => Promise<any>, post: (path: string, body?: unknown) => Promise<any>, delete: (path: string) => Promise<any> }} api
 * @returns {NotifyMeClient}
 */
export const notifyMeClient = (api) => {
	/** @param {any} result @returns {Result<any>} */
	const wrap = (result) =>
		result.ok ? { ok: true, value: result.value } : { ok: false, problem: result.error ?? { code: 'request_failed' } };
	return Object.freeze({
		alertTypes: async () => wrap(await api.get('/v1/alert-types')),
		subscribe: async (body) => wrap(await api.post('/v1/subscriptions', body)),
		unsubscribe: async (id) => wrap(await api.delete(`/v1/subscriptions/${encodeURIComponent(id)}`)),
	});
};

/** Problem codes with their own message in the catalog. */
const KNOWN_ERRORS = new Set([
	'rate_limited',
	'in_stock',
	'entry_not_allowed',
	'limit_reached',
	'contact_invalid',
	'consent_required',
	'element_disabled',
	'subscription_inactive',
]);

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: NotifyMeClient,
 *   identity?: { signedIn?: boolean } | null, emit?: (name: string, data: Record<string, unknown>) => void }} options
 *   `config`: `{ itemId, variantId?, item?: { name?, url? }, price?: { amount, currency }, types?: string[], type?, lang? }`
 */
export const createNotifyMe = ({ config = {}, strings = {}, client, identity = null, emit = () => {} }) => {
	const t = createTranslator(strings);
	/** @type {Set<(state: NotifyMeState) => void>} */
	const listeners = new Set();
	let destroyed = false;
	/** @type {NotifyMeState} */
	let state = Object.freeze({
		status: 'idle',
		types: [],
		type: typeof config.type === 'string' ? config.type : null,
		channels: ['email'],
		channel: 'email',
		email: '',
		phone: '',
		consent: false,
		targetAmount: '',
		allowTarget: false,
		requireConsent: true,
		allowEntry: true,
		identified: identity?.signedIn === true,
		subscription: null,
		message: null,
		errors: {},
	});
	/** @param {Partial<NotifyMeState>} patch */
	const set = (patch) => {
		if (destroyed) return;
		state = Object.freeze({ ...state, ...patch });
		for (const listener of listeners) listener(state);
	};

	/**
	 * Field problems of a form value (pure).
	 * @param {Partial<NotifyMeState>} input
	 * @returns {Array<{ path: string, code: string, message: string }>}
	 */
	const validate = (input) => {
		const form = { ...state, ...input };
		/** @type {Array<{ path: string, code: string, message: string }>} */
		const problems = [];
		if (!form.type) problems.push({ path: '/type', code: 'required', message: t('capture.error.required') });
		const channel = /** @type {import('../core/contact.js').Channel} */ (
			CHANNELS.includes(/** @type {any} */ (form.channel)) ? form.channel : 'email'
		);
		const field = fieldOf(channel);
		const typed = field === 'email' ? form.email : form.phone;
		if (!form.identified || typed) {
			if (!typed) problems.push({ path: `/${field}`, code: 'required', message: t('capture.error.required') });
			else if (!addressFor(channel, typed))
				problems.push({ path: `/${field}`, code: 'contact_invalid', message: t('capture.error.contact_invalid') });
		}
		if (form.requireConsent && !form.consent)
			problems.push({ path: '/consent', code: 'consent_required', message: t('capture.error.consent_required') });
		if (form.targetAmount && !/^[1-9]\d{0,14}$/.test(form.targetAmount))
			problems.push({ path: '/threshold/targetAmount', code: 'invalid', message: t('capture.error.invalid') });
		return problems;
	};

	/** @param {Problem} problem */
	const messageOf = (problem) => {
		const code = problem.code ?? '';
		if (code === 'element_disabled' || code === 'subscription_inactive') return t('capture.error.unavailable');
		if (KNOWN_ERRORS.has(code)) return t(`capture.error.${code}`);
		return t('capture.error.request_failed');
	};

	const actions = Object.freeze({
		/** Load the website's alert types and form settings. */
		load: async () => {
			set({ status: 'loading', message: t('capture.loading') });
			const result = await client.alertTypes();
			if (!result.ok) {
				set({ status: 'error', message: messageOf(result.problem) });
				return result;
			}
			const offered = result.value.items.map((item) => item.type);
			const wanted = Array.isArray(config.types) ? offered.filter((type) => config.types.includes(type)) : offered;
			const type = state.type && wanted.includes(state.type) ? state.type : (wanted[0] ?? null);
			const channels = result.value.capture.channels.filter((channel) => CHANNELS.includes(/** @type {any} */ (channel)));
			set({
				status: 'ready',
				types: wanted,
				type,
				channels,
				channel: channels.includes(state.channel) ? state.channel : (channels[0] ?? 'email'),
				allowTarget: result.value.items.some((item) => item.type === 'price_drop' && item.priceDrop?.allowTarget === true),
				requireConsent: result.value.capture.requireConsent,
				allowEntry: result.value.capture.allowEntry,
				message: null,
			});
			return result;
		},
		/** @param {string} type */
		setType: async (type) => set({ type, errors: {} }),
		/** @param {string} channel */
		setChannel: async (channel) => set({ channel, errors: {} }),
		/** @param {string} email */
		setEmail: async (email) => set({ email: String(email ?? ''), errors: { ...state.errors, '/email': '' } }),
		/** @param {string} phone */
		setPhone: async (phone) => set({ phone: String(phone ?? ''), errors: { ...state.errors, '/phone': '' } }),
		/** @param {boolean} consent */
		setConsent: async (consent) => set({ consent: consent === true, errors: { ...state.errors, '/consent': '' } }),
		/** @param {string} amount minor units */
		setTarget: async (amount) => set({ targetAmount: String(amount ?? '').trim() }),
		/** Submit the form. */
		subscribe: async () => {
			const problems = validate({});
			if (problems.length > 0) {
				set({ errors: Object.fromEntries(problems.map((p) => [p.path, p.message])), message: problems[0]?.message ?? null });
				return { ok: false, problem: { code: 'validation_failed', errors: problems } };
			}
			set({ status: 'submitting', message: t('capture.submitting'), errors: {} });
			const field = fieldOf(/** @type {import('../core/contact.js').Channel} */ (state.channel));
			const typed = field === 'email' ? state.email : state.phone;
			const body = {
				type: state.type,
				itemId: config.itemId,
				...(config.variantId ? { variantId: config.variantId } : {}),
				channel: state.channel,
				...(typed ? { [field]: typed } : {}),
				consent: state.consent,
				...(config.lang ? { lang: config.lang } : strings['capture.locale'] ? { lang: strings['capture.locale'] } : {}),
				...(config.item ? { item: config.item } : {}),
				...(config.price ? { price: config.price } : {}),
				...(state.type === 'price_drop' && state.targetAmount
					? { threshold: { targetAmount: Number(state.targetAmount) } }
					: {}),
			};
			const result = await client.subscribe(body);
			if (!result.ok) {
				const errors = Object.fromEntries((result.problem.errors ?? []).map((e) => [e.path, messageOf({ code: e.code })]));
				set({ status: 'ready', message: messageOf(result.problem), errors });
				return result;
			}
			const sub = result.value;
			const contact = sub.contactMasked ?? '';
			set({
				status: 'subscribed',
				subscription: sub,
				message:
					sub.status === 'unconfirmed'
						? t('capture.success.unconfirmed', { contact })
						: [
								t('capture.success', { contact }),
								typeof sub.position === 'number' ? t('capture.position', { position: sub.position }) : '',
							]
								.filter(Boolean)
								.join(' '),
			});
			emit('capture.subscribed', { type: sub.type, channel: sub.channel, created: sub.created === true });
			return result;
		},
		/** Stop the alert just created (the customer's own; signed-in shoppers only). */
		unsubscribe: async () => {
			const id = state.subscription?.id;
			if (!id) return { ok: false, problem: { code: 'not_subscribed' } };
			const result = await client.unsubscribe(id);
			if (result.ok) {
				set({ status: 'unsubscribed', subscription: result.value, message: t('capture.unsubscribed') });
				emit('capture.unsubscribed', { type: result.value.type });
			} else set({ message: messageOf(result.problem) });
			return result;
		},
	});

	return Object.freeze({
		/** @returns {NotifyMeState} immutable snapshot */
		state: () => state,
		actions,
		/**
		 * @param {(state: NotifyMeState) => void} listener
		 * @returns {() => void}
		 */
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		validate,
		strings,
		t,
		destroy: () => {
			destroyed = true;
			listeners.clear();
		},
	});
};
