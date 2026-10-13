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
import { STATUSES, logFilters } from '../core/log.js';
import {
	checkButtons,
	checkTemplate,
	checkValues,
	fillText,
	isProductKey,
	languageOfSegment,
	pickVersion,
	placeholdersOf,
	renderTemplate,
	sectionProblem,
	templateView,
	valueNamesOf,
} from '../core/templates.js';
import {
	RETRY_PLANS,
	checkSendAt,
	isQuietHour,
	localTime,
	nextAttemptAt,
	quietUntil,
	retryPlanOf,
	withinLimits,
} from '../core/timing.js';
import { checkForwardedEvent, checkWebhookUrls, eventTime, fromOldUrls, urlsFor } from '../core/webhooks.js';
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
				buttons: [],
				sensitive: false,
			},
		});
		expect(checkTemplate({ key: 'accounts.code', channel: 'sms', text: 'Code {code}' })).toMatchObject({
			value: { sensitive: true },
		});
		expect(checkTemplate({ key: 'login', channel: 'sms', text: 'Open {link}', sensitive: true })).toMatchObject({
			value: { sensitive: true },
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
		expect(renderTemplate(template, { pct: '5%' })).toEqual({
			subject: '',
			text: 'Sale 5% on {item}',
			parameters: ['5%', ''],
			buttons: [],
		});
		expect(templateView({ ...template, updatedAt: new Date(0) })).toMatchObject({
			language: 'default',
			updatedAt: '1970-01-01T00:00:00.000Z',
		});
		expect(templateView({ ...template, language: 'ur' })).not.toHaveProperty('updatedAt');
	});

	it('checks the buttons of a WhatsApp template at Meta and fills their values (PLAN 0.8.10 N1)', () => {
		const at = { channel: /** @type {const} */ ('whatsapp'), providerTemplate: 'authentication' };
		expect(checkButtons(undefined, at)).toEqual({ ok: true, value: [] });
		expect(checkButtons([], { channel: 'sms', providerTemplate: '' })).toEqual({ ok: true, value: [] });
		expect(checkButtons('x', at)).toMatchObject({ ok: false, field: 'buttons' });
		const one = [{ index: 0, type: 'copy_code', value: '{code}' }];
		expect(checkButtons(one, { channel: 'whatsapp', providerTemplate: '' })).toMatchObject({
			ok: false,
			field: 'buttons',
			message: 'Only WhatsApp templates with a template name at Meta have buttons.',
		});
		expect(checkButtons(one, { channel: 'sms', providerTemplate: '' })).toMatchObject({ field: 'buttons' });
		const many = Array.from({ length: 11 }, (_, index) => ({ index, type: 'url', value: 'x' }));
		expect(checkButtons(many, at)).toMatchObject({ field: 'buttons' });
		expect(checkButtons([null], at)).toMatchObject({ field: 'buttons/0/index' });
		expect(checkButtons([{ index: 10, type: 'url', value: 'x' }], at)).toMatchObject({ field: 'buttons/0/index' });
		expect(checkButtons([{ index: 1.5, type: 'url', value: 'x' }], at)).toMatchObject({ field: 'buttons/0/index' });
		expect(
			checkButtons(
				[
					{ index: 1, type: 'url', value: 'x' },
					{ index: 1, type: 'url', value: 'y' },
				],
				at,
			),
		).toMatchObject({ field: 'buttons/1/index', message: 'Button 1 is listed twice.' });
		expect(checkButtons([{ index: 0, type: 'quick_reply', value: 'x' }], at)).toMatchObject({ field: 'buttons/0/type' });
		expect(checkButtons([{ index: 0, type: 'url', value: ' ' }], at)).toMatchObject({ field: 'buttons/0/value' });
		expect(checkButtons([{ index: 0, type: 'url', value: 'x'.repeat(2001) }], at)).toMatchObject({
			field: 'buttons/0/value',
		});
		expect(checkButtons([{ index: 0, type: 'url', value: '{?a}x' }], at)).toMatchObject({ field: 'buttons/0/value' });
		expect(
			checkButtons(
				[
					{ index: 1, type: 'url', value: ' track/{order} ' },
					{ index: 0, type: 'copy_code', value: '{code}' },
				],
				at,
			),
		).toEqual({
			ok: true,
			value: [
				{ index: 0, type: 'copy_code', value: '{code}' },
				{ index: 1, type: 'url', value: 'track/{order}' },
			],
		});
		const checked = checkTemplate({
			key: 'accounts.code',
			channel: 'whatsapp',
			text: 'Your code is {code}.',
			providerTemplate: 'authentication',
			required: true,
			urgent: true,
			buttons: one,
		});
		expect(checked).toMatchObject({ ok: true, value: { buttons: one } });
		expect(
			checkTemplate({ key: 'a', channel: 'whatsapp', text: 'x', providerTemplate: 'p', buttons: [{ index: 0 }] }),
		).toMatchObject({ ok: false, field: 'buttons/0/type' });
		if (!checked.ok) return;
		expect(renderTemplate(checked.value, { code: '482913' })).toEqual({
			subject: '',
			text: 'Your code is 482913.',
			parameters: ['482913'],
			buttons: [{ index: 0, type: 'copy_code', value: '482913' }],
		});
		expect(templateView(checked.value).buttons).toEqual(one);
		const older = { ...checked.value };
		delete older.buttons;
		expect(templateView(older).buttons).toEqual([]);
		expect(renderTemplate(older, { code: '1' }).buttons).toEqual([]);
	});

	it('shows an optional section only when its value is not empty (PLAN 0.8.10 N2)', () => {
		const text = 'Order {order} is {status}.{?tracking} Track it: {tracking}{?courier} ({courier}){/courier}.{/tracking}';
		expect(fillText(text, { order: 'IM-1', status: 'shipped', tracking: 'TRK9', courier: 'TCS' })).toBe(
			'Order IM-1 is shipped. Track it: TRK9 (TCS).',
		);
		expect(fillText(text, { order: 'IM-1', status: 'shipped', tracking: 'TRK9' })).toBe(
			'Order IM-1 is shipped. Track it: TRK9.',
		);
		expect(fillText(text, { order: 'IM-1', status: 'shipped', tracking: '  ', courier: 'TCS' })).toBe('Order IM-1 is shipped.');
		expect(fillText('{?a}A{/a}-{?a}again{/a}', { a: 'x' })).toBe('A-again');
		expect(valueNamesOf('{?tracking}Track {tracking} with {courier}{/tracking} {order} {1x}')).toEqual([
			'tracking',
			'courier',
			'order',
		]);
		expect(fillText('{?reason}\nReason: {reason}{/reason}', {})).toBe('');
		expect(sectionProblem('{?a}x{/a} and {?b}{?c}y{/c}{/b}')).toBeNull();
		expect(sectionProblem('{?a}x')).toBe('Close {?a} with {/a}.');
		expect(sectionProblem('x{/a}')).toBe('{/a} closes no {?a}.');
		expect(sectionProblem('{?a}{?b}x{/a}{/b}')).toBe('Close {?b} before {/a}.');
		expect(sectionProblem('{?a}{?a}x{/a}{/a}')).toBe('{?a} is already open: close it with {/a} first.');
		expect(checkTemplate({ key: 'a', channel: 'sms', text: '{?reason}Reason: {reason}' })).toMatchObject({
			ok: false,
			field: 'text',
			message: 'Close {?reason} with {/reason}.',
		});
		expect(checkTemplate({ key: 'a', channel: 'email', subject: 'Hi{/name}', text: 'x' })).toMatchObject({
			ok: false,
			field: 'subject',
		});
		const checked = checkTemplate({
			key: 'ecommerce.order_cancelled',
			channel: 'email',
			subject: 'Order {order} cancelled{?reason}: {reason}{/reason}',
			text: 'Your order {order} was cancelled.{?reason} Reason: {reason}{/reason}',
		});
		expect(checked.ok).toBe(true);
		if (!checked.ok) return;
		expect(renderTemplate(checked.value, { order: 'IM-2', reason: 'Out of stock' })).toMatchObject({
			subject: 'Order IM-2 cancelled: Out of stock',
			text: 'Your order IM-2 was cancelled. Reason: Out of stock',
		});
		expect(renderTemplate(checked.value, { order: 'IM-2' })).toMatchObject({
			subject: 'Order IM-2 cancelled',
			text: 'Your order IM-2 was cancelled.',
		});
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
		// the long plan (PLAN 0.8.10 N3): now, then 5 and 15 minutes and 1, 3 and 6 hours later
		const MIN = 60_000;
		expect([1, 2, 3, 4, 5, 6].map((failed) => nextAttemptAt(failed, 0, RETRY_PLANS.long))).toEqual([
			5 * MIN,
			15 * MIN,
			60 * MIN,
			180 * MIN,
			360 * MIN,
			null,
		]);
		expect(retryPlanOf('long')).toBe('long');
		expect(retryPlanOf(undefined)).toBe('short');
		expect(retryPlanOf('weekly')).toBe('short');
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

	it('reads the wall clock in the business time zone, UTC when it is missing or unknown', () => {
		const at = Date.parse('2026-10-01T18:30:00Z');
		expect(localTime(at, 'America/New_York')).toEqual({ hour: 14, minute: 30 });
		expect(localTime(at, null)).toEqual({ hour: 18, minute: 30 });
		expect(localTime(at, 'Nowhere/Town')).toEqual({ hour: 18, minute: 30 });
		expect(quietUntil(at, { startHour: 18, endHour: 7 }, undefined)).toBe(Date.parse('2026-10-02T07:00:00Z'));
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

describe('the delivery log’s filters', () => {
	it('keep known statuses and channels and normalise the recipient', () => {
		expect(STATUSES).toEqual(['queued', 'retrying', 'sent', 'failed', 'skipped']);
		expect(logFilters({})).toEqual({});
		expect(logFilters({ status: 'sent', channel: 'sms', to: '+44 7700 900123' })).toEqual({
			status: 'sent',
			channel: 'sms',
			address: '+447700900123',
		});
		expect(logFilters({ status: 'bogus', channel: 'fax', to: '' })).toEqual({});
		expect(logFilters({ to: 'Ana@Example.com' })).toEqual({ address: 'ana@example.com' });
		expect(logFilters({ to: 'sub_1' })).toEqual({ address: 'sub_1' });
		expect(logFilters({ status: ['sent'], to: 5 })).toEqual({});
	});
});

describe('forwarded events', () => {
	it('read real ISO-8601 times only', () => {
		expect(eventTime('2026-10-01T10:00:00.000Z')).toBe(Date.parse('2026-10-01T10:00:00Z'));
		expect(eventTime('2026-10-01T15:00+05:00')).toBe(Date.parse('2026-10-01T10:00:00Z'));
		expect(eventTime('2026-10-01T10:00:00.123456Z')).toBe(Date.parse('2026-10-01T10:00:00.123Z'));
		expect(eventTime('2028-02-29T00:00:00Z')).toBe(Date.parse('2028-02-29T00:00:00Z'));
		for (const bad of [
			'2026-02-29T00:00:00Z',
			'2026-13-01T00:00:00Z',
			'2026-10-01T24:00:00Z',
			'2026-10-01T10:60:00Z',
			'2026-10-01T10:00:60Z',
			'2026-10-01T10:00:00+24:00',
			'2026-10-01T10:00:00+05:60',
			'2026-10-01T10:00:00',
			'2026-10-01',
			'0026-10-01T10:00:00Z',
			'+2026-10-01T10:00:00Z',
			1_790_848_800_000,
			null,
		])
			expect(eventTime(bad)).toBeNull();
	});

	it('check type, data, id and time', () => {
		const id = 'evt_0123456789abcdefghjkmnpqrs';
		expect(checkForwardedEvent({ id, type: 'payments.payment.paid', at: '2026-10-01T10:00:00Z', data: { a: 1 } })).toEqual({
			ok: true,
			value: { id, type: 'payments.payment.paid', at: Date.parse('2026-10-01T10:00:00Z'), data: { a: 1 } },
		});
		expect(checkForwardedEvent({ type: 'growth.goal.reached', data: {} })).toEqual({
			ok: true,
			value: { id: null, type: 'growth.goal.reached', at: null, data: {} },
		});
		/** @param {unknown} input */
		const field = (input) => {
			const checked = checkForwardedEvent(input);
			return checked.ok ? null : checked.field;
		};
		expect(field(null)).toBe('type');
		expect(field({ type: 'message.sent', data: {} })).toBe('type');
		expect(field({ type: 'notifications.message.sent', data: {} })).toBe('type');
		expect(field({ type: 'payments.paid', data: null })).toBe('data');
		expect(field({ type: 'payments.paid', data: [] })).toBe('data');
		expect(field({ type: 'payments.paid', data: { x: 'y'.repeat(17_000) } })).toBe('data');
		expect(field({ type: 'payments.paid', data: {}, id: 'msg_0123456789abcdefghjkmnpqrs' })).toBe('id');
		expect(field({ type: 'payments.paid', data: {}, id: '' })).toBe('id');
		expect(field({ type: 'payments.paid', data: {}, at: 'now' })).toBe('at');
		expect(field({ type: 'payments.paid', data: {}, at: null })).toBe('at');
	});
});

describe('provider answers, replies and webhook URLs', () => {
	it('reads gateway answers that report a refusal inside HTTP 200', () => {
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

	it('moves the old setting’s https URLs into the list, each taking every event (PLAN 0.8.10 N5)', () => {
		const many = Array.from({ length: 7 }, (_, i) => `https://h${i}.example/x`);
		expect(fromOldUrls(['https://a.example', 'http://b.example', 5, 'https://a.example', ...many])).toHaveLength(5);
		expect(fromOldUrls(['https://a.example', 'https://u:p@b.example', 'https://%zz'])).toEqual([
			{ url: 'https://a.example', events: [] },
		]);
		expect(fromOldUrls('https://a.example')).toEqual([]);
	});

	it('checks the list of webhook URLs and picks the URLs of an event (PLAN 0.8.10 N5)', () => {
		expect(checkWebhookUrls('x')).toMatchObject({ ok: false, errors: [{ path: '/value' }] });
		const six = Array.from({ length: 6 }, (_, i) => ({ url: `https://h${i}.example` }));
		expect(checkWebhookUrls(six)).toMatchObject({ ok: false, errors: [{ message: 'Add at most 5 URLs.' }] });
		expect(
			checkWebhookUrls([
				{ url: 'http://a.example' },
				{ url: `https://a.example/${'x'.repeat(2048)}` },
				null,
				{ url: 'https://b.example', events: ['nope'] },
				{ url: 'https://b.example', events: 'message.sent' },
			]),
		).toEqual({
			ok: false,
			errors: [
				{ path: '/value/0/url', message: 'Use an https address of at most 2048 characters.' },
				{ path: '/value/1/url', message: 'Use an https address of at most 2048 characters.' },
				{ path: '/value/2/url', message: 'Use an https address of at most 2048 characters.' },
				expect.objectContaining({ path: '/value/3/events' }),
				expect.objectContaining({ path: '/value/4/events' }),
			],
		});
		expect(
			checkWebhookUrls([{ url: 'https://c.example' }, { url: ' https://c.example ', events: Array(51).fill('message.sent') }]),
		).toEqual({
			ok: false,
			errors: [
				{ path: '/value/1/url', message: 'This URL is listed twice.' },
				expect.objectContaining({ path: '/value/1/events' }),
			],
		});
		const checked = checkWebhookUrls([
			{
				url: ' https://orders.example/hook ',
				events: ['ecommerce.order.placed', 'payments.payment.paid', 'payments.payment.paid'],
			},
			{ url: 'https://all.example/hook' },
			{ url: 'https://fails.example/hook', events: ['message.failed'] },
		]);
		expect(checked).toEqual({
			ok: true,
			value: [
				{ url: 'https://orders.example/hook', events: ['ecommerce.order.placed', 'payments.payment.paid'] },
				{ url: 'https://all.example/hook', events: [] },
				{ url: 'https://fails.example/hook', events: ['message.failed'] },
			],
		});
		if (!checked.ok) return;
		expect(urlsFor(checked.value, 'payments.payment.paid')).toEqual([
			'https://orders.example/hook',
			'https://all.example/hook',
		]);
		expect(urlsFor(checked.value, 'message.failed')).toEqual(['https://all.example/hook', 'https://fails.example/hook']);
		expect(urlsFor(checked.value, 'chat.conversation.opened')).toEqual(['https://all.example/hook']);
		expect(checkWebhookUrls([])).toEqual({ ok: true, value: [] });
	});

	it('turns a base64url push key into bytes', () => {
		expect([...keyBytes('AQID')]).toEqual([1, 2, 3]);
		expect([...keyBytes('_-8')]).toEqual([255, 239]);
	});
});
