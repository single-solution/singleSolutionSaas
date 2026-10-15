/** Return and warranty times (E14): a number and a unit, kept and shown as typed, counted on the calendar. */
import { describe, expect, it } from 'vitest';
import { daysOf, durationOf, durationText, endOf, isDuration, settingDuration } from '../core/durations.js';

describe('times', () => {
	it('takes a whole amount of days, months or years', () => {
		expect(isDuration({ amount: 1, unit: 'years' })).toBe(true);
		expect(isDuration({ amount: 0, unit: /** @type {const} */ ('days') })).toBe(true);
		expect(isDuration({ amount: 11, unit: 'years' })).toBe(false);
		expect(isDuration({ amount: 1.5, unit: 'months' })).toBe(false);
		expect(isDuration({ amount: 1, unit: 'weeks' })).toBe(false);
		expect(isDuration({ amount: 1, unit: 'days', extra: 1 })).toBe(false);
		expect(durationOf(null)).toBeNull();
		expect(durationOf(365)).toBeUndefined();
		expect(settingDuration(7, 'days')).toEqual({ amount: 7, unit: /** @type {const} */ ('days') });
		expect(settingDuration(1, 'years')).toEqual({ amount: 1, unit: 'years' });
	});

	it('shows a time as typed, in the language', () => {
		expect(durationText({ amount: 1, unit: 'years' })).toBe('1 year');
		expect(durationText({ amount: 6, unit: 'months' })).toBe('6 months');
		expect(durationText({ amount: 365, unit: /** @type {const} */ ('days') })).toBe('365 days');
		expect(durationText({ amount: 2, unit: 'years' }, 'de-DE')).toBe('2 Jahre');
	});

	it('counts months and years on the calendar', () => {
		const start = new Date('2026-01-31T10:00:00.000Z');
		expect(endOf(start, { amount: 1, unit: 'months' }).toISOString()).toBe('2026-02-28T10:00:00.000Z');
		expect(endOf(start, { amount: 1, unit: 'years' }).toISOString()).toBe('2027-01-31T10:00:00.000Z');
		expect(endOf(start, { amount: 7, unit: /** @type {const} */ ('days') }).toISOString()).toBe('2026-02-07T10:00:00.000Z');
		expect(daysOf({ amount: 1, unit: 'years' })).toBe(365);
		expect(daysOf({ amount: 2, unit: 'months' })).toBe(60);
	});
});
