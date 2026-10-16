/**
 * Step 10 with Ecommerce faked on the test network: the shop tools offered per feature, the sign-in tools only for a
 * verified sign-in (forwarded to Ecommerce, never a user the model names), failure answers, product cards on the AI
 * answer, the context panel's shop info and the dashboard checklist.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { SHOP_UNAVAILABLE } from '../core/shop.js';
import { AI_KEY, ECOMMERCE, ready } from './helpers.js';

/** @type {Array<Awaited<ReturnType<typeof ready>>>} */
const systems = [];
afterAll(async () => {
	for (const sys of systems) await sys.product.close();
});

/**
 * Products as Ecommerce answers them (ChatProduct), at the price the product page shows: the lamp after its deal (the
 * list price struck through), the tote with its own "was" price.
 */
const LAMP = {
	id: 'prd_lamp',
	name: 'Desk lamp',
	price: 4000,
	priceText: '$40.00',
	compareAtPrice: 4500,
	compareAtPriceText: '$45.00',
	deal: { id: 'd1', name: 'Autumn sale', savings: 500, savingsText: '$5.00' },
	priceMax: 4000,
	priceMaxText: '$40.00',
	currency: 'USD',
	image: 'https://cdn.shop.example.com/lamp.jpg',
	url: 'https://shop.example.com/products/desk-lamp',
	inStock: true,
	variantId: 'var_1',
	grade: null,
	stockLeft: null,
	// the quantities Add to cart adds (EU)
	limits: { step: 2, min: 2, max: 20 },
	unit: null,
};
// an image that is not https is dropped (cards are shown to visitors)
const TOTE = {
	...LAMP,
	id: 'prd_tote',
	name: 'Canvas tote',
	price: 1500,
	priceText: '$15.00',
	compareAtPrice: 2000,
	compareAtPriceText: '$20.00',
	deal: null,
	priceMax: 1500,
	priceMaxText: '$15.00',
	image: 'http://insecure.example.com/c.jpg',
	url: 'https://shop.example.com/products/canvas-tote',
	inStock: false,
};

/** An order as Ecommerce answers it (ChatOrder), with a street address it never sends: it would never be passed on. */
const ORDER = {
	id: 'ord_1001',
	number: 'SH-1001',
	status: 'Dispatched',
	statusKey: 'dispatched',
	total: 4500,
	totalText: '$45.00',
	currency: 'USD',
	placedAt: '2026-10-01T09:00:00.000Z',
	paymentMethod: 'online',
	paid: 4500,
	paidText: '$45.00',
	balanceDue: 0,
	balanceDueText: '$0.00',
	lines: [],
	courier: '',
	trackingNumber: '',
	trackingUrl: '',
	trackingNote: '',
	expectedAt: null,
	attachments: [],
	address: '1 Main Street',
};

/** Ecommerce's answers by path. @type {Record<string, unknown>} */
const ANSWERS = {
	'/v1/chat/products': { items: [LAMP, TOTE, { id: 'broken' }] },
	'/v1/chat/products/top': { items: [LAMP] },
	'/v1/chat/products/prd_lamp': {
		...LAMP,
		summary: 'A steady light.',
		description: 'A long description.',
		brand: 'Northlight',
		options: [{ name: 'Color', values: ['Black', 'White'] }],
		priceRange: { min: 4000, max: 4000, minText: '$40.00', maxText: '$40.00' },
		specs: [{ name: 'Height', value: 42, unit: 'cm' }],
		variants: [],
	},
	'/v1/chat/products/prd_lamp/quote': {
		productId: 'prd_lamp',
		variantId: 'var_1',
		quantity: 1,
		price: 4500,
		priceText: '$45.00',
		compareAtPrice: null,
		compareAtPriceText: null,
		priceAfterDeals: 4000,
		priceAfterDealsText: '$40.00',
		savings: 500,
		savingsText: '$5.00',
		currency: 'USD',
		deals: ['Autumn sale'],
		dealsApplied: [{ id: 'd1', name: 'Autumn sale', amount: 500, amountText: '$5.00' }],
		inStock: true,
		problems: [],
		paymentMethod: null,
		paymentMethods: [{ method: 'online', available: true, reason: null, advance: 0, fee: 0, advanceText: '$0.00' }],
		subtotal: 4500,
		subtotalText: '$45.00',
		discount: 500,
		discountText: '$5.00',
		roleDiscount: 0,
		roleDiscountText: '$0.00',
		fee: 0,
		feeText: '$0.00',
		tax: 0,
		taxText: '$0.00',
		delivery: null,
		freeDeliveryOver: null,
		freeDeliveryOverText: '',
		total: 4000,
		totalText: '$40.00',
	},
	'/v1/chat/deals': {
		items: [
			{
				id: 'd1',
				name: 'Autumn sale',
				description: 'On every lamp',
				slug: 'autumn-sale',
				type: 'percent',
				value: 5,
				valueText: '5%',
				badgeLabel: '',
				discountLabel: '5% off',
				color: '',
				bannerUrl: null,
				minQuantity: null,
				days: [],
				timeFrom: '',
				timeTo: '',
				endsAt: '2026-10-30T00:00:00.000Z',
				endsText: 'Oct 30, 2026',
			},
		],
	},
	'/v1/chat/me/orders': { name: 'Rea Der', extraFields: [{ label: 'Loyalty points', value: '120' }], items: [ORDER] },
	// a phone it never sends, never passed on
	'/v1/chat/me/account': {
		name: 'Rea Der',
		firstName: 'Rea',
		city: '',
		extraFields: [{ label: 'Loyalty points', value: '120' }],
		phone: '+447700900123',
	},
	'/v1/chat/me/shipments': {
		items: [
			{
				orderNumber: 'SH-1001',
				courier: 'Fast',
				trackingNumber: 'T1',
				trackingUrl: 'https://track.example.com/T1',
				trackingNote: '',
				expectedAt: null,
				status: 'In transit',
				address: '1 Main Street',
			},
		],
	},
	'/v1/customers/usr_1/orders': {
		loyaltyPoints: 120,
		items: [
			{
				id: 'o1',
				number: 'SH-1001',
				status: 'dispatched',
				statusLabel: 'On its way',
				total: 4500,
				totalText: '$45.00',
				currency: 'USD',
				createdAt: '2026-10-01T09:00:00.000Z',
			},
			{
				id: 'o2',
				number: 'SH-1000',
				status: 'delivered',
				statusLabel: 'Delivered',
				total: 9900,
				totalText: '$99.00',
				currency: 'USD',
				createdAt: '2026-09-01T00:00:00.000Z',
			},
		],
	},
};

/** @param {string[]} on @param {{ ecommerce?: boolean }} [options] */
const start = async (on, { ecommerce = true } = {}) => {
	const sys = await ready(on);
	systems.push(sys);
	await sys.connect('ai', AI_KEY);
	const { token } = await sys.portal.issueToken({ websiteId: sys.websiteId, productId: 'ecommerce', kind: 'server' });
	if (ecommerce) await sys.connect('ecommerce', token);
	sys.responders.set(ECOMMERCE, (call) => {
		const path = new URL(call.url).pathname;
		return path in ANSWERS ? { status: 200, body: ANSWERS[path] } : { status: 404, body: { type: 'x/not_found' } };
	});
	return Object.assign(sys, { ecommerceToken: token });
};

/** The tool names the AI was offered in a completion request. @param {any} request */
const offered = (request) => (request.tools ?? []).map((/** @type {any} */ tool) => tool.function.name);

/** What a tool answered, as the AI got it back. @param {any} request */
const toolAnswers = (request) =>
	request.messages.filter((/** @type {any} */ m) => m.role === 'tool').map((/** @type {any} */ m) => m.content);

const SHOP = ['visitor_chat', 'guest_chat', 'signed_in_chat', 'ai_replies'];

/** A signed-in visitor (Accounts token pasted). @param {Awaited<ReturnType<typeof ready>>} sys */
const signedIn = async (sys) => {
	await sys.paste('accounts');
	const signIn = await sys.accounts.signIn({
		websiteId: sys.websiteId,
		sub: 'usr_1',
		name: 'Rea Der',
		email: 'rea@example.com',
	});
	return { signIn, v: sys.visitor({ signIn }) };
};

describe('shop tools', () => {
	it('offers each tool only while its feature is on, and the sign-in tools only to a verified sign-in', async () => {
		const sys = await start([...SHOP, 'shop_search', 'shop_my_orders']);
		const guest = sys.visitor();
		await guest('POST', '/v1/chat/messages', { text: 'Hi' });
		expect(offered(sys.aiCalls()[0])).toEqual(['search_catalog', 'get_product_details']);
		expect(sys.aiCalls()[0].messages[0].content).toContain('use the shop tools');
		const { v } = await signedIn(sys);
		await v('POST', '/v1/chat/messages', { text: 'Hi again' });
		expect(offered(sys.aiCalls()[1])).toEqual(['search_catalog', 'get_product_details', 'get_my_orders', 'get_my_account']);

		const all = await start([...SHOP, 'shop_search', 'shop_deals', 'shop_top', 'shop_my_orders', 'track_shipment']);
		const user = await signedIn(all);
		await user.v('POST', '/v1/chat/messages', { text: 'Hi' });
		expect(offered(all.aiCalls()[0])).toEqual([
			'search_catalog',
			'get_product_details',
			'quote_product_savings',
			'list_active_deals',
			'get_top_products',
			'get_my_orders',
			'get_my_account',
			'track_shipment',
		]);
		const none = await start(SHOP);
		await none.visitor()('POST', '/v1/chat/messages', { text: 'Hi' });
		expect(offered(none.aiCalls()[0])).toEqual([]);
		expect(none.aiCalls()[0].messages[0].content).not.toContain('shop tools');
	});

	it('searches, reads details, quotes, lists deals and top products with the pasted server token', async () => {
		const sys = await start([...SHOP, 'shop_search', 'shop_deals', 'shop_top']);
		sys.ai(
			{
				tools: [
					{ name: 'search_catalog', arguments: { query: 'desk lamp' } },
					{ name: 'get_product_details', arguments: { productId: 'prd_lamp' } },
					{ name: 'quote_product_savings', arguments: { productId: 'prd_lamp' } },
					{ name: 'list_active_deals', arguments: {} },
					{ name: 'get_top_products', arguments: { kind: 'new' } },
				],
			},
			{ text: 'The desk lamp is $40 (was $45).' },
		);
		await sys.visitor()('POST', '/v1/chat/messages', { text: 'Desk lamp price?' });
		// the tools of one round run together: compare without their order
		const urls = sys.shopCalls().map((c) => c.url.replace(ECOMMERCE, ''));
		expect(urls.sort()).toEqual([
			'/v1/chat/deals?limit=10',
			'/v1/chat/products/prd_lamp',
			'/v1/chat/products/prd_lamp/quote',
			'/v1/chat/products/top?kind=new&limit=5',
			'/v1/chat/products?q=desk+lamp&limit=5',
		]);
		expect(sys.shopCalls().every((c) => c.headers.authorization === `Bearer ${sys.ecommerceToken}`)).toBe(true);
		expect(sys.shopCalls().every((c) => !c.headers['ss-sign-in'])).toBe(true);
		// how many deals and top products a list asks for are settings (C22), within what Ecommerce answers
		await sys.setting('shop_deals', 'count', 3);
		await sys.setting('shop_top', 'count', 12);
		sys.ai(
			{
				tools: [
					{ name: 'list_active_deals', arguments: {} },
					{ name: 'get_top_products', arguments: { kind: 'top' } },
				],
			},
			{ text: 'Here they are.' },
		);
		const before = sys.shopCalls().length;
		await sys.visitor()('POST', '/v1/chat/messages', { text: 'Deals and best sellers?' });
		expect(
			sys
				.shopCalls()
				.slice(before)
				.map((c) => c.url.replace(ECOMMERCE, ''))
				.sort(),
		).toEqual(['/v1/chat/deals?limit=3', '/v1/chat/products/top?kind=top&limit=12']);
		const [search, details, quote, deals, top] = toolAnswers(sys.aiCalls()[1]).map((/** @type {string} */ text) =>
			JSON.parse(text),
		);
		expect(search.products).toEqual([
			{
				id: 'prd_lamp',
				name: 'Desk lamp',
				price: '$40.00',
				wasPrice: '$45.00',
				deal: { name: 'Autumn sale', savings: '$5.00' },
				inStock: true,
				link: LAMP.url,
			},
			{ id: 'prd_tote', name: 'Canvas tote', price: '$15.00', wasPrice: '$20.00', inStock: false, link: TOTE.url },
		]);
		expect(details).toMatchObject({
			brand: 'Northlight',
			summary: 'A steady light.',
			options: [{ name: 'Color', values: ['Black', 'White'] }],
			specs: ['Height: 42 cm'],
		});
		expect(quote).toEqual({
			productId: 'prd_lamp',
			variantId: 'var_1',
			quantity: 1,
			price: '$45.00',
			priceAfterDeals: '$40.00',
			savings: '$5.00',
			deals: ['Autumn sale'],
			subtotal: '$45.00',
			discount: '$5.00',
			total: '$40.00',
			paymentMethods: [{ method: 'online', available: true }],
		});
		expect(deals.deals).toEqual([
			{ name: 'Autumn sale', description: 'On every lamp', offer: '5% off', endsAt: 'Oct 30, 2026' },
		]);
		expect(top.products).toHaveLength(1);
		// the AI is told which price to name: the price on the product page, the "was" price beside it and the deal in it
		const told = Object.fromEntries(
			sys.aiCalls()[0].tools.map((/** @type {any} */ tool) => [tool.function.name, tool.function.description]),
		);
		expect(told.search_catalog).toContain('price is what the product page charges now, after any live deal');
		expect(told.search_catalog).toContain('never as the price to pay');
		expect(told.get_product_details).toContain('price, wasPrice and deal');
		expect(told.get_top_products).toContain('the fields search_catalog gives');
		expect(told.quote_product_savings).toContain('for one unit, the price on the product page');
	});

	it('forwards the verified sign-in for my orders, account and shipments, ignoring a user the model names', async () => {
		const sys = await start([...SHOP, 'shop_my_orders', 'track_shipment']);
		const { signIn, v } = await signedIn(sys);
		sys.ai(
			{
				tools: [
					{ name: 'get_my_orders', arguments: { userId: 'usr_other', email: 'other@example.com' } },
					{ name: 'get_my_account', arguments: { userId: 'usr_other' } },
					{ name: 'track_shipment', arguments: { orderNumber: 'B-1' } },
				],
			},
			{ text: 'Your order is on its way.' },
		);
		await v('POST', '/v1/chat/messages', { text: 'Where is my order?' });
		const calls = sys.shopCalls();
		expect(calls.map((c) => c.url.replace(ECOMMERCE, '')).sort()).toEqual([
			'/v1/chat/me/account',
			'/v1/chat/me/orders?limit=5',
			'/v1/chat/me/shipments',
		]);
		expect(calls.every((c) => c.headers['ss-sign-in'] === signIn)).toBe(true);
		// the orders one answer reads are a setting (C22)
		await sys.setting('shop_my_orders', 'count', 2);
		sys.ai({ tools: [{ name: 'get_my_orders', arguments: {} }] }, { text: 'Two orders.' });
		await v('POST', '/v1/chat/messages', { text: 'My last orders?' });
		expect(sys.shopCalls().at(-1)?.url).toBe(`${ECOMMERCE}/v1/chat/me/orders?limit=2`);
		const answers = toolAnswers(sys.aiCalls()[1]);
		expect(JSON.parse(String(answers[0]))).toEqual({
			name: 'Rea Der',
			more: ['Loyalty points: 120'],
			orders: [{ number: 'SH-1001', status: 'Dispatched', total: '$45.00', placedAt: 'Oct 1, 2026', paymentMethod: 'online' }],
		});
		expect(JSON.parse(String(answers[1]))).toEqual({ name: 'Rea Der', firstName: 'Rea', more: ['Loyalty points: 120'] });
		expect(JSON.parse(String(answers[2])).shipments).toEqual([
			{
				orderNumber: 'SH-1001',
				courier: 'Fast',
				trackingNumber: 'T1',
				trackingLink: 'https://track.example.com/T1',
				status: 'In transit',
			},
		]);
		expect(answers.join(' ')).not.toMatch(/1 Main Street|\+44|7700/);
	});

	it('never runs a sign-in tool for a guest, even when the model asks for it', async () => {
		const sys = await start([...SHOP, 'shop_search', 'shop_my_orders']);
		sys.ai({ tools: [{ name: 'get_my_orders', arguments: {} }] }, { text: 'Please sign in.' });
		await sys.visitor()('POST', '/v1/chat/messages', { text: 'My orders?' });
		expect(sys.shopCalls()).toEqual([]);
		expect(toolAnswers(sys.aiCalls()[1])).toEqual(['No such tool.']);
	});

	it('answers that it cannot look this up now when Ecommerce is not connected, refuses or is stopped', async () => {
		const missing = await start([...SHOP, 'shop_search'], { ecommerce: false });
		missing.ai({ tools: [{ name: 'search_catalog', arguments: { query: 'lamp' } }] }, { text: 'Sorry.' });
		await missing.visitor()('POST', '/v1/chat/messages', { text: 'Lamps?' });
		expect(toolAnswers(missing.aiCalls()[1])).toEqual([SHOP_UNAVAILABLE]);

		const sys = await start([...SHOP, 'shop_search', 'shop_deals']);
		sys.responders.set(`${ECOMMERCE}/v1/chat/products`, () => ({ status: 401, body: { type: 'x/invalid_token' } }));
		sys.responders.set(`${ECOMMERCE}/v1/chat/deals`, () => ({
			status: 403,
			body: { type: 'x/product_unavailable', reason: 'stopped' },
		}));
		sys.ai(
			{
				tools: [
					{ name: 'search_catalog', arguments: { query: 'lamp' } },
					{ name: 'list_active_deals', arguments: {} },
					{ name: 'search_catalog', arguments: { query: '  ' } },
					{ name: 'get_product_details', arguments: { productId: '../../admin' } },
				],
			},
			{ text: 'Sorry.' },
		);
		const v = sys.visitor();
		await v('POST', '/v1/chat/messages', { text: 'Lamps?' });
		expect(toolAnswers(sys.aiCalls()[1])).toEqual([
			SHOP_UNAVAILABLE,
			SHOP_UNAVAILABLE,
			'Say what to search for, or give a filter.',
			'Give the product id from a search result.',
		]);
		expect((await v('GET', '/v1/chat')).json.messages[1].text).toBe('Sorry.');
	});

	it('explains empty answers so the AI invents nothing', async () => {
		const sys = await start([...SHOP, 'shop_search', 'shop_deals', 'shop_top', 'shop_my_orders', 'track_shipment']);
		sys.responders.set(ECOMMERCE, () => ({ status: 200, body: {} }));
		const { v } = await signedIn(sys);
		sys.ai(
			{
				tools: [
					{ name: 'search_catalog', arguments: { query: 'nothing' } },
					{ name: 'get_product_details', arguments: { productId: 'prd_gone' } },
					{ name: 'quote_product_savings', arguments: { productId: 'prd_gone' } },
					{ name: 'list_active_deals', arguments: {} },
					{ name: 'get_top_products', arguments: {} },
					{ name: 'get_my_orders', arguments: {} },
					{ name: 'track_shipment', arguments: {} },
				],
			},
			{ text: 'Nothing found.' },
		);
		await v('POST', '/v1/chat/messages', { text: 'Anything?' });
		expect(sys.shopCalls().map((c) => c.url)).toContain(`${ECOMMERCE}/v1/chat/products/top?kind=top&limit=5`);
		expect(toolAnswers(sys.aiCalls()[1])).toEqual([
			'Nothing in the catalog matched. Do not invent products; suggest another search.',
			'No such product. Do not invent details.',
			'No quote for this product. Do not invent prices.',
			'No deals are running right now.',
			'Nothing in the catalog matched. Do not invent products; suggest another search.',
			JSON.stringify({ name: null, orders: 'No orders on this account yet.' }),
			'No shipments on this account yet.',
		]);
	});
});

describe('product cards', () => {
	it('attaches the products the tools found to the AI answer, only while product cards is on', async () => {
		const on = [...SHOP, 'shop_search', 'shop_top', 'product_cards'];
		const sys = await start(on);
		sys.ai(
			{
				tools: [
					{ name: 'search_catalog', arguments: { query: 'lamp' } },
					{ name: 'get_top_products', arguments: { kind: 'top' } },
				],
			},
			{ text: 'Here you go.' },
		);
		const v = sys.visitor();
		await v('POST', '/v1/chat/messages', { text: 'Lamps?' });
		expect(sys.aiCalls()[0].messages[0].content).toContain('Add to cart');
		const answer = (await v('GET', '/v1/chat')).json.messages[1];
		expect(answer.text).toBe('Here you go.');
		expect(answer.cards).toEqual([
			{
				productId: 'prd_lamp',
				variantId: 'var_1',
				name: 'Desk lamp',
				price: 4000,
				compareAtPrice: 4500,
				currency: 'USD',
				image: LAMP.image,
				url: LAMP.url,
				inStock: true,
				limits: { step: 2, min: 2, max: 20 },
				unit: null,
			},
			{
				productId: 'prd_tote',
				variantId: 'var_1',
				name: 'Canvas tote',
				price: 1500,
				compareAtPrice: 2000,
				currency: 'USD',
				image: null,
				url: TOTE.url,
				inStock: false,
				limits: { step: 2, min: 2, max: 20 },
				unit: null,
			},
		]);
		await sys.switchOn(on.filter((key) => key !== 'product_cards'));
		expect((await v('GET', '/v1/chat')).json.messages[1].cards).toBeUndefined();
	});

	it('adds no cards without the feature', async () => {
		const sys = await start([...SHOP, 'shop_search']);
		sys.ai({ tools: [{ name: 'search_catalog', arguments: { query: 'lamp' } }] }, { text: 'Desk lamp.' });
		const v = sys.visitor();
		await v('POST', '/v1/chat/messages', { text: 'Lamps?' });
		expect(sys.aiCalls()[0].messages[0].content).not.toContain('Add to cart');
		await sys.switchOn([...SHOP, 'shop_search', 'product_cards']);
		expect((await v('GET', '/v1/chat')).json.messages[1].cards).toBeUndefined();
	});
});

describe('context panel shop info', () => {
	it('shows a signed-in visitor’s last orders and loyalty points; nothing for guests or without the token', async () => {
		const sys = await start([...SHOP, 'inbox', 'context_panel']);
		const { v } = await signedIn(sys);
		await v('POST', '/v1/chat/messages', { text: 'Hello' });
		await sys.visitor()('POST', '/v1/chat/messages', { text: 'Guest here' });
		const ticket = await sys.ticket(['inbox.read']);
		const list = await sys.admin(ticket, 'GET', '/v1/admin/conversations');
		const byKind = Object.fromEntries(list.json.items.map((/** @type {any} */ c) => [c.visitor.kind, c.id]));
		const user = await sys.admin(ticket, 'GET', `/v1/admin/conversations/${byKind.user}`);
		expect(sys.shopCalls().at(-1)?.url).toBe(`${ECOMMERCE}/v1/customers/usr_1/orders?limit=5`);
		// how many orders the panel shows is a setting (C22)
		await sys.setting('context_panel', 'orders', 8);
		await sys.admin(ticket, 'GET', `/v1/admin/conversations/${byKind.user}`);
		expect(sys.shopCalls().at(-1)?.url).toBe(`${ECOMMERCE}/v1/customers/usr_1/orders?limit=8`);
		expect(user.json.conversation.context.shop).toEqual({
			loyaltyPoints: 120,
			orders: [
				{ number: 'SH-1001', status: 'On its way', total: '$45.00', createdAt: '2026-10-01T09:00:00.000Z' },
				{ number: 'SH-1000', status: 'Delivered', total: '$99.00', createdAt: '2026-09-01T00:00:00.000Z' },
			],
		});
		const guest = await sys.admin(ticket, 'GET', `/v1/admin/conversations/${byKind.guest}`);
		expect(guest.json.conversation.context.shop).toBeNull();

		const cookie = await sys.adminSession();
		await sys.dashboard(cookie, 'DELETE', `/v1/dashboard/websites/${sys.websiteId}/connections/ecommerce`);
		const unplugged = await sys.admin(ticket, 'GET', `/v1/admin/conversations/${byKind.user}`);
		expect(unplugged.json.conversation.context.shop).toBeNull();
	});
});

describe('dashboard', () => {
	it('lists the Ecommerce token in the checklist when a shop feature is on', async () => {
		const sys = await start([...SHOP, 'shop_top'], { ecommerce: false });
		const overview = await sys.dashboard(await sys.adminSession(), 'GET', `/v1/dashboard/websites/${sys.websiteId}/overview`);
		const ecommerce = overview.json.checklist.connections.find((/** @type {any} */ c) => c.name === 'ecommerce');
		expect(ecommerce).toMatchObject({ status: 'not_connected', neededBy: expect.arrayContaining(['shop_top']) });
		const plain = await start(SHOP, { ecommerce: false });
		const without = await plain.dashboard(
			await plain.adminSession(),
			'GET',
			`/v1/dashboard/websites/${plain.websiteId}/overview`,
		);
		expect(without.json.checklist.connections.map((/** @type {any} */ c) => c.name)).not.toContain('ecommerce');
	});
});
