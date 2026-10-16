/**
 * The staff lists carry what a screen shows without opening each record: an order's delivery and its first lines, a
 * product's variants, price range, stock and first photo, a customer's last order, order count, spend and points. The
 * lists read a page with a projection and add what they need in one query for the page, never one query per row.
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS } from '../core/model.js';
import { ORDER_ROW_LINES } from '../core/orders.js';
import { readyShop, storedOrder } from './helpers.js';

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
 * @param {number} n
 * @returns {any}
 */
const line = (n) => ({
	id: createId('oln'),
	productId: createId('prd'),
	variantId: createId('var'),
	kind: 'physical',
	name: `Item ${n}`,
	variantName: n % 2 === 0 ? 'Blue / Large' : '',
	sku: '',
	grade: null,
	gradeLabel: '',
	image: null,
	unitPrice: 1000 * n,
	quantity: n,
	discount: 0,
	tax: 0,
	total: 1000 * n * n,
	cost: null,
	categoryIds: [],
	brandId: null,
	locationId: null,
	serials: [],
	booking: null,
	licenses: [],
});

/**
 * @param {{ number: string, lines: any[], delivery: any, city?: string, userId?: string }} given
 */
const order = ({ number, lines, delivery, city, userId = 'usr_rowbuyer0001' }) => {
	const total = lines.reduce((sum, row) => sum + row.total, 0);
	return storedOrder({
		id: createId('ord'),
		number,
		customer: { userId, name: 'Row Buyer', email: 'row@example.com', phone: '' },
		address: city
			? { name: 'Row Buyer', phone: '+15550003333', line1: '1 Main', city, region: 'IL', postalCode: '62701', country: 'US' }
			: null,
		delivery,
		lines,
		totals: { subtotal: total, discount: 0, delivery: delivery.fee, tax: 0, total, currency: 'USD', taxIncluded: true },
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
		payment: {
			method: 'cod',
			kind: 'cash',
			state: 'unpaid',
			paymentId: null,
			advance: 0,
			paid: 0,
			refunded: 0,
			checkedAt: null,
		},
		status: 'confirmed',
		role: 'open',
		history: [],
		shipment: null,
		stockHeld: true,
		holdUntil: null,
		idempotencyKey: createId('key'),
		note: '',
		staffNote: '',
		placedAt: new Date(shop.now()),
		createdAt: new Date(shop.now()),
		updatedAt: new Date(shop.now()),
		deliveredAt: null,
	});
};

describe('order list rows', () => {
	it('carry the delivery (method, rate name, city) and the first lines, capped, with the rest counted', async () => {
		const data = await shop.db();
		await data.collection(COLLECTIONS.orders).insertMany([
			order({
				number: 'ROW-1',
				lines: [1, 2, 3, 4, 5, 6, 7].map(line),
				delivery: {
					method: 'delivery',
					zone: 'zone_1',
					rate: 'standard',
					rateName: 'Standard shipping',
					fee: 500,
					locationId: null,
				},
				city: 'Springfield',
			}),
			order({
				number: 'ROW-2',
				lines: [line(2)],
				delivery: { method: 'pickup', zone: '', rate: '', rateName: '', fee: 0, locationId: null },
			}),
		]);
		const list = await shop.admin(ticket, 'GET', '/v1/admin/orders?limit=10');
		expect(list.status).toBe(200);
		const byNumber = new Map(list.json.items.map((/** @type {any} */ row) => [row.number, row]));
		const delivered = /** @type {any} */ (byNumber.get('ROW-1'));
		expect(delivered.delivery).toEqual({ method: 'delivery', rateName: 'Standard shipping', city: 'Springfield' });
		expect(ORDER_ROW_LINES).toBe(5);
		expect(delivered.lineCount).toBe(7);
		expect(delivered.lines).toHaveLength(ORDER_ROW_LINES);
		expect(delivered.lines[0]).toEqual({
			name: 'Item 1',
			variantName: '',
			quantity: 1,
			measure: null,
			total: 1000,
			totalText: 'USD 10.00',
		});
		expect(delivered.lines[1]).toEqual({
			name: 'Item 2',
			variantName: 'Blue / Large',
			quantity: 2,
			measure: null,
			total: 4000,
			totalText: 'USD 40.00',
		});
		expect(delivered.itemCount).toBe(28);
		const pickup = /** @type {any} */ (byNumber.get('ROW-2'));
		expect(pickup.delivery).toEqual({ method: 'pickup', rateName: '', city: '' });
		expect(pickup.lineCount).toBe(1);
		// the server token's list is the same
		const fromServer = await shop.api('GET', '/v1/orders?limit=10');
		expect(fromServer.json.items.find((/** @type {any} */ row) => row.number === 'ROW-1').lines).toEqual(delivered.lines);
	});

	it('read a page with a projection: no history, payments or refunds come from the database', async () => {
		const { createFulfillmentStore } = await import('../adapters/fulfillment-store.js');
		const store = createFulfillmentStore(await shop.db());
		const rows = await store.orders.list({ filter: {}, after: null, limit: 5 });
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(row).not.toHaveProperty('history');
			expect(row).not.toHaveProperty('payments');
			expect(row).not.toHaveProperty('refunds');
			expect(row).toHaveProperty('lines');
			expect(row).toHaveProperty('delivery');
		}
	});
});

describe('product list rows', () => {
	it('carry the variant count, price range, stock total and first photo', async () => {
		const variant = (/** @type {number} */ price, /** @type {number} */ stock, active = true) => ({
			id: createId('var'),
			sku: '',
			options: { Size: String(price) },
			price,
			compareAtPrice: null,
			cost: null,
			stock,
			locations: {},
			grade: null,
			active,
		});
		const item = await shop.seedProduct({
			name: 'Range Shirt',
			variants: [variant(1000, 2), variant(2500, 3), variant(1800, 4), variant(9900, 50, false)],
			media: [
				{ key: 'ecommerce/products/range/first.png', type: 'image/png', size: 1, alt: '' },
				{ key: 'ecommerce/products/range/second.png', type: 'image/png', size: 1, alt: '' },
			],
		});
		const list = await shop.admin(ticket, 'GET', '/v1/admin/products?q=Range%20Shirt');
		expect(list.status).toBe(200);
		const row = list.json.items.find((/** @type {any} */ found) => found.id === item.id);
		expect(row).toMatchObject({
			variantCount: 4,
			price: 1000,
			priceMax: 2500,
			priceText: 'USD 10.00',
			priceMaxText: 'USD 25.00',
			stock: 9,
			mediaCount: 2,
		});
		expect(row.image).toContain('first.png');
		expect(row.currency).toBe('USD');
	});
});

describe('customer list rows', () => {
	it('carry the last order date, order count, total spent and loyalty points, read for the whole page at once', async () => {
		const data = await shop.db();
		const last = new Date('2026-10-03T08:30:00Z');
		await data.collection(COLLECTIONS.customers).insertMany([
			{
				id: createId('cus'),
				userId: 'usr_rowcustomer01',
				name: 'Row Customer',
				email: 'rowc@example.com',
				phone: '',
				blocked: false,
				blockedReason: '',
				rtoCount: 0,
				orderCount: 2,
				lastOrderAt: last,
				note: '',
				seenBy: [],
			},
			{
				id: createId('cus'),
				userId: 'usr_rowcustomer02',
				name: 'Row Newcomer',
				email: 'rown@example.com',
				phone: '',
				blocked: false,
				blockedReason: '',
				rtoCount: 0,
				orderCount: 0,
				note: '',
				seenBy: [],
			},
		]);
		await data.collection(COLLECTIONS.orders).insertMany([
			storedOrder({
				...order({
					number: 'ROW-C1',
					lines: [line(1)],
					delivery: { method: 'none', zone: '', rate: '', rateName: '', fee: 0, locationId: null },
					userId: 'usr_rowcustomer01',
				}),
				payment: {
					method: 'online',
					kind: 'gateway',
					state: 'paid',
					paymentId: 'pay_row',
					advance: 0,
					paid: 1000,
					refunded: 0,
					checkedAt: null,
				},
			}),
		]);
		await data.collection(COLLECTIONS.loyalty).insertOne({
			websiteId: shop.websiteId,
			userId: 'usr_rowcustomer01',
			balance: 340,
			lifetimeEarned: 500,
			lots: [],
			history: [],
			version: 1,
		});
		const list = await shop.admin(ticket, 'GET', '/v1/admin/customers?q=Row%20');
		expect(list.status).toBe(200);
		const byUser = new Map(list.json.items.map((/** @type {any} */ row) => [row.userId, row]));
		expect(byUser.get('usr_rowcustomer01')).toMatchObject({
			lastOrderAt: last.toISOString(),
			ordersPlaced: 1,
			totalSpent: 1000,
			totalSpentText: 'USD 10.00',
			loyaltyPoints: 340,
		});
		expect(byUser.get('usr_rowcustomer02')).toMatchObject({
			lastOrderAt: null,
			ordersPlaced: 0,
			totalSpent: 0,
			loyaltyPoints: 0,
		});
	});
});
