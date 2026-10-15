/**
 * The extras-returns API as `schemas/api.json` describes it (every answer is checked against it by `call()`): the claim
 * list's count and counts with their filters, the staff moves on both the server-token routes and the orders admin
 * widget's ticket twins (replace, repair, reject and close, with the 409 rules of `CLAIM_ACTIONS`), the claim's detail
 * and the shopper's own view, and the alert answers (the same alert set again answers 201 with the waiting one).
 * Delivered orders are placed with the ledger and moved to delivered directly.
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { placeOrder } from '../adapters/ledger.js';
import { INDEXES } from '../adapters/product.js';
import { COLLECTIONS } from '../core/model.js';
import { readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
/** @type {import('@ss/app-kit').WebsiteData} */
let data;
/** @type {string} */
let ticket;
/** @type {string} */
let sara;
const SARA = 'usr_shopper0000001';

beforeAll(async () => {
	shop = await readyShop();
	data = await shop.db();
	await data.ensureIndexes(INDEXES);
	await shop.setting('returns', 'kinds', ['return', 'warranty', 'exchange']);
	await shop.setting('returns', 'warrantyTime', 365);
});
afterAll(async () => shop.product.close());
beforeEach(async () => {
	shop.advance(61_000);
	data = await shop.db();
	sara = await shop.signIn();
	ticket = await shop.ticket();
});

/**
 * Place a paid cash-on-delivery order of one unit of each product for Sara with the ledger and mark it delivered.
 * @param {import('../core/model.js').ProductRecord[]} products
 * @returns {Promise<import('../core/model.js').OrderRecord>}
 */
const delivered = async (products) => {
	const id = createId('ord');
	const lines = products.map((item) => {
		const variant = /** @type {import('../core/model.js').VariantRecord} */ (item.variants[0]);
		return {
			id: createId('oln'),
			productId: item.id,
			variantId: variant.id,
			kind: /** @type {const} */ ('physical'),
			name: item.name,
			variantName: '',
			sku: 'SKU-1',
			grade: null,
			gradeLabel: '',
			image: '',
			unitPrice: variant.price,
			quantity: 1,
			discount: 0,
			tax: 0,
			total: variant.price,
			cost: null,
			categoryIds: [],
			brandId: null,
			locationId: null,
			serials: [],
			booking: null,
			licences: [],
			returnedQuantity: 0,
		};
	});
	const total = lines.reduce((sum, line) => sum + line.total, 0);
	const placed = await placeOrder(
		data,
		{
			numberPrefix: 'A-',
			order: {
				id,
				customer: { userId: SARA, name: 'Sara Shopper', email: 'sara@example.com', phone: '' },
				address: null,
				delivery: { method: 'pickup', zone: '', fee: 0, locationId: null },
				lines,
				totals: { subtotal: total, discount: 0, delivery: 0, tax: 0, total, currency: 'USD', taxIncluded: true },
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
					method: 'cod',
					kind: 'on_delivery',
					state: 'paid',
					paymentId: null,
					advance: 0,
					paid: total,
					refunded: 0,
					checkedAt: null,
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
				placedAt: new Date(shop.now()),
				deliveredAt: null,
			},
		},
		{ now: shop.now() },
	);
	if (!placed.ok) throw new Error(`not placed: ${placed.code}`);
	await data
		.collection(COLLECTIONS.orders)
		.updateOne(
			{ websiteId: data.websiteId, id },
			{ $set: { status: 'delivered', role: 'delivered', deliveredAt: new Date(shop.now()) } },
		);
	return /** @type {any} */ (
		await data.collection(COLLECTIONS.orders).findOne({ websiteId: data.websiteId, id }, { projection: { _id: 0 } })
	);
};

/**
 * Sara claims every line of an order (in a fresh minute: visitor writes are rate limited); the claim's id.
 * @param {import('../core/model.js').OrderRecord} placed
 * @param {'return' | 'warranty' | 'exchange'} kind
 */
const claim = async (placed, kind) => {
	shop.advance(61_000);
	const answer = await shop.visitor('POST', '/v1/shop/returns', {
		signIn: sara,
		key: createId('key'),
		body: { orderId: placed.id, kind, lines: placed.lines.map((line) => ({ lineId: line.id, quantity: 1 })), reason: 'Faulty' },
	});
	expect(answer.status).toBe(201);
	return /** @type {string} */ (answer.json.id);
};

/** @param {{ json: any }} answer */
const codeOf = (answer) => String(answer.json.type).split('/').pop();

describe('claim counts', () => {
	it('count and count by status with the list’s filters, on the server and in the orders admin widget', async () => {
		const placed = await delivered([await shop.seedProduct({ name: 'Kettle', price: 2500 })]);
		const other = await delivered([await shop.seedProduct({ name: 'Toaster', price: 4000 })]);
		const first = await claim(placed, 'return');
		await claim(other, 'warranty');
		expect((await shop.api('POST', `/v1/returns/${first}/approve`, {})).status).toBe(200);

		for (const base of ['/v1/returns', '/v1/admin/returns']) {
			/** @param {string} path */
			const get = (path) => (base === '/v1/returns' ? shop.api('GET', path) : shop.admin(ticket, 'GET', path));
			const all = await get(`${base}/count`);
			expect(all.status).toBe(200);
			expect(all.json.count).toBeGreaterThanOrEqual(2);
			expect(all.json.capped).toBe(false);
			expect((await get(`${base}/count?orderId=${placed.id}`)).json).toEqual({ count: 1, capped: false });
			expect((await get(`${base}/count?kind=warranty&orderId=${other.id}`)).json).toEqual({ count: 1, capped: false });
			expect((await get(`${base}/count?status=approved&orderId=${other.id}`)).json).toEqual({ count: 0, capped: false });
			expect((await get(`${base}/count?userId=usr_nobody000000`)).json).toEqual({ count: 0, capped: false });
			// another status filters nothing
			expect((await get(`${base}/count?status=lost&orderId=${placed.id}`)).json).toEqual({ count: 1, capped: false });

			const counts = await get(`${base}/counts?by=status&userId=${SARA}`);
			expect(counts.status).toBe(200);
			expect(counts.json.groups).toMatchObject({ approved: 1, requested: 1 });
			expect(counts.json.total).toBe(Object.values(counts.json.groups).reduce((sum, n) => Number(sum) + Number(n), 0));
			const wrong = await get(`${base}/counts?by=kind`);
			expect([wrong.status, codeOf(wrong)]).toEqual([422, 'validation_failed']);
		}
	});
});

describe('claim outcomes', () => {
	it('replace an exchange on the server (naming the staff member), repair and reject in the admin widget, as CLAIM_ACTIONS allow', async () => {
		const placed = await delivered([await shop.seedProduct({ name: 'Blender', price: 6000 })]);
		const exchange = await claim(placed, 'exchange');
		// a requested claim cannot be replaced yet; a return-kind claim never
		const early = await shop.api('POST', `/v1/returns/${exchange}/replace`, {});
		expect([early.status, codeOf(early)]).toEqual([409, 'move_not_allowed']);
		const approved = await shop.api('POST', `/v1/returns/${exchange}/approve`, { note: 'Send it back' });
		expect(approved.json).toMatchObject({ status: 'approved', actions: expect.arrayContaining(['replace', 'receive']) });
		expect(approved.json.actions).not.toContain('repair');
		const replaced = await shop.api(
			'POST',
			`/v1/returns/${exchange}/replace`,
			{ note: 'New one sent' },
			{ 'ss-actor-id': 'usr_staff0000009', 'ss-actor-name': encodeURIComponent('Rida Staff') },
		);
		expect(replaced.status).toBe(200);
		expect(replaced.json).toMatchObject({
			id: exchange,
			kind: 'exchange',
			status: 'replaced',
			order: {
				id: placed.id,
				number: placed.number,
				payment: { method: 'cod', state: 'paid', paid: 6000, refunded: 0 },
			},
			refundable: 6000,
			refundsOnline: false,
			refundMethod: null,
			refundId: null,
		});
		expect(replaced.json.history.at(-1)).toMatchObject({ status: 'replaced', by: 'Rida Staff', note: 'New one sent' });
		expect(replaced.json.lines[0]).toMatchObject({ name: 'Blender', sku: 'SKU-1', unitPrice: 6000, bought: 1, total: 6000 });
		// replaced is final: only restock is left
		expect(replaced.json.actions).toEqual(['restock']);
		const again = await shop.api('POST', `/v1/returns/${exchange}/close`, {});
		expect([again.status, codeOf(again)]).toEqual([409, 'move_not_allowed']);

		// a warranty claim is repaired in the admin widget: final, its units can be claimed again
		const second = await delivered([await shop.seedProduct({ name: 'Mixer', price: 3000 })]);
		const warranty = await claim(second, 'warranty');
		expect((await shop.admin(ticket, 'POST', `/v1/admin/returns/${warranty}/approve`, {})).status).toBe(200);
		const repaired = await shop.admin(ticket, 'POST', `/v1/admin/returns/${warranty}/repair`, { note: 'Fixed' });
		expect(repaired.status).toBe(200);
		expect(repaired.json).toMatchObject({ status: 'repaired', actions: [] });
		expect(repaired.json.history.at(-1)).toMatchObject({ status: 'repaired', by: 'Sam Staff', note: 'Fixed' });
		const returnable = await shop.visitor('GET', `/v1/shop/orders/${second.id}/returnable`, { signIn: sara });
		expect(returnable.json.lines[0]).toMatchObject({
			claimable: 1,
			warranty: { time: { amount: 365, unit: 'days' }, open: true },
		});

		// rejecting needs a note for the shopper; an exchange cannot be repaired
		const third = await claim(second, 'exchange');
		const noNote = await shop.admin(ticket, 'POST', `/v1/admin/returns/${third}/reject`, {});
		expect([noNote.status, noNote.json.errors?.[0]?.path]).toEqual([422, '/note']);
		const repair = await shop.admin(ticket, 'POST', `/v1/admin/returns/${third}/repair`, {});
		expect([repair.status, codeOf(repair)]).toEqual([409, 'move_not_allowed']);
		const rejected = await shop.admin(ticket, 'POST', `/v1/admin/returns/${third}/reject`, { note: 'Out of the window' });
		expect(rejected.status).toBe(200);
		expect(rejected.json).toMatchObject({ status: 'rejected', actions: [] });

		// the shopper sees their claims without staff names, notes or photos
		const mine = await shop.visitor('GET', '/v1/shop/returns?limit=2', { signIn: sara });
		expect(mine.json.items).toHaveLength(2);
		expect(mine.json.hasMore).toBe(true);
		expect(mine.json.items[0]).toMatchObject({ id: third, status: 'rejected', orderNumber: second.number });
		expect(mine.json.items[0].history.at(-1)).toEqual({
			at: new Date(shop.now()).toISOString(),
			status: 'rejected',
			note: 'Out of the window',
		});
		expect(Object.keys(mine.json.items[0])).not.toContain('notes');
		const next = await shop.visitor('GET', `/v1/shop/returns?limit=2&cursor=${mine.json.nextCursor}`, { signIn: sara });
		expect(next.json.items.map((/** @type {any} */ item) => item.id)).toContain(exchange);
	});

	it('close a received return in the admin widget, its detail with the order and the claimed lines', async () => {
		const placed = await delivered([await shop.seedProduct({ name: 'Iron', price: 1800 })]);
		const id = await claim(placed, 'return');
		const early = await shop.admin(ticket, 'POST', `/v1/admin/returns/${id}/close`, {});
		expect([early.status, codeOf(early)]).toEqual([409, 'move_not_allowed']);
		expect((await shop.admin(ticket, 'POST', `/v1/admin/returns/${id}/approve`, {})).status).toBe(200);
		const received = await shop.admin(ticket, 'POST', `/v1/admin/returns/${id}/receive`, {
			lines: [{ lineId: placed.lines[0]?.id, restock: false }],
		});
		expect(received.json.lines[0]).toMatchObject({ restock: false, restockedAt: null });
		const closed = await shop.admin(ticket, 'POST', `/v1/admin/returns/${id}/close`, { note: 'Kept by the shop' });
		expect(closed.status).toBe(200);
		expect(closed.json).toMatchObject({ status: 'closed', restockedAt: null, actions: [] });
		const listed = await shop.admin(ticket, 'GET', `/v1/admin/returns?orderId=${placed.id}`);
		expect(listed.json).toMatchObject({ items: [{ id, status: 'closed', userId: SARA }], nextCursor: null, hasMore: false });
		// the list's claims are light: no order, no photo links
		expect(Object.keys(listed.json.items[0])).not.toContain('order');
		const read = await shop.api('GET', `/v1/returns/${id}`);
		expect(read.json.order.customer).toMatchObject({ userId: SARA, name: 'Sara Shopper', email: 'sara@example.com' });
	});
});

describe('alerts', () => {
	it('answer 201 for a new alert and for the same waiting alert set again, and list the shopper’s alerts', async () => {
		const item = await shop.seedProduct({ name: 'Heater', price: 9000, stock: 0 });
		const body = { kind: 'back_in_stock', productId: item.id };
		const first = await shop.visitor('POST', '/v1/shop/alerts', { signIn: sara, body, key: createId('key') });
		expect(first.status).toBe(201);
		expect(first.json).toMatchObject({
			kind: 'back_in_stock',
			productId: item.id,
			variantId: null,
			price: null,
			targetPrice: null,
			status: 'waiting',
			product: { id: item.id, name: 'Heater', inStock: false },
		});
		shop.advance(61_000);
		const again = await shop.visitor('POST', '/v1/shop/alerts', { signIn: sara, body, key: createId('key') });
		expect([again.status, again.json.id]).toEqual([201, first.json.id]);
		const listed = await shop.visitor('GET', '/v1/shop/alerts', { signIn: sara });
		expect(listed.json.items.filter((/** @type {any} */ alert) => alert.id === first.json.id)).toHaveLength(1);
		const signedOut = await shop.visitor('GET', '/v1/shop/alerts');
		expect([signedOut.status, codeOf(signedOut)]).toEqual([403, 'sign_in_required']);
		expect((await shop.visitor('DELETE', `/v1/shop/alerts/${first.json.id}`, { signIn: sara })).status).toBe(204);
	});
});
