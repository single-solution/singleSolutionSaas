/**
 * Ecommerce on the store-conversion kit (PLAN 0.8.10 K1–K9): the list settings through the kit's settings API, the
 * staff member a server-token call names in its `SS-Actor-*` headers on order, claim, refund and catalog records,
 * visitor calls from the merchant's server, counts that equal their lists, the Format and the business time zone in
 * server texts and order numbers and report days, and labelled activity entries.
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dayBounds } from '../core/calendar.js';
import { DEFAULT_FLOW } from '../core/flow.js';
import { COLLECTIONS } from '../core/model.js';
import { parseRange } from '../core/reports.js';
import { actorHeaders } from '../server/service.js';
import { ALL, ORIGIN, PAYMENTS, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
/** @type {string} */
let ticket;

/** A member of the staff named by the merchant's server (K2). */
const ACTOR = Object.freeze({
	'ss-actor-id': 'usr_ali0001',
	'ss-actor-name': encodeURIComponent('Ali Khān'),
	'ss-actor-role': encodeURIComponent('Store manager'),
});

beforeAll(async () => {
	shop = await readyShop();
	ticket = await shop.ticket();
});
afterAll(async () => shop.product.close());

/** The problem code of an answer. @param {{ json: any }} response */
const codeOf = (response) =>
	String(response.json?.type ?? '')
		.split('/')
		.pop();

/**
 * Serve business.json with a time zone and read it again.
 * @param {string} timeZone
 */
const useTimeZone = async (timeZone) => {
	shop.responders.set(`${ORIGIN}/.well-known/business.json`, () => ({
		status: 200,
		body: { version: 1, name: 'Shop', email: 'hello@shop.example.com', timeZone },
	}));
	const refreshed = await shop.dashboard(
		await shop.adminSession(),
		'POST',
		`/v1/dashboard/websites/${shop.websiteId}/business/refresh`,
	);
	expect(refreshed.status).toBeLessThan(300);
};

/**
 * Write an order straight into the merchant database.
 * @param {Partial<import('../core/model.js').OrderRecord>} [patch]
 * @returns {Promise<import('../core/model.js').OrderRecord>}
 */
const seedOrder = async (patch = {}) => {
	const order = {
		id: createId('ord'),
		number: `K-${createId('num').slice(4, 14)}`,
		customer: { userId: 'usr_kitshopper01', name: 'Kit Shopper', email: 'kit@example.com', phone: '' },
		address: null,
		delivery: { method: 'none', zone: '', fee: 0, locationId: null },
		lines: [
			{
				id: createId('oln'),
				productId: 'prd_kitline',
				variantId: 'var_kitline',
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
			released: true,
		},
		payment: { method: 'cod', state: 'unpaid', paymentId: null, advance: 0, paid: 0, refunded: 0, checkedAt: null },
		status: 'awaiting_confirmation',
		role: /** @type {import('../core/model.js').StatusRole} */ ('awaiting_confirmation'),
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
	await (await shop.db()).collection(COLLECTIONS.orders).insertOne({ ...order });
	return /** @type {any} */ (order);
};

/**
 * Every item of a server-token list (all pages).
 * @param {string} path with its query
 * @returns {Promise<any[]>}
 */
const listAll = async (path) => {
	/** @type {any[]} */
	const items = [];
	let cursor = '';
	for (;;) {
		const page = await shop.api('GET', `${path}${path.includes('?') ? '&' : '?'}limit=100${cursor ? `&cursor=${cursor}` : ''}`);
		expect(page.status).toBe(200);
		items.push(...page.json.items);
		if (!page.json.nextCursor) return items;
		cursor = encodeURIComponent(page.json.nextCursor);
	}
};

/** The activity entries of a target, newest first. @param {string} target */
const activityOf = async (target) => (await shop.api('GET', `/v1/activity?target=${encodeURIComponent(target)}`)).json.items;

describe('K1: list settings for the merchant’s server', () => {
	it('reads and saves each list, checked like the dashboard, as a Recent change by the acting user', async () => {
		const flow = await shop.api('GET', '/v1/lists/order_flow');
		expect(flow.status).toBe(200);
		expect(flow.json.value).toEqual(DEFAULT_FLOW);
		for (const name of ['couriers', 'delivery_zones', 'tax_rules', 'grades', 'booking_hours'])
			expect((await shop.api('GET', `/v1/lists/${name}`)).json, name).toEqual({ value: expect.any(Array) });
		const couriers = [{ key: 'swift', name: 'Swift Post', trackingUrl: 'https://track.example.org/t?n={tracking}' }];
		const saved = await shop.api('PUT', '/v1/lists/couriers', { value: couriers }, ACTOR);
		expect(saved.status).toBe(200);
		expect(saved.json.value).toEqual(couriers);
		expect((await shop.api('GET', '/v1/lists/couriers')).json.value).toEqual(couriers);
		const dashboard = await shop.dashboard(
			await shop.adminSession(),
			'GET',
			`/v1/dashboard/websites/${shop.websiteId}/lists/couriers`,
		);
		expect(dashboard.json.value).toEqual(couriers);
		const changes = await shop.product.recentChanges.list(shop.websiteId);
		expect(changes.find((change) => change.detail === 'Couriers: changed')).toMatchObject({
			who: { kind: 'user', id: 'usr_ali0001', name: 'Ali Khān', role: 'Store manager' },
			detail: 'Couriers: changed',
		});

		const refused = await shop.api('PUT', '/v1/lists/couriers', { value: [{ key: 'Bad Key', name: '' }] });
		expect(refused.status).toBe(422);
		expect(refused.json.errors.length).toBeGreaterThan(0);
		expect((await shop.api('PUT', '/v1/lists/couriers', {})).status).toBe(422);
		expect((await shop.api('GET', '/v1/lists/nothing')).status).toBe(404);
		await shop.switchOn(ALL.filter((feature) => feature !== 'taxes'));
		try {
			const off = await shop.api('PUT', '/v1/lists/tax_rules', { value: [] });
			expect(off.status).toBe(403);
			expect(codeOf(off)).toBe('feature_off');
		} finally {
			await shop.switchOn(ALL);
		}
	});
});

describe('K2 and K9: the acting staff member and labelled activity', () => {
	it('records the staff member a server-token move names, and Server without the headers', async () => {
		const order = await seedOrder();
		const moved = await shop.api('POST', `/v1/orders/${order.id}/move`, { to: 'confirmed' }, ACTOR);
		expect(moved.status).toBe(200);
		expect(moved.json.history.at(-1)).toMatchObject({ from: 'awaiting_confirmation', to: 'confirmed', by: 'Ali Khān' });
		const [entry] = await activityOf(order.id);
		expect(entry).toMatchObject({
			actor: { kind: 'user', id: 'usr_ali0001', name: 'Ali Khān', role: 'Store manager' },
			action: 'order.moved',
			target: order.id,
			label: order.number,
			detail: 'Awaiting confirmation → Confirmed',
		});

		const plain = await seedOrder();
		const byServer = await shop.api('POST', `/v1/orders/${plain.id}/move`, { to: 'confirmed' });
		expect(byServer.json.history.at(-1).by).toBe('Server');
		expect((await activityOf(plain.id))[0].actor).toEqual({ kind: 'server', id: 'server', name: 'Server' });

		const staff = await seedOrder();
		const byTicket = await shop.admin(ticket, 'POST', `/v1/admin/orders/${staff.id}/move`, { to: 'confirmed' });
		expect(byTicket.json.history.at(-1).by).toBe('Sam Staff');
		expect((await activityOf(staff.id))[0].actor).toMatchObject({ kind: 'staff', name: 'Sam Staff' });

		const malformed = await shop.api('POST', `/v1/orders/${plain.id}/move`, { to: 'packed' }, { 'ss-actor-id': 'usr_x' });
		expect(malformed.status).toBe(400);
		expect(codeOf(malformed)).toBe('invalid_actor');
	});

	it('names the staff member on bulk moves, notes and refunds, and tells Payments who refunded', async () => {
		const [a, b] = [await seedOrder(), await seedOrder()];
		const bulk = await shop.api('POST', '/v1/orders/bulk-move', { ids: [a.id, b.id, 'ord_missing'], to: 'confirmed' }, ACTOR);
		expect(bulk.json.moved).toBe(2);
		const records = (await shop.db()).collection(COLLECTIONS.orders);
		const after = /** @type {any} */ (await records.findOne({ websiteId: shop.websiteId, id: a.id }));
		expect(after.history.at(-1).by).toBe('Ali Khān');
		const bulkEntry = (await shop.api('GET', '/v1/activity?action=orders.bulk_moved')).json.items[0];
		expect(bulkEntry).toMatchObject({ label: '2 orders', detail: 'To Confirmed; 1 not moved', actor: { name: 'Ali Khān' } });

		const noted = await shop.api('PATCH', `/v1/orders/${a.id}`, { staffNote: 'Call first' }, ACTOR);
		expect(noted.status).toBe(200);
		expect((await activityOf(a.id))[0]).toMatchObject({
			action: 'order.noted',
			label: a.number,
			detail: 'Staff note changed',
		});

		const paid = await seedOrder({
			status: 'confirmed',
			role: 'open',
			payment: {
				method: 'online',
				state: 'paid',
				paymentId: 'pay_kitrefund',
				advance: 0,
				paid: 1000,
				refunded: 0,
				checkedAt: null,
			},
		});
		const refunded = await shop.api('POST', `/v1/orders/${paid.id}/refunds`, { amount: 250, reason: 'Scratched' }, ACTOR);
		expect(refunded.status).toBe(201);
		expect(refunded.json.order.history.at(-1)).toMatchObject({ by: 'Ali Khān', note: 'Refunded USD 2.50: Scratched' });
		const call = /** @type {import('./helpers.js').Call} */ (
			shop.callsTo(PAYMENTS).findLast((c) => c.path === '/v1/payments/pay_kitrefund/refunds')
		);
		expect(call.headers).toMatchObject({
			'ss-actor-id': 'usr_ali0001',
			'ss-actor-name': encodeURIComponent('Ali Khān'),
			'ss-actor-role': encodeURIComponent('Store manager'),
		});
		expect((await activityOf(paid.id))[0]).toMatchObject({ action: 'order.refunded', detail: 'Refunded USD 2.50' });
		await shop.api('POST', `/v1/orders/${paid.id}/refunds`, { amount: 100, reason: 'Again' });
		const plainCall = /** @type {import('./helpers.js').Call} */ (
			shop.callsTo(PAYMENTS).findLast((c) => c.path === '/v1/payments/pay_kitrefund/refunds')
		);
		expect(plainCall.headers['ss-actor-id']).toBeUndefined();
	});

	it('names the staff member on return claims and catalog edits', async () => {
		const order = await seedOrder({
			status: 'delivered',
			role: 'delivered',
			deliveredAt: new Date(shop.now()),
			payment: {
				method: 'online',
				state: 'paid',
				paymentId: 'pay_kitclaim',
				advance: 0,
				paid: 1000,
				refunded: 0,
				checkedAt: null,
			},
		});
		const claimId = createId('ret');
		await (await shop.db()).collection(COLLECTIONS.returns).insertOne({
			id: claimId,
			orderId: order.id,
			orderNumber: order.number,
			userId: order.customer.userId,
			kind: 'return',
			lines: [{ lineId: /** @type {any} */ (order.lines[0]).id, quantity: 1, serials: [] }],
			reason: 'Too big',
			photos: [],
			status: 'requested',
			refundAmount: 0,
			refundId: null,
			restockedAt: null,
			history: [{ at: new Date(shop.now()), status: 'requested', by: 'shopper', note: '' }],
		});
		const approved = await shop.api('POST', `/v1/returns/${claimId}/approve`, { note: 'Send it' }, ACTOR);
		expect(approved.json.history.at(-1)).toMatchObject({ status: 'approved', by: 'Ali Khān' });
		expect((await activityOf(claimId))[0]).toMatchObject({
			action: 'return.approved',
			label: expect.stringContaining(order.number),
			detail: 'requested → approved',
			actor: { kind: 'user', name: 'Ali Khān' },
		});
		const refund = await shop.api('POST', `/v1/returns/${claimId}/refund`, { amount: 400 }, ACTOR);
		expect(refund.json.history.at(-1)).toMatchObject({ status: 'refunded', by: 'Ali Khān', note: 'USD 4.00' });
		const call = /** @type {import('./helpers.js').Call} */ (
			shop.callsTo(PAYMENTS).findLast((c) => c.path === '/v1/payments/pay_kitclaim/refunds')
		);
		expect(call.headers['ss-actor-name']).toBe(encodeURIComponent('Ali Khān'));

		const created = await shop.api('POST', '/v1/products', { name: 'Kit Charger', price: 1500, sku: 'KIT-CH' }, ACTOR);
		expect(created.status).toBe(201);
		const [entry] = await activityOf(created.json.id);
		expect(entry).toMatchObject({
			action: 'product.created',
			label: 'Kit Charger',
			detail: 'Status: draft',
			actor: { kind: 'user', id: 'usr_ali0001', role: 'Store manager' },
		});
		const variant = created.json.variants[0];
		await shop.switchOn(ALL.filter((feature) => feature !== 'multi_location'));
		try {
			const stocked = await shop.api(
				'POST',
				`/v1/products/${created.json.id}/stock`,
				{ changes: [{ variantId: variant.id, set: 7 }] },
				ACTOR,
			);
			expect(stocked.status).toBe(200);
		} finally {
			await shop.switchOn(ALL);
		}
		expect((await activityOf(created.json.id))[0]).toMatchObject({
			action: 'product.stock_changed',
			detail: `KIT-CH: ${variant.stock} → 7`,
		});
		const patched = await shop.api('PATCH', `/v1/products/${created.json.id}`, { status: 'active' }, ACTOR);
		expect(patched.status).toBe(200);
		expect((await activityOf(created.json.id))[0]).toMatchObject({ action: 'product.updated', detail: 'draft → active' });
	});

	it('only names a staff member Payments can take', () => {
		expect(actorHeaders({ kind: 'server', id: 'server', name: 'Server' })).toEqual({});
		expect(actorHeaders({ kind: 'staff', id: 'has space', name: 'Sam' })).toEqual({});
		expect(actorHeaders({ kind: 'staff', id: 'usr_1', name: '' })).toEqual({});
		expect(actorHeaders({ kind: 'staff', id: 'usr_1', name: 'x'.repeat(121) })).toEqual({});
		expect(actorHeaders({ kind: 'staff', id: 'usr_1', name: 'Bad\nName' })).toEqual({});
		expect(actorHeaders({ kind: 'user', id: 'usr_1', name: 'Sam', role: 'r'.repeat(41) })).toEqual({
			'ss-actor-id': 'usr_1',
			'ss-actor-name': 'Sam',
		});
	});
});

describe('K3: visitor calls from the merchant’s server', () => {
	it('answers shop reads to the server token without an Origin, exactly as to the browser', async () => {
		await shop.seedProduct({ name: 'Server Rendered Phone', price: 2000 });
		const fromServer = await shop.api('GET', '/v1/shop/products?q=Server%20Rendered');
		const fromBrowser = await shop.visitor('GET', '/v1/shop/products?q=Server%20Rendered');
		expect(fromServer.status).toBe(200);
		expect(fromServer.json).toEqual(fromBrowser.json);
		expect(fromServer.headers.get('access-control-allow-origin')).toBeNull();
	});

	it('places an order for the signed-in visitor with SS-Visitor-IP, and limits writes per that address', async () => {
		const item = await shop.seedProduct({ price: 3000, stock: 5 });
		const signIn = await shop.signIn({ id: 'usr_serverbuyer01', name: 'Sana Server' });
		const body = { lines: [{ productId: item.id, quantity: 1 }], payment: 'cod' };
		const missing = await shop.api('POST', '/v1/shop/orders', body, { 'ss-sign-in': signIn, 'idempotency-key': 'srv-1' });
		expect(missing.status).toBe(400);
		expect(codeOf(missing)).toBe('visitor_ip_required');
		const placed = await shop.api(
			'POST',
			'/v1/shop/orders',
			{
				...body,
				address: { name: 'Sana', phone: '+15550002222', line1: '2 High Street', city: 'Springfield', country: 'US' },
			},
			{ 'ss-sign-in': signIn, 'ss-visitor-ip': '203.0.113.7', 'idempotency-key': 'srv-2' },
		);
		expect(placed.status).toBe(201);
		const record = /** @type {any} */ (
			await (await shop.db()).collection(COLLECTIONS.orders).findOne({ websiteId: shop.websiteId, id: placed.json.order.id })
		);
		expect(record.customer).toMatchObject({ userId: 'usr_serverbuyer01', name: 'Sana Server' });

		/** @param {string} ip */
		const review = (ip) => shop.api('POST', '/v1/shop/reviews', {}, { 'ss-visitor-ip': ip });
		for (let n = 0; n < 10; n += 1) expect((await review('198.51.100.20')).status).not.toBe(429);
		expect((await review('198.51.100.20')).status).toBe(429);
		expect((await review('198.51.100.21')).status).not.toBe(429);
	});
});

describe('K4: counts equal to their lists', () => {
	it('counts orders with the list filters, by status, role, payment method and payment state', async () => {
		const flow = {
			statuses: [...DEFAULT_FLOW.statuses, { key: 'quality_check', label: 'Quality check', role: 'open' }],
			moves: [...DEFAULT_FLOW.moves, { from: 'confirmed', to: 'quality_check' }, { from: 'quality_check', to: 'packed' }],
		};
		expect((await shop.api('PUT', '/v1/lists/order_flow', { value: flow })).status).toBe(200);
		const pay = (/** @type {any} */ method, /** @type {any} */ state) => ({
			method,
			state,
			paymentId: null,
			advance: 0,
			paid: 0,
			refunded: 0,
			checkedAt: null,
		});
		await seedOrder({ number: 'CNT-1', payment: pay('cod', 'unpaid') });
		await seedOrder({ number: 'CNT-2', status: 'confirmed', role: 'open', payment: pay('online', 'paid') });
		await seedOrder({ number: 'CNT-3', status: 'quality_check', role: 'open', payment: pay('cod', 'unpaid') });
		await seedOrder({ number: 'CNT-4', status: 'packed', role: 'packed', payment: pay('bank_transfer', 'pending') });
		await seedOrder({ number: 'CNT-5', status: 'cancelled', role: 'cancelled', payment: pay('online', 'refunded') });
		await seedOrder({ number: 'CNT-6', status: 'retired_status', role: 'open', payment: pay('online', 'paid') });

		for (const query of [
			'q=CNT-',
			'q=CNT-&paymentMethod=cod',
			'q=CNT-&status=confirmed',
			'q=CNT-&role=open',
			'q=nothing-like-it',
		]) {
			const count = await shop.api('GET', `/v1/orders/count?${query}`);
			expect(count.json, query).toEqual({ count: (await listAll(`/v1/orders?${query}`)).length, capped: false });
		}
		expect((await shop.api('GET', '/v1/orders/count?q=CNT-')).json.count).toBe(6);
		const by = async (/** @type {string} */ field) => (await shop.api('GET', `/v1/orders/counts?q=CNT-&by=${field}`)).json;
		expect(await by('status')).toEqual({
			total: 6,
			groups: { awaiting_confirmation: 1, cancelled: 1, confirmed: 1, packed: 1, quality_check: 1, retired_status: 1 },
		});
		expect(await by('role')).toEqual({
			total: 6,
			groups: { open: 2, awaiting_confirmation: 1, cancelled: 1, none: 1, packed: 1 },
		});
		expect((await by('paymentMethod')).groups).toEqual({ online: 3, cod: 2, bank_transfer: 1 });
		expect((await by('paymentState')).groups).toEqual({ paid: 2, unpaid: 2, pending: 1, refunded: 1 });

		const bad = await shop.api('GET', '/v1/orders/count?role=nowhere');
		expect(bad.status).toBe(422);
		expect(bad.json.errors[0].path).toBe((await shop.api('GET', '/v1/orders?role=nowhere')).json.errors[0].path);
		expect((await shop.api('GET', '/v1/orders/counts?by=nothing')).status).toBe(422);
		expect((await shop.admin(ticket, 'GET', '/v1/admin/orders/count?q=CNT-')).json).toEqual({ count: 6, capped: false });
		expect((await shop.admin(ticket, 'GET', '/v1/admin/orders/counts?q=CNT-&by=role')).json.groups.open).toBe(2);
		const manager = await shop.ticket(['orders.manage']);
		expect((await shop.admin(manager, 'GET', '/v1/admin/orders/count')).status).toBe(403);
		expect((await shop.api('PUT', '/v1/lists/order_flow', { value: DEFAULT_FLOW })).status).toBe(200);
	});

	it('counts products, customers, reviews and returns with the list filters', async () => {
		await shop.seedProduct({ name: 'Countable one', status: 'active', brandId: 'brd_cnta' });
		await shop.seedProduct({ name: 'Countable two', status: 'draft', brandId: 'brd_cnta' });
		await shop.seedProduct({ name: 'Countable three', status: 'archived' });
		await shop.seedProduct({ name: 'Countable four', status: 'active', brandId: 'brd_cntb' });
		for (const query of ['q=Countable', 'q=Countable&status=active', 'q=Countable&lowStock=1'])
			expect((await shop.api('GET', `/v1/products/count?${query}`)).json.count, query).toBe(
				(await listAll(`/v1/products?${query}`)).length,
			);
		expect((await shop.api('GET', '/v1/products/counts?q=Countable&by=status')).json).toEqual({
			total: 4,
			groups: { active: 2, archived: 1, draft: 1 },
		});
		expect((await shop.admin(ticket, 'GET', '/v1/admin/products/counts?q=Countable&by=brand')).json.groups).toEqual({
			brd_cnta: 2,
			brd_cntb: 1,
			none: 1,
		});
		expect((await shop.admin(ticket, 'GET', '/v1/admin/products/count?q=Countable')).json.count).toBe(4);

		const data = await shop.db();
		await data.collection(COLLECTIONS.customers).insertMany([
			{
				userId: 'usr_cnt0001',
				name: 'Counted Amy',
				email: '',
				phone: '',
				blocked: false,
				blockedReason: '',
				rtoCount: 0,
				orderCount: 1,
				note: '',
			},
			{
				userId: 'usr_cnt0002',
				name: 'Counted Bob',
				email: '',
				phone: '',
				blocked: true,
				blockedReason: 'x',
				rtoCount: 0,
				orderCount: 1,
				note: '',
			},
			{
				userId: 'usr_cnt0003',
				name: 'Counted Cy',
				email: '',
				phone: '',
				blocked: false,
				blockedReason: '',
				rtoCount: 0,
				orderCount: 0,
				note: '',
			},
		]);
		for (const query of ['q=Counted', 'q=Counted&blocked=true', 'q=Counted&blocked=false'])
			expect((await shop.api('GET', `/v1/customers/count?${query}`)).json.count, query).toBe(
				(await listAll(`/v1/customers?${query}`)).length,
			);
		expect((await shop.api('GET', '/v1/customers/counts?q=Counted&by=blocked')).json).toEqual({
			total: 3,
			groups: { false: 2, true: 1 },
		});
		expect((await shop.admin(ticket, 'GET', '/v1/admin/customers/count?q=Counted&blocked=true')).json.count).toBe(1);
		expect((await shop.admin(ticket, 'GET', '/v1/admin/customers/counts?q=Counted&by=blocked')).json.total).toBe(3);
		expect((await shop.api('GET', `/v1/customers/count?q=${'x'.repeat(121)}`)).status).toBe(422);

		const review = (/** @type {string} */ status) => ({
			id: createId('rev'),
			productId: 'prd_cntreview',
			userId: createId('usr'),
			orderId: 'ord_cntreview',
			name: 'R',
			rating: 4,
			title: '',
			body: '',
			status,
			reply: '',
		});
		await data.collection(COLLECTIONS.reviews).insertMany(['pending', 'pending', 'approved', 'rejected'].map(review));
		for (const query of ['productId=prd_cntreview', 'productId=prd_cntreview&status=pending'])
			expect((await shop.api('GET', `/v1/reviews/count?${query}`)).json.count, query).toBe(
				(await listAll(`/v1/reviews?${query}`)).length,
			);
		expect((await shop.admin(ticket, 'GET', '/v1/admin/reviews/counts?productId=prd_cntreview&by=status')).json).toEqual({
			total: 4,
			groups: { pending: 2, approved: 1, rejected: 1 },
		});
		expect((await shop.admin(ticket, 'GET', '/v1/admin/reviews/count?productId=prd_cntreview')).json.count).toBe(4);
		expect((await shop.api('GET', '/v1/reviews/counts?productId=prd_cntreview&by=status')).json.total).toBe(4);

		const claim = (/** @type {string} */ status) => ({
			id: createId('ret'),
			orderId: 'ord_cntreturn',
			orderNumber: 'CNT-R',
			userId: 'usr_cnt0001',
			kind: 'return',
			lines: [],
			reason: 'x',
			photos: [],
			status,
			refundAmount: 0,
			refundId: null,
			restockedAt: null,
			history: [],
		});
		await data.collection(COLLECTIONS.returns).insertMany(['requested', 'approved', 'approved', 'closed'].map(claim));
		for (const query of ['orderId=ord_cntreturn', 'orderId=ord_cntreturn&status=approved'])
			expect((await shop.api('GET', `/v1/returns/count?${query}`)).json.count, query).toBe(
				(await listAll(`/v1/returns?${query}`)).length,
			);
		expect((await shop.api('GET', '/v1/returns/counts?orderId=ord_cntreturn&by=status')).json).toEqual({
			total: 4,
			groups: { approved: 2, closed: 1, requested: 1 },
		});
		expect((await shop.admin(ticket, 'GET', '/v1/admin/returns/count?orderId=ord_cntreturn')).json.count).toBe(4);
		expect((await shop.admin(ticket, 'GET', '/v1/admin/returns/counts?orderId=ord_cntreturn&by=status')).json.total).toBe(4);
	});
});

describe('K7 and K8: Format and business time zone', () => {
	it('formats the texts the server makes with the Format, and dates in the business time zone', async () => {
		await useTimeZone('Asia/Karachi');
		const saved = await shop.api('PUT', '/v1/format', {
			locale: 'en-GB',
			currencyDisplay: 'custom',
			currencySymbol: 'Rs',
			wholeUnits: true,
			times: 'business',
		});
		expect(saved.status).toBe(200);
		try {
			const config = await shop.visitor('GET', '/v1/widget/config');
			expect(config.json).toMatchObject({
				format: { locale: 'en-GB', currencySymbol: 'Rs', wholeUnits: true },
				timeZone: 'Asia/Karachi',
			});

			const order = await seedOrder({
				number: 'FMT-1',
				customer: { userId: 'usr_fmt0001', name: 'Fay', email: 'fay@example.com', phone: '' },
				placedAt: new Date('2026-10-04T20:30:00Z'),
			});
			const list = await shop.api('GET', '/v1/orders?q=FMT-1');
			expect(list.json.items[0]).toMatchObject({ total: 1000, totalText: 'Rs 10' });
			expect((await shop.api('GET', `/v1/orders/${order.id}`)).json.totalText).toBe('Rs 10');
			const invoice = await shop.api('GET', `/v1/orders/${order.id}/invoice`);
			expect(invoice.text).toContain('5 Oct 2026');
			expect(invoice.text).toContain('Rs 10');
			const customer = await shop.api('GET', '/v1/customers/usr_fmt0001');
			expect(customer.json.recentOrders[0].totalText).toBe('Rs 10');
			expect(customer.json.totalSpentText).toBe('Rs 0');

			const sent = shop.messages().length;
			await shop.api('POST', `/v1/orders/${order.id}/move`, { to: 'confirmed' });
			expect(shop.messages().slice(sent)).toEqual([
				expect.objectContaining({ template: 'ecommerce.order_status', values: expect.objectContaining({ total: 'Rs 10' }) }),
			]);

			const item = await shop.seedProduct({ name: 'Formatted phone', price: 70000 });
			const card = (await shop.api('GET', `/v1/chat/products/${item.id}`)).json;
			expect(card).toMatchObject({ price: 70000, priceText: 'Rs 700', priceRange: { minText: 'Rs 700' } });
			expect((await shop.api('GET', '/v1/customers/usr_fmt0001/orders')).json.items[0].totalText).toBe('Rs 10');

			const sales = await shop.api('GET', '/v1/reports/sales?from=2026-10-05&to=2026-10-05');
			expect(sales.json).toMatchObject({ from: '2026-10-04T19:00:00.000Z', to: '2026-10-05T19:00:00.000Z' });
			expect(sales.json.totals.orders).toBeGreaterThanOrEqual(1);
		} finally {
			await shop.api('PUT', '/v1/format', {
				locale: null,
				currencyDisplay: null,
				currencySymbol: null,
				wholeUnits: null,
				times: null,
			});
		}
	});

	it('reads report days and picked days in the business time zone', () => {
		const now = Date.parse('2026-10-05T10:00:00Z');
		expect(parseRange({ from: '2026-10-01', to: '2026-10-01' }, now, 'Asia/Karachi')).toEqual({
			ok: true,
			range: { from: new Date('2026-09-30T19:00:00.000Z'), to: new Date('2026-10-01T19:00:00.000Z') },
		});
		expect(parseRange({ from: '2026-10-01' }, now)).toMatchObject({
			ok: true,
			range: { from: new Date('2026-10-01T00:00:00Z') },
		});
		expect(dayBounds('2026-02-30', 'UTC')).toBeNull();
		expect(dayBounds(20261001, 'UTC')).toBeNull();
		expect(dayBounds('2026-03-29', 'Europe/London')).toEqual({
			start: Date.parse('2026-03-29T00:00:00Z'),
			end: Date.parse('2026-03-29T23:00:00Z'),
		});
	});

	it('numbers orders by the year in the business time zone', async () => {
		await useTimeZone('Asia/Karachi');
		shop.advance(Date.parse('2026-12-31T20:00:00Z') - shop.now());
		const item = await shop.seedProduct({ price: 1000, stock: 3 });
		const signIn = await shop.signIn({ id: 'usr_newyear0001', name: 'New Year' });
		const placed = await shop.api(
			'POST',
			'/v1/shop/orders',
			{
				lines: [{ productId: item.id, quantity: 1 }],
				payment: 'cod',
				address: { name: 'N', phone: '+15550003333', line1: '3 Main Street', city: 'Springfield', country: 'US' },
			},
			{ 'ss-sign-in': signIn, 'ss-visitor-ip': '203.0.113.9', 'idempotency-key': 'new-year' },
		);
		expect(placed.status).toBe(201);
		expect(placed.json.order.number).toMatch(/^2027-\d{6}$/);
	});
});
