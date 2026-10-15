import { describe, expect, it } from 'vitest';
import { isEmailAddress, normalizeEmail } from '../src/email.js';

describe('email addresses (one check for every product)', () => {
	it('stores an address trimmed and in lower case, plus-addressing kept', () => {
		expect(normalizeEmail('  Ana.Silva@Example.COM ')).toBe('ana.silva@example.com');
		expect(normalizeEmail('ana+news@example.com')).toBe('ana+news@example.com');
		expect(normalizeEmail("o'neil_x-y!#$%&*/=?^`{|}~@sub.example.co.uk")).toBe("o'neil_x-y!#$%&*/=?^`{|}~@sub.example.co.uk");
		expect(normalizeEmail('a@b.co')).toBe('a@b.co');
		expect(normalizeEmail('ana@123.example.com')).toBe('ana@123.example.com');
	});

	it('accepts internationalized domains, in punycode or typed in Unicode (stored as punycode)', () => {
		expect(normalizeEmail('ana@example.xn--p1ai')).toBe('ana@example.xn--p1ai');
		expect(normalizeEmail('ana@пример.рф')).toBe('ana@xn--e1afmkfd.xn--p1ai');
		expect(normalizeEmail('Ana@BÜCHER.de')).toBe('ana@xn--bcher-kva.de');
		expect(normalizeEmail('ana@例子。广告')).toBe('ana@xn--fsqu00a.xn--4rr70v');
	});

	it('refuses dots in the wrong places', () => {
		for (const email of ['ana..b@example.com', '.ana@example.com', 'ana.@example.com', 'ana@example..com', 'ana@.example.com'])
			expect(normalizeEmail(email), email).toBeNull();
		expect(normalizeEmail('ana@example.com.')).toBeNull();
		expect(normalizeEmail('ana@bücher..de')).toBeNull();
	});

	it('keeps the length limits: local part 64, the whole address 254', () => {
		const label = 'a'.repeat(63);
		expect(normalizeEmail(`${'a'.repeat(64)}@example.com`)).toBe(`${'a'.repeat(64)}@example.com`);
		expect(normalizeEmail(`${'a'.repeat(65)}@example.com`)).toBeNull();
		const domain = `${label}.${label}.${label}.${'a'.repeat(55)}.com`;
		expect(normalizeEmail(`ab@${domain}`)).toHaveLength(254);
		expect(normalizeEmail(`abc@${domain}`)).toBeNull();
		expect(normalizeEmail(`a@${'b'.repeat(64)}.com`)).toBeNull();
		// a Unicode domain short as typed but past the limit as punycode
		const long = Array.from({ length: 7 }, () => 'bücher'.repeat(5)).join('.');
		expect(`a@${long}.de`.length).toBeLessThan(254);
		expect(normalizeEmail(`a@${long}.de`)).toBeNull();
		expect(normalizeEmail(`a@${'ü'.repeat(70)}.de`)).toBeNull();
	});

	it('refuses spaces, brackets, quoting, a second @ and non-ASCII local parts', () => {
		for (const email of [
			'ana silva@example.com',
			'ana@exa mple.com',
			'ana@exam\nple.com',
			'ana\t@example.com',
			'<ana@example.com>',
			'Ana <ana@example.com>',
			'"ana b"@example.com',
			'ana@b@example.com',
			'@example.com',
			'ana@',
			'ana',
			'',
			'josé@example.com',
			'ana@exa_mple.com',
			'ana@-example.com',
			'ana@example-.com',
			'ana@ex%41mple.com',
			'ana@bücher.de/x',
			'ana@bücher.de:25',
			'ana@bü\tcher.de',
			'ana@xn--a.bücher.de',
		])
			expect(normalizeEmail(email), email).toBeNull();
		expect(normalizeEmail(null)).toBeNull();
		expect(normalizeEmail(42)).toBeNull();
	});

	it('refuses single-label domains, IP addresses, domain literals and one-letter top-level labels', () => {
		for (const email of ['ana@localhost', 'ana@192.168.0.1', 'ana@[192.168.0.1]', 'ana@example.c', 'ana@１２７.０.０.１'])
			expect(normalizeEmail(email), email).toBeNull();
	});

	it('tells whether a value is already a stored address', () => {
		expect(isEmailAddress('ana@example.xn--p1ai')).toBe(true);
		expect(isEmailAddress('Ana@example.com')).toBe(false);
		expect(isEmailAddress(' ana@example.com')).toBe(false);
		expect(isEmailAddress('ana@bücher.de')).toBe(false);
		expect(isEmailAddress('ana..b@example.com')).toBe(false);
		expect(isEmailAddress(undefined)).toBe(false);
	});
});
