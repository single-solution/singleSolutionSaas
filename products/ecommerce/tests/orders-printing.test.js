/**
 * Invoices, packing slips and pick lists (E35): per-line warranty, grade and serials, the fee, role discount and points
 * apart, payment and refund entries (staff names on the staff copy only) and the cash due on delivery on the invoice;
 * the shopper's invoice from placement or from confirmation (`shopperFrom`); packing slips of up to 50 orders as one
 * document with the cash to collect and empty serial slots; a pick list of up to 100 orders by variant.
 */
import { DEFAULT_FORMAT, createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cashToCollect, invoiceHtml, invoiceTexts, packingSlipsHtml, pickListHtml } from '../core/invoice.js';
import { COLLECTIONS } from '../core/model.js';
import { ALL, UNIT_TYPES, readyShop } from './helpers.js';

/** @typedef {import('../core/model.js').OrderRecord} OrderRecord */
/** @typedef {OrderRecord['lines'][number]} OrderLine */

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
/** @type {string} */
let ticket;

beforeAll(async () => {
	shop = await readyShop();
	ticket = await shop.ticket();
});
afterAll(async () => shop.product.close());

const STAFF = { kind: 'staff', id: 'stf_1', name: 'Omar Staff' };

/**
 * An order line as checkout stores it.
 * @param {Partial<OrderLine>} [patch]
 * @returns {OrderLine}
 */
const lineOf = (patch = {}) => ({
	id: createId('oln'),
	productId: 'prd_1',
	variantId: 'var_1',
	kind: 'physical',
	name: 'Phone',
	variantName: 'Black / 128 GB',
	sku: 'PH-128',
	grade: 'a',
	gradeLabel: 'Grade A',
	image: null,
	unitPrice: 50000,
	quantity: 2,
	discount: 0,
	tax: 0,
	total: 100000,
	cost: null,
	categoryIds: [],
	brandId: null,
	locationId: null,
	serials: ['SN-111', 'SN-222'],
	booking: null,
	licences: [],
	returnedQuantity: 0,
	warrantyDays: 365,
	...patch,
});

/**
 * An order record as checkout stores it: deals 50.00, a member discount 30.00 and points worth 20.00 inside `discount`,
 * a cash-handling fee of 5.00, COD with a 100.00 advance paid by transfer and 10.00 of it refunded.
 * @param {Partial<OrderRecord>} [patch]
 * @returns {OrderRecord}
 */
const orderOf = (patch = {}) => ({
	id: createId('ord'),
	number: `DOC-2026-${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`,
	customer: { userId: 'usr_shopper0000001', name: 'Sara Shopper', email: 'sara@example.com', phone: '+15550001111' },
	address: {
		name: 'Sara Shopper',
		phone: '+15550001111',
		line1: '1 Main Street',
		line2: '',
		city: 'Springfield',
		area: 'North',
		region: '',
		postalCode: '12345',
		country: 'US',
		notes: '',
	},
	delivery: { method: 'delivery', zone: 'city', fee: 250, locationId: null },
	lines: [lineOf()],
	totals: {
		subtotal: 100000,
		discount: 10000,
		delivery: 250,
		tax: 0,
		total: 90750,
		currency: 'USD',
		taxIncluded: false,
		fee: 500,
		roleDiscount: 3000,
	},
	promotions: {
		couponId: null,
		couponCode: '',
		dealIds: [],
		bundleIds: [],
		pointsRedeemed: 200,
		pointsValue: 2000,
		pointsEarned: 0,
		released: false,
		role: { key: 'member', percent: 3, label: 'Club price' },
	},
	payment: {
		method: 'cod',
		kind: 'on_delivery',
		state: 'unpaid',
		paymentId: null,
		advance: 10000,
		paid: 10000,
		refunded: 1000,
		checkedAt: null,
	},
	payments: [
		{
			id: 'opy_1',
			method: 'bank_transfer',
			amount: 10000,
			reference: 'TRX-778',
			proofKey: null,
			note: 'Checked the bank app',
			by: STAFF,
			at: new Date('2026-10-04T12:00:00Z'),
		},
	],
	refunds: [
		{
			id: 'orf_1',
			method: 'cod',
			amount: 1000,
			reference: 'RF-1',
			claimId: null,
			note: 'Goodwill',
			by: STAFF,
			at: new Date('2026-10-05T08:00:00Z'),
		},
	],
	status: 'confirmed',
	role: 'open',
	history: [],
	shipment: null,
	stockHeld: true,
	holdUntil: null,
	idempotencyKey: createId('key'),
	note: '',
	staffNote: '',
	placedAt: new Date('2026-10-04T10:00:00Z'),
	deliveredAt: null,
	createdAt: new Date(shop.now()),
	updatedAt: new Date(shop.now()),
	...patch,
});

/** @param {OrderRecord} order */
const seed = async (order) => {
	await (await shop.db()).collection(COLLECTIONS.orders).insertOne({ ...order });
	return order;
};

describe('the invoice (E35)', () => {
	it('shows warranty, grade and serials, the fee, role discount and points apart, the entries and the cash due', async () => {
		const order = await seed(orderOf());
		const html = (await shop.admin(ticket, 'GET', `/v1/admin/orders/${order.id}/invoice`)).text;
		expect(html).toContain('Black / 128 GB · SKU PH-128 · Grade: Grade A · Warranty: 365 days');
		expect(html).toContain('Serial numbers: SN-111, SN-222');
		// discount 100.00 = deals 50.00 + the member discount 30.00 + points 20.00, each on its own line
		expect(html).toContain('<td>Discount</td><td class="num">−USD 50.00</td>');
		expect(html).toContain('<td>Club price</td><td class="num">−USD 30.00</td>');
		expect(html).toContain('<td>Points (200)</td><td class="num">−USD 20.00</td>');
		expect(html).toContain('<td>Cash handling</td><td class="num">USD 5.00</td>');
		expect(html).toContain('<h2>Payments</h2>');
		expect(html).toContain('Bank transfer · TRX-778 · Checked the bank app · Omar Staff');
		expect(html).toContain('<h2>Refunds</h2>');
		expect(html).toContain('Cash on delivery · RF-1 · Goodwill · Omar Staff');
		expect(html).toContain('<tr class="grand"><td>Cash due on delivery</td><td class="num">USD 807.50</td></tr>');
		expect((await shop.api('GET', `/v1/orders/${order.id}/invoice`)).text).toBe(html);
	});

	it('leaves staff names and notes off the shopper’s copy', async () => {
		const order = await seed(orderOf());
		const html = (await shop.visitor('GET', `/v1/shop/orders/${order.id}/invoice`, { signIn: await shop.signIn() })).text;
		expect(html).toContain('Bank transfer · TRX-778');
		expect(html).toContain('Club price');
		expect(html).not.toContain('Omar Staff');
		expect(html).not.toContain('Checked the bank app');
	});

	it('uses the merchant’s labels, and the role label setting when the role has none', async () => {
		await shop.setting('invoices', 'labelFee', 'COD charge');
		await shop.setting('invoices', 'labelCashDue', 'Collect in cash');
		try {
			const order = await seed(orderOf({ promotions: { ...orderOf().promotions, role: null } }));
			const html = (await shop.api('GET', `/v1/orders/${order.id}/invoice`)).text;
			expect(html).toContain('COD charge');
			expect(html).toContain('Collect in cash');
			expect(html).toContain('<td>Member discount</td>');
		} finally {
			await shop.setting('invoices', 'labelFee', 'Cash handling');
			await shop.setting('invoices', 'labelCashDue', 'Cash due on delivery');
		}
	});

	it('gives shoppers their invoice once confirmed with `shopperFrom` confirmed', async () => {
		const signIn = await shop.signIn();
		const url = (/** @type {string} */ id) => `/v1/shop/orders/${id}/invoice`;
		const waiting = await seed(orderOf({ status: 'pending', role: 'awaiting_confirmation' }));
		const open = await seed(orderOf());
		const cancelled = await seed(orderOf({ status: 'cancelled', role: 'cancelled' }));
		expect((await shop.visitor('GET', url(waiting.id), { signIn })).status).toBe(200);
		await shop.setting('invoices', 'shopperFrom', 'confirmed');
		try {
			const early = await shop.visitor('GET', url(waiting.id), { signIn });
			expect(early.status).toBe(404);
			expect(early.json.type).toMatch(/not_found$/);
			expect((await shop.visitor('GET', url(cancelled.id), { signIn })).status).toBe(404);
			expect((await shop.visitor('GET', url(open.id), { signIn })).status).toBe(200);
			// staff always print it
			expect((await shop.api('GET', `/v1/orders/${waiting.id}/invoice`)).status).toBe(200);
		} finally {
			await shop.setting('invoices', 'shopperFrom', 'placed');
		}
	});
});

describe('packing slips of several orders (E35)', () => {
	it('prints one document with the cash to collect and empty slots for missing serials', async () => {
		await shop.list('item_types', UNIT_TYPES);
		const phone = await shop.seedProduct({ typeKey: 'numbered' });
		const cable = await shop.seedProduct({ name: 'Cable' });
		const cod = await seed(
			orderOf({
				lines: [
					lineOf({ productId: phone.id, serials: ['SN-1'], quantity: 3 }),
					lineOf({ productId: cable.id, name: 'Cable', serials: [], quantity: 2 }),
				],
			}),
		);
		const paid = await seed(
			orderOf({
				payment: {
					method: 'online',
					kind: 'gateway',
					state: 'paid',
					paymentId: 'pay_1',
					advance: 0,
					paid: 90750,
					refunded: 0,
					checkedAt: null,
				},
				payments: [],
				refunds: [],
			}),
		);
		const answer = await shop.api('GET', `/v1/orders/packing-slips?ids=${cod.id},${paid.id},${cod.id}`);
		expect(answer.status).toBe(200);
		expect(answer.headers.get('content-security-policy')).toContain("default-src 'none'");
		const html = answer.text;
		expect(html.match(/<html>/g)).toHaveLength(1);
		expect(html.match(/<section class="sheet">/g)).toHaveLength(2);
		expect(html.indexOf(cod.number)).toBeLessThan(html.indexOf(paid.number));
		expect(html.match(/Cash due on delivery: USD 807\.50/g)).toHaveLength(1);
		// the phone has 3 units and 1 serial: 2 empty slots; the cable's type numbers no units
		expect(html.match(/<span class="slot"><\/span>/g)).toHaveLength(2);
		expect(html).not.toContain('Club price');
		const admin = await shop.admin(ticket, 'GET', `/v1/admin/orders/packing-slips?ids=${cod.id}`);
		expect(admin.status).toBe(200);
	});

	it('takes 1–50 known orders, with orders.read and the Invoices feature', async () => {
		const order = await seed(orderOf());
		const many = Array.from({ length: 51 }, () => createId('ord')).join(',');
		expect((await shop.api('GET', `/v1/orders/packing-slips?ids=${many}`)).status).toBe(422);
		expect((await shop.api('GET', '/v1/orders/packing-slips')).status).toBe(422);
		expect((await shop.api('GET', '/v1/orders/packing-slips?ids=nope')).status).toBe(422);
		expect((await shop.api('GET', `/v1/orders/packing-slips?ids=${order.id},ord_missing`)).status).toBe(404);
		const reader = await shop.ticket(['orders.manage']);
		expect((await shop.admin(reader, 'GET', `/v1/admin/orders/packing-slips?ids=${order.id}`)).status).toBe(403);
		await shop.switchOn(ALL.filter((feature) => feature !== 'invoices'));
		try {
			expect((await shop.api('GET', `/v1/orders/packing-slips?ids=${order.id}`)).status).toBe(403);
			expect((await shop.api('GET', `/v1/orders/pick-list?ids=${order.id}`)).status).toBe(403);
		} finally {
			await shop.switchOn(ALL);
		}
	});
});

describe('the pick list (E35)', () => {
	it('adds up the units per variant over up to 100 orders', async () => {
		const first = await seed(
			orderOf({
				lines: [
					lineOf({ variantId: 'var_black', quantity: 2 }),
					lineOf({ variantId: 'var_white', variantName: 'White / 64 GB', sku: 'PH-64', quantity: 1 }),
					lineOf({ variantId: 'var_ebook', kind: 'digital', name: 'Ebook', quantity: 1 }),
				],
			}),
		);
		const second = await seed(orderOf({ lines: [lineOf({ variantId: 'var_black', quantity: 3 })] }));
		const answer = await shop.api('GET', `/v1/orders/pick-list?ids=${first.id},${second.id}`);
		expect(answer.status).toBe(200);
		const html = answer.text;
		expect(html).toContain('<h1>Pick list</h1>');
		expect(html).toContain(`${first.number}, ${second.number}`);
		expect(html).toContain('Black / 128 GB · SKU PH-128 · Grade: Grade A</p></td><td class="num">5</td>');
		expect(html).toContain('White / 64 GB · SKU PH-64 · Grade: Grade A</p></td><td class="num">1</td>');
		expect(html).not.toContain('Ebook');
		expect(html).not.toContain('USD');
		expect((await shop.admin(ticket, 'GET', `/v1/admin/orders/pick-list?ids=${first.id}`)).status).toBe(200);
		const reader = await shop.ticket(['orders.manage']);
		expect((await shop.admin(reader, 'GET', `/v1/admin/orders/pick-list?ids=${first.id}`)).status).toBe(403);
		const many = Array.from({ length: 101 }, () => createId('ord')).join(',');
		expect((await shop.api('GET', `/v1/orders/pick-list?ids=${many}`)).status).toBe(422);
		const hundred = Array.from({ length: 99 }, () => createId('ord')).join(',');
		expect((await shop.api('GET', `/v1/orders/pick-list?ids=${first.id},${hundred}`)).status).toBe(404);
	});
});

describe('document parts (E35)', () => {
	const business = { name: 'B', email: null, phone: null, address: null };
	const context = {
		business,
		texts: invoiceTexts({}),
		words: { methods: {}, online: '', states: {} },
		columns: ['item', 'quantity', 'unitPrice', 'amount'],
		format: DEFAULT_FORMAT,
		timeZone: 'UTC',
		fields: { list: [], units: new Map(), customers: new Map() },
	};

	it('collects cash only on unpaid cash-on-delivery orders', () => {
		expect(cashToCollect(orderOf())).toBe(80750);
		expect(cashToCollect(orderOf({ payment: { ...orderOf().payment, state: 'paid', paid: 90750 } }))).toBe(0);
		expect(cashToCollect(orderOf({ payment: { ...orderOf().payment, method: 'online', kind: 'gateway' } }))).toBe(0);
		// paid at the counter: nothing for the courier to collect
		expect(cashToCollect(orderOf({ payment: { ...orderOf().payment, method: 'pickup', kind: 'at_pickup' } }))).toBe(0);
		expect(cashToCollect(orderOf({ payment: { ...orderOf().payment, state: 'pending', paid: 0 } }))).toBe(90750);
	});

	it('prints orders without the new parts as before, and entries of other methods by their reference', () => {
		const plain = orderOf({
			totals: { subtotal: 1000, discount: 0, delivery: 0, tax: 0, total: 1000, currency: 'USD', taxIncluded: false },
			promotions: { ...orderOf().promotions, pointsRedeemed: 0, pointsValue: 0, role: null },
			payment: {
				method: 'online',
				kind: 'gateway',
				state: 'paid',
				paymentId: 'p',
				advance: 0,
				paid: 1000,
				refunded: 0,
				checkedAt: null,
			},
			payments: [
				{
					id: 'opy_9',
					method: 'other',
					amount: 1000,
					reference: 'VOUCHER-9',
					proofKey: null,
					note: '',
					by: STAFF,
					at: new Date(),
				},
			],
			refunds: [],
		});
		const html = invoiceHtml(plain, context);
		expect(html).not.toContain('Cash handling');
		expect(html).not.toContain('Member discount');
		expect(html).not.toContain('Points (');
		expect(html).not.toContain('Cash due on delivery');
		expect(html).not.toContain('<h2>Refunds</h2>');
		expect(html).toContain('<td>VOUCHER-9 · Omar Staff</td>');
		const unlogged = { ...plain };
		delete unlogged.payments;
		const without = invoiceHtml(unlogged, context, { shopper: true });
		expect(without).not.toContain('<h2>Payments</h2>');
		const slips = packingSlipsHtml(
			[orderOf({ address: null, delivery: { method: 'pickup', zone: '', fee: 0, locationId: null } })],
			context,
			new Set(['prd_1']),
		);
		expect(slips).toContain('Store pickup');
		expect(slips).not.toContain('class="slot"');
		expect(pickListHtml([orderOf({ lines: [lineOf({ variantName: '', sku: '', gradeLabel: '' })] })], context)).toContain(
			'<strong>Phone</strong></td><td class="num">2</td>',
		);
	});
});
