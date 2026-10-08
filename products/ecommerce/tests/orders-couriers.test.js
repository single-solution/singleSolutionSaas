/**
 * Couriers (PLAN 0.8.8): the couriers list and tracking links, the generic courier API (booking address, tracking
 * address, headers, body template), booking a shipment when an order ships, and the tracking status read again on
 * view at most every 30 minutes.
 */
import { createId } from '@ss/contracts';
import { netError } from '@ss/net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bookingValues, courierViolation, createCouriers } from '../adapters/couriers.js';
import { placeOrder } from '../adapters/ledger.js';
import { checkCouriers, cleanTracking, courierOf, fillTemplate, readPath, trackingLink } from '../core/couriers.js';
import { COLLECTIONS } from '../core/model.js';
import { ALL, COURIER, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
/** @type {import('@ss/app-kit').WebsiteData} */
let data;
/** @type {string} */
let ticket;

const KEYS = {
	bookUrl: `${COURIER}/book`,
	trackUrl: `${COURIER}/track/{tracking}`,
	apiKey: 'courier-key-123',
	headers: '{"X-Api-Key":"{apiKey}"}',
	bodyTemplate: '{"ref":"{number}","to":"{name}","city":"{city}","collect":"{cod}","pieces":"{items}"}',
	trackingPath: 'data.cn',
	statusPath: 'data.state',
};

beforeAll(async () => {
	shop = await readyShop();
	data = await shop.db();
	await data.ensureIndexes((await import('../adapters/product.js')).INDEXES);
	ticket = await shop.ticket();
	await shop.list('couriers', [{ key: 'swift', name: 'Swift Post', trackingUrl: 'https://track.example.org/{tracking}' }]);
});
afterAll(async () => shop.product.close());

/**
 * A packed order ready to ship.
 * @param {{ method?: 'cod' | 'online', name?: string }} [options]
 */
const packedOrder = async ({ method = 'cod', name = 'Sara "Quotes" Shopper' } = {}) => {
	// the kit closes idle merchant database pools when the clock moves on: take a fresh handle
	data = await shop.db();
	const product = await shop.seedProduct({ stock: 5, price: 2500 });
	const variant = /** @type {import('../core/model.js').VariantRecord} */ (product.variants[0]);
	const placed = await placeOrder(
		data,
		{
			numberPrefix: '',
			order: {
				id: createId('ord'),
				customer: { userId: 'usr_courier00001', name, email: 'sara@example.com', phone: '+15550001111' },
				address: {
					name,
					phone: '+15550001111',
					line1: '1 Main St',
					line2: '',
					city: 'Springfield',
					area: '',
					postalCode: '',
					country: 'US',
					notes: 'Gate 2',
				},
				delivery: { method: 'delivery', zone: '', fee: 0, locationId: null },
				lines: [
					{
						id: createId('oln'),
						productId: product.id,
						variantId: variant.id,
						kind: 'physical',
						name: 'Phone',
						variantName: '',
						sku: '',
						grade: null,
						gradeLabel: '',
						image: null,
						unitPrice: 2500,
						quantity: 2,
						discount: 0,
						tax: 0,
						total: 5000,
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
				totals: { subtotal: 5000, discount: 0, delivery: 0, tax: 0, total: 5000, currency: 'USD', taxIncluded: true },
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
					method,
					state: method === 'cod' ? 'unpaid' : 'paid',
					paymentId: method === 'cod' ? null : 'pay_courier',
					advance: 0,
					paid: method === 'cod' ? 0 : 5000,
					refunded: 0,
					checkedAt: null,
				},
				status: 'packed',
				role: 'packed',
				history: [],
				shipment: null,
				stockHeld: true,
				holdUntil: null,
				idempotencyKey: createId('key'),
				note: '',
				staffNote: '',
				placedAt: new Date(shop.now()),
				deliveredAt: null,
			},
		},
		{ now: shop.now() },
	);
	if (!placed.ok) throw new Error(placed.code);
	shop.advance(1000);
	return placed.order;
};

describe('the couriers list', () => {
	it('checks keys, names and tracking-link templates', () => {
		expect(checkCouriers('x')).toEqual({ ok: false, errors: ['A list of couriers is expected.'] });
		const ok = checkCouriers([
			{ key: ' swift ', name: ' Swift ', trackingUrl: 'https://t.example.org/{tracking}' },
			{ key: 'hand', name: 'Hand', trackingUrl: '' },
			{ key: 'none', name: 'None' },
		]);
		expect(ok).toEqual({
			ok: true,
			value: [
				{ key: 'swift', name: 'Swift', trackingUrl: 'https://t.example.org/{tracking}' },
				{ key: 'hand', name: 'Hand', trackingUrl: '' },
				{ key: 'none', name: 'None', trackingUrl: '' },
			],
		});
		const bad = checkCouriers([
			null,
			{ key: 'Bad Key', name: 'x' },
			{ key: 'a', name: '' },
			{ key: 'a', name: 'A', trackingUrl: 'http://t.example.org/{tracking}' },
			{ key: 'b', name: 'B', trackingUrl: 'https://t.example.org/no-token' },
			{ key: 'c', name: 'C', trackingUrl: 'https://user:pw@t.example.org/{tracking}' },
			{ key: 'd', name: 'D', trackingUrl: 'not a url {tracking}' },
		]);
		expect(bad.ok).toBe(false);
		expect(!bad.ok && bad.errors.length).toBe(8);
		const many = checkCouriers(Array.from({ length: 31 }, (_, i) => ({ key: `c${i}`, name: `C${i}` })));
		expect(!many.ok && many.errors).toEqual(['At most 30 couriers.']);
	});

	it('fills tracking links and cleans tracking numbers', () => {
		expect(trackingLink('https://t.example.org/?n={tracking}', 'A B/1')).toBe('https://t.example.org/?n=A%20B%2F1');
		expect(trackingLink('', 'X')).toBe('');
		expect(trackingLink('http://insecure/{tracking}', 'X')).toBe('');
		expect(courierOf('nope', 'a')).toBeNull();
		expect(courierOf([{ key: 'a', name: 'A', trackingUrl: '' }], 'a')?.name).toBe('A');
		expect(cleanTracking(42)).toBe('42');
		expect(cleanTracking(' AB1 ')).toBe('AB1');
		expect(cleanTracking('a\nb')).toBeNull();
		expect(cleanTracking('x'.repeat(81))).toBeNull();
		expect(cleanTracking(1.5)).toBeNull();
		expect(cleanTracking(null)).toBeNull();
		expect(readPath({ a: { b: [{ c: 'deep' }] } }, 'a.b.0.c')).toBe('deep');
		expect(readPath({ a: 1 }, 'a.b')).toBeUndefined();
		expect(readPath(null, 'a')).toBeUndefined();
		expect(fillTemplate('{number}-{unknown}-{city}', { number: 'N1' })).toBe('N1-{unknown}-');
	});
});

describe('the generic courier API adapter', () => {
	/** @type {Array<{ url: string, init: any }>} */
	const sent = [];
	/** @type {(url: string, init: any) => any} */
	let answer = () => ({ status: 200, body: Buffer.from('{}') });
	const couriers = createCouriers({
		send: async (url, init) => {
			sent.push({ url, init });
			const result = answer(url, init);
			if (result instanceof Error) throw result;
			return { headers: {}, url, ...result };
		},
	});
	const order = /** @type {any} */ ({
		number: '2026-000001',
		customer: { userId: 'u', name: 'Sam', email: 's@example.com', phone: '+1555' },
		address: null,
		note: 'Leave at door',
		lines: [
			{ kind: 'physical', quantity: 2 },
			{ kind: 'digital', quantity: 1 },
		],
		totals: { total: 1999, currency: 'USD' },
		payment: { method: 'online', paid: 1999 },
	});

	it('checks the connection without calling the courier', async () => {
		expect(await couriers.test(null)).toMatchObject({ ok: false });
		expect(await couriers.test({ ...KEYS, bookUrl: 'http://courier.example.org/book' })).toMatchObject({ ok: false });
		expect(await couriers.test({ ...KEYS, bookUrl: 'https://127.0.0.1/book' })).toMatchObject({ ok: false });
		expect(await couriers.test({ ...KEYS, trackUrl: 'https://courier.example.org/track' })).toMatchObject({ ok: false });
		expect(await couriers.test({ ...KEYS, apiKey: '' })).toMatchObject({ ok: false });
		expect(await couriers.test({ ...KEYS, headers: 'not json' })).toMatchObject({ ok: false });
		expect(await couriers.test({ ...KEYS, headers: { 'Bad Header': 'x' } })).toMatchObject({ ok: false });
		expect(await couriers.test({ ...KEYS, headers: '[1]' })).toMatchObject({ ok: false });
		expect(await couriers.test({ ...KEYS, bodyTemplate: '{"a":' })).toMatchObject({ ok: false });
		expect(await couriers.test({ ...KEYS, bodyTemplate: 5 })).toMatchObject({ ok: false });
		expect(await couriers.test({ ...KEYS, trackingPath: 'a..b' })).toMatchObject({ ok: false });
		expect(await couriers.test({ ...KEYS, statusPath: '$bad path' })).toMatchObject({ ok: false });
		expect(await couriers.test(KEYS)).toEqual({ ok: true });
		expect(
			await couriers.test({ bookUrl: KEYS.bookUrl, trackUrl: KEYS.trackUrl, apiKey: 'k', headers: { 'X-Key': '{apiKey}' } }),
		).toEqual({
			ok: true,
		});
		expect(sent).toHaveLength(0);
		expect(
			courierViolation(
				{ ...KEYS, bodyTemplate: '' },
				/** @type {any} */ ({ ...(await import('@ss/net')).createOutboundPolicy() }),
			),
		).toBeNull();
	});

	it('books with the default body and the bearer key, and reads the tracking number', async () => {
		answer = () => ({ status: 201, body: Buffer.from(JSON.stringify({ trackingNumber: 'TN-1' })) });
		const booked = await couriers.book({ order, value: { bookUrl: KEYS.bookUrl, trackUrl: KEYS.trackUrl, apiKey: 'k1' } });
		expect(booked).toEqual({ ok: true, trackingNumber: 'TN-1' });
		const call = /** @type {{ url: string, init: any }} */ (sent.at(-1));
		expect(call.init).toMatchObject({ method: 'POST', timeoutMs: 8000, maxBytes: 65536, redirect: 'error' });
		expect(call.init.headers.authorization).toBe('Bearer k1');
		expect(JSON.parse(call.init.body)).toMatchObject({
			reference: '2026-000001',
			name: 'Sam',
			items: '2',
			amount: '19.99',
			cod: '0.00',
			note: 'Leave at door',
		});
	});

	it('reports what went wrong', async () => {
		const value = { ...KEYS };
		answer = () => ({ status: 500, body: Buffer.from('oops') });
		expect(await couriers.book({ order, value })).toEqual({ ok: false, message: 'The courier answered 500.' });
		answer = () => netError('timeout', 'deadline', 'too slow');
		expect(await couriers.book({ order, value })).toEqual({ ok: false, message: 'The courier could not be reached.' });
		answer = () => ({ status: 200, body: Buffer.from('not json') });
		expect(await couriers.book({ order, value })).toEqual({
			ok: false,
			message: 'The courier did not answer a tracking number.',
		});
		expect(await couriers.book({ order, value: { ...KEYS, apiKey: '' } })).toMatchObject({ ok: false });
		expect(await couriers.track({ trackingNumber: 'X', value: null })).toMatchObject({ ok: false });
		answer = () => ({ status: 404, body: Buffer.from('{}') });
		expect(await couriers.track({ trackingNumber: 'X', value })).toEqual({ ok: false, message: 'The courier answered 404.' });
		answer = () => ({ status: 200, body: Buffer.from('{"data":{}}') });
		expect(await couriers.track({ trackingNumber: 'X', value })).toEqual({
			ok: false,
			message: 'The courier did not answer a status.',
		});
		answer = () => ({ status: 200, body: Buffer.from('{"status":3}') });
		expect(await couriers.track({ trackingNumber: 'A/1', value: { ...KEYS, statusPath: '' } })).toEqual({
			ok: true,
			status: '3',
		});
		expect(sent.at(-1)?.url).toBe(`${COURIER}/track/A%2F1`);
		answer = () => new TypeError('bug');
		await expect(couriers.track({ trackingNumber: 'X', value })).rejects.toThrow('bug');
	});

	it('gives the booking the cash to collect', () => {
		const values = bookingValues({
			...order,
			payment: { method: 'cod', paid: 500 },
			address: {
				name: '',
				phone: '',
				line1: 'L1',
				line2: '',
				city: 'C',
				area: 'A',
				postalCode: 'P',
				country: 'US',
				notes: '',
			},
		});
		expect(values).toMatchObject({
			cod: '14.99',
			name: 'Sam',
			phone: '+1555',
			line1: 'L1',
			note: 'Leave at door',
			total: '1999',
		});
	});
});

describe('booking and tracking shipments', () => {
	it('refuses booking while Courier APIs are off or not connected', async () => {
		const order = await packedOrder();
		await shop.switchOn(ALL.filter((feature) => feature !== 'courier_apis'));
		try {
			const off = await shop.admin(ticket, 'POST', `/v1/admin/orders/${order.id}/move`, {
				to: 'dispatched',
				shipment: { book: true },
			});
			expect(off.status).toBe(422);
		} finally {
			await shop.switchOn(ALL);
		}
		const missing = await shop.admin(ticket, 'POST', `/v1/admin/orders/${order.id}/move`, {
			to: 'dispatched',
			shipment: { book: true },
		});
		expect(missing.status).toBe(502);
		expect(missing.json.type).toMatch(/courier_failed$/);
	});

	it('books through the courier API, links the tracking page and reads the status on view', async () => {
		await shop.connect('courier', KEYS);
		await shop.setting('courier_apis', 'courier', 'swift');
		/** @type {string[]} */
		const bodies = [];
		shop.responders.set(`${COURIER}/book`, (call) => {
			bodies.push(call.body);
			return { status: 200, body: { data: { cn: 'CN 77' } } };
		});
		let state = 'Picked up';
		shop.responders.set(`${COURIER}/track/CN%2077`, () => ({ status: 200, body: { data: { state } } }));
		const order = await packedOrder();
		const unknown = await shop.admin(ticket, 'POST', `/v1/admin/orders/${order.id}/move`, {
			to: 'dispatched',
			shipment: { book: true, courier: 'nobody' },
		});
		expect(unknown.status).toBe(422);
		const shipped = await shop.admin(ticket, 'POST', `/v1/admin/orders/${order.id}/move`, {
			to: 'dispatched',
			shipment: { book: true },
		});
		expect(shipped.status).toBe(200);
		expect(shipped.json.shipment).toMatchObject({
			courier: 'Swift Post',
			trackingNumber: 'CN 77',
			trackingUrl: 'https://track.example.org/CN%2077',
			booked: true,
			status: '',
		});
		expect(JSON.parse(/** @type {string} */ (bodies[0]))).toEqual({
			ref: order.number,
			to: 'Sara "Quotes" Shopper',
			city: 'Springfield',
			collect: '50.00',
			pieces: '2',
		});
		const book = shop.callsTo(`${COURIER}/book`).at(-1);
		expect(book?.headers['x-api-key']).toBe('courier-key-123');
		expect(book?.headers.authorization).toBeUndefined();
		const updatedAt = shipped.json.updatedAt;
		const viewed = await shop.admin(ticket, 'GET', `/v1/admin/orders/${order.id}`);
		expect(viewed.json.shipment).toMatchObject({ status: 'Picked up' });
		expect(viewed.json.updatedAt).toBe(updatedAt);
		// not asked again within 30 minutes
		state = 'Out for delivery';
		const calls = shop.callsTo(`${COURIER}/track`).length;
		shop.advance(10 * 60_000);
		expect((await shop.api('GET', `/v1/orders/${order.id}`)).json.shipment.status).toBe('Picked up');
		expect(shop.callsTo(`${COURIER}/track`).length).toBe(calls);
		shop.advance(25 * 60_000);
		expect((await shop.api('GET', `/v1/orders/${order.id}`)).json.shipment.status).toBe('Out for delivery');
		// a failed check keeps the last status
		shop.responders.set(`${COURIER}/track/CN%2077`, () => ({ status: 503, body: {} }));
		shop.advance(31 * 60_000);
		const kept = await shop.api('GET', `/v1/orders/${order.id}`);
		expect(kept.json.shipment.status).toBe('Out for delivery');
		data = await shop.db();
		const record = /** @type {any} */ (
			await data.collection(COLLECTIONS.orders).findOne({ websiteId: data.websiteId, id: order.id })
		);
		expect(record.shipment.checkedAt.getTime()).toBe(shop.now());
		// a staff move still goes through with the updatedAt staff saw (a new ticket: the first one expired meanwhile)
		ticket = await shop.ticket();
		const delivered = await shop.admin(ticket, 'POST', `/v1/admin/orders/${order.id}/move`, { to: 'delivered', updatedAt });
		expect(delivered.status).toBe(200);
	});

	it('books without a courier of the list, and moves nothing when the courier refuses', async () => {
		await shop.setting('courier_apis', 'courier', '');
		shop.responders.set(`${COURIER}/book`, () => ({ status: 200, body: { data: { cn: 'CN9' } } }));
		const order = await packedOrder({ method: 'online' });
		const shipped = await shop.api('POST', `/v1/orders/${order.id}/move`, { to: 'dispatched', shipment: { book: true } });
		expect(shipped.json.shipment).toMatchObject({ courier: '', trackingNumber: 'CN9', trackingUrl: '', booked: true });
		expect(JSON.parse(shop.callsTo(`${COURIER}/book`).at(-1)?.body ?? '{}').collect).toBe('0.00');
		shop.responders.set(`${COURIER}/book`, () => ({ status: 400, body: { error: 'bad address' } }));
		const other = await packedOrder();
		const refused = await shop.api('POST', `/v1/orders/${other.id}/move`, { to: 'dispatched', shipment: { book: true } });
		expect(refused.status).toBe(502);
		expect(refused.json.detail).toBe('The courier answered 400.');
		expect((await shop.api('GET', `/v1/orders/${other.id}`)).json.status).toBe('packed');
		// an order shipped by hand is never tracked
		const byHand = await packedOrder();
		await shop.api('POST', `/v1/orders/${byHand.id}/move`, {
			to: 'dispatched',
			shipment: { courier: 'swift', trackingNumber: 'H1' },
		});
		const tracks = shop.callsTo(`${COURIER}/track`).length;
		await shop.api('GET', `/v1/orders/${byHand.id}`);
		expect(shop.callsTo(`${COURIER}/track`).length).toBe(tracks);
	});
});
