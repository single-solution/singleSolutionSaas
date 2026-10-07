/**
 * Payment methods (pure): which manual methods (bank transfer, cash on delivery, pay at pickup) and the gateway are
 * available for a checkout, the cash-on-delivery surcharge, caps and advance, and the order's starting status with its
 * hold deadline. Every amount, cap and hour comes from the `payment_manual` / `payment_gateway` settings.
 *
 * Cash on delivery (review lesson A12): a COD order never auto-confirms — with `cod_confirmation` it starts
 * `awaiting_confirmation` (the merchant confirms by call / message, or it expires and gives its stock back); orders over
 * `cod_max_order` cannot use COD; an advance (flat or a share) is paid by bank transfer first and makes the order start
 * `pending_payment`; every unconfirmed order counts against the open-order cap.
 * @module
 */
import { applyBasisPoints, clampAmount } from './money.js';
import { conditionMatches } from './rules.js';

/** @typedef {'bank_transfer' | 'cod' | 'pickup_pay' | 'gateway'} MethodKey */
/** @typedef {'pending_payment' | 'awaiting_confirmation' | 'confirmed'} StartStatus */

export const METHOD_KEYS = Object.freeze(/** @type {const} */ (['bank_transfer', 'cod', 'pickup_pay', 'gateway']));

/**
 * @typedef {object} ManualSettings the `payment_manual` feature values used here
 * @property {boolean} bank_transfer_enabled
 * @property {number} bank_hold_hours
 * @property {string} bank_available_when
 * @property {boolean} cod_enabled
 * @property {number} cod_surcharge_bp
 * @property {number} cod_surcharge_flat
 * @property {number} cod_min_order
 * @property {number} cod_max_order
 * @property {number} cod_advance_flat
 * @property {number} cod_advance_bp
 * @property {boolean} cod_confirmation
 * @property {number} cod_confirmation_hours
 * @property {boolean} cod_requires_identity
 * @property {string} cod_available_when
 * @property {boolean} pickup_pay_enabled
 * @property {number} pickup_hold_hours
 * @property {string[]} method_order
 */
/**
 * @typedef {object} MethodContext what availability depends on
 * @property {number} subtotal merchandise after discounts
 * @property {number} total order total before any surcharge
 * @property {string} currency
 * @property {'ship' | 'pickup' | 'digital' | null} deliveryKind
 * @property {string | null} deliveryMethod
 * @property {boolean} signedIn
 * @property {string | null} country
 * @property {number} quantity
 */
/**
 * @typedef {object} MethodOption
 * @property {MethodKey} key
 * @property {'manual' | 'gateway'} kind
 * @property {boolean} available
 * @property {string | null} reason stable code when unavailable
 * @property {number} surcharge integer minor units
 */

/**
 * Cash-on-delivery surcharge on the post-discount subtotal.
 * @param {ManualSettings} settings
 * @param {number} subtotal
 */
export const codSurcharge = (settings, subtotal) =>
	subtotal <= 0 ? 0 : applyBasisPoints(subtotal, settings.cod_surcharge_bp) + Math.max(0, settings.cod_surcharge_flat);

/**
 * Advance a COD order pays by bank transfer first: the flat amount wins over the share; capped at the total; none
 * when bank transfer is not set up (it could not be paid).
 * @param {ManualSettings} settings
 * @param {number} total
 */
export const codAdvance = (settings, total) => {
	if (!settings.bank_transfer_enabled || total <= 0) return 0;
	if (settings.cod_advance_flat > 0) return clampAmount(settings.cod_advance_flat, total);
	if (settings.cod_advance_bp <= 0) return 0;
	return clampAmount(Math.ceil((total * Math.min(10_000, settings.cod_advance_bp)) / 10_000), total);
};

/**
 * The methods offered for a checkout, in the merchant's order, each with availability and surcharge.
 * @param {{ manual: ManualSettings | null, gatewayEnabled: boolean }} settings `manual` null when the element is off
 * @param {MethodContext} context
 * @param {{ now: number, timeZone: string }} clock
 * @returns {MethodOption[]}
 */
export const paymentOptions = ({ manual, gatewayEnabled }, context, clock) => {
	const rulesContext = {
		cart: { subtotal: context.subtotal, total: context.total, quantity: context.quantity, currency: context.currency },
		customer: { signedIn: context.signedIn },
		delivery: { method: context.deliveryMethod, kind: context.deliveryKind },
		country: context.country,
	};
	/** @param {MethodKey} key @param {string} [when] */
	const rule = (key, when) => conditionMatches(when, { ...rulesContext, payment: { method: key } }, clock);
	/** @type {MethodOption[]} */
	const options = [];
	if (manual) {
		const order = [...new Set([...manual.method_order, 'bank_transfer', 'cod', 'pickup_pay'])];
		for (const key of order) {
			if (key === 'bank_transfer' && manual.bank_transfer_enabled) {
				const ok = rule('bank_transfer', manual.bank_available_when);
				options.push({ key, kind: 'manual', available: ok, reason: ok ? null : 'rule_not_met', surcharge: 0 });
			}
			if (key === 'cod' && manual.cod_enabled) {
				const surcharge = codSurcharge(manual, context.subtotal);
				const total = context.total + surcharge;
				const reason =
					context.deliveryKind !== 'ship'
						? 'delivery_unsupported'
						: manual.cod_max_order > 0 && total > manual.cod_max_order
							? 'over_cap'
							: total < manual.cod_min_order
								? 'under_minimum'
								: manual.cod_requires_identity && !context.signedIn
									? 'identity_required'
									: !rule('cod', manual.cod_available_when)
										? 'rule_not_met'
										: null;
				options.push({ key, kind: 'manual', available: reason === null, reason, surcharge });
			}
			if (key === 'pickup_pay' && manual.pickup_pay_enabled) {
				const ok = context.deliveryKind === 'pickup';
				options.push({ key, kind: 'manual', available: ok, reason: ok ? null : 'delivery_unsupported', surcharge: 0 });
			}
		}
	}
	if (gatewayEnabled) options.push({ key: 'gateway', kind: 'gateway', available: true, reason: null, surcharge: 0 });
	return options;
};

const HOUR = 3_600_000;

/**
 * Starting status, the hold deadline and what is due when.
 * @param {MethodKey} method
 * @param {{ manual: ManualSettings | null, gatewayHoldMinutes: number, total: number, now: number }} input
 * @returns {{ status: StartStatus, expiresAt: number | null, advance: number, dueNow: number, dueLater: number }}
 */
export const startOf = (method, { manual, gatewayHoldMinutes, total, now }) => {
	if (method === 'gateway')
		return { status: 'pending_payment', expiresAt: now + gatewayHoldMinutes * 60_000, advance: 0, dueNow: total, dueLater: 0 };
	const settings = /** @type {ManualSettings} */ (manual);
	if (method === 'bank_transfer')
		return {
			status: 'pending_payment',
			expiresAt: now + settings.bank_hold_hours * HOUR,
			advance: 0,
			dueNow: total,
			dueLater: 0,
		};
	if (method === 'pickup_pay')
		return {
			status: 'pending_payment',
			expiresAt: now + settings.pickup_hold_hours * HOUR,
			advance: 0,
			dueNow: 0,
			dueLater: total,
		};
	const advance = codAdvance(settings, total);
	if (advance > 0)
		return {
			status: 'pending_payment',
			expiresAt: now + settings.bank_hold_hours * HOUR,
			advance,
			dueNow: advance,
			dueLater: total - advance,
		};
	if (!settings.cod_confirmation) return { status: 'confirmed', expiresAt: null, advance: 0, dueNow: 0, dueLater: total };
	return {
		status: 'awaiting_confirmation',
		expiresAt: settings.cod_confirmation_hours > 0 ? now + settings.cod_confirmation_hours * HOUR : null,
		advance: 0,
		dueNow: 0,
		dueLater: total,
	};
};

/** Statuses that hold stock without a confirmed payment or confirmation (counted by the open-order cap). */
export const UNCONFIRMED = Object.freeze(/** @type {const} */ (['pending_payment', 'awaiting_confirmation']));
