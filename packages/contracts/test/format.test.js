import { describe, expect, it } from 'vitest';
import {
	DEFAULT_FORMAT,
	FORMAT_FIELDS,
	IMPORT_LIMITS,
	currencyDigits,
	formatDate,
	formatMoney,
	formatViolation,
	normaliseFormat,
	validateActivityCopy,
	zonedDay,
	zonedDayStart,
	zonedParts,
} from '../src/index.js';
import * as browserEntry from '../src/format.js';
import { WEBSITE } from '../src/testing.js';

describe('Format values (K7)', () => {
	it('has five fields with safe defaults', () => {
		expect(FORMAT_FIELDS).toEqual(['locale', 'currencyDisplay', 'currencySymbol', 'wholeUnits', 'times']);
		expect(DEFAULT_FORMAT).toEqual({
			locale: '',
			currencyDisplay: 'code',
			currencySymbol: '',
			wholeUnits: false,
			times: 'viewer',
		});
	});

	it('checks each field', () => {
		expect(formatViolation('locale', '')).toBeNull();
		expect(formatViolation('locale', 'en-GB')).toBeNull();
		expect(formatViolation('locale', 'ur-PK')).toBeNull();
		expect(formatViolation('locale', 'not a locale')).toMatch(/language tag/);
		expect(formatViolation('locale', 7)).toMatch(/language tag/);
		expect(formatViolation('currencyDisplay', 'symbol')).toBeNull();
		expect(formatViolation('currencyDisplay', 'name')).toMatch(/code, symbol or custom/);
		expect(formatViolation('currencySymbol', 'Rs.')).toBeNull();
		expect(formatViolation('currencySymbol', 'TooLongSym')).toMatch(/8 characters/);
		expect(formatViolation('currencySymbol', 'a\u0007')).toMatch(/8 characters/);
		expect(formatViolation('wholeUnits', true)).toBeNull();
		expect(formatViolation('wholeUnits', 'yes')).toMatch(/true or false/);
		expect(formatViolation('times', 'business')).toBeNull();
		expect(formatViolation('times', 'utc')).toMatch(/viewer or business/);
		expect(formatViolation('colour', 'red')).toMatch(/unknown format field/);
	});

	it('normalises stored and partial values', () => {
		expect(normaliseFormat(undefined)).toEqual(DEFAULT_FORMAT);
		expect(normaliseFormat([])).toEqual(DEFAULT_FORMAT);
		expect(normaliseFormat({ wholeUnits: true, times: 'nope', extra: 1 })).toEqual({ ...DEFAULT_FORMAT, wholeUnits: true });
	});
});

describe('formatMoney (K7)', () => {
	it('shows the code by default, with the ISO 4217 minor units', () => {
		expect(formatMoney(1_250_000, 'PKR')).toBe('PKR 12,500.00');
		expect(formatMoney(12_500, 'JPY')).toBe('JPY 12,500');
		expect(formatMoney(1_234_567, 'KWD')).toBe('KWD 1,234.567');
		expect(currencyDigits('USD')).toBe(2);
		expect(currencyDigits('JPY')).toBe(0);
		expect(currencyDigits('BHD')).toBe(3);
	});

	it("shows the locale's symbol, a custom symbol and whole units", () => {
		expect(formatMoney(1_250_000, 'PKR', { currencyDisplay: 'symbol' })).toBe('Rs 12,500.00');
		expect(formatMoney(1_250_000, 'PKR', { currencyDisplay: 'symbol', wholeUnits: true })).toBe('Rs 12,500');
		expect(formatMoney(1_250_050, 'PKR', { currencyDisplay: 'custom', currencySymbol: 'Rs.', wholeUnits: true })).toBe(
			'Rs. 12,501',
		);
		// a custom display without a symbol keeps the code
		expect(formatMoney(100, 'USD', { currencyDisplay: 'custom' })).toBe('USD 1.00');
		expect(formatMoney(-150, 'USD')).toBe('-USD 1.50');
	});

	it("writes in the Format's locale, else the viewer's, else en", () => {
		expect(formatMoney(1_250_000, 'EUR', { locale: 'de' })).toBe('12.500,00 EUR');
		expect(formatMoney(1_250_000, 'EUR', {}, { locale: 'de' })).toBe('12.500,00 EUR');
		expect(formatMoney(1_250_000, 'EUR', { locale: 'en' }, { locale: 'de' })).toBe('EUR 12,500.00');
		expect(formatMoney(1_250_000, 'EUR', {}, { locale: 'xx-invalid-' })).toBe('EUR 12,500.00');
	});

	it('copes with unknown currencies and non-numbers', () => {
		expect(formatMoney(1050, 'XXQ1')).toBe('XXQ1 10.50');
		expect(formatMoney(Number.NaN, 'USD')).toBe('');
		expect(formatMoney(/** @type {any} */ ('10'), 'USD')).toBe('');
	});
});

describe('formatDate (K7, K8)', () => {
	const at = '2026-03-12T19:30:00Z';

	it("uses the business time zone for text the server makes, whatever the Format's times", () => {
		expect(formatDate(at, { locale: 'en-GB' }, { timeZone: 'Asia/Karachi', style: 'date' })).toBe('13 Mar 2026');
		expect(formatDate(at, { locale: 'en-GB' }, { timeZone: 'Asia/Karachi' })).toBe('13 Mar 2026, 00:30');
		expect(formatDate(at, { locale: 'en-GB' }, { timeZone: 'Asia/Karachi', style: 'time' })).toBe('00:30');
		expect(formatDate(at, { locale: 'en-GB' })).toBe('12 Mar 2026, 19:30');
		expect(formatDate(at, { locale: 'en-GB' }, { timeZone: 'Not/AZone' })).toBe('12 Mar 2026, 19:30');
	});

	it('follows the viewer in widgets unless the Format says business times', () => {
		const viewer = { locale: 'en-GB', timeZone: 'America/New_York' };
		expect(formatDate(at, {}, { timeZone: 'Asia/Karachi', viewer, style: 'time' })).toBe('15:30');
		expect(formatDate(at, { times: 'business' }, { timeZone: 'Asia/Karachi', viewer, style: 'time' })).toBe('00:30');
		expect(typeof formatDate(Date.parse(at), {}, { viewer: { locale: 'en' } })).toBe('string');
	});

	it('takes dates, epoch ms and ISO text, and refuses anything else', () => {
		expect(formatDate(new Date(at), { locale: 'en-GB' }, { style: 'date' })).toBe('12 Mar 2026');
		expect(formatDate(Date.parse(at), { locale: 'en-GB' }, { style: 'date' })).toBe('12 Mar 2026');
		expect(formatDate('not a date')).toBe('');
		expect(formatDate(null)).toBe('');
		expect(formatDate(undefined)).toBe('');
		expect(formatDate(at, { locale: 'en-GB' }, { style: /** @type {any} */ ('other') })).toBe('12 Mar 2026, 19:30');
	});
});

describe('calendar rules in the business time zone (K8)', () => {
	it('gives the wall clock of an instant', () => {
		expect(zonedParts('2026-12-31T20:00:00Z', 'Asia/Karachi')).toEqual({
			year: 2027,
			month: 1,
			day: 1,
			hour: 1,
			minute: 0,
			second: 0,
			weekday: 5,
		});
		expect(zonedParts(Date.parse('2026-12-31T20:00:00Z'), null).year).toBe(2026);
		expect(zonedParts(new Date('2026-12-31T20:00:00Z'), 'Bad/Zone').hour).toBe(20);
		expect(() => zonedParts('nope', 'UTC')).toThrow(RangeError);
	});

	it('gives days and the start of a day', () => {
		expect(zonedDay('2026-10-09T21:00:00Z', 'Asia/Karachi')).toBe('2026-10-10');
		expect(zonedDay('2026-10-09T21:00:00Z', 'UTC')).toBe('2026-10-09');
		expect(new Date(zonedDayStart('2026-10-10', 'Asia/Karachi')).toISOString()).toBe('2026-10-09T19:00:00.000Z');
		expect(new Date(zonedDayStart('2026-10-10', undefined)).toISOString()).toBe('2026-10-10T00:00:00.000Z');
		// a day that starts on a daylight-saving change (New York, 2026-03-08)
		expect(new Date(zonedDayStart('2026-03-08', 'America/New_York')).toISOString()).toBe('2026-03-08T05:00:00.000Z');
		expect(new Date(zonedDayStart('2026-03-09', 'America/New_York')).toISOString()).toBe('2026-03-09T04:00:00.000Z');
		expect(zonedDayStart('2026-02-30', 'UTC')).toBeNaN();
		expect(zonedDayStart('10/10/2026', 'UTC')).toBeNaN();
	});

	it('is the same code in the browser entry', () => {
		expect(browserEntry.formatMoney).toBe(formatMoney);
		expect(browserEntry.zonedDay).toBe(zonedDay);
	});
});

describe('cross-product shapes of the store conversion', () => {
	it('activity copies carry a label, a detail and the actor role (K9)', () => {
		const copy = {
			websiteId: WEBSITE,
			productId: 'ecommerce',
			actor: { kind: 'user', id: 'usr_1', name: 'Ayesha K.', role: 'Support staff' },
			action: 'order.status_changed',
			target: 'ord_0123456789abcdefghjkmnpq',
			label: 'IM-2026-0043',
			detail: 'confirmed → packed',
			at: '2026-10-10T10:00:00Z',
		};
		expect(validateActivityCopy(copy).ok).toBe(true);
		expect(validateActivityCopy({ ...copy, label: 'x'.repeat(201) }).ok).toBe(false);
		expect(validateActivityCopy({ ...copy, detail: 'x'.repeat(2001) }).ok).toBe(false);
		expect(validateActivityCopy({ ...copy, actor: { ...copy.actor, role: 'r'.repeat(41) } }).ok).toBe(false);
	});

	it('import calls are bounded (K10)', () => {
		expect(IMPORT_LIMITS).toEqual({ records: 1000, bytes: 4 * 1024 * 1024 });
	});
});
