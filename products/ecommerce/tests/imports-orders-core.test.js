/**
 * The shoppers' and orders' checks in import mode (`core/imports-orders.js`, PLAN 0.8.10 K10): what each collection
 * takes and refuses, field by field, and the pure parts of finish. No database.
 */
import { emptyWebsiteSettings } from '@ss/contracts/website-settings';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FLOW } from '../core/flow.js';
import { MAX_NOTE } from '../core/orders.js';
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
/** The Portal's Region and format with what a test needs: the currency, the country and the calling code. @param {string} currency @param {string} country @param {string} [callingCode] */
const regionOf = (currency, country, callingCode = '') => {
	const { region } = emptyWebsiteSettings('web_00000000000000000000000001');
	return { ...region, currency, country, phone: { ...region.phone, callingCode } };
};
const RULES = importRules({
	flow: DEFAULT_FLOW,
	checkout: { numberPattern: '{prefix}{year}-{number}', numberPrefix: 'S-', numberDigits: 4 },
	region: regionOf('USD', 'GB', '+1'),
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

/** A valid delivered order (default flow, yearly `S-` numbers of 4 digits, USD); `patch` replaces top-level fields. @param {Record<string, unknown>} [patch] */
const order = (patch = {}) => ({
	id: idOf('ord', 1),
	number: 'S-2026-0007',
	customer: { userId: 'usr_member0000000001', customerId: idOf('cus', 1), name: 'Sara', phone: '5550001111' },
	address: { name: 'Sara', phone: '(555) 000-1111', line1: '1 Main Street', city: 'Springfield' },
	delivery: { method: 'delivery', zone: 'city', rate: 'standard', rateName: 'Standard', fee: 200, locationId: null },
	lines: [LINE],
	totals: { subtotal: 2000, discount: 100, delivery: 200, tax: 0, total: 2100, currency: 'USD', taxIncluded: true },
	promotions: { released: false },
	payment: { method: 'cod', kind: 'on_delivery' },
	payments: [{ id: idOf('opy', 1), method: 'cod', amount: 2100, at: '2026-03-04T00:00:00Z' }],
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
			numbers: { pattern: '{prefix}{year}-{number}', prefix: 'S-', digits: 4 },
			currency: 'USD',
			phoneRules: { defaultCallingCode: '+1' },
		});
		expect(
			importRules({
				flow: DEFAULT_FLOW,
				checkout: { numberDigits: 12 },
				region: regionOf('USD', ''),
				now: NOW,
			}),
		).toMatchObject({
			numbers: { pattern: '{prefix}{number}', prefix: '', suffix: '', digits: 10 },
			currency: 'USD',
			phoneRules: { defaultCallingCode: '', trunkPrefix: '' },
		});
		// without a calling code, national numbers take the country's calling code (K12)
		const british = importRules({
			flow: DEFAULT_FLOW,
			checkout: { numberDigits: 'x' },
			region: regionOf('GBP', 'GB'),
			now: NOW,
		});
		expect(british).toMatchObject({ numbers: { digits: 6 }, currency: 'GBP', phoneRules: { defaultCallingCode: '+44' } });
		expect(valueOf(checkImportedCustomer({ id: idOf('cus', 9), name: 'Pat', phone: '020 7946 0958' }, british))).toMatchObject({
			phone: '+442079460958',
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
			guestKey: 'p:+15550002222',
			phone: '+15550002222',
			phoneDigits: '15550002222',
			note: 'Calls first',
		});
		expect(guest.createdAt).toEqual(new Date('2025-01-01T00:00:00Z'));
		expect(member).not.toHaveProperty('guestKey');
	});

	it('key guests as checkout.guestIdentity says: an email guest needs no phone (dynamic model §5)', () => {
		/** @param {string} guestIdentity */
		const rulesFor = (guestIdentity) =>
			importRules({ flow: DEFAULT_FLOW, checkout: { guestIdentity }, region: regionOf('USD', 'US'), now: NOW });
		const byEmail = { id: idOf('cus', 5), guest: true, name: 'Ella', email: 'Ella@Example.com' };
		expect(valueOf(checkImportedCustomer(byEmail, rulesFor('email')))).toMatchObject({
			guestKey: 'e:ella@example.com',
			phone: '',
			phoneDigits: '',
		});
		expect(valueOf(checkImportedCustomer({ ...byEmail, phone: '555 000 2222' }, rulesFor('either')))).toMatchObject({
			guestKey: 'p:+15550002222',
		});
		expect(valueOf(checkImportedCustomer(byEmail, rulesFor('either')))).toMatchObject({ guestKey: 'e:ella@example.com' });
		expect(pathsOf(checkImportedCustomer(byEmail, rulesFor('phone')))).toEqual(['/phone']);
		expect(pathsOf(checkImportedCustomer({ ...byEmail, email: '' }, rulesFor('email')))).toEqual(['/email']);
		// a guestKey given is derived again, never taken
		expect(valueOf(checkImportedCustomer({ ...byEmail, guestKey: 'e:other@example.com' }, rulesFor('email')))).toMatchObject({
			guestKey: 'e:ella@example.com',
		});
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
		// a guest needs a name and a phone (guestIdentity phone, the default); a block needs its reason
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

	it('take field values only as the shop’s own fields take them (review L5)', () => {
		/** @param {Record<string, unknown>} over @returns {any} */
		const field = (over) => ({
			name: 'Field',
			type: 'text',
			choices: [],
			multiple: false,
			maxValues: 1,
			min: null,
			max: null,
			decimals: 0,
			dates: 'any',
			format: null,
			...over,
		});
		const rules = importRules({
			flow: DEFAULT_FLOW,
			checkout: { numberPattern: '{prefix}{year}-{number}', numberPrefix: 'S-', numberDigits: 4 },
			region: regionOf('USD', 'GB', '+1'),
			now: NOW,
			fields: {
				customer: [
					field({ id: 'att_000000000000000000000001', name: 'Tax number' }),
					field({
						id: 'att_000000000000000000000002',
						name: 'Tier',
						type: 'choice',
						choices: [{ value: 'gold', label: 'Gold' }],
					}),
				],
				order: [field({ id: 'att_000000000000000000000003', name: 'Gift', type: 'yes_no' })],
			},
		});
		const guest = { id: idOf('cus', 5), name: 'Gina', phone: '+15550002222' };
		/** @param {Record<string, unknown>} fields */
		const customer = (fields) => checkImportedCustomer({ ...guest, fields }, rules);
		expect(valueOf(customer({ att_000000000000000000000001: 'TX-1', att_000000000000000000000002: 'gold' })).fields).toEqual({
			att_000000000000000000000001: 'TX-1',
			att_000000000000000000000002: 'gold',
		});
		// a field the shop does not have, a choice it does not offer, an order field on a customer
		expect(pathsOf(customer({ att_000000000000000000000009: 'x' }))).toEqual(['/fields/att_000000000000000000000009']);
		expect(pathsOf(customer({ att_000000000000000000000002: 'silver' }))).toEqual(['/fields/att_000000000000000000000002']);
		expect(pathsOf(customer({ att_000000000000000000000003: true }))).toEqual(['/fields/att_000000000000000000000003']);
		// orders take the order fields, in their type
		const gift = (/** @type {unknown} */ value) =>
			checkImportedOrder({ ...order(), fields: { att_000000000000000000000003: value } }, rules);
		expect(valueOf(gift(true)).fields).toEqual({ att_000000000000000000000003: true });
		expect(pathsOf(gift('maybe'))).toEqual(['/fields/att_000000000000000000000003']);
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
			payment: { kind: 'on_delivery', state: 'paid', paid: 2100, refunded: 0, advance: 0, checkoutUrl: '', proof: null },
			payments: [{ by: { kind: 'server', id: 'server', name: 'Server' }, reference: '', proofKey: null }],
			lines: [{ kind: 'physical', serials: [], booking: null, licenses: [], returnedQuantity: 0, grade: null, image: null }],
			phoneDigits: '15550001111',
			shipment: null,
			attachments: [],
			holdUntil: null,
			accessKeyHash: null,
		});
		expect(value.createdAt).toEqual(new Date('2026-03-01T00:00:00Z'));
	});

	it('keep an address’s country as its code (given as a code or an English name) and its postal code upper case', () => {
		const at = (/** @type {Record<string, string>} */ place) =>
			checkImportedOrder({ ...order(), address: { ...order().address, ...place } }, RULES);
		expect(valueOf(at({ country: 'United Kingdom', postalCode: 'sw1a 1aa' })).address).toMatchObject({
			country: 'GB',
			postalCode: 'SW1A 1AA',
		});
		expect(valueOf(at({ country: 'us' })).address.country).toBe('US');
		expect(pathsOf(at({ country: 'Atlantis' }))).toEqual(['/address/country']);
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
							licenses: [idOf('lic', 1)],
							booking: { start: '2027-01-01T10:00:00Z', end: '2027-01-01T11:00:00Z' },
							warrantyTime: { amount: 365, unit: /** @type {const} */ ('days') },
							dealId: idOf('deal', 1),
							returnedQuantity: 1,
							cost: 500,
						},
					],
					refunds: [
						{
							id: idOf('orf', 1),
							method: 'payments',
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
						kind: 'gateway',
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
					attachments: [
						{ kind: 'packing_video', key: 'ecommerce/videos/o1.mp4', at: '2026-03-02T00:00:00Z', by: 'Sam' },
						{ kind: 'packing_video', url: 'https://youtu.be/dQw4w9WgXcQ' },
					],
					seenBy: ['usr_staff'],
					accessKeyHash: 'A'.repeat(43),
					idempotencyKey: 'checkout-1',
					returnRestocked: true,
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
			lines: [
				{
					kind: 'digital',
					downloads: 0,
					serials: ['354000000000001', '354000000000002'],
					warrantyTime: { amount: 365, unit: /** @type {const} */ ('days') },
				},
			],
			payment: { state: 'refunded', via: 'payments', proof: { key: 'ecommerce/proofs/1.png' } },
			refunds: [{ by: { email: 'sam@shop.example', role: 'owner' }, manual: false, refundId: 'rfd_1' }],
			shipment: { courier: 'swift', trackingNumber: 'TRK-9', booked: true, trackingNote: '' },
			attachments: [
				{ id: 'att_0000000000', kind: 'packing_video', type: 'video', key: 'ecommerce/videos/o1.mp4', url: null, by: 'Sam' },
				{
					id: 'att_0000000001',
					kind: 'packing_video',
					type: 'video',
					key: null,
					url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
					by: '',
				},
			],
			promotions: { pointsReversed: 20, role: { key: 'member' } },
			idempotencyKey: 'checkout-1',
			phoneDigits: '15550001111',
			returnRestocked: true,
		});
		expect(value.lines[0].booking.start).toEqual(new Date('2027-01-01T10:00:00Z'));
	});

	it('take a waiting order with nothing paid, a pending payment and its time to wait', () => {
		const waiting = order({
			status: 'pending_payment',
			history: [{ at: '2026-10-05T09:00:00Z', to: 'pending_payment' }],
			payments: [],
			payment: { method: 'online', kind: 'gateway', state: 'pending' },
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

	it('keep the note for the shopper of a history entry, as a move keeps it: trimmed, bounded, only when there is one', () => {
		/** @param {unknown} shopperNote */
		const noted = (shopperNote) =>
			checkImportedOrder(
				order({
					history: [
						{ at: '2026-03-01T00:00:00Z', from: null, to: 'awaiting_confirmation', by: 'shopper', note: '' },
						{
							at: '2026-03-04T00:00:00Z',
							from: 'awaiting_confirmation',
							to: 'delivered',
							by: 'Staff',
							note: 'Left with the neighbor',
							shopperNote,
						},
					],
				}),
				RULES,
			);
		const history = valueOf(noted('  Your package is with your neighbor at number 3.  ')).history;
		expect(history[1]).toMatchObject({
			note: 'Left with the neighbor',
			shopperNote: 'Your package is with your neighbor at number 3.',
		});
		expect(history[0]).not.toHaveProperty('shopperNote');
		for (const none of ['', '   ', null, undefined]) expect(valueOf(noted(none)).history[1]).not.toHaveProperty('shopperNote');
		expect(pathsOf(noted('x'.repeat(MAX_NOTE)))).toEqual([]);
		expect(pathsOf(noted('x'.repeat(MAX_NOTE + 1)))).toEqual(['/history/1/shopperNote']);
		expect(pathsOf(noted(42))).toEqual(['/history/1/shopperNote']);
	});

	it('take a number in the website’s form only: running or yearly, with at least its digits', () => {
		const running = { ...RULES, numbers: { ...RULES.numbers, pattern: /** @type {const} */ ('{prefix}{number}') } };
		expect(pathsOf(checkImportedOrder(order({ number: 'S-0007' }), running))).toEqual([]);
		expect(pathsOf(checkImportedOrder(order({ number: 'S-1234567' }), running))).toEqual([]);
		const refused = checkImportedOrder(order({ number: 'S-2026-0007' }), running);
		expect(refused).toEqual({
			ok: false,
			errors: [
				{
					path: '/number',
					message:
						'An order number of this website is S-<at least 4 digits> (checkout.numberPattern, numberPrefix, numberSuffix and numberDigits).',
				},
			],
		});
		expect(pathsOf(checkImportedOrder(order({ number: 'S-007' }), running))).toEqual(['/number']);
		expect(pathsOf(checkImportedOrder(order({ number: 'S-0007' }), RULES))).toEqual(['/number']);
		expect(pathsOf(checkImportedOrder(order({ number: 'S-2026-007' }), RULES))).toEqual(['/number']);
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
						history: [{ at: 'later', from: 'nowhere', to: 'confirmed', reason: 'Lost!', kind: 'other', extra: 1 }],
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
			'/seenBy',
			'/returnRestocked',
			'/note',
		]);
		// a canceled order holds no stock
		expect(
			pathsOf(
				checkImportedOrder(
					order({ status: 'canceled', history: [{ at: '2026-03-01T00:00:00Z', to: 'canceled' }], deliveredAt: null }),
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
			warrantyTime: { amount: 99999, unit: /** @type {const} */ ('days') },
			dealId: 'deal',
			booking: 'today',
			color: 'red',
		};
		expect(pathsOf(checkImportedOrder(order({ lines: [bad] }), RULES))).toEqual([
			'/lines/0/color',
			'/lines/0/kind',
			'/lines/0/quantity',
			'/lines/0/discount',
			'/lines/0/total',
			'/lines/0/serials',
			'/lines/0/downloads',
			'/lines/0/warrantyTime',
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
						payments: [{ id: idOf('opy', 1), method: 'cod', amount: 2290, at: '2026-03-04T00:00:00Z' }],
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
					order({ payments: [], payment: { method: 'cod', kind: 'on_delivery', state: 'paid', paid: 2100, refunded: 5 } }),
					RULES,
				),
			),
		).toEqual(['/payment/paid', '/payment/refunded', '/payment/state']);
		expect(
			pathsOf(
				checkImportedOrder(
					order({
						payments: [
							{ id: idOf('opy', 1), method: 'cod', amount: 3000, at: '2026-03-04T00:00:00Z' },
							{
								id: idOf('opy', 1),
								method: 'Check!',
								amount: 0,
								reference: 'x'.repeat(121),
								at: '2099-01-01T00:00:00Z',
								by: { kind: 'user' },
							},
						],
						refunds: [{ id: idOf('orf', 1), method: 'cod', amount: 4000, at: '2026-03-05T00:00:00Z', manual: 'no' }],
						payment: {
							method: 'Check!',
							kind: 'on_delivery',
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
		expect(
			pathsOf(checkImportedOrder(order({ payment: { method: 'cod', kind: 'on_delivery', state: 'settled' } }), RULES)),
		).toEqual(['/payment/state']);
		expect(pathsOf(checkImportedOrder(order({ payment: 'cash' }), RULES))).toEqual([
			'/payment',
			'/payment/method',
			'/payment/kind',
		]);
	});

	it('refuse a shipment or attachments that do not fit', () => {
		expect(
			pathsOf(
				checkImportedOrder(
					order({
						shipment: { trackingNumber: 'TRK-1', trackingUrl: 'ftp://x', booked: 1, checkedAt: 'x' },
						attachments: [{ kind: 'photo', key: 'dQw4w9WgXcQ' }, { url: 'ftp://x' }, {}],
					}),
					RULES,
				),
			),
		).toEqual([
			'/shipment/courier',
			'/shipment/trackingUrl',
			'/shipment/booked',
			'/shipment/checkedAt',
			'/attachments/0/kind',
			'/attachments/1/kind',
			'/attachments/1',
			'/attachments/2/kind',
			'/attachments/2',
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
			refundMethod: 'cod',
			refundReference: 'Cash at the counter',
			restockedAt: '2026-05-03T00:00:00Z',
			history: [
				{ at: '2026-05-01T00:00:00Z', status: 'requested', by: 'shopper', note: '' },
				{ at: '2026-05-03T00:00:00Z', status: 'refunded', by: 'Sam', note: 'Done' },
			],
			notes: [{ at: '2026-05-02T00:00:00Z', by: 'Sam', text: 'Called the shopper' }],
		};
		const value = valueOf(checkImportedReturn(claim, RULES));
		expect(value).toMatchObject({ reference: 'RR-0001', kind: 'exchange', refundMethod: 'cod', lines: [{ restock: true }] });
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
						refundMethod: 'Check!',
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
	it('count a customer’s orders, RTO packages and last order', () => {
		expect(rtoKeysOf(DEFAULT_FLOW)).toEqual(['returned']);
		const late = new Date('2026-02-01T00:00:00Z');
		expect(customerCounts(undefined)).toEqual({ orderCount: 0, rtoCount: 0, lastOrderAt: null });
		expect(customerCounts({ count: 3, rto: 1, last: late })).toEqual({ orderCount: 3, rtoCount: 1, lastOrderAt: late });
	});

	it('mark sold the serials holding orders list, unless they came back', () => {
		expect(holdsSerials({ role: 'delivered' })).toBe(true);
		expect(holdsSerials({ role: 'returned_to_origin' })).toBe(false);
		expect(holdsSerials({ role: 'refunded', deliveredAt: null })).toBe(false);
		expect(holdsSerials({ role: 'refunded', deliveredAt: new Date() })).toBe(true);
		const orders = [
			{ id: 'o1', role: 'delivered', lines: [{ id: 'l1', serials: ['A', 'B'] }, { id: 'l2' }] },
			{ id: 'o2', role: 'canceled', lines: [{ id: 'l3', serials: ['C'] }] },
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
