import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { read } from '../src/index.js';
import { MAPPINGS } from '../src/mappings/index.js';
import { linesOf } from '../src/ndjson.js';
import { IDMAP_FILE, SETTINGS_FILE } from '../src/read.js';
import { SHOP_GUEST_COOKIE, SHOP_IDS, SHOP_MAPPING, seedShop, shopHex, shopSource } from '../src/fixture/index.js';
import { freshDb, removeDir, tempDir } from './helpers.js';

/** @type {Array<() => Promise<unknown>>} */
const cleanups = [];
afterEach(async () => {
	while (cleanups.length > 0) await /** @type {() => Promise<unknown>} */ (cleanups.pop())();
});

/** The example shop read into a fresh folder. */
const readShop = async () => {
	const source = await freshDb();
	await seedShop(source.db);
	const dir = await tempDir();
	cleanups.push(async () => {
		await source.db.dropDatabase();
		await source.client.close();
		await removeDir(dir);
	});
	const manifest = await read({ mapping: SHOP_MAPPING, db: source.db, dir, now: () => Date.parse('2026-10-01T00:00:00Z') });
	/** @param {string} target @returns {Promise<any[]>} */
	const records = async (target) => {
		const file = manifest.targets.find((entry) => `${entry.product}.${entry.collection}` === target)?.file ?? '';
		return linesOf(await readFile(path.join(dir, file), 'utf8')).map((line) => JSON.parse(line.text));
	};
	return { manifest, records, dir };
};

describe('the example shop (fixture)', () => {
	it('maps every collection into the four products in import order, merging the guest saved twice', async () => {
		expect(MAPPINGS['example-shop']).toBeUndefined();
		const { manifest } = await readShop();
		expect(manifest.targets.map((target) => [`${target.product}.${target.collection}`, target.records])).toEqual([
			['accounts.roles', 1],
			['accounts.users', 3],
			['ecommerce.size_charts', 1],
			['ecommerce.categories', 2],
			['ecommerce.brands', 1],
			['ecommerce.attributes', 1],
			['ecommerce.products', 2],
			['ecommerce.deals', 1],
			['ecommerce.customers', 2],
			['ecommerce.orders', 3],
			['ecommerce.loyalty', 1],
			['ecommerce.reviews', 1],
			['ecommerce.returns', 1],
			['ecommerce.alerts', 1],
			['ecommerce.wishlists', 1],
			['chat.staff', 2],
			['chat.guests', 1],
			['chat.conversations', 1],
			['chat.messages', 2],
			['growth.totals', 2],
		]);
		expect(manifest.steps.find((step) => step.collection === 'customers')).toMatchObject({ read: 3, records: 2, merged: 1 });
		expect(manifest.steps.find((step) => step.collection === 'loyalty')).toMatchObject({ read: 2, records: 1, merged: 1 });
		// only members become Accounts users
		expect(manifest.steps.filter((step) => step.collection === 'users').map((step) => step.read)).toEqual([2, 1]);
		expect(manifest.totals).toEqual({
			accounts: {
				'users.staff': 2,
				'users.withPassword': 3,
				'users.role.owner': 1,
				'users.role.support_staff': 1,
				'users.role.member': 1,
			},
			ecommerce: {
				products: 2,
				'products.active': 2,
				variants: 3,
				'stock.units': 17,
				'deals.used': 3,
				customers: 2,
				'orders.delivered.count': 1,
				'orders.delivered.total': 3000,
				'orders.confirmed.count': 1,
				'orders.confirmed.total': 3000,
				'orders.canceled.count': 1,
				'orders.canceled.total': 5500,
				'loyalty.points': 35,
				reviews: 1,
				returns: 1,
			},
			chat: { conversations: 1, 'conversations.resolved': 1, messages: 2 },
			growth: { days: 2, visits: 200, page_views: 500 },
		});
	});

	it('gives the products their own shapes: ids for slugs, cents, the status rules and one record per message', async () => {
		const { records, dir } = await readShop();
		const id = (/** @type {string} */ prefix, /** @type {number} */ n) => `${prefix}_${shopHex(n)}`;
		expect(await records('accounts.users')).toEqual([
			expect.objectContaining({ id: `usr_${SHOP_IDS.owner}`, role: 'owner', email: 'Olive@Example.com' }),
			expect.objectContaining({ id: `usr_${SHOP_IDS.support}`, role: 'support_staff' }),
			expect.objectContaining({ id: `usr_${SHOP_IDS.member}`, role: 'member', phone: '(555) 010-0001' }),
		]);
		expect(await records('ecommerce.categories')).toEqual([
			expect.objectContaining({ id: id('cat', 8), parentId: null }),
			expect.objectContaining({ id: id('cat', 9), parentId: id('cat', 8), sizeChartId: id('szc', 7) }),
		]);
		const [tee] = await records('ecommerce.products');
		expect(tee).toMatchObject({
			categoryIds: [id('cat', 9)],
			brandId: id('brd', 10),
			variants: [
				{ id: id('var', 13), price: 2500, compareAtPrice: 3000, attributes: { [id('att', 11)]: 'red' } },
				{ id: id('var', 14), price: 2500, compareAtPrice: null, stock: 0 },
			],
			sold: 40,
			rating: { average: 4.5, count: 6 },
		});
		const [delivered, confirmed, canceled] = await records('ecommerce.orders');
		expect(delivered).toMatchObject({
			customer: { userId: `usr_${SHOP_IDS.member}`, customerId: `cus_${SHOP_IDS.member}` },
			totals: { subtotal: 2500, delivery: 500, total: 3000 },
			payments: [{ method: 'cod', amount: 3000, at: '2026-07-04T12:00:00.000Z' }],
			history: [{ from: null, to: 'confirmed' }, { to: 'packed' }, { to: 'shipped' }, { from: 'shipped', to: 'delivered' }],
			deliveredAt: '2026-07-04T12:00:00.000Z',
			promotions: { pointsEarned: 25, pointsCredited: true, released: false },
		});
		// the guest's second record points at the record it joined
		expect(confirmed).toMatchObject({
			customer: { userId: '', customerId: `cus_${SHOP_IDS.guest}` },
			payment: { method: 'bank_transfer' },
			payments: [{ method: 'bank_transfer', amount: 3000, at: '2026-08-10T12:00:00.000Z' }],
			history: [{ to: 'awaiting_payment' }, { from: 'awaiting_payment', to: 'confirmed' }],
		});
		expect(canceled).toMatchObject({ payments: [], stockHeld: false, promotions: { released: true }, deliveredAt: null });
		expect(await records('ecommerce.loyalty')).toEqual([
			expect.objectContaining({
				customerId: `cus_${SHOP_IDS.member}`,
				userId: `usr_${SHOP_IDS.member}`,
				lots: [
					expect.objectContaining({ points: 25, kind: 'earn', orderId: `ord_${SHOP_IDS.delivered}` }),
					expect.objectContaining({ points: 10, kind: 'adjust', orderId: null }),
				],
			}),
		]);
		expect(await records('ecommerce.alerts')).toEqual([
			expect.objectContaining({ customerId: `cus_${SHOP_IDS.guest}`, variantId: id('var', 14), phone: '555-010-0002' }),
		]);
		expect(await records('ecommerce.wishlists')).toEqual([{ userId: `usr_${SHOP_IDS.member}`, productIds: [id('prd', 15)] }]);
		expect(await records('chat.guests')).toEqual([
			expect.objectContaining({
				keyHash: createHash('sha256').update(SHOP_GUEST_COOKIE).digest('hex'),
				id: `guest_${SHOP_IDS.chat}`,
			}),
		]);
		expect(await records('chat.conversations')).toEqual([
			expect.objectContaining({
				status: 'resolved',
				assignedTo: `usr_${SHOP_IDS.support}`,
				lastMessageAt: '2026-08-05T10:04:00.000Z',
			}),
		]);
		expect((await records('chat.messages')).map((message) => [message.author, message.staffId ?? null])).toEqual([
			['visitor', null],
			['staff', `usr_${SHOP_IDS.support}`],
		]);
		expect((await records('growth.totals'))[0]).toEqual({
			day: '2026-09-01',
			part: 0,
			totals: {
				visits: { '': { c: 120 } },
				page_views: { '': { c: 300 } },
				page: { '/': { c: 180 }, '/products/cotton-tee': { c: 120 } },
				source: { 'www.google.com': { c: 70 }, '(direct)': { c: 50 } },
			},
		});
		// the old shop's own statuses become the website's order flow, each with the role of its stage (K9)
		const plan = JSON.parse(await readFile(path.join(dir, SETTINGS_FILE), 'utf8'));
		expect(plan.ecommerce.settings).toEqual({
			'checkout.numberPattern': '{prefix}{year}-{number}',
			'checkout.numberPrefix': 'EX-',
			'catalog.mediaBaseUrl': 'https://cdn.example.com',
		});
		expect(plan.ecommerce.lists.order_flow.statuses).toEqual([
			{ key: 'awaiting_payment', label: 'Awaiting payment', role: 'awaiting_payment' },
			{ key: 'pending', label: 'Pending', role: 'awaiting_confirmation' },
			{ key: 'confirmed', label: 'Confirmed', role: 'open' },
			{ key: 'packed', label: 'Packed', role: 'packed' },
			{ key: 'shipped', label: 'Shipped', role: 'shipped' },
			{ key: 'delivered', label: 'Delivered', role: 'delivered' },
			{ key: 'canceled', label: 'Canceled', role: 'canceled' },
		]);
		expect(plan.ecommerce.lists.order_flow.moves).toContainEqual({ from: 'packed', to: 'shipped' });
		const idmap = JSON.parse(await readFile(path.join(dir, IDMAP_FILE), 'utf8'));
		expect(idmap[`customers/${SHOP_IDS.guestAgain}`]).toBe(`cus_${SHOP_IDS.guest}`);
		expect(idmap[`orders/${SHOP_IDS.confirmed}`]).toBe(`ord_${SHOP_IDS.confirmed}`);
	});

	it('reads a shop without settings and without a member', async () => {
		const source = await freshDb();
		const dir = await tempDir();
		cleanups.push(async () => {
			await source.db.dropDatabase();
			await source.client.close();
			await removeDir(dir);
		});
		const docs = shopSource();
		for (const [name, list] of Object.entries(docs))
			if (name !== 'settings')
				await source.db
					.collection(name)
					.insertMany(name === 'customers' ? list.map((doc) => ({ ...doc, member: false })) : list);
		const manifest = await read({ mapping: SHOP_MAPPING, db: source.db, dir });
		// a guest's wishlist stays behind; the guest's order and points have no user id
		expect(manifest.steps.find((step) => step.collection === 'wishlists')).toMatchObject({ read: 1, records: 0, skipped: 1 });
		expect(JSON.parse(await readFile(path.join(dir, SETTINGS_FILE), 'utf8'))).toEqual({});
	});
});
