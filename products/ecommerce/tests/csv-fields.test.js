/**
 * Merchant fields in the CSV files (E22): one `field:<slug>` column per product and variant field in the products file
 * (a product field's value on each of its variant rows, a variant field's per row), read back by an import that merges
 * them into the product's values (an empty cell clears one value, a column left out keeps it; the slug is the field
 * defined for the product's category, nearest first, else the one for every category); one per order field in both
 * orders files and one per customer field in the customers file (inactive fields too; unit fields stay out).
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS } from '../core/model.js';
import { ALL, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
/** @type {Record<string, any>} */
const ids = {};

/** @param {string} method @param {string} path @param {unknown} [body] */
const ok = async (method, path, body) => {
	const answer = await shop.api(method, path, body);
	if (answer.status >= 300) throw new Error(`${method} ${path}: ${answer.status} ${answer.text}`);
	return answer.json;
};

/** A CSV answer's lines as records by column. @param {string} text */
const recordsIn = (text) => {
	const [head = '', ...rest] = text.trim().split('\r\n');
	// trim drops the byte order mark too
	const header = head.split(',');
	return { header, rows: rest.map((line) => Object.fromEntries(line.split(',').map((cell, i) => [header[i], cell]))) };
};

beforeAll(async () => {
	shop = await readyShop({ features: ALL.filter((feature) => feature !== 'multi_location') });
	ids.dresses = await ok('POST', '/v1/categories', { name: 'Dresses' });
	ids.evening = await ok('POST', '/v1/categories', { name: 'Evening', parentId: ids.dresses.id });
	ids.shirts = await ok('POST', '/v1/categories', { name: 'Shirts' });
	ids.fabric = await ok('POST', '/v1/attributes', { name: 'Fabric', slug: 'fabric' });
	ids.dressFabric = await ok('POST', '/v1/attributes', {
		name: 'Dress fabric',
		slug: 'fabric',
		categoryId: ids.dresses.id,
		type: 'choice',
		choices: ['silk', 'linen'],
	});
	ids.waterproof = await ok('POST', '/v1/attributes', { name: 'Waterproof', slug: 'waterproof', type: 'yes_no' });
	ids.weight = await ok('POST', '/v1/attributes', { name: 'Weight', slug: 'weight', type: 'number', decimals: 1 });
	ids.features = await ok('POST', '/v1/attributes', {
		name: 'Features',
		slug: 'features',
		multiple: true,
		maxValues: 5,
	});
	ids.old = await ok('POST', '/v1/attributes', { name: 'Old', slug: 'old' });
	ids.length = await ok('POST', '/v1/attributes', {
		name: 'Length',
		slug: 'length',
		on: 'variant',
		type: 'number',
		show: { page: false },
	});
	ids.imei = await ok('POST', '/v1/attributes', { name: 'IMEI', slug: 'imei', on: 'unit' });
	ids.giftNote = await ok('POST', '/v1/attributes', { name: 'Gift note', slug: 'gift-note', on: 'order' });
	ids.poNumber = await ok('POST', '/v1/attributes', { name: 'PO number', slug: 'po-number', on: 'order' });
	ids.company = await ok('POST', '/v1/attributes', { name: 'Company', slug: 'company', on: 'customer' });
	ids.dress = await ok('POST', '/v1/products', {
		name: 'Gown',
		categoryIds: [ids.evening.id],
		specs: {
			[ids.dressFabric.id]: 'silk',
			[ids.waterproof.id]: true,
			[ids.weight.id]: 1.5,
			[ids.features.id]: ['lined', 'pockets'],
			[ids.old.id]: 'kept',
		},
		options: [{ name: 'Size', values: ['S', 'M'] }],
		variants: [
			{ options: { Size: 'S' }, sku: 'G-S', price: 1000, attributes: { [ids.length.id]: 140 } },
			{ options: { Size: 'M' }, sku: 'G-M', price: 1000 },
		],
	});
	ids.shirt = await ok('POST', '/v1/products', {
		name: 'Tee',
		categoryIds: [ids.shirts.id],
		specs: { [ids.fabric.id]: 'cotton' },
		sku: 'T-1',
		price: 500,
	});
	await ok('PATCH', `/v1/attributes/${ids.old.id}`, { active: false });
	await ok('PATCH', `/v1/attributes/${ids.poNumber.id}`, { active: false });
});
afterAll(async () => shop.product.close());

describe('products file', () => {
	it('has one column per product and variant field slug, before sold_out and updated_at', async () => {
		const { header, rows } = recordsIn((await shop.api('GET', '/v1/csv/products')).text);
		const fields = header.filter((column) => column.startsWith('field:'));
		// in the order of the fields (their sort, then name), one column per slug
		expect(fields).toEqual(['field:fabric', 'field:features', 'field:length', 'field:old', 'field:waterproof', 'field:weight']);
		expect(header.slice(-2)).toEqual(['sold_out', 'updated_at']);
		expect(header.indexOf('field:fabric')).toBeGreaterThan(header.indexOf('active'));
		const bySku = (/** @type {string} */ sku) => rows.find((row) => row.sku === sku);
		const [small, medium, tee] = [bySku('G-S'), bySku('G-M'), bySku('T-1')];
		// a product field's value on each variant row, a variant field's per row; several values joined with |
		expect(small).toMatchObject({
			sku: 'G-S',
			'field:fabric': 'silk',
			'field:waterproof': 'true',
			'field:weight': '1.5',
			'field:features': 'lined|pockets',
			'field:old': 'kept',
			'field:length': '140',
		});
		expect(medium).toMatchObject({ sku: 'G-M', 'field:fabric': 'silk', 'field:features': 'lined|pockets', 'field:length': '' });
		expect(tee).toMatchObject({ sku: 'T-1', 'field:fabric': 'cotton', 'field:waterproof': '', 'field:length': '' });
	});

	it('imports field columns into the values, keeping the others', async () => {
		const csv = [
			'sku,field:fabric,field:weight,field:features,field:length',
			'G-S,linen,2,lined|belt|hood,150',
			'G-M,linen,2,lined|belt|hood,',
			'T-1,linen,,,',
		].join('\n');
		const dry = await ok('POST', '/v1/csv/products', { csv });
		expect(dry).toMatchObject({ created: 0, updated: 2, errors: [] });
		expect(await ok('POST', '/v1/csv/products', { csv, dryRun: false })).toMatchObject({ updated: 2, errors: [] });
		const dress = await ok('GET', `/v1/products/${ids.dress.id}`);
		// the dress takes the fabric of its category's definition; the columns left out keep their values
		expect(dress.specs).toEqual({
			[ids.dressFabric.id]: 'linen',
			[ids.waterproof.id]: true,
			[ids.weight.id]: 2,
			[ids.features.id]: ['lined', 'belt', 'hood'],
			[ids.old.id]: 'kept',
		});
		expect(dress.variants.map((/** @type {any} */ v) => v.attributes)).toEqual([{ [ids.length.id]: 150 }, {}]);
		// the shirt takes the definition for every category; its empty cells clear a value it did not have
		expect((await ok('GET', `/v1/products/${ids.shirt.id}`)).specs).toEqual({ [ids.fabric.id]: 'linen' });
		// an empty cell clears that one value
		await ok('POST', '/v1/csv/products', { csv: 'sku,field:weight,field:waterproof\nG-S,,false', dryRun: false });
		expect((await ok('GET', `/v1/products/${ids.dress.id}`)).specs).toEqual({
			[ids.dressFabric.id]: 'linen',
			[ids.waterproof.id]: false,
			[ids.features.id]: ['lined', 'belt', 'hood'],
			[ids.old.id]: 'kept',
		});
		// an export imports back unchanged
		const exported = (await shop.api('GET', '/v1/csv/products')).text;
		expect(await ok('POST', '/v1/csv/products', { csv: exported, dryRun: false })).toMatchObject({ errors: [] });
		expect((await ok('GET', `/v1/products/${ids.dress.id}`)).specs[ids.features.id]).toEqual(['lined', 'belt', 'hood']);
		// a new product takes field values too
		await ok('POST', '/v1/csv/products', {
			csv: `name,categories,price,field:fabric,field:waterproof\nNew dress,${ids.dresses.slug},10,silk,yes`,
			dryRun: false,
		});
		expect((await ok('GET', '/v1/products/new-dress')).specs).toEqual({
			[ids.dressFabric.id]: 'silk',
			[ids.waterproof.id]: true,
		});
	});

	it('refuses unknown field columns and values that do not fit the field', async () => {
		const unknown = await ok('POST', '/v1/csv/products', { csv: 'sku,field:nothing,field:imei\nT-1,a,b' });
		expect(unknown.errors).toEqual([
			expect.objectContaining({ line: 1, path: '/field:nothing', code: 'unknown_field', values: { field: 'nothing' } }),
			expect.objectContaining({ line: 1, path: '/field:imei', code: 'unknown_field', values: { field: 'imei' } }),
		]);
		const bad = await ok('POST', '/v1/csv/products', {
			csv: [
				'sku,field:fabric,field:waterproof,field:weight,field:length',
				'G-S,wool,maybe,1.25,x',
				'G-M,silk,true,1,9',
				'T-1,cotton,,heavy,',
			].join('\n'),
		});
		expect(bad.errors.map((/** @type {any} */ e) => [e.line, e.path, e.code, e.values])).toEqual([
			[2, '/field:waterproof', 'field_value', { field: 'waterproof' }],
			[2, '/field:length', 'field_value', { field: 'length' }],
			[2, '/field:fabric', 'field_value', { field: 'fabric' }],
			[2, '/field:weight', 'field_value', { field: 'weight' }],
			[4, '/field:weight', 'field_value', { field: 'weight' }],
		]);
		const refused = await shop.api('POST', '/v1/csv/products', {
			csv: 'sku,field:waterproof\nG-S,maybe',
			dryRun: false,
		});
		expect(refused.status).toBe(422);
	});
});

describe('orders and customers files', () => {
	it('have one column per order or customer field, inactive ones too', async () => {
		const data = await shop.db();
		const customerId = createId('cus');
		await data.collection(COLLECTIONS.customers).insertOne({
			id: customerId,
			userId: null,
			guest: true,
			name: 'Ana',
			email: 'ana@example.com',
			phone: '',
			fields: { [ids.company.id]: 'Acme Inc' },
		});
		await data.collection(COLLECTIONS.orders).insertOne({
			id: createId('ord'),
			number: 'F-1',
			idempotencyKey: 'F-1',
			placedAt: new Date('2026-10-01T10:00:00Z'),
			status: 'delivered',
			customer: { userId: null, customerId, name: 'Ana', email: 'ana@example.com', phone: '' },
			address: { city: 'Lima' },
			lines: [
				{ name: 'Gown', variantName: 'S', sku: 'G-S', quantity: 1, unitPrice: 1000, discount: 0, total: 1000 },
				{ name: 'Tee', variantName: '', sku: 'T-1', quantity: 1, unitPrice: 500, discount: 0, total: 500 },
			],
			totals: { currency: 'USD', subtotal: 1500, total: 1500 },
			payment: { method: 'cod', state: 'paid', paid: 1500, refunded: 0 },
			fields: { [ids.giftNote.id]: 'Happy day', [ids.poNumber.id]: 'PO-7' },
		});
		const lines = recordsIn((await shop.api('GET', '/v1/csv/orders')).text);
		expect(lines.header.slice(-2)).toEqual(['field:gift-note', 'field:po-number']);
		expect(lines.rows.map((row) => [row.sku, row['field:gift-note'], row['field:po-number']])).toEqual([
			['G-S', 'Happy day', 'PO-7'],
			['T-1', 'Happy day', 'PO-7'],
		]);
		const perOrder = recordsIn((await shop.api('GET', '/v1/csv/orders?per=order')).text);
		expect(perOrder.header.slice(-2)).toEqual(['field:gift-note', 'field:po-number']);
		expect(perOrder.rows[0]).toMatchObject({ number: 'F-1', 'field:gift-note': 'Happy day', 'field:po-number': 'PO-7' });
		const customers = recordsIn((await shop.api('GET', '/v1/csv/customers')).text);
		expect(customers.header.filter((column) => column.startsWith('field:'))).toEqual(['field:company']);
		expect(customers.rows[0]).toMatchObject({ name: 'Ana', 'field:company': 'Acme Inc' });
	});
});
