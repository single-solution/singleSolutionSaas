import { describe, expect, it } from 'vitest';
import manifest from '../manifest.json' with { type: 'json' };
import strings from '../strings/en.json' with { type: 'json' };
import { GATEWAYS, GATEWAY_FEATURES, gatewaysFor, isGateway, takesCurrency } from '../core/gateways.js';
import {
	BANK_ROW_LABELS,
	METHOD_KINDS,
	PAYMENT_KINDS,
	accountsFor,
	checkMethods,
	defaultMethods,
	isMethodKey,
	methodReady,
	methodView,
} from '../core/methods.js';
import { MAX_AMOUNT, formatMoney, fromDecimal, isAmount, isCurrency, toDecimal } from '../core/money.js';
import {
	EVENT_DATA_LIMIT,
	checkCustomer,
	checkLinkInput,
	checkMetadata,
	checkPaymentInput,
	checkSubscriptionInput,
	cleanText,
	isConfirmedFor,
	isRefundDue,
	linkView,
	mirrorStatus,
	paymentEventData,
	paymentView,
	paymentsCsv,
	refundAmount,
	statusAfterRefund,
	subscriptionView,
} from '../core/payments.js';
import { callbackUrls, createSnippets } from '../core/snippets.js';

describe('money', () => {
	it('checks amounts and currencies', () => {
		expect(isCurrency('EUR')).toBe(true);
		expect(isCurrency('eur')).toBe(false);
		expect(isAmount(1)).toBe(true);
		expect(isAmount(0)).toBe(false);
		expect(isAmount(1.5)).toBe(false);
		expect(isAmount(MAX_AMOUNT + 1)).toBe(false);
	});
	it('turns minor units into decimals and back, by the currency exponent', () => {
		expect(toDecimal(1050, 'EUR')).toBe('10.50');
		expect(toDecimal(5, 'USD')).toBe('0.05');
		expect(toDecimal(500, 'JPY')).toBe('500');
		expect(toDecimal(1234, 'KWD')).toBe('1.234');
		expect(fromDecimal('10.5', 'EUR')).toBe(1050);
		expect(fromDecimal('10.500', 'EUR')).toBe(1050);
		expect(fromDecimal(10, 'USD')).toBe(1000);
		expect(fromDecimal('500', 'JPY')).toBe(500);
		expect(fromDecimal('10.505', 'EUR')).toBeNull();
		expect(fromDecimal('abc', 'EUR')).toBeNull();
		expect(fromDecimal('0', 'EUR')).toBeNull();
		expect(fromDecimal(undefined, 'EUR')).toBeNull();
	});
	it('formats for people without assuming a locale', () => {
		expect(formatMoney(125000, 'EUR')).toBe('EUR 1,250.00');
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
		const on = ['stripe', 'jazzcash', 'manual_payments', 'generic_gateway'];
		const ready = (/** @type {string} */ g) => g !== 'generic';
		expect(gatewaysFor({ on, ready, currency: 'PKR' })).toEqual(['stripe', 'jazzcash']);
		expect(gatewaysFor({ on, ready, currency: 'USD' })).toEqual(['stripe']);
		expect(gatewaysFor({ on, ready, currency: 'PKR', only: ['jazzcash'] })).toEqual(['jazzcash']);
		// a manual payment method is the merchant's, not a gateway
		expect(isGateway('bank_transfer')).toBe(false);
	});
});

describe('manual payment methods (P1, P2)', () => {
	/** @typedef {import('../core/methods.js').ManualMethod} ManualMethod */
	/** @param {Partial<ManualMethod>} change @returns {ManualMethod} */
	const method = (change = {}) => ({ .../** @type {ManualMethod} */ (defaultMethods()[0]), ...change });
	/** @param {Array<[string, string]>} rows @param {string} [currency] */
	const account = (rows, currency = '') => ({
		label: '',
		currency,
		rows: rows.map(([label, value]) => ({ label, value })),
	});

	it('has one fixed set of kinds, the same names every unit uses', () => {
		expect(METHOD_KINDS).toEqual(['pay_first', 'on_delivery', 'at_pickup']);
		expect(PAYMENT_KINDS).toEqual(['gateway', 'pay_first', 'on_delivery', 'at_pickup']);
	});
	it('is seeded with today’s bank transfer: paid first, proof upload off, one account of the eight bank rows', () => {
		expect(defaultMethods()).toEqual([
			{
				key: 'bank_transfer',
				name: 'Bank transfer',
				kind: 'pay_first',
				details: '',
				instructions: '',
				proof: false,
				accounts: [{ label: '', currency: '', rows: BANK_ROW_LABELS.map((label) => ({ label, value: '' })) }],
			},
		]);
		expect(BANK_ROW_LABELS).toHaveLength(8);
		// a fresh copy each time (the dashboard edits it)
		expect(defaultMethods()[0]).not.toBe(defaultMethods()[0]);
	});
	it('takes keys that are not gateway ids', () => {
		for (const key of ['bank_transfer', 'cash_on_delivery', 'upi', 'pix', 'wallet_2']) expect(isMethodKey(key)).toBe(true);
		for (const key of ['stripe', 'generic', 'Bank', '1st', '', 'a-b', 'x'.repeat(41), 5]) expect(isMethodKey(key)).toBe(false);
	});
	it('checks the whole list and trims it', () => {
		const list = [
			method({ name: ' Bank transfer ', accounts: [account([['IBAN', ' DE89 3704 0044 0532 0130 00 ']], 'EUR')] }),
			{ key: 'cod', name: 'Cash on delivery', kind: 'on_delivery' },
			{ key: 'pickup', name: 'Pay at the counter', kind: 'at_pickup', details: 'Cash or card at our shop.' },
		];
		const checked = checkMethods(list);
		expect(checked.ok).toBe(true);
		if (!checked.ok) return;
		expect(checked.value[0]).toMatchObject({
			name: 'Bank transfer',
			accounts: [{ currency: 'EUR', rows: [{ label: 'IBAN', value: 'DE89 3704 0044 0532 0130 00' }] }],
		});
		expect(checked.value[1]).toEqual({
			key: 'cod',
			name: 'Cash on delivery',
			kind: 'on_delivery',
			details: '',
			instructions: '',
			proof: false,
			accounts: [],
		});
		expect(checkMethods([])).toEqual({ ok: true, value: [] });
	});
	it('refuses a bad list with every error and its path', () => {
		const checked = checkMethods([
			{ key: 'stripe', name: '', kind: 'cash' },
			{ key: 'cod', name: 'A', kind: 'on_delivery', proof: 'yes' },
			{ key: 'cod', name: 'B', kind: 'on_delivery', accounts: [{ currency: 'usd', rows: [{ label: '', value: 'x' }] }] },
		]);
		expect(checked.ok).toBe(false);
		if (checked.ok) return;
		expect(checked.errors.map((error) => error.path)).toEqual([
			'/value/0/key',
			'/value/0/kind',
			'/value/0/name',
			'/value/1/proof',
			'/value/2/key',
			'/value/2/accounts/0/currency',
			'/value/2/accounts/0/rows/0/label',
		]);
		expect(checkMethods('x')).toMatchObject({ ok: false });
		expect(checkMethods(Array.from({ length: 21 }, (_, i) => method({ key: `m${i}` })))).toMatchObject({ ok: false });
	});
	it('shows payers the accounts of the payment’s currency, else those for any currency, only the rows filled in', () => {
		const euro = account(
			[
				['IBAN', 'DE89'],
				['BIC', ''],
			],
			'EUR',
		);
		const any = account([
			['Account number', '31926819'],
			['Sort code', '60-16-13'],
		]);
		const empty = account([['Wallet', '']]);
		const wallet = method({ accounts: [euro, any, empty] });
		expect(accountsFor(wallet, 'EUR')).toEqual([{ ...euro, rows: [{ label: 'IBAN', value: 'DE89' }] }]);
		expect(accountsFor(wallet, 'GBP')).toEqual([any]);
		expect(accountsFor(method({ accounts: [euro] }), 'GBP')).toEqual([]);
	});
	it('offers a method paid first only when payers are told how to pay; the others always', () => {
		expect(methodReady(method(), 'USD')).toEqual({ ready: false, missing: ['account'] });
		expect(methodReady(method({ instructions: 'We send our details by email.' }), 'USD').ready).toBe(true);
		const euro = method({ accounts: [account([['IBAN', 'DE89']], 'EUR')] });
		expect(methodReady(euro, 'EUR').ready).toBe(true);
		expect(methodReady(euro, 'USD').ready).toBe(false);
		// any currency (the dashboard): an account with a value counts
		expect(methodReady(euro, null).ready).toBe(true);
		for (const kind of /** @type {const} */ (['on_delivery', 'at_pickup']))
			expect(methodReady(method({ kind, accounts: [] }), 'USD')).toEqual({ ready: true, missing: [] });
	});
	it('is seen by payers and the merchant’s server with its words, readiness and matching accounts', () => {
		const euro = account([['IBAN', 'DE89']], 'EUR');
		expect(methodView(method({ accounts: [euro], details: 'Pay first.', proof: true }), 'EUR')).toEqual({
			key: 'bank_transfer',
			name: 'Bank transfer',
			kind: 'pay_first',
			details: 'Pay first.',
			instructions: '',
			proof: true,
			ready: true,
			missing: [],
			accounts: [euro],
		});
		expect(methodView(method({ accounts: [euro] }), null).accounts).toEqual([euro]);
	});
});

describe('payments', () => {
	it('cleans text and checks the payer', () => {
		expect(cleanText(' a\u0000b ', 10)).toBe('a b');
		expect(cleanText(5, 10)).toBeNull();
		expect(cleanText('x'.repeat(11), 10)).toBeNull();
		expect(cleanText(undefined, 10)).toBe('');
		expect(checkCustomer({ name: 'Ana', email: 'Ana@Example.com', phone: '+44 7700 900123', id: 'u1' })).toEqual({
			ok: true,
			value: { id: 'u1', name: 'Ana', email: 'ana@example.com', phone: '+447700900123' },
		});
		expect(checkCustomer(null)).toEqual({ ok: true, value: {} });
		expect(checkCustomer('x')).toMatchObject({ ok: false, field: 'customer' });
		expect(checkCustomer({ id: 'x'.repeat(200) })).toMatchObject({ ok: false, field: 'customer/id' });
		expect(checkCustomer({ name: 'x'.repeat(200) })).toMatchObject({ ok: false, field: 'customer/name' });
		expect(checkCustomer({ email: 'nope' })).toMatchObject({ ok: false, field: 'customer/email' });
		expect(checkCustomer({ phone: '0123' })).toMatchObject({ ok: false, field: 'customer/phone' });
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
		const ok = checkPaymentInput({ amount: 1000, currency: 'EUR', description: 'Order', returnUrl: 'https://x' });
		expect(ok).toMatchObject({ ok: true, value: { amount: 1000, gateway: null, cancelUrl: null } });
		expect(checkPaymentInput({ amount: 0, currency: 'EUR' })).toMatchObject({ ok: false, field: 'amount' });
		expect(checkPaymentInput({ amount: 1, currency: 'usd' })).toMatchObject({ ok: false, field: 'currency' });
		expect(checkPaymentInput({ amount: 1, currency: 'EUR', gateway: 'Cash!' })).toMatchObject({ ok: false, field: 'gateway' });
		// a manual payment method's key (whether it exists is checked when the payment is made)
		expect(checkPaymentInput({ amount: 1, currency: 'EUR', gateway: 'cash' })).toMatchObject({ ok: true });
		expect(checkPaymentInput({ amount: 1, currency: 'EUR', description: 'x'.repeat(201) })).toMatchObject({
			field: 'description',
		});
		expect(checkPaymentInput({ amount: 1, currency: 'EUR', reference: 'x'.repeat(121) })).toMatchObject({ field: 'reference' });
		expect(checkPaymentInput({ amount: 1, currency: 'EUR', customer: 'x' })).toMatchObject({ field: 'customer' });
		expect(checkPaymentInput({ amount: 1, currency: 'EUR', metadata: 'x' })).toMatchObject({ field: 'metadata' });
		expect(checkPaymentInput({ amount: 1, currency: 'EUR', cancelUrl: 5 })).toMatchObject({ field: 'cancelUrl' });
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
		expect(checkLinkInput({ title: 't', currency: 'USD', gateways: ['Cash!'] })).toMatchObject({ field: 'gateways' });
		expect(checkLinkInput({ title: 't', currency: 'USD', gateways: ['stripe', 'cash'] })).toMatchObject({ ok: true });
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
		const payment = { status: 'paid', amount: 1000, currency: 'EUR' };
		expect(isConfirmedFor(payment, { amount: 1000, currency: 'EUR' })).toBe(true);
		expect(isConfirmedFor({ ...payment, status: 'refunded' }, { amount: 1000, currency: 'EUR' })).toBe(true);
		expect(isConfirmedFor(payment, { amount: 999, currency: 'EUR' })).toBe(false);
		expect(isConfirmedFor(payment, { amount: 1000, currency: 'USD' })).toBe(false);
		expect(isConfirmedFor({ ...payment, status: 'pending' }, { amount: 1000, currency: 'EUR' })).toBe(false);
		// money that arrived after the merchant canceled the payment never confirms an order (K-13)
		const late = { ...payment, voidedAt: new Date('2026-10-01T10:00:00Z') };
		expect(isConfirmedFor(late, { amount: 1000, currency: 'EUR' })).toBe(false);
		expect(isRefundDue(late)).toBe(true);
		expect(isRefundDue({ ...late, status: 'partially_refunded' })).toBe(true);
		expect(isRefundDue({ ...late, status: 'refunded' })).toBe(false);
		expect(isRefundDue({ ...late, status: 'voided' })).toBe(false);
		expect(isRefundDue(payment)).toBe(false);
	});
	it('shapes views, mirrors statuses and exports CSV', () => {
		const at = new Date('2026-10-01T10:00:00Z');
		const record = {
			id: 'pay_1',
			status: 'paid',
			amount: 1000,
			currency: 'EUR',
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
		expect(view).toMatchObject({
			amountText: '10.00',
			proof: { type: 'image/png' },
			checkoutUrl: 'https://pay',
			refundDue: false,
			voidedAt: null,
		});
		expect(paymentView({ ...record, voidedAt: at }, '')).toMatchObject({ refundDue: true, voidedAt: at.toISOString() });
		expect(paymentView({ ...record, proof: null, refunds: [], history: [], paidAt: null }, '').refunds).toEqual([]);
		expect(linkView({ id: 'link_1', createdAt: at }, 'u')).toMatchObject({ url: 'u', createdAt: at.toISOString() });
		expect(
			subscriptionView({
				id: 'sub_1',
				history: [{ at, event: 'active', detail: 'stripe', by: 'x' }],
				createdAt: at,
				updatedAt: at,
			}).history,
		).toHaveLength(1);
		expect(subscriptionView({ id: 'sub_1', history: [], createdAt: at, updatedAt: at }).history).toEqual([]);
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
			email: 'Email',
			description: 'Description',
		});
		// a byte order mark first: spreadsheet apps then read names in any language right (UTF-8)
		expect(csv.startsWith('\uFEFFPayment,Date,')).toBe(true);
		expect(csv.split('\r\n')[1]).toBe(`pay_1,${at.toISOString()},paid,EUR 10.00,0.00,stripe,"o-1, ""x""",a@b.co,'=SUM(A1)`);
		expect(paymentsCsv([{ ...view, gateway: null, customer: {} }], /** @type {any} */ ({})).split('\r\n')[1]).toContain(',,');
	});
});

describe('payment events', () => {
	it('carry the payment as the API answers it, without metadata and history when that is too large', () => {
		const at = new Date('2026-10-01T10:00:00Z');
		const base = {
			id: 'pay_1',
			status: 'paid',
			amount: 100,
			currency: 'EUR',
			refunded: 0,
			refunds: [],
			createdAt: at,
			updatedAt: at,
		};
		const small = paymentView({ ...base, metadata: { order: '7' }, history: [{ at, event: 'paid' }] }, 'https://p/pay/1');
		expect(paymentEventData(small, { refund: { id: 'rfd_1', amount: 5 } })).toEqual({
			payment: small,
			refund: { id: 'rfd_1', amount: 5 },
		});
		/** @type {Record<string, string>} */
		const metadata = {};
		for (let i = 0; i < 20; i += 1) metadata[`field_${i}`] = 'x'.repeat(500);
		const history = Array.from({ length: 150 }, () => ({ at, event: 'started', detail: 'stripe' }));
		const large = paymentView({ ...base, metadata, history }, 'https://p/pay/1');
		const data = /** @type {any} */ (paymentEventData(large));
		expect(JSON.stringify({ payment: large }).length).toBeGreaterThan(EVENT_DATA_LIMIT);
		expect(data.payment).toMatchObject({ id: 'pay_1', status: 'paid', metadata: {}, history: [] });
		expect(JSON.stringify(data).length).toBeLessThanOrEqual(EVENT_DATA_LIMIT);
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

describe('payer texts', () => {
	it('names each gateway to payers by its brand: a place in its dashboard name stays out (P10)', () => {
		for (const gateway of GATEWAYS) {
			const feature = manifest.features.find((entry) => entry.key === GATEWAY_FEATURES[gateway]);
			const qualifier = /\(([^)]+)\)$/.exec(feature?.name ?? '')?.[1];
			const label = /** @type {Record<string, string>} */ (strings)[`gateway.${gateway}`];
			expect(label).toBeTruthy();
			if (qualifier) expect(label).not.toContain(qualifier);
		}
		expect(strings['gateway.payfast']).toBe('PayFast');
		expect(strings['gateway.payfast_pk']).toBe('PayFast');
		expect(strings['gateway.jazzcash']).toBe('JazzCash');
		expect(strings['gateway.easypaisa']).toBe('Easypaisa');
		expect(strings['gateway.rapid']).toBe('Rapid Gateway');
	});
});
