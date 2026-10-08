import { describe, expect, it } from 'vitest';
import {
	addressFor,
	checkRecipient,
	normaliseEmail,
	normaliseLanguage,
	normalisePhone,
	normaliseTimeZone,
} from '../core/channels.js';
import { gatewayOutcome } from '../core/gateway.js';
import { isOptOut, repliesOf } from '../core/inbound.js';
import {
	checkTemplate,
	checkValues,
	fillText,
	isProductKey,
	languageOfSegment,
	pickVersion,
	placeholdersOf,
	renderTemplate,
	templateView,
} from '../core/templates.js';
import { checkSendAt, isQuietHour, localTime, nextAttemptAt, quietUntil, withinLimits } from '../core/timing.js';
import { webhookUrls } from '../core/webhooks.js';
import { keyBytes } from '../core/widgets.js';

describe('channels', () => {
	it('normalises addresses without guessing a country', () => {
		expect(normaliseEmail(' Ana@Example.COM ')).toBe('ana@example.com');
		expect(normaliseEmail('nope')).toBeNull();
		expect(normaliseEmail(5)).toBeNull();
		expect(normalisePhone('+92 (300) 123-4567')).toBe('+923001234567');
		expect(normalisePhone('0092 300 1234567')).toBe('+923001234567');
		expect(normalisePhone('03001234567')).toBeNull();
		expect(normalisePhone(3)).toBeNull();
		expect(normaliseLanguage('pt-BR')).toBe('pt-BR');
		expect(normaliseLanguage('Portuguese')).toBeNull();
		expect(normaliseTimeZone('Asia/Karachi')).toBe('Asia/Karachi');
		expect(normaliseTimeZone('Mars/Base')).toBeNull();
		expect(normaliseTimeZone('')).toBeNull();
	});

	it('checks a recipient and finds the address of a channel', () => {
		expect(checkRecipient(null)).toEqual({ ok: false, field: 'to' });
		expect(checkRecipient({})).toEqual({ ok: false, field: 'to' });
		expect(checkRecipient({ email: 'x' })).toEqual({ ok: false, field: 'to/email' });
		expect(checkRecipient({ subscriberId: 'a b' })).toEqual({ ok: false, field: 'to/subscriberId' });
		expect(checkRecipient({ staffId: 5 })).toEqual({ ok: false, field: 'to/staffId' });
		const ok = checkRecipient({
			phone: '+15550001111',
			staffId: 'u_1',
			subscriberId: 'sub_1',
			language: 'en',
			timeZone: 'UTC',
		});
		expect(ok.ok).toBe(true);
		if (!ok.ok) return;
		expect(addressFor('whatsapp', ok.value)).toBe('+15550001111');
		expect(addressFor('email', ok.value)).toBeNull();
		expect(addressFor('staff_push', ok.value)).toBe('u_1');
		expect(addressFor('push', ok.value)).toBe('sub_1');
	});
});

describe('templates', () => {
	it('checks what the merchant saves', () => {
		expect(checkTemplate(null)).toMatchObject({ ok: false, field: 'key' });
		expect(checkTemplate({ key: 'a', channel: 'fax' })).toMatchObject({ ok: false, field: 'channel' });
		expect(checkTemplate({ key: 'a', channel: 'sms', language: 'Klingon!', text: 'x' })).toMatchObject({ field: 'language' });
		expect(checkTemplate({ key: 'a', channel: 'sms', text: '  ' })).toMatchObject({ field: 'text' });
		expect(checkTemplate({ key: 'a', channel: 'sms', text: 'x'.repeat(1601) })).toMatchObject({ field: 'text' });
		expect(checkTemplate({ key: 'a', channel: 'email', text: 'x' })).toMatchObject({
			field: 'subject',
			message: 'Write the subject.',
		});
		expect(checkTemplate({ key: 'a', channel: 'push', text: 'x' })).toMatchObject({ message: 'Write the title.' });
		expect(checkTemplate({ key: 'a', channel: 'email', subject: 'a\nb', text: 'x' })).toMatchObject({ field: 'subject' });
		expect(checkTemplate({ key: 'a', channel: 'sms', text: 'x', providerTemplate: 'tpl' })).toMatchObject({
			field: 'providerTemplate',
		});
		expect(
			checkTemplate({ key: 'a.b', channel: 'sms', language: '', text: ' Hi ', subject: 'ignored', required: true }),
		).toEqual({
			ok: true,
			value: {
				key: 'a.b',
				channel: 'sms',
				language: '',
				subject: '',
				text: 'Hi',
				required: true,
				urgent: false,
				providerTemplate: '',
			},
		});
		expect(
			checkTemplate({ key: 'a', channel: 'whatsapp', language: 'ur', text: 'x', providerTemplate: 'sale_1' }),
		).toMatchObject({
			ok: true,
			value: { language: 'ur', providerTemplate: 'sale_1' },
		});
	});

	it('fills values, picks the language version and renders', () => {
		expect(placeholdersOf('{a} {b} {a} {1x}')).toEqual(['a', 'b']);
		expect(fillText('Hi {name}, {missing}', { name: 'Ana' })).toBe('Hi Ana, {missing}');
		expect(isProductKey('accounts.code')).toBe(true);
		expect(isProductKey('order_ready')).toBe(false);
		expect(languageOfSegment('default')).toBe('');
		expect(languageOfSegment('x!')).toBeNull();
		const versions = [{ language: '' }, { language: 'ur' }, { language: 'pt-BR' }];
		expect(pickVersion(versions, 'ur-PK', true)).toEqual({ language: 'ur' });
		expect(pickVersion(versions, 'pt-BR', true)).toEqual({ language: 'pt-BR' });
		expect(pickVersion(versions, 'de', true)).toEqual({ language: '' });
		expect(pickVersion(versions, 'ur', false)).toEqual({ language: '' });
		expect(pickVersion([{ language: 'ur' }], null, true)).toBeNull();
		const template = {
			key: 'k',
			channel: /** @type {const} */ ('whatsapp'),
			language: '',
			subject: '',
			text: 'Sale {pct} on {item}',
			required: false,
			urgent: false,
			providerTemplate: 'sale',
		};
		expect(renderTemplate(template, { pct: '5%' })).toEqual({ subject: '', text: 'Sale 5% on {item}', parameters: ['5%', ''] });
		expect(templateView({ ...template, updatedAt: new Date(0) })).toMatchObject({
			language: 'default',
			updatedAt: '1970-01-01T00:00:00.000Z',
		});
		expect(templateView({ ...template, language: 'ur' })).not.toHaveProperty('updatedAt');
	});

	it('checks the values of a send', () => {
		expect(checkValues(undefined)).toEqual({ ok: true, value: {} });
		expect(checkValues({ a: 1, b: 'x' })).toEqual({ ok: true, value: { a: '1', b: 'x' } });
		expect(checkValues('x')).toEqual({ ok: false });
		expect(checkValues({ unsubscribeUrl: 'x' })).toEqual({ ok: false });
		expect(checkValues({ a: {} })).toEqual({ ok: false });
		expect(checkValues(Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`v${i}`, 'x'])))).toEqual({ ok: false });
	});
});

describe('timing', () => {
	it('retries a bounded number of times', () => {
		expect(nextAttemptAt(1, 0)).toBe(60_000);
		expect(nextAttemptAt(2, 0)).toBe(300_000);
		expect(nextAttemptAt(3, 0)).toBeNull();
		expect(nextAttemptAt(4, 0, { max: 5, delays: [1, 2] })).toBe(2);
	});

	it('holds non-urgent messages until the end of quiet hours in the recipient’s time zone', () => {
		expect(isQuietHour(22, { startHour: 21, endHour: 8 })).toBe(true);
		expect(isQuietHour(9, { startHour: 21, endHour: 8 })).toBe(false);
		expect(isQuietHour(3, { startHour: 1, endHour: 6 })).toBe(true);
		expect(isQuietHour(7, { startHour: 1, endHour: 6 })).toBe(false);
		expect(isQuietHour(3, { startHour: 5, endHour: 5 })).toBe(false);
		const at = Date.parse('2026-10-01T18:30:00Z');
		expect(localTime(at, 'Asia/Karachi')).toEqual({ hour: 23, minute: 30 });
		expect(new Date(quietUntil(at, { startHour: 21, endHour: 8 }, 'Asia/Karachi')).toISOString()).toBe(
			'2026-10-02T03:00:00.000Z',
		);
		expect(quietUntil(at, { startHour: 21, endHour: 8 }, 'UTC')).toBe(at);
	});

	it('checks send limits and send times', () => {
		expect(withinLimits({ lastHour: 4, lastDay: 19 }, { perHour: 5, perDay: 20 })).toBe(true);
		expect(withinLimits({ lastHour: 5, lastDay: 5 }, { perHour: 5, perDay: 20 })).toBe(false);
		const now = Date.parse('2026-10-01T00:00:00Z');
		expect(checkSendAt('2026-10-02T00:00:00Z', now, 30)).toEqual({ ok: true, at: now + 86_400_000 });
		expect(checkSendAt('2026-09-01T00:00:00+05:00', now, 30)).toEqual({ ok: true, at: now });
		expect(checkSendAt('2026-12-01T00:00:00Z', now, 30)).toEqual({ ok: false });
		expect(checkSendAt('2026-13-45T99:00:00Z', now, 30)).toEqual({ ok: false });
		expect(checkSendAt(5, now, 30)).toEqual({ ok: false });
	});
});

describe('provider answers, replies and webhook URLs', () => {
	it('reads gateway answers like ibrahimMobiles did', () => {
		expect(gatewayOutcome(500, '')).toMatchObject({ ok: false, retryable: true });
		expect(gatewayOutcome(429, '')).toMatchObject({ ok: false, retryable: true });
		expect(gatewayOutcome(400, '')).toMatchObject({ ok: false, retryable: false });
		expect(gatewayOutcome(200, 'OK')).toEqual({ ok: true, id: null });
		expect(gatewayOutcome(200, '[1]')).toEqual({ ok: true, id: null });
		expect(gatewayOutcome(200, '{"sid":"SM1"}')).toEqual({ ok: true, id: 'SM1' });
		expect(gatewayOutcome(200, '{"id":7}')).toEqual({ ok: true, id: '7' });
		expect(gatewayOutcome(200, '{"error":"no balance"}')).toEqual({ ok: false, error: 'no balance', retryable: false });
		expect(gatewayOutcome(200, '{"sent":"false","message":"expired"}')).toMatchObject({ error: 'expired' });
		expect(gatewayOutcome(200, '{"success":false}')).toMatchObject({ error: 'The message was not sent.' });
		expect(gatewayOutcome(200, '{"status":"Failed"}')).toMatchObject({ error: 'Failed' });
		expect(gatewayOutcome(200, '{"status":"queued"}')).toEqual({ ok: true, id: null });
	});

	it('reads forwarded replies and matches unsubscribe keywords', () => {
		expect(repliesOf('twilio', 'From=whatsapp%3A%2B15550001111&Body=STOP')).toEqual([{ from: '+15550001111', text: 'STOP' }]);
		expect(repliesOf('twilio', 'Body=STOP')).toEqual([]);
		expect(repliesOf('twilio', 'From=%2B1555')).toEqual([{ from: '+1555', text: '' }]);
		expect(repliesOf('meta', 'not json')).toEqual([]);
		expect(repliesOf('meta', '{"entry":[{"changes":[{"value":{"messages":[{"from":"155","type":"image"}]}}]}]}')).toEqual([
			{ from: '+155', text: '' },
		]);
		expect(repliesOf('meta', '{}')).toEqual([]);
		expect(isOptOut(' Stop ', ['STOP'])).toBe(true);
		expect(isOptOut('stop please', ['STOP'])).toBe(false);
		expect(isOptOut('stop', 'STOP')).toBe(false);
		expect(isOptOut('', ['', 5])).toBe(false);
	});

	it('keeps only https webhook URLs, at most five', () => {
		expect(webhookUrls(['https://a.example', 'http://b.example', 5, ...Array(6).fill('https://c.example')])).toHaveLength(5);
		expect(webhookUrls('https://a.example')).toEqual([]);
	});

	it('turns a base64url push key into bytes', () => {
		expect([...keyBytes('AQID')]).toEqual([1, 2, 3]);
		expect([...keyBytes('_-8')]).toEqual([255, 239]);
	});
});
