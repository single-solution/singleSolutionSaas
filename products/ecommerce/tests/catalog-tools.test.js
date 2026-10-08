/**
 * The catalog with every feature on (PLAN 0.8.8): stock locations, CSV import and export, bulk actions and AI copy;
 * and the catalog with only some features on (feature switches, storage not connected).
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS } from '../core/model.js';
import { AI, readyShop, setup } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
/** @type {Record<string, any>} */
const ids = {};

/** @param {string} method @param {string} path @param {unknown} [body] */
const api = (method, path, body) => shop.api(method, path, body);
/** @param {string} method @param {string} path @param {unknown} [body] */
const ok = async (method, path, body) => {
	const answer = await shop.api(method, path, body);
	if (answer.status >= 300) throw new Error(`${method} ${path}: ${answer.status} ${answer.text}`);
	return answer.json;
};

beforeAll(async () => {
	shop = await readyShop();
	ids.shopFloor = await ok('POST', '/v1/locations', { name: 'Shop floor', pickup: true });
	ids.store = await ok('POST', '/v1/locations', { name: 'Store room', sort: 2 });
	ids.phones = await ok('POST', '/v1/categories', { name: 'Phones' });
	ids.acme = await ok('POST', '/v1/brands', { name: 'Acme' });
});
afterAll(async () => shop.product.close());

describe('stock locations', () => {
	it('keeps locations and stock per location', async () => {
		expect((await api('GET', '/v1/locations')).json.items.map((/** @type {any} */ l) => l.name)).toEqual([
			'Shop floor',
			'Store room',
		]);
		expect((await api('PATCH', `/v1/locations/${ids.store.id}`, { name: 'Back room' })).json).toMatchObject({
			name: 'Back room',
			sort: 2,
		});
		expect((await api('POST', '/v1/locations', { pickup: 'yes' })).status).toBe(422);
		expect((await api('PATCH', `/v1/locations/${ids.store.id}`, { sort: 1.5 })).status).toBe(422);
		expect((await api('POST', '/v1/products', { name: 'Phone', price: 100, stock: 3 })).status).toBe(422);
		expect((await api('POST', '/v1/products', { name: 'Phone', price: 100, locations: { loc_none: 1 } })).status).toBe(422);
		expect((await api('POST', '/v1/products', { name: 'Phone', price: 100, locations: [] })).status).toBe(422);
		expect((await api('POST', '/v1/products', { name: 'Phone', price: 100, locations: { [ids.store.id]: -1 } })).status).toBe(
			422,
		);
		const phone = await ok('POST', '/v1/products', {
			name: 'Phone',
			status: 'active',
			sku: 'PH-1',
			price: 100,
			locations: { [ids.shopFloor.id]: 2, [ids.store.id]: 3 },
		});
		expect(phone.variants[0]).toMatchObject({ stock: 5, locations: { [ids.shopFloor.id]: 2, [ids.store.id]: 3 } });
		ids.phone = phone;
		const variantId = phone.variants[0].id;
		expect((await api('POST', `/v1/products/${phone.id}/stock`, { changes: [{ variantId, set: 1 }] })).status).toBe(422);
		expect(
			(await api('POST', `/v1/products/${phone.id}/stock`, { changes: [{ variantId, set: 1, locationId: 'loc_none' }] }))
				.status,
		).toBe(422);
		const moved = await ok('POST', `/v1/products/${phone.id}/stock`, {
			changes: [
				{ variantId, adjust: -2, locationId: ids.shopFloor.id },
				{ variantId, adjust: 2, locationId: ids.store.id },
			],
		});
		expect(moved.variants[0]).toMatchObject({ stock: 5, locations: { [ids.shopFloor.id]: 0, [ids.store.id]: 5 } });
		expect((await api('DELETE', `/v1/locations/${ids.store.id}`)).status).toBe(409);
		const spare = await ok('POST', '/v1/locations', { name: 'Spare' });
		await ok('POST', `/v1/products/${phone.id}/stock`, { changes: [{ variantId, set: 0, locationId: spare.id }] });
		expect((await api('DELETE', `/v1/locations/${spare.id}`)).status).toBe(204);
		const after = await ok('GET', `/v1/products/${phone.id}`);
		expect(Object.keys(after.variants[0].locations)).not.toContain(spare.id);
		expect((await api('PATCH', `/v1/locations/${spare.id}`, { name: 'x' })).status).toBe(404);
		const serials = await ok('POST', '/v1/serials', {
			productId: phone.id,
			variantId,
			serials: ['SN-1'],
			locationId: ids.store.id,
		});
		expect(serials.items[0].locationId).toBe(ids.store.id);
	});
});

describe('CSV', () => {
	it('exports products and stock, one row per variant', async () => {
		const answer = await shop.api('GET', '/v1/csv/products');
		expect(answer.status).toBe(200);
		expect(answer.headers.get('content-type')).toBe('text/csv; charset=utf-8');
		expect(answer.headers.get('content-disposition')).toBe('attachment; filename="products.csv"');
		const [header, row] = answer.text.replace(/^\uFEFF/, '').split('\r\n');
		expect(header).toContain(`stock@${ids.shopFloor.id},stock@${ids.store.id}`);
		expect(row).toContain(`${ids.phone.id},phone,Phone,active,physical,,,,,,,,true,${ids.phone.variants[0].id},PH-1,`);
		expect(row).toContain(',1.00,,,5,,true,0,5');
	});

	it('imports products after a dry run that lists every problem', async () => {
		const staff = await shop.ticket(['csv.run']);
		const head = `name,slug,status,categories,brand,tags,description,sku,option1_name,option1_value,price,compare_at_price,stock@${ids.shopFloor.id},active`;
		const bad = [
			head,
			'Tablet,tablet,active,nothing,Nobody,,,TB-1,,,9.99,,1,true',
			',,,,,,,,,,,,,',
			'Laptop,,draft,phones,acme,,,PH-1,,,abc,,x,maybe',
		].join('\n');
		const dry = await shop.admin(staff, 'POST', '/v1/admin/csv/products', { csv: bad });
		expect(dry.status).toBe(200);
		expect(dry.json.dryRun).toBe(true);
		const problems = dry.json.errors.map((/** @type {any} */ e) => `${e.line}${e.path}`);
		expect(problems).toEqual(
			expect.arrayContaining(['2/categories', '2/brand', '3/name', '4/price', `4/stock@${ids.shopFloor.id}`, '4/active']),
		);
		const refused = await shop.admin(staff, 'POST', '/v1/admin/csv/products', { csv: bad, dryRun: false });
		expect(refused.status).toBe(422);
		expect(refused.json.errors[0].path).toMatch(/^\/csv\/2\//);

		const good = [
			head,
			`Tablet,,active,phones,acme,big|new,"=1+1, said ""he""",TB-1,Colour,Black,9.99,12.50,4,true`,
			'Tablet,,active,,,,,TB-2,Colour,White,10,,0,true',
			'Phone,phone,,,,,,PH-1,,,1.50,,7,',
		].join('\r\n');
		const check = await ok('POST', '/v1/csv/products', { csv: good });
		expect(check).toMatchObject({ dryRun: true, rows: 3, created: 1, updated: 1, errors: [] });
		const done = await ok('POST', '/v1/csv/products', { csv: good, dryRun: false });
		expect(done).toMatchObject({ dryRun: false, created: 1, updated: 1 });
		const tablet = await ok('GET', '/v1/products/tablet');
		expect(tablet).toMatchObject({
			status: 'active',
			categoryIds: [ids.phones.id],
			brandId: ids.acme.id,
			tags: ['big', 'new'],
			description: '=1+1, said "he"',
			options: [{ name: 'Colour', values: ['Black', 'White'] }],
			price: 999,
		});
		expect(tablet.variants.map((/** @type {any} */ v) => [v.sku, v.price, v.compareAtPrice, v.stock])).toEqual([
			['TB-1', 999, 1250, 4],
			['TB-2', 1000, null, 0],
		]);
		const phone = await ok('GET', `/v1/products/${ids.phone.id}`);
		expect(phone.variants[0]).toMatchObject({ price: 150, stock: 12, locations: { [ids.shopFloor.id]: 7, [ids.store.id]: 5 } });
		// formula-looking cells are guarded on the way out and restored on the way in
		const exported = (await shop.api('GET', '/v1/csv/products')).text;
		expect(exported).toContain(`"'=1+1, said ""he"""`);
		const again = await ok('POST', '/v1/csv/products', { csv: exported, dryRun: false });
		expect(again).toMatchObject({ created: 0, updated: 2, errors: [] });
		expect((await ok('GET', '/v1/products/tablet')).description).toBe('=1+1, said "he"');
	});

	it('refuses files it cannot read', async () => {
		const send = (/** @type {unknown} */ csv) => api('POST', '/v1/csv/products', { csv, dryRun: false });
		expect((await send('')).status).toBe(422);
		expect((await send('name\n"open')).status).toBe(422);
		expect((await send('\n\n')).status).toBe(422);
		expect((await send(`name,price\n${'A,1\n'.repeat(5001)}`)).json.detail).toContain('5000');
		const columns = await api('POST', '/v1/csv/products', { csv: 'colour\nred' });
		expect(columns.json.errors[0]).toMatchObject({ line: 1 });
		const location = await api('POST', '/v1/csv/products', { csv: 'name,price,stock@loc_none\nA,1,1' });
		expect(location.json.errors[0].path).toBe('/stock@loc_none');
		const plain = await api('POST', '/v1/csv/products', { csv: 'name,price,stock\nA,1,1' });
		expect(plain.json.errors[0].message).toContain('per location');
		const existing = await api('POST', '/v1/csv/products', { csv: 'sku,stock\nPH-1,3' });
		expect(existing.json.errors[0].message).toContain('per location');
		const clash = await api('POST', '/v1/csv/products', {
			csv: `product_id,sku,price\nprd_none,X,1\n${ids.phone.id},TB-1,1\n,,1`,
		});
		expect(clash.json.errors.map((/** @type {any} */ e) => e.path)).toEqual(['/product_id', '/sku', '/variants', '/name']);
		const twice = await api('POST', '/v1/csv/products', {
			csv: 'name,slug,sku,price\nA,a-one,Q1,1\nB,b-one,Q1,1\nC,tablet,Q2,1',
		});
		expect(twice.json.errors.map((/** @type {any} */ e) => e.message)).toEqual(
			expect.arrayContaining(['The SKU Q1 is in two products of the file.']),
		);
		await shop.setting('csv', 'delimiter', ';');
		const semi = await ok('POST', '/v1/csv/products', { csv: 'name;price\nSemi;1,5' });
		expect(semi.errors.map((/** @type {any} */ e) => e.path)).toEqual(['/price', '/price']);
		expect((await shop.api('GET', '/v1/csv/products')).text.split('\r\n')[0]).toContain('product_id;slug;name');
		await shop.setting('csv', 'delimiter', ',');
	});

	it('exports orders, one row per line', async () => {
		const data = await shop.db();
		/** @param {string} number @param {string} at */
		const order = (number, at) => ({
			id: createId('ord'),
			number,
			idempotencyKey: number,
			placedAt: new Date(at),
			status: 'delivered',
			customer: { userId: 'usr_1', name: 'Sara', email: 's@example.com', phone: '' },
			address: { city: 'Lahore' },
			lines: [
				{ name: 'Phone', variantName: 'Black', sku: 'PH-1', quantity: 2, unitPrice: 1050, discount: 100, total: 2000 },
				{ name: '@Case', variantName: '', sku: '', quantity: 1, unitPrice: 500, discount: 0, total: 500 },
			],
			totals: { currency: 'USD' },
			payment: { method: 'cod', state: 'paid' },
		});
		await data
			.collection(COLLECTIONS.orders)
			.insertMany([order('2026-000001', '2026-09-01T10:00:00Z'), order('2026-000002', '2026-10-01T10:00:00Z')]);
		const answer = await shop.api('GET', '/v1/csv/orders?from=2026-09-15&to=2026-12-31&status=delivered');
		const lines = answer.text
			.replace(/^\uFEFF/, '')
			.trim()
			.split('\r\n');
		expect(lines[0]).toBe(
			'number,placed_at,status,customer,city,product,variant,sku,quantity,unit_price,discount,total,currency,payment_method,payment_state',
		);
		expect(lines.slice(1)).toEqual([
			'2026-000002,2026-10-01T10:00:00.000Z,delivered,Sara,Lahore,Phone,Black,PH-1,2,10.50,1.00,20.00,USD,cod,paid',
			"2026-000002,2026-10-01T10:00:00.000Z,delivered,Sara,Lahore,'@Case,,,1,5.00,0.00,5.00,USD,cod,paid",
		]);
		expect((await shop.api('GET', '/v1/csv/orders?from=yesterday')).status).toBe(422);
		const staff = await shop.ticket(['csv.run']);
		expect((await shop.admin(staff, 'GET', '/v1/admin/csv/orders')).text.trim().split('\r\n')).toHaveLength(5);
		await data.collection(COLLECTIONS.orders).insertMany(
			Array.from({ length: 10_000 }, (_, n) => ({
				id: createId('ord'),
				number: `x-${n}`,
				idempotencyKey: `k-${n}`,
				placedAt: new Date(),
			})),
		);
		expect((await shop.api('GET', '/v1/csv/orders')).status).toBe(422);
		await data.collection(COLLECTIONS.orders).deleteMany({ websiteId: shop.websiteId });
	});
});

describe('bulk actions', () => {
	it('changes status, prices, stock and categories of many products', async () => {
		const staff = await shop.ticket(['bulk.run']);
		const a = await ok('POST', '/v1/products', { name: 'Bulk A', price: 1000, locations: { [ids.store.id]: 1 } });
		const b = await ok('POST', '/v1/products', {
			name: 'Bulk B',
			options: [{ name: 'Size', values: ['S', 'M'] }],
			variants: [
				{ options: { Size: 'S' }, price: 999, locations: {} },
				{ options: { Size: 'M' }, price: 50 },
			],
		});
		const both = [a.id, b.id];
		/** @param {Record<string, unknown>} body */
		const run = (body) => shop.admin(staff, 'POST', '/v1/admin/products/bulk', { ids: both, ...body });
		expect((await run({ action: 'status', status: 'active' })).json).toEqual({ matched: 2, changed: 2, missing: [] });
		expect((await run({ action: 'status', status: 'active' })).json.changed).toBe(0);
		expect((await ok('GET', `/v1/products/${a.id}`)).publishedAt).toBeTruthy();
		await run({ action: 'price', price: { mode: 'percent', value: -10 } });
		expect((await ok('GET', `/v1/products/${b.id}`)).variants.map((/** @type {any} */ v) => v.price)).toEqual([899, 45]);
		await run({ action: 'price', price: { mode: 'fixed', value: -60 } });
		expect((await ok('GET', `/v1/products/${b.id}`)).variants.map((/** @type {any} */ v) => v.price)).toEqual([839, 0]);
		await run({ action: 'stock', stock: 4, locationId: ids.shopFloor.id });
		const stocked = await ok('GET', `/v1/products/${a.id}`);
		expect(stocked.variants[0]).toMatchObject({ stock: 5, locations: { [ids.shopFloor.id]: 4, [ids.store.id]: 1 } });
		expect((await run({ action: 'stock', stock: 4 })).status).toBe(422);
		expect((await run({ action: 'stock', stock: -1 })).status).toBe(422);
		await run({ action: 'add_category', categoryId: ids.phones.id });
		expect((await ok('GET', `/v1/products/${a.id}`)).categoryIds).toEqual([ids.phones.id]);
		expect((await run({ action: 'add_category', categoryId: ids.phones.id })).json.changed).toBe(0);
		await api('POST', '/v1/products/bulk', { ids: both, action: 'remove_category', categoryId: ids.phones.id });
		expect((await ok('GET', `/v1/products/${a.id}`)).categoryIds).toEqual([]);
		expect((await run({ action: 'remove_category', categoryId: ids.phones.id })).json.changed).toBe(0);
		expect((await run({ action: 'add_category', categoryId: 'cat_none' })).status).toBe(422);
		expect((await run({ action: 'status', status: 'gone' })).status).toBe(422);
		expect((await run({ action: 'price', price: { mode: 'percent', value: 2000 } })).status).toBe(422);
		expect((await run({ action: 'explode' })).status).toBe(422);
		expect((await shop.admin(staff, 'POST', '/v1/admin/products/bulk', { ids: [], action: 'status' })).status).toBe(422);
		expect((await shop.admin(staff, 'POST', '/v1/admin/products/bulk', { ids: [a.id, a.id], action: 'status' })).status).toBe(
			422,
		);
		const missing = await shop.admin(staff, 'POST', '/v1/admin/products/bulk', {
			ids: [a.id, 'prd_none'],
			action: 'status',
			status: 'draft',
		});
		expect(missing.json).toEqual({ matched: 1, changed: 1, missing: ['prd_none'] });
	});
});

describe('AI copy', () => {
	it('suggests texts with the merchant AI key and never saves them', async () => {
		const staff = await shop.ticket(['catalog.edit']);
		const item = await ok('POST', '/v1/products', {
			name: 'Pixel 9',
			summary: 'Phone',
			description: 'Old text',
			categoryIds: [ids.phones.id],
			brandId: ids.acme.id,
			options: [{ name: 'Colour', values: ['Black'] }],
			variants: [{ options: { Colour: 'Black' }, price: 100 }],
		});
		const path = `/v1/admin/products/${item.id}/ai-copy`;
		expect((await shop.admin(staff, 'POST', path, { fields: ['description'] })).status).toBe(503);
		await shop.connect('ai', { baseUrl: AI, apiKey: 'sk-test-123456', model: 'm' });
		expect((await shop.admin(staff, 'POST', path, { fields: ['price'] })).status).toBe(422);
		expect((await shop.admin(staff, 'POST', path, { fields: ['summary'], tone: 'x'.repeat(200) })).status).toBe(422);
		expect((await shop.admin(staff, 'POST', path, { fields: ['summary'], language: 'x'.repeat(50) })).status).toBe(422);
		expect((await shop.admin(staff, 'POST', '/v1/admin/products/prd_none/ai-copy', { fields: ['summary'] })).status).toBe(404);
		/** @type {any} */
		let sent = null;
		shop.responders.set(AI, (call) => {
			sent = JSON.parse(call.body);
			return {
				status: 200,
				body: {
					choices: [{ message: { content: '```json\n{"description":"New text","seoTitle":"Pixel 9 by Acme"}\n```' } }],
				},
			};
		});
		const answer = await shop.admin(staff, 'POST', path, { fields: ['description', 'seoTitle'], language: 'English' });
		expect(answer.json).toEqual({ suggestions: { description: 'New text', seoTitle: 'Pixel 9 by Acme' } });
		expect(sent.model).toBe('m');
		expect(sent.messages[0].content).toContain('Write in English.');
		expect(sent.messages[1].content).toContain('Brand: Acme');
		expect(sent.messages[1].content).toContain('Categories: Phones');
		expect((await ok('GET', `/v1/products/${item.id}`)).description).toBe('Old text');
		shop.responders.set(AI, () => ({ status: 200, body: { choices: [{ message: { content: 'Just a summary.' } }] } }));
		expect((await api('POST', `/v1/products/${item.id}/ai-copy`, { fields: ['summary'] })).json.suggestions).toEqual({
			summary: 'Just a summary.',
		});
		expect((await api('POST', `/v1/products/${item.id}/ai-copy`, { fields: ['summary', 'seoTitle'] })).status).toBe(502);
		shop.responders.set(AI, () => ({ status: 429, body: {} }));
		const busy = await api('POST', `/v1/products/${item.id}/ai-copy`, { fields: ['summary'] });
		expect(busy.json).toMatchObject({ status: 502, type: expect.stringContaining('ai_failed') });
		shop.responders.set(AI, () => ({ status: 500, body: {} }));
		expect((await api('POST', `/v1/products/${item.id}/ai-copy`, { fields: ['summary'] })).status).toBe(502);
		const data = await shop.db();
		expect(data.websiteId).toBe(shop.websiteId);
	});
});

describe('feature switches and connections', () => {
	it('refuses tools that are off and uploads without storage', async () => {
		const small = await setup();
		await small.switchOn(['catalog']);
		await small.connectDatabase();
		expect((await small.api('GET', '/v1/csv/products')).json.type).toContain('feature_off');
		expect((await small.api('GET', '/v1/locations')).json.type).toContain('feature_off');
		expect((await small.api('POST', '/v1/products', { name: 'A', price: 1, serialized: true })).status).toBe(422);
		expect((await small.api('POST', '/v1/products', { name: 'A', kind: 'digital', price: 1 })).status).toBe(422);
		expect(
			(await small.api('POST', '/v1/products', { name: 'A', kind: 'booking', price: 1, booking: { durationMinutes: 30 } }))
				.status,
		).toBe(422);
		expect(
			(
				await small.api('POST', '/v1/products', {
					name: 'A',
					options: [{ name: 'Size', values: ['S'] }],
					variants: [{ options: { Size: 'S' }, price: 1 }],
				})
			).status,
		).toBe(422);
		const item = await small.api('POST', '/v1/products', { name: 'A', price: 1, stock: 1 });
		expect(item.status).toBe(201);
		const upload = await small.api('POST', '/v1/catalog/uploads', {
			for: 'product',
			id: item.json.id,
			type: 'image/png',
			size: 10,
		});
		expect(upload.json.type).toContain('storage_not_connected');
		expect((await small.api('POST', `/v1/products/${item.json.id}/media`, { key: 'x' })).status).toBe(503);
		expect((await small.visitor('GET', '/v1/shop/products/a')).status).toBe(404);
		await small.product.close();
	});
});
