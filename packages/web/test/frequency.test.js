import { describe, expect, it } from 'vitest';
import { createFrequency } from '../src/frequency.js';
import { parseDuration } from '../src/util.js';
import { WEBSITE_ID, brokenStorage, memoryStorage } from './helpers.js';

/** @param {{ storage?: any, session?: string }} [options] */
const setup = ({ storage = memoryStorage(), session = 'ses_a' } = {}) => {
	const clock = { now: Date.parse('2026-10-01T00:00:00Z'), session };
	const frequency = createFrequency({ storage, websiteId: WEBSITE_ID, now: () => clock.now, sessionId: () => clock.session });
	return { frequency, clock, storage };
};

describe('frequency caps', () => {
	it('allows everything without a rule', () => {
		const { frequency } = setup();
		frequency.recordShow('bar');
		expect(frequency.allowed('bar', undefined)).toBe(true);
	});

	it('caps per session and resets with a new session', () => {
		const { frequency, clock } = setup();
		const rule = { maxPerSession: 2 };
		frequency.recordShow('bar');
		expect(frequency.allowed('bar', rule)).toBe(true);
		frequency.recordShow('bar');
		expect(frequency.allowed('bar', rule)).toBe(false);
		clock.session = 'ses_b';
		expect(frequency.allowed('bar', rule)).toBe(true);
		frequency.recordShow('bar');
		expect(frequency.allowed('bar', { maxPerSession: 1 })).toBe(false);
	});

	it('caps per rolling day and per visitor', () => {
		const { frequency, clock } = setup();
		frequency.recordShow('bar');
		frequency.recordShow('bar');
		expect(frequency.allowed('bar', { maxPerDay: 2 })).toBe(false);
		clock.now += 24 * 3600_000;
		expect(frequency.allowed('bar', { maxPerDay: 2 })).toBe(true);
		expect(frequency.allowed('bar', { maxPerVisitor: 2 })).toBe(false);
		expect(frequency.allowed('bar', { maxPerVisitor: 3 })).toBe(true);
	});

	it('honours cooldown and dismiss memory durations', () => {
		const { frequency, clock } = setup();
		frequency.recordShow('bar');
		expect(frequency.allowed('bar', { cooldown: 'PT1H' })).toBe(false);
		clock.now += 3600_000;
		expect(frequency.allowed('bar', { cooldown: 'PT1H' })).toBe(true);
		frequency.recordDismiss('bar');
		expect(frequency.allowed('bar', { dismissMemory: 'P7D' })).toBe(false);
		clock.now += 7 * 864e5;
		expect(frequency.allowed('bar', { dismissMemory: 'P7D' })).toBe(true);
		expect(frequency.allowed('bar', { cooldown: 'garbage' })).toBe(true);
	});

	it('persists across instances and isolates elements', () => {
		const storage = memoryStorage();
		setup({ storage }).frequency.recordShow('bar');
		const { frequency } = setup({ storage });
		expect(frequency.allowed('bar', { maxPerVisitor: 1 })).toBe(false);
		expect(frequency.allowed('other', { maxPerVisitor: 1 })).toBe(true);
		expect(storage.json(`ss:${WEBSITE_ID}:fq:bar`).total).toBe(1);
	});

	it('falls back to memory when storage is unavailable or corrupt', () => {
		const { frequency } = setup({ storage: brokenStorage() });
		frequency.recordShow('bar');
		expect(frequency.allowed('bar', { maxPerVisitor: 1 })).toBe(false);
		const storage = memoryStorage();
		storage.setItem(`ss:${WEBSITE_ID}:fq:bar`, '{"shows":"no"}');
		expect(setup({ storage }).frequency.allowed('bar', { maxPerVisitor: 1 })).toBe(true);
	});
});

describe('parseDuration', () => {
	it.each([
		['PT30M', 30 * 60_000],
		['P1D', 864e5],
		['P1W', 7 * 864e5],
		['P1Y', 365 * 864e5],
		['P1M', 30 * 864e5],
		['P1DT2H3M4.5S', 864e5 + 2 * 36e5 + 3 * 6e4 + 4500],
		['PT0S', 0],
	])('%s', (input, ms) => expect(parseDuration(input)).toBe(ms));

	it.each([['P'], ['PT'], ['P1DT'], ['1D'], ['PXD'], [''], [5]])('rejects %j', (input) =>
		expect(parseDuration(input)).toBeUndefined(),
	);
});
