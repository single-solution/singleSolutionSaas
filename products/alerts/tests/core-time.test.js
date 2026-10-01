import { describe, expect, it } from 'vitest';
import {
	DAY_MS,
	dayKey,
	fromLocal,
	isTimeZone,
	iso,
	localParts,
	nextDayStart,
	nextWeekStart,
	parseClock,
	quietHours,
	toMs,
	weekKey,
	zoneOr,
} from '../core/time.js';

describe('time', () => {
	it('knows zones and falls back to UTC', () => {
		expect(isTimeZone('Asia/Karachi')).toBe(true);
		expect(isTimeZone('Mars/Base')).toBe(false);
		expect(isTimeZone('')).toBe(false);
		expect(isTimeZone(3)).toBe(false);
		expect(zoneOr('Nope/Zone')).toBe('UTC');
		expect(zoneOr('Europe/Berlin')).toBe('Europe/Berlin');
		expect(localParts(Date.parse('2026-10-01T23:30:00Z'), 'Bad/Zone')).toMatchObject({ day: 1, hour: 23 });
	});

	it('converts local wall-clock time to instants (DST aware)', () => {
		expect(iso(fromLocal({ year: 2026, month: 7, day: 1, hour: 9 }, 'Europe/Berlin'))).toBe('2026-07-01T07:00:00.000Z');
		expect(iso(fromLocal({ year: 2026, month: 1, day: 1, hour: 9 }, 'Europe/Berlin'))).toBe('2026-01-01T08:00:00.000Z');
		expect(iso(fromLocal({ year: 2026, month: 1, day: 32 }, 'UTC'))).toBe('2026-02-01T00:00:00.000Z');
	});

	it('parses clocks', () => {
		expect(parseClock('08:30')).toBe(510);
		expect(parseClock('24:00')).toBeNull();
		expect(parseClock(830)).toBeNull();
	});

	it('keys local days and ISO weeks', () => {
		const ms = Date.parse('2026-10-01T22:30:00Z');
		expect(dayKey(ms, 'UTC')).toBe('2026-10-01');
		expect(dayKey(ms, 'Asia/Karachi')).toBe('2026-10-02');
		expect(weekKey(Date.parse('2026-01-01T12:00:00Z'), 'UTC')).toBe('2026-W01');
		expect(weekKey(Date.parse('2027-01-01T12:00:00Z'), 'UTC')).toBe('2026-W53');
		expect(iso(nextDayStart(ms, 'UTC'))).toBe('2026-10-02T00:00:00.000Z');
		expect(iso(nextDayStart(ms, 'Asia/Karachi'))).toBe('2026-10-02T19:00:00.000Z');
		// 2026-10-01 is a Thursday → next Monday 2026-10-05
		expect(iso(nextWeekStart(ms, 'UTC'))).toBe('2026-10-05T00:00:00.000Z');
		expect(iso(nextWeekStart(Date.parse('2026-10-05T10:00:00Z'), 'UTC'))).toBe('2026-10-12T00:00:00.000Z');
	});

	it('detects quiet hours, overnight windows included', () => {
		const night = { start: '21:00', end: '08:00', timeZone: 'UTC' };
		expect(quietHours(Date.parse('2026-10-01T22:00:00Z'), night)).toEqual({
			quiet: true,
			endsAt: Date.parse('2026-10-02T08:00:00Z'),
		});
		expect(quietHours(Date.parse('2026-10-01T03:00:00Z'), night)).toEqual({
			quiet: true,
			endsAt: Date.parse('2026-10-01T08:00:00Z'),
		});
		expect(quietHours(Date.parse('2026-10-01T12:00:00Z'), night)).toEqual({ quiet: false });
		const lunch = { start: '12:00', end: '13:00', timeZone: 'Europe/Berlin' };
		expect(quietHours(Date.parse('2026-07-01T10:30:00Z'), lunch)).toEqual({
			quiet: true,
			endsAt: Date.parse('2026-07-01T11:00:00Z'),
		});
		expect(quietHours(Date.parse('2026-07-01T09:30:00Z'), lunch)).toEqual({ quiet: false });
		expect(quietHours(0, { start: '10:00', end: '10:00', timeZone: 'UTC' })).toEqual({ quiet: false });
		expect(quietHours(0, { start: 'x', end: '10:00', timeZone: 'UTC' })).toEqual({ quiet: false });
	});

	it('reads instants', () => {
		expect(toMs(5)).toBe(5);
		expect(toMs(new Date(DAY_MS))).toBe(DAY_MS);
		expect(toMs('1970-01-02T00:00:00Z')).toBe(DAY_MS);
		expect(toMs(null)).toBeNaN();
	});
});
