/**
 * Moves and refunds when someone else changed the order meanwhile (optimistic concurrency), and the role effects that
 * depend on switched-off features. Calls the moves module directly with an order as read before the other change.
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMoves } from '../server/orders-moves.js';
import { createService } from '../server/service.js';
import { DEFAULT_FLOW } from '../core/flow.js';
import { COLLECTIONS } from '../core/model.js';
import { ALL, DOMAIN, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
/** @type {ReturnType<typeof createService>} */
let service;
/** @type {ReturnType<typeof createMoves>} */
let moves;

beforeAll(async () => {
	shop = await readyShop();
	service = createService(shop.product);
	moves = createMoves(shop.product, service);
});
afterAll(async () => shop.product.close());

const ctx = () => ({
	websiteId: shop.websiteId,
	merchantId: null,
	status: { domain: DOMAIN },
	headers: new Headers(),
	ticket: null,
	after: () => {},
});

/**
 * Seed an order record.
 * @param {Partial<import('../core/model.js').OrderRecord>} [patch]
 * @param {boolean} [serialized]
 * @returns {Promise<import('../core/model.js').OrderRecord>}
 */
const seed = async (patch = {}, serialized = false) => {
	const product = await shop.seedProduct({ stock: 5, serialized });
	const variant = /** @type {import('../core/model.js').VariantRecord} */ (product.variants[0]);
	const data = await shop.db();
	const order = {
		id: createId('ord'),
		number: `M-${createId('num').slice(4, 12)}`,
		customer: { userId: 'usr_moves0000001', name: 'Mo', email: '', phone: '' },
		address: null,
		delivery: { method: 'none', zone: '', fee: 0, locationId: null },
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
				unitPrice: 1000,
				quantity: 1,
				discount: 0,
				tax: 0,
				total: 1000,
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
		},
		payment: { method: 'online', state: 'paid', paymentId: 'pay_moves', advance: 0, paid: 1000, refunded: 0, checkedAt: null },
		status: 'confirmed',
		role: /** @type {const} */ ('open'),
		history: [],
		shipment: null,
		stockHeld: false,
		holdUntil: null,
		idempotencyKey: createId('key'),
		note: '',
		staffNote: '',
		placedAt: new Date(shop.now()),
		deliveredAt: null,
		...patch,
	};
	await data.collection(COLLECTIONS.orders).insertOne({ ...order });
	return /** @type {any} */ (
		await data.collection(COLLECTIONS.orders).findOne({ websiteId: shop.websiteId, id: order.id }, { projection: { _id: 0 } })
	);
};

/**
 * The order as read, then changed by someone else.
 * @param {Partial<import('../core/model.js').OrderRecord>} [patch]
 * @param {boolean} [serialized]
 */
const stale = async (patch, serialized = false) => {
	const order = await seed(patch, serialized);
	shop.advance(1000);
	await (
		await shop.db()
	)
		.collection(COLLECTIONS.orders)
		.updateOne({ websiteId: shop.websiteId, id: order.id }, { $set: { staffNote: 'changed' } });
	return order;
};

/** @param {string} to */
const input = (to) => ({ to, note: '', serials: {}, shipment: null, updatedAt: null });

describe('changed meanwhile', () => {
	it('refuses every kind of move and refund of an order that changed', async () => {
		const s = await service.site(ctx());
		for (const [patch, to] of /** @type {Array<[Partial<import('../core/model.js').OrderRecord>, string]>} */ ([
			[{}, 'packed'],
			[{}, 'delivered'],
			[{}, 'cancelled'],
			[{ status: 'dispatched', role: 'shipped' }, 'returned'],
		])) {
			const order = await stale(patch);
			const refused = moves.move(s, ctx(), order, input(to), DEFAULT_FLOW);
			await expect(refused, to).rejects.toMatchObject({ code: 'conflict' });
		}
		const serialized = await stale({}, true);
		const line = /** @type {import('../core/model.js').OrderLineRecord} */ (serialized.lines[0]);
		await (await shop.db()).collection(COLLECTIONS.serials).insertOne({
			id: createId('ser'),
			productId: line.productId,
			variantId: line.variantId,
			serial: 'S-1',
			status: 'in_stock',
			orderId: null,
			lineId: null,
			locationId: null,
		});
		await expect(
			moves.move(s, ctx(), serialized, { ...input('packed'), serials: { [line.id]: ['S-1'] } }, DEFAULT_FLOW),
		).rejects.toMatchObject({ code: 'conflict' });
		const refunded = await stale({
			status: 'delivered',
			role: 'delivered',
			promotions: {
				couponId: null,
				couponCode: '',
				dealIds: [],
				bundleIds: [],
				pointsRedeemed: 0,
				pointsValue: 0,
				pointsEarned: 5,
				released: false,
			},
		});
		await expect(moves.move(s, ctx(), refunded, input('refunded'), DEFAULT_FLOW)).rejects.toMatchObject({ code: 'conflict' });
		const paid = await seed();
		await (
			await shop.db()
		)
			.collection(COLLECTIONS.orders)
			.updateOne({ websiteId: shop.websiteId, id: paid.id }, { $set: { 'payment.refunded': 100 } });
		await expect(moves.refund(s, ctx(), paid, { amount: 100, reason: 'x' })).rejects.toMatchObject({ code: 'conflict' });
	});
});

describe('switched-off features', () => {
	it('packs serialized items without serials while Grades and serials is off, and earns no points without a user', async () => {
		await shop.switchOn(ALL.filter((feature) => feature !== 'grades_serials'));
		const s = await service.site(ctx());
		const order = await seed({}, true);
		const packed = await moves.move(s, ctx(), order, input('packed'), DEFAULT_FLOW);
		expect(packed.order.role).toBe('packed');
		await shop.switchOn(ALL);
		const anonymous = await seed({ customer: { userId: '', name: '', email: '', phone: '' } });
		const delivered = await moves.move(await service.site(ctx()), ctx(), anonymous, input('delivered'), DEFAULT_FLOW);
		expect(delivered.order.promotions.pointsEarned).toBe(0);
	});
});
