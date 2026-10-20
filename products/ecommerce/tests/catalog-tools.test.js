/**
 * The catalog with every feature on (PLAN 0.8.8): stock locations, CSV import and export, bulk actions and AI copy;
 * and the catalog with only some features on (feature switches, storage not connected).
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS } from '../core/model.js';
import { AI, UNIT_TYPES, readyShop, setup } from './helpers.js';

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
	await shop.list('item_types', UNIT_TYPES);
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
			typeKey: 'numbered',
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
		// the byte order mark Excel needs to read UTF-8 arrives byte for byte (the decoded text leaves it out)
		expect([...answer.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
		const [header, row] = answer.text.split('\r\n');
		expect(header).toContain(`stock@${ids.shopFloor.id},stock@${ids.store.id}`);
		expect(row).toContain(`${ids.phone.id},phone,Phone,active,physical,,,,,,,,true,${ids.phone.variants[0].id},PH-1,`);
		expect(row).toContain(',1.00,,,5,,true,0,5');
	});

	it('imports products after a dry run that lists every problem', async () => {
		const staff = await shop.ticket(['csv.run', 'catalog.edit']);
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
		// each problem's code and values, for the widget's words (PLAN 0.4.10)
		expect(dry.json.errors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ line: 2, code: 'unknown_category', values: { category: 'nothing' } }),
				expect.objectContaining({ line: 2, code: 'unknown_brand', values: { brand: 'Nobody' } }),
				expect.objectContaining({ line: 3, code: 'no_name' }),
				expect.objectContaining({ line: 4, path: '/price', code: 'not_price', values: { currency: 'USD' } }),
				expect.objectContaining({ line: 4, code: 'not_stock' }),
				expect.objectContaining({ line: 4, code: 'not_true_false' }),
			]),
		);
		const refused = await shop.admin(staff, 'POST', '/v1/admin/csv/products', { csv: bad, dryRun: false });
		expect(refused.status).toBe(422);
		expect(refused.json.errors[0].path).toMatch(/^\/csv\/2\//);

		const good = [
			head,
			`Tablet,,active,phones,acme,big|new,"=1+1, said ""he""",TB-1,Color,Black,9.99,12.50,4,true`,
			'Tablet,,active,,,,,TB-2,Color,White,10,,0,true',
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
			options: [{ name: 'Color', values: ['Black', 'White'] }],
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
		// a product made by CSV has no earlier slugs; a slug changed by CSV is kept as one, as an edit keeps it (E13)
		expect(tablet.previousSlugs).toEqual([]);
		const renamed = exported.replace(/,tablet,/g, ',tablet-pro,');
		expect(await ok('POST', '/v1/csv/products', { csv: renamed, dryRun: false })).toMatchObject({ updated: 2, errors: [] });
		expect((await ok('GET', '/v1/products/tablet-pro')).previousSlugs).toEqual(['tablet']);
	});

	it('refuses files it cannot read', async () => {
		const send = (/** @type {unknown} */ csv) => api('POST', '/v1/csv/products', { csv, dryRun: false });
		expect((await send('')).status).toBe(422);
		expect((await send('name\n"open')).status).toBe(422);
		expect((await send('\n\n')).status).toBe(422);
		expect((await send(`name,price\n${'A,1\n'.repeat(5001)}`)).json.detail).toContain('5000');
		const columns = await api('POST', '/v1/csv/products', { csv: 'color\nred' });
		expect(columns.json.errors[0]).toMatchObject({ line: 1, code: 'columns' });
		const location = await api('POST', '/v1/csv/products', { csv: 'name,price,stock@loc_none\nA,1,1' });
		expect(location.json.errors[0]).toMatchObject({ path: '/stock@loc_none', code: 'unknown_location' });
		const plain = await api('POST', '/v1/csv/products', { csv: 'name,price,stock\nA,1,1' });
		expect(plain.json.errors[0].message).toContain('per location');
		const existing = await api('POST', '/v1/csv/products', { csv: 'sku,stock\nPH-1,3' });
		expect(existing.json.errors[0]).toMatchObject({ code: 'stock_per_location' });
		expect(existing.json.errors[0].message).toContain('per location');
		const clash = await api('POST', '/v1/csv/products', {
			csv: `product_id,sku,price\nprd_none,X,1\n${ids.phone.id},TB-1,1\n,,1`,
		});
		expect(clash.json.errors.map((/** @type {any} */ e) => [e.path, e.code])).toEqual([
			['/product_id', 'unknown_product'],
			['/sku', 'sku_taken'],
			['/variants', 'invalid'],
			['/name', 'no_name'],
		]);
		const twice = await api('POST', '/v1/csv/products', {
			csv: 'name,slug,sku,price\nA,a-one,Q1,1\nB,b-one,Q1,1\nC,tablet,Q2,1',
		});
		expect(twice.json.errors.map((/** @type {any} */ e) => e.message)).toEqual(
			expect.arrayContaining(['The SKU Q1 is in two products of the file.']),
		);
		expect(twice.json.errors).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: 'sku_twice', values: { sku: 'Q1' } })]),
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
			address: { city: 'Berlin', region: 'Berlin', country: 'DE' },
			lines: [
				{ name: 'Phone', variantName: 'Black', sku: 'PH-1', quantity: 2, unitPrice: 1050, discount: 100, total: 2000 },
				{ name: '@Case', variantName: '', sku: '', quantity: 1, unitPrice: 500, discount: 0, total: 500 },
			],
			totals: { currency: 'USD' },
			payment: { method: 'cod', kind: 'on_delivery', state: 'paid' },
		});
		await data
			.collection(COLLECTIONS.orders)
			.insertMany([order('2026-000001', '2026-09-01T10:00:00Z'), order('2026-000002', '2026-10-01T10:00:00Z')]);
		const answer = await shop.api('GET', '/v1/csv/orders?from=2026-09-15&to=2026-12-31&status=delivered');
		expect([...answer.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
		const lines = answer.text.trim().split('\r\n');
		expect(lines[0]).toBe(
			'number,placed_at,status,customer,city,region,country,product,variant,sku,quantity,unit_price,discount,total,currency,payment_method,payment_state,tags',
		);
		expect(lines.slice(1)).toEqual([
			'2026-000002,2026-10-01T10:00:00.000Z,delivered,Sara,Berlin,Berlin,DE,Phone,Black,PH-1,2,10.50,1.00,20.00,USD,cod,paid,',
			"2026-000002,2026-10-01T10:00:00.000Z,delivered,Sara,Berlin,Berlin,DE,'@Case,,,1,5.00,0.00,5.00,USD,cod,paid,",
		]);
		expect((await shop.api('GET', '/v1/csv/orders?from=yesterday')).status).toBe(422);
		// the file takes the filters it documents: the list's polling filters are not among them
		const polled = await shop.api('GET', '/v1/csv/orders?createdAfter=2099-01-01T00:00:00Z&unseen=1');
		expect(polled.text.trim().split('\r\n')).toHaveLength(5);
		const staff = await shop.ticket(['csv.run', 'orders.read']);
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
		const staff = await shop.ticket(['bulk.run', 'catalog.edit']);
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
		expect((await run({ action: 'status', status: 'active' })).json).toEqual({
			matched: 2,
			changed: 2,
			missing: [],
			refused: [],
		});
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
		expect(missing.json).toEqual({ matched: 1, changed: 1, missing: ['prd_none'], refused: [] });
	});
});

describe('bulk edit any field (E23)', () => {
	it('sets the brand, tags, item type, compare-at price and any field of many products', async () => {
		const staff = await shop.ticket(['bulk.run', 'catalog.edit']);
		const material = await ok('POST', '/v1/attributes', { name: 'Material', slug: 'material' });
		const finish = await ok('POST', '/v1/attributes', {
			name: 'Finish',
			slug: 'finish',
			on: 'variant',
			type: 'choice',
			choices: ['matte', 'gloss'],
			show: { page: false },
		});
		const a = await ok('POST', '/v1/products', { name: 'Edit A', price: 1000, locations: { [ids.store.id]: 0 } });
		const b = await ok('POST', '/v1/products', {
			name: 'Edit B',
			options: [{ name: 'Size', values: ['S', 'M'] }],
			variants: [
				{ options: { Size: 'S' }, price: 500, locations: {} },
				{ options: { Size: 'M' }, price: 800, locations: {} },
			],
		});
		const both = [a.id, b.id];
		/** @param {Record<string, unknown>} body */
		const run = (body) => shop.admin(staff, 'POST', '/v1/admin/products/bulk', { ids: both, ...body });
		/** @param {string} id */
		const read = (id) => ok('GET', `/v1/products/${id}`);
		// brand
		expect((await run({ action: 'brand', brandId: ids.acme.id })).json).toMatchObject({ changed: 2, refused: [] });
		expect((await read(b.id)).brandId).toBe(ids.acme.id);
		expect((await run({ action: 'brand', brandId: 'brd_none' })).status).toBe(422);
		await run({ action: 'brand', brandId: null });
		expect((await read(a.id)).brandId).toBeNull();
		// tags
		await run({ action: 'add_tags', tags: ['sale', ' new '] });
		expect((await read(a.id)).tags).toEqual(['sale', 'new']);
		expect((await run({ action: 'add_tags', tags: ['sale'] })).json.changed).toBe(0);
		await run({ action: 'remove_tags', tags: ['sale'] });
		expect((await read(b.id)).tags).toEqual(['new']);
		expect((await run({ action: 'add_tags', tags: [] })).status).toBe(422);
		// item type
		await run({ action: 'item_type', typeKey: 'typed' });
		expect((await read(a.id)).typeKey).toBe('typed');
		expect((await run({ action: 'item_type', typeKey: 'nope' })).status).toBe(422);
		await run({ action: 'item_type', typeKey: null });
		expect((await read(a.id)).typeKey).toBeNull();
		// compare-at price: a percent above the price, a set amount, cleared
		await run({ action: 'compare_at_price', compareAt: { mode: 'percent', value: 20 } });
		expect((await read(b.id)).variants.map((/** @type {any} */ v) => v.compareAtPrice)).toEqual([600, 960]);
		await run({ action: 'compare_at_price', compareAt: { mode: 'set', value: 1500 } });
		expect((await read(a.id)).variants[0].compareAtPrice).toBe(1500);
		await run({ action: 'compare_at_price', compareAt: { mode: 'clear' } });
		expect((await read(a.id)).variants[0].compareAtPrice).toBeNull();
		expect((await run({ action: 'compare_at_price', compareAt: { mode: 'percent', value: -5 } })).status).toBe(422);
		// a product field by slug, a variant field by id on every variant, cleared with null
		await run({ action: 'field', field: 'material', value: 'Steel' });
		expect((await read(a.id)).specs).toEqual({ [material.id]: 'Steel' });
		await run({ action: 'field', field: finish.id, value: 'matte' });
		expect((await read(b.id)).variants.map((/** @type {any} */ v) => v.attributes[finish.id])).toEqual(['matte', 'matte']);
		const refused = await run({ action: 'field', field: finish.id, value: 'shiny' });
		expect(refused.json.changed).toBe(0);
		expect(refused.json.refused.map((/** @type {any} */ r) => r.id).sort()).toEqual([...both].sort());
		await run({ action: 'field', field: 'material', value: null });
		expect((await read(a.id)).specs).toEqual({});
		expect((await run({ action: 'field', field: 'nothing', value: 'x' })).status).toBe(422);
	});
});

describe('staff filters and counts by filterable fields (E24)', () => {
	it('filters the staff list and counts products by any field marked filterable', async () => {
		const color = await ok('POST', '/v1/attributes', {
			name: 'Color',
			slug: 'color',
			type: 'choice',
			choices: ['red', 'blue'],
			show: { filter: true },
		});
		const size = await ok('POST', '/v1/attributes', { name: 'Size', slug: 'size', on: 'variant', show: { filter: true } });
		const secret = await ok('POST', '/v1/attributes', { name: 'Supplier', slug: 'supplier' });
		const one = await ok('POST', '/v1/products', {
			name: 'Facet one',
			price: 100,
			locations: {},
			specs: { [color.id]: 'red', [secret.id]: 'Acme' },
		});
		const two = await ok('POST', '/v1/products', {
			name: 'Facet two',
			specs: { [color.id]: 'blue' },
			variants: [
				{ price: 100, locations: {}, attributes: { [size.id]: 'L' } },
				{ price: 100, locations: {}, attributes: { [size.id]: 'M' }, sku: 'FT-M' },
			],
		});
		const three = await ok('POST', '/v1/products', { name: 'Facet three', price: 100, locations: {} });
		const ids = `ids=${one.id},${two.id},${three.id}`;
		/** @param {string} path */
		const listed = async (path) => (await ok('GET', path)).items.map((/** @type {any} */ p) => p.id).sort();
		expect(await listed(`/v1/products?${ids}&attr.color=red`)).toEqual([one.id]);
		expect(await listed(`/v1/products?${ids}&attr.color=red,blue`)).toEqual([one.id, two.id].sort());
		expect(await listed(`/v1/products?${ids}&attr.${size.id}=M`)).toEqual([two.id]);
		// a field not marked filterable filters nothing in
		expect(await listed(`/v1/products?${ids}&attr.supplier=Acme`)).toEqual([]);
		expect(await ok('GET', `/v1/products/count?${ids}&attr.color=blue`)).toEqual({ count: 1, capped: false });
		const byColor = await ok('GET', `/v1/products/counts?${ids}&by=attr.color`);
		expect(byColor).toEqual({ total: 3, groups: { red: 1, blue: 1, none: 1 } });
		const bySize = await ok('GET', `/v1/products/counts?${ids}&by=attr.size`);
		expect(bySize).toEqual({ total: 3, groups: { L: 1, M: 1, none: 2 } });
		// with another filter
		expect(await ok('GET', `/v1/products/counts?${ids}&attr.color=blue&by=attr.size`)).toEqual({
			total: 1,
			groups: { L: 1, M: 1 },
		});
		expect((await api('GET', `/v1/products/counts?${ids}&by=attr.supplier`)).status).toBe(422);
		const staff = await shop.ticket(['catalog.edit']);
		expect((await shop.admin(staff, 'GET', `/v1/admin/products/counts?${ids}&by=attr.color`)).json.groups.red).toBe(1);
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
			options: [{ name: 'Color', values: ['Black'] }],
			variants: [{ options: { Color: 'Black' }, price: 100 }],
		});
		const path = `/v1/admin/products/${item.id}/ai-copy`;
		expect((await shop.admin(staff, 'POST', path, { fields: ['description'] })).status).toBe(503);
		await shop.connect('ai', { provider: 'compatible', baseUrl: AI, apiKey: 'sk-test-123456', model: 'm' });
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

	it('the AI key is the Portal’s: delivered and tested here, never saved or removed in Ecommerce', async () => {
		const small = await setup();
		await small.switchOn(['catalog', 'ai_copy']);
		const owner = await small.adminSession();
		const base = `/v1/dashboard/websites/${small.websiteId}/connections`;
		const item = async () =>
			(await small.dashboard(owner, 'GET', base)).json.connections.find(
				(/** @type {{ name: string }} */ c) => c.name === 'ai',
			);
		expect(await item()).toMatchObject({ managed: true, set: false, status: 'not_connected', neededBy: ['ai_copy'] });
		for (const [method, body] of /** @type {const} */ ([
			['PUT', { value: { provider: 'compatible', baseUrl: AI, apiKey: 'sk-test-123456', model: 'm' } }],
			['DELETE', undefined],
		])) {
			const attempt = await small.dashboard(owner, method, `${base}/ai`, body);
			expect([method, attempt.status, String(attempt.json.type).split('/').pop()]).toEqual([method, 409, 'managed_by_portal']);
		}
		await small.connect('ai', { provider: 'compatible', baseUrl: AI, apiKey: 'sk-test-123456', model: 'm' });
		expect(await item()).toMatchObject({ managed: true, set: true, status: 'connected' });
		// a key the provider refuses is kept and reported, not hidden
		small.responders.set(`${AI}/models`, () => ({ status: 401, body: {} }));
		await small.connect('ai', { provider: 'compatible', baseUrl: AI, apiKey: 'sk-test-refused-0123', model: 'm' });
		expect(await item()).toMatchObject({ managed: true, status: 'test_failed', message: 'The provider refused the key.' });
	});
});

describe('feature switches and connections', () => {
	it('refuses tools that are off and uploads without storage', async () => {
		const small = await setup();
		await small.switchOn(['catalog']);
		await small.connectDatabase();
		expect((await small.api('GET', '/v1/csv/products')).json.type).toContain('feature_off');
		expect((await small.api('GET', '/v1/locations')).json.type).toContain('feature_off');
		expect((await small.api('POST', '/v1/products', { name: 'A', price: 1, typeKey: 'used_phone' })).status).toBe(422);
		expect((await small.api('POST', '/v1/products', { name: 'A', kind: 'digital', price: 1 })).status).toBe(422);
		expect(
			(await small.api('POST', '/v1/products', { name: 'A', kind: 'service', price: 1, booking: { durationMinutes: 30 } }))
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

describe('the tool permissions do not open the data they work on (SR-5b-5)', () => {
	/** A server call with a staff sign-in that holds some permissions of this product. @param {string[]} keys @param {string} method @param {string} path @param {unknown} [body] */
	const asStaff = (keys, method, path, body) =>
		shop.call(method, path, {
			token: shop.server,
			staff: { permissions: keys.map((key) => `ecommerce:${key}`) },
			...(body === undefined ? {} : { body }),
		});
	const SEVERAL = () => [ids.phone.id];

	it('a file of orders, customers or products needs orders.read, customers.manage or catalog.edit as well', async () => {
		/** @type {[string, string][]} */
		const files = [
			['/v1/csv/orders', 'orders.read'],
			['/v1/csv/customers', 'customers.manage'],
			['/v1/csv/products', 'catalog.edit'],
		];
		for (const [path, needed] of files) {
			expect([path, (await asStaff(['csv.run'], 'GET', path)).status]).toEqual([path, 403]);
			// another object's permission does not help
			const other = files.find(([, key]) => key !== needed)?.[1] ?? '';
			expect([path, (await asStaff(['csv.run', other], 'GET', path)).status]).toEqual([path, 403]);
			expect([path, (await asStaff(['csv.run', needed], 'GET', path)).status]).toEqual([path, 200]);
		}
		// a ticket reads the same way
		const accountant = await shop.ticket(['csv.run']);
		for (const [path] of files)
			expect((await shop.admin(accountant, 'GET', path.replace('/v1/', '/v1/admin/'))).status).toBe(403);
	});

	it('an import of products needs catalog.edit as well, for a dry run too', async () => {
		const csv = 'name,price\nBlocked,1';
		expect((await asStaff(['csv.run'], 'POST', '/v1/csv/products', { csv })).status).toBe(403);
		expect((await asStaff(['csv.run'], 'POST', '/v1/csv/products', { csv, dryRun: false })).status).toBe(403);
		expect(
			(await shop.admin(await shop.ticket(['csv.run']), 'POST', '/v1/admin/csv/products', { csv, dryRun: false })).status,
		).toBe(403);
		expect((await asStaff(['csv.run', 'catalog.edit'], 'POST', '/v1/csv/products', { csv })).status).toBe(200);
	});

	it('a bulk action needs catalog.edit as well', async () => {
		const body = { ids: SEVERAL(), action: 'status', status: 'draft' };
		const refused = await asStaff(['bulk.run'], 'POST', '/v1/products/bulk', body);
		expect(refused.status).toBe(403);
		expect((await shop.admin(await shop.ticket(['bulk.run']), 'POST', '/v1/admin/products/bulk', body)).status).toBe(403);
		const allowed = await asStaff(['bulk.run', 'catalog.edit'], 'POST', '/v1/products/bulk', body);
		expect(allowed.status).toBe(200);
		await asStaff(['bulk.run', 'catalog.edit'], 'POST', '/v1/products/bulk', { ...body, status: 'active' });
	});
});
