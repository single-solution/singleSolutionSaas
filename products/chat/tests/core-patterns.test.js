/**
 * The merchant's own redaction patterns (C14): the safe subset, its refusals, and time that stays linear for patterns
 * that hang a backtracking engine.
 */
import { describe, expect, it } from 'vitest';
import { PATTERN_LIMITS, compilePattern, replacePattern } from '../core/patterns.js';

/** @param {string} source @param {string} text @param {string} [label] */
const hide = (source, text, label = '[x]') => {
	const compiled = compilePattern(source);
	if (!compiled.ok) throw new Error(compiled.error);
	return replacePattern(text, compiled.program, () => label);
};

describe('redaction patterns (C14)', () => {
	it('matches the safe subset, leftmost and as long as it goes, case aside', () => {
		expect(hide('\\d{5}-\\d{7}-\\d', 'ID 35202-1234567-1 here')).toBe('ID [x] here');
		expect(hide('[A-Z]{2}\\d{6}', 'passport ab123456.')).toBe('passport [x].');
		expect(hide('\\bTAX-?\\d{4,6}\\b', 'tax123456 and TAX-1234 and TAX-1234567')).toBe('[x] and [x] and TAX-1234567');
		expect(hide('(?:0x)?[0-9a-f]{40}', `wallet 0x${'ab'.repeat(20)} ok`)).toBe('wallet [x] ok');
		expect(hide('cat|category', 'category')).toBe('[x]');
		expect(hide('a*', 'baaa')).toBe('b[x]');
		expect(hide('^hi', 'hi hi')).toBe('[x] hi');
		expect(hide('end$', 'end end')).toBe('end [x]');
		expect(hide('\\p{L}+\\d', 'été9 x')).toBe('[x] x');
		expect(hide('a.c', 'abc a\nc')).toBe('[x] a\nc');
		expect(hide('\\+\\d+', 'call +4412')).toBe('call [x]');
		expect(hide('\\bوطن\\b', 'هذا وطن جميل')).toBe('هذا [x] جميل');
	});

	it('refuses what could be slow or is not in the subset', () => {
		const error = (/** @type {unknown} */ source) => {
			const compiled = compilePattern(source);
			return compiled.ok ? null : compiled.error;
		};
		expect(error('')).toBe('Write a pattern.');
		expect(error(5)).toBe('Write a pattern.');
		expect(error('a'.repeat(PATTERN_LIMITS.length + 1))).toBe('A pattern is up to 200 characters.');
		expect(error('(?=a)b')).toContain('Look-arounds');
		expect(error('(?<n>a)')).toContain('Look-arounds');
		expect(error('(a)\\1')).toBe('Back-references are not taken.');
		expect(error('a{101}')).toBe('A repeat counts at most 100.');
		expect(error('a{5,2}')).toBe('In {n,m}, n is at most m.');
		expect(error('(ab')).toBe('A group is not closed with ).');
		expect(error('ab)')).toBe('A ) has no (.');
		expect(error('[ab')).toBe('A [ is not closed with ].');
		expect(error('*a')).toContain('repeats nothing');
		expect(error('^*')).toBe('An anchor cannot repeat.');
		expect(error('\\q')).toBe('\\q is not taken.');
		expect(error('((a{100}){100}){100}')).toBe('The pattern is too complex: use fewer or smaller repeats.');
	});

	it('stays fast on patterns that hang a backtracking engine', () => {
		const text = `${'a'.repeat(4000)}!`;
		const started = Date.now();
		for (const source of ['(a+)+$', '(a|a)*b', '(a*)*b', '(?:a|aa)+c', '(\\w+\\s?)+x', 'a*a*a*a*a*b'])
			expect(hide(source, text)).toBe(text);
		// a pattern that reads to the end of the text for every match stops at its step budget, keeping what it found
		const many = hide('x.*y|x', 'x'.repeat(20_000));
		expect(many.startsWith('[x][x]')).toBe(true);
		expect(Date.now() - started).toBeLessThan(5000);
	});
});
