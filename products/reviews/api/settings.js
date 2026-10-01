/**
 * Effective settings of a website: which elements are on (signed entitlement document) and their configuration
 * (feature schemas' defaults overlaid with the document's values). Every number, flag and list the product uses
 * comes from here — nothing is hard-coded.
 */
import { effectiveConfig } from '../core/config.js';
import { isTimeZone } from '../core/time.js';
import analytics from '../schemas/analytics.features.json' with { type: 'json' };
import collection from '../schemas/collection.features.json' with { type: 'json' };
import content from '../schemas/content.features.json' with { type: 'json' };
import display from '../schemas/display.features.json' with { type: 'json' };
import importing from '../schemas/import.features.json' with { type: 'json' };
import moderation from '../schemas/moderation.features.json' with { type: 'json' };
import photos from '../schemas/photos.features.json' with { type: 'json' };
import qna from '../schemas/qna.features.json' with { type: 'json' };
import requestFlow from '../schemas/request_flow.features.json' with { type: 'json' };
import structuredData from '../schemas/structured_data.features.json' with { type: 'json' };

/** Feature schema of every element. */
export const SCHEMAS = Object.freeze({
	collection,
	request_flow: requestFlow,
	moderation,
	content,
	photos,
	display,
	structured_data: structuredData,
	qna,
	import: importing,
	analytics,
});

/** @typedef {keyof typeof SCHEMAS} ElementKey */

/**
 * @typedef {object} Settings
 * @property {(key: ElementKey) => boolean} enabled
 * @property {string} timeZone
 * @property {Record<string, any>} collection
 * @property {Record<string, any> | null} requestFlow null when the element is off
 * @property {import('../core/moderation.js').ModerationSettings | null} moderation null when off (reviews publish at once)
 * @property {import('../core/validate.js').ContentLimits} content defaults apply when the element is off
 * @property {{ max_photos_per_review: number, max_photo_bytes: number, allowed_types: string[], upload_ttl_seconds: number,
 *   view_ttl_seconds: number, public_base_url: string } | null} photos null when off
 * @property {Record<string, any>} display
 * @property {Record<string, any>} structured
 * @property {Record<string, any>} qna
 * @property {Record<string, any>} importing
 * @property {Record<string, any>} analytics
 */

/**
 * @param {{ can: (key: string) => boolean, config: (key: string) => Record<string, unknown> | null | undefined }} source
 * @returns {Settings}
 */
export const settingsFrom = ({ can, config }) => {
	const of = (/** @type {ElementKey} */ key) => effectiveConfig(SCHEMAS[key], config(key));
	const enabled = (/** @type {ElementKey} */ key) => can(key);
	const base = of('collection');
	const contentConfig = /** @type {import('../core/validate.js').ContentLimits} */ (
		enabled('content') ? of('content') : effectiveConfig(SCHEMAS.content, {})
	);
	return {
		enabled,
		timeZone: isTimeZone(base.time_zone) ? base.time_zone : 'UTC',
		collection: base,
		requestFlow: enabled('request_flow') ? of('request_flow') : null,
		moderation: enabled('moderation')
			? /** @type {import('../core/moderation.js').ModerationSettings} */ (of('moderation'))
			: null,
		content: { ...contentConfig, attributes: Array.isArray(contentConfig.attributes) ? contentConfig.attributes : [] },
		photos: enabled('photos') ? /** @type {NonNullable<Settings['photos']>} */ (of('photos')) : null,
		display: of('display'),
		structured: of('structured_data'),
		qna: of('qna'),
		importing: of('import'),
		analytics: of('analytics'),
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
