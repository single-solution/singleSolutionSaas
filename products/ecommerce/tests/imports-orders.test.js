/**
 * The shoppers' and orders' part of the import (PLAN 0.8.10 K10, Migration order step 6) through the real routes with
 * the `import` feature on: a dry run reports every refusal and writes nothing; a real run writes the records as the shop
 * keeps them, and a re-run gives the same; finish derives counts, balances, units sold, ratings, serials and counters,
 * and changes nothing the second time; imported orders read back and move through the flow, and the next order placed
 * gets the next number; prune; nothing is sent (no message, Payments call, event or activity copy).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS } from '../core/model.js';
import { ACCOUNTS, GROWTH, NOTIFY, ORIGIN, PAYMENTS, UNIT_TYPES, readyShop, storedUnit } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
/** @type {import('@ss/app-kit').WebsiteData} */
let data;

/** A test id: `<prefix>_` and 24 digits (as the importer makes them from the old ObjectIds). @param {string} prefix @param {number} n */
const idOf = (prefix, n) => `${prefix}_${String(n).padStart(24, '0')}`;

const PRODUCT = idOf('prd', 1);
const OTHER = idOf('prd', 2);
const MEMBER = 'usr_member0000000001';
const CUS_MEMBER = idOf('cus', 1);
const CUS_GUEST = idOf('cus', 2);
const DELIVERED = idOf('ord', 1);
const RETURNED = idOf('ord', 2);
const CONFIRMED = idOf('ord', 3);
const LAST_YEAR = idOf('ord', 4);
const ADDRESS = {
	name: 'Sara Shopper',
	phone: '+15550001111',
	line1: '1 Main Street',
	line2: '',
	city: 'Springfield',
	area: '',
	postalCode: '',
	country: 'US',
	notes: '',
};

/** @type {{ product: string, other: string }} variant ids */
const variants = { product: '', other: '' };

/** @param {unknown[]} records */
const ndjson = (records) => `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;

/** @param {string} collection @param {unknown[]} records @param {{ dryRun?: boolean }} [options] */
const send = async (collection, records, { dryRun = false } = {}) => {
	const response = await shop.call('POST', `/v1/import/${collection}${dryRun ? '?dryRun=1' : ''}`, {
		token: shop.server,
		body: ndjson(records),
		headers: { 'content-type': 'application/x-ndjson' },
	});
	return { status: response.status, json: response.json };
};

/** @param {string} collection @param {unknown} body @param {{ dryRun?: boolean }} [options] */
const prune = async (collection, body, { dryRun = false } = {}) =>
	(await shop.call('POST', `/v1/import/${collection}/prune${dryRun ? '?dryRun=1' : ''}`, { token: shop.server, body })).json;

const finish = async () => (await shop.call('POST', '/v1/import/finish', { token: shop.server })).json;

/** @param {string} name */
const all = async (name) =>
	/** @type {any[]} */ (
		await (
			await shop.db()
		)
			.collection(name)
			.find({ websiteId: shop.websiteId }, { projection: { _id: 0 } })
			.sort({ id: 1 })
			.toArray()
	);

/** Records without the time of their last write. @param {any[]} records */
const unstamped = (records) => records.map(({ updatedAt, ...rest }) => (void updatedAt, rest));

/**
 * An order as the old shop had it, in the product's shape (default flow, prefix '', 6 digits, USD).
 * @param {{ id: string, number: string, status: string, customer: Record<string, string>, lines: any[], delivery?: number,
 *   history: any[], payments?: any[], refunds?: any[], method?: string, stockHeld?: boolean, deliveredAt?: string | null,
 *   placedAt?: string, promotions?: Record<string, unknown>, extra?: Record<string, unknown> }} order
 */
const orderOf = ({
	id,
	number,
	status,
	customer,
	lines,
	delivery = 300,
	history,
	payments = [],
	refunds = [],
	method = 'cod',
	stockHeld = true,
	deliveredAt = null,
	placedAt = '2026-03-01T09:00:00Z',
	promotions = {},
	extra = {},
}) => {
	const goods = lines.reduce((n, line) => n + line.total, 0);
	return {
		id,
		number,
		customer: { name: 'Sara Shopper', email: '', phone: '+15550001111', ...customer },
		address: ADDRESS,
		delivery: { method: 'delivery', zone: 'city', fee: delivery, locationId: null },
		lines,
		totals: {
			subtotal: lines.reduce((n, line) => n + line.unitPrice * line.quantity, 0),
			discount: lines.reduce((n, line) => n + line.discount, 0),
			delivery,
			tax: 0,
			total: goods + delivery,
			currency: 'USD',
			taxIncluded: true,
		},
		promotions: { released: false, ...promotions },
		payment: {
			method,
			kind: /** @type {any} */ ({ cod: 'on_delivery', online: 'gateway', bank_transfer: 'pay_first', pickup: 'at_pickup' })[
				method
			],
		},
		payments,
		refunds,
		status,
		history,
		stockHeld,
		placedAt,
		deliveredAt,
		...extra,
	};
};

/** @param {number} n @param {string} productId @param {string} variantId @param {Record<string, unknown>} [patch] */
const lineOf = (n, productId, variantId, patch = {}) => ({
	id: idOf('oln', n),
	productId,
	variantId,
	name: 'Phone',
	unitPrice: 2500,
	quantity: 1,
	discount: 0,
	total: 2500,
	...patch,
});

/** @param {string} at @param {string | null} from @param {string} to @param {Record<string, unknown>} [more] */
const step = (at, from, to, more = {}) => ({ at, from, to, by: 'Staff', note: '', ...more });

const customers = () => [
	{
		id: CUS_MEMBER,
		userId: MEMBER,
		name: 'Sara Shopper',
		email: 'Sara@Example.com',
		phone: '+1 (555) 000-1111',
		city: 'Springfield',
	},
	{
		id: CUS_GUEST,
		name: 'Guest Buyer',
		phone: '+15550002222',
		blocked: true,
		blockedReason: 'Refused two packages',
		orderCount: 9,
	},
	// a customer without orders
	{ id: idOf('cus', 3), name: 'Window Shopper', phone: '+15550004444' },
];

const orders = () => [
	orderOf({
		id: DELIVERED,
		number: '2026-000002',
		status: 'delivered',
		customer: { userId: MEMBER, customerId: CUS_MEMBER },
		lines: [lineOf(1, PRODUCT, variants.product, { serials: ['SN-0001'], discount: 250, total: 2250 })],
		promotions: { pointsEarned: 25, pointsCredited: true, pointsRedeemed: 2, pointsValue: 250 },
		history: [
			step('2026-03-01T09:00:00Z', null, 'awaiting_confirmation', { by: 'shopper' }),
			step('2026-03-01T10:00:00Z', 'awaiting_confirmation', 'confirmed'),
			step('2026-03-02T10:00:00Z', 'confirmed', 'packed'),
			step('2026-03-02T12:00:00Z', 'packed', 'dispatched', { shopperNote: ' On its way with Swift Post. ' }),
			step('2026-03-04T12:00:00Z', 'dispatched', 'delivered'),
		],
		payments: [{ id: idOf('opy', 1), method: 'cod', amount: 2550, note: 'Imported', at: '2026-03-04T12:00:00Z' }],
		deliveredAt: '2026-03-04T12:00:00Z',
		extra: { shipment: { courier: 'Swift Post', trackingNumber: 'TRK-1', trackingNote: 'Left at door' } },
	}),
	orderOf({
		id: RETURNED,
		number: '2026-000003',
		status: 'returned',
		customer: { customerId: CUS_GUEST, name: 'Guest Buyer', phone: '+15550002222' },
		lines: [lineOf(2, PRODUCT, variants.product, { serials: ['SN-0002'] })],
		history: [
			step('2026-04-01T09:00:00Z', null, 'awaiting_confirmation', { by: 'guest' }),
			step('2026-04-01T10:00:00Z', 'awaiting_confirmation', 'confirmed'),
			step('2026-04-02T10:00:00Z', 'confirmed', 'packed'),
			step('2026-04-02T12:00:00Z', 'packed', 'dispatched'),
			step('2026-04-06T12:00:00Z', 'dispatched', 'returned', { reason: 'rto' }),
		],
		stockHeld: false,
		placedAt: '2026-04-01T09:00:00Z',
	}),
	orderOf({
		id: CONFIRMED,
		number: '2026-000004',
		status: 'confirmed',
		method: 'bank_transfer',
		customer: { userId: MEMBER, customerId: CUS_MEMBER },
		lines: [lineOf(3, OTHER, variants.other, { unitPrice: 1000, quantity: 2, total: 2000, serials: ['SN-0003'] })],
		history: [
			step('2026-09-01T09:00:00Z', null, 'pending_payment', { by: 'shopper' }),
			step('2026-09-01T11:00:00Z', 'pending_payment', 'confirmed'),
		],
		payments: [
			{
				id: idOf('opy', 2),
				method: 'bank_transfer',
				amount: 2300,
				reference: 'TX-77',
				by: { kind: 'user', id: 'usr_staff0000000001', name: 'Sam Staff' },
				at: '2026-09-01T11:00:00Z',
			},
		],
		placedAt: '2026-09-01T09:00:00Z',
		extra: {
			idempotencyKey: 'checkout-key-1',
			payment: { method: 'bank_transfer', kind: 'pay_first', state: 'paid', paid: 2300 },
		},
	}),
	orderOf({
		id: LAST_YEAR,
		number: '2025-000041',
		status: 'delivered',
		customer: { customerId: CUS_GUEST, name: 'Guest Buyer', phone: '+15550002222' },
		lines: [lineOf(4, OTHER, variants.other, { unitPrice: 1000, quantity: 3, total: 3000, serials: ['SN-0009'] })],
		history: [
			step('2025-12-01T09:00:00Z', null, 'awaiting_confirmation', { by: 'guest' }),
			step('2025-12-05T09:00:00Z', 'awaiting_confirmation', 'delivered'),
		],
		payments: [{ id: idOf('opy', 3), method: 'cod', amount: 3300, at: '2025-12-05T09:00:00Z' }],
		placedAt: '2025-12-01T09:00:00Z',
		deliveredAt: '2025-12-05T09:00:00Z',
	}),
];

const loyalty = () => [
	{
		customerId: CUS_MEMBER,
		userId: MEMBER,
		lots: [
			{
				id: idOf('lot', 1),
				points: 10,
				left: 10,
				earnedAt: '2025-01-01T00:00:00Z',
				expiresAt: '2026-01-01T00:00:00Z',
				kind: 'earn',
			},
			{ id: idOf('lot', 2), points: 25, left: 23, earnedAt: '2026-03-04T12:00:00Z', expiresAt: null, orderId: DELIVERED },
		],
		history: [
			{ at: '2025-01-01T00:00:00Z', kind: 'earn', points: 10, note: '' },
			{ at: '2026-03-01T09:00:00Z', kind: 'redeem', points: 2, orderId: DELIVERED, note: '2026-000002' },
			{ at: '2026-03-04T12:00:00Z', kind: 'earn', points: 25, orderId: DELIVERED, note: '2026-000002' },
		],
		balance: 999,
	},
	{
		customerId: CUS_GUEST,
		lots: [{ id: idOf('lot', 3), points: 5, left: 5, earnedAt: '2025-12-05T09:00:00Z', expiresAt: '2026-10-06T00:00:00Z' }],
		history: [{ at: '2025-12-05T09:00:00Z', kind: 'earn', points: 5, orderId: LAST_YEAR, note: '2025-000041' }],
	},
];

const reviews = () => [
	{
		id: idOf('rev', 1),
		productId: PRODUCT,
		userId: MEMBER,
		orderId: DELIVERED,
		lineId: idOf('oln', 1),
		name: 'Sara S.',
		rating: 4,
		title: 'Good',
		body: 'Works well.',
		status: 'approved',
		createdAt: '2026-03-10T00:00:00Z',
	},
	{ id: idOf('rev', 2), productId: PRODUCT, userId: '', orderId: RETURNED, rating: 1, status: 'pending' },
];

const returns = () => [
	{
		id: idOf('ret', 1),
		reference: 'RR-000001',
		orderId: DELIVERED,
		orderNumber: '2026-000002',
		userId: MEMBER,
		kind: 'warranty',
		lines: [{ lineId: idOf('oln', 1), quantity: 1, serials: ['SN-0001'] }],
		reason: 'Screen flickers',
		status: 'requested',
		history: [{ at: '2026-05-01T00:00:00Z', status: 'requested', by: 'shopper', note: '' }],
	},
];

const alerts = () => [
	{
		id: idOf('alr', 1),
		kind: 'back_in_stock',
		productId: OTHER,
		phone: '+15550002222',
		customerId: CUS_GUEST,
		status: 'waiting',
	},
	{
		id: idOf('alr', 2),
		kind: 'price_drop',
		productId: OTHER,
		userId: MEMBER,
		email: 'sara@example.com',
		price: 1200,
		status: 'sent',
		tokenHash: 'a'.repeat(43),
	},
];

const wishlists = () => [{ userId: MEMBER, productIds: [PRODUCT, OTHER] }];

/** Every collection of this part, in the order the importer sends them. */
const everything = () =>
	/** @type {Array<[string, unknown[]]>} */ ([
		['customers', customers()],
		['orders', orders()],
		['loyalty', loyalty()],
		['reviews', reviews()],
		['returns', returns()],
		['alerts', alerts()],
		['wishlists', wishlists()],
	]);

/** Calls made to the other products so far. */
const outside = () => [NOTIFY, PAYMENTS, ACCOUNTS, GROWTH].map((origin) => shop.callsTo(origin).length);

/** A COD order placed by a signed-in shopper through checkout. @param {string} key */
const placeNew = async (key) => {
	const token = await shop.signIn({ id: 'usr_newshopper000001', phone: '+15550003333' });
	return shop.call('POST', '/v1/shop/orders', {
		token: shop.browser,
		origin: ORIGIN,
		body: { lines: [{ productId: OTHER, quantity: 1 }], payment: 'cod', address: ADDRESS },
		headers: { 'ss-sign-in': token, 'idempotency-key': key, 'x-forwarded-for': `10.9.0.${key.length}` },
	});
};

beforeAll(async () => {
	shop = await readyShop();
	// numbers restart each year, as the imported shop's (2026-000002 …)
	await shop.setting('checkout', 'numberPattern', '{prefix}{year}-{number}');
	data = await shop.db();
	await data.ensureIndexes((await import('../adapters/product.js')).INDEXES);
	await shop.list('item_types', UNIT_TYPES);
	const product = await shop.seedProduct({ id: PRODUCT, slug: 'phone', price: 2500, stock: 5, typeKey: 'numbered' });
	const other = await shop.seedProduct({ id: OTHER, slug: 'case', price: 1000, stock: 5 });
	await shop.seedProduct({ id: idOf('prd', 3), slug: 'spare', price: 500, stock: 1 });
	variants.product = String(product.variants[0]?.id);
	variants.other = String(other.variants[0]?.id);
	// the old shop's counts, as the catalog import gave them: finish keeps what it cannot derive
	for (const [id, sold, rating] of /** @type {const} */ ([
		[PRODUCT, 99, { average: 5, count: 10 }],
		[OTHER, 50, { average: 3.5, count: 4 }],
		[idOf('prd', 3), 7, { average: 4.5, count: 2 }],
	]))
		await data.collection(COLLECTIONS.products).updateOne({ websiteId: shop.websiteId, id }, { $set: { sold, rating } });
	await data.collection(COLLECTIONS.serials).insertMany(
		['SN-0001', 'SN-0002'].map((serial, index) =>
			storedUnit({
				id: idOf('ser', index + 1),
				productId: PRODUCT,
				variantId: variants.product,
				serial,
				status: 'in_stock',
			}),
		),
	);
	// a unit the old shop sold through another order
	await data.collection(COLLECTIONS.serials).insertOne(
		storedUnit({
			id: idOf('ser', 3),
			productId: OTHER,
			variantId: variants.other,
			serial: 'SN-0003',
			status: 'sold',
			orderId: idOf('ord', 99),
			lineId: idOf('oln', 99),
		}),
	);
});
afterAll(async () => shop.product.close());

describe('import of shoppers and orders (K10)', () => {
	it('a dry run reports every refusal, by line and field, and writes nothing', async () => {
		const before = outside();
		const bad = orders();
		const [delivered, returned, confirmed, lastYear] = /** @type {any[]} */ (bad);
		const people = await send(
			'customers',
			[...customers(), { id: idOf('cus', 4), name: 'x'.repeat(121), phone: '12345', websiteId: 'web_other0000000001' }],
			{ dryRun: true },
		);
		expect(people.status).toBe(200);
		expect(people.json).toMatchObject({ inserted: 3, updated: 0, dryRun: true });
		expect(people.json.failed).toEqual([
			{
				line: 4,
				id: idOf('cus', 4),
				errors: expect.arrayContaining([
					{ path: '/websiteId', message: 'websiteId is not a field of a customer: check the mapping.' },
					{ path: '/name', message: 'At most 120 characters (this has 121); text is never cut.' },
					{ path: '/phone', message: expect.stringContaining('country code') },
				]),
			},
		]);
		const dry = await send(
			'orders',
			[
				delivered,
				{ ...returned, status: 'lost', number: 'R-17' },
				{
					...confirmed,
					totals: { ...confirmed.totals, total: 9999 },
					payment: { method: 'bank_transfer', kind: 'pay_first', state: 'paid' },
				},
				{ ...lastYear, deliveredAt: null, stockHeld: undefined, payments: [] },
			],
			{ dryRun: true },
		);
		expect(dry.json).toMatchObject({ inserted: 1, updated: 0, dryRun: true });
		/** @param {number} line */
		const pathsOf = (line) =>
			dry.json.failed.find((/** @type {any} */ f) => f.line === line)?.errors.map((/** @type {any} */ e) => e.path);
		expect(pathsOf(2)).toEqual(expect.arrayContaining(['/number', '/status', '/history/4/to']));
		expect(pathsOf(3)).toEqual(expect.arrayContaining(['/totals/total', '/payment/state']));
		expect(pathsOf(4)).toEqual(expect.arrayContaining(['/deliveredAt', '/stockHeld']));
		for (const [name, records] of everything()) {
			const answer = await send(name, records, { dryRun: true });
			expect(answer.json, name).toMatchObject({ failed: [], dryRun: true });
		}
		for (const name of ['customers', 'orders', 'loyalty', 'reviews', 'returns', 'alerts', 'wishlists'])
			expect(await (await shop.db()).collection(name).countDocuments({ websiteId: shop.websiteId }), name).toBe(0);
		expect(outside()).toEqual(before);
	});

	it('places one order before the import (its counter starts at 1)', async () => {
		const placed = await placeNew('before-import');
		expect(placed.status).toBe(201);
		expect(placed.json.order.number).toBe('2026-000001');
	});

	it('writes each collection in the shop’s own shapes, and a re-run gives the same records', async () => {
		const before = outside();
		for (const [name, records] of everything()) {
			const answer = await send(name, records);
			expect(answer.json, name).toEqual({ inserted: records.length, updated: 0, failed: [], dryRun: false });
		}
		const member = (await all(COLLECTIONS.customers)).find((c) => c.id === CUS_MEMBER);
		expect(member).toMatchObject({
			userId: MEMBER,
			guest: false,
			email: 'sara@example.com',
			phone: '+15550001111',
			phoneDigits: '15550001111',
			orderCount: 0,
		});
		const guest = (await all(COLLECTIONS.customers)).find((c) => c.id === CUS_GUEST);
		expect(guest).toMatchObject({
			userId: null,
			guest: true,
			blocked: true,
			blockedReason: 'Refused two packages',
			orderCount: 0,
		});
		const stored = await (await shop.db()).collection(COLLECTIONS.orders).findOne({ websiteId: shop.websiteId, id: DELIVERED });
		expect(stored).toMatchObject({
			number: '2026-000002',
			role: 'delivered',
			idempotencyKey: `import:${DELIVERED}`,
			phoneDigits: '15550001111',
			placedAt: new Date('2026-03-01T09:00:00Z'),
			createdAt: new Date('2026-03-01T09:00:00Z'),
			deliveredAt: new Date('2026-03-04T12:00:00Z'),
			payment: { method: 'cod', kind: 'on_delivery', state: 'paid', paid: 2550, refunded: 0, paymentId: null },
			payments: [{ id: idOf('opy', 1), amount: 2550, by: { kind: 'server', id: 'server', name: 'Server' } }],
			promotions: { pointsCredited: true, released: false, pointsEarned: 25 },
			shipment: { courier: 'Swift Post', trackingNumber: 'TRK-1', booked: false, trackingNote: 'Left at door' },
			stockHeld: true,
			holdUntil: null,
			seenBy: [],
		});
		expect(stored?.history[4].at).toEqual(new Date('2026-03-04T12:00:00Z'));
		expect(
			(await (await shop.db()).collection(COLLECTIONS.orders).findOne({ websiteId: shop.websiteId, id: RETURNED }))?.role,
		).toBe('returned_to_origin');
		expect(
			(await all(COLLECTIONS.loyalty)).map(({ customerId, userId, balance, lifetimeEarned, version }) => ({
				customerId,
				userId,
				balance,
				lifetimeEarned,
				version,
			})),
		).toEqual([
			{ customerId: CUS_MEMBER, userId: MEMBER, balance: 23, lifetimeEarned: 35, version: 1 },
			{ customerId: CUS_GUEST, userId: null, balance: 5, lifetimeEarned: 5, version: 1 },
		]);
		expect((await all(COLLECTIONS.alerts)).map((alert) => [alert.status, alert.dueAt, alert.userId])).toEqual([
			['waiting', null, ''],
			['sent', null, MEMBER],
		]);
		// stock is neither held nor moved by an import
		const product = await (
			await shop.db()
		)
			.collection(COLLECTIONS.products)
			.findOne({ websiteId: shop.websiteId, id: PRODUCT });
		expect(product?.variants[0].stock).toBe(5);
		expect(outside()).toEqual(before);

		const first = Object.fromEntries(await Promise.all(everything().map(async ([name]) => [name, unstamped(await all(name))])));
		for (const [name, records] of everything())
			expect((await send(name, records)).json, name).toMatchObject({ inserted: 0, updated: records.length, failed: [] });
		for (const [name] of everything()) expect(unstamped(await all(name)), name).toEqual(first[name]);
	});

	it('finish derives counts, balances, units sold, ratings, serials and counters, and a second run changes nothing', async () => {
		const before = outside();
		const summary = await finish();
		expect(summary).toMatchObject({
			finished: true,
			customersUpdated: 2,
			loyaltyUpdated: 0,
			productsSoldRatingUpdated: 2,
			serialsSold: 1,
			serialsMissing: 1,
			serialsOnOtherOrders: 1,
			countersSet: 2,
		});
		const people = await all(COLLECTIONS.customers);
		expect(people.find((c) => c.id === CUS_MEMBER)).toMatchObject({
			orderCount: 2,
			rtoCount: 0,
			lastOrderAt: new Date('2026-09-01T09:00:00Z'),
		});
		expect(people.find((c) => c.id === CUS_GUEST)).toMatchObject({ orderCount: 2, rtoCount: 1 });
		const products = await all(COLLECTIONS.products);
		// order lines and reviews moved: both derived (the pending review counts as a review, not in the rating); units
		// ordered: the delivered order, not the one sent back before delivery (P3-10)
		expect(products.find((p) => p.id === PRODUCT)).toMatchObject({ sold: 1, ordered: 1, rating: { average: 4, count: 1 } });
		// order lines but no review: units derived (ordered: the two open orders' and the delivered one's), the given rating
		// kept
		expect(products.find((p) => p.id === OTHER)).toMatchObject({ sold: 3, ordered: 6, rating: { average: 3.5, count: 4 } });
		// neither: the given numbers kept
		expect(products.find((p) => p.id === idOf('prd', 3))).toMatchObject({ sold: 7, rating: { average: 4.5, count: 2 } });
		expect((await all(COLLECTIONS.serials)).map((s) => [s.serial, s.status, s.orderId, s.lineId])).toEqual([
			['SN-0001', 'sold', DELIVERED, idOf('oln', 1)],
			['SN-0002', 'in_stock', null, null],
			['SN-0003', 'sold', idOf('ord', 99), idOf('oln', 99)],
		]);
		const counters = await all(COLLECTIONS.counters);
		expect(counters.map((c) => [c.id, c.seq]).sort()).toEqual([
			['orders-2025-:', 41],
			['orders-2026-:', 4],
		]);
		const stamps = Object.fromEntries(
			await Promise.all(
				[COLLECTIONS.customers, COLLECTIONS.loyalty, COLLECTIONS.products, COLLECTIONS.serials, COLLECTIONS.counters].map(
					async (name) => [name, (await all(name)).map((record) => record.updatedAt)],
				),
			),
		);
		expect(await finish()).toMatchObject({
			customersUpdated: 0,
			loyaltyUpdated: 0,
			productsSoldRatingUpdated: 0,
			serialsSold: 0,
			countersSet: 0,
		});
		for (const [name, times] of Object.entries(stamps))
			expect(
				(await all(name)).map((record) => record.updatedAt),
				name,
			).toEqual(times);
		expect(outside()).toEqual(before);
	});

	it('counts what verify compares', async () => {
		const status = await shop.call('GET', '/v1/import/status', { token: shop.server });
		expect(status.json.imported).toMatchObject({
			customers: 3,
			orders: 4,
			loyalty: 2,
			reviews: 2,
			returns: 1,
			alerts: 2,
			wishlists: 1,
		});
		expect(status.json.totals).toMatchObject({
			'orders.delivered.count': 2,
			'orders.delivered.total': 2550 + 3300,
			'orders.returned.count': 1,
			'orders.confirmed.count': 1,
			'orders.confirmed.total': 2300,
			'orders.awaiting_confirmation.count': 1,
			customers: 4,
			'loyalty.points': 28,
			reviews: 2,
			returns: 1,
		});
	});

	it('finish writes a balance again once a lot expired, once', async () => {
		shop.advance(15 * 3_600_000);
		expect(await finish()).toMatchObject({ loyaltyUpdated: 1, customersUpdated: 0 });
		expect(await finish()).toMatchObject({ loyaltyUpdated: 0 });
		const guest = (await all(COLLECTIONS.loyalty)).find((account) => account.customerId === CUS_GUEST);
		expect(guest).toMatchObject({ balance: 0, lifetimeEarned: 5, version: 2 });
		const status = await shop.call('GET', '/v1/import/status', { token: shop.server });
		expect(status.json.totals['loyalty.points']).toBe(23);
	});

	it('imported orders read back through the staff routes, move by the flow, and the next order gets the next number', async () => {
		const read = await shop.api('GET', `/v1/orders/${DELIVERED}`);
		expect(read.status).toBe(200);
		expect(read.json).toMatchObject({
			number: '2026-000002',
			statusLabel: 'Delivered',
			payment: { state: 'paid', balanceDue: 0, refundable: 2550 },
			customerFlags: { orderCount: 2 },
			nextStatuses: [{ key: 'refunded' }],
		});
		// the note the earlier shop showed the shopper stays in their timeline (trimmed); the staff note stays internal
		expect(read.json.history[3]).toMatchObject({ to: 'dispatched', shopperNote: 'On its way with Swift Post.' });
		const member = await shop.signIn({ id: MEMBER, email: 'sara@example.com', phone: '+15550001111' });
		const mine = await shop.visitor('GET', `/v1/shop/orders/${DELIVERED}`, { signIn: member });
		expect(mine.status).toBe(200);
		expect(mine.json.history.map((/** @type {any} */ entry) => [entry.status, entry.note])).toEqual([
			['awaiting_confirmation', ''],
			['confirmed', ''],
			['packed', ''],
			['dispatched', 'On its way with Swift Post.'],
			['delivered', ''],
		]);
		const moved = await shop.api('POST', `/v1/orders/${CONFIRMED}/move`, { to: 'packed' });
		expect(moved.status).toBe(200);
		expect(moved.json).toMatchObject({ status: 'packed', role: 'packed', warnings: [] });
		const placed = await placeNew('after-import');
		expect(placed.status).toBe(201);
		expect(placed.json.order.number).toBe('2026-000005');
		const events = await shop.api('GET', '/v1/events');
		const imported = new Set([DELIVERED, RETURNED, LAST_YEAR]);
		expect(events.json.items.filter((/** @type {any} */ e) => imported.has(e.data?.orderId))).toEqual([]);
	});

	it('prunes what the source no longer has, and writes one activity entry per call, never copied', async () => {
		expect(await prune('alerts', { keep: [idOf('alr', 2)] }, { dryRun: true })).toMatchObject({
			removed: 1,
			keys: [idOf('alr', 1)],
		});
		expect(await prune('alerts', { keep: [idOf('alr', 2)] })).toMatchObject({ removed: 1 });
		expect((await all(COLLECTIONS.alerts)).map((alert) => alert.id)).toEqual([idOf('alr', 2)]);
		expect(await prune('loyalty', { keep: [CUS_GUEST] })).toMatchObject({ removed: 1, keys: [CUS_MEMBER] });
		const entries = /** @type {any[]} */ (
			await (
				await shop.db()
			)
				.collection('activity')
				.find({ websiteId: shop.websiteId, action: { $regex: '^import' } })
				.toArray()
		);
		expect(entries.length).toBeGreaterThan(10);
		expect(entries.every((entry) => entry.copy === 'none')).toBe(true);
	});

	it('with one running number, takes numbers of that form only and finish sets the running counter after them', async () => {
		await shop.setting('checkout', 'numberPattern', '{prefix}{number}');
		const last = /** @type {any} */ (orders().find((order) => order.id === LAST_YEAR));
		const running = {
			...last,
			id: idOf('ord', 90),
			number: '000120',
			lines: [lineOf(90, OTHER, variants.other, { unitPrice: 1000, quantity: 3, total: 3000 })],
			payments: [{ ...last.payments[0], id: idOf('opy', 90) }],
		};
		expect((await send('orders', [{ ...running, number: '2026-000120' }], { dryRun: true })).json.failed).toEqual([
			{ line: 1, id: running.id, errors: [{ path: '/number', message: expect.stringContaining('<at least 6 digits>') }] },
		]);
		expect((await send('orders', [running])).json).toMatchObject({ inserted: 1, failed: [] });
		expect(await finish()).toMatchObject({ countersSet: 1 });
		const placed = await placeNew('after-running-import');
		expect(placed.status).toBe(201);
		expect(placed.json.order.number).toBe('000121');
		await shop.setting('checkout', 'numberPattern', '{prefix}{year}-{number}');
	});

	it('reads national phone numbers with the business.json country’s calling code (K12)', async () => {
		const guest = { id: idOf('cus', 5), name: 'Local Buyer', phone: '(555) 000-5555' };
		// no checkout.defaultCallingCode and no country: a national number cannot be read
		expect((await send('customers', [guest], { dryRun: true })).json.failed).toEqual([
			{ line: 1, id: guest.id, errors: [{ path: '/phone', message: expect.stringContaining('business.json country') }] },
		]);
		shop.responders.set(`${ORIGIN}/.well-known/business.json`, () => ({
			status: 200,
			body: { version: 1, name: 'Shop', country: 'US', timeZone: 'UTC' },
		}));
		await shop.dashboard(await shop.adminSession(), 'POST', `/v1/dashboard/websites/${shop.websiteId}/business/refresh`);
		expect((await send('customers', [guest])).json).toMatchObject({ inserted: 1, failed: [] });
		expect((await all(COLLECTIONS.customers)).find((c) => c.id === guest.id)).toMatchObject({
			phone: '+15550005555',
			phoneDigits: '15550005555',
		});
	});
});
