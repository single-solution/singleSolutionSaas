/**
 * The ledger (PLAN 0.8.8): placing an order holds stock, counts offer uses, spends points and books slots in one
 * transaction; giving them back happens exactly once. Runs on the MongoDB replica set (real transactions).
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	givePoints,
	holdStock,
	loyaltyAccount,
	mergeStockLines,
	placeOrder,
	releaseOrder,
	restockClaim,
	returnToOrigin,
	spendPoints,
	takePoints,
} from '../adapters/ledger.js';
import { COLLECTIONS } from '../core/model.js';
import { balanceOf, compactLots, expireLots, spendFromLots, takeFromLots } from '../core/points.js';
import { setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof setup>>} */
let shop;
/** @type {import('@ss/app-kit').WebsiteData} */
let data;

beforeAll(async () => {
	shop = await setup();
	await shop.switchOn(['catalog', 'checkout']);
	await shop.connectDatabase();
	data = await shop.db();
	await data.ensureIndexes((await import('../adapters/product.js')).INDEXES);
});
afterAll(async () => shop.product.close());

/**
 * An order to place.
 * @param {{ productId: string, variantId: string, quantity: number, kind?: 'physical' | 'digital' | 'booking' }[]} lines
 * @param {Partial<import('../core/model.js').OrderRecord['promotions']>} [promotions]
 * @param {string} [key]
 * @returns {import('../adapters/ledger.js').Placement['order']}
 */
const orderOf = (lines, promotions = {}, key = createId('key')) => ({
	id: createId('ord'),
	customer: { userId: 'usr_1', name: 'Sara', email: 'sara@example.com', phone: '' },
	address: null,
	delivery: { method: 'none', zone: '', fee: 0, locationId: null },
	lines: lines.map((line) => ({
		id: createId('oln'),
		productId: line.productId,
		variantId: line.variantId,
		kind: line.kind ?? 'physical',
		name: 'Phone',
		variantName: '',
		sku: '',
		grade: null,
		gradeLabel: '',
		image: null,
		unitPrice: 1000,
		quantity: line.quantity,
		discount: 0,
		tax: 0,
		total: 1000 * line.quantity,
		cost: null,
		categoryIds: [],
		brandId: null,
		locationId: null,
		serials: [],
		booking: null,
		licences: [],
		returnedQuantity: 0,
	})),
	totals: { subtotal: 1000, discount: 0, delivery: 0, tax: 0, total: 1000, currency: 'USD', taxIncluded: true },
	promotions: {
		couponId: null,
		couponCode: '',
		dealIds: [],
		bundleIds: [],
		pointsRedeemed: 0,
		pointsValue: 0,
		pointsEarned: 0,
		released: false,
		...promotions,
	},
	payment: { method: 'cod', state: 'unpaid', paymentId: null, advance: 0, paid: 0, refunded: 0, checkedAt: null },
	status: 'awaiting_confirmation',
	role: 'awaiting_confirmation',
	history: [],
	shipment: null,
	stockHeld: true,
	holdUntil: null,
	idempotencyKey: key,
	note: '',
	staffNote: '',
	placedAt: new Date(shop.now()),
	deliveredAt: null,
});

/** @param {string} id */
const stockOf = async (id) => {
	const product = /** @type {any} */ (await data.collection(COLLECTIONS.products).findOne({ websiteId: data.websiteId, id }));
	return { stock: product.variants[0].stock, inStock: product.inStock, locations: product.variants[0].locations };
};

describe('points', () => {
	const lot = (
		/** @type {number} */ left,
		/** @type {string | null} */ expiresAt,
		/** @type {string | null} */ orderId = null,
	) => ({
		id: createId('lot'),
		points: left,
		left,
		earnedAt: new Date('2026-01-01'),
		expiresAt: expiresAt ? new Date(expiresAt) : null,
		orderId,
	});
	it('expires, spends oldest first, takes back and compacts', () => {
		const lots = [lot(10, '2026-02-01'), lot(5, null), lot(7, '2026-01-15')];
		const { lots: live, expired } = expireLots(lots, Date.parse('2026-01-20'));
		expect(expired).toBe(7);
		expect(balanceOf(live)).toBe(15);
		const spent = spendFromLots(live, 12);
		expect(spent.ok && spent.lots.map((l) => l.left)).toEqual([0, 3, 0]);
		expect(spendFromLots(live, 99).ok).toBe(false);
		expect(spendFromLots(live, -1).ok).toBe(false);
		const taken = takeFromLots([lot(4, null), lot(6, null, 'ord_x')], 8, 'ord_x');
		expect(taken.taken).toBe(8);
		expect(taken.lots.map((l) => l.left)).toEqual([2, 0]);
		const many = Array.from({ length: 60 }, () => lot(0, null));
		expect(compactLots(many)).toHaveLength(50);
		expect(compactLots([lot(1, null)])).toHaveLength(1);
	});
});

describe('placing an order', () => {
	it('holds stock, counts offer uses and spends points in one transaction', async () => {
		const product = await shop.seedProduct({ stock: 3 });
		const variantId = /** @type {string} */ (product.variants[0]?.id);
		const couponId = createId('cpn');
		await data.collection(COLLECTIONS.coupons).insertOne({ id: couponId, code: 'TEN', active: true, limit: 5, used: 0 });
		const dealId = createId('deal');
		await data.collection(COLLECTIONS.deals).insertOne({ id: dealId, active: true, limit: null, used: 0 });
		expect(
			await givePoints(
				data,
				{ userId: 'usr_1', points: 50, orderId: null, kind: 'adjust', expiresAt: null },
				{ now: shop.now() },
			),
		).toBe(true);
		const order = orderOf([{ productId: product.id, variantId, quantity: 2 }], {
			couponId,
			dealIds: [dealId],
			pointsRedeemed: 20,
		});
		const placed = await placeOrder(data, { order, numberPrefix: 'A-', couponPerCustomer: 1 }, { now: shop.now() });
		expect(placed.ok).toBe(true);
		if (!placed.ok) return;
		expect(placed.order.number).toBe('A-2026-000001');
		expect(await stockOf(product.id)).toMatchObject({ stock: 1, inStock: true });
		expect(
			/** @type {any} */ (await data.collection(COLLECTIONS.coupons).findOne({ websiteId: data.websiteId, id: couponId }))
				.used,
		).toBe(1);
		expect((await loyaltyAccount(data, 'usr_1', { now: shop.now() })).balance).toBe(30);

		// the same checkout key returns the same order
		const again = await placeOrder(data, { order: { ...order, id: createId('ord') }, numberPrefix: 'A-' }, { now: shop.now() });
		expect(again.ok && again.duplicate && again.order.id).toBe(placed.order.id);

		// the coupon's per-customer limit: nothing at all is written
		const second = orderOf([{ productId: product.id, variantId, quantity: 1 }], { couponId });
		const refused = await placeOrder(data, { order: second, numberPrefix: 'A-', couponPerCustomer: 1 }, { now: shop.now() });
		expect(refused).toEqual({ ok: false, code: 'offer_unavailable', offerId: couponId });
		expect((await stockOf(product.id)).stock).toBe(1);

		// out of stock: nothing is written either (points stay)
		const third = orderOf([{ productId: product.id, variantId, quantity: 2 }], { pointsRedeemed: 10 });
		expect(await placeOrder(data, { order: third, numberPrefix: 'A-' }, { now: shop.now() })).toMatchObject({
			ok: false,
			code: 'out_of_stock',
		});
		expect((await loyaltyAccount(data, 'usr_1', { now: shop.now() })).balance).toBe(30);

		// too many points
		const fourth = orderOf([{ productId: product.id, variantId, quantity: 1 }], { pointsRedeemed: 999 });
		expect(await placeOrder(data, { order: fourth, numberPrefix: 'A-' }, { now: shop.now() })).toEqual({
			ok: false,
			code: 'points_changed',
		});

		// cancel: everything given back, once
		const cancel = async (/** @type {any} */ session) => {
			const result = await data
				.collection(COLLECTIONS.orders)
				.updateOne(
					{ websiteId: data.websiteId, id: placed.order.id },
					{ $set: { status: 'cancelled', role: 'cancelled' } },
					{ session },
				);
			return result.modifiedCount === 1;
		};
		const stored = /** @type {any} */ (
			await data.collection(COLLECTIONS.orders).findOne({ websiteId: data.websiteId, id: placed.order.id })
		);
		expect(await releaseOrder(data, stored, { now: shop.now(), update: cancel })).toBe(true);
		expect(await releaseOrder(data, stored, { now: shop.now(), update: cancel })).toBe(false);
		expect((await stockOf(product.id)).stock).toBe(3);
		expect(
			/** @type {any} */ (await data.collection(COLLECTIONS.coupons).findOne({ websiteId: data.websiteId, id: couponId }))
				.used,
		).toBe(0);
		expect((await loyaltyAccount(data, 'usr_1', { now: shop.now() })).balance).toBe(50);
	});

	it('takes stock from the first location that has it, books slots once and skips untracked items', async () => {
		const locations = await shop.seedProduct({
			variants: [
				{
					id: createId('var'),
					sku: 'L',
					options: {},
					price: 500,
					compareAtPrice: null,
					cost: null,
					stock: 5,
					locations: { loc_a: 1, loc_b: 4 },
					grade: null,
					active: true,
				},
			],
		});
		const variantId = /** @type {string} */ (locations.variants[0]?.id);
		const order = orderOf([{ productId: locations.id, variantId, quantity: 2 }]);
		const placed = await placeOrder(data, { order, numberPrefix: '', locationOrder: ['loc_a', 'loc_b'] }, { now: shop.now() });
		expect(placed.ok && placed.order.lines[0]?.locationId).toBe('loc_b');
		expect(await stockOf(locations.id)).toMatchObject({ stock: 3, locations: { loc_a: 1, loc_b: 2 } });

		const service = await shop.seedProduct({ kind: 'booking', trackStock: false, stock: 0 });
		const serviceVariant = /** @type {string} */ (service.variants[0]?.id);
		const start = new Date('2026-10-06T09:00:00Z');
		const slot = { productId: service.id, start, end: new Date('2026-10-06T10:00:00Z'), lineId: 'oln_1' };
		const booked = await placeOrder(
			data,
			{
				order: orderOf([{ productId: service.id, variantId: serviceVariant, quantity: 1, kind: 'booking' }]),
				numberPrefix: '',
				slots: [slot],
			},
			{ now: shop.now() },
		);
		expect(booked.ok).toBe(true);
		const twice = await placeOrder(
			data,
			{
				order: orderOf([{ productId: service.id, variantId: serviceVariant, quantity: 1, kind: 'booking' }]),
				numberPrefix: '',
				slots: [slot],
			},
			{ now: shop.now() },
		);
		expect(twice).toEqual({ ok: false, code: 'slot_taken' });

		const untracked = await shop.seedProduct({ trackStock: false, stock: 0 });
		const held = await holdStock(data, [
			{ productId: untracked.id, variantId: /** @type {string} */ (untracked.variants[0]?.id), quantity: 9 },
		]);
		expect(held.ok).toBe(true);
		expect(await holdStock(data, [{ productId: 'prd_missing000000', variantId: 'var_x', quantity: 1 }])).toMatchObject({
			ok: false,
		});
		expect(
			mergeStockLines([
				{ productId: 'p', variantId: 'v', quantity: 1 },
				{ productId: 'p', variantId: 'v', quantity: 2 },
			]),
		).toEqual([{ productId: 'p', variantId: 'v', quantity: 3 }]);
	});

	it('returns to origin and restocks a claim exactly once', async () => {
		const product = await shop.seedProduct({ stock: 2 });
		const variantId = /** @type {string} */ (product.variants[0]?.id);
		const placed = await placeOrder(
			data,
			{ order: orderOf([{ productId: product.id, variantId, quantity: 2 }]), numberPrefix: '' },
			{ now: shop.now() },
		);
		if (!placed.ok) throw new Error('not placed');
		const stored = /** @type {any} */ (
			await data.collection(COLLECTIONS.orders).findOne({ websiteId: data.websiteId, id: placed.order.id })
		);
		const move = async (/** @type {any} */ session) =>
			(
				await data
					.collection(COLLECTIONS.orders)
					.updateOne({ websiteId: data.websiteId, id: stored.id }, { $set: { status: 'returned' } }, { session })
			).modifiedCount === 1;
		expect(await returnToOrigin(data, stored, { update: move })).toBe(true);
		expect(await returnToOrigin(data, stored, { update: move })).toBe(false);
		expect((await stockOf(product.id)).stock).toBe(2);
		const customer = /** @type {any} */ (
			await data.collection(COLLECTIONS.customers).findOne({ websiteId: data.websiteId, userId: 'usr_1' })
		);
		expect(customer.rtoCount).toBe(1);

		const claimId = createId('ret');
		await data.collection(COLLECTIONS.returns).insertOne({ id: claimId, restockedAt: null });
		await data
			.collection(COLLECTIONS.serials)
			.insertOne({ id: createId('ser'), serial: 'IMEI1', status: 'sold', orderId: 'x', lineId: 'y' });
		const lines = [{ productId: product.id, variantId, quantity: 1, locationId: null }];
		expect(await restockClaim(data, { claimId, lines, serials: ['IMEI1'], now: shop.now() })).toBe(true);
		expect(await restockClaim(data, { claimId, lines, serials: ['IMEI1'], now: shop.now() })).toBe(false);
		expect((await stockOf(product.id)).stock).toBe(3);
		const serial = /** @type {any} */ (
			await data.collection(COLLECTIONS.serials).findOne({ websiteId: data.websiteId, serial: 'IMEI1' })
		);
		expect(serial.status).toBe('in_stock');
	});
});

describe('loyalty accounts', () => {
	it('expire on read, spend, take back and never go below 0', async () => {
		const now = shop.now();
		expect((await loyaltyAccount(data, 'usr_2', { now })).balance).toBe(0);
		await givePoints(
			data,
			{ userId: 'usr_2', points: 10, orderId: 'ord_a', kind: 'earn', expiresAt: new Date(now + 1000) },
			{ now },
		);
		await givePoints(data, { userId: 'usr_2', points: 5, orderId: null, kind: 'adjust', expiresAt: null }, { now });
		expect(
			await givePoints(data, { userId: 'usr_2', points: 0, orderId: null, kind: 'adjust', expiresAt: null }, { now }),
		).toBe(true);
		const later = await loyaltyAccount(data, 'usr_2', { now: now + 2000 });
		expect(later.balance).toBe(5);
		expect(later.history.at(-1)).toMatchObject({ kind: 'expire', points: 10 });
		expect(await spendPoints(data, { userId: 'usr_2', points: 0, orderId: 'o' }, { now })).toBe(true);
		expect(await spendPoints(data, { userId: 'usr_2', points: 3, orderId: 'o' }, { now: now + 2000 })).toBe(true);
		expect(await takePoints(data, { userId: 'usr_2', points: 9, orderId: null, kind: 'adjust' }, { now: now + 2000 })).toEqual({
			ok: true,
			taken: 2,
		});
		expect(await takePoints(data, { userId: 'usr_2', points: 9, orderId: null, kind: 'adjust' }, { now: now + 2000 })).toEqual({
			ok: true,
			taken: 0,
		});
	});
});
