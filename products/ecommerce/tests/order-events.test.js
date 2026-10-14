/**
 * Messages, events and staff alerts through the API (PLAN 0.8.10 E32): events listed by `GET /v1/events`, staff
 * alerts for the events the setting lists, one template per status, the fuller message values and the reason of a
 * cancel; message values in words from the website's texts, with the staff's note as a cancel's reason (K-10).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORIGIN, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
let users = 0;

const ADDRESS = { name: 'Sara Shopper', phone: '+15550001111', line1: '1 Main Street', city: 'Springfield', country: 'US' };

/** A COD order of a new shopper. */
const placeOrder = async () => {
	const item = await shop.seedProduct({ price: 1000, stock: 10 });
	users += 1;
	const token = await shop.signIn({ id: `usr_events${String(users).padStart(6, '0')}`, name: 'Sara Shopper' });
	const placed = await shop.call('POST', '/v1/shop/orders', {
		token: shop.browser,
		origin: ORIGIN,
		body: { lines: [{ productId: item.id }], payment: 'cod', address: ADDRESS },
		headers: { 'x-forwarded-for': `10.5.0.${users}`, 'ss-sign-in': token, 'idempotency-key': `evt-${users}` },
	});
	expect(placed.status).toBe(201);
	await shop.flush();
	return placed.json.order;
};

beforeAll(async () => {
	shop = await readyShop();
	await shop.setting('staff_alerts', 'recipients', ['team@shop.example.com']);
	await shop.setting('staff_alerts', 'events', ['placed', 'cancelled']);
	await shop.setting('checkout', 'orderUrl', `${ORIGIN}/orders/{number}`);
});
afterAll(async () => shop.product.close());

describe('events and staff alerts (E32)', () => {
	it('lists the order events and alerts the staff of what the setting lists', async () => {
		const before = shop.messages().length;
		const order = await placeOrder();
		const sent = shop.messages().slice(before);
		expect(sent.map((m) => m.template)).toEqual(expect.arrayContaining(['ecommerce.order_placed', 'ecommerce.staff_placed']));
		const staff = sent.find((m) => m.template === 'ecommerce.staff_placed');
		expect(staff).toMatchObject({ to: { email: 'team@shop.example.com' }, values: { number: order.number } });
		const mine = sent.find((m) => m.template === 'ecommerce.order_placed');
		expect(mine.values).toMatchObject({ firstName: 'Sara', orderUrl: `${ORIGIN}/orders/${order.number}` });

		await shop.api('POST', `/v1/orders/${order.id}/move`, { to: 'cancelled' });
		await shop.flush();
		const events = await shop.api('GET', '/v1/events?types=ecommerce.order.placed,ecommerce.order.cancelled');
		const types = events.json.items
			.filter((/** @type {any} */ e) => e.data.orderId === order.id)
			.map((/** @type {any} */ e) => e.type);
		expect(types).toEqual(expect.arrayContaining(['ecommerce.order.placed', 'ecommerce.order.cancelled']));
		const cancelled = events.json.items.find((/** @type {any} */ e) => e.type === 'ecommerce.order.cancelled');
		expect(cancelled.data).toMatchObject({ number: order.number, reason: 'staff' });
		expect(JSON.stringify(events.json)).not.toContain(ADDRESS.line1);
		expect(shop.messages().map((m) => m.template)).toContain('ecommerce.staff_cancelled');
	});

	it('raises the payment events for cash paid on delivery, as for payments staff record', async () => {
		const order = await placeOrder();
		for (const to of ['confirmed', 'delivered'])
			expect((await shop.api('POST', `/v1/orders/${order.id}/move`, { to })).status).toBe(200);
		await shop.flush();
		const events = await shop.api('GET', '/v1/events?types=ecommerce.order.payment_recorded,ecommerce.order.paid');
		const mine = events.json.items.filter((/** @type {any} */ e) => e.data.orderId === order.id);
		expect(mine.map((/** @type {any} */ e) => e.type).sort()).toEqual([
			'ecommerce.order.paid',
			'ecommerce.order.payment_recorded',
		]);
		expect(mine.find((/** @type {any} */ e) => e.type === 'ecommerce.order.payment_recorded').data).toMatchObject({
			method: 'cash',
			amount: order.totals.total,
		});
		expect(mine.find((/** @type {any} */ e) => e.type === 'ecommerce.order.paid').data).toMatchObject({
			paid: order.totals.total,
		});
	});

	it('sends words, not codes: payment and delivery methods and why it was canceled, from the texts (K-10)', async () => {
		const before = shop.messages().length;
		const order = await placeOrder();
		const placed = shop
			.messages()
			.slice(before)
			.find((m) => m.template === 'ecommerce.order_placed');
		expect(placed.values).toMatchObject({ paymentMethod: 'Cash on delivery', deliveryMethod: 'Delivery' });
		const staffPlaced = shop
			.messages()
			.slice(before)
			.find((m) => m.template === 'ecommerce.staff_placed');
		expect(staffPlaced.values.paymentMethod).toBe('Cash on delivery');

		// the staff's note is the reason; without one, the website's text for who canceled
		const noted = shop.messages().length;
		await shop.api('POST', `/v1/orders/${order.id}/move`, { to: 'cancelled', note: 'Out of stock at the warehouse' });
		const told = shop.messages().slice(noted);
		expect(told.find((m) => m.template === 'ecommerce.order_status')?.values.cancelReason).toBe(
			'Out of stock at the warehouse',
		);
		expect(told.find((m) => m.template === 'ecommerce.staff_cancelled')?.values.reason).toBe('Out of stock at the warehouse');

		const other = await placeOrder();
		expect(
			(await shop.api('PUT', '/v1/texts/messages.cancelReason.staff', { value: 'We had to cancel it' })).status,
		).toBeLessThan(300);
		const plain = shop.messages().length;
		await shop.api('POST', `/v1/orders/${other.id}/move`, { to: 'cancelled' });
		expect(
			shop
				.messages()
				.slice(plain)
				.find((m) => m.template === 'ecommerce.order_status')?.values.cancelReason,
		).toBe('We had to cancel it');
	});

	it('sends one template per status when asked', async () => {
		await shop.setting('checkout', 'statusTemplates', 'per_status');
		const order = await placeOrder();
		const before = shop.messages().length;
		await shop.api('POST', `/v1/orders/${order.id}/move`, { to: 'confirmed' });
		await shop.flush();
		expect(
			shop
				.messages()
				.slice(before)
				.map((m) => m.template),
		).toContain('ecommerce.order_status.confirmed');
		await shop.setting('checkout', 'statusTemplates', 'one');
	});
});
