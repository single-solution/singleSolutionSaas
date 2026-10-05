import { describe, expect, it } from 'vitest';
import { compile } from '@ss/rules';
import { validatePlacement } from '@ss/contracts';
import { evaluateAudience, evaluateAudienceProgram } from '../src/audience.js';
import { deviceOf, inSchedule, localTime, matchPath, matchPlacement, matchReferrer } from '../src/placement.js';

// 2026-10-02 is a Friday. 17:30Z = 22:30 in Asia/Karachi (UTC+5).
const FRI_1730Z = Date.parse('2026-10-02T17:30:00Z');
const SAT_2030Z = Date.parse('2026-10-03T20:30:00Z'); // Sun 01:30 Karachi
const SAT_0600Z = Date.parse('2026-10-03T06:00:00Z'); // Sat 11:00 Karachi

/** @param {Partial<import('../src/placement.js').PlacementEnv>} [overrides] @returns {import('../src/placement.js').PlacementEnv} */
const env = (overrides = {}) => ({
	path: '/products/phone-1',
	pageType: 'product',
	device: 'desktop',
	referrerHost: 'www.google.com',
	now: FRI_1730Z,
	consent: { necessary: true, analytics: true },
	hasSelector: (selector) => ['#pdp-actions', '.cart'].includes(selector),
	audience: evaluateAudience,
	audienceContext: { segments: ['vip'], page: { path: '/products/phone-1' }, device: 'desktop' },
	...overrides,
});

const KHI = 'Asia/Karachi';

/** @type {Array<[string, Record<string, any>, Partial<import('../src/placement.js').PlacementEnv>, true | string]>} */
const MATRIX = [
	// paths
	['empty placement matches everything', {}, {}, true],
	['exact path', { paths: { include: ['/products/phone-1'] } }, {}, true],
	['single-segment glob', { paths: { include: ['/products/*'] } }, {}, true],
	['single-segment glob does not cross /', { paths: { include: ['/products/*'] } }, { path: '/products/a/b' }, 'path'],
	['double-star glob crosses /', { paths: { include: ['/products/**'] } }, { path: '/products/a/b' }, true],
	['trailing slash is ignored', { paths: { include: ['/products/phone-1/'] } }, { path: '/products/phone-1/' }, true],
	['query string is ignored', { paths: { include: ['/cart'] } }, { path: '/cart?x=1#top' }, true],
	['root only', { paths: { include: ['/'] } }, { path: '/' }, true],
	['root does not match subpages', { paths: { include: ['/'] } }, {}, 'path'],
	['include miss', { paths: { include: ['/blog/**'] } }, {}, 'path'],
	['exclude wins over include', { paths: { include: ['/**'], exclude: ['/products/*'] } }, {}, 'path'],
	['exclude only, not excluded', { paths: { exclude: ['/checkout/**'] } }, {}, true],
	['exclude only, excluded', { paths: { exclude: ['/checkout/**'] } }, { path: '/checkout/pay' }, 'path'],
	['glob in the middle', { paths: { include: ['/*/phone-*'] } }, {}, true],
	// page types and devices
	['page type match', { pageTypes: ['product', 'collection'] }, {}, true],
	['page type miss', { pageTypes: ['collection'] }, {}, 'page_type'],
	['page type unknown on page', { pageTypes: ['product'] }, { pageType: undefined }, 'page_type'],
	['device match', { devices: ['desktop', 'tablet'] }, {}, true],
	['device miss', { devices: ['mobile'] }, {}, 'device'],
	['mobile device', { devices: ['mobile'] }, { device: 'mobile' }, true],
	// referrers
	['referrer exact', { referrers: { include: ['www.google.com'] } }, {}, true],
	['referrer wildcard subdomain', { referrers: { include: ['*.google.com'] } }, {}, true],
	['referrer wildcard excludes apex', { referrers: { include: ['*.google.com'] } }, { referrerHost: 'google.com' }, 'referrer'],
	[
		'referrer wildcard not a suffix trick',
		{ referrers: { include: ['*.google.com'] } },
		{ referrerHost: 'evilgoogle.com' },
		'referrer',
	],
	['referrer include needs a referrer', { referrers: { include: ['www.google.com'] } }, { referrerHost: undefined }, 'referrer'],
	['referrer excluded', { referrers: { exclude: ['*.google.com'] } }, {}, 'referrer'],
	['referrer exclude with no referrer', { referrers: { exclude: ['*.google.com'] } }, { referrerHost: undefined }, true],
	// schedule
	[
		'schedule from/until inside',
		{ schedule: { timezone: KHI, from: '2026-10-01T00:00:00Z', until: '2026-10-03T00:00:00Z' } },
		{},
		true,
	],
	['schedule before from', { schedule: { timezone: KHI, from: '2026-10-03T00:00:00Z' } }, {}, 'schedule'],
	['schedule until is exclusive', { schedule: { timezone: KHI, until: '2026-10-02T17:30:00Z' } }, {}, 'schedule'],
	[
		'window in local time',
		{ schedule: { timezone: KHI, windows: [{ days: ['fri'], start: '22:00', end: '23:00' }] } },
		{},
		true,
	],
	[
		'same window in UTC misses',
		{ schedule: { timezone: 'UTC', windows: [{ days: ['fri'], start: '22:00', end: '23:00' }] } },
		{},
		'schedule',
	],
	[
		'window wrong day',
		{ schedule: { timezone: KHI, windows: [{ days: ['sat'], start: '22:00', end: '23:00' }] } },
		{},
		'schedule',
	],
	['window without days', { schedule: { timezone: KHI, windows: [{ start: '09:00', end: '23:00' }] } }, {}, true],
	['window end is exclusive', { schedule: { timezone: KHI, windows: [{ start: '20:00', end: '22:30' }] } }, {}, 'schedule'],
	[
		'overnight window, evening part',
		{ schedule: { timezone: KHI, windows: [{ days: ['fri'], start: '22:00', end: '02:00' }] } },
		{},
		true,
	],
	[
		'overnight window belongs to its start day',
		{ schedule: { timezone: KHI, windows: [{ days: ['sat'], start: '22:00', end: '02:00' }] } },
		{ now: SAT_2030Z },
		true,
	],
	[
		'overnight window after-midnight part, wrong start day',
		{ schedule: { timezone: KHI, windows: [{ days: ['sun'], start: '22:00', end: '02:00' }] } },
		{ now: SAT_2030Z },
		'schedule',
	],
	[
		'weekend daytime',
		{ schedule: { timezone: KHI, windows: [{ days: ['sat', 'sun'], start: '10:00', end: '18:00' }] } },
		{ now: SAT_0600Z },
		true,
	],
	[
		'any of several windows',
		{
			schedule: {
				timezone: KHI,
				windows: [
					{ start: '01:00', end: '02:00' },
					{ start: '22:15', end: '22:45' },
				],
			},
		},
		{},
		true,
	],
	['unknown time zone fails closed', { schedule: { timezone: 'Mars/Olympus' } }, {}, 'schedule'],
	[
		'degenerate window never matches',
		{ schedule: { timezone: KHI, windows: [{ start: '22:30', end: '22:30' }] } },
		{},
		'schedule',
	],
	// consent
	['consent granted', { consent: ['analytics'] }, {}, true],
	['consent missing', { consent: ['analytics', 'marketing'] }, {}, 'consent'],
	['consent denied', { consent: ['analytics'] }, { consent: { necessary: true, analytics: false } }, 'consent'],
	// selectors
	['selector present', { selectors: [{ selector: '#missing' }, { selector: '#pdp-actions', position: 'after' }] }, {}, true],
	['selector absent', { selectors: [{ selector: '#missing' }] }, {}, 'selector'],
	[
		'selector check throwing',
		{ selectors: [{ selector: '###' }] },
		{
			hasSelector: () => {
				throw new SyntaxError('bad');
			},
		},
		'selector',
	],
	// audience
	['audience source true', { audience: "inSegment('vip') and device == 'desktop'" }, {}, true],
	['audience source false', { audience: "inSegment('wholesale')" }, {}, 'audience'],
	['audience uses the rule time zone', { audience: "between(now, '22:00', '23:00')" }, { timeZone: KHI }, true],
	[
		'audience defaults to the schedule zone',
		{ audience: "between(now, '22:00', '23:00')", schedule: { timezone: KHI } },
		{},
		true,
	],
	['audience compile error fails closed', { audience: 'order.total >' }, {}, 'audience'],
	['audience without evaluator fails closed', { audience: 'true' }, { audience: undefined }, 'audience'],
	[
		'audience evaluator throwing',
		{ audience: 'true' },
		{
			audience: () => {
				throw new Error('x');
			},
		},
		'audience',
	],
	['audience uses rules truthiness (empty string is falsy)', { audience: "''" }, {}, 'audience'],
	// combinations: the first failing check (cheapest first) is reported
	[
		'all dimensions match',
		{
			paths: { include: ['/products/*'] },
			devices: ['desktop'],
			consent: ['analytics'],
			pageTypes: ['product'],
			audience: "inSegment('vip')",
		},
		{},
		true,
	],
	['path reported before device', { paths: { include: ['/blog'] }, devices: ['mobile'] }, {}, 'path'],
	['consent reported before audience', { consent: ['marketing'], audience: 'false' }, {}, 'consent'],
];

describe('placement matrix', () => {
	it('has at least 40 cases, all of them contract-valid placements', () => {
		expect(MATRIX.length).toBeGreaterThanOrEqual(40);
		for (const [name, placement] of MATRIX) {
			if (name.includes('unknown time zone') || name.includes('degenerate')) continue; // semantically invalid on purpose
			expect(validatePlacement(placement).ok, name).toBe(true);
		}
	});

	it.each(MATRIX)('%s', (_name, placement, overrides, expected) => {
		const result = matchPlacement(placement, env(overrides));
		expect(result).toEqual(expected === true ? { ok: true } : { ok: false, reason: expected });
	});
});

describe('placement primitives', () => {
	it('classifies devices by breakpoint', () => {
		expect(deviceOf(375)).toBe('mobile');
		expect(deviceOf(768)).toBe('tablet');
		expect(deviceOf(1023)).toBe('tablet');
		expect(deviceOf(1024)).toBe('desktop');
		expect(deviceOf(900, { tablet: 600, desktop: 900 })).toBe('desktop');
	});

	it('handles missing rules', () => {
		expect(matchPath(undefined, '/x')).toBe(true);
		expect(matchPath({ include: [] }, '/x')).toBe(true);
		expect(matchReferrer(undefined, undefined)).toBe(true);
		expect(inSchedule(undefined, 0)).toBe(true);
	});

	it('computes local weekday and minute across DST zones', () => {
		expect(localTime(FRI_1730Z, KHI)).toEqual({ day: 4, minute: 22 * 60 + 30 });
		expect(localTime(Date.parse('2026-07-01T12:00:00Z'), 'Europe/London')).toEqual({ day: 2, minute: 13 * 60 });
		expect(localTime(Date.parse('2026-12-01T12:00:00Z'), 'Europe/London')).toEqual({ day: 1, minute: 12 * 60 });
		expect(localTime(Date.parse('2026-10-04T23:59:00Z'), 'UTC')).toEqual({ day: 6, minute: 23 * 60 + 59 });
	});
});

describe('audience evaluators', () => {
	it('evaluates precompiled programs without the parser', () => {
		const compiled = compile("inSegment('vip')");
		if (!compiled.ok) throw new Error('compile');
		const options = { now: FRI_1730Z, timeZone: 'UTC' };
		expect(evaluateAudienceProgram(compiled.program, { segments: ['vip'] }, options)).toBe(true);
		expect(evaluateAudienceProgram(compiled.program, { segments: [] }, options)).toBe(false);
		expect(evaluateAudienceProgram('source text', {}, options)).toBe(false);
		expect(evaluateAudienceProgram({ v: 1, ast: { tampered: true } }, {}, options)).toBe(false);
		expect(evaluateAudience(compiled.program, { segments: ['vip'] }, options)).toBe(true);
		expect(evaluateAudience("inSegment('vip')", { segments: ['vip'] }, options)).toBe(true); // cached
		expect(evaluateAudience("inSegment('vip')", { segments: ['vip'] }, options)).toBe(true);
	});
});
