import { describe, expect, it } from 'vitest';
import { DOCUMENT_RULES, checkPlacement, isTimeZone, validatePlacement } from '../src/index.js';
import { placement } from './fixtures.js';
import { expectProblem, expectRule } from './helpers.js';

describe('placement', () => {
	it('accepts full and empty placements', () => {
		expect(validatePlacement(placement()).ok).toBe(true);
		expect(validatePlacement({}).ok).toBe(true);
		expect(
			validatePlacement({
				triggers: [
					{ type: 'load', delayMs: 500 },
					{ type: 'idle', afterMs: 3000 },
					{ type: 'event', event: 'apply_box.applied' },
				],
			}).ok,
		).toBe(true);
	});

	/** @type {Array<[string, (p: any) => unknown, string, string | undefined]>} */
	const invalid = [
		['relative path glob', (p) => (p.paths.include = ['products/*']), '/paths/include/0', 'pattern'],
		['empty paths object', (p) => (p.paths = {}), '/paths', 'minProperties'],
		['unknown device', (p) => (p.devices = ['tv']), '/devices/0', 'enum'],
		['bad mount position', (p) => (p.selectors[0].position = 'inside'), '/selectors/0/position', 'enum'],
		['schedule without timezone', (p) => delete p.schedule.timezone, '/schedule/timezone', 'required'],
		['bad time', (p) => (p.schedule.windows[0].start = '24:00'), '/schedule/windows/0/start', 'pattern'],
		['bad weekday', (p) => (p.schedule.windows[0].days = ['monday']), '/schedule/windows/0/days/0', 'enum'],
		['unknown trigger', (p) => (p.triggers = [{ type: 'hover' }]), '/triggers/0', 'oneOf'],
		['scroll over 100', (p) => (p.triggers = [{ type: 'scroll', percent: 150 }]), '/triggers/0', 'oneOf'],
		['frequency cap zero', (p) => (p.frequency.maxPerSession = 0), '/frequency/maxPerSession', 'minimum'],
		['bad cooldown', (p) => (p.frequency.cooldown = '1 day'), '/frequency/cooldown', 'format'],
		['empty audience', (p) => (p.audience = ''), '/audience', 'minLength'],
	];
	it.each(invalid)('rejects %s', (_name, mutate, path, keyword) => {
		const p = placement();
		mutate(p);
		expectProblem(validatePlacement(p), path, keyword);
	});

	it('checks timezone, range and windows semantically', () => {
		/** @param {(p: any) => void} mutate */
		const check = (mutate) => {
			const p = placement();
			mutate(p);
			return checkPlacement(p);
		};
		expect(check(() => {})).toEqual([]);
		expect(checkPlacement({})).toEqual([]);
		expectRule(
			check((p) => (p.schedule.timezone = 'Mars/Olympus')),
			DOCUMENT_RULES.timezone,
			'/schedule/timezone',
		);
		expectRule(
			check((p) => (p.schedule.until = p.schedule.from)),
			DOCUMENT_RULES.scheduleRange,
			'/schedule/until',
		);
		expectRule(
			check((p) => (p.schedule.from = '2026-02-31T00:00:00Z')),
			DOCUMENT_RULES.scheduleRange,
			'/schedule/from',
		);
		expectRule(
			check((p) => (p.schedule.windows[0].end = '22:00')),
			DOCUMENT_RULES.timeWindow,
			'/schedule/windows/0',
		);
		const p = placement();
		p.schedule.timezone = 'Nowhere/Land';
		expectProblem(validatePlacement(p), '/schedule/timezone', DOCUMENT_RULES.timezone);
	});

	it('recognises IANA zones', () => {
		expect(isTimeZone('UTC')).toBe(true);
		expect(isTimeZone('America/Sao_Paulo')).toBe(true);
		expect(isTimeZone('Invalid/Zone')).toBe(false);
	});
});
