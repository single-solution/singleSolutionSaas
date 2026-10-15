/**
 * Office hours (C9): a weekly hours list by ISO weekday number (1 = Monday … 7 = Sunday) with minutes, and dated
 * exceptions (holidays, special hours) that replace a day's hours; no weekday names anywhere in the logic.
 */
import { describe, expect, it } from 'vitest';
import { checkOfficeExceptions, checkOfficeHours, officeState } from '../core/handoff.js';
import { isOpenAt, nextOpenAt } from '../core/time.js';

describe('office hours (C9)', () => {
	it('checks the weekly hours: ISO weekday numbers, HH:MM with minutes, 24:00 as the end of a day', () => {
		expect(
			checkOfficeHours([
				{ day: 1, start: '09:30', end: '17:45' },
				{ day: 7, start: '22:00', end: '02:00' },
				{ day: 6, start: '00:00', end: '24:00' },
			]),
		).toEqual({
			ok: true,
			value: [
				{ day: 1, start: '09:30', end: '17:45' },
				{ day: 7, start: '22:00', end: '02:00' },
				{ day: 6, start: '00:00', end: '24:00' },
			],
		});
		expect(checkOfficeHours([{ day: 'mon', start: '09:00', end: '17:00' }]).ok).toBe(false);
		expect(checkOfficeHours([{ day: 0, start: '09:00', end: '17:00' }]).ok).toBe(false);
		expect(checkOfficeHours([{ day: 8, start: '09:00', end: '17:00' }]).ok).toBe(false);
		expect(checkOfficeHours([{ day: 1, start: '9:00', end: '17:00' }]).ok).toBe(false);
		expect(checkOfficeHours([{ day: 1, start: '09:00', end: '24:30' }]).ok).toBe(false);
		expect(checkOfficeHours('mon-fri 09:00-17:00').ok).toBe(false);
	});

	it('checks dated exceptions: a real date, a name, and hours (none = closed all day), one per date', () => {
		expect(
			checkOfficeExceptions([
				{ date: '2026-12-25', name: 'Holiday', hours: [] },
				{ date: '2026-12-24', name: ' Short day ', hours: [{ start: '09:00', end: '12:30' }] },
			]),
		).toEqual({
			ok: true,
			value: [
				{ date: '2026-12-25', name: 'Holiday', hours: [] },
				{ date: '2026-12-24', name: 'Short day', hours: [{ start: '09:00', end: '12:30' }] },
			],
		});
		expect(checkOfficeExceptions([{ date: '2026-02-30', name: 'x', hours: [] }]).ok).toBe(false);
		expect(
			checkOfficeExceptions([
				{ date: '2026-12-25', name: 'a', hours: [] },
				{ date: '2026-12-25', name: 'b', hours: [] },
			]).ok,
		).toBe(false);
		expect(checkOfficeExceptions([{ date: '2026-12-25', name: 'a', hours: [{ start: '10:00', end: 'late' }] }]).ok).toBe(false);
	});

	it('is open inside the weekly windows, with minutes and overnight windows on their start day', () => {
		// 2026-10-05 is a Monday
		const weekly = [
			{ day: 1, start: '09:30', end: '17:45' },
			{ day: 7, start: '22:00', end: '02:00' },
		];
		const hours = { weekly, exceptions: [] };
		expect(isOpenAt(hours, Date.parse('2026-10-05T09:29:00Z'), 'UTC')).toBe(false);
		expect(isOpenAt(hours, Date.parse('2026-10-05T09:30:00Z'), 'UTC')).toBe(true);
		expect(isOpenAt(hours, Date.parse('2026-10-05T17:44:00Z'), 'UTC')).toBe(true);
		expect(isOpenAt(hours, Date.parse('2026-10-05T17:45:00Z'), 'UTC')).toBe(false);
		// Sunday 23:00 and Monday 01:00 belong to Sunday's overnight window
		expect(isOpenAt(hours, Date.parse('2026-10-04T23:00:00Z'), 'UTC')).toBe(true);
		expect(isOpenAt(hours, Date.parse('2026-10-05T01:00:00Z'), 'UTC')).toBe(true);
		expect(isOpenAt(hours, Date.parse('2026-10-05T02:00:00Z'), 'UTC')).toBe(false);
		// no hours at all: always open
		expect(isOpenAt({ weekly: [], exceptions: [] }, Date.parse('2026-10-05T03:00:00Z'), 'UTC')).toBe(true);
		// in the business time zone: 09:30 in Tokyo is 00:30 UTC
		expect(isOpenAt(hours, Date.parse('2026-10-05T00:30:00Z'), 'Asia/Tokyo')).toBe(true);
	});

	it('a dated exception replaces that day: closed all day, or its own hours', () => {
		const weekly = [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '17:00' }));
		const hours = {
			weekly,
			exceptions: [
				{ date: '2026-10-05', name: 'Holiday', hours: [] },
				{ date: '2026-10-06', name: 'Short day', hours: [{ start: '10:00', end: '12:00' }] },
				{ date: '2026-10-10', name: 'Open Saturday', hours: [{ start: '11:00', end: '13:00' }] },
			],
		};
		expect(isOpenAt(hours, Date.parse('2026-10-05T10:00:00Z'), 'UTC')).toBe(false);
		expect(isOpenAt(hours, Date.parse('2026-10-06T09:30:00Z'), 'UTC')).toBe(false);
		expect(isOpenAt(hours, Date.parse('2026-10-06T11:00:00Z'), 'UTC')).toBe(true);
		expect(isOpenAt(hours, Date.parse('2026-10-06T13:00:00Z'), 'UTC')).toBe(false);
		expect(isOpenAt(hours, Date.parse('2026-10-10T12:00:00Z'), 'UTC')).toBe(true);
		// the holiday Monday: back on Tuesday at the short day's opening
		expect(officeState(hours, Date.parse('2026-10-05T10:00:00Z'), 'UTC')).toEqual({
			open: false,
			backAt: Date.parse('2026-10-06T10:00:00Z'),
		});
		// a holiday on a website open every day (no weekly hours): only that day is closed
		const always = { weekly: [], exceptions: [{ date: '2026-10-05', name: 'Holiday', hours: [] }] };
		expect(isOpenAt(always, Date.parse('2026-10-05T10:00:00Z'), 'UTC')).toBe(false);
		expect(nextOpenAt(always, Date.parse('2026-10-05T10:00:00Z'), 'UTC')).toBe(Date.parse('2026-10-06T00:00:00Z'));
	});

	it('finds the next opening across long closures and time zones, and null when it never opens', () => {
		const weekly = [{ day: 1, start: '09:00', end: '10:00' }];
		// three Mondays closed in a row: back on the fourth
		const exceptions = ['2026-10-12', '2026-10-19', '2026-10-26'].map((date) => ({ date, name: 'Closed', hours: [] }));
		expect(nextOpenAt({ weekly, exceptions }, Date.parse('2026-10-05T11:00:00Z'), 'UTC')).toBe(
			Date.parse('2026-11-02T09:00:00Z'),
		);
		// Monday 09:00 in New York (UTC−5 after the clocks change on 1 November)
		expect(nextOpenAt({ weekly, exceptions: [] }, Date.parse('2026-10-31T12:00:00Z'), 'America/New_York')).toBe(
			Date.parse('2026-11-02T14:00:00Z'),
		);
		expect(nextOpenAt({ weekly: [], exceptions: [] }, 5, 'UTC')).toBe(5);
		expect(
			nextOpenAt(
				{ weekly: [{ day: 1, start: '09:00', end: '09:00' }], exceptions: [] },
				Date.parse('2026-10-05T08:00:00Z'),
				'UTC',
			),
		).toBe(Date.parse('2026-10-05T09:00:00Z'));
	});
});
