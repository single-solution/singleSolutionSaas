/**
 * Effective settings of a website: which elements are on (signed entitlement document) and their configuration
 * (feature schemas' defaults overlaid with the document's values). Every number, flag and choice the product uses comes
 * from here — nothing is hard-coded.
 */
import { effectiveConfig } from '../core/config.js';
import guestMerge from '../schemas/guest_merge.features.json' with { type: 'json' };
import lists from '../schemas/lists.features.json' with { type: 'json' };
import priceDropHook from '../schemas/price_drop_hook.features.json' with { type: 'json' };
import share from '../schemas/share.features.json' with { type: 'json' };
import widgets from '../schemas/widgets.features.json' with { type: 'json' };

/** Feature schema of every element. */
export const SCHEMAS = Object.freeze({ lists, guest_merge: guestMerge, share, price_drop_hook: priceDropHook, widgets });

/** @typedef {keyof typeof SCHEMAS} ElementKey */

/**
 * @typedef {object} Settings
 * @property {(key: ElementKey) => boolean} enabled
 * @property {{ maxLists: number, maxItems: number, whenFull: 'evict_oldest' | 'refuse', maxNameLength: number,
 *   urlPolicy: 'same_site' | 'any_https' | 'none', imagePolicy: 'same_site' | 'any_https' | 'none',
 *   writesPerMinute: number }} lists
 * @property {{ ttlDays: number, storage: 'local' | 'session' | 'memory', consentCategory: string,
 *   strategy: 'into_default' | 'keep_lists', perIpPerHour: number }} guests
 * @property {{ pageUrl: string, ttlDays: number, showPrices: boolean, allowGuests: boolean }} share
 * @property {import('../core/signals.js').SignalSettings & { acceptCustomerEvents: boolean, includeEmail: boolean,
 *   maxLists: number }} signals
 * @property {{ announce: boolean, layout: 'grid' | 'rows', manageLists: boolean, loadsPerMinute: number }} widgets
 */

/**
 * @param {{ can: (key: string) => boolean, config: (key: string) => Record<string, unknown> | null | undefined }} source
 * @returns {Settings}
 */
export const settingsFrom = ({ can, config }) => {
	const of = (/** @type {ElementKey} */ key) => effectiveConfig(SCHEMAS[key], config(key));
	const l = of('lists');
	const g = of('guest_merge');
	const s = of('share');
	const p = of('price_drop_hook');
	const w = of('widgets');
	return {
		enabled: (key) => can(key),
		lists: {
			maxLists: l.max_lists,
			maxItems: l.max_items_per_list,
			whenFull: l.when_full,
			maxNameLength: l.max_name_length,
			urlPolicy: l.item_url_policy,
			imagePolicy: l.image_url_policy,
			writesPerMinute: l.max_writes_per_minute,
		},
		guests: {
			ttlDays: g.guest_ttl_days,
			storage: g.storage,
			consentCategory: g.consent_category,
			strategy: g.merge_strategy,
			perIpPerHour: g.max_guests_per_ip_per_hour,
		},
		share: { pageUrl: s.page_url, ttlDays: s.ttl_days, showPrices: s.show_prices, allowGuests: s.allow_guests },
		signals: {
			priceDrops: p.price_drops,
			backInStock: p.back_in_stock,
			minDropPercent: p.min_drop_percent,
			minDropAmount: p.min_drop_amount,
			cooldownHours: p.cooldown_hours,
			inStockThreshold: p.in_stock_threshold,
			locations: p.locations,
			acceptCustomerEvents: p.accept_customer_events,
			includeEmail: p.include_email,
			maxLists: p.max_lists_per_event,
		},
		widgets: {
			announce: w.announce_changes,
			layout: w.page_layout,
			manageLists: w.page_manage_lists,
			loadsPerMinute: w.max_loads_per_minute,
		},
	};
};

/**
 * Settings from a signed entitlement document through the app-kit helpers.
 * @param {any} product app-kit product
 * @param {any} doc entitlement document
 * @returns {Settings}
 */
export const settingsForDoc = (product, doc) =>
	settingsFrom({
		can: (key) => product.entitlements.can(doc, key),
		config: (key) => product.entitlements.config(doc, key) ?? {},
	});
