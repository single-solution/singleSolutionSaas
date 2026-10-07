/**
 * Validity windows — ported from ibrahimMobiles `offerSchedule.test.ts` (store zone Asia/Karachi) and extended to any
 * zone (DST included), several windows and coupon-level zones.
 */
import { describe, expect, it } from 'vitest';
import { isActiveAt, parseClock, validityState, windowMatches, zoneOf } from '../core/schedule.js';
import { clockIn, isTimeZone, iso, toMs } from '../core/time.js';

const KARACHI = 'Asia/Karachi';
/** An instant from Karachi wall-clock time (PKT = UTC+5, no DST). @param {string} local */
const pkt = (local) => Date.parse(`${local}+05:00`);
/** @param {Record<string, any>} validity @param {number} at @param {string} [zone] */
const active = (validity, at, zone = KARACHI) => isActiveAt(validity, at, zone);
/** One window. @param {Record<string, any>} window */
const windows = (window) => ({ windows: [window] });

describe('time helpers', () => {
	it('reads wall clocks in a zone and validates zones', () => {
		expect(clockIn(Date.parse('2026-09-30T23:30:00Z'), KARACHI)).toEqual({ weekday: 4, minutes: 4 * 60 + 30 });
		expect(clockIn(Date.parse('2026-09-30T23:30:00Z'), 'Not/AZone')).toEqual({ weekday: 3, minutes: 23 * 60 + 30 });
		expect(isTimeZone('Europe/Berlin')).toBe(true);
		expect(isTimeZone('Nowhere/Land')).toBe(false);
		expect(isTimeZone('')).toBe(false);
		expect(isTimeZone(5)).toBe(false);
		expect(iso(0)).toBe('1970-01-01T00:00:00.000Z');
		expect(toMs(new Date(5))).toBe(5);
		expect(toMs(7)).toBe(7);
		expect(toMs({})).toBeNaN();
	});

	it('parses HH:MM clocks', () => {
		expect(parseClock('00:00')).toBe(0);
		expect(parseClock('23:59')).toBe(1439);
		expect(parseClock('24:00')).toBe(1440);
		expect(parseClock('24:30')).toBeNull();
		expect(parseClock('7:00')).toBeNull();
		expect(parseClock(undefined)).toBeNull();
	});
});

describe('validity dates', () => {
	it('is inclusive of the start and end instants', () => {
		const validity = { starts_at: '2026-09-01T00:00:00Z', ends_at: '2026-09-30T00:00:00Z' };
		expect(validityState(validity, Date.parse('2026-08-31T23:59:59Z'), 'UTC')).toBe('not_started');
		expect(active(validity, Date.parse('2026-09-01T00:00:00Z'))).toBe(true);
		expect(active(validity, Date.parse('2026-09-30T00:00:00Z'))).toBe(true);
		expect(validityState(validity, Date.parse('2026-09-30T00:00:01Z'), 'UTC')).toBe('ended');
	});

	it('an empty or missing validity is always active', () => {
		expect(active({}, Date.now())).toBe(true);
		expect(validityState(null, Date.now(), 'UTC')).toBe('active');
		expect(active({ starts_at: 'garbage' }, Date.now())).toBe(true);
	});
});

describe('weekday and time windows in the website zone', () => {
	it('uses the zone’s weekday, not the UTC one', () => {
		// 23:30 UTC Wednesday = 04:30 PKT Thursday
		const at = Date.parse('2026-09-30T23:30:00Z');
		expect(active(windows({ days: ['thu'] }), at)).toBe(true);
		expect(active(windows({ days: ['wed'] }), at)).toBe(false);
		expect(validityState(windows({ days: ['wed'] }), at, KARACHI)).toBe('outside_schedule');
	});

	it('uses the zone’s clock for daily windows (inclusive bounds)', () => {
		const window = windows({ start: '09:00', end: '17:00' });
		expect(active(window, pkt('2026-09-30T08:59:00'))).toBe(false);
		expect(active(window, pkt('2026-09-30T09:00:00'))).toBe(true);
		expect(active(window, pkt('2026-09-30T17:00:00'))).toBe(true);
		expect(active(window, pkt('2026-09-30T17:01:00'))).toBe(false);
		// 04:00 UTC is 09:00 PKT — would fail if evaluated in UTC
		expect(active(window, Date.parse('2026-09-30T04:00:00Z'))).toBe(true);
	});

	it('supports open-ended start-only / end-only windows', () => {
		expect(active(windows({ start: '20:00' }), pkt('2026-09-30T23:59:00'))).toBe(true);
		expect(active(windows({ start: '20:00' }), pkt('2026-09-30T19:59:00'))).toBe(false);
		expect(active(windows({ end: '06:00' }), pkt('2026-09-30T00:00:00'))).toBe(true);
		expect(active(windows({ end: '06:00' }), pkt('2026-09-30T06:01:00'))).toBe(false);
	});

	it('handles midnight correctly', () => {
		expect(active(windows({ start: '00:00', end: '00:30' }), pkt('2026-10-01T00:00:00'))).toBe(true);
	});

	it('follows daylight saving time through the runtime (no zone data of our own)', () => {
		// Europe/Berlin: 09:00 local is 07:00Z in summer (CEST) and 08:00Z in winter (CET)
		const window = windows({ start: '09:00', end: '09:30' });
		expect(active(window, Date.parse('2026-07-01T07:10:00Z'), 'Europe/Berlin')).toBe(true);
		expect(active(window, Date.parse('2026-12-01T07:10:00Z'), 'Europe/Berlin')).toBe(false);
		expect(active(window, Date.parse('2026-12-01T08:10:00Z'), 'Europe/Berlin')).toBe(true);
	});
});

describe('windows that wrap past midnight', () => {
	const lateNight = { start: '22:00', end: '02:00' };

	it('is active in both the evening and after-midnight parts', () => {
		expect(active(windows(lateNight), pkt('2026-09-30T22:00:00'))).toBe(true);
		expect(active(windows(lateNight), pkt('2026-09-30T23:59:00'))).toBe(true);
		expect(active(windows(lateNight), pkt('2026-10-01T00:00:00'))).toBe(true);
		expect(active(windows(lateNight), pkt('2026-10-01T02:00:00'))).toBe(true);
	});

	it('is inactive in the daytime gap', () => {
		expect(active(windows(lateNight), pkt('2026-10-01T02:01:00'))).toBe(false);
		expect(active(windows(lateNight), pkt('2026-09-30T12:00:00'))).toBe(false);
		expect(active(windows(lateNight), pkt('2026-09-30T21:59:00'))).toBe(false);
	});

	it('credits the after-midnight part to the day the window started', () => {
		const wednesdayNights = windows({ ...lateNight, days: ['wed'] });
		expect(active(wednesdayNights, pkt('2026-09-30T23:00:00'))).toBe(true);
		expect(active(wednesdayNights, pkt('2026-10-01T01:00:00'))).toBe(true);
		// Thursday 23:00 starts a Thursday window — not Wednesday's
		expect(active(wednesdayNights, pkt('2026-10-01T23:00:00'))).toBe(false);
		// Wednesday 01:00 belongs to Tuesday's window
		expect(active(wednesdayNights, pkt('2026-09-30T01:00:00'))).toBe(false);
	});

	it('wraps Saturday night into Sunday morning', () => {
		// 2026-10-03 is a Saturday
		expect(active(windows({ ...lateNight, days: ['sat'] }), pkt('2026-10-04T01:00:00'))).toBe(true);
	});
});

describe('several windows and zones', () => {
	it('matches any window', () => {
		const validity = {
			windows: [{ days: ['mon', 'tue'], start: '12:00', end: '14:00' }, { days: ['sat', 'sun'] }],
		};
		expect(active(validity, pkt('2026-10-05T13:00:00'))).toBe(true); // Monday lunch
		expect(active(validity, pkt('2026-10-05T15:00:00'))).toBe(false);
		expect(active(validity, pkt('2026-10-04T15:00:00'))).toBe(true); // Sunday
		expect(windowMatches({}, { weekday: 3, minutes: 0 })).toBe(true);
	});

	it('reads windows in the coupon’s own zone when it has one', () => {
		expect(zoneOf({ time_zone: 'America/New_York' }, KARACHI)).toBe('America/New_York');
		expect(zoneOf({ time_zone: 'Bad/Zone' }, KARACHI)).toBe(KARACHI);
		expect(zoneOf(null, 'Bad/Zone')).toBe('UTC');
		// 14:00Z = 10:00 in New York (EDT), 19:00 in Karachi
		const validity = { time_zone: 'America/New_York', windows: [{ start: '09:00', end: '11:00' }] };
		expect(active(validity, Date.parse('2026-10-01T14:00:00Z'))).toBe(true);
	});
});
