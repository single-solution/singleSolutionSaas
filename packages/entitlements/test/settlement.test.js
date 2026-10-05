import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
	balanceAfter,
	burnRate,
	hourlyCharge,
	hoursRemaining,
	nextCursor,
	planMeteredSettlement,
	planSettlement,
	priceBookResolver,
	projectedMonth,
	reconcile,
} from '../src/settlement.js';
import { coupons, deepFreeze } from './fixtures.js';

const H = 3_600_000;
const T0 = Date.parse('2026-10-01T10:00:00Z');
const at = (/** @type {number} */ hours, minutes = 0) => new Date(T0 + hours * H + minutes * 60_000).toISOString();

const V1 = /** @type {import('../src/catalog.js').PriceBook} */ (coupons.priceBooks[0]);
const V2 = /** @type {import('../src/catalog.js').PriceBook} */ (coupons.priceBooks[1]);

const sub = deepFreeze({ id: 'sub_1', startedAt: at(0), priceBookVersion: '2026-01-01' });
const timeline = deepFreeze([
	{ at: at(0), element: 'codes', enabled: true },
	{ at: at(0), element: 'apply_box', enabled: true },
]);

/**
 * @param {Partial<Parameters<typeof planSettlement>[0]>} [overrides]
 */
const settle = (overrides = {}) =>
	planSettlement({
		subscription: sub,
		priceBook: coupons,
		elementTimeline: timeline,
		pauses: [],
		from: at(0),
		to: at(5),
		...overrides,
	});

describe('planSettlement basics', () => {
	it('emits one bucket per complete UTC hour with periodKey and breakdown', () => {
		const result = settle();
		expect(result.buckets).toHaveLength(5);
		expect(result.buckets[0]).toEqual({
			periodKey: 'sub_1:2026-10-01T10:00:00Z',
			subscriptionId: 'sub_1',
			bucketStart: '2026-10-01T10:00:00Z',
			bucketEnd: '2026-10-01T11:00:00Z',
			sampledAt: '2026-10-01T10:00:00Z',
			priceBookVersion: '2026-01-01',
			amount: 1600,
			breakdown: [
				{ kind: 'base', amount: 100 },
				{ kind: 'element', element: 'apply_box', amount: 500 },
				{ kind: 'element', element: 'codes', amount: 1000 },
			],
		});
		expect(result.total).toBe(8000);
		expect(result.cursor).toBe('2026-10-01T15:00:00Z');
		expect(result.skipped).toEqual([]);
	});

	it('is idempotent: same inputs → same periodKeys and amounts, inputs untouched', () => {
		expect(settle()).toEqual(settle());
		const frozen = deepFreeze({
			subscription: { ...sub },
			priceBook: coupons,
			elementTimeline: [...timeline],
			pauses: [{ from: at(1), to: at(2), reason: 'paused' }],
			from: at(0),
			to: at(5),
		});
		expect(() => planSettlement(frozen)).not.toThrow();
	});

	it('settles only complete buckets and never before the cursor', () => {
		const partial = settle({ to: at(2, 59) });
		expect(partial.buckets.map((b) => b.bucketStart)).toEqual(['2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z']);
		expect(partial.cursor).toBe('2026-10-01T12:00:00Z');
		const unaligned = settle({ from: at(1, 1) });
		expect(unaligned.buckets[0]?.bucketStart).toBe('2026-10-01T12:00:00Z');
		const none = settle({ to: at(0, 30) });
		expect(none.buckets).toEqual([]);
		expect(none.cursor).toBe('2026-10-01T10:00:00Z');
	});

	it('bills the started hour of a subscription starting or ending mid-hour', () => {
		const late = settle({
			subscription: { ...sub, startedAt: at(0, 20) },
			elementTimeline: [{ at: at(0, 20), element: 'codes', enabled: true }],
		});
		expect(late.buckets[0]).toMatchObject({
			bucketStart: '2026-10-01T10:00:00Z',
			sampledAt: '2026-10-01T10:20:00Z',
			amount: 1100,
		});
		const ended = settle({ subscription: { ...sub, endedAt: at(2, 10) } });
		expect(ended.buckets.map((b) => b.bucketStart)).toEqual([
			'2026-10-01T10:00:00Z',
			'2026-10-01T11:00:00Z',
			'2026-10-01T12:00:00Z',
		]);
		const before = settle({ from: at(-5), to: at(1) });
		expect(before.buckets.map((b) => b.bucketStart)).toEqual(['2026-10-01T10:00:00Z']);
	});
});

describe('pauses', () => {
	it('never bills fully paused buckets and reports why', () => {
		const result = settle({ pauses: [{ from: at(1), to: at(3), reason: 'balance' }] });
		expect(result.buckets.map((b) => b.bucketStart)).toEqual([
			'2026-10-01T10:00:00Z',
			'2026-10-01T13:00:00Z',
			'2026-10-01T14:00:00Z',
		]);
		expect(result.skipped).toEqual([
			{ periodKey: 'sub_1:2026-10-01T11:00:00Z', bucketStart: '2026-10-01T11:00:00Z', reason: 'balance' },
			{ periodKey: 'sub_1:2026-10-01T12:00:00Z', bucketStart: '2026-10-01T12:00:00Z', reason: 'balance' },
		]);
	});

	it('bills a started hour when active time exists (pause mid-hour, resume mid-hour)', () => {
		const result = settle({ pauses: [{ from: at(0, 30), to: at(1, 30), reason: 'paused' }] });
		expect(result.buckets.map((b) => [b.bucketStart, b.sampledAt])).toEqual([
			['2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z'],
			['2026-10-01T11:00:00Z', '2026-10-01T11:30:00Z'],
			['2026-10-01T12:00:00Z', '2026-10-01T12:00:00Z'],
			['2026-10-01T13:00:00Z', '2026-10-01T13:00:00Z'],
			['2026-10-01T14:00:00Z', '2026-10-01T14:00:00Z'],
		]);
	});

	it('handles open-ended, overlapping and empty pauses with a deterministic reason', () => {
		const result = settle({
			pauses: [
				{ from: at(2), to: null, reason: 'paused' },
				{ from: at(1, 30), to: at(3), reason: 'suspended' },
				{ from: at(4), to: at(4), reason: 'spend_cap' },
				{ from: at(3), to: at(4), reason: 'custom' },
			],
		});
		expect(result.buckets.map((b) => b.bucketStart)).toEqual(['2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z']);
		expect(result.skipped.map((s) => s.reason)).toEqual(['suspended', 'paused', 'paused']);
	});

	it('Σ billed + skipped = in-life hours and billed buckets never start inside a full pause (property)', () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						from: fc.integer({ min: 0, max: 48 * 60 }),
						len: fc.integer({ min: 0, max: 6 * 60 }),
						reason: fc.constantFrom('paused', 'spend_cap', 'suspended'),
					}),
					{ maxLength: 6 },
				),
				(raw) => {
					const pauses = raw.map((p) => ({ from: at(0, p.from), to: at(0, p.from + p.len), reason: p.reason }));
					const result = settle({ pauses, to: at(48) });
					expect(result.buckets.length + result.skipped.length).toBe(48);
					for (const b of result.buckets) {
						const start = Date.parse(b.bucketStart);
						const covered = pauses.some((p) => Date.parse(p.from) <= start && Date.parse(p.to) >= start + H);
						const sample = Date.parse(b.sampledAt);
						expect(pauses.some((p) => Date.parse(p.from) <= sample && sample < Date.parse(p.to))).toBe(false);
						// A bucket fully covered by the union of pauses would have no active instant.
						if (covered) throw new Error(`billed a fully paused bucket ${b.bucketStart}`);
					}
				},
			),
		);
	});
});

describe('element toggles and price books', () => {
	it('an element enabled mid-hour is charged from the next bucket; disabled mid-hour still charged for the started hour', () => {
		const result = settle({
			elementTimeline: [
				...timeline,
				{ at: at(1, 20), element: 'reports', enabled: true },
				{ at: at(2, 40), element: 'apply_box', enabled: false },
			],
		});
		expect(result.buckets.map((b) => b.amount)).toEqual([1600, 1600, 1850, 1350, 1350]);
		expect(result.buckets[2]?.breakdown.map((l) => l.element ?? l.kind)).toEqual(['base', 'apply_box', 'codes', 'reports']);
	});

	it('a simultaneous enable/disable at the same instant resolves to disabled', () => {
		const result = settle({
			elementTimeline: [
				{ at: at(0), element: 'codes', enabled: false },
				{ at: at(0), element: 'codes', enabled: true },
			],
		});
		expect(result.buckets[0]?.amount).toBe(100);
	});

	it('a price-book change applies from the next bucket', () => {
		const pinned = {
			...sub,
			pins: [
				{ version: '2026-01-01', at: at(0) },
				{ version: '2026-06-01', at: at(1, 20) },
			],
		};
		const result = settle({ subscription: pinned });
		expect(result.buckets.map((b) => [b.priceBookVersion, b.amount])).toEqual([
			['2026-01-01', 1600],
			['2026-01-01', 1600],
			['2026-06-01', 2100],
			['2026-06-01', 2100],
			['2026-06-01', 2100],
		]);
	});

	it('a pin never applies before its book is effective; missing books are unpriced', () => {
		const future = { ...V2, version: 'future', effectiveFrom: Date.parse(at(2, 30)) };
		const books = [V1, future];
		const result = settle({ subscription: { ...sub, pins: [{ version: 'future', at: at(0) }] }, priceBook: books });
		expect(result.skipped.map((s) => [s.bucketStart, s.reason])).toEqual([
			['2026-10-01T10:00:00Z', 'unpriced'],
			['2026-10-01T11:00:00Z', 'unpriced'],
			['2026-10-01T12:00:00Z', 'unpriced'],
		]);
		expect(result.buckets.map((b) => b.bucketStart)).toEqual(['2026-10-01T13:00:00Z', '2026-10-01T14:00:00Z']);
		expect(() => settle({ subscription: { ...sub, priceBookVersion: 'nope' } })).toThrow(/nope/);
	});

	it('without pins uses the latest effective book; accepts a single book', () => {
		const unpinned = { id: 'sub_1', startedAt: at(0) };
		expect(settle({ subscription: unpinned }).buckets[0]?.priceBookVersion).toBe('2026-06-01');
		expect(settle({ subscription: unpinned, priceBook: V1 }).buckets[0]?.priceBookVersion).toBe('2026-01-01');
		const resolver = priceBookResolver(unpinned, [V1]);
		expect(resolver(Date.parse('2025-01-01T00:00:00Z'))).toBeNull();
	});

	it('rejects unknown elements in the timeline', () => {
		expect(() => settle({ elementTimeline: [{ at: at(0), element: 'ghost', enabled: true }] })).toThrow(/ghost/);
	});

	it('computes hourly charges and burn rates', () => {
		expect(hourlyCharge({ priceBook: V1, elements: ['codes', 'codes'] }).amount).toBe(1100);
		expect(burnRate({ priceBook: V2, elements: ['codes', 'ai_copy'] })).toBe(3600);
	});
});

describe('resumability and catch-up', () => {
	/**
	 * Runs settlement in consecutive windows, advancing the cursor like a job would.
	 * @param {number[]} stops Hours (relative to T0) at which runs happen.
	 */
	const runJob = (stops) => {
		let cursor = at(0);
		/** @type {import('../src/settlement.js').Bucket[]} */
		const all = [];
		/** @type {string[]} */
		const cursors = [];
		for (const stop of stops) {
			const result = settle({ from: cursor, to: at(0, stop), pauses: [{ from: at(7), to: at(9, 30), reason: 'spend_cap' }] });
			all.push(...result.buckets);
			cursors.push(result.cursor);
			cursor = result.cursor;
		}
		return { all, cursors };
	};

	it('downtime catch-up settles each bucket exactly once (property)', () => {
		const single = settle({ from: at(0), to: at(24), pauses: [{ from: at(7), to: at(9, 30), reason: 'spend_cap' }] }).buckets;
		fc.assert(
			fc.property(fc.array(fc.integer({ min: 0, max: 24 * 60 }), { maxLength: 12 }), (stops) => {
				const sorted = [...stops].sort((a, b) => a - b);
				const { all, cursors } = runJob([...sorted, 24 * 60]);
				expect(all).toEqual(single);
				expect(new Set(all.map((b) => b.periodKey)).size).toBe(all.length);
				for (let i = 1; i < cursors.length; i += 1)
					expect(Date.parse(/** @type {string} */ (cursors[i]))).toBeGreaterThanOrEqual(
						Date.parse(/** @type {string} */ (cursors[i - 1])),
					);
			}),
		);
	});

	it('re-running an already settled window yields the same keys (ledger dedupes them)', () => {
		const first = settle({ from: at(0), to: at(3) });
		const again = settle({ from: at(0), to: at(3) });
		expect(again.buckets.map((b) => b.periodKey)).toEqual(first.buckets.map((b) => b.periodKey));
		expect(
			reconcile({ expectedBuckets: first.buckets, ledgerKeys: [...first.buckets, ...again.buckets].map((b) => b.periodKey) })
				.duplicates,
		).toHaveLength(3);
	});

	it('the cursor is monotonic and hour-aligned (property)', () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 1e12 }), fc.integer({ min: 0, max: 1e12 }), (cursor, to) => {
				const next = Date.parse(nextCursor({ cursor, to }));
				expect(next % H).toBe(0);
				expect(next).toBeGreaterThanOrEqual(cursor);
				expect(next).toBeGreaterThanOrEqual(Math.floor(to / H) * H);
			}),
		);
	});

	it('Σ invariants: total = Σ amounts = Σ breakdown; amount = base + Σ enabled prices at the sample (property)', () => {
		const elements = ['codes', 'apply_box', 'reports', 'ai_copy'];
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						minute: fc.integer({ min: 0, max: 12 * 60 }),
						element: fc.constantFrom(...elements),
						enabled: fc.boolean(),
					}),
					{ maxLength: 20 },
				),
				(events) => {
					const elementTimeline = events.map((e) => ({ at: at(0, e.minute), element: e.element, enabled: e.enabled }));
					const pinned = {
						...sub,
						pins: [
							{ version: '2026-01-01', at: at(0) },
							{ version: '2026-06-01', at: at(6, 10) },
						],
					};
					const result = settle({ subscription: pinned, elementTimeline, to: at(12) });
					expect(result.total).toBe(result.buckets.reduce((s, b) => s + b.amount, 0));
					for (const b of result.buckets) {
						expect(b.amount).toBe(b.breakdown.reduce((s, l) => s + l.amount, 0));
						const sample = Date.parse(b.sampledAt);
						/** @type {Map<string, boolean>} */
						const state = new Map();
						const sorted = [...elementTimeline].sort(
							(x, y) =>
								Date.parse(x.at) - Date.parse(y.at) ||
								(x.element < y.element ? -1 : x.element > y.element ? 1 : 0) ||
								Number(y.enabled) - Number(x.enabled),
						);
						for (const e of sorted) if (Date.parse(e.at) <= sample) state.set(e.element, e.enabled);
						const book = sample >= Date.parse(at(6, 10)) ? V2 : V1;
						const expected =
							book.baseHourly + [...state].filter(([, on]) => on).reduce((s, [el]) => s + (book.elements[el] ?? 0), 0);
						expect(b.amount).toBe(expected);
						expect(b.priceBookVersion).toBe(book.version);
					}
				},
			),
		);
	});
});

describe('planMeteredSettlement', () => {
	const bucket = { subscriptionId: 'sub_1', bucketStart: at(3) };

	it('charges overage above included on cumulative usage', () => {
		const result = planMeteredSettlement({
			usageByUnit: { redemption: { before: 450, delta: 100 }, token: 12345, free: 5 },
			included: { redemption: 500, token: 0, free: null },
			overageRate: { redemption: 0.01, token: { millicredits: 1, per: 100 } },
			bucket,
		});
		expect(result).toEqual({
			periodKey: 'sub_1:2026-10-01T13:00:00Z:metered',
			bucketStart: '2026-10-01T13:00:00Z',
			lines: [
				{ unit: 'free', quantity: 5, billableQuantity: 0, amount: 0 },
				{ unit: 'redemption', quantity: 100, billableQuantity: 50, amount: 500 },
				{ unit: 'token', quantity: 12345, billableQuantity: 12345, amount: 123 },
			],
			amount: 623,
		});
	});

	it('treats missing included as zero and validates inputs', () => {
		expect(planMeteredSettlement({ usageByUnit: { x: 3 }, overageRate: { x: 1 }, bucket }).amount).toBe(3000);
		expect(() => planMeteredSettlement({ usageByUnit: { x: 3 }, overageRate: {}, bucket })).toThrow(/rate/);
		expect(() => planMeteredSettlement({ usageByUnit: { x: -1 }, overageRate: { x: 1 }, bucket })).toThrow(/integers/);
		expect(() =>
			planMeteredSettlement({ usageByUnit: {}, overageRate: {}, bucket: { ...bucket, bucketStart: at(3, 1) } }),
		).toThrow(/aligned/);
	});

	it('Σ hourly metered amounts over a period = charge of the period total (property)', () => {
		fc.assert(
			fc.property(
				fc.array(fc.nat(10_000), { minLength: 1, maxLength: 30 }),
				fc.nat(50_000),
				fc.nat(100),
				fc.integer({ min: 1, max: 1000 }),
				(deltas, included, m, per) => {
					const rate = { millicredits: m, per };
					let before = 0;
					let sum = 0;
					deltas.forEach((delta, i) => {
						sum += planMeteredSettlement({
							usageByUnit: { u: { before, delta } },
							included: { u: included },
							overageRate: { u: rate },
							bucket: { subscriptionId: 's', bucketStart: at(i) },
						}).amount;
						before += delta;
					});
					const total = Math.max(0, before - included);
					expect(sum).toBe(Math.floor(total / per) * m + Math.floor(((total % per) * m) / per));
				},
			),
		);
	});
});

describe('reconcile', () => {
	it('detects missing, duplicate, extra and mismatched entries', () => {
		const expected = settle().buckets;
		const ledger = [
			{ periodKey: expected[0]?.periodKey ?? '', amount: expected[0]?.amount },
			{ periodKey: expected[0]?.periodKey ?? '', amount: expected[0]?.amount },
			{ periodKey: expected[1]?.periodKey ?? '', amount: 1 },
			expected[2]?.periodKey ?? '',
			'sub_1:2026-10-02T00:00:00Z',
		];
		expect(reconcile({ expectedBuckets: expected, ledgerKeys: ledger })).toEqual({
			missing: ['sub_1:2026-10-01T13:00:00Z', 'sub_1:2026-10-01T14:00:00Z'],
			duplicates: ['sub_1:2026-10-01T10:00:00Z'],
			extra: ['sub_1:2026-10-02T00:00:00Z'],
			mismatched: [{ periodKey: 'sub_1:2026-10-01T11:00:00Z', expected: 1600, actual: 1 }],
		});
		expect(reconcile({ expectedBuckets: ['a', 'b'], ledgerKeys: ['b', 'a'] })).toEqual({
			missing: [],
			duplicates: [],
			extra: [],
			mismatched: [],
		});
	});

	it('a complete ledger always reconciles clean (property)', () => {
		fc.assert(
			fc.property(fc.uniqueArray(fc.string(), { maxLength: 30 }), fc.array(fc.nat(), { maxLength: 30 }), (keys, order) => {
				const shuffled = [...keys].sort((a, b) => (order[keys.indexOf(a)] ?? 0) - (order[keys.indexOf(b)] ?? 0));
				expect(reconcile({ expectedBuckets: keys, ledgerKeys: shuffled })).toEqual({
					missing: [],
					duplicates: [],
					extra: [],
					mismatched: [],
				});
			}),
		);
	});
});

describe('balance helpers', () => {
	it('computes balances and hours remaining', () => {
		expect(balanceAfter({ balance: 10_000, charges: [1600, { amount: 400 }], credits: [{ amount: 5000 }] })).toBe(13_000);
		expect(balanceAfter({ balance: 100 })).toBe(100);
		expect(() => balanceAfter({ balance: 1.5 })).toThrow(RangeError);
		expect(() => balanceAfter({ balance: 1, charges: [-5] })).toThrow(RangeError);
		expect(hoursRemaining({ balance: 10_000, burnRatePerHour: 1600 })).toBe(6);
		expect(hoursRemaining({ balance: 0, burnRatePerHour: 1600 })).toBe(0);
		expect(hoursRemaining({ balance: -5, burnRatePerHour: 0 })).toBe(0);
		expect(hoursRemaining({ balance: 5, burnRatePerHour: 0 })).toBeNull();
	});

	it('projects the month', () => {
		expect(projectedMonth({ monthToDate: 20_000, burnRatePerHour: 1000, now: '2026-10-31T22:30:00Z' })).toEqual({
			monthToDate: 20_000,
			remainingHours: 2,
			projectedRemaining: 2000,
			projectedTotal: 22_000,
			periodStart: '2026-10-01T00:00:00Z',
			periodEnd: '2026-11-01T00:00:00Z',
		});
		const karachi = projectedMonth({
			monthToDate: 0,
			burnRatePerHour: 1,
			now: '2026-10-31T18:00:00Z',
			timeZone: 'Asia/Karachi',
		});
		expect(karachi).toMatchObject({ remainingHours: 1, periodEnd: '2026-10-31T19:00:00Z' });
	});
});
