/**
 * Eligibility of one coupon code for one cart (pure): status, capacity, validity window, currency, identity
 * requirement, structured conditions and the rules@1 condition. The result is either a stackable **candidate**
 * (the lines it applies to and its stacking metadata) or a stable refusal reason. Authoritative capacity is claimed
 * atomically at reservation time (see `limits.js` and the repositories); the capacity check here is the cheap preview.
 * @module
 */
import { actionUsesMoney } from './actions.js';
import { matchedLines, usesMoney } from './conditions.js';
import { conditionMatches, ruleContext } from './rules.js';
import { validityState } from './schedule.js';

/** Refusal reasons of a code (also the RFC 9457 problem codes of the API). */
export const REASONS = Object.freeze([
	'code_not_found',
	'coupon_inactive',
	'code_disabled',
	'exhausted',
	'not_started',
	'ended',
	'outside_schedule',
	'currency_mismatch',
	'identity_required',
	'not_eligible',
	'action_unavailable',
	'blocked',
	'customer_limit_reached',
	'device_limit_reached',
	'not_combinable',
	'too_many_coupons',
	'duplicate_coupon',
	'no_discount',
]);

/**
 * @typedef {object} Candidate
 * @property {string} couponId
 * @property {string} code
 * @property {number} index position in the request
 * @property {Record<string, any>} action
 * @property {ReadonlySet<string>} matched line ids the coupon applies to
 * @property {string} class stacking class
 * @property {boolean} exclusive
 * @property {number} priority
 * @property {boolean} withLoyalty
 * @property {boolean} withDeals
 * @property {string} name
 */

/**
 * @typedef {object} EvaluationSettings
 * @property {string} timeZone website zone
 * @property {readonly string[]} allowedTypes `actions.allowed_types`
 * @property {boolean} requireIdentity `limits.require_identity_for_per_customer`
 * @property {{ class: string, withLoyalty: boolean, withDeals: boolean }} stackingDefaults
 */

/**
 * @param {{ coupon: Record<string, any>, code: Record<string, any>, cart: import('./cart.js').Cart, now: number,
 *   index?: number, settings: EvaluationSettings }} input
 * @returns {{ ok: true, candidate: Candidate } | { ok: false, reason: string }}
 */
export const evaluateCoupon = ({ coupon, code, cart, now, index = 0, settings }) => {
	if (coupon.status !== 'active') return { ok: false, reason: 'coupon_inactive' };
	if (code.status !== 'active') return { ok: false, reason: 'code_disabled' };
	if (typeof code.maxUses === 'number' && (code.taken ?? 0) >= code.maxUses) return { ok: false, reason: 'exhausted' };
	const total = coupon.limits?.total;
	if (typeof total === 'number' && (coupon.counters?.taken ?? 0) >= total) return { ok: false, reason: 'exhausted' };
	const state = validityState(coupon.validity, now, settings.timeZone);
	if (state !== 'active') return { ok: false, reason: state };
	const conditions = Array.isArray(coupon.eligibility?.conditions) ? coupon.eligibility.conditions : [];
	const money = actionUsesMoney(coupon.action ?? {}) || usesMoney(conditions);
	if (money && coupon.currency && coupon.currency !== cart.currency) return { ok: false, reason: 'currency_mismatch' };
	if (typeof coupon.limits?.per_customer === 'number' && settings.requireIdentity && !cart.customer.identified)
		return { ok: false, reason: 'identity_required' };
	if (!settings.allowedTypes.includes(coupon.action?.type)) return { ok: false, reason: 'action_unavailable' };
	const lines = matchedLines(conditions, cart);
	if (lines.length === 0) return { ok: false, reason: 'not_eligible' };
	const when = coupon.eligibility?.when;
	// a stored rule is always honoured (eligibility.allow_rules only gates authoring new ones)
	if (typeof when === 'string' && when.trim() !== '') {
		const verdict = conditionMatches(when, ruleContext(cart, { id: coupon.id, code: code.code }), {
			now,
			timeZone: settings.timeZone,
		});
		if (!verdict.matched) return { ok: false, reason: 'not_eligible' };
	}
	const stacking = coupon.stacking ?? {};
	return {
		ok: true,
		candidate: {
			couponId: coupon.id,
			code: code.code,
			index,
			action: coupon.action,
			matched: new Set(lines.map((line) => line.lineId)),
			class: typeof stacking.class === 'string' ? stacking.class : settings.stackingDefaults.class,
			exclusive: stacking.exclusive === true,
			priority: Number.isInteger(stacking.priority) ? stacking.priority : 0,
			withLoyalty: typeof stacking.with_loyalty === 'boolean' ? stacking.with_loyalty : settings.stackingDefaults.withLoyalty,
			withDeals: typeof stacking.with_deals === 'boolean' ? stacking.with_deals : settings.stackingDefaults.withDeals,
			name: String(coupon.name ?? ''),
		},
	};
};
