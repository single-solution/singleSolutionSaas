/**
 * Order numbers (E30, `core/order-numbers.js`): the form from the checkout settings (one running counter by default, or
 * a counter per year), the numbers, the counters' ids (never shared by the two forms) and the patterns that read them.
 */
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_NUMBER_PATTERN,
	NUMBER_PATTERNS,
	counterIdOf,
	counterNumbers,
	describeNumberForm,
	isYearly,
	numberFormOf,
	numberMatcher,
	orderNumberOf,
} from '../core/order-numbers.js';
import checkoutSettings from '../schemas/checkout.settings.json' with { type: 'json' };

const RUNNING = numberFormOf({ numberPrefix: 'SH-', numberDigits: 6 });
const YEARLY = numberFormOf({ numberPattern: '{prefix}{year}-{number}', numberPrefix: 'SH-', numberDigits: 4 });

describe('order numbers (E30)', () => {
	it('read the form from the settings, with the setting’s defaults', () => {
		expect(NUMBER_PATTERNS).toEqual(checkoutSettings.properties.numberPattern.enum);
		expect(DEFAULT_NUMBER_PATTERN).toBe(checkoutSettings.properties.numberPattern.default);
		expect(numberFormOf({})).toEqual({ pattern: '{prefix}{number}', prefix: '', digits: 6 });
		expect(numberFormOf({ numberPattern: '{year}', numberPrefix: 7, numberDigits: 12 })).toEqual({
			pattern: '{prefix}{number}',
			prefix: '',
			digits: 8,
		});
		expect(numberFormOf({ numberDigits: 2 }).digits).toBe(4);
		expect(numberFormOf({ numberDigits: 4.5 }).digits).toBe(6);
		expect([isYearly(RUNNING), isYearly(YEARLY)]).toEqual([false, true]);
	});

	it('write numbers with at least their digits, growing past them', () => {
		expect(orderNumberOf(RUNNING, { year: 2026, sequence: 43 })).toBe('SH-000043');
		expect(orderNumberOf(RUNNING, { year: 2026, sequence: 12_345_678 })).toBe('SH-12345678');
		expect(orderNumberOf(YEARLY, { year: 2026, sequence: 43 })).toBe('SH-2026-0043');
		expect(orderNumberOf(YEARLY, { year: 2027, sequence: 123_456 })).toBe('SH-2027-123456');
		expect(orderNumberOf(numberFormOf({}), { year: 2026, sequence: 1 })).toBe('000001');
	});

	it('keep the running counter and the years’ counters apart', () => {
		expect(counterIdOf(YEARLY, 2026)).toBe('orders-SH-2026');
		expect(counterIdOf(RUNNING, 2026)).toBe('orders-SH-:');
		// a running prefix that ends with a year still has its own counter
		const tricky = numberFormOf({ numberPrefix: 'SH-2026' });
		expect(counterIdOf(tricky, 2026)).not.toBe(counterIdOf(YEARLY, 2026));
	});

	it('read the numbers of a counter and of the form', () => {
		const ofYear = new RegExp(counterNumbers(YEARLY, 2026));
		expect(ofYear.exec('SH-2026-0043')?.[1]).toBe('0043');
		expect(ofYear.test('SH-2025-0043')).toBe(false);
		expect(ofYear.test('SH-000043')).toBe(false);
		const running = new RegExp(counterNumbers(RUNNING, 2026));
		expect(running.exec('SH-43')?.[1]).toBe('43');
		expect(running.test('SH-2026-0043')).toBe(false);
		// a prefix is taken as text, never as a pattern
		expect(new RegExp(counterNumbers(numberFormOf({ numberPrefix: 'A.' }), 2026)).test('AB000001')).toBe(false);
		expect(numberMatcher(RUNNING).test('SH-000043')).toBe(true);
		expect(numberMatcher(RUNNING).test('SH-00043')).toBe(false);
		expect(numberMatcher(YEARLY).test('SH-2026-0043')).toBe(true);
		expect(numberMatcher(YEARLY).test('SH-0043')).toBe(false);
		expect(describeNumberForm(RUNNING)).toBe('SH-<at least 6 digits>');
		expect(describeNumberForm(YEARLY)).toBe('SH-<year>-<at least 4 digits>');
	});
});
