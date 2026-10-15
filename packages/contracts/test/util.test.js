import { describe, expect, it } from 'vitest';
import { deepFreeze, isObject } from '../src/util.js';

describe('isObject', () => {
	it('is true for objects that are neither null nor arrays', () => {
		expect([{}, { a: 1 }, Object.create(null), new Date(0)].every(isObject)).toBe(true);
		expect([null, undefined, [], 'x', 1, true, () => {}].some(isObject)).toBe(false);
	});
});

describe('deepFreeze', () => {
	it('freezes a value all the way down and gives back the same reference', () => {
		const value = { a: { b: [1, { c: 2 }] } };
		expect(deepFreeze(value)).toBe(value);
		expect(Object.isFrozen(value.a.b[1])).toBe(true);
		expect(deepFreeze('text')).toBe('text');
		expect(deepFreeze(null)).toBeNull();
	});

	it('copes with values that refer to themselves and with typed arrays', () => {
		/** @type {Record<string, unknown>} */
		const looped = { name: 'loop' };
		looped.self = looped;
		expect(Object.isFrozen(deepFreeze(looped))).toBe(true);
		const withBytes = { bytes: new Uint8Array([1, 2]), view: new DataView(new ArrayBuffer(2)), list: [3] };
		deepFreeze(withBytes);
		expect(Object.isFrozen(withBytes) && Object.isFrozen(withBytes.list)).toBe(true);
		expect(Object.isFrozen(withBytes.bytes)).toBe(false);
	});
});
