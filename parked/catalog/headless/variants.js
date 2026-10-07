/**
 * Mode B headless core of the `variants` element: the option picker of one item. Options list only values used by
 * active variants; each value says whether it is available with the other selected options. Selecting a value that
 * has no exact variant with the current selection lands on the closest purchasable variant (most matching options),
 * so a shopper always ends on a real, priced variant. DOM-free; `client` is the Mode C client (`pk_` key).
 */
import { formatMoney } from '../core/money.js';
import { createTranslator } from './strings.js';
import { createStore, refused } from './store.js';

/**
 * @typedef {object} PickerOption
 * @property {string} key
 * @property {string} label
 * @property {Array<{ value: string, label: string, selected: boolean, available: boolean }>} values
 */
/**
 * @typedef {object} PickerState
 * @property {'idle' | 'loading' | 'ready' | 'error'} status
 * @property {{ id: string, title: string, currency: string | null } | null} item
 * @property {ReadonlyArray<PickerOption>} options
 * @property {Readonly<Record<string, string>>} selection
 * @property {Record<string, any> | null} variant the selected variant
 * @property {string | null} priceText
 * @property {string | null} compareText
 * @property {string | null} availabilityText
 * @property {boolean} purchasable
 * @property {string | null} error
 */

/**
 * The variant closest to a selection: exact match first, else the purchasable variant sharing most options (ties →
 * the earlier variant), else any variant sharing most options.
 * @param {ReadonlyArray<Record<string, any>>} variants
 * @param {Readonly<Record<string, string>>} selection
 * @param {string | null} [priority] the option the shopper just picked: it must match when possible
 */
export const closestVariant = (variants, selection, priority = null) => {
	const score = (/** @type {Record<string, any>} */ v) =>
		Object.entries(selection).filter(([key, value]) => v.options?.[key] === value).length;
	const keep = priority ? variants.filter((v) => v.options?.[priority] === selection[priority]) : [];
	const pool = keep.length > 0 ? keep : [...variants];
	const best = (/** @type {ReadonlyArray<Record<string, any>>} */ list) =>
		list.reduce((/** @type {Record<string, any> | null} */ top, v) => (top === null || score(v) > score(top) ? v : top), null);
	return best(pool.filter((v) => v.purchasable !== false)) ?? best(pool);
};

/**
 * @param {{ config?: Record<string, any>, strings?: Record<string, string>, client: import('./store.js').CatalogClient,
 *   emit?: (name: string, data: Record<string, unknown>) => void }} options
 */
export const createVariantPicker = ({ strings = {}, client, emit = () => {} }) => {
	const t = createTranslator(strings);
	const locale = strings['catalog.locale'] || 'en';
	const store = createStore(
		/** @type {PickerState} */ ({
			status: 'idle',
			item: null,
			options: [],
			selection: {},
			variant: null,
			priceText: null,
			compareText: null,
			availabilityText: null,
			purchasable: false,
			error: null,
		}),
	);
	/** @type {Array<Record<string, any>>} */
	let variants = [];
	/** @type {Array<{ key: string, label: string, values: Array<{ value: string, label: string }> }>} */
	let dimensions = [];

	/** @param {Readonly<Record<string, string>>} selection @param {Record<string, any> | null} variant */
	const settle = (selection, variant) => {
		const item = store.get().item;
		const options = dimensions.map((dimension) => ({
			key: dimension.key,
			label: dimension.label,
			values: dimension.values.map((v) => ({
				...v,
				selected: selection[dimension.key] === v.value,
				available: variants.some(
					(variant) =>
						variant.purchasable !== false &&
						variant.options?.[dimension.key] === v.value &&
						Object.entries(selection).every(([key, value]) => key === dimension.key || variant.options?.[key] === value),
				),
			})),
		}));
		store.set({
			options,
			selection,
			variant,
			priceText: variant ? formatMoney(variant.price, item?.currency ?? null, locale) : null,
			compareText:
				variant && typeof variant.compareAtPrice === 'number' && variant.compareAtPrice > variant.price
					? formatMoney(variant.compareAtPrice, item?.currency ?? null, locale)
					: null,
			availabilityText: variant ? t(`catalog.availability.${variant.availability}`) : null,
			purchasable: variant?.purchasable === true,
		});
	};

	const actions = Object.freeze({
		/**
		 * Load an item (id or slug) and pre-select its first purchasable variant (or `variantId`).
		 * @param {string} ref
		 * @param {{ variantId?: string }} [options]
		 */
		load: async (ref, { variantId } = {}) => {
			store.set({ status: 'loading', error: null });
			const result = await client.get(`/v1/items/${encodeURIComponent(ref)}`);
			if (!result.ok) {
				store.set({ status: 'error', error: t('catalog.error.load_failed') });
				return result;
			}
			const item = result.value;
			variants = item.variants ?? [];
			dimensions = item.options ?? [];
			store.set({ status: 'ready', item: { id: item.id, title: item.title, currency: item.currency ?? null } });
			const start = variants.find((v) => v.id === variantId) ?? variants.find((v) => v.purchasable) ?? variants[0] ?? null;
			settle(start ? { ...start.options } : {}, start);
			return result;
		},
		/**
		 * Pick an option value; lands on the exact or the closest variant.
		 * @param {string} key
		 * @param {string} value
		 */
		select: (key, value) => {
			const dimension = dimensions.find((d) => d.key === key);
			if (!dimension || !dimension.values.some((v) => v.value === value)) return refused('option_invalid');
			const wanted = { ...store.get().selection, [key]: value };
			const variant = closestVariant(variants, wanted, key);
			settle(variant ? { ...variant.options } : wanted, variant);
			if (variant) emit('selected', { itemId: store.get().item?.id ?? null, variantId: variant.id });
			return variant ? { ok: true, value: variant } : refused('no_variant');
		},
	});

	return Object.freeze({
		/** @returns {PickerState} */
		state: () => store.get(),
		actions,
		subscribe: store.subscribe,
		/** @returns {Array<{ path: string, code: string, message: string }>} */
		validate: () =>
			store.get().purchasable
				? []
				: [{ path: '/variant', code: 'not_purchasable', message: t('catalog.error.not_purchasable') }],
		strings,
		t,
		destroy: store.destroy,
	});
};
