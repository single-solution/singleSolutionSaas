import { describe, expect, it } from 'vitest';
import { spendCapDecision, spendCapState } from '../src/spend.js';
import { deepFreeze } from './fixtures.js';

const entries = deepFreeze([
	{ at: '2026-10-01T00:30:00Z', amount: 4000 },
	{ at: '2026-10-15T10:00:00Z', amount: 3000 },
	{ at: '2026-09-30T23:59:59Z', amount: 9000 },
	{ at: '2026-11-01T00:00:00Z', amount: 9000 },
]);
const now = '2026-10-20T12:30:00Z';

describe('spendCapState', () => {
	it('sums the spend of the current UTC calendar month', () => {
		expect(spendCapState({ cap: { limit: 10_000 }, entries, now })).toEqual({
			limit: 10_000,
			spent: 7000,
			remaining: 3000,
			reached: false,
			wouldExceed: false,
			periodKey: '2026-10',
			periodStart: '2026-10-01T00:00:00Z',
			periodEnd: '2026-11-01T00:00:00Z',
		});
	});

	it('flags would-exceed for the upcoming charge and reached at the limit', () => {
		expect(spendCapState({ cap: { limit: 7000 }, entries, now })).toMatchObject({
			reached: true,
			wouldExceed: true,
			remaining: 0,
		});
		const roomy = { limit: 8000 };
		expect(spendCapState({ cap: roomy, entries, now, upcoming: 1000 })).toMatchObject({ reached: false, wouldExceed: false });
		expect(spendCapState({ cap: roomy, entries, now, upcoming: 1001 })).toMatchObject({ reached: false, wouldExceed: true });
	});

	it('rolls over in December and refuses non-integer amounts', () => {
		expect(spendCapState({ cap: { limit: 1 }, entries: [], now: '2026-12-31T23:00:00Z' })).toMatchObject({
			periodKey: '2026-12',
			periodEnd: '2027-01-01T00:00:00Z',
		});
		expect(() => spendCapState({ cap: { limit: -1 }, entries, now })).toThrow(RangeError);
		expect(() => spendCapState({ cap: { limit: 1 }, entries, now, upcoming: 0.5 })).toThrow(RangeError);
	});
});

describe('spendCapDecision', () => {
	it('pauses until the month ends when the cap would be exceeded', () => {
		const decision = spendCapDecision({ cap: { limit: 7500 }, entries, now, upcoming: 600 });
		expect(decision.shouldPause).toBe(true);
		expect(decision.resumeAt).toBe('2026-11-01T00:00:00Z');
		expect(decision.state).toMatchObject({ spent: 7000, wouldExceed: true });
	});

	it('does not pause with room or without a cap', () => {
		expect(spendCapDecision({ cap: { limit: 100_000 }, entries, now })).toMatchObject({ shouldPause: false, resumeAt: null });
		expect(spendCapDecision({ cap: null, entries, now })).toEqual({ shouldPause: false, resumeAt: null, state: null });
	});
});
