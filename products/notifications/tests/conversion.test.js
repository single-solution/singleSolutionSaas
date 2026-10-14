/**
 * Notifications for converting existing stores (PLAN 0.8.10 N1–N5): WhatsApp template buttons, optional sections,
 * the long retry plan, the template routes for the merchant's server and webhook URLs per event.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_ORIGIN, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

const META = { provider: 'meta', phoneNumberId: '1234567890', secret: 'meta-token-5555' };
const RESEND = { provider: 'resend', secret: 're_secret_1234', from: 'Shop <shop@shop.example.com>' };

/** The body of the last call to Meta. */
const lastMeta = () => JSON.parse(env.providers.callsTo('https://graph.facebook.com').at(-1)?.body ?? '{}');

beforeAll(async () => {
	env = await setup();
	await env.switchOn(['whatsapp', 'email', 'sms', 'webhooks', 'send_api']);
	await env.connectDatabase();
	await env.connect('whatsapp', META);
	await env.connect('email', RESEND);
});
afterAll(async () => {
	await env.product.close();
});

describe('WhatsApp template buttons (N1)', () => {
	it('keeps the buttons of a template at Meta and sends a copy-code button with the code', async () => {
		const cookie = await env.adminSession();
		const path = `/v1/dashboard/websites/${env.websiteId}/templates`;
		const refused = await env.dashboard(cookie, 'PUT', path, {
			key: 'accounts.code',
			channel: 'sms',
			text: 'Code {code}',
			buttons: [{ index: 0, type: 'copy_code', value: '{code}' }],
		});
		expect(refused.status).toBe(422);
		expect((await refused.json()).errors[0].path).toBe('/buttons');
		await env.template({
			key: 'accounts.code',
			channel: 'whatsapp',
			text: '{code} is your verification code.',
			providerTemplate: 'authentication',
			required: true,
			urgent: true,
			buttons: [{ index: 0, type: 'copy_code', value: '{code}' }],
		});
		const list = await (await env.dashboard(cookie, 'GET', path)).json();
		expect(list.items).toContainEqual(
			expect.objectContaining({ key: 'accounts.code', buttons: [{ index: 0, type: 'copy_code', value: '{code}' }] }),
		);
		const sent = await env.send('whatsapp', {
			template: 'accounts.code',
			to: { phone: '+447700900123' },
			values: { code: '482913' },
		});
		// the delivery log keeps the code hidden; Meta gets it (PLAN 0.8.10 D11)
		expect(sent).toMatchObject({ status: 201, json: { status: 'sent', text: '****** is your verification code.' } });
		expect(lastMeta()).toEqual({
			messaging_product: 'whatsapp',
			to: '447700900123',
			type: 'template',
			template: {
				name: 'authentication',
				language: { code: 'en' },
				components: [
					{ type: 'body', parameters: [{ type: 'text', text: '482913' }] },
					{ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '482913' }] },
				],
			},
		});
		const overview = await (await env.dashboard(cookie, 'GET', `/v1/dashboard/websites/${env.websiteId}/overview`)).json();
		expect(overview.recentChanges.map((/** @type {{ detail: string }} */ c) => c.detail)).toContain(
			'Template accounts.code (whatsapp, default): saved',
		);
	});
});

describe('the long retry plan (N3)', () => {
	it('retries 6 times over about 10.5 hours, on uses; a message keeps the plan it was sent with', async () => {
		await env.setting('whatsapp', 'retryPlan', 'long');
		await env.template({ key: 'ecommerce.order_shipped', channel: 'whatsapp', text: 'Order {order} shipped.', required: true });
		env.providers.respond('https://graph.facebook.com', () => ({ status: 503 }));
		const sent = await env.send('whatsapp', {
			template: 'ecommerce.order_shipped',
			to: { phone: '+12025550143' },
			values: { order: 'SH-2026-0043' },
		});
		expect(sent.json).toMatchObject({ status: 'retrying', attempts: [{ outcome: 'failed' }] });
		// changing the setting later does not change the plan of a message already sent
		await env.setting('whatsapp', 'retryPlan', 'short');
		const attempts = async () =>
			(await (await env.call('GET', `/v1/messages/${sent.json.id}`, { token: env.server })).json()).attempts.length;
		const use = () => env.call('GET', '/v1/messages?limit=1', { token: env.server });
		const MIN = 60_000;
		env.advance(4 * MIN);
		await use();
		expect(await attempts()).toBe(1);
		for (const [wait, expected] of /** @type {const} */ ([
			[MIN + 1000, 2],
			[15 * MIN, 3],
			[60 * MIN, 4],
			[180 * MIN, 5],
			[359 * MIN, 5],
			[MIN, 6],
		])) {
			env.advance(wait);
			await use();
			expect(await attempts()).toBe(expected);
		}
		const done = await (await env.call('GET', `/v1/messages/${sent.json.id}`, { token: env.server })).json();
		expect(done.status).toBe('failed');
		const span = Date.parse(done.attempts.at(-1).at) - Date.parse(done.attempts[0].at);
		expect(span).toBeGreaterThan(10 * 60 * MIN);
		expect(span).toBeLessThan(10.6 * 60 * MIN);
		env.providers.reset('https://graph.facebook.com');
		// a later message is sent as usual
		const short = await env.send('whatsapp', {
			template: 'ecommerce.order_shipped',
			to: { phone: '+12025550143' },
			values: { order: 'SH-2026-0044' },
		});
		expect(short.json.status).toBe('sent');
	});
});

describe('templates for the merchant’s server (N4)', () => {
	const ACTOR = { 'ss-actor-id': 'usr_7', 'ss-actor-name': encodeURIComponent('Alex Morgan'), 'ss-actor-role': 'Manager' };
	/** @param {string} method @param {string} path @param {unknown} [body] @param {Record<string, string>} [headers] */
	const server = async (method, path, body, headers) => {
		const response = await env.call(method, path, { token: env.server, body, ...(headers ? { headers } : {}) });
		return { status: response.status, json: response.status === 204 ? null : await response.json() };
	};
	const recent = async () =>
		(await (await env.dashboard(await env.adminSession(), 'GET', `/v1/dashboard/websites/${env.websiteId}/overview`)).json())
			.recentChanges;

	it('lists, saves and deletes templates of switched-on channels, by the acting user', async () => {
		// a push template saved in the dashboard while browser push is off is not the server's
		await env.template({ key: 'alert', channel: 'push', subject: 'Back in stock', text: '{item} is back' });
		const listed = await server('GET', '/v1/templates');
		expect(listed.status).toBe(200);
		expect(listed.json.items.map((/** @type {any} */ t) => t.channel)).not.toContain('push');
		expect(listed.json.items).toContainEqual(expect.objectContaining({ key: 'accounts.code', channel: 'whatsapp' }));

		const saved = await server(
			'PUT',
			'/v1/templates',
			{
				key: 'ecommerce.order_cancelled',
				channel: 'sms',
				text: 'Order {order} was cancelled.{?reason} Reason: {reason}{/reason}',
				required: true,
			},
			ACTOR,
		);
		expect(saved).toMatchObject({
			status: 200,
			json: { key: 'ecommerce.order_cancelled', channel: 'sms', language: 'default', required: true, buttons: [] },
		});
		expect(await recent()).toContainEqual(
			expect.objectContaining({
				who: { kind: 'user', id: 'usr_7', name: 'Alex Morgan', role: 'Manager' },
				what: 'templates',
				detail: 'Template ecommerce.order_cancelled (sms, default): saved',
			}),
		);
		// the dashboard's checks
		const bad = await server('PUT', '/v1/templates', { key: 'x', channel: 'sms', text: '{?reason}open' });
		expect(bad.status).toBe(422);
		expect(bad.json.errors[0].path).toBe('/text');
		// a channel whose feature is off
		const off = await server('PUT', '/v1/templates', { key: 'x', channel: 'push', subject: 'T', text: 'x' });
		expect(off.status).toBe(403);
		expect(off.json.type).toMatch(/feature_off$/);
		expect((await server('DELETE', '/v1/templates/alert/push/default')).status).toBe(403);

		expect((await server('DELETE', '/v1/templates/ecommerce.order_cancelled/sms/default')).status).toBe(204);
		expect((await server('DELETE', '/v1/templates/ecommerce.order_cancelled/sms/default')).status).toBe(404);
		expect((await server('DELETE', '/v1/templates/x/fax/default')).status).toBe(404);
		expect(await recent()).toContainEqual(
			expect.objectContaining({
				who: { kind: 'server', id: 'server', name: 'Server' },
				detail: 'Template ecommerce.order_cancelled (sms, default): deleted',
			}),
		);
		// every channel off: the routes answer feature_off
		await env.switchOn(['webhooks', 'send_api']);
		expect((await server('GET', '/v1/templates')).status).toBe(403);
		await env.switchOn(['whatsapp', 'email', 'sms', 'webhooks', 'send_api']);
	});
});

describe('webhook URLs per event (N5)', () => {
	const HOOKS = 'https://hooks.example.org';
	const SECRET = 'whsec-0123456789abcdefghijklmnop';
	const list = () => `/v1/dashboard/websites/${env.websiteId}/lists/webhook_urls`;
	/** Paths of the webhook calls since `from`. @param {number} from */
	const delivered = (from) =>
		env.providers
			.callsTo(HOOKS)
			.slice(from)
			.map((call) => `${new URL(call.url).pathname} ${JSON.parse(call.body).type}`);

	it('keeps the URLs in their own list, which the merchant’s server and the dashboard read the same', async () => {
		const read = await env.call('GET', '/v1/lists/webhook_urls', { token: env.server });
		expect(await read.json()).toEqual({ value: [] });
		const settings = await (await env.call('GET', '/v1/settings', { token: env.server })).json();
		const webhooks = settings.features.find((/** @type {any} */ f) => f.key === 'webhooks');
		expect(Object.keys(webhooks.values)).toEqual(['events']);
		const value = [{ url: `${HOOKS}/first`, events: [] }];
		expect((await env.call('PUT', '/v1/lists/webhook_urls', { token: env.server, body: { value } })).status).toBe(200);
		// the dashboard reads the same list
		const cookie = await env.adminSession();
		expect(await (await env.dashboard(cookie, 'GET', list())).json()).toEqual({ value });
		expect((await env.dashboard(cookie, 'GET', `/v1/dashboard/websites/${env.websiteId}/lists/other`)).status).toBe(404);
	});

	it('sends each event only to the URLs that take it (none named: every event)', async () => {
		await env.connect('webhook_secret', SECRET);
		const saved = await env.call('PUT', '/v1/lists/webhook_urls', {
			token: env.server,
			headers: { 'ss-actor-id': 'usr_7', 'ss-actor-name': 'Sam Lee' },
			body: {
				value: [
					{ url: `${HOOKS}/orders`, events: ['ecommerce.order.placed', 'payments.payment.paid'] },
					{ url: `${HOOKS}/failures`, events: ['message.failed'] },
					{ url: `${HOOKS}/all`, events: [] },
				],
			},
		});
		expect(saved.status).toBe(200);
		const overview = await (
			await env.dashboard(await env.adminSession(), 'GET', `/v1/dashboard/websites/${env.websiteId}/overview`)
		).json();
		expect(overview.recentChanges).toContainEqual(
			expect.objectContaining({ who: { kind: 'user', id: 'usr_7', name: 'Sam Lee' }, detail: 'Webhook URLs: changed' }),
		);
		const from = env.providers.callsTo(HOOKS).length;
		/** @param {string} type */
		const relay = async (type) =>
			(await (await env.call('POST', '/v1/events', { token: env.server, body: { type, data: {} } })).json()).queued;
		expect(await relay('payments.payment.paid')).toBe(2);
		expect(await relay('chat.conversation.opened')).toBe(1);
		// Notifications' own events too: a failed message goes to /failures and /all, a sent one to /all
		env.providers.respond('https://graph.facebook.com', () => ({ status: 400, body: '{"error":{"message":"bad"}}' }));
		await env.send('whatsapp', { template: 'accounts.code', to: { phone: '+33612345678' }, values: { code: '1' } });
		env.providers.reset('https://graph.facebook.com');
		await env.send('whatsapp', { template: 'accounts.code', to: { phone: '+33612345678' }, values: { code: '2' } });
		expect(delivered(from).sort()).toEqual(
			[
				'/orders payments.payment.paid',
				'/all payments.payment.paid',
				'/all chat.conversation.opened',
				'/failures message.failed',
				'/all message.failed',
				'/all message.sent',
			].sort(),
		);
	});

	it('checks the list and keeps it to the webhooks feature', async () => {
		const bad = await env.call('PUT', '/v1/lists/webhook_urls', {
			token: env.server,
			body: { value: [{ url: `${HOOKS}/a`, events: ['orders'] }] },
		});
		expect(bad.status).toBe(422);
		expect((await bad.json()).errors[0].path).toBe('/value/0/events');
		const cookie = await env.adminSession();
		expect((await env.dashboard(cookie, 'PUT', list(), { value: 'x' })).status).toBe(422);
		await env.switchOn(['whatsapp', 'email', 'sms', 'send_api']);
		expect((await env.call('PUT', '/v1/lists/webhook_urls', { token: env.server, body: { value: [] } })).status).toBe(403);
		// a merchant edits it only while the feature is on; our admins may prepare it
		const launch = await env.portal.issueLaunch({ productId: 'notifications', kind: 'merchant', websiteId: env.websiteId });
		const merchant = ((await env.call('GET', `/sso?launch=${launch}`)).headers.get('set-cookie') ?? '').split(';')[0] ?? '';
		const refused = await env.dashboard(merchant, 'PUT', list(), { value: [] });
		expect(refused.status).toBe(403);
		expect((await env.dashboard(cookie, 'PUT', list(), { value: [] })).status).toBe(200);
		await env.switchOn(['whatsapp', 'email', 'sms', 'webhooks', 'send_api']);
		expect((await env.dashboard(merchant, 'PUT', list(), { value: [{ url: `${HOOKS}/all` }] })).status).toBe(200);
	});
});

describe('a test send of a saved template from the template editor (tickets)', () => {
	it('sends the template with sample values to the member of staff, logged as a staff message', async () => {
		const ticket = await env.ticket(['messages.send', 'templates.edit']);
		/** @param {unknown} body */
		const post = async (body) => {
			const response = await env.call('POST', '/v1/admin/messages', { token: ticket, origin: ADMIN_ORIGIN, body });
			return { status: response.status, json: await response.json() };
		};
		const sent = await post({
			channel: 'whatsapp',
			to: '+44 7700 900123',
			template: 'accounts.code',
			language: 'default',
			values: { code: '111222' },
		});
		expect(sent).toMatchObject({ status: 201, json: { status: 'sent', source: 'staff', template: 'accounts.code' } });
		expect(lastMeta().template.components[1]).toEqual({
			type: 'button',
			sub_type: 'url',
			index: '0',
			parameters: [{ type: 'text', text: '111222' }],
		});
		const activity = await (await env.call('GET', '/v1/activity?action=message.sent', { token: env.server })).json();
		expect(activity.items[0]).toMatchObject({
			actor: { kind: 'staff', id: 'u_1', name: 'Sam Staff' },
			detail: 'Template accounts.code by WhatsApp: sent',
		});
		for (const [body, path] of /** @type {const} */ ([
			[{ channel: 'whatsapp', to: '+447700900123', template: 'Bad Key' }, '/template'],
			[{ channel: 'whatsapp', to: '+447700900123', template: 'accounts.code', values: { 'a b': 1 } }, '/values'],
			[{ channel: 'whatsapp', to: '+447700900123', template: 'accounts.code', language: 'Klingon!' }, '/language'],
		])) {
			const refused = await post(body);
			expect(refused.status).toBe(422);
			expect(refused.json.errors[0].path).toBe(path);
		}
		const missing = await post({ channel: 'email', to: 'me@shop.example.com', template: 'nothing.here' });
		expect(missing.json.type).toMatch(/template_not_found$/);
	});
});
