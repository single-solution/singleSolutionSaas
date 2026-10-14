/**
 * The catalog's product routes as schemas/api.json describes them: the catalog admin widget's twins (create, count,
 * the variant generator, stock, images, the products CSV), deleting with the server token, and the staff view of a
 * product saved before its newer fields existed (every field answered). The helper's `call()` checks every answer
 * against the description.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS } from '../core/model.js';
import { ALL, STORAGE, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
/** @type {string} */
let staff;

beforeAll(async () => {
	shop = await readyShop({ features: ALL.filter((feature) => feature !== 'multi_location') });
	staff = await shop.ticket(['catalog.edit', 'csv.run']);
});
afterAll(async () => shop.product.close());

/** @param {string} method @param {string} path @param {unknown} [body] */
const admin = (method, path, body) => shop.admin(staff, method, path, body);

/** The bucket answers HEAD with a PNG of 2,000 bytes. */
const bucket = () =>
	shop.responders.set(STORAGE, (call) =>
		call.method === 'HEAD'
			? { status: 200, headers: { 'content-length': '2000', 'content-type': 'image/png' } }
			: { status: 204 },
	);

describe('the catalog admin widget', () => {
	it('creates and counts products, adds their missing variants and changes their stock', async () => {
		const size = await shop.api('POST', '/v1/attributes', {
			name: 'Size',
			type: 'choice',
			on: 'variant',
			choices: ['S', 'M', 'L'],
		});
		expect(size.status).toBe(201);
		const made = await admin('POST', '/v1/admin/products', {
			name: 'Tee',
			status: 'active',
			variants: [{ attributes: { [size.json.id]: 'S' }, price: 1500, stock: 2, sku: 'TEE-S' }],
			attributeSetup: [{ attributeId: size.json.id, values: ['S', 'M'] }],
		});
		expect(made.status).toBe(201);
		expect(made.json).toMatchObject({
			name: 'Tee',
			slug: 'tee',
			status: 'active',
			price: 1500,
			priceMax: 1500,
			inStock: true,
			stockState: 'full',
			options: [{ name: 'Size', values: ['S'] }],
			featured: false,
			previousSlugs: [],
			media: [],
		});
		const id = made.json.id;
		expect(await admin('GET', '/v1/admin/products/count?status=active')).toMatchObject({
			status: 200,
			json: { count: 1, capped: false },
		});

		const one = await admin('POST', `/v1/admin/products/${id}/variants/generate`, { price: null, stock: 1 });
		expect(one.status).toBe(200);
		expect(one.json.added).toBe(1);
		expect(one.json.product.variants.map((/** @type {any} */ v) => [v.options.Size, v.price, v.stock])).toEqual([
			['S', 1500, 2],
			['M', 1500, 1],
		]);
		await shop.api('PATCH', `/v1/products/${id}`, { attributeSetup: [{ attributeId: size.json.id, values: ['S', 'M', 'L'] }] });
		const many = await admin('POST', '/v1/admin/products/variants/generate', { ids: [id, 'prd_none'], price: 1800 });
		expect(many.json).toEqual({
			results: [
				{ id, added: 1 },
				{ id: 'prd_none', error: 'There is no such product.', code: 'not_found' },
			],
			added: 1,
		});

		const [small, medium] = one.json.product.variants;
		const stock = await admin('POST', `/v1/admin/products/${id}/stock`, {
			changes: [
				{ variantId: small.id, adjust: 3 },
				{ variantId: medium.id, soldOut: true },
			],
		});
		expect(stock.status).toBe(200);
		expect(stock.json.variants.map((/** @type {any} */ v) => [v.stock, v.soldOut])).toEqual([
			[5, false],
			[1, true],
			[0, false],
		]);
		expect(stock.json).toMatchObject({ stockState: 'partial', priceMax: 1800, inStock: true });

		const removed = await shop.api('DELETE', `/v1/products/${id}`);
		expect(removed.status).toBe(204);
		expect(removed.text).toBe('');
		expect((await shop.api('GET', `/v1/products/${id}`)).status).toBe(404);
	});

	it('reorders and removes product images', async () => {
		const item = await shop.api('POST', '/v1/products', { name: 'Case', price: 500, stock: 3 });
		const id = item.json.id;
		/** @returns {Promise<string>} */
		const upload = async () =>
			(await admin('POST', '/v1/admin/catalog/uploads', { for: 'product', id, type: 'image/png', size: 2000 })).json.key;
		const [front, back] = [await upload(), await upload()];
		bucket();
		await admin('POST', `/v1/admin/products/${id}/media`, { key: front, alt: 'Front' });
		await admin('POST', `/v1/admin/products/${id}/media`, { key: back });
		const arranged = await admin('PUT', `/v1/admin/products/${id}/media`, {
			items: [
				{ key: back, alt: 'Back', width: 800, height: 600 },
				{ key: front, alt: 'Front side' },
			],
		});
		expect(arranged.status).toBe(200);
		expect(arranged.json.media).toMatchObject([
			{ key: back, alt: 'Back', width: 800, height: 600, type: 'image/png', size: 2000 },
			{ key: front, alt: 'Front side' },
		]);
		expect(arranged.json.media[0].url).toContain(STORAGE);
		const removed = await admin('DELETE', `/v1/admin/products/${id}/media?key=${encodeURIComponent(back)}`);
		expect(removed.status).toBe(200);
		expect(removed.json.media.map((/** @type {any} */ file) => file.key)).toEqual([front]);
		expect((await shop.api('GET', `/v1/products/${id}`)).json.media).toMatchObject([{ key: front, alt: 'Front side' }]);
	});

	it('exports the products as CSV', async () => {
		await shop.api('POST', '/v1/products', { name: 'Charger', price: 900, stock: 4, sku: 'CHG-1' });
		const answer = await admin('GET', '/v1/admin/csv/products');
		expect(answer.status).toBe(200);
		expect(answer.headers.get('content-type')).toContain('text/csv');
		expect(answer.headers.get('content-disposition')).toContain('products.csv');
		expect(answer.text).toContain('CHG-1');
	});
});

describe('GTIN and MPN (SEO audit G5.6)', () => {
	it("keeps each variant's barcode number and part number, checked, in the API, the CSV and structured data", async () => {
		const made = await shop.api('POST', '/v1/products', {
			name: 'Scanner',
			status: 'active',
			price: 4500,
			stock: 3,
			sku: 'SCN-1',
			gtin: '5 901234 123457',
			mpn: ' SC-100 ',
		});
		expect(made.status).toBe(201);
		expect(made.json.variants[0]).toMatchObject({ sku: 'SCN-1', gtin: '5901234123457', mpn: 'SC-100' });
		const variantId = made.json.variants[0].id;
		const wrong = await shop.api('PATCH', `/v1/products/${made.json.id}`, {
			variants: [{ id: variantId, gtin: '5901234123458', mpn: 'x'.repeat(71) }],
		});
		expect(wrong.status).toBe(422);
		expect(wrong.json.errors.map((/** @type {any} */ error) => error.path)).toEqual(['/variants/0/gtin', '/variants/0/mpn']);
		// the structured data names them on the product
		const page = await shop.api('GET', `/v1/seo/products/${made.json.id}`);
		expect(JSON.parse(page.json.jsonLd)['@graph'][0]).toMatchObject({ gtin: '5901234123457', mpn: 'SC-100' });
		// the products CSV has the columns; an empty cell clears, a typed one sets
		const file = await admin('GET', '/v1/admin/csv/products');
		const [header, ...rows] = file.text
			.replace(/^\uFEFF/, '')
			.trim()
			.split('\r\n');
		expect(header).toContain('variant_id,sku,gtin,mpn,option1_name');
		expect(rows.find((row) => row.includes('SCN-1'))).toContain('SCN-1,5901234123457,SC-100,');
		const imported = await admin('POST', '/v1/admin/csv/products', {
			csv: `product_id,variant_id,gtin,mpn\n${made.json.id},${variantId},,SC-200`,
			dryRun: false,
		});
		expect(imported.json).toMatchObject({ updated: 1, errors: [] });
		const read = await shop.api('GET', `/v1/products/${made.json.id}`);
		expect(read.json.variants[0].gtin).toBeUndefined();
		expect(read.json.variants[0].mpn).toBe('SC-200');
		const refused = await admin('POST', '/v1/admin/csv/products', {
			csv: `product_id,variant_id,gtin\n${made.json.id},${variantId},123`,
		});
		expect(refused.json.errors).toEqual([expect.objectContaining({ line: 2, path: '/variants/0/gtin', code: 'invalid' })]);
	});
});

describe('the staff view of a product', () => {
	it('answers every field of a product saved before the newer fields existed', async () => {
		const seeded = await shop.seedProduct({ name: 'Old phone' });
		const read = await shop.api('GET', `/v1/products/${seeded.id}`);
		expect(read.status).toBe(200);
		expect(read.json).toMatchObject({
			id: seeded.id,
			featured: false,
			descriptionHtml: '',
			video: null,
			sizeChartId: null,
			hideSizeGuide: false,
			attributeSetup: [],
			faqs: [],
			previousSlugs: [],
			seo: { title: '', description: '', canonicalUrl: '', ogImage: '', noindex: false, nofollow: false, focusKeyword: '' },
			price: 1000,
			priceMax: 1000,
			stockState: 'full',
			grades: [],
		});
		expect(read.json.variants[0]).toMatchObject({ attributes: {}, media: [], soldOut: false, warrantyDays: null, stock: 10 });

		// a change keeps the defaults of the fields it does not name (never null)
		const changed = await shop.api('PATCH', `/v1/products/${seeded.id}`, { name: 'Older phone' });
		expect(changed.json).toMatchObject({ name: 'Older phone', featured: false, hideSizeGuide: false });
		const stored = await (
			await shop.db()
		)
			.collection(COLLECTIONS.products)
			.findOne({ websiteId: shop.websiteId, id: seeded.id });
		expect(stored).toMatchObject({ featured: false, hideSizeGuide: false });
	});
});
