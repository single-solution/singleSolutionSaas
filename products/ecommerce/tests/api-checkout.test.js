/**
 * The checkout area's routes as schemas/api.json describes them (`call()` checks every answer against it): a digital
 * product's files added with the server token, the one pickup point and a coupon that does not apply in a quote and an
 * order, and a guest order read, paid and canceled with its key (SS-Order-Key).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS } from '../core/model.js';
import { ALL, ORIGIN, PAYMENTS, STORAGE, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
let ip = 0;

const ADDRESS = { name: 'Gina Guest', phone: '+15550003333', line1: '3 Low Street', city: 'Village' };

/**
 * A visitor request from a fresh address (the visitor rate limits count per address).
 * @param {string} method @param {string} path
 * @param {{ body?: unknown, signIn?: string, key?: string, orderKey?: string }} [init]
 */
const visit = (method, path, { body, signIn, key, orderKey } = {}) => {
	ip += 1;
	return shop.call(method, path, {
		token: shop.browser,
		origin: ORIGIN,
		body,
		headers: {
			'x-forwarded-for': `10.7.${(ip >> 8) & 255}.${ip & 255}`,
			...(signIn ? { 'ss-sign-in': signIn } : {}),
			...(key ? { 'idempotency-key': key } : {}),
			...(orderKey ? { 'ss-order-key': orderKey } : {}),
		},
	});
};

/** The problem code of an answer. @param {{ json: any }} response */
const codeOf = (response) =>
	String(response.json?.type ?? '')
		.split('/')
		.pop();

beforeAll(async () => {
	// the one pickup point of the delivery_zones settings is offered while stock has no locations
	shop = await readyShop({ features: ALL.filter((feature) => feature !== 'multi_location') });
});
afterAll(async () => shop.product.close());

describe('digital files with the server token', () => {
	it('answers a signed upload and lists the file once, by its cleaned name', async () => {
		const item = await shop.seedProduct({
			kind: 'digital',
			trackStock: false,
			digital: { files: [], retired: [], licenceKeys: false, downloadLimit: 0 },
		});
		const added = await shop.api('POST', `/v1/products/${item.id}/files`, {
			name: 'Manual v2.pdf',
			type: 'application/pdf',
			size: 4096,
		});
		expect(added.status).toBe(200);
		expect(added.json.file).toEqual({ name: 'Manual-v2.pdf', type: 'application/pdf', size: 4096 });
		expect(added.json.upload).toMatchObject({ method: 'PUT', headers: { 'content-type': 'application/pdf' } });
		expect(added.json.upload.url.startsWith(STORAGE)).toBe(true);
		expect(Date.parse(added.json.upload.expiresAt) - shop.now()).toBe(900_000);
		// the same name again replaces the file
		const again = await shop.api('POST', `/v1/products/${item.id}/files`, {
			name: 'Manual v2.pdf',
			type: 'application/pdf',
			size: 10,
		});
		expect(again.json.file.size).toBe(10);
		const stored = /** @type {any} */ (
			await (await shop.db()).collection(COLLECTIONS.products).findOne({ websiteId: shop.websiteId, id: item.id })
		);
		expect(stored.digital.files).toEqual([
			{ key: `ecommerce/digital/${item.id}/Manual-v2.pdf`, type: 'application/pdf', size: 10, alt: 'Manual-v2.pdf' },
		]);
	});
});

describe('the pickup point and coupon problems', () => {
	it('prices pickup at the one pickup point, says why a coupon does not apply, and shows the point on the order', async () => {
		await shop.setting('delivery_zones', 'pickupEnabled', true);
		await shop.setting('delivery_zones', 'pickupName', 'Front desk');
		await shop.setting('delivery_zones', 'pickupAddress', '1 Market Road');
		await shop.setting('delivery_zones', 'pickupHours', '9–5');
		await shop.setting('delivery_zones', 'pickupReadyNote', 'We text you when it is ready.');
		const item = await shop.seedProduct({ price: 2000, stock: 5 });
		const shopper = await shop.signIn({ id: 'usr_pickup0000001' });
		const body = { lines: [{ productId: item.id }], delivery: { method: 'pickup' }, coupon: 'nope' };
		const quote = await visit('POST', '/v1/shop/cart/quote', { body, signIn: shopper });
		expect(quote.status).toBe(200);
		// the seeded zone (every place) with today's rates: Standard and Pickup (E5)
		expect(quote.json.delivery).toEqual({
			method: 'pickup',
			zone: 'everywhere',
			rate: 'pickup',
			rateName: 'Pickup',
			name: 'Front desk',
			fee: 0,
			freeOver: 0,
			locationId: null,
			minDays: null,
			maxDays: null,
			address: '1 Market Road',
			hours: '9–5',
		});
		expect(quote.json.deliveryOptions.map((/** @type {any} */ option) => option.method)).toEqual(['delivery', 'pickup']);
		expect(quote.json.promotions).toMatchObject({
			couponCode: 'NOPE',
			couponProblem: { code: 'coupon_unknown', message: 'This code is not valid.' },
		});
		expect(quote.json.paymentMethods).toContainEqual({
			method: 'cod',
			name: 'Cash on delivery',
			kind: 'on_delivery',
			note: '',
			available: false,
			reason: 'needs_delivery',
			advance: 0,
			fee: 0,
		});
		expect(quote.json.paymentMethods).toContainEqual({
			method: 'pickup',
			name: 'Pay at pickup',
			kind: 'at_pickup',
			note: '',
			available: true,
			reason: null,
			advance: 0,
			fee: 0,
		});
		// no method asked: the first available one of the payment_methods list is priced
		expect(quote.json).toMatchObject({ paymentMethod: 'online', deliveryProblem: null, ready: true, totals: { total: 2000 } });

		const placed = await visit('POST', '/v1/shop/orders', {
			body: { ...body, coupon: '', payment: 'pickup' },
			signIn: shopper,
			key: 'pickup-point-1',
		});
		expect(placed.status).toBe(201);
		expect(placed.json).not.toHaveProperty('orderKey');
		expect(placed.json.next).toEqual({ kind: 'done', url: null });
		expect(placed.json.order).toMatchObject({
			role: 'awaiting_confirmation',
			guest: false,
			address: null,
			delivery: {
				method: 'pickup',
				zone: 'everywhere',
				rate: 'pickup',
				rateName: 'Pickup',
				fee: 0,
				locationId: null,
				locationName: '',
			},
			pickupPoint: { name: 'Front desk', address: '1 Market Road', hours: '9–5' },
			notes: { pickupReady: 'We text you when it is ready.' },
			payment: { method: 'pickup', kind: 'at_pickup', state: 'unpaid', via: 'payments', payUrl: null, balanceDue: 2000 },
		});
		await shop.setting('delivery_zones', 'pickupEnabled', false);
	});
});

describe('a guest order and its key (SS-Order-Key)', () => {
	it('is read by number, paid again and canceled with its key only', async () => {
		await shop.setting('checkout', 'guests', 'on');
		const item = await shop.seedProduct({ price: 1500, stock: 5 });
		const placed = await visit('POST', '/v1/shop/orders', {
			body: {
				lines: [{ productId: item.id }],
				payment: 'online',
				address: ADDRESS,
				customer: { name: 'Gina Guest', phone: '+15550003333', email: 'Gina@Example.com' },
			},
			key: 'guest-key-1',
		});
		expect(placed.status).toBe(201);
		const { order, orderKey, next } = placed.json;
		expect(orderKey).toMatch(/^[A-HJ-NP-Za-km-z2-9]{32}$/);
		expect(order).toMatchObject({
			guest: true,
			role: 'awaiting_payment',
			payment: { method: 'online', kind: 'gateway', state: 'pending', via: 'payments' },
			canCancel: true,
		});
		expect(next.kind).toBe('pay');
		expect(next.url.startsWith(PAYMENTS)).toBe(true);
		expect(order.payment.payUrl).toBe(next.url);
		expect(Date.parse(order.payment.payBy) - Date.parse(order.placedAt)).toBe(60 * 60_000);

		expect(codeOf(await visit('GET', `/v1/shop/orders/by-number/${order.number}`))).toBe('sign_in_required');
		expect((await visit('GET', `/v1/shop/orders/by-number/${order.number}`, { orderKey: 'A'.repeat(32) })).status).toBe(404);
		const byNumber = await visit('GET', `/v1/shop/orders/by-number/${order.number}`, { orderKey });
		expect(byNumber.status).toBe(200);
		expect(byNumber.json).toMatchObject({ id: order.id, number: order.number, guest: true });

		// paying again keeps the payment it has: the same page
		const pay = await visit('POST', `/v1/shop/orders/${order.id}/pay`, { body: {}, orderKey, key: 'guest-pay-1' });
		expect(pay.status).toBe(200);
		expect(pay.json.next).toEqual({ kind: 'pay', url: next.url });
		expect(pay.json.order.id).toBe(order.id);
		// a payment through Payments takes no transfer proof
		const proof = await visit('POST', `/v1/shop/orders/${order.id}/proof/upload`, {
			body: { type: 'image/png', size: 100 },
			orderKey,
		});
		expect(codeOf(proof)).toBe('nothing_to_pay');

		const cancelled = await visit('POST', `/v1/shop/orders/${order.id}/cancel`, { orderKey });
		expect(cancelled.status).toBe(200);
		expect(cancelled.json.order).toMatchObject({
			role: 'cancelled',
			canCancel: false,
			payment: { payUrl: null, payBy: null },
		});
		expect(cancelled.json.order.history.at(-1)).toMatchObject({ status: 'cancelled', label: 'Canceled' });
		expect(codeOf(await visit('POST', `/v1/shop/orders/${order.id}/pay`, { orderKey, key: 'guest-pay-2' }))).toBe(
			'nothing_to_pay',
		);
		await shop.setting('checkout', 'guests', 'off');
	});
});
