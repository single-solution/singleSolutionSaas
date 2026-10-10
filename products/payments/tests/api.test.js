import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formSignature } from '../adapters/gateways/payfast.js';
import { secureHash } from '../adapters/gateways/jazzcash.js';
import { validationHash } from '../adapters/gateways/payfast-pk.js';
import { webhookSignature } from '../adapters/gateways/rapid.js';
import { signTimestamped } from '../adapters/util.js';
import { ADMIN_ORIGIN, ALL, BASE, BUCKET, DOMAIN, NOTIFY_BASE, ORIGIN, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let env;

const STRIPE = { secretKey: 'sk_test_abcdefghijkl', webhookSecret: 'whsec_abcdefghijkl' };
const PAYPAL = { clientId: 'client', secret: 'paypal-secret', webhookId: 'WH-1', sandbox: false };
const PAYFAST = { merchantId: '10000100', merchantKey: '46f0cd694581a', passphrase: 'jt7NOE43FZPn', sandbox: false };
const JAZZCASH = { merchantId: 'MC123', password: 'pass', integritySalt: 'salt123', sandbox: false };
const EASYPAISA = {
	storeId: '12345',
	hashKey: '0123456789ABCDEF',
	username: 'user',
	password: 'pw',
	accountNum: '987',
	sandbox: false,
};
const PAYFAST_PK = { merchantId: '102', securedKey: 'secured-key-0123', merchantName: 'Shop Ltd', sandbox: false };
const RAPID = { secretKey: 'rg_sk_live_0123', webhookSecret: 'rg_whsec_4567', sandbox: false };
const GENERIC = { name: 'PayNow', url: 'https://gateway.example.org/checkout', secret: 'g'.repeat(32) };
const STORAGE = {
	endpoint: BUCKET,
	region: 'auto',
	bucket: 'proofs',
	accessKeyId: 'AKIDTEST',
	secretAccessKey: 'secret-test-key-0123',
};
const RETURN = `${ORIGIN}/thanks`;

/** Events Notifications received (`POST /v1/events`). @type {any[]} */
const events = [];
/** Answer of the fake Notifications. */
let notifyStatus = 202;

/** @param {string} path */
const page = (path) => env.call('GET', path);

/** @param {Record<string, unknown>} body @param {Record<string, string>} [headers] */
const createPayment = async (body, headers) => {
	const res = await env.api('POST', '/v1/payments', { amount: 250000, currency: 'PKR', returnUrl: RETURN, ...body }, headers);
	if (res.status !== 201) throw new Error(`payment ${res.status} ${res.text}`);
	return res.json;
};

/** @param {object} event */
const stripeHook = (event) => {
	const body = JSON.stringify(event);
	return env.call('POST', `/v1/gateways/stripe/${env.websiteId}`, {
		body,
		headers: { 'stripe-signature': signTimestamped(body, STRIPE.webhookSecret, env.now()) },
	});
};

/** @param {string} id @param {number} amount @param {string} [currency] */
const stripePaid = (id, amount, currency = 'pkr') =>
	stripeHook({
		type: 'checkout.session.completed',
		data: {
			object: {
				id: `cs_${id}`,
				client_reference_id: id,
				payment_status: 'paid',
				amount_total: amount,
				currency,
				payment_intent: `pi_${id}`,
			},
		},
	});

/** Stripe answers by path. */
const stripeAnswers = () =>
	env.gateways.respond('https://api.stripe.com', (c) => {
		if (c.path === '/v1/checkout/sessions' && c.method === 'POST') {
			const form = new URLSearchParams(c.body);
			const id = form.get('client_reference_id');
			return { status: 200, body: { id: `cs_${id}`, url: `https://checkout.stripe.com/c/${id}` } };
		}
		if (c.path === '/v1/refunds') return { status: 200, body: { id: `re_${env.gateways.calls.length}`, status: 'succeeded' } };
		if (c.path.startsWith('/v1/subscriptions/')) return { status: 200, body: { status: 'canceled' } };
		return { status: 200, body: {} };
	});

beforeAll(async () => {
	env = await setup();
	env.gateways.respond(NOTIFY_BASE, (c) => {
		events.push({ ...JSON.parse(c.body), authorization: c.headers.authorization, key: c.headers['idempotency-key'] });
		return { status: notifyStatus, body: { queued: 1 } };
	});
});
afterAll(async () => {
	await env.product.close();
});

describe('before setup', () => {
	it('refuses while the feature is off and until the merchant database is connected', async () => {
		const off = await env.api('POST', '/v1/payments', { amount: 100, currency: 'PKR' });
		expect(off.status).toBe(403);
		expect(off.json.type).toMatch(/feature_off$/);
		await env.switchOn(ALL);
		const noDb = await env.api('POST', '/v1/payments', { amount: 100, currency: 'PKR' });
		expect(noDb.json.type).toMatch(/database_not_connected$/);
		await env.connectDatabase();
		const noGateway = await env.api('POST', '/v1/payments', { amount: 100, currency: 'PKR' });
		expect(noGateway.status).toBe(422);
		expect(noGateway.json.type).toMatch(/gateway_not_ready$/);
	});

	it('tests each gateway connection when it is saved', async () => {
		env.gateways.respond('https://api.stripe.com', () => ({ status: 401 }));
		expect(await env.connect('stripe', STRIPE)).toMatchObject({ status: 'test_failed' });
		expect(await env.connect('stripe', { secretKey: 'nope' })).toMatchObject({ status: 'test_failed' });
		stripeAnswers();
		expect(await env.connect('stripe', STRIPE)).toMatchObject({ status: 'connected', last4: 'ijkl' });
		env.gateways.respond('https://api-m.paypal.com', (c) =>
			c.path === '/v1/oauth2/token' ? { status: 200, body: { access_token: 'tok' } } : { status: 404 },
		);
		expect(await env.connect('paypal', PAYPAL)).toMatchObject({ status: 'connected' });
		expect(await env.connect('payfast', PAYFAST)).toMatchObject({ status: 'connected' });
		expect(await env.connect('jazzcash', JAZZCASH)).toMatchObject({ status: 'connected' });
		expect(await env.connect('easypaisa', EASYPAISA)).toMatchObject({ status: 'connected' });
		expect(await env.connect('generic', GENERIC)).toMatchObject({ status: 'connected' });
		expect(await env.connect('storage', STORAGE)).toMatchObject({ status: 'connected' });
		expect(await env.connect('notifications', env.notificationsToken)).toMatchObject({ status: 'connected' });
		await env.setting('bank_transfer', 'accountNumber', '0123-456789');
		await env.setting('bank_transfer', 'accountTitle', 'Shop Ltd');
	});
});

describe('the payment API and Stripe', () => {
	it('checks a new payment against the website and the gateways', async () => {
		const elsewhere = await env.api('POST', '/v1/payments', {
			amount: 100,
			currency: 'PKR',
			returnUrl: 'https://evil.example.net/x',
		});
		expect(elsewhere.status).toBe(422);
		expect(elsewhere.json.errors[0].path).toBe('/returnUrl');
		const local = await env.api('POST', '/v1/payments', { amount: 100, currency: 'PKR', returnUrl: 'http://localhost:3000/x' });
		expect(local.status).toBe(201);
		const wrong = await env.api('POST', '/v1/payments', { amount: 100, currency: 'USD', gateway: 'jazzcash' });
		expect(wrong.json.type).toMatch(/currency_not_supported$/);
		const notReady = await env.api('POST', '/v1/payments', {
			amount: 100,
			currency: 'ZAR',
			gateway: 'payfast',
			cancelUrl: 'x',
		});
		expect(notReady.status).toBe(422);
		const bad = await env.api('POST', '/v1/payments', { amount: 1.5, currency: 'PKR' });
		expect(bad.json.errors[0].path).toBe('/amount');
		const none = await env.api('POST', '/v1/payments', { amount: 100, currency: 'ZZZ', gateway: 'paypal' });
		expect(none.json.type).toMatch(/currency_not_supported$/);
	});

	it('takes a payment on Stripe: choice, redirect, signed webhook, events through Notifications', async () => {
		const payment = await createPayment(
			{ description: 'Order 1042', reference: 'order-1042', customer: { email: 'Ana@Example.com' } },
			{ 'idempotency-key': 'o-1042' },
		);
		expect(payment).toMatchObject({
			status: 'pending',
			gateway: null,
			amountText: '2500.00',
			checkoutUrl: `${BASE}/pay/${env.websiteId}/${payment.id}`,
		});
		const again = await env.api('POST', '/v1/payments', { amount: 250000, currency: 'PKR' }, { 'idempotency-key': 'o-1042' });
		expect(again.status).toBe(409);

		const choice = await page(`/pay/${env.websiteId}/${payment.id}`);
		expect(choice.status).toBe(200);
		expect(choice.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
		for (const name of ['Card (Stripe)', 'JazzCash', 'Easypaisa', 'Bank transfer', 'PayNow'])
			expect(choice.text).toContain(name);
		expect(choice.text).not.toContain('PayPal');
		expect(choice.text).not.toContain('PayFast');

		const picked = await env.call('POST', `/pay/${env.websiteId}/${payment.id}`, { form: { gateway: 'stripe' } });
		expect(picked.status).toBe(303);
		const go = await page(`/pay/${env.websiteId}/${payment.id}`);
		expect(go.status).toBe(303);
		expect(go.headers.get('location')).toBe(`https://checkout.stripe.com/c/${payment.id}`);
		// another gateway cannot take over a started checkout
		await env.call('POST', `/pay/${env.websiteId}/${payment.id}`, { form: { gateway: 'jazzcash' } });
		expect((await env.api('GET', `/v1/payments/${payment.id}`)).json.gateway).toBe('stripe');

		const forged = await env.call('POST', `/v1/gateways/stripe/${env.websiteId}`, {
			body: '{}',
			headers: { 'stripe-signature': 't=1,v1=x' },
		});
		expect(forged.status).toBe(401);
		expect((await stripePaid(payment.id, 250000)).json).toEqual({ received: true });
		const paid = await env.api('GET', `/v1/payments/${payment.id}`);
		expect(paid.json).toMatchObject({
			status: 'paid',
			gatewayReference: `cs_${payment.id}`,
			customer: { email: 'ana@example.com' },
		});
		// a second confirmation changes nothing
		await stripePaid(payment.id, 250000);
		const sent = events.filter((e) => e.type === 'payments.payment.paid');
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			authorization: `Bearer ${env.notificationsToken}`,
			data: { payment: { id: payment.id, status: 'paid' } },
		});
		expect(sent[0].key).toMatch(/^evt_/);
		// the kit's event: its id is the Idempotency-Key, `at` its time
		expect(sent[0]).toMatchObject({ id: sent[0].key, at: new Date(env.now()).toISOString() });

		const result = await page(`/pay/${env.websiteId}/${payment.id}`);
		expect(result.text).toContain('Payment received');
		expect(result.text).toContain(`${RETURN}?ss_payment=${payment.id}`);
	});

	it('verifies a payment only for its exact amount and currency', async () => {
		const [first] = (await env.api('GET', '/v1/payments?status=paid')).json.items;
		const ok = await env.api('POST', `/v1/payments/${first.id}/verify`, { amount: 250000, currency: 'PKR' });
		expect(ok.json).toMatchObject({ verified: true, payment: { id: first.id } });
		const wrong = await env.api('POST', `/v1/payments/${first.id}/verify`, { amount: 250001, currency: 'PKR' });
		expect(wrong.json.verified).toBe(false);
		expect((await env.api('POST', '/v1/payments/pay_nope/verify', {})).status).toBe(404);
		expect((await env.api('GET', `/v1/payments/${first.id.replace('pay_', 'pay_0')}`)).status).toBe(404);
	});

	it('records a confirmation for another amount without marking it paid', async () => {
		const payment = await createPayment({ gateway: 'stripe' });
		await page(`/pay/${env.websiteId}/${payment.id}`);
		await stripePaid(payment.id, 1);
		const after = (await env.api('GET', `/v1/payments/${payment.id}`)).json;
		expect(after.status).toBe('pending');
		expect(after.history.map((/** @type {any} */ e) => e.event)).toContain('mismatch');
		// a failed async payment
		await stripeHook({
			type: 'checkout.session.async_payment_failed',
			data: { object: { id: `cs_${payment.id}`, client_reference_id: payment.id, payment_status: 'unpaid' } },
		});
		expect((await env.api('GET', `/v1/payments/${payment.id}`)).json.status).toBe('failed');
		expect(events.at(-1)?.type).toBe('payments.payment.failed');
		const retry = await page(`/pay/${env.websiteId}/${payment.id}`);
		expect(retry.text).toContain('Try again');
		await env.call('POST', `/pay/${env.websiteId}/${payment.id}`, { form: { retry: '1' } });
		expect((await page(`/pay/${env.websiteId}/${payment.id}`)).text).toContain('Choose how to pay');
	});

	it('rechecks a pending payment with the gateway when it is read', async () => {
		const payment = await createPayment({ gateway: 'stripe' });
		await page(`/pay/${env.websiteId}/${payment.id}`);
		env.gateways.respond('https://api.stripe.com', (c) =>
			c.method === 'GET' && c.path.startsWith('/v1/checkout/sessions/')
				? {
						status: 200,
						body: {
							id: `cs_${payment.id}`,
							client_reference_id: payment.id,
							payment_status: 'paid',
							amount_total: 250000,
							currency: 'pkr',
							payment_intent: 'pi_r',
						},
					}
				: { status: 200, body: {} },
		);
		expect((await env.api('GET', `/v1/payments/${payment.id}`)).json.status).toBe('pending');
		env.advance(31_000);
		expect((await env.api('GET', `/v1/payments/${payment.id}`)).json.status).toBe('paid');
		stripeAnswers();
	});

	it('refunds part, then the rest, and never more', async () => {
		const [payment] = (await env.api('GET', '/v1/payments?status=paid&q=order-1042')).json.items;
		const pending = await createPayment({});
		const notPaid = await env.api('POST', `/v1/payments/${pending.id}/refunds`, {});
		expect(notPaid.json.type).toMatch(/not_refundable$/);
		const part = await env.api(
			'POST',
			`/v1/payments/${payment.id}/refunds`,
			{ amount: 50000, reason: 'One item returned' },
			{ 'idempotency-key': 'r-1' },
		);
		expect(part.status).toBe(201);
		expect(part.json).toMatchObject({
			status: 'partially_refunded',
			refunded: 50000,
			refunds: [{ amount: 50000, reason: 'One item returned', manual: false, by: 'Server' }],
		});
		const call = env.gateways.callsTo('https://api.stripe.com').at(-1);
		const form = new URLSearchParams(call?.body);
		expect([form.get('payment_intent'), form.get('amount')]).toEqual([`pi_${payment.id}`, '50000']);
		const tooMuch = await env.api('POST', `/v1/payments/${payment.id}/refunds`, { amount: 200001 });
		expect(tooMuch.status).toBe(422);
		const rest = await env.api('POST', `/v1/payments/${payment.id}/refunds`, {});
		expect(rest.json).toMatchObject({ status: 'refunded', refunded: 250000 });
		expect(events.filter((e) => e.type === 'payments.payment.refunded')).toHaveLength(2);
		env.gateways.respond('https://api.stripe.com', () => ({ status: 402, body: { error: { message: 'Declined' } } }));
		const other = await createPayment({ gateway: 'stripe' });
		await stripePaid(other.id, 250000);
		const refused = await env.api('POST', `/v1/payments/${other.id}/refunds`, { amount: 1 });
		expect(refused.status).toBe(502);
		expect(refused.json.detail).toBe('Declined');
		stripeAnswers();
		expect((await page(`/pay/${env.websiteId}/${payment.id}`)).text).toContain('This payment was refunded');
	});

	it('lists payments and events', async () => {
		const first = await env.api('GET', '/v1/payments?limit=2');
		expect(first.json.items).toHaveLength(2);
		const next = await env.api('GET', `/v1/payments?limit=2&cursor=${first.json.nextCursor}`);
		expect(next.json.items[0].id).not.toBe(first.json.items[0].id);
		expect((await env.api('GET', '/v1/payments?q=ana@example.com')).json.items).toHaveLength(1);
		const list = await env.api('GET', '/v1/events?limit=50');
		expect(list.json.items.length).toBeGreaterThan(3);
		expect(list.json.items.every((/** @type {any} */ e) => e.delivery === 'sent' && e.type.startsWith('payments.'))).toBe(true);
		expect(Object.keys(list.json.items[0]).sort()).toEqual(['at', 'data', 'delivery', 'id', 'type']);
	});

	it('retries a due event after a public page too, as after a token request', async () => {
		notifyStatus = 500;
		const payment = await createPayment({ gateway: 'stripe' });
		await stripePaid(payment.id, 250000);
		const forwarded = () =>
			events.filter((/** @type {any} */ e) => e.type === 'payments.payment.paid' && e.data.payment.id === payment.id).length;
		// one refused attempt so far (the fake Notifications records every attempt)
		expect(forwarded()).toBe(1);
		notifyStatus = 202;
		env.advance(61_000);
		// the payer's page: no token, but the event that is due goes out right after it
		expect((await page(`/pay/${env.websiteId}/${payment.id}`)).status).toBe(200);
		expect(forwarded()).toBe(2);
	});

	it('retries an event Notifications did not take, and keeps it when the token is removed', async () => {
		/** The delivery of a payment's paid event. @param {string} id */
		const delivery = async (id) =>
			(await env.api('GET', '/v1/events?limit=100')).json.items.find(
				(/** @type {any} */ e) => e.type === 'payments.payment.paid' && e.data.payment.id === id,
			)?.delivery;
		notifyStatus = 500;
		const payment = await createPayment({ gateway: 'stripe' });
		await stripePaid(payment.id, 250000);
		expect(await delivery(payment.id)).toBe('pending');
		notifyStatus = 202;
		env.advance(61_000);
		await env.api('GET', '/v1/links');
		expect(await delivery(payment.id)).toBe('sent');
		notifyStatus = 409;
		const dup = await createPayment({ gateway: 'stripe' });
		await stripePaid(dup.id, 250000);
		expect(await delivery(dup.id)).toBe('sent');
		notifyStatus = 500;
		const lost = await createPayment({ gateway: 'stripe' });
		await stripePaid(lost.id, 250000);
		for (const wait of [60_000, 300_000, 1_800_000, 7_200_000]) {
			env.advance(wait + 1000);
			await env.api('GET', '/v1/links');
		}
		expect(await delivery(lost.id)).toBe('failed');
		notifyStatus = 202;
		await env.dashboard(
			await env.adminSession(),
			'DELETE',
			`/v1/dashboard/websites/${env.websiteId}/connections/notifications`,
		);
		const quiet = await createPayment({ gateway: 'stripe' });
		await stripePaid(quiet.id, 250000);
		expect(await delivery(quiet.id)).toBe('not_connected');
		await env.connect('notifications', env.notificationsToken);
	});
});

describe('the other gateways', () => {
	it('JazzCash: signed form, signed answer on the return address', async () => {
		const payment = await createPayment({ gateway: 'jazzcash', reference: 'inv 7' });
		const form = await page(`/pay/${env.websiteId}/${payment.id}`);
		expect(form.text).toContain('payments.jazzcash.com.pk');
		expect(form.text).toContain('/pay.js');
		const ref = /name="pp_TxnRefNo" value="([^"]+)"/.exec(form.text)?.[1] ?? '';
		/** @type {Record<string, string>} */
		const answer = { pp_TxnRefNo: ref, pp_Amount: '250000', pp_TxnCurrency: 'PKR', pp_ResponseCode: '000' };
		const back = await env.call('POST', `/return/jazzcash/${env.websiteId}/${payment.id}`, {
			form: { ...answer, pp_SecureHash: secureHash(answer, JAZZCASH.integritySalt) },
		});
		expect(back.status).toBe(303);
		expect(back.headers.get('location')).toBe(`${RETURN}?ss_payment=${payment.id}`);
		// the payer's return is a public page: its paid event is forwarded right after it all the same
		expect(
			events.find((/** @type {any} */ e) => e.type === 'payments.payment.paid' && e.data.payment.id === payment.id),
		).toBeTruthy();
		expect((await env.api('GET', `/v1/payments/${payment.id}`)).json.status).toBe('paid');
		const refund = await env.api('POST', `/v1/payments/${payment.id}/refunds`, { amount: 1000 });
		expect(refund.json.refunds[0]).toMatchObject({ manual: true, amount: 1000 });
	});

	it('Easypaisa: token step, then Payments asks Easypay', async () => {
		const payment = await createPayment({ gateway: 'easypaisa', returnUrl: undefined });
		const form = await page(`/pay/${env.websiteId}/${payment.id}`);
		expect(form.text).toContain('easypay.easypaisa.com.pk/easypay/Index.jsf');
		const step = await page(`/return/easypaisa/${env.websiteId}/${payment.id}?auth_token=abc`);
		expect(step.text).toContain('Confirm.jsf');
		expect(step.text).toContain(`${BASE}/return/easypaisa/${env.websiteId}/${payment.id}`);
		env.gateways.respond('https://easypay.easypaisa.com.pk', () => ({
			status: 200,
			body: { responseCode: '0000', transactionStatus: 'PAID', transactionAmount: '2500.00' },
		}));
		const back = await page(`/return/easypaisa/${env.websiteId}/${payment.id}?status=0000`);
		expect(back.headers.get('location')).toBe(`/pay/${env.websiteId}/${payment.id}`);
		expect((await env.api('GET', `/v1/payments/${payment.id}`)).json.status).toBe('paid');
	});

	it('PayPal: approve, capture when the payer returns, refund the capture', async () => {
		env.gateways.respond('https://api-m.paypal.com', (c) => {
			if (c.path === '/v1/oauth2/token') return { status: 200, body: { access_token: 'tok' } };
			if (c.path === '/v2/checkout/orders')
				return { status: 201, body: { id: 'ORD1', links: [{ rel: 'payer-action', href: 'https://paypal.test/a' }] } };
			if (c.path === '/v2/checkout/orders/ORD1') return { status: 200, body: { id: 'ORD1', status: 'APPROVED' } };
			if (c.path === '/v2/checkout/orders/ORD1/capture')
				return {
					status: 201,
					body: {
						id: 'ORD1',
						status: 'COMPLETED',
						purchase_units: [
							{
								payments: {
									captures: [{ id: 'CAP1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '25.00' } }],
								},
							},
						],
					},
				};
			if (c.path.endsWith('/refund')) return { status: 201, body: { id: 'REF1', status: 'COMPLETED' } };
			return { status: 404 };
		});
		const payment = await createPayment({ amount: 2500, currency: 'USD', gateway: 'paypal', cancelUrl: `${ORIGIN}/cart` });
		const go = await page(`/pay/${env.websiteId}/${payment.id}`);
		expect(go.headers.get('location')).toBe('https://paypal.test/a');
		await page(`/return/paypal/${env.websiteId}/${payment.id}?token=ORD1`);
		const paid = (await env.api('GET', `/v1/payments/${payment.id}`)).json;
		expect(paid).toMatchObject({ status: 'paid' });
		const refund = await env.api('POST', `/v1/payments/${payment.id}/refunds`, { amount: 500 });
		expect(refund.json).toMatchObject({ status: 'partially_refunded' });
		expect(env.gateways.callsTo('https://api-m.paypal.com').at(-1)?.path).toBe('/v2/payments/captures/CAP1/refund');
	});

	it('PayFast: signed form, ITN checked with PayFast', async () => {
		env.gateways.respond('https://www.payfast.co.za', () => ({ status: 200, body: 'VALID' }));
		const payment = await createPayment({ amount: 10000, currency: 'ZAR', gateway: 'payfast' });
		const form = await page(`/pay/${env.websiteId}/${payment.id}`);
		expect(form.text).toContain('https://www.payfast.co.za/eng/process');
		/** @type {Array<[string, string]>} */
		const itn = [
			['m_payment_id', payment.id],
			['pf_payment_id', '777'],
			['payment_status', 'COMPLETE'],
			['amount_gross', '100.00'],
			['merchant_id', PAYFAST.merchantId],
		];
		const body = new URLSearchParams([...itn, ['signature', formSignature(itn, PAYFAST.passphrase)]]).toString();
		const res = await env.call('POST', `/v1/gateways/payfast/${env.websiteId}`, { form: body });
		expect(res.status).toBe(200);
		expect((await env.api('GET', `/v1/payments/${payment.id}`)).json.status).toBe('paid');
		const refund = await env.api('POST', `/v1/payments/${payment.id}/refunds`, {});
		expect(refund.json.status).toBe('refunded');
		expect(env.gateways.callsTo('https://api.payfast.co.za').at(-1)?.path).toBe('/refunds/777');
		// the payer back on PayFast's return address
		expect((await page(`/return/payfast/${env.websiteId}/${payment.id}`)).headers.get('location')).toBe(
			`${RETURN}?ss_payment=${payment.id}`,
		);
	});

	it('PayFast (Pakistan): access token, form to PayFast, signed return and CHECKOUT_URL notices', async () => {
		env.gateways.respond('https://ipg1.apps.net.pk', (c) =>
			c.path === '/Ecommerce/api/Transaction/GetAccessToken' ? { status: 200, body: { ACCESS_TOKEN: 'tok' } } : undefined,
		);
		expect(await env.connect('payfast_pk', PAYFAST_PK)).toMatchObject({ status: 'connected', last4: '0123' });
		const payment = await createPayment({ gateway: 'payfast_pk' });
		const form = await page(`/pay/${env.websiteId}/${payment.id}`);
		expect(form.text).toContain('https://ipg1.apps.net.pk/Ecommerce/api/Transaction/PostTransaction');
		expect(form.text).toContain(`${BASE}/v1/gateways/payfast_pk/${env.websiteId}`);
		expect(form.text).toContain('Continue to PayFast (Pakistan)');
		/** PayFast's signed answer. @param {string} basket @param {string} code */
		const signed = (basket, code) =>
			new URLSearchParams({
				basket_id: basket,
				err_code: code,
				transaction_id: 'T-1',
				transaction_amount: '2500',
				validation_hash: validationHash(basket, code, PAYFAST_PK),
			}).toString();
		// what the browser brings back unsigned changes nothing
		const forged = await page(`/return/payfast_pk/${env.websiteId}/${payment.id}?basket_id=${payment.id}&err_code=000`);
		expect(forged.headers.get('location')).toBe(`${RETURN}?ss_payment=${payment.id}`);
		expect((await env.api('GET', `/v1/payments/${payment.id}`)).json.status).toBe('pending');
		const back = await page(`/return/payfast_pk/${env.websiteId}/${payment.id}?${signed(payment.id, '000')}`);
		expect(back.headers.get('location')).toBe(`${RETURN}?ss_payment=${payment.id}`);
		expect((await env.api('GET', `/v1/payments/${payment.id}`)).json).toMatchObject({
			status: 'paid',
			gatewayReference: payment.id,
		});
		// PayFast's own call to CHECKOUT_URL, by GET or POST: a second confirmation changes nothing
		const notice = await env.call('GET', `/v1/gateways/payfast_pk/${env.websiteId}?${signed(payment.id, '000')}`);
		expect(notice.json).toEqual({ received: true });
		const posted = await env.call('POST', `/v1/gateways/payfast_pk/${env.websiteId}`, { form: signed(payment.id, '000') });
		expect(posted.status).toBe(200);
		const unsigned = await env.call('GET', `/v1/gateways/payfast_pk/${env.websiteId}?basket_id=${payment.id}&err_code=000`);
		expect(unsigned.status).toBe(401);
		// a payment confirmed by the notice alone, and a failed one sent back to the pay page
		const second = await createPayment({ gateway: 'payfast_pk' });
		await page(`/pay/${env.websiteId}/${second.id}`);
		await env.call('GET', `/v1/gateways/payfast_pk/${env.websiteId}?${signed(second.id, '000')}`);
		expect((await env.api('GET', `/v1/payments/${second.id}`)).json.status).toBe('paid');
		const third = await createPayment({ gateway: 'payfast_pk' });
		await page(`/pay/${env.websiteId}/${third.id}`);
		const failed = await page(`/return/payfast_pk/${env.websiteId}/${third.id}?${signed(third.id, '002')}`);
		expect(failed.headers.get('location')).toBe(`/pay/${env.websiteId}/${third.id}`);
		expect((await env.api('GET', `/v1/payments/${third.id}`)).json.status).toBe('failed');
		// no refund call at PayFast Pakistan: recorded for the merchant to return
		const refund = await env.api('POST', `/v1/payments/${payment.id}/refunds`, { amount: 1000 });
		expect(refund.json.refunds[0]).toMatchObject({ manual: true, amount: 1000 });
	});

	it('Rapid Gateway: payment created at Rapid, redirect, confirmed by the signed webhook only', async () => {
		env.gateways.respond('https://api.rapidgateway.pk', (c) => {
			const sent = JSON.parse(c.body);
			return { status: 201, body: { id: `rp_${sent.metadata.ss_payment}`, checkout_url: 'https://checkout.rapid.test/x' } };
		});
		expect(await env.connect('rapid', RAPID)).toMatchObject({ status: 'connected', last4: '0123' });
		const payment = await createPayment({ gateway: 'rapid' });
		const go = await page(`/pay/${env.websiteId}/${payment.id}`);
		expect(go.headers.get('location')).toBe('https://checkout.rapid.test/x');
		// back from Rapid: still pending until the webhook
		const back = await page(`/return/rapid/${env.websiteId}/${payment.id}`);
		expect(back.headers.get('location')).toBe(`${RETURN}?ss_payment=${payment.id}`);
		expect((await env.api('GET', `/v1/payments/${payment.id}`)).json.status).toBe('pending');
		/** @param {object} event @param {string} [signature] */
		const hook = (event, signature) => {
			const body = JSON.stringify(event);
			return env.call('POST', `/v1/gateways/rapid/${env.websiteId}`, {
				body,
				headers: { 'x-rg-signature': signature ?? webhookSignature(body, RAPID.webhookSecret) },
			});
		};
		const event = { id: `rp_${payment.id}`, status: 'succeeded', amount: 2500, metadata: { ss_payment: payment.id } };
		expect((await hook(event, 'x')).status).toBe(401);
		expect((await hook(event)).json).toEqual({ received: true });
		expect((await env.api('GET', `/v1/payments/${payment.id}`)).json).toMatchObject({
			status: 'paid',
			gatewayReference: `rp_${payment.id}`,
		});
		// a webhook for another amount is recorded and pays nothing
		const other = await createPayment({ gateway: 'rapid' });
		await page(`/pay/${env.websiteId}/${other.id}`);
		await hook({ id: `rp_${other.id}`, status: 'paid', amount: 25, metadata: { ss_payment: other.id } });
		const unpaid = (await env.api('GET', `/v1/payments/${other.id}`)).json;
		expect(unpaid.status).toBe('pending');
		expect(unpaid.history.at(-1)).toMatchObject({ event: 'mismatch', detail: 'rapid confirmed 2500 PKR' });
		// paisa cannot be paid at Rapid
		const fraction = await createPayment({ gateway: 'rapid', amount: 250050 });
		expect((await page(`/pay/${env.websiteId}/${fraction.id}`)).status).toBe(502);
		const refund = await env.api('POST', `/v1/payments/${payment.id}/refunds`, {});
		expect(refund.json).toMatchObject({ status: 'refunded', refunds: [{ manual: true, amount: 250000 }] });
	});

	it('the generic adapter: signed checkout fields, signed notice, refunds recorded', async () => {
		const payment = await createPayment({ amount: 900, currency: 'USD', gateway: 'generic' });
		const form = await page(`/pay/${env.websiteId}/${payment.id}`);
		expect(form.text).toContain('Continue to PayNow');
		const body = JSON.stringify({ paymentId: payment.id, status: 'paid', amount: 900, currency: 'USD', reference: 'G-1' });
		const res = await env.call('POST', `/v1/gateways/generic/${env.websiteId}`, {
			body,
			headers: { 'ss-signature': signTimestamped(body, GENERIC.secret, env.now()) },
		});
		expect(res.json).toEqual({ received: true });
		const refund = await env.api('POST', `/v1/payments/${payment.id}/refunds`, {});
		expect(refund.json.refunds[0].manual).toBe(true);
	});

	it('refuses notices for unknown websites and gateways that are not set up', async () => {
		expect((await env.call('POST', '/v1/gateways/stripe/web_nope', { body: '{}' })).status).toBe(404);
		await env.dashboard(await env.adminSession(), 'DELETE', `/v1/dashboard/websites/${env.websiteId}/connections/generic`);
		expect((await env.call('POST', `/v1/gateways/generic/${env.websiteId}`, { body: '{}' })).status).toBe(404);
		await env.connect('generic', GENERIC);
	});

	it('cancel on the gateway: back to the pay page, then try again', async () => {
		const payment = await createPayment({ gateway: 'stripe', returnUrl: undefined });
		await page(`/pay/${env.websiteId}/${payment.id}`);
		const cancel = await page(`/return/cancel/${env.websiteId}/${payment.id}`);
		expect(cancel.headers.get('location')).toBe(`/pay/${env.websiteId}/${payment.id}`);
		expect((await page(`/pay/${env.websiteId}/${payment.id}`)).text).toContain('The payment was cancelled.');
		const withCancel = await createPayment({ gateway: 'stripe', cancelUrl: `${ORIGIN}/cart` });
		expect((await page(`/return/cancel/${env.websiteId}/${withCancel.id}`)).headers.get('location')).toBe(
			`${ORIGIN}/cart?ss_payment=${withCancel.id}`,
		);
		expect((await page(`/return/stripe/${env.websiteId}/pay_unknown`)).status).toBe(404);
		expect((await page(`/return/stripe/web_nope/${payment.id}`)).status).toBe(404);
		expect((await page(`/pay/${env.websiteId}/pay_unknown`)).status).toBe(404);
		expect((await page(`/pay/web_nope/${payment.id}`)).status).toBe(404);
		expect((await env.call('POST', `/pay/web_nope/${payment.id}`, { form: {} })).status).toBe(404);
		expect((await env.call('POST', `/pay/${env.websiteId}/pay_unknown`, { form: {} })).status).toBe(404);
	});
});

describe('bank transfer', () => {
	it('shows the bank details, takes a proof and is confirmed by the merchant', async () => {
		env.gateways.respond(BUCKET, (c) =>
			c.method === 'HEAD' && c.path.includes('payments/proofs/')
				? { status: 200, headers: { 'content-type': 'image/png', 'content-length': '1234' } }
				: { status: 404 },
		);
		const payment = await createPayment({ gateway: 'bank_transfer', reference: 'INV-9' });
		const details = await page(`/pay/${env.websiteId}/${payment.id}`);
		expect(details.text).toContain('0123-456789');
		expect(details.text).toContain('INV-9');
		expect(details.text).toContain('data-proof');
		const base = `/pay/${env.websiteId}/${payment.id}/proof`;
		expect((await env.call('POST', base, { body: { type: 'text/html', size: 10 } })).status).toBe(422);
		expect((await env.call('POST', base, { body: { type: 'image/png', size: 50 * 1_048_576 } })).status).toBe(422);
		const signed = await env.call('POST', base, { body: { type: 'image/png', size: 1234 } });
		expect(signed.json.upload).toMatchObject({ method: 'PUT', headers: { 'content-type': 'image/png' } });
		expect(signed.json.upload.url).toContain(BUCKET);
		expect((await env.call('POST', `${base}/done`, { body: { key: 'other/key.png' } })).status).toBe(422);
		expect((await env.call('POST', `${base}/done`, { body: { key: `payments/proofs/${payment.id}.gif` } })).status).toBe(422);
		expect((await env.call('POST', `${base}/done`, { body: { key: signed.json.key } })).json).toEqual({ uploaded: true });
		expect((await env.call('POST', base, { body: { type: 'image/png', size: 1 } })).status).toBe(404);
		expect((await page(`/pay/${env.websiteId}/${payment.id}`)).text).toContain('Your proof was received');

		const proof = await env.api('GET', `/v1/payments/${payment.id}/proof`);
		expect(proof.json.url).toContain('X-Amz-Signature');
		const confirmed = await env.api('POST', `/v1/payments/${payment.id}/confirm`, {});
		expect(confirmed.json).toMatchObject({ status: 'paid', proof: { type: 'image/png', size: 1234 } });
		expect((await env.api('POST', `/v1/payments/${payment.id}/confirm`, {})).status).toBe(409);
		const refund = await env.api('POST', `/v1/payments/${payment.id}/refunds`, { amount: 100 });
		expect(refund.json.refunds[0].manual).toBe(true);
		const noProof = await createPayment({ gateway: 'stripe' });
		expect((await env.api('GET', `/v1/payments/${noProof.id}/proof`)).status).toBe(404);
	});

	it('without proof upload the page shows only the details', async () => {
		await env.setting('bank_transfer', 'proofUpload', false);
		const payment = await createPayment({ gateway: 'bank_transfer' });
		const details = await page(`/pay/${env.websiteId}/${payment.id}`);
		expect(details.text).not.toContain('data-proof');
		expect(
			(await env.call('POST', `/pay/${env.websiteId}/${payment.id}/proof`, { body: { type: 'image/png', size: 1 } })).status,
		).toBe(503);
		await env.setting('bank_transfer', 'proofUpload', true);
	});
});

describe('payment links and the pay button routes', () => {
	/** @type {any} */
	let fixed;
	/** @type {any} */
	let open;
	it('creates links and serves their hosted page', async () => {
		const bad = await env.api('POST', '/v1/links', { title: 'X', currency: 'PKR', returnUrl: 'https://evil.example.net' });
		expect(bad.status).toBe(422);
		expect((await env.api('POST', '/v1/links', { currency: 'PKR' })).status).toBe(422);
		fixed = (
			await env.api('POST', '/v1/links', {
				title: 'Invoice 12',
				currency: 'PKR',
				amount: 150000,
				gateways: ['jazzcash', 'bank_transfer'],
				reference: 'inv-12',
			})
		).json;
		expect(fixed.url).toBe(`${BASE}/l/${env.websiteId}/${fixed.id}`);
		open = (
			await env.api('POST', '/v1/links', {
				title: 'Donate',
				description: 'Thank you',
				currency: 'USD',
				amount: null,
				minAmount: 500,
				returnUrl: RETURN,
			})
		).json;
		const html = await page(`/l/${env.websiteId}/${fixed.id}`);
		expect(html.text).toContain('PKR 1,500.00');
		expect(html.text).toContain('JazzCash');
		expect(html.text).not.toContain('Card (Stripe)');
		expect((await page(`/l/${env.websiteId}/${open.id}`)).text).toContain('At least USD 5.00');
		expect((await env.api('GET', '/v1/links')).json.items).toHaveLength(2);
		expect((await env.api('GET', `/v1/links/${fixed.id}`)).json.title).toBe('Invoice 12');
		expect((await env.api('GET', '/v1/links/link_nope')).status).toBe(404);
	});

	it('the hosted page makes a payment and sends the payer on', async () => {
		const low = await env.call('POST', `/l/${env.websiteId}/${open.id}`, { form: { amount: '1', gateway: 'stripe' } });
		expect(low.status).toBe(422);
		expect(low.text).toContain('Enter an amount of at least USD 5.00.');
		const email = await env.call('POST', `/l/${env.websiteId}/${open.id}`, {
			form: { amount: '10', gateway: 'stripe', email: 'x' },
		});
		expect(email.text).toContain('Enter a valid e-mail address.');
		const method = await env.call('POST', `/l/${env.websiteId}/${open.id}`, { form: { amount: '10', gateway: 'jazzcash' } });
		expect(method.text).toContain('Choose a payment method.');
		const made = await env.call('POST', `/l/${env.websiteId}/${open.id}`, {
			form: { amount: '10', gateway: 'stripe', name: 'Ana', email: 'ana@example.com' },
		});
		expect(made.status).toBe(303);
		const paymentId = /\/pay\/[^/]+\/(pay_[A-Za-z0-9]+)/.exec(made.headers.get('location') ?? '')?.[1] ?? '';
		const payment = (await env.api('GET', `/v1/payments/${paymentId}`)).json;
		expect(payment).toMatchObject({
			amount: 1000,
			currency: 'USD',
			source: 'link',
			linkId: open.id,
			description: 'Donate',
			customer: { name: 'Ana' },
		});
		await page(`/pay/${env.websiteId}/${paymentId}`);
		await stripePaid(paymentId, 1000, 'usd');
		expect((await env.api('GET', `/v1/links/${open.id}`)).json.paidCount).toBe(1);
	});

	it('the pay button routes work with the browser token from the website only', async () => {
		const noOrigin = await env.call('GET', `/v1/checkout/links/${fixed.id}`, { token: env.browser });
		expect(noOrigin.status).toBe(401);
		const elsewhere = await env.call('GET', `/v1/checkout/links/${fixed.id}`, {
			token: env.browser,
			origin: `https://www.${DOMAIN}`,
		});
		expect(elsewhere.status).toBe(401);
		expect((await env.call('GET', '/v1/payments', { token: env.server, origin: ORIGIN })).status).toBe(401);
		const shown = await env.call('GET', `/v1/checkout/links/${fixed.id}`, { token: env.browser, origin: ORIGIN });
		expect(shown.json).toMatchObject({
			title: 'Invoice 12',
			amount: 150000,
			gateways: [
				{ id: 'jazzcash', name: 'JazzCash' },
				{ id: 'bank_transfer', name: 'Bank transfer' },
			],
		});
		const bad = await env.call('POST', `/v1/checkout/links/${fixed.id}`, {
			token: env.browser,
			origin: ORIGIN,
			body: { gateway: 'stripe' },
		});
		expect(bad.json.errors[0]).toMatchObject({ path: '/gateway', message: 'Choose a payment method.' });
		const made = await env.call('POST', `/v1/checkout/links/${fixed.id}`, {
			token: env.browser,
			origin: 'http://localhost:5173',
			body: { gateway: 'bank_transfer', customer: { email: 'b@example.com' } },
		});
		expect(made.status).toBe(201);
		expect(made.json.checkoutUrl).toBe(`${BASE}/pay/${env.websiteId}/${made.json.paymentId}`);
		const payment = await env.call('GET', `/v1/checkout/payments/${made.json.paymentId}`, {
			token: env.browser,
			origin: ORIGIN,
		});
		expect(payment.json).toMatchObject({ amount: 150000, status: 'pending', checkoutUrl: made.json.checkoutUrl });
		expect(Object.keys(payment.json)).not.toContain('customer');
		expect((await env.call('GET', '/v1/checkout/links/link_nope', { token: env.browser, origin: ORIGIN })).status).toBe(404);
		expect(
			(await env.call('POST', '/v1/checkout/links/link_nope', { token: env.browser, origin: ORIGIN, body: {} })).status,
		).toBe(404);
	});

	it('a link that is turned off is gone', async () => {
		expect((await env.api('PATCH', `/v1/links/${fixed.id}`, { active: 'no' })).status).toBe(422);
		expect((await env.api('PATCH', '/v1/links/link_nope', { active: false })).status).toBe(404);
		expect((await env.api('PATCH', `/v1/links/${fixed.id}`, { active: false })).json.active).toBe(false);
		expect((await page(`/l/${env.websiteId}/${fixed.id}`)).status).toBe(404);
		expect((await page(`/l/web_nope/${fixed.id}`)).status).toBe(404);
	});
});

describe('subscriptions', () => {
	it('starts a Stripe subscription and mirrors its status', async () => {
		const bad = await env.api('POST', '/v1/subscriptions', {
			gateway: 'stripe',
			plan: 'price_1',
			returnUrl: 'https://evil.example.net',
		});
		expect(bad.status).toBe(422);
		expect((await env.api('POST', '/v1/subscriptions', { gateway: 'x' })).status).toBe(422);
		const made = await env.api('POST', '/v1/subscriptions', {
			gateway: 'stripe',
			plan: 'price_1',
			customer: { email: 'sub@example.com' },
			returnUrl: RETURN,
		});
		expect(made.status).toBe(201);
		expect(made.json).toMatchObject({ status: 'pending', checkoutUrl: `https://checkout.stripe.com/c/${made.json.id}` });
		await stripeHook({
			type: 'checkout.session.completed',
			data: {
				object: { mode: 'subscription', client_reference_id: made.json.id, subscription: 'sub_stripe1', status: 'complete' },
			},
		});
		expect((await env.api('GET', `/v1/subscriptions/${made.json.id}`)).json).toMatchObject({
			status: 'active',
			gatewayReference: 'sub_stripe1',
		});
		await stripeHook({
			type: 'customer.subscription.updated',
			data: { object: { id: 'sub_stripe1', status: 'past_due', metadata: {} } },
		});
		expect((await env.api('GET', `/v1/subscriptions/${made.json.id}`)).json.status).toBe('past_due');
		expect(events.at(-1)).toMatchObject({
			type: 'payments.subscription.updated',
			data: { subscription: { status: 'past_due' } },
		});
		await stripeHook({
			type: 'customer.subscription.updated',
			data: { object: { id: 'sub_stripe1', status: 'past_due', metadata: {} } },
		});
		const cancelled = await env.api('POST', `/v1/subscriptions/${made.json.id}/cancel`, {});
		expect(cancelled.json.status).toBe('cancelled');
		expect(env.gateways.callsTo('https://api.stripe.com').at(-1)).toMatchObject({
			method: 'DELETE',
			path: '/v1/subscriptions/sub_stripe1',
		});
		expect((await env.api('POST', `/v1/subscriptions/${made.json.id}/cancel`, {})).status).toBe(409);
		expect((await env.api('GET', '/v1/subscriptions/sub_nope')).status).toBe(404);
		expect((await env.api('POST', '/v1/subscriptions/sub_nope/cancel', {})).status).toBe(404);
	});

	it('starts a PayPal subscription and reads it when the payer returns', async () => {
		env.gateways.respond('https://api-m.paypal.com', (c) => {
			if (c.path === '/v1/oauth2/token') return { status: 200, body: { access_token: 'tok' } };
			if (c.path === '/v1/billing/subscriptions')
				return { status: 201, body: { id: 'I-1', links: [{ rel: 'approve', href: 'https://paypal.test/s' }] } };
			if (c.path === '/v1/billing/subscriptions/I-1') return { status: 200, body: { id: 'I-1', status: 'ACTIVE' } };
			return { status: 400 };
		});
		const made = await env.api('POST', '/v1/subscriptions', {
			gateway: 'paypal',
			plan: 'P-123',
			returnUrl: RETURN,
			cancelUrl: `${ORIGIN}/plans`,
		});
		expect(made.json.checkoutUrl).toBe('https://paypal.test/s');
		const back = await page(`/return/paypal/${env.websiteId}/${made.json.id}?subscription_id=I-1`);
		expect(back.headers.get('location')).toBe(`${RETURN}?ss_subscription=${made.json.id}`);
		expect((await env.api('GET', `/v1/subscriptions/${made.json.id}`)).json.status).toBe('active');
		expect((await page(`/return/cancel/${env.websiteId}/${made.json.id}`)).headers.get('location')).toBe(
			`${ORIGIN}/plans?ss_subscription=${made.json.id}`,
		);
		expect((await page(`/return/paypal/${env.websiteId}/sub_unknown`)).status).toBe(404);
		const refused = await env.api('POST', `/v1/subscriptions/${made.json.id}/cancel`, {});
		expect(refused.status).toBe(502);
		env.gateways.respond('https://api-m.paypal.com', (c) =>
			c.path === '/v1/oauth2/token' ? { status: 200, body: { access_token: 'tok' } } : { status: 400 },
		);
		expect((await env.api('POST', '/v1/subscriptions', { gateway: 'paypal', plan: 'P-123', returnUrl: RETURN })).status).toBe(
			502,
		);
		expect((await env.api('GET', '/v1/subscriptions?status=expired')).json.items).toHaveLength(1);
		await env.dashboard(await env.adminSession(), 'DELETE', `/v1/dashboard/websites/${env.websiteId}/connections/paypal`);
		expect((await env.api('POST', '/v1/subscriptions', { gateway: 'paypal', plan: 'P-123', returnUrl: RETURN })).status).toBe(
			422,
		);
		expect((await env.api('POST', `/v1/subscriptions/${made.json.id}/cancel`, {})).status).toBe(422);
		await env.connect('paypal', PAYPAL);
	});
});

describe('admin widgets (tickets)', () => {
	it('lists, searches, refunds and confirms with a ticket bound to the admin origin', async () => {
		const ticket = await env.ticket();
		const list = await env.call('GET', '/v1/admin/payments?limit=5&status=paid', { token: ticket, origin: ADMIN_ORIGIN });
		expect(list.status).toBe(200);
		expect(list.headers.get('access-control-allow-origin')).toBe(ADMIN_ORIGIN);
		expect(list.json.items.every((/** @type {any} */ p) => p.status === 'paid')).toBe(true);
		const target = list.json.items[0];
		const one = await env.call('GET', `/v1/admin/payments/${target.id}`, { token: ticket, origin: ADMIN_ORIGIN });
		expect(one.json.id).toBe(target.id);
		const refund = await env.call('POST', `/v1/admin/payments/${target.id}/refunds`, {
			token: ticket,
			origin: ADMIN_ORIGIN,
			body: { amount: 1 },
		});
		expect(refund.json.refunds.at(-1)).toMatchObject({ by: 'Sam Staff', amount: 1 });
		const transfer = await createPayment({ gateway: 'bank_transfer' });
		const confirm = await env.call('POST', `/v1/admin/payments/${transfer.id}/confirm`, {
			token: ticket,
			origin: ADMIN_ORIGIN,
			body: {},
		});
		expect(confirm.json.history.at(-1)).toMatchObject({ event: 'paid', by: 'Sam Staff' });
		expect(
			(await env.call('GET', `/v1/admin/payments/${transfer.id}/proof`, { token: ticket, origin: ADMIN_ORIGIN })).status,
		).toBe(404);
		const subs = await env.call('GET', '/v1/admin/subscriptions', { token: ticket, origin: ADMIN_ORIGIN });
		expect(subs.json.items.length).toBeGreaterThan(0);
		const wrong = await env.call('GET', '/v1/admin/payments', { token: ticket, origin: 'https://other.example.net' });
		expect(wrong.status).toBe(401);
		const readOnly = await env.ticket(['payments.read']);
		expect(
			(await env.call('POST', `/v1/admin/payments/${target.id}/refunds`, { token: readOnly, origin: ADMIN_ORIGIN, body: {} }))
				.status,
		).toBe(403);
	});
});

describe('kit features (PLAN 0.8.10)', () => {
	/**
	 * Every item of a list, following its cursors.
	 * @param {string} path
	 * @param {(path: string) => Promise<{ json: any }>} [read]
	 */
	const listAll = async (path, read = (p) => env.api('GET', p)) => {
		/** @type {any[]} */
		const items = [];
		let cursor = '';
		for (;;) {
			const res = await read(`${path}${path.includes('?') ? '&' : '?'}limit=100${cursor ? `&cursor=${cursor}` : ''}`);
			items.push(...res.json.items);
			if (!res.json.hasMore) return items;
			cursor = res.json.nextCursor;
		}
	};
	const ACTOR = { 'ss-actor-id': 'staff_7', 'ss-actor-name': encodeURIComponent('Zoë Khan'), 'ss-actor-role': 'Manager' };

	it('counts payments with the list’s own filters (K4), also with a ticket', async () => {
		const all = await listAll('/v1/payments');
		for (const query of ['', 'status=paid', 'status=pending', 'q=order-1042', 'q=ana@example.com', 'status=bogus', 'q=%20']) {
			const listed = await listAll(`/v1/payments${query ? `?${query}` : ''}`);
			const counted = await env.api('GET', `/v1/payments/count${query ? `?${query}` : ''}`);
			expect(counted.json).toEqual({ count: listed.length, capped: false });
		}
		const byState = await env.api('GET', '/v1/payments/counts?by=state');
		expect(byState.json.total).toBe(all.length);
		for (const status of ['paid', 'pending', 'refunded', 'partially_refunded', 'failed'])
			expect(byState.json.groups[status] ?? 0).toBe(all.filter((p) => p.status === status).length);
		const byGateway = await env.api('GET', '/v1/payments/counts?by=gateway&status=paid');
		const paid = all.filter((p) => p.status === 'paid');
		expect(byGateway.json.total).toBe(paid.length);
		expect(byGateway.json.groups.stripe).toBe(paid.filter((p) => p.gateway === 'stripe').length);
		const none = await env.api('GET', '/v1/payments/counts?by=gateway&status=pending');
		expect(none.json.groups.none).toBe(all.filter((p) => p.status === 'pending' && p.gateway === null).length);
		const wrong = await env.api('GET', '/v1/payments/counts?by=status');
		expect(wrong.status).toBe(422);
		expect(wrong.json.errors[0].path).toBe('/by');

		const ticket = await env.ticket(['payments.read']);
		/** @param {string} path */
		const admin = (path) => env.call('GET', path, { token: ticket, origin: ADMIN_ORIGIN });
		const adminPaid = await listAll('/v1/admin/payments?status=paid', admin);
		expect((await admin('/v1/admin/payments/count?status=paid')).json.count).toBe(adminPaid.length);
		expect((await admin('/v1/admin/payments/counts?by=state')).json).toEqual(byState.json);
		const other = await env.ticket(['subscriptions.read']);
		expect((await env.call('GET', '/v1/admin/payments/count', { token: other, origin: ADMIN_ORIGIN })).status).toBe(403);
	});

	it('lists and counts the kit’s events by time and type (K5)', async () => {
		const all = await listAll('/v1/events');
		const refunded = await listAll('/v1/events?types=payments.payment.refunded');
		expect(refunded.length).toBeGreaterThan(0);
		expect(refunded.every((e) => e.type === 'payments.payment.refunded' && e.data.refund.amount > 0)).toBe(true);
		expect((await env.api('GET', '/v1/events/count?types=payments.payment.refunded')).json.count).toBe(refunded.length);
		const counts = await env.api('GET', '/v1/events/counts?by=type');
		expect(counts.json.total).toBe(all.length);
		expect(counts.json.groups['payments.payment.paid']).toBe(all.filter((e) => e.type === 'payments.payment.paid').length);
		const middle = all[Math.floor(all.length / 2)];
		const since = await listAll(`/v1/events?since=${encodeURIComponent(middle.at)}`);
		expect(since.every((e) => e.at > middle.at)).toBe(true);
		expect((await env.api('GET', '/v1/events?types=chat.message.sent')).status).toBe(422);
		expect((await env.api('GET', '/v1/events/count?since=yesterday')).status).toBe(422);
	});

	it('records the acting user of a server-token call (K2) in histories, refunds and the activity log (K9)', async () => {
		const transfer = await createPayment({ gateway: 'bank_transfer', reference: 'INV-77' });
		const confirmed = await env.api('POST', `/v1/payments/${transfer.id}/confirm`, {}, ACTOR);
		expect(confirmed.json.history.at(-1)).toMatchObject({ event: 'paid', by: 'Zoë Khan' });
		const refund = await env.api('POST', `/v1/payments/${transfer.id}/refunds`, { amount: 50000 }, ACTOR);
		expect(refund.json.refunds.at(-1)).toMatchObject({ by: 'Zoë Khan', amount: 50000, manual: true });
		const sub = await env.api('POST', '/v1/subscriptions', {
			gateway: 'stripe',
			plan: 'price_2',
			reference: 'club-9',
			returnUrl: RETURN,
		});
		await stripeHook({
			type: 'checkout.session.completed',
			data: {
				object: { mode: 'subscription', client_reference_id: sub.json.id, subscription: 'sub_stripe9', status: 'complete' },
			},
		});
		const cancelled = await env.api('POST', `/v1/subscriptions/${sub.json.id}/cancel`, {}, ACTOR);
		expect(cancelled.json.history.at(-1)).toMatchObject({ event: 'cancelled', by: 'Zoë Khan' });

		const log = (await env.api('GET', '/v1/activity?actor=staff_7')).json.items;
		expect(log.map((/** @type {any} */ e) => e.action).sort()).toEqual([
			'payment.refunded',
			'payment.transfer_confirmed',
			'subscription.cancelled',
		]);
		for (const entry of log) expect(entry.actor).toEqual({ kind: 'user', id: 'staff_7', name: 'Zoë Khan', role: 'Manager' });
		const byAction = Object.fromEntries(log.map((/** @type {any} */ e) => [e.action, e]));
		expect(byAction['payment.transfer_confirmed']).toMatchObject({
			target: transfer.id,
			label: 'INV-77',
			detail: 'Bank transfer of PKR 2,500.00 confirmed',
		});
		expect(byAction['payment.refunded']).toMatchObject({
			label: 'INV-77',
			detail: 'Refunded PKR 500.00 (recorded; returned outside the gateway)',
		});
		expect(byAction['subscription.cancelled']).toMatchObject({
			target: sub.json.id,
			label: 'club-9',
			detail: 'Cancelled at Stripe (plan price_2)',
		});
		// the server itself, and a ticket's staff member
		const plain = await createPayment({ gateway: 'bank_transfer' });
		await env.api('POST', `/v1/payments/${plain.id}/confirm`, {});
		const server = (await env.api('GET', `/v1/activity?target=${plain.id}`)).json.items[0];
		expect(server).toMatchObject({ actor: { kind: 'server', id: 'server', name: 'Server' }, label: plain.id });
		const malformed = await env.api('POST', `/v1/payments/${plain.id}/refunds`, {}, { 'ss-actor-id': 'not valid!' });
		expect(malformed.status).toBe(400);
		expect(malformed.json.type).toMatch(/invalid_actor$/);
		expect((await env.api('GET', `/v1/payments/${plain.id}`)).json.refunded).toBe(0);
	});

	it('serves the pay button routes to the server for one visitor (K3)', async () => {
		const link = (
			await env.api('POST', '/v1/links', {
				title: 'Server visit',
				currency: 'PKR',
				amount: 70000,
				gateways: ['bank_transfer'],
			})
		).json;
		const shown = await env.call('GET', `/v1/checkout/links/${link.id}`, { token: env.server });
		expect(shown.status).toBe(200);
		expect(shown.headers.get('access-control-allow-origin')).toBeNull();
		expect(shown.json).toMatchObject({ title: 'Server visit', gateways: [{ id: 'bank_transfer' }] });
		const body = { gateway: 'bank_transfer', customer: { email: 'visitor@example.com' } };
		const noIp = await env.call('POST', `/v1/checkout/links/${link.id}`, { token: env.server, body });
		expect(noIp.status).toBe(400);
		expect(noIp.json.type).toMatch(/visitor_ip_required$/);
		const made = await env.call('POST', `/v1/checkout/links/${link.id}`, {
			token: env.server,
			body,
			headers: { 'ss-visitor-ip': '203.0.113.7' },
		});
		expect(made.status).toBe(201);
		expect(made.json.checkoutUrl).toBe(`${BASE}/pay/${env.websiteId}/${made.json.paymentId}`);
		const payment = await env.call('GET', `/v1/checkout/payments/${made.json.paymentId}`, { token: env.server });
		expect(payment.json).toMatchObject({ amount: 70000, status: 'pending' });
		// the per-visitor limit (30 a minute) counts by SS-Visitor-IP
		env.advance(61_000);
		/** @param {string} ip */
		const visit = (ip) =>
			env.call('GET', `/v1/checkout/links/${link.id}`, { token: env.server, headers: { 'ss-visitor-ip': ip } });
		for (let i = 0; i < 30; i += 1) expect((await visit('198.51.100.1')).status).toBe(200);
		expect((await visit('198.51.100.1')).status).toBe(429);
		expect((await visit('198.51.100.2')).status).toBe(200);
		env.advance(61_000);
	});

	it('formats money with the website’s Format on hosted pages, in activity details and in the widget config (K7)', async () => {
		const saved = await env.api('PUT', '/v1/format', { currencyDisplay: 'custom', currencySymbol: 'Rs', wholeUnits: true });
		expect(saved.status).toBe(200);
		const config = await env.call('GET', '/v1/widget/config', { token: env.browser, origin: ORIGIN });
		expect(config.json).toMatchObject({ format: { currencySymbol: 'Rs', wholeUnits: true }, timeZone: 'UTC' });
		const payment = await createPayment({});
		const choice = await page(`/pay/${env.websiteId}/${payment.id}`);
		expect(choice.text).toContain('Rs 2,500');
		expect(choice.text).not.toContain('PKR 2,500.00');
		const link = (await env.api('POST', '/v1/links', { title: 'Tip', currency: 'PKR', amount: null, minAmount: 50000 })).json;
		expect((await page(`/l/${env.websiteId}/${link.id}`)).text).toContain('At least Rs 500');
		const low = await env.call('POST', `/l/${env.websiteId}/${link.id}`, { form: { amount: '1', gateway: 'bank_transfer' } });
		expect(low.text).toContain('Enter an amount of at least Rs 500.');
		const transfer = await createPayment({ gateway: 'bank_transfer' });
		expect((await page(`/pay/${env.websiteId}/${transfer.id}`)).text).toContain('Rs 2,500');
		await env.api('POST', `/v1/payments/${transfer.id}/confirm`, {});
		const entry = (await env.api('GET', `/v1/activity?target=${transfer.id}`)).json.items[0];
		expect(entry.detail).toBe('Bank transfer of Rs 2,500 confirmed');
		// API JSON keeps minor units and ISO times
		expect((await env.api('GET', `/v1/payments/${transfer.id}`)).json).toMatchObject({ amount: 250000, amountText: '2500.00' });
		await env.api('PUT', '/v1/format', { currencyDisplay: null, currencySymbol: null, wholeUnits: null });
		expect((await page(`/pay/${env.websiteId}/${payment.id}`)).text).toContain('PKR 2,500.00');
	});

	it('explains the kit’s routes in the docs', async () => {
		const docs = await page('/docs');
		for (const id of ['server-settings', 'acting-user', 'server-visitors', 'counts', 'activity', 'format'])
			expect(docs.text).toContain(`id="${id}"`);
		expect(docs.text).toContain('GET /v1/payments/count');
	});
});

describe('data rights, statuses and public files', () => {
	it('exports and anonymises a person’s payments', async () => {
		const exported = await env.api('POST', '/v1/data-rights/export', { user: { email: 'sub@example.com' } });
		expect(exported.json.records.subscriptions).toHaveLength(1);
		const ana = await env.api('POST', '/v1/data-rights/export', {
			user: { email: 'ana@example.com', id: 'u_none', phone: '+923001234567' },
		});
		expect(ana.json.records.payments.length).toBeGreaterThan(0);
		expect(ana.json.records.payments[0]).not.toHaveProperty('metadata');
		const removed = await env.api('POST', '/v1/data-rights/delete', { user: { email: 'ana@example.com' } });
		expect(removed.json.anonymised).toBeGreaterThan(0);
		expect(
			(await env.api('POST', '/v1/data-rights/export', { user: { email: 'ana@example.com' } })).json.records.payments,
		).toEqual([]);
		expect((await env.api('POST', '/v1/data-rights/delete', { user: {} })).status).toBeLessThan(500);
	});

	it('serves the widget script, the page script and the docs', async () => {
		expect((await page('/widget.js')).headers.get('content-type')).toContain('javascript');
		expect((await page('/pay.js')).text).toContain('data-autosubmit');
		const docs = await page('/docs');
		expect(docs.text).toContain(`${BASE}/v1/gateways/stripe/&#60;websiteId&#62;`);
		expect(docs.text).toContain('feature-payment_links');
	});

	it('obeys stopped, suspended and removed (API, tickets, hosted pages, notices), and grace keeps working', async () => {
		const payment = await createPayment({ gateway: 'stripe' });
		const ticket = await env.ticket();
		for (const status of /** @type {const} */ (['stopped', 'suspended', 'removed'])) {
			env.portal.setStatus(env.websiteId, { status });
			env.advance(1000);
			await env.portal.sendNotice('payments', { type: 'status.changed', websiteId: env.websiteId });
			await env.flush();
			const api = await env.api('GET', '/v1/payments');
			expect(api.status).toBe(403);
			expect(api.json.reason).toBe(status);
			expect((await env.call('GET', '/v1/admin/payments', { token: ticket, origin: ADMIN_ORIGIN })).status).toBe(403);
			expect(
				(await env.call('GET', `/v1/checkout/payments/${payment.id}`, { token: env.browser, origin: ORIGIN })).status,
			).toBe(403);
			const hosted = await page(`/pay/${env.websiteId}/${payment.id}`);
			expect(hosted.status).toBe(404);
			expect(hosted.text).toContain('Payments are not available right now.');
			expect((await stripePaid(payment.id, 250000)).status).toBe(404);
		}
		env.portal.setStatus(env.websiteId, { status: 'grace', graceEndsAt: new Date(env.now() + 86_400_000).toISOString() });
		env.advance(1000);
		await env.portal.sendNotice('payments', { type: 'status.changed', websiteId: env.websiteId });
		await env.flush();
		await env.switchOn(ALL);
		expect((await env.api('GET', '/v1/payments')).status).toBe(200);
		expect((await stripePaid(payment.id, 250000)).json).toEqual({ received: true });
	});

	it('handles the other notices: revoked tokens and sessions, and a deleted website', async () => {
		env.advance(1000);
		const revoked = (await env.portal.issueToken({ websiteId: env.websiteId, productId: 'payments', kind: 'server' })).token;
		expect((await env.call('GET', '/v1/payments', { token: revoked })).status).toBe(200);
		const claims = JSON.parse(Buffer.from(revoked.split('.')[1] ?? '', 'base64url').toString());
		env.portal.revoke(claims.jti);
		expect((await env.portal.sendNotice('payments', { type: 'token.revoked', websiteId: env.websiteId })).status).toBe(204);
		await env.flush();
		expect((await env.call('GET', '/v1/payments', { token: revoked })).status).toBe(401);
		const cookie = await env.adminSession();
		const session = await env.dashboard(cookie, 'GET', '/v1/dashboard/session');
		expect(session.status).toBe(200);
		env.advance(1000);
		expect((await env.portal.sendNotice('payments', { type: 'sessions.revoked', subject: session.json.who.id })).status).toBe(
			204,
		);
		expect((await env.dashboard(cookie, 'GET', '/v1/dashboard/session')).status).toBe(401);
		env.advance(1000);
		expect((await env.portal.sendNotice('payments', { type: 'website.deleted', websiteId: env.websiteId })).status).toBe(204);
		await env.flush();
		expect((await env.api('GET', '/v1/payments')).status).toBe(403);
	});
});
