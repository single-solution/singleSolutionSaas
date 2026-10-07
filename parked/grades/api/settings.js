/**
 * Effective settings of a website: which elements are on (signed entitlement document), their configuration
 * (feature schemas' defaults overlaid with the document's values) and the website's own settings (time zone and
 * language from the document's `website` section). Every list, number and flag the product uses comes from here.
 */
import { effectiveConfig } from '../core/config.js';
import { normaliseChecklists } from '../core/inspection.js';
import { resolveVocabularies } from '../core/mapping.js';
import { normaliseTiers, tierIndex } from '../core/tiers.js';
import filters from '../schemas/filters.features.json' with { type: 'json' };
import inspection from '../schemas/inspection.features.json' with { type: 'json' };
import mapping from '../schemas/mapping.features.json' with { type: 'json' };
import showcase from '../schemas/showcase.features.json' with { type: 'json' };
import tiers from '../schemas/tiers.features.json' with { type: 'json' };
import warranty from '../schemas/warranty.features.json' with { type: 'json' };

/** Feature schema of every element. */
export const SCHEMAS = Object.freeze({ tiers, showcase, filters, warranty, mapping, inspection });

/** @typedef {keyof typeof SCHEMAS} ElementKey */

/** Element keys in manifest order. */
export const ELEMENT_KEYS = /** @type {ElementKey[]} */ (Object.keys(SCHEMAS));

/**
 * @typedef {object} Settings
 * @property {(key: ElementKey) => boolean} enabled
 * @property {string} timeZone IANA zone of the website (UTC when unset)
 * @property {string | null} language BCP 47 tag of the website, when set
 * @property {Record<string, any>} tiersConfig
 * @property {ReadonlyArray<import('../core/tiers.js').Tier>} tiers
 * @property {ReadonlyMap<string, import('../core/tiers.js').Tier>} index
 * @property {string} badgeStyle
 * @property {string | null} defaultTier
 * @property {Record<string, any>} showcase
 * @property {Record<string, any>} filters
 * @property {Record<string, any>} warranty
 * @property {Record<string, any>} mapping
 * @property {import('../core/mapping.js').Vocabulary[]} vocabularies
 * @property {Record<string, any>} inspection
 * @property {import('../core/inspection.js').Checklist[]} checklists
 */

/**
 * @param {unknown} zone
 */
const isTimeZone = (zone) => {
	if (typeof zone !== 'string' || zone.length === 0) return false;
	try {
		new Intl.DateTimeFormat('en', { timeZone: zone });
		return true;
	} catch {
		return false;
	}
};

/**
 * @param {{ can: (key: string) => boolean, config: (key: string) => Record<string, unknown> | null | undefined,
 *   website?: { timeZone?: string, language?: string } | null }} source
 * @returns {Settings}
 */
export const settingsFrom = ({ can, config, website = null }) => {
	const of = (/** @type {ElementKey} */ key) => effectiveConfig(SCHEMAS[key], config(key));
	const tiersConfig = of('tiers');
	const ladder = normaliseTiers(tiersConfig.tiers);
	const index = tierIndex(ladder);
	const mappingConfig = of('mapping');
	const inspectionConfig = of('inspection');
	return {
		enabled: (key) => can(key),
		timeZone: isTimeZone(website?.timeZone) ? /** @type {string} */ (website?.timeZone) : 'UTC',
		language: typeof website?.language === 'string' ? website.language : null,
		tiersConfig,
		tiers: ladder,
		index,
		badgeStyle: String(tiersConfig.badge_style),
		defaultTier: index.has(tiersConfig.default_tier) ? tiersConfig.default_tier : null,
		showcase: of('showcase'),
		filters: of('filters'),
		warranty: of('warranty'),
		mapping: mappingConfig,
		vocabularies: resolveVocabularies(mappingConfig.vocabularies, ladder),
		inspection: inspectionConfig,
		checklists: normaliseChecklists(inspectionConfig.checklists, index),
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
		website: doc.website ?? null,
	});
