import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { constantTimeEqual, hmacSha256Hex, randomToken, sha256Hex } from '../src/index.js';
import { randomId } from '../src/encoding.js';

/** @param {number} length */
const counting = (length) => Uint8Array.from({ length }, (_, i) => i);

describe('sha256Hex', () => {
	it('hashes text and bytes to lower-case hex', () => {
		expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
		expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(sha256Hex('abc'));
		expect(sha256Hex('münchen')).toBe(createHash('sha256').update('münchen', 'utf8').digest('hex'));
	});
});

describe('hmacSha256Hex', () => {
	it('is the hex HMAC-SHA256 of the data under the key', () => {
		expect(hmacSha256Hex('key', 'The quick brown fox jumps over the lazy dog')).toBe(
			'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
		);
		expect(hmacSha256Hex(Buffer.from('key'), 'x')).toBe(createHmac('sha256', 'key').update('x').digest('hex'));
	});
});

describe('constantTimeEqual', () => {
	it('compares texts and bytes of any length', () => {
		expect(constantTimeEqual('secret', 'secret')).toBe(true);
		expect(constantTimeEqual('secret', 'secreT')).toBe(false);
		expect(constantTimeEqual('secret', 'secret-longer')).toBe(false);
		expect(constantTimeEqual('', '')).toBe(true);
		expect(constantTimeEqual(Buffer.from('abc'), 'abc')).toBe(true);
	});

	it('is never equal for anything that is not text or bytes', () => {
		for (const [a, b] of [
			[undefined, undefined],
			[null, null],
			['1', 1],
			[1, '1'],
			[{}, '{}'],
		])
			expect(constantTimeEqual(a, b)).toBe(false);
	});
});

describe('randomToken', () => {
	it('is base64url of the random bytes, 32 by default', () => {
		expect(randomToken(3, counting)).toBe('AAEC');
		expect(randomToken(undefined, counting)).toBe(Buffer.from(counting(32)).toString('base64url'));
		expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(randomToken()).not.toBe(randomToken());
		expect(randomId(counting)).toBe(randomToken(16, counting));
	});

	it('refuses a byte count that is not a positive integer', () => {
		for (const bytes of [0, -1, 1.5, Number.NaN, /** @type {any} */ ('8')])
			expect(() => randomToken(bytes, counting)).toThrow(TypeError);
	});
});
