/**
 * Returns and warranty claims, reviews, wishlist, alerts, compare, reports and the extras' data rights, through the
 * routes (PLAN 0.8.8). Delivered orders are placed with the ledger and moved to delivered directly, so this part is
 * tested on its own.
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { givePoints, loyaltyAccount, placeOrder } from '../adapters/ledger.js';
import { INDEXES } from '../adapters/product.js';
import { createExtras } from '../server/extras.js';
import { createService } from '../server/service.js';
import { COLLECTIONS } from '../core/model.js';
import { DOMAIN, PAYMENTS, STORAGE, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
/** @type {import('@ss/app-kit').WebsiteData} */
let data;
/** @type {string} */
let ticket;
/** @type {string} */
let sara;
/** @type {string} */
let omar;
const SARA = 'usr_shopper0000001';
const OMAR = 'usr_shopper0000002';
const DAY = 86_400_000;

beforeAll(async () => {
	shop = await readyShop();
	data = await shop.db();
	await data.ensureIndexes(INDEXES);
	ticket = await shop.ticket();
	sara = await shop.signIn();
	omar = await shop.signIn({ id: OMAR, name: 'Omar', email: 'omar@example.com', phone: '' });
});
afterAll(async () => shop.product.close());
// visitor writes are rate limited per minute: each test starts in a fresh minute
beforeEach(async () => {
	shop.advance(61_000);
	data = await shop.db();
	sara = await shop.signIn();
	omar = await shop.signIn({ id: OMAR, name: 'Omar', email: 'omar@example.com', phone: '' });
});

/**
 * @typedef {{ product: import('../core/model.js').ProductRecord, quantity?: number, total?: number, serials?: string[],
 *   cost?: number | null, grade?: string | null, kind?: 'physical' | 'digital' }} LineInput
 */

/**
 * Place an order with the ledger and mark it delivered (unless `delivered: false`).
 * @param {{ userId?: string, lines: LineInput[], payment?: Partial<import('../core/model.js').OrderRecord['payment']>,
 *   delivered?: boolean, pointsEarned?: number, city?: string, placedAt?: number, role?: string, currency?: string }} input
 * @returns {Promise<import('../core/model.js').OrderRecord>}
 */
const order = async ({
	userId = SARA,
	lines,
	payment = {},
	delivered = true,
	pointsEarned = 0,
	city = 'Lahore',
	placedAt = shop.now(),
	role = 'delivered',
	currency = 'USD',
}) => {
	const id = createId('ord');
	const records = lines.map((line) => {
		const quantity = line.quantity ?? 1;
		const variant = /** @type {import('../core/model.js').VariantRecord} */ (line.product.variants[0]);
		return {
			id: createId('oln'),
			productId: line.product.id,
			variantId: variant.id,
			kind: line.kind ?? 'physical',
			name: line.product.name,
			variantName: '',
			sku: '',
			grade: line.grade ?? null,
			gradeLabel: '',
			image: 'ecommerce/products/x/main.jpg',
			unitPrice: variant.price,
			quantity,
			discount: 0,
			tax: 0,
			total: line.total ?? variant.price * quantity,
			cost: line.cost ?? null,
			categoryIds: line.product.categoryIds,
			brandId: line.product.brandId,
			locationId: null,
			serials: line.serials ?? [],
			booking: null,
			licences: [],
			returnedQuantity: 0,
		};
	});
	const total = records.reduce((sum, line) => sum + line.total, 0);
	const placed = await placeOrder(
		data,
		{
			numberPrefix: 'T-',
			order: {
				id,
				customer: {
					userId,
					name: userId === SARA ? 'Sara Shopper' : 'Omar',
					email: userId === SARA ? 'sara@example.com' : 'omar@example.com',
					phone: '',
				},
				address: { name: 'Sara', phone: '', line1: 'x', line2: '', city, area: '', postalCode: '', country: 'PK', notes: '' },
				delivery: { method: 'delivery', zone: '', fee: 0, locationId: null },
				lines: records,
				totals: { subtotal: total, discount: 0, delivery: 0, tax: 0, total, currency, taxIncluded: true },
				promotions: {
					couponId: null,
					couponCode: '',
					dealIds: [],
					bundleIds: [],
					pointsRedeemed: 0,
					pointsValue: 0,
					pointsEarned,
					released: false,
				},
				payment: {
					method: 'cod',
					state: 'unpaid',
					paymentId: null,
					advance: 0,
					paid: 0,
					refunded: 0,
					checkedAt: null,
					...payment,
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
				placedAt: new Date(placedAt),
				deliveredAt: null,
			},
		},
		{ now: shop.now() },
	);
	if (!placed.ok) throw new Error(`not placed: ${placed.code}`);
	if (delivered || role !== 'delivered')
		await data
			.collection(COLLECTIONS.orders)
			.updateOne(
				{ websiteId: data.websiteId, id },
				{ $set: { status: role, role, deliveredAt: delivered ? new Date(shop.now()) : null } },
			);
	return /** @type {any} */ (
		await data.collection(COLLECTIONS.orders).findOne({ websiteId: data.websiteId, id }, { projection: { _id: 0 } })
	);
};

/** @param {string} id */
const productOf = async (id) =>
	/** @type {any} */ (await data.collection(COLLECTIONS.products).findOne({ websiteId: data.websiteId, id }));
/** @param {string} id */
const orderOf = async (id) =>
	/** @type {any} */ (await data.collection(COLLECTIONS.orders).findOne({ websiteId: data.websiteId, id }));

/** Uploaded photos answer HEAD with their type and size; the rest are missing. */
const uploaded = new Set();
const fakeBucket = () =>
	shop.responders.set(STORAGE, (call) => {
		if (call.method !== 'HEAD') return { status: 200, body: {} };
		const known = [...uploaded].some((key) => call.url.includes(key));
		return known
			? { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '1234' } }
			: { status: 404, body: '' };
	});

describe('returns and warranty claims', () => {
	it('a shopper claims a delivered item, staff approve, refund online, restock once and close', async () => {
		fakeBucket();
		const phone = await shop.seedProduct({ name: 'Phone A', stock: 5, price: 1000 });
		const placed = await order({
			lines: [{ product: phone, quantity: 2, serials: ['IMEI-1', 'IMEI-2'] }],
			payment: { method: 'online', state: 'paid', paymentId: 'pay_000000000001', paid: 2000 },
			pointsEarned: 20,
		});
		for (const serial of ['IMEI-1', 'IMEI-2'])
			await data
				.collection(COLLECTIONS.serials)
				.insertOne({ id: createId('ser'), productId: phone.id, serial, status: 'sold', orderId: placed.id, lineId: 'x' });
		await givePoints(
			data,
			{ userId: SARA, points: 20, orderId: placed.id, kind: 'earn', expiresAt: null },
			{ now: shop.now() },
		);
		const lineId = /** @type {string} */ (placed.lines[0]?.id);

		// what can be claimed
		expect((await shop.visitor('GET', `/v1/shop/orders/${placed.id}/returnable`)).status).toBe(403);
		expect((await shop.visitor('GET', `/v1/shop/orders/${placed.id}/returnable`, { signIn: omar })).status).toBe(404);
		const returnable = await shop.visitor('GET', `/v1/shop/orders/${placed.id}/returnable`, { signIn: sara });
		expect(returnable.status).toBe(200);
		expect(returnable.json.lines[0]).toMatchObject({
			lineId,
			claimable: 2,
			return: { days: 7, open: true },
			warranty: { days: 0, open: false, until: null },
		});
		expect(returnable.json.lines[0].image).toContain(STORAGE);

		// photos go straight to the merchant's storage
		const bad = await shop.visitor('POST', '/v1/shop/returns/photos', { signIn: sara, body: { type: 'image/gif', size: 10 } });
		expect(bad.status).toBe(422);
		const photo = await shop.visitor('POST', '/v1/shop/returns/photos', {
			signIn: sara,
			body: { type: 'image/jpeg', size: 1234 },
		});
		expect(photo.status).toBe(201);
		expect(photo.json.key).toMatch(/^ecommerce\/returns\/usr_shopper0000001\/pho_[A-Za-z0-9]+\.jpg$/);
		expect(photo.json.upload).toMatchObject({ method: 'PUT', headers: { 'content-type': 'image/jpeg' } });
		uploaded.add(photo.json.key);

		const claim = (/** @type {Record<string, unknown>} */ body, key = createId('key')) =>
			shop.visitor('POST', '/v1/shop/returns', {
				signIn: sara,
				key,
				body: { orderId: placed.id, kind: 'return', lines: [{ lineId, quantity: 1 }], reason: 'Screen flickers', ...body },
			});
		expect((await claim({ kind: 'warranty' })).json.type.split('/').pop()).toBe('not_returnable');
		expect((await claim({ lines: [{ lineId, quantity: 3 }] })).json.type.split('/').pop()).toBe('not_returnable');
		expect((await claim({ lines: [{ lineId: 'oln_other', quantity: 1 }] })).status).toBe(422);
		expect((await claim({ reason: '' })).status).toBe(422);
		expect((await claim({ orderId: 'ord_missing' })).status).toBe(404);
		expect((await claim({ photos: ['ecommerce/returns/usr_shopper0000001/pho_missing.jpg'] })).json.errors[0].path).toBe(
			'/photos',
		);
		expect((await claim({ photos: ['ecommerce/returns/usr_other/pho_x.jpg'] })).status).toBe(422);
		shop.advance(61_000);
		const made = await claim({ photos: [photo.json.key] });
		expect(made.status).toBe(201);
		expect(made.json).toMatchObject({ orderNumber: placed.number, kind: 'return', status: 'requested', refundAmount: 0 });
		const claimId = made.json.id;
		expect(shop.messages().at(-1)).toMatchObject({
			template: 'ecommerce.return_status',
			to: { email: 'sara@example.com' },
			values: { number: placed.number, status: 'requested', amount: '' },
		});
		const again = await shop.visitor('GET', `/v1/shop/orders/${placed.id}/returnable`, { signIn: sara });
		expect(again.json.lines[0].claimable).toBe(1);
		const mine = await shop.visitor('GET', '/v1/shop/returns?limit=1', { signIn: sara });
		expect(mine.json.items.map((/** @type {any} */ c) => c.id)).toContain(claimId);

		// staff
		const list = await shop.admin(ticket, 'GET', `/v1/admin/returns?status=requested&orderId=${placed.id}&kind=return`);
		expect(list.json.items.map((/** @type {any} */ c) => c.id)).toEqual([claimId]);
		expect((await shop.api('GET', `/v1/returns?userId=${SARA}`)).json.items.length).toBeGreaterThan(0);
		const detail = await shop.admin(ticket, 'GET', `/v1/admin/returns/${claimId}`);
		expect(detail.json).toMatchObject({
			refundable: 1000,
			refundsOnline: true,
			actions: ['approve', 'reject'],
			lines: [{ lineId, quantity: 1, serials: ['IMEI-1'], name: 'Phone A', bought: 2 }],
			order: { number: placed.number, payment: { state: 'paid' } },
		});
		expect(detail.json.photos[0].url).toContain(STORAGE);
		expect((await shop.api('GET', '/v1/returns/ret_missing')).status).toBe(404);
		expect((await shop.admin(ticket, 'POST', `/v1/admin/returns/${claimId}/receive`, {})).json.type.split('/').pop()).toBe(
			'move_not_allowed',
		);
		expect((await shop.admin(ticket, 'POST', `/v1/admin/returns/${claimId}/restock`, {})).json.type.split('/').pop()).toBe(
			'move_not_allowed',
		);
		expect((await shop.admin(ticket, 'POST', `/v1/admin/returns/${claimId}/approve`, { note: 'x'.repeat(1001) })).status).toBe(
			422,
		);
		const approved = await shop.admin(ticket, 'POST', `/v1/admin/returns/${claimId}/approve`, { note: 'Send it back' });
		expect(approved.json).toMatchObject({ status: 'approved' });
		expect(approved.json.history.at(-1)).toMatchObject({ status: 'approved', by: 'Sam Staff', note: 'Send it back' });
		expect((await shop.api('POST', `/v1/returns/${claimId}/receive`, {})).json.status).toBe('received');

		// refund through Payments, within what the line was paid
		expect((await shop.admin(ticket, 'POST', `/v1/admin/returns/${claimId}/refund`, { amount: 1001 })).status).toBe(422);
		expect((await shop.admin(ticket, 'POST', `/v1/admin/returns/${claimId}/refund`, { amount: 600, note: 1 })).status).toBe(
			200,
		);
		const refunds = shop.callsTo(`${PAYMENTS}/v1/payments/pay_000000000001/refunds`);
		expect(refunds).toHaveLength(1);
		expect(JSON.parse(/** @type {any} */ (refunds[0]).body)).toMatchObject({ amount: 600 });
		let stored = await orderOf(placed.id);
		expect(stored.payment).toMatchObject({ refunded: 600, state: 'partially_refunded' });
		expect(stored.lines[0].returnedQuantity).toBe(1);
		expect((await loyaltyAccount(data, SARA, { now: shop.now() })).balance).toBe(10);
		const topUp = await shop.api('POST', `/v1/returns/${claimId}/refund`, { amount: 400 });
		expect(topUp.json).toMatchObject({
			status: 'refunded',
			refundAmount: 1000,
			refundable: 0,
			refundId: expect.stringMatching(/^rfd_/),
		});
		stored = await orderOf(placed.id);
		expect(stored.payment).toMatchObject({ refunded: 1000, state: 'partially_refunded' });
		expect(stored.lines[0].returnedQuantity).toBe(1);
		expect((await loyaltyAccount(data, SARA, { now: shop.now() })).balance).toBe(10);
		expect(shop.messages().at(-1)).toMatchObject({ values: { status: 'refunded', amount: 'USD 10.00' } });
		expect((await shop.api('POST', `/v1/returns/${claimId}/refund`, { amount: 1 })).status).toBe(422);

		// restock exactly once: stock and the serial come back
		const stockBefore = (await productOf(phone.id)).variants[0].stock;
		const restocked = await shop.admin(ticket, 'POST', `/v1/admin/returns/${claimId}/restock`, {});
		expect(restocked.status).toBe(200);
		expect(restocked.json.restockedAt).not.toBeNull();
		expect((await productOf(phone.id)).variants[0].stock).toBe(stockBefore + 1);
		const serial = /** @type {any} */ (
			await data.collection(COLLECTIONS.serials).findOne({ websiteId: data.websiteId, serial: 'IMEI-1' })
		);
		expect(serial.status).toBe('in_stock');
		expect((await shop.api('POST', `/v1/returns/${claimId}/restock`, {})).status).toBe(409);
		expect((await productOf(phone.id)).variants[0].stock).toBe(stockBefore + 1);

		const closed = await shop.api('POST', `/v1/returns/${claimId}/close`, {});
		expect(closed.json).toMatchObject({ status: 'closed', actions: [] });
		expect((await shop.api('POST', `/v1/returns/${claimId}/approve`, {})).status).toBe(409);
	});

	it('records refunds of orders not paid online, rejects with a note and frees rejected units', async () => {
		const item = await shop.seedProduct({ name: 'Charger', price: 500, returnDays: 3 });
		const placed = await order({ userId: OMAR, lines: [{ product: item, quantity: 1 }] });
		const lineId = /** @type {string} */ (placed.lines[0]?.id);
		const body = { orderId: placed.id, kind: 'return', lines: [{ lineId, quantity: 1 }], reason: 'Wrong item' };
		const first = await shop.visitor('POST', '/v1/shop/returns', { signIn: omar, body });
		expect(first.status).toBe(201);
		expect((await shop.visitor('POST', '/v1/shop/returns', { signIn: omar, body })).json.type.split('/').pop()).toBe(
			'not_returnable',
		);
		expect((await shop.api('POST', `/v1/returns/${first.json.id}/reject`, {})).status).toBe(422);
		const rejected = await shop.api('POST', `/v1/returns/${first.json.id}/reject`, { note: 'Used item' });
		expect(rejected.json.status).toBe('rejected');
		expect(shop.messages().at(-1)).toMatchObject({ to: { email: 'omar@example.com' }, values: { status: 'rejected' } });

		const second = await shop.visitor('POST', '/v1/shop/returns', { signIn: omar, body });
		expect(second.status).toBe(201);
		await shop.api('POST', `/v1/returns/${second.json.id}/approve`, {});
		const before = shop.callsTo(PAYMENTS).length;
		const refunded = await shop.api('POST', `/v1/returns/${second.json.id}/refund`, { amount: 500 });
		expect(refunded.json).toMatchObject({ status: 'refunded', refundId: null, refundsOnline: false });
		expect(shop.callsTo(PAYMENTS).length).toBe(before);
		expect((await orderOf(placed.id)).payment).toMatchObject({ refunded: 500, state: 'refunded' });

		// the item's own window has passed
		await data
			.collection(COLLECTIONS.orders)
			.updateOne({ websiteId: data.websiteId, id: placed.id }, { $set: { deliveredAt: new Date(shop.now() - 4 * DAY) } });
		const late = await shop.visitor('GET', `/v1/shop/orders/${placed.id}/returnable`, { signIn: omar });
		expect(late.json.lines[0].return.open).toBe(false);
	});

	it('undoes the claim when Payments refuses, and uses grade windows', async () => {
		await shop.list('grades', [{ key: 'used_a', label: 'Used A', returnDays: 0, warrantyDays: 90 }]);
		const used = await shop.seedProduct({ name: 'Used phone', price: 3000 });
		const placed = await order({
			lines: [{ product: used, grade: 'used_a' }],
			payment: { method: 'online', state: 'paid', paymentId: 'pay_000000000009', paid: 3000 },
		});
		const lineId = /** @type {string} */ (placed.lines[0]?.id);
		const view = await shop.visitor('GET', `/v1/shop/orders/${placed.id}/returnable`, { signIn: sara });
		expect(view.json.lines[0]).toMatchObject({ return: { days: 0, open: false }, warranty: { days: 90, open: true } });
		const body = { orderId: placed.id, kind: 'warranty', lines: [{ lineId, quantity: 1 }], reason: 'Battery' };
		const made = await shop.visitor('POST', '/v1/shop/returns', { signIn: sara, body });
		expect(made.status).toBe(201);
		await shop.api('POST', `/v1/returns/${made.json.id}/approve`, {});
		shop.responders.set(`${PAYMENTS}/v1/payments/pay_000000000009/refunds`, () => ({
			status: 400,
			body: { detail: 'Too late' },
		}));
		const refused = await shop.api('POST', `/v1/returns/${made.json.id}/refund`, { amount: 100 });
		expect(refused.json.type.split('/').pop()).toMatch(/^payments_(refused|unavailable)$/);
		const kept = await shop.api('GET', `/v1/returns/${made.json.id}`);
		expect(kept.json).toMatchObject({ status: 'approved', refundAmount: 0, refundable: 3000 });
		expect(kept.json.history.at(-1).status).toBe('approved');
		// a warranty repair closes without a refund or restock, and frees the unit for another claim
		expect((await shop.api('POST', `/v1/returns/${made.json.id}/close`, { note: 'Repaired' })).json.status).toBe('closed');
		expect((await shop.visitor('POST', '/v1/shop/returns', { signIn: sara, body })).status).toBe(201);
	});

	it('refuses claims on undelivered orders and photo uploads without storage', async () => {
		const item = await shop.seedProduct({ name: 'Case', price: 100 });
		const waiting = await order({ lines: [{ product: item }], delivered: false });
		const body = {
			orderId: waiting.id,
			kind: 'return',
			lines: [{ lineId: /** @type {string} */ (waiting.lines[0]?.id), quantity: 1 }],
			reason: 'Changed mind',
		};
		expect((await shop.visitor('POST', '/v1/shop/returns', { signIn: sara, body })).json.type.split('/').pop()).toBe(
			'not_returnable',
		);
		expect((await shop.visitor('GET', `/v1/shop/orders/${waiting.id}/returnable`, { signIn: sara })).json.lines).toEqual([]);
		await shop.setting('returns', 'maxPhotos', 0);
		expect(
			(await shop.visitor('POST', '/v1/shop/returns/photos', { signIn: sara, body: { type: 'image/png', size: 1 } })).status,
		).toBe(422);
		await shop.setting('returns', 'maxPhotos', 5);
		const cookie = await shop.adminSession();
		await shop.dashboard(cookie, 'DELETE', `/v1/dashboard/websites/${shop.websiteId}/connections/storage`);
		const none = await shop.visitor('POST', '/v1/shop/returns/photos', { signIn: sara, body: { type: 'image/png', size: 1 } });
		expect(none.json.type.split('/').pop()).toBe('storage_not_connected');
		await shop.connectStorage();
	});
});

describe('reviews', () => {
	it('only after delivery, one per product, moderated, keeping the product rating right', async () => {
		const item = await shop.seedProduct({ name: 'Headphones', price: 2000 });
		const write = (/** @type {string} */ who, /** @type {Record<string, unknown>} */ body) =>
			shop.visitor('POST', '/v1/shop/reviews', { signIn: who, body: { productId: item.id, rating: 5, ...body } });
		expect((await write(sara, {})).json.type.split('/').pop()).toBe('review_not_allowed');
		await order({ lines: [{ product: item }], delivered: false });
		expect((await write(sara, {})).json.type.split('/').pop()).toBe('review_not_allowed');
		await order({ lines: [{ product: item }] });
		expect((await write(sara, { rating: 0 })).status).toBe(422);
		expect((await write(sara, { productId: 'prd_missing0000' })).status).toBe(404);
		const first = await write(sara, { title: 'Great', body: 'Clear sound' });
		expect(first.status).toBe(201);
		expect(first.json).toMatchObject({ status: 'pending', name: 'Sara Shopper', rating: 5 });
		expect((await write(sara, { rating: 4 })).json.type.split('/').pop()).toBe('already_reviewed');

		const pub = () => shop.visitor('GET', `/v1/shop/products/${item.id}/reviews`);
		expect((await pub()).json).toMatchObject({ items: [], summary: { count: 0, average: 0 } });
		const pending = await shop.admin(ticket, 'GET', `/v1/admin/reviews?status=pending&productId=${item.id}`);
		expect(pending.json.items.map((/** @type {any} */ r) => r.id)).toEqual([first.json.id]);
		await shop.admin(ticket, 'POST', `/v1/admin/reviews/${first.json.id}/approve`, {});
		await shop.admin(ticket, 'POST', `/v1/admin/reviews/${first.json.id}/approve`, {});
		expect((await productOf(item.id)).rating).toEqual({ average: 5, count: 1 });

		// automatic approval
		await shop.setting('reviews', 'moderation', 'auto');
		await order({ userId: OMAR, lines: [{ product: item }] });
		shop.advance(1000);
		const second = await write(omar, { rating: 2, body: 'Too tight' });
		expect(second.json.status).toBe('approved');
		expect((await productOf(item.id)).rating).toEqual({ average: 3.5, count: 2 });
		await shop.setting('reviews', 'moderation', 'manual');

		const all = await pub();
		expect(all.json.items.map((/** @type {any} */ r) => r.rating)).toEqual([2, 5]);
		expect(all.json.summary).toMatchObject({ average: 3.5, count: 2, stars: { 2: 1, 5: 1 } });
		const highest = await shop.visitor('GET', `/v1/shop/products/${item.id}/reviews?sort=highest&limit=1`);
		expect(highest.json.items.map((/** @type {any} */ r) => r.rating)).toEqual([5]);
		expect(highest.headers.get('link')).toContain('cursor=');
		const next = await shop.visitor(
			'GET',
			`/v1/shop/products/${item.id}/reviews?sort=highest&limit=1&cursor=${highest.json.nextCursor}`,
		);
		expect(next.json.items.map((/** @type {any} */ r) => r.rating)).toEqual([2]);
		const lowest = await shop.visitor('GET', `/v1/shop/products/${item.id}/reviews?sort=lowest`);
		expect(lowest.json.items.map((/** @type {any} */ r) => r.rating)).toEqual([2, 5]);

		const replied = await shop.api('POST', `/v1/reviews/${second.json.id}/reply`, { reply: 'Sorry to hear' });
		expect(replied.json.reply).toBe('Sorry to hear');
		expect((await shop.api('POST', `/v1/reviews/${second.json.id}/reply`, { reply: 'x'.repeat(2001) })).status).toBe(422);
		await shop.api('POST', `/v1/reviews/${second.json.id}/reject`, {});
		expect((await productOf(item.id)).rating).toEqual({ average: 5, count: 1 });
		expect((await shop.api('DELETE', `/v1/reviews/${first.json.id}`)).status).toBe(204);
		expect((await productOf(item.id)).rating).toEqual({ average: 0, count: 0 });
		expect((await shop.api('DELETE', `/v1/reviews/${second.json.id}`)).status).toBe(204);
		expect((await shop.api('DELETE', '/v1/reviews/rev_missing')).status).toBe(404);
		expect((await shop.api('GET', '/v1/reviews')).status).toBe(200);
	});
});

describe('wishlist, alerts and compare', () => {
	it('keeps a wishlist of product cards', async () => {
		const a = await shop.seedProduct({ name: 'Watch', price: 4000 });
		const b = await shop.seedProduct({ name: 'Draft', status: 'draft' });
		expect((await shop.visitor('GET', '/v1/shop/wishlist')).status).toBe(403);
		const added = await shop.visitor('POST', `/v1/shop/wishlist/items/${a.id}`, { signIn: sara });
		expect(added.json.items).toEqual([
			expect.objectContaining({
				id: a.id,
				name: 'Watch',
				price: 4000,
				priceText: 'USD 40.00',
				inStock: true,
				url: `https://${DOMAIN}/products/${a.slug}`,
			}),
		]);
		await shop.visitor('POST', `/v1/shop/wishlist/items/${a.id}`, { signIn: sara });
		expect((await shop.visitor('POST', `/v1/shop/wishlist/items/${b.id}`, { signIn: sara })).status).toBe(404);
		expect((await shop.visitor('POST', '/v1/shop/wishlist/items/nope', { signIn: sara })).status).toBe(404);
		expect((await shop.visitor('GET', '/v1/shop/wishlist', { signIn: sara })).json.items).toHaveLength(1);
		const removed = await shop.visitor('DELETE', `/v1/shop/wishlist/items/${a.id}`, { signIn: sara });
		expect(removed.json.items).toEqual([]);
		await data
			.collection(COLLECTIONS.wishlists)
			.updateOne(
				{ websiteId: data.websiteId, userId: SARA },
				{ $set: { productIds: Array.from({ length: 200 }, (_, i) => `prd_full${i}`) } },
			);
		expect((await shop.visitor('POST', `/v1/shop/wishlist/items/${a.id}`, { signIn: sara })).status).toBe(422);
		await data
			.collection(COLLECTIONS.wishlists)
			.updateOne({ websiteId: data.websiteId, userId: SARA }, { $set: { productIds: [a.id] } });
	});

	it('sends back-in-stock and price-drop alerts once, when the catalog changes', async () => {
		const out = await shop.seedProduct({ name: 'Console', price: 30000, stock: 0 });
		const inStock = await shop.seedProduct({ name: 'Cable', price: 900, stock: 3 });
		const subscribe = (/** @type {string} */ who, /** @type {Record<string, unknown>} */ body) =>
			shop.visitor('POST', '/v1/shop/alerts', { signIn: who, body });
		expect((await subscribe(sara, { kind: 'back_in_stock', productId: inStock.id })).status).toBe(422);
		expect((await subscribe(sara, { kind: 'back_in_stock', productId: 'prd_missing000' })).status).toBe(404);
		expect((await subscribe(sara, { kind: 'nope', productId: out.id })).status).toBe(422);
		expect((await subscribe(sara, { kind: 'price_drop', productId: out.id, variantId: 'var_missing000' })).status).toBe(422);
		const back = await subscribe(sara, { kind: 'back_in_stock', productId: out.id });
		expect(back.status).toBe(201);
		expect(back.json).toMatchObject({ kind: 'back_in_stock', status: 'waiting', price: null, product: { name: 'Console' } });
		expect((await subscribe(sara, { kind: 'back_in_stock', productId: out.id })).status).toBe(200);
		const drop = await subscribe(omar, { kind: 'price_drop', productId: inStock.id });
		expect(drop.json).toMatchObject({ price: 900 });
		const noContact = await shop.signIn({ id: 'usr_shopper0000003', name: 'Nobody', email: '', phone: '' });
		expect((await subscribe(noContact, { kind: 'price_drop', productId: inStock.id })).status).toBe(422);
		expect((await shop.visitor('GET', '/v1/shop/alerts', { signIn: sara })).json.items).toHaveLength(1);

		// a catalog change: the console is back and the cable is cheaper
		const service = createService(shop.product);
		createExtras(shop.product, service);
		/** @type {Array<() => Promise<unknown>>} */
		const later = [];
		const site = await service.site({
			websiteId: shop.websiteId,
			status: { domain: DOMAIN },
			headers: new Headers(),
			after: (/** @type {() => Promise<unknown>} */ task) => later.push(task),
		});
		const products = data.collection(COLLECTIONS.products);
		await products.updateOne({ websiteId: data.websiteId, id: out.id }, { $set: { 'variants.0.stock': 2, inStock: true } });
		await products.updateOne({ websiteId: data.websiteId, id: inStock.id }, { $set: { 'variants.0.price': 700, price: 700 } });
		const sent = shop.messages().length;
		await service.emit('products.changed', site, { productIds: [out.id, inStock.id, 'prd_gone'] });
		const news = shop.messages().slice(sent);
		expect(news.map((m) => m.template).sort()).toEqual(['ecommerce.back_in_stock', 'ecommerce.price_drop']);
		expect(news.find((m) => m.template === 'ecommerce.price_drop')).toMatchObject({
			to: { email: 'omar@example.com' },
			values: { name: 'Cable', price: 'USD 7.00', url: `https://${DOMAIN}/products/${inStock.slug}` },
		});
		await service.emit('products.changed', site, { productIds: [out.id, inStock.id] });
		await service.emit('products.changed', site, {});
		expect(shop.messages().length).toBe(sent + 2);
		expect((await shop.visitor('GET', '/v1/shop/alerts', { signIn: sara })).json.items[0].status).toBe('sent');

		// due alerts left over are sent on a later use; one no longer due waits again; a failed send is marked
		const again = await subscribe(sara, { kind: 'price_drop', productId: inStock.id });
		const third = await subscribe(omar, { kind: 'price_drop', productId: out.id });
		const alerts = data.collection(COLLECTIONS.alerts);
		await alerts.updateOne({ websiteId: data.websiteId, id: again.json.id }, { $set: { dueAt: new Date(shop.now()) } });
		await alerts.updateOne(
			{ websiteId: data.websiteId, id: third.json.id },
			{ $set: { dueAt: new Date(shop.now()), price: 999_999 } },
		);
		shop.responders.set(`https://notifications.example.dev/v1/messages/email`, () => ({ status: 500, body: {} }));
		for (const task of later.splice(0)) await task();
		shop.responders.delete(`https://notifications.example.dev/v1/messages/email`);
		const states = await alerts.find({ websiteId: data.websiteId, id: { $in: [again.json.id, third.json.id] } }).toArray();
		expect(Object.fromEntries(states.map((a) => [a.id, [a.status, a.dueAt]]))).toEqual({
			[again.json.id]: ['waiting', null],
			[third.json.id]: ['failed', null],
		});

		// a restock tells the alerts too (through the shop's own hooks)
		expect((await shop.visitor('DELETE', `/v1/shop/alerts/${again.json.id}`, { signIn: sara })).status).toBe(204);
		expect((await shop.visitor('DELETE', `/v1/shop/alerts/${again.json.id}`, { signIn: sara })).status).toBe(404);
	});

	it('compares products on their comparable attributes', async () => {
		const brand = createId('brd');
		await data.collection(COLLECTIONS.brands).insertOne({ id: brand, slug: 'acme', name: 'Acme', description: '', logo: null });
		await data.collection(COLLECTIONS.attributes).insertMany([
			{ id: 'att_ram', name: 'RAM', type: 'text', choices: [], unit: 'GB', filterable: true, comparable: true, sort: 1 },
			{ id: 'att_sku', name: 'Code', type: 'text', choices: [], unit: '', filterable: false, comparable: false, sort: 0 },
		]);
		const variant = (/** @type {string | null} */ grade) => ({
			id: createId('var'),
			sku: '',
			options: {},
			price: 5000,
			compareAtPrice: 6000,
			cost: null,
			stock: 1,
			locations: {},
			grade,
			active: true,
		});
		const a = await shop.seedProduct({
			name: 'A',
			brandId: brand,
			specs: { att_ram: 8, att_sku: 'x' },
			variants: [variant('used_a')],
		});
		const b = await shop.seedProduct({ name: 'B', specs: { att_ram: 12 } });
		const compared = await shop.visitor('GET', `/v1/shop/compare?ids=${a.id},${b.id},prd_missing00`);
		expect(compared.status).toBe(200);
		expect(compared.json.products).toEqual([
			expect.objectContaining({ id: a.id, brand: 'Acme', grades: ['Used A'], compareAtPrice: 6000 }),
			expect.objectContaining({ id: b.id, brand: null, grades: [] }),
		]);
		expect(compared.json.rows).toEqual([{ attributeId: 'att_ram', name: 'RAM', unit: 'GB', values: [8, 12] }]);
		await shop.setting('compare', 'maxProducts', 2);
		expect((await shop.visitor('GET', `/v1/shop/compare?ids=${a.id},${b.id},prd_x`)).status).toBe(422);
		expect((await shop.visitor('GET', `/v1/shop/compare?ids=${b.id}`)).json.rows).toHaveLength(1);
	});
});

describe('reports', () => {
	it('sales, margin, stock age and return rate over a range', async () => {
		const category = createId('cat');
		await data.collection(COLLECTIONS.categories).insertOne({ id: category, slug: 'tabs', name: 'Tablets' });
		const tab = await shop.seedProduct({ name: 'Tablet', price: 10000, stock: 20, categoryIds: [category] });
		const old = await shop.seedProduct({
			name: 'Old stock',
			price: 100,
			stock: 4,
			publishedAt: new Date(shop.now() - 50 * DAY),
		});
		const from = new Date(shop.now()).toISOString().slice(0, 10);
		const first = await order({ lines: [{ product: tab, quantity: 2, cost: 7000 }], city: ' Karachi ' });
		await order({ userId: OMAR, lines: [{ product: tab, quantity: 1 }], city: 'karachi' });
		await order({ lines: [{ product: tab, quantity: 5 }], role: 'cancelled', delivered: false });
		await order({ lines: [{ product: tab, quantity: 1 }], currency: 'EUR' });
		const claim = await shop.visitor('POST', '/v1/shop/returns', {
			signIn: sara,
			body: { orderId: first.id, kind: 'return', lines: [{ lineId: first.lines[0]?.id, quantity: 1 }], reason: 'Cracked' },
		});
		expect(claim.status).toBe(201);
		const range = `from=${from}&to=${from}`;

		const sales = await shop.admin(ticket, 'GET', `/v1/admin/reports/sales?${range}`);
		expect(sales.status).toBe(200);
		const row = sales.json.rows.find((/** @type {any} */ r) => r.key === tab.id);
		expect(row).toMatchObject({ name: 'Tablet', units: 3, revenue: 30000, discount: 0 });
		expect(sales.json).toMatchObject({ currency: 'USD', by: 'product' });
		expect(sales.json.totals.units).toBeGreaterThanOrEqual(3);
		const byCategory = await shop.api('GET', `/v1/reports/sales?by=category&${range}`);
		expect(byCategory.json.rows.find((/** @type {any} */ r) => r.key === category)).toMatchObject({
			name: 'Tablets',
			units: 3,
		});
		const byCity = await shop.api('GET', `/v1/reports/sales?by=city&${range}`);
		expect(byCity.json.rows.find((/** @type {any} */ r) => r.key === 'karachi')).toMatchObject({ units: 3 });
		const byBrand = await shop.api('GET', `/v1/reports/sales?by=brand&${range}`);
		expect(byBrand.status).toBe(200);
		expect((await shop.api('GET', '/v1/reports/sales?from=2020-01-01&to=2026-01-01')).status).toBe(422);

		const margin = await shop.api('GET', `/v1/reports/margin?${range}`);
		expect(margin.json.rows.find((/** @type {any} */ r) => r.productId === tab.id)).toMatchObject({
			units: 2,
			revenue: 20000,
			cost: 14000,
			margin: 6000,
		});
		expect((await shop.admin(ticket, 'GET', `/v1/admin/reports/margin?${range}`)).status).toBe(200);

		const rate = await shop.api('GET', `/v1/reports/returns?${range}`);
		expect(rate.json.rows.find((/** @type {any} */ r) => r.productId === tab.id)).toMatchObject({
			sold: 3,
			claimed: 1,
			rate: 0.3333,
		});
		expect((await shop.admin(ticket, 'GET', `/v1/admin/reports/returns?from=2020-01-01&to=2020-01-02`)).json.rows).toEqual([]);

		const age = await shop.admin(ticket, 'GET', '/v1/admin/reports/stock-age');
		const oldRow = age.json.rows.find((/** @type {any} */ r) => r.productId === old.id);
		expect(oldRow).toMatchObject({ stock: 4, daysSinceSale: 50, lastSoldAt: null });
		expect(age.json.rows.find((/** @type {any} */ r) => r.productId === tab.id)).toMatchObject({ daysSinceSale: 0 });
		expect((await shop.api('GET', '/v1/reports/stock-age')).status).toBe(200);
	});
});

describe('data rights and widget settings', () => {
	it('exports and deletes a person’s claims, reviews, wishlist and alerts', async () => {
		const exported = await shop.api('POST', '/v1/data-rights/export', { user: { email: 'sara@example.com' } });
		expect(exported.status).toBe(200);
		const records = exported.json.records;
		expect(records.returnClaims.length).toBeGreaterThan(0);
		expect(records.wishlist).toEqual([expect.objectContaining({ userId: SARA })]);
		expect(records.alerts.length).toBeGreaterThan(0);
		expect(records).toHaveProperty('reviews');
		expect((await shop.api('POST', '/v1/data-rights/export', { user: { phone: '+19990000000' } })).json.records).toMatchObject({
			returnClaims: [],
			reviews: [],
			wishlist: [],
			alerts: [],
		});

		// a review to delete, then everything of Omar's
		const item = await shop.seedProduct({ name: 'Lamp' });
		await order({ userId: OMAR, lines: [{ product: item }] });
		await shop.setting('reviews', 'moderation', 'auto');
		await shop.visitor('POST', '/v1/shop/reviews', { signIn: omar, body: { productId: item.id, rating: 4 } });
		expect((await productOf(item.id)).rating.count).toBe(1);
		const removed = await shop.api('POST', '/v1/data-rights/delete', { user: { id: OMAR } });
		expect(removed.json.deleted).toBeGreaterThanOrEqual(2);
		expect(removed.json.anonymised).toBeGreaterThanOrEqual(1);
		expect((await productOf(item.id)).rating).toEqual({ average: 0, count: 0 });
		const left = await data.collection(COLLECTIONS.returns).find({ websiteId: data.websiteId, userId: OMAR }).toArray();
		expect(left).toEqual([]);
		expect((await shop.api('POST', '/v1/data-rights/delete', { user: { phone: '+19990000000' } })).json).toEqual({
			deleted: 0,
			anonymised: 0,
		});

		// Sara's claims with photos: the photos are deleted from storage
		const deleted = await shop.api('POST', '/v1/data-rights/delete', { user: { id: SARA, email: 'sara@example.com' } });
		expect(deleted.json.anonymised).toBeGreaterThan(0);
		expect(shop.callsTo(STORAGE).some((c) => c.method === 'DELETE')).toBe(true);
	});

	it('gives the visitor widgets their settings', async () => {
		const config = await shop.visitor('GET', '/v1/widget/config');
		expect(config.json.settings).toMatchObject({
			returns: { maxPhotos: 5, photoMaxMb: 5 },
			reviews: { moderation: 'auto' },
			wishlist: { max: 200 },
			compare: { max: 2 },
		});
	});
});
