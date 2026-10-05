import { describe, expect, it } from 'vitest';
import { collectible, refundedFraction, returnsRedeemed, reversalFor, reversalTarget, spendTarget } from '../core/reversal.js';

/** @param {Record<string, any>} [overrides] @returns {any} */
const config = (overrides = {}) => ({
	reverse_earned: true,
	negative_balance: 'cap_at_balance',
	partial_refunds: 'proportional',
	refund_redeemed: true,
	...overrides,
});

describe('reversal semantics (ibrahimMobiles reverseEarnedPoints / refundRedeemedPoints, extended)', () => {
	it('computes the refunded fraction', () => {
		expect(refundedFraction({ cancelled: true, total: 100 })).toBe(1);
		expect(refundedFraction({ refunded: 25, total: 100 })).toBe(0.25);
		expect(refundedFraction({ refunded: 250, total: 100 })).toBe(1);
		expect(refundedFraction({ refunded: 1, total: 0 })).toBe(1);
		expect(refundedFraction({ total: 0 })).toBe(0);
		expect(refundedFraction({ refunded: -5, total: 100 })).toBe(0);
	});

	it('caps at the balance (points already spent are not clawed back below zero)', () => {
		expect(reversalFor({ earned: 120, reversed: 0, fraction: 1, balance: 500, config: config() })).toEqual({
			points: 120,
			allowNegative: false,
			target: 120,
			uncollected: 0,
		});
		expect(reversalFor({ earned: 120, reversed: 0, fraction: 1, balance: 30, config: config() })).toEqual({
			points: 30,
			allowNegative: false,
			target: 120,
			uncollected: 90,
		});
		expect(reversalFor({ earned: 120, reversed: 0, fraction: 1, balance: -10, config: config() }).points).toBe(0);
	});

	it('allows negative balances when configured', () => {
		expect(
			reversalFor({
				earned: 120,
				reversed: 0,
				fraction: 1,
				balance: 30,
				config: config({ negative_balance: 'allow_negative' }),
			}),
		).toEqual({ points: 120, allowNegative: true, target: 120, uncollected: 0 });
	});

	it('reverses partial refunds proportionally and converges over several refunds', () => {
		const c = config();
		const first = reversalFor({ earned: 101, reversed: 0, fraction: 0.5, balance: 1000, config: c });
		expect(first.points).toBe(50);
		const second = reversalFor({ earned: 101, reversed: 50, fraction: 1, balance: 1000, config: c });
		expect(second.points).toBe(51);
		expect(reversalFor({ earned: 101, reversed: 101, fraction: 1, balance: 1000, config: c }).points).toBe(0);
		expect(reversalFor({ earned: 101, reversed: 80, fraction: 0.5, balance: 1000, config: c }).points).toBe(0);
	});

	it('ignores partial refunds with partial_refunds = none and everything with reverse_earned = false', () => {
		expect(reversalTarget({ earned: 100, fraction: 0.5, config: config({ partial_refunds: 'none' }) })).toBe(0);
		expect(reversalTarget({ earned: 100, fraction: 1, config: config({ partial_refunds: 'none' }) })).toBe(100);
		expect(reversalTarget({ earned: 100, fraction: 1, config: config({ reverse_earned: false }) })).toBe(0);
		expect(reversalTarget({ earned: -5, fraction: 1, config: config() })).toBe(0);
		expect(spendTarget({ total: 10_000, fraction: 0.333, config: config() })).toBe(3330);
		expect(spendTarget({ total: 10_000, fraction: 0.5, config: config({ partial_refunds: 'none' }) })).toBe(0);
		expect(spendTarget({ total: -1, fraction: 2, config: config() })).toBe(0);
		expect(collectible({ due: -3, balance: 10, config: config() })).toEqual({
			points: 0,
			allowNegative: false,
			uncollected: 0,
		});
	});

	it('gives redeemed points back only on full cancellation / refund and when enabled', () => {
		expect(returnsRedeemed({ fraction: 1, config: config() })).toBe(true);
		expect(returnsRedeemed({ fraction: 0.9, config: config() })).toBe(false);
		expect(returnsRedeemed({ fraction: 1, config: config({ refund_redeemed: false }) })).toBe(false);
	});
});
