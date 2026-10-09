/**
 * Orders for the merchant (PLAN 0.8.8): the staff list and detail, moves through the flow with their role effects
 * (serials when packed, couriers when shipped, cash and points when delivered, give-backs and refunds when cancelled,
 * returned or refunded), refunds without a move, edits, bulk moves and the data-rights answers. Orders are placed with
 * the ledger directly, so this part is tested on its own.
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { placeOrder } from '../adapters/ledger.js';
import { createOrders } from '../server/orders.js';
import { createService } from '../server/service.js';
import { COLLECTIONS } from '../core/model.js';
import { ALL_PERMISSIONS, DOMAIN, PAYMENTS, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
/** @type {import('@ss/app-kit').WebsiteData} */
let data;
/** @type {string} */
let ticket;

beforeAll(async () => {
	shop = await readyShop();
	data = await shop.db();
	await data.ensureIndexes((await import('../adapters/product.js')).INDEXES);
	ticket = await shop.ticket();
	await shop.list('couriers', [
		{ key: 'swift', name: 'Swift Post', trackingUrl: 'https://track.example.org/t?n={tracking}' },
		{ key: 'hand', name: 'By hand', trackingUrl: '' },
	]);
});
afterAll(async () => shop.product.close());

const ADDRESS = {
	name: 'Sara Shopper',
	phone: '+15550001111',
	line1: '1 Main Street',
	line2: '',
	city: 'Springfield',
	area: 'North',
	postalCode: '12345',
	country: 'US',
	notes: '',
};

/**
 * Place an order with the ledger (stock is held as at checkout).
 * @param {{ price?: number, quantity?: number, stock?: number, method?: 'cod' | 'online' | 'bank_transfer' | 'pickup',
 *   paid?: boolean, status?: string, role?: import('../core/model.js').StatusRole, serialized?: boolean,
 *   address?: typeof ADDRESS | null, userId?: string, name?: string, email?: string, phone?: string,
 *   promotions?: Partial<import('../core/model.js').OrderRecord['promotions']>, advance?: number }} [options]
 */
const place = async (options = {}) => {
	const {
		price = 1000,
		quantity = 1,
		stock = 10,
		method = 'cod',
		paid = false,
		serialized = false,
		address = ADDRESS,
		userId = 'usr_shopper0000001',
		name = 'Sara Shopper',
		email = 'sara@example.com',
		phone = '+15550001111',
		advance = 0,
	} = options;
	const product = await shop.seedProduct({ stock, price, serialized, sku: 'SKU-1', media: [] });
	const variant = /** @type {import('../core/model.js').VariantRecord} */ (product.variants[0]);
	const total = price * quantity;
	const waiting = method === 'cod' || method === 'pickup';
	const status = options.status ?? (paid ? 'confirmed' : waiting ? 'awaiting_confirmation' : 'pending_payment');
	const role = options.role ?? (paid ? 'open' : waiting ? 'awaiting_confirmation' : 'awaiting_payment');
	const placed = await placeOrder(
		data,
		{
			numberPrefix: 'T-',
			order: {
				id: createId('ord'),
				customer: { userId, name, email, phone },
				address,
				delivery: { method: address ? 'delivery' : 'pickup', zone: '', fee: 0, locationId: null },
				lines: [
					{
						id: createId('oln'),
						productId: product.id,
						variantId: variant.id,
						kind: 'physical',
						name: 'Phone',
						variantName: 'Black',
						sku: 'SKU-1',
						grade: null,
						gradeLabel: '',
						image: null,
						unitPrice: price,
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
					released: false,
					...options.promotions,
				},
				payment: {
					method,
					state: paid ? 'paid' : 'unpaid',
					paymentId: paid || advance > 0 ? createId('pay') : null,
					advance,
					paid: paid ? total : advance,
					refunded: 0,
					checkedAt: null,
				},
				status,
				role,
				history: [{ at: new Date(shop.now()), from: null, to: status, by: 'Sara Shopper', note: '' }],
				shipment: null,
				stockHeld: true,
				holdUntil: null,
				idempotencyKey: createId('key'),
				note: 'Ring twice',
				staffNote: '',
				placedAt: new Date(shop.now()),
				deliveredAt: null,
			},
		},
		{ now: shop.now() },
	);
	if (!placed.ok) throw new Error(placed.code);
	shop.advance(1000);
	return { order: placed.order, product, variant };
};

/** @param {string} id */
const orderRecord = async (id) =>
	/** @type {import('../core/model.js').OrderRecord} */ (
		await data.collection(COLLECTIONS.orders).findOne({ websiteId: data.websiteId, id }, { projection: { _id: 0 } })
	);

/** @param {string} id */
const stockOf = async (id) => {
	const product = /** @type {any} */ (await data.collection(COLLECTIONS.products).findOne({ websiteId: data.websiteId, id }));
	return { stock: product.variants[0].stock, sold: product.sold };
};

/** @param {string} id @param {string} to @param {Record<string, unknown>} [extra] */
const move = (id, to, extra = {}) => shop.admin(ticket, 'POST', `/v1/admin/orders/${id}/move`, { to, ...extra });

describe('the order list and detail', () => {
	it('filters, searches and pages orders for staff and the server', async () => {
		const a = await place({ name: 'Zed Zebra', phone: '+15559990000', email: 'zed@example.com' });
		const b = await place({ method: 'online', paid: true, address: { ...ADDRESS, city: 'Shelbyville' } });
		const list = await shop.admin(ticket, 'GET', '/v1/admin/orders?limit=1');
		expect(list.status).toBe(200);
		expect(list.json.items).toHaveLength(1);
		expect(list.json.items[0].id).toBe(b.order.id);
		expect(list.json.items[0]).toMatchObject({ statusLabel: 'Confirmed', totalText: 'USD 10.00', city: 'Shelbyville' });
		expect(list.headers.get('link')).toContain('cursor=');
		const next = await shop.admin(ticket, 'GET', `/v1/admin/orders?limit=1&cursor=${list.json.nextCursor}`);
		expect(next.json.items[0].id).toBe(a.order.id);
		const search = async (/** @type {string} */ query) =>
			(await shop.api('GET', `/v1/orders?${query}`)).json.items.map((/** @type {any} */ o) => o.id);
		expect(await search('q=zebra')).toEqual([a.order.id]);
		expect(await search('q=9990000')).toEqual([a.order.id]);
		expect(await search('q=shelby')).toEqual([b.order.id]);
		expect(await search(`q=${a.order.number}`)).toEqual([a.order.id]);
		expect(await search('q=zed%40example')).toEqual([a.order.id]);
		expect(await search('paymentMethod=online')).toContain(b.order.id);
		expect(await search('paymentMethod=online')).not.toContain(a.order.id);
		expect(await search('paymentState=paid&role=open&status=confirmed')).toContain(b.order.id);
		const placedAt = a.order.placedAt.toISOString();
		expect(await search(`from=${placedAt}&to=${b.order.placedAt.toISOString()}`)).toEqual([a.order.id]);
		for (const bad of [
			'role=nope',
			'status=BAD',
			'paymentState=nope',
			'paymentMethod=nope',
			'from=yesterday',
			`q=${'x'.repeat(121)}`,
		]) {
			const refused = await shop.api('GET', `/v1/orders?${bad}`);
			expect(refused.status, bad).toBe(422);
		}
		const narrow = await shop.ticket(['orders.manage']);
		expect((await shop.admin(narrow, 'GET', '/v1/admin/orders')).status).toBe(403);
	});

	it('shows one order with its next statuses, history names and the customer flags', async () => {
		const { order } = await place({ userId: 'usr_flagged000001' });
		await data.collection(COLLECTIONS.customers).insertOne({
			userId: 'usr_flagged000001',
			name: 'Sara',
			email: '',
			phone: '',
			blocked: true,
			blockedReason: 'fraud',
			rtoCount: 2,
			orderCount: 3,
			note: '',
		});
		const detail = await shop.admin(ticket, 'GET', `/v1/admin/orders/${order.id}`);
		expect(detail.status).toBe(200);
		expect(detail.json).toMatchObject({
			id: order.id,
			number: order.number,
			statusLabel: 'Awaiting confirmation',
			customerFlags: { blocked: true, blockedReason: 'fraud', rtoCount: 2, orderCount: 3 },
			payment: { method: 'cod', refundable: 0 },
			staffNote: '',
		});
		expect(detail.json.nextStatuses.map((/** @type {any} */ s) => s.key)).toEqual(['confirmed', 'cancelled']);
		expect(detail.json.history[0]).toMatchObject({ fromLabel: '', toLabel: 'Awaiting confirmation', by: 'Sara Shopper' });
		expect(detail.json.lines[0].imageUrl).toBeNull();
		expect(typeof detail.json.placedAt).toBe('string');
		expect(detail.json.websiteId).toBeUndefined();
		expect((await shop.api('GET', '/v1/orders/ord_missing')).status).toBe(404);
		expect((await shop.api('GET', '/v1/orders/nope')).status).toBe(404);
	});
});

describe('moving orders', () => {
	it('confirms, refuses moves the flow does not allow and stale ones', async () => {
		const { order } = await place();
		const sent = shop.messages().length;
		const stale = await move(order.id, 'confirmed', { updatedAt: '2020-01-01T00:00:00.000Z' });
		expect(stale.status).toBe(409);
		expect(stale.json.type).toMatch(/conflict$/);
		const confirmed = await move(order.id, 'confirmed', {
			note: 'Called the shopper',
			updatedAt: (await orderRecord(order.id)).updatedAt.toISOString(),
		});
		expect(confirmed.status).toBe(200);
		expect(confirmed.json).toMatchObject({ status: 'confirmed', role: 'open', holdUntil: null, warnings: [] });
		expect(confirmed.json.history.at(-1)).toMatchObject({
			from: 'awaiting_confirmation',
			to: 'confirmed',
			by: 'Sam Staff',
			note: 'Called the shopper',
			toLabel: 'Confirmed',
		});
		expect(shop.messages().slice(sent)).toEqual([
			expect.objectContaining({
				template: 'ecommerce.order_status',
				values: expect.objectContaining({ status: 'Confirmed' }),
			}),
		]);
		const refused = await move(order.id, 'refunded');
		expect(refused.status).toBe(409);
		expect(refused.json.type).toMatch(/move_not_allowed$/);
		expect((await move(order.id, 'nowhere')).json.type).toMatch(/move_not_allowed$/);
		expect((await move(order.id, 'BAD')).status).toBe(422);
		expect((await move(order.id, 'confirmed', { note: 5 })).status).toBe(422);
		const viaServer = await shop.api('POST', `/v1/orders/${order.id}/move`, { to: 'cancelled' });
		expect(viaServer.status).toBe(200);
		expect(viaServer.json.history.at(-1).by).toBe('Server');
		expect(
			(await shop.admin(await shop.ticket(['orders.read']), 'POST', `/v1/admin/orders/${order.id}/move`, { to: 'x' })).status,
		).toBe(403);
	});

	it('captures serial numbers when packing serialized items', async () => {
		const { order, product, variant } = await place({ serialized: true, quantity: 2, method: 'online', paid: true });
		const serials = data.collection(COLLECTIONS.serials);
		for (const serial of ['IMEI-1', 'IMEI-2', 'IMEI-3'])
			await serials.insertOne({
				id: createId('ser'),
				productId: product.id,
				variantId: variant.id,
				serial,
				status: 'in_stock',
				orderId: null,
				lineId: null,
				locationId: null,
			});
		await serials.insertOne({
			id: createId('ser'),
			productId: product.id,
			variantId: 'var_other',
			serial: 'IMEI-X',
			status: 'in_stock',
			orderId: null,
			lineId: null,
			locationId: null,
		});
		const lineId = /** @type {string} */ (order.lines[0]?.id);
		const missing = await move(order.id, 'packed');
		expect(missing.status).toBe(422);
		expect(missing.json.errors[0].path).toBe(`/serials/${lineId}`);
		expect((await move(order.id, 'packed', { serials: { oln_other: ['A'] } })).status).toBe(422);
		expect((await move(order.id, 'packed', { serials: { [lineId]: ['A', 'A'] } })).status).toBe(422);
		expect((await move(order.id, 'packed', { serials: { [lineId]: [''] } })).status).toBe(422);
		expect((await move(order.id, 'packed', { serials: [] })).status).toBe(422);
		expect((await move(order.id, 'packed', { serials: { [lineId]: 'A' } })).status).toBe(422);
		const wrong = await move(order.id, 'packed', { serials: { [lineId]: ['IMEI-1', 'IMEI-X'] } });
		expect(wrong.status).toBe(422);
		expect(wrong.json.errors[0].message).toContain('IMEI-X');
		// nothing was taken by the failed try
		expect((await serials.findOne({ websiteId: data.websiteId, serial: 'IMEI-1' }))?.status).toBe('in_stock');
		const packed = await move(order.id, 'packed', { serials: { [lineId]: ['IMEI-1', 'IMEI-2'] } });
		expect(packed.status).toBe(200);
		expect(packed.json.lines[0].serials).toEqual(['IMEI-1', 'IMEI-2']);
		const sold = await serials.find({ websiteId: data.websiteId, orderId: order.id }).toArray();
		expect(sold.map((row) => row.serial).sort()).toEqual(['IMEI-1', 'IMEI-2']);
		expect(sold.every((row) => row.status === 'sold' && row.lineId === lineId)).toBe(true);
		// back to confirmed and packed again with one unit swapped
		await shop.list('order_flow', {
			statuses: (await import('../core/flow.js')).DEFAULT_FLOW.statuses,
			moves: [...(await import('../core/flow.js')).DEFAULT_FLOW.moves, { from: 'packed', to: 'confirmed' }],
		});
		expect((await move(order.id, 'confirmed')).status).toBe(200);
		const again = await move(order.id, 'packed', { serials: { [lineId]: ['IMEI-1', 'IMEI-3'] } });
		expect(again.status).toBe(200);
		expect((await serials.findOne({ websiteId: data.websiteId, serial: 'IMEI-2' }))?.status).toBe('in_stock');
		expect((await serials.findOne({ websiteId: data.websiteId, serial: 'IMEI-3' }))?.orderId).toBe(order.id);
		await shop.list('order_flow', (await import('../core/flow.js')).DEFAULT_FLOW);
		// cancelling puts the serials back in stock
		const cancelled = await move(order.id, 'cancelled', { note: 'Out of stock' });
		expect(cancelled.status).toBe(200);
		expect(await serials.countDocuments({ websiteId: data.websiteId, orderId: order.id })).toBe(0);
	});

	it('packs without serials when the product is not serialized', async () => {
		const { order } = await place({ method: 'online', paid: true });
		const packed = await move(order.id, 'packed');
		expect(packed.status).toBe(200);
		expect(packed.json.role).toBe('packed');
	});

	it('ships with a courier of the list and its tracking link', async () => {
		const { order } = await place({ method: 'online', paid: true });
		expect((await move(order.id, 'packed')).status).toBe(200);
		const none = await move(order.id, 'dispatched');
		expect(none.status).toBe(422);
		expect(none.json.errors[0].path).toBe('/shipment');
		expect((await move(order.id, 'dispatched', { shipment: { courier: 'nobody', trackingNumber: '1' } })).status).toBe(422);
		expect((await move(order.id, 'dispatched', { shipment: { courier: '', trackingNumber: '1' } })).status).toBe(422);
		expect((await move(order.id, 'dispatched', { shipment: { courier: 'swift', trackingNumber: '' } })).status).toBe(422);
		const shipped = await move(order.id, 'dispatched', { shipment: { courier: 'swift', trackingNumber: 'AB 12/3' } });
		expect(shipped.status).toBe(200);
		expect(shipped.json.shipment).toMatchObject({
			courier: 'Swift Post',
			trackingNumber: 'AB 12/3',
			trackingUrl: 'https://track.example.org/t?n=AB%2012%2F3',
			booked: false,
		});
		expect(shop.messages().at(-1)?.values).toMatchObject({ courier: 'Swift Post', trackingNumber: 'AB 12/3' });
		const { order: other } = await place({ method: 'online', paid: true });
		const byHand = await move(other.id, 'packed').then(() =>
			move(other.id, 'dispatched', { shipment: { courier: 'hand', trackingNumber: 77 } }),
		);
		expect(byHand.json.shipment).toMatchObject({ courier: 'By hand', trackingNumber: '77', trackingUrl: '' });
	});

	it('delivers: cash is collected, units are counted sold and points are earned', async () => {
		await shop.setting('loyalty', 'earnPercent', 10);
		await shop.setting('loyalty', 'pointValue', 1);
		await shop.setting('loyalty', 'expiryDays', 30);
		const { order, product } = await place({ quantity: 2, price: 1500, userId: 'usr_loyal0000001' });
		expect((await move(order.id, 'confirmed')).status).toBe(200);
		const delivered = await move(order.id, 'delivered');
		expect(delivered.status).toBe(200);
		expect(delivered.json.payment).toMatchObject({ state: 'paid', paid: 3000, refundable: 3000 });
		expect(delivered.json.promotions.pointsEarned).toBe(300);
		expect(typeof delivered.json.deliveredAt).toBe('string');
		expect((await stockOf(product.id)).sold).toBe(2);
		const account = /** @type {any} */ (
			await data.collection(COLLECTIONS.loyalty).findOne({ websiteId: data.websiteId, userId: 'usr_loyal0000001' })
		);
		expect(account.balance).toBe(300);
		expect(account.lots[0].expiresAt).toBeInstanceOf(Date);
		// refunded after delivery: cash goes back by hand and the points are taken back
		const calls = shop.callsTo(PAYMENTS).length;
		const refunded = await move(order.id, 'refunded', { note: 'Broken on arrival' });
		expect(refunded.status).toBe(200);
		expect(refunded.json.payment).toMatchObject({ state: 'refunded', refunded: 3000, refundable: 0 });
		expect(shop.callsTo(PAYMENTS).length).toBe(calls);
		const after = /** @type {any} */ (
			await data.collection(COLLECTIONS.loyalty).findOne({ websiteId: data.websiteId, userId: 'usr_loyal0000001' })
		);
		expect(after.balance).toBe(0);
		expect(after.history.at(-1)).toMatchObject({ kind: 'reverse', points: 300, orderId: order.id });
	});

	it('cancels: stock and offer uses come back once and money paid online is refunded', async () => {
		const couponId = createId('cpn');
		await data.collection(COLLECTIONS.coupons).insertOne({ id: couponId, code: 'SAVE', active: true, limit: 10, used: 0 });
		const { order, product } = await place({
			method: 'online',
			paid: true,
			quantity: 3,
			promotions: { couponId, couponCode: 'SAVE' },
		});
		expect((await stockOf(product.id)).stock).toBe(7);
		const coupon = async () =>
			/** @type {any} */ (await data.collection(COLLECTIONS.coupons).findOne({ websiteId: data.websiteId, id: couponId }));
		expect((await coupon()).used).toBe(1);
		const before = shop.callsTo(PAYMENTS).length;
		const cancelled = await move(order.id, 'cancelled', { note: 'Asked by shopper' });
		expect(cancelled.status).toBe(200);
		expect(cancelled.json).toMatchObject({ status: 'cancelled', stockHeld: false, warnings: [] });
		expect(cancelled.json.payment).toMatchObject({ state: 'refunded', refunded: 3000 });
		const refundCall = shop
			.callsTo(PAYMENTS)
			.slice(before)
			.find((c) => c.path.endsWith('/refunds'));
		expect(JSON.parse(refundCall?.body ?? '{}')).toEqual({ amount: 3000, reason: 'Asked by shopper' });
		expect(refundCall?.headers['idempotency-key']).toBe(`${order.id}:cancel`);
		expect((await stockOf(product.id)).stock).toBe(10);
		expect((await coupon()).used).toBe(0);
		expect((await move(order.id, 'confirmed')).json.type).toMatch(/move_not_allowed$/);
	});

	it('cancels even when the refund fails, with a warning', async () => {
		const { order } = await place({ method: 'cod', advance: 200 });
		const keep = shop.responders.get(PAYMENTS);
		shop.responders.set(PAYMENTS, (call) =>
			call.path.endsWith('/refunds') ? { status: 500, body: {} } : keep ? keep(call) : { status: 200 },
		);
		try {
			const cancelled = await move(order.id, 'cancelled');
			expect(cancelled.status).toBe(200);
			expect(cancelled.json.status).toBe('cancelled');
			expect(cancelled.json.warnings[0]).toContain('refund failed');
			expect(cancelled.json.payment).toMatchObject({ state: 'unpaid', refunded: 0, paid: 200, refundable: 200 });
		} finally {
			if (keep) shop.responders.set(PAYMENTS, keep);
		}
		// staff refund the advance afterwards
		const refund = await shop.admin(ticket, 'POST', `/v1/admin/orders/${order.id}/refunds`, {
			amount: 200,
			reason: 'Cancelled',
		});
		expect(refund.status).toBe(201);
		expect(refund.json.refund).toMatchObject({ online: 200, manual: 0, recorded: false });
	});

	it('returns to origin: stock back and the RTO count rises', async () => {
		const { order, product } = await place({ userId: 'usr_rto000000001', quantity: 2 });
		await move(order.id, 'confirmed');
		await move(order.id, 'packed');
		await move(order.id, 'dispatched', { shipment: { courier: 'swift', trackingNumber: 'RT1' } });
		expect((await stockOf(product.id)).stock).toBe(8);
		const returned = await move(order.id, 'returned');
		expect(returned.status).toBe(200);
		expect(returned.json.customerFlags.rtoCount).toBe(1);
		expect((await stockOf(product.id)).stock).toBe(10);
		// nothing was paid: refunded records nothing
		const refunded = await move(order.id, 'refunded');
		expect(refunded.json.payment).toMatchObject({ state: 'unpaid', refunded: 0 });
	});

	it('keeps the shipment when moving between shipped statuses', async () => {
		const flow = (await import('../core/flow.js')).DEFAULT_FLOW;
		await shop.list('order_flow', {
			statuses: [...flow.statuses, { key: 'out_for_delivery', label: 'Out for delivery', role: 'shipped' }],
			moves: [...flow.moves, { from: 'dispatched', to: 'out_for_delivery' }],
		});
		try {
			const { order } = await place({ method: 'online', paid: true });
			await move(order.id, 'packed');
			await move(order.id, 'dispatched', { shipment: { courier: 'swift', trackingNumber: 'K1' } });
			const out = await move(order.id, 'out_for_delivery');
			expect(out.status).toBe(200);
			expect(out.json.shipment.trackingNumber).toBe('K1');
		} finally {
			await shop.list('order_flow', flow);
		}
	});

	it('refunds online-paid orders through Payments when refunded after delivery', async () => {
		const { order } = await place({ method: 'online', paid: true });
		await move(order.id, 'delivered');
		const refunded = await move(order.id, 'refunded');
		expect(refunded.status).toBe(200);
		const call = shop.callsTo(PAYMENTS).at(-1);
		expect(call?.headers['idempotency-key']).toBe(`${order.id}:refund:0`);
		expect(JSON.parse(call?.body ?? '{}')).toEqual({ amount: 1000, reason: 'Order refunded' });
		expect(refunded.json.payment.state).toBe('refunded');
	});
});

describe('refunds without a status change', () => {
	it('refunds part through Payments, then the rest, never more than was paid', async () => {
		const { order } = await place({ method: 'online', paid: true, price: 1000 });
		const url = `/v1/admin/orders/${order.id}/refunds`;
		expect((await shop.admin(ticket, 'POST', url, { amount: 1001, reason: 'Too much' })).status).toBe(422);
		expect((await shop.admin(ticket, 'POST', url, { amount: 100 })).status).toBe(422);
		expect((await shop.admin(ticket, 'POST', url, { amount: 1.5, reason: 'x' })).status).toBe(422);
		const first = await shop.admin(ticket, 'POST', url, { amount: 300, reason: 'Scratched' });
		expect(first.status).toBe(201);
		expect(first.json.refund).toMatchObject({ amount: 300, online: 300, manual: 0, recorded: false });
		expect(first.json.refund.refundId).toMatch(/^rfd_/);
		expect(first.json.order.payment).toMatchObject({ state: 'partially_refunded', refunded: 300, refundable: 700 });
		expect(first.json.order.history.at(-1).note).toBe('Refunded USD 3.00: Scratched');
		expect(first.json.order.status).toBe('confirmed');
		const rest = await shop.api('POST', `/v1/orders/${order.id}/refunds`, { amount: 700, reason: 'Gave up' });
		expect(rest.json.order.payment).toMatchObject({ state: 'refunded', refunded: 1000 });
		const none = await shop.api('POST', `/v1/orders/${order.id}/refunds`, { amount: 1, reason: 'More' });
		expect(none.status).toBe(422);
		expect(none.json.errors[0].message).toContain('Nothing paid');
		expect((await shop.admin(await shop.ticket(['orders.manage']), 'POST', url, { amount: 1, reason: 'x' })).status).toBe(403);
	});

	it('records cash refunds by hand', async () => {
		const { order } = await place();
		await move(order.id, 'confirmed');
		await move(order.id, 'delivered');
		const before = shop.callsTo(PAYMENTS).length;
		const cash = await shop.admin(ticket, 'POST', `/v1/admin/orders/${order.id}/refunds`, { amount: 400, reason: 'Discount' });
		expect(cash.status).toBe(201);
		expect(cash.json.refund).toMatchObject({ online: 0, manual: 400, recorded: true, refundId: null });
		expect(cash.json.order.history.at(-1).note).toBe('Refunded USD 4.00 (recorded): Discount');
		expect(shop.callsTo(PAYMENTS).length).toBe(before);
	});
});

describe('editing orders', () => {
	it('keeps a staff note and changes the address before shipping only', async () => {
		const { order } = await place({ method: 'online', paid: true });
		const url = `/v1/admin/orders/${order.id}`;
		const noted = await shop.admin(ticket, 'PATCH', url, { staffNote: '  Fragile  ' });
		expect(noted.status).toBe(200);
		expect(noted.json.staffNote).toBe('Fragile');
		const moved = await shop.admin(ticket, 'PATCH', url, { address: { city: 'Capital City', line2: 'Flat 2' } });
		expect(moved.json.address).toMatchObject({ city: 'Capital City', line2: 'Flat 2', line1: '1 Main Street' });
		expect((await shop.admin(ticket, 'PATCH', url, { address: { city: '' } })).status).toBe(422);
		expect((await shop.admin(ticket, 'PATCH', url, { address: { city: 5 } })).status).toBe(422);
		expect((await shop.admin(ticket, 'PATCH', url, { staffNote: 5 })).status).toBe(422);
		expect((await shop.admin(ticket, 'PATCH', url, {})).status).toBe(422);
		await move(order.id, 'packed');
		await move(order.id, 'dispatched', { shipment: { courier: 'swift', trackingNumber: 'E1' } });
		const late = await shop.api('PATCH', `/v1/orders/${order.id}`, { address: { city: 'Elsewhere' } });
		expect(late.status).toBe(422);
		expect(late.json.errors[0].message).toContain('shipped');
		const { order: pickup } = await place({ address: null });
		expect((await shop.api('PATCH', `/v1/orders/${pickup.id}`, { address: { city: 'X' } })).status).toBe(422);
	});
});

describe('bulk moves', () => {
	it('moves many orders, each checked like one move', async () => {
		const a = await place();
		const b = await place();
		const c = await place({ method: 'online', paid: true });
		const answer = await shop.admin(ticket, 'POST', '/v1/admin/orders/bulk-move', {
			ids: [a.order.id, b.order.id, c.order.id, 'ord_missing', a.order.id],
			to: 'confirmed',
			note: 'Morning batch',
		});
		expect(answer.status).toBe(200);
		expect(answer.json.moved).toBe(2);
		expect(answer.json.results).toEqual([
			{ id: a.order.id, ok: true, number: a.order.number, status: 'confirmed', warnings: [] },
			{ id: b.order.id, ok: true, number: b.order.number, status: 'confirmed', warnings: [] },
			expect.objectContaining({ id: c.order.id, ok: false, code: 'move_not_allowed' }),
			{ id: 'ord_missing', ok: false, code: 'not_found', detail: 'There is no such order.' },
		]);
		const shipping = await shop.api('POST', '/v1/orders/bulk-move', { ids: [a.order.id], to: 'packed' });
		expect(shipping.json.moved).toBe(1);
		const needs = await shop.api('POST', '/v1/orders/bulk-move', { ids: [a.order.id], to: 'dispatched' });
		expect(needs.json.results[0]).toMatchObject({ ok: false, code: 'validation_failed' });
		expect(needs.json.results[0].detail).toContain('courier');
		for (const body of [
			{ ids: [], to: 'confirmed' },
			{ ids: ['nope'], to: 'confirmed' },
			{ ids: [a.order.id], to: 'BAD' },
		])
			expect((await shop.api('POST', '/v1/orders/bulk-move', body)).status).toBe(422);
		expect(
			(await shop.api('POST', '/v1/orders/bulk-move', { ids: Array.from({ length: 201 }, () => a.order.id), to: 'x' })).status,
		).toBe(422);
		const noBulk = await shop.ticket(ALL_PERMISSIONS.filter((p) => p !== 'bulk.run'));
		expect((await shop.admin(noBulk, 'POST', '/v1/admin/orders/bulk-move', { ids: [a.order.id], to: 'x' })).status).toBe(403);
	});
});

describe('data rights', () => {
	it('exports the person’s orders without staff notes and anonymises them on delete', async () => {
		const userId = 'usr_rights000001';
		const { order } = await place({ userId, email: 'Rights@Example.com', phone: '+15550002222' });
		await shop.api('PATCH', `/v1/orders/${order.id}`, { staffNote: 'Difficult customer' });
		await shop.api('PATCH', `/v1/customers/${userId}`, { note: 'VIP' });
		const service = createService(shop.product);
		const area = createOrders(shop.product, service);
		const s = await service.site({
			websiteId: shop.websiteId,
			merchantId: null,
			status: { domain: DOMAIN },
			headers: new Headers(),
		});
		const byEmail = await /** @type {NonNullable<typeof area.exportUser>} */ (area.exportUser)(s, {
			email: 'rights@example.com',
		});
		expect(byEmail.orders).toHaveLength(0);
		const exported = await /** @type {NonNullable<typeof area.exportUser>} */ (area.exportUser)(s, { id: userId });
		expect(exported.orders).toHaveLength(1);
		const [first] = /** @type {any[]} */ (exported.orders);
		expect(first.number).toBe(order.number);
		expect(first.staffNote).toBeUndefined();
		expect(first.idempotencyKey).toBeUndefined();
		expect(typeof first.placedAt).toBe('string');
		expect(exported.customers).toHaveLength(1);
		expect(/** @type {any[]} */ (exported.customers)[0].note).toBeUndefined();
		const byPhone = await /** @type {NonNullable<typeof area.exportUser>} */ (area.exportUser)(s, { phone: '+15550002222' });
		expect(byPhone.orders).toHaveLength(1);
		expect(await /** @type {NonNullable<typeof area.exportUser>} */ (area.exportUser)(s, {})).toEqual({
			orders: [],
			customers: [],
		});
		const done = await /** @type {NonNullable<typeof area.deleteUser>} */ (area.deleteUser)(s, { email: 'Rights@Example.com' });
		expect(done).toEqual({ deleted: 1, anonymised: 1 });
		const after = await orderRecord(order.id);
		expect(after.customer).toEqual({ userId, name: '', email: '', phone: '' });
		expect(after.address).toBeNull();
		expect(after.totals.total).toBe(1000);
		expect(await /** @type {NonNullable<typeof area.deleteUser>} */ (area.deleteUser)(s, {})).toEqual({
			deleted: 0,
			anonymised: 0,
		});
	});
});
