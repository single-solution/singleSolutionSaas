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

const PHONE = {
	id: 'prd_phone',
	name: 'Phone X',
	price: 125000,
	currency: 'PKR',
	image: 'https://cdn.shop.example.com/phone.jpg',
	url: 'https://shop.example.com/products/phone-x',
	inStock: true,
	variantId: 'var_1',
};
const CASE = { ...PHONE, id: 'prd_case', name: 'Case', price: 1500, image: 'http://insecure.example.com/c.jpg', inStock: false };

/** Ecommerce's answers by path. @type {Record<string, unknown>} */
const ANSWERS = {
	'/v1/chat/products': { items: [PHONE, CASE, { id: 'broken' }] },
	'/v1/chat/products/top': { items: [PHONE] },
	'/v1/chat/products/prd_phone': {
		...PHONE,
		summary: 'A phone.',
		description: 'A long description.',
		brand: 'Acme',
		options: [{ name: 'Colour', values: ['Black', { name: 'White' }] }],
		specs: { Storage: '128 GB' },
	},
	'/v1/chat/products/prd_phone/quote': {
		productId: 'prd_phone',
		price: 125000,
		priceAfterDeals: 120000,
		savings: 5000,
		currency: 'PKR',
		deals: ['Eid sale'],
	},
	'/v1/chat/deals': { items: [{ id: 'd1', name: 'Eid sale', description: '5% off', endsAt: '2026-10-30T00:00:00.000Z' }] },
	'/v1/chat/me/orders': {
		name: 'Rea Der',
		loyaltyPoints: 120,
		items: [
			{ number: 'A-1001', status: 'Dispatched', total: 125000, currency: 'PKR', placedAt: '2026-10-01', address: '1 Road' },
		],
	},
	'/v1/chat/me/account': { name: 'Rea Der', loyaltyPoints: 120, phone: '+923001234567' },
	'/v1/chat/me/shipments': {
		items: [
			{
				orderNumber: 'A-1001',
				courier: 'Fast',
				trackingNumber: 'T1',
				trackingUrl: 'https://track.example.com/T1',
				status: 'In transit',
				address: '1 Road',
			},
		],
	},
	'/v1/customers/usr_1/orders': {
		loyaltyPoints: 120,
		items: [
			{
				id: 'o1',
				number: 'A-1001',
				status: 'dispatched',
				statusLabel: 'On its way',
				totalText: 'PKR 1,250.00',
				total: 125000,
				currency: 'PKR',
			},
			{ id: 'o2', number: 'A-1000', status: 'delivered', total: 9900, currency: 'PKR', createdAt: '2026-09-01T00:00:00.000Z' },
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
					{ name: 'search_catalog', arguments: { query: 'phone x' } },
					{ name: 'get_product_details', arguments: { productId: 'prd_phone' } },
					{ name: 'quote_product_savings', arguments: { productId: 'prd_phone' } },
					{ name: 'list_active_deals', arguments: {} },
					{ name: 'get_top_products', arguments: { kind: 'new' } },
				],
			},
			{ text: 'Phone X is 1,250.' },
		);
		await sys.visitor()('POST', '/v1/chat/messages', { text: 'Phone X price?' });
		// the tools of one round run together: compare without their order
		const urls = sys.shopCalls().map((c) => c.url.replace(ECOMMERCE, ''));
		expect(urls.sort()).toEqual([
			'/v1/chat/deals?limit=10',
			'/v1/chat/products/prd_phone',
			'/v1/chat/products/prd_phone/quote',
			'/v1/chat/products/top?kind=new&limit=5',
			'/v1/chat/products?q=phone%20x&limit=5',
		]);
		expect(sys.shopCalls().every((c) => c.headers.authorization === `Bearer ${sys.ecommerceToken}`)).toBe(true);
		expect(sys.shopCalls().every((c) => !c.headers['ss-sign-in'])).toBe(true);
		const [search, details, quote, deals, top] = toolAnswers(sys.aiCalls()[1]).map((/** @type {string} */ text) =>
			JSON.parse(text),
		);
		expect(search.products).toEqual([
			{ id: 'prd_phone', name: 'Phone X', price: 'PKR 1,250.00', inStock: true, link: PHONE.url },
			{ id: 'prd_case', name: 'Case', price: 'PKR 15.00', inStock: false, link: PHONE.url },
		]);
		expect(details).toMatchObject({
			brand: 'Acme',
			summary: 'A phone.',
			options: [{ name: 'Colour', values: ['Black', 'White'] }],
			specs: ['Storage: 128 GB'],
		});
		expect(quote).toEqual({
			productId: 'prd_phone',
			price: 'PKR 1,250.00',
			priceAfterDeals: 'PKR 1,200.00',
			savings: 'PKR 50.00',
			deals: ['Eid sale'],
		});
		expect(deals.deals).toEqual([{ name: 'Eid sale', description: '5% off', endsAt: 'Oct 30, 2026, 12:00 AM' }]);
		expect(top.products).toHaveLength(1);
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
		const answers = toolAnswers(sys.aiCalls()[1]);
		expect(JSON.parse(String(answers[0]))).toEqual({
			name: 'Rea Der',
			loyaltyPoints: 120,
			orders: [{ number: 'A-1001', status: 'Dispatched', total: 'PKR 1,250.00', placedAt: 'Oct 1, 2026' }],
		});
		expect(JSON.parse(String(answers[1]))).toEqual({ name: 'Rea Der', loyaltyPoints: 120 });
		expect(JSON.parse(String(answers[2])).shipments).toEqual([
			{
				orderNumber: 'A-1001',
				courier: 'Fast',
				trackingNumber: 'T1',
				trackingLink: 'https://track.example.com/T1',
				status: 'In transit',
			},
		]);
		expect(answers.join(' ')).not.toMatch(/1 Road|\+92/);
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
		missing.ai({ tools: [{ name: 'search_catalog', arguments: { query: 'phone' } }] }, { text: 'Sorry.' });
		await missing.visitor()('POST', '/v1/chat/messages', { text: 'Phones?' });
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
					{ name: 'search_catalog', arguments: { query: 'phone' } },
					{ name: 'list_active_deals', arguments: {} },
					{ name: 'search_catalog', arguments: { query: '  ' } },
					{ name: 'get_product_details', arguments: { productId: '../../admin' } },
				],
			},
			{ text: 'Sorry.' },
		);
		const v = sys.visitor();
		await v('POST', '/v1/chat/messages', { text: 'Phones?' });
		expect(toolAnswers(sys.aiCalls()[1])).toEqual([
			SHOP_UNAVAILABLE,
			SHOP_UNAVAILABLE,
			'Say what to search for.',
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
			JSON.stringify({ name: null, loyaltyPoints: null, orders: 'No orders on this account yet.' }),
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
					{ name: 'search_catalog', arguments: { query: 'phone' } },
					{ name: 'get_top_products', arguments: { kind: 'top' } },
				],
			},
			{ text: 'Here you go.' },
		);
		const v = sys.visitor();
		await v('POST', '/v1/chat/messages', { text: 'Phones?' });
		expect(sys.aiCalls()[0].messages[0].content).toContain('Add to cart');
		const answer = (await v('GET', '/v1/chat')).json.messages[1];
		expect(answer.text).toBe('Here you go.');
		expect(answer.cards).toEqual([
			{
				productId: 'prd_phone',
				variantId: 'var_1',
				name: 'Phone X',
				price: 125000,
				currency: 'PKR',
				image: PHONE.image,
				url: PHONE.url,
				inStock: true,
			},
			{
				productId: 'prd_case',
				variantId: 'var_1',
				name: 'Case',
				price: 1500,
				currency: 'PKR',
				image: null,
				url: PHONE.url,
				inStock: false,
			},
		]);
		await sys.switchOn(on.filter((key) => key !== 'product_cards'));
		expect((await v('GET', '/v1/chat')).json.messages[1].cards).toBeUndefined();
	});

	it('adds no cards without the feature', async () => {
		const sys = await start([...SHOP, 'shop_search']);
		sys.ai({ tools: [{ name: 'search_catalog', arguments: { query: 'phone' } }] }, { text: 'Phone X.' });
		const v = sys.visitor();
		await v('POST', '/v1/chat/messages', { text: 'Phones?' });
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
		expect(user.json.conversation.context.shop).toEqual({
			loyaltyPoints: 120,
			orders: [
				{ number: 'A-1001', status: 'On its way', total: 'PKR 1,250.00', createdAt: null },
				{ number: 'A-1000', status: 'delivered', total: 'PKR 99.00', createdAt: '2026-09-01T00:00:00.000Z' },
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
