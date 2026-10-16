import { describe, expect, it } from 'vitest';
import { feeBaseOf, priceLines } from '../core/checkout.js';
import {
	BANK_ROW_LABELS,
	accountsFor,
	advanceOf,
	checkPaymentMethods,
	defaultPaymentMethods,
	isMethodKey,
	isRtoFlagged,
	methodFee,
	newAccount,
	payFirstDetails,
	payLaterDecision,
	paymentOptions,
} from '../core/payment-methods.js';

/**
 * A checked list from the given methods (each filled with its kind's defaults).
 * @param {unknown[]} methods
 * @returns {any[]}
 */
const listOf = (methods) => {
	const checked = checkPaymentMethods(methods);
	if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
	return checked.value;
};

describe('the payment methods list (E2, E8)', () => {
	it('starts with today’s four methods, one of each kind', () => {
		const methods = defaultPaymentMethods();
		expect(methods.map((method) => [method.key, method.kind, method.name])).toEqual([
			['online', 'gateway', 'Online payment'],
			['bank_transfer', 'pay_first', 'Bank transfer'],
			['cod', 'on_delivery', 'Cash on delivery'],
			['pickup', 'at_pickup', 'Pay at pickup'],
		]);
		// the bank transfer goes through Payments, whose own method holds its accounts; cash on delivery is for delivered
		// orders
		expect(methods[1]).toMatchObject({ via: 'payments', accounts: [], instructions: '' });
		expect(newAccount()).toEqual({ label: '', currency: '', rows: BANK_ROW_LABELS.map((label) => ({ label, value: '' })) });
		expect(methods[2]).toMatchObject({ delivery: true, pickup: false, rtoThreshold: 2, rtoRequireAdvance: true });
		expect(methods[3]).toMatchObject({ delivery: false, pickup: true });
		// the defaults pass their own check unchanged
		expect(checkPaymentMethods(methods)).toEqual({ ok: true, value: methods });
	});

	it('takes the merchant’s own methods on the fixed kinds, filling what each leaves out', () => {
		const [cheque, card] = listOf([
			{ key: 'cheque', name: 'Cheque', kind: 'pay_first', via: 'manual', instructions: 'Payable to Example Shop.' },
			{ key: 'card_on_delivery', name: 'Card on delivery', kind: 'on_delivery', feePercent: 1.5, pickup: true },
		]);
		expect(cheque).toMatchObject({ active: true, via: 'manual', proof: true, delivery: true, pickup: true, accounts: [] });
		expect(card).toMatchObject({ feePercent: 1.5, delivery: true, pickup: true, rtoThreshold: 2, advanceVia: 'payments' });
		// what a kind does not use keeps its default
		const [online, wire] = listOf([
			{ key: 'card', name: 'Card', kind: 'gateway', advancePercent: 50, via: 'manual', accounts: [] },
			{ key: 'wire', name: 'Wire', kind: 'pay_first', instructions: 'Pay us', accounts: [newAccount()] },
		]);
		expect(online).toMatchObject({ advancePercent: 0, via: 'payments', rtoThreshold: 0 });
		// through Payments its accounts and instructions are Payments' own: never kept in two places
		expect(wire).toMatchObject({ via: 'payments', instructions: '', accounts: [] });
	});

	it('refuses what cannot be stored, naming each place', () => {
		const checked = checkPaymentMethods([
			{ key: 'Cash', name: '', kind: 'barter' },
			{ key: 'payments', name: 'P', kind: 'gateway' },
			{ key: 'cod', name: 'Cash', kind: 'on_delivery', delivery: false, pickup: false, feePercent: 30 },
			{ key: 'cod', name: 'Again', kind: 'at_pickup' },
			{
				key: 'wire',
				name: 'Wire',
				kind: 'pay_first',
				via: 'manual',
				accounts: [{ label: 'Main', currency: 'usd', rows: [{ label: '', value: 'x' }] }],
			},
		]);
		expect(checked.ok).toBe(false);
		expect(checked.ok ? [] : checked.errors.map((error) => error.path)).toEqual([
			'/0/key',
			'/0/kind',
			'/0/name',
			'/1/key',
			'/2/feePercent',
			'/2/delivery',
			'/3/key',
			'/4/accounts/0/currency',
			'/4/accounts/0/rows/0/label',
		]);
		expect(checkPaymentMethods({}).ok).toBe(false);
		expect(isMethodKey('other')).toBe(false);
		expect(isMethodKey('mobile_wallet')).toBe(true);
	});

	it('shows the accounts of the shop’s currency, else those for any currency, and names entries', () => {
		const [wire] = listOf([
			{
				key: 'wire',
				name: 'Wire',
				kind: 'pay_first',
				via: 'manual',
				accounts: [
					{
						label: 'Any',
						currency: '',
						rows: [
							{ label: 'IBAN', value: 'GB33' },
							{ label: 'BIC', value: '' },
						],
					},
					{ label: 'Euro', currency: 'EUR', rows: [{ label: 'IBAN', value: 'DE89' }] },
					{ label: 'Empty', currency: 'USD', rows: [{ label: 'Account', value: '' }] },
				],
			},
		]);
		expect(accountsFor(wire, 'EUR').map((account) => account.label)).toEqual(['Euro']);
		expect(accountsFor(wire, 'USD')).toEqual([{ label: 'Any', currency: '', rows: [{ label: 'IBAN', value: 'GB33' }] }]);
		expect(payFirstDetails(wire, 'USD').ready).toBe(true);
		expect(payFirstDetails({ ...wire, accounts: [] }, 'USD')).toEqual({
			ready: false,
			name: 'Wire',
			instructions: '',
			accounts: [],
		});
		expect(payFirstDetails({ ...wire, accounts: [], instructions: 'Ask us.' }, 'USD').ready).toBe(true);
	});
});

describe('methods paid later', () => {
	it('computes the advance and the fee in whole units', () => {
		expect(advanceOf(0, { advanceAmount: 10, advancePercent: 0 })).toBe(0);
		expect(advanceOf(1000, { advanceAmount: 300, advancePercent: 50 })).toBe(300);
		expect(advanceOf(200, { advanceAmount: 300, advancePercent: 0 })).toBe(200);
		expect(advanceOf(1001, { advanceAmount: 0, advancePercent: 10 })).toBe(101);
		expect(advanceOf(10_050, { advanceAmount: 0, advancePercent: 10 }, 100)).toBe(1100);
		expect(methodFee(10_050, { feePercent: 5 }, 100)).toBe(500);
		expect(methodFee(10_000, { feePercent: 25 })).toBe(2000);
		expect(methodFee(10_000, { feePercent: 0 })).toBe(0);
	});

	it('flags returned packages and decides', () => {
		expect(isRtoFlagged(2, 2)).toBe(true);
		expect(isRtoFlagged(5, 0)).toBe(false);
		const method = { maxOrderValue: 0, advanceAmount: 0, advancePercent: 0, rtoThreshold: 1, rtoRequireAdvance: true };
		expect(payLaterDecision({ total: 10, rtoCount: 1, canCollectAdvance: true }, method)).toEqual({
			ok: false,
			reason: 'advance_unavailable',
			flagged: true,
		});
		expect(
			payLaterDecision({ total: 10, rtoCount: 1, canCollectAdvance: true }, { ...method, rtoRequireAdvance: false }),
		).toEqual({ ok: true, advance: 0, flagged: true });
		expect(payLaterDecision({ total: 1000, rtoCount: 0, canCollectAdvance: false }, { ...method, advancePercent: 50 })).toEqual(
			{ ok: true, advance: 0, flagged: false },
		);
	});
});

describe('payment options at checkout', () => {
	const methods = listOf([
		{ key: 'online', name: 'Online payment', kind: 'gateway' },
		{ key: 'bank_transfer', name: 'Bank transfer', kind: 'pay_first' },
		{ key: 'cod', name: 'Cash on delivery', kind: 'on_delivery', maxOrderValue: 5000, advancePercent: 10 },
		{ key: 'pickup', name: 'Pay at pickup', kind: 'at_pickup' },
	]);
	const base = {
		methods,
		paymentsConnected: true,
		pickupPossible: true,
		deliveryMethod: /** @type {'delivery' | 'pickup' | 'none'} */ ('delivery'),
		digital: false,
		total: 1000,
		rtoCount: 0,
	};
	/** @param {Partial<Parameters<typeof paymentOptions>[0]>} over */
	const reasons = (over) => paymentOptions({ ...base, ...over }).map((option) => `${option.method}:${option.reason ?? 'ok'}`);

	it('offers the list in its order, each with its name, kind, advance and fee', () => {
		expect(paymentOptions(base)).toEqual([
			{ method: 'online', name: 'Online payment', kind: 'gateway', available: true, reason: null, advance: 0, fee: 0 },
			{ method: 'bank_transfer', name: 'Bank transfer', kind: 'pay_first', available: true, reason: null, advance: 0, fee: 0 },
			{ method: 'cod', name: 'Cash on delivery', kind: 'on_delivery', available: true, reason: null, advance: 100, fee: 0 },
			{
				method: 'pickup',
				name: 'Pay at pickup',
				kind: 'at_pickup',
				available: false,
				reason: 'needs_pickup',
				advance: 0,
				fee: 0,
			},
		]);
		const reordered = [methods[2], methods[0], methods[3], methods[1]];
		expect(paymentOptions({ ...base, methods: reordered }).map((option) => option.method)).toEqual([
			'cod',
			'online',
			'pickup',
			'bank_transfer',
		]);
	});

	it('says why a method cannot be used', () => {
		expect(reasons({ deliveryMethod: 'pickup' })).toEqual(['online:ok', 'bank_transfer:ok', 'cod:needs_delivery', 'pickup:ok']);
		expect(reasons({ digital: true })).toEqual(['online:ok', 'bank_transfer:ok', 'cod:digital_items', 'pickup:needs_pickup']);
		expect(reasons({ deliveryMethod: 'pickup', digital: true }).at(-1)).toBe('pickup:digital_items');
		expect(reasons({ deliveryMethod: 'none' })).toEqual([
			'online:ok',
			'bank_transfer:ok',
			'cod:needs_delivery',
			'pickup:needs_pickup',
		]);
		expect(reasons({ total: 6000 })[2]).toBe('cod:over_max');
		expect(reasons({ paymentsConnected: false, rtoCount: 3 })).toEqual(['cod:advance_unavailable', 'pickup:needs_pickup']);
		expect(reasons({ pickupPossible: false, methods: methods.map((method) => ({ ...method, active: false })) })).toEqual([]);
		expect(reasons({ ready: (method) => method.key !== 'bank_transfer' })[1]).toBe('bank_transfer:not_ready');
	});

	it('takes a method paid first by hand without Payments, and any method for delivery, pickup or both', () => {
		const manual = methods.map((method) =>
			method.key === 'bank_transfer' ? { ...method, via: /** @type {const} */ ('manual') } : method,
		);
		expect(reasons({ paymentsConnected: false })).toEqual(['cod:ok', 'pickup:needs_pickup']);
		expect(reasons({ paymentsConnected: false, methods: manual })).toEqual([
			'bank_transfer:ok',
			'cod:ok',
			'pickup:needs_pickup',
		]);
		const both = methods.map((method) => (method.key === 'cod' ? { ...method, pickup: true } : method));
		expect(reasons({ methods: both, deliveryMethod: 'pickup' })[2]).toBe('cod:ok');
		const deliveredOnly = methods.map((method) => (method.key === 'online' ? { ...method, pickup: false } : method));
		expect(reasons({ methods: deliveredOnly, deliveryMethod: 'pickup' })[0]).toBe('online:needs_delivery');
		// a largest order and a fee for any kind
		const capped = methods.map((method) =>
			method.key === 'online' ? { ...method, maxOrderValue: 500, feePercent: 2 } : method,
		);
		expect(paymentOptions({ ...base, methods: capped })[0]).toMatchObject({ available: false, reason: 'over_max', fee: 20 });
	});

	it('takes the fee on the order total, or on the goods after discounts', () => {
		/** @type {any[]} */
		const lines = [{ key: 'a', unitPrice: 10_000, quantity: 1, allCategoryIds: [] }];
		const priced = priceLines({
			lines,
			promotions: null,
			delivery: 250,
			pointsValue: 1000,
			taxRules: [],
			region: null,
			taxIncluded: true,
			feePercent: 0,
		});
		const feeMethods = methods.map((method) =>
			method.key === 'cod' ? { ...method, feePercent: 2, advancePercent: 0 } : method,
		);
		const options = { ...base, methods: feeMethods, total: 9250, feeBase: (/** @type {any} */ b) => feeBaseOf(priced, b) };
		expect(paymentOptions(options)[2]).toMatchObject({ method: 'cod', fee: 185 });
		const goods = feeMethods.map((method) =>
			method.key === 'cod' ? { ...method, feeBase: /** @type {const} */ ('goods_after_discounts') } : method,
		);
		expect(paymentOptions({ ...options, methods: goods })[2]).toMatchObject({ method: 'cod', fee: 200 });
	});
});
