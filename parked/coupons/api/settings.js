/**
 * Effective settings of a website: which elements are on (signed entitlement document) and their configuration
 * (feature schemas' defaults overlaid with the document's values). Every number, flag and list the product uses
 * comes from here — nothing is hard-coded.
 */
import { effectiveConfig } from '../core/config.js';
import { SINGLE_COUPON } from '../core/stacking.js';
import { isTimeZone } from '../core/time.js';
import actions from '../schemas/actions.features.json' with { type: 'json' };
import api from '../schemas/api.features.json' with { type: 'json' };
import applyBox from '../schemas/apply_box.features.json' with { type: 'json' };
import codes from '../schemas/codes.features.json' with { type: 'json' };
import distribution from '../schemas/distribution.features.json' with { type: 'json' };
import eligibility from '../schemas/eligibility.features.json' with { type: 'json' };
import limits from '../schemas/limits.features.json' with { type: 'json' };
import reporting from '../schemas/reporting.features.json' with { type: 'json' };
import stacking from '../schemas/stacking.features.json' with { type: 'json' };

/** Feature schema of every element. */
export const SCHEMAS = Object.freeze({
	codes,
	eligibility,
	actions,
	limits,
	stacking,
	apply_box: applyBox,
	distribution,
	reporting,
	api,
});

/** @typedef {keyof typeof SCHEMAS} ElementKey */

/**
 * @typedef {object} Settings
 * @property {(key: ElementKey) => boolean} enabled
 * @property {string} timeZone
 * @property {Record<string, any>} codes
 * @property {Record<string, any>} eligibility
 * @property {Record<string, any>} actions
 * @property {Record<string, any>} limits
 * @property {Record<string, any>} stacking
 * @property {Record<string, any>} applyBox
 * @property {Record<string, any>} distribution
 * @property {Record<string, any>} reporting
 * @property {Record<string, any>} api
 * @property {import('../core/stacking.js').StackPolicy} policy stacking policy (one coupon when the element is off)
 * @property {import('../core/actions.js').ActionBounds} bounds
 * @property {import('../core/evaluate.js').EvaluationSettings} evaluation
 * @property {import('../core/validate.js').CouponRules} couponRules
 * @property {number} maxCodes codes per cart the API accepts
 */

/**
 * @param {{ can: (key: string) => boolean, config: (key: string) => Record<string, unknown> | null | undefined }} source
 * @returns {Settings}
 */
export const settingsFrom = ({ can, config }) => {
	const of = (/** @type {ElementKey} */ key) => effectiveConfig(SCHEMAS[key], config(key));
	const enabled = (/** @type {ElementKey} */ key) => can(key);
	const codeSettings = of('codes');
	const stackingSettings = of('stacking');
	const actionSettings = of('actions');
	const limitSettings = of('limits');
	const eligibilitySettings = of('eligibility');
	const timeZone = isTimeZone(codeSettings.time_zone) ? codeSettings.time_zone : 'UTC';
	const stackingOn = enabled('stacking');
	/** @type {import('../core/stacking.js').StackPolicy} */
	const policy = stackingOn
		? {
				maxCoupons: stackingSettings.max_coupons_per_cart,
				classes: Array.isArray(stackingSettings.classes) ? stackingSettings.classes : [],
				allowSameClass: stackingSettings.allow_same_class === true,
				strategy: stackingSettings.strategy === 'in_order' ? 'in_order' : 'best_discount',
			}
		: SINGLE_COUPON;
	const classes = stackingOn ? policy.classes.map((entry) => entry.key) : [];
	return {
		enabled,
		timeZone,
		codes: codeSettings,
		eligibility: eligibilitySettings,
		actions: actionSettings,
		limits: limitSettings,
		stacking: stackingSettings,
		applyBox: of('apply_box'),
		distribution: of('distribution'),
		reporting: of('reporting'),
		api: of('api'),
		policy,
		bounds: {
			rounding: actionSettings.rounding,
			maxPercent: actionSettings.max_percent,
			maxFixedAmount: actionSettings.max_fixed_amount,
		},
		evaluation: {
			timeZone,
			allowedTypes: actionSettings.allowed_types,
			requireIdentity: limitSettings.require_identity_for_per_customer === true,
			stackingDefaults: {
				class: stackingOn ? stackingSettings.default_class : 'order',
				withLoyalty: stackingOn ? stackingSettings.default_with_loyalty === true : true,
				withDeals: stackingOn ? stackingSettings.default_with_deals === true : true,
			},
		},
		couponRules: {
			code: { minLength: codeSettings.min_code_length, maxLength: codeSettings.max_code_length },
			minRandom: codeSettings.min_random_chars,
			maxCodesPerBatch: codeSettings.max_codes_per_batch,
			allowedTypes: actionSettings.allowed_types,
			maxPercent: actionSettings.max_percent,
			maxFixedAmount: actionSettings.max_fixed_amount,
			maxTiers: actionSettings.max_tiers,
			maxConditions: eligibilitySettings.max_conditions,
			allowRules: enabled('eligibility') && eligibilitySettings.allow_rules === true,
			maxRuleLength: eligibilitySettings.max_rule_length,
			classes,
		},
		// a request may name more codes than apply (the extra ones come back as `too_many_coupons`), up to the schema bound
		maxCodes: Math.max(policy.maxCoupons, stacking.properties.max_coupons_per_cart.maximum),
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
