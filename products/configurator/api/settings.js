/**
 * Effective settings of a website: which elements are on (signed entitlement document), their configuration (feature
 * schemas' defaults overlaid with the document's values) and the website's own settings (currency, time zone,
 * language). Every number, flag and list the product uses comes from here — nothing is hard-coded.
 */
import { effectiveConfig } from '../core/config.js';
import { urlOptionsFrom } from '../core/urlSync.js';
import api from '../schemas/api.features.json' with { type: 'json' };
import priceDeltas from '../schemas/price_deltas.features.json' with { type: 'json' };
import resolver from '../schemas/resolver.features.json' with { type: 'json' };
import schema from '../schemas/schema.features.json' with { type: 'json' };
import urlSync from '../schemas/url_sync.features.json' with { type: 'json' };
import widget from '../schemas/widget.features.json' with { type: 'json' };

/** Feature schema of every element. */
export const SCHEMAS = Object.freeze({ schema, resolver, price_deltas: priceDeltas, url_sync: urlSync, widget, api });

/** @typedef {keyof typeof SCHEMAS} ElementKey */

/**
 * @typedef {object} Settings
 * @property {(key: ElementKey) => boolean} enabled
 * @property {Record<string, any>} schema
 * @property {import('../core/schema.js').SchemaLimits} limits
 * @property {import('../core/resolve.js').ResolveOptions & { notify: boolean }} resolver
 * @property {Record<string, any>} pricing price_deltas feature values
 * @property {import('../core/schema.js').Rounding} rounding the default rounding
 * @property {import('../core/urlSync.js').UrlOptions} url
 * @property {Record<string, any>} widget
 * @property {Record<string, any>} api
 * @property {{ currency: string | null, timeZone: string, language: string | null }} website
 */

/**
 * @param {{ can: (key: string) => boolean, config: (key: string) => Record<string, unknown> | null | undefined,
 *   website?: { currency?: string, timeZone?: string, language?: string } | null }} source
 * @returns {Settings}
 */
export const settingsFrom = ({ can, config, website = null }) => {
	const of = (/** @type {ElementKey} */ key) => effectiveConfig(SCHEMAS[key], config(key));
	const schemaConfig = of('schema');
	const resolverConfig = of('resolver');
	const pricing = of('price_deltas');
	const timeZone = typeof website?.timeZone === 'string' && website.timeZone ? website.timeZone : 'UTC';
	return {
		enabled: (key) => can(key),
		schema: schemaConfig,
		limits: {
			groups: schemaConfig.max_groups,
			options: schemaConfig.max_options_per_group,
			combinations: schemaConfig.max_combinations,
			rules: schemaConfig.max_rules,
			priceRules: pricing.max_price_rules,
		},
		resolver: {
			inStock: resolverConfig.in_stock,
			tieBreak: resolverConfig.tie_break,
			partial: resolverConfig.partial,
			fallback: resolverConfig.fallback,
			maxSteps: resolverConfig.max_steps,
			notify: resolverConfig.notify_when_out_of_stock,
			timeZone,
		},
		pricing,
		rounding: { mode: pricing.rounding_mode, increment: pricing.rounding_increment, ending: pricing.rounding_ending },
		url: urlOptionsFrom(of('url_sync')),
		widget: of('widget'),
		api: of('api'),
		website: {
			currency: typeof website?.currency === 'string' ? website.currency : null,
			timeZone,
			language: typeof website?.language === 'string' ? website.language : null,
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
		website: doc?.website ?? null,
	});
