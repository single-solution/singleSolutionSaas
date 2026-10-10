/**
 * PLAN 0.12 step 10: Ecommerce against the REAL Portal, with the real Accounts, Payments, Notifications and Chat next
 * to it — connect (manifest and price list), price and feature reports, a catalog item made with the Portal-issued
 * server token, a shopper signed in through the real Accounts, a priced cart, a cash-on-delivery order, an order paid
 * online through the real Payments (Stripe faked in process) and marked paid only after Payments confirms it, a status
 * move by the merchant's staff with a ticket, a partial return refunded through Payments and restocked exactly once,
 * a Chat shop lookup answered from the real Ecommerce with a product card, and the hourly charge. The e-mail provider,
 * Stripe and the AI provider are fakes in this process; no real network call is made.
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	createProductInstance as createAccounts,
	manifest as accountsManifest,
	strings as accountsStrings,
} from '@ss/product-accounts/product';
import { createRoutes as accountsRoutes } from '@ss/product-accounts/routes';
import { createProductInstance as createChat, manifest as chatManifest, strings as chatStrings } from '@ss/product-chat/product';
import { createRoutes as chatRoutes } from '@ss/product-chat/routes';
import { createProductInstance, manifest, strings } from '@ss/product-ecommerce/product';
import { createRoutes } from '@ss/product-ecommerce/routes';
import {
	createProductInstance as createNotifications,
	manifest as notifyManifest,
	strings as notifyStrings,
} from '@ss/product-notifications/product';
import { createRoutes as notifyRoutes } from '@ss/product-notifications/routes';
import {
	createProductInstance as createPayments,
	manifest as payManifest,
	strings as payStrings,
} from '@ss/product-payments/product';
import { createRoutes as payRoutes } from '@ss/product-payments/routes';
import { HOUR, codeOf, startSystem } from './helpers.js';

const SHOP = 'https://ecommerce.test';
const ACCOUNTS = 'https://accounts.test';
const PAYMENTS = 'https://payments.test';
const NOTIFY = 'https://notifications.test';
const CHAT = 'https://chat.test';
const DOMAIN = 'store.example.com';
const ORIGIN = `https://${DOMAIN}`;
const ADMIN_ORIGIN = 'https://admin.store.example.com';
const STRIPE_KEYS = { secretKey: 'sk_test_e2e0123456789', webhookSecret: 'whsec_e2e0123456789' };
const ADDRESS = { name: 'Sara Shopper', phone: '+15550001111', line1: '1 Main Street', city: 'Springfield', country: 'US' };

/** Calls the merchant's Stripe account received. @type {Array<{ path: string, form: URLSearchParams }>} */
const stripeCalls = [];
/** E-mails the merchant's provider (Resend) received. @type {any[]} */
const mails = [];
/** What the merchant's AI provider answers next (a tool call, then text). @type {any[]} */
const aiAnswers = [];

/** @param {Request} request */
const stripe = async (request) => {
	const url = new URL(request.url);
	const form = new URLSearchParams(request.method === 'POST' ? await request.text() : '');
	stripeCalls.push({ path: url.pathname, form });
	if (url.pathname === '/v1/checkout/sessions')
		return Response.json({
			id: `cs_${form.get('client_reference_id')}`,
			url: `https://checkout.stripe.com/c/${form.get('client_reference_id')}`,
		});
	if (url.pathname === '/v1/refunds') return Response.json({ id: `re_${stripeCalls.length}`, status: 'succeeded' });
	return Response.json({ object: 'balance' });
};
/** @param {Request} request */
const resend = async (request) => {
	if (request.method === 'POST') mails.push(await request.json());
	return Response.json({ id: `re_${mails.length}` });
};
/** @param {Request} request */
const openai = async (request) => {
	if (request.method === 'GET') return Response.json({ data: [] });
	const next = aiAnswers.shift() ?? { text: 'Happy to help.' };
	return Response.json({
		choices: [
			{
				message: {
					role: 'assistant',
					content: next.text ?? '',
					...(next.tool
						? {
								tool_calls: [
									{
										id: 'call_1',
										type: 'function',
										function: { name: next.tool, arguments: JSON.stringify(next.arguments) },
									},
								],
							}
						: {}),
				},
				finish_reason: next.tool ? 'tool_calls' : 'stop',
			},
		],
		usage: { prompt_tokens: 50, completion_tokens: 10 },
	});
};

/** @type {import('./helpers.js').System} */
let sys;
/** @type {Awaited<ReturnType<import('./helpers.js').System['merchant']>>} */
let m;
let websiteId = '';
/** @type {Record<string, { browser: string, server: string }>} */
const tokens = {};
let productId = '';
let signIn = '';
let codOrderId = '';
let paidOrderId = '';
let paymentId = '';

beforeAll(async () => {
	/** @param {any} create @param {any} routes @param {any} productManifest @param {any} productStrings @param {string} url */
	const unit = (create, routes, productManifest, productStrings, url) => ({
		createProductInstance: create,
		createRoutes: routes,
		manifest: productManifest,
		strings: productStrings,
		url,
	});
	sys = await startSystem({
		unit: {
			...unit(createProductInstance, createRoutes, manifest, strings, SHOP),
			handlers: {
				'https://api.stripe.com': stripe,
				'https://api.resend.com': resend,
				'https://api.openai.com': openai,
			},
		},
		extras: [
			unit(createAccounts, accountsRoutes, accountsManifest, accountsStrings, ACCOUNTS),
			unit(createPayments, payRoutes, payManifest, payStrings, PAYMENTS),
			unit(createNotifications, notifyRoutes, notifyManifest, notifyStrings, NOTIFY),
			unit(createChat, chatRoutes, chatManifest, chatStrings, CHAT),
		],
	});
});
afterAll(async () => {
	await sys?.stop();
});

/**
 * A shopper's request with the browser token from the website's own domain, signed in when there is a sign-in.
 * @param {string} method @param {string} path @param {{ body?: unknown, key?: string }} [init]
 */
const shopper = (method, path, { body, key } = {}) =>
	sys.call(method, path, {
		token: tokens.ecommerce?.browser,
		origin: ORIGIN,
		...(body === undefined ? {} : { body }),
		headers: { ...(signIn ? { 'ss-sign-in': signIn } : {}), ...(key ? { 'idempotency-key': key } : {}) },
	});

/** @param {string} method @param {string} path @param {unknown} [body] */
const merchantServer = (method, path, body) =>
	sys.call(method, path, { token: tokens.ecommerce?.server, ...(body === undefined ? {} : { body }) });

/**
 * A dashboard write on another product.
 * @param {string} base @param {string} productKey @param {string} path @param {unknown} body @param {string} [method]
 */
const setUp = async (base, productKey, path, body, method = 'PUT') => {
	const cookie = await sys.adminSession(await sys.owner(), websiteId, productKey);
	return sys.dashboard(cookie, method, `/v1/dashboard/websites/${websiteId}${path}`, body, base);
};

/** A ticket of the merchant's staff for the admin widgets. @param {string[]} permissions */
const ticket = async (permissions) => {
	const answer = await merchantServer('POST', '/v1/tickets', {
		user: { id: 'u_staff', name: 'Sam Staff', email: 'sam@store.example.com' },
		permissions,
		origin: ADMIN_ORIGIN,
	});
	return String(answer.json.ticket);
};

/** @param {string} id */
const stockOf = async (id) => (await merchantServer('GET', `/v1/products/${id}`)).json.variants[0].stock;

describe('Ecommerce on the real Portal', () => {
	it('connects: the Portal keeps its manifest and price list version 1, every feature at 0', async () => {
		expect(await sys.connect()).toMatchObject({ productId: 'ecommerce' });
		for (const base of [ACCOUNTS, PAYMENTS, NOTIFY, CHAT]) await sys.connect({ base });
		const page = await (await sys.owner()).get('/v1/admin/products/ecommerce');
		expect(page.json.priceListVersion).toBe(1);
		expect(page.json.features.map((/** @type {{ key: string }} */ f) => f.key)).toEqual(manifest.features.map((f) => f.key));
		expect(page.json.features.every((/** @type {{ millicreditsPerHour: number }} */ f) => f.millicreditsPerHour === 0)).toBe(
			true,
		);
		m = await sys.merchant('store@shop.test', [DOMAIN]);
		websiteId = m.websiteIds[0] ?? '';
		for (const id of ['ecommerce', 'accounts', 'payments', 'notifications', 'chat']) {
			await sys.addProduct(m.merchantId, websiteId, id);
			tokens[id] = await sys.tokens(m.merchantId, websiteId, id);
		}
		await sys.addCredits(m.merchantId, 100);
	});

	it('an Owner prices features and a Support admin switches them on: both reports are accepted', async () => {
		expect(await sys.setPrices({ catalog: 1000, checkout: 500 })).toMatchObject({ version: 2 });
		const support = await sys.admin('support');
		const cookie = await sys.adminSession(support.client, websiteId);
		const on = ['catalog', 'checkout', 'cod', 'returns'];
		const report = await sys.switchFeatures(cookie, websiteId, on);
		expect(report.version).toBe(1);
		expect([...report.on].sort()).toEqual(on);
		const [entry] = await sys.activity('product.features_changed');
		expect(entry?.after).toMatchObject({ on });
	});

	it('sets up the shop: its database, and the pasted Accounts, Payments and Notifications tokens', async () => {
		// Accounts: e-mail and password sign-in
		expect((await setUp(ACCOUNTS, 'accounts', '/features', { on: ['email_password'] })).status).toBe(200);
		await sys.connectDatabase(await sys.adminSession(await sys.owner(), websiteId, 'accounts'), websiteId, ACCOUNTS);
		// Payments: Stripe with the merchant's keys, the payment API and refunds
		expect((await setUp(PAYMENTS, 'payments', '/features', { on: ['payment_api', 'refunds', 'stripe'] })).status).toBe(200);
		await sys.connectDatabase(await sys.adminSession(await sys.owner(), websiteId, 'payments'), websiteId, PAYMENTS);
		expect((await setUp(PAYMENTS, 'payments', '/connections/stripe', { value: STRIPE_KEYS })).json).toMatchObject({
			status: 'connected',
		});
		// Notifications: e-mail through the merchant's provider, with the order-placed template
		expect((await setUp(NOTIFY, 'notifications', '/features', { on: ['email'] })).status).toBe(200);
		await sys.connectDatabase(await sys.adminSession(await sys.owner(), websiteId, 'notifications'), websiteId, NOTIFY);
		const provider = await setUp(NOTIFY, 'notifications', '/connections/email', {
			value: { provider: 'resend', secret: 're_live_key_0003', from: 'Store <shop@store.example.com>' },
		});
		expect(provider.json).toMatchObject({ status: 'connected' });
		const template = await setUp(NOTIFY, 'notifications', '/templates', {
			key: 'ecommerce.order_placed',
			channel: 'email',
			subject: 'Order {number}',
			text: 'Thank you {name}: order {number}, {total}.',
		});
		expect(template.status).toBe(200);
		// Ecommerce: its merchant database and the three pasted tokens
		const cookie = await sys.adminSession(await sys.owner(), websiteId);
		await sys.connectDatabase(cookie, websiteId);
		for (const id of ['accounts', 'payments', 'notifications']) {
			const pasted = await sys.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${websiteId}/connections/${id}`, {
				value: tokens[id]?.server,
			});
			expect(pasted.json).toMatchObject({ status: 'connected' });
		}
		// a token of another product is refused where Payments' is expected
		const wrong = await sys.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${websiteId}/connections/payments`, {
			value: tokens.chat?.server,
		});
		expect(wrong.status).toBe(422);
	});

	it('the merchant’s server adds a catalog item with the Portal-issued server token; shoppers find it', async () => {
		const created = await merchantServer('POST', '/v1/products', {
			name: 'Phone X',
			status: 'active',
			summary: 'A fast phone',
			price: 50_000,
			sku: 'PHX-1',
			stock: 5,
		});
		expect(created.status).toBe(201);
		productId = created.json.id;
		expect(created.json).toMatchObject({ slug: 'phone-x', price: 50_000, inStock: true });
		const found = await shopper('GET', '/v1/shop/products?q=phone');
		expect(found.json.items).toEqual([
			expect.objectContaining({
				id: productId,
				name: 'Phone X',
				price: 50_000,
				currency: 'USD',
				url: `${ORIGIN}/products/phone-x`,
			}),
		]);
		// the server token never works from a browser
		expect((await sys.call('GET', '/v1/products', { token: tokens.ecommerce?.server, origin: ORIGIN })).status).toBe(401);
	});

	it('a shopper signs in through the real Accounts and gets a priced cart', async () => {
		const up = await sys.call('POST', '/v1/sign-up/password', {
			base: ACCOUNTS,
			token: tokens.accounts?.browser,
			origin: ORIGIN,
			body: { email: 'sara@example.com', password: 'a long enough password', name: 'Sara Shopper' },
		});
		expect(up.json.status).toBe('signed_in');
		const quote = await shopper('POST', '/v1/shop/cart/quote', { body: { lines: [{ productId, quantity: 2 }] } });
		expect(quote.status).toBe(200);
		expect(quote.json.totals).toMatchObject({ subtotal: 100_000, total: 100_000 });
		// placing needs the sign-in
		const guest = await shopper('POST', '/v1/shop/orders', {
			body: { lines: [{ productId }], payment: 'cod', address: ADDRESS },
			key: 'guest-try',
		});
		expect(codeOf(guest)).toBe('sign_in_required');
		signIn = String(up.json.signIn);
	});

	it('places a cash-on-delivery order: stock held in the same step; the shopper is told through Notifications', async () => {
		const placed = await shopper('POST', '/v1/shop/orders', {
			body: { lines: [{ productId, quantity: 1 }], payment: 'cod', address: ADDRESS },
			key: 'cod-1',
		});
		expect(placed.status).toBe(201);
		codOrderId = placed.json.order.id;
		expect(placed.json).toMatchObject({
			next: { kind: 'done' },
			order: { status: 'awaiting_confirmation', payment: { method: 'cod', state: 'unpaid' }, totals: { total: 50_000 } },
		});
		expect(await stockOf(productId)).toBe(4);
		const again = await shopper('POST', '/v1/shop/orders', {
			body: { lines: [{ productId, quantity: 1 }], payment: 'cod', address: ADDRESS },
			key: 'cod-1',
		});
		expect(again.json.order?.id ?? codOrderId).toBe(codOrderId);
		expect(await stockOf(productId)).toBe(4);
		const mail = mails.find((sent) => String(sent.subject).startsWith('Order '));
		expect(mail).toMatchObject({ to: ['sara@example.com'] });
		expect(mail.text).toContain(placed.json.order.number);
	});

	it('places an order paid online: marked paid only after Payments confirms the exact amount', async () => {
		const placed = await shopper('POST', '/v1/shop/orders', {
			body: { lines: [{ productId, quantity: 2 }], payment: 'online', address: ADDRESS, returnUrl: `${ORIGIN}/checkout` },
			key: 'online-1',
		});
		expect(placed.status).toBe(201);
		paidOrderId = placed.json.order.id;
		expect(placed.json.order).toMatchObject({ status: 'pending_payment', payment: { state: 'pending' } });
		expect(placed.json.next.kind).toBe('pay');
		const payUrl = new URL(placed.json.next.url);
		expect(payUrl.origin).toBe(PAYMENTS);
		paymentId = /pay_[A-Za-z0-9]+/.exec(payUrl.pathname)?.[0] ?? '';
		// the shopper picks Stripe on Payments' page and pays on Stripe's
		const pick = await sys.call('POST', payUrl.pathname, { base: PAYMENTS, form: { gateway: 'stripe' } });
		expect([pick.status, pick.headers.get('location')]).toEqual([303, payUrl.pathname]);
		const go = await sys.call('GET', payUrl.pathname, { base: PAYMENTS });
		expect([go.status, go.headers.get('location')]).toEqual([303, `https://checkout.stripe.com/c/${paymentId}`]);
		// coming back with a forged parameter changes nothing: still waiting
		sys.clock.advance(31_000);
		expect((await shopper('GET', `/v1/shop/orders/${paidOrderId}?ss_payment=${paymentId}`)).json.payment.state).toBe('pending');
		// Stripe's signed confirmation reaches Payments
		const event = JSON.stringify({
			type: 'checkout.session.completed',
			data: {
				object: {
					id: `cs_${paymentId}`,
					client_reference_id: paymentId,
					payment_status: 'paid',
					amount_total: 100_000,
					currency: 'usd',
					payment_intent: 'pi_shop',
				},
			},
		});
		const t = Math.floor(sys.clock.now() / 1000);
		const signature = `t=${t},v1=${createHmac('sha256', STRIPE_KEYS.webhookSecret).update(`${t}.${event}`).digest('hex')}`;
		const notice = await sys.call('POST', `/v1/gateways/stripe/${websiteId}`, {
			base: PAYMENTS,
			body: event,
			headers: { 'stripe-signature': signature },
		});
		expect(notice.json).toEqual({ received: true });
		// Ecommerce asks Payments again (server to server) when the order is read
		sys.clock.advance(31_000);
		const read = await shopper('GET', `/v1/shop/orders/${paidOrderId}`);
		expect(read.json).toMatchObject({ status: 'confirmed', payment: { state: 'paid', paid: 100_000 } });
		expect(await stockOf(productId)).toBe(2);
	});

	it('the merchant’s staff move orders with a ticket, only along the flow', async () => {
		const staff = await ticket(['orders.read', 'orders.manage', 'returns.manage']);
		const admin = (/** @type {string} */ method, /** @type {string} */ path, /** @type {unknown} */ body = undefined) =>
			sys.call(method, path, { token: staff, origin: ADMIN_ORIGIN, ...(body === undefined ? {} : { body }) });
		const list = await admin('GET', '/v1/admin/orders');
		expect(list.json.items.map((/** @type {any} */ o) => o.id).sort()).toEqual([codOrderId, paidOrderId].sort());
		expect(codeOf(await admin('POST', `/v1/admin/orders/${codOrderId}/move`, { to: 'delivered' }))).toBe('move_not_allowed');
		const confirmed = await admin('POST', `/v1/admin/orders/${codOrderId}/move`, { to: 'confirmed' });
		expect(confirmed.json).toMatchObject({ status: 'confirmed', statusLabel: 'Confirmed' });
		const delivered = await admin('POST', `/v1/admin/orders/${paidOrderId}/move`, { to: 'delivered', note: 'Handed over' });
		expect(delivered.json).toMatchObject({ status: 'delivered' });
		expect(delivered.json.history.at(-1)).toMatchObject({ to: 'delivered', by: 'Sam Staff' });
		// a ticket works only from its own origin
		expect((await sys.call('GET', '/v1/admin/orders', { token: staff, origin: ORIGIN })).status).toBe(401);
	});

	it('the merchant’s server moves an order as a named member of staff (SS-Actor), and counts match the lists', async () => {
		const server = String(tokens.ecommerce?.server);
		const actor = {
			'ss-actor-id': 'usr_staff_7',
			'ss-actor-name': encodeURIComponent('Ayesha Khan'),
			'ss-actor-role': 'Packer',
		};
		const packed = await sys.call('POST', `/v1/orders/${codOrderId}/move`, {
			token: server,
			headers: actor,
			body: { to: 'packed' },
		});
		expect(packed.status).toBe(200);
		expect(packed.json.history.at(-1)).toMatchObject({ to: 'packed', by: 'Ayesha Khan' });
		const activity = await sys.call('GET', `/v1/activity?target=${codOrderId}&actor=usr_staff_7`, { token: server });
		expect(activity.json.items[0]).toMatchObject({
			actor: { kind: 'user', id: 'usr_staff_7', name: 'Ayesha Khan', role: 'Packer' },
		});
		// without the headers the server is the actor
		const unpacked = await sys.call('POST', `/v1/orders/${codOrderId}/move`, { token: server, body: { to: 'delivered' } });
		expect(unpacked.json.history.at(-1)).toMatchObject({ to: 'delivered', by: 'Server' });
		// counts equal the lists (PLAN 0.8.10 K4)
		for (const list of ['orders', 'products', 'customers', 'returns']) {
			const items = await sys.call('GET', `/v1/${list}?limit=100`, { token: server });
			const count = await sys.call('GET', `/v1/${list}/count`, { token: server });
			expect([list, count.json]).toEqual([list, { count: items.json.items.length, capped: false }]);
		}
		// a count has its list's feature: reviews are off here, so both refuse alike
		const reviews = await sys.call('GET', '/v1/reviews', { token: server });
		const reviewCount = await sys.call('GET', '/v1/reviews/count', { token: server });
		expect([reviews.status, codeOf(reviews), reviewCount.status, codeOf(reviewCount)]).toEqual([
			403,
			'feature_off',
			403,
			'feature_off',
		]);
		const byStatus = await sys.call('GET', '/v1/orders/counts?by=status', { token: server });
		expect(byStatus.json).toEqual({ total: 2, groups: { delivered: 2 } });
		const byRole = await sys.call('GET', '/v1/orders/counts?by=role', { token: server });
		expect(byRole.json).toEqual({ total: 2, groups: { delivered: 2 } });
	});

	it('a partial return is refunded through Payments and restocked exactly once', async () => {
		const order = await shopper('GET', `/v1/shop/orders/${paidOrderId}`);
		const lineId = order.json.lines[0].id;
		const claim = await shopper('POST', '/v1/shop/returns', {
			body: { orderId: paidOrderId, kind: 'return', lines: [{ lineId, quantity: 1 }], reason: 'Changed my mind' },
			key: 'return-1',
		});
		expect(claim.status).toBe(201);
		const claimId = claim.json.id;
		const staff = await ticket(['returns.manage']);
		const admin = (/** @type {string} */ path, /** @type {unknown} */ body) =>
			sys.call('POST', path, { token: staff, origin: ADMIN_ORIGIN, body });
		expect((await admin(`/v1/admin/returns/${claimId}/approve`, {})).json.status).toBe('approved');
		const refunded = await sys.call('POST', `/v1/admin/returns/${claimId}/refund`, {
			token: staff,
			origin: ADMIN_ORIGIN,
			body: { amount: 50_000 },
			headers: { 'idempotency-key': 'refund-claim-1' },
		});
		expect(refunded.status).toBe(200);
		expect(refunded.json).toMatchObject({ status: 'refunded', refundAmount: 50_000 });
		const call = stripeCalls.find((c) => c.path === '/v1/refunds');
		expect([call?.form.get('payment_intent'), call?.form.get('amount')]).toEqual(['pi_shop', '50000']);
		const payment = await sys.call('GET', `/v1/payments/${paymentId}`, { base: PAYMENTS, token: tokens.payments?.server });
		expect(payment.json).toMatchObject({ status: 'partially_refunded', refunded: 50_000 });
		const before = await stockOf(productId);
		expect((await admin(`/v1/admin/returns/${claimId}/restock`, {})).status).toBe(200);
		expect(await stockOf(productId)).toBe(before + 1);
		expect((await admin(`/v1/admin/returns/${claimId}/restock`, {})).status).toBe(409);
		expect(await stockOf(productId)).toBe(before + 1);
	});

	it('Chat’s shop search looks the product up in the real Ecommerce and shows a product card', async () => {
		const chatCookie = await sys.adminSession(await sys.owner(), websiteId, 'chat');
		const on = ['ai_replies', 'guest_chat', 'product_cards', 'shop_search', 'visitor_chat'];
		expect((await setUp(CHAT, 'chat', '/features', { on })).status).toBe(200);
		await sys.connectDatabase(chatCookie, websiteId, CHAT);
		await setUp(CHAT, 'chat', '/connections/ai', {
			value: { provider: 'openai', apiKey: 'sk-merchant-000456', model: 'gpt-4.1-mini' },
		});
		const pasted = await setUp(CHAT, 'chat', '/connections/ecommerce', { value: tokens.ecommerce?.server });
		expect(pasted.json).toMatchObject({ status: 'connected' });
		aiAnswers.push({ tool: 'search_catalog', arguments: { query: 'phone' } }, { text: 'Phone X is in stock.' });
		const sent = await sys.call('POST', '/v1/chat/messages', {
			base: CHAT,
			token: tokens.chat?.browser,
			origin: ORIGIN,
			body: { text: 'Do you have phones?' },
		});
		expect(sent.status).toBe(201);
		const state = await sys.call('GET', '/v1/chat', {
			base: CHAT,
			token: tokens.chat?.browser,
			origin: ORIGIN,
			headers: { 'ss-guest': String(sent.json.guestKey) },
		});
		const answer = state.json.messages.at(-1);
		expect(answer).toMatchObject({ author: 'ai', text: 'Phone X is in stock.' });
		expect(answer.cards).toEqual([
			expect.objectContaining({ productId, name: 'Phone X', url: `${ORIGIN}/products/phone-x`, inStock: true }),
		]);
	});

	it('the Portal charges the switched-on features every clock hour', async () => {
		const cards = await m.client.get(`/v1/merchants/${m.merchantId}/websites/${websiteId}/products`);
		expect(cards.json.items).toEqual(
			expect.arrayContaining([expect.objectContaining({ productId: 'ecommerce', hourlyCost: 1500, dailyCost: 36_000 })]),
		);
		const cookie = await sys.merchantSession(m, websiteId);
		const before = await sys.dashboard(cookie, 'GET', `/v1/dashboard/websites/${websiteId}/overview`);
		expect(before.json).toMatchObject({ status: { status: 'active' } });
		sys.clock.advance(HOUR);
		const after = await sys.dashboard(cookie, 'GET', `/v1/dashboard/websites/${websiteId}/overview`);
		expect(after.json.todayMillicredits).toBe(before.json.todayMillicredits + 1500);
	});
});
