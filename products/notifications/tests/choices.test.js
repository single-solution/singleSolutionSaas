/**
 * The merchant's own choices (fixed-choices N2, N5–N8): the fixed retry waits, quiet hours per weekday and
 * channel, unsubscribe topics, template settings and fallback channels — the pure checks and rules.
 */
import { describe, expect, it } from 'vitest';
import {
	checkFallbackChains,
	checkQuietHours,
	checkTemplateSettings,
	checkTopics,
	fallbackChainOf,
	topicIdOf,
} from '../core/choices.js';
import { RETRY_WAITS, WEBHOOK_RETRY_WAITS } from '../core/limits.js';
import { DEFAULT_QUIET_HOURS, nextAttemptAt, quietUntil } from '../core/timing.js';

const MIN = 60_000;
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
/** @param {unknown} windows @returns {import('../core/timing.js').QuietWindow[]} */
const quiet = (windows) => /** @type {any} */ (windows);

describe('retries (N8)', () => {
	it('keep today’s timings: 3 attempts on a channel (now, 1 and 5 minutes), 5 on a webhook', () => {
		expect(RETRY_WAITS).toEqual([MIN, 5 * MIN]);
		expect(WEBHOOK_RETRY_WAITS).toEqual([MIN, 5 * MIN, 30 * MIN, 120 * MIN]);
	});

	it('the attempts are one more than the waits', () => {
		expect(nextAttemptAt(1, 0, RETRY_WAITS)).toBe(MIN);
		expect(nextAttemptAt(2, 0, RETRY_WAITS)).toBe(5 * MIN);
		expect(nextAttemptAt(3, 0, RETRY_WAITS)).toBeNull();
		expect(nextAttemptAt(1, 0, [])).toBeNull();
	});
});

describe('quiet hours per weekday and channel (N6)', () => {
	it('the default is today’s: every day 21:00–08:00 on every channel', () => {
		const at = Date.parse('2026-10-01T18:30:00Z');
		expect(new Date(quietUntil(at, DEFAULT_QUIET_HOURS, 'Asia/Tokyo', 'sms')).toISOString()).toBe('2026-10-01T23:00:00.000Z');
		expect(quietUntil(at, DEFAULT_QUIET_HOURS, 'UTC', 'sms')).toBe(at);
	});

	it('takes minutes, weekdays and channels', () => {
		// Thursday 2026-10-01, 12:10 UTC
		const at = Date.parse('2026-10-01T12:10:00Z');
		const lunch = quiet([{ days: [4], from: '12:00', until: '13:30', channels: [] }]);
		expect(new Date(quietUntil(at, lunch, 'UTC', 'email')).toISOString()).toBe('2026-10-01T13:30:00.000Z');
		// another weekday: not quiet
		expect(quietUntil(at, quiet([{ ...lunch[0], days: [1] }]), 'UTC', 'email')).toBe(at);
		// only SMS and WhatsApp are held; email goes now
		const textOnly = quiet([{ days: EVERY_DAY, from: '12:00', until: '13:30', channels: ['sms', 'whatsapp'] }]);
		expect(quietUntil(at, textOnly, 'UTC', 'email')).toBe(at);
		expect(new Date(quietUntil(at, textOnly, 'UTC', 'whatsapp')).toISOString()).toBe('2026-10-01T13:30:00.000Z');
	});

	it('a window passing midnight belongs to the day it starts; windows that follow one another are passed in turn', () => {
		// Saturday 2026-10-03 23:00 UTC; the weekend window starts Friday and Saturday at 20:00, until 10:00
		const at = Date.parse('2026-10-03T23:00:00Z');
		const weekend = quiet([{ days: [5, 6], from: '20:00', until: '10:00', channels: [] }]);
		expect(new Date(quietUntil(at, weekend, 'UTC', 'sms')).toISOString()).toBe('2026-10-04T10:00:00.000Z');
		// Sunday 05:00: still inside Saturday's window
		expect(new Date(quietUntil(Date.parse('2026-10-04T05:00:00Z'), weekend, 'UTC', 'sms')).toISOString()).toBe(
			'2026-10-04T10:00:00.000Z',
		);
		// Monday 05:00: Sunday starts no window
		expect(quietUntil(Date.parse('2026-10-05T05:00:00Z'), weekend, 'UTC', 'sms')).toBe(Date.parse('2026-10-05T05:00:00Z'));
		// 22:00–08:00 then 08:00–09:15 on Sunday: held until 09:15
		const chained = quiet([...weekend, { days: [0], from: '10:00', until: '11:15', channels: [] }]);
		expect(new Date(quietUntil(at, chained, 'UTC', 'sms')).toISOString()).toBe('2026-10-04T11:15:00.000Z');
		// the same from and until is no quiet time
		expect(quietUntil(at, quiet([{ days: EVERY_DAY, from: '05:00', until: '05:00', channels: [] }]), 'UTC', 'sms')).toBe(at);
	});

	it('checks the windows', () => {
		expect(checkQuietHours([{ days: [3, 1], from: '21:30', until: '07:45', channels: ['sms'] }])).toEqual({
			ok: true,
			value: [{ days: [1, 3], from: '21:30', until: '07:45', channels: ['sms'] }],
		});
		expect(checkQuietHours([{ days: [1], from: '21:30', until: '07:45' }])).toMatchObject({ ok: true });
		for (const bad of [
			{ days: [], from: '21:00', until: '08:00' },
			{ days: [7], from: '21:00', until: '08:00' },
			{ days: [1, 1], from: '21:00', until: '08:00' },
			{ days: [1], from: '24:00', until: '08:00' },
			{ days: [1], from: '21:00', until: '8:00' },
			{ days: [1], from: '21:00', until: '08:00', channels: ['fax'] },
		])
			expect(checkQuietHours([bad]).ok).toBe(false);
		expect(checkQuietHours('21-8').ok).toBe(false);
	});
});

describe('unsubscribe topics (N2)', () => {
	it('a new topic gets its id from its name; renaming keeps the id', () => {
		expect(topicIdOf('Back in stock')).toBe('back_in_stock');
		expect(topicIdOf('Ofertas y promociónes')).toBe('ofertas_y_promociones');
		expect(topicIdOf('2026 news')).toBe('topic_2026_news');
		expect(checkTopics([{ name: ' Newsletter ' }, { id: 'promotions', name: 'Deals' }])).toEqual({
			ok: true,
			value: [
				{ id: 'newsletter', name: 'Newsletter' },
				{ id: 'promotions', name: 'Deals' },
			],
		});
	});

	it('refuses a missing name, a twice-listed id or name, a bad id and more than 20', () => {
		expect(checkTopics([{ name: '' }]).ok).toBe(false);
		expect(checkTopics([{ name: 'News' }, { name: 'news' }]).ok).toBe(false);
		expect(
			checkTopics([
				{ id: 'a', name: 'One' },
				{ id: 'a', name: 'Two' },
			]).ok,
		).toBe(false);
		expect(checkTopics([{ id: 'Bad Id', name: 'One' }]).ok).toBe(false);
		expect(checkTopics(Array.from({ length: 21 }, (_, n) => ({ name: `Topic ${n}` }))).ok).toBe(false);
	});
});

describe('template settings and fallback channels (N2, N5, N7)', () => {
	it('keeps what each template sets and drops entries that set nothing', () => {
		expect(
			checkTemplateSettings(
				[
					{ key: 'growth.back_in_stock', topic: 'stock', fallback: ['push', 'email'], capped: true },
					{ key: 'order.shipped', topic: null, fallback: null, capped: null },
					{ key: 'order.paid', capped: false },
				],
				['stock'],
			),
		).toEqual({
			ok: true,
			value: [
				{ key: 'growth.back_in_stock', topic: 'stock', fallback: ['push', 'email'], capped: true },
				{ key: 'order.paid', topic: null, fallback: null, capped: false },
			],
		});
		// an unknown topic, a channel twice, staff push, a key twice
		expect(checkTemplateSettings([{ key: 'a.b', topic: 'nope' }], ['stock']).ok).toBe(false);
		expect(checkTemplateSettings([{ key: 'a.b', fallback: ['sms', 'sms'] }], []).ok).toBe(false);
		expect(checkTemplateSettings([{ key: 'a.b', fallback: ['staff_push'] }], []).ok).toBe(false);
		expect(
			checkTemplateSettings(
				[
					{ key: 'a.b', capped: true },
					{ key: 'a.b', capped: false },
				],
				[],
			).ok,
		).toBe(false);
	});

	it('the website’s chains: each channel once, never falling back to itself', () => {
		expect(
			checkFallbackChains([
				{ channel: 'whatsapp', then: ['sms', 'email'] },
				{ channel: 'email', then: [] },
			]),
		).toEqual({ ok: true, value: [{ channel: 'whatsapp', then: ['sms', 'email'] }] });
		expect(checkFallbackChains([{ channel: 'sms', then: ['sms'] }]).ok).toBe(false);
		expect(
			checkFallbackChains([
				{ channel: 'sms', then: ['email'] },
				{ channel: 'sms', then: ['push'] },
			]).ok,
		).toBe(false);
	});

	it('a template’s own chain comes first, else the website’s chain of its channel', () => {
		const lists = {
			templates: [{ key: 'order.shipped', topic: null, fallback: /** @type {any[]} */ (['push', 'sms']), capped: null }],
			chains: [{ channel: /** @type {const} */ ('whatsapp'), then: /** @type {any[]} */ (['sms', 'email']) }],
		};
		expect(fallbackChainOf({ channel: 'whatsapp', template: 'order.shipped' }, lists)).toEqual(['push', 'sms']);
		expect(fallbackChainOf({ channel: 'whatsapp', template: 'order.paid' }, lists)).toEqual(['sms', 'email']);
		expect(fallbackChainOf({ channel: 'whatsapp', template: null }, lists)).toEqual(['sms', 'email']);
		expect(fallbackChainOf({ channel: 'email', template: null }, lists)).toEqual([]);
	});
});
