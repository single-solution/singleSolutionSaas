/**
 * The orders area's API answers as `schemas/api.json` describes them (every answer `call()` sees is checked against
 * it): the shop's events with each kind of data, their count and counts, the staff view of a guest's order (never its
 * key's hash nor the checkout's Idempotency-Key), customers by segment and a bulk move's answer per order.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORIGIN, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
let visits = 0;

const ADDRESS = { name: 'Sara Shopper', phone: '+15550001111', line1: '1 Main Street', city: 'Springfield', country: 'US' };

/**
 * Place a cash-on-delivery order through checkout: a member's (signed in) or a guest's.
 * @param {{ guest?: boolean }} [options]
 */
const placeOrder = async ({ guest = false } = {}) => {
	const item = await shop.seedProduct({ price: 1000, stock: 10 });
	visits += 1;
	const signIn = guest ? null : await shop.signIn({ id: `usr_apiorders${String(visits).padStart(4, '0')}` });
	const placed = await shop.call('POST', '/v1/shop/orders', {
		token: shop.browser,
		origin: ORIGIN,
		body: {
			lines: [{ productId: item.id }],
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
		expect((await shop.api('PUT', '/v1/settings/catalog.lowStock', { value: 100 })).status).toBeLessThan(300);
		const { order: paid } = await placeOrder();
		expect((await shop.api('POST', `/v1/orders/${paid.id}/move`, { to: 'confirmed' })).status).toBe(200);
		const payment = await shop.api('POST', `/v1/orders/${paid.id}/payments`, { method: 'cash', amount: 1000 });
		expect(payment.status).toBe(201);
		expect(payment.json.order.payment).toMatchObject({ state: 'paid', paid: 1000, balanceDue: 0, refundable: 1000 });
		const refund = await shop.api('POST', `/v1/orders/${paid.id}/refunds`, {
			amount: 400,
			reason: 'Box damaged',
			method: 'cash',
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
			method: 'cash',
			amount: 1000,
			reference: '',
		});
		expect(find('ecommerce.order.paid', paid.id)[0]?.data).toMatchObject({ paid: 1000 });
		expect(find('ecommerce.order.refunded', paid.id)[0]?.data).toMatchObject({ amount: 400, claimId: null });
		expect(find('ecommerce.order.cancelled', cancelled.id)[0]?.data).toMatchObject({ reason: 'staff' });
		// a staff move carries no reason of its own (only order.cancelled says who)
		expect(find('ecommerce.order.status_changed', cancelled.id)[0]?.data).toMatchObject({ to: 'cancelled', reason: null });
		// the cancel gives the stock back: the product changed, and it is at or under the low-stock level
		expect(events).toContainEqual(
			expect.objectContaining({ type: 'ecommerce.catalog.changed', data: { kind: 'product', id: item.id, slug: item.slug } }),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'ecommerce.stock.low',
				data: { productId: item.id, variantId: item.variants[0]?.id, stock: 10 },
			}),
		);
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

describe('a guest’s order for staff', () => {
	it('shows everything but the order key’s hash and the checkout’s Idempotency-Key, and its guest customer', async () => {
		await shop.setting('checkout', 'guests', 'on');
		await shop.setting('checkout', 'defaultCallingCode', '+1');
		const { order } = await placeOrder({ guest: true });
		await shop.setting('checkout', 'guests', 'off');
		const read = await shop.api('GET', `/v1/orders/${order.id}`);
		expect(read.status).toBe(200);
		expect(read.json).not.toHaveProperty('accessKeyHash');
		expect(read.json).not.toHaveProperty('idempotencyKey');
		expect(read.json.customer).toMatchObject({ userId: '', name: 'Gina Guest', phone: '+15550007777' });
		expect(read.json.customer.customerId).toMatch(/^cus_/);
		expect(read.json).toMatchObject({
			stockHeld: true,
			customerFlags: { blocked: false, rtoCount: 0 },
			payment: { method: 'cod', state: 'unpaid', balanceDue: 1000, refundable: 0, refundDue: 0 },
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
				{ id: order.id, ok: true, number: order.number, status: 'confirmed', warnings: [] },
				{ id: missing, ok: false, code: 'not_found', detail: 'There is no such order.' },
			],
		});
	});
});
