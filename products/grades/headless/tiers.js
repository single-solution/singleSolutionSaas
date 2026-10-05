/**
 * Mode B headless core of the `tiers` element: the tier badge of an item or variant, the tiers an item is offered in,
 * and the legend of every tier (Part E §4: state, actions, subscribe, validate, strings, destroy). `client` is the
 * element's Mode C client with the website's `pk_` key. The default renderer (ui/tiers.js) uses exactly this core.
 */
import { isId } from '../core/text.js';
import { ID_PROBLEM, badgeOf, createStore, errorMessage } from './store.js';
import { createTranslator } from './strings.js';

/**
 * @typedef {object} TiersState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {string | null} itemId
 * @property {string | null} variantId
 * @property {ReadonlyArray<import('./store.js').Badge>} legend every tier shown to shoppers
 * @property {ReadonlyArray<import('./store.js').Badge>} offered the item's tiers, best first
 * @property {import('./store.js').Badge | null} current the selected variant's tier, else the item's
 * @property {ReadonlyArray<{ variantId: string, tier: string }>} variants
 * @property {string | null} error
 */

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: import('./store.js').ElementClient,
 *   emit?: import('./store.js').Emit }} options
 */
export const createTierBadges = ({ strings = {}, client, emit = () => {} }) => {
	const t = createTranslator(strings);
	const store = createStore(
		/** @type {TiersState} */ ({
			status: 'idle',
			itemId: null,
			variantId: null,
			legend: [],
			offered: [],
			current: null,
			variants: [],
			error: null,
		}),
	);
	/** @type {Record<string, any> | null} */
	let item = null;

	/** @param {string | null} variantId */
	const currentOf = (variantId) => {
		if (!item) return null;
		const variant = variantId ? item.variants.find((/** @type {any} */ row) => row.variantId === variantId) : null;
		const tier = variant?.tier ?? item.tier ?? item.tiers[0] ?? null;
		return tier ? badgeOf(tier, t) : null;
	};

	/** @param {unknown} input */
	const validate = (input) =>
		input === undefined || input === null || isId(input)
			? []
			: [{ path: '/itemId', code: ID_PROBLEM, message: t('grades.error.id_invalid') }];

	/**
	 * Load the legend and, with an item id, the item's tiers.
	 * @param {{ itemId?: string | null, variantId?: string | null }} [input]
	 */
	const load = async ({ itemId = null, variantId = null } = {}) => {
		const problems = [...validate(itemId), ...validate(variantId)];
		if (problems.length > 0) {
			store.set({ status: 'error', error: problems[0]?.message ?? null });
			return { ok: false, error: { code: 'validation_failed' } };
		}
		store.set({ status: 'loading', error: null, itemId, variantId });
		const [definitions, own] = await Promise.all([
			client.get('/v1/tiers'),
			itemId ? client.get(`/v1/items/${encodeURIComponent(itemId)}`) : Promise.resolve(null),
		]);
		const failed = !definitions.ok ? definitions : own && !own.ok ? own : null;
		if (failed && !failed.ok) {
			store.set({ status: 'error', error: errorMessage(t, strings, 'tiers', failed.error) });
			return failed;
		}
		item = own && own.ok ? own.value : null;
		const legend = (definitions.ok ? definitions.value.items : []).map((/** @type {any} */ tier) => badgeOf(tier, t));
		store.set({
			status: 'ready',
			legend,
			offered: item ? item.tiers.map((/** @type {any} */ tier) => badgeOf(tier, t)) : [],
			variants: item ? item.variants.map((/** @type {any} */ row) => ({ variantId: row.variantId, tier: row.tier.key })) : [],
			current: currentOf(variantId),
		});
		emit('tiers.loaded', { itemId, tiers: store.get().offered.map((badge) => badge.key) });
		return { ok: true, value: store.get() };
	};

	/**
	 * Show the tier of another variant (e.g. when the shopper picks one).
	 * @param {string | null} variantId
	 */
	const selectVariant = async (variantId) => {
		if (variantId !== null && !isId(variantId)) return { ok: false, error: { code: 'validation_failed' } };
		store.set({ variantId, current: currentOf(variantId) });
		emit('tiers.variant_selected', { itemId: store.get().itemId, variantId, tier: store.get().current?.key ?? null });
		return { ok: true, value: store.get() };
	};

	return {
		state: store.get,
		actions: { load, selectVariant },
		subscribe: store.subscribe,
		validate,
		strings,
		destroy: store.destroy,
	};
};
