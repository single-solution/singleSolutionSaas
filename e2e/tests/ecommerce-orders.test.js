/**
 * PLAN 0.8.10 build phase 4, Ecommerce's "done when": guest and member checkout (a guest's order key and order page by
 * number; a member's sign-in claims the guest's orders and points), COD (the cash-handling fee, the open start status),
 * bank transfer (through the real Payments `bank_transfer` gateway with its bank details, and `bankTransferVia: manual`
 * with the shopper's proof upload and staff-recorded payments) and whole-unit totals (Format `wholeUnits` with GBP),
 * deal rules and locks, role pricing (an Accounts role on the sign-in), the loyalty options, the extra moves (refunded
 * before delivery only when paid; a customer return after delivery with and without restock), the payments log, an
 * order numbered `SO-2026-0043` (prefix, digits and the counter, in the business year of business.json's time zone),
 * events, staff alerts (listed recipients and Accounts staff whose role grants the permission) and per-status
 * messages (the mails the real Notifications sends), claims, invoices, the reports summary, and the shop's own order and
 * unit fields (a gift message asked at checkout, a box size needed before packing, a dual-SIM phone's IMEIs). Ecommerce runs on the
 * REAL Portal with the real Accounts, Payments and Notifications next to it; the email provider (Resend), the
 * merchant's S3 bucket and the shop's own site (its business.json) are fakes in this process.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	createProductInstance as createAccounts,
	manifest as accountsManifest,
	strings as accountsStrings,
} from '@ss/product-accounts/product';
import { createRoutes as accountsRoutes } from '@ss/product-accounts/routes';
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
import { codeOf, startSystem } from './helpers.js';

const SHOP = 'https://ecommerce-orders.test';
const ACCOUNTS = 'https://accounts-orders.test';
const PAYMENTS = 'https://payments-orders.test';
const NOTIFY = 'https://notifications-orders.test';
const BUCKET = 'https://bucket.orders.test';
const DOMAIN = 'shop.example.com';
const ORIGIN = `https://${DOMAIN}`;
const PASSWORD = 'a long shopper password';
const TEAM = 'orders@shop.example.com';
const MANAGER = 'manager@shop.example.com';
const ADDRESS = { name: 'Sara Shopper', phone: '+447700900111', line1: '1 High Street', city: 'London', country: 'GB' };
const LONDON = { city: 'London' };
/** Prices in pence (GBP minor units): whole pounds, as the merchant enters them. */
const PHONE_PRICE = 4_999_900;
const CASE_PRICE = 99_900;
const DELIVERY = 25_000;

/** The default order flow with the E27 moves listed, and a customer-return status (role `returned`). */
const FLOW = {
	statuses: [
		{ key: 'pending_payment', label: 'Awaiting payment', role: 'awaiting_payment' },
		{ key: 'awaiting_confirmation', label: 'Awaiting confirmation', role: 'awaiting_confirmation' },
		{ key: 'confirmed', label: 'Confirmed', role: 'open' },
		{ key: 'packed', label: 'Packed', role: 'packed' },
		{ key: 'dispatched', label: 'Dispatched', role: 'shipped' },
		{ key: 'delivered', label: 'Delivered', role: 'delivered' },
		{ key: 'cancelled', label: 'Canceled', role: 'cancelled' },
		{ key: 'returned', label: 'Returned to origin', role: 'returned_to_origin' },
		{ key: 'refunded', label: 'Refunded', role: 'refunded' },
		{ key: 'customer-returned', label: 'Returned by the customer', role: 'returned' },
	],
	moves: [
		{ from: 'pending_payment', to: 'confirmed' },
		{ from: 'pending_payment', to: 'cancelled' },
		{ from: 'awaiting_confirmation', to: 'confirmed' },
		{ from: 'awaiting_confirmation', to: 'cancelled' },
		{ from: 'confirmed', to: 'packed' },
		{ from: 'confirmed', to: 'delivered' },
		{ from: 'confirmed', to: 'cancelled' },
		{ from: 'packed', to: 'dispatched' },
		{ from: 'packed', to: 'delivered' },
		{ from: 'packed', to: 'cancelled' },
		{ from: 'dispatched', to: 'delivered' },
		{ from: 'dispatched', to: 'returned' },
		{ from: 'delivered', to: 'refunded' },
		{ from: 'returned', to: 'refunded' },
		{ from: 'confirmed', to: 'refunded' },
		{ from: 'delivered', to: 'customer-returned' },
		{ from: 'customer-returned', to: 'refunded' },
	],
};

/** E-mails the merchant's provider (Resend) received from Notifications. @type {any[]} */
const mails = [];
/** @param {Request} request */
const resend = async (request) => {
	if (request.method === 'POST') mails.push(await request.json());
	return Response.json({ id: `re_${mails.length}` });
};

/** @type {Record<string, string>} */
const TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf' };
/**
 * The merchant's S3 bucket: every upload works; HEAD answers a file of the key's type.
 * @param {Request} request
 */
const bucket = async (request) => {
	if (request.method !== 'HEAD') return new Response(null, { status: 200 });
	const extension = new URL(request.url).pathname.split('.').pop() ?? '';
	return new Response(null, {
		status: 200,
		headers: { 'content-type': TYPES[extension] ?? 'application/octet-stream', 'content-length': '1000' },
	});
};

/**
 * The shop's own site: its business.json names the business time zone (PLAN 0.8.10 K8).
 * @param {Request} request
 */
const storeSite = async (request) =>
	new URL(request.url).pathname === '/.well-known/business.json'
		? Response.json({ version: 1, name: 'Example Shop', email: 'hello@shop.example.com', timeZone: 'Europe/London' })
		: new Response('not found', { status: 404 });

/** @type {import('./helpers.js').System} */
let sys;
let websiteId = '';
/** @type {Record<string, { browser: string, server: string }>} */
const tokens = {};
/** Records the tests share. @type {Record<string, any>} */
const ids = {};
let ip = 0;

/** A fresh visitor address, so per-visitor rate limits never mix the tests' shoppers. */
const nextIp = () => {
	ip += 1;
	return `10.44.${(ip >> 8) & 255}.${ip & 255}`;
};

/**
 * A shopper's request to Ecommerce with the browser token from the store's domain.
 * @param {string} method @param {string} path
 * @param {{ body?: unknown, signIn?: string, key?: string, orderKey?: string }} [init]
 */
const shopper = (method, path, { body, signIn, key, orderKey } = {}) =>
	sys.call(method, path, {
		token: tokens.ecommerce?.browser,
		origin: ORIGIN,
		...(body === undefined ? {} : { body }),
		headers: {
			'x-forwarded-for': nextIp(),
			...(signIn ? { 'ss-sign-in': signIn } : {}),
			...(key ? { 'idempotency-key': key } : {}),
			...(orderKey ? { 'ss-order-key': orderKey } : {}),
		},
	});

/**
 * A call of the store's server with Ecommerce's server token; `staff` names the acting member of staff (K2).
 * @param {string} method @param {string} path @param {unknown} [body] @param {{ staff?: string, key?: string }} [init]
 */
const server = (method, path, body, { staff, key } = {}) =>
	sys.call(method, path, {
		token: tokens.ecommerce?.server,
		...(body === undefined ? {} : { body }),
		headers: {
			...(staff
				? { 'ss-actor-id': `usr_${staff.split(' ')[0]?.toLowerCase()}`, 'ss-actor-name': encodeURIComponent(staff) }
				: {}),
			...(key ? { 'idempotency-key': key } : {}),
		},
	});

/** @param {string} method @param {string} path @param {unknown} [body] */
const write = async (method, path, body) => {
	const answer = await server(method, path, body);
	expect(answer.status, `${method} ${path}: ${JSON.stringify(answer.json)}`).toBeLessThan(300);
	return answer.json;
};

/**
 * Save settings and lists through a product's settings API (K1) with its server token.
 * @param {string} base @param {string} productId @param {Record<string, unknown>} values
 */
const configureOn = async (base, productId, values) => {
	for (const [key, value] of Object.entries(values)) {
		const path = key.startsWith('list.') ? `/v1/lists/${key.slice(5)}` : `/v1/settings/${key}`;
		const saved = await sys.call('PUT', path, { base, token: tokens[productId]?.server, body: { value } });
		expect(saved.status, `${productId} ${key}: ${JSON.stringify(saved.json)}`).toBeLessThan(300);
	}
};

/** @param {Record<string, unknown>} values */
const configure = (values) => configureOn(SHOP, 'ecommerce', values);

/**
 * A dashboard write on a product (Owner).
 * @param {string} base @param {string} productId @param {string} path @param {unknown} body @param {string} [method]
 */
const dashboardOf = async (base, productId, path, body, method = 'PUT') => {
	const cookie = await sys.adminSession(await sys.owner(), websiteId, productId);
	const answer = await sys.dashboard(cookie, method, `/v1/dashboard/websites/${websiteId}${path}`, body, base);
	expect(answer.status, `${productId} ${path}: ${JSON.stringify(answer.json)}`).toBeLessThan(300);
	return answer.json;
};

/**
 * An Accounts user made by the store's server (staff-entered contacts are verified, A4).
 * @param {{ name: string, email?: string, phone: string, role?: string }} user
 */
const accountsUser = async (user) => {
	const made = await sys.call('POST', '/v1/users', {
		base: ACCOUNTS,
		token: tokens.accounts?.server,
		body: { ...user, password: PASSWORD },
	});
	expect(made.status, JSON.stringify(made.json)).toBe(201);
	return made.json;
};

/**
 * A shopper signs in on the store with phone and password through the real Accounts: the sign-in Ecommerce trusts.
 * @param {string} phone as typed (national form)
 */
const signIn = async (phone) => {
	const answer = await sys.call('POST', '/v1/sign-in/phone-password', {
		base: ACCOUNTS,
		token: tokens.accounts?.browser,
		origin: ORIGIN,
		body: { phone, password: PASSWORD },
		headers: { 'x-forwarded-for': nextIp() },
	});
	expect(answer.json?.status, JSON.stringify(answer.json)).toBe('signed_in');
	return String(answer.json.signIn);
};

let keys = 0;
/**
 * Place an order as a shopper (or a guest with `customer`).
 * @param {Record<string, unknown>} body @param {string} [token] the sign-in
 */
const place = (body, token) => {
	keys += 1;
	return shopper('POST', '/v1/shop/orders', {
		body: { address: ADDRESS, ...body },
		...(token ? { signIn: token } : {}),
		key: `order-${keys}`,
	});
};

/** @param {Record<string, unknown>} body @param {string} [token] */
const quote = (body, token) =>
	shopper('POST', '/v1/shop/cart/quote', { body: { delivery: LONDON, ...body }, ...(token ? { signIn: token } : {}) });

/** @param {string} id @param {string} to @param {Record<string, unknown>} [extra] @param {string} [staff] */
const move = (id, to, extra = {}, staff = 'Alex Morgan') => server('POST', `/v1/orders/${id}/move`, { to, ...extra }, { staff });

/** @param {string} id */
const orderOf = async (id) => (await server('GET', `/v1/orders/${id}`)).json;

/** @param {string} id the product */
const stockOf = async (id) => (await server('GET', `/v1/products/${id}`)).json.variants[0].stock;

/** Mails sent since a count, to an address. @param {number} since @param {string} to */
const mailsTo = (since, to) => mails.slice(since).filter((mail) => (mail.to ?? []).includes(to));

/** @param {string} types comma-separated */
const eventsOf = async (types) => (await server('GET', `/v1/events?types=${types}&limit=100`)).json.items;

/** A case line (the simple product). @param {number} [quantity] */
const caseLine = (quantity = 1) => ({ productId: ids.case.id, quantity });

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
			handlers: { 'https://api.resend.com': resend, [BUCKET]: bucket, [ORIGIN]: storeSite },
		},
		extras: [
			unit(createAccounts, accountsRoutes, accountsManifest, accountsStrings, ACCOUNTS),
			unit(createPayments, payRoutes, payManifest, payStrings, PAYMENTS),
			unit(createNotifications, notifyRoutes, notifyManifest, notifyStrings, NOTIFY),
		],
	});
	await sys.connect();
	for (const base of [ACCOUNTS, PAYMENTS, NOTIFY]) await sys.connect({ base });
	const m = await sys.merchant('owner@shop.test', [DOMAIN]);
	websiteId = m.websiteIds[0] ?? '';
	for (const id of ['ecommerce', 'accounts', 'payments', 'notifications']) {
		await sys.addProduct(m.merchantId, websiteId, id);
		tokens[id] = await sys.tokens(m.merchantId, websiteId, id);
	}
	await sys.addCredits(m.merchantId, 100);
	const owner = await sys.owner();

	// Accounts: phone + password sign-in with roles; a member role; a manager whose role grants ecommerce:orders.read
	await dashboardOf(ACCOUNTS, 'accounts', '/features', { on: ['phone_password', 'roles'] });
	await sys.connectDatabase(await sys.adminSession(owner, websiteId, 'accounts'), websiteId, ACCOUNTS);
	await configureOn(ACCOUNTS, 'accounts', {
		'phone.defaultCallingCode': '+44',
		'phone.trunkPrefix': '0',
		'phone_password.breachedCheck': false,
	});
	const role = await sys.call('PUT', '/v1/roles/member', {
		base: ACCOUNTS,
		token: tokens.accounts?.server,
		body: { name: 'Member', permissions: ['site:discount'] },
	});
	expect(role.status, JSON.stringify(role.json)).toBe(200);
	ids.manager = await accountsUser({
		name: 'Maya Manager',
		email: MANAGER,
		phone: '+447700900444',
		role: 'business_manager',
	});

	// Payments: the payment API and bank transfer with the store's bank details (P1)
	await dashboardOf(PAYMENTS, 'payments', '/features', { on: ['payment_api', 'bank_transfer'] });
	await sys.connectDatabase(await sys.adminSession(owner, websiteId, 'payments'), websiteId, PAYMENTS);
	await configureOn(PAYMENTS, 'payments', {
		'bank_transfer.accountHolder': 'Example Shop Ltd',
		'bank_transfer.bankName': 'Example Bank',
		'bank_transfer.accountNumber': '31926819',
		'bank_transfer.iban': 'GB29NWBK60161331926819',
		'bank_transfer.instructions': 'Write your order number as the reference.',
	});

	// Notifications: email through the merchant's provider, with the shopper's and the staff's templates
	await dashboardOf(NOTIFY, 'notifications', '/features', { on: ['email'] });
	await sys.connectDatabase(await sys.adminSession(owner, websiteId, 'notifications'), websiteId, NOTIFY);
	await dashboardOf(NOTIFY, 'notifications', '/connections/email', {
		value: { provider: 'resend', secret: 're_live_key_0044', from: 'Example Shop <shop@shop.example.com>' },
	});
	for (const [key, subject, text] of [
		['ecommerce.order_placed', 'Order {number} placed', 'Hi {firstName}, order {number} for {total} is placed: {orderUrl}'],
		['ecommerce.order_status.confirmed', 'Order {number}: {status}', 'Hi {firstName}, order {number} is {status}.'],
		['ecommerce.order_status.cancelled', 'Order {number}: {status}', 'Order {number} is {status} ({cancelReason}).'],
		['ecommerce.order_status.refunded', 'Order {number}: {status}', 'Order {number} is {status}.'],
		['ecommerce.staff_placed', 'New order {number}', '{name} placed {number} for {total} ({paymentMethod}).'],
		['ecommerce.staff_paid', 'Paid: {number}', 'Order {number} is paid.'],
		['ecommerce.staff_cancelled', 'Canceled: {number}', 'Order {number} was canceled ({reason}).'],
		['ecommerce.staff_proof_uploaded', 'Transfer proof: {number}', 'Proof for {number}, reference {reference}.'],
		['ecommerce.staff_return_requested', 'Claim {reference}', 'A claim {reference} on order {number}.'],
		['ecommerce.back_in_stock', 'Back in stock: {name}', '{name} is back for {price}: {url} Stop these alerts: {stopUrl}'],
	])
		await dashboardOf(NOTIFY, 'notifications', '/templates', { key, channel: 'email', subject, text });

	// Ecommerce: the features these tests use, its database, the bucket and the three pasted tokens
	const support = await sys.admin('support');
	await sys.switchFeatures(await sys.adminSession(support.client, websiteId), websiteId, [
		'catalog',
		'variants',
		'grades_serials',
		'checkout',
		'cod',
		'delivery_zones',
		'deals',
		'loyalty',
		'role_pricing',
		'returns',
		'invoices',
		'reports',
		'events',
		'staff_alerts',
		'alerts',
	]);
	const cookie = await sys.adminSession(owner, websiteId);
	await sys.connectDatabase(cookie, websiteId);
	await dashboardOf(SHOP, 'ecommerce', '/connections/storage', {
		value: {
			endpoint: BUCKET,
			region: 'auto',
			bucket: 'shop',
			accessKeyId: 'AKIAORDERS',
			secretAccessKey: 'orders-secret-0123456789',
		},
	});
	for (const id of ['accounts', 'payments', 'notifications']) {
		const pasted = await dashboardOf(SHOP, 'ecommerce', `/connections/${id}`, { value: tokens[id]?.server });
		expect(pasted).toMatchObject({ status: 'connected' });
	}
	expect((await write('PUT', '/v1/format', { wholeUnits: true })).format).toMatchObject({ wholeUnits: true });
	await configure({
		'catalog.currency': 'GBP',
		'checkout.numberPattern': '{prefix}{year}-{number}',
		'checkout.numberPrefix': 'SO-',
		'checkout.numberDigits': 4,
		'checkout.paymentMethods': ['online', 'bank_transfer', 'pickup'],
		'checkout.paymentWindowMinutes': 0,
		'checkout.confirmationHours': 0,
		'checkout.guests': 'unless_password',
		'checkout.defaultCallingCode': '+44',
		'checkout.trunkPrefix': '0',
		'checkout.statusTemplates': 'per_status',
		'checkout.orderUrl': `${ORIGIN}/orders/{number}`,
		'staff_alerts.recipients': [TEAM],
		'staff_alerts.staffPermission': 'orders.read',
		'staff_alerts.events': ['placed', 'paid', 'cancelled', 'proof_uploaded', 'return_requested'],
		'loyalty.earnPercent': 10,
		'loyalty.pointValue': 100,
		'loyalty.roles': ['member'],
		'loyalty.guests': 'earn',
		'loyalty.earnBase': 'total',
		'loyalty.earnAt': 'placement',
		'loyalty.redeemMode': 'maximum',
		'loyalty.expiryUnit': 'months',
		'loyalty.expiryDays': 12,
		'list.order_flow': FLOW,
		'list.delivery_zones': [
			{ key: 'london', name: 'London', match: { cities: ['London'] }, fee: DELIVERY, freeOver: 0, minDays: 1, maxDays: 2 },
		],
		'list.grades': [
			{ key: 'a-plus', label: 'A+', condition: 'refurbished', warrantyDays: 90 },
			{ key: 'b', label: 'B', condition: 'used', warrantyDays: 30 },
		],
	});

	// the catalog: a graded phone and a case
	ids.phone = await write('POST', '/v1/products', {
		name: 'Pixel 8 Pro',
		slug: 'pixel-8-pro',
		status: 'active',
		options: [{ name: 'Storage', values: ['128 GB'] }],
		variants: [
			{ options: { Storage: '128 GB' }, price: PHONE_PRICE, stock: 20, grade: 'a-plus' },
			{ options: { Storage: '128 GB' }, price: 3_999_900, stock: 20, grade: 'b' },
		],
	});
	ids.case = await write('POST', '/v1/products', {
		name: 'Phone case',
		status: 'active',
		price: CASE_PRICE,
		sku: 'CASE-1',
		stock: 50,
	});

	// the shoppers: Sara (a customer) and Mona (a member)
	ids.sara = await accountsUser({ name: 'Sara Shopper', email: 'sara@example.com', phone: '+447700900111' });
	ids.mona = await accountsUser({ name: 'Mona Member', email: 'mona@example.com', phone: '+447700900222', role: 'member' });
});
afterAll(async () => {
	await sys?.stop();
});

describe('Ecommerce orders on the real Portal, Accounts, Payments and Notifications', () => {
	it('numbers orders SO-YYYY-NNNN in the business year and continues from the counter: SO-2026-0043 (E30)', async () => {
		const sara = await signIn('07700900111');
		const first = await place({ lines: [caseLine()], payment: 'cod' }, sara);
		expect(first.status, JSON.stringify(first.json)).toBe(201);
		expect(first.json.order.number).toBe('SO-2026-0001');
		ids.first = first.json.order;

		// the counter never goes back to a number already used
		const used = await server('POST', '/v1/orders/counter', { year: 2026, next: 1 });
		expect([used.status, codeOf(used)]).toEqual([422, 'validation_failed']);
		const set = await server('POST', '/v1/orders/counter', { year: 2026, next: 43 });
		expect(set.json).toEqual({ prefix: 'SO-', year: 2026, next: 43 });
		const next = await place({ lines: [caseLine(2)], payment: 'cod' }, sara);
		expect(next.json.order).toMatchObject({ number: 'SO-2026-0043', status: 'awaiting_confirmation' });
		ids.order43 = next.json.order;
		// the server token reads it by number in the list
		const listed = await server('GET', '/v1/orders?q=SO-2026-0043');
		expect(listed.json.items.map((/** @type {any} */ o) => o.number)).toContain('SO-2026-0043');
	});

	it('messages the shopper per status, alerts the staff and records events through the real Notifications (E32)', async () => {
		// placing SO-2026-0043 told Sara and the staff: the listed recipient and the Accounts manager with orders.read
		const placed = mails.find((mail) => mail.subject === 'Order SO-2026-0043 placed');
		expect(placed).toMatchObject({ to: ['sara@example.com'] });
		expect(placed.text).toContain('Hi Sara, order SO-2026-0043');
		expect(placed.text).toContain(`${ORIGIN}/orders/SO-2026-0043`);
		for (const to of [TEAM, MANAGER]) {
			const alert = mails.find((mail) => mail.subject === 'New order SO-2026-0043' && mail.to.includes(to));
			expect(alert?.text, to).toContain('Sara Shopper placed SO-2026-0043');
		}

		// a move into a status sends that status's own template (statusTemplates: per_status)
		const before = mails.length;
		const confirmed = await move(ids.order43.id, 'confirmed');
		expect(confirmed.json.history.at(-1)).toMatchObject({ to: 'confirmed', by: 'Alex Morgan' });
		expect(mailsTo(before, 'sara@example.com').map((mail) => mail.subject)).toEqual(['Order SO-2026-0043: Confirmed']);

		// the shopper cancels SO-2026-0001: the cancel's reason reaches the message, the staff alert and the event
		const sara = await signIn('07700900111');
		const cancelled = await shopper('POST', `/v1/shop/orders/${ids.first.id}/cancel`, { signIn: sara });
		expect(cancelled.json.order.status).toBe('cancelled');
		const told = mailsTo(before, 'sara@example.com').find((mail) => mail.subject === 'Order SO-2026-0001: Canceled');
		// the reason in words from the website's texts, not the code (K-10)
		expect(told?.text).toBe('Order SO-2026-0001 is Canceled (Canceled at your request).');
		expect(mailsTo(before, TEAM).map((mail) => mail.subject)).toContain('Canceled: SO-2026-0001');

		const events = await eventsOf('ecommerce.order.placed,ecommerce.order.status_changed,ecommerce.order.cancelled');
		const of43 = events.filter((/** @type {any} */ e) => e.data.number === 'SO-2026-0043');
		expect(of43.map((/** @type {any} */ e) => e.type).sort()).toEqual([
			'ecommerce.order.placed',
			'ecommerce.order.status_changed',
		]);
		expect(of43.find((/** @type {any} */ e) => e.type === 'ecommerce.order.status_changed').data).toMatchObject({
			from: 'awaiting_confirmation',
			to: 'confirmed',
			by: 'Alex Morgan',
			paymentMethod: 'cod',
		});
		const cancel = events.find((/** @type {any} */ e) => e.type === 'ecommerce.order.cancelled');
		expect(cancel.data).toMatchObject({ number: 'SO-2026-0001', reason: 'shopper' });
		// events carry ids and small facts, never the address
		expect(JSON.stringify(events)).not.toContain(ADDRESS.line1);
	});

	it('takes a guest’s order with an order key and page by number; the member’s sign-in claims it and its points (E21)', async () => {
		const guest = { name: 'Gina Guest', phone: '07700 900333', email: 'gina@example.com' };
		const placed = await place({
			lines: [caseLine()],
			payment: 'cod',
			address: { ...ADDRESS, name: 'Gina Guest' },
			customer: guest,
		});
		expect(placed.status, JSON.stringify(placed.json)).toBe(201);
		const { order, orderKey } = placed.json;
		expect(orderKey).toMatch(/^[A-Za-z0-9_-]{32}$/);
		expect(order.guest).toBe(true);
		ids.guestOrder = order;
		const record = await orderOf(order.id);
		expect(record.customer).toMatchObject({ userId: '', phone: '+447700900333' });
		// guests earn on their phone (loyalty guests: earn, fixed at placement)
		expect(record.promotions.pointsEarned).toBeGreaterThan(0);

		// the guest reads the order with its key only, by id and by number (the order page)
		expect(codeOf(await shopper('GET', `/v1/shop/orders/${order.id}`))).toBe('sign_in_required');
		expect((await shopper('GET', `/v1/shop/orders/${order.id}`, { orderKey })).json.number).toBe(order.number);
		const page = await shopper('GET', `/v1/shop/orders/by-number/${order.number}`, { orderKey });
		expect(page.json).toMatchObject({ id: order.id, guest: true, payment: { method: 'cod' } });
		const wrong = await shopper('GET', `/v1/shop/orders/by-number/${order.number}`, { orderKey: 'x'.repeat(32) });
		expect(wrong.status).toBe(404);
		// the guest is told through Notifications too
		expect(mails.find((mail) => mail.subject === `Order ${order.number} placed`)).toMatchObject({ to: ['gina@example.com'] });

		// Gina gets an account with that phone (verified by staff); her sign-in claims the guest's order and points
		const gina = await accountsUser({ name: 'Gina Guest', email: 'gina@example.com', phone: '+447700900333' });
		const token = await signIn('07700900333');
		const mine = await shopper('GET', '/v1/shop/orders', { signIn: token });
		expect(mine.json.items.map((/** @type {any} */ o) => o.number)).toEqual([order.number]);
		expect((await orderOf(order.id)).customer.userId).toBe(gina.id);
		const loyalty = await shopper('GET', '/v1/shop/loyalty', { signIn: token });
		expect(loyalty.json).toMatchObject({ balance: 0, pending: record.promotions.pointsEarned });
		// and her own order page by number now opens with the sign-in
		expect((await shopper('GET', `/v1/shop/orders/by-number/${order.number}`, { signIn: token })).json.guest).toBe(false);
	});

	it('sends a guest whose phone has an Accounts password to sign in (E21 guests: unless_password)', async () => {
		// Mona's phone belongs to an Accounts user with a password (asked through the pasted Accounts token)
		const member = await place({ lines: [caseLine()], payment: 'cod', customer: { name: 'Mona', phone: '07700 900222' } });
		expect([codeOf(member), member.json.signIn], JSON.stringify(member.json)).toEqual(['sign_in_required', 'member_phone']);
	});

	it('prices a member’s cart with deal rules, the role price, the COD fee and whole units by both totals rules, kept by a lock (E18, E19, E23, E25, D4)', async () => {
		await configure({
			'deals.lockMinutes': 30,
			'cod.feePercent': 2,
			// cash-on-delivery orders start confirmed (the flow's starts)
			'list.order_flow': { ...FLOW, starts: { cod: 'confirmed' } },
			'list.role_prices': [{ role: 'member', percent: 7, label: 'Member price' }],
		});
		const deal = await write('POST', '/v1/deals', {
			name: 'Spring sale',
			slug: 'spring-sale',
			type: 'percent',
			value: 15,
			badgeLabel: 'Spring',
			discountLabel: '15% off A+',
			color: '#0a7d3b',
			scope: { productIds: [ids.phone.id], categoryIds: [], brandIds: [] },
			conditions: {
				match: 'all',
				rules: [{ field: 'grades', op: 'in', values: ['a-plus'] }],
				groups: [],
				paymentMethods: ['cod'],
				minQuantity: 1,
				cartTotal: 0,
			},
		});
		ids.deal = deal;
		// the deal page by slug, with its display fields
		const shown = await shopper('GET', '/v1/shop/deals/spring-sale');
		expect(shown.json).toMatchObject({ id: deal.id, badgeLabel: 'Spring', discountLabel: '15% off A+', color: '#0a7d3b' });

		const [aPlus, gradeB] = ids.phone.variants;
		const mona = await signIn('07700900222');
		const line = { productId: ids.phone.id, variantId: aPlus.id, quantity: 1 };
		const priced = await quote({ lines: [line], payment: 'cod' }, mona);
		expect(priced.status, JSON.stringify(priced.json)).toBe(200);
		// 15% of GBP 49,999 is 7,499.85: deal discounts round down to whole pounds (E25)
		// the member's 7% comes off what is left (GBP 42,500 → 2,975), before delivery (E19)
		// the 2% cash handling of GBP 39,775 is 795.50: fees round half up (E23, E25)
		expect(priced.json.totals).toMatchObject({
			subtotal: PHONE_PRICE,
			discount: 749_900 + 297_500,
			roleDiscount: 297_500,
			delivery: DELIVERY,
			fee: 79_600,
			total: 3_977_500 + 79_600,
		});
		expect(priced.json.role).toMatchObject({ key: 'member', percent: 7, label: 'Member price' });
		expect(priced.json.lines[0].deal).toMatchObject({ id: deal.id, badgeLabel: 'Spring' });
		// loyalty: members take part and earn 10% of the whole total (earnBase: total)
		expect(priced.json.pointsToEarn).toBe(4057);
		const lock = priced.json.lines[0].lock;
		expect(typeof lock).toBe('string');

		// the conditions: not for another grade, nor for another payment method; no role price for a customer
		expect((await quote({ lines: [{ ...line, variantId: gradeB.id }], payment: 'cod' }, mona)).json.totals.discount).toBe(
			roleOf(3_999_900),
		);
		expect((await quote({ lines: [line], payment: 'bank_transfer' }, mona)).json.totals.discount).toBe(roleOf(PHONE_PRICE));
		const sara = await signIn('07700900111');
		const customer = (await quote({ lines: [line], payment: 'cod' }, sara)).json;
		expect(customer.totals).toMatchObject({ roleDiscount: 0, discount: 749_900 });
		expect(customer.pointsToEarn).toBe(0);

		// the other totals rules (D4): the deal worked out on the line and rounded once, half up (7,499.85 → 7,500), the
		// member's 7% of GBP 42,499 (2,975), and the 2% cash handling on the goods after both (GBP 39,524 → 790)
		await configure({ 'deals.rounding': 'total_half_up', 'cod.feeBase': 'goods_after_discounts' });
		const other = await quote({ lines: [line], payment: 'cod' }, mona);
		expect(other.json.totals).toMatchObject({
			subtotal: PHONE_PRICE,
			discount: 750_000 + 297_500,
			roleDiscount: 297_500,
			delivery: DELIVERY,
			fee: 79_000,
			total: 3_952_400 + DELIVERY + 79_000,
		});
		expect(other.json.paymentMethods.find((/** @type {any} */ method) => method.method === 'cod')).toMatchObject({
			fee: 79_000,
		});
		await configure({ 'deals.rounding': 'per_unit_down', 'cod.feeBase': 'order_total' });

		// the deal ends; the signed lock keeps its price at placement
		await write('PATCH', `/v1/deals/${deal.id}`, { active: false });
		expect((await quote({ lines: [line], payment: 'cod' }, mona)).json.totals.discount).toBe(roleOf(PHONE_PRICE));
		const placed = await place({ lines: [{ ...line, lock }], payment: 'cod' }, mona);
		expect(placed.status, JSON.stringify(placed.json)).toBe(201);
		expect(placed.json.order).toMatchObject({
			status: 'confirmed',
			role: 'open',
			totals: { discount: 749_900 + 297_500, roleDiscount: 297_500, fee: 79_600, total: 4_057_100 },
			promotions: { role: { label: 'Member price', percent: 7 } },
		});
		ids.monaOrder = placed.json.order;
		// a lock ends with its minutes
		sys.clock.advance(31 * 60_000);
		const late = await quote({ lines: [{ ...line, lock }], payment: 'cod' }, await signIn('07700900222'));
		expect(late.json.totals.discount).toBe(roleOf(PHONE_PRICE));
		await configure({ 'cod.feePercent': 0, 'list.order_flow': FLOW });
	});

	it('prints invoices with the fee, the role price, points and cash due, packing slips and a pick list (E35)', async () => {
		const detail = await orderOf(ids.monaOrder.id);
		const invoice = await server('GET', `/v1/orders/${ids.monaOrder.id}/invoice`);
		expect(invoice.status).toBe(200);
		const html = String(invoice.json);
		for (const text of [
			ids.monaOrder.number,
			'Member price',
			'Cash handling',
			'Cash due on delivery',
			'Grade: A+',
			detail.totalText,
		])
			expect(html, text).toContain(text);
		const mona = await signIn('07700900222');
		const own = await shopper('GET', `/v1/shop/orders/${ids.monaOrder.id}/invoice`, { signIn: mona });
		expect(own.status).toBe(200);
		expect(String(own.json)).toContain('Member price');
		const slips = await server('GET', `/v1/orders/packing-slips?ids=${ids.monaOrder.id},${ids.order43.id}`);
		expect(String(slips.json).match(/<section class="sheet">/g)).toHaveLength(2);
		const picks = await server('GET', `/v1/orders/pick-list?ids=${ids.monaOrder.id},${ids.order43.id}`);
		expect(String(picks.json)).toContain('<h1>Pick list</h1>');
		expect(String(picks.json)).toContain('SO-2026-0043');
	});

	it('the loyalty options: points fixed at placement are credited on delivery and one switch redeems the most (E20)', async () => {
		let mona = await signIn('07700900222');
		const before = await shopper('GET', '/v1/shop/loyalty?limit=5', { signIn: mona });
		expect(before.json).toMatchObject({ balance: 0, pending: 4057, lifetimeEarned: 0 });
		const delivered = await move(ids.monaOrder.id, 'delivered');
		// cash on delivery is paid on delivery (paidOnDelivery), an entry of the payments log
		expect(delivered.json.payment).toMatchObject({ state: 'paid', paid: 4_057_100 });
		mona = await signIn('07700900222');
		const after = await shopper('GET', '/v1/shop/loyalty?limit=5', { signIn: mona });
		expect(after.json).toMatchObject({ balance: 4057, pending: 0, lifetimeEarned: 4057 });
		expect(after.json.history[0]).toMatchObject({ points: 4057 });
		// redeemMode: maximum — asking for one point redeems the most allowed
		const priced = await quote({ lines: [caseLine(10)], payment: 'bank_transfer', points: 1 }, mona);
		expect(priced.json.points.used).toBeGreaterThan(1);
		expect(priced.json.points.used).toBe(priced.json.points.max);
		expect(priced.json.points.value).toBe(priced.json.points.used * 100);
	});

	it('takes a bank transfer through the real Payments: bank details, its page, and paid once Payments confirms (E24)', async () => {
		const sara = await signIn('07700900111');
		const priced = await quote({ lines: [caseLine()], payment: 'bank_transfer' }, sara);
		// exactly Payments' answer: every field, '' for those the merchant did not set
		expect(priced.json.bankDetails).toEqual({
			ready: true,
			accountHolder: 'Example Shop Ltd',
			bankName: 'Example Bank',
			accountNumber: '31926819',
			routingNumber: '',
			sortCode: '',
			branchCode: '',
			iban: 'GB29NWBK60161331926819',
			bic: '',
			instructions: 'Write your order number as the reference.',
		});
		// the cart widget sends its return address (Payments sends the shopper back there)
		const placed = await place({ lines: [caseLine()], payment: 'bank_transfer', returnUrl: `${ORIGIN}/checkout` }, sara);
		expect(placed.status, JSON.stringify(placed.json)).toBe(201);
		const { order, next } = placed.json;
		expect(order).toMatchObject({ status: 'pending_payment', payment: { state: 'pending', via: 'payments' } });
		expect(order.bankDetails).toMatchObject({ bankName: 'Example Bank' });
		expect(next.kind).toBe('pay');
		expect(new URL(next.url).origin).toBe(PAYMENTS);
		const { paymentId } = (await orderOf(order.id)).payment;
		const payments = (/** @type {string} */ method, /** @type {string} */ path, /** @type {unknown} */ body = undefined) =>
			sys.call(method, path, { base: PAYMENTS, token: tokens.payments?.server, ...(body === undefined ? {} : { body }) });
		expect((await payments('GET', `/v1/payments/${paymentId}`)).json).toMatchObject({
			gateway: 'bank_transfer',
			amount: order.totals.total,
			currency: 'GBP',
			reference: order.number,
		});
		// the store's staff confirm the transfer in Payments; Ecommerce asks Payments again when the order is read
		const confirmed = await payments('POST', `/v1/payments/${paymentId}/confirm`, { reference: 'TRX-7', note: 'Seen' });
		expect(confirmed.json.status).toBe('paid');
		sys.clock.advance(31_000);
		const read = await shopper('GET', `/v1/shop/orders/${order.id}`, { signIn: sara });
		expect(read.json).toMatchObject({
			status: 'confirmed',
			payment: { state: 'paid', paid: order.totals.total, balanceDue: 0 },
		});
		expect(read.json.payment.entries).toEqual([
			{ method: 'online', amount: order.totals.total, reference: paymentId, at: expect.any(String) },
		]);
		const paid = (await eventsOf('ecommerce.order.paid')).find((/** @type {any} */ e) => e.data.orderId === order.id);
		expect(paid.data).toMatchObject({ number: order.number, paid: order.totals.total });
		expect(mails.find((mail) => mail.subject === `Paid: ${order.number}`)).toBeTruthy();
	});

	it('cancels the Payments payment with its order; a transfer confirmed after shows a refund due, refunded through Payments (K-13)', async () => {
		const sara = await signIn('07700900111');
		const placed = await place({ lines: [caseLine()], payment: 'bank_transfer' }, sara);
		expect(placed.status, JSON.stringify(placed.json)).toBe(201);
		const { order } = placed.json;
		const total = order.totals.total;
		const { paymentId } = (await orderOf(order.id)).payment;
		const payments = (/** @type {string} */ method, /** @type {string} */ path, /** @type {unknown} */ body = undefined) =>
			sys.call(method, path, { base: PAYMENTS, token: tokens.payments?.server, ...(body === undefined ? {} : { body }) });
		const cancelled = await shopper('POST', `/v1/shop/orders/${order.id}/cancel`, { signIn: sara });
		expect(cancelled.json.order.status).toBe('cancelled');
		expect((await payments('GET', `/v1/payments/${paymentId}`)).json).toMatchObject({ status: 'voided', refundDue: false });
		// the money arrives anyway and the store's staff confirm it in Payments: it is to be refunded
		const late = await payments('POST', `/v1/payments/${paymentId}/confirm`, { reference: 'TRX-9', note: 'Late' });
		expect(late.json).toMatchObject({ status: 'paid', refundDue: true });
		await dashboardOf(PAYMENTS, 'payments', '/features', { on: ['payment_api', 'bank_transfer', 'refunds'] });
		sys.clock.advance(31_000);
		const read = await orderOf(order.id);
		expect(read).toMatchObject({ status: 'cancelled', payment: { paid: total, refundDue: total } });
		// refunded the normal way: Payments records a bank transfer's refund, the shop returns the money by hand
		const refunded = await server(
			'POST',
			`/v1/orders/${order.id}/refunds`,
			{ amount: total, reason: 'Order was canceled' },
			{ staff: 'Alex Morgan', key: `k13-${order.id}` },
		);
		expect(refunded.status, JSON.stringify(refunded.json)).toBe(201);
		expect(refunded.json.refund).toMatchObject({ online: total, recorded: true });
		expect(refunded.json.warnings[0]).toContain('by hand');
		expect(refunded.json.order.payment).toMatchObject({ refundDue: 0, state: 'refunded' });
		expect(refunded.json.order.refunds[0]).toMatchObject({ method: 'bank_transfer', manual: true });
		expect((await payments('GET', `/v1/payments/${paymentId}`)).json).toMatchObject({ status: 'refunded', refundDue: false });
	});

	it('takes a manual bank transfer with the shopper’s proof, and the payments log records staff payments and refunds (E24, E26)', async () => {
		await configure({
			'checkout.bankTransferVia': 'manual',
			// refunds that cover the payments move the order to refunded (the flow's trigger)
			'list.order_flow': { ...FLOW, triggers: { refundsCover: 'refunded' } },
		});
		let sara = await signIn('07700900111');
		const placed = await place({ lines: [caseLine(2)], payment: 'bank_transfer' }, sara);
		expect(placed.status, JSON.stringify(placed.json)).toBe(201);
		const { order, next } = placed.json;
		const total = order.totals.total;
		expect(order).toMatchObject({ status: 'pending_payment', canSendProof: true, payment: { via: 'manual', state: 'unpaid' } });
		expect(order.bankDetails).toMatchObject({ accountNumber: '31926819' });
		expect(next.kind).toBe('proof');
		expect((await orderOf(order.id)).payment.paymentId).toBeNull();

		// the shopper uploads the proof (a presigned upload to the merchant's bucket) and sends it with a reference
		const upload = await shopper('POST', `/v1/shop/orders/${order.id}/proof/upload`, {
			signIn: sara,
			body: { type: 'image/png', size: 1000 },
		});
		expect(upload.status, JSON.stringify(upload.json)).toBe(201);
		expect(new URL(upload.json.upload.url).origin).toBe(BUCKET);
		const before = mails.length;
		const sent = await shopper('POST', `/v1/shop/orders/${order.id}/proof`, {
			signIn: sara,
			body: { key: upload.json.key, reference: 'TRX-42' },
		});
		expect(sent.json.order.payment.proof).toMatchObject({ reference: 'TRX-42' });
		expect(mailsTo(before, TEAM).find((mail) => mail.subject === `Transfer proof: ${order.number}`)?.text).toContain('TRX-42');
		const proofEvent = (await eventsOf('ecommerce.order.proof_uploaded')).find(
			(/** @type {any} */ e) => e.data.orderId === order.id,
		);
		expect(proofEvent.data.reference).toBe('TRX-42');

		// staff record part by transfer, then the rest in cash, confirming the order in the same call
		const half = Math.floor(total / 200) * 100;
		const first = await server(
			'POST',
			`/v1/orders/${order.id}/payments`,
			{ method: 'bank_transfer', amount: half, reference: 'TRX-42' },
			{ staff: 'Omar Staff', key: 'pay-manual-1' },
		);
		expect(first.status, JSON.stringify(first.json)).toBe(201);
		expect(first.json.order.payment).toMatchObject({ paid: half, state: 'unpaid' });
		const tooMuch = await server(
			'POST',
			`/v1/orders/${order.id}/payments`,
			{ method: 'cash', amount: total },
			{ key: 'pay-manual-x' },
		);
		expect(codeOf(tooMuch)).toBe('validation_failed');
		const rest = await server(
			'POST',
			`/v1/orders/${order.id}/payments`,
			{ method: 'cash', amount: total - half, confirm: true },
			{ staff: 'Omar Staff', key: 'pay-manual-2' },
		);
		expect(rest.json.order).toMatchObject({ status: 'confirmed', payment: { state: 'paid', paid: total } });
		expect(rest.json.order.payments.map((/** @type {any} */ e) => [e.method, e.amount, e.reference, e.by.name])).toEqual([
			['bank_transfer', half, 'TRX-42', 'Omar Staff'],
			['cash', total - half, '', 'Omar Staff'],
		]);
		// the shopper sees paid, the balance and the entries, never the staff's names
		sara = await signIn('07700900111');
		const mine = await shopper('GET', `/v1/shop/orders/${order.id}`, { signIn: sara });
		expect(mine.json.payment).toMatchObject({ paid: total, balanceDue: 0 });
		expect(mine.json.payment.entries.map((/** @type {any} */ e) => [e.method, e.amount])).toEqual([
			['bank_transfer', half],
			['cash', total - half],
		]);
		expect(JSON.stringify(mine.json)).not.toContain('Omar Staff');
		const recorded = (await eventsOf('ecommerce.order.payment_recorded')).filter(
			(/** @type {any} */ e) => e.data.orderId === order.id,
		);
		expect(recorded.map((/** @type {any} */ e) => e.data.method).sort()).toEqual(['bank_transfer', 'cash']);

		// refunds with a method and reference; once they cover the payments the order is refunded (the refundsCover trigger)
		const part = await server(
			'POST',
			`/v1/orders/${order.id}/refunds`,
			{ amount: half, reason: 'One case returned', method: 'bank_transfer', reference: 'RF-1' },
			{ staff: 'Omar Staff', key: 'refund-manual-1' },
		);
		expect(part.status, JSON.stringify(part.json)).toBe(201);
		expect(part.json.order.status).toBe('confirmed');
		const all = await server(
			'POST',
			`/v1/orders/${order.id}/refunds`,
			{ amount: total - half, reason: 'Both returned', method: 'cash', reference: 'RF-2' },
			{ staff: 'Omar Staff', key: 'refund-manual-2' },
		);
		expect(all.json.order).toMatchObject({ status: 'refunded', payment: { state: 'refunded', refunded: total } });
		expect(all.json.order.refunds.map((/** @type {any} */ e) => [e.method, e.amount, e.reference])).toEqual([
			['bank_transfer', half, 'RF-1'],
			['cash', total - half, 'RF-2'],
		]);
		const refunded = (await eventsOf('ecommerce.order.refunded')).filter((/** @type {any} */ e) => e.data.orderId === order.id);
		expect(refunded).toHaveLength(2);
		await configure({ 'checkout.bankTransferVia': 'payments', 'list.order_flow': FLOW });
	});

	it('moves to refunded before dispatch as a cancel, giving the stock back; unpaid with no money (E27)', async () => {
		const sara = await signIn('07700900111');
		const stock = await stockOf(ids.case.id);
		// nothing paid: it is canceled with no money (the default of the move's unpaid option)
		const unpaid = (await place({ lines: [caseLine()], payment: 'cod' }, sara)).json.order;
		await move(unpaid.id, 'confirmed');
		const canceled = await move(unpaid.id, 'refunded');
		expect(canceled.json).toMatchObject({ status: 'refunded', payment: { refunded: 0 } });
		expect(canceled.json.refunds).toHaveLength(0);
		expect(await stockOf(ids.case.id)).toBe(stock);

		const paid = (await place({ lines: [caseLine()], payment: 'cod' }, sara)).json.order;
		await server(
			'POST',
			`/v1/orders/${paid.id}/payments`,
			{ method: 'cash', amount: paid.totals.total, confirm: true },
			{ key: 'pay-before-refund' },
		);
		expect(await stockOf(ids.case.id)).toBe(stock - 1);
		const done = await move(paid.id, 'refunded');
		expect(done.json).toMatchObject({
			status: 'refunded',
			payment: { state: 'refunded', refunded: paid.totals.total },
		});
		expect(done.json.refunds).toHaveLength(1);
		// it acts as a cancel: the stock comes back
		expect(await stockOf(ids.case.id)).toBe(stock);
	});

	it('takes a customer return after delivery, restocking or not as the move says (E27)', async () => {
		/** @param {'yes' | 'no'} restock */
		const returned = async (restock) => {
			await configure({
				'list.order_flow': {
					...FLOW,
					moves: FLOW.moves.map((entry) =>
						entry.from === 'delivered' && entry.to === 'customer-returned' ? { ...entry, options: { restock } } : entry,
					),
				},
			});
			const sara = await signIn('07700900111');
			const stock = await stockOf(ids.case.id);
			const order = (await place({ lines: [caseLine()], payment: 'cod' }, sara)).json.order;
			await move(order.id, 'confirmed');
			await move(order.id, 'delivered');
			expect(await stockOf(ids.case.id)).toBe(stock - 1);
			const back = await move(order.id, 'customer-returned');
			expect(back.json).toMatchObject({ status: 'customer-returned', role: 'returned' });
			return { stock, after: await stockOf(ids.case.id), order: back.json };
		};
		const restocked = await returned('yes');
		expect(restocked.after).toBe(restocked.stock);
		const kept = await returned('no');
		expect(kept.after).toBe(kept.stock - 1);
		// a returned order may then be refunded
		expect((await move(kept.order.id, 'refunded')).json.status).toBe('refunded');
		await configure({ 'list.order_flow': FLOW });
	});

	it('handles claims: exchange and fixed reasons, prefixed references, notes, restock per line, refunds by method (E33)', async () => {
		await configure({
			'returns.kinds': ['return', 'warranty', 'exchange'],
			'returns.reasons': ['Faulty', 'Wrong item'],
			'returns.referencePrefix': 'RR-',
		});
		const delivered = async () => {
			const sara = await signIn('07700900111');
			const order = (await place({ lines: [caseLine()], payment: 'cod' }, sara)).json.order;
			await move(order.id, 'confirmed');
			await move(order.id, 'delivered');
			return { order: await orderOf(order.id), sara };
		};
		const { order, sara } = await delivered();
		const lineId = order.lines[0].id;
		/** @param {Record<string, unknown>} body @param {string} token */
		const claim = (body, token) =>
			shopper('POST', '/v1/shop/returns', {
				signIn: token,
				key: `claim-${keys++}`,
				body: { orderId: order.id, kind: 'return', lines: [{ lineId, quantity: 1 }], reason: 'Faulty', ...body },
			});
		expect((await claim({ kind: 'exchange', reason: 'Changed my mind' }, sara)).json.errors[0].path).toBe('/reason');
		const before = mails.length;
		const made = await claim({ kind: 'exchange', reason: 'Faulty' }, sara);
		expect(made.status, JSON.stringify(made.json)).toBe(201);
		expect(made.json).toMatchObject({ kind: 'exchange', reason: 'Faulty', status: 'requested' });
		expect(made.json.reference).toMatch(/^RR-/);
		expect(mailsTo(before, TEAM).find((mail) => mail.subject === `Claim ${made.json.reference}`)?.text).toContain(order.number);
		const requested = (await eventsOf('ecommerce.return.requested')).find(
			(/** @type {any} */ e) => e.data.claimId === made.json.id,
		);
		expect(requested.data).toMatchObject({ kind: 'exchange', number: order.number, reference: made.json.reference });

		const id = made.json.id;
		const noted = await server('POST', `/v1/returns/${id}/notes`, { text: 'Called the shopper' }, { staff: 'Omar Staff' });
		expect(noted.json.notes).toEqual([{ at: expect.any(String), by: 'Omar Staff', text: 'Called the shopper' }]);
		expect((await server('POST', `/v1/returns/${id}/approve`, {})).json.status).toBe('approved');
		const stock = await stockOf(ids.case.id);
		const received = await server('POST', `/v1/returns/${id}/receive`, { lines: [{ lineId, restock: true }] });
		expect(received.json.status, JSON.stringify(received.json)).toBe('received');
		expect(await stockOf(ids.case.id)).toBe(stock + 1);
		const replaced = await server('POST', `/v1/returns/${id}/replace`, { note: 'New case sent' });
		expect(replaced.json).toMatchObject({ status: 'replaced' });
		const theirs = (await shopper('GET', '/v1/shop/returns', { signIn: sara })).json.items.find(
			(/** @type {any} */ c) => c.id === id,
		);
		expect(theirs.status).toBe('replaced');
		expect(JSON.stringify(theirs)).not.toContain('Called the shopper');

		// a return refunded by bank transfer with its reference, written on the order's refunds with the claim
		const other = await delivered();
		const returned = await shopper('POST', '/v1/shop/returns', {
			signIn: other.sara,
			key: `claim-${keys++}`,
			body: {
				orderId: other.order.id,
				kind: 'return',
				lines: [{ lineId: other.order.lines[0].id, quantity: 1 }],
				reason: 'Wrong item',
			},
		});
		expect(returned.status, JSON.stringify(returned.json)).toBe(201);
		await server('POST', `/v1/returns/${returned.json.id}/approve`, {});
		const refund = await server('POST', `/v1/returns/${returned.json.id}/refund`, {
			amount: CASE_PRICE,
			method: 'bank_transfer',
			reference: 'RF-77',
		});
		expect(refund.json, JSON.stringify(refund.json)).toMatchObject({
			status: 'refunded',
			refundAmount: CASE_PRICE,
			refundMethod: 'bank_transfer',
			refundReference: 'RF-77',
		});
		const stored = await orderOf(other.order.id);
		expect(stored.refunds.map((/** @type {any} */ r) => [r.method, r.amount, r.reference, r.claimId])).toEqual([
			['bank_transfer', CASE_PRICE, 'RF-77', returned.json.id],
		]);
	});

	it('sends a back-in-stock alert through the real Notifications with its stop link, which stops it (MS-2, EN-1)', async () => {
		const charger = await write('POST', '/v1/products', {
			name: 'Fast charger',
			status: 'active',
			price: 250_000,
			sku: 'CHG-1',
			stock: 0,
		});
		const sara = await signIn('07700900111');
		const set = await shopper('POST', '/v1/shop/alerts', {
			body: { kind: 'back_in_stock', productId: charger.id },
			signIn: sara,
			key: 'alert-charger',
		});
		expect(set.status, JSON.stringify(set.json)).toBe(201);
		const before = mails.length;
		const restocked = await server('POST', `/v1/products/${charger.id}/stock`, {
			changes: [{ variantId: charger.variants[0].id, set: 5 }],
		});
		expect(restocked.status, JSON.stringify(restocked.json)).toBe(200);
		const told = mailsTo(before, 'sara@example.com').find((mail) => mail.subject === 'Back in stock: Fast charger');
		expect(told?.text).toContain('Fast charger is back for');
		const link = /Stop these alerts: (\S+)$/.exec(String(told?.text))?.[1] ?? '';
		expect(link).toMatch(new RegExp(`^${ORIGIN}/alerts/unsubscribe/[A-Za-z0-9]{32}$`));
		// the alert was sent, not refused for a reserved value
		const mine = await shopper('GET', '/v1/shop/alerts', { signIn: sara });
		expect(mine.json.items.find((/** @type {any} */ a) => a.productId === charger.id)?.status).toBe('sent');
		// the stop page's widget stops every alert of that address
		const stopped = await shopper('POST', `/v1/shop/alerts/unsubscribe/${link.split('/').pop()}`);
		expect(stopped.json).toEqual({ removed: 1 });
	});

	it('reports the summary by business day in the business time zone, as the order list adds up (E36)', async () => {
		const summary = await server('GET', '/v1/reports/summary?from=2026-10-01&to=2026-10-01&series=day');
		expect(summary.status, JSON.stringify(summary.json)).toBe(200);
		// business.json's Europe/London (summer time in October): the day starts at 23:00 UTC the day before
		expect(summary.json).toMatchObject({
			from: '2026-09-30T23:00:00.000Z',
			to: '2026-10-01T23:00:00.000Z',
			currency: 'GBP',
			statuses: null,
		});
		const orders = (await server('GET', '/v1/orders?limit=100')).json.items;
		const counted = orders.filter((/** @type {any} */ o) => o.role !== 'cancelled');
		const total = counted.reduce((/** @type {number} */ sum, /** @type {any} */ o) => sum + o.total, 0);
		const units = counted.reduce((/** @type {number} */ sum, /** @type {any} */ o) => sum + o.itemCount, 0);
		expect(summary.json).toMatchObject({ orders: counted.length, total, units });
		expect(summary.json.fees).toBe(79_600);
		expect(summary.json.days).toEqual([{ day: '2026-10-01', orders: counted.length, total }]);
		// statuses decide what counts as revenue
		const refunded = orders.filter((/** @type {any} */ o) => o.status === 'refunded');
		const only = await server('GET', '/v1/reports/summary?from=2026-10-01&to=2026-10-01&statuses=refunded');
		expect(only.json).toMatchObject({ statuses: ['refunded'], orders: refunded.length });
		const file = await server('GET', '/v1/reports/summary?from=2026-10-01&to=2026-10-01&format=csv');
		expect(file.headers.get('content-type')).toBe('text/csv; charset=utf-8');
		expect(String(file.json).split('\r\n')[1]).toMatch(new RegExp(`^2026-10-01,${counted.length},`));
	});

	it('asks the shop’s order fields at checkout, needs a stage’s field before packing, and keeps a dual-SIM phone’s IMEIs as its own unit field of its item type (dynamic model §1–§2)', async () => {
		const gift = await write('POST', '/v1/attributes', {
			name: 'Gift message',
			on: 'order',
			required: true,
			requiredAt: 'checkout',
			show: { shopper: true, invoice: true },
		});
		const box = await write('POST', '/v1/attributes', {
			name: 'Box',
			on: 'order',
			type: 'choice',
			choices: ['S', 'M'],
			required: true,
			requiredAt: 'packed',
			show: { packingSlip: true },
		});
		// the IMEI is this shop's own unit field: 15 digits with a Luhn check digit, two per dual-SIM phone
		const imei = await write('POST', '/v1/attributes', {
			name: 'IMEI',
			on: 'unit',
			multiple: true,
			required: true,
			format: { chars: 'digits', minLength: 15, maxLength: 15, checkDigit: 'luhn', ignoreSpaces: true },
			show: { shopper: true, invoice: true },
		});
		// the shop's phones: an item type whose units are numbered by the IMEI, typed at packing, needed before dispatch
		await configure({
			'list.item_types': [
				{
					key: 'phone',
					name: 'Phone',
					kind: 'physical',
					elements: { units: { fieldIds: [imei.id], capture: 'packing', requiredBefore: 'shipped' } },
				},
			],
		});
		const dual = await write('POST', '/v1/products', {
			name: 'Dual-SIM phone',
			status: 'active',
			price: PHONE_PRICE,
			stock: 3,
			typeKey: 'phone',
		});
		const sara = await signIn('07700900111');
		const lines = [{ productId: dual.id, quantity: 1 }];
		const priced = await quote({ lines, payment: 'cod' }, sara);
		expect(priced.json.fields.map((/** @type {any} */ field) => [field.name, field.required])).toEqual([
			['Gift message', true],
		]);
		const refused = await place({ lines, payment: 'cod' }, sara);
		expect(refused.status).toBe(422);
		expect(refused.json.errors[0].path).toBe(`/fields/${gift.id}`);
		const placed = await place({ lines, payment: 'cod', fields: { [gift.id]: 'Happy birthday' } }, sara);
		expect(placed.status, JSON.stringify(placed.json)).toBe(201);
		const order = placed.json.order;
		const lineId = order.lines[0].id;
		expect((await move(order.id, 'confirmed')).status).toBe(200);
		const early = await move(order.id, 'packed');
		expect(early.status).toBe(422);
		expect(early.json.errors[0].path).toBe(`/fields/${box.id}`);
		await write('PATCH', `/v1/orders/${order.id}`, { fields: { [box.id]: 'M' } });
		expect((await move(order.id, 'packed')).status).toBe(200);
		// typed at packing or later, in the field's format
		const wrong = await server('PATCH', `/v1/orders/${order.id}`, {
			serials: { [lineId]: [{ values: { [imei.id]: ['490154203237519'] } }] },
		});
		expect(wrong.status).toBe(422);
		const typed = await write('PATCH', `/v1/orders/${order.id}`, {
			serials: { [lineId]: [{ values: { [imei.id]: ['4901 5420 3237 518', '356938035643809'] } }] },
		});
		expect(typed.lines[0]).toMatchObject({ unitCapture: 'packing', unitsRequiredBefore: 'shipped' });
		expect(typed.lines[0].units).toEqual([
			{ serial: '490154203237518', values: { [imei.id]: ['490154203237518', '356938035643809'] } },
		]);
		// the shopper sees the gift message and the IMEIs; the box size stays the staff's
		const view = await shopper('GET', `/v1/shop/orders/${order.id}`, { signIn: sara });
		expect(view.json.fields).toEqual([{ name: 'Gift message', value: 'Happy birthday' }]);
		expect(view.json.lines[0].unitValues).toEqual([{ name: 'IMEI', values: ['490154203237518', '356938035643809'] }]);
		const invoice = String((await server('GET', `/v1/orders/${order.id}/invoice`)).json);
		expect(invoice).toContain('Gift message: Happy birthday');
		expect(invoice).toContain('IMEI: 490154203237518, 356938035643809');
		expect(invoice).not.toContain('Box: M');
		expect(String((await server('GET', `/v1/orders/${order.id}/packing-slip`)).json)).toContain('Box: M');
	});
});

/** The member's 7% of a price with no deal, rounded half up to whole pounds. @param {number} price */
function roleOf(price) {
	return Math.round((price * 7) / 100 / 100) * 100;
}
