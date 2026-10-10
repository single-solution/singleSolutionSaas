import { createDecipheriv, createHmac } from 'node:crypto';
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyWebhook } from '../adapters/signatures.js';
import { ADMIN_ORIGIN, GATEWAY_URL, HOOK_URL, ORIGIN, PUSH_ORIGIN, browserSubscription, pushKeys, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

const ALL = [
	'email',
	'sms',
	'whatsapp',
	'browser_push',
	'staff_push',
	'webhooks',
	'fallback',
	'quiet_hours',
	'send_limits',
	'delayed_send',
	'multi_language',
	'send_api',
];
const RESEND = { provider: 'resend', secret: 're_secret_1234', from: 'Shop <shop@shop.example.com>' };
const TWILIO = { provider: 'twilio', accountSid: `AC${'a'.repeat(32)}`, secret: 'twilio-token-9876', from: '+15550001111' };
const META = {
	provider: 'meta',
	phoneNumberId: '1234567890',
	secret: 'meta-token-5555',
	appSecret: 'meta-app-secret',
	verifyToken: 'verify-me',
};
const WEBHOOK_SECRET = 'whsec-0123456789abcdefghijklmnop';

/**
 * Decrypt an aes128gcm push body with the browser's keys (what the browser does).
 * @param {Buffer} body
 * @param {ReturnType<typeof browserSubscription>} browser
 */
const decryptPush = (body, browser) => {
	const salt = body.subarray(0, 16);
	const idlen = body.readUInt8(20);
	const asPublic = body.subarray(21, 21 + idlen);
	const shared = browser.ecdh.computeSecret(asPublic);
	/** @param {Buffer} key @param {Buffer} data */
	const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
	const prkKey = hmac(browser.auth, shared);
	const ikm = hmac(
		prkKey,
		Buffer.concat([Buffer.from('WebPush: info\0'), browser.ecdh.getPublicKey(), asPublic, Buffer.from([1])]),
	);
	const prk = hmac(salt, ikm);
	const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
	const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
	const data = body.subarray(21 + idlen);
	const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
	decipher.setAuthTag(data.subarray(data.length - 16));
	const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
	return JSON.parse(plain.subarray(0, plain.length - 1).toString('utf8'));
};

/** The path of the unsubscribe link in the last e-mail's List-Unsubscribe header. */
const unsubscribeLink = () => {
	const body = JSON.parse(env.providers.callsTo('https://api.resend.com').at(-1)?.body ?? '{}');
	return /\/unsubscribe\/[^>]+/.exec(body.headers?.['List-Unsubscribe'] ?? '')?.[0] ?? '';
};

beforeAll(async () => {
	env = await setup();
});
afterAll(async () => {
	await env.product.close();
});

describe('before setup', () => {
	it('refuses sends while the channel is off and until the merchant database is connected', async () => {
		const off = await env.send('email', { template: 'welcome', to: { email: 'a@example.com' } });
		expect(off.status).toBe(403);
		expect(off.json.type).toMatch(/feature_off$/);
		await env.switchOn(ALL);
		const noDb = await env.send('email', { template: 'welcome', to: { email: 'a@example.com' } });
		expect(noDb.json.type).toMatch(/database_not_connected$/);
		await env.connectDatabase();
	});

	it('tests provider connections live when they are saved (fake providers, no network)', async () => {
		expect((await env.connect('email', RESEND)).status).toBe('connected');
		expect(env.providers.callsTo('https://api.resend.com').at(-1)).toMatchObject({
			method: 'GET',
			url: 'https://api.resend.com/domains',
		});
		env.providers.respond('https://api.twilio.com', () => ({ status: 401, body: '{"message":"bad"}' }));
		const refused = await env.connect('sms', TWILIO);
		expect(refused).toMatchObject({ status: 'test_failed', message: 'The provider answered HTTP 401.', last4: '9876' });
		env.providers.reset('https://api.twilio.com');
		expect((await env.connect('sms', TWILIO)).status).toBe('connected');
		expect((await env.connect('whatsapp', META)).status).toBe('connected');
		expect((await env.connect('push_keys', pushKeys())).status).toBe('connected');
		expect((await env.connect('push_keys', { ...pushKeys(), subject: 'nope' })).status).toBe('test_failed');
		expect((await env.connect('push_keys', pushKeys())).status).toBe('connected');
		expect((await env.connect('webhook_secret', 'short')).status).toBe('test_failed');
		expect((await env.connect('webhook_secret', WEBHOOK_SECRET)).status).toBe('connected');
		const listed = await env.dashboard(await env.adminSession(), 'GET', `/v1/dashboard/websites/${env.websiteId}/connections`);
		const text = await listed.text();
		expect(text).not.toContain('re_secret_1234');
		expect(text).not.toContain(WEBHOOK_SECRET);
	});
});

describe('templates', () => {
	it('are saved, listed and deleted in the dashboard, with Recent changes', async () => {
		const cookie = await env.adminSession();
		const path = `/v1/dashboard/websites/${env.websiteId}/templates`;
		const bad = await env.dashboard(cookie, 'PUT', path, { key: 'Bad Key', channel: 'email', text: 'x' });
		expect(bad.status).toBe(422);
		await env.template({
			key: 'welcome',
			channel: 'email',
			subject: 'Hi {name}',
			text: 'Welcome {name}. Leave: {unsubscribeUrl}',
		});
		await env.template({
			key: 'welcome',
			channel: 'email',
			language: 'ur',
			subject: 'Salam {name}',
			text: 'Khush amdeed {name}',
		});
		await env.template({ key: 'welcome', channel: 'sms', text: 'Welcome {name}' });
		await env.template({ key: 'accounts.code', channel: 'sms', text: 'Code {code}', required: true, urgent: true });
		await env.template({ key: 'accounts.code', channel: 'whatsapp', text: 'Code {code}', required: true, urgent: true });
		await env.template({ key: 'promo', channel: 'whatsapp', text: 'Sale {pct}', providerTemplate: 'sale_alert' });
		await env.template({ key: 'promo', channel: 'email', subject: 'Sale', text: 'Sale {pct}' });
		await env.template({ key: 'alert', channel: 'push', subject: 'Back in stock', text: '{item} is back' });
		await env.template({ key: 'alert', channel: 'staff_push', subject: 'New order', text: 'Order {order}' });
		await env.template({ key: 'gone', channel: 'sms', text: 'Bye' });
		const list = await (await env.dashboard(cookie, 'GET', path)).json();
		expect(list.items).toHaveLength(10);
		expect(list.items).toContainEqual(expect.objectContaining({ key: 'welcome', channel: 'email', language: 'ur' }));
		expect((await env.dashboard(cookie, 'DELETE', `${path}/gone/sms/default`)).status).toBe(204);
		expect((await env.dashboard(cookie, 'DELETE', `${path}/gone/sms/default`)).status).toBe(404);
		expect((await env.dashboard(cookie, 'DELETE', `${path}/gone/fax/default`)).status).toBe(404);
		const overview = await (await env.dashboard(cookie, 'GET', `/v1/dashboard/websites/${env.websiteId}/overview`)).json();
		expect(overview.recentChanges.map((/** @type {{ detail: string }} */ c) => c.detail)).toContain(
			'Template gone (sms, default): deleted',
		);
	});
});

describe('the send API', () => {
	it('sends a template by e-mail with the values, the unsubscribe link and headers', async () => {
		const sent = await env.send(
			'email',
			{ template: 'welcome', to: { email: 'Ana@Example.com' }, values: { name: 'Ana' } },
			{ 'idempotency-key': 'k-1' },
		);
		expect(sent.status).toBe(201);
		expect(sent.json).toMatchObject({
			status: 'sent',
			to: 'ana@example.com',
			subject: 'Hi Ana',
			attempts: [{ outcome: 'sent', provider: 'resend' }],
		});
		const call = env.providers.callsTo('https://api.resend.com').at(-1);
		const body = JSON.parse(call?.body ?? '{}');
		expect(body).toMatchObject({ from: RESEND.from, to: ['ana@example.com'], subject: 'Hi Ana' });
		expect(body.text).toMatch(/^Welcome Ana\. Leave: https:\/\/notifications\.example\.dev\/unsubscribe\/web_\w+\/[\w-]{24}$/);
		expect(body.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
		expect(call?.headers.authorization).toBe('Bearer re_secret_1234');
		const again = await env.send(
			'email',
			{ template: 'welcome', to: { email: 'ana@example.com' } },
			{ 'idempotency-key': 'k-1' },
		);
		expect(again.status).toBe(409);
	});

	it('refuses unknown templates, bad recipients and values, and own keys without the Merchant send API', async () => {
		expect((await env.send('email', { template: 'nope', to: { email: 'a@example.com' } })).json.type).toMatch(
			/template_not_found$/,
		);
		expect((await env.send('email', { template: 'welcome', to: { phone: '+15550002222' } })).status).toBe(422);
		expect((await env.send('email', { template: 'welcome', to: { email: 'not-an-email' } })).status).toBe(422);
		expect((await env.send('email', { template: 'welcome', to: { email: 'a@example.com' }, values: [] })).status).toBe(422);
		expect((await env.send('email', { template: 'welcome', to: { email: 'a@example.com' }, language: '!!' })).status).toBe(422);
		expect((await env.send('email', { to: { email: 'a@example.com' } })).status).toBe(422);
		await env.switchOn(ALL.filter((key) => key !== 'send_api'));
		const own = await env.send('email', { template: 'welcome', to: { email: 'a@example.com' } });
		expect(own.status).toBe(403);
		const product = await env.send('sms', {
			template: 'accounts.code',
			to: { phone: '+15550002222' },
			values: { code: 123456 },
		});
		expect(product.json).toMatchObject({ status: 'sent', text: 'Code 123456' });
		await env.switchOn(ALL);
		// a server token never works from a browser
		const browser = await env.call('POST', '/v1/messages/sms', {
			token: env.server,
			origin: ORIGIN,
			body: { template: 'accounts.code', to: { phone: '+15550002222' } },
		});
		expect(browser.status).toBe(401);
	});

	it('sends SMS through Twilio and WhatsApp through Meta, with provider templates', async () => {
		const sms = await env.send('sms', { template: 'welcome', to: { phone: '+44 7700 900123' }, values: { name: 'Bo' } });
		expect(sms.json.status).toBe('sent');
		const twilio = env.providers.callsTo('https://api.twilio.com').at(-1);
		expect(twilio?.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO.accountSid}/Messages.json`);
		expect(new URLSearchParams(twilio?.body)).toEqual(
			new URLSearchParams({ To: '+447700900123', Body: 'Welcome Bo', From: '+15550001111' }),
		);
		const wa = await env.send('whatsapp', { template: 'promo', to: { phone: '+447700900123' }, values: { pct: '20%' } });
		expect(wa.json.status).toBe('sent');
		const meta = JSON.parse(env.providers.callsTo('https://graph.facebook.com').at(-1)?.body ?? '{}');
		expect(meta).toMatchObject({
			messaging_product: 'whatsapp',
			to: '447700900123',
			type: 'template',
			template: { name: 'sale_alert', components: [{ type: 'body', parameters: [{ type: 'text', text: '20%' }] }] },
		});
	});

	it('picks the recipient’s language only while multi-language templates are on', async () => {
		const ur = await env.send('email', {
			template: 'welcome',
			to: { email: 'u@example.com', language: 'ur-PK' },
			values: { name: 'Ali' },
		});
		expect(ur.json.subject).toBe('Salam Ali');
		await env.switchOn(ALL.filter((key) => key !== 'multi_language'));
		const plain = await env.send('email', {
			template: 'welcome',
			to: { email: 'u@example.com' },
			language: 'ur',
			values: { name: 'Ali' },
		});
		expect(plain.json.subject).toBe('Hi Ali');
		await env.switchOn(ALL);
	});

	it('retries on later uses, then falls back to another channel; every attempt is logged', async () => {
		await env.setting('fallback', 'whatsapp', 'sms');
		env.providers.respond('https://graph.facebook.com', () => ({ status: 503 }));
		const first = await env.send('whatsapp', {
			template: 'accounts.code',
			to: { phone: '+15550003333', email: 'c@example.com' },
			values: { code: '42' },
		});
		expect(first.json).toMatchObject({ status: 'retrying', attempts: [{ outcome: 'failed', provider: 'meta' }] });
		// not due yet: a use does nothing
		await env.call('GET', '/v1/messages?limit=1', { token: env.server });
		expect(
			(await (await env.call('GET', `/v1/messages/${first.json.id}`, { token: env.server })).json()).attempts,
		).toHaveLength(1);
		env.advance(61_000);
		await env.call('GET', '/v1/messages?limit=1', { token: env.server });
		env.advance(5 * 60_000 + 1000);
		await env.call('GET', '/v1/messages?limit=1', { token: env.server });
		const done = await (await env.call('GET', `/v1/messages/${first.json.id}`, { token: env.server })).json();
		expect(done.status).toBe('sent');
		expect(done.channel).toBe('sms');
		expect(done.attempts.map((/** @type {any} */ a) => `${a.channel}:${a.outcome}`)).toEqual([
			'whatsapp:failed',
			'whatsapp:failed',
			'whatsapp:failed',
			'sms:sent',
		]);
		// a final error goes to the fallback at once; with no fallback it fails
		env.providers.respond('https://graph.facebook.com', () => ({ status: 200, body: '{"error":{"message":"bad number"}}' }));
		const failed = await env.send('whatsapp', { template: 'promo', to: { phone: '+15550004444' }, values: { pct: '5' } });
		expect(failed.json).toMatchObject({ status: 'failed', reason: '{"message":"bad number"}' });
		env.providers.reset('https://graph.facebook.com');
	});

	it('honours unsubscribes for optional messages only, through the hosted page', async () => {
		await env.send('email', { template: 'promo', to: { email: 'opt@example.com' }, values: { pct: '10' } });
		const link = unsubscribeLink();
		expect(link).not.toBe('');
		const page = await env.call('GET', link);
		expect(page.status).toBe(200);
		expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
		const html = await page.text();
		expect(html).toContain('Stop optional messages from shop.example.com?');
		expect(html).toContain(`action="${link}"`);
		// still subscribed after only opening it
		expect((await env.send('email', { template: 'promo', to: { email: 'opt@example.com' } })).json.status).toBe('sent');
		const done = await env.call('POST', link, { raw: 'List-Unsubscribe=One-Click' });
		expect(await done.text()).toContain('You are unsubscribed.');
		const skipped = await env.send('email', { template: 'promo', to: { email: 'opt@example.com' } });
		expect(skipped.json).toMatchObject({ status: 'skipped', reason: 'unsubscribed' });
		await env.template({
			key: 'accounts.reset',
			channel: 'email',
			subject: 'Reset',
			text: 'Reset {code}',
			required: true,
			urgent: true,
		});
		expect((await env.send('email', { template: 'accounts.reset', to: { email: 'opt@example.com' } })).json.status).toBe(
			'sent',
		);
		expect((await env.call('GET', `/unsubscribe/${env.websiteId}/${'x'.repeat(24)}`)).status).toBe(404);
		expect((await env.call('GET', '/unsubscribe/web_nope/abc')).status).toBe(404);
	});

	it('the merchant edits the hosted page’s words and theme', async () => {
		const cookie = await env.adminSession();
		await env.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${env.websiteId}/texts/unsubscribe.title`, {
			value: 'Afmelden',
		});
		await env.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${env.websiteId}/theme`, {
			radius: 12,
			customCss: '.box{color:red}</style>',
		});
		await env.send('email', { template: 'promo', to: { email: 'nl@example.com' } });
		const html = await (await env.call('GET', unsubscribeLink())).text();
		expect(html).toContain('<title>Afmelden</title>');
		expect(html).toContain('--ss-radius: 12px;');
		expect(html).not.toContain('{color:red}</style>');
	});

	it('unsubscribes by keyword through signed Twilio and WhatsApp Cloud API replies', async () => {
		const url = `https://notifications.example.dev/v1/inbound/${env.websiteId}/sms`;
		const params = new URLSearchParams({ From: '+15550005555', Body: ' stop ' });
		const data = [...params.keys()].sort().reduce((text, name) => `${text}${name}${params.get(name)}`, url);
		const signature = createHmac('sha1', TWILIO.secret).update(data).digest('base64');
		const bad = await env.call('POST', `/v1/inbound/${env.websiteId}/sms`, {
			raw: params.toString(),
			headers: { 'x-twilio-signature': 'nope' },
		});
		expect(bad.status).toBe(401);
		const ok = await env.call('POST', `/v1/inbound/${env.websiteId}/sms`, {
			raw: params.toString(),
			headers: { 'x-twilio-signature': signature },
		});
		expect(ok.status).toBe(200);
		expect(await ok.text()).toBe('<Response/>');
		expect((await env.send('sms', { template: 'welcome', to: { phone: '+15550005555' } })).json.status).toBe('skipped');

		const body = JSON.stringify({
			entry: [{ changes: [{ value: { messages: [{ from: '15550006666', text: { body: 'UNSUBSCRIBE' } }] } }] }],
		});
		const hub = `sha256=${createHmac('sha256', META.appSecret).update(body).digest('hex')}`;
		const meta = await env.call('POST', `/v1/inbound/${env.websiteId}/whatsapp`, {
			raw: body,
			type: 'application/json',
			headers: { 'x-hub-signature-256': hub },
		});
		expect(meta.status).toBe(204);
		expect((await env.send('whatsapp', { template: 'promo', to: { phone: '+15550006666' } })).json.status).toBe('skipped');
		const verify = await env.call(
			'GET',
			`/v1/inbound/${env.websiteId}/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1158201444`,
		);
		expect(await verify.text()).toBe('1158201444');
		expect((await env.call('GET', `/v1/inbound/${env.websiteId}/whatsapp?hub.mode=subscribe&hub.verify_token=x`)).status).toBe(
			403,
		);
		expect((await env.call('POST', `/v1/inbound/${env.websiteId}/fax`, { raw: '' })).status).toBe(404);
		expect((await env.call('POST', `/v1/inbound/web_nope/sms`, { raw: '' })).status).toBe(404);
	});

	it('caps messages per recipient with send limits', async () => {
		await env.setting('send_limits', 'perHour', 1);
		const first = await env.send('sms', { template: 'welcome', to: { phone: '+15550007777' } });
		expect(first.json.status).toBe('sent');
		const second = await env.send('sms', { template: 'welcome', to: { phone: '+15550007777' } });
		expect(second.json).toMatchObject({ status: 'skipped', reason: 'limited' });
		env.advance(3_600_001);
		expect((await env.send('sms', { template: 'welcome', to: { phone: '+15550007777' } })).json.status).toBe('sent');
		await env.setting('send_limits', 'perHour', 100);
	});

	it('holds non-urgent messages during quiet hours until the recipient’s morning', async () => {
		// 2026-10-01T23:00 in Asia/Karachi (UTC+5) is 18:00 UTC
		env.advance(Date.parse('2026-10-02T18:00:00Z') - env.now());
		const held = await env.send('sms', { template: 'welcome', to: { phone: '+15550008888', timeZone: 'Asia/Karachi' } });
		expect(held.json).toMatchObject({ status: 'queued', dueAt: '2026-10-03T03:00:00.000Z', attempts: [] });
		const urgent = await env.send('sms', {
			template: 'accounts.code',
			to: { phone: '+15550008888', timeZone: 'Asia/Karachi' },
		});
		expect(urgent.json.status).toBe('sent');
		env.advance(Date.parse('2026-10-03T03:00:30Z') - env.now());
		await env.call('GET', '/v1/messages?limit=1', { token: env.server });
		expect((await (await env.call('GET', `/v1/messages/${held.json.id}`, { token: env.server })).json()).status).toBe('sent');
		// equal hours: no quiet hours
		await env.setting('quiet_hours', 'endHour', 21);
	});

	it('holds them by the business.json time zone when the recipient names none', async () => {
		await env.businessJson({ name: 'Shop', timeZone: 'Asia/Karachi' });
		await env.setting('quiet_hours', 'endHour', 8);
		// 17:30 UTC is 22:30 in Karachi: quiet there, not in UTC
		env.advance(Date.parse('2026-10-03T17:30:00Z') - env.now());
		const held = await env.send('sms', { template: 'welcome', to: { phone: '+15550008899' } });
		expect(held.json).toMatchObject({ status: 'queued', dueAt: '2026-10-04T03:00:00.000Z' });
		// the recipient's own time zone still wins
		const own = await env.send('sms', { template: 'welcome', to: { phone: '+15550008898', timeZone: 'UTC' } });
		expect(own.json.status).toBe('sent');
		await env.businessJson({ name: 'shop.example.com', timeZone: 'UTC' });
		const utc = await env.send('sms', { template: 'welcome', to: { phone: '+15550008897' } });
		expect(utc.json.status).toBe('sent');
		await env.setting('quiet_hours', 'endHour', 21);
	});

	it('sends a delayed message on the first use after its time', async () => {
		const sendAt = new Date(env.now() + 2 * 3_600_000).toISOString();
		const later = await env.send('email', { template: 'accounts.reset', to: { email: 'later@example.com' }, sendAt });
		expect(later.json).toMatchObject({ status: 'queued', dueAt: sendAt });
		expect(
			(await env.send('email', { template: 'accounts.reset', to: { email: 'x@example.com' }, sendAt: 'tomorrow' })).status,
		).toBe(422);
		const tooFar = new Date(env.now() + 40 * 86_400_000).toISOString();
		expect(
			(await env.send('email', { template: 'accounts.reset', to: { email: 'x@example.com' }, sendAt: tooFar })).status,
		).toBe(422);
		env.advance(2 * 3_600_000);
		await env.call('GET', '/v1/messages?limit=1', { token: env.server });
		expect((await (await env.call('GET', `/v1/messages/${later.json.id}`, { token: env.server })).json()).status).toBe('sent');
		await env.switchOn(ALL.filter((key) => key !== 'delayed_send'));
		expect((await env.send('email', { template: 'accounts.reset', to: { email: 'x@example.com' }, sendAt })).status).toBe(403);
		await env.switchOn(ALL);
	});

	it('sends browser push to a subscribed visitor, encrypted for the browser, and forgets gone browsers', async () => {
		const browser = browserSubscription();
		const subscribed = await env.call('POST', '/v1/push/subscriptions', {
			token: env.browser,
			origin: ORIGIN,
			body: { subscription: browser.subscription },
		});
		expect(subscribed.status).toBe(201);
		const { subscriberId } = await subscribed.json();
		expect(subscribed.headers.get('access-control-allow-origin')).toBe(ORIGIN);
		const bad = await env.call('POST', '/v1/push/subscriptions', {
			token: env.browser,
			origin: ORIGIN,
			body: { subscription: { endpoint: 'http://x' } },
		});
		expect(bad.status).toBe(422);
		const pushed = await env.send('push', { template: 'alert', to: { subscriberId }, values: { item: 'Phone', url: '/p/1' } });
		expect(pushed.json.status).toBe('sent');
		const call = env.providers.callsTo(PUSH_ORIGIN).at(-1);
		expect(call?.headers['content-encoding']).toBe('aes128gcm');
		expect(call?.headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
		expect(decryptPush(Buffer.from(call?.body ?? '', 'base64'), browser)).toEqual({
			title: 'Back in stock',
			body: 'Phone is back',
			url: '/p/1',
		});
		env.providers.respond(PUSH_ORIGIN, () => ({ status: 410 }));
		expect((await env.send('push', { template: 'alert', to: { subscriberId } })).json.status).toBe('failed');
		expect((await env.send('push', { template: 'alert', to: { subscriberId } })).json.reason).toBe(
			'No browser is subscribed for this recipient.',
		);
		env.providers.reset(PUSH_ORIGIN);
		const again = await env.call('POST', '/v1/push/subscriptions', {
			token: env.browser,
			origin: ORIGIN,
			body: { subscription: browser.subscription },
		});
		const id = (await again.json()).subscriberId;
		const removed = await env.call('POST', '/v1/push/subscriptions/remove', {
			token: env.browser,
			origin: ORIGIN,
			body: { subscriberId: id, endpoint: browser.subscription.endpoint },
		});
		expect(removed.status).toBe(204);
		expect(
			(await env.call('POST', '/v1/push/subscriptions/remove', { token: env.browser, origin: ORIGIN, body: {} })).status,
		).toBe(422);
	});

	it('signs outgoing webhooks and retries them on later uses', async () => {
		const cookie = await env.adminSession();
		await env.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${env.websiteId}/settings/webhooks.urls`, {
			value: [HOOK_URL, 'http://insecure.example'],
		});
		env.providers.respond('https://hooks.example.org', () => ({ status: 500 }));
		const sent = await env.send('sms', { template: 'accounts.code', to: { phone: '+15550009999' } });
		const first = env.providers.callsTo('https://hooks.example.org');
		expect(first).toHaveLength(1);
		env.providers.reset('https://hooks.example.org');
		env.advance(61_000);
		await env.call('GET', '/v1/messages?limit=1', { token: env.server });
		const calls = env.providers.callsTo('https://hooks.example.org');
		expect(calls).toHaveLength(2);
		const last = /** @type {import('./helpers.js').ProviderCall} */ (calls.at(-1));
		expect(
			verifyWebhook({ body: last.body, header: last.headers['ss-signature'] ?? null, secret: WEBHOOK_SECRET, now: env.now() }),
		).toBe(true);
		expect(JSON.parse(last.body)).toMatchObject({
			type: 'message.sent',
			websiteId: env.websiteId,
			data: { messageId: sent.json.id, status: 'sent' },
		});
		expect(JSON.parse(last.body).data.text).toBeUndefined();
	});

	it("relays other products' events to every webhook URL, signed", async () => {
		/** @param {unknown} body */
		const relay = (body) => env.call('POST', '/v1/events', { token: env.server, body });
		expect((await relay({ type: 'message.sent', data: {} })).status).toBe(422);
		expect((await relay({ type: 'payments.payment.paid', data: [] })).status).toBe(422);
		expect((await relay({ type: 'payments.payment.paid', data: { x: 'y'.repeat(17_000) } })).status).toBe(422);
		const before = env.providers.callsTo('https://hooks.example.org').length;
		const res = await relay({ type: 'payments.payment.paid', data: { payment: { id: 'pay_1', status: 'paid' } } });
		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ queued: 1 });
		const calls = env.providers.callsTo('https://hooks.example.org');
		expect(calls).toHaveLength(before + 1);
		const last = /** @type {import('./helpers.js').ProviderCall} */ (calls.at(-1));
		expect(
			verifyWebhook({ body: last.body, header: last.headers['ss-signature'] ?? null, secret: WEBHOOK_SECRET, now: env.now() }),
		).toBe(true);
		expect(JSON.parse(last.body)).toMatchObject({
			type: 'payments.payment.paid',
			websiteId: env.websiteId,
			data: { payment: { id: 'pay_1' } },
		});
		const cookie = await env.adminSession();
		await env.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${env.websiteId}/settings/webhooks.urls`, { value: [] });
		expect(await (await relay({ type: 'payments.payment.paid', data: {} })).json()).toEqual({ queued: 0 });
		await env.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${env.websiteId}/settings/webhooks.urls`, { value: [HOOK_URL] });
		await env.dashboard(cookie, 'DELETE', `/v1/dashboard/websites/${env.websiteId}/connections/webhook_secret`);
		expect(await (await relay({ type: 'payments.payment.paid', data: {} })).json()).toEqual({ queued: 0 });
		await env.connect('webhook_secret', WEBHOOK_SECRET);
	});

	it('relays a forwarded kit event { id, type, at, data } with its own id and time', async () => {
		/** @param {unknown} body @param {string} [key] */
		const relay = (body, key) =>
			env.call('POST', '/v1/events', { token: env.server, body, ...(key ? { headers: { 'idempotency-key': key } } : {}) });
		const id = createId('evt');
		const at = '2026-10-01T09:30:00.000Z';
		const before = env.providers.callsTo('https://hooks.example.org').length;
		// exactly what a product's kit sends: the event id is also the Idempotency-Key
		const event = { id, type: 'ecommerce.order.placed', at, data: { orderId: 'ord_1', number: 'A-1001' } };
		const res = await relay(event, id);
		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ queued: 1 });
		const calls = env.providers.callsTo('https://hooks.example.org');
		expect(calls).toHaveLength(before + 1);
		const last = /** @type {import('./helpers.js').ProviderCall} */ (calls.at(-1));
		expect(
			verifyWebhook({ body: last.body, header: last.headers['ss-signature'] ?? null, secret: WEBHOOK_SECRET, now: env.now() }),
		).toBe(true);
		expect(JSON.parse(last.body)).toEqual({
			id,
			type: 'ecommerce.order.placed',
			createdAt: at,
			websiteId: env.websiteId,
			data: { orderId: 'ord_1', number: 'A-1001' },
		});
		// the kit forwards again after a lost answer: refused as a repeat, which the kit takes as delivered
		expect((await relay(event, id)).status).toBe(409);
		expect(env.providers.callsTo('https://hooks.example.org')).toHaveLength(before + 1);
		// a time with an offset is kept as the same instant
		await relay({ id: createId('evt'), type: 'chat.conversation.opened', at: '2026-10-01T15:00+05:00', data: {} });
		expect(JSON.parse(env.providers.callsTo('https://hooks.example.org').at(-1)?.body ?? '{}').createdAt).toBe(
			'2026-10-01T10:00:00.000Z',
		);
		// without them: a new id and now
		await relay({ type: 'chat.conversation.opened', data: {} });
		const plain = JSON.parse(env.providers.callsTo('https://hooks.example.org').at(-1)?.body ?? '{}');
		expect(plain.id).toMatch(/^evt_[0-9a-z]{26}$/);
		expect(plain.id).not.toBe(id);
		expect(plain.createdAt).toBe(new Date(env.now()).toISOString());
		for (const bad of [
			{ id: 'evt_nope', type: 'chat.conversation.opened', data: {} },
			{ id: createId('msg'), type: 'chat.conversation.opened', data: {} },
			{ id: 42, type: 'chat.conversation.opened', data: {} },
			{ at: 'yesterday', type: 'chat.conversation.opened', data: {} },
			{ at: '2026-02-30T10:00:00Z', type: 'chat.conversation.opened', data: {} },
			{ at: '2026-10-01T24:00:00Z', type: 'chat.conversation.opened', data: {} },
			{ at: '2026-10-01T10:00:00', type: 'chat.conversation.opened', data: {} },
		]) {
			const refused = await relay(bad);
			expect(refused.status).toBe(422);
			expect((await refused.json()).errors[0].path).toBe(bad.id === undefined ? '/at' : '/id');
		}
	});
});

describe('the delivery log and the admin widgets (tickets)', () => {
	it('lists the log for the merchant server with filters and pages', async () => {
		const page = await (await env.call('GET', '/v1/messages?limit=2&channel=sms&status=sent', { token: env.server })).json();
		expect(page.items).toHaveLength(2);
		expect(page.items.every((/** @type {any} */ m) => m.channel === 'sms' && m.status === 'sent')).toBe(true);
		const next = await (
			await env.call('GET', `/v1/messages?limit=2&channel=sms&status=sent&cursor=${page.nextCursor}`, { token: env.server })
		).json();
		expect(next.items[0].id).not.toBe(page.items[0].id);
		const one = await (await env.call('GET', '/v1/messages?to=%2B15550007777', { token: env.server })).json();
		expect(one.items.every((/** @type {any} */ m) => m.to === '+15550007777')).toBe(true);
		expect((await env.call('GET', '/v1/messages/msg_missing', { token: env.server })).status).toBe(404);
	});

	it('counts the log with exactly the list’s filters, by status, channel, template and source', async () => {
		/** Every message the list answers for a query, page by page. @param {string} query */
		const listed = async (query) => {
			/** @type {any[]} */
			const items = [];
			let cursor = '';
			for (;;) {
				const page = await (
					await env.call('GET', `/v1/messages?limit=100${query}${cursor ? `&cursor=${cursor}` : ''}`, { token: env.server })
				).json();
				items.push(...page.items);
				if (!page.hasMore) return items;
				cursor = page.nextCursor;
			}
		};
		/** @param {string} path */
		const get = async (path) => (await env.call('GET', path, { token: env.server })).json();
		for (const query of [
			'',
			'&status=sent',
			'&channel=sms',
			'&channel=sms&status=sent',
			'&status=skipped',
			'&to=%2B15550007777',
			'&to=OPT%40example.com',
			'&status=bogus&channel=fax',
		]) {
			const items = await listed(query);
			expect(await get(`/v1/messages/count?x=1${query}`)).toEqual({ count: items.length, capped: false });
			for (const by of ['status', 'channel', 'template', 'source']) {
				/** @type {Record<string, number>} */
				const expected = {};
				for (const item of items) {
					const key = String(item[by] ?? 'none');
					expected[key] = (expected[key] ?? 0) + 1;
				}
				const counted = await get(`/v1/messages/counts?by=${by}${query}`);
				expect(counted.total).toBe(items.length);
				expect(counted.groups).toEqual(expected);
			}
		}
		const all = await get('/v1/messages/counts?by=status');
		expect(all.total).toBeGreaterThan(20);
		expect(Object.keys(all.groups)).toEqual(expect.arrayContaining(['sent', 'skipped', 'failed']));
		expect((await get('/v1/messages/counts?by=channel')).groups.sms).toBe((await get('/v1/messages/count?channel=sms')).count);
		const bad = await env.call('GET', '/v1/messages/counts?by=address', { token: env.server });
		expect(bad.status).toBe(422);
		expect((await bad.json()).detail).toBe('by is one of: status, channel, template, source.');
		// the same feature as the list
		await env.switchOn(ALL.filter((key) => key !== 'send_api'));
		expect((await env.call('GET', '/v1/messages/count', { token: env.server })).status).toBe(403);
		expect((await env.call('GET', '/v1/messages/counts?by=status', { token: env.server })).status).toBe(403);
		await env.switchOn(ALL);
		// the ticket twins: the delivery log's permission
		const ticket = await env.ticket(['log.read']);
		const total = (await get('/v1/messages/count')).count;
		const twin = await env.call('GET', '/v1/admin/messages/count', { token: ticket, origin: ADMIN_ORIGIN });
		expect(twin.status).toBe(200);
		expect(twin.headers.get('access-control-allow-origin')).toBe(ADMIN_ORIGIN);
		expect(await twin.json()).toEqual({ count: total, capped: false });
		const twins = await (
			await env.call('GET', '/v1/admin/messages/counts?by=channel&status=sent', { token: ticket, origin: ADMIN_ORIGIN })
		).json();
		expect(twins).toEqual(await get('/v1/messages/counts?by=channel&status=sent'));
		const none = await env.ticket(['templates.edit']);
		expect((await env.call('GET', '/v1/admin/messages/count', { token: none, origin: ADMIN_ORIGIN })).status).toBe(403);
		expect((await env.call('GET', '/v1/admin/messages/counts?by=status', { token: none, origin: ADMIN_ORIGIN })).status).toBe(
			403,
		);
	});

	it('serves the delivery log, templates, one-off sends and staff push to tickets from their origin', async () => {
		const ticket = await env.ticket();
		/** @param {string} method @param {string} path @param {unknown} [body] */
		const admin = (method, path, body) =>
			env.call(method, path, { token: ticket, origin: ADMIN_ORIGIN, ...(body === undefined ? {} : { body }) });
		const log = await admin('GET', '/v1/admin/messages?limit=5');
		expect(log.status).toBe(200);
		expect(log.headers.get('access-control-allow-origin')).toBe(ADMIN_ORIGIN);
		expect((await env.call('GET', '/v1/admin/messages', { token: ticket, origin: ORIGIN })).status).toBe(401);
		expect((await admin('GET', '/v1/admin/templates')).status).toBe(200);
		expect((await admin('PUT', '/v1/admin/templates', { key: 'staff.note', channel: 'sms', text: 'Hi' })).status).toBe(200);
		expect((await admin('PUT', '/v1/admin/templates', { key: 'staff.note', channel: 'sms', text: '' })).status).toBe(422);
		expect((await admin('DELETE', '/v1/admin/templates/staff.note/sms/default')).status).toBe(204);
		expect((await admin('DELETE', '/v1/admin/templates/staff.note/sms/!!')).status).toBe(404);
		const oneOff = await admin('POST', '/v1/admin/messages', {
			channel: 'email',
			to: 'opt@example.com',
			subject: 'About your order',
			text: 'It shipped.',
		});
		expect(oneOff.status).toBe(201);
		expect(await oneOff.json()).toMatchObject({ status: 'sent', source: 'staff', template: null });
		for (const body of [
			{ channel: 'push', to: 'x', text: 'x' },
			{ channel: 'sms', to: '123', text: 'x' },
			{ channel: 'sms', to: '+15550001234', text: '' },
			{ channel: 'email', to: 'a@example.com', text: 'x' },
		])
			expect((await admin('POST', '/v1/admin/messages', body)).status).toBe(422);
		const staff = browserSubscription(`${PUSH_ORIGIN}/push/staff`);
		const subscribed = await admin('POST', '/v1/admin/push/subscriptions', { subscription: staff.subscription });
		expect(subscribed.status).toBe(201);
		expect((await admin('POST', '/v1/admin/push/subscriptions', { subscription: null })).status).toBe(422);
		const pushed = await env.send('staff-push', { template: 'alert', to: { staffId: 'u_1' }, values: { order: '7' } });
		expect(pushed.json.status).toBe('sent');
		expect(decryptPush(Buffer.from(env.providers.callsTo(PUSH_ORIGIN).at(-1)?.body ?? '', 'base64'), staff)).toEqual({
			title: 'New order',
			body: 'Order 7',
		});
		expect((await env.send('staff-push', { template: 'alert', to: { staffId: 'u_404' } })).json.status).toBe('failed');
		// a ticket without the permission is refused
		const none = await env.ticket([]);
		expect((await env.call('GET', '/v1/admin/messages', { token: none, origin: ADMIN_ORIGIN })).status).toBe(403);
	});

	it('records who acted in the widgets in the activity log, with a label and a short detail', async () => {
		/** @param {string} query */
		const activity = async (query) =>
			(await (await env.call('GET', `/v1/activity?${query}`, { token: env.server })).json()).items;
		const saved = await activity('action=template.saved');
		expect(saved[0]).toMatchObject({
			actor: { kind: 'staff', id: 'u_1', name: 'Sam Staff' },
			action: 'template.saved',
			target: 'staff.note/sms/default',
			label: 'staff.note (sms, default)',
			detail: 'Optional, not urgent',
		});
		expect(await activity('action=template.deleted')).toEqual([
			expect.objectContaining({
				actor: expect.objectContaining({ name: 'Sam Staff' }),
				target: 'staff.note/sms/default',
				label: 'staff.note (sms, default)',
				detail: null,
			}),
		]);
		const [sent] = await activity('action=message.sent');
		expect(sent).toMatchObject({
			actor: { kind: 'staff', id: 'u_1', name: 'Sam Staff' },
			label: sent.target,
			detail: 'One-off e-mail message: sent',
		});
		expect(sent.target).toMatch(/^msg_/);
		// never an address or the words
		expect(JSON.stringify(await activity(''))).not.toMatch(/opt@example\.com|It shipped/);
		expect((await activity('q=sam%20staff')).length).toBeGreaterThanOrEqual(3);
	});

	it('serves widget.js, the widget config with the public push key only, and the public docs', async () => {
		const script = await env.call('GET', '/widget.js');
		expect(await script.text()).toContain('/v1/widget/config');
		const config = await (await env.call('GET', '/v1/widget/config', { token: env.browser, origin: ORIGIN })).json();
		expect(config.settings.pushPublicKey).toMatch(/^[\w-]{87}$/);
		expect(JSON.stringify(config)).not.toContain('privateKey');
		const html = await (await env.call('GET', '/docs')).text();
		for (const part of [
			'/v1/messages/whatsapp',
			'SS_SERVER_TOKEN',
			'curl -X POST',
			'SS-Signature',
			'Connectivity.pk',
			'/ss-notifications-sw.js',
			'data-ss-notifications',
			'log.read',
			'/v1/tickets',
			'business.json',
		])
			expect(html).toContain(part);
		expect(GATEWAY_URL).toMatch(/^https:/);
	});
});

describe('the merchant’s server and the widget config (PLAN 0.8.10)', () => {
	it('takes visitor calls from the merchant’s server, by the visitor’s SS-Visitor-IP', async () => {
		const browser = browserSubscription(`${PUSH_ORIGIN}/push/server-call`);
		/** @param {Record<string, string>} headers */
		const subscribe = (headers) =>
			env.call('POST', '/v1/push/subscriptions', { token: env.server, body: { subscription: browser.subscription }, headers });
		const missing = await subscribe({});
		expect(missing.status).toBe(400);
		expect((await missing.json()).type).toMatch(/visitor_ip_required$/);
		const first = await subscribe({ 'ss-visitor-ip': '203.0.113.7' });
		expect(first.status).toBe(201);
		expect(first.headers.get('access-control-allow-origin')).toBeNull();
		const { subscriberId } = await first.json();
		expect(subscriberId).toMatch(/^sub_/);
		// the per-visitor limit (20 a minute) counts that visitor's address, not the server's
		for (let i = 1; i < 20; i += 1) expect((await subscribe({ 'ss-visitor-ip': '203.0.113.7' })).status).toBe(201);
		expect((await subscribe({ 'ss-visitor-ip': '203.0.113.7' })).status).toBe(429);
		expect((await subscribe({ 'ss-visitor-ip': '203.0.113.8' })).status).toBe(201);
		const removed = await env.call('POST', '/v1/push/subscriptions/remove', {
			token: env.server,
			body: { subscriberId, endpoint: browser.subscription.endpoint },
			headers: { 'ss-visitor-ip': '203.0.113.9' },
		});
		expect(removed.status).toBe(204);
		const pushed = await env.send('push', { template: 'alert', to: { subscriberId } });
		expect(pushed.json).toMatchObject({ status: 'failed', reason: 'No browser is subscribed for this recipient.' });
	});

	it('takes the SS-Actor headers on server calls and refuses malformed ones', async () => {
		const named = await env.call('GET', '/v1/messages/count', {
			token: env.server,
			headers: { 'ss-actor-id': 'usr_42', 'ss-actor-name': encodeURIComponent('Zoë Admin'), 'ss-actor-role': 'Manager' },
		});
		expect(named.status).toBe(200);
		const malformed = await env.call('GET', '/v1/messages/count', {
			token: env.server,
			headers: { 'ss-actor-id': 'usr 42', 'ss-actor-name': 'Zoe' },
		});
		expect(malformed.status).toBe(400);
		expect((await malformed.json()).type).toMatch(/invalid_actor$/);
		// a settings change from the server shows the acting user in Recent changes
		const changed = await env.call('PUT', '/v1/settings/send_limits.perDay', {
			token: env.server,
			body: { value: 30 },
			headers: { 'ss-actor-id': 'usr_42', 'ss-actor-name': encodeURIComponent('Zoë Admin') },
		});
		expect(changed.status).toBe(200);
		const overview = await (
			await env.dashboard(await env.adminSession(), 'GET', `/v1/dashboard/websites/${env.websiteId}/overview`)
		).json();
		expect(overview.recentChanges).toContainEqual(
			expect.objectContaining({ who: { kind: 'user', id: 'usr_42', name: 'Zoë Admin' } }),
		);
	});

	it('gives the widgets the Format and the business time zone', async () => {
		await env.businessJson({ name: 'Shop', timeZone: 'Asia/Karachi' });
		const cookie = await env.adminSession();
		const saved = await env.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${env.websiteId}/format`, {
			locale: 'en-GB',
			times: 'business',
		});
		expect(saved.status).toBe(200);
		const ticket = await env.ticket(['log.read']);
		const admin = await (await env.call('GET', '/v1/widget/admin/config', { token: ticket, origin: ADMIN_ORIGIN })).json();
		expect(admin).toMatchObject({ format: { locale: 'en-GB', times: 'business' }, timeZone: 'Asia/Karachi' });
		const visitor = await (await env.call('GET', '/v1/widget/config', { token: env.browser, origin: ORIGIN })).json();
		expect(visitor).toMatchObject({ format: { locale: 'en-GB', times: 'business' }, timeZone: 'Asia/Karachi' });
		await env.businessJson({ name: 'shop.example.com', timeZone: 'UTC' });
	});

	it('explains the kit’s routes for the merchant’s server in the docs', async () => {
		const html = await (await env.call('GET', '/docs')).text();
		for (const part of [
			'Settings from your server',
			'SS-Actor-Id',
			'SS-Visitor-IP',
			'/v1/messages/count',
			'/v1/messages/counts',
			'/v1/admin/messages/counts',
			'GET /v1/activity',
			'Format and time zone',
			'{ id, type, at, data }',
		])
			expect(html).toContain(part);
	});
});

describe('data rights, statuses and notices', () => {
	it('exports and deletes a person’s messages and unsubscribes', async () => {
		const user = { email: 'opt@example.com' };
		const exported = await (await env.call('POST', '/v1/data-rights/export', { token: env.server, body: { user } })).json();
		expect(exported.records.messages.length).toBeGreaterThan(2);
		expect(exported.records.unsubscribes).toEqual([expect.objectContaining({ address: 'opt@example.com', via: 'link' })]);
		expect(
			(await (await env.call('POST', '/v1/data-rights/export', { token: env.server, body: { user: { id: 'u_9' } } })).json())
				.records,
		).toEqual({});
		const deleted = await (await env.call('POST', '/v1/data-rights/delete', { token: env.server, body: { user } })).json();
		expect(deleted.deleted).toBeGreaterThan(3);
		expect(
			await (await env.call('POST', '/v1/data-rights/delete', { token: env.server, body: { user: { id: 'u_9' } } })).json(),
		).toEqual({ deleted: 0, anonymised: 0 });
	});

	it('obeys stopped, suspended and removed, and the hosted page says unavailable', async () => {
		await env.send('email', { template: 'promo', to: { email: 'st@example.com' } });
		const link = unsubscribeLink();
		for (const status of /** @type {const} */ (['stopped', 'suspended', 'removed'])) {
			env.portal.setStatus(env.websiteId, { status });
			env.advance(1000);
			await env.portal.sendNotice('notifications', { type: 'status.changed', websiteId: env.websiteId });
			await env.flush();
			const refused = await env.send('sms', { template: 'accounts.code', to: { phone: '+15550001212' } });
			expect(refused.status).toBe(403);
			expect(refused.json).toMatchObject({ reason: status });
			expect((await env.call('GET', link)).status).toBe(404);
		}
		env.portal.setStatus(env.websiteId, { status: 'grace', graceEndsAt: new Date(env.now() + 86_400_000).toISOString() });
		env.advance(1000);
		await env.portal.sendNotice('notifications', { type: 'status.changed', websiteId: env.websiteId });
		await env.flush();
		await env.switchOn(ALL);
		expect((await env.send('sms', { template: 'accounts.code', to: { phone: '+15550001212' } })).json.status).toBe('sent');
	});

	it('forgets the website’s connections when the website is deleted (the merchant database is never touched)', async () => {
		env.advance(1000);
		expect((await env.portal.sendNotice('notifications', { type: 'website.deleted', websiteId: env.websiteId })).status).toBe(
			204,
		);
		await env.flush();
		const after = await env.send('sms', { template: 'accounts.code', to: { phone: '+15550001212' } });
		expect(after.status).toBe(403);
	});
});
