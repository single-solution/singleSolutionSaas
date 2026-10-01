/** Redemption bounds; the first cases are ibrahimMobiles' `maxRedeemable` / `pointsToRupees` tests. */
import { describe, expect, it } from 'vitest';
import { pointsToValue, quote, redeemProblem, valueToPoints } from '../core/redeem.js';

/** @param {Record<string, any>} [overrides] @returns {any} */
const config = (overrides = {}) => ({
	min_points: 100,
	max_share_percent: 20,
	rate_points: 1,
	rate_value_minor: 1,
	allow_with_offers: true,
	...overrides,
});
const max = (/** @type {any} */ amount, /** @type {any} */ balance, /** @type {any} */ overrides = {}) =>
	quote({ balance, amount, config: config({ min_points: 1, ...overrides }) }).maxPoints;

describe('conversion', () => {
	it('is 1:1 by default, floored and never negative', () => {
		expect(pointsToValue(250, config())).toBe(250);
		expect(pointsToValue(10.9, config())).toBe(10);
		expect(pointsToValue(-5, config())).toBe(0);
		expect(pointsToValue(Number.NaN, config())).toBe(0);
	});
	it('supports fractional rates (100 points = 50 minor units)', () => {
		const rate = config({ rate_points: 100, rate_value_minor: 50 });
		expect(pointsToValue(199, rate)).toBe(99);
		expect(valueToPoints(99, rate)).toBe(198);
		expect(pointsToValue(valueToPoints(1234, rate), rate)).toBeLessThanOrEqual(1234);
	});
});

describe('maxRedeemable (ported)', () => {
	it('caps at 20% of the subtotal', () => {
		expect(max(10_000, 50_000)).toBe(2_000);
		expect(max(10_004, 50_000)).toBe(2_000);
	});
	it('caps at the available balance', () => {
		expect(max(100_000, 750)).toBe(750);
	});
	it('is zero for empty carts, zero balances and negative inputs', () => {
		expect(max(0, 1_000)).toBe(0);
		expect(max(10_000, 0)).toBe(0);
		expect(max(-100, 1_000)).toBe(0);
		expect(max(10_000, -5)).toBe(0);
	});
	it('never lets the value exceed the share with non-integer rates', () => {
		const q = quote({ balance: 1e9, amount: 9999, config: config({ min_points: 1, rate_points: 3, rate_value_minor: 7 }) });
		expect(q.maxValue).toBeLessThanOrEqual(q.capValue);
		expect(q.capValue).toBe(1999);
	});
});

describe('quote and redeemProblem', () => {
	it('explains why nothing can be redeemed', () => {
		expect(quote({ balance: 500, amount: 10_000, discount: 100, config: config({ allow_with_offers: false }) })).toMatchObject({
			allowed: false,
			reason: 'offers_not_allowed',
			maxPoints: 0,
		});
		expect(quote({ balance: 500, amount: 0, config: config() }).reason).toBe('amount_required');
		expect(quote({ balance: 0, amount: 10_000, config: config() }).reason).toBe('no_balance');
		expect(quote({ balance: 50, amount: 10_000, config: config() }).reason).toBe('below_minimum');
		expect(quote({ balance: 5000, amount: 400, config: config() }).reason).toBe('share_too_small');
		expect(quote({ balance: 5000, amount: 10_000, discount: 100, config: config() })).toMatchObject({
			allowed: true,
			maxPoints: 2000,
		});
	});
	it('validates a requested number of points', () => {
		const q = quote({ balance: 1500, amount: 10_000, config: config() });
		expect(redeemProblem(1.5, q)).toBe('points_invalid');
		expect(redeemProblem(0, q)).toBe('points_invalid');
		expect(redeemProblem(99, q)).toBe('below_minimum');
		expect(redeemProblem(1600, q)).toBe('insufficient_points');
		expect(redeemProblem(1500, q)).toBeNull();
		const capped = quote({ balance: 5000, amount: 10_000, config: config() });
		expect(redeemProblem(2001, capped)).toBe('above_maximum');
		expect(redeemProblem(100, quote({ balance: 0, amount: 1, config: config() }))).toBe('no_balance');
	});
});
