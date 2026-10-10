/**
 * Invoices and packing slips (PLAN 0.8.8: serials per line): printable HTML for staff and the merchant's server, the
 * shopper's own invoice, texts from the `invoices` settings, business details from business.json.
 */
import { DEFAULT_FORMAT, createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INVOICE_TEXTS, esc, invoiceHtml, invoiceTexts, packingSlipHtml } from '../core/invoice.js';
import { COLLECTIONS } from '../core/model.js';
import { ALL, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
/** @type {string} */
let ticket;

beforeAll(async () => {
	shop = await readyShop();
	ticket = await shop.ticket();
});
afterAll(async () => shop.product.close());

/**
 * An order record as checkout stores it.
 * @param {Partial<import('../core/model.js').OrderRecord>} [patch]
 * @returns {import('../core/model.js').OrderRecord}
 */
const orderOf = (patch = {}) => ({
	id: createId('ord'),
	number: `INV-2026-${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`,
	customer: { userId: 'usr_shopper0000001', name: 'Sara <b>Shopper</b>', email: 'sara@example.com', phone: '+15550001111' },
	address: {
		name: 'Sara Shopper',
		phone: '+15550001111',
		line1: '1 Main Street',
		line2: '',
		city: 'Springfield',
		area: 'North',
		postalCode: '12345',
		country: 'US',
		notes: '',
	},
	delivery: { method: 'delivery', zone: 'city', fee: 250, locationId: null },
	lines: [
		{
			id: createId('oln'),
			productId: 'prd_1',
			variantId: 'var_1',
			kind: 'physical',
			name: 'Phone <script>alert(1)</script>',
			variantName: 'Black / 128 GB',
			sku: 'PH-128',
			grade: 'a',
			gradeLabel: 'Grade A',
			image: null,
			unitPrice: 50000,
			quantity: 2,
			discount: 5000,
			tax: 0,
			total: 95000,
			cost: null,
			categoryIds: [],
			brandId: null,
			locationId: null,
			serials: ['IMEI-111', 'IMEI-222'],
			booking: null,
			licences: [],
			returnedQuantity: 0,
		},
		{
			id: createId('oln'),
			productId: 'prd_2',
			variantId: 'var_2',
			kind: 'digital',
			name: 'Ebook',
			variantName: '',
			sku: '',
			grade: null,
			gradeLabel: '',
			image: null,
			unitPrice: 1000,
			quantity: 1,
			discount: 0,
			tax: 0,
			total: 1000,
			cost: null,
			categoryIds: [],
			brandId: null,
			locationId: null,
			serials: [],
			booking: null,
			licences: [],
			returnedQuantity: 0,
		},
	],
	totals: { subtotal: 101000, discount: 5000, delivery: 250, tax: 1200, total: 97450, currency: 'USD', taxIncluded: false },
	promotions: {
		couponId: null,
		couponCode: '',
		dealIds: [],
		bundleIds: [],
		pointsRedeemed: 0,
		pointsValue: 0,
		pointsEarned: 0,
		released: false,
	},
	payment: { method: 'cod', state: 'unpaid', paymentId: 'pay_adv', advance: 10000, paid: 10000, refunded: 0, checkedAt: null },
	status: 'dispatched',
	role: 'shipped',
	history: [],
	shipment: { courier: 'Swift Post', trackingNumber: 'TR-9', trackingUrl: '', booked: false, status: '', checkedAt: null },
	stockHeld: true,
	holdUntil: null,
	idempotencyKey: createId('key'),
	note: 'Leave with the neighbour',
	staffNote: 'Secret staff note',
	placedAt: new Date('2026-10-04T23:30:00Z'),
	deliveredAt: null,
	createdAt: new Date(shop.now()),
	updatedAt: new Date(shop.now()),
	...patch,
});

/** @param {import('../core/model.js').OrderRecord} order */
const seed = async (order) => {
	await (await shop.db()).collection(COLLECTIONS.orders).insertOne({ ...order });
	return order;
};

describe('printable documents', () => {
	it('prints the invoice with serials, grades, discounts, delivery, tax and payment, escaped', async () => {
		const order = await seed(orderOf());
		const answer = await shop.admin(ticket, 'GET', `/v1/admin/orders/${order.id}/invoice`);
		expect(answer.status).toBe(200);
		expect(answer.headers.get('content-type')).toBe('text/html; charset=utf-8');
		expect(answer.headers.get('content-security-policy')).toContain("default-src 'none'");
		const html = answer.text;
		expect(html).toContain('<style>');
		expect(html).not.toContain('<script>');
		expect(html).toContain('Phone &lt;script&gt;alert(1)&lt;/script&gt;');
		expect(html).toContain('Sara &lt;b&gt;Shopper&lt;/b&gt;');
		expect(html).toContain(order.number);
		expect(html).toContain('Invoice no.');
		expect(html).toContain('Oct 4, 2026');
		expect(html).toContain('Black / 128 GB · SKU PH-128 · Grade: Grade A');
		expect(html).toContain('Serial numbers: IMEI-111, IMEI-222');
		expect(html).toContain('USD 1,000.00');
		expect(html).toContain('−USD 50.00');
		expect(html).toContain('USD 2.50');
		expect(html).toContain('Tax');
		expect(html).toContain('USD 974.50');
		expect(html).toContain('Balance due');
		expect(html).toContain('Cash on delivery · Unpaid');
		expect(html).toContain('Shop');
		expect(html).toContain('hello@shop.example.com');
		expect(html).not.toContain('Secret staff note');
		const server = await shop.api('GET', `/v1/orders/${order.id}/invoice`);
		expect(server.text).toBe(html);
	});

	it('prints the packing slip without prices', async () => {
		const order = await seed(orderOf());
		const slip = await shop.api('GET', `/v1/orders/${order.id}/packing-slip`);
		expect(slip.status).toBe(200);
		expect(slip.text).toContain('Packing slip');
		expect(slip.text).toContain('IMEI-111, IMEI-222');
		expect(slip.text).toContain('Swift Post');
		expect(slip.text).toContain('TR-9');
		expect(slip.text).toContain('Leave with the neighbour');
		expect(slip.text).not.toContain('USD');
		expect(slip.text).not.toContain('Ebook');
		expect((await shop.admin(ticket, 'GET', `/v1/admin/orders/${order.id}/packing-slip`)).status).toBe(200);
		expect((await shop.api('GET', '/v1/orders/ord_missing/packing-slip')).status).toBe(404);
	});

	it('uses the merchant’s texts', async () => {
		await shop.setting('invoices', 'title', 'Tax invoice');
		await shop.setting('invoices', 'footer', 'Thank you!\nReturns within 14 days.');
		await shop.setting('invoices', 'labelBalance', 'Still to pay');
		try {
			const order = await seed(orderOf());
			const html = (await shop.api('GET', `/v1/orders/${order.id}/invoice`)).text;
			expect(html).toContain('<h1>Tax invoice</h1>');
			expect(html).toContain('Thank you!\nReturns within 14 days.');
			expect(html).toContain('Still to pay');
		} finally {
			await shop.setting('invoices', 'title', 'Invoice');
			await shop.setting('invoices', 'footer', '');
		}
	});

	it('needs the Invoices feature and orders.read', async () => {
		const order = await seed(orderOf());
		const reader = await shop.ticket(['orders.manage']);
		expect((await shop.admin(reader, 'GET', `/v1/admin/orders/${order.id}/invoice`)).status).toBe(403);
		await shop.switchOn(ALL.filter((feature) => feature !== 'invoices'));
		try {
			const off = await shop.api('GET', `/v1/orders/${order.id}/invoice`);
			expect(off.status).toBe(403);
			expect(off.json.type).toMatch(/feature_off$/);
		} finally {
			await shop.switchOn(ALL);
		}
	});

	it('gives shoppers the invoice of their own orders only', async () => {
		const mine = await seed(orderOf());
		const theirs = await seed(orderOf({ customer: { userId: 'usr_other00000001', name: 'O', email: '', phone: '' } }));
		const url = (/** @type {string} */ id) => `/v1/shop/orders/${id}/invoice`;
		const anonymous = await shop.visitor('GET', url(mine.id));
		expect(anonymous.status).toBe(403);
		expect(anonymous.json.type).toMatch(/sign_in_required$/);
		const signIn = await shop.signIn();
		const own = await shop.visitor('GET', url(mine.id), { signIn });
		expect(own.status).toBe(200);
		expect(own.text).toContain(mine.number);
		expect((await shop.visitor('GET', url(theirs.id), { signIn })).status).toBe(404);
		expect((await shop.visitor('GET', url('nope'), { signIn })).status).toBe(404);
	});
});

describe('document parts', () => {
	it('prints pickup orders, paid and refunded states, and falls back to the default texts', () => {
		const business = { name: 'B & Co', email: null, phone: null, address: '1 Road' };
		const context = { format: DEFAULT_FORMAT, timeZone: 'Asia/Tokyo' };
		const order = orderOf({
			address: null,
			delivery: { method: 'pickup', zone: '', fee: 0, locationId: null },
			shipment: null,
			note: '',
			totals: { subtotal: 1000, discount: 0, delivery: 0, tax: 100, total: 1000, currency: 'USD', taxIncluded: true },
			payment: {
				method: 'online',
				state: 'partially_refunded',
				paymentId: 'p',
				advance: 0,
				paid: 1000,
				refunded: 300,
				checkedAt: null,
			},
		});
		const texts = invoiceTexts({ title: '', labelTotal: 'Sum', footer: '', other: 1 });
		expect(texts.title).toBe('Invoice');
		expect(texts.labelTotal).toBe('Sum');
		const html = invoiceHtml(order, { business, texts, ...context });
		expect(html).toContain('B &amp; Co');
		expect(html).toContain('1 Road');
		expect(html).toContain('Store pickup');
		expect(html).toContain('Tax included');
		expect(html).toContain('−USD 3.00');
		expect(html).toContain('Paid online · Partially refunded');
		expect(html).toContain('Oct 5, 2026');
		expect(html).not.toContain('Balance due');
		const slip = packingSlipHtml(order, { business, texts, ...context });
		expect(slip).toContain('Store pickup');
		const none = orderOf({
			address: null,
			delivery: { method: 'none', zone: '', fee: 0, locationId: null },
			payment: { ...order.payment, method: /** @type {any} */ ('other'), state: /** @type {any} */ ('odd') },
		});
		expect(invoiceHtml(none, { business, texts, ...context })).toContain('Paid online · Unpaid');
		expect(packingSlipHtml(none, { business, texts, ...context })).toContain('Sara &lt;b&gt;Shopper&lt;/b&gt;');
		const local = {
			...context,
			format: {
				...DEFAULT_FORMAT,
				locale: 'en-GB',
				currencyDisplay: /** @type {const} */ ('custom'),
				currencySymbol: 'Rs',
				wholeUnits: true,
			},
		};
		const formatted = invoiceHtml(order, { business, texts, ...local, timeZone: 'Not/AZone' });
		expect(formatted).toContain('4 Oct 2026');
		expect(formatted).toContain('Rs 10');
		expect(formatted).toContain('−Rs 3');
		expect(esc(null)).toBe('');
		expect(Object.keys(INVOICE_TEXTS)).toContain('labelSerials');
	});
});
