import { describe, expect, it } from 'vitest';
import {
	creditsNumber,
	formatCredits,
	formatCreditsPerHour,
	formatDate,
	formatDateTime,
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
		expect(formatCredits(-1000)).toBe('-1 credit');
		expect(formatCredits(-2500)).toBe('-2.5 credits');
		expect(formatCredits(undefined)).toBe('—');
		expect(formatCreditsPerHour(1250)).toBe('1.25 credits/h');
		expect(formatCreditsPerHour(null)).toBe('—');
	});
	it('parses typed amounts into integer millicredits', () => {
		expect(parseCredits('12')).toEqual({ ok: true, value: 12000 });
		expect(parseCredits(' 0.125 ')).toEqual({ ok: true, value: 125 });
		expect(parseCredits('1.5')).toEqual({ ok: true, value: 1500 });
		expect(parseCredits('1.2345').ok).toBe(false);
		expect(parseCredits('-1').ok).toBe(false);
		expect(parseCredits('').ok).toBe(false);
	});
	it('formats dates and codes', () => {
		expect(formatDateTime('2026-10-01T10:05:00Z')).toBe('Oct 1, 2026, 10:05 AM UTC');
		expect(formatDateTime('2026-10-04T14:30:00Z')).toBe('Oct 4, 2026, 2:30 PM UTC');
		expect(formatDateTime(Date.UTC(2026, 9, 4, 0, 5))).toBe('Oct 4, 2026, 12:05 AM UTC');
		expect(formatDateTime(null)).toBe('—');
		expect(formatDateTime('nope')).toBe('—');
		expect(formatDate(new Date(Date.UTC(2026, 0, 2)))).toBe('Jan 2, 2026');
		expect(formatDate('2026-10-04T23:30:00Z')).toBe('Oct 4, 2026');
		expect(formatDate(null)).toBe('—');
		expect(humanize('low_balance')).toBe('Low balance');
		expect(humanize(null)).toBe('');
		expect(humanize('')).toBe('');
	});
	it('shows a code as readable words, keeping known short words in capitals', () => {
		expect(humanize('per_unit_down')).toBe('Per unit down');
		expect(humanize('sms')).toBe('SMS');
		expect(humanize('api_key')).toBe('API key');
		expect(humanize('whatsapp')).toBe('WhatsApp');
		expect(humanize('cod_fee')).toBe('COD fee');
		expect(humanize('one-exclusive')).toBe('One exclusive');
		expect(humanize('Mixed Case')).toBe('Mixed Case');
		expect(humanize('iban')).toBe('IBAN');
		expect(humanize('postalCode')).toBe('Postal code');
		expect(humanize('line1')).toBe('Line 1');
		expect(humanize(30)).toBe('30');
		expect(humanize(0)).toBe('0');
	});
});

describe("date and time in a time zone (the viewer's local time)", () => {
	it("keeps the same en-US style with the zone's short name", () => {
		expect(formatDateTime('2026-10-04T14:30:00Z', { timeZone: 'America/New_York' })).toBe('Oct 4, 2026, 10:30 AM EDT');
		expect(formatDateTime('2026-01-04T14:30:00Z', { timeZone: 'America/New_York' })).toBe('Jan 4, 2026, 9:30 AM EST');
		expect(formatDateTime('2026-10-04T14:30:00Z', { timeZone: 'Asia/Tokyo' })).toBe('Oct 4, 2026, 11:30 PM GMT+9');
		// the day changes with the zone
		expect(formatDateTime('2026-10-04T20:30:00Z', { timeZone: 'Asia/Tokyo' })).toBe('Oct 5, 2026, 5:30 AM GMT+9');
	});
	it('falls back to UTC for UTC, a missing or an unknown zone', () => {
		for (const timeZone of ['UTC', '', null, undefined, 'Not/AZone'])
			expect(formatDateTime('2026-10-04T14:30:00Z', { timeZone })).toBe('Oct 4, 2026, 2:30 PM UTC');
		expect(formatDateTime(null, { timeZone: 'Asia/Tokyo' })).toBe('—');
	});
	it('uses plain spaces only (the same text on the server and in browsers)', () => {
		expect(formatDateTime('2026-10-04T14:30:00Z', { timeZone: 'Europe/London' })).not.toMatch(/[\u00a0\u202f]/);
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
		expect(describeProblem({ type: '/problems/invalid_credentials', detail: 'The email or password is incorrect.' })).toBe(
			'The email or password is incorrect.',
		);
		expect(describeProblem({ type: '/problems/catalog_launch_refused', detail: 'the launch has expired' })).toBe(
			'the launch has expired',
		);
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
