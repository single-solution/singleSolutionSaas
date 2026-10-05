import { describe, expect, it } from 'vitest';
import { spendCapDecision, spendCapState } from '../src/spend.js';
import { deepFreeze } from './fixtures.js';

const entries = deepFreeze([
	{ at: '2026-10-01T00:30:00Z', amount: 4000, websiteId: 'w1', merchantId: 'm1' },
	{ at: '2026-10-01T10:00:00Z', amount: 3000, websiteId: 'w1', merchantId: 'm1' },
	{ at: '2026-10-01T11:00:00Z', amount: 2500, websiteId: 'w2', merchantId: 'm1' },
	{ at: '2026-09-30T23:00:00Z', amount: 9000, websiteId: 'w1', merchantId: 'm1' },
	{ at: '2026-10-01T12:00:00Z', amount: 9000, websiteId: 'w9', merchantId: 'm9' },
]);
const now = '2026-10-01T12:30:00Z';

describe('spendCapState', () => {
	it('sums scoped spend in the current day', () => {
		const state = spendCapState({ cap: { scope: 'website', scopeId: 'w1', window: 'day', limit: 10_000 }, entries, now });
		expect(state).toMatchObject({
			key: 'website:w1:day:2026-10-01',
			spent: 7000,
			remaining: 3000,
			reached: false,
			wouldExceed: false,
			periodStart: '2026-10-01T00:00:00Z',
			periodEnd: '2026-10-02T00:00:00Z',
		});
	});

	it('flags would-exceed for the upcoming charge and reached at the limit', () => {
		const cap = /** @type {const} */ ({ scope: 'website', scopeId: 'w1', window: 'day', limit: 7000 });
		expect(spendCapState({ cap, entries, now })).toMatchObject({ reached: true, wouldExceed: true, remaining: 0 });
		const roomy = { ...cap, limit: 8000 };
		expect(spendCapState({ cap: roomy, entries, now, upcoming: 1000 })).toMatchObject({ reached: false, wouldExceed: false });
		expect(spendCapState({ cap: roomy, entries, now, upcoming: 1001 })).toMatchObject({ reached: false, wouldExceed: true });
	});

	it('uses merchant scope, monthly windows and the cap time zone', () => {
		const month = spendCapState({ cap: { scope: 'merchant', scopeId: 'm1', window: 'month', limit: 100_000 }, entries, now });
		expect(month).toMatchObject({ spent: 9500, key: 'merchant:m1:month:2026-10' });
		// In Karachi (+05) the 2026-09-30T23:00Z entry is already October 1st.
		const karachi = spendCapState({
			cap: { scope: 'website', scopeId: 'w1', window: 'day', limit: 1, timeZone: 'Asia/Karachi' },
			entries,
			now,
		});
		expect(karachi.spent).toBe(16_000);
		expect(() =>
			spendCapState({
				cap: { scope: 'website', scopeId: 'w1', window: /** @type {never} */ ('week'), limit: 1 },
				entries,
				now,
			}),
		).toThrow(RangeError);
		expect(() => spendCapState({ cap: { scope: 'website', scopeId: 'w1', window: 'day', limit: -1 }, entries, now })).toThrow(
			RangeError,
		);
	});
});

describe('spendCapDecision', () => {
	it('pauses when any cap blocks and resumes at the latest blocking period end', () => {
		const decision = spendCapDecision({
			caps: [
				{ scope: 'website', scopeId: 'w1', window: 'day', limit: 7500 },
				{ scope: 'merchant', scopeId: 'm1', window: 'month', limit: 9000 },
				{ scope: 'website', scopeId: 'w2', window: 'day', limit: 100_000 },
			],
			entries,
			now,
			upcoming: 600,
		});
		expect(decision.shouldPause).toBe(true);
		expect(decision.blocking.map((s) => s.key)).toEqual(['merchant:m1:month:2026-10', 'website:w1:day:2026-10-01']);
		expect(decision.resumeAt).toBe('2026-11-01T00:00:00Z');
		expect(decision.states).toHaveLength(3);
	});

	it('does not pause when all caps have room', () => {
		expect(
			spendCapDecision({ caps: [{ scope: 'website', scopeId: 'w2', window: 'day', limit: 100_000 }], entries, now }),
		).toMatchObject({
			shouldPause: false,
			blocking: [],
			resumeAt: null,
		});
		expect(spendCapDecision({ caps: [], entries, now }).shouldPause).toBe(false);
	});
});
