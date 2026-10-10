/**
 * Notifications for converting existing stores (PLAN 0.8.10 N1–N5): WhatsApp template buttons, optional sections,
 * the long retry plan, the template routes for the merchant's server and webhook URLs per event.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup } from './helpers.js';

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
			to: { phone: '+923001234567' },
			values: { code: '482913' },
		});
		expect(sent).toMatchObject({ status: 201, json: { status: 'sent', text: '482913 is your verification code.' } });
		expect(lastMeta()).toEqual({
			messaging_product: 'whatsapp',
			to: '923001234567',
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
			to: { phone: '+923001112222' },
			values: { order: 'IM-2026-0043' },
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
			to: { phone: '+923001112222' },
			values: { order: 'IM-2026-0044' },
		});
		expect(short.json.status).toBe('sent');
	});
});
