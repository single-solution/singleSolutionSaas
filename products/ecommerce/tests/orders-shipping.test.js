/**
 * Shipping and packing options through the API (PLAN 0.8.10 E28): dispatch without a tracking number when the website
 * allows it, the shipment's note and expected date changed at any time, the courier kept by name with its link from
 * today's list, the dispatch video when packing, and bulk moves with each order's shipment.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS } from '../core/model.js';
import { ORIGIN, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
let users = 0;

const ADDRESS = { name: 'Sara Shopper', phone: '+15550001111', line1: '1 Main Street', city: 'Springfield', country: 'US' };

/** @param {{ json: any }} response */
const codeOf = (response) =>
	String(response.json?.type ?? '')
		.split('/')
		.pop();

/** @param {string} id */
const orderRecord = async (id) =>
	/** @type {any} */ (await (await shop.db()).collection(COLLECTIONS.orders).findOne({ websiteId: shop.websiteId, id }));

/** A confirmed COD order of a new shopper. */
const confirmedOrder = async () => {
	const item = await shop.seedProduct({ price: 1000, stock: 10 });
	users += 1;
	const token = await shop.signIn({ id: `usr_shipping${String(users).padStart(6, '0')}` });
	const placed = await shop.call('POST', '/v1/shop/orders', {
		token: shop.browser,
		origin: ORIGIN,
		body: { lines: [{ productId: item.id }], payment: 'cod', address: ADDRESS },
		headers: { 'x-forwarded-for': `10.8.0.${users}`, 'ss-sign-in': token, 'idempotency-key': `ship-${users}` },
	});
	expect(placed.status).toBe(201);
	const id = placed.json.order.id;
	expect((await shop.api('POST', `/v1/orders/${id}/move`, { to: 'confirmed' })).status).toBe(200);
	return { id, token };
};

/** @param {string} id @param {string} to @param {Record<string, unknown>} [extra] */
const moveTo = (id, to, extra = {}) => shop.api('POST', `/v1/orders/${id}/move`, { to, ...extra });

beforeAll(async () => {
	shop = await readyShop();
	await shop.list('couriers', [{ key: 'post', name: 'Post', trackingUrl: 'https://track.example/{tracking}' }]);
});
afterAll(async () => shop.product.close());

describe('shipping and packing options (E28)', () => {
	it('needs a tracking number to dispatch unless the website says otherwise', async () => {
		const { id } = await confirmedOrder();
		await moveTo(id, 'packed');
		expect(codeOf(await moveTo(id, 'dispatched', { shipment: { courier: 'post' } }))).toBe('validation_failed');
		await shop.setting('checkout', 'trackingRequired', false);
		const sent = await moveTo(id, 'dispatched', {
			shipment: { courier: 'post', trackingNote: 'Rider calls first', estimatedDeliveryAt: '2026-10-08T00:00:00Z' },
		});
		expect(sent.status).toBe(200);
		expect(sent.json.shipment).toMatchObject({ courier: 'Post', trackingNumber: '', trackingNote: 'Rider calls first' });
		await shop.setting('checkout', 'trackingRequired', true);
	});

	it('changes the shipment at any time and builds the link from today’s couriers', async () => {
		const { id, token } = await confirmedOrder();
		const changed = await shop.api('PATCH', `/v1/orders/${id}`, {
			shipment: { courier: 'Post', trackingNumber: 'TN9', trackingNote: 'Packed soon', estimatedDeliveryAt: '2026-10-09' },
		});
		expect(changed.json).toMatchObject({ status: 'confirmed' });
		expect((await orderRecord(id)).shipment).toMatchObject({
			courier: 'Post',
			trackingNumber: 'TN9',
			trackingNote: 'Packed soon',
		});
		expect(codeOf(await shop.api('PATCH', `/v1/orders/${id}`, { shipment: { courier: 'nobody' } }))).toBe('validation_failed');
		await shop.list('couriers', [{ key: 'post', name: 'Post', trackingUrl: 'https://new.example/{tracking}' }]);
		const mine = await shop.call('GET', `/v1/shop/orders/${id}`, {
			token: shop.browser,
			origin: ORIGIN,
			headers: { 'ss-sign-in': token, 'x-forwarded-for': '10.8.1.1' },
		});
		expect(mine.json.shipment).toMatchObject({
			trackingUrl: 'https://new.example/TN9',
			trackingNote: 'Packed soon',
			estimatedDeliveryAt: '2026-10-09T00:00:00.000Z',
		});
		await shop.list('couriers', [{ key: 'post', name: 'Post', trackingUrl: 'https://track.example/{tracking}' }]);
	});

	it('takes the dispatch video when packing, as the website asks', async () => {
		await shop.setting('checkout', 'packingVideo', 'required');
		const { id, token } = await confirmedOrder();
		expect(codeOf(await moveTo(id, 'packed'))).toBe('validation_failed');
		expect(codeOf(await moveTo(id, 'packed', { video: 'javascript:alert(1)' }))).toBe('validation_failed');
		const packed = await moveTo(id, 'packed', { video: 'https://youtu.be/dQw4w9WgXcQ' });
		expect(packed.status).toBe(200);
		const mine = await shop.call('GET', `/v1/shop/orders/${id}`, {
			token: shop.browser,
			origin: ORIGIN,
			headers: { 'ss-sign-in': token, 'x-forwarded-for': '10.8.1.2' },
		});
		expect(mine.json.dispatchVideo).toEqual({ kind: 'youtube', url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ' });
		await shop.setting('checkout', 'packingVideo', 'off');
	});

	it('dispatches several orders with their own shipments', async () => {
		const a = await confirmedOrder();
		const b = await confirmedOrder();
		await moveTo(a.id, 'packed');
		await moveTo(b.id, 'packed');
		const bulk = await shop.api('POST', '/v1/orders/bulk-move', {
			to: 'dispatched',
			items: [
				{ id: a.id, shipment: { courier: 'post', trackingNumber: 'A1' } },
				{ id: b.id, shipment: { courier: 'post', trackingNumber: 'B1' } },
			],
		});
		expect(bulk.json.moved).toBe(2);
		expect((await orderRecord(a.id)).shipment.trackingNumber).toBe('A1');
		expect((await orderRecord(b.id)).shipment.trackingNumber).toBe('B1');
	});
});

describe('order editing and numbers (E29, E30)', () => {
	it('changes the items, price and payment of a waiting order, swapping its stock', async () => {
		const a = await shop.seedProduct({ price: 1000, stock: 5 });
		const b = await shop.seedProduct({ price: 3000, stock: 5 });
		users += 1;
		const token = await shop.signIn({ id: `usr_shipping${String(users).padStart(6, '0')}` });
		const placed = await shop.call('POST', '/v1/shop/orders', {
			token: shop.browser,
			origin: ORIGIN,
			body: { lines: [{ productId: a.id, quantity: 2 }], payment: 'cod', address: ADDRESS },
			headers: { 'x-forwarded-for': `10.8.2.${users}`, 'ss-sign-in': token, 'idempotency-key': `edit-${users}` },
		});
		const id = placed.json.order.id;
		const bVariant = /** @type {any} */ (b.variants[0]).id;
		const aVariant = /** @type {any} */ (a.variants[0]).id;
		const edited = await shop.api('PATCH', `/v1/orders/${id}`, {
			lines: [
				{ variantId: aVariant, quantity: 1 },
				{ variantId: bVariant, quantity: 1, unitPrice: 2500 },
			],
		});
		expect(edited.status).toBe(200);
		expect(edited.json.totals).toMatchObject({ subtotal: 3500 });
		const record = await orderRecord(id);
		expect(record.history.at(-1)).toMatchObject({ kind: 'edited' });
		const stock = async (/** @type {string} */ productId) =>
			/** @type {any} */ (
				await (await shop.db()).collection(COLLECTIONS.products).findOne({ websiteId: shop.websiteId, id: productId })
			).variants[0].stock;
		expect(await stock(a.id)).toBe(4);
		expect(await stock(b.id)).toBe(4);
		const tooMany = await shop.api('PATCH', `/v1/orders/${id}`, { lines: [{ variantId: bVariant, quantity: 9 }] });
		expect(codeOf(tooMany)).toBe('out_of_stock');
		expect(await stock(a.id)).toBe(4);

		await shop.api('POST', `/v1/orders/${id}/move`, { to: 'confirmed' });
		const late = await shop.api('PATCH', `/v1/orders/${id}`, { lines: [{ variantId: aVariant, quantity: 1 }] });
		expect(codeOf(late)).toBe('validation_failed');
	});

	it('sets the next order number, never below one used', async () => {
		const year = new Date(shop.now()).getUTCFullYear();
		const { id } = await confirmedOrder();
		const used = Number(
			String((await orderRecord(id)).number)
				.split('-')
				.pop(),
		);
		expect(codeOf(await shop.api('POST', '/v1/orders/counter', { year, next: used }))).toBe('validation_failed');
		const set = await shop.api('POST', '/v1/orders/counter', { year, next: used + 100 });
		expect(set.json.next).toBe(used + 100);
		const after = await confirmedOrder();
		expect(String((await orderRecord(after.id)).number).endsWith(String(used + 100))).toBe(true);
	});
});
