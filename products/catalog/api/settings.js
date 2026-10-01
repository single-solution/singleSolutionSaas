/**
 * Effective settings of a website: which elements are on (signed entitlement document) and their configuration
 * (feature schemas' defaults overlaid with the document's values), plus the website's own settings from the Portal
 * (currency, language, domain). Every number, flag and list the product uses comes from here — nothing is hard-coded.
 */
import { effectiveConfig } from '../core/config.js';
import { currencyOf, exponentOf } from '../core/money.js';
import api from '../schemas/api.features.json' with { type: 'json' };
import attributes from '../schemas/attributes.features.json' with { type: 'json' };
import brands from '../schemas/brands.features.json' with { type: 'json' };
import collections from '../schemas/collections.features.json' with { type: 'json' };
import feeds from '../schemas/feeds.features.json' with { type: 'json' };
import importExport from '../schemas/import_export.features.json' with { type: 'json' };
import items from '../schemas/items.features.json' with { type: 'json' };
import media from '../schemas/media.features.json' with { type: 'json' };
import mediaUploads from '../schemas/media_uploads.features.json' with { type: 'json' };
import variants from '../schemas/variants.features.json' with { type: 'json' };

/** Feature schema of every element. */
export const SCHEMAS = Object.freeze({
	items,
	variants,
	attributes,
	collections,
	brands,
	media,
	media_uploads: mediaUploads,
	import_export: importExport,
	feeds,
	api,
});

/** @typedef {keyof typeof SCHEMAS} ElementKey */
export const ELEMENTS = /** @type {ElementKey[]} */ (Object.keys(SCHEMAS));

/**
 * @typedef {object} Settings
 * @property {(key: ElementKey) => boolean} enabled
 * @property {string} domain
 * @property {string | null} websiteCurrency
 * @property {string | null} language
 * @property {import('../core/items.js').ItemSettings & Record<string, any>} items
 * @property {Record<string, any>} variants
 * @property {Record<string, any>} attributes
 * @property {Record<string, any>} collections
 * @property {Record<string, any>} brands
 * @property {import('../core/media.js').MediaSettings & Record<string, any>} media
 * @property {Record<string, any>} uploads
 * @property {Record<string, any>} importing
 * @property {Record<string, any>} feeds
 * @property {Record<string, any>} api
 * @property {{ trackInventory: boolean, backorders: 'deny' | 'allow', lowStock: number, showQuantity: boolean }} stock
 * @property {(item?: { currency?: string | null } | null) => string | null} currencyOf
 * @property {(currency: string | null) => number} exponentOf
 */

/**
 * @param {{ can: (key: string) => boolean, config: (key: string) => Record<string, unknown> | null | undefined,
 *   domain: string, website?: { currency?: string, language?: string } | null }} source
 * @returns {Settings}
 */
export const settingsFrom = ({ can, config, domain, website = null }) => {
	const of = (/** @type {ElementKey} */ key) => effectiveConfig(SCHEMAS[key], config(key));
	const itemSettings = /** @type {Settings['items']} */ (of('items'));
	const variantSettings = of('variants');
	const websiteCurrency = website?.currency ?? null;
	return {
		enabled: (key) => can(key),
		domain,
		websiteCurrency,
		language: website?.language ?? null,
		items: itemSettings,
		variants: variantSettings,
		attributes: of('attributes'),
		collections: of('collections'),
		brands: of('brands'),
		media: /** @type {Settings['media']} */ (of('media')),
		uploads: of('media_uploads'),
		importing: of('import_export'),
		feeds: of('feeds'),
		api: of('api'),
		stock: {
			trackInventory: variantSettings.track_inventory,
			backorders: variantSettings.backorders,
			lowStock: variantSettings.low_stock_threshold,
			showQuantity: variantSettings.show_quantity,
		},
		currencyOf: (item = null) =>
			currencyOf(
				{ itemCurrency: itemSettings.item_currency, catalogCurrency: itemSettings.currency, websiteCurrency },
				item ?? null,
			),
		exponentOf,
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
		domain: doc.domain,
		website: doc.website ?? null,
	});
