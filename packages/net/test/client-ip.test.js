import { describe, expect, it } from 'vitest';
import { clientIpOf } from '../src/index.js';

/** @param {Record<string, string>} headers */
const of = (headers) => clientIpOf(new Headers(headers));

describe('clientIpOf', () => {
	it('takes the hosting platform header first, whatever X-Forwarded-For says', () => {
		expect(of({ 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1, 192.0.2.4' })).toBe('203.0.113.9');
		expect(of({ 'x-real-ip': ' 2001:db8::7 ' })).toBe('2001:db8::7');
	});

	it('else takes the LAST X-Forwarded-For hop, never the first value the caller wrote', () => {
		expect(of({ 'x-forwarded-for': '192.0.2.4' })).toBe('192.0.2.4');
		expect(of({ 'x-forwarded-for': '10.1.1.1, 10.2.2.2 ,203.0.113.9' })).toBe('203.0.113.9');
		// a caller's own first value does not change the answer
		expect(of({ 'x-forwarded-for': 'attacker-1, 203.0.113.9' })).toBe(of({ 'x-forwarded-for': 'attacker-2, 203.0.113.9' }));
	});

	it('is null when nothing usable is present: an empty, missing or non-address value is never a bucket of its own', () => {
		expect(of({})).toBeNull();
		expect(of({ 'x-forwarded-for': '' })).toBeNull();
		expect(of({ 'x-forwarded-for': '203.0.113.9, not-an-address' })).toBeNull();
		expect(of({ 'x-real-ip': 'not-an-address', 'x-forwarded-for': '203.0.113.9' })).toBe('203.0.113.9');
	});
});
