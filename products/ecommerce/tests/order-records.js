/**
 * Orders written straight into a test shop's database, for the order engine's tests (`transitions*.test.js`, the money
 * tests): an order in the shape checkout writes (or delivered with earned points and an approved return claim), its
 * record, claim and product's stock read back, a move through the API, and Payments' refunds answered as a test says.
 */
import { createId } from '@ss/contracts';
import { givePoints } from '../adapters/ledger.js';
import { COLLECTIONS } from '../core/model.js';
import { PAYMENTS, storedOrder } from './helpers.js';

/**
 * @param {Awaited<ReturnType<typeof import('./helpers.js').readyShop>>} shop
 */
export const orderRecords = (shop) => {
	const orders = async () => (await shop.db()).collection(COLLECTIONS.orders);
	/** @param {string} id @returns {Promise<any>} */
	const recordOf = async (id) => (await orders()).findOne({ websiteId: shop.websiteId, id }, { projection: { _id: 0 } });
	/** @param {string} id */
	const stockOf = async (id) =>
		/** @type {any} */ (await (await shop.db()).collection(COLLECTIONS.products).findOne({ websiteId: shop.websiteId, id }))
			.variants[0].stock;

	/**
	 * An order record in the shape checkout writes: one physical line of a new product, paid online (with its Payments
	 * entry) unless `cod`, with the facts its flags give unless `patch` gives them (`storedOrder` of `./helpers.js`).
	 * @param {{ status?: string, role?: string, cod?: boolean, quantity?: number, stock?: number, typeKey?: string,
	 *   patch?: Record<string, any> }} [options] `typeKey`: the product's item type (`UNIT_TYPES` of `./helpers.js`)
	 */
	const seedOrder = async ({
		status = 'confirmed',
		role = 'open',
		cod = false,
		quantity = 1,
		stock = 5,
		typeKey,
		patch = {},
	} = {}) => {
		const product = await shop.seedProduct({ price: 1000, stock, ...(typeKey ? { typeKey } : {}) });
		const variant = /** @type {any} */ (product.variants[0]);
		const id = createId('ord');
		const paymentId = `pay_${id.slice(4, 16)}`;
		const total = 1000 * quantity;
		const record = storedOrder({
			id,
			number: `T-${createId('num').slice(4, 14)}`,
			customer: { userId: 'usr_engine000001', name: 'Eve', email: '', phone: '', customerId: 'cus_engine000001' },
			address: null,
			delivery: { method: 'none', zone: '', rate: '', rateName: '', fee: 0, locationId: null },
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
					quantity,
					discount: 0,
					tax: 0,
					total,
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
			totals: { subtotal: total, discount: 0, delivery: 0, tax: 0, total, currency: 'USD', taxIncluded: true },
			promotions: {
				couponId: null,
				couponCode: '',
				dealIds: [],
				bundleIds: [],
				pointsRedeemed: 0,
				pointsValue: 0,
				pointsEarned: 0,
				pointsFixed: false,
				pointsCredited: false,
				released: false,
			},
			payment: cod
				? {
						method: 'cod',
						kind: 'on_delivery',
						state: 'unpaid',
						paymentId: null,
						advance: 0,
						paid: 0,
						refunded: 0,
						checkedAt: null,
					}
				: {
						method: 'online',
						kind: 'gateway',
						state: 'paid',
						paymentId,
						advance: 0,
						paid: total,
						refunded: 0,
						checkedAt: null,
					},
			payments: cod
				? []
				: [
						{
							id: createId('opy'),
							method: 'payments',
							amount: total,
							reference: paymentId,
							proofKey: null,
							note: '',
							by: { kind: 'system', id: 'payments', name: 'Payments' },
							at: new Date(shop.now()),
						},
					],
			refunds: [],
			status,
			role,
			history: [{ at: new Date(shop.now()), from: null, to: status, by: 'shopper', note: '' }],
			shipment: null,
			media: [],
			// the stock it holds was taken from the product
			stockHeld: true,
			holdUntil: null,
			idempotencyKey: createId('key'),
			note: '',
			staffNote: '',
			placedAt: new Date(shop.now()),
			deliveredAt: null,
			...patch,
		});
		if (record.stockHeld)
			await (
				await shop.db()
			)
				.collection(COLLECTIONS.products)
				.updateOne(
					{ websiteId: shop.websiteId, id: product.id, 'variants.id': variant.id },
					{ $inc: { 'variants.$.stock': -quantity } },
				);
		await (await orders()).insertOne({ ...record });
		return { order: await recordOf(id), product, paymentId };
	};

	/** The facts and dates of a delivered order (paid, its stock sold). */
	const delivered = () => ({
		facts: { stock: 'sold', offers: 'counted', redeemed: 'spent', earned: 'none', units: 'none' },
		deliveredAt: new Date(shop.now()),
	});

	/**
	 * A delivered order paid online (1000) that earned 20 points (credited to its member), with an approved return claim
	 * of its one unit.
	 * @param {{ role?: string }} [options] `role`: the step the order is in (as the flow had it)
	 */
	const seedClaimed = async ({ role = 'delivered' } = {}) => {
		const { order, paymentId } = await seedOrder({
			status: 'delivered',
			role,
			patch: {
				...delivered(),
				facts: { stock: 'sold', offers: 'counted', redeemed: 'spent', earned: 'credited', units: 'none' },
				promotions: {
					couponId: null,
					couponCode: '',
					dealIds: [],
					bundleIds: [],
					pointsRedeemed: 0,
					pointsValue: 0,
					pointsEarned: 20,
					pointsFixed: true,
					pointsCredited: true,
					released: false,
				},
			},
		});
		const data = await shop.db();
		await givePoints(
			data,
			{ userId: order.customer.userId, points: 20, orderId: order.id, kind: 'earn', expiresAt: null },
			{ now: shop.now() },
		);
		const claimId = createId('ret');
		await data.collection(COLLECTIONS.returns).insertOne({
			id: claimId,
			orderId: order.id,
			orderNumber: order.number,
			userId: order.customer.userId,
			kind: 'return',
			window: 'return',
			outcomes: ['refund'],
			lines: [{ lineId: order.lines[0].id, quantity: 1, serials: [] }],
			reason: 'Broken',
			photos: [],
			status: 'approved',
			role: 'approved',
			refundAmount: 0,
			refundId: null,
			restockedAt: null,
			history: [],
			notes: [],
		});
		return { order, paymentId, claimId };
	};

	/** @param {string} id */
	const claimOf = async (id) =>
		/** @type {any} */ (
			await (
				await shop.db()
			)
				.collection(COLLECTIONS.returns)
				.findOne({ websiteId: shop.websiteId, id }, { projection: { _id: 0 } })
		);

	/** @param {string} id @param {string} to @param {Record<string, unknown>} [extra] */
	const moveTo = (id, to, extra = {}) => shop.api('POST', `/v1/orders/${id}/move`, { to, ...extra });

	/**
	 * Answer Payments' refunds (of one payment, or all) with this until the returned function restores the normal answers.
	 * @param {{ status: number, type?: string, body?: unknown }} answer @param {string} [paymentId]
	 */
	const refundsAnswer = (answer, paymentId) => {
		const normal = /** @type {any} */ (shop.responders.get(PAYMENTS));
		shop.responders.set(PAYMENTS, (call) =>
			call.path.endsWith('/refunds') && (!paymentId || call.path.includes(`/${paymentId}/`)) ? answer : normal(call),
		);
		return () => shop.responders.set(PAYMENTS, normal);
	};

	/** Payments' refund calls of a payment. @param {string} paymentId */
	const refundCalls = (paymentId) => shop.callsTo(`${PAYMENTS}/v1/payments/${paymentId}/refunds`);

	return { orders, recordOf, stockOf, seedOrder, delivered, seedClaimed, claimOf, moveTo, refundsAnswer, refundCalls };
};
