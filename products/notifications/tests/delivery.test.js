/**
 * Delivery (PLAN 0.8.5, 0.8.10 D7 and D11): the delivery log never keeps a secret and is kept for the days the merchant
 * sets; required messages ignore opt-outs; nothing accepted is lost when an attempt breaks off; Accounts' messages are
 * never held by quiet hours or a delayed send.
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSealer, messageAadOf, resealWebsite } from '../adapters/crypto.js';
import { checkValueNames, hideValues, hiddenNamesOf } from '../core/templates.js';
import { ADMIN_ORIGIN, HOOK_URL, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

const RESEND = { provider: 'resend', secret: 're_secret_1234', from: 'Shop <shop@shop.example.com>' };
const TWILIO = { provider: 'twilio', accountSid: `AC${'a'.repeat(32)}`, secret: 'twilio-token-9876', from: '+15550001111' };
const META = { provider: 'meta', phoneNumberId: '1234567890', secret: 'meta-token-5555' };
const MIN = 60_000;
const DAY = 86_400_000;

/** @param {string} origin */
const lastBody = (origin) => env.providers.callsTo(origin).at(-1)?.body ?? '';

/** A message as the merchant database keeps it. @param {string} id */
const raw = async (id) =>
	/** @type {Record<string, any>} */ (
		await (await env.merchantCollection('messages')).findOne({ websiteId: env.websiteId, id }, { projection: { _id: 0 } })
	);

/** A use of the website (due messages are sent right after it). */
const use = () => env.call('GET', '/v1/messages?limit=1', { token: env.server });

/** @param {string} id */
const read = async (id) => (await env.call('GET', `/v1/messages/${id}`, { token: env.server })).json();

beforeAll(async () => {
	env = await setup();
	await env.switchOn(['email', 'sms', 'whatsapp', 'fallback', 'send_api', 'webhooks']);
	await env.connectDatabase();
	await env.connect('email', RESEND);
	await env.connect('sms', TWILIO);
	await env.connect('whatsapp', META);
});
afterAll(async () => {
	await env.product.close();
});

describe('secrets never reach the delivery log (D11, SE-3)', () => {
	it('names the hidden values and replaces them: links, other values, never empty ones', () => {
		expect(checkValueNames(undefined)).toEqual({ ok: true, value: [] });
		expect(checkValueNames(['code', 'code', 'link'])).toEqual({ ok: true, value: ['code', 'link'] });
		for (const bad of ['code', [1], ['a b'], Array.from({ length: 51 }, (_, i) => `v${i}`)])
			expect(checkValueNames(bad).ok).toBe(false);
		const values = { code: '123456', link: 'https://shop.example.com/a#t=1', path: '/reset?t=9', pin: ' ', order: '7' };
		expect(hiddenNamesOf(values, { sensitive: true, secretValues: [] })).toEqual(Object.keys(values));
		expect(hiddenNamesOf(values, { sensitive: false, secretValues: ['pin', 'code', 'missing'] })).toEqual(['code', 'pin']);
		expect(hideValues(values, ['code', 'link', 'path', 'pin'])).toEqual({
			code: '******',
			link: '[link hidden]',
			path: '[link hidden]',
			pin: ' ',
			order: '7',
		});
	});

	it('hides the codes and links of Accounts’ messages in every read, and sends the real ones', async () => {
		await env.template({
			key: 'accounts.email_code',
			channel: 'email',
			subject: 'Your code for {business}',
			text: 'Code {code}. Or sign in: {link} (valid {minutes} minutes)',
		});
		const secrets = ['482913', 'ss_accounts_magic=abc.def'];
		const sent = await env.send('email', {
			template: 'accounts.email_code',
			to: { email: 'ana@example.com' },
			values: {
				code: '482913',
				link: 'https://shop.example.com/account#ss_accounts_magic=abc.def',
				minutes: 10,
				business: 'Shop',
			},
		});
		// the provider gets the real words
		const mail = JSON.parse(lastBody('https://api.resend.com'));
		expect(mail).toMatchObject({
			subject: 'Your code for Shop',
			text: 'Code 482913. Or sign in: https://shop.example.com/account#ss_accounts_magic=abc.def (valid 10 minutes)',
		});
		// every read and the record keep them hidden
		expect(sent.json).toMatchObject({
			status: 'sent',
			subject: 'Your code for ******',
			text: 'Code ******. Or sign in: [link hidden] (valid ****** minutes)',
		});
		const ticket = await env.ticket(['log.read']);
		const reads = [
			JSON.stringify(sent.json),
			JSON.stringify(await read(sent.json.id)),
			await (await env.call('GET', '/v1/messages?to=ana@example.com', { token: env.server })).text(),
			await (await env.call('GET', '/v1/admin/messages', { token: ticket, origin: ADMIN_ORIGIN })).text(),
			await (
				await env.call('POST', '/v1/data-rights/export', { token: env.server, body: { user: { email: 'ana@example.com' } } })
			).text(),
		];
		const record = await raw(sent.json.id);
		for (const text of [...reads, JSON.stringify(record)]) for (const secret of secrets) expect(text).not.toContain(secret);
		expect(record).toMatchObject({
			hidden: ['code', 'link', 'minutes', 'business'],
			values: { code: '******', link: '[link hidden]', minutes: '******', business: '******' },
			sealed: null,
		});
		const templates = await (
			await env.dashboard(await env.adminSession(), 'GET', `/v1/dashboard/websites/${env.websiteId}/templates`)
		).json();
		expect(templates.items).toContainEqual(expect.objectContaining({ key: 'accounts.email_code', sensitive: true }));
	});

	it('keeps the real words sealed only while the message has attempts to make, also on the fallback channel', async () => {
		await env.setting('fallback', 'whatsapp', 'sms');
		await env.template({
			key: 'accounts.phone_code',
			channel: 'whatsapp',
			text: '{code} is your code.',
			providerTemplate: 'authentication',
			buttons: [{ index: 0, type: 'copy_code', value: '{code}' }],
		});
		await env.template({ key: 'accounts.phone_code', channel: 'sms', text: 'Code {code}' });
		env.providers.respond('https://graph.facebook.com', () => ({ status: 503 }));
		const sent = await env.send('whatsapp', {
			template: 'accounts.phone_code',
			to: { phone: '+447700900123' },
			values: { code: '771122' },
		});
		expect(sent.json).toMatchObject({ status: 'retrying', text: '****** is your code.' });
		expect(JSON.parse(lastBody('https://graph.facebook.com')).template.components).toEqual([
			{ type: 'body', parameters: [{ type: 'text', text: '771122' }] },
			{ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '771122' }] },
		]);
		const waiting = await raw(sent.json.id);
		expect(waiting).toMatchObject({
			parameters: ['******'],
			buttons: [{ index: 0, type: 'copy_code', value: '******' }],
			values: { code: '******' },
		});
		expect(typeof waiting.sealed).toBe('string');
		expect(JSON.stringify(waiting)).not.toContain('771122');
		// the retries and the fallback send the real code
		env.advance(MIN + 1000);
		await use();
		expect(lastBody('https://graph.facebook.com')).toContain('771122');
		env.advance(5 * MIN + 1000);
		await use();
		expect(new URLSearchParams(lastBody('https://api.twilio.com')).get('Body')).toBe('Code 771122');
		const done = await raw(sent.json.id);
		expect(done).toMatchObject({ status: 'sent', channel: 'sms', text: 'Code ******', sealed: null });
		expect(JSON.stringify(done)).not.toContain('771122');
		env.providers.reset('https://graph.facebook.com');
	});

	it('hides the values of a template the merchant marks sensitive, and the values a sender names secret', async () => {
		await env.template({
			key: 'login_link',
			channel: 'email',
			subject: 'Sign in',
			text: 'Hi {name}, open {link}',
			sensitive: true,
		});
		const link = await env.send('email', {
			template: 'login_link',
			to: { email: 'bo@example.com' },
			values: { name: 'Bo', link: 'https://shop.example.com/in?t=xyz' },
		});
		expect(link.json.text).toBe('Hi ******, open [link hidden]');
		expect(JSON.parse(lastBody('https://api.resend.com')).text).toContain('https://shop.example.com/in?t=xyz');
		await env.template({ key: 'pickup', channel: 'sms', text: 'Order {order}{?pin}: pickup code {pin}{/pin}', required: true });
		const pin = await env.send('sms', {
			template: 'pickup',
			to: { phone: '+15550002020' },
			values: { order: '1001', pin: '5521' },
			secretValues: ['pin'],
		});
		expect(pin.json.text).toBe('Order 1001: pickup code ******');
		expect(new URLSearchParams(lastBody('https://api.twilio.com')).get('Body')).toBe('Order 1001: pickup code 5521');
		expect((await raw(pin.json.id)).values).toEqual({ order: '1001', pin: '******' });
		const none = await env.send('sms', {
			template: 'pickup',
			to: { phone: '+15550002020' },
			values: { order: '1002', pin: '' },
			secretValues: ['pin'],
		});
		expect(none.json.text).toBe('Order 1002');
		for (const secretValues of ['pin', ['a b']])
			expect(
				(await env.send('sms', { template: 'pickup', to: { phone: '+15550002020' }, values: { order: '1' }, secretValues }))
					.status,
			).toBe(422);
	});

	it('fails a waiting sensitive message whose sealed words cannot be opened (the encryption key changed)', async () => {
		env.providers.respond('https://graph.facebook.com', () => ({ status: 503 }));
		const sent = await env.send('whatsapp', {
			template: 'accounts.phone_code',
			to: { phone: '+447700900124' },
			values: { code: '334455' },
		});
		expect(sent.json.status).toBe('retrying');
		const metaCalls = env.providers.callsTo('https://graph.facebook.com').length;
		const twilioCalls = env.providers.callsTo('https://api.twilio.com').length;
		await (
			await env.merchantCollection('messages')
		).updateOne({ websiteId: env.websiteId, id: sent.json.id }, { $set: { sealed: 'v1.AAAA.BBBB.CCCC' } });
		env.advance(MIN + 1000);
		await use();
		expect(await read(sent.json.id)).toMatchObject({
			status: 'failed',
			reason: 'sealed_unreadable',
		});
		expect(env.providers.callsTo('https://graph.facebook.com')).toHaveLength(metaCalls);
		expect(env.providers.callsTo('https://api.twilio.com')).toHaveLength(twilioCalls);
		expect((await raw(sent.json.id)).sealed).toBeNull();
		env.providers.reset('https://graph.facebook.com');
	});

	it('keeps waiting sensitive messages through a change of ENCRYPTION_KEY: the Owner’s Re-seal moves them (RT-14)', async () => {
		env.providers.respond('https://graph.facebook.com', () => ({ status: 503 }));
		const sent = await env.send('whatsapp', {
			template: 'accounts.phone_code',
			to: { phone: '+447700900125' },
			values: { code: '667788' },
		});
		expect(sent.json.status).toBe('retrying');
		// on this instance's key: the Owner's Re-seal finds it current
		const owner = await env.adminSession();
		expect(await (await env.dashboard(owner, 'POST', '/v1/dashboard/reseal')).json()).toMatchObject({
			resealed: 0,
			unreadable: 0,
			failedWebsites: [],
		});
		const data = await env.product.data.forWebsite(env.websiteId);
		const aad = messageAadOf(env.websiteId, 'whatsapp', '+447700900125');
		const changing = createSealer('encryption-key-b-0123456789-abcdefghij', 'encryption-key-0123456789-abcdefghij');
		expect(changing.open((await raw(sent.json.id)).sealed, aad)).toContain('667788');
		expect(await resealWebsite(changing, data)).toMatchObject({ resealed: 1, unreadable: 0 });
		expect(await resealWebsite(changing, data)).toMatchObject({ resealed: 0, current: 1 });
		const moved = await raw(sent.json.id);
		expect(createSealer('encryption-key-b-0123456789-abcdefghij').open(moved.sealed, aad)).toContain('667788');
		expect(env.product.sealer.open(moved.sealed, aad)).toBeNull();
		await (await env.merchantCollection('messages')).deleteOne({ websiteId: env.websiteId, id: sent.json.id });
		env.providers.reset('https://graph.facebook.com');
	});
});

describe('the delivery log is kept for the days the merchant sets (D11, SE-6)', () => {
	it('keeps it forever by default, and the database has the expiry indexes', async () => {
		await env.template({ key: 'note', channel: 'sms', text: 'Note {n}', required: true });
		const sent = await env.send('sms', { template: 'note', to: { phone: '+15550003030' }, values: { n: '1' } });
		expect(sent.json.status).toBe('sent');
		expect((await raw(sent.json.id)).expireAt).toBeNull();
		for (const name of ['messages', 'webhook_events'])
			expect(await env.merchantIndexes(name)).toContainEqual(
				expect.objectContaining({ name: 'expire', key: { expireAt: 1 }, expireAfterSeconds: 0 }),
			);
	});

	it('removes finished messages and webhook events that many days after they finish; waiting ones stay', async () => {
		await env.setting('delivery_log', 'retentionDays', 30);
		const sent = await env.send('sms', { template: 'note', to: { phone: '+15550003030' }, values: { n: '2' } });
		expect((await raw(sent.json.id)).expireAt).toEqual(new Date(env.now() + 30 * DAY));
		// a waiting message never expires; it does once it fails
		env.providers.respond('https://api.twilio.com', () => ({ status: 503 }));
		const failing = await env.send('sms', { template: 'note', to: { phone: '+15550003031' }, values: { n: '3' } });
		expect(failing.json.status).toBe('retrying');
		expect((await raw(failing.json.id)).expireAt).toBeUndefined();
		env.advance(MIN + 1000);
		await use();
		env.advance(5 * MIN + 1000);
		await use();
		const failed = await raw(failing.json.id);
		expect(failed.status).toBe('failed');
		expect(failed.expireAt).toEqual(new Date(env.now() + 30 * DAY));
		env.providers.reset('https://api.twilio.com');
		// an outgoing webhook event, once delivered
		await env.connect('webhook_secret', 'whsec-0123456789abcdefghijklmnop');
		const cookie = await env.adminSession();
		const list = await env.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${env.websiteId}/lists/webhook_urls`, {
			value: [{ url: HOOK_URL, events: ['payments.payment.paid'] }],
		});
		expect(list.status).toBe(200);
		const relayed = await env.call('POST', '/v1/events', {
			token: env.server,
			body: { type: 'payments.payment.paid', data: { paymentId: 'pay_1' } },
		});
		expect(relayed.status).toBe(202);
		const event = await (
			await env.merchantCollection('webhook_events')
		).findOne({
			websiteId: env.websiteId,
			type: 'payments.payment.paid',
		});
		expect(event).toMatchObject({ status: 'delivered', expireAt: new Date(env.now() + 30 * DAY) });
		// back to forever
		await env.setting('delivery_log', 'retentionDays', 0);
		const kept = await env.send('sms', { template: 'note', to: { phone: '+15550003030' }, values: { n: '4' } });
		expect((await raw(kept.json.id)).expireAt).toBeNull();
	});
});

describe('required messages are never stopped by an opt-out (PLAN 0.8.5, MS-4)', () => {
	/** Opt a phone out with a signed Twilio reply (STOP). @param {string} phone */
	const stop = async (phone) => {
		const url = `https://notifications.example.dev/v1/inbound/${env.websiteId}/sms`;
		const params = new URLSearchParams({ From: phone, Body: 'STOP' });
		const data = [...params.keys()].sort().reduce((text, name) => `${text}${name}${params.get(name)}`, url);
		const signature = createHmac('sha1', TWILIO.secret).update(data).digest('base64');
		const answer = await env.call('POST', `/v1/inbound/${env.websiteId}/sms`, {
			raw: params.toString(),
			headers: { 'x-twilio-signature': signature },
		});
		expect(answer.status).toBe(200);
	};
	/** Mark a stored template optional, straight in the merchant database. @param {string} key @param {string} channel */
	const storeAsOptional = async (key, channel) =>
		(await env.merchantCollection('templates')).updateOne(
			{ websiteId: env.websiteId, key, channel, language: '' },
			{ $set: { required: false } },
		);

	it('sends Accounts’ messages after a STOP reply or an unsubscribe, without unsubscribe headers', async () => {
		await storeAsOptional('accounts.phone_code', 'sms');
		await stop('+15550004040');
		const code = await env.send('sms', {
			template: 'accounts.phone_code',
			to: { phone: '+15550004040' },
			values: { code: '909090' },
		});
		expect(code.json).toMatchObject({ status: 'sent' });
		expect(new URLSearchParams(lastBody('https://api.twilio.com')).get('Body')).toBe('Code 909090');
		await env.template({ key: 'promo_sms', channel: 'sms', text: 'Sale {pct}' });
		expect(
			(await env.send('sms', { template: 'promo_sms', to: { phone: '+15550004040' }, values: { pct: '5%' } })).json,
		).toMatchObject({ status: 'skipped', reason: 'unsubscribed' });
		// an email of Accounts carries no unsubscribe link or header
		await storeAsOptional('accounts.email_code', 'email');
		await env.send('email', {
			template: 'accounts.email_code',
			to: { email: 'cy@example.com' },
			values: { code: '1', link: 'https://shop.example.com/in', minutes: 10, business: 'Shop' },
		});
		expect(JSON.parse(lastBody('https://api.resend.com')).headers?.['List-Unsubscribe']).toBeUndefined();
		const templates = await (
			await env.dashboard(await env.adminSession(), 'GET', `/v1/dashboard/websites/${env.websiteId}/templates`)
		).json();
		expect(templates.items).toContainEqual(
			expect.objectContaining({ key: 'accounts.phone_code', channel: 'sms', required: true }),
		);
	});

	it('sends an optional template to people who unsubscribed when the sender marks the message required', async () => {
		await stop('+15550004041');
		const order = await env.send('sms', {
			template: 'promo_sms',
			to: { phone: '+15550004041' },
			values: { pct: '10%' },
			required: true,
		});
		expect(order.json.status).toBe('sent');
		expect(
			(await env.send('sms', { template: 'promo_sms', to: { phone: '+15550004041' }, values: { pct: '1%' } })).json.status,
		).toBe('skipped');
		expect((await env.send('sms', { template: 'promo_sms', to: { phone: '+15550004041' }, required: 'yes' })).status).toBe(422);
	});
});

describe('nothing accepted is lost when an attempt breaks off (D7, K-17)', () => {
	it('saves the message, records the failed attempt and retries it on the next uses, within the plan', async () => {
		// the SMS connection cannot be read for a moment while the message is attempted
		env.failReads(`connections|${env.websiteId}|sms`);
		const sent = await env.send('sms', { template: 'note', to: { phone: '+15550005050' }, values: { n: '5' } });
		expect(sent.status).toBe(201);
		expect(sent.json).toMatchObject({
			status: 'retrying',
			reason: 'interrupted',
			attempts: [{ channel: 'sms', provider: 'none', outcome: 'failed', reason: 'interrupted' }],
		});
		env.failReads();
		env.advance(MIN + 1000);
		await use();
		expect(await read(sent.json.id)).toMatchObject({
			status: 'sent',
			attempts: [{ outcome: 'failed' }, { outcome: 'sent', provider: 'twilio' }],
		});
		expect(new URLSearchParams(lastBody('https://api.twilio.com')).get('Body')).toBe('Note 5');
		// an outage that lasts ends the message after its plan, as a failure the log shows
		env.failReads(`connections|${env.websiteId}|sms`);
		const lost = await env.send('sms', { template: 'note', to: { phone: '+15550005051' }, values: { n: '6' } });
		env.advance(MIN + 1000);
		await use();
		env.advance(5 * MIN + 1000);
		await use();
		env.advance(60 * MIN);
		await use();
		const done = await read(lost.json.id);
		expect(done.status).toBe('failed');
		expect(done.attempts).toHaveLength(3);
		env.failReads();
	});
});

describe('Accounts’ messages are never held by quiet hours or a delayed send (PLAN 0.8.5)', () => {
	it('sends sign-in codes at once at night and with a sendAt, even from a template saved as not urgent', async () => {
		await env.switchOn(['email', 'sms', 'whatsapp', 'fallback', 'send_api', 'webhooks', 'quiet_hours', 'delayed_send']);
		await env.template({ key: 'accounts.phone_code', channel: 'sms', text: 'Code {code}', urgent: false });
		await env.template({ key: 'promo_sms', channel: 'sms', text: 'Sale {pct}' });
		// stored as not urgent, straight in the merchant database
		await (
			await env.merchantCollection('templates')
		).updateOne(
			{ websiteId: env.websiteId, key: 'accounts.phone_code', channel: 'sms', language: '' },
			{ $set: { urgent: false } },
		);
		// 23:00 UTC: inside the default quiet hours (21 to 8)
		const night = new Date(env.now());
		night.setUTCHours(23, 0, 0, 0);
		if (night.getTime() <= env.now()) night.setUTCDate(night.getUTCDate() + 1);
		env.advance(night.getTime() - env.now());
		const to = { phone: '+15550006060', timeZone: 'UTC' };
		const code = await env.send('sms', { template: 'accounts.phone_code', to, values: { code: '414141' } });
		expect(code.json).toMatchObject({ status: 'sent' });
		const promo = await env.send('sms', { template: 'promo_sms', to, values: { pct: '5%' } });
		expect(promo.json.status).toBe('queued');
		expect(new Date(promo.json.dueAt).getUTCHours()).toBe(8);
		// a delayed send holds other messages, never a sign-in code
		const sendAt = new Date(env.now() + 2 * 3_600_000).toISOString();
		const asked = await env.send('sms', { template: 'accounts.phone_code', to, values: { code: '515151' }, sendAt });
		expect(asked.json).toMatchObject({ status: 'sent' });
		expect((await env.send('sms', { template: 'promo_sms', to, values: { pct: '6%' }, sendAt })).json.status).toBe('queued');
		// the template shows as urgent wherever it is read, and stays urgent when saved unchecked
		const templates = await (
			await env.dashboard(await env.adminSession(), 'GET', `/v1/dashboard/websites/${env.websiteId}/templates`)
		).json();
		expect(templates.items).toContainEqual(
			expect.objectContaining({ key: 'accounts.phone_code', channel: 'sms', urgent: true }),
		);
		expect(templates.items).toContainEqual(expect.objectContaining({ key: 'promo_sms', channel: 'sms', urgent: false }));
		await env.template({ key: 'accounts.phone_code', channel: 'sms', text: 'Code {code}', urgent: false });
		const saved = await (
			await env.merchantCollection('templates')
		).findOne({
			websiteId: env.websiteId,
			key: 'accounts.phone_code',
			channel: 'sms',
			language: '',
		});
		expect(saved?.urgent).toBe(true);
		await env.switchOn(['email', 'sms', 'whatsapp', 'fallback', 'send_api', 'webhooks']);
	});
});
