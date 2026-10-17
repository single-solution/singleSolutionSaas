/**
 * Website settings end to end (settings-ownership design, steps 2–4): the merchant sets a fact once in the Portal and
 * every product on that website uses it — Ecommerce and Chat, real products on the real kit against the real Portal —
 * and nothing but a signed-in person changes it: not a server token (also with a staff sign-in), not a browser token,
 * not a product's own signed call.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProductInstance as createChat, manifest as chatManifest, strings as chatStrings } from '@ss/product-chat/product';
import { createRoutes as chatRoutes } from '@ss/product-chat/routes';
import { createProductInstance, manifest, strings } from '@ss/product-ecommerce/product';
import { createRoutes } from '@ss/product-ecommerce/routes';
import { codeOf, startSystem } from './helpers.js';

const SHOP = 'https://ecommerce.test';
const CHAT = 'https://chat.test';
const DOMAIN = 'store.example.com';
const ORIGIN = `https://${DOMAIN}`;

/** @type {import('./helpers.js').System} */
let sys;
/** @type {Awaited<ReturnType<import('./helpers.js').System['merchant']>>} */
let m;
let websiteId = '';
let settingsUrl = '';
/** @type {Record<string, { browser: string, server: string }>} */
const tokens = {};

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
		unit: unit(createProductInstance, createRoutes, manifest, strings, SHOP),
		extras: [unit(createChat, chatRoutes, chatManifest, chatStrings, CHAT)],
	});
	await sys.connect();
	await sys.connect({ base: CHAT });
	m = await sys.merchant('store@shop.test', [DOMAIN]);
	websiteId = m.websiteIds[0] ?? '';
	settingsUrl = `/v1/merchants/${m.merchantId}/websites/${websiteId}/settings`;
	for (const id of ['ecommerce', 'chat']) {
		await sys.addProduct(m.merchantId, websiteId, id);
		tokens[id] = await sys.tokens(m.merchantId, websiteId, id);
	}
	await sys.addCredits(m.merchantId, 100);
	// each product has a merchant database (its widget config needs one)
	await sys.connectDatabase(websiteId);
	await sys.connectDatabase(websiteId, CHAT);
	// Ecommerce's Store details feature is on (its list is only open to the website's server while it is)
	await sys.switchFeatures(await sys.adminSession(await sys.owner(), websiteId), websiteId, ['store_details']);
});
afterAll(async () => {
	await sys?.stop();
});

/** The time zone each product's widgets are given. */
const widgetTimeZones = async () => {
	const shop = await sys.call('GET', '/v1/widget/config', { token: tokens.ecommerce?.browser, origin: ORIGIN });
	const chat = await sys.call('GET', '/v1/widget/config', { token: tokens.chat?.browser, origin: ORIGIN, base: CHAT });
	return [shop.json.timeZone, chat.json.timeZone];
};

/** The time zone each product's server code (business facts and formatter) works in. @param {string} id */
const serverTimeZones = async (id) => {
	const product = id === 'ecommerce' ? sys.product : sys.others[id];
	return [(await product.business(websiteId)).timeZone, (await product.format(websiteId)).timeZone];
};

/** The Region and format form as the Portal's console sends it. @param {string} timeZone */
const region = (timeZone) => ({
	country: 'PK',
	timeZone,
	currency: 'PKR',
	currencies: ['PKR'],
	language: 'en-PK',
	languages: ['en-PK'],
	countriesServed: [],
	units: { weight: 'kg', size: 'cm' },
	format: { locale: '', currencyDisplay: 'symbol', currencySymbols: { PKR: 'Rs' }, wholeUnits: true, times: 'business' },
	phone: { callingCode: '+92', trunkPrefix: '0', countries: [] },
	address: { required: ['line1', 'city'], regions: [] },
});

describe('the merchant sets the time zone once, in the Portal', () => {
	it('before anything is saved the products work in UTC (nothing says otherwise)', async () => {
		expect(await widgetTimeZones()).toEqual(['UTC', 'UTC']);
		const read = await m.client.get(settingsUrl);
		expect(read.json.settings).toMatchObject({ version: 0 });
		// the Portal tells what each product needs; Ecommerce and Chat ask for nothing yet
		expect(read.json.readiness.map((/** @type {{ productId: string }} */ r) => r.productId)).toEqual(['chat', 'ecommerce']);
	});

	it('every product on that website uses it: widgets, business facts and the formatter', async () => {
		const saved = await m.client.put(`${settingsUrl}/region`, { version: 0, value: region('Asia/Karachi') });
		expect(saved.status).toBe(200);
		expect(saved.json.settings.version).toBe(1);
		// the notice reached both products (in process, right after the save) and each fetched the document
		expect(await sys.waitingNotices()).toEqual([]);
		expect(await widgetTimeZones()).toEqual(['Asia/Karachi', 'Asia/Karachi']);
		expect(await serverTimeZones('ecommerce')).toEqual(['Asia/Karachi', 'Asia/Karachi']);
		expect(await serverTimeZones('chat')).toEqual(['Asia/Karachi', 'Asia/Karachi']);
		// the Format and the currency come with it
		const shop = await sys.call('GET', '/v1/widget/config', { token: tokens.ecommerce?.browser, origin: ORIGIN });
		expect(shop.json.format).toMatchObject({
			currencyDisplay: 'symbol',
			currencySymbols: { PKR: 'Rs' },
			wholeUnits: true,
			times: 'business',
		});
		expect((await sys.product.business(websiteId)).currency).toBe('PKR');
		// a change is logged in the Portal with who made it
		const [entry] = await sys.activity('website.settings_saved');
		expect(entry).toMatchObject({ actor: { type: 'merchant', id: m.merchantId }, after: { section: 'region', version: 1 } });
	});

	it('a second change reaches them too', async () => {
		const saved = await m.client.put(`${settingsUrl}/region`, { version: 1, value: region('America/Chicago') });
		expect(saved.status).toBe(200);
		expect(await widgetTimeZones()).toEqual(['America/Chicago', 'America/Chicago']);
	});

	it('a product that could not be told catches up from its next status read, and the Portal keeps the notice meanwhile', async () => {
		sys.setReachable(false);
		const saved = await m.client.put(`${settingsUrl}/region`, { version: 2, value: region('Europe/Paris') });
		expect(saved.status).toBe(200);
		expect((await sys.waitingNotices()).map((n) => n.type)).toEqual(['website.settings_changed']);
		// Chat, reachable, already has it
		expect((await serverTimeZones('chat'))[0]).toBe('Europe/Paris');
		sys.setReachable(true);
		// Ecommerce still has the old time zone; its status copy runs out, the status shows the newer version, the new
		// settings are fetched right after a response
		expect((await serverTimeZones('ecommerce'))[0]).toBe('America/Chicago');
		sys.clock.advance(6 * 60_000);
		await sys.call('GET', '/v1/widget/config', { token: tokens.ecommerce?.browser, origin: ORIGIN });
		sys.clock.advance(61_000);
		expect((await serverTimeZones('ecommerce'))[0]).toBe('Europe/Paris');
	});

	it('Ecommerce’s Store details are the Portal’s: the shop reads the same facts, and keeps no record or form of its own', async () => {
		const business = {
			name: 'Portal Store',
			otherNames: [],
			tagline: '',
			legalName: '',
			taxNumber: '',
			businessType: '',
			email: 'hello@store.example.com',
			phone: '+92 300 0000000',
			phones: [],
			whatsapp: '',
			address: { line1: '1 Main Road', line2: '', area: '', city: 'Lahore', region: '', postalCode: '', country: 'PK' },
			hours: { weekly: [], exceptions: [] },
			social: [],
		};
		const version = (await m.client.get(settingsUrl)).json.settings.version;
		expect((await m.client.put(`${settingsUrl}/business`, { version, value: business })).status).toBe(200);
		const shop = await sys.call('GET', '/v1/shop/store', { token: tokens.ecommerce?.browser, origin: ORIGIN });
		expect(shop.json).toMatchObject({
			name: 'Portal Store',
			timeZone: 'Europe/Paris',
			address: { city: 'Lahore', country: 'PK' },
			contact: { email: 'hello@store.example.com' },
		});
		// the website's server reads the same, and Ecommerce has no list of its own for them any more
		const fromServer = await sys.call('GET', '/v1/shop/store', {
			token: tokens.ecommerce?.server,
			headers: { 'ss-visitor-ip': '203.0.113.7' },
		});
		expect(fromServer.json).toEqual(shop.json);
		expect((await sys.call('GET', '/v1/lists/store_details', { token: tokens.ecommerce?.server })).status).toBe(404);
	});
});

describe('nothing but a signed-in person changes website settings', () => {
	it('a bare server token cannot: not in the Portal, not in the products — also with a staff sign-in', async () => {
		const before = (await m.client.get(settingsUrl)).json.settings;
		const server = tokens.ecommerce?.server;
		const browser = tokens.ecommerce?.browser;
		const body = { version: before.version, value: region('Asia/Tokyo') };

		// the Portal's routes take a signed-in session only
		for (const bearer of [server, browser]) {
			const put = await sys.api.call('PUT', `${settingsUrl}/region`, { bearer, body });
			expect([put.status, codeOf(put)]).toEqual([401, 'unauthorized']);
			expect((await sys.api.call('GET', settingsUrl, { bearer })).status).toBe(401);
		}
		// a product's own signed call (its client assertion) cannot write them either, nor read the console route
		const asProduct = await sys.productApi('PUT', `${settingsUrl}/region`, body);
		expect(asProduct.status).toBe(401);
		// …and its pull route is read only
		expect((await sys.productApi('PUT', `/v1/product/websites/${websiteId}/settings`, body)).status).toBe(405);
		// a server token is not a product assertion: it cannot even read the product route
		expect((await sys.api.call('GET', `/v1/product/websites/${websiteId}/settings`, { bearer: server })).status).toBe(401);

		// the products: the theme and the Format are the Portal's — a bare server token never could, and with a signed-in
		// staff member it is still refused
		for (const [path, change] of /** @type {Array<[string, unknown]>} */ ([
			['/v1/theme', { mode: 'light' }],
			['/v1/format', { wholeUnits: false }],
		])) {
			const bare = await sys.call('PUT', path, { token: server, bare: true, body: change });
			expect([bare.status, codeOf(bare)]).toEqual([403, 'needs_signed_in_staff']);
			const staff = await sys.call('PUT', path, { token: server, body: change });
			expect([staff.status, codeOf(staff)]).toEqual([409, 'managed_by_portal']);
			const chatBare = await sys.call('PUT', path, { token: tokens.chat?.server, bare: true, base: CHAT, body: change });
			expect(chatBare.status).toBe(403);
			const chatStaff = await sys.call('PUT', path, { token: tokens.chat?.server, base: CHAT, body: change });
			expect([chatStaff.status, codeOf(chatStaff)]).toEqual([409, 'managed_by_portal']);
		}
		// Ecommerce keeps no copy of the Portal's facts to change: there is no such list, and no such setting
		const store = await sys.call('PUT', '/v1/lists/store_details', { token: server, body: { value: { name: 'Mine' } } });
		expect([store.status, codeOf(store)]).toEqual([404, 'not_found']);
		const currency = await sys.call('PUT', '/v1/settings/catalog.currency', { token: server, body: { value: 'EUR' } });
		expect([currency.status, codeOf(currency)]).toEqual([404, 'not_found']);

		// the same through the dashboards: they have no route to change what the Portal owns
		const cookie = await sys.adminSession(await sys.owner(), websiteId);
		const theme = await sys.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${websiteId}/theme`, { mode: 'light' });
		expect([theme.status, codeOf(theme)]).toEqual([404, 'not_found']);

		// another merchant’s session cannot write them
		const other = await sys.merchant('other@shop.test', ['other.example.com']);
		expect((await other.client.put(`${settingsUrl}/region`, body)).status).toBe(403);

		// nothing changed, nothing was logged as a change
		const after = (await m.client.get(settingsUrl)).json.settings;
		expect(after).toEqual(before);
		expect((await sys.activity('website.settings_saved')).length).toBe(before.version);
		expect(await widgetTimeZones()).toEqual(['Europe/Paris', 'Europe/Paris']);
	});
});
