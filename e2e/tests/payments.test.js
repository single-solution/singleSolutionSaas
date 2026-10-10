/**
 * PLAN 0.12 step 9: Payments against the REAL Portal, with the real Notifications next to it — connect (manifest and
 * price list), price and feature reports, a payment link created with the Portal-issued server token, a payer paying it
 * through the hosted page on a faked Stripe (no real network call), the signed Stripe confirmation marking it paid, the
 * server-to-server check for the exact amount, a partial refund, the merchant notified through Notifications' signed
 * webhook, and the hourly charge.
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	createProductInstance as createNotifications,
	manifest as notifyManifest,
	strings as notifyStrings,
} from '@ss/product-notifications/product';
import { createRoutes as notifyRoutes } from '@ss/product-notifications/routes';
import { createProductInstance, manifest, strings } from '@ss/product-payments/product';
import { createRoutes } from '@ss/product-payments/routes';
import { HOUR, startSystem } from './helpers.js';

const PAYMENTS = 'https://payments.test';
const NOTIFY = 'https://notifications.test';
const HOOKS = 'https://hooks.pay.example.com';
const DOMAIN = 'pay.example.com';
const STRIPE_KEYS = { secretKey: 'sk_test_e2e0123456789', webhookSecret: 'whsec_e2e0123456789' };
const WEBHOOK_SECRET = 'merchant-webhook-secret-0123456789';

/** Calls the merchant's Stripe account received (faked in process). @type {Array<{ path: string, form: URLSearchParams }>} */
const stripeCalls = [];
/** Webhooks the merchant's server received from Notifications. @type {Array<{ body: string, signature: string | null }>} */
const hooks = [];

/** @param {Request} request */
const stripe = async (request) => {
	const url = new URL(request.url);
	const form = new URLSearchParams(request.method === 'POST' ? await request.text() : '');
	stripeCalls.push({ path: url.pathname, form });
	if (url.pathname === '/v1/checkout/sessions')
		return Response.json({
			id: `cs_${form.get('client_reference_id')}`,
			url: `https://checkout.stripe.com/c/${form.get('client_reference_id')}`,
		});
	if (url.pathname === '/v1/refunds') return Response.json({ id: `re_${stripeCalls.length}`, status: 'succeeded' });
	return Response.json({ object: 'balance' });
};
/** @param {Request} request */
const merchantHooks = async (request) => {
	hooks.push({ body: await request.text(), signature: request.headers.get('ss-signature') });
	return new Response(null, { status: 204 });
};

/** @type {import('./helpers.js').System} */
let sys;
/** @type {Awaited<ReturnType<import('./helpers.js').System['merchant']>>} */
let m;
let websiteId = '';
/** @type {{ browser: string, server: string }} */
let payTokens;
/** @type {{ browser: string, server: string }} */
let notifyTokens;
let linkId = '';
let paymentId = '';

beforeAll(async () => {
	sys = await startSystem({
		unit: {
			createProductInstance,
			createRoutes,
			manifest,
			strings,
			url: PAYMENTS,
			handlers: { 'https://api.stripe.com': stripe, [HOOKS]: merchantHooks },
		},
		extras: [
			{
				createProductInstance: createNotifications,
				createRoutes: notifyRoutes,
				manifest: notifyManifest,
				strings: notifyStrings,
				url: NOTIFY,
			},
		],
	});
});
afterAll(async () => {
	await sys?.stop();
});

describe('Payments on the real Portal', () => {
	it('connects: the Portal keeps its manifest and price list version 1, every feature at 0', async () => {
		expect(await sys.connect()).toMatchObject({ productId: 'payments' });
		await sys.connect({ base: NOTIFY });
		const page = await (await sys.owner()).get('/v1/admin/products/payments');
		expect(page.json.priceListVersion).toBe(1);
		expect(page.json.features.map((/** @type {{ key: string }} */ f) => f.key)).toEqual(manifest.features.map((f) => f.key));
		expect(page.json.features.every((/** @type {{ millicreditsPerHour: number }} */ f) => f.millicreditsPerHour === 0)).toBe(
			true,
		);
		m = await sys.merchant('pay@shop.test', [DOMAIN]);
		websiteId = m.websiteIds[0] ?? '';
		for (const id of ['payments', 'notifications']) await sys.addProduct(m.merchantId, websiteId, id);
		await sys.addCredits(m.merchantId, 100);
		payTokens = await sys.tokens(m.merchantId, websiteId, 'payments');
		notifyTokens = await sys.tokens(m.merchantId, websiteId, 'notifications');
	});

	it('an Owner prices features and a Support admin switches them on: both reports are accepted', async () => {
		expect(await sys.setPrices({ stripe: 1000, payment_links: 500 })).toMatchObject({ version: 2 });
		const support = await sys.admin('support');
		const cookie = await sys.adminSession(support.client, websiteId);
		const on = ['payment_api', 'payment_links', 'refunds', 'stripe'];
		const report = await sys.switchFeatures(cookie, websiteId, on);
		expect(report.version).toBe(1);
		expect([...report.on].sort()).toEqual(on);
		const [entry] = await sys.activity('product.features_changed');
		expect(entry?.after).toMatchObject({ on });
	});

	it('sets up Stripe with the merchant’s keys and Notifications’ signed webhooks', async () => {
		const cookie = await sys.adminSession(await sys.owner(), websiteId);
		await sys.connectDatabase(cookie, websiteId);
		const keys = await sys.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${websiteId}/connections/stripe`, {
			value: STRIPE_KEYS,
		});
		expect(keys.json).toMatchObject({ status: 'connected', last4: '6789' });
		const notifyCookie = await sys.adminSession(await sys.owner(), websiteId, 'notifications');
		expect(
			(await sys.dashboard(notifyCookie, 'PUT', `/v1/dashboard/websites/${websiteId}/features`, { on: ['webhooks'] }, NOTIFY))
				.status,
		).toBe(200);
		await sys.connectDatabase(notifyCookie, websiteId, NOTIFY);
		const secret = await sys.dashboard(
			notifyCookie,
			'PUT',
			`/v1/dashboard/websites/${websiteId}/connections/webhook_secret`,
			{ value: WEBHOOK_SECRET },
			NOTIFY,
		);
		expect(secret.json).toMatchObject({ status: 'connected' });
		const urls = await sys.dashboard(
			notifyCookie,
			'PUT',
			`/v1/dashboard/websites/${websiteId}/settings/webhooks.urls`,
			{ value: [`${HOOKS}/payments`] },
			NOTIFY,
		);
		expect(urls.status).toBe(204);
		const pasted = await sys.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${websiteId}/connections/notifications`, {
			value: notifyTokens.server,
		});
		expect(pasted.json).toMatchObject({ status: 'connected' });
	});

	it('creates a payment link with the Portal-issued server token; the payer pays it on Stripe', async () => {
		const link = await sys.call('POST', '/v1/links', {
			token: payTokens.server,
			body: { title: 'Invoice 42', currency: 'USD', amount: 12_000, reference: 'inv-42' },
		});
		expect(link.status).toBe(201);
		linkId = link.json.id;
		expect(link.json.url).toBe(`${PAYMENTS}/l/${websiteId}/${linkId}`);
		// a server token never works from a browser
		expect((await sys.call('GET', '/v1/links', { token: payTokens.server, origin: `https://${DOMAIN}` })).status).toBe(401);

		const pageView = await sys.call('GET', `/l/${websiteId}/${linkId}`);
		expect(pageView.json).toContain('USD 120.00');
		const missing = await sys.call('POST', `/l/${websiteId}/${linkId}`, { form: { name: 'Ana' } });
		expect(missing.status).toBe(422);
		const form = await sys.call('POST', `/l/${websiteId}/${linkId}`, {
			form: { gateway: 'stripe', name: 'Ana', email: 'ana@example.com' },
		});
		expect(form.status).toBe(303);
		paymentId = /pay_[A-Za-z0-9]+/.exec(form.headers.get('location') ?? '')?.[0] ?? '';
		const go = await sys.call('GET', `/pay/${websiteId}/${paymentId}`);
		expect(go.status).toBe(303);
		expect(go.headers.get('location')).toBe(`https://checkout.stripe.com/c/${paymentId}`);
		const session = stripeCalls.find((c) => c.path === '/v1/checkout/sessions');
		expect(session?.form.get('line_items[0][price_data][unit_amount]')).toBe('12000');
		expect(session?.form.get('success_url')).toBe(`${PAYMENTS}/return/stripe/${websiteId}/${paymentId}`);
	});

	it('Stripe’s signed confirmation marks it paid; the merchant’s server verifies the exact amount', async () => {
		const before = await sys.call('POST', `/v1/payments/${paymentId}/verify`, {
			token: payTokens.server,
			body: { amount: 12_000, currency: 'USD' },
		});
		expect(before.json.verified).toBe(false);
		const event = JSON.stringify({
			type: 'checkout.session.completed',
			data: {
				object: {
					id: `cs_${paymentId}`,
					client_reference_id: paymentId,
					payment_status: 'paid',
					amount_total: 12_000,
					currency: 'usd',
					payment_intent: 'pi_e2e',
				},
			},
		});
		const t = Math.floor(sys.clock.now() / 1000);
		const signature = `t=${t},v1=${createHmac('sha256', STRIPE_KEYS.webhookSecret).update(`${t}.${event}`).digest('hex')}`;
		const forged = await sys.call('POST', `/v1/gateways/stripe/${websiteId}`, {
			body: event,
			headers: { 'stripe-signature': `t=${t},v1=00` },
		});
		expect(forged.status).toBe(401);
		const notice = await sys.call('POST', `/v1/gateways/stripe/${websiteId}`, {
			body: event,
			headers: { 'stripe-signature': signature },
		});
		expect(notice.json).toEqual({ received: true });
		const verified = await sys.call('POST', `/v1/payments/${paymentId}/verify`, {
			token: payTokens.server,
			body: { amount: 12_000, currency: 'USD' },
		});
		expect(verified.json).toMatchObject({ verified: true, payment: { status: 'paid', linkId, gateway: 'stripe' } });
		const other = await sys.call('POST', `/v1/payments/${paymentId}/verify`, {
			token: payTokens.server,
			body: { amount: 11_999, currency: 'USD' },
		});
		expect(other.json.verified).toBe(false);
	});

	it('the merchant is notified through Notifications with a signed webhook', async () => {
		const paid = hooks.find((hook) => JSON.parse(hook.body).type === 'payments.payment.paid');
		expect(paid).toBeTruthy();
		const body = JSON.parse(paid?.body ?? '{}');
		expect(body).toMatchObject({ websiteId, data: { payment: { id: paymentId, status: 'paid', amount: 12_000 } } });
		const parts = Object.fromEntries((paid?.signature ?? '').split(',').map((part) => part.split('=')));
		expect(createHmac('sha256', WEBHOOK_SECRET).update(`${parts.t}.${paid?.body}`).digest('hex')).toBe(parts.v1);
		const events = await sys.call('GET', '/v1/events', { token: payTokens.server });
		expect(events.json.items).toEqual([expect.objectContaining({ type: 'payments.payment.paid', delivery: 'sent' })]);
		// the kit's event (PLAN 0.8.10 K5), forwarded by Notifications with its own id and time
		expect(body).toMatchObject({ id: events.json.items[0].id, createdAt: events.json.items[0].at });
		expect((await sys.call('GET', '/v1/events/count', { token: payTokens.server })).json).toEqual({ count: 1, capped: false });
	});

	it('refunds part of it on Stripe and tells the merchant', async () => {
		const refund = await sys.call('POST', `/v1/payments/${paymentId}/refunds`, {
			token: payTokens.server,
			body: { amount: 2000, reason: 'Discount' },
			headers: { 'idempotency-key': 'refund-inv-42-1' },
		});
		expect(refund.status).toBe(201);
		expect(refund.json).toMatchObject({ status: 'partially_refunded', refunded: 2000 });
		const call = stripeCalls.find((c) => c.path === '/v1/refunds');
		expect([call?.form.get('payment_intent'), call?.form.get('amount')]).toEqual(['pi_e2e', '2000']);
		const notified = hooks.map((hook) => JSON.parse(hook.body)).find((hook) => hook.type === 'payments.payment.refunded');
		expect(notified?.data).toMatchObject({ refund: { amount: 2000 }, payment: { refunded: 2000 } });
		// the payment still counts as paid for the order's exact amount
		const verified = await sys.call('POST', `/v1/payments/${paymentId}/verify`, {
			token: payTokens.server,
			body: { amount: 12_000, currency: 'USD' },
		});
		expect(verified.json.verified).toBe(true);
	});

	it('counts equal list lengths, and a refund names the member of staff the merchant’s server acts for', async () => {
		const list = await sys.call('GET', '/v1/payments?limit=100', { token: payTokens.server });
		const count = await sys.call('GET', '/v1/payments/count', { token: payTokens.server });
		expect(count.json).toEqual({ count: list.json.items.length, capped: false });
		const byState = await sys.call('GET', '/v1/payments/counts?by=state', { token: payTokens.server });
		expect(byState.json).toEqual({ total: list.json.items.length, groups: { partially_refunded: 1 } });
		const refund = await sys.call('POST', `/v1/payments/${paymentId}/refunds`, {
			token: payTokens.server,
			body: { amount: 1000, reason: 'Goodwill' },
			headers: {
				'idempotency-key': 'refund-inv-42-2',
				'ss-actor-id': 'usr_finance_1',
				'ss-actor-name': 'Hina%20Malik',
				'ss-actor-role': 'Finance',
			},
		});
		expect(refund.json.refunds.at(-1)).toMatchObject({ amount: 1000, by: 'Hina Malik' });
		const activity = await sys.call('GET', `/v1/activity?target=${paymentId}&action=payment.refunded`, {
			token: payTokens.server,
		});
		expect(activity.json.items[0]).toMatchObject({
			actor: { kind: 'user', id: 'usr_finance_1', name: 'Hina Malik', role: 'Finance' },
			label: 'inv-42',
		});
	});

	it('data rights: the export with the server token finds the payer’s payment', async () => {
		const exported = await sys.call('POST', '/v1/data-rights/export', {
			token: payTokens.server,
			body: { user: { email: 'ana@example.com' } },
		});
		expect(exported.json.records.payments).toEqual([expect.objectContaining({ id: paymentId, amount: 12_000 })]);
	});

	it('the Portal charges the switched-on features every clock hour', async () => {
		const cards = await m.client.get(`/v1/merchants/${m.merchantId}/websites/${websiteId}/products`);
		expect(cards.json.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					productId: 'payments',
					hourlyCost: 1500,
					dailyCost: 36_000,
				}),
			]),
		);
		const cookie = await sys.merchantSession(m, websiteId);
		const before = await sys.dashboard(cookie, 'GET', `/v1/dashboard/websites/${websiteId}/overview`);
		expect(before.json).toMatchObject({ status: { status: 'active' } });
		sys.clock.advance(HOUR);
		const after = await sys.dashboard(cookie, 'GET', `/v1/dashboard/websites/${websiteId}/overview`);
		expect(after.json.todayMillicredits).toBe(before.json.todayMillicredits + 1500);
	});
});
