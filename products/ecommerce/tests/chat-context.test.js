/**
 * Fuller Chat lookups (PLAN 0.8.10 E37): search filters, warranties in details, quotes per variant, quantity and
 * payment method (priced like the cart, with delivery and its free-delivery threshold), deals with their display
 * fields, fuller orders and accounts, and the live store context Chat's AI replies add (C1).
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_CONTEXT, contextText, oneLine } from '../core/chat-context.js';
import { chatFilters, filtersGiven, gradePrices, matchingVariant, variantFilter, warrantyOf } from '../core/lookup.js';
import { shipmentLink } from '../core/couriers.js';
import { COLLECTIONS } from '../core/model.js';
import { ACCOUNTS, readyShop, storedCategory } from './helpers.js';

/** @typedef {import('../core/model.js').VariantRecord} VariantRecord */

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
	attributes: {},
	media: [],
	soldOut: false,
	warrantyDays: null,
	...input,
});

/** @param {Record<string, unknown>} input */
const deal = (input) => ({
	id: createId('deal'),
	name: 'Deal',
	description: '',
	type: 'percent',
	value: 10,
	scope: { productIds: [], categoryIds: [], brandIds: [] },
	startsAt: null,
	endsAt: null,
	limit: null,
	used: 0,
	priority: 0,
	active: true,
	slug: '',
	badgeLabel: '',
	discountLabel: '',
	color: '',
	banner: null,
	content: '',
	seo: { title: '', description: '' },
	sort: 0,
	conditions: null,
	target: 'items',
	days: [],
	timeFrom: '',
	timeTo: '',
	allowPoints: true,
	...input,
});

describe('core: Chat filters, warranties and the context text', () => {
	const product = /** @type {any} */ ({
		id: 'prd_1',
		kind: 'physical',
		trackStock: true,
		warrantyDays: null,
		variants: [
			variant({ id: 'a1', grade: 'a', price: 900, stock: 0 }),
			variant({ id: 'a2', grade: 'a', price: 1000 }),
			variant({ id: 'b1', grade: 'b', price: 700, warrantyDays: 30 }),
			variant({ id: 'n1', price: 1200, soldOut: true }),
			variant({ id: 'off', price: 1, active: false }),
		],
	});

	it('reads filters and refuses wrong values', () => {
		expect(chatFilters({})).toEqual({
			ok: true,
			value: { category: null, grades: [], minPrice: null, maxPrice: null, inStock: false, limit: 5 },
		});
		const read = chatFilters({ category: 'phones', grade: 'A,b', minPrice: '100', maxPrice: '900', inStock: '1', limit: '99' });
		expect(read).toEqual({
			ok: true,
			value: { category: 'phones', grades: ['a', 'b'], minPrice: 100, maxPrice: 900, inStock: true, limit: 12 },
		});
		expect(read.ok && filtersGiven(read.value)).toBe(true);
		expect(chatFilters({ category: 'a b' })).toMatchObject({ ok: false, field: 'category' });
		expect(chatFilters({ grade: 'BAD KEY' })).toMatchObject({ ok: false, field: 'grade' });
		expect(chatFilters({ grade: ['a'] })).toMatchObject({ ok: false, field: 'grade' });
		expect(chatFilters({ minPrice: '-1' })).toMatchObject({ ok: false, field: 'minPrice' });
		expect(chatFilters({ maxPrice: '1.5' })).toMatchObject({ ok: false, field: 'maxPrice' });
		expect(chatFilters({ minPrice: '10', maxPrice: '5' })).toMatchObject({ ok: false, field: 'maxPrice' });
		expect(chatFilters({ inStock: 'yes' })).toMatchObject({ ok: false, field: 'inStock' });
		const none = /** @type {any} */ (chatFilters({})).value;
		expect(filtersGiven(none)).toBe(false);
		expect(variantFilter(none)).toBeNull();
		expect(variantFilter({ ...none, grades: ['a'], minPrice: 5 })).toEqual({
			variants: { $elemMatch: { active: true, price: { $gte: 5 }, grade: { $in: ['a'] } } },
		});
		expect(variantFilter({ ...none, inStock: true })).toHaveProperty('$or');
	});

	it('matches variants, prices per grade and warranties', () => {
		const any = { grades: [], minPrice: null, maxPrice: null, inStock: false };
		expect(matchingVariant(product, any)?.id).toBe('b1');
		expect(matchingVariant(product, { ...any, grades: ['a'] })?.id).toBe('a2');
		expect(matchingVariant(product, { ...any, grades: ['a'], maxPrice: 950 })?.id).toBe('a1');
		expect(matchingVariant(product, { ...any, grades: ['a'], maxPrice: 950, inStock: true })).toBeNull();
		expect(gradePrices(product)).toEqual([
			{ grade: 'a', price: 1000, inStock: true },
			{ grade: 'b', price: 700, inStock: true },
			{ grade: null, price: 1200, inStock: false },
		]);
		const grades = new Map([['a', { warrantyDays: 90 }]]);
		const [a1, , b1, n1] = product.variants;
		expect(warrantyOf(product, a1, { grades, fallback: 7 })).toBe(90);
		expect(warrantyOf(product, b1, { grades, fallback: 7 })).toBe(30);
		expect(warrantyOf(product, n1, { grades, fallback: 7 })).toBe(7);
		expect(warrantyOf(product, n1, { grades, fallback: 0 })).toBeNull();
		expect(warrantyOf({ ...product, kind: 'digital' }, a1, { grades, fallback: 7 })).toBeNull();
		expect(warrantyOf({ ...product, warrantyDays: 365 }, a1, { grades, fallback: 7 })).toBe(365);
	});

	it('builds tracking pages from today’s couriers', () => {
		const couriers = [{ key: 'tcs', name: 'TCS', trackingUrl: 'https://t.example/{tracking}' }];
		expect(shipmentLink(couriers, null)).toBe('');
		expect(shipmentLink(couriers, { courier: 'tcs', trackingNumber: 'A 1' })).toBe('https://t.example/A%201');
		expect(shipmentLink(couriers, { courier: ' tcs ', trackingNumber: 'X' })).toBe('https://t.example/X');
		expect(shipmentLink(couriers, { courier: 'Other', trackingNumber: 'X', trackingUrl: 'https://kept.example/X' })).toBe(
			'https://kept.example/X',
		);
		expect(shipmentLink('nope', { courier: 'tcs', trackingNumber: 'X', trackingUrl: 'http://insecure' })).toBe('');
	});

	it('keeps the context text within 6,000 characters, the visitor and product first', () => {
		expect(oneLine('a\nb | c', 300)).toBe('a b / c');
		expect(oneLine('x'.repeat(10), 5)).toBe('xxxx…');
		const long = 'Policy text. '.repeat(2000);
		const text = contextText({
			business: 'Shop',
			policies: [
				{ key: 'shipping', text: long },
				{ key: 'returns', text: long },
				{ key: 'custom', text: 'Custom.' },
			],
			products: Array.from({ length: 10 }, (_, index) => ({
				name: `Product ${index} ${'n'.repeat(200)}`,
				url: `https://shop.example.com/p/${index}`,
				inStock: true,
				prices: [{ grade: 'A', priceText: 'Rs 1,000', inStock: index % 2 === 0 }],
			})),
			deals: Array.from({ length: 10 }, (_, index) => ({
				name: `Deal ${index}`,
				badgeLabel: index === 0 ? 'Hot' : '',
				discountLabel: '10% off',
				endsText: index === 0 ? '' : '12 Mar 2026',
				description: '',
			})),
			product: {
				name: 'Viewed phone',
				url: 'https://shop.example.com/p/v',
				summary: 'Nice',
				priceRange: { minText: 'Rs 1', maxText: 'Rs 2' },
				variants: [
					{ options: {}, grade: null, priceText: 'Rs 1', inStock: true, stockLeft: 3, warrantyDays: 30 },
					{ options: { Color: 'Red' }, grade: 'A', priceText: 'Rs 2', inStock: false, stockLeft: 0, warrantyDays: null },
					{ options: {}, grade: null, priceText: 'Rs 2', inStock: true, stockLeft: null, warrantyDays: null },
				],
			},
			visitor: { firstName: 'Ayesha', city: 'Lahore', points: 120 },
		});
		expect(text.length).toBeLessThanOrEqual(MAX_CONTEXT);
		expect(text).toContain('first name Ayesha; city Lahore; 120 loyalty points');
		expect(text).toContain('Viewed phone (Rs 1 – Rs 2)');
		expect(text).toContain('- Standard, Rs 1, 3 in stock, 30 days warranty');
		expect(text).toContain('- Red, grade A, Rs 2, out of stock');
		expect(text).toContain('| Deal 0 (Hot) | 10% off | no end date |');
		expect(text).toContain('A Rs 1,000 (out of stock)');
		expect(text).toContain('Delivery: Policy text.');
		expect(text).toContain('custom: Custom.');
		const small = contextText({ business: 'Shop', policies: [], products: [], deals: [], product: null, visitor: null });
		expect(small).toBe('# Shop — live store facts');
		const quiet = contextText({
			business: 'Shop',
			policies: [],
			products: [],
			deals: [],
			product: {
				name: 'One',
				url: 'u',
				summary: '',
				priceRange: { minText: 'Rs 1', maxText: 'Rs 1' },
				variants: [],
			},
			visitor: { firstName: '', city: '', points: null },
		});
		expect(quiet).toContain('One (Rs 1) u');
		expect(quiet).not.toContain('Signed-in visitor');
	});
});

describe('Chat lookups (E37)', () => {
	/** @type {Awaited<ReturnType<typeof readyShop>>} */
	let shop;
	/** @type {import('../core/model.js').ProductRecord} */
	let phone;
	/** @type {import('../core/model.js').ProductRecord} */
	let cable;
	const sara = 'usr_sara000000001';

	beforeAll(async () => {
		shop = await readyShop();
		const data = await shop.db();
		await data.collection(COLLECTIONS.categories).insertMany([
			storedCategory({
				id: 'cat_phones',
				slug: 'phones',
				name: 'Phones',
				parentId: null,
				path: [],
				description: '',
				seo: {},
				image: null,
				sort: 0,
			}),
			storedCategory({
				id: 'cat_used',
				slug: 'used',
				name: 'Used',
				parentId: 'cat_phones',
				path: ['cat_phones'],
				description: '',
				seo: {},
				image: null,
				sort: 0,
			}),
			storedCategory({
				id: 'cat_acc',
				slug: 'accessories',
				name: 'Accessories',
				parentId: null,
				path: [],
				description: '',
				seo: {},
				image: null,
				sort: 1,
			}),
		]);
		await shop.list('grades', [
			{ key: 'a', label: 'Grade A', description: '', returnDays: null, warrantyDays: 90 },
			{ key: 'b', label: 'Grade B', description: '', returnDays: null, warrantyDays: null },
		]);
		await shop.setting('returns', 'warrantyDays', 7);
		await shop.setting('catalog', 'showStock', 'always');
		phone = await shop.seedProduct({
			slug: 'iphone-13',
			name: 'iPhone 13',
			categoryIds: ['cat_used'],
			publishedAt: new Date('2026-09-01T00:00:00Z'),
			variants: [
				variant({ options: { Storage: '128 GB' }, grade: 'a', price: 120000, stock: 2 }),
				variant({ options: { Storage: '128 GB' }, grade: 'b', price: 100000, stock: 0 }),
				variant({ options: { Storage: '256 GB' }, grade: 'b', price: 110000, stock: 4, warrantyDays: 30 }),
			],
		});
		cable = await shop.seedProduct({
			slug: 'cable',
			name: 'USB cable',
			categoryIds: ['cat_acc'],
			price: 1500,
			publishedAt: new Date('2026-10-01T00:00:00Z'),
		});
		await data.collection(COLLECTIONS.deals).insertMany([
			deal({
				id: 'deal_phones',
				name: 'Phone week',
				description: '10% off phones',
				scope: { productIds: [], categoryIds: ['cat_phones'], brandIds: [] },
				slug: 'phone-week',
				badgeLabel: 'Sale',
				discountLabel: '10% off phones',
				color: '#e11d48',
				endsAt: new Date('2026-11-01T00:00:00Z'),
				priority: 5,
			}),
			deal({
				id: 'deal_fixed',
				name: 'Cable promo',
				type: 'fixed',
				value: 500,
				scope: { productIds: [cable.id], categoryIds: [], brandIds: [] },
			}),
			deal({ id: 'deal_gone', name: 'Over', active: false }),
		]);
		await shop.list('delivery_zones', [
			{ key: 'lhr', name: 'Lahore', cities: ['Lahore'], areas: [], fee: 25000, freeOver: 500000, minDays: 1, maxDays: 2 },
		]);
		await shop.setting('delivery_zones', 'defaultFee', 30000);
		await shop.setting('delivery_zones', 'defaultFreeOver', 0);
		await shop.setting('checkout', 'policyShipping', 'We deliver in {business} style.');
		await shop.setting('checkout', 'policyReturns', 'Returns within {returnDays} days.');
		await shop.list('couriers', [{ key: 'tcs', name: 'TCS', trackingUrl: 'https://track.example/{tracking}' }]);
		const placedAt = new Date('2026-10-02T00:00:00Z');
		await data.collection(COLLECTIONS.orders).insertOne({
			id: 'ord_sara1',
			number: 'SH-2026-0043',
			customer: { userId: sara, name: 'Sara Shopper', email: '', phone: '+923001234567' },
			address: {
				name: 'Sara',
				phone: '+923001234567',
				line1: 'Hidden street',
				line2: '',
				city: 'Lahore',
				area: 'DHA',
				postalCode: '',
				country: 'PK',
				notes: '',
			},
			delivery: { method: 'delivery', zone: 'lhr', fee: 0, locationId: null },
			lines: [
				{
					id: 'oln_1',
					productId: phone.id,
					variantId: phone.variants[0]?.id,
					kind: 'physical',
					name: 'iPhone 13',
					variantName: '128 GB',
					sku: '',
					grade: 'a',
					gradeLabel: 'Grade A',
					image: null,
					unitPrice: 120000,
					quantity: 1,
					discount: 0,
					tax: 0,
					total: 120000,
					serials: ['356938035643809'],
					warrantyDays: 90,
				},
			],
			totals: { subtotal: 120000, discount: 0, delivery: 0, tax: 0, total: 120000, currency: 'USD', taxIncluded: true },
			payment: { method: 'cod', state: 'unpaid', paymentId: null, advance: 0, paid: 20000, refunded: 0, checkedAt: null },
			status: 'dispatched',
			role: 'shipped',
			history: [],
			shipment: {
				courier: 'TCS',
				trackingNumber: 'TRK 9',
				trackingUrl: '',
				booked: false,
				status: '',
				checkedAt: null,
				trackingNote: 'Leaves Karachi today',
				estimatedDeliveryAt: new Date('2026-10-05T00:00:00Z'),
			},
			media: [{ kind: 'dispatch_video', url: 'https://www.youtube-nocookie.com/embed/abcdefghijk' }],
			placedAt,
			createdAt: placedAt,
		});
	});
	afterAll(async () => shop.product.close());

	it('searches with filters, words optional', async () => {
		const used = await shop.api('GET', '/v1/chat/products?category=phones');
		expect(used.status).toBe(200);
		expect(used.json.items.map((/** @type {any} */ item) => item.name)).toEqual(['iPhone 13']);
		const graded = await shop.api('GET', '/v1/chat/products?grade=b&inStock=1');
		expect(graded.json.items).toEqual([
			expect.objectContaining({
				id: phone.id,
				price: 110000,
				grade: 'Grade B',
				stockLeft: 4,
				variantId: phone.variants[2]?.id,
			}),
		]);
		const budget = await shop.api('GET', '/v1/chat/products?q=iphone&maxPrice=105000');
		expect(budget.json.items).toEqual([expect.objectContaining({ price: 100000, stockLeft: 0, priceMax: 120000 })]);
		expect((await shop.api('GET', '/v1/chat/products?maxPrice=1000')).json.items).toEqual([]);
		expect((await shop.api('GET', '/v1/chat/products?category=nope')).json.items).toEqual([]);
		expect((await shop.api('GET', '/v1/chat/products?minPrice=1&limit=12')).json.items).toHaveLength(2);
		expect((await shop.api('GET', '/v1/chat/products?minPrice=x')).status).toBe(422);
		expect((await shop.api('GET', '/v1/chat/products?q=')).json.items).toEqual([]);
	});

	it('gives each variant’s grade, stock left and warranty', async () => {
		const answer = await shop.api('GET', '/v1/chat/products/iphone-13');
		expect(answer.json.variants).toEqual([
			expect.objectContaining({ grade: 'Grade A', gradeKey: 'a', stockLeft: 2, warrantyDays: 90, inStock: true }),
			expect.objectContaining({ grade: 'Grade B', stockLeft: 0, warrantyDays: 7, inStock: false, soldOut: false }),
			expect.objectContaining({ grade: 'Grade B', stockLeft: 4, warrantyDays: 30 }),
		]);
	});

	it('quotes a variant, quantity and payment method like the cart, with delivery', async () => {
		const id = /** @type {string} */ (phone.variants[2]?.id);
		const answer = await shop.api(
			'GET',
			`/v1/chat/products/iphone-13/quote?variantId=${id}&quantity=2&paymentMethod=cod&city=Lahore`,
		);
		expect(answer.status).toBe(200);
		expect(answer.json).toMatchObject({
			productId: phone.id,
			variantId: id,
			quantity: 2,
			price: 110000,
			priceText: 'USD 1,100.00',
			priceAfterDeals: 99000,
			savings: 11000,
			deals: ['Phone week'],
			dealsApplied: [
				expect.objectContaining({
					id: 'deal_phones',
					badgeLabel: 'Sale',
					color: '#e11d48',
					amount: 22000,
					amountText: 'USD 220.00',
				}),
			],
			paymentMethod: 'cod',
			subtotal: 220000,
			discount: 22000,
			fee: 0,
			roleDiscount: 0,
			delivery: { method: 'delivery', name: 'Lahore', fee: 25000, feeText: 'USD 250.00', minDays: 1, maxDays: 2 },
			freeDeliveryOver: 500000,
			freeDeliveryOverText: 'USD 5,000.00',
			total: 223000,
			totalText: 'USD 2,230.00',
			inStock: true,
		});
		expect(answer.json.paymentMethods).toContainEqual(expect.objectContaining({ method: 'cod', available: true }));
		const plain = await shop.api('GET', '/v1/chat/products/cable/quote');
		expect(plain.json).toMatchObject({
			price: 1500,
			priceAfterDeals: 1000,
			quantity: 1,
			paymentMethod: null,
			delivery: { fee: 30000 },
			freeDeliveryOver: null,
			freeDeliveryOverText: '',
		});
		const out = await shop.api('GET', `/v1/chat/products/iphone-13/quote?variantId=${phone.variants[1]?.id}`);
		expect(out.json).toMatchObject({ inStock: false, problems: [{ code: 'out_of_stock' }] });
		expect((await shop.api('GET', '/v1/chat/products/iphone-13/quote?quantity=6')).status).toBe(422);
		expect((await shop.api('GET', '/v1/chat/products/iphone-13/quote?quantity=1.5')).status).toBe(422);
		expect((await shop.api('GET', '/v1/chat/products/iphone-13/quote?paymentMethod=card')).status).toBe(422);
		expect((await shop.api('GET', '/v1/chat/products/iphone-13/quote?variantId=var_nope')).status).toBe(404);
		expect((await shop.api('GET', '/v1/chat/products/iphone-13/quote?variantId=a%20b')).status).toBe(422);
		expect((await shop.api('GET', `/v1/chat/products/iphone-13/quote?city=${'x'.repeat(81)}`)).status).toBe(422);
	});

	it('lists deals with their display fields', async () => {
		const answer = await shop.api('GET', '/v1/chat/deals');
		expect(answer.json.items).toEqual([
			{
				id: 'deal_phones',
				name: 'Phone week',
				description: '10% off phones',
				slug: 'phone-week',
				type: 'percent',
				value: 10,
				valueText: '10%',
				badgeLabel: 'Sale',
				discountLabel: '10% off phones',
				color: '#e11d48',
				bannerUrl: null,
				minQuantity: null,
				days: [],
				timeFrom: '',
				timeTo: '',
				endsAt: '2026-11-01T00:00:00.000Z',
				endsText: expect.stringMatching(/2026/),
			},
			expect.objectContaining({
				id: 'deal_fixed',
				valueText: 'USD 5.00',
				discountLabel: 'USD 5.00 off',
				endsAt: null,
				endsText: '',
			}),
		]);
		// a deal outside its hours is not offered, as the cart would not give it (PR-6)
		const later = await shop.api('POST', '/v1/deals', {
			name: 'Midnight',
			type: 'percent',
			value: 5,
			timeFrom: '00:00',
			timeTo: '00:01',
		});
		expect(later.status).toBe(201);
		const now = (await shop.api('GET', '/v1/chat/deals')).json.items;
		expect(now.map((/** @type {{ id: string }} */ item) => item.id)).toEqual(['deal_phones', 'deal_fixed']);
		await shop.api('DELETE', `/v1/deals/${later.json.id}`);
	});

	it('gives fuller orders and the account’s city and area', async () => {
		const token = await shop.signIn({ id: sara, name: 'Sara Shopper' });
		const headers = { 'ss-sign-in': token };
		const orders = await shop.api('GET', '/v1/chat/me/orders', undefined, headers);
		expect(orders.json.items).toEqual([
			expect.objectContaining({
				number: 'SH-2026-0043',
				statusKey: 'dispatched',
				paymentMethod: 'cod',
				paid: 20000,
				balanceDue: 100000,
				balanceDueText: 'USD 1,000.00',
				lines: [
					{
						name: 'iPhone 13',
						variantName: '128 GB',
						gradeLabel: 'Grade A',
						quantity: 1,
						unitPrice: 120000,
						unitPriceText: 'USD 1,200.00',
						total: 120000,
						totalText: 'USD 1,200.00',
						warrantyDays: 90,
					},
				],
				courier: 'TCS',
				trackingUrl: 'https://track.example/TRK%209',
				trackingNote: 'Leaves Karachi today',
				expectedAt: '2026-10-05T00:00:00.000Z',
				dispatchVideo: { kind: 'youtube', url: 'https://www.youtube-nocookie.com/embed/abcdefghijk' },
			}),
		]);
		expect(orders.text).not.toContain('Hidden street');
		expect(orders.text).not.toContain('356938035643809');
		const shipments = await shop.api('GET', '/v1/chat/me/shipments', undefined, headers);
		expect(shipments.json.items[0]).toMatchObject({
			trackingNote: 'Leaves Karachi today',
			expectedAt: '2026-10-05T00:00:00.000Z',
		});
		// the city of the last order, until Accounts answers with a default address
		expect((await shop.api('GET', '/v1/chat/me/account', undefined, headers)).json).toMatchObject({ city: 'Lahore', area: '' });
		shop.responders.set(`${ACCOUNTS}/v1/me`, (call) =>
			call.headers['ss-sign-in'] === token
				? {
						status: 200,
						body: {
							name: 'Sara Shopper',
							addresses: [
								{ city: 'Karachi', area: 'Clifton', default: false },
								{ city: 'Islamabad', area: 'F-7', default: true },
							],
						},
					}
				: { status: 401, body: {} },
		);
		expect((await shop.api('GET', '/v1/chat/me/account', undefined, headers)).json).toEqual({
			name: 'Sara Shopper',
			firstName: 'Sara',
			loyaltyPoints: 0,
			city: 'Islamabad',
			area: 'F-7',
		});
		shop.responders.delete(`${ACCOUNTS}/v1/me`);
	});

	it('serves the store context with policies, newest products, deals, the viewed product and the visitor', async () => {
		const guest = await shop.api('GET', '/v1/chat/context?productId=iphone-13');
		expect(guest.status).toBe(200);
		expect(guest.json).toMatchObject({
			business: 'Shop',
			currency: 'USD',
			policies: [
				{ key: 'shipping', text: 'We deliver in Shop style.' },
				{ key: 'returns', text: 'Returns within 7 days.' },
			],
			products: [
				{ id: cable.id, name: 'USB cable', prices: [{ grade: null, priceText: 'USD 15.00', inStock: true }] },
				{
					id: phone.id,
					prices: [
						{ grade: 'Grade A', price: 120000, inStock: true },
						{ grade: 'Grade B', price: 110000, inStock: true },
					],
				},
			],
			deals: [expect.objectContaining({ name: 'Phone week' }), expect.objectContaining({ name: 'Cable promo' })],
			product: expect.objectContaining({ id: phone.id, variants: expect.any(Array) }),
			visitor: null,
		});
		expect(guest.json.text.length).toBeLessThanOrEqual(MAX_CONTEXT);
		expect(guest.json.text).toContain('Delivery: We deliver in Shop style.');
		expect(guest.json.text).toContain('| Phone week (Sale) | 10% off phones |');
		expect(guest.json.text).toContain('## Product the visitor is viewing');
		const token = await shop.signIn({ id: sara, name: 'Sara Shopper' });
		const signed = await shop.api('GET', '/v1/chat/context', undefined, { 'ss-sign-in': token });
		expect(signed.json).toMatchObject({ product: null, visitor: { firstName: 'Sara', city: 'Lahore', points: 0 } });
		expect(signed.json.text).toContain('first name Sara; city Lahore; 0 loyalty points');
		expect((await shop.api('GET', '/v1/chat/context?productId=nope')).json.product).toBeNull();
		expect((await shop.api('GET', '/v1/chat/context?productId=a%20b')).status).toBe(422);
		await shop.switchOn(['catalog']);
		const bare = await shop.api('GET', '/v1/chat/context', undefined, { 'ss-sign-in': token });
		expect(bare.json).toMatchObject({ policies: [], deals: [], visitor: { points: null } });
		expect((await shop.api('GET', '/v1/chat/products/iphone-13/quote')).status).toBe(403);
	});
});
