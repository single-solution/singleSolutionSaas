import { describe, expect, it } from 'vitest';
import { GATEWAYS, gatewaysFor, isGateway, takesCurrency } from '../core/gateways.js';
import { MAX_AMOUNT, exponentOf, formatMoney, fromDecimal, isAmount, isCurrency, toDecimal } from '../core/money.js';
import {
	checkCustomer,
	checkLinkInput,
	checkMetadata,
	checkPaymentInput,
	checkSubscriptionInput,
	cleanText,
	isConfirmedFor,
	linkView,
	mirrorStatus,
	paymentView,
	paymentsCsv,
	refundAmount,
	statusAfterRefund,
	subscriptionView,
} from '../core/payments.js';
import { callbackUrls, createSnippets } from '../core/snippets.js';

describe('money', () => {
	it('checks amounts and currencies', () => {
		expect(isCurrency('PKR')).toBe(true);
		expect(isCurrency('pkr')).toBe(false);
		expect(isAmount(1)).toBe(true);
		expect(isAmount(0)).toBe(false);
		expect(isAmount(1.5)).toBe(false);
		expect(isAmount(MAX_AMOUNT + 1)).toBe(false);
	});
	it('turns minor units into decimals and back, by the currency exponent', () => {
		expect(exponentOf('JPY')).toBe(0);
		expect(exponentOf('KWD')).toBe(3);
		expect(exponentOf('USD')).toBe(2);
		expect(toDecimal(1050, 'PKR')).toBe('10.50');
		expect(toDecimal(5, 'USD')).toBe('0.05');
		expect(toDecimal(500, 'JPY')).toBe('500');
		expect(toDecimal(1234, 'KWD')).toBe('1.234');
		expect(fromDecimal('10.5', 'PKR')).toBe(1050);
		expect(fromDecimal('10.500', 'PKR')).toBe(1050);
		expect(fromDecimal(10, 'USD')).toBe(1000);
		expect(fromDecimal('500', 'JPY')).toBe(500);
		expect(fromDecimal('10.505', 'PKR')).toBeNull();
		expect(fromDecimal('abc', 'PKR')).toBeNull();
		expect(fromDecimal('0', 'PKR')).toBeNull();
		expect(fromDecimal(undefined, 'PKR')).toBeNull();
	});
	it('formats for people without assuming a locale', () => {
		expect(formatMoney(125000, 'PKR')).toBe('PKR 1,250.00');
		expect(formatMoney(1234567, 'JPY')).toBe('JPY 1,234,567');
	});
});

describe('gateways', () => {
	it('knows each gateway and its currencies', () => {
		expect(GATEWAYS).toContain('generic');
		expect(isGateway('stripe')).toBe(true);
		expect(isGateway('cash')).toBe(false);
		expect(takesCurrency('stripe', 'XYZ')).toBe(true);
		expect(takesCurrency('jazzcash', 'USD')).toBe(false);
		expect(takesCurrency('paypal', 'USD')).toBe(true);
		expect(takesCurrency('generic', 'USD', ['EUR'])).toBe(false);
		expect(takesCurrency('generic', 'USD', [])).toBe(true);
	});
	it('offers the switched-on, ready gateways that take the currency, optionally only a link’s own', () => {
		const on = ['stripe', 'jazzcash', 'bank_transfer', 'generic_gateway'];
		const ready = (/** @type {string} */ g) => g !== 'generic';
		expect(gatewaysFor({ on, ready, currency: 'PKR' })).toEqual(['stripe', 'jazzcash', 'bank_transfer']);
		expect(gatewaysFor({ on, ready, currency: 'USD' })).toEqual(['stripe', 'bank_transfer']);
		expect(gatewaysFor({ on, ready, currency: 'PKR', only: ['jazzcash'] })).toEqual(['jazzcash']);
	});
});

describe('payments', () => {
	it('cleans text and checks the payer', () => {
		expect(cleanText(' a\u0000b ', 10)).toBe('a b');
		expect(cleanText(5, 10)).toBeNull();
		expect(cleanText('x'.repeat(11), 10)).toBeNull();
		expect(cleanText(undefined, 10)).toBe('');
		expect(checkCustomer({ name: 'Ana', email: 'Ana@Example.com', phone: '+92 300 1234567', id: 'u1' })).toEqual({
			ok: true,
			value: { id: 'u1', name: 'Ana', email: 'ana@example.com', phone: '+923001234567' },
		});
		expect(checkCustomer(null)).toEqual({ ok: true, value: {} });
		expect(checkCustomer('x')).toMatchObject({ ok: false, field: 'customer' });
		expect(checkCustomer({ id: 'x'.repeat(200) })).toMatchObject({ ok: false, field: 'customer/id' });
		expect(checkCustomer({ name: 'x'.repeat(200) })).toMatchObject({ ok: false, field: 'customer/name' });
		expect(checkCustomer({ email: 'nope' })).toMatchObject({ ok: false, field: 'customer/email' });
		expect(checkCustomer({ phone: '0300' })).toMatchObject({ ok: false, field: 'customer/phone' });
	});
	it('checks metadata', () => {
		expect(checkMetadata({ order: '1' })).toEqual({ ok: true, value: { order: '1' } });
		expect(checkMetadata(undefined)).toEqual({ ok: true, value: {} });
		expect(checkMetadata([])).toMatchObject({ ok: false });
		expect(checkMetadata({ 'bad name': 'x' })).toMatchObject({ ok: false });
		expect(checkMetadata(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v'])))).toMatchObject({
			ok: false,
		});
	});
	it('checks a new payment', () => {
		const ok = checkPaymentInput({ amount: 1000, currency: 'PKR', description: 'Order', returnUrl: 'https://x' });
		expect(ok).toMatchObject({ ok: true, value: { amount: 1000, gateway: null, cancelUrl: null } });
		expect(checkPaymentInput({ amount: 0, currency: 'PKR' })).toMatchObject({ ok: false, field: 'amount' });
		expect(checkPaymentInput({ amount: 1, currency: 'rs' })).toMatchObject({ ok: false, field: 'currency' });
		expect(checkPaymentInput({ amount: 1, currency: 'PKR', gateway: 'cash' })).toMatchObject({ ok: false, field: 'gateway' });
		expect(checkPaymentInput({ amount: 1, currency: 'PKR', description: 'x'.repeat(201) })).toMatchObject({
			field: 'description',
		});
		expect(checkPaymentInput({ amount: 1, currency: 'PKR', reference: 'x'.repeat(121) })).toMatchObject({ field: 'reference' });
		expect(checkPaymentInput({ amount: 1, currency: 'PKR', customer: 'x' })).toMatchObject({ field: 'customer' });
		expect(checkPaymentInput({ amount: 1, currency: 'PKR', metadata: 'x' })).toMatchObject({ field: 'metadata' });
		expect(checkPaymentInput({ amount: 1, currency: 'PKR', cancelUrl: 5 })).toMatchObject({ field: 'cancelUrl' });
		expect(checkPaymentInput(null)).toMatchObject({ ok: false });
	});
	it('checks a new link', () => {
		expect(
			checkLinkInput({ title: 'Donate', currency: 'USD', amount: null, minAmount: 500, gateways: ['stripe', 'stripe'] }),
		).toMatchObject({
			ok: true,
			value: { amount: null, minAmount: 500, gateways: ['stripe'] },
		});
		expect(checkLinkInput({ title: 'Invoice', currency: 'USD', amount: 100 })).toMatchObject({ value: { minAmount: null } });
		expect(checkLinkInput({ currency: 'USD' })).toMatchObject({ field: 'title' });
		expect(checkLinkInput({ title: 't', currency: 'USD', description: 'x'.repeat(1001) })).toMatchObject({
			field: 'description',
		});
		expect(checkLinkInput({ title: 't', currency: 'us' })).toMatchObject({ field: 'currency' });
		expect(checkLinkInput({ title: 't', currency: 'USD', amount: -1 })).toMatchObject({ field: 'amount' });
		expect(checkLinkInput({ title: 't', currency: 'USD', minAmount: 0 })).toMatchObject({ field: 'minAmount' });
		expect(checkLinkInput({ title: 't', currency: 'USD', gateways: ['cash'] })).toMatchObject({ field: 'gateways' });
		expect(checkLinkInput({ title: 't', currency: 'USD', returnUrl: 1 })).toMatchObject({ field: 'returnUrl' });
		expect(checkLinkInput({ title: 't', currency: 'USD', reference: 'x'.repeat(121) })).toMatchObject({ field: 'reference' });
	});
	it('checks a new subscription', () => {
		expect(checkSubscriptionInput({ gateway: 'stripe', plan: 'price_123', returnUrl: 'https://x' })).toMatchObject({
			ok: true,
		});
		expect(checkSubscriptionInput({ gateway: 'payfast' })).toMatchObject({ field: 'gateway' });
		expect(checkSubscriptionInput({ gateway: 'paypal', plan: 'x' })).toMatchObject({ field: 'plan' });
		expect(checkSubscriptionInput({ gateway: 'paypal', plan: 'P-123', customer: 1 })).toMatchObject({ field: 'customer' });
		expect(checkSubscriptionInput({ gateway: 'paypal', plan: 'P-123', reference: 'x'.repeat(121) })).toMatchObject({
			field: 'reference',
		});
		expect(checkSubscriptionInput({ gateway: 'paypal', plan: 'P-123' })).toMatchObject({ field: 'returnUrl' });
		expect(checkSubscriptionInput({ gateway: 'paypal', plan: 'P-123', returnUrl: 'https://x', cancelUrl: 1 })).toMatchObject({
			field: 'cancelUrl',
		});
	});
	it('refunds at most what is left, and only paid payments', () => {
		const paid = { status: 'paid', amount: 1000, refunded: 0 };
		expect(refundAmount(paid, undefined)).toEqual({ ok: true, amount: 1000 });
		expect(refundAmount(paid, 400)).toEqual({ ok: true, amount: 400 });
		expect(refundAmount(paid, 1001)).toMatchObject({ ok: false, code: 'invalid' });
		expect(refundAmount({ ...paid, status: 'pending' }, 1)).toMatchObject({ ok: false, code: 'not_refundable' });
		expect(statusAfterRefund(paid, 400)).toBe('partially_refunded');
		expect(statusAfterRefund({ amount: 1000, refunded: 400 }, 600)).toBe('refunded');
	});
	it('confirms a payment only for its exact amount and currency', () => {
		const payment = { status: 'paid', amount: 1000, currency: 'PKR' };
		expect(isConfirmedFor(payment, { amount: 1000, currency: 'PKR' })).toBe(true);
		expect(isConfirmedFor({ ...payment, status: 'refunded' }, { amount: 1000, currency: 'PKR' })).toBe(true);
		expect(isConfirmedFor(payment, { amount: 999, currency: 'PKR' })).toBe(false);
		expect(isConfirmedFor(payment, { amount: 1000, currency: 'USD' })).toBe(false);
		expect(isConfirmedFor({ ...payment, status: 'pending' }, { amount: 1000, currency: 'PKR' })).toBe(false);
	});
	it('shapes views, mirrors statuses and exports CSV', () => {
		const at = new Date('2026-10-01T10:00:00Z');
		const record = {
			id: 'pay_1',
			status: 'paid',
			amount: 1000,
			currency: 'PKR',
			refunded: 0,
			gateway: 'stripe',
			description: '=SUM(A1)',
			reference: 'o-1, "x"',
			customer: { email: 'a@b.co' },
			metadata: {},
			source: 'api',
			linkId: null,
			proof: { type: 'image/png', size: 5, at },
			refunds: [{ id: 'r', amount: 1, reason: '', manual: true, by: 'Sam', at }],
			history: [
				{ at, event: 'created' },
				{ at, event: 'paid', detail: 'x', by: 'Sam' },
			],
			paidAt: at,
			createdAt: at,
			updatedAt: at,
		};
		const view = paymentView(record, 'https://pay');
		expect(view).toMatchObject({ amountText: '10.00', proof: { type: 'image/png' }, checkoutUrl: 'https://pay' });
		expect(paymentView({ ...record, proof: null, refunds: undefined, history: undefined, paidAt: null }, '').refunds).toEqual(
			[],
		);
		expect(linkView({ id: 'link_1', createdAt: at }, 'u')).toMatchObject({ url: 'u', createdAt: at.toISOString() });
		expect(
			subscriptionView({
				id: 'sub_1',
				history: [{ at, event: 'active', detail: 'stripe', by: 'x' }],
				createdAt: at,
				updatedAt: at,
			}).history,
		).toHaveLength(1);
		expect(subscriptionView({ id: 'sub_1', createdAt: at, updatedAt: at }).history).toEqual([]);
		expect(mirrorStatus('stripe', 'trialing')).toBe('active');
		expect(mirrorStatus('paypal', 'SUSPENDED')).toBe('paused');
		expect(mirrorStatus('paypal', 'NOPE')).toBeNull();
		const csv = paymentsCsv([view], {
			id: 'Payment',
			date: 'Date',
			status: 'Status',
			amount: 'Amount',
			refunded: 'Refunded',
			gateway: 'Gateway',
			reference: 'Reference',
			email: 'E-mail',
			description: 'Description',
		});
		expect(csv.split('\r\n')[1]).toBe(`pay_1,${at.toISOString()},paid,PKR 10.00,0.00,stripe,"o-1, ""x""",a@b.co,'=SUM(A1)`);
		expect(paymentsCsv([{ ...view, gateway: null, customer: {} }], /** @type {any} */ ({})).split('\r\n')[1]).toContain(',,');
	});
});

describe('snippets', () => {
	it('names the addresses to register and the snippets', () => {
		expect(callbackUrls('https://p', 'web_1').stripe).toBe('https://p/v1/gateways/stripe/web_1');
		expect(callbackUrls('https://p').payfast).toContain('<websiteId>');
		const snippets = createSnippets({
			base: 'https://p',
			widgets: [
				{ key: 'pay_button', kind: 'visitor' },
				{ key: 'payments_admin', kind: 'admin' },
			],
			permissions: ['payments.read'],
		});
		expect(snippets.admin).toContain('data-ss-payments="payments_admin"');
		expect(snippets.create).toContain('https://p/v1/payments');
		expect(snippets.ticketCurl).toContain('payments.read');
	});
});
