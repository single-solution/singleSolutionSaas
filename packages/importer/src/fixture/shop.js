/**
 * The example shop (`@ss/importer/fixture`): a small shop as an older shop system kept it, in one MongoDB database —
 * ObjectId ids, prices in dollars, phones as typed, slugs where the products use ids, one customer saved twice, loyalty
 * transactions, chats with their messages inside them and daily analytics — and `SHOP_MAPPING`, which moves it into
 * Accounts, Ecommerce, Chat and Growth in import order (PLAN 0.8.10 Migration). A neutral example, no real store: the
 * e2e suite imports it through the real products (`e2e/tests/import.test.js`) and this unit's tests read it.
 * @module
 */
import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { normalizePhone } from '@ss/contracts/phone';
import { defineMapping } from '../mapping.js';

/** The example shop's calling code: its phones were typed nationally (the products read them with business.json). */
const CALLING_CODE = '+1';

/** A source id: `n` in the last digits of 24. @param {number} n */
export const shopHex = (n) => `65e000000000000000000${String(n).padStart(3, '0')}`;
/** @param {number} n */
const oid = (n) => new ObjectId(shopHex(n));
/** @param {string} text */
const at = (text) => new Date(text);

/** The example shop's passwords, as its people typed them (the source keeps only their bcrypt hashes). */
export const SHOP_PASSWORDS = Object.freeze({
	owner: 'example owner password',
	staff: 'example staff password',
	member: 'example member password',
});
/** bcrypt (cost 4) of {@link SHOP_PASSWORDS}, as the source keeps them. */
const HASHES = Object.freeze({
	owner: '$2b$04$O3n1py50cwPR3NbndsU7DOLsyi71IXc9B27HWt98GwfNoRTjFzItG',
	staff: '$2b$04$ECbDQlzOgD7yNf7./2Gd4eueFzvrbDAgEbZxAAwiXSem.bmL7Gp6S',
	member: '$2b$04$34D8qSO4xRV/G002opYLjOk7tf6MlCW.DpqRqIF2O8a0XGaq7Xllu',
});

/** The source ids the tests refer to. */
export const SHOP_IDS = Object.freeze({
	owner: shopHex(1),
	support: shopHex(2),
	member: shopHex(4),
	guest: shopHex(5),
	guestAgain: shopHex(6),
	tee: shopHex(12),
	tote: shopHex(15),
	delivered: shopHex(18),
	confirmed: shopHex(20),
	canceled: shopHex(22),
	alert: shopHex(28),
	chat: shopHex(30),
});

/** The guest cookie value the old shop gave the chatting guest (Chat keeps only its hash, C7). */
export const SHOP_GUEST_COOKIE = 'example-guest-cookie-0001';

/**
 * The source documents, by collection (fresh objects each call: `seedShop` stores them).
 * @returns {Record<string, Array<Record<string, any>>>}
 */
export const shopSource = () => ({
	settings: [
		{
			_id: oid(35),
			orderPrefix: 'EX-',
			currency: 'USD',
			imageBase: 'https://cdn.example.com',
			// the old shop's own order statuses (each with the stage it stands for) and the moves it allowed
			orderStatuses: [
				{ key: 'awaiting_payment', name: 'Awaiting payment', stage: 'unpaid' },
				{ key: 'pending', name: 'Pending', stage: 'new' },
				{ key: 'confirmed', name: 'Confirmed', stage: 'open' },
				{ key: 'packed', name: 'Packed', stage: 'packed' },
				{ key: 'shipped', name: 'Shipped', stage: 'shipped' },
				{ key: 'delivered', name: 'Delivered', stage: 'delivered' },
				{ key: 'canceled', name: 'Canceled', stage: 'canceled' },
			],
			orderMoves: [
				['awaiting_payment', 'confirmed'],
				['awaiting_payment', 'canceled'],
				['pending', 'confirmed'],
				['pending', 'canceled'],
				['confirmed', 'packed'],
				['confirmed', 'canceled'],
				['packed', 'shipped'],
				['packed', 'canceled'],
				['shipped', 'delivered'],
			],
			updatedAt: at('2026-01-01T00:00:00Z'),
		},
	],
	roles: [{ _id: oid(3), key: 'member', name: 'Member', description: 'Members get early access to sales.' }],
	staff: [
		{
			_id: oid(1),
			name: 'Olive Owner',
			email: 'Olive@Example.com',
			role: 'admin',
			passwordHash: HASHES.owner,
			createdAt: at('2025-01-10T09:00:00Z'),
		},
		{
			_id: oid(2),
			name: 'Sam Support',
			email: 'sam@example.com',
			role: 'staff',
			passwordHash: HASHES.staff,
			createdAt: at('2025-02-01T09:00:00Z'),
		},
	],
	customers: [
		{
			_id: oid(4),
			name: 'Mia Member',
			email: 'mia@example.com',
			phone: '(555) 010-0001',
			city: 'Springfield',
			member: true,
			memberSince: at('2025-03-01T00:00:00Z'),
			passwordHash: HASHES.member,
			createdAt: at('2025-03-01T00:00:00Z'),
		},
		{ _id: oid(5), name: 'Gus Guest', phone: '555-010-0002', city: 'Shelbyville', createdAt: at('2025-04-01T00:00:00Z') },
		// the same guest again, typed with the country code: one customer (merged by phone)
		{ _id: oid(6), name: 'Gus G.', phone: '+1 555 010 0002', createdAt: at('2025-05-01T00:00:00Z') },
	],
	sizecharts: [
		{
			_id: oid(7),
			name: 'Tops',
			unit: 'cm',
			columns: ['chest', 'length'],
			rows: [
				{ size: 'M', chest: 96, length: 70 },
				{ size: 'L', chest: 102, length: 72 },
			],
		},
	],
	categories: [
		{
			_id: oid(8),
			slug: 'clothing',
			name: 'Clothing',
			parent: null,
			sort: 1,
			active: true,
			createdAt: at('2025-01-15T00:00:00Z'),
		},
		{
			_id: oid(9),
			slug: 'tops',
			name: 'Tops',
			parent: 'clothing',
			sizeChart: oid(7),
			sort: 2,
			active: true,
			createdAt: at('2025-01-15T00:00:00Z'),
		},
	],
	brands: [{ _id: oid(10), slug: 'northwind', name: 'Northwind', categories: ['clothing'] }],
	attributes: [{ _id: oid(11), slug: 'color', name: 'Color', values: ['Red', 'Blue'] }],
	products: [
		{
			_id: oid(12),
			slug: 'cotton-tee',
			name: 'Cotton tee',
			summary: 'A soft cotton tee.',
			category: 'tops',
			brand: 'northwind',
			images: ['uploads/cotton-tee.webp'],
			variants: [
				{ _id: oid(13), sku: 'TEE-RED', color: 'Red', price: 25, comparePrice: 30, stock: 5 },
				{ _id: oid(14), sku: 'TEE-BLUE', color: 'Blue', price: 25, stock: 0 },
			],
			// the old shop's own counts: its orders and reviews move too, so the products count them again
			sold: 40,
			rating: 4.5,
			reviews: 6,
			createdAt: at('2025-03-05T00:00:00Z'),
		},
		{
			_id: oid(15),
			slug: 'canvas-tote',
			name: 'Canvas tote',
			summary: 'A sturdy tote bag.',
			category: 'clothing',
			brand: 'northwind',
			images: ['uploads/canvas-tote.webp'],
			variants: [{ _id: oid(16), sku: 'TOTE', price: 15, stock: 12 }],
			// no order or review of it moves: these numbers stay
			sold: 9,
			rating: 4,
			reviews: 3,
			createdAt: at('2025-03-06T00:00:00Z'),
		},
	],
	deals: [
		{
			_id: oid(17),
			name: 'Tee week',
			slug: 'tee-week',
			percent: 10,
			products: ['cotton-tee'],
			limit: 100,
			used: 3,
			startsAt: at('2026-06-01T00:00:00Z'),
		},
	],
	orders: [
		{
			_id: oid(18),
			number: 'EX-2026-000101',
			customer: oid(4),
			name: 'Mia Member',
			email: 'mia@example.com',
			phone: '(555) 010-0001',
			address: { line1: '12 Elm Street', city: 'Springfield', zip: '01101' },
			payment: 'cod',
			deliveryFee: 5,
			items: [
				{
					_id: oid(19),
					product: 'cotton-tee',
					variant: oid(13),
					name: 'Cotton tee',
					variantName: 'Red',
					sku: 'TEE-RED',
					qty: 1,
					price: 25,
				},
			],
			status: 'delivered',
			history: [
				{ status: 'confirmed', at: at('2026-07-01T09:00:00Z'), by: 'Mia Member' },
				{ status: 'packed', at: at('2026-07-01T15:00:00Z'), by: 'Sam Support' },
				{ status: 'shipped', at: at('2026-07-02T09:00:00Z'), by: 'Sam Support' },
				{ status: 'delivered', at: at('2026-07-04T12:00:00Z'), by: 'Sam Support' },
			],
			pointsEarned: 25,
			placedAt: at('2026-07-01T09:00:00Z'),
		},
		{
			_id: oid(20),
			number: 'EX-2026-000102',
			// the guest's second record (merged into the first)
			customer: oid(6),
			name: 'Gus Guest',
			phone: '+1 555 010 0002',
			address: { line1: '4 Oak Avenue', city: 'Shelbyville', zip: '01102' },
			payment: 'bank-transfer',
			deliveryFee: 5,
			items: [
				{
					_id: oid(21),
					product: 'cotton-tee',
					variant: oid(14),
					name: 'Cotton tee',
					variantName: 'Blue',
					sku: 'TEE-BLUE',
					qty: 1,
					price: 25,
				},
			],
			status: 'confirmed',
			history: [
				{ status: 'awaiting_payment', at: at('2026-08-10T10:00:00Z'), by: 'Gus Guest' },
				{ status: 'confirmed', at: at('2026-08-10T12:00:00Z'), by: 'Sam Support' },
			],
			placedAt: at('2026-08-10T10:00:00Z'),
		},
		{
			_id: oid(22),
			number: 'EX-2026-000103',
			customer: oid(5),
			name: 'Gus Guest',
			phone: '555-010-0002',
			address: { line1: '4 Oak Avenue', city: 'Shelbyville', zip: '01102' },
			payment: 'cod',
			deliveryFee: 5,
			items: [
				{
					_id: oid(23),
					product: 'cotton-tee',
					variant: oid(13),
					name: 'Cotton tee',
					variantName: 'Red',
					sku: 'TEE-RED',
					qty: 2,
					price: 25,
				},
			],
			status: 'canceled',
			history: [
				{ status: 'pending', at: at('2026-09-01T10:00:00Z'), by: 'Gus Guest' },
				{ status: 'canceled', at: at('2026-09-01T11:00:00Z'), by: 'Sam Support' },
			],
			placedAt: at('2026-09-01T10:00:00Z'),
		},
	],
	points: [
		{
			_id: oid(24),
			customer: oid(4),
			kind: 'earn',
			points: 25,
			order: oid(18),
			note: 'EX-2026-000101',
			at: at('2026-07-04T12:00:00Z'),
		},
		{ _id: oid(25), customer: oid(4), kind: 'bonus', points: 10, note: 'Welcome bonus', at: at('2026-08-01T00:00:00Z') },
	],
	reviews: [
		{
			_id: oid(26),
			product: 'cotton-tee',
			order: oid(18),
			item: oid(19),
			customer: oid(4),
			name: 'Mia M.',
			rating: 5,
			title: 'Soft and comfy',
			body: 'Fits well and washes well.',
			approved: true,
			createdAt: at('2026-07-10T00:00:00Z'),
		},
	],
	returns: [
		{
			_id: oid(27),
			reference: 'R-000001',
			order: oid(18),
			orderNumber: 'EX-2026-000101',
			customer: oid(4),
			items: [{ item: oid(19), qty: 1 }],
			reason: 'Too small',
			status: 'requested',
			createdAt: at('2026-07-12T00:00:00Z'),
		},
	],
	stockalerts: [
		{
			_id: oid(28),
			product: 'cotton-tee',
			variant: oid(14),
			phone: '555-010-0002',
			customer: oid(5),
			createdAt: at('2026-08-05T00:00:00Z'),
		},
	],
	wishlists: [{ _id: oid(29), customer: oid(4), products: ['canvas-tote'] }],
	chats: [
		{
			_id: oid(30),
			guestCookie: SHOP_GUEST_COOKIE,
			cookieExpires: at('2027-01-01T00:00:00Z'),
			name: 'Gus Guest',
			phone: '555-010-0002',
			status: 'closed',
			assignedTo: oid(2),
			messages: [
				{ _id: oid(31), from: 'visitor', text: 'Will the blue tee be back?', at: at('2026-08-05T10:00:00Z') },
				{
					_id: oid(32),
					from: 'staff',
					staff: oid(2),
					staffName: 'Sam Support',
					text: 'Yes, next week. We will let you know.',
					at: at('2026-08-05T10:04:00Z'),
				},
			],
			createdAt: at('2026-08-05T10:00:00Z'),
		},
	],
	dailystats: [
		{
			_id: oid(33),
			day: '2026-09-01',
			visits: 120,
			pageViews: 300,
			pages: [
				{ path: '/', views: 180 },
				{ path: '/products/cotton-tee', views: 120 },
			],
			sources: [
				{ source: 'www.google.com', visits: 70 },
				{ source: '(direct)', visits: 50 },
			],
		},
		{
			_id: oid(34),
			day: '2026-09-02',
			visits: 80,
			pageViews: 200,
			pages: [
				{ path: '/', views: 150 },
				{ path: '/products/canvas-tote', views: 50 },
			],
			sources: [{ source: '(direct)', visits: 80 }],
		},
	],
});

/**
 * Store the source documents in a (test) database.
 * @param {import('mongodb').Db} db
 */
export const seedShop = async (db) => {
	for (const [name, docs] of Object.entries(shopSource())) await db.collection(name).insertMany(docs);
};

/** @param {unknown} value */
const iso = (value) => (value instanceof Date ? value.toISOString() : null);
/** Dollars to cents. @param {unknown} dollars */
const cents = (dollars) => Math.round(Number(dollars) * 100);
/** @param {string} text */
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
/** @param {unknown} sourceId */
const hexKey = (sourceId) => String(sourceId);

/**
 * The stage each of the old shop's own statuses stands for → the role it has in Ecommerce's order flow (the engine's
 * fixed status roles). The statuses themselves are the shop's: its keys and names become the website's order flow
 * (fixed-choices audit K9), so orders keep their own statuses.
 */
const STAGE_ROLES = Object.freeze({
	unpaid: 'awaiting_payment',
	new: 'awaiting_confirmation',
	open: 'open',
	packed: 'packed',
	shipped: 'shipped',
	delivered: 'delivered',
	canceled: 'canceled',
});
/** The old shop's payment methods → the keys of Ecommerce's payment methods list (IMP-32), with each one's kind. */
const METHODS = Object.freeze({ cod: 'cod', 'bank-transfer': 'bank_transfer', card: 'online' });
const KINDS = Object.freeze({ cod: 'on_delivery', bank_transfer: 'pay_first', online: 'gateway' });
/** The old shop's staff roles → Accounts' owner (the one role every website has) and a ready-made staff role. */
const STAFF_ROLES = Object.freeze({ admin: 'owner', staff: 'support_staff' });

/**
 * An order's payment entry by the status rule (IMP-13): a bank transfer is paid at its first `confirmed` entry, cash
 * on delivery at `delivered`; a canceled order has none.
 * @param {Record<string, any>} doc @param {number} total @param {import('../mapping.js').MapContext} ctx
 */
const paymentsOf = (doc, total, ctx) => {
	const method = /** @type {Record<string, string>} */ (METHODS)[doc.payment] ?? 'cod';
	const entry = doc.history.find(
		(/** @type {{ status: string }} */ step) => step.status === (method === 'cod' ? 'delivered' : 'confirmed'),
	);
	if (!entry || doc.status === 'canceled') return [];
	return [
		{
			id: ctx.id('opy', doc._id),
			method: method === 'cod' ? 'cod' : 'bank_transfer',
			amount: total,
			note: 'Imported',
			at: iso(entry.at),
		},
	];
};

/** The example shop's mapping, in import order (PLAN 0.8.10 Migration steps 1–8). */
export const SHOP_MAPPING = defineMapping({
	name: 'example-shop',
	description: 'Test mapping: the example shop (people, catalog, orders, chats and analytics) into four products (e2e).',
	steps: [
		// 1. Accounts: roles, then staff and members (staff and shoppers stay separate users)
		{
			product: 'accounts',
			collection: 'roles',
			source: 'roles',
			prefix: 'role',
			key: ['key'],
			map: (doc) => ({ key: doc.key, name: doc.name, description: doc.description, permissions: [], rank: 800 }),
		},
		{
			product: 'accounts',
			collection: 'users',
			source: 'staff',
			prefix: 'usr',
			map: (doc, ctx) => ({
				id: ctx.id('usr', doc._id),
				name: doc.name,
				email: doc.email,
				emailVerified: true,
				role: /** @type {Record<string, string>} */ (STAFF_ROLES)[doc.role] ?? 'support_staff',
				passwordHash: doc.passwordHash,
				createdAt: iso(doc.createdAt),
			}),
			sums: (record) => ({ 'users.staff': 1, 'users.withPassword': 1, [`users.role.${record.role}`]: 1 }),
		},
		{
			product: 'accounts',
			collection: 'users',
			source: 'customers',
			prefix: 'usr',
			filter: { member: true },
			// later steps find a member's user id by the customer's source id
			lookups: { members: (_record, doc) => hexKey(doc._id) },
			map: (doc, ctx) => ({
				id: ctx.id('usr', doc._id),
				name: doc.name,
				email: doc.email,
				phone: doc.phone,
				role: 'member',
				roleSince: iso(doc.memberSince),
				passwordHash: doc.passwordHash,
				createdAt: iso(doc.createdAt),
			}),
			sums: () => ({ 'users.withPassword': 1, 'users.role.member': 1 }),
		},
		// 3. Ecommerce taxonomy (slugs → ids through lookup tables)
		{
			product: 'ecommerce',
			collection: 'size_charts',
			source: 'sizecharts',
			prefix: 'szc',
			map: (doc, ctx) => ({
				id: ctx.id('szc', doc._id),
				name: doc.name,
				unit: doc.unit,
				columns: doc.columns.map((/** @type {string} */ name) => ({
					key: name,
					label: name.charAt(0).toUpperCase() + name.slice(1),
				})),
				rows: doc.rows.map((/** @type {Record<string, any>} */ row) => ({
					size: String(row.size).toLowerCase(),
					label: row.size,
					values: Object.fromEntries(doc.columns.map((/** @type {string} */ name) => [name, String(row[name])])),
				})),
				active: true,
			}),
		},
		{
			product: 'ecommerce',
			collection: 'categories',
			source: 'categories',
			prefix: 'cat',
			lookups: { 'category-slugs': (record) => String(record.slug) },
			map: (doc, ctx) => ({
				id: ctx.id('cat', doc._id),
				slug: doc.slug,
				name: doc.name,
				parentId: doc.parent ? ctx.lookup('category-slugs', doc.parent) : null,
				...(doc.sizeChart ? { sizeChartId: ctx.ref('sizecharts', doc.sizeChart) } : {}),
				sort: doc.sort,
				status: doc.active ? 'active' : 'hidden',
				createdAt: iso(doc.createdAt),
			}),
		},
		{
			product: 'ecommerce',
			collection: 'brands',
			source: 'brands',
			prefix: 'brd',
			lookups: { 'brand-slugs': (record) => String(record.slug) },
			map: (doc, ctx) => ({
				id: ctx.id('brd', doc._id),
				slug: doc.slug,
				name: doc.name,
				categoryIds: doc.categories.map((/** @type {string} */ slug) => ctx.lookup('category-slugs', slug)),
				status: 'active',
			}),
		},
		{
			product: 'ecommerce',
			collection: 'attributes',
			source: 'attributes',
			prefix: 'att',
			lookups: { 'attribute-slugs': (record) => String(record.slug) },
			map: (doc, ctx) => ({
				id: ctx.id('att', doc._id),
				slug: doc.slug,
				name: doc.name,
				type: 'choice',
				on: 'variant',
				show: { filter: true },
				choices: doc.values.map((/** @type {string} */ label) => ({ value: label.toLowerCase(), label })),
			}),
		},
		// 5. Ecommerce products (money × 100) and deals
		{
			product: 'ecommerce',
			collection: 'products',
			source: 'products',
			prefix: 'prd',
			lookups: { 'product-slugs': (record) => String(record.slug) },
			map: (doc, ctx) => {
				const color = ctx.lookup('attribute-slugs', 'color');
				return {
					id: ctx.id('prd', doc._id),
					slug: doc.slug,
					name: doc.name,
					status: 'active',
					summary: doc.summary,
					categoryIds: [ctx.lookup('category-slugs', doc.category)],
					brandId: ctx.lookup('brand-slugs', doc.brand),
					media: doc.images.map((/** @type {string} */ key) => ({ key, alt: doc.name })),
					variants: doc.variants.map((/** @type {Record<string, any>} */ variant) => ({
						id: ctx.id('var', variant._id),
						sku: variant.sku,
						price: cents(variant.price),
						compareAtPrice: variant.comparePrice ? cents(variant.comparePrice) : null,
						stock: variant.stock,
						attributes: variant.color && color ? { [color]: variant.color.toLowerCase() } : {},
					})),
					sold: doc.sold,
					rating: { average: doc.rating, count: doc.reviews },
					createdAt: iso(doc.createdAt),
				};
			},
			sums: (record) => {
				const variants = /** @type {Array<{ stock: number }>} */ (record.variants);
				return {
					products: 1,
					'products.active': 1,
					variants: variants.length,
					'stock.units': variants.reduce((sum, variant) => sum + variant.stock, 0),
				};
			},
			countPath: '/v1/products/count',
		},
		{
			product: 'ecommerce',
			collection: 'deals',
			source: 'deals',
			prefix: 'deal',
			map: (doc, ctx) => ({
				id: ctx.id('deal', doc._id),
				name: doc.name,
				slug: doc.slug,
				type: 'percent',
				value: doc.percent,
				scope: { productIds: doc.products.map((/** @type {string} */ slug) => ctx.lookup('product-slugs', slug)) },
				startsAt: iso(doc.startsAt),
				limit: doc.limit,
				used: doc.used,
			}),
			sums: (record) => ({ 'deals.used': Number(record.used) }),
		},
		// 6. Ecommerce shoppers and orders
		{
			product: 'ecommerce',
			collection: 'customers',
			source: 'customers',
			prefix: 'cus',
			// one customer per phone (K12): the guest saved twice becomes one, the oldest record kept
			mergeKey: (doc) => normalizePhone(doc.phone, CALLING_CODE) ?? hexKey(doc._id),
			lookups: { customers: (_record, doc) => hexKey(doc._id) },
			map: (doc, ctx) => {
				const userId = ctx.lookup('members', hexKey(doc._id));
				return {
					id: ctx.id('cus', doc._id),
					...(userId ? { userId } : {}),
					name: doc.name,
					email: doc.email ?? '',
					phone: doc.phone,
					city: doc.city ?? '',
					createdAt: iso(doc.createdAt),
				};
			},
			sums: () => ({ customers: 1 }),
		},
		{
			product: 'ecommerce',
			collection: 'orders',
			source: 'orders',
			prefix: 'ord',
			map: (doc, ctx) => {
				const lines = doc.items.map((/** @type {Record<string, any>} */ item) => ({
					id: ctx.id('oln', item._id),
					productId: ctx.lookup('product-slugs', item.product),
					variantId: ctx.id('var', item.variant),
					name: item.name,
					variantName: item.variantName,
					sku: item.sku,
					unitPrice: cents(item.price),
					quantity: item.qty,
					discount: 0,
					total: cents(item.price) * item.qty,
				}));
				const goods = lines.reduce((/** @type {number} */ sum, /** @type {{ total: number }} */ line) => sum + line.total, 0);
				const fee = cents(doc.deliveryFee);
				const total = goods + fee;
				/** @type {Array<{ status: string, at: Date, by: string }>} */
				const steps = doc.history;
				const delivered = steps.filter((step) => step.status === 'delivered').at(-1);
				return {
					id: ctx.id('ord', doc._id),
					number: doc.number,
					customer: {
						userId: ctx.lookup('members', hexKey(doc.customer)) ?? '',
						customerId: ctx.lookup('customers', hexKey(doc.customer)),
						name: doc.name,
						email: doc.email ?? '',
						phone: doc.phone,
					},
					address: {
						name: doc.name,
						phone: doc.phone,
						line1: doc.address.line1,
						line2: '',
						city: doc.address.city,
						area: '',
						region: '',
						postalCode: doc.address.zip,
						country: 'US',
						notes: '',
					},
					delivery: {
						method: 'delivery',
						zone: doc.address.city,
						rate: 'standard',
						rateName: 'Standard',
						fee,
						locationId: null,
					},
					lines,
					totals: { subtotal: goods, discount: 0, delivery: fee, tax: 0, total, currency: 'USD', taxIncluded: true },
					promotions: {
						released: doc.status === 'canceled',
						...(doc.pointsEarned ? { pointsEarned: doc.pointsEarned, pointsCredited: true } : {}),
					},
					payment: (() => {
						const method = /** @type {Record<string, string>} */ (METHODS)[doc.payment] ?? 'cod';
						return { method, kind: /** @type {Record<string, string>} */ (KINDS)[method] };
					})(),
					payments: paymentsOf(doc, total, ctx),
					status: doc.status,
					history: steps.map((step, index) => ({
						at: iso(step.at),
						from: index === 0 ? null : /** @type {{ status: string }} */ (steps[index - 1]).status,
						to: step.status,
						by: step.by,
						note: '',
					})),
					stockHeld: doc.status !== 'canceled',
					placedAt: iso(doc.placedAt),
					deliveredAt: delivered ? iso(delivered.at) : null,
				};
			},
			sums: (record) => ({
				[`orders.${record.status}.count`]: 1,
				[`orders.${record.status}.total`]: /** @type {{ total: number }} */ (record.totals).total,
			}),
			countPath: '/v1/orders/count',
		},
		{
			product: 'ecommerce',
			collection: 'loyalty',
			source: 'points',
			prefix: 'lot',
			key: ['customerId'],
			// one account per customer: its lots rebuilt from the transactions (IMP-5: a bonus is an adjust credit)
			mergeKey: (_doc, record) => String(record.customerId),
			merge: (kept, next) => ({
				...kept,
				lots: [.../** @type {unknown[]} */ (kept.lots), .../** @type {unknown[]} */ (next.lots)],
				history: [.../** @type {unknown[]} */ (kept.history), .../** @type {unknown[]} */ (next.history)],
			}),
			map: (doc, ctx) => {
				const kind = doc.kind === 'earn' ? 'earn' : 'adjust';
				const orderId = doc.order ? ctx.ref('orders', doc.order) : null;
				return {
					customerId: ctx.lookup('customers', hexKey(doc.customer)),
					userId: ctx.lookup('members', hexKey(doc.customer)),
					lots: [
						{
							id: ctx.id('lot', doc._id),
							points: doc.points,
							left: doc.points,
							earnedAt: iso(doc.at),
							expiresAt: null,
							orderId,
							kind,
						},
					],
					history: [{ at: iso(doc.at), kind, points: doc.points, orderId, note: doc.note }],
				};
			},
			sums: (record) => ({
				'loyalty.points': /** @type {Array<{ left: number }>} */ (record.lots).reduce((sum, lot) => sum + lot.left, 0),
			}),
		},
		{
			product: 'ecommerce',
			collection: 'reviews',
			source: 'reviews',
			prefix: 'rev',
			map: (doc, ctx) => ({
				id: ctx.id('rev', doc._id),
				productId: ctx.lookup('product-slugs', doc.product),
				userId: ctx.lookup('members', hexKey(doc.customer)) ?? '',
				orderId: ctx.ref('orders', doc.order),
				lineId: ctx.id('oln', doc.item),
				name: doc.name,
				rating: doc.rating,
				title: doc.title,
				body: doc.body,
				status: doc.approved ? 'approved' : 'pending',
				createdAt: iso(doc.createdAt),
			}),
			sums: () => ({ reviews: 1 }),
		},
		{
			product: 'ecommerce',
			collection: 'returns',
			source: 'returns',
			prefix: 'ret',
			map: (doc, ctx) => ({
				id: ctx.id('ret', doc._id),
				reference: doc.reference,
				orderId: ctx.ref('orders', doc.order),
				orderNumber: doc.orderNumber,
				userId: ctx.lookup('members', hexKey(doc.customer)) ?? '',
				kind: 'return',
				lines: doc.items.map((/** @type {Record<string, any>} */ item) => ({
					lineId: ctx.id('oln', item.item),
					quantity: item.qty,
				})),
				reason: doc.reason,
				status: doc.status,
				history: [{ at: iso(doc.createdAt), status: 'requested', by: 'shopper', note: '' }],
				createdAt: iso(doc.createdAt),
			}),
			sums: () => ({ returns: 1 }),
		},
		{
			product: 'ecommerce',
			collection: 'alerts',
			source: 'stockalerts',
			prefix: 'alr',
			map: (doc, ctx) => ({
				id: ctx.id('alr', doc._id),
				kind: 'back_in_stock',
				productId: ctx.lookup('product-slugs', doc.product),
				variantId: ctx.id('var', doc.variant),
				phone: doc.phone,
				customerId: ctx.lookup('customers', hexKey(doc.customer)),
				status: 'waiting',
				createdAt: iso(doc.createdAt),
			}),
		},
		{
			product: 'ecommerce',
			collection: 'wishlists',
			source: 'wishlists',
			prefix: 'wsh',
			key: ['userId'],
			// a guest's list stays behind (wishlists are members')
			map: (doc, ctx) => {
				const userId = ctx.lookup('members', hexKey(doc.customer));
				return userId
					? { userId, productIds: doc.products.map((/** @type {string} */ slug) => ctx.lookup('product-slugs', slug)) }
					: null;
			},
		},
		// 7. Chat: staff (their Accounts user ids), the guest's old cookie as a hash, conversations and their messages
		{
			product: 'chat',
			collection: 'staff',
			source: 'staff',
			prefix: 'usr',
			map: (doc, ctx) => ({ id: ctx.id('usr', doc._id), name: doc.name, email: doc.email, createdAt: iso(doc.createdAt) }),
		},
		{
			product: 'chat',
			collection: 'guests',
			source: 'chats',
			prefix: 'guest',
			key: ['keyHash'],
			filter: { guestCookie: { $type: 'string' } },
			map: (doc, ctx) => ({
				keyHash: sha256(doc.guestCookie),
				id: ctx.id('guest', doc._id),
				expireAt: iso(doc.cookieExpires),
				createdAt: iso(doc.createdAt),
			}),
		},
		{
			product: 'chat',
			collection: 'conversations',
			source: 'chats',
			prefix: 'conv',
			map: (doc, ctx) => ({
				id: ctx.id('conv', doc._id),
				visitor: { kind: 'guest', id: ctx.id('guest', doc._id) },
				name: doc.name,
				phone: doc.phone,
				status: doc.status === 'closed' ? 'resolved' : 'open',
				assignedTo: doc.assignedTo ? ctx.ref('staff', doc.assignedTo) : null,
				lastMessageAt: iso(doc.messages.at(-1)?.at ?? doc.createdAt),
				createdAt: iso(doc.createdAt),
			}),
			sums: (record) => ({ conversations: 1, [`conversations.${record.status}`]: 1 }),
			countPath: '/v1/conversations/count',
		},
		{
			product: 'chat',
			collection: 'messages',
			source: 'chats',
			prefix: 'msg',
			// one record per message the chat holds
			map: (doc, ctx) =>
				doc.messages.map((/** @type {Record<string, any>} */ message) => ({
					id: ctx.id('msg', message._id),
					conversationId: ctx.id('conv', doc._id),
					author: message.from === 'staff' ? 'staff' : 'visitor',
					...(message.from === 'staff' ? { staffId: ctx.ref('staff', message.staff), name: message.staffName } : {}),
					text: message.text,
					createdAt: iso(message.at),
				})),
			sums: () => ({ messages: 1 }),
		},
		// 8. Growth: the daily totals rebuilt from the old analytics
		{
			product: 'growth',
			collection: 'totals',
			source: 'dailystats',
			prefix: 'day',
			key: ['day', 'part'],
			map: (doc) => ({
				day: doc.day,
				part: 0,
				totals: {
					visits: { '': { c: doc.visits } },
					page_views: { '': { c: doc.pageViews } },
					page: Object.fromEntries(
						doc.pages.map((/** @type {{ path: string, views: number }} */ page) => [page.path, { c: page.views }]),
					),
					source: Object.fromEntries(
						doc.sources.map((/** @type {{ source: string, visits: number }} */ row) => [row.source, { c: row.visits }]),
					),
				},
			}),
			sums: (record) => {
				const totals = /** @type {Record<string, Record<string, { c: number }>>} */ (record.totals);
				return { days: 1, visits: totals.visits?.['']?.c ?? 0, page_views: totals.page_views?.['']?.c ?? 0 };
			},
		},
	],
	// 2. the website's settings the old shop kept (the per-store table adds the rest by hand)
	settings: async (db) => {
		/** @type {import('../mapping.js').SettingsPlan} */
		const plan = {};
		for await (const doc of db.collection('settings').find({}, { limit: 1 }))
			plan.ecommerce = {
				settings: {
					// the old shop numbered orders per year: <prefix><year>-<number>
					'checkout.numberPattern': '{prefix}{year}-{number}',
					'checkout.numberPrefix': doc.orderPrefix,
					'catalog.mediaBaseUrl': doc.imageBase,
				},
				// its own statuses and moves are the website's order flow (written before the orders)
				...(Array.isArray(doc.orderStatuses)
					? {
							lists: {
								order_flow: {
									statuses: doc.orderStatuses.map((/** @type {Record<string, string>} */ status) => ({
										key: status.key,
										label: status.name,
										role: /** @type {Record<string, string>} */ (STAGE_ROLES)[String(status.stage)] ?? 'open',
									})),
									moves: (doc.orderMoves ?? []).map((/** @type {[string, string]} */ [from, to]) => ({ from, to })),
								},
							},
						}
					: {}),
			};
		return plan;
	},
});
