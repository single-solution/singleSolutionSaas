import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/index.js';
import { formatDateLiteral, isValidTimeZone, parseClock, parseIso, zonedParts } from '../src/time.js';
import { prog, run } from './helpers.js';

describe('ISO parsing', () => {
	it('parses dates, times, fractions and offsets', () => {
		expect(parseIso('2026-10-01')).toBe(Date.UTC(2026, 9, 1));
		expect(parseIso('2026-10-01T10:20')).toBe(Date.UTC(2026, 9, 1, 10, 20));
		expect(parseIso('2026-10-01 10:20:30')).toBe(Date.UTC(2026, 9, 1, 10, 20, 30));
		expect(parseIso('2026-10-01T10:20:30.1234Z')).toBe(Date.UTC(2026, 9, 1, 10, 20, 30, 123));
		expect(parseIso('2026-10-01T10:00-0330')).toBe(Date.UTC(2026, 9, 1, 13, 30));
		expect(parseIso('2026-10-01t10:00z')).toBe(Date.UTC(2026, 9, 1, 10, 0));
		expect(parseIso('0001-01-01')).toBe(new Date('0001-01-01T00:00:00Z').getTime());
		expect(parseIso('1900-02-28')).toBe(Date.UTC(1900, 1, 28));
		expect(parseIso('2000-02-29')).toBe(Date.UTC(2000, 1, 29));
	});
	it('rejects malformed input', () => {
		for (const s of [
			'',
			'2026',
			'2026-1-01',
			'2026-00-10',
			'2026-10-32',
			'1900-02-29',
			'2026-10-01T',
			'2026-10-01T24:00',
			'2026-10-01T10:60',
			'2026-10-01T10:00:61',
			'2026-10-01T10:00:00.',
			'2026-10-01T10:00+25:00',
			'2026-10-01T10:00+05:61',
			'2026-10-01T10:00Z junk',
			'2026-10-01T10',
		])
			expect(parseIso(s)).toBe(null);
	});
	it('formats canonical literals', () => {
		expect(formatDateLiteral(Date.UTC(2026, 9, 1))).toBe('@2026-10-01');
		expect(formatDateLiteral(Date.UTC(2026, 9, 1, 10))).toBe('@2026-10-01T10:00Z');
		expect(formatDateLiteral(Date.UTC(2026, 9, 1, 10, 0, 5))).toBe('@2026-10-01T10:00:05Z');
		expect(formatDateLiteral(Date.UTC(2026, 9, 1, 10, 0, 0, 7))).toBe('@2026-10-01T10:00:00.007Z');
		expect(formatDateLiteral(Date.UTC(1969, 11, 31))).toBe('@1969-12-31');
	});
	it('parses clocks', () => {
		expect(parseClock('00:00')).toBe(0);
		expect(parseClock('23:59')).toBe(1439);
		expect(parseClock('24:00')).toBe(1440);
		for (const s of ['24:01', '7:00', '07:0', '07-00', 'ab:cd', '12:60', 5, null]) expect(parseClock(s)).toBe(null);
	});
});

describe('time zones via Intl', () => {
	it('validates zones', () => {
		expect(isValidTimeZone('UTC')).toBe(true);
		expect(isValidTimeZone('Asia/Karachi')).toBe(true);
		expect(isValidTimeZone('America/New_York')).toBe(true);
		expect(isValidTimeZone('Mars/Base')).toBe(false);
		expect(isValidTimeZone('')).toBe(false);
		expect(isValidTimeZone(5)).toBe(false);
	});
	it('computes zoned parts', () => {
		const ms = Date.UTC(2026, 9, 1, 20, 30);
		expect(zonedParts(ms, 'UTC')).toEqual({
			year: 2026,
			month: 10,
			day: 1,
			hour: 20,
			minute: 30,
			second: 0,
			weekday: 4,
			weekdayName: 'thu',
		});
		expect(zonedParts(ms, 'Asia/Karachi')).toMatchObject({ day: 2, hour: 1, minute: 30, weekday: 5, weekdayName: 'fri' });
		expect(zonedParts(ms, 'Asia/Kolkata')).toMatchObject({ day: 2, hour: 2, minute: 0 });
		expect(zonedParts(ms, 'America/New_York')).toMatchObject({ day: 1, hour: 16 });
		expect(zonedParts(Date.UTC(2026, 0, 15, 20, 30), 'America/New_York')).toMatchObject({ hour: 15 });
		expect(zonedParts(Date.UTC(2026, 9, 4, 12), 'UTC')).toMatchObject({ weekday: 7, weekdayName: 'sun' });
		expect(zonedParts(ms, 'Mars/Base')).toBe(null);
	});
	it('dateParts in the language', () => {
		const now = '2026-10-01T20:30:00Z';
		expect(run("dateParts(now, 'Asia/Karachi').hour", {}, { now })).toBe(1);
		expect(run("dateParts(now, 'Asia/Karachi').weekdayName", {}, { now })).toBe('fri');
		expect(run('dateParts(now).hour', {}, { now })).toBe(20);
		expect(run('dateParts(now).hour', {}, { now, timeZone: 'Asia/Karachi' })).toBe(1);
		expect(run("dateParts('2026-10-01T00:00:00Z').month")).toBe(10);
		expect(run('dateParts(x)')).toBe(null);
		expect(run('dateParts(now, tz)', { tz: 'Nope/Nope' })).toBe(null);
		expect(run('dateParts(now, tz)', { tz: 5 })).toBe(null);
		expect(run('dateParts(now, tz).year', { tz: null })).toBe(2026);
	});
	it('rejects an unknown default zone', () => {
		expect(evaluate(prog('1'), {}, { timeZone: 'Nope/Nope' })).toMatchObject({ ok: false, error: { code: 'invalid_option' } });
	});
});

describe('between: time-of-day windows', () => {
	/** @param {string} at @param {string} src @param {string} [timeZone] */
	const at = (at, src, timeZone) => run(src, {}, { now: at, ...(timeZone ? { timeZone } : {}) });
	it('same-day window is [start, end)', () => {
		expect(at('2026-10-01T09:00:00Z', "between(now, '09:00', '17:00')")).toBe(true);
		expect(at('2026-10-01T16:59:00Z', "between(now, '09:00', '17:00')")).toBe(true);
		expect(at('2026-10-01T17:00:00Z', "between(now, '09:00', '17:00')")).toBe(false);
		expect(at('2026-10-01T08:59:00Z', "between(now, '09:00', '17:00')")).toBe(false);
	});
	it('overnight window 22:00–02:00', () => {
		const src = "between(now, '22:00', '02:00')";
		expect(at('2026-10-01T21:59:00Z', src)).toBe(false);
		expect(at('2026-10-01T22:00:00Z', src)).toBe(true);
		expect(at('2026-10-01T23:59:00Z', src)).toBe(true);
		expect(at('2026-10-02T00:00:00Z', src)).toBe(true);
		expect(at('2026-10-02T01:59:00Z', src)).toBe(true);
		expect(at('2026-10-02T02:00:00Z', src)).toBe(false);
		expect(at('2026-10-02T12:00:00Z', src)).toBe(false);
	});
	it('respects the zone argument and the default zone', () => {
		// 18:00Z is 23:00 in Karachi (UTC+5)
		expect(at('2026-10-01T18:00:00Z', "between(now, '22:00', '02:00', 'Asia/Karachi')")).toBe(true);
		expect(at('2026-10-01T18:00:00Z', "between(now, '22:00', '02:00')")).toBe(false);
		expect(at('2026-10-01T18:00:00Z', "between(now, '22:00', '02:00')", 'Asia/Karachi')).toBe(true);
		// New York DST: 13:30Z is 09:30 EDT in October, 08:30 EST in January
		expect(at('2026-10-01T13:30:00Z', "between(now, '09:00', '17:00', 'America/New_York')")).toBe(true);
		expect(at('2026-01-15T13:30:00Z', "between(now, '09:00', '17:00', 'America/New_York')")).toBe(false);
	});
	it('edge bounds', () => {
		expect(at('2026-10-01T23:59:00Z', "between(now, '18:00', '24:00')")).toBe(true);
		expect(at('2026-10-01T00:00:00Z', "between(now, '00:00', '24:00')")).toBe(true);
		expect(at('2026-10-01T10:00:00Z', "between(now, '10:00', '10:00')")).toBe(false);
		expect(at('2026-10-01T10:00:00Z', "between(now, '24:00', '02:00')")).toBe(false);
		expect(at('2026-10-01T10:00:00Z', "between(x, '09:00', '11:00')")).toBe(false);
		expect(at('2026-10-01T10:00:00Z', "between(now, '09:00', '11:00', tz)")).toBe(true); // null zone → default
		expect(run("between(now, '09:00', '11:00', tz)", { tz: 'Nope/Nope' })).toBe(false);
		expect(run("between('2026-10-01T10:30:00Z', '10:00', '11:00')")).toBe(true);
	});
	it('ordering mode for numbers, strings and dates', () => {
		expect(run('between(5, 1, 10)')).toBe(true);
		expect(run('between(1, 1, 10)')).toBe(true);
		expect(run('between(10, 1, 10)')).toBe(true);
		expect(run('between(11, 1, 10)')).toBe(false);
		expect(run('between(x, 1, 10)')).toBe(false);
		expect(run("between('m', 'a', 'z')")).toBe(true);
		expect(run("between(now, '2026-09-01', '2026-10-31')")).toBe(true);
		expect(run('between(now, @2026-10-02, @2026-10-31)')).toBe(false);
		expect(run("between(5, 'a', 'z')")).toBe(false);
	});
});
