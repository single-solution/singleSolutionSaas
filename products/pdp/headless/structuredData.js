/**
 * Mode B core of the `structured_data` element: the item's schema.org `Product` + `Offer` JSON-LD (field mapping
 * through the JSON source settings, condition mapping through the merchant's own values), skipped when the page
 * already has Product markup, plus the optional standard `item.viewed@1` event data.
 * @module
 */
import { itemViewedData } from '../core/display.js';
import { CONDITIONS } from '../core/item.js';
import { productJsonLd, priceValidUntil, resolveCondition, scriptJson } from '../core/jsonld.js';
import { bool, int, isObject, oneOf, text } from '../core/util.js';
import { createItemElement, instance } from './base.js';

/** @param {Record<string, unknown>} config */
export const structuredSettings = (config) => {
	const raw = isObject(config.condition_map) ? config.condition_map : {};
	/** @type {import('../core/jsonld.js').ConditionMap} */
	const conditionMap = {};
	for (const condition of CONDITIONS)
		conditionMap[condition] = (Array.isArray(raw[condition]) ? raw[condition] : [])
			.slice(0, 50)
			.map((/** @type {unknown} */ value) => text(value, 100));
	return {
		offer: bool(config.include_offer, true),
		rating: bool(config.include_rating, true),
		validDays: int(config.price_valid_days, 0, 365, 0),
		conditionMap,
		fallback: /** @type {import('../core/jsonld.js').Condition | ''} */ (
			oneOf(config.default_condition, ['none', ...CONDITIONS], 'none').replace('none', '')
		),
		seller: text(config.seller_name, 200),
		skipIfPresent: bool(config.skip_if_present, true),
		trackViewed: bool(config.track_item_viewed, false),
	};
};

/**
 * @param {import('./base.js').ElementOptions} options
 */
export const createStructuredData = (options) => {
	const settings = structuredSettings(options.config ?? {});
	const now = options.now ?? Date.now;
	/** @type {import('./base.js').PageContext} */
	let context = {};
	/** @param {import('../core/item.js').Item | null} item */
	const build = (item) => {
		if (!item) return { node: null, json: '', viewed: null, skipped: false };
		const viewed = settings.trackViewed ? itemViewedData(item) : null;
		if (settings.skipIfPresent && context.hasProductJsonLd === true) return { node: null, json: '', viewed, skipped: true };
		const node = productJsonLd(item, {
			pageUrl: text(context.url, 2048),
			condition: resolveCondition(item.condition, settings.conditionMap, settings.fallback),
			validUntil: priceValidUntil(now(), settings.validDays),
			seller: settings.seller,
			offer: settings.offer,
			rating: settings.rating,
		});
		return { node, json: node ? scriptJson(node) : '', viewed, skipped: false };
	};
	const core = createItemElement({
		...options,
		prefix: 'structured_data',
		extra: { ...build(null) },
		derive: build,
	});
	const actions = {
		...core.actions,
		/**
		 * @param {import('./base.js').ItemSource} [source]
		 */
		load: (source = {}) => {
			context = source.context ?? {};
			return core.actions.load(source);
		},
	};
	return instance({ ...core, actions, strings: options.strings ?? {} });
};
