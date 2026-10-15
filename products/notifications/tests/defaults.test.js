/**
 * Default templates (parity P1): a product's send carries the default words of its message; Notifications uses them
 * while the website has no template of its own, the merchant's template wins, deleting it returns to the default, a
 * switched-off message is skipped, and WhatsApp (no default possible) is recorded as not set up, then goes to the
 * fallback channel. The dashboard lists every product's messages through the Portal's directory.
 */
import { TEMPLATE_CHANNELS } from '@ss/contracts/templates';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULTS_TTL_MS } from '../adapters/defaults.js';
import { CHANNELS } from '../core/channels.js';
import { checkDefaults, productOfKey, templateRows } from '../core/templates.js';
import { SWITCHED_OFF } from '../server/sending.js';
import { OTHER_PRODUCTS, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

const RESEND = { provider: 'resend', secret: 're_secret_1234', from: 'Shop <shop@shop.example.com>' };
const TWILIO = { provider: 'twilio', accountSid: `AC${'a'.repeat(32)}`, secret: 'twilio-token-9876', from: '+15550001111' };
const META = { provider: 'meta', phoneNumberId: '1234567890', secret: 'meta-token-5555', appSecret: 'meta-app-secret' };

/** What Accounts' kit attaches to a reset link send. */
const RESET_DEFAULTS = {
	email: {
		subject: 'Reset your password for {business}',
		text: 'Choose a new password: {link}\n\nThe link works for {minutes} minutes.',
		required: true,
		urgent: true,
		sensitive: true,
	},
};
/** What Chat's kit attaches to a new-message staff alert. */
const ALERT_DEFAULTS = {
	email: {
		subject: 'New chat message from {visitor}',
		text: '{visitor}: {preview}{?link}\n\nOpen the conversation: {link}{/link}',
		required: true,
		urgent: false,
		sensitive: false,
	},
	sms: { text: 'New chat from {visitor}: {preview}', required: true, urgent: false, sensitive: false },
};
const ALERT_VALUES = { visitor: 'Alex Morgan', preview: 'Is it in stock?', link: '', business: 'Shop' };

const lastResend = () => JSON.parse(env.providers.callsTo('https://api.resend.com').at(-1)?.body ?? '{}');
const lastSms = () => new URLSearchParams(env.providers.callsTo('https://api.twilio.com').at(-1)?.body).get('Body');

/** @param {string} key @param {string} channel @param {unknown} body */
const switchMessage = async (key, channel, body) =>
	env.dashboard(await env.adminSession(), 'PUT', `/v1/dashboard/websites/${env.websiteId}/messages/${key}/${channel}`, body);

beforeAll(async () => {
	env = await setup();
	await env.switchOn(['email', 'sms', 'whatsapp', 'fallback', 'send_api']);
	await env.connectDatabase();
	expect((await env.connect('email', RESEND)).status).toBe('connected');
	expect((await env.connect('sms', TWILIO)).status).toBe('connected');
	expect((await env.connect('whatsapp', META)).status).toBe('connected');
});

describe('default templates of products (parity P1)', () => {
	it('a website with no templates gets the product default, by email and by SMS', async () => {
		const reset = await env.send('email', {
			template: 'accounts.password_reset',
			to: { email: 'rea@example.com' },
			values: { link: 'https://shop.example.com/#reset=abc', minutes: 60, business: 'Shop' },
			defaults: RESET_DEFAULTS,
		});
		expect(reset.status).toBe(201);
		expect(reset.json).toMatchObject({ status: 'sent', subject: 'Reset your password for ******' });
		// sent with the real words; the delivery log hides an Accounts message's values
		expect(lastResend()).toMatchObject({
			to: ['rea@example.com'],
			subject: 'Reset your password for Shop',
			text: 'Choose a new password: https://shop.example.com/#reset=abc\n\nThe link works for 60 minutes.',
		});
		expect(reset.json.text).toBe('Choose a new password: [link hidden]\n\nThe link works for ****** minutes.');

		const alert = await env.send('sms', {
			template: 'chat.staff_new_message',
			to: { phone: '+15550002222' },
			values: ALERT_VALUES,
			required: true,
			defaults: ALERT_DEFAULTS,
		});
		expect(alert.json).toMatchObject({ status: 'sent', text: 'New chat from Alex Morgan: Is it in stock?' });
		expect(lastSms()).toBe('New chat from Alex Morgan: Is it in stock?');
		// a product's message with no default on the channel and no template of the merchant's: as before
		const none = await env.send('email', { template: 'chat.transcript', to: { email: 'rea@example.com' } });
		expect(none.status).toBe(422);
		expect(none.json.type).toMatch(/template_not_found$/);
	});

	it('the merchant’s template wins, and deleting it (reset) returns to the default', async () => {
		await env.template({
			key: 'chat.staff_new_message',
			channel: 'email',
			subject: 'Chat: {visitor}',
			text: 'Reply soon: {preview}',
			required: true,
		});
		const send = () =>
			env.send('email', {
				template: 'chat.staff_new_message',
				to: { email: 'ops@example.com' },
				values: ALERT_VALUES,
				required: true,
				defaults: ALERT_DEFAULTS,
			});
		expect((await send()).json).toMatchObject({ status: 'sent', subject: 'Chat: Alex Morgan' });
		expect(lastResend()).toMatchObject({ subject: 'Chat: Alex Morgan', text: 'Reply soon: Is it in stock?' });
		const removed = await env.dashboard(
			await env.adminSession(),
			'DELETE',
			`/v1/dashboard/websites/${env.websiteId}/templates/chat.staff_new_message/email/default`,
		);
		expect(removed.status).toBe(204);
		expect((await send()).json).toMatchObject({ status: 'sent', subject: 'New chat message from Alex Morgan' });
		// an empty optional section is left out
		expect(lastResend().text).toBe('Alex Morgan: Is it in stock?');
	});

	it('a switched-off message is skipped, never sent; Accounts’ messages and the merchant’s own keys cannot be switched off', async () => {
		const before = env.providers.callsTo('https://api.resend.com').length;
		const off = await switchMessage('chat.staff_new_message', 'email', { off: true });
		expect(off.status).toBe(200);
		expect(await off.json()).toEqual({ key: 'chat.staff_new_message', channel: 'email', off: true });
		const skipped = await env.send('email', {
			template: 'chat.staff_new_message',
			to: { email: 'ops@example.com' },
			values: ALERT_VALUES,
			required: true,
			defaults: ALERT_DEFAULTS,
		});
		expect(skipped.status).toBe(201);
		expect(skipped.json).toMatchObject({ status: 'skipped', reason: SWITCHED_OFF, subject: '', text: '', attempts: [] });
		expect(env.providers.callsTo('https://api.resend.com')).toHaveLength(before);
		// only that channel: SMS still goes
		const sms = await env.send('sms', {
			template: 'chat.staff_new_message',
			to: { phone: '+15550002222' },
			values: ALERT_VALUES,
			defaults: ALERT_DEFAULTS,
		});
		expect(sms.json.status).toBe('sent');
		const listed = await env.dashboard(await env.adminSession(), 'GET', `/v1/dashboard/websites/${env.websiteId}/messages`);
		expect((await listed.json()).off).toEqual([{ key: 'chat.staff_new_message', channel: 'email' }]);
		const recent = await env.dashboard(await env.adminSession(), 'GET', `/v1/dashboard/websites/${env.websiteId}/overview`);
		expect(JSON.stringify(await recent.json())).toContain('Message chat.staff_new_message (email): switched off');
		const logged = await env.call('GET', '/v1/activity?action=message.switched_off', { token: env.server });
		expect((await logged.json()).items).toEqual([
			expect.objectContaining({
				actor: expect.objectContaining({ kind: 'admin' }),
				target: 'chat.staff_new_message/email',
				label: 'chat.staff_new_message (email)',
			}),
		]);

		expect((await switchMessage('chat.staff_new_message', 'email', { off: false })).status).toBe(200);
		const again = await env.send('email', {
			template: 'chat.staff_new_message',
			to: { email: 'ops@example.com' },
			values: ALERT_VALUES,
			defaults: ALERT_DEFAULTS,
		});
		expect(again.json.status).toBe('sent');

		const signIn = await switchMessage('accounts.password_reset', 'email', { off: true });
		expect(signIn.status).toBe(422);
		expect((await signIn.json()).errors[0].message).toBe(
			'Sign-in messages are always sent: switch the sign-in method off in Accounts instead.',
		);
		expect((await switchMessage('welcome', 'email', { off: true })).status).toBe(422);
		expect((await switchMessage('chat.staff_new_message', 'fax', { off: true })).status).toBe(404);
		expect((await switchMessage('chat.staff_new_message', 'email', { off: 'yes' })).status).toBe(422);
	});

	it('WhatsApp without the merchant’s template is recorded as not set up, then goes to the fallback channel', async () => {
		const meta = env.providers.callsTo('https://graph.facebook.com').length;
		const failed = await env.send('whatsapp', {
			template: 'chat.staff_new_message',
			to: { phone: '+15550002222' },
			values: ALERT_VALUES,
			required: true,
			defaults: ALERT_DEFAULTS,
		});
		expect(failed.status).toBe(201);
		expect(failed.json).toMatchObject({
			status: 'failed',
			channel: 'whatsapp',
			reason: 'not_set_up',
			reasonValues: { template: 'chat.staff_new_message' },
			attempts: [
				{
					channel: 'whatsapp',
					provider: 'none',
					outcome: 'failed',
					reason: 'not_set_up',
					reasonValues: { template: 'chat.staff_new_message' },
				},
			],
		});
		expect(env.providers.callsTo('https://graph.facebook.com')).toHaveLength(meta);
		// with WhatsApp → SMS as the fallback, the SMS default goes
		await env.fallback('whatsapp', 'sms');
		const fellBack = await env.send('whatsapp', {
			template: 'chat.staff_new_message',
			to: { phone: '+15550002222' },
			values: ALERT_VALUES,
			required: true,
			defaults: ALERT_DEFAULTS,
		});
		expect(fellBack.json).toMatchObject({ status: 'sent', channel: 'sms', text: 'New chat from Alex Morgan: Is it in stock?' });
		expect(fellBack.json.attempts.map((/** @type {any} */ a) => `${a.channel}:${a.provider}:${a.outcome}`)).toEqual([
			'whatsapp:none:failed',
			'sms:twilio:sent',
		]);
		expect(lastSms()).toBe('New chat from Alex Morgan: Is it in stock?');
		// a sign-in code is not set up either, and its values stay hidden in the log
		const code = await env.send('whatsapp', {
			template: 'accounts.phone_code',
			to: { phone: '+15550002222' },
			values: { code: '123456', minutes: 10, business: 'Shop' },
			defaults: { sms: { text: '{code} is your {business} code.', required: true, urgent: true, sensitive: true } },
		});
		expect(code.json).toMatchObject({ status: 'sent', channel: 'sms', text: '****** is your ****** code.' });
		expect(lastSms()).toBe('123456 is your Shop code.');
		await env.fallback('whatsapp', 'none');
		// once the merchant sets the WhatsApp template up, it goes by WhatsApp
		await env.template({
			key: 'chat.staff_new_message',
			channel: 'whatsapp',
			text: 'New chat from {visitor}',
			providerTemplate: 'chat_alert',
			required: true,
		});
		const set = await env.send('whatsapp', {
			template: 'chat.staff_new_message',
			to: { phone: '+15550002222' },
			values: ALERT_VALUES,
			defaults: ALERT_DEFAULTS,
		});
		expect(set.json).toMatchObject({ status: 'sent', channel: 'whatsapp' });
		expect(env.providers.callsTo('https://graph.facebook.com')).toHaveLength(meta + 1);
		// the merchant's own keys keep answering template_not_found on WhatsApp, and use defaults their send carries
		const own = await env.send('whatsapp', { template: 'welcome', to: { phone: '+15550002222' } });
		expect(own.json.type).toMatch(/template_not_found$/);
		const ownDefault = await env.send('sms', {
			template: 'my.receipt',
			to: { phone: '+15550002222' },
			values: { amount: '12' },
			defaults: { sms: { text: 'Paid: {amount}' } },
		});
		expect(ownDefault.json).toMatchObject({ status: 'sent', text: 'Paid: 12' });
	});

	it('keeps the defaults on a waiting message for its fallback, never in a delivery-log read, and drops them once done', async () => {
		await env.fallback('email', 'sms');
		env.providers.respond('https://api.resend.com', () => ({ status: 503 }));
		const waiting = await env.send('email', {
			template: 'chat.staff_new_message',
			to: { email: 'ops@example.com', phone: '+15550002222' },
			values: ALERT_VALUES,
			required: true,
			defaults: ALERT_DEFAULTS,
		});
		expect(waiting.json.status).toBe('retrying');
		const messages = await env.merchantCollection('messages');
		expect((await messages.findOne({ websiteId: env.websiteId, id: waiting.json.id }))?.defaults).toMatchObject({
			sms: { text: ALERT_DEFAULTS.sms.text },
		});
		const read = await (await env.call('GET', `/v1/messages/${waiting.json.id}`, { token: env.server })).json();
		expect(read).not.toHaveProperty('defaults');
		env.advance(61_000);
		await env.call('GET', '/v1/messages?limit=1', { token: env.server });
		env.advance(5 * 60_000 + 1000);
		await env.call('GET', '/v1/messages?limit=1', { token: env.server });
		const done = await (await env.merchantCollection('messages')).findOne({ websiteId: env.websiteId, id: waiting.json.id });
		expect(done).toMatchObject({
			status: 'sent',
			channel: 'sms',
			text: 'New chat from Alex Morgan: Is it in stock?',
			defaults: null,
		});
		env.providers.reset('https://api.resend.com');
		await env.fallback('email', 'none');
	});

	it('a send with a fallbackTemplate uses the website’s template for that key before the defaults', async () => {
		const STATUS_DEFAULTS = {
			email: {
				subject: 'Your order {number} is now {status}',
				text: 'Your order {number} is now {status}.',
				required: true,
				urgent: false,
				sensitive: false,
			},
			sms: { text: 'Your order {number} is now {status}.', required: true, urgent: false, sensitive: false },
		};
		/** @param {string} channel @param {Record<string, unknown>} [more] */
		const send = (channel, more = {}) =>
			env.send(channel, {
				template: 'ecommerce.order_status.shipped',
				fallbackTemplate: 'ecommerce.order_status',
				to: { email: 'sam@example.com', phone: '+15550003333' },
				values: { number: 'A-1001', status: 'Shipped' },
				required: true,
				defaults: STATUS_DEFAULTS,
				...more,
			});
		// no template of the website's: the defaults
		expect((await send('email')).json).toMatchObject({ status: 'sent', subject: 'Your order A-1001 is now Shipped' });
		// the website's general template comes before the defaults
		await env.template({
			key: 'ecommerce.order_status',
			channel: 'email',
			subject: 'Order {number}: {status}',
			text: 'Hello, order {number} is {status}.',
			required: true,
		});
		expect((await send('email')).json).toMatchObject({ status: 'sent', subject: 'Order A-1001: Shipped' });
		expect(lastResend()).toMatchObject({ subject: 'Order A-1001: Shipped', text: 'Hello, order A-1001 is Shipped.' });
		// and its template for the status itself before both
		await env.template({
			key: 'ecommerce.order_status.shipped',
			channel: 'email',
			subject: 'On its way: {number}',
			text: 'Order {number} has shipped.',
			required: true,
		});
		expect((await send('email')).json).toMatchObject({ status: 'sent', subject: 'On its way: A-1001' });
		const removed = await env.dashboard(
			await env.adminSession(),
			'DELETE',
			`/v1/dashboard/websites/${env.websiteId}/templates/ecommerce.order_status.shipped/email/default`,
		);
		expect(removed.status).toBe(204);
		expect((await send('email')).json).toMatchObject({ status: 'sent', subject: 'Order A-1001: Shipped' });
		// without a fallbackTemplate, the per-status key alone has only the defaults
		expect((await send('email', { fallbackTemplate: undefined })).json).toMatchObject({
			subject: 'Your order A-1001 is now Shipped',
		});

		// switching the general message off skips the per-status one too, on that channel only
		expect((await switchMessage('ecommerce.order_status', 'email', { off: true })).status).toBe(200);
		expect((await send('email')).json).toMatchObject({ status: 'skipped', reason: SWITCHED_OFF });
		expect((await send('sms')).json).toMatchObject({ status: 'sent', text: 'Your order A-1001 is now Shipped.' });
		expect((await switchMessage('ecommerce.order_status', 'email', { off: false })).status).toBe(200);

		// WhatsApp names both keys when neither is set up
		expect((await send('whatsapp')).json).toMatchObject({
			status: 'failed',
			reason: 'not_set_up',
			reasonValues: { template: 'ecommerce.order_status.shipped', fallbackTemplate: 'ecommerce.order_status' },
		});

		// a message moved to its fallback channel keeps the chain: the website's general SMS template
		await env.template({ key: 'ecommerce.order_status', channel: 'sms', text: 'Order {number}: {status}', required: true });
		await env.fallback('email', 'sms');
		env.providers.respond('https://api.resend.com', () => ({ status: 503 }));
		const waiting = await send('email');
		expect(waiting.json.status).toBe('retrying');
		env.advance(61_000);
		await env.call('GET', '/v1/messages?limit=1', { token: env.server });
		env.advance(5 * 60_000 + 1000);
		await env.call('GET', '/v1/messages?limit=1', { token: env.server });
		const done = await (await env.merchantCollection('messages')).findOne({ websiteId: env.websiteId, id: waiting.json.id });
		expect(done).toMatchObject({ status: 'sent', channel: 'sms', text: 'Order A-1001: Shipped' });
		env.providers.reset('https://api.resend.com');
		await env.fallback('email', 'none');

		// fallbackTemplate is another template key
		for (const fallbackTemplate of ['ecommerce.order_status.shipped', 'Order status', 42]) {
			const refused = await send('email', { fallbackTemplate });
			expect(refused.status).toBe(422);
			expect(refused.json.errors[0]).toMatchObject({ path: '/fallbackTemplate' });
		}
	});

	it('refuses defaults that break the template rules, and WhatsApp defaults', async () => {
		/** @param {string} channel @param {Record<string, unknown>} body */
		const refused = async (channel, body) => {
			const answer = await env.send(channel, { to: { email: 'a@example.com', phone: '+15550002222' }, ...body });
			expect(answer.status).toBe(422);
			return answer.json.errors[0];
		};
		expect(
			await refused('whatsapp', { template: 'chat.staff_new_message', defaults: { whatsapp: { text: 'Hi' } } }),
		).toMatchObject({ path: '/defaults/whatsapp' });
		expect(await refused('email', { template: 'chat.x', defaults: { email: { text: 'Hi' } } })).toMatchObject({
			path: '/defaults/email/subject',
			message: 'Write the subject.',
		});
		expect(await refused('email', { template: 'chat.x', defaults: { fax: { text: 'Hi' } } })).toMatchObject({
			path: '/defaults/fax',
		});
		expect(await refused('email', { template: 'chat.x', defaults: ['email'] })).toMatchObject({ path: '/defaults' });
		expect(await refused('sms', { template: 'chat.x', defaults: { sms: { text: '{?a}x' } } })).toMatchObject({
			path: '/defaults/sms/text',
			message: 'Close {?a} with {/a}.',
		});
	});
});

describe('the dashboard’s list of products’ messages (parity P1)', () => {
	it('reads each product’s defaults through the Portal directory, keeps them 10 minutes and shows the switched-off ones', async () => {
		/** @type {Record<string, number>} */
		const reads = { accounts: 0, chat: 0 };
		/** @type {Record<string, unknown>} */
		const answers = {
			accounts: {
				productId: 'accounts',
				messages: [
					{
						key: 'accounts.password_reset',
						name: 'Password reset link',
						values: ['link', 'minutes', 'business'],
						required: true,
						urgent: true,
						sensitive: true,
						channels: { email: { subject: RESET_DEFAULTS.email.subject, text: RESET_DEFAULTS.email.text } },
					},
				],
			},
			chat: {
				productId: 'chat',
				messages: [
					{
						key: 'chat.staff_new_message',
						name: 'New chat message',
						values: ['visitor', 'preview', 'link', 'business'],
						required: true,
						channels: {
							email: { subject: ALERT_DEFAULTS.email.subject, text: ALERT_DEFAULTS.email.text },
							sms: { text: ALERT_DEFAULTS.sms.text },
							whatsapp: null,
						},
					},
				],
			},
		};
		for (const productId of ['accounts', 'chat']) {
			const base = `https://${productId}.example.dev`;
			env.portal.addProduct({ productId, baseUrl: base });
			env.handlers[base] = async (request) => {
				expect(new URL(request.url).pathname).toBe('/v1/message-defaults');
				reads[productId] = (reads[productId] ?? 0) + 1;
				const answer = answers[productId];
				return answer === 'down'
					? new Response('down', { status: 503 })
					: new Response(JSON.stringify(answer), { headers: { 'content-type': 'application/json' } });
			};
		}
		await switchMessage('chat.staff_new_message', 'sms', { off: true });
		const list = async () =>
			(await env.dashboard(await env.adminSession(), 'GET', `/v1/dashboard/websites/${env.websiteId}/messages`)).json();
		const first = await list();
		expect(first.items.map((/** @type {any} */ m) => `${m.productId}:${m.key}`)).toEqual([
			'accounts:accounts.password_reset',
			'chat:chat.staff_new_message',
		]);
		expect(first.items[1].channels.whatsapp).toBeNull();
		expect(first.off).toEqual([{ key: 'chat.staff_new_message', channel: 'sms' }]);
		// products of the directory that answer no list are named
		expect(first.unavailable).toEqual(['ecommerce', 'growth', 'payments']);
		await list();
		expect(reads).toEqual({ accounts: 1, chat: 1 });
		env.advance(DEFAULTS_TTL_MS);
		answers.chat = 'down';
		answers.accounts = {
			productId: 'accounts',
			messages: [{ key: 'chat.x', name: 'X', values: [], channels: { whatsapp: null } }],
		};
		const later = await list();
		expect(reads).toEqual({ accounts: 2, chat: 2 });
		// the last good copies stay while a product cannot be read or answers a list that does not fit the contract
		expect(later.items).toEqual(first.items);
		expect(later.unavailable).toEqual(['ecommerce', 'growth', 'payments']);
		await switchMessage('chat.staff_new_message', 'sms', { off: false });
	});
});

describe('a product made after Notifications (any product the Portal’s directory lists)', () => {
	const BOOKINGS = 'https://bookings.example.dev';
	/** What the new product's kit attaches to its confirmation. */
	const CONFIRMED = {
		email: {
			subject: 'Booking {number} is confirmed',
			text: 'See you on {day}.',
			required: false,
			urgent: false,
			sensitive: false,
		},
	};
	/** @param {Awaited<ReturnType<typeof setup>>} own @param {string} [template] */
	const confirm = (own, template = 'bookings.confirmed') =>
		own.send('email', {
			template,
			to: { email: 'sam@example.com' },
			values: { number: 'B-12', day: 'Monday' },
			defaults: CONFIRMED,
		});

	it('its keys are its own once the directory lists it: no Merchant send API, listed with its defaults, switchable', async () => {
		const own = await setup();
		await own.switchOn(['email']);
		await own.connectDatabase();
		expect((await own.connect('email', RESEND)).status).toBe('connected');
		// not connected to the Portal yet: the key is the merchant's own, which needs the Merchant send API
		const before = await confirm(own);
		expect(before.status).toBe(403);
		expect(before.json.type).toMatch(/feature_off$/);
		// the new product connects; within 5 minutes (the directory's cache) its keys are its own
		own.portal.addProduct({ productId: 'bookings', name: 'Bookings', baseUrl: BOOKINGS });
		own.handlers[BOOKINGS] = async () =>
			new Response(
				JSON.stringify({
					productId: 'bookings',
					messages: [
						{
							key: 'bookings.confirmed',
							name: 'Booking confirmed',
							values: ['number', 'day'],
							channels: { email: { subject: CONFIRMED.email.subject, text: CONFIRMED.email.text } },
						},
					],
				}),
				{ headers: { 'content-type': 'application/json' } },
			);
		own.advance(5 * 60_000);
		const sent = await confirm(own);
		expect(sent.status).toBe(201);
		expect(sent.json).toMatchObject({ status: 'sent', subject: 'Booking B-12 is confirmed', text: 'See you on Monday.' });
		// the dashboard lists its messages with their defaults; the merchant can switch one off
		const cookie = await own.adminSession();
		const listed = await (await own.dashboard(cookie, 'GET', `/v1/dashboard/websites/${own.websiteId}/messages`)).json();
		expect(listed.items).toContainEqual(
			expect.objectContaining({ productId: 'bookings', key: 'bookings.confirmed', name: 'Booking confirmed' }),
		);
		expect(listed.products).toContainEqual({ productId: 'bookings', name: 'Bookings' });
		expect(listed.products.map((/** @type {any} */ p) => p.productId)).not.toContain('notifications');
		const off = await own.dashboard(
			cookie,
			'PUT',
			`/v1/dashboard/websites/${own.websiteId}/messages/bookings.confirmed/email`,
			{
				off: true,
			},
		);
		expect(off.status).toBe(200);
		expect((await confirm(own)).json).toMatchObject({ status: 'skipped', reason: SWITCHED_OFF });
		// a merchant's own key with a dot is not a product's: it still needs the Merchant send API, and cannot be
		// switched off
		expect((await confirm(own, 'promo.summer')).status).toBe(403);
		const mine = await own.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${own.websiteId}/messages/promo.summer/email`, {
			off: true,
		});
		expect(mine.status).toBe(422);
		expect((await mine.json()).errors[0].message).toBe(
			'Only the messages of products can be switched off: delete your own template instead.',
		);
	});

	it('while the Portal’s directory cannot be read, a product’s message still goes; the dashboard asks to try again', async () => {
		const own = await setup();
		await own.switchOn(['email']);
		await own.connectDatabase();
		expect((await own.connect('email', RESEND)).status).toBe('connected');
		const cookie = await own.adminSession();
		own.portal.setReachable(false);
		// never read on this instance: a key whose first part can be a product's counts as that product's
		expect((await confirm(own)).json).toMatchObject({ status: 'sent', subject: 'Booking B-12 is confirmed' });
		// Notifications' own id is never another product
		expect((await confirm(own, 'notifications.test')).status).toBe(403);
		const listed = await own.dashboard(cookie, 'GET', `/v1/dashboard/websites/${own.websiteId}/messages`);
		expect(listed.status).toBe(503);
		expect((await listed.json()).type).toMatch(/portal_unreachable$/);
	});
});

describe('rules of defaults and rows (core)', () => {
	it('uses the contract’s channels and knows the products’ keys', () => {
		expect(CHANNELS).toEqual(TEMPLATE_CHANNELS);
		// a key is a product's when its first part names a product of the Portal's directory, whichever product it is
		const products = [...OTHER_PRODUCTS, 'bookings'];
		expect(productOfKey('chat.staff_new_message', products)).toBe('chat');
		expect(productOfKey('bookings.confirmed', products)).toBe('bookings');
		expect(productOfKey('bookings.confirmed', OTHER_PRODUCTS)).toBeNull();
		expect(productOfKey('promo.summer', products)).toBeNull();
		expect(productOfKey('welcome', products)).toBeNull();
		expect(productOfKey('.chat', products)).toBeNull();
		expect(checkDefaults(undefined, 'chat.x')).toEqual({ ok: true, value: {} });
		const checked = checkDefaults({ sms: { text: ' Hi ' } }, 'accounts.phone_code');
		expect(checked).toMatchObject({ ok: true, value: { sms: { text: 'Hi', required: true, urgent: true, sensitive: true } } });
	});

	it('makes a row per product message and channel, then every other saved template', () => {
		/** @type {import('../core/templates.js').ProductMessage[]} */
		const messages = [
			{
				productId: 'chat',
				key: 'chat.staff_new_message',
				name: 'New chat message',
				values: ['visitor', 'preview'],
				required: true,
				channels: { sms: { text: 'New chat: {preview}' }, email: { subject: 'Chat', text: '{preview}' }, whatsapp: null },
			},
			{
				productId: 'accounts',
				key: 'accounts.email_code',
				name: 'Sign-in code',
				values: ['code'],
				channels: { email: { subject: 'Code', text: '{code}' } },
			},
		];
		const template = (/** @type {Record<string, unknown>} */ fields) =>
			/** @type {any} */ ({
				subject: '',
				required: false,
				urgent: false,
				sensitive: false,
				providerTemplate: '',
				buttons: [],
				...fields,
			});
		const rows = templateRows({
			messages,
			templates: [
				template({ key: 'chat.staff_new_message', channel: 'email', language: 'default', subject: 'Mine', text: 'Mine' }),
				template({ key: 'chat.staff_new_message', channel: 'email', language: 'fr', subject: 'Le mien', text: 'Le mien' }),
				template({ key: 'welcome', channel: 'sms', language: 'default', text: 'Hi' }),
			],
			off: [{ key: 'chat.staff_new_message', channel: 'sms' }],
		});
		expect(rows.map((row) => `${row.key}|${row.channel}|${row.language}|${row.state}|${row.switchable}`)).toEqual([
			'accounts.email_code|email|default|default|false',
			'chat.staff_new_message|email|default|edited|true',
			'chat.staff_new_message|sms|default|off|true',
			'chat.staff_new_message|whatsapp|default|not_set_up|true',
			'chat.staff_new_message|email|fr|saved|false',
			'welcome|sms|default|saved|false',
		]);
		expect(rows[0]?.defaults).toMatchObject({ subject: 'Code', text: '{code}', required: true, sensitive: true });
		expect(rows[1]?.template?.subject).toBe('Mine');
		expect(rows[3]?.defaults).toBeNull();
	});
});

describe('long values of a product’s message (a chat transcript)', () => {
	/** What Chat's kit attaches to a transcript: its defaults and its long value. */
	const TRANSCRIPT = {
		template: 'chat.transcript',
		longValues: ['transcript'],
		required: true,
		defaults: {
			email: {
				subject: 'Your chat with {business}',
				text: 'Here is your chat with {business}:\n\n{transcript}',
				required: true,
				urgent: true,
				sensitive: false,
			},
			sms: { text: 'Your chat with {business}:\n{transcript}', required: true, urgent: true, sensitive: false },
		},
	};
	/** A chat of about 49,000 characters, a line per message. */
	const CHAT = Array.from({ length: 500 }, (_, i) => `You: message ${String(i).padStart(3, '0')} ${'x'.repeat(80)}`).join('\n');
	const NOTE = '… (shortened)';
	/** @type {Awaited<ReturnType<typeof setup>>} */
	let own;
	const sms = () => new URLSearchParams(own.providers.callsTo('https://api.twilio.com').at(-1)?.body).get('Body') ?? '';
	/** @param {string} channel @param {Record<string, unknown>} [more] */
	const send = (channel, more = {}) =>
		own.send(channel, {
			...TRANSCRIPT,
			to: { email: 'ana@example.com', phone: '+15550004444' },
			values: { transcript: CHAT, business: 'Shop' },
			...more,
		});

	beforeAll(async () => {
		own = await setup();
		await own.switchOn(['email', 'sms', 'fallback', 'send_api']);
		await own.connectDatabase();
		expect((await own.connect('email', RESEND)).status).toBe('connected');
		expect((await own.connect('sms', TWILIO)).status).toBe('connected');
	});

	it('email sends a long value whole; values over the limits, and long values of the merchant’s own keys, are refused', async () => {
		expect(CHAT.length).toBeGreaterThan(45_000);
		const sent = await send('email');
		expect(sent).toMatchObject({ status: 201, json: { status: 'sent', subject: 'Your chat with Shop' } });
		expect(JSON.parse(own.providers.callsTo('https://api.resend.com').at(-1)?.body ?? '{}').text).toBe(
			`Here is your chat with Shop:\n\n${CHAT}`,
		);
		/** @param {Record<string, unknown>} body */
		const refused = async (body) => {
			const answer = await send('email', body);
			expect(answer.status).toBe(422);
			return answer.json.errors[0];
		};
		// only a value the send names long may pass 1,000 characters, up to 50,000; 100,000 for all the values
		expect(await refused({ longValues: undefined })).toMatchObject({ path: '/values' });
		expect(await refused({ values: { transcript: 'x'.repeat(50_001), business: 'Shop' } })).toMatchObject({
			path: '/values',
		});
		expect(
			await refused({
				longValues: ['transcript', 'summary'],
				values: { transcript: 'x'.repeat(50_000), summary: 'y'.repeat(50_000), business: 'Shop' },
			}),
		).toMatchObject({ path: '/values' });
		expect(await refused({ longValues: 'transcript' })).toMatchObject({ path: '/longValues' });
		expect(await refused({ template: 'order_ready', defaults: undefined })).toMatchObject({
			path: '/longValues',
			message: 'Only the messages of products have long values.',
		});
		// a long value goes in the message only
		expect(
			await refused({
				defaults: { email: { ...TRANSCRIPT.defaults.email, subject: 'Chat: {transcript}' } },
			}),
		).toMatchObject({ path: '/defaults/email/subject', message: '{transcript} is long text: use it in the message only.' });
	});

	it('SMS gets a long value cut to fit at a line end, with the website’s note; so does the fallback channel', async () => {
		/** The chat lines an SMS kept, after checking it fits, cuts at a line end and ends with the note. */
		const kept = (/** @type {string} */ body, /** @type {string} */ note) => {
			expect(body.length).toBeLessThanOrEqual(1600);
			expect(body.endsWith(note)).toBe(true);
			const lines = body.slice('Your chat with Shop:\n'.length, -note.length);
			expect(CHAT.startsWith(lines)).toBe(true);
			expect(CHAT[lines.length]).toBe('\n');
			return lines;
		};
		expect((await send('sms')).json).toMatchObject({ status: 'sent' });
		expect(kept(sms(), NOTE).split('\n')).toHaveLength(15);
		// the note is a website text the merchant may change
		const cookie = await own.adminSession();
		const texts = `/v1/dashboard/websites/${own.websiteId}/texts/message.shortened`;
		expect((await own.dashboard(cookie, 'PUT', texts, { value: ' [the rest is in your email]' })).status).toBe(204);
		expect((await send('sms')).json).toMatchObject({ status: 'sent' });
		kept(sms(), ' [the rest is in your email]');
		expect((await own.dashboard(cookie, 'DELETE', texts)).status).toBe(204);

		// an email that fails moves to SMS, where its long value is cut too
		await own.fallback('email', 'sms');
		own.providers.respond('https://api.resend.com', () => ({ status: 503 }));
		const waiting = await send('email');
		expect(waiting.json.status).toBe('retrying');
		const messages = await own.merchantCollection('messages');
		expect(await messages.findOne({ websiteId: own.websiteId, id: waiting.json.id })).toMatchObject({
			longValues: ['transcript'],
		});
		own.advance(61_000);
		await own.call('GET', '/v1/messages?limit=1', { token: own.server });
		own.advance(5 * 60_000 + 1000);
		await own.call('GET', '/v1/messages?limit=1', { token: own.server });
		const done = await (await own.merchantCollection('messages')).findOne({ websiteId: own.websiteId, id: waiting.json.id });
		expect(done).toMatchObject({ status: 'sent', channel: 'sms' });
		kept(String(done?.text), NOTE);
		expect(sms()).toBe(done?.text);
		own.providers.reset('https://api.resend.com');
	});

	it('a template the merchant saves for a product’s message keeps its long values out of the subject and buttons', async () => {
		const CHAT_BASE = 'https://chat.example.dev';
		own.handlers[CHAT_BASE] = async () =>
			new Response(
				JSON.stringify({
					productId: 'chat',
					messages: [
						{
							key: 'chat.transcript',
							name: 'Chat transcript',
							values: ['transcript', 'business'],
							longValues: ['transcript'],
							required: true,
							channels: { email: { subject: 'Your chat with {business}', text: '{transcript}' } },
						},
					],
				}),
				{ headers: { 'content-type': 'application/json' } },
			);
		const cookie = await own.adminSession();
		const base = `/v1/dashboard/websites/${own.websiteId}/templates`;
		const titled = await own.dashboard(cookie, 'PUT', base, {
			key: 'chat.transcript',
			channel: 'email',
			subject: 'Chat {transcript}',
			text: 'Your chat:\n\n{transcript}',
			required: true,
		});
		expect(titled.status).toBe(422);
		expect((await titled.json()).errors[0]).toMatchObject({
			path: '/subject',
			message: '{transcript} is long text: use it in the message only.',
		});
		const saved = await own.dashboard(cookie, 'PUT', base, {
			key: 'chat.transcript',
			channel: 'email',
			subject: 'Your chat with {business}',
			text: 'Your chat:\n\n{transcript}',
			required: true,
		});
		expect(saved.status).toBe(200);
		// the dashboard's list shows the long values of the message
		const listed = await (await own.dashboard(cookie, 'GET', `/v1/dashboard/websites/${own.websiteId}/messages`)).json();
		expect(listed.items.find((/** @type {any} */ m) => m.key === 'chat.transcript')?.longValues).toEqual(['transcript']);
		// the merchant's own keys have no long values
		expect(
			(
				await own.dashboard(cookie, 'PUT', base, {
					key: 'chat_copy',
					channel: 'email',
					subject: 'Chat {transcript}',
					text: '{transcript}',
				})
			).status,
		).toBe(200);
	});
});
