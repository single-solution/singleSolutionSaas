import { describe, expect, it } from 'vitest';
import { isScheduleActive, scheduleState, scheduleZone, validateSchedule, windowInstances } from '../core/schedule.js';
import { addDays, clockMinutes, isTimeZone, localParts, parseInstant, zoneOffset, zonedToUtc } from '../core/time.js';

const weekdayEvenings = { windows: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '18:00', end: '02:00' }] };
const at = (/** @type {string} */ iso) => Date.parse(iso);

describe('time zone maths', () => {
	it('knows zones, local parts, offsets and local → UTC conversion (DST included)', () => {
		expect(isTimeZone('Asia/Karachi')).toBe(true);
		expect(isTimeZone('Mars/Base')).toBe(false);
		expect(isTimeZone(5)).toBe(false);
		expect(localParts(at('2026-10-02T17:30:00Z'), 'Europe/Berlin')).toMatchObject({ day: 2, hour: 19, minute: 30 });
		expect(localParts(at('2026-10-02T17:30:00Z'), 'Mars/Base')).toMatchObject({ hour: 17 });
		expect(zoneOffset(at('2026-07-01T00:00:00Z'), 'Europe/Berlin')).toBe(2 * 3_600_000);
		expect(zoneOffset(at('2026-01-01T00:00:00Z'), 'Europe/Berlin')).toBe(3_600_000);
		expect(zonedToUtc({ year: 2026, month: 10, day: 2, hour: 18 }, 'Europe/Berlin')).toBe(at('2026-10-02T16:00:00Z'));
		expect(zonedToUtc({ year: 2026, month: 10, day: 2, hour: 18 }, 'America/New_York')).toBe(at('2026-10-02T22:00:00Z'));
		// 02:30 does not exist on 29 March 2026 in Berlin: it resolves forward
		expect(zonedToUtc({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, 'Europe/Berlin')).toBe(
			at('2026-03-29T00:30:00Z'),
		);
		expect(addDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({ year: 2027, month: 1, day: 1, weekday: 5 });
		expect(clockMinutes('18:30')).toBe(1110);
		expect(clockMinutes('24:00')).toBe(1440);
		expect(clockMinutes('24:01')).toBeNull();
		expect(clockMinutes('7:00')).toBeNull();
		expect(clockMinutes(null)).toBeNull();
		expect(parseInstant('2026-10-02T18:00:00+02:00')).toBe(at('2026-10-02T16:00:00Z'));
		expect(parseInstant('2026-10-02')).toBeNull();
		expect(parseInstant('2026-13-40T00:00:00Z')).toBeNull();
	});
});

describe('weekday and overnight windows', () => {
	it('evaluates an overnight window in the deal zone; the after-midnight part belongs to the start day', () => {
		const berlin = { ...weekdayEvenings, timeZone: 'Europe/Berlin' };
		expect(isScheduleActive(berlin, at('2026-10-02T15:59:00Z'))).toBe(false); // Fri 17:59
		expect(isScheduleActive(berlin, at('2026-10-02T16:00:00Z'))).toBe(true); // Fri 18:00
		expect(isScheduleActive(berlin, at('2026-10-02T23:59:00Z'))).toBe(true); // Sat 01:59 (Friday's window)
		expect(isScheduleActive(berlin, at('2026-10-03T00:00:00Z'))).toBe(false); // Sat 02:00 (end is exclusive)
		expect(isScheduleActive(berlin, at('2026-10-03T17:00:00Z'))).toBe(false); // Sat 19:00 (no Saturday window)
		expect(isScheduleActive(berlin, at('2026-10-04T23:30:00Z'))).toBe(false); // Mon 01:30 — Sunday had no window
		expect(isScheduleActive(berlin, at('2026-10-05T23:30:00Z'))).toBe(true); // Tue 01:30 — Monday's window
		// the same schedule in the website's zone when the deal has none
		expect(isScheduleActive(weekdayEvenings, at('2026-10-02T16:30:00Z'), 'Asia/Karachi')).toBe(true); // Fri 21:30 PKT
		expect(isScheduleActive(weekdayEvenings, at('2026-10-02T16:30:00Z'), 'America/New_York')).toBe(false); // Fri 12:30
		expect(scheduleZone({ timeZone: 'Nope/Zone' }, 'Nope')).toBe('UTC');
	});

	it('reports when the activity ends (chained windows) and when it starts next', () => {
		const berlin = { ...weekdayEvenings, timeZone: 'Europe/Berlin' };
		const live = scheduleState(berlin, at('2026-10-02T17:00:00Z'));
		expect(live).toMatchObject({
			active: true,
			phase: 'active',
			activeUntil: at('2026-10-03T00:00:00Z'),
			timeZone: 'Europe/Berlin',
		});
		const off = scheduleState(berlin, at('2026-10-03T12:00:00Z')); // Saturday
		expect(off).toMatchObject({ active: false, phase: 'outside_window', nextStart: at('2026-10-05T16:00:00Z') }); // Monday 18:00
		// back-to-back windows chain into one activity
		const chained = scheduleState(
			{
				windows: [
					{ start: '22:00', end: '00:00' },
					{ start: '00:00', end: '06:00' },
				],
			},
			at('2026-10-02T23:00:00Z'),
		);
		expect(chained.activeUntil).toBe(at('2026-10-03T06:00:00Z'));
		// a full-day window (start == end)
		expect(isScheduleActive({ windows: [{ days: ['sat'], start: '00:00', end: '00:00' }] }, at('2026-10-03T23:59:00Z'))).toBe(
			true,
		);
		// windows with invalid times are ignored
		expect(windowInstances([{ start: 'x', end: '01:00' }], at('2026-10-02T00:00:00Z'), 'UTC', 0, 1)).toEqual([]);
	});

	it('combines windows with a date range', () => {
		const range = { startsAt: '2026-10-05T00:00:00Z', endsAt: '2026-10-10T00:00:00Z' };
		expect(scheduleState(range, at('2026-10-01T00:00:00Z'))).toMatchObject({
			phase: 'scheduled',
			nextStart: at('2026-10-05T00:00:00Z'),
		});
		expect(scheduleState(range, at('2026-10-06T00:00:00Z'))).toMatchObject({
			active: true,
			activeUntil: at('2026-10-10T00:00:00Z'),
		});
		expect(scheduleState(range, at('2026-10-10T00:00:00Z'))).toMatchObject({ phase: 'ended', active: false });
		const both = { ...range, windows: [{ start: '09:00', end: '17:00' }] };
		expect(scheduleState(both, at('2026-10-01T12:00:00Z'))).toMatchObject({
			phase: 'scheduled',
			nextStart: at('2026-10-05T09:00:00Z'),
		});
		expect(scheduleState(both, at('2026-10-09T16:00:00Z')).activeUntil).toBe(at('2026-10-09T17:00:00Z'));
		// a range that starts mid-window activates at its start
		const mid = { startsAt: '2026-10-05T12:00:00Z', windows: [{ start: '09:00', end: '17:00' }] };
		expect(scheduleState(mid, at('2026-10-05T10:00:00Z')).nextStart).toBe(at('2026-10-05T12:00:00Z'));
		// a window after the end never starts
		const ending = { endsAt: '2026-10-02T20:00:00Z', windows: [{ start: '21:00', end: '23:00' }] };
		expect(scheduleState(ending, at('2026-10-02T19:00:00Z')).nextStart).toBeNull();
		expect(scheduleState(null, 0)).toMatchObject({ active: true, activeUntil: null });
	});

	it('validates schedules', () => {
		expect(validateSchedule(undefined, { maxWindows: 7 })).toEqual([]);
		expect(validateSchedule([], { maxWindows: 7 })).toEqual([{ path: '', code: 'object_invalid' }]);
		const codes = validateSchedule(
			{
				startsAt: 'yesterday',
				endsAt: '2026-10-01T00:00:00Z',
				timeZone: 'X/Y',
				windows: [{ start: '24:00', end: '25:00', days: ['mon', 'mon'], extra: 1 }, 5],
				other: 1,
			},
			{ maxWindows: 1 },
		).map((p) => `${p.path}:${p.code}`);
		expect(codes).toEqual([
			'/other:unknown_field',
			'/startsAt:instant_invalid',
			'/timeZone:time_zone_invalid',
			'/windows:too_many',
			'/windows/0/extra:unknown_field',
			'/windows/0/start:time_invalid',
			'/windows/0/end:time_invalid',
			'/windows/0/days:days_invalid',
			'/windows/1:object_invalid',
		]);
		expect(validateSchedule({ startsAt: '2026-10-02T00:00:00Z', endsAt: '2026-10-01T00:00:00Z' }, { maxWindows: 1 })).toEqual([
			{ path: '/endsAt', code: 'range_invalid' },
		]);
		expect(
			validateSchedule(
				{ startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-10-09T00:00:00Z' },
				{ maxWindows: 1, maxDurationDays: 7 },
			),
		).toEqual([{ path: '/endsAt', code: 'duration_exceeded' }]);
		expect(validateSchedule({ windows: 'x' }, { maxWindows: 1 })).toEqual([{ path: '/windows', code: 'array_invalid' }]);
	});
});
