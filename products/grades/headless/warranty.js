/**
 * Mode B headless core of the `warranty` element: the warranty period, text and exclusions of every tier, and the one
 * of the selected tier (e.g. the variant the shopper picked).
 */
import { isKey } from '../core/text.js';
import { createStore, errorMessage } from './store.js';
import { createTranslator } from './strings.js';

/**
 * @typedef {{ tier: string, label: string, days: number, periodText: string, text: string, exclusions: string[] }} Term
 */

/**
 * @typedef {object} WarrantyState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {ReadonlyArray<Term>} terms
 * @property {string | null} selected
 * @property {Term | null} current
 * @property {string | null} error
 */

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: import('./store.js').ElementClient,
 *   emit?: import('./store.js').Emit }} options
 */
export const createWarranty = ({ strings = {}, client, emit = () => {} }) => {
	const t = createTranslator(strings);
	const store = createStore(
		/** @type {WarrantyState} */ ({ status: 'idle', terms: [], selected: null, current: null, error: null }),
	);
	/** @param {unknown} tier */
	const validate = (tier) =>
		tier === undefined || tier === null || isKey(tier)
			? []
			: [{ path: '/tier', code: 'tier_invalid', message: t('grades.error.tier_invalid') }];

	/** @param {ReadonlyArray<Term>} terms @param {string | null} tier */
	const pick = (terms, tier) => (tier ? (terms.find((term) => term.tier === tier) ?? null) : (terms[0] ?? null));

	/** @param {{ tier?: string | null }} [input] */
	const load = async ({ tier = null } = {}) => {
		const problems = validate(tier);
		if (problems.length > 0) {
			store.set({ status: 'error', error: problems[0]?.message ?? null });
			return { ok: false, error: { code: 'validation_failed' } };
		}
		store.set({ status: 'loading', error: null });
		const result = await client.get('/v1/warranty');
		if (!result.ok) {
			store.set({ status: 'error', error: errorMessage(t, strings, 'warranty', result.error) });
			return result;
		}
		const terms = /** @type {Term[]} */ (result.value.items);
		store.set({ status: 'ready', terms, selected: tier, current: pick(terms, tier) });
		return { ok: true, value: store.get() };
	};

	/** @param {string} tier */
	const select = async (tier) => {
		const current = pick(store.get().terms, tier);
		if (!current) return { ok: false, error: { code: 'not_found' } };
		store.set({ selected: tier, current });
		emit('warranty.tier_selected', { tier });
		return { ok: true, value: store.get() };
	};

	return {
		state: store.get,
		actions: { load, select },
		subscribe: store.subscribe,
		validate,
		strings,
		destroy: store.destroy,
	};
};
