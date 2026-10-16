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

const ADDRESS = {
	name: 'Sara Shopper',
	phone: '+15550001111',
	line1: '1 Main Street',
	city: 'Springfield',
	region: 'IL',
	postalCode: '62701',
	country: 'US',
};

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
	it('needs a tracking number to dispatch unless the move says otherwise', async () => {
		const { id } = await confirmedOrder();
		await moveTo(id, 'packed');
		expect(codeOf(await moveTo(id, 'dispatched', { shipment: { courier: 'post' } }))).toBe('validation_failed');
		await shop.moveOptions('packed', 'dispatched', { tracking: 'optional' });
		const sent = await moveTo(id, 'dispatched', {
			shipment: { courier: 'post', trackingNote: 'Rider calls first', estimatedDeliveryAt: '2026-10-08T00:00:00Z' },
		});
		expect(sent.status).toBe(200);
		expect(sent.json.shipment).toMatchObject({ courier: 'Post', trackingNumber: '', trackingNote: 'Rider calls first' });
		await shop.moveOptions('packed', 'dispatched', {});
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

	it('takes the dispatch video when packing, as the move asks', async () => {
		await shop.moveOptions('confirmed', 'packed', { video: 'required' });
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
		await shop.moveOptions('confirmed', 'packed', {});
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
		expect(record.history.at(-1)).toMatchObject({ kind: 'edited', code: 'edited' });
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

	it('keeps the deals an order was placed with when it is edited after they ended (OR-9)', async () => {
		const item = await shop.seedProduct({ price: 10_000, stock: 10 });
		const made = await shop.api('POST', '/v1/deals', {
			name: 'Ten off',
			type: 'percent',
			value: 10,
			limit: 1,
			scope: { productIds: [item.id], categoryIds: [], brandIds: [] },
		});
		users += 1;
		const token = await shop.signIn({ id: `usr_shipping${String(users).padStart(6, '0')}` });
		const placed = await shop.call('POST', '/v1/shop/orders', {
			token: shop.browser,
			origin: ORIGIN,
			body: { lines: [{ productId: item.id, quantity: 1 }], payment: 'cod', address: ADDRESS },
			headers: { 'x-forwarded-for': `10.8.2.${users}`, 'ss-sign-in': token, 'idempotency-key': `edit-${users}` },
		});
		expect(placed.json.order.totals.discount).toBe(1000);
		// this order took the deal's last use; then the deal is switched off
		await shop.api('PATCH', `/v1/deals/${made.json.id}`, { active: false });
		const variantId = /** @type {any} */ (item.variants[0]).id;
		const edited = await shop.api('PATCH', `/v1/orders/${placed.json.order.id}`, { lines: [{ variantId, quantity: 2 }] });
		expect(edited.status).toBe(200);
		expect(edited.json.totals).toMatchObject({ subtotal: 20_000, discount: 2000 });
		await shop.api('DELETE', `/v1/deals/${made.json.id}`);
	});

	it('sets the next order number, never below one used: the running counter, or a year’s with the yearly form', async () => {
		const year = new Date(shop.now()).getUTCFullYear();
		const { id } = await confirmedOrder();
		const used = Number((await orderRecord(id)).number);
		expect(codeOf(await shop.api('POST', '/v1/orders/counter', { next: used }))).toBe('validation_failed');
		// the running counter has no year
		const yearGiven = await shop.api('POST', '/v1/orders/counter', { year, next: used + 100 });
		expect(yearGiven.json.errors[0]).toMatchObject({ path: '/year' });
		const set = await shop.api('POST', '/v1/orders/counter', { next: used + 100 });
		expect(set.json).toEqual({ prefix: '', year: null, month: null, next: used + 100 });
		const after = await confirmedOrder();
		expect((await orderRecord(after.id)).number).toBe(String(used + 100).padStart(6, '0'));

		// the yearly form: a counter per year, which starts after the highest number of that year
		await shop.setting('checkout', 'numberPattern', '{prefix}{year}-{number}');
		await shop.setting('checkout', 'numberPrefix', 'Y-');
		const first = await confirmedOrder();
		expect((await orderRecord(first.id)).number).toBe(`Y-${year}-000001`);
		expect((await shop.api('POST', '/v1/orders/counter', { next: 50 })).json.errors[0]).toMatchObject({ path: '/year' });
		expect(codeOf(await shop.api('POST', '/v1/orders/counter', { year, next: 1 }))).toBe('validation_failed');
		expect((await shop.api('POST', '/v1/orders/counter', { year, next: 50 })).json).toEqual({
			prefix: 'Y-',
			year,
			month: null,
			next: 50,
		});
		const fiftieth = await confirmedOrder();
		expect((await orderRecord(fiftieth.id)).number).toBe(`Y-${year}-000050`);

		// the merchant's own pattern (E29): a counter per month, a suffix and fewer digits
		const month = new Date(shop.now()).getUTCMonth() + 1;
		const yearMonth = `${year}${String(month).padStart(2, '0')}`;
		await shop.setting('checkout', 'numberPattern', 'W{year}{month}_{number}{suffix}');
		await shop.setting('checkout', 'numberSuffix', '-EU');
		await shop.setting('checkout', 'numberDigits', 2);
		const monthly = await confirmedOrder();
		expect((await orderRecord(monthly.id)).number).toBe(`W${yearMonth}_01-EU`);
		expect((await shop.api('POST', '/v1/orders/counter', { year, next: 7 })).json.errors[0]).toMatchObject({ path: '/month' });
		expect((await shop.api('POST', '/v1/orders/counter', { year, month, next: 7 })).json).toMatchObject({ month, next: 7 });
		expect((await orderRecord((await confirmedOrder()).id)).number).toBe(`W${yearMonth}_07-EU`);
		// a pattern that breaks the rules ({month} without {year}) reads as the default
		await shop.setting('checkout', 'numberPattern', '{month}{number}');
		await shop.setting('checkout', 'numberDigits', 6);
		await shop.setting('checkout', 'numberSuffix', '');
		await shop.setting('checkout', 'numberPrefix', '');
		expect((await orderRecord((await confirmedOrder()).id)).number).toBe(String(used + 101).padStart(6, '0'));
		await shop.setting('checkout', 'numberPattern', '{prefix}{number}');
		// back to the running form: its counter goes on where it was
		const later = await confirmedOrder();
		expect((await orderRecord(later.id)).number).toBe(String(used + 102).padStart(6, '0'));
	});
});
