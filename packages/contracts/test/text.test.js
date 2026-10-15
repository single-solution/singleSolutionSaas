import { describe, expect, it } from 'vitest';
import { escapeHtml } from '../src/text.js';

describe('escapeHtml', () => {
	it('escapes the five characters HTML gives a meaning, as decimal references', () => {
		expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&#60;a href=&#34;x&#34;&#62;&#39;&#38;&#39;&#60;/a&#62;');
		expect(escapeHtml('plain text, café ✓')).toBe('plain text, café ✓');
		expect(escapeHtml('&amp;')).toBe('&#38;amp;');
	});

	it('writes null and undefined as nothing, other values as their text', () => {
		expect(escapeHtml(null)).toBe('');
		expect(escapeHtml(undefined)).toBe('');
		expect(escapeHtml(0)).toBe('0');
		expect(escapeHtml(false)).toBe('false');
	});
});
