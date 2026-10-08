import { createECDH } from 'node:crypto';
import { createOutboundPolicy, netError } from '@ss/net';
import { describe, expect, it } from 'vitest';
import { createProviders, providerViolation } from '../adapters/providers.js';
import { signWebhook, verifyMeta, verifyTwilio, verifyWebhook } from '../adapters/signatures.js';
import { checkSubscription, createWebPush, encryptPayload, pushKeysOf } from '../adapters/webpush.js';

const NOW = Date.parse('2026-10-01T10:00:00Z');
const policy = createOutboundPolicy({ resolve: async () => [{ address: '93.184.215.14', family: 4 }] });

/**
 * A fake outbound `send` recording calls and answering with `answer`.
 * @param {(url: string, init: any) => { status: number, body?: string, headers?: Record<string, string> } | Error} [answer]
 */
const fakeSend = (answer = () => ({ status: 200, body: '{"id":"x1"}' })) => {
	/** @type {Array<{ url: string, init: any }>} */
	const calls = [];
	/** @type {import('../adapters/providers.js').OutboundSend} */
	const send = async (url, init = {}) => {
		calls.push({ url, init });
		const out = answer(url, init);
		if (out instanceof Error) throw out;
		return { status: out.status, headers: out.headers ?? {}, body: Buffer.from(out.body ?? ''), url };
	};
	return { send, calls };
};

const MESSAGE = { to: 'ana@example.com', subject: 'Hi', text: 'Hello', parameters: [], providerTemplate: '', language: '' };
const FROM = 'Shop <shop@example.com>';

describe('provider values', () => {
	it('names what is missing or wrong', () => {
		expect(providerViolation('email', null)).toMatch(/^Pick a provider/);
		expect(providerViolation('sms', { provider: 'resend' })).toMatch(/^Pick a provider/);
		expect(providerViolation('email', { provider: 'resend', secret: 'k' })).toBe('Fill in: from.');
		expect(providerViolation('email', { provider: 'resend', secret: 'k', from: 'nope' })).toMatch(/^from must/);
		expect(providerViolation('email', { provider: 'mailgun', secret: 'k', from: FROM, domain: 'd', region: 'asia' })).toBe(
			'region must be us or eu.',
		);
		expect(providerViolation('email', { provider: 'ses', secret: 'k', from: FROM, accessKeyId: 'A', region: 'mars' })).toMatch(
			/AWS region/,
		);
		expect(providerViolation('whatsapp', { provider: 'meta', secret: 'k', phoneNumberId: 'abc' })).toMatch(/digits/);
		expect(providerViolation('sms', { provider: 'twilio', secret: 'k', from: '+1', accountSid: 'x' })).toMatch(/AC/);
		expect(providerViolation('sms', { provider: 'http', url: 'http://x', body: 'b' })).toMatch(/https/);
		expect(providerViolation('sms', { provider: 'http', url: 'https://x', body: 'b', contentType: 'xml' })).toMatch(
			/json or form/,
		);
		expect(providerViolation('sms', { provider: 'http', url: 'https://x', body: 'b', headers: '[1]' })).toMatch(/JSON object/);
		expect(providerViolation('sms', { provider: 'http', url: 'https://x', body: 'b', headers: '{"a b":"c"}' })).toMatch(
			/JSON object/,
		);
		expect(providerViolation('sms', { provider: 'http', url: 'https://x', body: 'b', headers: 'nope' })).toMatch(/JSON object/);
		expect(providerViolation('sms', { provider: 'http', url: 'https://x', body: 'b', headers: '' })).toBeNull();
	});
});

describe('e-mail providers', () => {
	it('send through SendGrid, Mailgun and Amazon SES with the merchant’s keys', async () => {
		const { send, calls } = fakeSend();
		const providers = createProviders({ send, policy, now: () => NOW });
		const headers = { 'List-Unsubscribe': '<https://u>' };
		expect(
			await providers.sendMessage(
				'email',
				{ provider: 'sendgrid', secret: 'SG.key', from: FROM },
				{ ...MESSAGE, replyTo: 'r@example.com', headers },
			),
		).toEqual({ ok: true, id: 'x1', provider: 'sendgrid' });
		expect(JSON.parse(calls[0]?.init.body)).toMatchObject({
			from: { email: 'shop@example.com', name: 'Shop' },
			reply_to: { email: 'r@example.com' },
			headers,
		});
		await providers.sendMessage('email', { provider: 'sendgrid', secret: 'SG.key', from: 'plain@example.com' }, MESSAGE);
		expect(JSON.parse(calls[1]?.init.body).from).toEqual({ email: 'plain@example.com' });
		await providers.sendMessage(
			'email',
			{ provider: 'mailgun', secret: 'mg', from: FROM, domain: 'mg.example.com', region: 'eu' },
			{ ...MESSAGE, replyTo: 'r@example.com', headers },
		);
		expect(calls[2]?.url).toBe('https://api.eu.mailgun.net/v3/mg.example.com/messages');
		expect(calls[2]?.init.headers.authorization).toBe(`Basic ${Buffer.from('api:mg').toString('base64')}`);
		expect(new URLSearchParams(calls[2]?.init.body).get('h:List-Unsubscribe')).toBe('<https://u>');
		await providers.sendMessage('email', { provider: 'mailgun', secret: 'mg', from: FROM, domain: 'mg.example.com' }, MESSAGE);
		expect(calls[3]?.url).toBe('https://api.mailgun.net/v3/mg.example.com/messages');
		await providers.sendMessage(
			'email',
			{ provider: 'ses', secret: 'aws-secret', accessKeyId: 'AKIAEXAMPLE', region: 'eu-west-1', from: FROM },
			{ ...MESSAGE, replyTo: 'r@example.com', headers },
		);
		expect(calls[4]?.url).toBe('https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails');
		expect(calls[4]?.init.headers.authorization).toMatch(
			/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/20261001\/eu-west-1\/ses\/aws4_request/,
		);
		expect(JSON.parse(calls[4]?.init.body).Content.Simple.Headers).toEqual([
			{ Name: 'List-Unsubscribe', Value: '<https://u>' },
		]);
		await providers.sendMessage(
			'email',
			{ provider: 'ses', secret: 's', accessKeyId: 'A', region: 'eu-west-1', from: FROM },
			MESSAGE,
		);
		expect(JSON.parse(calls[5]?.init.body).Content.Simple.Headers).toBeUndefined();
		await providers.sendMessage('email', { provider: 'resend', secret: 're', from: FROM }, MESSAGE);
		expect(JSON.parse(calls[6]?.init.body)).not.toHaveProperty('headers');
		expect(JSON.stringify(calls.map((call) => call.url))).not.toContain('secret');
	});

	it('send through SMTP with TLS and sign in for the test', async () => {
		/** @type {any[]} */
		const seen = [];
		const providers = createProviders({
			send: fakeSend().send,
			policy,
			now: () => NOW,
			createTransport: (options) => ({
				sendMail: async (mail) => {
					seen.push({ options, mail });
					return { messageId: '<1@x>', accepted: [mail.to] };
				},
			}),
		});
		const value = { provider: 'smtp', host: 'smtp.example.com', port: 587, username: 'u', secret: 'p4ss', from: FROM };
		expect(
			await providers.sendMessage('email', value, {
				...MESSAGE,
				replyTo: 'r@example.com',
				headers: { 'List-Unsubscribe': '<https://u>' },
			}),
		).toEqual({
			ok: true,
			id: '<1@x>',
			provider: 'smtp',
		});
		expect(seen[0].options).toMatchObject({ port: 587, requireTLS: true, auth: { user: 'u', pass: 'p4ss' } });
		expect(seen[0].mail).toMatchObject({ from: FROM, to: ['ana@example.com'], replyTo: 'r@example.com' });
		expect(await providers.test('email', value)).toEqual({ ok: true });
		const failing = createProviders({
			send: fakeSend().send,
			policy,
			now: () => NOW,
			createTransport: () => ({
				sendMail: async () => {
					throw Object.assign(new Error('x'), { code: 'ETIMEDOUT' });
				},
				verify: async () => {
					throw Object.assign(new Error('bad login'), { code: 'EAUTH', responseCode: 535 });
				},
			}),
		});
		expect(await failing.sendMessage('email', value, MESSAGE)).toMatchObject({ ok: false, retryable: true });
		expect(await failing.test('email', value)).toEqual({ ok: false, message: 'smtp delivery failed' });
		expect(await failing.sendMessage('email', { ...value, host: '10.0.0.1' }, MESSAGE)).toMatchObject({
			ok: false,
			retryable: false,
		});
	});
});

describe('SMS and WhatsApp providers', () => {
	it('send through a generic HTTP gateway (Connectivity.pk form, or JSON with headers)', async () => {
		const { send, calls } = fakeSend(() => ({ status: 200, body: '{"sent":"true","id":"g1"}' }));
		const providers = createProviders({ send, policy, now: () => NOW });
		const connectivity = {
			provider: 'http',
			url: 'https://connectivity.pk/api/messages/chat',
			contentType: 'form',
			body: 'instance_id=9&token={secret}&to={toDigits}&body={text}&priority=0',
			secret: 'tok&en',
		};
		const sms = { ...MESSAGE, to: '+923001234567', text: 'Your code: 12 & more' };
		expect(await providers.sendMessage('whatsapp', connectivity, sms)).toEqual({ ok: true, id: 'g1', provider: 'http' });
		expect(calls[0]?.init.headers['content-type']).toBe('application/x-www-form-urlencoded');
		expect(Object.fromEntries(new URLSearchParams(calls[0]?.init.body))).toEqual({
			instance_id: '9',
			token: 'tok&en',
			to: '923001234567',
			body: 'Your code: 12 & more',
			priority: '0',
		});
		const json = {
			provider: 'http',
			url: 'https://sms.example.com/send',
			body: '{"to":"{to}","message":"{text}"}',
			headers: '{"Authorization":"Key {secret}"}',
			secret: 's3',
		};
		await providers.sendMessage('sms', json, { ...sms, text: 'Say "hi"' });
		expect(JSON.parse(calls[1]?.init.body)).toEqual({ to: '+923001234567', message: 'Say "hi"' });
		expect(calls[1]?.init.headers.authorization).toBe('Key s3');
		await providers.sendMessage('sms', { provider: 'http', url: 'https://sms.example.com/send', body: '{"t":"{text}"}' }, sms);
		expect(calls[2]?.init.headers['content-type']).toBe('application/json');
		expect(await providers.test('sms', json)).toEqual({ ok: true });
		expect(await providers.test('sms', { ...json, url: 'https://10.0.0.1/x' })).toMatchObject({ ok: false });
	});

	it('send WhatsApp through Twilio and plain text through Meta, and report unusable values', async () => {
		const { send, calls } = fakeSend();
		const providers = createProviders({ send, policy, now: () => NOW });
		const twilio = { provider: 'twilio', accountSid: `AC${'b'.repeat(32)}`, secret: 't', from: '+15550001111' };
		await providers.sendMessage('whatsapp', twilio, { ...MESSAGE, to: '+15550002222' });
		expect(Object.fromEntries(new URLSearchParams(calls[0]?.init.body))).toMatchObject({
			To: 'whatsapp:+15550002222',
			From: 'whatsapp:+15550001111',
		});
		await providers.sendMessage('sms', { ...twilio, from: `MG${'c'.repeat(32)}` }, { ...MESSAGE, to: '+15550002222' });
		expect(new URLSearchParams(calls[1]?.init.body).get('MessagingServiceSid')).toBe(`MG${'c'.repeat(32)}`);
		await providers.sendMessage(
			'whatsapp',
			{ provider: 'meta', phoneNumberId: '123456', secret: 'm' },
			{ ...MESSAGE, to: '+15550002222' },
		);
		expect(JSON.parse(calls[2]?.init.body)).toMatchObject({ type: 'text', text: { body: 'Hello' } });
		await providers.sendMessage(
			'whatsapp',
			{ provider: 'meta', phoneNumberId: '123456', secret: 'm' },
			{ ...MESSAGE, to: '+15550002222', providerTemplate: 'hello', language: 'ur' },
		);
		expect(JSON.parse(calls[3]?.init.body).template).toEqual({ name: 'hello', language: { code: 'ur' } });
		expect(await providers.sendMessage('sms', { provider: 'meta' }, MESSAGE)).toMatchObject({
			ok: false,
			retryable: false,
			provider: 'meta',
		});
	});

	it('test each provider with a read-only call and turn network errors into retryable failures', async () => {
		const { send, calls } = fakeSend((url) => (url.includes('mailgun') ? { status: 404 } : { status: 200, body: '{}' }));
		const providers = createProviders({ send, policy, now: () => NOW });
		expect(await providers.test('email', { provider: 'sendgrid', secret: 's', from: FROM })).toEqual({ ok: true });
		expect(await providers.test('email', { provider: 'mailgun', secret: 's', from: FROM, domain: 'd' })).toEqual({
			ok: false,
			message: 'The provider answered HTTP 404.',
		});
		expect(
			await providers.test('email', { provider: 'mailgun', secret: 's', from: FROM, domain: 'd', region: 'eu' }),
		).toMatchObject({ ok: false });
		expect(
			await providers.test('email', { provider: 'ses', secret: 's', accessKeyId: 'A', region: 'us-east-1', from: FROM }),
		).toEqual({ ok: true });
		expect(
			await providers.test('sms', { provider: 'twilio', accountSid: `AC${'d'.repeat(32)}`, secret: 't', from: '+1555' }),
		).toEqual({ ok: true });
		expect(await providers.test('whatsapp', { provider: 'meta', phoneNumberId: '123456', secret: 'm' })).toEqual({ ok: true });
		expect(await providers.test('whatsapp', { provider: 'meta' })).toMatchObject({ ok: false });
		expect(calls.map((call) => call.init.method)).toEqual(['GET', 'GET', 'GET', 'GET', 'GET', 'GET']);
		const down = createProviders({
			send: fakeSend(() => netError('timeout', 'deadline', 'slow')).send,
			policy,
			now: () => NOW,
		});
		expect(await down.sendMessage('email', { provider: 'resend', secret: 'r', from: FROM }, MESSAGE)).toMatchObject({
			ok: false,
			retryable: true,
			error: 'The provider could not be reached (timeout).',
		});
		const blocked = createProviders({
			send: fakeSend(() => netError('ssrf_blocked', 'private', 'no')).send,
			policy,
			now: () => NOW,
		});
		expect(await blocked.sendMessage('email', { provider: 'resend', secret: 'r', from: FROM }, MESSAGE)).toMatchObject({
			retryable: false,
		});
		const plain = createProviders({ send: fakeSend(() => new Error('boom')).send, policy, now: () => NOW });
		expect(await plain.sendMessage('email', { provider: 'resend', secret: 'r', from: FROM }, MESSAGE)).toMatchObject({
			error: 'The provider could not be reached (network).',
		});
	});
});

describe('web push', () => {
	const keyPair = () => {
		const ecdh = createECDH('prime256v1');
		ecdh.generateKeys();
		return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: ecdh.getPrivateKey().toString('base64url') };
	};

	it('checks push keys and browser subscriptions', () => {
		const pair = keyPair();
		expect(pushKeysOf(null)).toMatchObject({ ok: false });
		expect(pushKeysOf({ ...pair, subject: 'ops@example.com' })).toMatchObject({ ok: false, message: /contact/ });
		expect(pushKeysOf({ subject: 'mailto:a@b.c' })).toMatchObject({ ok: false, message: /base64url/ });
		expect(pushKeysOf({ publicKey: 'AAAA', privateKey: pair.privateKey, subject: 'mailto:a@b.c' })).toMatchObject({
			message: /P-256/,
		});
		expect(pushKeysOf({ publicKey: keyPair().publicKey, privateKey: pair.privateKey, subject: 'mailto:a@b.c' })).toMatchObject({
			message: /does not belong/,
		});
		const notOnCurve = Buffer.alloc(65, 1);
		notOnCurve[0] = 4;
		expect(
			pushKeysOf({
				publicKey: notOnCurve.toString('base64url'),
				privateKey: pair.privateKey,
				subject: 'https://shop.example',
			}),
		).toMatchObject({
			ok: false,
		});
		expect(pushKeysOf({ ...pair, subject: 'https://shop.example' })).toMatchObject({ ok: true });
		const keys = { p256dh: keyPair().publicKey, auth: Buffer.alloc(16).toString('base64url') };
		expect(checkSubscription({ endpoint: 'https://push.example/x', keys })).toEqual({
			endpoint: 'https://push.example/x',
			keys,
		});
		expect(checkSubscription({ endpoint: 'https://push.example/x', keys: { ...keys, auth: 'AA' } })).toBeNull();
		expect(checkSubscription({ endpoint: 'https://push.example/x', keys: { p256dh: 1, auth: 2 } })).toBeNull();
		expect(checkSubscription({ endpoint: 'ftp://x', keys })).toBeNull();
		expect(checkSubscription('x')).toBeNull();
	});

	it('encrypts with a fixed salt and server key (RFC 8291 layout) and maps push service answers', async () => {
		const server = createECDH('prime256v1');
		server.generateKeys();
		const keys = { p256dh: keyPair().publicKey, auth: Buffer.alloc(16, 1).toString('base64url') };
		const body = encryptPayload({ payload: Buffer.from('{}'), keys, salt: Buffer.alloc(16, 2), serverKeys: server });
		expect(body.subarray(0, 16)).toEqual(Buffer.alloc(16, 2));
		expect(body.readUInt32BE(16)).toBe(4096);
		expect(body.subarray(21, 86)).toEqual(server.getPublicKey());
		expect(body.length).toBe(86 + 3 + 16);
		const vapid = { ...keyPair(), subject: 'mailto:ops@example.com' };
		const subscription = { endpoint: 'https://push.example/s/1', keys };
		for (const [status, expected] of /** @type {const} */ ([
			[201, { ok: true }],
			[410, { ok: false, gone: true, retryable: false }],
			[429, { ok: false, retryable: true }],
			[400, { ok: false, retryable: false }],
		])) {
			const push = createWebPush({
				send: fakeSend(() => ({ status, headers: { location: 'https://push.example/m/1' } })).send,
				now: () => NOW,
			});
			expect(await push.push(vapid, subscription, { title: 't', body: 'b' })).toMatchObject(expected);
		}
		const down = createWebPush({ send: fakeSend(() => netError('timeout', 'deadline', 'slow')).send, now: () => NOW });
		expect(await down.push(vapid, subscription, { title: 't', body: 'b' })).toMatchObject({ ok: false, retryable: true });
		const bare = createWebPush({ send: fakeSend(() => new Error('x')).send, now: () => NOW });
		expect(await bare.push(vapid, subscription, { title: 't', body: 'b' })).toMatchObject({ error: /\(network\)/ });
		expect(await bare.push({}, subscription, { title: 't', body: 'b' })).toMatchObject({ ok: false, error: /not usable/ });
	});
});

describe('signatures', () => {
	it('signs webhooks and checks them as a receiver does', () => {
		const header = signWebhook('{"a":1}', 'secret', NOW);
		expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
		expect(verifyWebhook({ body: '{"a":1}', header, secret: 'secret', now: NOW })).toBe(true);
		expect(verifyWebhook({ body: '{"a":2}', header, secret: 'secret', now: NOW })).toBe(false);
		expect(verifyWebhook({ body: '{"a":1}', header, secret: 'secret', now: NOW + 301_000 })).toBe(false);
		expect(verifyWebhook({ body: '{"a":1}', header: null, secret: 'secret', now: NOW })).toBe(false);
		expect(verifyWebhook({ body: '{"a":1}', header: 't=1', secret: 'secret', now: 1000 })).toBe(false);
	});

	it('checks Twilio and WhatsApp Cloud API signatures', () => {
		const params = new URLSearchParams({ Body: 'STOP', From: '+1' });
		expect(verifyTwilio({ url: 'https://x/y', params, signature: null, authToken: 't' })).toBe(false);
		expect(verifyTwilio({ url: 'https://x/y', params, signature: 'AAAA', authToken: 't' })).toBe(false);
		expect(verifyMeta({ body: '{}', signature: null, appSecret: 's' })).toBe(false);
		expect(verifyMeta({ body: '{}', signature: 'sha256=00', appSecret: 's' })).toBe(false);
	});
});
