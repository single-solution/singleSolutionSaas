/**
 * Order numbers (E30, E29, `core/order-numbers.js`): the merchant's pattern of `{prefix}`, `{year}`, `{month}`,
 * `{number}` and `{suffix}` from the checkout settings (one running counter by default), the numbers, the counters'
 * ids (shared only by forms that give the same numbers) and the patterns that read them.
 */
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_NUMBER_PATTERN,
	ORDER_NUMBER,
	captureIndexes,
	counterIdOf,
	counterNameOf,
	counterNumbers,
	describeNumberForm,
	formNumbers,
	isNumberPattern,
	numberFormOf,
	numberMatcher,
	orderNumberOf,
	periodOf,
} from '../core/order-numbers.js';
import checkoutSettings from '../schemas/checkout.settings.json' with { type: 'json' };

const RUNNING = numberFormOf({ numberPrefix: 'SH-', numberDigits: 6 });
const YEARLY = numberFormOf({ numberPattern: '{prefix}{year}-{number}', numberPrefix: 'SH-', numberDigits: 4 });
const MONTHLY = numberFormOf({ numberPattern: '{year}{month}-{number}{suffix}', numberSuffix: '-W', numberDigits: 3 });
const MARCH = { year: 2026, month: 3 };

describe('order numbers (E30, E29)', () => {
	it('read the form from the settings, with the setting’s defaults', () => {
		expect(DEFAULT_NUMBER_PATTERN).toBe(checkoutSettings.properties.numberPattern.default);
		expect(checkoutSettings.properties.numberDigits).toMatchObject({ minimum: 1, maximum: 10 });
		expect(numberFormOf({})).toEqual({ pattern: '{prefix}{number}', prefix: '', suffix: '', digits: 6 });
		expect(numberFormOf({ numberPattern: '{year}', numberPrefix: 7, numberDigits: 12 })).toEqual({
			pattern: '{prefix}{number}',
			prefix: '',
			suffix: '',
			digits: 10,
		});
		expect(numberFormOf({ numberDigits: 0 }).digits).toBe(1);
		// a number goes in addresses and is looked up by them: a prefix and suffix keep letters, digits, - and _ only
		const spaced = numberFormOf({
			numberPrefix: 'Order #1/',
			numberSuffix: ' (web)',
			numberPattern: '{prefix}{number}{suffix}',
		});
		expect([spaced.prefix, spaced.suffix]).toEqual(['Order1', 'web']);
		expect(orderNumberOf(spaced, { ...MARCH, sequence: 7 })).toMatch(ORDER_NUMBER);
		expect(numberFormOf({ numberDigits: 4.5 }).digits).toBe(6);
		expect([periodOf(RUNNING), periodOf(YEARLY), periodOf(MONTHLY)]).toEqual(['all', 'year', 'month']);
	});

	it('take any pattern of the tokens, with {number} once and {month} only with {year}', () => {
		for (const pattern of ['{number}', '{prefix}{year}{month}{number}{suffix}', 'W-{year}_{number}', '{number}-{year}'])
			expect(isNumberPattern(pattern)).toBe(true);
		for (const pattern of [
			'',
			'{prefix}',
			'{number}{number}',
			'{year}{year}{number}',
			'{month}-{number}',
			'{day}{number}',
			'A {number}',
			'#{number}',
			'{number',
			`${'x'.repeat(60)}{number}`,
		])
			expect(isNumberPattern(pattern)).toBe(false);
	});

	it('write numbers with at least their digits, growing past them', () => {
		expect(orderNumberOf(RUNNING, { ...MARCH, sequence: 43 })).toBe('SH-000043');
		expect(orderNumberOf(RUNNING, { ...MARCH, sequence: 12_345_678 })).toBe('SH-12345678');
		expect(orderNumberOf(YEARLY, { ...MARCH, sequence: 43 })).toBe('SH-2026-0043');
		expect(orderNumberOf(YEARLY, { year: 2027, month: 1, sequence: 123_456 })).toBe('SH-2027-123456');
		expect(orderNumberOf(MONTHLY, { ...MARCH, sequence: 7 })).toBe('202603-007-W');
		expect(orderNumberOf(numberFormOf({}), { ...MARCH, sequence: 1 })).toBe('000001');
	});

	it('keep counters apart unless their numbers are the same', () => {
		expect(counterIdOf(YEARLY, MARCH)).toBe('orders-SH-2026-:');
		expect(counterIdOf(YEARLY, { year: 2026, month: 9 })).toBe('orders-SH-2026-:');
		expect(counterIdOf(RUNNING, MARCH)).toBe('orders-SH-:');
		expect(counterIdOf(MONTHLY, MARCH)).toBe('orders-202603-:-W');
		expect(counterIdOf(MONTHLY, { year: 2026, month: 4 })).not.toBe(counterIdOf(MONTHLY, MARCH));
		// a running prefix that ends with a year still has its own counter
		expect(counterIdOf(numberFormOf({ numberPrefix: 'SH-2026' }), MARCH)).not.toBe(counterIdOf(YEARLY, MARCH));
		expect(counterNameOf(MONTHLY, MARCH)).toBe('202603-#-W');
	});

	it('read the numbers of a counter and of the form', () => {
		const ofYear = new RegExp(counterNumbers(YEARLY, MARCH));
		expect(ofYear.exec('SH-2026-0043')?.[1]).toBe('0043');
		expect(ofYear.test('SH-2025-0043')).toBe(false);
		expect(ofYear.test('SH-000043')).toBe(false);
		const running = new RegExp(counterNumbers(RUNNING, MARCH));
		expect(running.exec('SH-43')?.[1]).toBe('43');
		expect(running.test('SH-2026-0043')).toBe(false);
		expect(new RegExp(counterNumbers(MONTHLY, MARCH)).exec('202603-12-W')?.[1]).toBe('12');
		// a prefix is taken as text, never as a pattern
		expect(new RegExp(counterNumbers(numberFormOf({ numberPrefix: 'A.' }), MARCH)).test('AB000001')).toBe(false);
		expect(numberMatcher(RUNNING).test('SH-000043')).toBe(true);
		expect(numberMatcher(RUNNING).test('SH-00043')).toBe(false);
		expect(numberMatcher(YEARLY).test('SH-2026-0043')).toBe(true);
		expect(numberMatcher(YEARLY).test('SH-0043')).toBe(false);
		expect(numberMatcher(MONTHLY).test('202613-007-W')).toBe(false);
		expect(describeNumberForm(RUNNING)).toBe('SH-<at least 6 digits>');
		expect(describeNumberForm(YEARLY)).toBe('SH-<year>-<at least 4 digits>');
		expect(describeNumberForm(MONTHLY)).toBe('<year><month>-<at least 3 digits>-W');
		// every number of the form, any count of digits, with where its year, month and sequence are
		const all = new RegExp(formNumbers(numberFormOf({ numberPattern: '{number}-{month}{year}' })));
		expect(all.exec('5-032026')?.slice(1)).toEqual(['5', '03', '2026']);
		expect(captureIndexes(numberFormOf({ numberPattern: '{number}-{month}{year}' }))).toEqual({
			sequence: 0,
			month: 1,
			year: 2,
		});
		expect(captureIndexes(RUNNING)).toEqual({ sequence: 0, month: -1, year: -1 });
	});
});
