/**
 * The orders area's API answers as `schemas/api.json` describes them (every answer `call()` sees is checked against
 * it): the shop's events with each kind of data, their count and counts, the stock events by E44's levels, the staff
 * view of a guest's order (never its
 * key's hash nor the checkout's Idempotency-Key), customers by segment and a bulk move's answer per order.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL, ORIGIN, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
let visits = 0;

const ADDRESS = {
	name: 'Sara Shopper',
	phone: '+15550001111',
	line1: '1 Main Street',
	city: 'Springfield',
	region: 'IL',
	postalCode: '62701',
	country: 'US',
};

/**
 * Place a cash-on-delivery order through checkout: a member's (signed in) or a guest's, of a new product (10 in
 * stock) or of `item`.
 * @param {{ guest?: boolean, item?: import('../core/model.js').ProductRecord, quantity?: number }} [options]
 */
const placeOrder = async ({ guest = false, item: given, quantity = 1 } = {}) => {
	const item = given ?? (await shop.seedProduct({ price: 1000, stock: 10 }));
	visits += 1;
	const signIn = guest ? null : await shop.signIn({ id: `usr_apiorders${String(visits).padStart(4, '0')}` });
	const placed = await shop.call('POST', '/v1/shop/orders', {
		token: shop.browser,
		origin: ORIGIN,
		body: {
			lines: [{ productId: item.id, quantity }],
			payment: 'cod',
			address: ADDRESS,
			...(guest ? { customer: { name: 'Gina Guest', phone: '555 000 7777' } } : {}),
		},
		headers: {
			'x-forwarded-for': `10.7.0.${visits}`,
			'idempotency-key': `api-orders-${visits}`,
			...(signIn ? { 'ss-sign-in': signIn } : {}),
		},
	});
	expect(placed.status).toBe(201);
	await shop.flush();
	return { order: placed.json.order, item };
};

beforeAll(async () => {
	shop = await readyShop();
});
afterAll(async () => shop.product.close());

describe('the shop events (GET /v1/events)', () => {
	it('lists each kind of order event with its data, and counts them by type and delivery', async () => {
		expect((await shop.api('PUT', '/v1/settings/catalog.lowStock', { value: 9 })).status).toBeLessThan(300);
		const { order: paid } = await placeOrder();
		expect((await shop.api('POST', `/v1/orders/${paid.id}/move`, { to: 'confirmed' })).status).toBe(200);
		const payment = await shop.api('POST', `/v1/orders/${paid.id}/payments`, { method: 'cod', amount: 1000 });
		expect(payment.status).toBe(201);
		expect(payment.json.order.payment).toMatchObject({ state: 'paid', paid: 1000, balanceDue: 0, refundable: 1000 });
		const refund = await shop.api('POST', `/v1/orders/${paid.id}/refunds`, {
			amount: 400,
			reason: 'Box damaged',
			method: 'cod',
		});
		expect(refund.status).toBe(201);
		expect(refund.json.refund).toEqual({ amount: 400, online: 0, manual: 400, refundId: null, recorded: true });
		const { order: cancelled, item } = await placeOrder();
		expect((await shop.api('POST', `/v1/orders/${cancelled.id}/move`, { to: 'cancelled' })).status).toBe(200);
		await shop.flush();

		const listed = await shop.api('GET', '/v1/events?limit=100');
		expect(listed.status).toBe(200);
		/** @type {Array<{ type: string, data: Record<string, unknown>, delivery: string }>} */
		const events = listed.json.items;
		/** @param {string} type @param {string} orderId */
		const find = (type, orderId) => events.filter((event) => event.type === type && event.data.orderId === orderId);
		const facts = { number: paid.number, total: 1000, currency: 'USD', paymentMethod: 'cod', deliveryMethod: 'delivery' };
		expect(find('ecommerce.order.placed', paid.id)).toEqual([
			expect.objectContaining({ data: { orderId: paid.id, status: 'awaiting_confirmation', ...facts } }),
		]);
		expect(find('ecommerce.order.status_changed', paid.id)[0]?.data).toMatchObject({
			from: 'awaiting_confirmation',
			to: 'confirmed',
			reason: null,
			by: 'Server',
		});
		expect(find('ecommerce.order.payment_recorded', paid.id)[0]?.data).toMatchObject({
			method: 'cod',
			amount: 1000,
			reference: '',
		});
		expect(find('ecommerce.order.paid', paid.id)[0]?.data).toMatchObject({ paid: 1000 });
		expect(find('ecommerce.order.refunded', paid.id)[0]?.data).toMatchObject({ amount: 400, claimId: null });
		expect(find('ecommerce.order.cancelled', cancelled.id)[0]?.data).toMatchObject({ reason: 'staff' });
		// a staff move carries no reason of its own (only order.cancelled says who)
		expect(find('ecommerce.order.status_changed', cancelled.id)[0]?.data).toMatchObject({ to: 'cancelled', reason: null });
		// the order took 10 down to 9, the low-stock level; the cancel gives the stock back: the product changed, and a
		// rise publishes no stock event
		expect(events).toContainEqual(
			expect.objectContaining({ type: 'ecommerce.catalog.changed', data: { kind: 'product', id: item.id, slug: item.slug } }),
		);
		expect(events.filter((event) => event.type.startsWith('ecommerce.stock.') && event.data.productId === item.id)).toEqual([
			expect.objectContaining({
				type: 'ecommerce.stock.low',
				data: { productId: item.id, variantId: item.variants[0]?.id, stock: 9 },
			}),
		]);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'ecommerce.settings.changed',
				data: { what: 'settings', key: 'catalog.lowStock' },
			}),
		);
		expect(JSON.stringify(events)).not.toContain(ADDRESS.line1);
		expect(events.every((event) => event.delivery === 'sent')).toBe(true);

		const placed = await shop.api('GET', '/v1/events/count?types=ecommerce.order.placed');
		expect(placed.json).toEqual({ count: 2, capped: false });
		const all = await shop.api('GET', '/v1/events/count');
		expect(all.json).toEqual({ count: events.length, capped: false });
		const byType = await shop.api('GET', '/v1/events/counts?by=type');
		expect(byType.json.total).toBe(events.length);
		expect(byType.json.groups).toMatchObject({ 'ecommerce.order.placed': 2, 'ecommerce.order.cancelled': 1 });
		const byDelivery = await shop.api('GET', '/v1/events/counts?by=delivery&types=ecommerce.order.paid');
		expect(byDelivery.json).toEqual({ total: 1, groups: { sent: 1 } });

		expect((await shop.api('GET', '/v1/events?since=yesterday')).status).toBe(422);
		expect((await shop.api('GET', '/v1/events/count?types=payments.payment.paid')).status).toBe(422);
		expect((await shop.api('GET', '/v1/events/counts?by=status')).status).toBe(422);
	});
});

describe('the catalog events of pages (review L13)', () => {
	it('publishes catalog.changed when staff write a category, a brand or a deal, so cached pages are cleared', async () => {
		const category = (await shop.api('POST', '/v1/categories', { name: 'Kettles' })).json;
		const brand = (await shop.api('POST', '/v1/brands', { name: 'Steam' })).json;
		await shop.api('PATCH', `/v1/brands/${brand.id}`, { description: 'Kettles that last.' });
		const deal = (await shop.api('POST', '/v1/deals', { name: 'Kettle week', type: 'percent', value: 10 })).json;
		await shop.api('DELETE', `/v1/deals/${deal.id}`);
		await shop.api('POST', '/v1/coupons', { code: 'KETTLE', type: 'percent', value: 5 });
		await shop.flush();
		/** @type {string[]} */
		const changed = (await shop.api('GET', '/v1/events?types=ecommerce.catalog.changed&limit=100')).json.items.map(
			(/** @type {any} */ event) => `${event.data.kind} ${event.data.id}`,
		);
		expect(changed).toEqual(expect.arrayContaining([`category ${category.id}`, `brand ${brand.id}`, `deal ${deal.id}`]));
		expect(changed.filter((entry) => entry === `brand ${brand.id}`)).toHaveLength(2);
		expect(changed.filter((entry) => entry === `deal ${deal.id}`)).toHaveLength(2);
		// a coupon is an offer of the cart: no page shows it
		expect(changed.some((entry) => entry.startsWith('coupon'))).toBe(false);
	});
});

describe('the stock events (E44)', () => {
	/** @type {{ stocked?: string }} */
	const ids = {};
	it('publishes stock.low when a variant drops into 1 to lowStock units and stock.out when it drops to 0, never on a rise', async () => {
		expect((await shop.api('PUT', '/v1/settings/catalog.lowStock', { value: 2 })).status).toBeLessThan(300);
		// stock without locations, so staff set a variant's units straight
		await shop.switchOn(ALL.filter((feature) => feature !== 'multi_location'));
		try {
			const item = await shop.seedProduct({ price: 500, stock: 4 });
			const variantId = /** @type {string} */ (item.variants[0]?.id);
			/** @param {number} set */
			const stock = async (set) =>
				expect((await shop.api('POST', `/v1/products/${item.id}/stock`, { changes: [{ variantId, set }] })).status).toBe(200);
			await placeOrder({ item }); // 4 → 3: above the level
			await placeOrder({ item }); // 3 → 2: low
			await placeOrder({ item }); // 2 → 1: still low
			await stock(5); // a rise
			await stock(0); // out, by a catalog write
			await stock(2); // a rise into the low range
			await placeOrder({ item, quantity: 2 }); // 2 → 0: out, by an order
			await shop.flush();
			ids.stocked = item.id;
		} finally {
			await shop.switchOn(ALL);
		}
		const listed = (await shop.api('GET', '/v1/events?types=ecommerce.stock.low,ecommerce.stock.out&limit=100')).json.items;
		// one low (3 → 2) and two outs (a catalog write to 0, an order to 0); the test clock stands still, so by kind
		const mine = listed
			.filter((/** @type {any} */ event) => event.data.productId === ids.stocked)
			.map((/** @type {any} */ event) => `${event.type} ${event.data.stock}`)
			.sort();
		expect(mine).toEqual(['ecommerce.stock.low 2', 'ecommerce.stock.out 0', 'ecommerce.stock.out 0']);
	});
});

describe('a guest’s order for staff', () => {
	it('shows everything but the order key’s hash, the checkout’s Idempotency-Key and the search’s phone digits, and its guest customer', async () => {
		await shop.setting('checkout', 'guests', 'on');
		await shop.setting('checkout', 'defaultCallingCode', '+1');
		const { order } = await placeOrder({ guest: true });
		await shop.setting('checkout', 'guests', 'off');
		const read = await shop.api('GET', `/v1/orders/${order.id}`);
		expect(read.status).toBe(200);
		expect(read.json).not.toHaveProperty('accessKeyHash');
		expect(read.json).not.toHaveProperty('idempotencyKey');
		expect(read.json).not.toHaveProperty('phoneDigits');
		expect(read.json.customer).toMatchObject({ userId: '', name: 'Gina Guest', phone: '+15550007777' });
		expect(read.json.customer.customerId).toMatch(/^cus_/);
		expect(read.json).toMatchObject({
			stockHeld: true,
			customerFlags: { blocked: false, rtoCount: 0 },
			payment: { method: 'cod', kind: 'on_delivery', state: 'unpaid', balanceDue: 1000, refundable: 0, refundDue: 0 },
		});
		expect(read.json.nextStatuses.map((/** @type {any} */ next) => next.role)).toEqual(['open', 'cancelled']);

		const guests = await shop.api('GET', '/v1/customers?segment=guest');
		expect(guests.json.items).toEqual([
			expect.objectContaining({ id: read.json.customer.customerId, guest: true, userId: '' }),
		]);
		const segments = await shop.api('GET', '/v1/customers/counts?by=segment');
		expect(segments.json.groups.guest).toBe(1);
		const customer = await shop.api('GET', `/v1/customers/${read.json.customer.customerId}`);
		expect(customer.json).toMatchObject({ guest: true, ordersPlaced: 1, totalSpent: 0 });
		expect(customer.json.recentOrders.map((/** @type {any} */ row) => row.id)).toEqual([order.id]);
		const seen = await shop.api('POST', `/v1/customers/${read.json.customer.customerId}/seen`);
		expect(seen.json).toEqual({ seen: true });
	});
});

describe('a bulk move', () => {
	it('answers each order’s result: moved, or not with its problem', async () => {
		const { order } = await placeOrder();
		const missing = 'ord_doesnotexist01';
		const moved = await shop.api('POST', '/v1/orders/bulk-move', { ids: [order.id, missing], to: 'confirmed' });
		expect(moved.status).toBe(200);
		expect(moved.json).toEqual({
			moved: 1,
			results: [
				{ id: order.id, ok: true, number: order.number, status: 'confirmed', warnings: [], warningCodes: [] },
				{ id: missing, ok: false, code: 'not_found', detail: 'There is no such order.' },
			],
		});
	});
});
