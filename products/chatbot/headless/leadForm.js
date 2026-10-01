/**
 * Mode B headless core of `lead_capture`: the configured fields with labels, values, client-side validation (the same
 * rules as the server) and submission (`POST /v1/leads`), optionally attached to the current conversation.
 * @module
 */
import { validateField } from '../core/leads.js';
import { createChatClient } from './chatClient.js';
import { createTranslator } from './strings.js';

/**
 * @typedef {object} LeadFormState
 * @property {'idle' | 'submitting' | 'submitted' | 'error'} status
 * @property {ReadonlyArray<{ name: string, type: string, label: string, required: boolean, options: string[] }>} fields
 * @property {Readonly<Record<string, unknown>>} values
 * @property {boolean} consent
 * @property {boolean} consentRequired
 * @property {Readonly<Record<string, string>>} errors field → message
 * @property {string | null} error
 */

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: any, identity?: { token: () => string | null | undefined } | null,
 *   emit?: (name: string, data: Record<string, unknown>) => void, storage?: import('./chatClient.js').TokenStorage, conversationId?: string | null }} options
 */
export const createLeadForm = ({
	config = {},
	strings = {},
	client,
	identity = null,
	emit = () => {},
	storage,
	conversationId = null,
}) => {
	const t = createTranslator(strings);
	const chat =
		client && typeof client.lead === 'function'
			? client
			: createChatClient({ api: client, ...(storage ? { storage } : {}), identity });
	const fields = (Array.isArray(config.fields) ? config.fields : []).map((/** @type {any} */ f) => ({
		name: String(f.name),
		type: String(f.type),
		label: f.label || t(`lead.field.${f.name}`),
		required: f.required === true,
		options: Array.isArray(f.options) ? f.options : [],
		...(f.max_length ? { max_length: f.max_length } : {}),
	}));
	/** @type {Set<(state: LeadFormState) => void>} */
	const listeners = new Set();
	let destroyed = false;
	/** @type {LeadFormState} */
	let state = Object.freeze({
		status: 'idle',
		fields,
		values: {},
		consent: false,
		consentRequired: config.consent_required !== false,
		errors: {},
		error: null,
	});
	/** @param {Partial<LeadFormState>} patch */
	const set = (patch) => {
		if (destroyed) return;
		state = Object.freeze({ ...state, ...patch });
		for (const listener of listeners) listener(state);
	};
	/** @param {Record<string, unknown>} values @param {boolean} consent */
	const check = (values, consent) => {
		/** @type {Record<string, string>} */
		const errors = {};
		for (const field of fields) {
			const code = validateField(field, values[field.name]);
			if (code) errors[field.name] = t(code === 'required' ? 'window.form.required' : 'window.form.invalid');
		}
		if (state.consentRequired && !consent) errors.consent = t('window.form.required');
		return errors;
	};

	const actions = Object.freeze({
		/** @param {string} name @param {unknown} value */
		setValue: async (name, value) => {
			set({ values: { ...state.values, [name]: value } });
			return { ok: true, value: state.values };
		},
		/** @param {boolean} value */
		setConsent: async (value) => {
			set({ consent: value === true });
			return { ok: true, value: state.consent };
		},
		submit: async () => {
			const errors = check(state.values, state.consent);
			if (Object.keys(errors).length > 0) {
				set({ errors, status: 'error', error: t('window.form.invalid') });
				return { ok: false, error: { code: 'validation_failed', status: 422 } };
			}
			set({ status: 'submitting', errors: {}, error: null });
			const result = await chat.lead({
				...(conversationId ? { conversationId } : {}),
				fields: { ...state.values },
				consent: state.consent,
			});
			if (!result.ok) {
				set({ status: 'error', error: t('lead.error.request_failed') });
				return result;
			}
			set({ status: 'submitted' });
			emit('submitted', {});
			return result;
		},
	});

	return Object.freeze({
		/** @returns {LeadFormState} */
		state: () => state,
		actions,
		/** @param {(state: LeadFormState) => void} listener */
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		/** @param {unknown} input `{ values, consent }` */
		validate: (input) => {
			const i = /** @type {any} */ (input) ?? {};
			return Object.entries(check(i.values ?? {}, i.consent === true)).map(([name, message]) => ({
				path: `/${name}`,
				code: 'invalid',
				message,
			}));
		},
		strings,
		t,
		destroy: () => {
			destroyed = true;
			listeners.clear();
		},
	});
};
