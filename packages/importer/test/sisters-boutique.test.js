import { ObjectId } from 'mongodb';
import { afterEach, describe, expect, it } from 'vitest';
import { send, verify } from '../src/index.js';
import { MAPPINGS } from '../src/mappings/index.js';
import { SB_IDS, sbHex } from '../src/mappings/sisters-boutique/fixture.js';
import {
	BY_HAND,
	DEAL_HOURS_SHIFT_MINUTES,
	DEFAULT_CHART_ID,
	FEATURES,
	SISTERS_BOUTIQUE_MAPPING,
	STORE_DEFAULTS,
	readValues,
	settingsPlan,
	spread,
	windowOf,
} from '../src/mappings/sisters-boutique/index.js';
import { fakeProduct } from './helpers.js';
import { readSisters } from './sb-helpers.js';

/** @type {Array<() => Promise<unknown>>} */
const cleanups = [];
afterEach(async () => {
	while (cleanups.length > 0) await /** @type {() => Promise<unknown>} */ (cleanups.pop())();
});

/** @param {string} prefix @param {string} hex */
const id = (prefix, hex) => `${prefix}_${hex}`;

describe('the Sisters Boutique mapping', () => {
	it('reads every kind SB has into Accounts and Ecommerce, in import order, with the sums verify compares', async () => {
		expect(MAPPINGS['sisters-boutique']).toBe(SISTERS_BOUTIQUE_MAPPING);
		const { manifest } = await readSisters({ cleanups });
		expect(manifest.targets.map((target) => [`${target.product}.${target.collection}`, target.records])).toEqual([
			['accounts.roles', 1],
			['ecommerce.customers', 5],
			['accounts.users', 7],
			['accounts.requests', 6],
			['accounts.copies', 3],
			['ecommerce.size_charts', 2],
			['ecommerce.categories', 2],
			['ecommerce.brands', 2],
			['ecommerce.attributes', 3],
			['ecommerce.landings', 2],
			['ecommerce.products', 4],
			['ecommerce.deals', 6],
			['ecommerce.orders', 7],
			['ecommerce.loyalty', 2],
		]);
		/** @param {string} collection @param {string} source */
		const stepOf = (collection, source) =>
			manifest.steps.find((step) => step.collection === collection && step.source === source);
		// two guests saved twice merge; the member role is one record whatever SB holds
		expect(stepOf('customers', 'customers')).toMatchObject({ read: 7, records: 5, merged: 2 });
		expect(stepOf('roles', 'settings')).toMatchObject({ records: 1, skipped: 0 });
		// one brand per slug
		expect(stepOf('brands', 'brands')).toMatchObject({ read: 3, records: 2, merged: 1 });
		// invited requests: one user per phone, none for a member's phone
		expect(stepOf('users', 'membershiprequests')).toMatchObject({ read: 3, records: 1, merged: 1, skipped: 1 });
		// a landing whose brand is gone, buy X get Y and a cart total at most are left out; a gone customer's points too
		expect(stepOf('landings', 'seosurfaces')).toMatchObject({ read: 3, records: 2, skipped: 1 });
		expect(stepOf('deals', 'offers')).toMatchObject({ read: 8, records: 6, skipped: 2 });
		expect(stepOf('loyalty', 'loyaltyaccounts')).toMatchObject({ read: 4, records: 2, merged: 1, skipped: 1 });
		// the built-in chart and the attributes' several values come from the products, into earlier files
		expect(stepOf('size_charts', 'products')).toMatchObject({ records: 1, merged: 3 });
		expect(stepOf('attributes', 'products')).toMatchObject({ records: 0, merged: 1 });
		expect(manifest.totals).toEqual({
			accounts: {
				'requests.pending': 1,
				'users.withPassword': 6,
				'users.role.member': 3,
				'users.role.customer': 1,
				'users.staff': 3,
				'users.role.owner': 1,
				'users.role.product_manager': 1,
				'users.role.support_staff': 1,
			},
			ecommerce: {
				customers: 5,
				products: 4,
				'products.active': 2,
				'products.draft': 1,
				variants: 4,
				'stock.units': 15,
				'deals.used': 8,
				'orders.delivered.count': 1,
				'orders.delivered.total': 1_231_600,
				'orders.confirmed.count': 1,
				'orders.confirmed.total': 650_000,
				'orders.pending-payment.count': 1,
				'orders.pending-payment.total': 450_000,
				'orders.cancelled.count': 1,
				'orders.cancelled.total': 640_000,
				'orders.refunded.count': 1,
				'orders.refunded.total': 300_000,
				'orders.packed.count': 1,
				'orders.packed.total': 510_000,
				'orders.returned.count': 1,
				'orders.returned.total': 450_000,
				'loyalty.points': 337,
			},
		});
	});

	it('moves people: members with their hashes and addresses, staff with their roles, requests and activity', async () => {
		const { records, idmap } = await readSisters({ cleanups });
		const [role] = await records('accounts.roles');
		expect(role).toMatchObject({ key: 'member', permissions: [], methods: ['phone_password'], remember: 'always', rank: 800 });
		const users = await records('accounts.users');
		const byId = new Map(users.map((user) => [user.id, user]));
		expect(byId.get(id('usr', SB_IDS.memberA))).toMatchObject({
			phone: '+923000000001',
			phoneVerified: true,
			role: 'member',
			roleSince: '2026-08-11T10:00:00.000Z',
			identity: 'phone',
			addresses: [
				{ id: id('adr', sbHex(100)), label: 'Home', line1: '1 Example Street', area: 'Area One', default: true },
				// no street: the area is the first line; only the first default stays
				{ id: id('adr', sbHex(101)), line1: 'Area Two', area: '', default: false },
			],
		});
		expect(byId.get(id('usr', SB_IDS.customerD))).toMatchObject({ role: 'customer', phone: '+923000000004' });
		// a super admin is an owner; a member's phone stays off the staff user; an inactive one is blocked
		expect(byId.get(id('usr', SB_IDS.owner))).toMatchObject({ role: 'owner', emailVerified: true, identity: 'email' });
		expect(byId.get(id('usr', SB_IDS.productManager))).not.toHaveProperty('phone');
		expect(byId.get(id('usr', SB_IDS.support))).toMatchObject({
			phone: '+923000000020',
			blocked: { at: '2026-09-01T08:00:00.000Z', reason: 'Inactive in the old admin.' },
		});
		const invited = users.find((user) => user.status === 'invited');
		expect(invited).toMatchObject({ role: 'member', phone: '+923000000011', createdAt: '2026-09-01T10:00:00.000Z' });
		expect(invited.id).toMatch(/^usr_[0-9a-f]{24}$/);
		// its id never holds the phone
		expect(invited.id).not.toContain('3000000011');
		const requests = new Map((await records('accounts.requests')).map((request) => [request.id, request]));
		expect(requests.get(id('rrq', sbHex(20)))).toMatchObject({ status: 'pending' });
		expect(requests.get(id('rrq', sbHex(20)))).not.toHaveProperty('userId');
		expect(requests.get(id('rrq', sbHex(21)))).toMatchObject({
			status: 'invited',
			userId: invited.id,
			invitedBy: { kind: 'user', id: id('usr', SB_IDS.owner) },
			setupExpiresAt: '2026-10-20T10:00:00.000Z',
		});
		// SB's expired request without an expiry reads as expired from its invitation
		expect(requests.get(id('rrq', sbHex(22)))).toMatchObject({
			status: 'invited',
			userId: invited.id,
			setupExpiresAt: '2026-09-01T10:00:00.000Z',
		});
		expect(requests.get(id('rrq', sbHex(23)))).toMatchObject({ status: 'completed', userId: id('usr', SB_IDS.memberE) });
		expect(requests.get(id('rrq', sbHex(25)))).toMatchObject({ status: 'invited', userId: id('usr', SB_IDS.memberA) });
		expect(requests.get(id('rrq', sbHex(24)))).toMatchObject({ status: 'declined' });
		expect(await records('accounts.copies')).toEqual([
			expect.objectContaining({
				productId: 'ecommerce',
				action: 'order.status_changed',
				target: id('ord', SB_IDS.delivered),
				actor: expect.objectContaining({ kind: 'user', id: id('usr', SB_IDS.owner) }),
			}),
			expect.objectContaining({
				productId: 'accounts',
				action: 'auth.login',
				target: 'auth',
				actor: expect.objectContaining({ kind: 'anonymous' }),
			}),
			expect.objectContaining({ action: 'size_chart.updated', target: id('szc', SB_IDS.chart) }),
		]);
		// the id map names customers' Ecommerce records, merged ones the record they joined
		expect(idmap[`customers/${SB_IDS.guestBAgain}`]).toBe(id('cus', SB_IDS.guestB));
		expect(idmap[`customers/${SB_IDS.guestE}`]).toBe(id('cus', SB_IDS.memberE));
		expect(idmap[`users/${SB_IDS.owner}`]).toBe(id('usr', SB_IDS.owner));
	});

	it('moves the catalog: charts, hidden categories, brands and attributes per category, landings, products', async () => {
		const { records } = await readSisters({ cleanups });
		const charts = await records('ecommerce.size_charts');
		expect(charts[0]).toMatchObject({
			unit: 'cm',
			columns: [{ key: 'bust' }, { key: 'shirt-length' }],
			rows: [{ size: 'm', values: { bust: '38', 'shirt-length': '40' } }],
		});
		expect(charts[1]).toMatchObject({ id: DEFAULT_CHART_ID, name: "Standard Women's Size Guide", unit: 'in' });
		const [lawn, formals] = await records('ecommerce.categories');
		expect(lawn).toMatchObject({
			status: 'active',
			sizeChartId: id('szc', SB_IDS.chart),
			faqs: [{ question: 'Is it cotton?' }],
		});
		expect(formals).toMatchObject({ status: 'hidden' });
		expect(formals).not.toHaveProperty('seo');
		const brands = await records('ecommerce.brands');
		// SB's two `luxe` records are one brand: in the categories where SB shows it, with the hidden one's SEO
		expect(brands.map((brand) => [brand.slug, brand.categoryIds, brand.status])).toEqual([
			['house-brand', [id('cat', SB_IDS.lawn), id('cat', SB_IDS.formals)], 'active'],
			['luxe', [id('cat', SB_IDS.lawn)], 'active'],
		]);
		expect(brands[1]).toMatchObject({
			id: id('brd', SB_IDS.luxeLawn),
			seo: { title: 'Luxe formals' },
			sizeChartId: id('szc', SB_IDS.chart),
		});
		const attributes = await records('ecommerce.attributes');
		expect(
			attributes.map((attribute) => [attribute.slug, attribute.categoryId, attribute.multiple, attribute.show.card]),
		).toEqual([
			['size', id('cat', SB_IDS.lawn), false, 'chips'],
			['colour', id('cat', SB_IDS.lawn), true, 'image'],
			['size', id('cat', SB_IDS.formals), false, 'chips'],
		]);
		expect(attributes[1].visibility).toEqual({ when: 'brands', ids: [id('brd', SB_IDS.houseBrand)] });
		// SB reads `attribute` visibility as always
		expect(attributes[2].visibility).toBe('always');
		expect(await records('ecommerce.landings')).toEqual([
			expect.objectContaining({ brandId: id('brd', SB_IDS.houseBrand), title: 'House Brand lawn suits', indexable: 'auto' }),
			expect.objectContaining({ categoryId: id('cat', SB_IDS.formals), brandId: id('brd', SB_IDS.luxeLawn) }),
		]);
		const [suit, shell, basic, old] = await records('ecommerce.products');
		expect(suit).toMatchObject({
			status: 'active',
			featured: true,
			brandId: id('brd', SB_IDS.houseBrand),
			media: [
				{
					key: 'products/lawn-suit-one/1 full.webp',
					type: 'image/webp',
					sizes: { thumb: 'products/lawn-suit-one/1-thumb.webp' },
					width: 1600,
					blur: expect.stringMatching(/^data:image\/webp;base64,/),
				},
			],
			video: { kind: 'youtube', id: 'https://youtu.be/abcdefghijk' },
			variants: [
				// the stale `fit` key is cleared; several colors stay a list
				{
					price: 500_000,
					stock: 4,
					attributes: { [id('att', SB_IDS.sizeLawn)]: 'm', [id('att', SB_IDS.colourLawn)]: ['red', 'blue'] },
				},
				// a product-only color keeps its label
				{ soldOut: true, attributes: { [id('att', SB_IDS.colourLawn)]: 'Dusty Pink' } },
			],
			attributeSetup: [
				{ attributeId: id('att', SB_IDS.sizeLawn), values: ['m', 'l'], defaultValue: 'm' },
				{ attributeId: id('att', SB_IDS.colourLawn), customValues: ['Dusty Pink'] },
			],
			seo: { canonicalUrl: 'https://shop.example.com/lawn/lawn-suit-one', ogImage: '/lawn/og.webp' },
			faqs: [{ question: 'Machine washable?', answer: 'Yes, cold.' }],
		});
		expect(Object.keys(suit.variants[0].attributes)).toHaveLength(2);
		// SB's Google feed ids stay: <product hex>_<variant hex> in the group <product hex> (E17)
		const hex = (/** @type {string} */ value) => value.slice(value.indexOf('_') + 1);
		expect(suit.feedGroupId).toBe(hex(suit.id));
		expect(suit.variants.map((/** @type {any} */ v) => v.feedId)).toEqual(
			suit.variants.map((/** @type {any} */ v) => `${hex(suit.id)}_${hex(v.id)}`),
		);
		expect(shell).toMatchObject({ status: 'draft', variants: [], brandId: id('brd', SB_IDS.luxeLawn) });
		expect(basic).toMatchObject({
			brandId: id('brd', SB_IDS.luxeLawn),
			video: { kind: 'file', key: 'products/lawn-basic/clip.mp4', type: 'video/mp4' },
			sizeChartId: id('szc', SB_IDS.chart),
			hideSizeGuide: false,
			variants: [{ warrantyDays: 0 }],
		});
		expect(old).toMatchObject({ status: 'archived' });
	});

	it('moves offers as SB applies them', async () => {
		const { records } = await readSisters({ cleanups });
		const deals = new Map((await records('ecommerce.deals')).map((deal) => [deal.slug, deal]));
		expect([...deals.keys()]).toEqual([
			'lawn-week',
			'transfer-saver',
			'night-owl',
			'everything',
			'luxe-shipping',
			'not-by-card',
		]);
		expect(deals.get('lawn-week')).toMatchObject({
			type: 'percent',
			target: 'items',
			value: 10,
			// the empty scenario is dropped; the size slug of both categories each make a group; no cart total
			conditions: {
				match: 'any',
				groups: [
					{
						rules: [
							{ field: 'categories' },
							{ field: 'attribute', attributeId: id('att', SB_IDS.sizeLawn), values: ['m'] },
						],
					},
					{ rules: [{ field: 'categories' }, { field: 'attribute', attributeId: id('att', SB_IDS.sizeFormals) }] },
				],
				minQuantity: 2,
				cartTotal: 0,
			},
			days: [5, 6],
			timeFrom: '10:00',
			timeTo: '',
			limit: null,
			used: 5,
			sort: 0,
			priority: 19,
			active: true,
			allowPoints: true,
			content: 'This week only.\n- Medium sizes',
			banner: { key: 'products/lawn-week/1 full.webp' },
			seo: { title: 'Lawn week sale', description: 'Ten percent off.' },
		});
		expect(deals.get('transfer-saver')).toMatchObject({
			type: 'fixed',
			target: 'cart',
			value: 50_000,
			conditions: { cartTotal: 1_000_000, paymentMethods: ['bank_transfer'], groups: [] },
			limit: 50,
			allowPoints: false,
			priority: 9,
		});
		// newer offers rank first among equal sort orders
		expect(deals.get('lawn-week').priority).toBeGreaterThan(deals.get('transfer-saver').priority);
		expect(deals.get('night-owl')).toMatchObject({ active: false, timeFrom: '22:00', timeTo: '02:01' });
		expect(deals.get('everything')).toMatchObject({ active: false, conditions: null });
		expect(deals.get('luxe-shipping')).toMatchObject({
			type: 'free_delivery',
			conditions: {
				groups: [{ rules: [{ field: 'brands', values: [id('brd', SB_IDS.luxeLawn)] }] }],
				priceRange: { min: 100_000, max: 600_000 },
			},
			days: [0],
		});
		expect(deals.get('luxe-shipping')).not.toHaveProperty('value');
		expect(deals.get('not-by-card')).toMatchObject({
			active: false,
			target: 'items',
			conditions: { paymentMethods: ['bank_transfer', 'cod'] },
			allowPoints: true,
		});
	});

	it('moves customers, orders and loyalty with their money, payments, history and markers', async () => {
		const { records } = await readSisters({ cleanups });
		const customers = new Map((await records('ecommerce.customers')).map((customer) => [customer.id, customer]));
		expect(customers.get(id('cus', SB_IDS.guestB))).toMatchObject({
			phone: '+923000000002',
			name: 'Guest Two',
			city: '—',
			note: 'Prefers evening delivery\nSecond record',
			seenBy: [id('usr', SB_IDS.owner), id('usr', SB_IDS.productManager)],
			createdAt: '2026-08-12T10:00:00.000Z',
		});
		expect(customers.get(id('cus', SB_IDS.guestB))).not.toHaveProperty('userId');
		// the guest who became a member: the member's record, from the guest's first day
		expect(customers.get(id('cus', SB_IDS.memberE))).toMatchObject({
			userId: id('usr', SB_IDS.memberE),
			name: 'Member Five',
			createdAt: '2026-08-17T10:00:00.000Z',
		});
		const orders = new Map((await records('ecommerce.orders')).map((order) => [order.number, order]));
		const first = orders.get('IM-2026-0001');
		expect(first).toMatchObject({
			customer: { userId: id('usr', SB_IDS.memberA), customerId: id('cus', SB_IDS.memberA), phone: '+923000000001' },
			delivery: { method: 'delivery', fee: 150_000 },
			// offers, member discount and points spread over the lines (IMP-10)
			totals: { subtotal: 1_300_000, discount: 240_000, delivery: 150_000, fee: 21_600, total: 1_231_600, currency: 'PKR' },
			lines: [
				{
					discount: 184_615,
					total: 815_385,
					dealId: id('deal', SB_IDS.lawnWeek),
					categoryIds: [id('cat', SB_IDS.lawn)],
					brandId: id('brd', SB_IDS.houseBrand),
				},
				{ discount: 55_385, total: 244_615, brandId: id('brd', SB_IDS.luxeLawn) },
			],
			promotions: {
				dealIds: [id('deal', SB_IDS.lawnWeek)],
				pointsRedeemed: 200,
				pointsValue: 20_000,
				pointsEarned: 123,
				pointsCredited: true,
				released: false,
			},
			payments: [{ method: 'cash', amount: 1_231_600, note: 'Imported', at: '2026-08-25T10:00:00.000Z' }],
			deliveredAt: '2026-08-25T10:00:00.000Z',
			shipment: { trackingNote: 'Courier booked' },
			media: [{ kind: 'dispatch_video', url: 'https://media.example.com/dispatch/0001.mp4', at: '2026-08-21T10:00:00.000Z' }],
			seenBy: [id('usr', SB_IDS.owner), id('usr', SB_IDS.productManager)],
			stockHeld: true,
			idempotencyKey: 'checkout-0001',
		});
		// a paid order with no payment entry: the transfer counts as paid when staff confirmed it (IMP-13)
		expect(orders.get('IM-2026-0002')).toMatchObject({
			customer: { userId: '', customerId: id('cus', SB_IDS.guestB), phone: '+923000000002' },
			payment: { method: 'bank_transfer', via: 'manual' },
			payments: [{ method: 'bank_transfer', amount: 650_000, at: '2026-08-26T12:00:00.000Z' }],
			idempotencyKey: `import:${SB_IDS.confirmed}`,
		});
		expect(orders.get('IM-2026-0003')).toMatchObject({ payments: [], status: 'pending-payment' });
		expect(orders.get('IM-2026-0004')).toMatchObject({
			payments: [],
			totals: { discount: 10_000, total: 640_000 },
			promotions: { pointsCredited: true, pointsReversed: 64, released: true },
			stockHeld: false,
			deliveredAt: null,
		});
		expect(orders.get('IM-2026-0005')).toMatchObject({
			address: null,
			delivery: { method: 'pickup', fee: 0 },
			payments: [{ amount: 300_000 }],
			refunds: [{ method: 'bank_transfer', amount: 300_000, at: '2026-09-03T10:00:00.000Z' }],
			promotions: { pointsCredited: false, released: true },
		});
		expect(orders.get('IM-2026-0006')).toMatchObject({
			customer: { userId: id('usr', SB_IDS.memberE), customerId: id('cus', SB_IDS.memberE) },
			totals: { fee: 10_000, total: 510_000 },
			history: [
				{ to: 'confirmed' },
				{ from: 'confirmed', to: 'packed', at: '2026-09-05T10:00:00.000Z', note: 'Imported: the status at the move' },
			],
			media: [{ url: 'https://media.example.com/dispatch/0006.mp4' }],
		});
		expect(orders.get('IM-2026-0007')).toMatchObject({
			payments: [{ method: 'cash' }],
			deliveredAt: '2026-09-08T10:00:00.000Z',
			stockHeld: false,
		});
		const [member, guest] = await records('ecommerce.loyalty');
		expect(member).toMatchObject({ customerId: id('cus', SB_IDS.memberA), userId: id('usr', SB_IDS.memberA) });
		expect(member.lots.map((/** @type {any} */ lot) => [lot.points, lot.left, lot.kind, lot.orderId])).toEqual([
			[50, 0, 'adjust', null],
			[300, 47, 'adjust', null],
			[123, 123, 'earn', id('ord', SB_IDS.delivered)],
			[64, 0, 'earn', id('ord', SB_IDS.cancelled)],
			[100, 100, 'refund', id('ord', SB_IDS.cancelled)],
			[30, 30, 'earn', id('ord', SB_IDS.returned)],
			// SB stored 307 where its transactions give 300
			[7, 7, 'adjust', null],
		]);
		expect(member.history.map((/** @type {any} */ entry) => entry.kind)).toEqual([
			'adjust',
			'adjust',
			'redeem',
			'earn',
			'redeem',
			'earn',
			'reverse',
			'refund',
			'earn',
			'expire',
			'adjust',
		]);
		expect(member.history.at(-1)).toMatchObject({ points: 7, note: 'Imported: balance correction' });
		// the guest's two accounts are one
		expect(guest).toMatchObject({ customerId: id('cus', SB_IDS.guestB), userId: null, lots: [{ points: 20 }, { points: 10 }] });
	});

	it("writes SB's settings and lists for every product, from its rows over its code defaults", async () => {
		const { settings } = await readSisters({ cleanups });
		expect(Object.keys(settings)).toEqual(['accounts', 'ecommerce', 'notifications', 'payments', 'growth']);
		const ecommerce = /** @type {Record<string, any>} */ (settings.ecommerce?.settings);
		expect(ecommerce).toMatchObject({
			'checkout.numberPattern': '{prefix}{year}-{number}',
			'checkout.numberPrefix': 'IM-',
			'checkout.numberDigits': 4,
			'checkout.messageChannels': [],
			'checkout.paymentMethods': ['bank_transfer'],
			'checkout.noteCod': '+2% handling on cash orders',
			'cod.feePercent': 2,
			'cod.enabled': true,
			'delivery_zones.defaultFreeOver': 2_000_000,
			'delivery_zones.defaultFee': 150_000,
			'delivery_zones.pickupAddress': '1 Sample Road, Sample City',
			// a row of the wrong type falls back to the code default
			'catalog.lowStock': STORE_DEFAULTS.lowStockThreshold,
			'catalog.mediaBaseUrl': 'https://media.example.com',
			'size_charts.defaultChartId': DEFAULT_CHART_ID,
			'deals.rounding': 'total_half_up',
			'deals.lineChoice': 'first',
			'deals.cartOffer': 'one_after_items',
			'deals.cartThresholdBase': 'after_item_deals',
			'deals.pointsBlockedBy': 'cart_offer',
			'cod.feeBase': 'goods_after_discounts',
			'staff_alerts.recipients': ['alerts@example.com', 'support@example.com', 'products@example.com'],
			'staff_alerts.adminUrl': 'https://admin.example.com/orders?order={number}',
			'seo.titleTemplate': '{name} — {business}',
		});
		expect(settings.ecommerce?.lists?.role_prices).toEqual([{ role: 'member', percent: 10, label: 'Member discount' }]);
		// SB's order rules are its flow's: no messages, its starts, and the options of its moves
		const flow = /** @type {any} */ (settings.ecommerce?.lists?.order_flow);
		expect(flow.statuses.every((/** @type {any} */ status) => status.notify === false)).toBe(true);
		expect(flow.starts).toEqual({ cod: 'confirmed', pickup: 'awaiting-confirmation', free: 'pending-payment' });
		expect(flow.triggers).toMatchObject({ refundsCover: '' });
		/** @param {string} from @param {string} to */
		const move = (from, to) => flow.moves.find((/** @type {any} */ entry) => entry.from === from && entry.to === to);
		expect(move('pending-payment', 'confirmed').options).toEqual({ paidOnConfirm: ['bank_transfer'] });
		expect(move('confirmed', 'packed').options).toEqual({ video: 'required' });
		expect(move('packed', 'dispatched').options).toEqual({ tracking: 'optional' });
		expect(move('confirmed', 'cancelled')).toMatchObject({ who: ['staff', 'shopper'], options: { shopperPaid: 'flag' } });
		expect(move('delivered', 'returned').options).toEqual({ restock: 'yes', points: 'keep' });
		expect(move('delivered', 'refunded').options).toEqual({ restock: 'yes', points: 'take_back' });
		expect(ecommerce).toMatchObject({ 'checkout.editPricing': 'keep_placed', 'checkout.deleteGivesBack': 'all' });
		expect(settings.accounts?.settings).toMatchObject({
			'phone_password.signUp': false,
			'phone_password.maxAttempts': 20,
			'phone_password.lockMinutes': 1,
			'passwords.networkLimit': 8,
			'phone_password.forgotUrl': expect.stringMatching(/^https:\/\/wa\.me\/923000000099\?text=Salam!%20I%20forgot/),
			'staff_links.setupPageUrl': 'https://shop.example.com/account/setup/{code}',
			'role_requests.requestableRoles': ['member'],
			// SB says "already a member" to a repeat ask: Accounts' detailed answers (its default is private)
			'role_requests.revealStatus': true,
		});
		expect(settings.growth?.settings).toMatchObject({
			'notice_bar.enabled': true,
			'notice_bar.text': 'Free delivery this week',
			'meta_pixel.pixelId': '100000000000000',
			'robots_verification.robotsRules': 'User-agent: *\nAllow: /\nDisallow: /account\nDisallow: /checkout\nDisallow: /api/',
			'robots_verification.sitemaps': ['https://shop.example.com/sitemap.xml'],
			'robots_verification.googleVerification': 'sample-verification',
		});
		expect(settings.payments?.settings).toMatchObject({ 'bank_transfer.accountNumber': '0000-0000000000' });
		// every product gets SB's Format; a secret row is never read
		expect(settings.ecommerce?.format).toEqual({
			wholeUnits: true,
			currencyDisplay: 'custom',
			currencySymbol: 'Rs',
			locale: 'en',
			times: 'business',
		});
		expect(JSON.stringify(settings)).not.toContain('not-a-real-secret');
	});

	it('uses the code defaults without rows and leaves out what only the deployment knows', async () => {
		const { db } = await readSisters({ cleanups, change: (docs) => void (docs.settings = []) });
		const values = await readValues(/** @type {any} */ (db));
		expect(values.store).toEqual(STORE_DEFAULTS);
		expect(values.seo.robotsDisallow).toBeNull();
		const plan = settingsPlan(values);
		const keys = Object.entries(plan).flatMap(([product, part]) =>
			Object.keys(part.settings ?? {}).map((key) => `${product} ${key}`),
		);
		for (const key of Object.keys(BY_HAND).filter((name) => !name.includes('recipients'))) expect(keys).not.toContain(key);
		expect(plan.ecommerce?.settings).toMatchObject({
			'checkout.noteBankTransfer': 'Transfer online — send payment screenshot on WhatsApp',
			'checkout.noteCod': 'Pay when you receive your order',
			'delivery_zones.defaultFreeOver': 5_000_000,
			'catalog.lowStock': 2,
			'seo.titleTemplate': '{name} | {business}',
			// SB alerts every active staff user; those whose role reads orders come through the permission
			'staff_alerts.recipients': ['products@example.com'],
		});
		expect(plan.growth?.settings?.['robots_verification.robotsRules']).toContain('Disallow: /admin');
		expect(plan.accounts?.settings?.['phone_password.forgotUrl']).toBe('');
		expect(plan.ecommerce?.lists?.role_prices).toEqual([{ role: 'member', percent: 10, label: 'Member discount' }]);
		expect(Object.keys(FEATURES)).toEqual(Object.keys(plan));
	});

	it('reads an empty database into empty files', async () => {
		const { manifest, settings } = await readSisters({
			cleanups,
			change: (docs) => {
				for (const name of Object.keys(docs)) docs[name] = [];
			},
		});
		expect(manifest.targets.every((target) => target.records === 0)).toBe(true);
		expect(settings.ecommerce?.settings?.['staff_alerts.recipients']).toEqual([]);
	});

	it('maps the odd shapes SB may hold', async () => {
		const { records } = await readSisters({
			cleanups,
			change: (docs) => {
				const offers = /** @type {Array<Record<string, any>>} */ (docs.offers);
				const base = /** @type {Record<string, any>} */ (offers[1]);
				offers.push(
					// either payment method: their union; a nested or: two groups; an unknown category: nothing in it
					{
						...base,
						_id: new ObjectId(sbHex(58)),
						slug: 'either-method',
						conditions: [
							{
								type: 'group',
								operator: 'or',
								value: [
									{ type: 'payment_method', operator: 'in', value: 'cod' },
									{ type: 'payment_method', operator: 'in', value: ['bank-transfer'] },
								],
							},
						],
					},
					{
						...base,
						_id: new ObjectId(sbHex(59)),
						slug: 'nested',
						action: { type: 'percentage_discount', value: 5, target: 'matched_items' },
						conditions: [
							{
								type: 'group',
								operator: 'and',
								value: [
									{
										type: 'group',
										operator: 'or',
										value: [
											{ type: 'products', operator: 'in', value: [SB_IDS.suit] },
											{ type: 'categories', operator: 'not_in', value: ['gone'] },
										],
									},
									{ type: 'price_range', operator: 'gte', value: 100 },
								],
							},
						],
						schedule: { daysOfWeek: [1], startTime: '9:30' },
					},
					{
						...base,
						_id: new ObjectId(sbHex(70)),
						slug: 'unknown-only',
						action: { type: 'percentage_discount', value: 5, target: 'matched_items' },
						conditions: [{ type: 'categories', operator: 'in', value: ['gone'] }],
					},
					{
						...base,
						_id: new ObjectId(sbHex(71)),
						slug: 'checkout-items',
						action: { type: 'percentage_discount', value: 5, target: 'matched_items' },
					},
					{
						...base,
						_id: new ObjectId(sbHex(72)),
						slug: 'too-many-prices',
						action: { type: 'percentage_discount', value: 5, target: 'matched_items' },
						conditions: [
							{
								type: 'group',
								operator: 'or',
								value: [
									{ type: 'price_range', operator: 'lte', value: 10 },
									{ type: 'categories', operator: 'in', value: ['lawn'] },
								],
							},
						],
					},
					{
						...base,
						_id: new ObjectId(sbHex(73)),
						slug: 'bad-price',
						action: { type: 'percentage_discount', value: 5, target: 'matched_items' },
						conditions: [{ type: 'price_range', operator: 'between', value: [1] }],
					},
					{
						...base,
						_id: new ObjectId(sbHex(74)),
						slug: 'mixed-checkout',
						conditions: [
							{
								type: 'group',
								operator: 'or',
								value: [
									{ type: 'cart_total', operator: 'gte', value: 5 },
									{ type: 'payment_method', operator: 'in', value: ['cod'] },
								],
							},
						],
					},
					{
						...base,
						_id: new ObjectId(sbHex(75)),
						slug: 'no-date',
						createdAt: undefined,
						sortOrder: 1.6,
						schedule: undefined,
						constraints: undefined,
					},
					{ ...base, _id: new ObjectId(sbHex(76)), slug: 'no-action', action: undefined },
				);
				const orders = /** @type {Array<Record<string, any>>} */ (docs.orders);
				const order = /** @type {Record<string, any>} */ (orders[2]);
				orders.push({
					...order,
					_id: new ObjectId(sbHex(67)),
					orderNumber: 'IM-2026-0008',
					status: 'delivered',
					timeline: [],
					payment: 'card',
					dispatchVideoUrl: 'uploads/clip.mp4',
					totals: { ...order.totals, totalRupees: 0, shippingRupees: 0, subtotalRupees: 3000 },
				});
			},
		});
		const deals = new Map((await records('ecommerce.deals')).map((deal) => [deal.slug, deal]));
		expect(deals.get('either-method')?.conditions).toMatchObject({ paymentMethods: ['cod', 'bank_transfer'], cartTotal: 0 });
		expect(deals.get('nested')).toMatchObject({
			conditions: {
				groups: [{ rules: [{ field: 'products', values: [`prd_${SB_IDS.suit}`] }] }, { rules: [] }],
				priceRange: { min: 10_000, max: null },
			},
			days: [1],
			timeFrom: '09:30',
		});
		expect(deals.get('unknown-only')).toMatchObject({ active: false, conditions: null });
		expect(deals.get('checkout-items')).toMatchObject({ active: false, target: 'cart' });
		expect(deals.get('no-date')).toMatchObject({ sort: 2, priority: 0, limit: null, used: 0, allowPoints: false, days: [] });
		expect(deals.get('no-date')).not.toHaveProperty('createdAt');
		for (const slug of ['too-many-prices', 'bad-price', 'mixed-checkout', 'no-action']) expect(deals.has(slug)).toBe(false);
		const orders = new Map((await records('ecommerce.orders')).map((order) => [order.number, order]));
		expect(orders.get('IM-2026-0008')).toMatchObject({
			payment: { method: 'online' },
			payments: [],
			history: [{ from: null, to: 'delivered', note: 'Imported: no timeline' }],
			deliveredAt: '2026-08-27T10:00:00.000Z',
			media: [{ key: 'uploads/clip.mp4' }],
			totals: { discount: 300_000, total: 0 },
		});
	});

	it('maps the odd people, catalog and loyalty shapes SB may hold', async () => {
		const { records } = await readSisters({
			cleanups,
			change: (docs) => {
				/** @param {string} name */
				const list = (name) => /** @type {Array<Record<string, any>>} */ (docs[name]);
				list('users').push({
					_id: new ObjectId(sbHex(4)),
					email: 'cashier@example.com',
					passwordHash: 'not-a-hash',
					name: 'Sample Cashier',
					phoneNumber: 'n/a',
					role: 'cashier',
					isActive: false,
					isSuperAdmin: false,
					createdAt: new Date('2026-08-09T10:00:00Z'),
				});
				list('activityentries').push(
					{
						_id: new ObjectId(sbHex(703)),
						actorName: 'Sample',
						actorRole: 'owner',
						action: 'updated',
						resourceType: 'loyalty',
						resourceId: sbHex(80),
						resourceLabel: 'Member One',
						createdAt: new Date('2026-08-28T10:00:00Z'),
					},
					{
						_id: new ObjectId(sbHex(704)),
						actorName: 'Sample',
						actorRole: 'owner',
						resourceType: 'widget',
						resourceLabel: 'x',
						createdAt: new Date('2026-08-28T10:00:00Z'),
					},
					{
						_id: new ObjectId(sbHex(705)),
						actorName: '',
						actorRole: '',
						resourceType: '',
						resourceLabel: '',
						createdAt: new Date('2026-08-28T10:00:00Z'),
					},
				);
				list('membershiprequests').push(
					// completed without its customer: found by the member's phone
					{
						_id: new ObjectId(sbHex(26)),
						name: 'Member One',
						phoneNumber: '0300 0000001',
						status: 'completed',
						completedAt: new Date('2026-09-02T10:00:00Z'),
						createdAt: new Date('2026-09-01T10:00:00Z'),
					},
					{
						_id: new ObjectId(sbHex(27)),
						name: 'Someone',
						phoneNumber: 'abc',
						status: 'invited',
						createdAt: new Date('2026-09-01T10:00:00Z'),
					},
					{
						_id: new ObjectId(sbHex(28)),
						name: 'Reopened',
						phoneNumber: '+923000000013',
						status: 'pending',
						invitedByUserId: new ObjectId(sbHex(1)),
						invitedAt: new Date('2026-09-01T10:00:00Z'),
						createdAt: new Date('2026-08-30T10:00:00Z'),
					},
				);
				const memberA = /** @type {Record<string, any>} */ (list('customers')[0]);
				memberA.addresses.push({
					_id: new ObjectId(sbHex(102)),
					recipientName: 'Member One',
					phoneNumber: '03000000001',
					city: 'Sample City',
					isDefault: false,
				});
				const guest = /** @type {Record<string, any>} */ (list('customers')[1]);
				guest.addresses = 'none';
				list('sizecharts').push({ _id: new ObjectId(sbHex(90)), name: 'Plain', rows: 'none', isActive: false });
				list('categories').push({
					_id: new ObjectId(sbHex(91)),
					slug: 'misc',
					label: 'Misc',
					description: 'Misc.',
					sortOrder: 2.6,
					isActive: true,
					defaultSizeChartId: new ObjectId(sbHex(99)),
					seo: { noindex: true, description: 'Misc things', ogImageUrl: '//cdn.example.com/x.webp' },
				});
				list('brands').push({
					_id: new ObjectId(sbHex(92)),
					slug: 'only-formals',
					name: 'Only formals',
					categorySlugs: ['formals'],
					isActive: true,
				});
				list('seosurfaces').push({
					_id: new ObjectId(sbHex(93)),
					categorySlug: 'lawn',
					brandSlug: 'only-formals',
					title: 'T',
					description: 'D',
					headline: 'H',
					intro: 'I',
					canonicalQuery: '?brand=only-formals',
				});
				list('products').push({
					_id: new ObjectId(sbHex(94)),
					slug: 'misc-one',
					name: 'Misc one',
					brandSlug: 'nobody',
					categorySlug: 'gone',
					isActive: true,
					images: [{ alt: 'no variants' }, { variants: { full: 'not a url/%E0%A4%A.webp' }, alt: 'x', blurDataURL: 'nope' }],
					video: 'http://cdn.example.com/v.webm',
					variants: [
						{ _id: new ObjectId(sbHex(95)), priceRupees: 10, quantity: 'x', warrantyDays: -1, attributes: { size: null } },
					],
				});
				const account = /** @type {Record<string, any>} */ (list('loyaltyaccounts')[1]);
				account.balance = 15;
				account.transactions.push(
					{ kind: 'earn', amount: 0, occurredAt: new Date('2026-08-12T12:00:00Z'), reason: 'nothing' },
					{ kind: 'earn', amount: 5, reason: 'no time' },
					{ kind: 'earn', amount: 7, occurredAt: new Date('2026-08-12T13:00:00Z'), reason: 'no id' },
				);
				delete account.updatedAt;
			},
		});
		const users = new Map((await records('accounts.users')).map((user) => [user.id, user]));
		const cashier = users.get(`usr_${sbHex(4)}`);
		expect(cashier).toMatchObject({ role: 'support_staff', blocked: { at: '2026-08-09T10:00:00.000Z' } });
		expect(cashier).not.toHaveProperty('phone');
		expect(users.get(`usr_${SB_IDS.memberA}`)?.addresses[2]).toMatchObject({ line1: 'Sample City', phone: '+923000000001' });
		const copies = await records('accounts.copies');
		expect(copies.slice(3).map((copy) => [copy.action, copy.target, copy.actor.kind])).toEqual([
			['loyalty.updated', sbHex(80), 'anonymous'],
			['widget.updated', 'widget', 'anonymous'],
			['activity.updated', 'unknown', 'anonymous'],
		]);
		const requests = new Map((await records('accounts.requests')).map((request) => [request.id, request]));
		expect(requests.get(`rrq_${sbHex(26)}`)).toMatchObject({ status: 'completed', userId: `usr_${SB_IDS.memberA}` });
		expect(requests.get(`rrq_${sbHex(27)}`)).not.toHaveProperty('userId');
		expect(requests.get(`rrq_${sbHex(28)}`)).toMatchObject({ status: 'pending' });
		expect(requests.get(`rrq_${sbHex(28)}`)).not.toHaveProperty('invitedAt');
		const charts = await records('ecommerce.size_charts');
		expect(charts.find((chart) => chart.id === `szc_${sbHex(90)}`)).toMatchObject({
			unit: 'in',
			rows: [],
			columns: [],
			active: false,
		});
		const misc = (await records('ecommerce.categories')).find((category) => category.slug === 'misc');
		expect(misc).toMatchObject({
			sort: 3,
			seo: { noindex: true, description: 'Misc things', ogImage: 'https://cdn.example.com/x.webp' },
		});
		expect(misc).not.toHaveProperty('sizeChartId');
		// a brand of another category, found by its slug
		expect((await records('ecommerce.landings')).find((landing) => landing.id === `lnd_${sbHex(93)}`)).toMatchObject({
			brandId: `brd_${sbHex(92)}`,
		});
		const product = (await records('ecommerce.products')).find((record) => record.slug === 'misc-one');
		expect(product).toMatchObject({
			categoryIds: [],
			brandId: null,
			media: [{ key: 'not a url/%E0%A4%A.webp', type: 'image/webp' }],
			video: { kind: 'url', url: 'https://cdn.example.com/v.webm' },
			variants: [{ stock: 0, attributes: {} }],
		});
		expect(product.media[0]).not.toHaveProperty('blur');
		expect(product.variants[0]).not.toHaveProperty('warrantyDays');
		const [, guest] = await records('ecommerce.loyalty');
		// a transaction without a time is left out; one without an id gets one; SB's lower balance takes points back
		expect(guest.lots.map((/** @type {any} */ lot) => [lot.points, lot.left])).toEqual([
			[20, 8],
			[7, 7],
			[10, 10],
		]);
		expect(guest.lots[1].id).toMatch(/^lot_[0-9a-f]{24}$/);
		expect(guest.history.find((/** @type {any} */ entry) => entry.note === 'Imported: balance correction')).toMatchObject({
			kind: 'adjust',
			points: 12,
		});
	});

	it('shifts deal hours to the same real time once SB runs on UTC', () => {
		expect(DEAL_HOURS_SHIFT_MINUTES).toBe(0);
		expect(windowOf({ daysOfWeek: [5], startTime: '10:00', endTime: '17:59' }, 300)).toEqual({
			days: [5],
			timeFrom: '15:00',
			timeTo: '23:00',
			overnight: false,
		});
		// evening hours run past midnight; a start past midnight moves the weekday
		expect(windowOf({ daysOfWeek: [6], startTime: '20:00', endTime: '21:59' }, 300)).toMatchObject({
			days: [0],
			timeFrom: '01:00',
			timeTo: '03:00',
		});
		expect(windowOf({ daysOfWeek: [1], startTime: '17:00' }, 300)).toMatchObject({
			days: [1],
			timeFrom: '22:00',
			timeTo: '05:00',
		});
		// a whole day ends a minute before it starts again
		expect(windowOf({ daysOfWeek: [2] }, 300)).toMatchObject({ days: [2], timeFrom: '05:00', timeTo: '04:59' });
		expect(windowOf({}, 300)).toEqual({ days: [], timeFrom: '', timeTo: '', overnight: false });
		expect(windowOf({ startTime: '25:00', endTime: 'late', daysOfWeek: [9, 3, 3] })).toEqual({
			days: [3],
			timeFrom: '',
			timeTo: '',
			overnight: false,
		});
	});

	it('spreads a discount over lines by their amounts', () => {
		expect(spread(240_000, [1_000_000, 300_000])).toEqual([184_615, 55_385]);
		expect(spread(10, [0, 0])).toEqual([0, 0]);
		expect(spread(0, [5])).toEqual([0]);
		expect(spread(3, [1, 1, 1])).toEqual([1, 1, 1]);
		// never more than a line's own amount
		expect(spread(5, [1, 1])).toEqual([1, 1]);
	});

	it('sends the files and verifies them against the products', async () => {
		const { dir, manifest } = await readSisters({ cleanups });
		/** @type {Record<string, ReturnType<typeof fakeProduct>>} */
		const fakes = {};
		for (const product of ['accounts', 'ecommerce', 'notifications', 'payments', 'growth'])
			fakes[product] = fakeProduct({
				token: `${product}-token`,
				keys: { roles: ['key'], loyalty: ['customerId'] },
				totals: manifest.totals[product] ?? {},
			});
		/** @type {typeof globalThis.fetch} */
		const fetch = async (input, init) => {
			const url = new URL(new Request(input, init).url);
			return /** @type {ReturnType<typeof fakeProduct>} */ (fakes[url.hostname.split('.')[0] ?? '']).fetch(input, init);
		};
		const products = Object.fromEntries(
			Object.keys(fakes).map((product) => [product, { url: `https://${product}.example.com`, token: `${product}-token` }]),
		);
		const report = await send({ dir, products, fetch, sleep: async () => {} });
		expect(report.steps.every((step) => step.failed.length === 0)).toBe(true);
		expect(report.finished.map((finish) => finish.product)).toEqual(['accounts', 'ecommerce']);
		// the fake knows only two settings: the rest is listed as refused
		expect(report.settings.refused.length).toBeGreaterThan(100);
		const checked = await verify({ dir, products, fetch });
		expect(checked.ok).toBe(true);
		expect(checked.steps.find((step) => step.collection === 'orders')).toMatchObject({ expected: 7, imported: 7, counted: 7 });
	});
});
