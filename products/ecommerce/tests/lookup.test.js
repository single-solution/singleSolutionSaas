/**
 * The lookups Chat's shop tools call (exactly `products/chat/core/shop.js`) and the customer orders lookup, all with
 * the server token; the `me` lookups only with the visitor's verified Accounts sign-in, and only that user's data.
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	cardVariant,
	escapeRegex,
	gradeLabels,
	limitOf,
	orderSummary,
	priceRange,
	productCard,
	productDetails,
	searchTerms,
	shipmentSummary,
	statusLabel,
} from '../core/lookup.js';
import { DEFAULT_FLOW } from '../core/flow.js';
import { COLLECTIONS } from '../core/model.js';
import { readyShop } from './helpers.js';

/** @typedef {import('../core/model.js').ProductRecord} ProductRecord */
/** @typedef {import('../core/model.js').VariantRecord} VariantRecord */
/** @typedef {import('../core/model.js').OrderRecord} OrderRecord */

/**
 * @param {Partial<VariantRecord>} [input]
 * @returns {VariantRecord}
 */
const variant = (input = {}) => ({
	id: createId('var'),
	sku: '',
	options: {},
	price: 1000,
	compareAtPrice: null,
	cost: null,
	stock: 5,
	locations: {},
	grade: null,
	active: true,
	...input,
});

/**
 * An order of a user (only the fields the lookups read, plus the address they must never return).
 * @param {{ userId: string, number: string, status?: string, placedAt: Date, shipment?: OrderRecord['shipment'] }} input
 */
const order = ({ userId, number, status = 'confirmed', placedAt, shipment = null }) => ({
	id: createId('ord'),
	number,
	customer: { userId, name: 'Sara Shopper', email: 'sara@example.com', phone: '+15550001111' },
	address: {
		name: 'Sara',
		phone: '+15550001111',
		line1: '1 Secret Street',
		line2: '',
		city: 'Town',
		area: '',
		postalCode: '',
		country: 'US',
		notes: '',
	},
	status,
	role: 'open',
	totals: { subtotal: 5000, discount: 0, delivery: 0, tax: 0, total: 5000, currency: 'USD', taxIncluded: true },
	shipment,
	idempotencyKey: `key-${number}`,
	placedAt,
	createdAt: placedAt,
});

describe('core/lookup', () => {
	/** @type {ProductRecord} */
	const product = /** @type {any} */ ({
		id: 'prd_1',
		slug: 'p',
		name: 'Phone',
		summary: 'S',
		description: 'x'.repeat(2000),
		trackStock: true,
		price: 500,
		inStock: true,
		options: [{ name: 'Colour', values: ['Red'] }],
		specs: { att_1: '6 in', att_gone: true },
		variants: [
			variant({ id: 'var_cheap_out', price: 500, stock: 0 }),
			variant({ id: 'var_in', price: 800, grade: 'a' }),
			variant({ id: 'var_in2', price: 900, grade: 'zz' }),
			variant({ id: 'var_off', price: 100, active: false }),
		],
	});

	it('reads limits and search words safely', () => {
		expect(limitOf('3', 5, 10)).toBe(3);
		expect(limitOf('99', 5, 10)).toBe(10);
		expect(limitOf('0', 5, 10)).toBe(5);
		expect(limitOf('x', 5, 10)).toBe(5);
		expect(limitOf(undefined, 5, 10)).toBe(5);
		expect(searchTerms('  iPhone 13, (Pro)!  ')).toEqual(['iphone', '13', 'pro']);
		expect(searchTerms('a.b*')).toEqual(['a\\.b']);
		expect(searchTerms(42)).toEqual([]);
		expect(searchTerms('1 2 3 4 5 6 7 8')).toHaveLength(6);
		expect(escapeRegex('(x)')).toBe('\\(x\\)');
		expect([...gradeLabels([{ key: 'a', label: 'Like new' }, { key: 'b', label: '' }, { label: 'x' }, null])]).toEqual([
			['a', 'Like new'],
			['b', 'b'],
		]);
		expect(gradeLabels({ not: 'a list' }).size).toBe(0);
	});

	it('picks the card variant and the price range', () => {
		expect(cardVariant(product)?.id).toBe('var_in');
		const soldOut = {
			...product,
			variants: [variant({ id: 'v1', price: 7, stock: 0 }), variant({ id: 'v2', price: 3, stock: 0 })],
		};
		expect(cardVariant(soldOut)?.id).toBe('v2');
		expect(cardVariant({ ...product, variants: [] })).toBeNull();
		expect(priceRange(product)).toEqual({ min: 500, max: 900 });
		expect(priceRange({ ...product, variants: [] })).toEqual({ min: 500, max: 500 });
	});

	it('shapes cards and details', () => {
		const context = { currency: 'USD', image: 'http://insecure.example/i.jpg', url: 'https://s.example/p' };
		expect(productCard(product, context)).toEqual({
			id: 'prd_1',
			name: 'Phone',
			price: 800,
			currency: 'USD',
			image: null,
			url: 'https://s.example/p',
			inStock: true,
			variantId: 'var_in',
		});
		expect(productCard({ ...product, variants: [] }, context)).toMatchObject({ price: 500, variantId: null });
		const details = productDetails(product, {
			...context,
			image: 'https://cdn.example/i.jpg',
			brand: null,
			attributes: new Map([['att_1', { name: 'Screen', unit: '' }]]),
			grades: new Map([['a', 'Grade A']]),
		});
		expect(details.image).toBe('https://cdn.example/i.jpg');
		expect(details.description).toHaveLength(1500);
		expect(details.specs).toEqual([
			{ name: 'Screen', value: '6 in', unit: '' },
			{ name: 'att_gone', value: true, unit: '' },
		]);
		expect(details.variants.map((v) => v.grade)).toEqual([null, 'Grade A', 'zz']);
		const short = productDetails(
			{ ...product, description: 'Short', specs: /** @type {any} */ (undefined) },
			{ ...context, brand: 'B', attributes: new Map(), grades: new Map() },
		);
		expect(short).toMatchObject({ description: 'Short', specs: [], brand: 'B' });
	});

	it('shapes orders and shipments', () => {
		const placed = new Date('2026-10-01T00:00:00Z');
		const record = /** @type {any} */ (order({ userId: 'u', number: 'N-1', placedAt: placed }));
		expect(orderSummary(record, DEFAULT_FLOW)).toEqual({
			number: 'N-1',
			status: 'Confirmed',
			total: 5000,
			currency: 'USD',
			placedAt: '2026-10-01T00:00:00.000Z',
		});
		expect(statusLabel(DEFAULT_FLOW, 'gone')).toBe('gone');
		expect(shipmentSummary(record, DEFAULT_FLOW)).toBeNull();
		const shipped = {
			...record,
			status: 'dispatched',
			shipment: { courier: 'C', trackingNumber: 'T', trackingUrl: 'javascript:x', booked: true, status: '', checkedAt: null },
		};
		expect(shipmentSummary(shipped, DEFAULT_FLOW)).toEqual({
			orderNumber: 'N-1',
			courier: 'C',
			trackingNumber: 'T',
			trackingUrl: '',
			status: 'Dispatched',
		});
	});
});

describe('Chat lookups', () => {
	/** @type {Awaited<ReturnType<typeof readyShop>>} */
	let shop;
	/** @type {ProductRecord} */
	let phone;
	/** @type {ProductRecord} */
	let fresh;
	const sara = 'usr_sara000000001';
	const other = 'usr_other00000001';

	beforeAll(async () => {
		shop = await readyShop();
		const data = await shop.db();
		await data
			.collection(COLLECTIONS.brands)
			.insertOne({ id: 'brd_s', slug: 'samsung', name: 'Samsung', description: '', logo: null });
		await data.collection(COLLECTIONS.attributes).insertOne({
			id: 'att_screen',
			name: 'Screen',
			type: 'text',
			choices: [],
			unit: 'in',
			filterable: true,
			comparable: true,
			sort: 0,
		});
		phone = await shop.seedProduct({
			slug: 'galaxy-s24',
			name: 'Galaxy S24',
			summary: 'Flagship',
			description: 'A phone.',
			brandId: 'brd_s',
			tags: ['android'],
			sold: 50,
			media: [{ key: 'ecommerce/products/g/1.jpg', type: 'image/jpeg', size: 1, alt: '' }],
			specs: { att_screen: '6.2' },
			options: [{ name: 'Storage', values: ['128 GB', '256 GB'] }],
			variants: [
				variant({ options: { Storage: '128 GB' }, price: 70000, sku: 'S24-128', grade: 'a' }),
				variant({ options: { Storage: '256 GB' }, price: 80000, sku: 'S24-256' }),
			],
			publishedAt: new Date('2026-01-01T00:00:00Z'),
		});
		fresh = await shop.seedProduct({ slug: 'pixel', name: 'Pixel 9', sold: 1, publishedAt: new Date('2026-10-01T00:00:00Z') });
		await shop.seedProduct({
			slug: 'old',
			name: 'Old Galaxy',
			sold: 5,
			stock: 0,
			publishedAt: new Date('2025-01-01T00:00:00Z'),
		});
		await shop.seedProduct({ slug: 'draft', name: 'Galaxy Draft', status: 'draft' });

		const tracking = { booked: true, checkedAt: null };
		await data.collection(COLLECTIONS.orders).insertMany([
			order({ userId: sara, number: 'S-1', status: 'delivered', placedAt: new Date('2026-09-01T00:00:00Z') }),
			order({
				userId: sara,
				number: 'S-2',
				status: 'dispatched',
				placedAt: new Date('2026-09-10T00:00:00Z'),
				shipment: {
					courier: 'Fast',
					trackingNumber: 'TRK1',
					trackingUrl: 'https://track.example/TRK1',
					status: '',
					...tracking,
				},
			}),
			order({ userId: sara, number: 'S-3', status: 'my_custom', placedAt: new Date('2026-09-20T00:00:00Z') }),
			order({ userId: other, number: 'O-1', placedAt: new Date('2026-09-15T00:00:00Z') }),
		]);
		await data.collection(COLLECTIONS.loyalty).insertOne({
			userId: sara,
			balance: 120,
			lots: [
				{ id: 'lot_1', points: 120, left: 120, earnedAt: new Date('2026-09-01T00:00:00Z'), expiresAt: null, orderId: null },
			],
			history: [],
			version: 1,
		});
	});
	afterAll(async () => shop.product.close());

	it('searches the catalog by name, brand, tag and SKU', async () => {
		const byBrand = await shop.api('GET', '/v1/chat/products?q=samsung');
		expect(byBrand.status).toBe(200);
		expect(byBrand.json.items).toHaveLength(1);
		const [card] = byBrand.json.items;
		expect(card).toEqual({
			id: phone.id,
			name: 'Galaxy S24',
			price: 70000,
			currency: 'USD',
			image: expect.stringMatching(/^https:\/\//),
			url: 'https://shop.example.com/products/galaxy-s24',
			inStock: true,
			variantId: phone.variants[0]?.id,
		});
		const galaxy = await shop.api('GET', '/v1/chat/products?q=galaxy&limit=5');
		expect(galaxy.json.items.map((/** @type {any} */ item) => item.name)).toEqual(['Galaxy S24', 'Old Galaxy']);
		expect((await shop.api('GET', '/v1/chat/products?q=galaxy&limit=1')).json.items).toHaveLength(1);
		expect((await shop.api('GET', '/v1/chat/products?q=s24-256')).json.items).toHaveLength(1);
		expect((await shop.api('GET', '/v1/chat/products?q=ANDROID pixel')).json.items).toHaveLength(0);
		expect((await shop.api('GET', '/v1/chat/products?q=android flagship')).json.items).toHaveLength(1);
		expect((await shop.api('GET', '/v1/chat/products?q=(.*)')).json.items).toEqual([]);
		expect((await shop.api('GET', '/v1/chat/products')).json.items).toEqual([]);
	});

	it('lists top and new products', async () => {
		const top = await shop.api('GET', '/v1/chat/products/top?kind=top&limit=2');
		expect(top.json.items.map((/** @type {any} */ item) => item.name)).toEqual(['Galaxy S24', 'Old Galaxy']);
		const plain = await shop.api('GET', '/v1/chat/products/top');
		expect(plain.json.items).toHaveLength(3);
		const fresh = await shop.api('GET', '/v1/chat/products/top?kind=new&limit=1');
		expect(fresh.json.items.map((/** @type {any} */ item) => item.name)).toEqual(['Pixel 9']);
		expect((await shop.api('GET', '/v1/chat/products/top?kind=worst')).status).toBe(422);
	});

	it('gives a product’s details by id or slug', async () => {
		const answer = await shop.api('GET', '/v1/chat/products/galaxy-s24');
		expect(answer.status).toBe(200);
		expect(answer.json).toMatchObject({
			id: phone.id,
			summary: 'Flagship',
			description: 'A phone.',
			brand: 'Samsung',
			options: [{ name: 'Storage', values: ['128 GB', '256 GB'] }],
			priceRange: { min: 70000, max: 80000 },
			specs: [{ name: 'Screen', value: '6.2', unit: 'in' }],
		});
		expect(answer.json.variants.map((/** @type {any} */ v) => v.grade)).toEqual(['a', null]);
		const plain = await shop.api('GET', `/v1/chat/products/${fresh.id}`);
		expect(plain.json).toMatchObject({ brand: null, specs: [], image: null });
		expect((await shop.api('GET', '/v1/chat/products/draft')).status).toBe(404);
	});

	it('answers a signed-in visitor’s orders, account and shipments only', async () => {
		const token = await shop.signIn({ id: sara, name: 'Sara Shopper' });
		const headers = { 'ss-sign-in': token };
		const orders = await shop.api('GET', `/v1/chat/me/orders?userId=${other}`, undefined, headers);
		expect(orders.status).toBe(200);
		expect(orders.json).toEqual({
			items: [
				{ number: 'S-3', status: 'my_custom', total: 5000, currency: 'USD', placedAt: '2026-09-20T00:00:00.000Z' },
				{ number: 'S-2', status: 'Dispatched', total: 5000, currency: 'USD', placedAt: '2026-09-10T00:00:00.000Z' },
				{ number: 'S-1', status: 'Delivered', total: 5000, currency: 'USD', placedAt: '2026-09-01T00:00:00.000Z' },
			],
			loyaltyPoints: 120,
			name: 'Sara Shopper',
		});
		expect(orders.text).not.toContain('Secret Street');
		expect(orders.text).not.toContain('+1555');
		expect((await shop.api('GET', '/v1/chat/me/orders?limit=1', undefined, headers)).json.items).toHaveLength(1);
		const account = await shop.api('GET', '/v1/chat/me/account', undefined, headers);
		expect(account.json).toEqual({ name: 'Sara Shopper', loyaltyPoints: 120 });
		const shipments = await shop.api('GET', '/v1/chat/me/shipments', undefined, headers);
		expect(shipments.json).toEqual({
			items: [
				{
					orderNumber: 'S-2',
					courier: 'Fast',
					trackingNumber: 'TRK1',
					trackingUrl: 'https://track.example/TRK1',
					status: 'Dispatched',
				},
			],
		});
		for (const path of ['/v1/chat/me/orders', '/v1/chat/me/account', '/v1/chat/me/shipments']) {
			const none = await shop.api('GET', path);
			expect(none.status).toBe(403);
			expect(none.json.type).toMatch(/sign_in_required$/);
			expect((await shop.api('GET', path, undefined, { 'ss-sign-in': 'not-a-sign-in' })).status).toBe(403);
		}
	});

	it('answers the customer orders lookup', async () => {
		const answer = await shop.api('GET', `/v1/customers/${sara}/orders?limit=2`);
		expect(answer.status).toBe(200);
		expect(answer.json.loyaltyPoints).toBe(120);
		expect(answer.json.items).toEqual([
			{
				id: expect.stringMatching(/^ord_/),
				number: 'S-3',
				status: 'my_custom',
				statusLabel: 'my_custom',
				total: 5000,
				totalText: 'USD 50.00',
				currency: 'USD',
				createdAt: '2026-09-20T00:00:00.000Z',
			},
			expect.objectContaining({ number: 'S-2', status: 'dispatched', statusLabel: 'Dispatched' }),
		]);
		expect((await shop.api('GET', '/v1/customers/usr_nobody/orders')).json).toEqual({ items: [], loyaltyPoints: 0 });
	});

	it('refuses browsers and switched-off features', async () => {
		const browser = await shop.visitor('GET', '/v1/chat/products?q=galaxy');
		expect(browser.status).toBeGreaterThanOrEqual(400);
		await shop.switchOn(['catalog', 'checkout']);
		const token = await shop.signIn({ id: sara });
		expect((await shop.api('GET', '/v1/chat/me/account', undefined, { 'ss-sign-in': token })).json.loyaltyPoints).toBe(0);
		expect((await shop.api('GET', '/v1/chat/deals')).json.type).toMatch(/feature_off$/);
		expect((await shop.api('GET', '/v1/chat/products/galaxy-s24')).json.variants[0].grade).toBe('a');
		expect((await shop.api('GET', '/v1/seo/sitemap.xml')).status).toBe(403);
	});
});
