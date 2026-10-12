/**
 * Reviews, alerts and wishlists (PLAN 0.8.10 E34) through the routes: reviews per order line written from the order page
 * by its owner (a sign-in or a guest's order key), `verified` and the variant on every answer, names as `nameFormat`
 * shows them, `pageSize`, setting a review back to pending and counts by status; alerts per variant with a target price,
 * guest alerts by phone, the unsubscribe link of every alert message, alerts when stock comes back through the order
 * ledger (a shopper's cancel, an ended window, a staff cancel, a refund before delivery, a return to origin) and an
 * import; and merging a guest's wishlist at sign-in.
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { INDEXES } from '../adapters/product.js';
import { DEFAULT_FLOW } from '../core/flow.js';
import { newOrderKey, orderKeyHash } from '../core/guests.js';
import { COLLECTIONS } from '../core/model.js';
import { ALL, DOMAIN, ORIGIN, readyShop } from './helpers.js';

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
let ip = 0;
const SARA = 'usr_shopper0000001';
const OMAR = 'usr_shopper0000002';
const ADDRESS = { name: 'Sara Shopper', phone: '+15550001111', line1: '1 Main Street', city: 'Springfield', country: 'US' };

beforeAll(async () => {
	shop = await readyShop();
	data = await shop.db();
	await data.ensureIndexes(INDEXES);
	ticket = await shop.ticket();
});
afterAll(async () => shop.product.close());
beforeEach(async () => {
	shop.advance(61_000);
	data = await shop.db();
	sara = await shop.signIn();
	omar = await shop.signIn({ id: OMAR, name: 'Omar Farooq', email: 'omar@example.com', phone: '' });
});

/**
 * A visitor request from a fresh address (the visitor rate limits count per address).
 * @param {string} method @param {string} path
 * @param {{ body?: unknown, signIn?: string, orderKey?: string, key?: string }} [init]
 */
const visit = (method, path, { body, signIn, orderKey, key } = {}) => {
	ip += 1;
	return shop.call(method, path, {
		token: shop.browser,
		origin: ORIGIN,
		body,
		headers: {
			'x-forwarded-for': `10.9.${(ip >> 8) & 255}.${ip & 255}`,
			...(signIn ? { 'ss-sign-in': signIn } : {}),
			...(orderKey ? { 'ss-order-key': orderKey } : {}),
			...(key ? { 'idempotency-key': key } : {}),
		},
	});
};

/** The problem code of an answer. @param {{ json: any }} response */
const codeOf = (response) =>
	String(response.json?.type ?? '')
		.split('/')
		.pop();

/** @param {string} id */
const productOf = async (id) =>
	/** @type {any} */ (await data.collection(COLLECTIONS.products).findOne({ websiteId: data.websiteId, id }));

/**
 * Write an order record straight into the merchant database (delivered unless said otherwise).
 * @param {{ userId?: string, name?: string, lines: Array<{ product: import('../core/model.js').ProductRecord,
 *   variant?: number, variantName?: string }>, key?: string, patch?: Record<string, unknown> }} input
 */
const seedOrder = async ({ userId = SARA, name = 'Sara Shopper', lines, key, patch = {} }) => {
	const record = {
		id: createId('ord'),
		number: `R-${createId('num').slice(4, 12)}`,
		customer: { userId, customerId: null, name, email: '', phone: '' },
		address: null,
		delivery: { method: 'none', zone: '', fee: 0, locationId: null },
		lines: lines.map((line) => {
			const variant = /** @type {import('../core/model.js').VariantRecord} */ (line.product.variants[line.variant ?? 0]);
			return {
				id: createId('oln'),
				productId: line.product.id,
				variantId: variant.id,
				kind: 'physical',
				name: line.product.name,
				variantName: line.variantName ?? '',
				sku: '',
				grade: null,
				gradeLabel: '',
				image: null,
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
		}),
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
		payment: { method: 'cod', state: 'unpaid', paymentId: null, advance: 0, paid: 0, refunded: 0, checkedAt: null },
		status: 'delivered',
		role: 'delivered',
		history: [],
		shipment: null,
		stockHeld: false,
		holdUntil: null,
		idempotencyKey: createId('key'),
		note: '',
		staffNote: '',
		placedAt: new Date(shop.now()),
		deliveredAt: new Date(shop.now()),
		...(key ? { accessKeyHash: orderKeyHash(key) } : {}),
		...patch,
	};
	await data.collection(COLLECTIONS.orders).insertOne({ ...record });
	return record;
};

/** A product with two variants. */
const twoVariants = () =>
	shop.seedProduct({
		name: 'Phone X',
		options: [{ name: 'Storage', values: ['128', '256'] }],
		variants: ['128', '256'].map((size, at) => ({
			id: createId('var'),
			sku: `PX-${size}-${createId('sku').slice(4, 12)}`,
			options: { Storage: size },
			price: 10_000 + at * 2_000,
			compareAtPrice: null,
			cost: null,
			stock: 5,
			locations: {},
			grade: null,
			active: true,
		})),
	});

describe('reviews per order line', () => {
	it('are written from the order page by its owner, one per line, verified and naming the variant', async () => {
		await shop.setting('reviews', 'per', 'order_line');
		await shop.setting('reviews', 'nameFormat', 'first_initial');
		await shop.setting('reviews', 'moderation', 'auto');
		const item = await twoVariants();
		const order = await seedOrder({
			lines: [
				{ product: item, variant: 0, variantName: '128 GB' },
				{ product: item, variant: 1, variantName: '256 GB' },
			],
		});
		const [first, second] = /** @type {Array<{ id: string }>} */ (order.lines);
		const write = (/** @type {Record<string, unknown>} */ body, /** @type {{ signIn?: string, orderKey?: string }} */ who) =>
			visit('POST', '/v1/shop/reviews', { body: { orderId: order.id, rating: 5, ...body }, ...who });

		expect(codeOf(await write({ lineId: first?.id }, {}))).toBe('sign_in_required');
		expect((await write({}, { signIn: sara })).status).toBe(422);
		expect((await write({ lineId: 'oln_nope', orderId: order.id }, { signIn: sara })).status).toBe(422);
		expect((await write({ lineId: first?.id, orderId: 'ord_nope' }, { signIn: sara })).status).toBe(404);
		// someone else's order is not found
		expect((await write({ lineId: first?.id }, { signIn: omar })).status).toBe(404);
		// not delivered yet
		const waiting = await seedOrder({ lines: [{ product: item }], patch: { deliveredAt: null, status: 'confirmed' } });
		const early = await visit('POST', '/v1/shop/reviews', {
			body: { orderId: waiting.id, lineId: waiting.lines[0]?.id, rating: 4 },
			signIn: sara,
		});
		expect(codeOf(early)).toBe('review_not_allowed');

		shop.advance(1000);
		const one = await write({ lineId: first?.id, title: 'Fast' }, { signIn: sara });
		expect(one.status).toBe(201);
		expect(one.json).toMatchObject({
			name: 'Sara Shopper',
			verified: true,
			variantName: '128 GB',
			lineId: first?.id,
			orderId: order.id,
			status: 'approved',
		});
		expect(codeOf(await write({ lineId: first?.id, rating: 3 }, { signIn: sara }))).toBe('already_reviewed');
		// the same product's other line takes its own review
		shop.advance(1000);
		const two = await write({ lineId: second?.id, rating: 3 }, { signIn: sara });
		expect(two.json).toMatchObject({ variantName: '256 GB', status: 'approved' });

		// a guest's order opens with its key
		const key = newOrderKey();
		const guest = await seedOrder({ userId: '', name: 'Ayesha Khan', key, lines: [{ product: item, variantName: '128 GB' }] });
		const guestWrite = (/** @type {string} */ orderKey) =>
			visit('POST', '/v1/shop/reviews', {
				body: { orderId: guest.id, lineId: guest.lines[0]?.id, rating: 4, body: 'Good' },
				orderKey,
			});
		expect((await guestWrite(newOrderKey())).status).toBe(404);
		shop.advance(1000);
		const byGuest = await guestWrite(key);
		expect(byGuest.status).toBe(201);
		expect(byGuest.json).toMatchObject({ name: 'Ayesha Khan', userId: '', verified: true });

		// visitors see "Ayesha K.", the badge and the variant
		const list = await visit('GET', `/v1/shop/products/${item.id}/reviews`);
		expect(list.json.items.map((/** @type {any} */ r) => [r.name, r.verified, r.variantName])).toEqual([
			['Ayesha K.', true, '128 GB'],
			['Sara S.', true, '256 GB'],
			['Sara S.', true, '128 GB'],
		]);
		expect(list.json.summary).toMatchObject({ count: 3 });
		expect((await productOf(item.id)).rating.count).toBe(3);
		// staff see the whole name
		const staff = await shop.api('GET', `/v1/reviews?productId=${item.id}`);
		expect(staff.json.items.map((/** @type {any} */ r) => r.name)).toContain('Ayesha Khan');
		await shop.setting('reviews', 'nameFormat', 'full');
		expect((await visit('GET', `/v1/shop/products/${item.id}/reviews`)).json.items[0].name).toBe('Ayesha Khan');
		await shop.setting('reviews', 'moderation', 'manual');
		await shop.setting('reviews', 'per', 'product');
	});

	it('pages by pageSize, sets reviews back to pending and counts them by status', async () => {
		const item = await shop.seedProduct({ name: 'Charger' });
		const reviews = data.collection(COLLECTIONS.reviews);
		await reviews.insertMany(
			Array.from({ length: 7 }, (_, at) => ({
				id: createId('rev'),
				productId: item.id,
				userId: `usr_many${at}`,
				orderId: `ord_many${at}`,
				name: `Buyer ${at}`,
				rating: 4,
				title: '',
				body: '',
				status: 'approved',
				reply: '',
				createdAt: new Date(shop.now() + at),
			})),
		);
		const page = async () => (await visit('GET', `/v1/shop/products/${item.id}/reviews`)).json;
		expect((await page()).items).toHaveLength(7);
		await shop.setting('reviews', 'pageSize', 5);
		const five = await page();
		expect(five.items).toHaveLength(5);
		expect(five.nextCursor).toBeTruthy();
		expect(five.items[0]).toMatchObject({ verified: true, variantName: '' });
		await shop.setting('reviews', 'pageSize', 10);

		// the product mode answers carry the badge and the variant too
		const other = await shop.seedProduct({ name: 'Cable' });
		await seedOrder({ userId: OMAR, name: 'Omar Farooq', lines: [{ product: other, variantName: '1 m' }] });
		const written = await visit('POST', '/v1/shop/reviews', { body: { productId: other.id, rating: 2 }, signIn: omar });
		expect(written.json).toMatchObject({ verified: true, variantName: '1 m', lineId: null, status: 'pending' });

		const [approved] = /** @type {any[]} */ (await reviews.find({ websiteId: data.websiteId, productId: item.id }).toArray());
		const back = await shop.api('POST', `/v1/reviews/${approved.id}/pending`, {});
		expect(back.json.status).toBe('pending');
		expect((await productOf(item.id)).rating.count).toBe(6);
		const twin = await shop.admin(ticket, 'POST', `/v1/admin/reviews/${written.json.id}/pending`, {});
		expect(twin.json.status).toBe('pending');
		await shop.api('POST', `/v1/reviews/${written.json.id}/approve`, {});
		expect((await shop.admin(ticket, 'POST', `/v1/admin/reviews/${written.json.id}/pending`, {})).json.status).toBe('pending');
		expect((await shop.api('POST', '/v1/reviews/rev_missing/pending', {})).status).toBe(404);

		const counts = await shop.api('GET', `/v1/reviews/counts?by=status&productId=${item.id}`);
		expect(counts.json.groups).toMatchObject({ approved: 6, pending: 1 });
		const adminCounts = await shop.admin(ticket, 'GET', `/v1/admin/reviews/counts?by=status&productId=${other.id}`);
		expect(adminCounts.json.groups).toMatchObject({ pending: 1 });

		const config = await visit('GET', '/v1/widget/config');
		expect(config.json.settings.reviews).toMatchObject({ per: 'product', pageSize: 10 });
	});
});

describe('alerts', () => {
	it('take a target price per variant, from members and (when allowed) guests, each message with an unsubscribe link', async () => {
		const item = await twoVariants();
		const [small, big] = /** @type {import('../core/model.js').VariantRecord[]} */ (item.variants);
		const subscribe = (/** @type {Record<string, unknown>} */ body, /** @type {string | undefined} */ signIn) =>
			visit('POST', '/v1/shop/alerts', { body: { kind: 'price_drop', productId: item.id, ...body }, signIn });
		expect((await subscribe({ variantId: big?.id, targetPrice: 12_000 }, sara)).status).toBe(422);
		expect((await subscribe({ variantId: big?.id, targetPrice: 'cheap' }, sara)).status).toBe(422);
		expect((await subscribe({ kind: 'back_in_stock', variantId: big?.id, targetPrice: 1 }, sara)).status).toBe(422);
		const target = await subscribe({ variantId: big?.id, targetPrice: 10_500 }, sara);
		expect(target.status).toBe(201);
		expect(target.json).toMatchObject({ variantId: big?.id, price: 12_000, targetPrice: 10_500 });
		const plain = await subscribe({ variantId: small?.id }, sara);
		expect(plain.json).toMatchObject({ targetPrice: null, price: 10_000 });

		// guests only while the setting allows, with a phone normalised as checkout does
		expect(codeOf(await subscribe({ variantId: big?.id, phone: '0300 1234567' }, undefined))).toBe('sign_in_required');
		await shop.setting('alerts', 'guests', true);
		await shop.setting('alerts', 'channels', ['email', 'sms']);
		await shop.setting('checkout', 'defaultCallingCode', '+92');
		await shop.setting('checkout', 'trunkPrefix', '0');
		expect((await subscribe({ variantId: big?.id, phone: 'call me' }, undefined)).status).toBe(422);
		const customerId = createId('cus');
		await data.collection(COLLECTIONS.customers).insertOne({
			id: customerId,
			userId: null,
			guest: true,
			name: 'Guest',
			email: '',
			phone: '+923001234567',
			phoneDigits: '3001234567',
			blocked: false,
			blockedReason: '',
			rtoCount: 0,
			orderCount: 1,
			note: '',
			city: '',
			seenBy: [],
		});
		const guest = await subscribe({ variantId: big?.id, phone: '0300 1234567', targetPrice: 11_000 }, undefined);
		expect(guest.status).toBe(201);
		expect((await subscribe({ variantId: big?.id, phone: '+92 300 1234567' }, undefined)).status).toBe(200);
		const stored = /** @type {any} */ (
			await data.collection(COLLECTIONS.alerts).findOne({ websiteId: data.websiteId, id: guest.json.id })
		);
		expect(stored).toMatchObject({ userId: '', phone: '+923001234567', email: '', customerId, targetPrice: 11_000 });
		const guestBack = await visit('POST', '/v1/shop/alerts', {
			body: { kind: 'back_in_stock', productId: item.id, variantId: big?.id, phone: '03001234567' },
		});
		expect(guestBack.status).toBe(422);

		// the big variant drops to 10,800: Sara's target (10,500) waits, the guest's (11,000) and Sara's plain alert on
		// the small variant (unchanged) do not fire, so only the guest's is sent
		/** Change the big variant's price by an import. @param {string} price */
		const reprice = async (price) => {
			const done = await shop.api('POST', '/v1/csv/products', {
				csv: `name,slug,sku,price\nPhone X,${item.slug},${big?.sku},${price}`,
				dryRun: false,
			});
			expect(done.json).toMatchObject({ updated: 1, errors: [] });
		};
		const sent = shop.messages().length;
		await reprice('108.00');
		const first = shop.messages().slice(sent);
		expect(first.map((m) => [m.template, m.to])).toEqual([['ecommerce.price_drop', { phone: '+923001234567' }]]);
		const link = String(first[0]?.values.unsubscribeUrl);
		expect(link).toMatch(new RegExp(`^https://${DOMAIN.replace(/\./g, '\\.')}/alerts/unsubscribe/[A-Za-z0-9]{32}$`));
		const token = link.split('/').pop() ?? '';
		const kept = /** @type {any} */ (
			await data.collection(COLLECTIONS.alerts).findOne({ websiteId: data.websiteId, id: guest.json.id })
		);
		expect(kept).toMatchObject({ status: 'sent', tokenHash: orderKeyHash(token) });
		expect(JSON.stringify(kept)).not.toContain(token);

		// then to 10,400: Sara's target is reached, with her own link
		await shop.setting('alerts', 'channels', ['email']);
		await reprice('104.00');
		const second = shop.messages().slice(sent + 1);
		expect(second.map((m) => [m.template, m.to])).toEqual([['ecommerce.price_drop', { email: 'sara@example.com' }]]);
		const saraToken = String(second[0]?.values.unsubscribeUrl).split('/').pop();

		// unsubscribing removes every alert of that e-mail (Sara's waiting one too); a used or unknown token removes nothing
		const gone = await visit('POST', `/v1/shop/alerts/unsubscribe/${saraToken}`);
		expect(gone.json).toEqual({ removed: 2 });
		expect((await visit('POST', `/v1/shop/alerts/unsubscribe/${saraToken}`)).json).toEqual({ removed: 0 });
		expect((await visit('POST', '/v1/shop/alerts/unsubscribe/short')).json).toEqual({ removed: 0 });
		expect((await visit('GET', '/v1/shop/alerts', { signIn: sara })).json.items).toEqual([]);
		// and every alert of that phone
		await subscribe({ variantId: small?.id, phone: '03001234567' }, undefined);
		expect((await visit('POST', `/v1/shop/alerts/unsubscribe/${token}`)).json).toEqual({ removed: 2 });

		// a guest's alert moves to the member whose verified phone it is (E21)
		const again = await subscribe({ variantId: small?.id, phone: '03001234567' }, undefined);
		const member = await shop.signIn({ id: 'usr_shopper0000009', name: 'Guest Member', phone: '+923001234567' });
		await visit('GET', '/v1/shop/orders', { signIn: member });
		const listed = await visit('GET', '/v1/shop/alerts', { signIn: member });
		expect(listed.json.items.map((/** @type {any} */ a) => a.id)).toEqual([again.json.id]);
		await shop.setting('alerts', 'guests', false);
		await shop.setting('alerts', 'channels', ['email']);
	});

	it('fire when stock comes back through the order ledger or an import', async () => {
		/** An out-of-stock product with Sara's back-in-stock alert. @param {string} name */
		const watched = async (name) => {
			const item = await shop.seedProduct({ name, stock: 0, sku: `SKU-${createId('sku').slice(4, 10)}` });
			const alert = await visit('POST', '/v1/shop/alerts', {
				body: { kind: 'back_in_stock', productId: item.id },
				signIn: sara,
			});
			expect(alert.status).toBe(201);
			return item;
		};
		/** The back-in-stock messages sent since `from`, by product name. @param {number} from */
		const backSince = (from) =>
			shop
				.messages()
				.slice(from)
				.filter((m) => m.template === 'ecommerce.back_in_stock')
				.map((m) => m.values.name);

		// a shopper's cancel and an ended window (orders placed through checkout hold the last unit)
		const cancelled = await shop.seedProduct({ name: 'Cancelled', stock: 1 });
		const expired = await shop.seedProduct({ name: 'Expired', stock: 1 });
		const buyer = await shop.signIn({ id: 'usr_buyer0000001', name: 'Bo Buyer', email: 'bo@example.com' });
		const place = (/** @type {string} */ id) =>
			visit('POST', '/v1/shop/orders', {
				body: { lines: [{ productId: id }], payment: 'cod', address: ADDRESS },
				signIn: buyer,
				key: `e34-${id}`,
			});
		const toCancel = (await place(cancelled.id)).json.order;
		await place(expired.id);
		expect((await productOf(cancelled.id)).inStock).toBe(false);
		for (const item of [cancelled, expired])
			expect(
				(await visit('POST', '/v1/shop/alerts', { body: { kind: 'back_in_stock', productId: item.id }, signIn: sara }))
					.status,
			).toBe(201);
		let from = shop.messages().length;
		await visit('POST', `/v1/shop/orders/${toCancel.id}/cancel`, { signIn: buyer });
		expect(backSince(from)).toEqual(['Cancelled']);
		from = shop.messages().length;
		shop.advance(25 * 3_600_000);
		await visit('GET', '/v1/shop/products');
		expect(backSince(from)).toEqual(['Expired']);
		// sign-ins last 15 minutes and the database client was idle meanwhile
		sara = await shop.signIn();
		data = await shop.db();

		// a staff cancel, a refund before delivery and a return to origin give back the stock an order holds
		await shop.list('order_flow', {
			...DEFAULT_FLOW,
			moves: [...DEFAULT_FLOW.moves, { from: 'confirmed', to: 'refunded' }],
		});
		const staffCancel = await watched('Staff cancel');
		const refund = await watched('Refund');
		const rto = await watched('Return to origin');
		const held = { stockHeld: true, deliveredAt: null };
		const a = await seedOrder({ lines: [{ product: staffCancel }], patch: { ...held, status: 'confirmed', role: 'open' } });
		const b = await seedOrder({
			lines: [{ product: refund }],
			patch: {
				...held,
				status: 'confirmed',
				role: 'open',
				payment: { method: 'cod', state: 'paid', paymentId: null, advance: 0, paid: 1000, refunded: 0, checkedAt: null },
			},
		});
		const c = await seedOrder({
			lines: [{ product: rto }],
			patch: {
				...held,
				status: 'dispatched',
				role: 'shipped',
				shipment: { courier: 'Post', trackingNumber: 'T1', trackingUrl: '', bookedAt: null },
			},
		});
		for (const [order, to, name] of /** @type {Array<[{ id: string }, string, string]>} */ ([
			[a, 'cancelled', 'Staff cancel'],
			[b, 'refunded', 'Refund'],
			[c, 'returned', 'Return to origin'],
		])) {
			from = shop.messages().length;
			const moved = await shop.api('POST', `/v1/orders/${order.id}/move`, { to });
			expect(moved.status, to).toBe(200);
			expect(backSince(from), to).toEqual([name]);
		}
		// a move that gives nothing back tells no one
		from = shop.messages().length;
		const d = await seedOrder({
			lines: [{ product: staffCancel }],
			patch: { status: 'confirmed', role: 'open', deliveredAt: null },
		});
		await shop.api('POST', `/v1/orders/${d.id}/move`, { to: 'cancelled' });
		expect(backSince(from)).toEqual([]);

		// an import (stock without locations)
		await shop.switchOn(ALL.filter((feature) => feature !== 'multi_location'));
		const imported = await watched('Imported');
		from = shop.messages().length;
		const csv = await shop.api('POST', '/v1/csv/products', {
			csv: `name,slug,sku,price,stock\nImported,${imported.slug},${imported.variants[0]?.sku},,4`,
			dryRun: false,
		});
		expect(csv.json).toMatchObject({ updated: 1, errors: [] });
		expect(backSince(from)).toEqual(['Imported']);
		await shop.switchOn(ALL);
	});
});

describe('wishlist merge', () => {
	it('merges a guest’s wishlist into the signed-in shopper’s', async () => {
		const kept = await shop.seedProduct({ name: 'Kept' });
		const added = await shop.seedProduct({ name: 'Added' });
		const draft = await shop.seedProduct({ name: 'Draft', status: 'draft' });
		const merge = (/** @type {unknown} */ productIds, /** @type {string | undefined} */ signIn) =>
			visit('POST', '/v1/shop/wishlist/merge', { body: { productIds }, signIn });
		expect(codeOf(await merge([added.id], undefined))).toBe('sign_in_required');
		expect((await merge('nope', omar)).status).toBe(422);
		expect((await merge(['bad id'], omar)).status).toBe(422);
		expect(
			(
				await merge(
					Array.from({ length: 201 }, (_, i) => `prd_x${i}`),
					omar,
				)
			).status,
		).toBe(422);
		await visit('POST', `/v1/shop/wishlist/items/${kept.id}`, { signIn: omar });
		const merged = await merge([added.id, kept.id, draft.id, 'prd_missing', added.id], omar);
		expect(merged.status).toBe(200);
		expect(merged.json.items.map((/** @type {any} */ p) => p.name)).toEqual(['Kept', 'Added']);
		const record = /** @type {any} */ (
			await data.collection(COLLECTIONS.wishlists).findOne({ websiteId: data.websiteId, userId: OMAR })
		);
		expect(record.productIds).toEqual([kept.id, added.id]);
		// a full wishlist takes no more
		await data
			.collection(COLLECTIONS.wishlists)
			.updateOne(
				{ websiteId: data.websiteId, userId: OMAR },
				{ $set: { productIds: Array.from({ length: 200 }, (_, i) => `prd_full${i}`) } },
			);
		const full = await merge([kept.id], omar);
		expect(full.json.items).toEqual([]);
		// a first merge makes the wishlist
		const fresh = await shop.signIn({ id: 'usr_merge0000001', name: 'New', email: 'new@example.com' });
		expect((await merge([kept.id], fresh)).json.items.map((/** @type {any} */ p) => p.id)).toEqual([kept.id]);
	});
});
