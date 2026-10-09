/**
 * Coupons (PLAN 0.8.8 Promotions): codes (upper case, unique per website), why a code does not apply (stable problem
 * codes), what a coupon takes off the lines in its scope after deals and bundles, the checks of a coupon the merchant
 * writes, and random codes for a batch: normalisation, percent with a cap, fixed amounts spread by value, free
 * delivery, first-order and per-customer limits. No I/O.
 * @module
 */
import { allocate, isPrice, MAX_AMOUNT, percentOf } from './money.js';
import {
	checkAmount,
	checkBoolean,
	checkPercent,
	checkWhole,
	commonSteps,
	fail,
	gather,
	inScope,
	isObject,
	isoOrNull,
	MAX_LIMIT,
	phaseOf,
} from './promotions-rules.js';

/** @typedef {import('./model.js').CouponRecord} CouponRecord */
/** @typedef {import('./promotions-rules.js').Checked} Checked */

/** Coupon types. */
const COUPON_TYPES = Object.freeze(/** @type {const} */ (['percent', 'fixed', 'free_delivery']));

/** A stored code: 3–40 characters A–Z, 0–9, `-` and `_`. */
const CODE_PATTERN = /^[A-Z0-9_-]{3,40}$/;

/** Why a code does not apply, with the shopper's message. */
const COUPON_PROBLEMS = Object.freeze({
	coupon_unknown: 'This code is not valid.',
	coupon_inactive: 'This code is not active.',
	coupon_not_started: 'This code is not valid yet.',
	coupon_expired: 'This code has expired.',
	coupon_used_up: 'This code has been used up.',
	coupon_first_order: 'This code is for a first order only.',
	coupon_per_customer: 'You have already used this code.',
	coupon_min_subtotal: 'Add more to your cart to use this code.',
	coupon_not_applicable: 'This code does not apply to the items in your cart.',
});

/** @typedef {keyof typeof COUPON_PROBLEMS} CouponProblemCode */

/**
 * A code as typed: trimmed and upper case ('' when not a text).
 * @param {unknown} value
 */
export const normaliseCode = (value) => (typeof value === 'string' ? value.trim().toUpperCase() : '');

/**
 * @param {CouponProblemCode} code
 * @returns {{ code: CouponProblemCode, message: string }}
 */
export const couponProblem = (code) => ({ code, message: COUPON_PROBLEMS[code] });

/**
 * Why a coupon cannot be used by this customer now, before looking at the cart lines (null: it may be used).
 * @param {CouponRecord | null} coupon
 * @param {{ code: string, now: number, customer: { orderCount: number, couponUses: number } }} input
 * @returns {CouponProblemCode | null}
 */
export const couponBlocked = (coupon, { code, now, customer }) => {
	if (!coupon || coupon.code !== code) return 'coupon_unknown';
	if (!coupon.active) return 'coupon_inactive';
	const phase = phaseOf(coupon, now);
	if (phase === 'not_started') return 'coupon_not_started';
	if (phase === 'ended') return 'coupon_expired';
	if (coupon.limit !== null && coupon.used >= coupon.limit) return 'coupon_used_up';
	if (coupon.firstOrderOnly && customer.orderCount > 0) return 'coupon_first_order';
	if (coupon.perCustomer !== null && customer.couponUses >= coupon.perCustomer) return 'coupon_per_customer';
	return null;
};

/**
 * What a coupon takes off, on what is left of each line after deals and bundles.
 * @param {CouponRecord} coupon a coupon that may be used (see {@link couponBlocked})
 * @param {Array<{ productId: string, categoryIds: string[], brandId: string | null, remaining: number }>} lines
 * @returns {{ ok: true, amounts: number[], freeDelivery: boolean } | { ok: false, code: CouponProblemCode }}
 *   `amounts`: per line, in the same order
 */
export const couponDiscount = (coupon, lines) => {
	const subtotal = lines.reduce((sum, line) => sum + line.remaining, 0);
	if (subtotal < coupon.minSubtotal) return { ok: false, code: 'coupon_min_subtotal' };
	const weights = lines.map((line) => (line.remaining > 0 && inScope(line, coupon.scope) ? line.remaining : 0));
	const base = weights.reduce((sum, weight) => sum + weight, 0);
	if (base === 0) return { ok: false, code: 'coupon_not_applicable' };
	if (coupon.type === 'free_delivery') return { ok: true, amounts: lines.map(() => 0), freeDelivery: true };
	const raw = coupon.type === 'percent' ? percentOf(base, coupon.value) : Math.min(coupon.value, base);
	const total = coupon.type === 'percent' && coupon.maxDiscount !== null ? Math.min(raw, coupon.maxDiscount) : raw;
	if (total <= 0) return { ok: false, code: 'coupon_not_applicable' };
	return { ok: true, amounts: allocate(total, weights), freeDelivery: false };
};

// ----------------------------------------------------------------------------------------------- merchant input

/**
 * A coupon the merchant writes (create, or the merged record of an edit). `used` is never written here.
 * @param {unknown} input
 * @returns {Checked} `value`: the coupon's fields (without id and used)
 */
export const checkCouponInput = (input) => {
	if (!isObject(input)) return fail('', 'Send a coupon object.');
	const code = normaliseCode(input.code);
	if (!CODE_PATTERN.test(code)) return fail('code', 'code is 3 to 40 characters: letters, digits, - and _.');
	if (!COUPON_TYPES.includes(input.type)) return fail('type', `type is one of ${COUPON_TYPES.join(', ')}.`);
	/** @type {'percent' | 'fixed' | 'free_delivery'} */
	const type = input.type;
	const checked = gather([
		[
			'value',
			() =>
				type === 'percent'
					? checkPercent(input.value, 'value')
					: type === 'fixed'
						? checkAmount(input.value, 'value')
						: { ok: true, value: 0 },
		],
		[
			'maxDiscount',
			() =>
				type === 'percent'
					? checkWhole(input.maxDiscount, 'maxDiscount', { min: 1, max: MAX_AMOUNT, nullable: true, fallback: null })
					: { ok: true, value: null },
		],
		[
			'minSubtotal',
			() =>
				input.minSubtotal === undefined || isPrice(input.minSubtotal)
					? { ok: true, value: input.minSubtotal ?? 0 }
					: fail('minSubtotal', 'minSubtotal is an amount in minor units from 0.'),
		],
		...commonSteps(input),
		[
			'perCustomer',
			() => checkWhole(input.perCustomer, 'perCustomer', { min: 1, max: MAX_LIMIT, nullable: true, fallback: null }),
		],
		['firstOrderOnly', () => checkBoolean(input.firstOrderOnly, 'firstOrderOnly', false)],
	]);
	if (!checked.ok) return checked;
	return { ok: true, value: { code, type, ...checked.value } };
};

/**
 * A coupon for the merchant (dates as ISO-8601 UTC).
 * @param {CouponRecord & { createdAt?: Date, updatedAt?: Date }} coupon
 */
export const couponView = (coupon) => ({
	id: coupon.id,
	code: coupon.code,
	type: coupon.type,
	value: coupon.value,
	maxDiscount: coupon.maxDiscount,
	minSubtotal: coupon.minSubtotal,
	scope: coupon.scope,
	startsAt: isoOrNull(coupon.startsAt),
	endsAt: isoOrNull(coupon.endsAt),
	limit: coupon.limit,
	used: coupon.used,
	perCustomer: coupon.perCustomer,
	firstOrderOnly: coupon.firstOrderOnly,
	active: coupon.active,
	createdAt: isoOrNull(coupon.createdAt),
	updatedAt: isoOrNull(coupon.updatedAt),
});

// ------------------------------------------------------------------------------------------------- batch codes

/** Most codes in one batch. */
const MAX_BATCH = 500;
/** Random characters after the prefix (no 0/O or 1/I, so codes read back without mistakes). */
export const BATCH_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** Random characters of a batch code. */
const BATCH_RANDOM_LENGTH = 8;

/**
 * A batch request: `{ prefix, count, coupon }` (the coupon without `code`).
 * @param {unknown} input
 * @returns {Checked} `value`: `{ prefix, count, coupon }`
 */
export const checkBatchInput = (input) => {
	if (!isObject(input)) return fail('', 'Send { prefix, count, coupon }.');
	const prefix = normaliseCode(input.prefix ?? '');
	if (!/^[A-Z0-9_-]{0,30}$/.test(prefix)) return fail('prefix', 'prefix is up to 30 characters: letters, digits, - and _.');
	const count = checkWhole(input.count, 'count', { min: 1, max: MAX_BATCH });
	if (!count.ok) return count;
	const coupon = checkCouponInput({ ...(isObject(input.coupon) ? input.coupon : {}), code: `${prefix}${'X'.repeat(8)}` });
	if (!coupon.ok)
		return coupon.field === '' ? fail('coupon', 'coupon is an object.') : { ...coupon, field: `coupon/${coupon.field}` };
	return { ok: true, value: { prefix, count: count.value, coupon: coupon.value } };
};

/**
 * One random code: the prefix and {@link BATCH_RANDOM_LENGTH} characters, every character equally likely (bytes at
 * or above the largest multiple of the alphabet size are skipped).
 * @param {string} prefix
 * @param {() => number} nextByte a uniformly random byte 0…255
 */
export const drawCode = (prefix, nextByte) => {
	const size = BATCH_ALPHABET.length;
	const limit = 256 - (256 % size);
	let code = prefix;
	while (code.length < prefix.length + BATCH_RANDOM_LENGTH) {
		const byte = nextByte();
		if (byte < limit) code += BATCH_ALPHABET[byte % size];
	}
	return code;
};
