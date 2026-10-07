/**
 * Effective settings of a website: which elements are on (signed entitlement document) and their configuration
 * (feature schemas' defaults overlaid with the document's values), plus the website's own settings from the Portal
 * (domain, time zone, language). Every number, flag and list the product uses comes from here.
 */
import { effectiveConfig } from '../core/config.js';
import { rankingOf } from '../core/query.js';
import { typesOf } from '../core/schema.js';
import analytics from '../schemas/analytics.features.json' with { type: 'json' };
import index from '../schemas/index.features.json' with { type: 'json' };
import overlay from '../schemas/overlay.features.json' with { type: 'json' };
import ranking from '../schemas/ranking.features.json' with { type: 'json' };
import sources from '../schemas/sources.features.json' with { type: 'json' };
import suggestions from '../schemas/suggestions.features.json' with { type: 'json' };

/** Feature schema of every element. */
export const SCHEMAS = Object.freeze({ index, sources, ranking, suggestions, overlay, analytics });

/** @typedef {keyof typeof SCHEMAS} ElementKey */
export const ELEMENTS = /** @type {ElementKey[]} */ (Object.keys(SCHEMAS));

/**
 * @typedef {object} Settings
 * @property {(key: ElementKey) => boolean} enabled
 * @property {string} domain
 * @property {string | null} timeZone
 * @property {string | null} language
 * @property {Record<string, any>} index
 * @property {Record<string, any>} sources
 * @property {Record<string, any>} ranking
 * @property {Record<string, any>} suggestions
 * @property {Record<string, any>} overlay
 * @property {Record<string, any>} analytics
 * @property {Map<string, import('../core/schema.js').TypeDef>} types
 * @property {import('../core/query.js').Ranking} rank
 */

/**
 * @param {{ can: (key: string) => boolean, config: (key: string) => Record<string, unknown> | null | undefined,
 *   domain: string, website?: { timeZone?: string, language?: string } | null }} source
 * @returns {Settings}
 */
const settingsFrom = ({ can, config, domain, website = null }) => {
	const of = (/** @type {ElementKey} */ key) => effectiveConfig(SCHEMAS[key], config(key));
	const indexSettings = of('index');
	const rankingSettings = of('ranking');
	return {
		enabled: (key) => can(key),
		domain,
		timeZone: website?.timeZone ?? null,
		language: website?.language ?? null,
		index: indexSettings,
		sources: of('sources'),
		ranking: rankingSettings,
		suggestions: of('suggestions'),
		overlay: of('overlay'),
		analytics: of('analytics'),
		types: typesOf(indexSettings.document_types),
		// a website without the ranking element searches with the schema defaults
		rank: rankingOf(can('ranking') ? rankingSettings : effectiveConfig(SCHEMAS.ranking, {})),
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
