/**
 * The merchant's cancel and failed-delivery reasons (fixed-choices E19): the list check and the reason a move takes.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_CANCEL_REASONS, DEFAULT_DELIVERY_FAILURE_REASONS, checkReasons, reasonOf } from '../core/order-reasons.js';

describe('order reasons', () => {
	it('checks a list: keys once, names, countsAgainst true or false, checkout’s own keys reserved', () => {
		expect(checkReasons(DEFAULT_CANCEL_REASONS)).toMatchObject({ ok: true });
		expect(checkReasons(DEFAULT_DELIVERY_FAILURE_REASONS)).toMatchObject({ ok: true });
		expect(checkReasons([{ key: 'late', label: ' Too late ' }])).toEqual({
			ok: true,
			value: [{ key: 'late', label: 'Too late', countsAgainst: false }],
		});
		expect(checkReasons({})).toMatchObject({ ok: false });
		expect(checkReasons([{ key: 'expired', label: 'Expired' }])).toMatchObject({
			ok: false,
			errors: [{ path: '/value/0/key' }],
		});
		expect(checkReasons([{ key: 'a', label: 'A', countsAgainst: 'yes' }])).toMatchObject({
			errors: [{ path: '/value/0/countsAgainst' }],
		});
		expect(
			checkReasons([
				{ key: 'a', label: 'A' },
				{ key: 'a', label: 'B' },
			]),
		).toMatchObject({ errors: [{ path: '/value/1/key' }] });
		expect(checkReasons(Array.from({ length: 31 }, (_, n) => ({ key: `r${n}`, label: 'R' })))).toMatchObject({ ok: false });
	});

	it('takes a reason of the list; none is none for a cancel and the first for a package that came back', () => {
		expect(reasonOf('rto', DEFAULT_DELIVERY_FAILURE_REASONS, { fallbackFirst: true })).toMatchObject({
			ok: true,
			reason: { key: 'rto', countsAgainst: true },
		});
		expect(reasonOf(undefined, DEFAULT_DELIVERY_FAILURE_REASONS, { fallbackFirst: true })).toMatchObject({
			reason: { key: 'rto' },
		});
		expect(reasonOf('', DEFAULT_CANCEL_REASONS, { fallbackFirst: false })).toEqual({ ok: true, reason: null });
		expect(reasonOf('lost', DEFAULT_CANCEL_REASONS, { fallbackFirst: false })).toEqual({ ok: false });
	});
});
