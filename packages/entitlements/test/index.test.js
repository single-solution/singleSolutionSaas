import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';
import { MILLICREDITS_PER_CREDIT, assertMillicredits, isMillicredits, toCredits, toMillicredits } from '../src/units.js';
import { deepEqual, sha256Hex, stableStringify } from '../src/hash.js';
import { HOUR_MS, ceilHour, floorHour, isoHour, isoInstant, toMs } from '../src/time.js';

describe('public API', () => {
	it('exports only the hourly charge helpers', () => {
		expect(Object.keys(api).sort()).toEqual(
			[
				'HOUR_MS',
				'MILLICREDITS_PER_CREDIT',
				'assertMillicredits',
				'ceilHour',
				'deepEqual',
				'floorHour',
				'isMillicredits',
				'isoHour',
				'isoInstant',
				'sha256Hex',
				'stableStringify',
				'toCredits',
				'toMillicredits',
				'toMs',
			].sort(),
		);
	});
});

describe('units', () => {
	it('converts credits to integer millicredits and back', () => {
		expect(MILLICREDITS_PER_CREDIT).toBe(1000);
		expect(toMillicredits(1)).toBe(1000);
		expect(toMillicredits(0.25)).toBe(250);
		expect(toMillicredits(0.001)).toBe(1);
		expect(toMillicredits(1.1)).toBe(1100);
		expect(toMillicredits(0)).toBe(0);
		expect(toCredits(1250)).toBe(1.25);
	});

	it('rejects amounts that are not whole millicredits', () => {
		expect(() => toMillicredits(0.0001)).toThrow(RangeError);
		expect(() => toMillicredits(-1)).toThrow(RangeError);
		expect(() => toMillicredits(Number.NaN)).toThrow(RangeError);
		expect(() => toMillicredits(Number.POSITIVE_INFINITY)).toThrow(RangeError);
		expect(() => toMillicredits(/** @type {never} */ ('1'))).toThrow(RangeError);
		expect(() => toMillicredits(Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
	});

	it('checks millicredit amounts', () => {
		expect(isMillicredits(0)).toBe(true);
		expect(isMillicredits(5)).toBe(true);
		expect(isMillicredits(-1)).toBe(false);
		expect(isMillicredits(1.5)).toBe(false);
		expect(isMillicredits('5')).toBe(false);
		expect(assertMillicredits(5)).toBe(5);
		expect(() => assertMillicredits(1.5)).toThrow('amount must be a non-negative integer');
		expect(() => assertMillicredits(-2, 'price')).toThrow('price must be a non-negative integer');
	});
});

describe('UTC hours', () => {
	it('normalises instants', () => {
		expect(toMs(5.7)).toBe(5);
		expect(toMs(new Date(5))).toBe(5);
		expect(toMs('1970-01-01T00:00:01Z')).toBe(1000);
		expect(() => toMs('nope')).toThrow('instant is not a valid instant');
		expect(() => toMs(Number.NaN, 'from')).toThrow('from is not a valid instant');
		expect(() => toMs(/** @type {never} */ (null))).toThrow(RangeError);
	});

	it('rounds to whole hours and formats them', () => {
		expect(HOUR_MS).toBe(3_600_000);
		expect(floorHour(HOUR_MS + 1)).toBe(HOUR_MS);
		expect(floorHour(HOUR_MS)).toBe(HOUR_MS);
		expect(ceilHour(1)).toBe(HOUR_MS);
		expect(ceilHour(HOUR_MS)).toBe(HOUR_MS);
		expect(isoHour(HOUR_MS)).toBe('1970-01-01T01:00:00Z');
		expect(isoInstant(0)).toBe('1970-01-01T00:00:00Z');
		expect(isoInstant(1)).toBe('1970-01-01T00:00:00.001Z');
	});
});

describe('hash', () => {
	it('serialises with sorted keys', () => {
		expect(stableStringify({ b: 1, a: [2, { d: undefined, c: 3 }] })).toBe('{"a":[2,{"c":3}],"b":1}');
		expect(stableStringify(undefined)).toBe('null');
		expect(stableStringify(null)).toBe('null');
		expect(stableStringify('x')).toBe('"x"');
		expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
		expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
	});

	it('hashes UTF-8 text with SHA-256', () => {
		expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
		expect(sha256Hex(stableStringify({ b: 1, a: 2 }))).toBe(sha256Hex('{"a":2,"b":1}'));
	});
});
