/**
 * Merchant field formats (PLAN 0.8.10 dynamic model §2): one pure check walks each value once (no regular expression
 * made from merchant input), Luhn and GS1 check digits, and the format rules a merchant saves.
 */
import { describe, expect, it } from 'vitest';
import { checkFormat, checkFormatRule, formatted, gtinOf, luhnValid } from '../core/fields.js';

/** @typedef {import('../core/fields.js').Format} Format */

/**
 * A format with the defaults a saved one gets.
 * @param {Partial<Format>} parts
 * @returns {Format}
 */
const format = (parts) => {
	const checked = checkFormatRule(parts);
	if (!checked.ok || !checked.value) throw new Error(JSON.stringify(checked));
	return checked.value;
};

describe('check digits', () => {
	it('checks Luhn numbers', () => {
		for (const valid of ['79927398713', '490154203237518', '356938035643809', '4111111111111111', '18'])
			expect(luhnValid(valid), valid).toBe(true);
		for (const wrong of ['79927398710', '490154203237519', '1', '', '4111-1111', 'ABCDEFG'])
			expect(luhnValid(wrong), wrong).toBe(false);
	});

	it('checks GTINs: 8, 12, 13 or 14 digits with the GS1 check digit', () => {
		// GTIN-13 (EAN), GTIN-12 (UPC-A), GTIN-8 and GTIN-14
		for (const valid of ['4006381333931', '5901234123457', '036000291452', '96385074', '12345670', '10012345678902'])
			expect(gtinOf(valid), valid).toBe(valid);
		expect(gtinOf('00012345600012')).toBe('00012345600012');
		// spaces and dashes as printed under a barcode are dropped
		expect(gtinOf(' 4006381-333931 ')).toBe('4006381333931');
		expect(gtinOf('5 901234 123457')).toBe('5901234123457');
		for (const wrong of ['4006381333932', '036000291453', '0360002914520', '1234567', '123456789', 'ABC', '', 5, null])
			expect(gtinOf(wrong), String(wrong)).toBeNull();
		expect(gtinOf('4'.repeat(41))).toBeNull();
	});
});

describe('formats', () => {
	it('checks the format rules a merchant saves, with defaults', () => {
		expect(checkFormatRule(null)).toEqual({ ok: true, value: null });
		expect(checkFormatRule(undefined)).toEqual({ ok: true, value: null });
		expect(checkFormatRule({})).toEqual({
			ok: true,
			value: {
				chars: 'any',
				minLength: 1,
				maxLength: 200,
				startsWith: [],
				mask: '',
				checkDigit: 'none',
				ignoreSpaces: false,
				upperCase: false,
			},
		});
		// starts and the mask are kept the way values are
		expect(
			checkFormatRule({
				startsWith: ['sn ', 'SN', 'ab c'],
				mask: 'aa 9999',
				upperCase: true,
				ignoreSpaces: true,
				maxLength: 6,
			}),
		).toMatchObject({ ok: true, value: { startsWith: ['SN', 'ABC'], mask: 'AA9999' } });
		/** @param {unknown} rule */
		const paths = (rule) => {
			const checked = checkFormatRule(rule);
			return checked.ok ? [] : checked.errors.map((error) => error.path);
		};
		expect(paths('digits')).toEqual(['/format']);
		expect(paths({ chars: 'emoji', ignoreSpaces: 'yes', upperCase: 1 })).toEqual([
			'/format/chars',
			'/format/ignoreSpaces',
			'/format/upperCase',
		]);
		expect(paths({ minLength: 0 })).toEqual(['/format/minLength']);
		expect(paths({ minLength: 10, maxLength: 5 })).toEqual(['/format/minLength']);
		expect(paths({ maxLength: 201 })).toEqual(['/format/minLength']);
		expect(paths({ startsWith: 'SN' })).toEqual(['/format/startsWith']);
		expect(paths({ startsWith: Array.from({ length: 11 }, (_, i) => `S${i}`) })).toEqual(['/format/startsWith']);
		expect(paths({ startsWith: [''] })).toEqual(['/format/startsWith']);
		expect(paths({ startsWith: ['x'.repeat(21)] })).toEqual(['/format/startsWith']);
		expect(paths({ startsWith: ['a\u0000'] })).toEqual(['/format/startsWith']);
		expect(paths({ mask: 5 })).toEqual(['/format/mask']);
		expect(paths({ mask: '9'.repeat(65) })).toEqual(['/format/mask']);
		expect(paths({ mask: '99\u0007' })).toEqual(['/format/mask']);
		expect(paths({ mask: '999', minLength: 4, maxLength: 9 })).toEqual(['/format/mask']);
		expect(paths({ checkDigit: 'mod97' })).toEqual(['/format/checkDigit']);
		expect(paths({ checkDigit: 'luhn' })).toEqual(['/format/checkDigit']);
		expect(paths({ chars: 'digits', checkDigit: 'luhn' })).toEqual([]);
	});

	it('refuses values by the first part they fail: length, characters, start, mask, check digit', () => {
		const imei = format({ chars: 'digits', minLength: 15, maxLength: 15, checkDigit: 'luhn', ignoreSpaces: true });
		expect(checkFormat('490154203237518', imei)).toEqual({ ok: true, value: '490154203237518' });
		// kept without its spaces
		expect(checkFormat(' 49015420 3237518 ', imei)).toEqual({ ok: true, value: '490154203237518' });
		expect(checkFormat('49015420323751', imei)).toEqual({ ok: false, code: 'length' });
		expect(checkFormat('49015420323751X', imei)).toEqual({ ok: false, code: 'chars' });
		expect(checkFormat('490154203237519', imei)).toEqual({ ok: false, code: 'check_digit' });
		const tag = format({ chars: 'letters_digits_dash', mask: 'AA-9999', upperCase: true, startsWith: ['SN', 'XR'] });
		expect(checkFormat('sn-1234', tag)).toEqual({ ok: true, value: 'SN-1234' });
		expect(checkFormat('AB-1234', tag)).toEqual({ ok: false, code: 'starts' });
		expect(checkFormat('SN-12A4', tag)).toEqual({ ok: false, code: 'mask' });
		expect(checkFormat('SN_1234', tag)).toEqual({ ok: false, code: 'chars' });
		expect(checkFormat('SN-12345', tag)).toEqual({ ok: false, code: 'mask' });
		const any = format({ mask: '*9*' });
		expect(checkFormat('A1b', any)).toEqual({ ok: true, value: 'A1b' });
		expect(checkFormat('A-b', any)).toEqual({ ok: false, code: 'mask' });
		expect(checkFormat('a\u0001b', any)).toEqual({ ok: false, code: 'chars' });
		// letters of any script
		const letters = format({ chars: 'letters', maxLength: 10 });
		expect(checkFormat('Ωμέγα', letters)).toEqual({ ok: true, value: 'Ωμέγα' });
		expect(checkFormat('東京', letters)).toEqual({ ok: true, value: '東京' });
		expect(checkFormat('abc1', letters)).toEqual({ ok: false, code: 'chars' });
		expect(checkFormat('ab12', format({ chars: 'letters_digits' }))).toEqual({ ok: true, value: 'ab12' });
		expect(checkFormat('a b', format({ chars: 'letters_digits' }))).toEqual({ ok: false, code: 'chars' });
		// a length counts characters, not code units
		expect(checkFormat('😀😀', format({ maxLength: 2 }))).toEqual({ ok: true, value: '😀😀' });
		expect(formatted('  a b  ', { ignoreSpaces: false, upperCase: true })).toBe('A B');
	});

	it('checks very long values in linear time, whatever the format', () => {
		const huge = 'a'.repeat(1_000_000);
		/** @type {Format} */
		const wide = {
			chars: 'letters_digits_dash',
			minLength: 1,
			maxLength: 2_000_000,
			startsWith: ['A'.repeat(20), 'B'],
			mask: '*'.repeat(1_000_000),
			checkDigit: 'none',
			ignoreSpaces: true,
			upperCase: true,
		};
		const started = performance.now();
		const kept = checkFormat(huge, wide);
		expect(kept.ok && kept.value === 'A'.repeat(1_000_000)).toBe(true);
		expect(checkFormat(`${'1'.repeat(999_999)}x`, { ...wide, chars: 'digits', mask: '' })).toEqual({
			ok: false,
			code: 'chars',
		});
		expect(checkFormat(`${'1 '.repeat(500_000)}`, { ...wide, chars: 'digits', mask: '', checkDigit: 'luhn' }).ok).toBe(false);
		// the saved limits stop long values at once
		expect(checkFormat(huge, format({ chars: 'digits', maxLength: 15 }))).toEqual({ ok: false, code: 'length' });
		expect(performance.now() - started).toBeLessThan(5000);
	});
});
