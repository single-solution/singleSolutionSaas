import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { overageCharge, periodBounds, quotaAllows, quotaState, wallToInstant, zoneOffset } from '../src/quotas.js';

const H = 3_600_000;
const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();

/**
 * @param {import('../src/catalog.js').PeriodUnit} unit
 * @param {string} timeZone
 * @param {string} at
 */
const bounds = (unit, timeZone, at) => {
	const b = periodBounds({ unit, timeZone, at });
	return { start: iso(b.start), end: iso(b.end), hours: (b.end - b.start) / H, key: b.key };
};

describe('periodBounds across DST and month boundaries', () => {
	it.each([
		// America/New_York: spring forward 2026-03-08, fall back 2026-11-01.
		[
			'day',
			'America/New_York',
			'2026-03-08T12:00:00Z',
			'2026-03-08T05:00:00.000Z',
			'2026-03-09T04:00:00.000Z',
			23,
			'day:2026-03-08',
		],
		[
			'day',
			'America/New_York',
			'2026-11-01T12:00:00Z',
			'2026-11-01T04:00:00.000Z',
			'2026-11-02T05:00:00.000Z',
			25,
			'day:2026-11-01',
		],
		[
			'hour',
			'America/New_York',
			'2026-11-01T05:30:00Z',
			'2026-11-01T05:00:00.000Z',
			'2026-11-01T06:00:00.000Z',
			1,
			'hour:2026-11-01T01:00-04:00',
		],
		[
			'hour',
			'America/New_York',
			'2026-11-01T06:30:00Z',
			'2026-11-01T06:00:00.000Z',
			'2026-11-01T07:00:00.000Z',
			1,
			'hour:2026-11-01T01:00-05:00',
		],
		[
			'month',
			'America/New_York',
			'2026-03-15T00:00:00Z',
			'2026-03-01T05:00:00.000Z',
			'2026-04-01T04:00:00.000Z',
			743,
			'month:2026-03',
		],
		// Europe/Berlin: DST starts 2026-03-29 (week containing it is 167 h).
		[
			'week',
			'Europe/Berlin',
			'2026-03-29T12:00:00Z',
			'2026-03-22T23:00:00.000Z',
			'2026-03-29T22:00:00.000Z',
			167,
			'week:2026-03-23',
		],
		[
			'month',
			'Europe/Berlin',
			'2026-10-31T23:30:00Z',
			'2026-10-31T23:00:00.000Z',
			'2026-11-30T23:00:00.000Z',
			720,
			'month:2026-11',
		],
		// Asia/Kolkata (+05:30, no DST): hours start at :30 UTC.
		[
			'hour',
			'Asia/Kolkata',
			'2026-11-01T06:10:00Z',
			'2026-11-01T05:30:00.000Z',
			'2026-11-01T06:30:00.000Z',
			1,
			'hour:2026-11-01T11:00+05:30',
		],
		[
			'day',
			'Asia/Kolkata',
			'2026-12-31T20:00:00Z',
			'2026-12-31T18:30:00.000Z',
			'2027-01-01T18:30:00.000Z',
			24,
			'day:2027-01-01',
		],
		// Asia/Karachi month boundary.
		[
			'month',
			'Asia/Karachi',
			'2026-10-31T20:00:00Z',
			'2026-10-31T19:00:00.000Z',
			'2026-11-30T19:00:00.000Z',
			720,
			'month:2026-11',
		],
		// Australia/Sydney: southern-hemisphere DST ends 2026-04-05, starts 2026-10-04.
		[
			'day',
			'Australia/Sydney',
			'2026-04-05T05:00:00Z',
			'2026-04-04T13:00:00.000Z',
			'2026-04-05T14:00:00.000Z',
			25,
			'day:2026-04-05',
		],
		[
			'day',
			'Australia/Sydney',
			'2026-10-04T05:00:00Z',
			'2026-10-03T14:00:00.000Z',
			'2026-10-04T13:00:00.000Z',
			23,
			'day:2026-10-04',
		],
		// America/Santiago: midnight is skipped on 2026-09-06 → day starts at 01:00 local.
		[
			'day',
			'America/Santiago',
			'2026-09-06T12:00:00Z',
			'2026-09-06T04:00:00.000Z',
			'2026-09-07T03:00:00.000Z',
			23,
			'day:2026-09-06',
		],
		// Australia/Lord_Howe: 30-minute DST shifts give 30-minute hour periods.
		[
			'hour',
			'Australia/Lord_Howe',
			'2026-10-03T15:45:00Z',
			'2026-10-03T15:30:00.000Z',
			'2026-10-03T16:00:00.000Z',
			0.5,
			'hour:2026-10-04T02:30+11:00',
		],
		[
			'hour',
			'Australia/Lord_Howe',
			'2026-04-04T14:30:00Z',
			'2026-04-04T14:00:00.000Z',
			'2026-04-04T15:00:00.000Z',
			1,
			'hour:2026-04-05T01:00+11:00',
		],
		[
			'hour',
			'Australia/Lord_Howe',
			'2026-04-04T15:10:00Z',
			'2026-04-04T15:00:00.000Z',
			'2026-04-04T15:30:00.000Z',
			0.5,
			'hour:2026-04-05T01:30+10:30',
		],
		// America/Caracas 2016-05-01: offset changed at 02:30 local (−04:30 → −04:00), mid-hour.
		[
			'hour',
			'America/Caracas',
			'2016-05-01T06:45:00Z',
			'2016-05-01T06:30:00.000Z',
			'2016-05-01T07:00:00.000Z',
			0.5,
			'hour:2016-05-01T02:00-04:30',
		],
		[
			'hour',
			'America/Caracas',
			'2016-05-01T07:10:00Z',
			'2016-05-01T07:00:00.000Z',
			'2016-05-01T08:00:00.000Z',
			1,
			'hour:2016-05-01T03:00-04:00',
		],
		// UTC year end.
		['month', 'UTC', '2026-12-31T23:59:59.999Z', '2026-12-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 744, 'month:2026-12'],
		['week', 'UTC', '2027-01-01T00:00:00Z', '2026-12-28T00:00:00.000Z', '2027-01-04T00:00:00.000Z', 168, 'week:2026-12-28'],
	])('%s in %s at %s', (unit, tz, at, start, end, hours, key) => {
		expect(bounds(/** @type {never} */ (unit), tz, at)).toEqual({ start, end, hours, key });
	});

	it('defaults to UTC and rejects unknown units and zones', () => {
		expect(periodBounds({ unit: 'day', at: '2026-10-01T12:00:00Z' }).key).toBe('day:2026-10-01');
		expect(() => periodBounds({ unit: /** @type {never} */ ('year'), at: 0 })).toThrow(RangeError);
		expect(() => periodBounds({ unit: 'day', timeZone: 'Mars/Olympus', at: 0 })).toThrow(RangeError);
	});

	it('resolves wall times in gaps and overlaps', () => {
		// 02:30 on 2026-03-08 does not exist in New York → first instant after the gap (07:00Z).
		expect(iso(wallToInstant(Date.UTC(2026, 2, 8, 2, 30), 'America/New_York'))).toBe('2026-03-08T07:00:00.000Z');
		// 01:30 on 2026-11-01 happens twice → earliest (EDT).
		expect(iso(wallToInstant(Date.UTC(2026, 10, 1, 1, 30), 'America/New_York'))).toBe('2026-11-01T05:30:00.000Z');
		expect(zoneOffset(Date.UTC(2026, 0, 1), 'Asia/Kathmandu')).toBe(5.75 * H);
	});

	const zones = [
		'UTC',
		'America/New_York',
		'Europe/Berlin',
		'Asia/Kolkata',
		'Australia/Sydney',
		'Australia/Lord_Howe',
		'America/Santiago',
		'Pacific/Chatham',
	];
	it('periods partition time: contain the instant, are stable at both edges and contiguous (property)', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: Date.UTC(2025, 0, 1), max: Date.UTC(2028, 0, 1) }),
				fc.constantFrom(...zones),
				fc.constantFrom(/** @type {const} */ ('hour'), 'day', 'week', 'month'),
				(t, timeZone, unit) => {
					const b = periodBounds({ unit, timeZone, at: t });
					expect(b.start).toBeLessThanOrEqual(t);
					expect(t).toBeLessThan(b.end);
					expect(periodBounds({ unit, timeZone, at: b.start })).toEqual(b);
					expect(periodBounds({ unit, timeZone, at: b.end - 1 }).start).toBe(b.start);
					expect(periodBounds({ unit, timeZone, at: b.end }).start).toBe(b.end);
					expect(periodBounds({ unit, timeZone, at: b.start - 1 }).end).toBe(b.start);
				},
			),
			{ numRuns: 400 },
		);
	});
});

describe('quotaState', () => {
	const now = '2026-10-15T12:00:00Z';
	const counters = [
		{ at: '2026-09-30T23:59:59Z', quantity: 1000 },
		{ at: '2026-10-01T00:00:00Z', quantity: 40 },
		{ at: '2026-10-15T11:00:00Z', quantity: 70 },
		{ at: '2026-11-01T00:00:00Z', quantity: 1000 },
	];

	it('sums counters inside the period and reports overage and hard stop', () => {
		const state = quotaState({ feature: { value: 100, hardStop: true, period: 'month' }, counters, now });
		expect(state).toMatchObject({
			used: 110,
			included: 100,
			remaining: 0,
			overage: 10,
			exhausted: true,
			blocked: true,
			hardStop: true,
		});
		expect(state.period.key).toBe('month:2026-10');
		expect(quotaAllows(state, 1)).toBe(false);
	});

	it('soft quotas never block', () => {
		const state = quotaState({ feature: { included: 100, hardStop: false }, counters, now });
		expect(state).toMatchObject({ used: 110, blocked: false, exhausted: true, overage: 10 });
		expect(quotaAllows(state, 1000)).toBe(true);
	});

	it('handles unlimited and pre-aggregated counters', () => {
		expect(quotaState({ feature: { value: null }, counters: 1e6, now })).toMatchObject({
			remaining: null,
			overage: 0,
			blocked: false,
			included: null,
		});
		expect(quotaState({ feature: {}, counters: 3, now })).toMatchObject({ included: null, used: 3 });
		const fresh = quotaState({ feature: { value: 100 }, counters: 30, now });
		expect(fresh).toMatchObject({ remaining: 70, blocked: false });
		expect(quotaAllows(fresh, 70)).toBe(true);
		expect(quotaAllows(fresh, 71)).toBe(false);
	});

	it('uses the period time zone', () => {
		// 2026-10-31T20:00Z is already November in Karachi (+05).
		const state = quotaState({
			feature: { value: 10, period: 'month' },
			counters: [{ at: '2026-10-31T20:00:00Z', quantity: 5 }],
			period: { timeZone: 'Asia/Karachi' },
			now: '2026-11-02T00:00:00Z',
		});
		expect(state.used).toBe(5);
		const utc = quotaState({
			feature: { value: 10, period: 'month' },
			counters: [{ at: '2026-10-31T20:00:00Z', quantity: 5 }],
			now: '2026-11-02T00:00:00Z',
		});
		expect(utc.used).toBe(0);
		expect(
			quotaState({ feature: { value: 10, period: 'month' }, counters: [], period: { unit: 'day' }, now }).period.unit,
		).toBe('day');
	});

	it('rejects invalid counters', () => {
		expect(() => quotaState({ feature: { value: 1 }, counters: [{ at: now, quantity: -1 }], now })).toThrow(RangeError);
	});
});

describe('overage charges', () => {
	it('charges units above included, rounded down', () => {
		expect(overageCharge({ used: 610, included: 500, rate: 0.01 })).toBe(1100);
		expect(overageCharge({ used: 400, included: 500, rate: 0.01 })).toBe(0);
		expect(overageCharge({ used: 400, included: null, rate: 0.01 })).toBe(0);
		expect(overageCharge({ used: 350, included: 0, rate: { millicredits: 1, per: 100 } })).toBe(3);
	});
});
