/**
 * Returns and warranty claims, E33: the `returns` settings (kinds with exchange, fixed reasons, the reference prefix,
 * delivery inside the refund cap, points taken back), the `replaced` and `repaired` outcomes, restock per line when
 * received, the refund's method and reference written on the order's `refunds`, staff notes and the
 * `return.requested` hook, through the routes. Delivered orders are placed with the ledger and moved to delivered
 * directly.
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { givePoints, loyaltyAccount, placeOrder } from '../adapters/ledger.js';
import { INDEXES } from '../adapters/product.js';
import { DEFAULT_FLOW } from '../core/flow.js';
import { DEFAULT_CLAIM_KINDS, DEFAULT_CLAIM_STATUSES } from '../core/returns.js';
import { COLLECTIONS } from '../core/model.js';
import {
	actionsOf,
	checkClaimInput,
	checkRefundMethod,
	checkRestockChoices,
	claimReference,
	deliveryLeft,
	holdsUnits,
	refundCap,
} from '../core/returns.js';
import { ALL, PAYMENTS, readyShop, storedOrder, storedUnit } from './helpers.js';

/** Every hook the shop's service emits, in order. */
const hooks = vi.hoisted(() => /** @type {Array<{ name: string, payload: any }>} */ ([]));
vi.mock('../server/service.js', async (original) => {
	const real = /** @type {typeof import('../server/service.js')} */ (await original());
	return {
		...real,
		createService: (/** @type {any} */ product) => {
			const service = real.createService(product);
			return {
				...service,
				/** @type {typeof service.emit} */
				emit: async (name, s, payload) => {
					hooks.push({ name, payload });
					await service.emit(name, s, payload);
				},
			};
		},
	};
});

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
});
afterAll(async () => shop.product.close());
beforeEach(async () => {
	shop.advance(61_000);
	data = await shop.db();
	sara = await shop.signIn();
	ticket = await shop.ticket();
	await offer(['return', 'warranty']);
	await shop.list('claim_statuses', DEFAULT_CLAIM_STATUSES);
	for (const [name, value] of Object.entries({
		reasons: [],
		otherReason: true,
		referencePrefix: 'R-',
		refundDelivery: false,
		pointsBack: 'proportional',
		warrantyTime: 0,
	}))
		await shop.setting('returns', name, value);
});

/**
 * Save the seeded claim kinds, offering shoppers the ones named (E18).
 * @param {string[]} keys
 */
const offer = (keys) =>
	shop.list(
		'claim_kinds',
		DEFAULT_CLAIM_KINDS.map((kind) => ({ ...kind, shoppers: keys.includes(kind.key) })),
	);

/**
 * Place an order for Sara with the ledger and mark it delivered.
 * @param {{ lines: Array<{ product: import('../core/model.js').ProductRecord, quantity?: number, serials?: string[] }>,
 *   delivery?: number, payment?: Partial<import('../core/model.js').OrderRecord['payment']>, pointsEarned?: number }} input
 * @returns {Promise<import('../core/model.js').OrderRecord>}
 */
const order = async ({ lines, delivery = 0, payment = {}, pointsEarned = 0 }) => {
	const id = createId('ord');
	const records = lines.map((line) => {
		const quantity = line.quantity ?? 1;
		const variant = /** @type {import('../core/model.js').VariantRecord} */ (line.product.variants[0]);
		return {
			id: createId('oln'),
			productId: line.product.id,
			variantId: variant.id,
			kind: /** @type {const} */ ('physical'),
			name: line.product.name,
			variantName: '',
			sku: '',
			grade: null,
			gradeLabel: '',
			image: '',
			unitPrice: variant.price,
			quantity,
			discount: 0,
			tax: 0,
			total: variant.price * quantity,
			cost: null,
			categoryIds: [],
			brandId: null,
			locationId: null,
			serials: line.serials ?? [],
			booking: null,
			licences: [],
			returnedQuantity: 0,
		};
	});
	const subtotal = records.reduce((sum, line) => sum + line.total, 0);
	const placed = await placeOrder(
		data,
		{
			numberPrefix: 'T-',
			order: storedOrder({
				id,
				customer: { userId: SARA, name: 'Sara Shopper', email: 'sara@example.com', phone: '' },
				address: {
					name: 'Sara',
					phone: '',
					line1: 'x',
					line2: '',
					city: 'X',
					area: '',
					region: '',
					postalCode: '',
					country: 'XX',
					notes: '',
				},
				delivery: { method: 'delivery', zone: '', rate: '', rateName: '', fee: delivery, locationId: null },
				lines: records,
				totals: { subtotal, discount: 0, delivery, tax: 0, total: subtotal + delivery, currency: 'USD', taxIncluded: true },
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
					kind: 'on_delivery',
					state: 'paid',
					paymentId: null,
					advance: 0,
					paid: subtotal + delivery,
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
				placedAt: new Date(shop.now()),
				deliveredAt: null,
			}),
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
 * Sara claims items of an order (each claim in a fresh minute: visitor writes are rate limited).
 * @param {import('../core/model.js').OrderRecord} placed
 * @param {Record<string, unknown>} body
 */
const claim = async (placed, body) => {
	shop.advance(61_000);
	return shop.visitor('POST', '/v1/shop/returns', {
		signIn: sara,
		key: createId('key'),
		body: {
			orderId: placed.id,
			kind: 'return',
			lines: placed.lines.map((line) => ({ lineId: line.id, quantity: line.quantity })),
			reason: 'Broken',
			...body,
		},
	});
};

/** @param {{ json: any }} answer */
const codeOf = (answer) => String(answer.json.type).split('/').pop();
/** @param {string} id */
const orderOf = async (id) =>
	/** @type {any} */ (await data.collection(COLLECTIONS.orders).findOne({ websiteId: data.websiteId, id }));
/** @param {string} id */
const stockOf = async (id) =>
	/** @type {any} */ (await data.collection(COLLECTIONS.products).findOne({ websiteId: data.websiteId, id })).variants[0].stock;

describe('claim settings', () => {
	it('take only the kinds offered to shoppers and the reasons the shop lists (or Other), keep the prefixed reference and raise return.requested', async () => {
		const item = await shop.seedProduct({ name: 'Headset', price: 800 });
		const placed = await order({ lines: [{ product: item }] });

		await offer(['return']);
		const warranty = await claim(placed, { kind: 'warranty' });
		expect(warranty.status).toBe(422);
		expect(warranty.json.errors[0]).toMatchObject({ path: '/kind', message: 'kind is return.' });
		expect((await claim(placed, { kind: 'exchange' })).json.errors[0].path).toBe('/kind');

		await offer(['return', 'exchange']);
		await shop.setting('returns', 'reasons', ['Damaged', 'Wrong item']);
		await shop.setting('returns', 'otherReason', false);
		await shop.setting('returns', 'referencePrefix', 'RR-');
		// the form reads the kinds offered (with the window each counts in) and the reasons (E17)
		shop.advance(61_000);
		const form = await shop.visitor('GET', `/v1/shop/orders/${placed.id}/returnable`, { signIn: sara });
		expect(form.json).toMatchObject({
			kinds: [
				{ key: 'return', label: 'Return', window: 'return' },
				{ key: 'exchange', label: 'Exchange', window: 'return' },
			],
			reasons: ['Damaged', 'Wrong item'],
			otherReason: false,
		});
		expect((await claim(placed, { kind: 'exchange', reason: 'Changed mind' })).json.errors[0].path).toBe('/reason');
		await shop.setting('returns', 'otherReason', true);
		// the shopper's own words pass with Other offered (here the quantity is what stops it)
		const lineId = /** @type {string} */ (placed.lines[0]?.id);
		const other = await claim(placed, { kind: 'exchange', reason: 'Changed mind', lines: [{ lineId, quantity: 2 }] });
		expect(codeOf(other)).toBe('not_returnable');
		const before = hooks.length;
		const made = await claim(placed, { kind: 'exchange', reason: 'Damaged' });
		expect(made.status).toBe(201);
		expect(made.json).toMatchObject({
			kind: 'exchange',
			kindLabel: 'Exchange',
			reason: 'Damaged',
			status: 'requested',
			statusLabel: 'Requested',
			role: 'requested',
		});
		expect(made.json.reference).toBe(`RR-${made.json.id.slice(-6).toUpperCase()}`);
		expect(shop.messages().at(-1)).toMatchObject({
			template: 'ecommerce.return_status',
			// the merchant's names of the kind and status, and the shopper's reason
			values: { claim: made.json.reference, kind: 'Exchange', status: 'Requested', reason: 'Damaged' },
		});
		const raised = hooks.slice(before).filter((hook) => hook.name === 'return.requested');
		expect(raised).toHaveLength(1);
		expect(raised[0]?.payload).toMatchObject({ claim: { id: made.json.id, kind: 'exchange' }, order: { id: placed.id } });

		// the reference stays as it was made when the prefix changes
		await shop.setting('returns', 'referencePrefix', 'X-');
		const read = await shop.api('GET', `/v1/returns/${made.json.id}`);
		expect(read.json).toMatchObject({ reference: made.json.reference, kind: 'exchange', notes: [] });
		const list = await shop.api('GET', `/v1/returns?kind=exchange&orderId=${placed.id}`);
		expect(list.json.items.map((/** @type {any} */ c) => c.id)).toEqual([made.json.id]);
	});
});

describe('claim outcomes and notes', () => {
	it('replace an exchange, repair a warranty claim (both final) and keep staff notes from the shopper', async () => {
		await offer(['return', 'warranty', 'exchange']);
		await shop.setting('returns', 'warrantyTime', 30);
		const item = await shop.seedProduct({ name: 'Watch', price: 2000 });
		const swapped = await order({ lines: [{ product: item }] });
		const exchange = await claim(swapped, { kind: 'exchange' });
		const id = exchange.json.id;
		const approved = await shop.api('POST', `/v1/returns/${id}/approve`, {});
		expect(approved.json.actions).toEqual(['reject', 'receive', 'refund', 'replace', 'close', 'restock']);
		expect(codeOf(await shop.api('POST', `/v1/returns/${id}/repair`, {}))).toBe('move_not_allowed');
		const replaced = await shop.admin(ticket, 'POST', `/v1/admin/returns/${id}/replace`, { note: 'New one sent' });
		expect(replaced.status).toBe(200);
		expect(replaced.json).toMatchObject({ status: 'replaced', actions: ['restock'] });
		expect(replaced.json.history.at(-1)).toMatchObject({ status: 'replaced', by: 'Sam Staff', note: 'New one sent' });
		expect(shop.messages().at(-1)).toMatchObject({ values: { status: 'Replaced' } });
		for (const action of ['close', 'refund', 'reject', 'replace'])
			expect(codeOf(await shop.api('POST', `/v1/returns/${id}/${action}`, { amount: 1, note: 'x' }))).toBe('move_not_allowed');
		expect((await shop.api('GET', `/v1/returns?status=replaced&orderId=${swapped.id}`)).json.items).toHaveLength(1);

		const fixed = await order({ lines: [{ product: item }] });
		const warranty = await claim(fixed, { kind: 'warranty' });
		await shop.api('POST', `/v1/returns/${warranty.json.id}/approve`, {});
		await shop.api('POST', `/v1/returns/${warranty.json.id}/receive`, {});
		const repaired = await shop.api('POST', `/v1/returns/${warranty.json.id}/repair`, {});
		expect(repaired.json).toMatchObject({ status: 'repaired', actions: [] });
		// a repaired item went back to the shopper: it can be claimed again
		expect((await claim(fixed, { kind: 'warranty' })).status).toBe(201);

		// staff notes, on both routes, never shown to the shopper
		expect((await shop.api('POST', `/v1/returns/${id}/notes`, { text: ' ' })).json.errors[0].path).toBe('/text');
		expect((await shop.api('POST', `/v1/returns/${id}/notes`, { text: 'x'.repeat(1001) })).status).toBe(422);
		expect((await shop.api('POST', '/v1/returns/ret_missing/notes', { text: 'Hi' })).status).toBe(404);
		const noted = await shop.api('POST', `/v1/returns/${id}/notes`, { text: 'Called the shopper' });
		expect(noted.status).toBe(201);
		expect(noted.json.notes).toEqual([{ at: expect.any(String), by: 'Server', text: 'Called the shopper' }]);
		const twice = await shop.admin(ticket, 'POST', `/v1/admin/returns/${id}/notes`, { text: 'Courier booked' });
		expect(twice.json.notes.map((/** @type {any} */ n) => [n.by, n.text])).toEqual([
			['Server', 'Called the shopper'],
			['Sam Staff', 'Courier booked'],
		]);
		expect(twice.json.status).toBe('replaced');
		const mine = await shop.visitor('GET', '/v1/shop/returns', { signIn: sara });
		const seen = mine.json.items.find((/** @type {any} */ c) => c.id === id);
		expect(seen).toBeDefined();
		expect(seen.notes).toBeUndefined();
		expect(JSON.stringify(seen)).not.toContain('Called the shopper');
	});
});

describe('restock per line', () => {
	it('restocks the lines staff choose when received, each once, and leaves the rest out or for later', async () => {
		const phone = await shop.seedProduct({ name: 'Phone B', price: 3000, stock: 4 });
		const cover = await shop.seedProduct({ name: 'Cover', price: 200, stock: 10 });
		const placed = await order({
			lines: [
				{ product: phone, serials: ['SN-B1'] },
				{ product: cover, quantity: 2 },
			],
		});
		await data.collection(COLLECTIONS.serials).insertOne(
			storedUnit({
				id: createId('ser'),
				productId: phone.id,
				serial: 'SN-B1',
				status: 'sold',
				orderId: placed.id,
				lineId: 'x',
			}),
		);
		const [phoneLine, coverLine] = /** @type {[string, string]} */ (placed.lines.map((line) => line.id));
		const made = await claim(placed, {});
		const id = made.json.id;
		await shop.api('POST', `/v1/returns/${id}/approve`, {});
		const phoneStock = await stockOf(phone.id);
		const coverStock = await stockOf(cover.id);

		expect((await shop.api('POST', `/v1/returns/${id}/receive`, { lines: 'all' })).json.errors[0].path).toBe('/lines');
		expect(
			(await shop.api('POST', `/v1/returns/${id}/receive`, { lines: [{ lineId: 'oln_other', restock: true }] })).json.errors[0]
				.path,
		).toBe('/lines/0/lineId');
		expect(
			(
				await shop.api('POST', `/v1/returns/${id}/receive`, {
					lines: [
						{ lineId: phoneLine, restock: true },
						{ lineId: phoneLine, restock: false },
					],
				})
			).json.errors[0].path,
		).toBe('/lines/1/lineId');
		expect(
			(await shop.api('POST', `/v1/returns/${id}/receive`, { lines: [{ lineId: phoneLine, restock: 'yes' }] })).json.errors[0]
				.path,
		).toBe('/lines/0/restock');
		expect((await shop.api('GET', `/v1/returns/${id}`)).json.status).toBe('approved');

		const received = await shop.admin(ticket, 'POST', `/v1/admin/returns/${id}/receive`, {
			lines: [
				{ lineId: phoneLine, restock: true },
				{ lineId: coverLine, restock: false },
			],
		});
		expect(received.status).toBe(200);
		expect(received.json.status).toBe('received');
		expect(received.json.lines).toMatchObject([
			{ lineId: phoneLine, restock: true, restockedAt: expect.any(String) },
			{ lineId: coverLine, restock: false, restockedAt: null },
		]);
		expect(received.json.restockedAt).not.toBeNull();
		expect(received.json.actions).not.toContain('restock');
		expect(received.json.history.at(-1)).toMatchObject({ note: 'restocked', code: 'restocked' });
		// the shopper never sees the shop's own note as a reply
		const mine = await shop.visitor('GET', '/v1/shop/returns', { signIn: sara });
		expect(mine.json.items.find((/** @type {any} */ c) => c.id === id).history.at(-1)).toMatchObject({
			status: 'received',
			note: '',
		});
		expect(await stockOf(phone.id)).toBe(phoneStock + 1);
		expect(await stockOf(cover.id)).toBe(coverStock);
		const serial = /** @type {any} */ (
			await data.collection(COLLECTIONS.serials).findOne({ websiteId: data.websiteId, serial: 'SN-B1' })
		);
		expect(serial.status).toBe('in_stock');
		expect(codeOf(await shop.api('POST', `/v1/returns/${id}/restock`, {}))).toBe('conflict');

		// a line not named when received is restocked later, once (placing the order took one phone and two covers)
		const second = await order({ lines: [{ product: phone }, { product: cover, quantity: 2 }] });
		const [secondPhone, secondCover] = /** @type {[string, string]} */ (second.lines.map((line) => line.id));
		const later = await claim(second, {});
		await shop.api('POST', `/v1/returns/${later.json.id}/approve`, {});
		const partly = await shop.api('POST', `/v1/returns/${later.json.id}/receive`, {
			lines: [{ lineId: secondPhone, restock: true }],
		});
		expect(partly.json.restockedAt).toBeNull();
		expect(partly.json.actions).toContain('restock');
		expect(await stockOf(phone.id)).toBe(phoneStock + 1);
		const rest = await shop.api('POST', `/v1/returns/${later.json.id}/restock`, {});
		expect(rest.status).toBe(200);
		expect(rest.json.lines).toMatchObject([
			{ lineId: secondPhone, restockedAt: expect.any(String) },
			{ lineId: secondCover, restockedAt: expect.any(String) },
		]);
		expect(rest.json.restockedAt).not.toBeNull();
		expect(await stockOf(phone.id)).toBe(phoneStock + 1);
		expect(await stockOf(cover.id)).toBe(coverStock);
		expect(codeOf(await shop.api('POST', `/v1/returns/${later.json.id}/restock`, {}))).toBe('conflict');
		expect(await stockOf(cover.id)).toBe(coverStock);
	});
});

describe('a returned unit goes back in stock once (OR-10)', () => {
	it('whether its claim or the order’s return restocks it first', async () => {
		await shop.list('order_flow', {
			statuses: [...DEFAULT_FLOW.statuses, { key: 'customer-returned', label: 'Returned', role: 'returned' }],
			moves: [...DEFAULT_FLOW.moves, { from: 'delivered', to: 'customer-returned' }],
		});
		const phone = await shop.seedProduct({ name: 'Phone', price: 1000, stock: 5 });
		/** Make, approve and (optionally) receive a claim of the whole order. @param {any} placed @param {boolean} restock */
		const claimOf = async (placed, restock) => {
			const made = await claim(placed, {});
			await shop.api('POST', `/v1/returns/${made.json.id}/approve`, {});
			if (restock)
				await shop.api('POST', `/v1/returns/${made.json.id}/receive`, {
					lines: [{ lineId: placed.lines[0].id, restock: true }],
				});
			return made.json.id;
		};
		// the claim first: the order's return puts nothing back again
		const first = await order({ lines: [{ product: phone }] });
		expect(await stockOf(phone.id)).toBe(4);
		await claimOf(first, true);
		expect(await stockOf(phone.id)).toBe(5);
		expect((await shop.api('POST', `/v1/orders/${first.id}/move`, { to: 'customer-returned' })).status).toBe(200);
		expect(await stockOf(phone.id)).toBe(5);
		// the order's return first: the claim puts nothing back again
		const second = await order({ lines: [{ product: phone }] });
		expect(await stockOf(phone.id)).toBe(4);
		const id = await claimOf(second, false);
		expect((await shop.api('POST', `/v1/orders/${second.id}/move`, { to: 'customer-returned' })).status).toBe(200);
		expect(await stockOf(phone.id)).toBe(5);
		const received = await shop.api('POST', `/v1/returns/${id}/receive`, {
			lines: [{ lineId: second.lines[0]?.id, restock: true }],
		});
		expect(received.json.lines[0].restockedAt).toEqual(expect.any(String));
		expect(await stockOf(phone.id)).toBe(5);
		// the default moves again; the customer-returned status keeps its orders, so it stays in the flow
		await shop.list('order_flow', {
			statuses: [...DEFAULT_FLOW.statuses, { key: 'customer-returned', label: 'Returned', role: 'returned' }],
			moves: DEFAULT_FLOW.moves,
		});
	});
});

describe('claim refunds', () => {
	it('record the method and reference on the order, keep delivery out of the cap unless allowed, and once', async () => {
		const shoes = await shop.seedProduct({ name: 'Shoes', price: 1000 });
		const placed = await order({ lines: [{ product: shoes }, { product: shoes }], delivery: 500 });
		const [first, second] = /** @type {[string, string]} */ (placed.lines.map((line) => line.id));
		const a = await claim(placed, { lines: [{ lineId: first, quantity: 1 }] });
		const b = await claim(placed, { lines: [{ lineId: second, quantity: 1 }] });
		for (const made of [a, b]) await shop.api('POST', `/v1/returns/${made.json.id}/approve`, {});
		expect((await shop.api('GET', `/v1/returns/${a.json.id}`)).json.refundable).toBe(1000);
		expect((await shop.api('POST', `/v1/returns/${a.json.id}/refund`, { amount: 1001 })).json.errors[0].path).toBe('/amount');

		const refund = (/** @type {string} */ id, /** @type {Record<string, unknown>} */ body) =>
			shop.api('POST', `/v1/returns/${id}/refund`, body);
		expect((await refund(a.json.id, { amount: 100, method: 'payments' })).json.errors[0].path).toBe('/method');
		expect((await refund(a.json.id, { amount: 100, method: 'cheque' })).json.errors[0].path).toBe('/method');
		expect((await refund(a.json.id, { amount: 100, reference: 'x'.repeat(121) })).json.errors[0].path).toBe('/reference');
		expect((await refund(a.json.id, { amount: 100, reference: 7 })).json.errors[0].path).toBe('/reference');

		await shop.setting('returns', 'refundDelivery', true);
		expect((await shop.api('GET', `/v1/returns/${a.json.id}`)).json.refundable).toBe(1500);
		const before = shop.callsTo(PAYMENTS).length;
		const done = await shop.admin(ticket, 'POST', `/v1/admin/returns/${a.json.id}/refund`, {
			amount: 1500,
			method: 'bank_transfer',
			reference: ' TX-1 ',
			note: 'With delivery',
		});
		expect(done.status).toBe(200);
		expect(done.json).toMatchObject({
			status: 'refunded',
			refundAmount: 1500,
			refundMethod: 'bank_transfer',
			refundReference: 'TX-1',
			refundId: null,
			refundable: 0,
		});
		expect(shop.callsTo(PAYMENTS).length).toBe(before);
		let stored = await orderOf(placed.id);
		expect(stored.payment).toMatchObject({ refunded: 1500, state: 'partially_refunded' });
		expect(stored.refunds).toEqual([
			{
				id: expect.stringMatching(/^orf_/),
				method: 'bank_transfer',
				amount: 1500,
				reference: 'TX-1',
				claimId: a.json.id,
				note: 'With delivery',
				by: expect.objectContaining({ name: 'Sam Staff' }),
				at: expect.any(Date),
				refundId: null,
			},
		]);
		// the delivery fee went back with the first claim: the second is capped at its line
		expect((await shop.api('GET', `/v1/returns/${b.json.id}`)).json.refundable).toBe(1000);
		const plain = await refund(b.json.id, { amount: 1000 });
		expect(plain.json).toMatchObject({ refundMethod: 'other', refundReference: '' });
		stored = await orderOf(placed.id);
		expect(stored.payment).toMatchObject({ refunded: 2500, state: 'refunded' });
		expect(stored.refunds.map((/** @type {any} */ r) => [r.claimId, r.method, r.amount])).toEqual([
			[a.json.id, 'bank_transfer', 1500],
			[b.json.id, 'other', 1000],
		]);
		// shoppers see the refunds on their order
		const mine = await shop.visitor('GET', `/v1/shop/orders/${placed.id}`, { signIn: sara });
		expect(JSON.stringify(mine.json)).toContain('TX-1');
	});

	it('go through Payments only for online refunds of orders paid online', async () => {
		const tv = await shop.seedProduct({ name: 'TV', price: 5000 });
		const placed = await order({
			lines: [{ product: tv }],
			payment: { method: 'online', kind: 'gateway', state: 'paid', paymentId: 'pay_000000000077', paid: 5000 },
		});
		const made = await claim(placed, {});
		await shop.api('POST', `/v1/returns/${made.json.id}/approve`, {});
		const online = await shop.api('POST', `/v1/returns/${made.json.id}/refund`, { amount: 3000, reference: 'Web' });
		expect(online.json).toMatchObject({ refundMethod: 'payments', refundId: expect.stringMatching(/^rfd_/) });
		expect(shop.callsTo(`${PAYMENTS}/v1/payments/pay_000000000077/refunds`)).toHaveLength(1);
		const cash = await shop.api('POST', `/v1/returns/${made.json.id}/refund`, { amount: 2000, method: 'cod' });
		expect(cash.json).toMatchObject({ refundMethod: 'cod', refundAmount: 5000 });
		expect(shop.callsTo(`${PAYMENTS}/v1/payments/pay_000000000077/refunds`)).toHaveLength(1);
		const stored = await orderOf(placed.id);
		expect(stored.refunds.map((/** @type {any} */ r) => [r.method, r.amount, r.refundId])).toEqual([
			['payments', 3000, expect.stringMatching(/^rfd_/)],
			['cod', 2000, null],
		]);
		// refunded without a note: the claim's reference, in the order's history too (PLAN 0.4.10)
		const reference = made.json.reference;
		expect(stored.refunds.map((/** @type {any} */ r) => r.note)).toEqual([`Claim ${reference}`, `Claim ${reference}`]);
		expect(stored.history.slice(-2).map((/** @type {any} */ e) => [e.code, e.values])).toEqual([
			['claim_refunded', { amount: 3000, reference }],
			['claim_refunded_recorded', { amount: 2000, reference }],
		]);
		expect(stored.payment).toMatchObject({ refunded: 5000, state: 'refunded' });

		// Payments refusing undoes the claim's refund, method and reference
		const again = await order({
			lines: [{ product: tv }],
			payment: { method: 'online', kind: 'gateway', state: 'paid', paymentId: 'pay_000000000078', paid: 5000 },
		});
		const refused = await claim(again, {});
		await shop.api('POST', `/v1/returns/${refused.json.id}/approve`, {});
		shop.responders.set(`${PAYMENTS}/v1/payments/pay_000000000078/refunds`, () => ({ status: 400, body: { detail: 'No' } }));
		expect((await shop.api('POST', `/v1/returns/${refused.json.id}/refund`, { amount: 100 })).status).toBeGreaterThan(499);
		const kept = await shop.api('GET', `/v1/returns/${refused.json.id}`);
		expect(kept.json).toMatchObject({ status: 'approved', refundAmount: 0, refundMethod: null, refundReference: '' });
		expect((await orderOf(again.id)).refunds ?? []).toEqual([]);
	});

	it('take points back in proportion, or only once the order is fully refunded', async () => {
		const lamp = await shop.seedProduct({ name: 'Lamp', price: 1000 });
		const balance = async () => (await loyaltyAccount(data, SARA, { now: shop.now() })).balance;
		const earn = async (/** @type {string} */ orderId) =>
			givePoints(data, { userId: SARA, points: 20, orderId, kind: 'earn', expiresAt: null }, { now: shop.now() });

		const proportional = await order({ lines: [{ product: lamp }, { product: lamp }], pointsEarned: 20 });
		await earn(proportional.id);
		const start = await balance();
		const part = await claim(proportional, { lines: [{ lineId: proportional.lines[0]?.id, quantity: 1 }] });
		await shop.api('POST', `/v1/returns/${part.json.id}/approve`, {});
		await shop.api('POST', `/v1/returns/${part.json.id}/refund`, { amount: 500 });
		expect(await balance()).toBe(start - 10);
		await shop.api('POST', `/v1/returns/${part.json.id}/refund`, { amount: 500 });
		expect(await balance()).toBe(start - 10);

		await shop.setting('returns', 'pointsBack', 'full_refund_only');
		const whole = await order({ lines: [{ product: lamp }, { product: lamp }], pointsEarned: 20 });
		await earn(whole.id);
		const held = await balance();
		const [first, second] = /** @type {[string, string]} */ (whole.lines.map((line) => line.id));
		const a = await claim(whole, { lines: [{ lineId: first, quantity: 1 }] });
		const b = await claim(whole, { lines: [{ lineId: second, quantity: 1 }] });
		for (const made of [a, b]) await shop.api('POST', `/v1/returns/${made.json.id}/approve`, {});
		await shop.api('POST', `/v1/returns/${a.json.id}/refund`, { amount: 1000 });
		expect(await balance()).toBe(held);
		await shop.api('POST', `/v1/returns/${b.json.id}/refund`, { amount: 600 });
		expect(await balance()).toBe(held);
		await shop.api('POST', `/v1/returns/${b.json.id}/refund`, { amount: 400 });
		expect((await orderOf(whole.id)).payment.state).toBe('refunded');
		expect(await balance()).toBe(held - 20);
	});

	it("take a guest order's points back from the guest's own record (by customer id)", async () => {
		const lamp = await shop.seedProduct({ name: 'Guest lamp', price: 1000 });
		const placed = await order({ lines: [{ product: lamp }], pointsEarned: 30 });
		const customerId = 'cus_guestclaim0001';
		await data
			.collection(COLLECTIONS.orders)
			.updateOne(
				{ websiteId: data.websiteId, id: placed.id },
				{ $set: { 'customer.userId': '', 'customer.customerId': customerId } },
			);
		const guest = { customerId };
		await givePoints(
			data,
			{ userId: guest, points: 30, orderId: placed.id, kind: 'earn', expiresAt: null },
			{ now: shop.now() },
		);
		// a claim on the guest's order (staff take it by phone; shoppers claim signed in)
		const id = createId('ret');
		await data.collection(COLLECTIONS.returns).insertOne({
			id,
			orderId: placed.id,
			orderNumber: placed.number,
			userId: '',
			kind: 'return',
			window: 'return',
			outcomes: ['refund'],
			lines: [{ lineId: placed.lines[0]?.id, quantity: 1, serials: [] }],
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
		const done = await shop.api('POST', `/v1/returns/${id}/refund`, { amount: 1000, method: 'cod' });
		expect(done.status).toBe(200);
		expect((await loyaltyAccount(data, guest, { now: shop.now() })).balance).toBe(0);
		expect((await orderOf(placed.id)).promotions.pointsReversed).toBe(30);
	});

	it('move a fully refunded order to refunded with the refundsCover trigger, its points settled once (OR-3, OR-10, K-23)', async () => {
		await shop.flow((flow) => ({ ...flow, triggers: { ...flow.triggers, refundsCover: 'refunded' } }));
		const desk = await shop.seedProduct({ name: 'Desk', price: 2000 });
		const balance = async () => (await loyaltyAccount(data, SARA, { now: shop.now() })).balance;
		const placed = await order({ lines: [{ product: desk }], pointsEarned: 20 });
		// it earned 20 points and the shopper paid 50 points with it
		await data
			.collection(COLLECTIONS.orders)
			.updateOne({ websiteId: data.websiteId, id: placed.id }, { $set: { 'promotions.pointsRedeemed': 50 } });
		await givePoints(
			data,
			{ userId: SARA, points: 20, orderId: placed.id, kind: 'earn', expiresAt: null },
			{ now: shop.now() },
		);
		const start = await balance();
		const made = await claim(placed, {});
		await shop.api('POST', `/v1/returns/${made.json.id}/approve`, {});
		const sent = shop.messages().length;
		const done = await shop.api('POST', `/v1/returns/${made.json.id}/refund`, { amount: 2000, method: 'cod' });
		expect(done.status).toBe(200);
		const stored = await orderOf(placed.id);
		expect(stored).toMatchObject({ status: 'refunded', payment: { refunded: 2000, state: 'refunded' } });
		expect(stored.promotions).toMatchObject({ released: true, pointsReversed: 20 });
		// earned points taken back once, redeemed ones given back once
		expect(await balance()).toBe(start - 20 + 50);
		expect(
			shop
				.messages()
				.slice(sent)
				.map((m) => m.template),
		).toEqual(expect.arrayContaining(['ecommerce.order_status', 'ecommerce.return_status']));
		await shop.flow((flow) => ({ ...flow, triggers: { ...flow.triggers, refundsCover: '' } }));
	});
});

describe('merchant claim kinds and statuses (E18)', () => {
	it('checks the lists: kinds with a window and outcomes, statuses on fixed roles with every role covered', async () => {
		await expect(shop.list('claim_kinds', [{ key: 'swap', label: 'Swap', outcomes: [] }])).rejects.toThrow(/outcomes/);
		await expect(
			shop.list('claim_kinds', [{ key: 'swap', label: 'Swap', window: 'later', outcomes: ['refund'] }]),
		).rejects.toThrow(/window/);
		await expect(
			shop.list(
				'claim_statuses',
				DEFAULT_CLAIM_STATUSES.filter((status) => status.role !== 'credited'),
			),
		).rejects.toThrow(/credited has none/);
		await expect(
			shop.list('claim_statuses', [...DEFAULT_CLAIM_STATUSES, { key: 'lost', label: 'Lost', role: 'gone' }]),
		).rejects.toThrow(/role/);
	});

	it('moves claims into the merchant statuses, between statuses of one role, and keeps statuses that have claims', async () => {
		await shop.list('claim_statuses', [
			{ key: 'requested', label: 'New request', role: 'requested' },
			{ key: 'approved', label: 'Approved', role: 'approved' },
			{ key: 'label_sent', label: 'Return label sent', role: 'approved' },
			...DEFAULT_CLAIM_STATUSES.filter((status) => status.role !== 'requested' && status.role !== 'approved'),
		]);
		const item = await shop.seedProduct({ name: 'Kettle', price: 900 });
		const placed = await order({ lines: [{ product: item }] });
		const made = await claim(placed, {});
		expect(made.json).toMatchObject({ status: 'requested', statusLabel: 'New request', role: 'requested' });
		const id = made.json.id;
		// an approve into a named status of the role, else the role's first
		expect((await shop.api('POST', `/v1/returns/${id}/approve`, { status: 'received' })).json.errors[0].path).toBe('/status');
		const approved = await shop.api('POST', `/v1/returns/${id}/approve`, {});
		expect(approved.json).toMatchObject({
			status: 'approved',
			role: 'approved',
			statuses: [{ key: 'label_sent', label: 'Return label sent' }],
		});
		// a move inside the role, told to the shopper by its name
		expect((await shop.api('POST', `/v1/returns/${id}/status`, { status: 'received' })).status).toBe(422);
		expect((await shop.api('POST', `/v1/returns/${id}/status`, { status: 'approved' })).status).toBe(422);
		const sent = await shop.admin(ticket, 'POST', `/v1/admin/returns/${id}/status`, {
			status: 'label_sent',
			note: 'Label emailed',
		});
		expect(sent.status).toBe(200);
		expect(sent.json).toMatchObject({
			status: 'label_sent',
			role: 'approved',
			actions: ['reject', 'receive', 'refund', 'close', 'restock'],
		});
		expect(sent.json.history.at(-1)).toMatchObject({
			status: 'label_sent',
			statusLabel: 'Return label sent',
			role: 'approved',
		});
		expect(shop.messages().at(-1)).toMatchObject({ values: { status: 'Return label sent' } });
		// filters by status and role; counts by role
		expect((await shop.api('GET', `/v1/returns?status=label_sent&orderId=${placed.id}`)).json.items).toHaveLength(1);
		expect((await shop.api('GET', `/v1/returns?role=approved&orderId=${placed.id}`)).json.items).toHaveLength(1);
		const byRole = await shop.api('GET', `/v1/returns/counts?by=role&orderId=${placed.id}`);
		expect(byRole.status).toBe(200);
		const lists = await shop.admin(ticket, 'GET', '/v1/admin/returns/lists');
		expect(lists.json.statuses.map((/** @type {any} */ status) => status.key)).toContain('label_sent');
		expect(lists.json.kinds.map((/** @type {any} */ kind) => kind.key)).toEqual(['return', 'warranty', 'exchange']);
		// a status with claims stays with its role
		await expect(
			shop.list(
				'claim_statuses',
				DEFAULT_CLAIM_STATUSES.map((status) => ({ ...status })),
			),
		).rejects.toThrow(/label_sent/);
		// the shopper reads the merchant's names
		const mine = await shop.visitor('GET', '/v1/shop/returns', { signIn: sara });
		expect(mine.json.items.find((/** @type {any} */ c) => c.id === id)).toMatchObject({
			statusLabel: 'Return label sent',
			kindLabel: 'Return',
		});
		// moved on, the status is free to go
		await shop.api('POST', `/v1/returns/${id}/reject`, { note: 'Not sent back' });
		await shop.list('claim_statuses', DEFAULT_CLAIM_STATUSES);
	});

	it('gives store credit as a one-use code when the kind allows it, within the cap, with the code in the message', async () => {
		await shop.list('claim_kinds', [
			{ key: 'return', label: 'Return', window: 'return', outcomes: ['refund', 'store_credit'], shoppers: true },
			{ key: 'swap', label: 'Swap', window: 'return', outcomes: ['replace'], shoppers: true },
		]);
		const item = await shop.seedProduct({ name: 'Blender', price: 2000 });
		const placed = await order({ lines: [{ product: item, quantity: 2 }] });
		const lineId = /** @type {string} */ (placed.lines[0]?.id);
		const swap = await claim(placed, { kind: 'swap', lines: [{ lineId, quantity: 1 }] });
		await shop.api('POST', `/v1/returns/${swap.json.id}/approve`, {});
		// a kind without store credit cannot give it
		expect(codeOf(await shop.api('POST', `/v1/returns/${swap.json.id}/credit`, { amount: 100 }))).toBe('move_not_allowed');

		const made = await claim(placed, { lines: [{ lineId, quantity: 1 }] });
		const id = made.json.id;
		const approved = await shop.api('POST', `/v1/returns/${id}/approve`, {});
		expect(approved.json).toMatchObject({ actions: ['reject', 'receive', 'refund', 'credit', 'close', 'restock'] });
		const detail = await shop.api('GET', `/v1/returns/${id}`);
		expect(detail.json).toMatchObject({ creditable: 2000, refundable: 2000 });
		expect((await shop.api('POST', `/v1/returns/${id}/credit`, { amount: 2001 })).json.errors[0].path).toBe('/amount');
		const credited = await shop.admin(ticket, 'POST', `/v1/admin/returns/${id}/credit`, { amount: 1500 });
		expect(credited.status).toBe(200);
		expect(credited.json).toMatchObject({
			role: 'credited',
			status: 'credited',
			creditAmount: 1500,
			creditable: 500,
			refundable: 500,
		});
		const [code] = credited.json.creditCodes;
		expect(code).toMatch(/^CREDIT-[A-Z0-9]{8}$/);
		expect(shop.messages().at(-1)).toMatchObject({
			template: 'ecommerce.return_status',
			values: { status: 'Store credit given', credit: 'USD 15.00', creditCode: code, amount: '' },
		});
		// the code is a one-use fixed coupon the shopper spends at checkout
		const coupon = /** @type {any} */ (await data.collection(COLLECTIONS.coupons).findOne({ websiteId: data.websiteId, code }));
		expect(coupon).toMatchObject({ type: 'fixed', value: 1500, limit: 1, used: 0, active: true });
		// the units count as returned on the first money back, once
		expect((await orderOf(placed.id)).lines[0].returnedQuantity).toBe(1);
		const more = await shop.api('POST', `/v1/returns/${id}/credit`, { amount: 500 });
		expect(more.json).toMatchObject({ creditAmount: 2000, creditable: 0 });
		expect(more.json.creditCodes).toHaveLength(2);
		expect((await orderOf(placed.id)).lines[0].returnedQuantity).toBe(1);
		const mine = await shop.visitor('GET', '/v1/shop/returns', { signIn: sara });
		expect(mine.json.items.find((/** @type {any} */ c) => c.id === id)).toMatchObject({ creditAmount: 2000 });
	});

	it('refuses store credit while Coupons is off', async () => {
		await shop.list('claim_kinds', [
			{ key: 'return', label: 'Return', window: 'return', outcomes: ['store_credit'], shoppers: true },
		]);
		const item = await shop.seedProduct({ name: 'Toaster', price: 1000 });
		const placed = await order({ lines: [{ product: item }] });
		const made = await claim(placed, {});
		await shop.api('POST', `/v1/returns/${made.json.id}/approve`, {});
		await shop.switchOn(ALL.filter((feature) => feature !== 'coupons'));
		try {
			expect(codeOf(await shop.api('POST', `/v1/returns/${made.json.id}/credit`, { amount: 100 }))).toBe('feature_off');
		} finally {
			await shop.switchOn(ALL);
		}
	});
});

describe('claim rules', () => {
	it('check kinds, reasons, refund methods, restock choices and the delivery left', () => {
		const body = { orderId: 'ord_1', kind: 'exchange', lines: [{ lineId: 'oln_1', quantity: 1 }], reason: 'Damaged' };
		// the seeded kinds: exchange is made by staff only
		expect(checkClaimInput(body, { maxPhotos: 0 })).toMatchObject({ field: 'kind', message: 'kind is return or warranty.' });
		expect(checkClaimInput(body, { maxPhotos: 0, kinds: [] })).toMatchObject({ message: 'kind is not open.' });
		const exchange = [{ key: 'exchange', shoppers: true }];
		expect(checkClaimInput(body, { maxPhotos: 0, kinds: exchange, reasons: ['Damaged'] })).toMatchObject({ ok: true });
		// a reason of the shopper's own words: taken with "Other" offered, refused without (E17)
		const own = { ...body, reason: 'The color is not as shown' };
		expect(checkClaimInput(own, { maxPhotos: 0, kinds: exchange, reasons: ['Damaged'] })).toMatchObject({ ok: true });
		expect(checkClaimInput(own, { maxPhotos: 0, kinds: exchange, reasons: ['Damaged'], otherReason: false })).toMatchObject({
			field: 'reason',
		});
		const keys = ['online', 'cod'];
		expect(checkRefundMethod(null, true, keys)).toEqual({ ok: true, method: 'payments', reference: '' });
		expect(checkRefundMethod({ method: 'cod', reference: null }, false, keys)).toEqual({
			ok: true,
			method: 'cod',
			reference: '',
		});
		// a way the list does not have, and Payments for an order not paid through it
		expect(checkRefundMethod({ method: 'cheque' }, false, keys)).toMatchObject({ ok: false, field: 'method' });
		expect(checkRefundMethod({ method: 'payments' }, false, keys)).toMatchObject({ ok: false, field: 'method' });
		expect(checkRestockChoices(undefined, { lines: [] })).toMatchObject({ ok: true });
		expect(checkRestockChoices([null], { lines: [] })).toMatchObject({ field: 'lines/0/lineId' });
		expect(checkRestockChoices(Array.from({ length: 51 }), { lines: [] })).toMatchObject({ field: 'lines' });
		expect(claimReference('ret_abcdef123456', '')).toBe('123456');
		expect(claimReference('ret_abcdef123456', 5)).toBe('R-123456');
		expect(holdsUnits({ role: 'repaired', window: 'warranty', refundAmount: 0 })).toBe(false);
		// a warranty-window claim closed with store credit keeps its units (the item came back)
		expect(holdsUnits({ role: 'closed', window: 'warranty', refundAmount: 0, creditAmount: 500 })).toBe(true);
		expect(holdsUnits({ role: 'closed', window: 'warranty', refundAmount: 0 })).toBe(false);
		expect(actionsOf({ role: 'approved', outcomes: ['refund'], restockedAt: null })).toEqual([
			'reject',
			'receive',
			'refund',
			'close',
		]);
		expect(actionsOf({ role: 'approved', outcomes: ['store_credit', 'repair'], restockedAt: null })).toEqual([
			'reject',
			'receive',
			'credit',
			'repair',
			'close',
		]);
		const order = /** @type {any} */ ({
			lines: [{ id: 'oln_1', total: 1000, quantity: 1 }],
			totals: { total: 1300, delivery: 300 },
			payment: { paid: 1300, refunded: 0 },
		});
		const claims = [
			{ id: 'ret_1', lines: [{ lineId: 'oln_1', quantity: 1, serials: [] }], refundAmount: 1100 },
			{ id: 'ret_2', lines: [{ lineId: 'oln_1', quantity: 1, serials: [] }], refundAmount: 0 },
		];
		expect(deliveryLeft(order, claims, 'ret_2')).toBe(200);
		expect(deliveryLeft(order, claims, 'ret_1')).toBe(300);
		expect(deliveryLeft({ ...order, totals: { total: 1000 } }, claims, 'ret_2')).toBe(0);
		expect(refundCap(order, /** @type {any} */ (claims[1]), 200)).toBe(1200);
	});
});
