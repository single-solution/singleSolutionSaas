import { describe, expect, it } from 'vitest';
import { PHONE_COUNTRIES, callingCodeOf, normalisePhone, phoneInCountries, websiteCallingCode } from '../src/index.js';
import * as browserEntry from '../src/phone.js';

/** @param {string} defaultCallingCode @param {string} [trunkPrefix] */
const site = (defaultCallingCode, trunkPrefix = '') => ({ defaultCallingCode, trunkPrefix });

describe('phone numbers (one normaliser for every product)', () => {
	it('is the browser-safe entry too', () => {
		expect(browserEntry.normalisePhone).toBe(normalisePhone);
		expect(browserEntry.websiteCallingCode).toBe(websiteCallingCode);
	});

	it('reads every usual way of typing one number with a default calling code', () => {
		for (const typed of [
			'923001234567',
			'92 300 1234567',
			'+923001234567',
			'+92 300 1234567',
			'03001234567',
			'0300-1234567',
			'(0300) 1234567',
			'3001234567',
			'+92 0300 1234567',
			'+92 (0)300-1234567',
			'+920300 1234567',
			'92 0300 1234567',
			'0092 0300 1234567',
			'0092300 1234567',
			'0092-300-1234567',
			' 0300.123.4567 ',
		])
			expect([typed, normalisePhone(typed, '+92')]).toEqual([typed, '+923001234567']);
		expect(normalisePhone('+92 0320 4862403', site('+92', '0'))).toBe('+923204862403');
		expect(normalisePhone('0320 4862403', site('92'))).toBe('+923204862403');
		// a landline: nine national digits
		expect(normalisePhone('051 1234567', '+92')).toBe('+92511234567');
	});

	it('lets the country’s usual lengths choose between readings', () => {
		// India: mobiles may start with the code's digits
		expect(normalisePhone('9123456789', '+91')).toBe('+919123456789');
		expect(normalisePhone('919123456789', '+91')).toBe('+919123456789');
		expect(normalisePhone('09123456789', '+91')).toBe('+919123456789');
		// Pakistan: nine digits starting with 92 are national
		expect(normalisePhone('921234567', '+92')).toBe('+92921234567');
		// Kazakhstan: a mobile starting with the code's 7
		expect(normalisePhone('7012345678', '+7')).toBe('+77012345678');
	});

	it('keeps the digits as typed (no second code) when the lengths cannot decide', () => {
		// no lengths listed for Germany
		expect(normalisePhone('4930123456', '+49')).toBe('+4930123456');
		// no reading has a usual Pakistani length
		expect(normalisePhone('92300123', '+92')).toBe('+92300123');
	});

	it('accepts countries without listed lengths and lengths outside them', () => {
		expect(normalisePhone('01 234 5678', '+43')).toBe('+4312345678');
		expect(normalisePhone('0803 123 4567', '+234')).toBe('+2348031234567');
		expect(normalisePhone('01712-345678', '+880')).toBe('+8801712345678');
		expect(normalisePhone('+254 712 345678')).toBe('+254712345678');
		expect(normalisePhone('+92 300 123')).toBe('+92300123');
		expect(normalisePhone('0300123', '+92')).toBe('+92300123');
		expect(normalisePhone('+92 300 123456789')).toBe('+92300123456789');
		expect(normalisePhone('+1 415 555 01')).toBe('+141555501');
		// a number of another country typed without its + reads as national
		expect(normalisePhone('447700900123', '+92')).toBe('+92447700900123');
	});

	it('accepts calling codes of no country as they are', () => {
		expect(normalisePhone('+800 1234 5678')).toBe('+80012345678');
		expect(normalisePhone('+882 3123 456789')).toBe('+8823123456789');
		expect(normalisePhone('00870 7712 34567')).toBe('+870771234567');
		expect(normalisePhone('+883 0123 4567 89')).toBe('+8830123456789');
		// never a website's default calling code
		expect(normalisePhone('1234 5678', '+800')).toBeNull();
		expect(websiteCallingCode('+800', 'PK')).toBe('+92');
	});

	it('works for other countries', () => {
		expect(normalisePhone('+44 (0)20 7946 0018')).toBe('+442079460018');
		expect(normalisePhone('020 7946 0018', '+44')).toBe('+442079460018');
		expect(normalisePhone('07700 900123', '+44')).toBe('+447700900123');
		expect(normalisePhone('447700900123', '+44')).toBe('+447700900123');
		expect(normalisePhone('0044 7700 900123')).toBe('+447700900123');
		expect(normalisePhone('+1 415 555 0100')).toBe('+14155550100');
		expect(normalisePhone('+1 (415) 555-0100', '+92')).toBe('+14155550100');
		expect(normalisePhone('(415) 555-0100', '+1')).toBe('+14155550100');
		expect(normalisePhone('1 415 555 0100', '+1')).toBe('+14155550100');
		expect(normalisePhone('415/555/0100', '1')).toBe('+14155550100');
		expect(normalisePhone('+49 (0)30 123456')).toBe('+4930123456');
		expect(normalisePhone('030 123456', '+49')).toBe('+4930123456');
		expect(normalisePhone('06 12 34 56 78', '+33')).toBe('+33612345678');
		expect(normalisePhone('0412 345 678', '+61')).toBe('+61412345678');
		expect(normalisePhone('050-123-4567', '+971')).toBe('+971501234567');
	});

	it('keeps the 0 where national numbers start with it', () => {
		expect(normalisePhone('+39 06 1234 5678')).toBe('+390612345678');
		expect(normalisePhone('06 1234 5678', '+39')).toBe('+390612345678');
		expect(normalisePhone('0039 333 123 4567')).toBe('+393331234567');
		// Italian mobiles may start with 39: read as national first
		expect(normalisePhone('393 123 4567', '+39')).toBe('+393931234567');
		expect(normalisePhone('39 393 123 4567', '+39')).toBe('+393931234567');
		expect(normalisePhone('39 06 1234 5678', '+39')).toBe('+390612345678');
		expect(normalisePhone('+225 07 01 23 45 67')).toBe('+2250701234567');
		expect(normalisePhone('07 01 23 45 67', '+225')).toBe('+2250701234567');
		expect(normalisePhone('+242 06 123 4567')).toBe('+242061234567');
	});

	it('uses the trunk prefix of the country or of the website', () => {
		expect(normalisePhone('8 912 345 67 89', '+7')).toBe('+79123456789');
		expect(normalisePhone('8 812 345 67 89', '+7')).toBe('+78123456789');
		expect(normalisePhone('812 345 67 89', '+7')).toBe('+78123456789');
		expect(normalisePhone('+7 812 345 67 89')).toBe('+78123456789');
		expect(normalisePhone('7012345678', '+7')).toBe('+77012345678');
		expect(normalisePhone('06 1 234 5678', site('+36', '06'))).toBe('+3612345678');
		expect(normalisePhone('5 06 1234 5678', site('+39', '5'))).toBe('+390612345678');
		expect(normalisePhone('0300 1234567', site('+92', 'x'))).toBe('+923001234567');
	});

	it('refuses what cannot be an E.164 number', () => {
		for (const bad of [
			'',
			'   ',
			'+',
			'()',
			'call me',
			'3+00',
			'++923001234567',
			'+92 300 1234567 ext 5',
			'+92 00 300 1234567',
			'+44 00 20 7946 0018',
			'+0300 1234567',
			'+999 1234 5678',
			'+92 3001',
			'+92300123456789012',
			'1'.repeat(41),
		])
			expect([bad, normalisePhone(bad, '+92')]).toEqual([bad, null]);
		expect(normalisePhone(923001234567, '+92')).toBeNull();
		expect(normalisePhone(null)).toBeNull();
		// a national number needs a default calling code
		expect(normalisePhone('0300 1234567')).toBeNull();
		expect(normalisePhone('923001234567')).toBeNull();
		expect(normalisePhone('0300 1234567', '+999')).toBeNull();
		expect(normalisePhone('0300 1234567', site(''))).toBeNull();
		expect(normalisePhone('12', '+1')).toBeNull();
		// a short total
		expect(normalisePhone('+290 1234')).toBeNull();
	});

	it('finds the default calling code in the setting, else the business.json country', () => {
		expect(callingCodeOf('pk')).toBe('+92');
		expect(callingCodeOf('GB')).toBe('+44');
		expect(callingCodeOf('ZZ')).toBe('');
		expect(callingCodeOf(null)).toBe('');
		expect(websiteCallingCode('+44', 'PK')).toBe('+44');
		expect(websiteCallingCode(' 44 ', 'PK')).toBe('+44');
		expect(websiteCallingCode('', 'PK')).toBe('+92');
		expect(websiteCallingCode('+999', 'US')).toBe('+1');
		expect(websiteCallingCode(undefined, null)).toBe('');
		expect(normalisePhone('0300 1234567', websiteCallingCode('', 'PK'))).toBe('+923001234567');
	});

	it('keeps numbers to a list of countries ([] = any)', () => {
		expect(PHONE_COUNTRIES).toContain('PK');
		expect(PHONE_COUNTRIES).toHaveLength(new Set(PHONE_COUNTRIES).size);
		expect(PHONE_COUNTRIES.every((country) => callingCodeOf(country) !== '')).toBe(true);
		expect(phoneInCountries('+923001234567', [])).toBe(true);
		expect(phoneInCountries('+923001234567', ['GB', 'PK'])).toBe(true);
		expect(phoneInCountries('+447700900123', ['PK'])).toBe(false);
		expect(phoneInCountries('+14155550100', ['CA'])).toBe(true);
		expect(phoneInCountries('+14155550100', ['ZZ'])).toBe(false);
	});
});
