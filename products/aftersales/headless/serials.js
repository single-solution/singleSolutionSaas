/**
 * Mode B headless core of the `serial_registry` element: the public warranty lookup (state, actions, subscribe,
 * validate, strings, destroy — Part E §4). DOM-free; `client` is the element's Mode C client with the website's `pk_`
 * key. A lookup shows the item, its sale date (when the merchant shows it) and its cover per claim type — never the
 * order or the customer.
 */
import { createTranslator } from './strings.js';

/** @typedef {{ code?: string, status?: number }} Problem */
/**
 * @typedef {object} SerialsClient
 * @property {(path: string) => Promise<{ ok: true, value: any } | { ok: false, error: Problem }>} get
 */
/**
 * @typedef {object} SerialState
 * @property {'idle' | 'loading' | 'found' | 'not_found' | 'error'} status
 * @property {string} serial the typed serial
 * @property {Record<string, any> | null} result `GET /v1/serials/{serial}`
 * @property {ReadonlyArray<{ type: string, text: string, active: boolean }>} cover display lines
 * @property {string | null} error
 */

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: SerialsClient,
 *   emit?: (name: string, data: Record<string, unknown>) => void }} options
 */
export const createSerialLookup = ({ config = {}, strings = {}, client, emit = () => {} }) => {
	const t = createTranslator(strings);
	const minLength = Number.isInteger(config.min_length) ? config.min_length : 1;
	const maxLength = Number.isInteger(config.max_length) ? config.max_length : 128;
	/** @type {Set<(state: SerialState) => void>} */
	const listeners = new Set();
	let destroyed = false;
	/** @type {SerialState} */
	let state = Object.freeze({ status: 'idle', serial: '', result: null, cover: [], error: null });
	/** @param {Partial<SerialState>} patch */
	const set = (patch) => {
		if (destroyed) return;
		state = Object.freeze({ ...state, ...patch });
		for (const listener of listeners) listener(state);
	};
	/** @param {string} value @returns {Array<{ path: string, code: string, message: string }>} */
	const validate = (value) => {
		const serial = value.trim();
		if (serial.length < minLength) return [{ path: '/serial', code: 'too_short', message: t('serials.field.too_short') }];
		if (serial.length > maxLength) return [{ path: '/serial', code: 'too_long', message: t('serials.field.too_long') }];
		return [];
	};
	const actions = Object.freeze({
		/** @param {string} serial */
		setSerial: (serial) => set({ serial }),
		/** Look the typed serial up. */
		lookup: async () => {
			const problems = validate(state.serial);
			if (problems.length > 0) {
				set({ status: 'error', error: /** @type {{ message: string }} */ (problems[0]).message });
				return { ok: false, error: { code: 'validation_failed' } };
			}
			set({ status: 'loading', error: null });
			const result = await client.get(`/v1/serials/${encodeURIComponent(state.serial.trim())}`);
			if (!result.ok) {
				const missing = result.error.code === 'not_found' || result.error.status === 404;
				set({
					status: missing ? 'not_found' : 'error',
					result: null,
					cover: [],
					error: missing ? t('serials.not_found') : t('serials.error'),
				});
				return result;
			}
			const cover = /** @type {Array<Record<string, any>>} */ (result.value.cover ?? []).map((entry) => ({
				type: entry.type,
				active: entry.active === true,
				text: t(entry.active ? 'serials.cover.active' : 'serials.cover.ended', {
					type: entry.label,
					date: typeof entry.endsAt === 'string' ? entry.endsAt.slice(0, 10) : '—',
				}),
			}));
			set({ status: 'found', result: result.value, cover });
			emit('serial_registry.looked_up', { active: cover.some((entry) => entry.active) });
			return result;
		},
		reset: () => set({ status: 'idle', serial: '', result: null, cover: [], error: null }),
	});
	return Object.freeze({
		/** @returns {SerialState} */
		state: () => state,
		actions,
		/** @param {(state: SerialState) => void} listener */
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
