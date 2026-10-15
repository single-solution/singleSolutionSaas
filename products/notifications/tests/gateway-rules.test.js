/**
 * Any SMS or WhatsApp gateway with an HTTP API (fixed-choices N1): the merchant builds the request — method, a URL with
 * placeholders, headers, body type and body — and says what success is: the HTTP statuses and, when the gateway
 * answers 200 for a refusal, a JSON path and the value it must have. Never English words in the answer. The message id
 * is read at the path the merchant names. Known providers use their own id paths and HTTP statuses.
 */
import { describe, expect, it } from 'vitest';
import { createOutboundPolicy } from '@ss/net';
import { httpOutcome, parseStatusRule, valueAt } from '../core/gateway.js';
import { createProviders, providerViolation } from '../adapters/providers.js';

const policy = createOutboundPolicy({});
const NOW = Date.parse('2026-10-01T10:00:00Z');
const MESSAGE = {
	to: '+447700900123',
	subject: '',
	text: 'Code 12 & more',
	parameters: [],
	providerTemplate: '',
	language: 'en',
};

/** @param {(call: { url: string, init: any }) => { status: number, body?: string }} [answer] */
const fakeSend = (answer = () => ({ status: 200, body: '{}' })) => {
	/** @type {Array<{ url: string, init: any }>} */
	const calls = [];
	/** @type {import('../adapters/providers.js').OutboundSend} */
	const send = async (url, init) => {
		calls.push({ url, init });
		const { status, body = '' } = answer({ url, init });
		return /** @type {any} */ ({ status, headers: {}, body: Buffer.from(body) });
	};
	return { send, calls };
};

describe('the success rule (N1)', () => {
	it('reads statuses as codes, ranges or classes', () => {
		expect(parseStatusRule('')).toEqual([[200, 299]]);
		expect(parseStatusRule('2xx')).toEqual([[200, 299]]);
		expect(parseStatusRule('200, 202')).toEqual([
			[200, 200],
			[202, 202],
		]);
		expect(parseStatusRule('200-204,3xx')).toEqual([
			[200, 204],
			[300, 399],
		]);
		expect(parseStatusRule('ok')).toBeNull();
		expect(parseStatusRule('299-200')).toBeNull();
	});

	it('reads a JSON path with object keys and list places', () => {
		const body = { data: [{ status: 'queued', id: 7 }], ok: true, code: 0 };
		expect(valueAt(body, 'data.0.status')).toBe('queued');
		expect(valueAt(body, '$.data.0.id')).toBe(7);
		expect(valueAt(body, 'ok')).toBe(true);
		expect(valueAt(body, 'data.1.status')).toBeUndefined();
		expect(valueAt(body, 'missing.x')).toBeUndefined();
	});

	it('judges an answer by the merchant’s rule only, never by words in it', () => {
		const statuses = parseStatusRule('2xx') ?? [];
		// a body saying "error" or "failed" is a success while the rule says so
		expect(httpOutcome(200, '{"status":"failed","error":"x","id":"g1"}', { statuses, idPath: 'id' })).toEqual({
			ok: true,
			id: 'g1',
		});
		// the gateway's own success flag
		const rule = { statuses, path: 'result.code', value: '0', idPath: 'result.messageId' };
		expect(httpOutcome(200, '{"result":{"code":0,"messageId":"m-9"}}', rule)).toEqual({ ok: true, id: 'm-9' });
		expect(httpOutcome(200, '{"result":{"code":17,"text":"no credit"}}', rule)).toEqual({
			ok: false,
			reason: 'provider_refused',
			values: { path: 'result.code' },
			detail: '{"result":{"code":17,"text":"no credit"}}',
			retryable: false,
		});
		// not JSON while a path is named: refused
		expect(httpOutcome(200, 'OK', rule)).toMatchObject({ ok: false, reason: 'provider_refused' });
		// a status outside the rule: 5xx, 408 and 429 are retried
		expect(httpOutcome(202, '', { statuses: parseStatusRule('200') ?? [] })).toMatchObject({
			reason: 'provider_status',
			retryable: false,
		});
		expect(httpOutcome(503, 'down', { statuses })).toMatchObject({ reason: 'provider_status', retryable: true });
		expect(httpOutcome(429, '', { statuses })).toMatchObject({ retryable: true });
		// no id path: no id
		expect(httpOutcome(200, '{"id":"x"}', { statuses })).toEqual({ ok: true, id: null });
	});
});

describe('the request builder (N1)', () => {
	it('builds GET, PUT and text requests with a URL template, and reads the id where the merchant says', async () => {
		const { send, calls } = fakeSend(() => ({ status: 200, body: '{"data":{"ref":"abc"},"ok":1}' }));
		const providers = createProviders({ send, policy, now: () => NOW });
		const get = {
			provider: 'http',
			method: 'GET',
			url: 'https://gateway.example.com/send?to={toDigits}&from={from}&msg={text}&key={secret}',
			contentType: 'none',
			from: 'SHOP',
			secret: 'k&1',
			successPath: 'ok',
			successValue: '1',
			idPath: 'data.ref',
		};
		expect(providerViolation('sms', get)).toBeNull();
		expect(await providers.sendMessage('sms', get, MESSAGE)).toEqual({ ok: true, id: 'abc', provider: 'http' });
		const url = new URL(calls[0]?.url ?? '');
		expect(calls[0]?.init.method).toBe('GET');
		expect(calls[0]?.init.body).toBeUndefined();
		expect(Object.fromEntries(url.searchParams)).toEqual({
			to: '447700900123',
			from: 'SHOP',
			msg: 'Code 12 & more',
			key: 'k&1',
		});
		const text = {
			provider: 'http',
			method: 'PUT',
			url: 'https://gateway.example.com/m/{to}',
			contentType: 'text',
			body: '{text}',
		};
		await providers.sendMessage('whatsapp', text, MESSAGE);
		expect(calls[1]?.url).toBe('https://gateway.example.com/m/%2B447700900123');
		expect(calls[1]?.init.method).toBe('PUT');
		expect(calls[1]?.init.headers['content-type']).toBe('text/plain; charset=utf-8');
		expect(calls[1]?.init.body).toBe('Code 12 & more');
	});

	it('refuses a rule it cannot read', () => {
		const base = { provider: 'http', url: 'https://gateway.example.com/send', body: '{"t":"{text}"}' };
		expect(providerViolation('sms', { ...base, method: 'DELETE' })).toMatch(/method/);
		expect(providerViolation('sms', { ...base, contentType: 'xml' })).toMatch(/contentType/);
		expect(providerViolation('sms', { ...base, successStatus: 'fine' })).toMatch(/successStatus/);
		expect(providerViolation('sms', { ...base, successPath: 'a..b', successValue: '1' })).toMatch(/successPath/);
		expect(providerViolation('sms', { ...base, successPath: 'ok' })).toMatch(/successValue/);
		expect(providerViolation('sms', { ...base, idPath: 'a b' })).toMatch(/idPath/);
		// a body is needed unless the request has none
		expect(providerViolation('sms', { provider: 'http', url: 'https://g.example.com/s' })).toMatch(/body/);
		expect(providerViolation('sms', { provider: 'http', url: 'https://g.example.com/s', method: 'GET' })).toBeNull();
	});

	it('known providers keep their own id paths and are judged by HTTP status only', async () => {
		const { send } = fakeSend(({ url }) =>
			url.includes('graph.facebook.com')
				? { status: 200, body: '{"messages":[{"id":"wamid.1"}],"status":"failed"}' }
				: { status: 201, body: '{"sid":"SM1","status":"failed"}' },
		);
		const providers = createProviders({ send, policy, now: () => NOW });
		expect(
			await providers.sendMessage('whatsapp', { provider: 'meta', phoneNumberId: '123456', secret: 'm' }, MESSAGE),
		).toEqual({ ok: true, id: 'wamid.1', provider: 'meta' });
		expect(
			await providers.sendMessage(
				'sms',
				{ provider: 'twilio', accountSid: `AC${'a'.repeat(32)}`, secret: 't', from: '+15550001111' },
				MESSAGE,
			),
		).toEqual({ ok: true, id: 'SM1', provider: 'twilio' });
	});
});
