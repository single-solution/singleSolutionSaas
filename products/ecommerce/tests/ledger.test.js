/**
 * The ledger (PLAN 0.8.8): placing an order holds stock, counts offer uses, spends points and books slots in one
 * transaction; giving them back (a transition the order engine plans, applied with `applyTransition`) happens exactly
 * once. Runs on the MongoDB replica set (real transactions).
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	applyTransition,
	givePoints,
	holdStock,
	loyaltyAccount,
	mergeStockLines,
	placeOrder,
	restockClaimLines,
	spendPoints,
	swapOrderStock,
	takePoints,
} from '../adapters/ledger.js';
import { DEFAULT_FLOW } from '../core/flow.js';
import { COLLECTIONS } from '../core/model.js';
import { planTransition } from '../core/transitions.js';
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

/** The customer record of the test orders (checkout always gives an order one, K-6). */
const CUSTOMER_ID = createId('cus');

/**
 * An order to place.
 * @param {{ productId: string, variantId: string, quantity: number, kind?: 'physical' | 'digital' | 'service' }[]} lines
 * @param {Partial<import('../core/model.js').OrderRecord['promotions']>} [promotions]
 * @param {string} [key]
 * @returns {import('../adapters/ledger.js').Placement['order']}
 */
const orderOf = (lines, promotions = {}, key = createId('key')) => ({
	id: createId('ord'),
	customer: { userId: 'usr_1', name: 'Sara', email: 'sara@example.com', phone: '', customerId: CUSTOMER_ID },
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

/**
 * Apply the transition the order engine plans for an order as read (a staff move of the default flow), once per call.
 * @param {any} order as read @param {string} to
 */
const transition = async (order, to) => {
	const planned = planTransition({
		order,
		flow: DEFAULT_FLOW,
		to,
		input: { who: 'staff', actor: { kind: 'server', id: 'server', name: 'Server' }, by: 'Server', note: '' },
		rules: { paymentWindowMinutes: 0, paidOnDelivery: true, loyalty: null, timeZone: 'UTC' },
		now: shop.now(),
	});
	if (!planned.ok) throw new Error(planned.message);
	const { plan } = planned;
	return applyTransition(
		data,
		{ orderId: order.id, guard: plan.guard, update: { $set: plan.set, $push: plan.push }, effects: plan.ledger },
		{ now: shop.now() },
	);
};

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
		expect(placed.order.number).toBe('A-000001');
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
		const stored = /** @type {any} */ (
			await data.collection(COLLECTIONS.orders).findOne({ websiteId: data.websiteId, id: placed.order.id })
		);
		expect(await transition(stored, 'cancelled')).toBe(true);
		expect(await transition(stored, 'cancelled')).toBe(false);
		expect((await stockOf(product.id)).stock).toBe(3);
		expect(
			/** @type {any} */ (await data.collection(COLLECTIONS.coupons).findOne({ websiteId: data.websiteId, id: couponId }))
				.used,
		).toBe(0);
		expect((await loyaltyAccount(data, 'usr_1', { now: shop.now() })).balance).toBe(50);
	});

	it('counts a customer’s coupon uses after a cancel gave one back (the next use is numbered after the highest)', async () => {
		const product = await shop.seedProduct({ stock: 10 });
		const variantId = /** @type {string} */ (product.variants[0]?.id);
		const couponId = createId('cpn');
		await data.collection(COLLECTIONS.coupons).insertOne({ id: couponId, code: 'AGAIN', active: true, limit: null, used: 0 });
		/** @returns {Promise<any>} */
		const place = async (perCustomer = /** @type {number | undefined} */ (undefined)) => {
			const placed = await placeOrder(
				data,
				{
					order: orderOf([{ productId: product.id, variantId, quantity: 1 }], { couponId }),
					numberPrefix: 'C-',
					...(perCustomer ? { couponPerCustomer: perCustomer } : {}),
				},
				{ now: shop.now() },
			);
			return placed;
		};
		const first = await place();
		const second = await place();
		expect(first.ok && second.ok).toBe(true);
		// the first is canceled: its use goes back, the second's stays (uses 2 of the customer: numbers 1 and 2 → 2)
		const stored = await data.collection(COLLECTIONS.orders).findOne({ websiteId: data.websiteId, id: first.order.id });
		expect(await transition(stored, 'cancelled')).toBe(true);
		// a third order with the same coupon is placed (it used to take number 2 again and be refused)
		const third = await place();
		expect(third).toMatchObject({ ok: true });
		const uses = await data
			.collection(COLLECTIONS.couponUses)
			.find({ websiteId: data.websiteId, couponId }, { projection: { _id: 0, seq: 1 } })
			.toArray();
		expect(uses.map((use) => use.seq).sort()).toEqual([2, 3]);
		// the per-customer limit still counts the uses kept
		expect(await place(2)).toMatchObject({ ok: false, code: 'offer_unavailable' });
		expect(await place(3)).toMatchObject({ ok: true });
	});

	it('numbers orders in the form given: a running counter, or a year’s that starts after the highest number of its form', async () => {
		const product = await shop.seedProduct({ stock: 5 });
		const variantId = /** @type {string} */ (product.variants[0]?.id);
		const place = (/** @type {Record<string, string>} */ form) =>
			placeOrder(
				data,
				{ order: orderOf([{ productId: product.id, variantId, quantity: 1 }]), ...form, numberPrefix: 'N-' },
				{ now: shop.now() },
			);
		await data
			.collection(COLLECTIONS.orders)
			.insertOne({ websiteId: data.websiteId, id: createId('ord'), number: 'N-2026-000041', customer: {} });
		const yearly = await place({ numberPattern: '{prefix}{year}-{number}' });
		expect(yearly.ok && yearly.order.number).toBe('N-2026-000042');
		const running = await place({});
		expect(running.ok && running.order.number).toBe('N-000001');
		expect(
			(
				await data
					.collection(COLLECTIONS.counters)
					.find({ websiteId: data.websiteId, id: { $regex: '^orders-N-' } })
					.toArray()
			)
				.map((counter) => [counter.id, counter.seq])
				.sort(),
		).toEqual([
			['orders-N-2026', 42],
			['orders-N-:', 1],
		]);
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

		const service = await shop.seedProduct({ kind: 'service', trackStock: false, stock: 0 });
		const serviceVariant = /** @type {string} */ (service.variants[0]?.id);
		const start = new Date('2026-10-06T09:00:00Z');
		const slot = { productId: service.id, start, end: new Date('2026-10-06T10:00:00Z'), lineId: 'oln_1' };
		const booked = await placeOrder(
			data,
			{
				order: orderOf([{ productId: service.id, variantId: serviceVariant, quantity: 1, kind: 'service' }]),
				numberPrefix: '',
				slots: [slot],
			},
			{ now: shop.now() },
		);
		expect(booked.ok).toBe(true);
		const twice = await placeOrder(
			data,
			{
				order: orderOf([{ productId: service.id, variantId: serviceVariant, quantity: 1, kind: 'service' }]),
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
		expect(held).toMatchObject({ ok: true, taken: [{ quantity: 9, left: null }] });
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

	it('reports the stock an order takes: placed, and edited to more units (the stock events)', async () => {
		const product = await shop.seedProduct({ stock: 6 });
		const variantId = /** @type {string} */ (product.variants[0]?.id);
		const placed = await placeOrder(
			data,
			{ order: orderOf([{ productId: product.id, variantId, quantity: 2 }]), numberPrefix: '' },
			{ now: shop.now() },
		);
		if (!placed.ok) throw new Error('not placed');
		expect(placed.taken).toEqual([{ productId: product.id, variantId, quantity: 2, left: 4 }]);
		const order = /** @type {any} */ (
			await data.collection(COLLECTIONS.orders).findOne({ websiteId: data.websiteId, id: placed.order.id })
		);
		const edit = (/** @type {number} */ quantity, /** @type {any} */ current) =>
			swapOrderStock(data, current, {
				lines: [{ productId: product.id, variantId, quantity }],
				ordered: [{ productId: product.id, quantity }],
				update: async (session) =>
					(
						await data
							.collection(COLLECTIONS.orders)
							.updateOne(
								{ websiteId: data.websiteId, id: current.id },
								{ $set: { 'lines.0.quantity': quantity } },
								{ session },
							)
					).modifiedCount === 1,
			});
		// 2 → 5 units: the variant lost 3 more
		expect(await edit(5, order)).toEqual({ ok: true, taken: [{ productId: product.id, variantId, quantity: 3, left: 1 }] });
		const edited = /** @type {any} */ (
			await data.collection(COLLECTIONS.orders).findOne({ websiteId: data.websiteId, id: order.id })
		);
		// 5 → 4 units: the variant got one back, nothing was taken
		expect(await edit(4, edited)).toEqual({ ok: true, taken: [] });
		expect((await stockOf(product.id)).stock).toBe(2);
		// the units ordered follow the edit (P3-10)
		expect((await data.collection(COLLECTIONS.products).findOne({ websiteId: data.websiteId, id: product.id }))?.ordered).toBe(
			4,
		);
	});

	it('returns to origin and restocks a claim exactly once', async () => {
		await data.collection(COLLECTIONS.customers).insertOne({ id: CUSTOMER_ID, userId: 'usr_1', rtoCount: 0 });
		const product = await shop.seedProduct({ stock: 2 });
		const variantId = /** @type {string} */ (product.variants[0]?.id);
		const placed = await placeOrder(
			data,
			{ order: orderOf([{ productId: product.id, variantId, quantity: 2 }]), numberPrefix: '' },
			{ now: shop.now() },
		);
		if (!placed.ok) throw new Error('not placed');
		// the package was dispatched, then comes back
		await data
			.collection(COLLECTIONS.orders)
			.updateOne({ websiteId: data.websiteId, id: placed.order.id }, { $set: { status: 'dispatched', role: 'shipped' } });
		const stored = /** @type {any} */ (
			await data.collection(COLLECTIONS.orders).findOne({ websiteId: data.websiteId, id: placed.order.id })
		);
		expect(await transition(stored, 'returned')).toBe(true);
		expect(await transition(stored, 'returned')).toBe(false);
		expect((await stockOf(product.id)).stock).toBe(2);
		const customer = /** @type {any} */ (
			await data.collection(COLLECTIONS.customers).findOne({ websiteId: data.websiteId, id: CUSTOMER_ID })
		);
		expect(customer.rtoCount).toBe(1);

		const claimId = createId('ret');
		await data
			.collection(COLLECTIONS.returns)
			.insertOne({ id: claimId, restockedAt: null, lines: [{ lineId: 'oln_1', quantity: 1, restockedAt: null }] });
		await data
			.collection(COLLECTIONS.serials)
			.insertOne({ id: createId('ser'), serial: 'SN1', status: 'sold', orderId: 'x', lineId: 'y' });
		const lines = [{ productId: product.id, variantId, quantity: 1, locationId: null, lineId: 'oln_1', serials: ['SN1'] }];
		// each line exactly once, and the claim is restocked once every line is
		expect(await restockClaimLines(data, { claimId, lines, now: shop.now() })).toEqual(['oln_1']);
		expect(await restockClaimLines(data, { claimId, lines, now: shop.now() })).toEqual([]);
		expect((await stockOf(product.id)).stock).toBe(3);
		const serial = /** @type {any} */ (
			await data.collection(COLLECTIONS.serials).findOne({ websiteId: data.websiteId, serial: 'SN1' })
		);
		expect(serial.status).toBe('in_stock');
		const claim = /** @type {any} */ (
			await data.collection(COLLECTIONS.returns).findOne({ websiteId: data.websiteId, id: claimId })
		);
		expect(claim.restockedAt).toBeInstanceOf(Date);
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
