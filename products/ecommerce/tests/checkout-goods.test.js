/**
 * Bookings and digital goods at checkout: free slots, booking a slot once, licence keys and files added by the
 * merchant, licence keys given and downloads opened once the order is paid.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_FLOW } from '../core/flow.js';
import { COLLECTIONS } from '../core/model.js';
import { ORIGIN, PAYMENTS, STORAGE, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
let ip = 0;
let users = 0;

const ADDRESS = { name: 'Sam', phone: '+15550002222', line1: '2 High Street', city: 'Town' };

/**
 * @param {string} method @param {string} path @param {{ body?: unknown, signIn?: string, key?: string }} [init]
 */
const visit = (method, path, { body, signIn, key } = {}) => {
	ip += 1;
	return shop.call(method, path, {
		token: shop.browser,
		origin: ORIGIN,
		body,
		headers: {
			'x-forwarded-for': `10.1.${(ip >> 8) & 255}.${ip & 255}`,
			...(signIn ? { 'ss-sign-in': signIn } : {}),
			...(key ? { 'idempotency-key': key } : {}),
		},
	});
};

const newShopper = async () => {
	users += 1;
	return shop.signIn({ id: `usr_goods${String(users).padStart(6, '0')}` });
};

/** @param {string} token @param {Record<string, unknown>} body */
const place = (token, body) => visit('POST', '/v1/shop/orders', { body, signIn: token, key: `goods-${ip}-${Math.random()}` });

/** @param {{ json: any }} response */
const codeOf = (response) =>
	String(response.json?.type ?? '')
		.split('/')
		.pop();

/** @param {string} id */
const paymentOf = async (id) =>
	/** @type {any} */ (await (await shop.db()).collection(COLLECTIONS.orders).findOne({ websiteId: shop.websiteId, id })).payment
		.paymentId;

beforeAll(async () => {
	shop = await readyShop();
	await shop.list(
		'booking_hours',
		[0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, from: '09:00', to: '17:00' })),
	);
});
afterAll(async () => shop.product.close());

describe('bookings', () => {
	it('lists free slots and books each slot once', async () => {
		const service = await shop.seedProduct({
			kind: 'booking',
			trackStock: false,
			booking: { durationMinutes: 60 },
			price: 5000,
		});
		const free = await visit('GET', `/v1/shop/slots?productId=${service.id}&to=2026-10-06T00:00:00Z`);
		expect(free.status).toBe(200);
		expect(free.json).toMatchObject({ productId: service.id, durationMinutes: 60, timeZone: 'UTC' });
		expect(free.json.slots.map((/** @type {any} */ slot) => slot.start)).toEqual([
			'2026-10-05T11:00:00.000Z',
			'2026-10-05T12:00:00.000Z',
			'2026-10-05T13:00:00.000Z',
			'2026-10-05T14:00:00.000Z',
			'2026-10-05T15:00:00.000Z',
			'2026-10-05T16:00:00.000Z',
		]);
		const slot = '2026-10-05T12:00:00.000Z';
		const first = await newShopper();
		const quote = await visit('POST', '/v1/shop/cart/quote', { body: { lines: [{ productId: service.id, slot }] } });
		expect(quote.json).toMatchObject({ delivery: { method: 'none' }, ready: true, lines: [{ slot: { start: slot } }] });
		expect(quote.json.paymentMethods[0]).toMatchObject({ method: 'cod', available: false, reason: 'needs_delivery' });
		const placed = await place(first, { lines: [{ productId: service.id, slot }], payment: 'online' });
		expect(placed.status).toBe(201);
		expect(placed.json.order).toMatchObject({
			address: null,
			lines: [{ booking: { start: slot, end: '2026-10-05T13:00:00.000Z' } }],
		});

		const second = await newShopper();
		const taken = await place(second, { lines: [{ productId: service.id, slot }], payment: 'online' });
		expect(taken.status).toBe(409);
		expect(codeOf(taken)).toBe('slot_taken');
		const after = await visit('GET', `/v1/shop/slots?productId=${service.id}&to=2026-10-06T00:00:00Z`);
		expect(after.json.slots.map((/** @type {any} */ s) => s.start)).not.toContain(slot);

		await visit('POST', `/v1/shop/orders/${placed.json.order.id}/cancel`, { signIn: first });
		const freed = await visit('GET', `/v1/shop/slots?productId=${service.id}&to=2026-10-06T00:00:00Z`);
		expect(freed.json.slots.map((/** @type {any} */ s) => s.start)).toContain(slot);

		const odd = await place(second, { lines: [{ productId: service.id, slot: '2026-10-05T12:30:00Z' }], payment: 'online' });
		expect(odd.status).toBe(422);
		expect(odd.json.errors[0].code).toBe('slot_unavailable');
	});

	it('checks the slot query', async () => {
		const physical = await shop.seedProduct();
		expect((await visit('GET', '/v1/shop/slots')).status).toBe(422);
		expect((await visit('GET', `/v1/shop/slots?productId=${physical.id}&from=never`)).status).toBe(422);
		expect((await visit('GET', `/v1/shop/slots?productId=${physical.id}`)).status).toBe(404);
	});
});

describe('digital goods', () => {
	it('lets the merchant add licence keys and files', async () => {
		const item = await shop.seedProduct({
			kind: 'digital',
			trackStock: false,
			digital: { files: [], licenceKeys: true, downloadLimit: 0 },
		});
		const added = await shop.api('POST', `/v1/products/${item.id}/licences`, { keys: ['K-1', 'K-2', 'K-1'] });
		expect(added.json).toEqual({ added: 2, available: 2 });
		const ticket = await shop.ticket(['catalog.edit']);
		const more = await shop.admin(ticket, 'POST', `/v1/admin/products/${item.id}/licences`, { keys: ['K-2', 'K-3'] });
		expect(more.json).toEqual({ added: 1, available: 3 });
		expect((await shop.api('POST', `/v1/products/${item.id}/licences`, { keys: [] })).status).toBe(422);
		expect((await shop.api('POST', '/v1/products/prd_nothing/licences', { keys: ['x'] })).status).toBe(404);
		const physical = await shop.seedProduct();
		expect((await shop.api('POST', `/v1/products/${physical.id}/licences`, { keys: ['x'] })).status).toBe(422);

		const file = await shop.admin(ticket, 'POST', `/v1/admin/products/${item.id}/files`, {
			name: 'User Guide.pdf',
			type: 'application/pdf',
			size: 2048,
		});
		expect(file.status).toBe(200);
		expect(file.json.file).toEqual({ name: 'User-Guide.pdf', type: 'application/pdf', size: 2048 });
		expect(file.json.upload).toMatchObject({ method: 'PUT', headers: { 'content-type': 'application/pdf' } });
		expect(file.json.upload.url.startsWith(STORAGE)).toBe(true);
		const stored = /** @type {any} */ (
			await (await shop.db()).collection(COLLECTIONS.products).findOne({ websiteId: shop.websiteId, id: item.id })
		);
		expect(stored.digital).toMatchObject({
			licenceKeys: true,
			files: [{ key: `ecommerce/digital/${item.id}/User-Guide.pdf` }],
		});
		for (const [body, field] of /** @type {Array<[unknown, string]>} */ ([
			[{ name: '..', type: 'application/pdf', size: 1 }, '/name'],
			[{ name: 'a.pdf', type: 'pdf', size: 1 }, '/type'],
			[{ name: 'a.pdf', type: 'application/pdf', size: 0 }, '/size'],
		])) {
			const refused = await shop.api('POST', `/v1/products/${item.id}/files`, body);
			expect(refused.json.errors[0].path).toBe(field);
		}
	});

	it('gives licence keys and downloads once the order is paid, within the download limit', async () => {
		const item = await shop.seedProduct({
			kind: 'digital',
			trackStock: false,
			price: 900,
			digital: {
				files: [{ key: 'ecommerce/digital/x/book.pdf', type: 'application/pdf', size: 10, alt: 'The book' }],
				licenceKeys: true,
				downloadLimit: 2,
			},
		});
		await shop.api('POST', `/v1/products/${item.id}/licences`, { keys: ['AAA', 'BBB', 'CCC'] });
		const shopper = await newShopper();
		const many = await visit('POST', '/v1/shop/cart/quote', { body: { lines: [{ productId: item.id, quantity: 4 }] } });
		expect(many.json.lines[0].problems[0].code).toBe('not_enough_stock');
		const cod = await place(shopper, { lines: [{ productId: item.id }], payment: 'cod' });
		expect(cod.status).toBe(422);

		const placed = await place(shopper, { lines: [{ productId: item.id, quantity: 2 }], payment: 'online' });
		expect(placed.status).toBe(201);
		const id = placed.json.order.id;
		const lineId = placed.json.order.lines[0].id;
		expect(placed.json.order.lines[0]).toMatchObject({ downloads: [], licenceKeys: [] });
		const early = await visit('GET', `/v1/shop/orders/${id}/downloads/${lineId}/book.pdf`, { signIn: shopper });
		expect(early.status).toBe(403);
		expect(codeOf(early)).toBe('download_not_allowed');

		shop.payPayment(await paymentOf(id));
		shop.advance(31_000);
		const paid = await visit('GET', `/v1/shop/orders/${id}`, { signIn: shopper });
		expect(paid.json.payment.state).toBe('paid');
		expect(paid.json.lines[0]).toMatchObject({
			downloads: [{ file: 'book.pdf', name: 'The book', type: 'application/pdf', size: 10 }],
			downloadsLeft: 2,
		});
		expect(paid.json.lines[0].licenceKeys).toHaveLength(2);
		expect(['AAA', 'BBB', 'CCC']).toEqual(expect.arrayContaining(paid.json.lines[0].licenceKeys));

		for (let n = 0; n < 2; n += 1) {
			const link = await visit('GET', `/v1/shop/orders/${id}/downloads/${lineId}/book.pdf`, { signIn: shopper });
			expect(link.status).toBe(200);
			expect(link.json.url).toContain('response-content-disposition');
			expect(Date.parse(link.json.expiresAt) - shop.now()).toBe(300_000);
		}
		expect(codeOf(await visit('GET', `/v1/shop/orders/${id}/downloads/${lineId}/book.pdf`, { signIn: shopper }))).toBe(
			'download_not_allowed',
		);
		expect((await visit('GET', `/v1/shop/orders/${id}/downloads/oln_none/book.pdf`, { signIn: shopper })).status).toBe(404);
		expect((await visit('GET', `/v1/shop/orders/${id}/downloads/${lineId}/other.pdf`, { signIn: shopper })).status).toBe(404);
		expect(shop.callsTo(PAYMENTS).length).toBeGreaterThan(0);
	});
});

describe('free orders', () => {
	it('are paid as they are placed and give their licence keys at once', async () => {
		const item = await shop.seedProduct({
			kind: 'digital',
			trackStock: false,
			price: 0,
			digital: { files: [], licenceKeys: true, downloadLimit: 0 },
		});
		await shop.api('POST', `/v1/products/${item.id}/licences`, { keys: ['FREE-1'] });
		const placed = await place(await newShopper(), { lines: [{ productId: item.id }], payment: 'online' });
		expect(placed.status).toBe(201);
		expect(placed.json.next).toEqual({ kind: 'done' });
		expect(placed.json.order).toMatchObject({
			status: 'awaiting_confirmation',
			payment: { state: 'paid' },
			lines: [{ licenceKeys: ['FREE-1'], downloadsLeft: 5 }],
		});
	});
});

describe('a shop with only the catalog and checkout', () => {
	it('prices without zones, taxes or COD, keeps a paid order the flow cannot move, and ends unpaid ones without Payments', async () => {
		const other = await readyShop({ features: ['catalog', 'checkout'] });
		try {
			const config = await other.visitor('GET', '/v1/widget/config');
			expect(config.json.settings.checkout).toMatchObject({
				paymentMethods: ['online', 'bank_transfer'],
				cod: null,
				pickupLocations: [],
				delivery: { zones: false, cities: [] },
				pricesIncludeTax: true,
				bookings: false,
				digital: false,
			});
			await other.list('order_flow', {
				statuses: DEFAULT_FLOW.statuses,
				moves: DEFAULT_FLOW.moves.filter((move) => !(move.from === 'pending_payment' && move.to === 'confirmed')),
			});
			const item = await other.seedProduct({ price: 800 });
			const token = await other.signIn({ id: 'usr_small0000001' });
			const quote = await other.visitor('POST', '/v1/shop/cart/quote', {
				body: { lines: [{ productId: item.id }], points: 10 },
				signIn: token,
			});
			expect(quote.json).toMatchObject({ delivery: { method: 'delivery', fee: 0 }, points: null, totals: { total: 800 } });
			/** @param {string} key */
			const order = (key) =>
				other.visitor('POST', '/v1/shop/orders', {
					body: { lines: [{ productId: item.id }], payment: 'online', address: ADDRESS },
					signIn: token,
					key,
				});
			const paid = (await order('small-1')).json.order;
			const unpaid = (await order('small-2')).json.order;
			/** @param {string} id */
			const record = async (id) =>
				/** @type {any} */ (
					await (await other.db()).collection(COLLECTIONS.orders).findOne({ websiteId: other.websiteId, id })
				);
			other.payPayment((await record(paid.id)).payment.paymentId);
			const read = await other.visitor('GET', `/v1/shop/orders/${paid.id}`, { signIn: token });
			expect(read.json).toMatchObject({ status: 'pending_payment', payment: { state: 'paid', paid: 800, payUrl: null } });

			await other.dashboard(
				await other.adminSession(),
				'DELETE',
				`/v1/dashboard/websites/${other.websiteId}/connections/payments`,
			);
			other.advance(62 * 60_000);
			await other.visitor('POST', '/v1/shop/cart/quote', { body: { lines: [{ productId: item.id }] } });
			expect((await record(unpaid.id)).status).toBe('cancelled');
			expect((await record(paid.id)).status).toBe('pending_payment');
			expect((await other.visitor('GET', '/v1/widget/config')).json.settings.checkout.paymentMethods).toEqual([]);

			await other.switchOn(['catalog']);
			const off = await other.visitor('GET', '/v1/widget/config');
			expect(off.json.settings).not.toHaveProperty('checkout');
		} finally {
			await other.product.close();
		}
	});
});
