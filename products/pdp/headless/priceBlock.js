/**
 * Mode B core of the `price_block` element: the price formatted for the page's locale and currency, the compare-at
 * price and savings, availability copy, and per-variant updates (a configurator or the merchant's code sends the
 * selected variant's price, compare-at price, currency and availability).
 * @module
 */
import { CURRENCY_DISPLAYS, formatMoney, savings } from '../core/display.js';
import { normaliseItem } from '../core/item.js';
import { bool, int, isObject, oneOf, text } from '../core/util.js';
import { createItemElement, fail, instance, ok } from './base.js';

export const SAVINGS = Object.freeze(/** @type {const} */ (['none', 'amount', 'percent', 'both']));

/** @param {Record<string, unknown>} config */
export const priceSettings = (config) => ({
	display: oneOf(config.currency_display, CURRENCY_DISPLAYS, 'symbol'),
	digits: int(config.fraction_digits, -1, 4, -1),
	locale: text(config.locale, 35),
	savings: oneOf(config.savings, SAVINGS, 'percent'),
	showAvailability: bool(config.show_availability, true),
	showTaxes: bool(config.show_taxes, false),
	showFinancing: bool(config.show_financing, false),
	updateEvent: text(config.update_event, 120),
});

/**
 * Formatted view of an item's price.
 * @param {import('../core/item.js').Item | null} item
 * @param {ReturnType<typeof priceSettings>} settings
 * @param {string} locale
 */
export const priceView = (item, settings, locale) => {
	const options = { locale: settings.locale || locale, display: settings.display, digits: settings.digits };
	const saved = item ? savings(item.price, item.compareAtPrice) : null;
	return {
		price: item ? formatMoney(item.price, item.currency, options) : '',
		compareAt: item && saved ? formatMoney(item.compareAtPrice, item.currency, options) : '',
		saving: saved ? formatMoney(saved.amount, item?.currency ?? '', options) : '',
		percent: saved ? saved.percent : 0,
		availability: item?.availability ?? '',
	};
};

/**
 * @param {import('./base.js').ElementOptions} options
 */
export const createPriceBlock = (options) => {
	const settings = priceSettings(options.config ?? {});
	const core = createItemElement({
		...options,
		prefix: 'price_block',
		extra: { ...settings, view: priceView(null, settings, '') },
		usable: (item) => item.price !== '',
		derive: (item, locale) => ({ view: priceView(item, settings, locale) }),
	});
	const { store } = core;
	const actions = {
		...core.actions,
		/**
		 * Apply the selected variant's `{ price, compareAtPrice?, currency?, availability?, stock? }`.
		 * @param {unknown} data
		 * @returns {Promise<import('./base.js').Result<string>>}
		 */
		setVariant: async (data) => {
			const current = store.get().item;
			if (!isObject(data) || !current) return fail('variant_invalid');
			const next = normaliseItem({
				...current,
				price: data.price,
				compareAtPrice: data.compareAtPrice ?? '',
				currency: data.currency ?? current.currency,
				availability: data.availability ?? current.availability,
				stock: data.stock,
			});
			if (next.price === '') return fail('variant_invalid');
			store.set({ item: next, view: priceView(next, settings, store.get().locale) });
			core.emit('variant_applied', {});
			return ok(next.price);
		},
	};
	return instance({ ...core, actions, strings: options.strings ?? {} });
};
