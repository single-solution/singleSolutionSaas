/**
 * Places (dynamic model §5): addresses with a region, picked from the address_regions list in a listed country;
 * delivery zones by country, region, city, area and postcode start (the most specific wins); tax by country, region,
 * city and postcode start, a pickup taxed in the business.json country; a staff address change checked by the
 * website's rules; phones found by their whole number.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS } from '../core/model.js';
import { ORIGIN, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
let ip = 0;

/**
 * A visitor request from a fresh address.
 * @param {string} method @param {string} path
 * @param {{ body?: unknown, signIn?: string, key?: string }} [init]
 */
const visit = (method, path, { body, signIn, key } = {}) => {
	ip += 1;
	return shop.call(method, path, {
		token: shop.browser,
		origin: ORIGIN,
		body,
		headers: {
			'x-forwarded-for': `10.7.${(ip >> 8) & 255}.${ip & 255}`,
			...(signIn ? { 'ss-sign-in': signIn } : {}),
			...(key ? { 'idempotency-key': key } : {}),
		},
	});
};

/** @param {Record<string, unknown>} body @param {string} [signIn] */
const place = (body, signIn) => visit('POST', '/v1/shop/orders', { body, signIn, key: `places-${ip}-${Math.random()}` });
/** @param {Record<string, unknown>} body */
const quote = (body) => visit('POST', '/v1/shop/cart/quote', { body });

/** One Standard rate of a price (E5). @param {number} price */
const rate = (price) => [{ key: 'standard', name: 'Standard', price }];

beforeAll(async () => {
	shop = await readyShop({ business: { country: 'US' } });
	await shop.list('delivery_zones', [
		{ key: 'world', name: 'Rest of the world', rates: rate(1500) },
		{ key: 'us', name: 'United States', match: { countries: ['United States'] }, rates: rate(900) },
		{ key: 'ca', name: 'California', match: { countries: ['US'], regions: ['California'] }, rates: rate(500) },
		{ key: 'sf', name: 'San Francisco', match: { postcodes: ['941'] }, rates: rate(300) },
		{ key: 'mission', name: 'Mission', match: { cities: ['San Francisco'], areas: ['Mission'] }, rates: rate(200) },
	]);
	await shop.list('address_regions', [{ country: 'United States', names: ['California', 'New York', 'Texas'] }]);
});
afterAll(async () => shop.product.close());

describe('delivery zones by place', () => {
	it('takes the most specific zone: postcode start, area, city, region, country; else the catch-all zone', async () => {
		const item = await shop.seedProduct({ price: 10_000, stock: 10 });
		/** @param {Record<string, string>} delivery */
		const zoneOf = async (delivery) => {
			const answer = await quote({ lines: [{ productId: item.id }], delivery });
			expect(answer.status).toBe(200);
			return [answer.json.delivery.zone, answer.json.delivery.fee];
		};
		// an address without a country is in the business.json country
		expect(await zoneOf({ city: 'Austin', region: 'Texas' })).toEqual(['us', 900]);
		expect(await zoneOf({ region: 'california' })).toEqual(['ca', 500]);
		expect(await zoneOf({ region: 'California', postalCode: '94105' })).toEqual(['sf', 300]);
		expect(await zoneOf({ city: 'San Francisco', area: 'Mission', region: 'California', postalCode: '94110' })).toEqual([
			'sf',
			300,
		]);
		expect(await zoneOf({ city: 'san francisco', area: 'mission' })).toEqual(['mission', 200]);
		expect(await zoneOf({ country: 'Canada', city: 'Toronto' })).toEqual(['world', 1500]);
	});
});

describe('tax by place', () => {
	it('adds the rules of where a delivery goes, and taxes a pickup in the business.json country', async () => {
		await shop.list('tax_rules', [
			{ name: 'Federal', percent: 1, regions: [{ country: 'US' }] },
			{ name: 'California', percent: 7.25, regions: [{ country: 'US', region: 'California' }] },
			{ name: 'SF', percent: 0.5, regions: [{ country: 'US', postcode: '941' }] },
			{ name: 'Canada', percent: 5, regions: [{ country: 'CA' }] },
		]);
		await shop.setting('taxes', 'pricesIncludeTax', false);
		const counter = await shop.api('POST', '/v1/locations', { name: 'Front desk', pickup: true });
		expect(counter.status).toBe(201);
		const item = await shop.seedProduct({ price: 10_000, stock: 10 });
		/** @param {Record<string, string | null>} delivery */
		const taxOf = async (delivery) => (await quote({ lines: [{ productId: item.id }], delivery })).json.totals.tax;
		expect(await taxOf({ region: 'California', postalCode: '94105' })).toBe(875);
		expect(await taxOf({ region: 'California', postalCode: '90001' })).toBe(825);
		expect(await taxOf({ region: 'Texas' })).toBe(100);
		expect(await taxOf({ country: 'CA', region: 'Ontario' })).toBe(500);
		// a pickup is at the business: its country's rules apply (before, a pickup order had no place and paid none)
		expect(await taxOf({ method: 'pickup', locationId: counter.json.id, region: 'California' })).toBe(100);
		await shop.api('DELETE', `/v1/locations/${counter.json.id}`);
		await shop.setting('taxes', 'pricesIncludeTax', true);
		await shop.list('tax_rules', []);
	});
});

describe('addresses with a region', () => {
	it('keeps the region on the order, picked from address_regions in a listed country', async () => {
		const item = await shop.seedProduct({ price: 1000, stock: 10 });
		const shopper = await shop.signIn({ id: 'usr_places0000001' });
		const address = { name: 'Sara Shopper', phone: '+15550001111', line1: '1 Main Street', city: 'Austin' };
		const placed = await place(
			{ lines: [{ productId: item.id }], payment: 'cod', address: { ...address, region: ' new  york ' } },
			shopper,
		);
		expect(placed.status).toBe(201);
		expect(placed.json.order.address).toMatchObject({ region: 'New York', country: '' });
		const wrong = await place(
			{ lines: [{ productId: item.id }], payment: 'cod', address: { ...address, country: 'US', region: 'Ontario' } },
			shopper,
		);
		expect(wrong.status).toBe(422);
		expect(wrong.json.errors[0].path).toBe('/address/region');
		// another country's region is the shopper's own words
		const abroad = await place(
			{ lines: [{ productId: item.id }], payment: 'cod', address: { ...address, country: 'CA', region: 'Ontario' } },
			shopper,
		);
		expect(abroad.status).toBe(201);
		expect(abroad.json.order.address.region).toBe('Ontario');

		// staff change the address as checkout checks it: the website's required fields, the region names
		await shop.setting('checkout', 'addressRequired', ['line1']);
		const order = placed.json.order;
		const moved = await shop.api('PATCH', `/v1/orders/${order.id}`, {
			address: { city: '', region: 'texas', postalCode: '73301' },
		});
		expect(moved.status).toBe(200);
		expect(moved.json.address).toMatchObject({ city: '', region: 'Texas', postalCode: '73301' });
		const refused = await shop.api('PATCH', `/v1/orders/${order.id}`, { address: { region: 'Bavaria' } });
		expect(refused.status).toBe(422);
		expect(refused.json.errors[0].path).toBe('/address/region');
		await shop.setting('checkout', 'addressRequired', ['line1', 'city']);
		const city = await shop.api('PATCH', `/v1/orders/${order.id}`, { address: { region: 'Texas' } });
		expect(city.status).toBe(422);
		expect(city.json.errors[0].path).toBe('/address/city');
		for (const id of [order.id, abroad.json.order.id]) await shop.api('DELETE', `/v1/orders/${id}`);
	});

	it('gives the cart widget the region lists and the business.json country', async () => {
		const config = await visit('GET', '/v1/widget/config');
		expect(config.status).toBe(200);
		expect(config.json.settings.checkout.address).toMatchObject({
			regions: [{ country: 'United States', names: ['California', 'New York', 'Texas'] }],
			country: 'US',
			required: ['name', 'phone', 'line1', 'city'],
		});
		await shop.setting('checkout', 'phoneRequired', false);
		const optional = (await visit('GET', '/v1/widget/config')).json.settings.checkout.address;
		expect(optional.required).toEqual(['name', 'line1', 'city']);
		expect(optional.optional).toContain('phone');
		await shop.setting('checkout', 'phoneRequired', true);
	});
});

describe('phones found by their whole number', () => {
	it('finds a customer and an order by a national number typed with its trunk prefix', async () => {
		await shop.setting('checkout', 'guests', 'on');
		await shop.setting('checkout', 'defaultCallingCode', '+33');
		const item = await shop.seedProduct({ price: 1000, stock: 10 });
		const placed = await place({
			lines: [{ productId: item.id }],
			payment: 'cod',
			address: { name: 'Lea Guest', phone: '06 12 34 56 78', line1: '1 rue de la Paix', city: 'Paris', country: 'FR' },
			customer: { name: 'Lea Guest', phone: '06 12 34 56 78' },
		});
		expect(placed.status).toBe(201);
		const db = await shop.db();
		const record = await db.collection(COLLECTIONS.orders).findOne({ websiteId: shop.websiteId, id: placed.json.order.id });
		expect(record?.phoneDigits).toBe('33612345678');
		// before, only the last 10 digits were kept and searched: 0612345678 never matched 3612345678
		const customers = await shop.api('GET', `/v1/customers?q=${encodeURIComponent('06 12 34 56 78')}`);
		expect(customers.json.items.map((/** @type {any} */ c) => c.guestKey)).toContain('p:+33612345678');
		const orders = await shop.api('GET', '/v1/orders?q=0612345678');
		expect(orders.json.items.map((/** @type {any} */ o) => o.id)).toContain(placed.json.order.id);
		expect((await shop.api('GET', '/v1/orders?q=12345678')).json.items.map((/** @type {any} */ o) => o.id)).toContain(
			placed.json.order.id,
		);
		await shop.api('DELETE', `/v1/orders/${placed.json.order.id}`);
		await shop.setting('checkout', 'defaultCallingCode', '');
		await shop.setting('checkout', 'guests', 'off');
	});
});
