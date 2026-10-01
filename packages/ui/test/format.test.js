import { describe, expect, it } from 'vitest';
import {
	creditsNumber,
	formatCredits,
	formatCreditsPerHour,
	formatDate,
	formatDateTime,
	formatHours,
	formatNumber,
	formatUnitPrice,
	humanize,
	parseCredits,
} from '../src/format.js';
import { describeProblem, fieldErrors, networkProblem, problemCode } from '../src/problems.js';

describe('money formatting (credits from millicredits, ≤ 3 decimals)', () => {
	it('formats exact credits', () => {
		expect(creditsNumber(0)).toBe('0');
		expect(creditsNumber(1)).toBe('0.001');
		expect(creditsNumber(1250)).toBe('1.25');
		expect(creditsNumber(-123456789)).toBe('-123,456.789');
		expect(creditsNumber(null)).toBe('—');
		expect(creditsNumber(Number.NaN)).toBe('—');
		expect(formatCredits(1000)).toBe('1 credit');
		expect(formatCredits(2500)).toBe('2.5 credits');
		expect(formatCredits(2500, { signed: true })).toBe('+2.5 credits');
		expect(formatCredits(-2500, { signed: true })).toBe('-2.5 credits');
		expect(formatCredits(2500, { unit: false })).toBe('2.5');
		expect(formatCredits(undefined)).toBe('—');
		expect(formatCreditsPerHour(1250)).toBe('1.25 credits/h');
		expect(formatCreditsPerHour(null)).toBe('—');
		expect(formatUnitPrice(10, 1, 'redemption')).toBe('0.01 credits / redemption');
		expect(formatUnitPrice(1, 1000, 'token')).toBe('0.001 credits / 1,000 tokens');
	});
	it('parses typed amounts into integer millicredits', () => {
		expect(parseCredits('12')).toEqual({ ok: true, value: 12000 });
		expect(parseCredits(' 0.125 ')).toEqual({ ok: true, value: 125 });
		expect(parseCredits('1.5')).toEqual({ ok: true, value: 1500 });
		expect(parseCredits('1.2345').ok).toBe(false);
		expect(parseCredits('-1').ok).toBe(false);
		expect(parseCredits('').ok).toBe(false);
	});
	it('formats hours, dates, numbers and codes', () => {
		expect(formatHours(null)).toBe('No spend');
		expect(formatHours(0)).toBe('0 h');
		expect(formatHours(5.25)).toBe('5.3 h');
		expect(formatHours(72)).toBe('3 days');
		expect(formatHours(Number.POSITIVE_INFINITY)).toBe('—');
		expect(formatDateTime('2026-10-01T10:05:00Z')).toBe('01 Oct 2026, 10:05 UTC');
		expect(formatDateTime(null)).toBe('—');
		expect(formatDateTime('nope')).toBe('—');
		expect(formatDate(new Date(Date.UTC(2026, 0, 2)))).toBe('02 Jan 2026');
		expect(formatNumber(12345)).toBe('12,345');
		expect(formatNumber(undefined)).toBe('—');
		expect(humanize('spend_cap')).toBe('Spend cap');
		expect(humanize(null)).toBe('');
	});
});

describe('problem documents', () => {
	const validation = {
		type: 'https://portal.test/problems/validation_failed',
		title: 'Validation failed',
		status: 422,
		detail: 'The request is invalid.',
		errors: [
			{ path: '/credentials/uri', message: 'hosts must be public addresses' },
			{ path: '/credentials/uri', message: 'TLS is required' },
			{ path: '/features/bar.message', message: 'too long' },
			{ path: '', message: 'body must be an object' },
			{ path: '/x' },
		],
	};
	it('derives stable codes', () => {
		expect(problemCode(validation)).toBe('validation_failed');
		expect(problemCode({ code: 'custom', type: 'x/y' })).toBe('custom');
		expect(problemCode({ type: 'about:blank', status: 404 })).toBe('not_found');
		for (const [status, code] of [
			[401, 'unauthorized'],
			[403, 'forbidden'],
			[409, 'conflict'],
			[422, 'validation_failed'],
			[429, 'rate_limited'],
			[503, 'service_unavailable'],
			[500, 'internal_error'],
		])
			expect(problemCode({ status: /** @type {number} */ (status) })).toBe(code);
		expect(problemCode(null)).toBe('internal_error');
	});
	it('describes problems in friendly words', () => {
		expect(describeProblem(validation)).toBe('Some fields need your attention.');
		expect(describeProblem({ type: '/problems/invalid_credentials', detail: 'The e-mail or password is incorrect.' })).toBe(
			'The e-mail or password is incorrect.',
		);
		expect(
			describeProblem({ type: '/problems/catalog_launch_refused', detail: 'element packs have no dashboard to launch' }),
		).toBe('element packs have no dashboard to launch');
		expect(describeProblem({ type: '/problems/rate_limited' })).toMatch(/Too many attempts/);
		expect(describeProblem({ type: '/problems/something_new', detail: 'Plain detail.' })).toBe('Plain detail.');
		expect(describeProblem({ type: '/problems/something_new', title: 'Title only' })).toBe('Title only');
		expect(describeProblem(networkProblem(new Error('offline')))).toMatch(/could not reach/);
		expect(networkProblem('x').detail).toBe('Network error');
	});
	it('maps JSON-pointer field errors onto field names', () => {
		expect(fieldErrors(validation)).toEqual({
			'credentials.uri': 'Hosts must be public addresses.',
			'features.bar.message': 'Too long.',
			_form: 'Body must be an object.',
			x: 'Invalid value.',
		});
		expect(fieldErrors(validation, { base: '/features/' })).toEqual({ 'bar.message': 'Too long.' });
		expect(fieldErrors(validation, { base: '/credentials' })).toEqual({ uri: 'Hosts must be public addresses.' });
		expect(fieldErrors(null)).toEqual({});
	});
});
