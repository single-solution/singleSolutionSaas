/**
 * Notifications after the re-audit (PLAN 0.8.10, owner decisions D7 and D11): the delivery log never keeps a secret.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkSecretValues, hideValues, hiddenNamesOf } from '../core/templates.js';
import { ADMIN_ORIGIN, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

const RESEND = { provider: 'resend', secret: 're_secret_1234', from: 'Shop <shop@shop.example.com>' };
const TWILIO = { provider: 'twilio', accountSid: `AC${'a'.repeat(32)}`, secret: 'twilio-token-9876', from: '+15550001111' };
const META = { provider: 'meta', phoneNumberId: '1234567890', secret: 'meta-token-5555' };
const MIN = 60_000;

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
	await env.switchOn(['email', 'sms', 'whatsapp', 'fallback', 'send_api']);
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
		expect(checkSecretValues(undefined)).toEqual({ ok: true, value: [] });
		expect(checkSecretValues(['code', 'code', 'link'])).toEqual({ ok: true, value: ['code', 'link'] });
		for (const bad of ['code', [1], ['a b'], Array.from({ length: 51 }, (_, i) => `v${i}`)])
			expect(checkSecretValues(bad).ok).toBe(false);
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
			to: { phone: '+923001234567' },
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
			to: { phone: '+923001234568' },
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
			reason: 'Its hidden values cannot be read: the encryption key changed.',
		});
		expect(env.providers.callsTo('https://graph.facebook.com')).toHaveLength(metaCalls);
		expect(env.providers.callsTo('https://api.twilio.com')).toHaveLength(twilioCalls);
		expect((await raw(sent.json.id)).sealed).toBeNull();
		env.providers.reset('https://graph.facebook.com');
	});
});
