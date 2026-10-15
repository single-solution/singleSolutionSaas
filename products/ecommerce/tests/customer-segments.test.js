/**
 * Customer and order tags and saved customer segments (E11): the tag check, the `customer_segments` list's check with
 * today's three segments as its default, and the filter a segment's rules make.
 */
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_SEGMENTS,
	SEGMENT_FIELDS,
	checkSegments,
	checkTags,
	segmentFilter,
	segmentNeeds,
} from '../core/customer-segments.js';

describe('tags', () => {
	it('keeps trimmed tags once each and refuses too many or too long', () => {
		expect(checkTags([' vip ', 'vip', 'Wholesale'])).toEqual({ ok: true, value: ['vip', 'Wholesale'] });
		expect(checkTags([])).toEqual({ ok: true, value: [] });
		expect(checkTags('vip').ok).toBe(false);
		expect(checkTags(['x'.repeat(41)]).ok).toBe(false);
		expect(checkTags(Array.from({ length: 31 }, (_, i) => `t${i}`)).ok).toBe(false);
		expect(checkTags(['']).ok).toBe(false);
	});
});

describe('saved segments', () => {
	it('seeds the three segments customers had', () => {
		expect(DEFAULT_SEGMENTS.map((segment) => segment.key)).toEqual(['loyalty', 'active', 'guest']);
		expect(checkSegments(DEFAULT_SEGMENTS)).toEqual({ ok: true, value: DEFAULT_SEGMENTS });
	});

	it('checks keys, names, rules and match', () => {
		const ok = checkSegments([
			{
				key: 'big-spenders',
				name: ' Big spenders ',
				match: 'any',
				rules: [
					{ field: 'spent', op: 'gte', value: 50000 },
					{ field: 'tag', op: 'is', value: 'vip' },
					{ field: 'country', op: 'is', value: 'us' },
					{ field: 'field:att_1', op: 'set' },
				],
			},
		]);
		expect(ok.ok).toBe(true);
		if (ok.ok) {
			expect(ok.value[0]?.name).toBe('Big spenders');
			expect(ok.value[0]?.rules[2]).toEqual({ field: 'country', op: 'is', value: 'US' });
			expect(ok.value[0]?.rules[3]).toEqual({ field: 'field:att_1', op: 'set', value: null });
		}
		const bad = checkSegments([
			{ key: 'Bad Key', name: '', match: 'some', rules: [] },
			{ key: 'x', name: 'X', rules: [{ field: 'nope', op: 'is', value: 1 }] },
			{ key: 'y', name: 'Y', rules: [{ field: 'orders', op: 'is', value: 'two' }] },
			{ key: 'x', name: 'X again', rules: [{ field: 'guest', op: 'is', value: true }] },
		]);
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.errors.length).toBeGreaterThanOrEqual(5);
	});

	it('names every rule field', () => {
		expect(Object.keys(SEGMENT_FIELDS)).toEqual(
			expect.arrayContaining([
				'tag',
				'orders',
				'spent',
				'last_order',
				'city',
				'region',
				'country',
				'guest',
				'blocked',
				'loyalty',
			]),
		);
	});

	it('turns the seeded segments into today’s filters', () => {
		const [loyalty, active, guest] = DEFAULT_SEGMENTS;
		expect(segmentFilter(/** @type {any} */ (guest), { now: 0 })).toEqual({ $and: [{ guest: true }] });
		expect(segmentFilter(/** @type {any} */ (active), { now: 0 })).toEqual({ $and: [{ orderCount: { $gte: 1 } }] });
		// the loyalty segment is the member flag while the loyalty setting memberFlag is on (E47) …
		expect(segmentFilter(/** @type {any} */ (loyalty), { now: 0, loyalty: 'flag' })).toEqual({
			$and: [{ loyaltyMember: true }],
		});
		// … else who holds points
		expect(
			segmentFilter(/** @type {any} */ (loyalty), { now: 0, loyalty: { userIds: ['u1'], customerIds: ['cus_1'] } }),
		).toEqual({ $and: [{ $or: [{ userId: { $in: ['u1'] } }, { id: { $in: ['cus_1'] } }] }] });
		expect(segmentNeeds(/** @type {any} */ (loyalty))).toEqual({ loyalty: true, spent: [] });
	});

	it('matches tags, places, spend, last order and fields', () => {
		const now = Date.parse('2026-10-15T00:00:00Z');
		const segment = {
			key: 's',
			name: 'S',
			match: /** @type {const} */ ('any'),
			rules: [
				{ field: 'tag', op: 'is_not', value: 'vip' },
				{ field: 'city', op: 'is', value: 'Springfield' },
				{ field: 'spent', op: 'lte', value: 1000 },
				{ field: 'last_order', op: 'within', value: 30 },
				{ field: 'field:att_1', op: 'is', value: 'gold' },
				{ field: 'blocked', op: 'is', value: false },
			],
		};
		expect(segmentNeeds(segment)).toEqual({ loyalty: false, spent: [{ index: 2, op: 'lte', value: 1000 }] });
		const filter = segmentFilter(segment, { now, spent: new Map([[2, { userIds: ['u9'], customerIds: [] }]]) });
		expect(filter).toEqual({
			$or: [
				{ tags: { $ne: 'vip' } },
				{
					$or: [
						{ city: { $regex: '^Springfield$', $options: 'i' } },
						{ 'addresses.city': { $regex: '^Springfield$', $options: 'i' } },
					],
				},
				{ $nor: [{ userId: { $in: ['u9'] } }, { id: { $in: [] } }] },
				{ lastOrderAt: { $gte: new Date(now - 30 * 86_400_000) } },
				{ 'fields.att_1': 'gold' },
				{ blocked: { $ne: true } },
			],
		});
	});
});
