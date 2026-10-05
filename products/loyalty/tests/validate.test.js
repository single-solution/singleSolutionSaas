import { describe, expect, it } from 'vitest';
import {
	checkFields,
	idCheck,
	validateActivity,
	validateAdjustment,
	validateConfirm,
	validateCustomer,
	validateEarn,
	validateQuote,
	validateRedeem,
	validateReferral,
} from '../core/validate.js';

const codes = (/** @type {any} */ problems) => problems.map((/** @type {any} */ p) => `${p.path}:${p.code}`);

describe('request validation', () => {
	it('rejects non-objects and unknown fields', () => {
		expect(checkFields(null, {}, [])).toEqual([{ path: '', code: 'body_invalid' }]);
		expect(checkFields([], {}, [])).toEqual([{ path: '', code: 'body_invalid' }]);
		expect(codes(validateCustomer({ customerId: 'cus_1', extra: 1 }))).toEqual(['/extra:unknown_field']);
		expect(idCheck('a b')).toBe('id_invalid');
		expect(idCheck('x'.repeat(129))).toBe('id_invalid');
	});
	it('earn', () => {
		expect(
			validateEarn({ customerId: 'cus_1', points: 25, reason: 'welcome', reference: 'ref-1' }, { maxPoints: 100 }),
		).toEqual([]);
		expect(codes(validateEarn({ points: 101, reason: ' ' }, { maxPoints: 100 }))).toEqual([
			'/customerId:required',
			'/points:integer_invalid',
			'/reason:text_invalid',
		]);
	});
	it('activities', () => {
		expect(validateActivity({ type: 'custom.review_written@1', customerId: 'c', data: { a: 1 }, id: 'x' })).toEqual([]);
		expect(codes(validateActivity({ type: 'order.completed@1', customerId: 'c', data: [] }))).toEqual([
			'/type:type_invalid',
			'/data:object_invalid',
		]);
	});
	it('quote and redeem', () => {
		expect(validateQuote({ customerId: 'c', amount: 100, currency: 'USD' })).toEqual([]);
		expect(codes(validateQuote({ customerId: 'c', amount: -1, currency: 'usd', discount: 1.5 }))).toEqual([
			'/amount:integer_invalid',
			'/currency:currency_invalid',
			'/discount:integer_invalid',
		]);
		expect(validateRedeem({ customerId: 'c', points: 5, amount: 100, currency: 'EUR', orderId: 'o', reference: 'r' })).toEqual(
			[],
		);
		expect(codes(validateRedeem({ customerId: 'c', points: 0, amount: 1, currency: 'EUR' }))).toEqual([
			'/points:integer_invalid',
		]);
		expect(validateConfirm({ orderId: 'o' })).toEqual([]);
	});
	it('adjustments', () => {
		const rules = { maxPoints: 1000, reasons: ['goodwill'], requireNote: true };
		expect(validateAdjustment({ customerId: 'c', points: -5, reason: 'goodwill', note: 'n' }, rules)).toEqual([]);
		expect(codes(validateAdjustment({ customerId: 'c', points: 0, reason: 'x' }, rules))).toEqual([
			'/points:points_invalid',
			'/reason:reason_invalid',
			'/note:required',
		]);
		expect(validateAdjustment({ customerId: 'c', points: 1001, reason: 'goodwill' }, { ...rules, requireNote: false })).toEqual(
			[{ path: '/points', code: 'points_invalid' }],
		);
	});
	it('referrals', () => {
		expect(validateReferral({ code: 'REF-7K2M', customerId: 'c' })).toEqual([]);
		expect(codes(validateReferral({ code: 'x', customerId: 'c' }))).toEqual(['/code:code_invalid']);
	});
});
