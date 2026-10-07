/**
 * Effective settings of a website: which elements are on (signed entitlement document) and their configuration
 * (feature schemas' defaults overlaid with the document's values). Every number, flag and list the product uses
 * comes from here — nothing is hard-coded.
 */
import { effectiveConfig } from '../core/config.js';
import { KIND_ELEMENT } from '../core/deals.js';
import { createPolicy } from '../core/stacking.js';
import { HOUR_MS, isTimeZone } from '../core/time.js';
import badges from '../schemas/badges.features.json' with { type: 'json' };
import bundles from '../schemas/bundles.features.json' with { type: 'json' };
import cartDeals from '../schemas/cart_deals.features.json' with { type: 'json' };
import dealsPage from '../schemas/deals_page.features.json' with { type: 'json' };
import flashSales from '../schemas/flash_sales.features.json' with { type: 'json' };
import itemDeals from '../schemas/item_deals.features.json' with { type: 'json' };
import priceLocks from '../schemas/price_locks.features.json' with { type: 'json' };
import quoteApi from '../schemas/quote_api.features.json' with { type: 'json' };
import reporting from '../schemas/reporting.features.json' with { type: 'json' };
import stacking from '../schemas/stacking.features.json' with { type: 'json' };

/** Feature schema of every element. */
export const SCHEMAS = Object.freeze({
	quote_api: quoteApi,
	item_deals: itemDeals,
	cart_deals: cartDeals,
	flash_sales: flashSales,
	bundles,
	stacking,
	price_locks: priceLocks,
	badges,
	deals_page: dealsPage,
	reporting,
});

/** @typedef {keyof typeof SCHEMAS} ElementKey */

/**
 * @typedef {object} Settings
 * @property {(key: ElementKey) => boolean} enabled
 * @property {string} timeZone
 * @property {Record<string, any>} quote quote_api features
 * @property {import('../core/deals.js').DealRules} dealRules
 * @property {Record<'item' | 'cart' | 'flash' | 'bundle', number>} maxActive
 * @property {{ combinesWithCoupons: boolean, combinesWithLoyalty: boolean }} defaults
 * @property {import('../core/evaluate.js').EngineSettings} engine
 * @property {import('../core/offers.js').DisplaySettings} display
 * @property {{ enabled: boolean, ttlMinutes: number, policy: import('../core/locks.js').LockPolicy, issueOnQuote: boolean,
 *   issueOnOffers: boolean, bindToCustomer: boolean, maxUnits: number }} locks
 * @property {Record<string, any>} badges
 * @property {Record<string, any>} dealsPage
 * @property {Record<string, any>} reporting
 */

/**
 * @param {{ can: (key: string) => boolean, config: (key: string) => Record<string, unknown> | null | undefined }} source
 * @returns {Settings}
 */
export const settingsFrom = ({ can, config }) => {
	const of = (/** @type {ElementKey} */ key) => effectiveConfig(SCHEMAS[key], config(key));
	const enabled = (/** @type {ElementKey} */ key) => can(key);
	const quote = of('quote_api');
	const stack = of('stacking');
	const locks = of('price_locks');
	const badge = of('badges');
	const cart = of('cart_deals');
	const timeZone = isTimeZone(quote.time_zone) ? quote.time_zone : 'UTC';
	// stacking off: no class combines with any other; on: the configured classes
	const classes = /** @type {import('../core/stacking.js').ClassConfig[]} */ (Array.isArray(stack.classes) ? stack.classes : []);
	const classKeys = classes.map((c) => c.key);
	/** @param {Record<string, any>} c */
	const kind = (c, extra = {}) => ({
		enabled: true,
		maxPercent: c.max_percent,
		allowStorewide: c.allow_storewide !== false,
		maxWindows: c.max_windows,
		defaultClass: classKeys.includes(c.default_class) ? c.default_class : (classKeys[0] ?? c.default_class),
		defaultPriority: c.default_priority,
		...extra,
	});
	const item = of('item_deals');
	const flash = of('flash_sales');
	const bundle = of('bundles');
	const kinds = {
		item: kind(item),
		cart: kind(cart, { maxTiers: cart.max_tiers }),
		flash: kind(flash, { requireEnd: flash.require_end, maxDurationHours: flash.max_duration_hours }),
		bundle: kind(bundle, { maxComponents: bundle.max_components }),
	};
	for (const [k, element] of Object.entries(KIND_ELEMENT))
		/** @type {any} */ (kinds)[k].enabled = enabled(/** @type {ElementKey} */ (element));
	return {
		enabled,
		timeZone,
		quote,
		dealRules: { kinds, classes: classKeys, maxConditionLength: quote.max_condition_length },
		maxActive: { item: item.max_active, cart: cart.max_active, flash: flash.max_active, bundle: bundle.max_active },
		defaults: { combinesWithCoupons: stack.coupons_default, combinesWithLoyalty: stack.loyalty_default },
		engine: {
			timeZone,
			rounding: quote.rounding,
			kinds: { item: kinds.item.enabled, cart: kinds.cart.enabled, flash: kinds.flash.enabled, bundle: kinds.bundle.enabled },
			policy: createPolicy({ enabled: enabled('stacking'), classes }),
			strategy: enabled('stacking') ? stack.strategy : 'best_for_customer',
			maxDealsPerLine: enabled('stacking') ? stack.max_deals_per_line : 1,
			searchLimit: stack.search_limit,
			thresholdBasis: cart.threshold_basis,
			maxHints: cart.max_hints,
			anonymousLimited: quote.anonymous_limited_deals,
			preferLive: locks.prefer_better_live_price,
			maxBundleInstances: bundle.max_instances_per_order,
		},
		display: {
			countdownWithinMs: badge.countdown_within_hours * HOUR_MS,
			showConditional: badge.show_conditional,
			showBundles: badge.show_bundles && kinds.bundle.enabled,
			showCartDeals: badge.show_cart_deals && kinds.cart.enabled,
			maxPills: badge.max_pills,
		},
		locks: {
			enabled: enabled('price_locks'),
			ttlMinutes: locks.ttl_minutes,
			policy: {
				onExpired: locks.on_expired,
				onBasePriceChange: locks.on_base_price_change,
				graceSeconds: locks.grace_seconds,
			},
			issueOnQuote: locks.issue_on_quote,
			issueOnOffers: locks.issue_on_offers,
			bindToCustomer: locks.bind_to_customer,
			maxUnits: locks.max_units,
		},
		badges: badge,
		dealsPage: of('deals_page'),
		reporting: of('reporting'),
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
