import { describe, expect, it } from 'vitest';
import {
	attributionRefusal,
	CODE_ALPHABET,
	codeFromBytes,
	codeFromSource,
	normaliseCode,
	rewardDecision,
} from '../core/referrals.js';
import { DAY_MS } from '../core/time.js';

/** @param {Record<string, any>} [overrides] @returns {any} */
const config = (overrides = {}) => ({
	referrer_points: 500,
	referee_points: 250,
	min_order_amount: 2000,
	code_prefix: 'REF',
	code_length: 8,
	attribution_days: 30,
	source_prefix: 'referral:',
	new_customers_only: true,
	max_rewards_per_month: 2,
	max_rewards_lifetime: 3,
	...overrides,
});
const attributedAt = '2026-10-01T00:00:00.000Z';
const t0 = Date.parse(attributedAt);

describe('codes', () => {
	it('builds codes from an unambiguous alphabet and normalises input', () => {
		const code = codeFromBytes({ prefix: 'REF', length: 8, bytes: [0, 1, 2, 30, 31, 255, 7, 8] });
		expect(code).toMatch(/^REF[A-Z2-9]{8}$/);
		expect(CODE_ALPHABET).not.toMatch(/[01OIL]/);
		expect(codeFromBytes({ prefix: '', length: 2, bytes: [] })).toBe('AA');
		expect(normaliseCode(' ref-7k2m 9q ')).toBe('REF7K2M9Q');
		expect(normaliseCode(5)).toBe('');
		expect(codeFromSource('referral:ref7k2m', 'referral:')).toBe('REF7K2M');
		expect(codeFromSource('referral:', 'referral:')).toBeNull();
		expect(codeFromSource('newsletter', 'referral:')).toBeNull();
		expect(codeFromSource(undefined, 'referral:')).toBeNull();
		expect(codeFromSource('x', '')).toBeNull();
	});
});

describe('attribution fraud rules', () => {
	const base = { referrerId: 'cus_a', refereeId: 'cus_b', alreadyReferred: false, refereeOrders: 0, config: config() };
	it('refuses unknown codes, self-referrals, double attribution and existing customers', () => {
		expect(attributionRefusal(base)).toBeNull();
		expect(attributionRefusal({ ...base, referrerId: null })).toBe('unknown_code');
		expect(attributionRefusal({ ...base, refereeId: 'cus_a' })).toBe('self_referral');
		expect(attributionRefusal({ ...base, alreadyReferred: true })).toBe('already_referred');
		expect(attributionRefusal({ ...base, refereeOrders: 1 })).toBe('not_a_new_customer');
		expect(attributionRefusal({ ...base, refereeOrders: 1, config: config({ new_customers_only: false }) })).toBeNull();
	});
});

describe('reward decisions', () => {
	const decide = (overrides = {}) =>
		rewardDecision({
			attributedAt,
			now: t0 + DAY_MS,
			orderAmount: 5000,
			referrerRewardsThisMonth: 0,
			referrerRewardsTotal: 0,
			config: config(),
			...overrides,
		});
	it('rewards both sides on the first qualifying order within the window', () => {
		expect(decide()).toEqual({ decision: 'reward', referee: 250, referrer: 500, reason: null });
	});
	it('waits for a qualifying order and expires after the attribution window', () => {
		expect(decide({ orderAmount: 1999 })).toMatchObject({ decision: 'wait', reason: 'order_below_minimum' });
		expect(decide({ now: t0 + 30 * DAY_MS })).toMatchObject({ decision: 'reward' });
		expect(decide({ now: t0 + 30 * DAY_MS + 1 })).toMatchObject({ decision: 'expired', referee: 0, referrer: 0 });
	});
	it('applies the referrer fraud caps (monthly and lifetime) but still rewards the referee', () => {
		expect(decide({ referrerRewardsThisMonth: 2 })).toEqual({
			decision: 'reward',
			referee: 250,
			referrer: 0,
			reason: 'referrer_cap_reached',
		});
		expect(decide({ referrerRewardsTotal: 3 })).toMatchObject({ referrer: 0, reason: 'referrer_cap_reached' });
		expect(decide({ referrerRewardsThisMonth: 1, referrerRewardsTotal: 2 })).toMatchObject({ referrer: 500 });
	});
});
