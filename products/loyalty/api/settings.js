/**
 * Effective settings of a website: which elements are on (signed entitlement document) and their configuration
 * (feature schemas' defaults overlaid with the document's values). Every number, flag and list the product uses
 * comes from here — nothing is hard-coded.
 */
import { effectiveConfig } from '../core/config.js';
import { isTimeZone } from '../core/time.js';
import adjustments from '../schemas/adjustments.features.json' with { type: 'json' };
import earnRules from '../schemas/earn_rules.features.json' with { type: 'json' };
import expiry from '../schemas/expiry.features.json' with { type: 'json' };
import redeem from '../schemas/redeem.features.json' with { type: 'json' };
import referrals from '../schemas/referrals.features.json' with { type: 'json' };
import reversal from '../schemas/reversal.features.json' with { type: 'json' };
import tiers from '../schemas/tiers.features.json' with { type: 'json' };
import wallet from '../schemas/wallet.features.json' with { type: 'json' };

/** Feature schema of every element. */
export const SCHEMAS = Object.freeze({
	earn_rules: earnRules,
	redeem,
	wallet,
	tiers,
	expiry,
	referrals,
	adjustments,
	reversal,
});

/** @typedef {keyof typeof SCHEMAS} ElementKey */

/**
 * @typedef {object} Settings
 * @property {(key: ElementKey) => boolean} enabled
 * @property {string} timeZone
 * @property {Record<string, any>} earn
 * @property {import('../core/earn.js').EarnRule[]} rules
 * @property {import('../core/redeem.js').RedeemConfig} redeem
 * @property {Record<string, any>} wallet
 * @property {import('../core/tiers.js').TierConfig | null} tiers null when the element is off
 * @property {{ months: number, graceDays: number, noticeDays: number } | null} expiry null when off or months = 0
 * @property {import('../core/referrals.js').ReferralConfig | null} referrals
 * @property {Record<string, any>} adjustments
 * @property {import('../core/reversal.js').ReversalConfig | null} reversal
 */

/**
 * @param {{ can: (key: string) => boolean, config: (key: string) => Record<string, unknown> | null | undefined }} source
 * @returns {Settings}
 */
export const settingsFrom = ({ can, config }) => {
	const of = (/** @type {ElementKey} */ key) => effectiveConfig(SCHEMAS[key], config(key));
	const enabled = (/** @type {ElementKey} */ key) => can(key);
	const earn = of('earn_rules');
	const tierConfig = of('tiers');
	const expiryConfig = of('expiry');
	return {
		enabled,
		timeZone: isTimeZone(earn.time_zone) ? earn.time_zone : 'UTC',
		earn,
		rules: Array.isArray(earn.rules) ? earn.rules : [],
		redeem: /** @type {import('../core/redeem.js').RedeemConfig} */ (of('redeem')),
		wallet: of('wallet'),
		tiers: enabled('tiers')
			? {
					tiers: Array.isArray(tierConfig.tiers) ? tierConfig.tiers : [],
					basis: tierConfig.basis,
					window_months: tierConfig.window_months,
					downgrade: tierConfig.downgrade,
				}
			: null,
		expiry:
			enabled('expiry') && expiryConfig.months > 0
				? { months: expiryConfig.months, graceDays: expiryConfig.grace_days, noticeDays: expiryConfig.notice_days }
				: null,
		referrals: enabled('referrals') ? /** @type {import('../core/referrals.js').ReferralConfig} */ (of('referrals')) : null,
		adjustments: of('adjustments'),
		reversal: enabled('reversal') ? /** @type {import('../core/reversal.js').ReversalConfig} */ (of('reversal')) : null,
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
