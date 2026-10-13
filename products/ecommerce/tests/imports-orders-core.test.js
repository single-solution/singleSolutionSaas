/**
 * The shoppers' and orders' checks in import mode (`core/imports-orders.js`, PLAN 0.8.10 K10): what each collection
 * takes and refuses, field by field, and the pure parts of finish. No database.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_FLOW } from '../core/flow.js';
import {
	checkImportedAlert,
	checkImportedCustomer,
	checkImportedLoyalty,
	checkImportedOrder,
	checkImportedReturn,
	checkImportedReview,
	checkImportedWishlist,
	customerCounts,
	holdsSerials,
	importRules,
	loyaltyDerived,
	rtoKeysOf,
	serialsSoldTo,
} from '../core/imports-orders.js';

const NOW = Date.parse('2026-10-05T10:00:00Z');
const RULES = importRules({
	flow: DEFAULT_FLOW,
	checkout: { numberPrefix: 'S-', numberDigits: 4, defaultCallingCode: '+1' },
	catalog: { currency: 'USD' },
	now: NOW,
});

/** @param {string} prefix @param {number} n */
const idOf = (prefix, n) => `${prefix}_${String(n).padStart(24, '0')}`;

/** The paths a check refused, or [] when it took the record. @param {import('../core/imports-orders.js').ImportCheck} result */
const pathsOf = (result) => (result.ok ? [] : result.errors.map((error) => error.path));

/** @param {import('../core/imports-orders.js').ImportCheck} result */
const valueOf = (result) => {
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return /** @type {any} */ (result.value);
};

const LINE = {
	id: idOf('oln', 1),
	productId: idOf('prd', 1),
	variantId: idOf('var', 1),
	name: 'Phone',
	unitPrice: 1000,
	quantity: 2,
	discount: 100,
	total: 1900,
};

/** A valid delivered order (default flow, `S-` numbers of 4 digits, USD); `patch` replaces top-level fields. @param {Record<string, unknown>} [patch] */
const order = (patch = {}) => ({
	id: idOf('ord', 1),
	number: 'S-2026-0007',
	customer: { userId: 'usr_member0000000001', customerId: idOf('cus', 1), name: 'Sara', phone: '5550001111' },
	address: { name: 'Sara', phone: '(555) 000-1111', line1: '1 Main Street', city: 'Springfield' },
	delivery: { method: 'delivery', zone: 'city', fee: 200, locationId: null },
	lines: [LINE],
	totals: { subtotal: 2000, discount: 100, delivery: 200, tax: 0, total: 2100, currency: 'USD', taxIncluded: true },
	promotions: { released: false },
	payment: { method: 'cod' },
	payments: [{ id: idOf('opy', 1), method: 'cash', amount: 2100, at: '2026-03-04T00:00:00Z' }],
	status: 'delivered',
	history: [
		{ at: '2026-03-01T00:00:00Z', from: null, to: 'awaiting_confirmation', by: 'shopper', note: '' },
		{ at: '2026-03-04T00:00:00Z', from: 'awaiting_confirmation', to: 'delivered', by: 'Staff', note: '' },
	],
	stockHeld: true,
	placedAt: '2026-03-01T00:00:00Z',
	deliveredAt: '2026-03-04T00:00:00Z',
	...patch,
});

describe('import rules', () => {
	it('read the order number form, currency and phone rules, with safe defaults', () => {
		expect(RULES).toMatchObject({
			numberPrefix: 'S-',
			numberDigits: 4,
			currency: 'USD',
			phoneRules: { defaultCallingCode: '+1' },
		});
		expect(importRules({ flow: DEFAULT_FLOW, checkout: { numberDigits: 12 }, catalog: {}, now: NOW })).toMatchObject({
			numberPrefix: '',
			numberDigits: 8,
			currency: 'USD',
			phoneRules: { defaultCallingCode: '', trunkPrefix: '' },
		});
		expect(
			importRules({ flow: DEFAULT_FLOW, checkout: { numberDigits: 'x' }, catalog: { currency: 'PKR' }, now: NOW }),
		).toMatchObject({
			numberDigits: 6,
			currency: 'PKR',
		});
	});
});

describe('customers', () => {
	it('take members and guests, phones as E.164, and ignore the counts finish derives', () => {
		const member = valueOf(
			checkImportedCustomer(
				{ id: idOf('cus', 1), userId: 'usr_member0000000001', email: 'A@B.example', phone: '', orderCount: 7, rtoCount: 2 },
				RULES,
			),
		);
		expect(member).toMatchObject({
			userId: 'usr_member0000000001',
			guest: false,
			email: 'a@b.example',
			phone: '',
			orderCount: 0,
			rtoCount: 0,
		});
		const guest = valueOf(
			checkImportedCustomer(
				{
					id: idOf('cus', 2),
					guest: true,
					name: 'Guest',
					phone: '555 000 2222',
					note: 'Calls first',
					createdAt: '2025-01-01T00:00:00Z',
				},
				RULES,
			),
		);
		expect(guest).toMatchObject({
			userId: null,
			guest: true,
			phone: '+15550002222',
			phoneDigits: '5550002222',
			note: 'Calls first',
		});
		expect(guest.createdAt).toEqual(new Date('2025-01-01T00:00:00Z'));
	});

	it('refuse what does not fit, field by field', () => {
		expect(
			pathsOf(
				checkImportedCustomer(
					{
						id: 'cus_X',
						userId: 'member-1',
						guest: true,
						name: 7,
						email: 'not-an-email',
						city: 'x'.repeat(101),
						seenBy: ['ok', ''],
						createdAt: '2099-01-01T00:00:00Z',
						merchantId: 'mer_0123456789',
					},
					RULES,
				),
			),
		).toEqual(['/merchantId', '/id', '/userId', '/name', '/email', '/phone', '/city', '/createdAt', '/seenBy']);
		// a guest needs a name and a phone; a block needs its reason
		expect(pathsOf(checkImportedCustomer({ id: idOf('cus', 3), guest: false, phone: 'abc', blocked: true }, RULES))).toEqual([
			'/guest',
			'/name',
			'/phone',
			'/blockedReason',
		]);
		expect(
			pathsOf(checkImportedCustomer({ id: idOf('cus', 4), name: ' ', phone: '+15550002222', createdAt: 'soon' }, RULES)),
		).toEqual(['/name', '/createdAt']);
	});
});

describe('orders', () => {
	it('take an order as the shop keeps it: role from the flow, key and creation time filled, money adding up', () => {
		const value = valueOf(checkImportedOrder(order(), RULES));
		expect(value).toMatchObject({
			role: 'delivered',
			idempotencyKey: `import:${idOf('ord', 1)}`,
			customer: { phone: '+15550001111', email: '' },
			address: { phone: '+15550001111', line2: '', notes: '' },
			payment: { state: 'paid', paid: 2100, refunded: 0, advance: 0, checkoutUrl: '', proof: null },
			payments: [{ by: { kind: 'server', id: 'server', name: 'Server' }, reference: '', proofKey: null }],
			lines: [{ kind: 'physical', serials: [], booking: null, licences: [], returnedQuantity: 0, grade: null, image: null }],
			phoneDigits: '5550001111',
			shipment: null,
			media: [],
			holdUntil: null,
			accessKeyHash: null,
		});
		expect(value.createdAt).toEqual(new Date('2026-03-01T00:00:00Z'));
	});

	it('take the rest of an order’s shape: refunds, shipment, video, flags and given keys', () => {
		const value = valueOf(
			checkImportedOrder(
				order({
					status: 'refunded',
					role: 'refunded',
					lines: [
						{
							...LINE,
							kind: 'digital',
							grade: 'a',
							gradeLabel: 'Like new',
							image: 'ecommerce/products/p/1.jpg',
							categoryIds: [idOf('cat', 1)],
							brandId: idOf('brd', 1),
							serials: [' 354000000000001 ', '354000000000002'],
							licences: [idOf('lic', 1)],
							booking: { start: '2027-01-01T10:00:00Z', end: '2027-01-01T11:00:00Z' },
							warrantyDays: 365,
							dealId: idOf('deal', 1),
							returnedQuantity: 1,
							cost: 500,
						},
					],
					refunds: [
						{
							id: idOf('orf', 1),
							method: 'online',
							amount: 2100,
							claimId: idOf('ret', 1),
							refundId: 'rfd_1',
							manual: false,
							by: { kind: 'user', id: 'usr_staff', name: 'Sam', role: 'owner', email: 'SAM@shop.example' },
							at: '2026-03-05T00:00:00Z',
						},
					],
					payment: {
						method: 'online',
						state: 'refunded',
						paid: 2100,
						refunded: 2100,
						paymentId: 'pay_000000000001',
						checkoutUrl: 'https://payments.example/pay/1',
						via: 'payments',
						proof: { key: 'ecommerce/proofs/1.png', reference: 'TX', at: '2026-03-02T00:00:00Z' },
						voidedAt: '2026-03-05T00:00:00Z',
						checkedAt: '2026-03-05T00:00:00Z',
					},
					history: [
						{ at: '2026-03-01T00:00:00Z', to: 'pending_payment', by: 'shopper' },
						{ at: '2026-03-02T00:00:00Z', from: 'pending_payment', to: 'confirmed', kind: 'payment' },
						{ at: '2026-03-03T00:00:00Z', from: 'confirmed', to: 'delivered' },
						{ at: '2026-03-05T00:00:00Z', from: 'delivered', to: 'refunded', reason: 'staff' },
					],
					promotions: {
						released: true,
						couponId: idOf('cpn', 1),
						couponCode: 'SAVE10',
						dealIds: [idOf('deal', 1)],
						pointsEarned: 20,
						pointsCredited: true,
						pointsFixed: true,
						pointsBlocked: false,
						pointsReversed: 20,
						role: { key: 'member', percent: 5, label: 'Members' },
					},
					shipment: {
						courier: 'swift',
						trackingNumber: 'TRK-9',
						trackingUrl: 'https://track.example/t?n=TRK-9',
						booked: true,
						status: 'Delivered',
						checkedAt: '2026-03-03T00:00:00Z',
						estimatedDeliveryAt: '2026-03-03T00:00:00Z',
					},
					media: [
						{ kind: 'dispatch_video', key: 'ecommerce/videos/o1.mp4', at: '2026-03-02T00:00:00Z', by: 'Sam' },
						{ kind: 'dispatch_video', url: 'https://youtu.be/dQw4w9WgXcQ' },
					],
					seenBy: ['usr_staff'],
					accessKeyHash: 'A'.repeat(43),
					idempotencyKey: 'checkout-1',
					returnRestocked: true,
					claimRestockedAt: '2026-03-06T00:00:00Z',
					createdAt: '2026-03-01T00:00:01Z',
					phoneDigits: 'ignored',
					note: 'Ring twice',
					staffNote: 'Old customer',
					stockHeld: true,
				}),
				RULES,
			),
		);
		expect(value).toMatchObject({
			role: 'refunded',
			lines: [{ kind: 'digital', downloads: 0, serials: ['354000000000001', '354000000000002'], warrantyDays: 365 }],
			payment: { state: 'refunded', via: 'payments', proof: { key: 'ecommerce/proofs/1.png' } },
			refunds: [{ by: { email: 'sam@shop.example', role: 'owner' }, manual: false, refundId: 'rfd_1' }],
			shipment: { courier: 'swift', trackingNumber: 'TRK-9', booked: true, trackingNote: '' },
			media: [{ key: 'ecommerce/videos/o1.mp4', by: 'Sam' }, { url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ' }],
			promotions: { pointsReversed: 20, role: { key: 'member' } },
			idempotencyKey: 'checkout-1',
			phoneDigits: '5550001111',
			returnRestocked: true,
		});
		expect(value.lines[0].booking.start).toEqual(new Date('2027-01-01T10:00:00Z'));
	});

	it('take a waiting order with nothing paid, a pending payment and its time to wait', () => {
		const waiting = order({
			status: 'pending_payment',
			history: [{ at: '2026-10-05T09:00:00Z', to: 'pending_payment' }],
			payments: [],
			payment: { method: 'online', state: 'pending' },
			holdUntil: '2026-10-05T11:00:00Z',
			deliveredAt: null,
			delivery: { method: 'pickup', fee: 200 },
			address: null,
		});
		expect(valueOf(checkImportedOrder(waiting, RULES)).payment.state).toBe('pending');
		// a free order is paid without a payment
		const free = order({
			lines: [{ ...LINE, unitPrice: 0, discount: 0, total: 0 }],
			totals: { subtotal: 0, discount: 0, delivery: 0, tax: 0, total: 0, currency: 'USD', taxIncluded: true },
			delivery: { method: 'none' },
			payments: [],
		});
		expect(valueOf(checkImportedOrder(free, RULES)).payment).toMatchObject({ state: 'paid', paid: 0 });
	});

	it('refuse an order whose number, status, role, history or times do not fit', () => {
		expect(
			pathsOf(
				checkImportedOrder(
					order({
						id: 'ord_1',
						number: '2026-0007',
						status: 'lost',
						websiteId: 'web_000000000001',
						history: [{ at: 'later', from: 'nowhere', to: 'confirmed', reason: 'lost', kind: 'other', extra: 1 }],
						placedAt: undefined,
						deliveredAt: '2026-03-04T00:00:00Z',
					}),
					RULES,
				),
			),
		).toEqual([
			'/websiteId',
			'/id',
			'/number',
			'/status',
			'/history/0/extra',
			'/history/0/at',
			'/history/0/from',
			'/history/0/reason',
			'/history/0/kind',
			'/history/0/to',
			'/placedAt',
		]);
		expect(pathsOf(checkImportedOrder(order({ role: 'open', history: [], deliveredAt: undefined }), RULES))).toEqual([
			'/role',
			'/history',
			'/deliveredAt',
		]);
		expect(
			pathsOf(
				checkImportedOrder(
					order({
						status: 'confirmed',
						history: [{ at: '2026-03-01T00:00:00Z', to: 'confirmed' }],
						deliveredAt: '2026-02-01T00:00:00Z',
						holdUntil: '2026-11-01T00:00:00Z',
						stockHeld: 'yes',
						accessKeyHash: 'short',
						createdAt: '2099-01-01T00:00:00Z',
						claimRestockedAt: 'x',
						returnRestocked: 'no',
						note: 'x'.repeat(1001),
						seenBy: 'all',
					}),
					RULES,
				),
			),
		).toEqual([
			'/deliveredAt',
			'/deliveredAt',
			'/stockHeld',
			'/holdUntil',
			'/accessKeyHash',
			'/createdAt',
			'/claimRestockedAt',
			'/seenBy',
			'/returnRestocked',
			'/note',
		]);
		// a cancelled order holds no stock
		expect(
			pathsOf(
				checkImportedOrder(
					order({ status: 'cancelled', history: [{ at: '2026-03-01T00:00:00Z', to: 'cancelled' }], deliveredAt: null }),
					RULES,
				),
			),
		).toEqual(['/stockHeld']);
	});

	it('refuse a customer, address, delivery or line that does not fit', () => {
		expect(
			pathsOf(
				checkImportedOrder(
					order({
						customer: { userId: 'nobody', name: 'x'.repeat(121), email: 'x', phone: 'call me', extra: true },
						address: 'Main Street',
						delivery: { method: 'drone', fee: -1, locationId: 'loc' },
					}),
					RULES,
				),
			),
		).toEqual([
			'/customer/extra',
			'/customer/userId',
			'/customer/name',
			'/customer/email',
			'/customer/phone',
			'/customer/customerId',
			'/address',
			'/delivery/method',
			'/delivery/fee',
			'/delivery/locationId',
			'/totals/delivery',
		]);
		expect(pathsOf(checkImportedOrder(order({ address: null }), RULES))).toEqual(['/address']);
		expect(pathsOf(checkImportedOrder(order({ lines: [] }), RULES))).toEqual(
			expect.arrayContaining(['/lines', '/totals/subtotal', '/totals/discount', '/totals/total']),
		);
		expect(pathsOf(checkImportedOrder(order({ lines: 'none' }), RULES))).toEqual(expect.arrayContaining(['/lines']));
		const bad = {
			...LINE,
			id: 'oln_bad',
			kind: 'gift',
			name: '',
			quantity: 0,
			discount: 5000,
			total: 1,
			serials: ['a', 'b', 'c'],
			categoryIds: [idOf('cat', 1), idOf('cat', 1)],
			downloads: -1,
			warrantyDays: 99999,
			dealId: 'deal',
			booking: 'today',
			colour: 'red',
		};
		expect(pathsOf(checkImportedOrder(order({ lines: [bad] }), RULES))).toEqual([
			'/lines/0/colour',
			'/lines/0/kind',
			'/lines/0/quantity',
			'/lines/0/discount',
			'/lines/0/total',
			'/lines/0/serials',
			'/lines/0/downloads',
			'/lines/0/warrantyDays',
			'/lines/0/id',
			'/lines/0/name',
			'/lines/0/categoryIds',
			'/lines/0/booking',
			'/lines/0/dealId',
			'/totals/subtotal',
			'/totals/discount',
			'/totals/total',
		]);
		// too large, prices excluding tax, serials twice, the same line twice
		expect(
			pathsOf(
				checkImportedOrder(order({ lines: [{ ...LINE, unitPrice: 1_000_000_000_000, quantity: 10, total: 0 }] }), RULES),
			),
		).toEqual(expect.arrayContaining(['/lines/0/unitPrice', '/lines/0/total']));
		const taxed = { ...LINE, tax: 190, total: 2090 };
		expect(
			pathsOf(
				checkImportedOrder(
					order({
						lines: [taxed],
						totals: {
							subtotal: 2000,
							discount: 100,
							delivery: 200,
							tax: 190,
							total: 2290,
							currency: 'USD',
							taxIncluded: false,
						},
						payments: [{ id: idOf('opy', 1), method: 'cash', amount: 2290, at: '2026-03-04T00:00:00Z' }],
					}),
					RULES,
				),
			),
		).toEqual([]);
		const twice = [
			{ ...LINE, serials: ['SN-1'] },
			{ ...LINE, serials: ['SN-1'] },
		];
		expect(pathsOf(checkImportedOrder(order({ lines: twice }), RULES))).toEqual(
			expect.arrayContaining(['/lines', '/totals/subtotal']),
		);
		expect(
			pathsOf(checkImportedOrder(order({ lines: [{ ...LINE, quantity: 2, serials: ['SN-1', 'x'.repeat(65)] }] }), RULES)),
		).toEqual(['/lines/0/serials']);
		expect(pathsOf(checkImportedOrder(order({ lines: Array.from({ length: 101 }, () => LINE) }), RULES))).toEqual(
			expect.arrayContaining(['/lines']),
		);
	});

	it('refuse totals and promotions that do not add up (IMP-10, IMP-49)', () => {
		expect(
			pathsOf(
				checkImportedOrder(
					order({
						totals: {
							subtotal: 1,
							discount: 2,
							delivery: 3,
							tax: 4,
							total: 5,
							fee: 6,
							roleDiscount: 7,
							currency: 'EUR',
							taxIncluded: 'yes',
							shipping: 0,
						},
					}),
					RULES,
				),
			),
		).toEqual(
			expect.arrayContaining([
				'/totals/shipping',
				'/totals/taxIncluded',
				'/totals/currency',
				'/totals/subtotal',
				'/totals/discount',
				'/totals/tax',
				'/totals/delivery',
				'/totals/total',
				'/totals/roleDiscount',
			]),
		);
		expect(
			pathsOf(
				checkImportedOrder(
					order({
						promotions: {
							pointsRedeemed: 5,
							pointsValue: 0,
							pointsEarned: 10,
							pointsReversed: 11,
							pointsFixed: 'yes',
							couponId: 'cpn',
							dealIds: ['x'],
							role: { percent: 95 },
						},
					}),
					RULES,
				),
			),
		).toEqual([
			'/promotions/pointsValue',
			'/promotions/pointsCredited',
			'/promotions/pointsFixed',
			'/promotions/pointsReversed',
			'/promotions/couponId',
			'/promotions/dealIds/0',
			'/promotions/released',
			'/promotions/role/key',
			'/promotions/role/percent',
		]);
		expect(
			pathsOf(checkImportedOrder(order({ promotions: { released: false, pointsRedeemed: 1, pointsValue: 500 } }), RULES)),
		).toEqual(['/promotions/pointsValue']);
		expect(pathsOf(checkImportedOrder(order({ promotions: null }), RULES))).toEqual(['/promotions', '/promotions/released']);
	});

	it('refuse payments that do not add up, with the state they give (IMP-13)', () => {
		expect(
			pathsOf(
				checkImportedOrder(
					order({ payments: [], payment: { method: 'cod', state: 'paid', paid: 2100, refunded: 5 } }),
					RULES,
				),
			),
		).toEqual(['/payment/paid', '/payment/refunded', '/payment/state']);
		expect(
			pathsOf(
				checkImportedOrder(
					order({
						payments: [
							{ id: idOf('opy', 1), method: 'cash', amount: 3000, at: '2026-03-04T00:00:00Z' },
							{
								id: idOf('opy', 1),
								method: 'cheque',
								amount: 0,
								reference: 'x'.repeat(121),
								at: '2099-01-01T00:00:00Z',
								by: { kind: 'user' },
							},
						],
						refunds: [{ id: idOf('orf', 1), method: 'cash', amount: 4000, at: '2026-03-05T00:00:00Z', manual: 'no' }],
						payment: {
							method: 'cheque',
							state: 'partially_refunded',
							paymentId: 'pay 1',
							checkoutUrl: 'http://pay.example',
							via: 'post',
							voidedAt: 'x',
							advance: 99999,
							proof: { reference: 'x' },
						},
					}),
					RULES,
				),
			),
		).toEqual([
			'/payments/1/method',
			'/payments/1/amount',
			'/payments/1/reference',
			'/payments/1/by/id',
			'/payments/1/by/name',
			'/payments/1/at',
			'/refunds/0/manual',
			'/payments',
			'/payments',
			'/refunds',
			'/payment/state',
			'/payment/paymentId',
			'/payment/checkoutUrl',
			'/payment/via',
			'/payment/voidedAt',
			'/payment/method',
			'/payment/advance',
			'/payment/proof/key',
			'/payment/proof/at',
		]);
		expect(pathsOf(checkImportedOrder(order({ payment: { method: 'cod', state: 'settled' } }), RULES))).toEqual([
			'/payment/state',
		]);
		expect(pathsOf(checkImportedOrder(order({ payment: 'cash' }), RULES))).toEqual(['/payment', '/payment/method']);
	});

	it('refuse a shipment or dispatch video that does not fit', () => {
		expect(
			pathsOf(
				checkImportedOrder(
					order({
						shipment: { trackingNumber: 'TRK-1', trackingUrl: 'ftp://x', booked: 1, checkedAt: 'x' },
						media: [{ kind: 'photo', key: 'dQw4w9WgXcQ' }, { url: 'ftp://x' }, {}],
					}),
					RULES,
				),
			),
		).toEqual([
			'/shipment/courier',
			'/shipment/trackingUrl',
			'/shipment/booked',
			'/shipment/checkedAt',
			'/media/0/kind',
			'/media/0',
			'/media/1/kind',
			'/media/1',
			'/media/2/kind',
			'/media/2',
		]);
	});
});

describe('loyalty', () => {
	it('take the rebuilt lots and history, and derive the balance and lifetime points', () => {
		const value = valueOf(
			checkImportedLoyalty(
				{
					customerId: idOf('cus', 1),
					lots: [
						{
							id: idOf('lot', 1),
							points: 50,
							left: 50,
							earnedAt: '2025-01-01T00:00:00Z',
							expiresAt: '2026-01-01T00:00:00Z',
							kind: 'adjust',
						},
						{
							id: idOf('lot', 2),
							points: 30,
							left: 20,
							earnedAt: '2026-02-01T00:00:00Z',
							expiresAt: '2027-02-01T00:00:00Z',
							orderId: idOf('ord', 1),
						},
					],
					history: [
						{ at: '2025-01-01T00:00:00Z', kind: 'adjust', points: 50, note: 'Starter points' },
						{ at: '2026-02-01T00:00:00Z', kind: 'earn', points: 30, orderId: idOf('ord', 1) },
						{ at: '2026-02-02T00:00:00Z', kind: 'redeem', points: 10 },
					],
					balance: 1,
					lifetimeEarned: 1,
					version: 9,
					createdAt: '2025-01-01T00:00:00Z',
				},
				RULES,
			),
		);
		expect(value).toMatchObject({ userId: null, balance: 20, lifetimeEarned: 30, version: 1 });
		expect(loyaltyDerived({ lots: value.lots, history: value.history, lifetimeEarned: 500 }, NOW)).toEqual({
			balance: 20,
			lifetimeEarned: 500,
		});
		expect(loyaltyDerived({}, NOW)).toEqual({ balance: 0, lifetimeEarned: 0 });
	});

	it('refuse lots and entries that do not fit', () => {
		expect(
			pathsOf(
				checkImportedLoyalty(
					{
						customerId: 'cus',
						userId: 'u',
						lots: [
							{
								id: idOf('lot', 1),
								points: 5,
								left: 6,
								earnedAt: '2099-01-01T00:00:00Z',
								expiresAt: 'x',
								orderId: 'o',
								kind: 'bonus',
							},
							{ id: idOf('lot', 1), points: 0, left: 0, earnedAt: '2025-01-01T00:00:00Z' },
						],
						history: [{ at: '2025-01-01T00:00:00Z', kind: 'gift', points: -1, note: 'x'.repeat(501), by: 'staff' }],
						createdAt: 'x',
					},
					RULES,
				),
			),
		).toEqual([
			'/customerId',
			'/userId',
			'/lots/0/left',
			'/lots/0/earnedAt',
			'/lots/0/expiresAt',
			'/lots/0/orderId',
			'/lots/0/kind',
			'/lots/1/points',
			'/lots',
			'/history/0/by',
			'/history/0/kind',
			'/history/0/points',
			'/history/0/note',
			'/createdAt',
		]);
	});
});

describe('reviews, claims, alerts and wishlists', () => {
	it('take a review as shoppers write it, and refuse one that does not fit', () => {
		expect(
			valueOf(
				checkImportedReview(
					{
						id: idOf('rev', 1),
						productId: idOf('prd', 1),
						orderId: idOf('ord', 1),
						rating: 5,
						title: ' Great ',
						reply: 'Thanks',
						status: 'approved',
						createdAt: '2026-01-01T00:00:00Z',
					},
					RULES,
				),
			),
		).toMatchObject({ userId: '', lineId: null, title: 'Great', body: '', reply: 'Thanks', variantName: '', name: '' });
		expect(
			pathsOf(
				checkImportedReview(
					{
						id: 'rev',
						productId: 'prd_1',
						orderId: 'x',
						lineId: 'y',
						rating: 6,
						reply: 'x'.repeat(2001),
						status: 'hidden',
						name: 'x'.repeat(81),
						stars: 1,
					},
					RULES,
				),
			),
		).toEqual(['/stars', '/rating', '/reply', '/id', '/productId', '/orderId', '/lineId', '/name', '/status']);
	});

	it('take a claim with its lines, photos, history, notes and reference, and refuse one that does not fit', () => {
		const claim = {
			id: idOf('ret', 1),
			reference: 'RR-0001',
			orderId: idOf('ord', 1),
			orderNumber: 'S-2026-0007',
			userId: 'usr_member0000000001',
			kind: 'exchange',
			lines: [{ lineId: idOf('oln', 1), quantity: 1, serials: ['SN-1'], restock: true, restockedAt: '2026-05-03T00:00:00Z' }],
			reason: 'Wrong size',
			photos: [{ key: 'ecommerce/returns/u/1.jpg', type: 'image/jpeg', size: 1000, alt: '' }],
			status: 'refunded',
			refundAmount: 1900,
			refundId: 'rfd_1',
			refundMethod: 'cash',
			refundReference: 'Cash at the counter',
			restockedAt: '2026-05-03T00:00:00Z',
			history: [
				{ at: '2026-05-01T00:00:00Z', status: 'requested', by: 'shopper', note: '' },
				{ at: '2026-05-03T00:00:00Z', status: 'refunded', by: 'Sam', note: 'Done' },
			],
			notes: [{ at: '2026-05-02T00:00:00Z', by: 'Sam', text: 'Called the shopper' }],
		};
		const value = valueOf(checkImportedReturn(claim, RULES));
		expect(value).toMatchObject({ reference: 'RR-0001', kind: 'exchange', refundMethod: 'cash', lines: [{ restock: true }] });
		expect(value.createdAt).toEqual(new Date('2026-05-01T00:00:00Z'));
		expect(
			pathsOf(
				checkImportedReturn(
					{
						...claim,
						kind: 'swap',
						lines: [{ lineId: 'x', quantity: 0, serials: [''], restock: 'yes', restockedAt: 'x' }],
						photos: [{ type: 'image/png', size: -1 }],
						history: [],
						notes: [{ at: '2026-05-02T00:00:00Z', by: 'Sam', text: '' }],
						refundReference: 'x'.repeat(121),
						refundMethod: 'cheque',
						status: 'lost',
						orderNumber: '',
						refundId: 7,
					},
					RULES,
				),
			),
		).toEqual([
			'/lines/0/serials',
			'/lines/0/restockedAt',
			'/lines/0/lineId',
			'/lines/0/quantity',
			'/lines/0/restock',
			'/kind',
			'/photos/0/key',
			'/photos/0/size',
			'/history',
			'/notes/0/text',
			'/refundReference',
			'/orderNumber',
			'/status',
			'/refundId',
			'/refundMethod',
		]);
		expect(
			pathsOf(checkImportedReturn({ ...claim, history: [{ at: 'x', status: 'gone', note: 'x'.repeat(1001) }] }, RULES)),
		).toEqual(['/history/0/note', '/history/0/at', '/history/0/status']);
	});

	it('take alerts of members and guests, never due, and refuse ones that do not fit', () => {
		expect(
			valueOf(
				checkImportedAlert(
					{
						id: idOf('alr', 1),
						kind: 'price_drop',
						productId: idOf('prd', 1),
						variantId: idOf('var', 1),
						userId: 'usr_member0000000001',
						email: 'a@b.example',
						price: 1000,
						targetPrice: 900,
						status: 'failed',
						tries: 5,
						createdAt: '2026-01-01T00:00:00Z',
					},
					RULES,
				),
			),
		).toMatchObject({ dueAt: null, phone: '', tries: 5, customerId: null, targetPrice: 900 });
		expect(
			pathsOf(
				checkImportedAlert(
					{
						id: idOf('alr', 2),
						kind: 'back_in_stock',
						productId: idOf('prd', 1),
						userId: 'usr_member0000000001',
						price: 5,
						status: 'waiting',
						dueAt: '2026-01-01T00:00:00Z',
						tokenHash: 'x',
						tries: 6,
					},
					RULES,
				),
			),
		).toEqual(['/dueAt', '/email', '/price', '/tokenHash', '/tries']);
		expect(
			pathsOf(
				checkImportedAlert(
					{ id: idOf('alr', 3), kind: 'price_drop', productId: idOf('prd', 1), targetPrice: 5, status: 'sent' },
					RULES,
				),
			),
		).toEqual(['/phone', '/price']);
		expect(
			pathsOf(
				checkImportedAlert(
					{
						id: idOf('alr', 4),
						kind: 'price_drop',
						productId: idOf('prd', 1),
						phone: '5550002222',
						price: 100,
						targetPrice: 100,
						status: 'waiting',
					},
					RULES,
				),
			),
		).toEqual(['/targetPrice']);
		expect(
			pathsOf(
				checkImportedAlert(
					{ id: idOf('alr', 5), kind: 'sale', productId: 'x', phone: '5550002222', status: 'waiting' },
					RULES,
				),
			),
		).toEqual(['/kind']);
	});

	it('take a member’s wishlist, and refuse one that does not fit', () => {
		expect(
			valueOf(
				checkImportedWishlist(
					{ userId: 'usr_member0000000001', productIds: [idOf('prd', 1)], createdAt: '2026-01-01T00:00:00Z' },
					RULES,
				),
			),
		).toMatchObject({ productIds: [idOf('prd', 1)] });
		expect(
			pathsOf(checkImportedWishlist({ userId: '', productIds: [idOf('prd', 1), idOf('prd', 1)], name: 'x' }, RULES)),
		).toEqual(['/name', '/userId', '/productIds']);
		expect(
			pathsOf(
				checkImportedWishlist(
					{ userId: 'usr_member0000000001', productIds: Array.from({ length: 201 }, (_, i) => idOf('prd', i)) },
					RULES,
				),
			),
		).toEqual(['/productIds']);
	});
});

describe('finish', () => {
	it('count a customer’s orders, RTO parcels and last order', () => {
		expect(rtoKeysOf(DEFAULT_FLOW)).toEqual(['returned']);
		const early = new Date('2026-01-01T00:00:00Z');
		const late = new Date('2026-02-01T00:00:00Z');
		expect(customerCounts([])).toEqual({ orderCount: 0, rtoCount: 0, lastOrderAt: null });
		expect(
			customerCounts([
				{ count: 2, rto: 1, last: late },
				{ count: 1, rto: 0, last: early },
				{ count: 0, rto: 0, last: null },
			]),
		).toEqual({ orderCount: 3, rtoCount: 1, lastOrderAt: late });
	});

	it('mark sold the serials holding orders list, unless they came back', () => {
		expect(holdsSerials({ role: 'delivered' })).toBe(true);
		expect(holdsSerials({ role: 'returned_to_origin' })).toBe(false);
		expect(holdsSerials({ role: 'refunded', deliveredAt: null })).toBe(false);
		expect(holdsSerials({ role: 'refunded', deliveredAt: new Date() })).toBe(true);
		const orders = [
			{ id: 'o1', role: 'delivered', lines: [{ id: 'l1', serials: ['A', 'B'] }, { id: 'l2' }] },
			{ id: 'o2', role: 'cancelled', lines: [{ id: 'l3', serials: ['C'] }] },
			{ id: 'o3', role: 'shipped', lines: [{ id: 'l4', serials: ['D', 'E'] }] },
		];
		const claims = [
			{ orderId: 'o1', restockedAt: null, lines: [{ serials: ['A'], restockedAt: new Date() }] },
			{ orderId: 'o3', restockedAt: new Date(), lines: [{ serials: ['D'] }, { serials: ['E'], restock: false }] },
			{ orderId: 'o3' },
		];
		expect(serialsSoldTo(orders, claims)).toEqual([
			{ serial: 'B', orderId: 'o1', lineId: 'l1' },
			{ serial: 'E', orderId: 'o3', lineId: 'l4' },
		]);
	});
});
