import { describe, expect, it } from 'vitest';
import {
	addToBucket,
	decideTier,
	ladder,
	multiplierOf,
	nextTier,
	pruneBuckets,
	rankOf,
	tierFor,
	tierMetric,
} from '../core/tiers.js';

const tiers = [
	{ key: 'gold', name: 'Gold', threshold: 5000, multiplier: 1.5 },
	{ key: 'bronze', name: 'Bronze', threshold: 0, multiplier: 1 },
	{ key: 'silver', name: 'Silver', threshold: 1000, multiplier: 1.25 },
];
/** @param {Record<string, any>} [overrides] @returns {any} */
const config = (overrides = {}) => ({
	tiers,
	basis: 'points_earned',
	window_months: 12,
	downgrade: 'end_of_period',
	...overrides,
});
const now = Date.parse('2026-10-01T00:00:00Z');

describe('tier ladder', () => {
	it('sorts, finds the highest reached tier and the next one', () => {
		expect(ladder(tiers).map((t) => t.key)).toEqual(['bronze', 'silver', 'gold']);
		expect(tierFor(tiers, 0)?.key).toBe('bronze');
		expect(tierFor(tiers, 4999)?.key).toBe('silver');
		expect(tierFor(tiers, 5000)?.key).toBe('gold');
		expect(tierFor([{ key: 'vip', name: 'VIP', threshold: 100 }], 50)).toBeNull();
		expect(nextTier(tiers, 1200)).toEqual({ tier: tiers[0], remaining: 3800 });
		expect(nextTier(tiers, 9000)).toBeNull();
		expect(multiplierOf(tiers, 'silver')).toBe(1.25);
		expect(multiplierOf(tiers, null)).toBe(1);
		expect(multiplierOf([{ key: 'x', name: 'X', threshold: 0 }], 'x')).toBe(1);
		expect(rankOf(tiers, 'gold')).toBe(2);
		expect(rankOf(tiers, 'nope')).toBe(-1);
	});
});

describe('qualification metric', () => {
	it('sums the window of local months, or lifetime', () => {
		let buckets = addToBucket({}, '2026-10', { points: 100, spend: 5000 });
		buckets = addToBucket(buckets, '2026-10', { points: 50 });
		buckets = addToBucket(buckets, '2025-10', { points: 999 });
		buckets = addToBucket(buckets, '2025-11', { points: 1, spend: 10 });
		const member = { buckets, lifetime: { points: 2000, spend: 90000 } };
		expect(tierMetric(member, config(), { now, timeZone: 'UTC' })).toBe(151);
		expect(tierMetric(member, config({ basis: 'spend' }), { now, timeZone: 'UTC' })).toBe(5010);
		expect(tierMetric(member, config({ window_months: 0 }), { now, timeZone: 'UTC' })).toBe(2000);
		expect(tierMetric(member, config({ window_months: 0, basis: 'spend' }), { now, timeZone: 'UTC' })).toBe(90000);
		expect(
			tierMetric({ buckets: { '2026-10': { points: -50, spend: 0 } }, lifetime: { points: 0, spend: 0 } }, config(), {
				now,
				timeZone: 'UTC',
			}),
		).toBe(0);
		expect(Object.keys(pruneBuckets(buckets, { now, months: 12, timeZone: 'UTC' })).sort()).toEqual(['2025-11', '2026-10']);
		expect(pruneBuckets(buckets, { now, months: 0, timeZone: 'UTC' })).toBe(buckets);
	});
});

describe('decideTier', () => {
	it('upgrades at once with a review date one window later', () => {
		const result = decideTier({ current: null, metric: 1200, config: config(), now });
		expect(result).toEqual({
			tier: { key: 'silver', since: '2026-10-01T00:00:00.000Z', reviewAt: '2027-10-01T00:00:00.000Z' },
			changed: true,
			direction: 'up',
		});
		expect(decideTier({ current: null, metric: 0, config: config({ window_months: 0 }), now }).tier?.reviewAt).toBe(
			'2027-10-01T00:00:00.000Z',
		);
	});

	const gold = { key: 'gold', since: '2026-01-01T00:00:00.000Z', reviewAt: '2027-01-01T00:00:00.000Z' };
	it('end_of_period keeps a tier until its review date, then downgrades or renews', () => {
		expect(decideTier({ current: gold, metric: 10, config: config(), now })).toEqual({
			tier: gold,
			changed: false,
			direction: null,
		});
		const after = Date.parse('2027-01-02T00:00:00Z');
		expect(decideTier({ current: gold, metric: 1500, config: config(), now: after })).toMatchObject({
			tier: { key: 'silver' },
			direction: 'down',
		});
		const renewed = decideTier({ current: gold, metric: 6000, config: config(), now: after });
		expect(renewed).toMatchObject({
			changed: false,
			tier: { key: 'gold', since: gold.since, reviewAt: '2028-01-02T00:00:00.000Z' },
		});
	});

	it('never keeps the highest tier; immediate follows the metric', () => {
		expect(decideTier({ current: gold, metric: 0, config: config({ downgrade: 'never' }), now }).tier).toBe(gold);
		expect(decideTier({ current: gold, metric: 0, config: config({ downgrade: 'immediate' }), now })).toMatchObject({
			tier: { key: 'bronze' },
			direction: 'down',
		});
		expect(decideTier({ current: gold, metric: 9000, config: config({ downgrade: 'immediate' }), now })).toMatchObject({
			changed: false,
		});
		const noFloor = config({ downgrade: 'immediate', tiers: [{ key: 'vip', name: 'VIP', threshold: 100 }] });
		expect(decideTier({ current: { key: 'vip', since: '', reviewAt: null }, metric: 0, config: noFloor, now })).toMatchObject({
			tier: null,
			direction: 'down',
		});
	});

	it('moves members off a tier that no longer exists', () => {
		const removed = { key: 'platinum', since: '2026-01-01T00:00:00.000Z', reviewAt: null };
		expect(decideTier({ current: removed, metric: 1200, config: config(), now })).toMatchObject({
			tier: { key: 'silver' },
			direction: 'up',
		});
		expect(
			decideTier({
				current: removed,
				metric: 1200,
				config: config({ tiers: [{ key: 'vip', name: 'VIP', threshold: 5000 }] }),
				now,
			}),
		).toMatchObject({ tier: null, direction: 'down' });
	});
});
