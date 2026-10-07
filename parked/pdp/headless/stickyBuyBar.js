/**
 * Mode B core of the `sticky_buy_bar` element: a compact title + price + call-to-action bar that shows by rule —
 * on the configured devices, once the page's own buy button scrolled out of view (or after a scroll depth, or
 * always), optionally hidden while the item is unavailable. Its action triggers the page's own buy button, so the
 * merchant's cart logic stays the only cart logic.
 * @module
 */
import { DEVICES, STICKY_MODES, deviceOf, stickyVisible } from '../core/page.js';
import { bool, int, oneOf, someOf, text } from '../core/util.js';
import { createItemElement, fail, instance, ok } from './base.js';
import { priceSettings, priceView } from './priceBlock.js';

export const STICKY_ACTIONS = Object.freeze(/** @type {const} */ (['click', 'scroll']));

/** @param {Record<string, unknown>} config */
export const stickySettings = (config) => ({
	devices: someOf(config.devices, DEVICES, ['mobile']),
	mode: oneOf(config.mode, STICKY_MODES, 'after_cta'),
	scrollPercent: int(config.scroll_percent, 0, 100, 30),
	ctaSelector: text(config.cta_selector, 200) || '[data-ss-buy]',
	action: oneOf(config.action, STICKY_ACTIONS, 'click'),
	hideUnavailable: bool(config.hide_unavailable, true),
	showPrice: bool(config.show_price, true),
	dismissible: bool(config.dismissible, false),
});

const UNAVAILABLE = new Set(['out_of_stock', 'discontinued']);

/**
 * @param {import('./base.js').ElementOptions} options
 */
export const createStickyBuyBar = (options) => {
	const settings = stickySettings(options.config ?? {});
	const money = priceSettings(options.config ?? {});
	const view = { device: 'mobile', ctaVisible: true, scrolled: 0, dismissed: false };
	/** @param {import('../core/item.js').Item | null} item */
	const visibleFor = (item) =>
		item !== null && stickyVisible(settings, { ...view, available: !UNAVAILABLE.has(item.availability) });
	const core = createItemElement({
		...options,
		prefix: 'sticky_buy_bar',
		extra: { ...settings, visible: false, price: '', availability: '' },
		derive: (item, locale) => ({
			visible: visibleFor(item),
			price: settings.showPrice ? priceView(item, money, locale).price : '',
			availability: item?.availability ?? '',
		}),
	});
	const { store } = core;
	const actions = {
		...core.actions,
		/**
		 * Report the viewport: `width` (or `device`), whether the page's buy button is visible, the scroll depth (%).
		 * @param {{ width?: number, device?: string, ctaVisible?: boolean, scrolled?: number }} input
		 */
		setViewport: async (input) => {
			if (typeof input.width === 'number') view.device = deviceOf(input.width);
			else if (DEVICES.includes(/** @type {any} */ (input.device))) view.device = String(input.device);
			if (typeof input.ctaVisible === 'boolean') view.ctaVisible = input.ctaVisible;
			if (typeof input.scrolled === 'number') view.scrolled = Math.max(0, Math.min(100, input.scrolled));
			const visible = visibleFor(store.get().item);
			if (visible !== store.get().visible) store.set({ visible });
			return ok(visible);
		},
		/**
		 * The visitor pressed the bar's button: returns what the renderer does (`click` or `scroll` to the page's button).
		 * @returns {Promise<import('./base.js').Result<'click' | 'scroll'>>}
		 */
		buy: async () => {
			if (!store.get().visible) return fail('not_visible');
			core.emit('clicked', { action: settings.action });
			return ok(settings.action);
		},
		dismiss: async () => {
			if (!settings.dismissible) return fail('not_dismissible');
			view.dismissed = true;
			store.set({ visible: false });
			core.emit('dismissed', {});
			return ok(true);
		},
	};
	return instance({ ...core, actions, strings: options.strings ?? {} });
};
