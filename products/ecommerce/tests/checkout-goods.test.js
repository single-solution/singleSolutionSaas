/**
 * Bookings and digital goods at checkout: free slots, booking a slot once, license keys and files added by the
 * merchant, license keys given and downloads opened once the order is paid.
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
	await shop.list('booking_schedules', [
		{ key: 'main', name: 'Main', weekly: [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, start: '09:00', end: '17:00' })) },
		// a second place, open on Mondays only, closed on one Monday and open on one Tuesday (E30)
		{
			key: 'branch',
			name: 'Branch',
			weekly: [{ day: 1, start: '14:00', end: '16:00' }],
			exceptions: [
				{ date: '2026-10-12', name: 'Holiday' },
				{ date: '2026-10-06', name: 'Open Tuesday', hours: [{ start: '10:00', end: '11:00' }] },
			],
		},
	]);
});
afterAll(async () => shop.product.close());

describe('bookings', () => {
	it('lists free slots and books each slot once', async () => {
		const service = await shop.seedProduct({
			kind: 'service',
			trackStock: false,
			booking: { durationMinutes: 60, schedule: '' },
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
		expect(quote.json.paymentMethods.find((/** @type {any} */ m) => m.method === 'cod')).toMatchObject({
			available: false,
			reason: 'needs_delivery',
		});
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

	it('books each service on its own schedule, with its dated exceptions (E30)', async () => {
		const service = await shop.seedProduct({
			kind: 'service',
			trackStock: false,
			booking: { durationMinutes: 60, schedule: 'branch' },
			price: 5000,
		});
		const free = await visit('GET', `/v1/shop/slots?productId=${service.id}&to=2026-10-14T00:00:00Z`);
		expect(free.json.slots.map((/** @type {any} */ slot) => slot.start)).toEqual([
			'2026-10-05T14:00:00.000Z',
			'2026-10-05T15:00:00.000Z',
			// the open Tuesday; the Monday holiday has none
			'2026-10-06T10:00:00.000Z',
		]);
		const shopper = await newShopper();
		const closed = await place(shopper, {
			lines: [{ productId: service.id, slot: '2026-10-12T14:00:00.000Z' }],
			payment: 'online',
		});
		expect(closed.json.errors[0].code).toBe('slot_unavailable');
		const placed = await place(shopper, {
			lines: [{ productId: service.id, slot: '2026-10-06T10:00:00.000Z' }],
			payment: 'online',
		});
		expect(placed.status).toBe(201);
		// a schedule the list no longer has: nothing can be booked
		const gone = await shop.seedProduct({
			kind: 'service',
			trackStock: false,
			booking: { durationMinutes: 60, schedule: 'gone' },
			price: 5000,
		});
		expect((await visit('GET', `/v1/shop/slots?productId=${gone.id}&to=2026-10-14T00:00:00Z`)).json.slots).toEqual([]);
	});

	it('checks the slot query', async () => {
		const physical = await shop.seedProduct();
		expect((await visit('GET', '/v1/shop/slots')).status).toBe(422);
		expect((await visit('GET', `/v1/shop/slots?productId=${physical.id}&from=never`)).status).toBe(422);
		expect((await visit('GET', `/v1/shop/slots?productId=${physical.id}`)).status).toBe(404);
	});
});

describe('digital goods', () => {
	it('lets the merchant add license keys and files', async () => {
		const item = await shop.seedProduct({
			kind: 'digital',
			trackStock: false,
			digital: { files: [], retired: [], licenseKeys: true, downloadLimit: 0 },
		});
		const added = await shop.api('POST', `/v1/products/${item.id}/licenses`, { keys: ['K-1', 'K-2', 'K-1'] });
		expect(added.json).toEqual({ added: 2, available: 2 });
		const ticket = await shop.ticket(['catalog.edit']);
		const more = await shop.admin(ticket, 'POST', `/v1/admin/products/${item.id}/licenses`, { keys: ['K-2', 'K-3'] });
		expect(more.json).toEqual({ added: 1, available: 3 });
		expect((await shop.api('POST', `/v1/products/${item.id}/licenses`, { keys: [] })).status).toBe(422);
		expect((await shop.api('POST', '/v1/products/prd_nothing/licenses', { keys: ['x'] })).status).toBe(404);
		const physical = await shop.seedProduct();
		expect((await shop.api('POST', `/v1/products/${physical.id}/licenses`, { keys: ['x'] })).status).toBe(422);

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
			licenseKeys: true,
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

	it('gives license keys and downloads once the order is paid, within the download limit', async () => {
		const item = await shop.seedProduct({
			kind: 'digital',
			trackStock: false,
			price: 900,
			digital: {
				files: [{ key: 'ecommerce/digital/x/book.pdf', type: 'application/pdf', size: 10, alt: 'The book' }],
				retired: [],
				licenseKeys: true,
				downloadLimit: 2,
			},
		});
		await shop.api('POST', `/v1/products/${item.id}/licenses`, { keys: ['AAA', 'BBB', 'CCC'] });
		const shopper = await newShopper();
		const many = await visit('POST', '/v1/shop/cart/quote', { body: { lines: [{ productId: item.id, quantity: 4 }] } });
		expect(many.json.lines[0].problems[0].code).toBe('not_enough_stock');
		const cod = await place(shopper, { lines: [{ productId: item.id }], payment: 'cod' });
		expect(cod.status).toBe(422);

		const placed = await place(shopper, { lines: [{ productId: item.id, quantity: 2 }], payment: 'online' });
		expect(placed.status).toBe(201);
		const id = placed.json.order.id;
		const lineId = placed.json.order.lines[0].id;
		expect(placed.json.order.lines[0]).toMatchObject({ downloads: [], licenseKeys: [] });
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
		expect(paid.json.lines[0].licenseKeys).toHaveLength(2);
		expect(['AAA', 'BBB', 'CCC']).toEqual(expect.arrayContaining(paid.json.lines[0].licenseKeys));

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

	it('holds a license key per unit while an order waits, so the last key is sold once (SR-5a-2)', async () => {
		const item = await shop.seedProduct({
			kind: 'digital',
			trackStock: false,
			price: 900,
			digital: { files: [], retired: [], licenseKeys: true, downloadLimit: 0 },
		});
		await shop.api('POST', `/v1/products/${item.id}/licenses`, { keys: ['ONLY-1'] });
		const first = await newShopper();
		const second = await newShopper();
		const placed = await place(first, { lines: [{ productId: item.id }], payment: 'online' });
		expect(placed.status).toBe(201);
		// the key is held: a second shopper's cart is refused at the cart check and at placing
		const quote = await visit('POST', '/v1/shop/cart/quote', { body: { lines: [{ productId: item.id }] } });
		expect(quote.json.lines[0].problems[0].code).toBe('out_of_stock');
		const refused = await place(second, { lines: [{ productId: item.id }], payment: 'online' });
		expect([refused.status, codeOf(refused)]).toEqual([409, 'out_of_stock']);
		const keys = async () =>
			/** @type {any[]} */ (
				await (
					await shop.db()
				)
					.collection(COLLECTIONS.licenses)
					.find({ websiteId: shop.websiteId, productId: item.id })
					.toArray()
			).map((license) => license.status);
		expect(await keys()).toEqual(['held']);
		// a staff removal does not take the held key away
		const removed = await shop.api('POST', `/v1/products/${item.id}/licenses/remove`, { keys: ['ONLY-1'] });
		expect(removed.json).toMatchObject({ removed: 0, given: 1, available: 0 });

		// the order is canceled: the key is free for the next shopper, who then pays and is given it
		await visit('POST', `/v1/shop/orders/${placed.json.order.id}/cancel`, { signIn: first });
		expect(await keys()).toEqual(['available']);
		const next = await place(second, { lines: [{ productId: item.id }], payment: 'online' });
		expect(next.status).toBe(201);
		shop.payPayment(await paymentOf(next.json.order.id));
		shop.advance(31_000);
		const paid = await visit('GET', `/v1/shop/orders/${next.json.order.id}`, { signIn: second });
		expect(paid.json.lines[0].licenseKeys).toEqual(['ONLY-1']);
		expect(await keys()).toEqual(['assigned']);
	});
});

describe('removing digital files and license keys', () => {
	it('takes them away from new buyers, while paid orders keep what they were given', async () => {
		const book = { key: 'ecommerce/digital/prd_removals1/book.pdf', type: 'application/pdf', size: 10, alt: 'The book' };
		const extra = { key: 'ecommerce/digital/prd_removals1/extra.pdf', type: 'application/pdf', size: 20, alt: 'Extras' };
		const item = await shop.seedProduct({
			id: 'prd_removals1',
			kind: 'digital',
			trackStock: false,
			price: 900,
			digital: { files: [book, extra], retired: [], licenseKeys: true, downloadLimit: 0 },
		});
		const ticket = await shop.ticket(['catalog.edit']);
		await shop.api('POST', `/v1/products/${item.id}/licenses`, { keys: ['K-1', 'K-2', 'K-3'] });
		// keys not given yet go; unknown ones are not counted
		const removed = await shop.admin(ticket, 'POST', `/v1/admin/products/${item.id}/licenses/remove`, {
			keys: ['K-3', 'NOPE'],
		});
		expect(removed.status).toBe(200);
		expect(removed.json).toEqual({ removed: 1, given: 0, available: 2 });
		expect((await shop.api('POST', `/v1/products/${item.id}/licenses/remove`, { keys: [] })).status).toBe(422);
		expect((await shop.api('POST', '/v1/products/prd_nothing/licenses/remove', { keys: ['x'] })).status).toBe(404);

		// a paid order gets a key and both files
		const shopper = await newShopper();
		const placed = await place(shopper, { lines: [{ productId: item.id }], payment: 'online' });
		const id = placed.json.order.id;
		const lineId = placed.json.order.lines[0].id;
		shop.payPayment(await paymentOf(id));
		shop.advance(31_000);
		const paid = await visit('GET', `/v1/shop/orders/${id}`, { signIn: shopper });
		const [given] = paid.json.lines[0].licenseKeys;
		expect(['K-1', 'K-2']).toContain(given);

		// a key given to an order stays with it
		const kept = await shop.api('POST', `/v1/products/${item.id}/licenses/remove`, { keys: [given] });
		expect(kept.json).toEqual({ removed: 0, given: 1, available: 1 });
		shop.advance(1000);

		// a file removed while orders have the product is kept for the orders placed before
		const gone = await shop.admin(ticket, 'DELETE', `/v1/admin/products/${item.id}/files/extra.pdf`);
		expect(gone.status).toBe(200);
		expect(gone.json).toEqual({ files: [{ name: 'book.pdf', type: 'application/pdf', size: 10 }], keptForOrders: true });
		const stored = /** @type {any} */ (
			await (await shop.db()).collection(COLLECTIONS.products).findOne({ websiteId: shop.websiteId, id: item.id })
		);
		expect(stored.digital.files).toEqual([book]);
		expect(stored.digital.retired).toEqual([{ ...extra, removedAt: expect.any(Date) }]);
		expect((await shop.api('DELETE', `/v1/products/${item.id}/files/extra.pdf`)).status).toBe(404);
		const before = await visit('GET', `/v1/shop/orders/${id}`, { signIn: shopper });
		expect(before.json.lines[0].licenseKeys).toEqual([given]);
		expect(before.json.lines[0].downloads.map((/** @type {any} */ file) => file.file)).toEqual(['book.pdf', 'extra.pdf']);
		expect((await visit('GET', `/v1/shop/orders/${id}/downloads/${lineId}/extra.pdf`, { signIn: shopper })).status).toBe(200);

		// an order placed after the removal does not get it
		shop.advance(1000);
		const later = await newShopper();
		const next = await place(later, { lines: [{ productId: item.id }], payment: 'online' });
		shop.payPayment(await paymentOf(next.json.order.id));
		shop.advance(31_000);
		const after = await visit('GET', `/v1/shop/orders/${next.json.order.id}`, { signIn: later });
		expect(after.json.lines[0].downloads.map((/** @type {any} */ file) => file.file)).toEqual(['book.pdf']);
		const refused = await visit('GET', `/v1/shop/orders/${next.json.order.id}/downloads/${after.json.lines[0].id}/extra.pdf`, {
			signIn: later,
		});
		expect(refused.status).toBe(404);

		// uploaded again under its name, it is a file of the product again (the same storage key), for everyone
		await shop.api('POST', `/v1/products/${item.id}/files`, { name: 'extra.pdf', type: 'application/pdf', size: 30 });
		const again = /** @type {any} */ (
			await (await shop.db()).collection(COLLECTIONS.products).findOne({ websiteId: shop.websiteId, id: item.id })
		);
		expect(again.digital.retired).toEqual([]);
		expect(again.digital.files.map((/** @type {any} */ file) => file.key)).toEqual([book.key, extra.key]);
	});

	it('drops a file of a product no order has, and refuses what is not a file of a digital product', async () => {
		const item = await shop.seedProduct({
			kind: 'digital',
			trackStock: false,
			digital: {
				files: [{ key: 'ecommerce/digital/y/a.pdf', type: 'application/pdf', size: 1, alt: 'a.pdf' }],
				retired: [],
				licenseKeys: false,
				downloadLimit: 0,
			},
		});
		const gone = await shop.api('DELETE', `/v1/products/${item.id}/files/a.pdf`);
		expect(gone.json).toEqual({ files: [], keptForOrders: false });
		const stored = /** @type {any} */ (
			await (await shop.db()).collection(COLLECTIONS.products).findOne({ websiteId: shop.websiteId, id: item.id })
		);
		expect(stored.digital).toMatchObject({ files: [], retired: [] });
		expect((await shop.api('DELETE', `/v1/products/prd_nothing/files/a.pdf`)).status).toBe(404);
		const physical = await shop.seedProduct();
		expect((await shop.api('DELETE', `/v1/products/${physical.id}/files/a.pdf`)).status).toBe(422);
		expect((await shop.api('POST', `/v1/products/${physical.id}/licenses/remove`, { keys: ['x'] })).status).toBe(422);
		// a ticket without catalog.edit
		const ticket = await shop.ticket(['orders.read']);
		expect((await shop.admin(ticket, 'DELETE', `/v1/admin/products/${item.id}/files/a.pdf`)).status).toBe(403);
	});
});

describe('free orders', () => {
	it('are paid as they are placed and give their license keys at once', async () => {
		const item = await shop.seedProduct({
			kind: 'digital',
			trackStock: false,
			price: 0,
			digital: { files: [], retired: [], licenseKeys: true, downloadLimit: 0 },
		});
		await shop.api('POST', `/v1/products/${item.id}/licenses`, { keys: ['FREE-1'] });
		const placed = await place(await newShopper(), { lines: [{ productId: item.id }], payment: 'online' });
		expect(placed.status).toBe(201);
		expect(placed.json.next).toEqual({ kind: 'done', url: null });
		expect(placed.json.order).toMatchObject({
			status: 'awaiting_confirmation',
			payment: { state: 'paid' },
			lines: [{ licenseKeys: ['FREE-1'], downloadsLeft: 5 }],
		});
	});

	it('start awaiting payment when the flow starts free orders there, waiting for staff without a time to pay (CK-41)', async () => {
		await shop.flow((flow) => ({ ...flow, starts: { ...flow.starts, free: 'pending_payment' } }));
		const item = await shop.seedProduct({ price: 0, stock: 5 });
		const shopper = await newShopper();
		const sentToPayments = shop.callsTo(PAYMENTS).filter((call) => call.method === 'POST').length;
		const free = await place(shopper, { lines: [{ productId: item.id }], payment: 'bank_transfer', address: ADDRESS });
		expect(free.status).toBe(201);
		expect(free.json.next).toEqual({ kind: 'done', url: null });
		expect(free.json.order).toMatchObject({ status: 'pending_payment', payment: { state: 'paid', payBy: null } });
		const online = await place(shopper, { lines: [{ productId: item.id }], payment: 'online', address: ADDRESS });
		expect(online.json.order).toMatchObject({ status: 'pending_payment', payment: { state: 'paid' } });
		// nothing to pay: no Payments payment, and no window ends it
		expect(shop.callsTo(PAYMENTS).filter((call) => call.method === 'POST')).toHaveLength(sentToPayments);
		const record = /** @type {any} */ (
			await (await shop.db()).collection(COLLECTIONS.orders).findOne({ websiteId: shop.websiteId, id: free.json.order.id })
		);
		expect(record).toMatchObject({ role: 'awaiting_payment', holdUntil: null });
		// cash on delivery keeps its own start
		const cod = await place(shopper, { lines: [{ productId: item.id }], payment: 'cod', address: ADDRESS });
		expect(cod.json.order.status).toBe('awaiting_confirmation');
		await shop.flow((flow) => ({ ...flow, starts: { ...flow.starts, free: 'awaiting_confirmation' } }));
		for (const placed of [free, online, cod]) await shop.api('DELETE', `/v1/orders/${placed.json.order.id}`);
	});
});

describe('a shop with only the catalog and checkout', () => {
	it('prices without zones or taxes, keeps a paid order the flow cannot move, and ends unpaid ones without Payments', async () => {
		const other = await readyShop({ features: ['catalog', 'checkout'] });
		try {
			const config = await other.visitor('GET', '/v1/widget/config');
			expect(config.json.settings.checkout).toMatchObject({
				// today's four methods but pay at pickup, which needs a pickup point
				paymentMethods: [
					{ key: 'online', name: 'Online payment', kind: 'gateway' },
					{ key: 'bank_transfer', name: 'Bank transfer', kind: 'pay_first' },
					{ key: 'cod', name: 'Cash on delivery', kind: 'on_delivery' },
				],
				pickupLocations: [],
				delivery: { cities: [] },
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

			await other.disconnect('payments');
			other.advance(62 * 60_000);
			await other.visitor('POST', '/v1/shop/cart/quote', { body: { lines: [{ productId: item.id }] } });
			expect((await record(unpaid.id)).status).toBe('canceled');
			expect((await record(paid.id)).status).toBe('pending_payment');
			// without Payments only the methods it does not take part in stay
			expect(
				(await other.visitor('GET', '/v1/widget/config')).json.settings.checkout.paymentMethods.map(
					(/** @type {any} */ method) => method.key,
				),
			).toEqual(['cod']);

			await other.switchOn(['catalog']);
			const off = await other.visitor('GET', '/v1/widget/config');
			expect(off.json.settings).not.toHaveProperty('checkout');
		} finally {
			await other.product.close();
		}
	});
});
