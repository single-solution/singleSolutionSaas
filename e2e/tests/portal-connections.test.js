/**
 * Settings ownership, steps 6 and 7, against the REAL Portal and real products (Notes, Notifications, Payments,
 * Ecommerce), all in this process.
 *
 * - Step 6: the merchant enters the website's database ONCE in the Portal (Website settings, Data and files); every
 *   product on the website gets its own database on it, with nothing entered in a product; a product added later gets
 *   it too; a new value reaches all of them; the value is never shown again and never logged; a product's dashboard, a
 *   product token or a server token cannot change it.
 * - Step 7: adding Ecommerce and Payments to a website links them without pasting; the link allows only the scopes the
 *   manifests agree on (and only while the feature that needs them is on); a link key calls nothing outside its scope
 *   or another product, a key of one website does nothing on another; a link ends when a product leaves the website.
 */
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	createProductInstance as createEcommerce,
	manifest as shopManifest,
	strings as shopStrings,
} from '@ss/product-ecommerce/product';
import { createRoutes as shopRoutes } from '@ss/product-ecommerce/routes';
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
import { PASSWORD, PRODUCT_URL, codeOf, startSystem } from './helpers.js';

const NOTIFY = 'https://notifications.test';
const PAYMENTS = 'https://payments.test';
const SHOP = 'https://ecommerce.test';
const SITE_A = 'one.example.com';
const SITE_B = 'two.example.com';
const SECRET_HOST = 'cluster-secret-name';
/** The databases the merchant's connection gives each product (derived: nobody names them here). */
const DATABASES = ['ss_notes', 'ss_notifications', 'ss_payments', 'ss_ecommerce'];

/** @param {any} create @param {any} routes @param {any} manifest @param {any} strings @param {string} url */
const unit = (create, routes, manifest, strings, url) => ({
	createProductInstance: create,
	createRoutes: routes,
	manifest,
	strings,
	url,
});

/** @type {import('./helpers.js').System} */
let sys;
/** @type {MongoClient} */
let mongo;
/** @type {Awaited<ReturnType<import('./helpers.js').System['merchant']>>} */
let m;
let siteA = '';
let siteB = '';
/** @type {Record<string, { browser: string, server: string }>} */
const tokensA = {};

beforeAll(async () => {
	mongo = await new MongoClient(/** @type {string} */ (process.env.TEST_MONGODB_URI)).connect();
	for (const name of DATABASES) await mongo.db(name).dropDatabase();
	sys = await startSystem({
		extras: [
			unit(createNotifications, notifyRoutes, notifyManifest, notifyStrings, NOTIFY),
			unit(createPayments, payRoutes, payManifest, payStrings, PAYMENTS),
			unit(createEcommerce, shopRoutes, shopManifest, shopStrings, SHOP),
		],
	});
});
afterAll(async () => {
	await sys?.stop();
	for (const name of DATABASES) await mongo?.db(name).dropDatabase();
	await mongo?.close();
});

/** The merchant's database connection string (the shared test MongoDB), with a marker so the replacement differs. @param {string} [marker] */
const connectionString = (marker = 'first') => {
	const target = new URL(/** @type {string} */ (process.env.TEST_MONGODB_URI));
	target.pathname = '/';
	target.searchParams.set('appName', `${SECRET_HOST}-${marker}`);
	return target.toString();
};

/** The connections page of a website, as the merchant's console reads it. @param {string} websiteId */
const connectionsOf = async (websiteId) =>
	(await m.client.get(`/v1/merchants/${m.merchantId}/websites/${websiteId}/connections`)).json;

/**
 * The merchant enters a connection in the Portal (the password again).
 * @param {string} websiteId @param {'database' | 'storage'} name @param {unknown} value
 */
const enter = (websiteId, name, value) =>
	m.client.put(`/v1/merchants/${m.merchantId}/websites/${websiteId}/connections/${name}`, { value, password: PASSWORD });

/**
 * A dashboard call on a product with an Owner's session.
 * @param {string} websiteId @param {string} base @param {string} productId @param {string} method @param {string} path @param {unknown} [body]
 */
const dashboardOf = async (websiteId, base, productId, method, path, body) =>
	sys.dashboard(
		await sys.adminSession(await sys.owner(), websiteId, productId),
		method,
		`/v1/dashboard/websites/${websiteId}${path}`,
		body,
		base,
	);

/**
 * Use a link key where the scope \`payments.read\` is needed (a payment that does not exist): 404 when the key is allowed in,
 * 403 when the link holds no such scope, 401 when the key is not accepted at all.
 * @param {string} key
 */
const readWith = async (key) => (await sys.call('GET', '/v1/payments/pay_nothing', { base: PAYMENTS, token: key })).status;

/** The link key a product holds for another (what the Portal delivered). @param {'ecommerce'} caller @param {string} websiteId @param {string} to */
const linkKey = async (caller, websiteId, to) =>
	/** @type {string | null} */ (await sys.others[caller].connections.value(websiteId, `link_${to}`));

describe('The database is entered once, in the Portal', () => {
	it('connects four products and gives the merchant a website with Notes and Notifications', async () => {
		await sys.connect();
		for (const base of [NOTIFY, PAYMENTS, SHOP]) await sys.connect({ base });
		m = await sys.merchant('seller@one.test', [SITE_A, SITE_B]);
		siteA = m.websiteIds[0] ?? '';
		siteB = m.websiteIds[1] ?? '';
		await sys.addCredits(m.merchantId, 100);
		for (const id of ['notes', 'notifications']) await sys.addProduct(m.merchantId, siteA, id);
		tokensA.notes = await sys.tokens(m.merchantId, siteA, 'notes');
		expect((await sys.switchFeatures(await sys.adminSession(await sys.owner(), siteA), siteA, ['notes'])).on).toEqual([
			'notes',
		]);
		expect((await dashboardOf(siteA, NOTIFY, 'notifications', 'PUT', '/features', { on: ['email'] })).status).toBe(200);
	});

	it('before it is entered the products say so and show no form of their own; the Portal lists what each will get', async () => {
		const note = await sys.call('POST', '/v1/notes', {
			token: tokensA.notes?.browser,
			origin: `https://${SITE_A}`,
			body: { text: 'Hello' },
		});
		expect([note.status, codeOf(note)]).toEqual([403, 'database_not_connected']);
		expect(note.json.detail).toContain('enter it once in the Portal');
		const view = await connectionsOf(siteA);
		expect(view.database).toMatchObject({ set: false });
		expect(view.products.map((/** @type {any} */ p) => [p.productId, p.database?.name, p.database?.state])).toEqual(
			expect.arrayContaining([
				['notes', 'ss_notes', 'not_set'],
				['notifications', 'ss_notifications', 'not_set'],
			]),
		);
		// the product's own Connections screen has the database as the Portal's: no value, no form, a link to the Portal
		const screen = await dashboardOf(siteA, NOTIFY, 'notifications', 'GET', '/connections');
		const database = screen.json.connections.find((/** @type {{ name: string }} */ each) => each.name === 'database');
		expect(database).toMatchObject({ set: false, managed: true });
		const refused = await dashboardOf(siteA, NOTIFY, 'notifications', 'PUT', '/connections/database', {
			value: connectionString(),
		});
		expect([refused.status, codeOf(refused)]).toEqual([409, 'managed_by_portal']);
	});

	it('the merchant enters it once (a wrong password changes nothing) and Notes and Notifications each work on a database of their own', async () => {
		const wrong = await m.client.put(`/v1/merchants/${m.merchantId}/websites/${siteA}/connections/database`, {
			value: connectionString(),
			password: 'not the password',
		});
		expect(wrong.status).toBeGreaterThanOrEqual(400);
		expect((await connectionsOf(siteA)).database).toMatchObject({ set: false });

		const saved = await enter(siteA, 'database', connectionString());
		expect(saved.status).toBe(200);
		expect(saved.json.database).toMatchObject({ set: true });
		// nothing else was entered: both products took it from the Portal
		const note = await sys.call('POST', '/v1/notes', {
			token: tokensA.notes?.browser,
			origin: `https://${SITE_A}`,
			body: { text: 'Hello' },
		});
		expect(note.status).toBe(201);
		const templates = await sys.call('GET', '/v1/templates', {
			base: NOTIFY,
			token: (await sys.tokens(m.merchantId, siteA, 'notifications')).server,
		});
		expect(templates.status).toBe(200);
		const collections = async (/** @type {string} */ name) =>
			(await mongo.db(name).listCollections().toArray()).map((each) => each.name);
		expect((await collections('ss_notes')).some((name) => name.startsWith('ss_notes_'))).toBe(true);
		expect((await collections('ss_notifications')).some((name) => name.startsWith('ss_notifications_'))).toBe(true);
		// each product's tests of it went back to the Portal
		const view = await connectionsOf(siteA);
		expect(view.products.map((/** @type {any} */ p) => [p.productId, p.database?.state])).toEqual(
			expect.arrayContaining([
				['notes', 'connected'],
				['notifications', 'connected'],
			]),
		);
	});

	it('a product added to the website later gets the same connection with nothing entered again', async () => {
		await sys.addProduct(m.merchantId, siteA, 'payments');
		const payTokens = await sys.tokens(m.merchantId, siteA, 'payments');
		expect((await dashboardOf(siteA, PAYMENTS, 'payments', 'PUT', '/features', { on: ['payment_api'] })).status).toBe(200);
		const list = await sys.call('GET', '/v1/payments', { base: PAYMENTS, token: payTokens.server });
		expect(list.status).toBe(200);
		expect(
			(await mongo.db('ss_payments').listCollections().toArray()).some((each) => each.name.startsWith('ss_payments_')),
		).toBe(true);
		const view = await connectionsOf(siteA);
		expect(view.products.find((/** @type {any} */ p) => p.productId === 'payments').database).toMatchObject({
			name: 'ss_payments',
			state: 'connected',
		});
	});

	it('a new value reaches every product; the value is never shown again and never logged', async () => {
		const replacement = connectionString('second');
		expect((await enter(siteA, 'database', replacement)).status).toBe(200);
		for (const [id, productInstance] of /** @type {const} */ ([
			['notes', sys.product],
			['notifications', sys.others.notifications],
			['payments', sys.others.payments],
		]))
			expect(await productInstance.connections.value(siteA, 'database'), id).toBe(replacement);
		// nothing the Portal or a product answers carries the value or the name inside it
		const everything = JSON.stringify([
			await connectionsOf(siteA),
			(await dashboardOf(siteA, NOTIFY, 'notifications', 'GET', '/connections')).json,
			(await dashboardOf(siteA, PAYMENTS, 'payments', 'GET', '/connections')).json,
			(await dashboardOf(siteA, PRODUCT_URL, 'notes', 'GET', '/connections')).json,
			await sys.activity('website.connection_saved'),
		]);
		expect(everything).not.toContain(SECRET_HOST);
		const saves = await sys.activity('website.connection_saved');
		expect(saves).toHaveLength(2);
		expect(saves[0]?.actor).toMatchObject({ type: 'merchant' });
		expect(saves[0]?.after).toMatchObject({ name: 'database', replaced: true });
	});

	it('a product dashboard, a server token or a product token cannot change the connection', async () => {
		const notifyServer = (await sys.tokens(m.merchantId, siteA, 'notifications')).server;
		// the server token alone is not a person: no configuration, and nothing about the Portal's connection
		for (const [method, path, body] of /** @type {const} */ ([
			['PUT', '/v1/connections/database', { value: 'mongodb://attacker.example.com/db' }],
			['DELETE', '/v1/connections/database', undefined],
		])) {
			const answer = await sys.call(method, path, {
				base: NOTIFY,
				token: notifyServer,
				bare: true,
				...(body ? { body } : {}),
			});
			expect(answer.status, `${method} ${path}`).toBeGreaterThanOrEqual(400);
		}
		// a signed-in Owner of the product cannot either: the database is the Portal's
		const owned = await dashboardOf(siteA, NOTIFY, 'notifications', 'DELETE', '/connections/database');
		expect([owned.status, codeOf(owned)]).toEqual([409, 'managed_by_portal']);
		// no route of the Portal lets a product (signed with its own key) write the value
		const viaProduct = await sys.productApi('PUT', `/v1/product/websites/${siteA}/connections/database`, {
			value: 'mongodb://x/db',
		});
		expect(viaProduct.status).toBeGreaterThanOrEqual(400);
		expect((await connectionsOf(siteA)).database).toMatchObject({ set: true });
	});
});

describe('Ecommerce and Payments are linked by the Portal', () => {
	it('adding Ecommerce alone makes no link; adding Payments makes none yet, since nothing of Payments is needed until checkout is on', async () => {
		await sys.addProduct(m.merchantId, siteB, 'ecommerce');
		expect((await connectionsOf(siteB)).links).toEqual([]);
		await sys.addProduct(m.merchantId, siteB, 'payments');
		expect((await connectionsOf(siteB)).links).toEqual([]);
		expect(await linkKey('ecommerce', siteB, 'payments')).toBeNull();
	});

	it('switching on checkout at Ecommerce links it to Payments with exactly the scopes its manifest asks for and Payments offers', async () => {
		await enter(siteB, 'database', connectionString('b'));
		expect((await dashboardOf(siteB, PAYMENTS, 'payments', 'PUT', '/features', { on: ['payment_api'] })).status).toBe(200);
		expect((await dashboardOf(siteB, SHOP, 'ecommerce', 'PUT', '/features', { on: ['catalog', 'checkout'] })).status).toBe(200);
		const [link] = (await connectionsOf(siteB)).links;
		expect(link).toMatchObject({ caller: 'ecommerce', callee: 'payments', state: 'on' });
		expect(link.scopes.map((/** @type {{ scope: string }} */ each) => each.scope).sort()).toEqual(
			['methods.read', 'payments.cancel', 'payments.create', 'payments.read', 'payments.refund'].sort(),
		);
		// the page shows the key to nobody: not in the answer, not in the activity
		expect(JSON.stringify([await connectionsOf(siteB), await sys.activity('website.link_changed')])).not.toMatch(
			/eyJ[A-Za-z0-9_-]{10,}/,
		);
	});

	it('the link key works on what it allows, and on nothing else', async () => {
		const key = /** @type {string} */ (await linkKey('ecommerce', siteB, 'payments'));
		const claims = JSON.parse(Buffer.from(key.split('.')[1] ?? '', 'base64url').toString('utf8'));
		// signed for one website, one callee and one caller; the claims carry no scopes (the callee asks the Portal's grant)
		expect(claims).toMatchObject({ kind: 'link', websiteId: siteB, productId: 'payments', caller: 'ecommerce' });
		expect(claims.scopes).toBeUndefined();
		// allowed: payments.read (no such payment, but the key was let in)
		expect(await readWith(key)).toBe(404);
		// a route without a scope takes the website's server token alone, never a link key
		expect((await sys.call('GET', '/v1/links', { base: PAYMENTS, token: key })).status).toBe(401);
		// a scope the link does not hold (the kit's permissions list belongs to Accounts' link)
		const outside = await sys.call('GET', '/v1/permissions', { base: PAYMENTS, token: key });
		expect([outside.status, codeOf(outside)]).toEqual([403, 'scope_denied']);
		// it changes no configuration, whatever it is sent
		for (const [method, path] of /** @type {const} */ ([
			['PUT', '/v1/settings/payment_api.currency'],
			['PUT', '/v1/lists/manual_methods'],
			['PUT', '/v1/connections/database'],
			['DELETE', '/v1/connections/database'],
			['PUT', '/v1/theme'],
		]))
			expect(
				(await sys.call(method, path, { base: PAYMENTS, token: key, body: { value: 'x' } })).status,
				path,
			).toBeGreaterThanOrEqual(400);
		// a key made for Payments is no key at Notifications (another product), nor at Notes
		expect((await sys.call('GET', '/v1/templates', { base: NOTIFY, token: key })).status).toBe(401);
		expect((await sys.call('GET', '/v1/notes', { token: key })).status).toBe(401);
		expect((await connectionsOf(siteB)).database).toMatchObject({ set: true });
	});

	it('switching checkout off takes the scopes away at once (the link is idle); switching it on gives them back', async () => {
		const key = /** @type {string} */ (await linkKey('ecommerce', siteB, 'payments'));
		expect((await dashboardOf(siteB, SHOP, 'ecommerce', 'PUT', '/features', { on: ['catalog'] })).status).toBe(200);
		expect((await connectionsOf(siteB)).links.map((/** @type {any} */ link) => link.state)).toEqual(['idle']);
		expect(await readWith(key)).toBe(403);
		expect((await dashboardOf(siteB, SHOP, 'ecommerce', 'PUT', '/features', { on: ['catalog', 'checkout'] })).status).toBe(200);
		expect((await connectionsOf(siteB)).links.map((/** @type {any} */ link) => link.state)).toEqual(['on']);
		expect(await readWith(key)).toBe(404);
	});

	it('the key of one website does nothing on another: switching the link off on one website changes only that website', async () => {
		// the same two products on the first website: its own link, its own key
		await sys.addProduct(m.merchantId, siteA, 'ecommerce');
		expect((await dashboardOf(siteA, SHOP, 'ecommerce', 'PUT', '/features', { on: ['catalog', 'checkout'] })).status).toBe(200);
		const keyA = /** @type {string} */ (await linkKey('ecommerce', siteA, 'payments'));
		const keyB = /** @type {string} */ (await linkKey('ecommerce', siteB, 'payments'));
		expect(keyA).not.toBe(keyB);
		expect(await readWith(keyA)).toBe(404);
		// website A's link is switched off in the Portal (the password again)
		const off = await m.client.post(`/v1/merchants/${m.merchantId}/websites/${siteA}/links/payments/ecommerce/switch`, {
			on: false,
			password: PASSWORD,
		});
		expect(off.status).toBe(200);
		expect(await readWith(keyA)).toBe(401);
		// website B's key is untouched
		expect(await readWith(keyB)).toBe(404);
	});

	it('a new key replaces the old one at once', async () => {
		const before = /** @type {string} */ (await linkKey('ecommerce', siteB, 'payments'));
		const done = await m.client.post(`/v1/merchants/${m.merchantId}/websites/${siteB}/links/payments/ecommerce/regenerate`, {
			password: PASSWORD,
		});
		expect(done.status).toBe(200);
		const after = /** @type {string} */ (await linkKey('ecommerce', siteB, 'payments'));
		expect(after).not.toBe(before);
		expect(await readWith(before)).toBe(401);
		expect(await readWith(after)).toBe(404);
	});

	it('the link ends when Payments leaves the website: its key stops working and the page no longer lists it', async () => {
		const key = /** @type {string} */ (await linkKey('ecommerce', siteB, 'payments'));
		const removed = await (await sys.owner()).del(`/v1/merchants/${m.merchantId}/websites/${siteB}/products/payments`);
		expect(removed.status).toBeLessThan(300);
		expect(await readWith(key)).toBe(401);
		expect((await connectionsOf(siteB)).links).toEqual([]);
		expect(await linkKey('ecommerce', siteB, 'payments')).toBeNull();
	});
});
