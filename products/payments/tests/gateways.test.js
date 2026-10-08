import { createHash, createHmac, createDecipheriv } from 'node:crypto';
import { createNetwork } from '@ss/app-kit/testing';
import { createOutboundPolicy } from '@ss/net';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAdapters, genericCurrencies } from '../adapters/gateways/index.js';
import { apiSignature, formSignature } from '../adapters/gateways/payfast.js';
import { pakistanTime, secureHash, shortRef } from '../adapters/gateways/jazzcash.js';
import { hashedRequest } from '../adapters/gateways/easypaisa.js';
import { checkoutSignature } from '../adapters/gateways/generic.js';
import { call, failure } from '../adapters/gateways/types.js';
import { formFields, phpUrlencode, signTimestamped, verifyTimestamped } from '../adapters/util.js';
import { createFakeGateways } from './helpers.js';

const NOW = Date.parse('2026-10-01T10:00:00Z');
const adapters = createAdapters(createOutboundPolicy());
/** @type {ReturnType<typeof createFakeGateways>} */
let fake;
/** @type {{ send: any, now: () => number }} */
let ctx;
beforeEach(() => {
	fake = createFakeGateways();
	ctx = { send: createNetwork(fake.handlers).send, now: () => NOW };
});

const PAYMENT = {
	id: 'pay_abcdefghijklmnopqrstuvwxyz',
	websiteId: 'web_1',
	amount: 250000,
	currency: 'PKR',
	description: 'Order 1042',
	reference: 'order-1042',
	customer: { email: 'ana@example.com', name: 'Ana Khan', phone: '+923001234567' },
	gatewayRef: null,
	captureRef: null,
};
const URLS = { return: 'https://pay.test/return', cancel: 'https://pay.test/cancel', notify: 'https://pay.test/notify' };
/** @param {Record<string, string>} [headers] @param {string} [rawBody] @param {Record<string, string>} [query] */
const incoming = (headers = {}, rawBody = '', query = {}) => ({ rawBody, headers: new Headers(headers), query });

describe('util', () => {
	it('signs and checks timestamped signatures (repeated v1 allowed, 5 minutes)', () => {
		const header = signTimestamped('{"a":1}', 'secret', NOW);
		expect(verifyTimestamped({ header, body: '{"a":1}', secret: 'secret', now: NOW })).toBe(true);
		expect(verifyTimestamped({ header: `${header},v1=zz`, body: '{"a":1}', secret: 'secret', now: NOW })).toBe(true);
		expect(verifyTimestamped({ header, body: '{"a":2}', secret: 'secret', now: NOW })).toBe(false);
		expect(verifyTimestamped({ header, body: '{"a":1}', secret: 'secret', now: NOW + 301_000 })).toBe(false);
		expect(verifyTimestamped({ header: null, body: '', secret: 'secret', now: NOW })).toBe(false);
	});
	it("encodes like PHP's urlencode and reads forms in order", () => {
		expect(phpUrlencode("a b!'()*~")).toBe('a+b%21%27%28%29%2A%7E');
		expect(formFields('b=1&a=2&b=3')).toEqual([
			['b', '3'],
			['a', '2'],
		]);
	});
	it('answers status 0 when a gateway cannot be reached, and names failures', async () => {
		expect(await call(ctx, 'https://unknown.example.net/x', { method: 'GET' })).toMatchObject({ status: 0 });
		expect(failure('X', 0)).toBe('X could not be reached.');
		expect(failure('X', 401)).toBe('X refused the keys.');
		expect(failure('X', 500)).toBe('X answered HTTP 500.');
		await expect(call({ send: () => Promise.reject(new Error('boom')), now: () => NOW }, 'https://x', {})).rejects.toThrow(
			'boom',
		);
	});
});

describe('Stripe', () => {
	const keys = { secretKey: 'sk_test_abcdefghijkl', webhookSecret: 'whsec_abcdefghijkl' };
	const stripe = adapters.stripe;
	/** @param {object} event */
	const signed = (event) => {
		const body = JSON.stringify(event);
		return incoming({ 'stripe-signature': signTimestamped(body, keys.webhookSecret, NOW) }, body);
	};
	it('checks the keys', async () => {
		expect(stripe.violation(null)).toMatch(/secret key/);
		expect(stripe.violation({ secretKey: 'pk_x' })).toMatch(/sk_live_/);
		expect(stripe.violation({ secretKey: keys.secretKey, webhookSecret: 'x' })).toMatch(/whsec_/);
		expect(stripe.violation(keys)).toBeNull();
		expect(await stripe.test(keys, ctx)).toEqual({ ok: true });
		fake.respond('https://api.stripe.com', () => ({ status: 401 }));
		expect(await stripe.test(keys, ctx)).toEqual({ ok: false, message: 'Stripe refused the keys.' });
	});
	it('starts a Checkout Session and refuses when Stripe does', async () => {
		fake.respond('https://api.stripe.com', () => ({
			status: 200,
			body: { id: 'cs_1', url: 'https://checkout.stripe.com/c/1' },
		}));
		expect(await stripe.start({ payment: PAYMENT, keys, urls: URLS }, ctx)).toEqual({
			kind: 'redirect',
			url: 'https://checkout.stripe.com/c/1',
			ref: 'cs_1',
		});
		const sent = fake.calls.at(-1);
		expect(sent?.headers['stripe-version']).toBe('2024-06-20');
		expect(sent?.headers['idempotency-key']).toBe(`ss-${PAYMENT.id}`);
		const form = new URLSearchParams(sent?.body);
		expect(form.get('line_items[0][price_data][unit_amount]')).toBe('250000');
		expect(form.get('line_items[0][price_data][currency]')).toBe('pkr');
		expect(form.get('client_reference_id')).toBe(PAYMENT.id);
		expect(form.get('customer_email')).toBe('ana@example.com');
		fake.respond('https://api.stripe.com', () => ({ status: 400, body: { error: { message: 'Bad currency' } } }));
		expect(
			await stripe.start({ payment: { ...PAYMENT, customer: {}, description: '', reference: '' }, keys, urls: URLS }, ctx),
		).toEqual({
			kind: 'error',
			message: 'Bad currency',
		});
		fake.respond('https://api.stripe.com', () => ({ status: 500 }));
		expect(await stripe.start({ payment: PAYMENT, keys, urls: URLS }, ctx)).toMatchObject({ kind: 'error' });
	});
	it('reads signed webhooks: payments, subscriptions, other events', async () => {
		const session = {
			id: 'cs_1',
			client_reference_id: PAYMENT.id,
			payment_status: 'paid',
			amount_total: 250000,
			currency: 'pkr',
			payment_intent: 'pi_1',
		};
		expect(await stripe.notice?.(signed({ type: 'checkout.session.completed', data: { object: session } }), keys, ctx)).toEqual(
			{
				ok: true,
				news: [
					{
						kind: 'payment',
						paymentId: PAYMENT.id,
						ref: 'cs_1',
						outcome: 'paid',
						amount: 250000,
						currency: 'PKR',
						capture: 'pi_1',
					},
				],
			},
		);
		const failed = await stripe.notice?.(
			signed({
				type: 'checkout.session.async_payment_failed',
				data: { object: { ...session, payment_status: 'unpaid', payment_intent: { id: 'pi_2' } } },
			}),
			keys,
			ctx,
		);
		expect(failed).toMatchObject({ news: [{ outcome: 'failed', capture: 'pi_2' }] });
		const pending = await stripe.notice?.(
			signed({ type: 'checkout.session.completed', data: { object: { id: 'cs_9', payment_status: 'unpaid' } } }),
			keys,
			ctx,
		);
		expect(pending).toMatchObject({ news: [{ paymentId: null, outcome: 'pending', capture: null }] });
		expect(
			await stripe.notice?.(
				signed({
					type: 'checkout.session.completed',
					data: {
						object: { mode: 'subscription', client_reference_id: 'sub_1', subscription: 'sub_x', status: 'complete' },
					},
				}),
				keys,
				ctx,
			),
		).toEqual({ ok: true, news: [{ kind: 'subscription', subscriptionId: 'sub_1', ref: 'sub_x', status: 'active' }] });
		expect(
			await stripe.notice?.(
				signed({ type: 'checkout.session.completed', data: { object: { mode: 'subscription' } } }),
				keys,
				ctx,
			),
		).toMatchObject({ news: [{ subscriptionId: null, status: null }] });
		expect(
			await stripe.notice?.(
				signed({
					type: 'customer.subscription.deleted',
					data: { object: { id: 'sub_x', status: 'active', metadata: { ss_subscription: 'sub_1' } } },
				}),
				keys,
				ctx,
			),
		).toMatchObject({ news: [{ subscriptionId: 'sub_1', status: 'canceled' }] });
		expect(
			await stripe.notice?.(signed({ type: 'customer.subscription.updated', data: { object: {} } }), keys, ctx),
		).toMatchObject({
			news: [{ subscriptionId: null, status: null, ref: '' }],
		});
		expect(await stripe.notice?.(signed({ type: 'charge.refunded' }), keys, ctx)).toEqual({ ok: true, news: [] });
		expect(await stripe.notice?.(incoming({}, '{}'), keys, ctx)).toEqual({ ok: false });
		const bad = incoming({ 'stripe-signature': signTimestamped('nope', keys.webhookSecret, NOW) }, 'nope');
		expect(await stripe.notice?.(bad, keys, ctx)).toEqual({ ok: false });
	});
	it('asks a session, refunds and manages subscriptions', async () => {
		const withRef = { ...PAYMENT, gatewayRef: 'cs_1', captureRef: 'pi_1' };
		expect(await stripe.status?.(PAYMENT, keys, ctx)).toBeNull();
		fake.respond('https://api.stripe.com', (c) =>
			c.path.startsWith('/v1/checkout/sessions/cs_1')
				? {
						status: 200,
						body: {
							id: 'cs_1',
							client_reference_id: PAYMENT.id,
							payment_status: 'unpaid',
							status: 'expired',
							amount_total: 250000,
							currency: 'pkr',
						},
					}
				: { status: 404 },
		);
		expect(await stripe.status?.(withRef, keys, ctx)).toMatchObject({ outcome: 'cancelled' });
		expect(await stripe.returned?.(incoming(), withRef, keys, ctx)).toMatchObject({ news: { outcome: 'cancelled' } });
		expect(await stripe.status?.({ ...withRef, gatewayRef: 'cs_2' }, keys, ctx)).toBeNull();
		expect(await stripe.returned?.(incoming(), { ...withRef, gatewayRef: 'cs_2' }, keys, ctx)).toEqual({ news: null });

		expect(await stripe.refund({ payment: PAYMENT, amount: 100, reason: '', refundId: 'r1' }, keys, ctx)).toMatchObject({
			ok: false,
		});
		fake.respond('https://api.stripe.com', () => ({ status: 200, body: { id: 're_1', status: 'succeeded' } }));
		expect(await stripe.refund({ payment: withRef, amount: 100, reason: '', refundId: 'r1' }, keys, ctx)).toEqual({
			ok: true,
			ref: 're_1',
		});
		expect(new URLSearchParams(fake.calls.at(-1)?.body).get('amount')).toBe('100');
		fake.respond('https://api.stripe.com', () => ({ status: 200, body: { status: 'failed' } }));
		expect(await stripe.refund({ payment: withRef, amount: 100, reason: '', refundId: 'r1' }, keys, ctx)).toMatchObject({
			ok: false,
		});
		fake.respond('https://api.stripe.com', () => ({ status: 200, body: {} }));
		expect(await stripe.refund({ payment: withRef, amount: 100, reason: '', refundId: 'r1' }, keys, ctx)).toEqual({
			ok: true,
			ref: '',
		});

		const subscription = { id: 'sub_1', plan: 'price_1', customer: { email: 'a@b.co' }, gatewayRef: null };
		fake.respond('https://api.stripe.com', () => ({ status: 200, body: { id: 'cs_s', url: 'https://checkout.stripe.com/s' } }));
		expect(await stripe.subscribe?.({ subscription, keys, urls: URLS }, ctx)).toMatchObject({ kind: 'redirect', ref: 'cs_s' });
		expect(new URLSearchParams(fake.calls.at(-1)?.body).get('mode')).toBe('subscription');
		fake.respond('https://api.stripe.com', () => ({ status: 400, body: {} }));
		expect(await stripe.subscribe?.({ subscription: { ...subscription, customer: {} }, keys, urls: URLS }, ctx)).toMatchObject({
			kind: 'error',
		});

		expect(await stripe.subscriptionStatus?.(subscription, keys, ctx)).toBeNull();
		fake.respond('https://api.stripe.com', (c) =>
			c.path.startsWith('/v1/checkout/sessions/')
				? { status: 200, body: { subscription: { id: 'sub_x', status: 'active' } } }
				: c.path === '/v1/subscriptions/sub_x'
					? { status: 200, body: { id: 'sub_x', status: 'past_due' } }
					: { status: 200, body: { subscription: 'not-expanded' } },
		);
		expect(await stripe.subscriptionStatus?.({ ...subscription, gatewayRef: 'cs_s' }, keys, ctx)).toEqual({
			kind: 'subscription',
			subscriptionId: 'sub_1',
			ref: 'sub_x',
			status: 'active',
		});
		expect(await stripe.subscriptionStatus?.({ ...subscription, gatewayRef: 'sub_x' }, keys, ctx)).toMatchObject({
			status: 'past_due',
		});
		fake.respond('https://api.stripe.com', () => ({ status: 200, body: { subscription: 'x' } }));
		expect(await stripe.subscriptionStatus?.({ ...subscription, gatewayRef: 'cs_s' }, keys, ctx)).toBeNull();
		fake.respond('https://api.stripe.com', () => ({ status: 200, body: {} }));
		expect(await stripe.subscriptionStatus?.({ ...subscription, gatewayRef: 'sub_y' }, keys, ctx)).toMatchObject({
			status: null,
		});
		fake.respond('https://api.stripe.com', () => ({ status: 500 }));
		expect(await stripe.subscriptionStatus?.({ ...subscription, gatewayRef: 'sub_y' }, keys, ctx)).toBeNull();

		expect(await stripe.cancelSubscription?.(subscription, keys, ctx)).toMatchObject({ ok: false });
		expect(await stripe.cancelSubscription?.({ ...subscription, gatewayRef: 'sub_x' }, keys, ctx)).toMatchObject({ ok: false });
		fake.respond('https://api.stripe.com', () => ({ status: 200, body: { status: 'canceled' } }));
		expect(await stripe.cancelSubscription?.({ ...subscription, gatewayRef: 'sub_x' }, keys, ctx)).toEqual({ ok: true });
		expect(fake.calls.at(-1)?.method).toBe('DELETE');
	});
});

describe('PayPal', () => {
	const keys = { clientId: 'client', secret: 'secret', webhookId: 'WH-1', sandbox: true };
	const paypal = adapters.paypal;
	const API = 'https://api-m.sandbox.paypal.com';
	/** @param {(c: import('./helpers.js').GatewayCall) => any} answer */
	const paypalAnswers = (answer) =>
		fake.respond(API, (c) => (c.path === '/v1/oauth2/token' ? { status: 200, body: { access_token: 'tok' } } : answer(c)));
	it('checks the keys and gets a token', async () => {
		expect(paypal.violation(null)).toMatch(/client id/);
		expect(paypal.violation({ clientId: 'a', secret: 'b' })).toBe('Fill in: webhookId.');
		expect(paypal.violation({ ...keys, sandbox: 'yes' })).toMatch(/sandbox/);
		expect(paypal.violation(keys)).toBeNull();
		paypalAnswers(() => ({ status: 200 }));
		expect(await paypal.test(keys, ctx)).toEqual({ ok: true });
		expect(fake.calls.at(-1)?.headers.authorization).toBe(`Basic ${Buffer.from('client:secret').toString('base64')}`);
		fake.respond('https://api-m.paypal.com', () => ({ status: 401 }));
		expect(await paypal.test({ ...keys, sandbox: false }, ctx)).toEqual({ ok: false, message: 'PayPal refused the keys.' });
	});
	it('creates an order and captures it when the payer returns', async () => {
		paypalAnswers(() => ({
			status: 201,
			body: { id: 'ORDER1', links: [{ rel: 'payer-action', href: 'https://paypal.test/approve' }] },
		}));
		const payment = { ...PAYMENT, currency: 'USD', amount: 1050 };
		expect(await paypal.start({ payment, keys, urls: URLS }, ctx)).toEqual({
			kind: 'redirect',
			url: 'https://paypal.test/approve',
			ref: 'ORDER1',
		});
		const order = JSON.parse(fake.calls.at(-1)?.body ?? '{}');
		expect(order.purchase_units[0]).toMatchObject({ custom_id: PAYMENT.id, amount: { currency_code: 'USD', value: '10.50' } });
		paypalAnswers(() => ({ status: 422, body: {} }));
		expect(await paypal.start({ payment: { ...payment, description: '' }, keys, urls: URLS }, ctx)).toMatchObject({
			kind: 'error',
		});

		const withRef = { ...payment, gatewayRef: 'ORDER1' };
		expect(await paypal.status?.(payment, keys, ctx)).toBeNull();
		const captured = {
			id: 'ORDER1',
			status: 'COMPLETED',
			purchase_units: [
				{ payments: { captures: [{ id: 'CAP1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '10.50' } }] } },
			],
		};
		paypalAnswers((c) =>
			c.method === 'GET' ? { status: 200, body: { id: 'ORDER1', status: 'APPROVED' } } : { status: 201, body: captured },
		);
		expect(await paypal.returned?.(incoming(), withRef, keys, ctx)).toEqual({
			news: {
				kind: 'payment',
				paymentId: payment.id,
				ref: 'ORDER1',
				outcome: 'paid',
				amount: 1050,
				currency: 'USD',
				capture: 'CAP1',
			},
		});
		paypalAnswers((c) => (c.method === 'GET' ? { status: 200, body: { id: 'ORDER1', status: 'APPROVED' } } : { status: 500 }));
		expect(await paypal.status?.(withRef, keys, ctx)).toBeNull();
		paypalAnswers(() => ({
			status: 200,
			body: { id: 'ORDER1', status: 'VOIDED', purchase_units: [{ amount: { currency_code: 'USD', value: '10.50' } }] },
		}));
		expect(await paypal.status?.(withRef, keys, ctx)).toMatchObject({ outcome: 'cancelled', capture: null });
		paypalAnswers(() => ({
			status: 200,
			body: { status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ status: 'DECLINED' }] } }] },
		}));
		expect(await paypal.status?.(withRef, keys, ctx)).toMatchObject({ outcome: 'failed' });
		paypalAnswers(() => ({ status: 200, body: { status: 'CREATED' } }));
		expect(await paypal.status?.(withRef, keys, ctx)).toMatchObject({ outcome: 'pending' });
		paypalAnswers(() => ({ status: 404 }));
		expect(await paypal.status?.(withRef, keys, ctx)).toBeNull();
		fake.respond(API, () => ({ status: 500 }));
		expect(await paypal.status?.(withRef, keys, ctx)).toBeNull();
	});
	it('verifies webhooks with PayPal and reads captures and subscriptions', async () => {
		/** @param {object} event */
		const hook = (event) => incoming({ 'paypal-transmission-id': 't1' }, JSON.stringify(event));
		paypalAnswers((c) => ({
			status: 200,
			body: { verification_status: JSON.parse(c.body).transmission_id === 't1' ? 'SUCCESS' : 'FAILURE' },
		}));
		expect(
			await paypal.notice?.(
				hook({
					event_type: 'PAYMENT.CAPTURE.COMPLETED',
					resource: {
						id: 'CAP1',
						custom_id: PAYMENT.id,
						amount: { currency_code: 'USD', value: '10.50' },
						supplementary_data: { related_ids: { order_id: 'ORDER1' } },
					},
				}),
				keys,
				ctx,
			),
		).toEqual({
			ok: true,
			news: [
				{
					kind: 'payment',
					paymentId: PAYMENT.id,
					ref: 'ORDER1',
					outcome: 'paid',
					amount: 1050,
					currency: 'USD',
					capture: 'CAP1',
				},
			],
		});
		expect(await paypal.notice?.(hook({ event_type: 'PAYMENT.CAPTURE.DENIED', resource: {} }), keys, ctx)).toMatchObject({
			news: [{ paymentId: null, outcome: 'failed', capture: null, ref: null }],
		});
		expect(
			await paypal.notice?.(
				hook({ event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I-1', custom_id: 'sub_1', status: 'ACTIVE' } }),
				keys,
				ctx,
			),
		).toEqual({ ok: true, news: [{ kind: 'subscription', subscriptionId: 'sub_1', ref: 'I-1', status: 'ACTIVE' }] });
		expect(
			await paypal.notice?.(hook({ event_type: 'BILLING.SUBSCRIPTION.CANCELLED', resource: {} }), keys, ctx),
		).toMatchObject({
			news: [{ subscriptionId: null, ref: '', status: null }],
		});
		expect(await paypal.notice?.(hook({ event_type: 'CUSTOMER.DISPUTE.CREATED' }), keys, ctx)).toEqual({ ok: true, news: [] });
		expect(await paypal.notice?.(incoming({ 'paypal-transmission-id': 'forged' }, '{}'), keys, ctx)).toEqual({ ok: false });
		expect(await paypal.notice?.(incoming({}, 'not json'), keys, ctx)).toEqual({ ok: false });
	});
	it('refunds captures and manages subscriptions', async () => {
		const withCapture = { ...PAYMENT, currency: 'USD', captureRef: 'CAP1' };
		expect(await paypal.refund({ payment: PAYMENT, amount: 1, reason: '', refundId: 'r' }, keys, ctx)).toMatchObject({
			ok: false,
		});
		paypalAnswers(() => ({ status: 201, body: { id: 'REF1', status: 'COMPLETED' } }));
		expect(await paypal.refund({ payment: withCapture, amount: 500, reason: 'Returned', refundId: 'r' }, keys, ctx)).toEqual({
			ok: true,
			ref: 'REF1',
		});
		expect(JSON.parse(fake.calls.at(-1)?.body ?? '{}')).toEqual({
			amount: { value: '5.00', currency_code: 'USD' },
			note_to_payer: 'Returned',
		});
		paypalAnswers(() => ({ status: 201, body: { status: 'FAILED' } }));
		expect(await paypal.refund({ payment: withCapture, amount: 500, reason: '', refundId: 'r' }, keys, ctx)).toMatchObject({
			ok: false,
		});

		const subscription = { id: 'sub_1', plan: 'P-1', customer: { email: 'a@b.co' }, gatewayRef: null };
		paypalAnswers(() => ({ status: 201, body: { id: 'I-1', links: [{ rel: 'approve', href: 'https://paypal.test/sub' }] } }));
		expect(await paypal.subscribe?.({ subscription, keys, urls: URLS }, ctx)).toEqual({
			kind: 'redirect',
			url: 'https://paypal.test/sub',
			ref: 'I-1',
		});
		paypalAnswers(() => ({ status: 201, body: { id: 'I-1', links: 'none' } }));
		expect(await paypal.subscribe?.({ subscription: { ...subscription, customer: {} }, keys, urls: URLS }, ctx)).toMatchObject({
			kind: 'error',
		});
		expect(await paypal.subscriptionStatus?.(subscription, keys, ctx)).toBeNull();
		paypalAnswers(() => ({ status: 200, body: { status: 'ACTIVE' } }));
		expect(await paypal.subscriptionStatus?.({ ...subscription, gatewayRef: 'I-1' }, keys, ctx)).toMatchObject({
			status: 'ACTIVE',
		});
		paypalAnswers(() => ({ status: 200, body: {} }));
		expect(await paypal.subscriptionStatus?.({ ...subscription, gatewayRef: 'I-1' }, keys, ctx)).toMatchObject({
			status: null,
		});
		paypalAnswers(() => ({ status: 404 }));
		expect(await paypal.subscriptionStatus?.({ ...subscription, gatewayRef: 'I-1' }, keys, ctx)).toBeNull();
		expect(await paypal.cancelSubscription?.({ ...subscription, gatewayRef: 'I-1' }, keys, ctx)).toMatchObject({ ok: false });
		paypalAnswers(() => ({ status: 204 }));
		expect(await paypal.cancelSubscription?.({ ...subscription, gatewayRef: 'I-1' }, keys, ctx)).toEqual({ ok: true });
	});
});

describe('PayFast', () => {
	const keys = { merchantId: '10000100', merchantKey: '46f0cd694581a', passphrase: 'jt7NOE43FZPn', sandbox: true };
	const payfast = adapters.payfast;
	it('checks the keys and pings the API with a signature', async () => {
		expect(payfast.violation(null)).toMatch(/merchant id/);
		expect(payfast.violation({ merchantId: 'x' })).toMatch(/number/);
		expect(payfast.violation({ merchantId: '10000100', merchantKey: '' })).toMatch(/merchant key/);
		expect(payfast.violation({ merchantId: '10000100', merchantKey: 'abcdefg', passphrase: 'short' })).toMatch(/passphrase/);
		expect(payfast.violation({ ...keys, sandbox: 1 })).toMatch(/sandbox/);
		expect(payfast.violation(keys)).toBeNull();
		expect(await payfast.test(keys, ctx)).toEqual({ ok: true });
		const ping = fake.calls.at(-1);
		expect(ping?.path).toBe('/ping?testing=true');
		const head = { 'merchant-id': keys.merchantId, version: 'v1', timestamp: ping?.headers.timestamp ?? '' };
		expect(ping?.headers.signature).toBe(apiSignature(head, keys.passphrase));
		fake.respond('https://api.payfast.co.za', () => ({ status: 401 }));
		expect(await payfast.test({ ...keys, sandbox: false }, ctx)).toMatchObject({ ok: false });
	});
	it('signs the payment form in field order with the passphrase', async () => {
		const started = await payfast.start({ payment: { ...PAYMENT, currency: 'ZAR' }, keys, urls: URLS }, ctx);
		if (started.kind !== 'form') throw new Error('form expected');
		expect(started.action).toBe('https://sandbox.payfast.co.za/eng/process');
		const fields = Object.fromEntries(started.fields);
		expect(fields).toMatchObject({
			amount: '2500.00',
			m_payment_id: PAYMENT.id,
			name_first: 'Ana',
			name_last: 'Khan',
			notify_url: URLS.notify,
		});
		const text = started.fields
			.filter(([name]) => name !== 'signature')
			.map(([name, value]) => `${name}=${phpUrlencode(value)}`)
			.join('&');
		expect(fields.signature).toBe(
			createHash('md5')
				.update(`${text}&passphrase=${phpUrlencode(keys.passphrase)}`)
				.digest('hex'),
		);
		const bare = await payfast.start(
			{ payment: { ...PAYMENT, customer: {}, description: '', reference: '' }, keys: { ...keys, sandbox: false }, urls: URLS },
			ctx,
		);
		expect(bare.kind === 'form' && bare.action).toBe('https://www.payfast.co.za/eng/process');
		expect(formSignature([['a', 'x y']], '')).toBe(createHash('md5').update('a=x+y').digest('hex'));
	});
	it('accepts an ITN only when signed, from this merchant and valid at PayFast', async () => {
		/** @type {Array<[string, string]>} */
		const fields = [
			['m_payment_id', PAYMENT.id],
			['pf_payment_id', '1089250'],
			['payment_status', 'COMPLETE'],
			['amount_gross', '2500.00'],
			['merchant_id', keys.merchantId],
		];
		/** @param {Array<[string, string]>} list */
		const body = (list) => new URLSearchParams([...list, ['signature', formSignature(list, keys.passphrase)]]).toString();
		fake.respond('https://sandbox.payfast.co.za', () => ({ status: 200, body: 'VALID' }));
		expect(await payfast.notice?.(incoming({}, body(fields)), keys, ctx)).toEqual({
			ok: true,
			news: [
				{
					kind: 'payment',
					paymentId: PAYMENT.id,
					ref: PAYMENT.id,
					outcome: 'paid',
					amount: 250000,
					currency: 'ZAR',
					capture: '1089250',
				},
			],
		});
		expect(fake.calls.at(-1)?.path).toBe('/eng/query/validate');
		for (const [status, outcome] of [
			['CANCELLED', 'cancelled'],
			['FAILED', 'failed'],
			['PENDING', 'pending'],
		]) {
			const list = /** @type {Array<[string, string]>} */ (fields.map(([n, v]) => [n, n === 'payment_status' ? status : v]));
			expect(await payfast.notice?.(incoming({}, body(list)), keys, ctx)).toMatchObject({ news: [{ outcome }] });
		}
		/** @type {Array<[string, string]>} */
		const sparse = [['merchant_id', keys.merchantId]];
		expect(await payfast.notice?.(incoming({}, body(sparse)), keys, ctx)).toMatchObject({
			news: [{ paymentId: null, capture: null }],
		});
		fake.respond('https://sandbox.payfast.co.za', () => ({ status: 200, body: 'INVALID' }));
		expect(await payfast.notice?.(incoming({}, body(fields)), keys, ctx)).toEqual({ ok: false });
		expect(await payfast.notice?.(incoming({}, `${body(fields)}x`), keys, ctx)).toEqual({ ok: false });
		expect(await payfast.notice?.(incoming({}, 'a=1'), keys, ctx)).toEqual({ ok: false });
	});
	it('refunds through the API', async () => {
		expect(await payfast.refund({ payment: PAYMENT, amount: 100, reason: '', refundId: 'r' }, keys, ctx)).toMatchObject({
			ok: false,
		});
		const paid = { ...PAYMENT, captureRef: '1089250' };
		expect(await payfast.refund({ payment: paid, amount: 100, reason: '', refundId: 'r' }, keys, ctx)).toEqual({
			ok: true,
			ref: '1089250',
		});
		const sent = fake.calls.at(-1);
		expect(sent?.path).toBe('/refunds/1089250?testing=true');
		expect(new URLSearchParams(sent?.body).get('amount')).toBe('100');
		fake.respond('https://api.payfast.co.za', () => ({ status: 400, body: { data: { message: 'Too much' } } }));
		expect(await payfast.refund({ payment: paid, amount: 100, reason: 'x', refundId: 'r' }, keys, ctx)).toEqual({
			ok: false,
			message: 'Too much',
		});
		fake.respond('https://api.payfast.co.za', () => ({ status: 500 }));
		expect(await payfast.refund({ payment: paid, amount: 100, reason: 'x', refundId: 'r' }, keys, ctx)).toMatchObject({
			ok: false,
		});
	});
});

describe('JazzCash', () => {
	const keys = { merchantId: 'MC123', password: 'pass', integritySalt: 'salt123', sandbox: true };
	const jazzcash = adapters.jazzcash;
	it('checks the keys by their shape', async () => {
		expect(jazzcash.violation(null)).toMatch(/merchant id/);
		expect(jazzcash.violation({ merchantId: 'x' })).toBe('Fill in: password.');
		expect(jazzcash.violation({ ...keys, sandbox: 'no' })).toMatch(/sandbox/);
		expect(await jazzcash.test(keys, ctx)).toEqual({ ok: true });
		expect(await jazzcash.test({}, ctx)).toMatchObject({ ok: false });
	});
	it('signs the request form and records refunds by hand', async () => {
		expect(pakistanTime(NOW)).toBe('20261001150000');
		expect(shortRef(PAYMENT.id, 'T')).toBe('Tabcdefghijklmnopqrs');
		const started = await jazzcash.start({ payment: PAYMENT, keys, urls: URLS }, ctx);
		if (started.kind !== 'form') throw new Error('form expected');
		const fields = Object.fromEntries(started.fields);
		expect(fields).toMatchObject({
			pp_Amount: '250000',
			pp_TxnRefNo: 'Tabcdefghijklmnopqrs',
			pp_BillReference: 'order1042',
			pp_ReturnURL: URLS.return,
		});
		const values = Object.keys(fields)
			.filter((n) => n !== 'pp_SecureHash' && fields[n] !== '')
			.sort()
			.map((n) => fields[n]);
		expect(fields.pp_SecureHash).toBe(
			createHmac('sha256', keys.integritySalt)
				.update([keys.integritySalt, ...values].join('&'))
				.digest('hex')
				.toUpperCase(),
		);
		expect(started.action).toContain('sandbox.jazzcash.com.pk');
		const live = await jazzcash.start(
			{ payment: { ...PAYMENT, reference: '', description: '' }, keys: { ...keys, sandbox: false }, urls: URLS },
			ctx,
		);
		expect(live.kind === 'form' && Object.fromEntries(live.fields)).toMatchObject({
			pp_BillReference: 'payment',
			pp_Description: 'Payment',
		});
		expect(await jazzcash.refund({ payment: PAYMENT, amount: 1, reason: '', refundId: 'r' }, keys, ctx)).toEqual({
			ok: true,
			manual: true,
		});
	});
	it('trusts a return only with a valid hash, the payment’s reference and its code', async () => {
		const payment = { ...PAYMENT, gatewayRef: 'Tabcdefghijklmnopqrs' };
		/** @param {Record<string, string>} fields */
		const post = (fields) =>
			incoming({}, new URLSearchParams({ ...fields, pp_SecureHash: secureHash(fields, keys.integritySalt) }).toString());
		const answer = {
			pp_TxnRefNo: payment.gatewayRef,
			pp_Amount: '250000',
			pp_TxnCurrency: 'PKR',
			pp_ResponseCode: '000',
			pp_RetreivalReferenceNo: 'R1',
		};
		expect(await jazzcash.returned?.(post(answer), payment, keys, ctx)).toEqual({
			news: {
				kind: 'payment',
				paymentId: payment.id,
				ref: payment.gatewayRef,
				outcome: 'paid',
				amount: 250000,
				currency: 'PKR',
				capture: 'R1',
			},
		});
		expect(
			await jazzcash.returned?.(
				post({ ...answer, pp_ResponseCode: '124', pp_TxnCurrency: '', pp_RetreivalReferenceNo: '' }),
				payment,
				keys,
				ctx,
			),
		).toMatchObject({
			news: { outcome: 'pending', currency: 'PKR', capture: payment.gatewayRef },
		});
		expect(await jazzcash.returned?.(post({ ...answer, pp_ResponseCode: '199' }), payment, keys, ctx)).toMatchObject({
			news: { outcome: 'failed' },
		});
		expect(await jazzcash.returned?.(post({ ...answer, pp_TxnRefNo: 'Tother' }), payment, keys, ctx)).toEqual({ news: null });
		expect(await jazzcash.returned?.(incoming({}, 'pp_Amount=1&pp_SecureHash=ABC'), payment, keys, ctx)).toEqual({
			news: null,
		});
		expect(await jazzcash.returned?.(incoming({}, 'pp_Amount=1'), payment, keys, ctx)).toEqual({ news: null });
	});
});

describe('Easypaisa', () => {
	const keys = {
		storeId: '12345',
		hashKey: '0123456789ABCDEF',
		username: 'user',
		password: 'pw',
		accountNum: '987',
		sandbox: true,
	};
	const easypaisa = adapters.easypaisa;
	it('checks the keys by their shape', async () => {
		expect(easypaisa.violation(null)).toMatch(/store id/);
		expect(easypaisa.violation({ storeId: 'x' })).toMatch(/number/);
		expect(easypaisa.violation({ storeId: '1', hashKey: 'short' })).toMatch(/16/);
		expect(easypaisa.violation({ storeId: '1', hashKey: keys.hashKey })).toBe('Fill in: username.');
		expect(easypaisa.violation({ ...keys, sandbox: 0 })).toMatch(/sandbox/);
		expect(await easypaisa.test(keys, ctx)).toEqual({ ok: true });
		expect(await easypaisa.test({}, ctx)).toMatchObject({ ok: false });
	});
	it('encrypts the sorted request and hands the token on to the confirm page', async () => {
		const started = await easypaisa.start({ payment: PAYMENT, keys, urls: URLS }, ctx);
		if (started.kind !== 'form') throw new Error('form expected');
		const fields = Object.fromEntries(started.fields);
		expect(fields).toMatchObject({
			amount: '2500.00',
			orderRefNum: 'Eabcdefghijklmnopqrs',
			mobileNum: '03001234567',
			emailAddr: 'ana@example.com',
		});
		const decipher = createDecipheriv('aes-128-ecb', Buffer.from(keys.hashKey), null);
		const plain = Buffer.concat([
			decipher.update(Buffer.from(String(fields.merchantHashedReq), 'base64')),
			decipher.final(),
		]).toString();
		expect(plain.startsWith('amount=2500.00&autoRedirect=1&emailAddr=ana@example.com&expiryDate=')).toBe(true);
		expect(hashedRequest({ b: '1', a: '2' }, keys.hashKey)).toBe(hashedRequest({ a: '2', b: '1' }, keys.hashKey));
		const bare = await easypaisa.start(
			{ payment: { ...PAYMENT, customer: { phone: '+15551234567' } }, keys: { ...keys, sandbox: false }, urls: URLS },
			ctx,
		);
		expect(bare.kind === 'form' && bare.action).toBe('https://easypay.easypaisa.com.pk/easypay/Index.jsf');
		expect(bare.kind === 'form' && Object.fromEntries(bare.fields).mobileNum).toBeUndefined();
		const payment = { ...PAYMENT, gatewayRef: 'Eabcdefghijklmnopqrs' };
		const next = await easypaisa.returned?.(
			{ ...incoming({}, '', { auth_token: 'tok' }), self: 'https://pay.test/r' },
			payment,
			keys,
			ctx,
		);
		expect(next).toEqual({
			news: null,
			next: {
				kind: 'form',
				action: 'https://easypaystg.easypaisa.com.pk/easypay/Confirm.jsf',
				fields: [
					['auth_token', 'tok'],
					['postBackURL', 'https://pay.test/r'],
				],
				ref: payment.gatewayRef,
			},
		});
		expect(await easypaisa.returned?.(incoming({}, 'auth_token=tok'), payment, keys, ctx)).toMatchObject({
			next: {
				fields: [
					['auth_token', 'tok'],
					['postBackURL', ''],
				],
			},
		});
		expect(await easypaisa.refund({ payment, amount: 1, reason: '', refundId: 'r' }, keys, ctx)).toEqual({
			ok: true,
			manual: true,
		});
	});
	it('asks Easypay whether it was paid', async () => {
		const payment = { ...PAYMENT, gatewayRef: 'Eabcdefghijklmnopqrs' };
		expect(await easypaisa.status?.(PAYMENT, keys, ctx)).toBeNull();
		fake.respond('https://easypaystg.easypaisa.com.pk', () => ({
			status: 200,
			body: { responseCode: '0000', transactionStatus: 'PAID', transactionAmount: '2500.0', transactionId: 'X1' },
		}));
		expect(await easypaisa.returned?.(incoming({}, '', { status: '0000' }), payment, keys, ctx)).toEqual({
			news: {
				kind: 'payment',
				paymentId: payment.id,
				ref: payment.gatewayRef,
				outcome: 'paid',
				amount: 250000,
				currency: 'PKR',
				capture: 'X1',
			},
		});
		const sent = fake.calls.at(-1);
		expect(sent?.headers.credentials).toBe(Buffer.from('user:pw').toString('base64'));
		expect(JSON.parse(sent?.body ?? '{}')).toEqual({ orderId: payment.gatewayRef, storeId: '12345', accountNum: '987' });
		fake.respond('https://easypaystg.easypaisa.com.pk', () => ({
			status: 200,
			body: { responseCode: '0000', transactionStatus: 'FAILED' },
		}));
		expect(await easypaisa.status?.(payment, keys, ctx)).toMatchObject({ outcome: 'failed', capture: payment.gatewayRef });
		fake.respond('https://easypaystg.easypaisa.com.pk', () => ({ status: 200, body: { responseCode: '0000' } }));
		expect(await easypaisa.status?.(payment, keys, ctx)).toMatchObject({ outcome: 'pending' });
		fake.respond('https://easypaystg.easypaisa.com.pk', () => ({ status: 200, body: { responseCode: '0001' } }));
		expect(await easypaisa.status?.(payment, keys, ctx)).toBeNull();
	});
});

describe('generic adapter', () => {
	const keys = {
		name: 'PayNow',
		url: 'https://gateway.example.org/checkout',
		secret: 's'.repeat(24),
		refundUrl: 'https://gateway.example.org/refund',
		currencies: 'usd, EUR, x',
	};
	const generic = adapters.generic;
	it('checks the connection', async () => {
		expect(generic.violation(null)).toMatch(/name/);
		expect(generic.violation({ name: '' })).toMatch(/name/);
		expect(generic.violation({ name: 'x', url: 'http://gateway.example.org' })).toMatch(/https/);
		expect(generic.violation({ name: 'x', url: keys.url, secret: 'short' })).toMatch(/24/);
		expect(generic.violation({ ...keys, refundUrl: 'ftp://x' })).toMatch(/refund/);
		expect(generic.violation({ ...keys, currencies: 5 })).toMatch(/Currencies/);
		expect(generic.violation({ ...keys, refundUrl: '' })).toBeNull();
		expect(await generic.test(keys, ctx)).toEqual({ ok: true });
		expect(await generic.test({}, ctx)).toMatchObject({ ok: false });
		expect(genericCurrencies(keys)).toEqual(['USD', 'EUR']);
		expect(genericCurrencies(null)).toEqual([]);
	});
	it('signs the checkout fields and reads signed notices', async () => {
		const started = await generic.start({ payment: PAYMENT, keys, urls: URLS }, ctx);
		if (started.kind !== 'form') throw new Error('form expected');
		const fields = Object.fromEntries(started.fields);
		expect(fields.signature).toBe(checkoutSignature(fields, keys.secret));
		expect(started.action).toBe(keys.url);
		/** @param {unknown} body */
		const post = (body) => {
			const text = JSON.stringify(body);
			return incoming({ 'ss-signature': signTimestamped(text, keys.secret, NOW) }, text);
		};
		expect(
			await generic.notice?.(
				post({ paymentId: PAYMENT.id, status: 'paid', amount: 250000, currency: 'PKR', reference: 'G1' }),
				keys,
				ctx,
			),
		).toEqual({
			ok: true,
			news: [
				{
					kind: 'payment',
					paymentId: PAYMENT.id,
					ref: 'G1',
					outcome: 'paid',
					amount: 250000,
					currency: 'PKR',
					capture: 'G1',
				},
			],
		});
		expect(await generic.notice?.(post({ paymentId: PAYMENT.id, status: 'failed' }), keys, ctx)).toEqual({
			ok: true,
			news: [{ kind: 'payment', paymentId: PAYMENT.id, ref: null, outcome: 'failed', capture: null }],
		});
		expect(await generic.notice?.(post({ paymentId: PAYMENT.id, status: 'maybe' }), keys, ctx)).toEqual({ ok: false });
		expect(
			await generic.notice?.(incoming({ 'ss-signature': signTimestamped('x', keys.secret, NOW) }, 'x'), keys, ctx),
		).toEqual({ ok: false });
		expect(await generic.notice?.(incoming({}, '{}'), keys, ctx)).toEqual({ ok: false });
	});
	it('refunds at the refund address, or records them', async () => {
		const paid = { ...PAYMENT, captureRef: 'G1' };
		expect(
			await generic.refund({ payment: paid, amount: 5, reason: 'x', refundId: 'r1' }, { ...keys, refundUrl: '' }, ctx),
		).toEqual({ ok: true, manual: true });
		fake.respond('https://gateway.example.org', () => ({ status: 200, body: { reference: 'GR1' } }));
		expect(await generic.refund({ payment: paid, amount: 5, reason: 'x', refundId: 'r1' }, keys, ctx)).toEqual({
			ok: true,
			ref: 'GR1',
		});
		const sent = fake.calls.at(-1);
		expect(
			verifyTimestamped({
				header: sent?.headers['ss-signature'] ?? null,
				body: sent?.body ?? '',
				secret: keys.secret,
				now: NOW,
			}),
		).toBe(true);
		fake.respond('https://gateway.example.org', () => ({ status: 200, body: 'ok' }));
		expect(await generic.refund({ payment: PAYMENT, amount: 5, reason: '', refundId: 'r1' }, keys, ctx)).toEqual({
			ok: true,
			ref: 'r1',
		});
		fake.respond('https://gateway.example.org', () => ({ status: 500 }));
		expect(await generic.refund({ payment: paid, amount: 5, reason: '', refundId: 'r1' }, keys, ctx)).toMatchObject({
			ok: false,
		});
	});
});
