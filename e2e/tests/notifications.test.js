/**
 * PLAN 0.12 step 6: Notifications against the REAL Portal — connect (manifest and price list), price and feature
 * reports, a send through the send API with the server token the Portal issued (the email provider is a fake in this
 * process: no real network call), the delivery log through a ticket, and the hourly charge for the switched-on
 * features. PLAN 0.8.10 phase 2: a WhatsApp template with a copy-code button and a per-status template with optional
 * sections, written by the merchant's server, are sent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProductInstance, manifest, strings } from '@ss/product-notifications/product';
import { createRoutes } from '@ss/product-notifications/routes';
import { HOUR, startSystem } from './helpers.js';

const URL_ = 'https://notifications.test';
const ADMIN_ORIGIN = 'https://admin.notify.example.com';

/** @type {Array<{ url: string, authorization: string | null, body: any }>} */
const sent = [];
/** The merchant's email provider (Resend), faked in process. @param {Request} request */
const resend = async (request) => {
	const body = request.method === 'POST' ? await request.json() : null;
	sent.push({ url: request.url, authorization: request.headers.get('authorization'), body });
	return Response.json({ id: `re_${sent.length}` });
};

/** @type {any[]} */
const whatsapp = [];
/** The merchant's WhatsApp Cloud API (Meta), faked in process: its account read and its sends. @param {Request} request */
const meta = async (request) => {
	if (request.method === 'POST') whatsapp.push(await request.json());
	return Response.json(request.method === 'POST' ? { messages: [{ id: `wamid.${whatsapp.length}` }] } : { id: '1234567890' });
};

/** @type {import('./helpers.js').System} */
let sys;
/** @type {Awaited<ReturnType<import('./helpers.js').System['merchant']>>} */
let m;
let websiteId = '';
beforeAll(async () => {
	sys = await startSystem({
		unit: {
			createProductInstance,
			createRoutes,
			manifest,
			strings,
			url: URL_,
			handlers: { 'https://api.resend.com': resend, 'https://graph.facebook.com': meta },
		},
	});
});
afterAll(async () => {
	await sys?.stop();
});

describe('Notifications on the real Portal', () => {
	it('connects: the Portal keeps its manifest and price list version 1, every feature at 0', async () => {
		const product = await sys.connect();
		expect(product).toMatchObject({ productId: 'notifications' });
		const page = await (await sys.owner()).get('/v1/admin/products/notifications');
		expect(page.json.priceListVersion).toBe(1);
		expect(page.json.features.map((/** @type {{ key: string }} */ f) => f.key)).toEqual(manifest.features.map((f) => f.key));
		expect(page.json.features.every((/** @type {{ millicreditsPerHour: number }} */ f) => f.millicreditsPerHour === 0)).toBe(
			true,
		);
		m = await sys.merchant('notify@shop.test', ['notify.example.com']);
		websiteId = m.websiteIds[0] ?? '';
		await sys.addProduct(m.merchantId, websiteId);
		await sys.addCredits(m.merchantId, 100);
	});

	it('an Owner prices features and a Support admin switches them on: both reports are accepted', async () => {
		const prices = await sys.setPrices({ email: 1000, send_api: 500 });
		expect(prices).toMatchObject({ version: 2 });
		const support = await sys.admin('support');
		const cookie = await sys.adminSession(support.client, websiteId);
		expect(await sys.switchFeatures(cookie, websiteId, ['email', 'send_api'])).toEqual({
			version: 1,
			on: ['email', 'send_api'],
		});
		const [entry] = await sys.activity('product.features_changed');
		expect(entry?.after).toMatchObject({ on: ['email', 'send_api'] });
	});

	it('sends through the send API with the Portal-issued server token and a fake provider', async () => {
		const cookie = await sys.adminSession(await sys.owner(), websiteId);
		await sys.connectDatabase(cookie, websiteId);
		const provider = await sys.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${websiteId}/connections/email`, {
			value: { provider: 'resend', secret: 're_live_key_0001', from: 'Shop <shop@notify.example.com>' },
		});
		expect(provider.json).toMatchObject({ status: 'connected', last4: '0001' });
		const template = await sys.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${websiteId}/templates`, {
			key: 'order_ready',
			channel: 'email',
			subject: 'Order {order} is ready',
			text: 'Hi {name}, order {order} is ready.',
			required: true,
		});
		expect(template.status).toBe(200);
		const { server } = await sys.tokens(m.merchantId, websiteId);
		const res = await sys.call('POST', '/v1/messages/email', {
			token: server,
			body: { template: 'order_ready', to: { email: 'buyer@example.com' }, values: { name: 'Ana', order: '1042' } },
		});
		expect(res.status).toBe(201);
		expect(res.json).toMatchObject({ status: 'sent', to: 'buyer@example.com', subject: 'Order 1042 is ready' });
		const call = sent.at(-1);
		expect(call?.url).toBe('https://api.resend.com/emails');
		expect(call?.authorization).toBe('Bearer re_live_key_0001');
		expect(call?.body).toMatchObject({ to: ['buyer@example.com'], text: 'Hi Ana, order 1042 is ready.' });

		// the merchant's staff read the delivery log in their own admin with a ticket
		const ticket = await sys.call('POST', '/v1/tickets', {
			token: server,
			body: {
				user: { id: 'u_1', name: 'Sam Staff', email: 'sam@notify.example.com' },
				permissions: ['log.read'],
				origin: ADMIN_ORIGIN,
			},
		});
		const log = await sys.call('GET', '/v1/admin/messages', { token: String(ticket.json.ticket), origin: ADMIN_ORIGIN });
		expect(log.json.items).toEqual([expect.objectContaining({ id: res.json.id, status: 'sent' })]);
		// counts equal the list's length, for the admin widget and the merchant's server (PLAN 0.8.10 K4)
		const counted = await sys.call('GET', '/v1/admin/messages/count', {
			token: String(ticket.json.ticket),
			origin: ADMIN_ORIGIN,
		});
		expect(counted.json).toEqual({ count: log.json.items.length, capped: false });
		const byChannel = await sys.call('GET', '/v1/messages/counts?by=channel', { token: server });
		expect(byChannel.json).toEqual({ total: 1, groups: { email: 1 } });
		// a feature that is off refuses its route
		const sms = await sys.call('POST', '/v1/messages/sms', {
			token: server,
			body: { template: 'order_ready', to: { phone: '+15550001111' } },
		});
		expect(sms.status).toBe(403);
	});

	it('the Portal charges the switched-on features every clock hour', async () => {
		const cards = await m.client.get(`/v1/merchants/${m.merchantId}/websites/${websiteId}/products`);
		expect(cards.json.items).toEqual([
			expect.objectContaining({
				productId: 'notifications',
				featuresOn: ['email', 'send_api'],
				hourlyCost: 1500,
				dailyCost: 36_000,
			}),
		]);
		const cookie = await sys.merchantSession(m, websiteId);
		const before = await sys.dashboard(cookie, 'GET', `/v1/dashboard/websites/${websiteId}/overview`);
		expect(before.json).toMatchObject({ featuresOn: ['email', 'send_api'], status: { status: 'active' } });
		sys.clock.advance(HOUR);
		const after = await sys.dashboard(cookie, 'GET', `/v1/dashboard/websites/${websiteId}/overview`);
		expect(after.json.todayMillicredits).toBe(before.json.todayMillicredits + 1500);
	});
	it('sends a WhatsApp template with a copy-code button and a per-status template with optional sections', async () => {
		const cookie = await sys.adminSession(await sys.owner(), websiteId);
		await sys.switchFeatures(cookie, websiteId, ['email', 'send_api', 'whatsapp']);
		const connected = await sys.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${websiteId}/connections/whatsapp`, {
			value: { provider: 'meta', phoneNumberId: '1234567890', secret: 'meta-token-0042' },
		});
		expect(connected.json).toMatchObject({ status: 'connected' });
		const { server } = await sys.tokens(m.merchantId, websiteId);
		const actor = { 'ss-actor-id': 'usr_1', 'ss-actor-name': encodeURIComponent('Alex Morgan') };
		// the merchant's server writes both templates (PLAN 0.8.10 N4)
		const code = await sys.call('PUT', '/v1/templates', {
			token: server,
			headers: actor,
			body: {
				key: 'accounts.code',
				channel: 'whatsapp',
				text: '{code} is your verification code.',
				providerTemplate: 'authentication',
				required: true,
				urgent: true,
				buttons: [{ index: 0, type: 'copy_code', value: '{code}' }],
			},
		});
		expect(code.status).toBe(200);
		const status = await sys.call('PUT', '/v1/templates', {
			token: server,
			headers: actor,
			body: {
				key: 'ecommerce.order_status',
				channel: 'email',
				subject: 'Order {order}: {status}',
				text: 'Your order {order} is {status}.{?tracking} Track it with {courier}: {tracking}.{/tracking}{?reason} Reason: {reason}.{/reason}',
				required: true,
			},
		});
		expect(status.status).toBe(200);

		const otp = await sys.call('POST', '/v1/messages/whatsapp', {
			token: server,
			body: { template: 'accounts.code', to: { phone: '+447700900123' }, values: { code: '482913' } },
		});
		// the answer and the log hide the code (N6, SE-3); the provider gets the real one
		expect(otp).toMatchObject({ status: 201, json: { status: 'sent', text: '****** is your verification code.' } });
		expect(whatsapp.at(-1)).toEqual({
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

		/** @param {Record<string, string>} values */
		const order = (values) =>
			sys.call('POST', '/v1/messages/email', {
				token: server,
				body: { template: 'ecommerce.order_status', to: { email: 'buyer@example.com' }, values },
			});
		const shipped = await order({ order: 'SH-2026-0043', status: 'shipped', courier: 'UPS', tracking: 'TRK9' });
		expect(shipped.json).toMatchObject({
			status: 'sent',
			subject: 'Order SH-2026-0043: shipped',
			text: 'Your order SH-2026-0043 is shipped. Track it with UPS: TRK9.',
		});
		const cancelled = await order({ order: 'SH-2026-0044', status: 'canceled', reason: 'Out of stock' });
		expect(cancelled.json.text).toBe('Your order SH-2026-0044 is canceled. Reason: Out of stock.');
		const confirmed = await order({ order: 'SH-2026-0045', status: 'confirmed', tracking: '' });
		expect(confirmed.json.text).toBe('Your order SH-2026-0045 is confirmed.');
		// the email provider got exactly those words
		expect(sent.at(-1)?.body).toMatchObject({ to: ['buyer@example.com'], text: 'Your order SH-2026-0045 is confirmed.' });
	});
});
