import { describe, expect, it } from 'vitest';
import {
	addMonths,
	dayKey,
	fromLocal,
	isTimeZone,
	localParts,
	monthKey,
	periodKey,
	recentMonthKeys,
	toMs,
	zoneOffset,
} from '../core/time.js';

const at = (/** @type {any} */ iso) => Date.parse(iso);

describe('core/time', () => {
	it('adds UTC calendar months clamped to the last day (ported from ibrahimMobiles addLoyaltyMonths)', () => {
		expect(new Date(addMonths(at('2026-01-31T10:00:00Z'), 1)).toISOString()).toBe('2026-02-28T10:00:00.000Z');
		expect(new Date(addMonths(at('2027-11-15T00:00:00Z'), 3)).toISOString()).toBe('2028-02-15T00:00:00.000Z');
		expect(new Date(addMonths(at('2026-03-31T00:00:00Z'), -1)).toISOString()).toBe('2026-02-28T00:00:00.000Z');
		expect(new Date(addMonths(at('2028-01-31T00:00:00Z'), 1)).toISOString()).toBe('2028-02-29T00:00:00.000Z');
		expect(new Date(addMonths(at('2026-05-15T08:30:00.123Z'), -17)).toISOString()).toBe('2024-12-15T08:30:00.123Z');
	});

	it('reads local calendars of zones on both sides of UTC', () => {
		const instant = at('2026-10-31T22:30:00Z');
		expect(dayKey(instant, 'UTC')).toBe('2026-10-31');
		expect(dayKey(instant, 'Asia/Karachi')).toBe('2026-11-01'); // UTC+5
		expect(dayKey(instant, 'America/Los_Angeles')).toBe('2026-10-31');
		expect(monthKey(instant, 'Asia/Karachi')).toBe('2026-11');
		expect(monthKey(instant, 'Pacific/Kiritimati')).toBe('2026-11'); // UTC+14
		expect(dayKey(at('2026-01-01T09:00:00Z'), 'Pacific/Pago_Pago')).toBe('2025-12-31'); // UTC−11
	});

	it('computes cap period keys (day, ISO week, month, year) in the website zone', () => {
		const instant = at('2026-12-31T20:00:00Z');
		expect(periodKey(instant, 'day', 'UTC')).toBe('2026-12-31');
		expect(periodKey(instant, 'day', 'Asia/Tokyo')).toBe('2027-01-01');
		expect(periodKey(instant, 'month', 'Asia/Tokyo')).toBe('2027-01');
		expect(periodKey(instant, 'year', 'Asia/Tokyo')).toBe('2027');
		expect(periodKey(instant, 'year', 'UTC')).toBe('2026');
		// 2026-12-31 is a Thursday → ISO week 53 of 2026; 2027-01-01 (Friday) still belongs to 2026-W53
		expect(periodKey(instant, 'week', 'UTC')).toBe('2026-W53');
		expect(periodKey(instant, 'week', 'Asia/Tokyo')).toBe('2026-W53');
		expect(periodKey(at('2027-01-04T00:00:00Z'), 'week', 'UTC')).toBe('2027-W01');
	});

	it('lists recent month keys across year boundaries', () => {
		expect(recentMonthKeys(at('2026-02-10T00:00:00Z'), 4, 'UTC')).toEqual(['2026-02', '2026-01', '2025-12', '2025-11']);
		expect(recentMonthKeys(at('2026-02-28T23:30:00Z'), 1, 'Asia/Karachi')).toEqual(['2026-03']);
	});

	it('converts local wall-clock times to instants, including DST changes', () => {
		expect(new Date(fromLocal({ year: 2026, month: 10, day: 1 }, 'Asia/Karachi')).toISOString()).toBe(
			'2026-09-30T19:00:00.000Z',
		);
		expect(new Date(fromLocal({ year: 2026, month: 3, day: 8, hour: 12 }, 'America/New_York')).toISOString()).toBe(
			'2026-03-08T16:00:00.000Z',
		);
		expect(zoneOffset(at('2026-07-01T00:00:00Z'), 'Europe/London')).toBe(3_600_000);
		expect(zoneOffset(at('2026-01-01T00:00:00Z'), 'Europe/London')).toBe(0);
	});

	it('validates zones and falls back to UTC for unknown ones', () => {
		expect(isTimeZone('Asia/Karachi')).toBe(true);
		expect(isTimeZone('Mars/Olympus')).toBe(false);
		expect(isTimeZone('')).toBe(false);
		expect(isTimeZone(5)).toBe(false);
		expect(localParts(at('2026-10-01T10:00:00Z'), 'Mars/Olympus')).toMatchObject({ year: 2026, month: 10, day: 1, hour: 10 });
	});

	it('parses instants leniently', () => {
		expect(toMs(5)).toBe(5);
		expect(toMs(new Date(7))).toBe(7);
		expect(toMs('1970-01-01T00:00:01Z')).toBe(1000);
		expect(Number.isNaN(toMs(null))).toBe(true);
	});
});
