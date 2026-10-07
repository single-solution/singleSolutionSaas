/**
 * Effective settings of a website: which elements are on (signed entitlement document) and their configuration
 * (feature schemas' defaults overlaid with the document's values). Every number, flag, list and text the product uses
 * comes from here — nothing is hard-coded.
 */
import { effectiveConfig } from '../core/config.js';
import { isLang } from '../core/validate.js';
import { zoneOr } from '../core/time.js';
import analytics from '../schemas/analytics.features.json' with { type: 'json' };
import capture from '../schemas/capture.features.json' with { type: 'json' };
import dispatch from '../schemas/dispatch.features.json' with { type: 'json' };
import triggers from '../schemas/triggers.features.json' with { type: 'json' };
import types from '../schemas/types.features.json' with { type: 'json' };
import unsubscribe from '../schemas/unsubscribe.features.json' with { type: 'json' };
import waitlist from '../schemas/waitlist_priority.features.json' with { type: 'json' };

/** Feature schema of every element. */
export const SCHEMAS = Object.freeze({
	types,
	triggers,
	capture,
	dispatch,
	waitlist_priority: waitlist,
	unsubscribe,
	analytics,
});

/** @typedef {keyof typeof SCHEMAS} ElementKey */

/**
 * @typedef {object} Settings
 * @property {(key: ElementKey) => boolean} enabled
 * @property {import('../core/types.js').TypeSettings & { pendingDays: number, retentionDays: number, repeat: boolean,
 *   availabilityPerUnit: number }} types
 * @property {{ consumeInventory: boolean, consumePrice: boolean, consumeCustom: boolean, acceptCustomerEvents: boolean,
 *   threshold: number, locations: string[], priceLists: string[], ignoreOutOfOrder: boolean, fanoutLimit: number,
 *   maxBatch: number, maxCsvRows: number }} triggers
 * @property {{ channels: Array<'email' | 'sms' | 'whatsapp'>, requireConsent: boolean, doubleOptIn: boolean, confirmHours: number,
 *   allowEntry: boolean, preferIdentity: boolean, refuseWhenAvailable: boolean, itemUrlPolicy: 'same_site' | 'any_https' | 'none',
 *   defaultLang: string, maxPerIpPerHour: number, maxPerContactPerDay: number, maxActivePerContact: number,
 *   maxActive: number }} capture
 * @property {import('../core/dispatch.js').DispatchSettings & { leaseMs: number, releaseOnFailure: boolean, inline: boolean,
 *   sendPath: string, siteName: string, itemUrlTemplate: string, templates: import('../core/dispatch.js').TemplateOverride[],
 *   retentionDays: number }} dispatch
 * @property {{ order: 'fifo' | 'tier', tierClaim: string, tiers: Array<{ key: string, rank: number }>, showPosition: boolean }} waitlist
 * @property {{ scope: 'contact' | 'subscription', ttlDays: number, pageUrl: string, liftOnResubscribe: boolean }} unsubscribe
 * @property {{ maxDays: number, defaultDays: number }} analytics
 */

/**
 * @param {{ can: (key: string) => boolean, config: (key: string) => Record<string, unknown> | null | undefined }} source
 * @returns {Settings}
 */
export const settingsFrom = ({ can, config }) => {
	const of = (/** @type {ElementKey} */ key) => effectiveConfig(SCHEMAS[key], config(key));
	const enabled = (/** @type {ElementKey} */ key) => can(key);
	const t = of('types');
	const tr = of('triggers');
	const c = of('capture');
	const d = of('dispatch');
	const w = of('waitlist_priority');
	const u = of('unsubscribe');
	const a = of('analytics');
	return {
		enabled,
		types: {
			backInStock: t.back_in_stock_enabled,
			priceDrop: t.price_drop_enabled,
			availability: t.availability_enabled,
			minDropPercent: t.price_drop_min_percent,
			minDropAmount: t.price_drop_min_amount,
			allowTarget: t.price_drop_allow_target,
			requiresStock: t.price_drop_requires_stock,
			customTypes: Array.isArray(t.custom_types) ? t.custom_types : [],
			pendingDays: t.pending_max_days,
			retentionDays: t.retention_days,
			repeat: t.repeat,
			availabilityPerUnit: t.availability_notify_per_unit,
		},
		triggers: {
			consumeInventory: tr.consume_inventory_events,
			consumePrice: tr.consume_price_events,
			consumeCustom: tr.consume_custom_events,
			acceptCustomerEvents: tr.accept_customer_events,
			threshold: tr.in_stock_threshold,
			locations: tr.locations,
			priceLists: tr.price_lists,
			ignoreOutOfOrder: tr.ignore_out_of_order,
			fanoutLimit: tr.fanout_limit,
			maxBatch: tr.max_batch_items,
			maxCsvRows: tr.max_csv_rows,
		},
		capture: {
			channels: c.channels,
			requireConsent: c.require_consent,
			doubleOptIn: c.double_opt_in,
			confirmHours: c.confirm_ttl_hours,
			allowEntry: c.allow_contact_entry,
			preferIdentity: c.prefer_identity_contact,
			refuseWhenAvailable: c.refuse_when_available,
			itemUrlPolicy: c.item_url_policy,
			defaultLang: isLang(c.default_lang) ? c.default_lang : 'en',
			maxPerIpPerHour: c.max_per_ip_per_hour,
			maxPerContactPerDay: c.max_per_contact_per_day,
			maxActivePerContact: c.max_active_per_contact,
			maxActive: c.max_active_subscriptions,
		},
		dispatch: {
			timeZone: zoneOr(d.time_zone),
			quietHoursEnabled: d.quiet_hours_enabled,
			quietStart: d.quiet_hours_start,
			quietEnd: d.quiet_hours_end,
			batchWindowMinutes: d.batch_window_minutes,
			maxPerDay: d.max_per_contact_per_day,
			maxPerWeek: d.max_per_contact_per_week,
			capAction: d.cap_action,
			maxAttempts: d.max_attempts,
			retryBaseMinutes: d.retry_base_minutes,
			leaseMs: d.lease_seconds * 1000,
			releaseOnFailure: d.release_on_failure,
			inline: d.inline_dispatch,
			sendPath: d.send_path,
			siteName: d.site_name,
			itemUrlTemplate: d.item_url_template,
			templates: Array.isArray(d.templates) ? d.templates : [],
			retentionDays: d.message_retention_days,
		},
		waitlist: {
			order: enabled('waitlist_priority') ? w.order : 'fifo',
			tierClaim: w.tier_claim,
			tiers: Array.isArray(w.tiers) ? w.tiers : [],
			showPosition: enabled('waitlist_priority') && w.show_position,
		},
		unsubscribe: {
			scope: u.scope,
			ttlDays: u.token_ttl_days,
			pageUrl: u.page_url,
			liftOnResubscribe: u.resubscribe_lifts_suppression,
		},
		analytics: { maxDays: a.max_window_days, defaultDays: Math.min(a.default_window_days, a.max_window_days) },
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
