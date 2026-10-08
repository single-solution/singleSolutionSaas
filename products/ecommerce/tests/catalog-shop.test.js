/**
 * The catalog for shoppers (PLAN 0.8.8 Shopper widgets): the product grid's listing with search, filters, sorts and
 * facets, the product page, the category tree and brands, and the widget settings.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
/** @type {Record<string, any>} */
const ids = {};

/** @param {string} method @param {string} path @param {unknown} [body] */
const api = async (method, path, body) => {
	const answer = await shop.api(method, path, body);
	if (answer.status >= 300) throw new Error(`${method} ${path}: ${answer.status} ${answer.text}`);
	return answer.json;
};
/** @param {string} path */
const get = (path) => shop.visitor('GET', path);
/** @param {any} answer */
const names = (answer) => answer.json.items.map((/** @type {any} */ item) => item.name);

beforeAll(async () => {
	shop = await readyShop({ features: ALL.filter((feature) => feature !== 'multi_location') });
	await shop.list('grades', [
		{ key: 'new', label: 'New', description: 'Sealed box' },
		{ key: 'used', label: 'Used', description: 'Light marks' },
	]);
	await shop.setting('catalog', 'mediaBaseUrl', 'https://cdn.shop.example.com/');
	const phones = await api('POST', '/v1/categories', { name: 'Phones', description: 'Phones text' });
	const android = await api('POST', '/v1/categories', { name: 'Android', parentId: phones.id });
	const cases = await api('POST', '/v1/categories', { name: 'Cases', sort: 5 });
	const acme = await api('POST', '/v1/brands', { name: 'Acme' });
	const ram = await api('POST', '/v1/attributes', { name: 'RAM', type: 'number', unit: 'GB', filterable: true, sort: 1 });
	const colour = await api('POST', '/v1/attributes', {
		name: 'Colour',
		type: 'choice',
		choices: ['Black', 'Blue'],
		filterable: true,
		sort: 2,
	});
	const fiveG = await api('POST', '/v1/attributes', { name: '5G', type: 'boolean', filterable: true, sort: 3 });
	const note = await api('POST', '/v1/attributes', { name: 'Note', type: 'text' });
	Object.assign(ids, { phones, android, cases, acme, ram, colour, fiveG, note });
	ids.pixel = await api('POST', '/v1/products', {
		name: 'Pixel 9',
		status: 'active',
		summary: 'Fast phone',
		categoryIds: [android.id],
		brandId: acme.id,
		specs: { [ram.id]: 8, [colour.id]: 'Black', [fiveG.id]: true, [note.id]: 'Nice' },
		options: [{ name: 'Storage', values: ['128 GB', '256 GB'] }],
		variants: [
			{ sku: 'PX-128', options: { Storage: '128 GB' }, price: 70000, compareAtPrice: 75000, stock: 3, grade: 'new' },
			{ sku: 'PX-256', options: { Storage: '256 GB' }, price: 80000, stock: 0, grade: 'used' },
		],
	});
	shop.advance(1000);
	ids.galaxy = await api('POST', '/v1/products', {
		name: 'Galaxy S',
		status: 'active',
		categoryIds: [phones.id],
		tags: ['samsung'],
		specs: { [ram.id]: 12, [colour.id]: 'Blue', [fiveG.id]: false },
		price: 90000,
		stock: 0,
	});
	shop.advance(1000);
	ids.case = await api('POST', '/v1/products', {
		name: 'Clear case',
		status: 'active',
		categoryIds: [cases.id],
		price: 1500,
		stock: 10,
	});
	shop.advance(1000);
	ids.draft = await api('POST', '/v1/products', { name: 'Secret phone', status: 'draft', categoryIds: [phones.id], price: 100 });
	await shop.seedProduct({ name: 'Bestseller', sold: 50, rating: { average: 4.5, count: 10 }, price: 5000, slug: 'bestseller' });
});
afterAll(async () => shop.product.close());

describe('the product grid', () => {
	it('lists active products, newest first, with cards and facets', async () => {
		const answer = await get('/v1/shop/products');
		expect(answer.status).toBe(200);
		expect(names(answer)).toEqual(['Bestseller', 'Clear case', 'Galaxy S', 'Pixel 9']);
		const pixel = answer.json.items[3];
		expect(pixel).toMatchObject({
			id: ids.pixel.id,
			slug: 'pixel-9',
			price: 70000,
			compareAtPrice: 75000,
			currency: 'USD',
			image: null,
			url: 'https://shop.example.com/products/pixel-9',
			inStock: true,
			brand: { id: ids.acme.id, name: 'Acme' },
			grades: ['New', 'Used'],
			variantCount: 2,
		});
		expect(pixel).not.toHaveProperty('stock');
		const { facets } = answer.json;
		expect(facets.price).toEqual({ min: 1500, max: 90000 });
		expect(facets.brands).toEqual([{ id: ids.acme.id, slug: 'acme', name: 'Acme', count: 1 }]);
		expect(facets.categories.map((/** @type {any} */ c) => c.name).sort()).toEqual(['Android', 'Cases', 'Phones']);
		expect(facets.attributes.map((/** @type {any} */ a) => a.name)).toEqual(['RAM', 'Colour', '5G']);
		expect(facets.attributes[0].values).toEqual([
			{ value: 8, count: 1 },
			{ value: 12, count: 1 },
		]);
		expect(facets.grades).toEqual([
			{ key: 'new', label: 'New', count: 1 },
			{ key: 'used', label: 'Used', count: 1 },
		]);
	});

	it('searches, filters and sorts', async () => {
		expect(names(await get('/v1/shop/products?q=pixel'))).toEqual(['Pixel 9']);
		expect(names(await get('/v1/shop/products?q=px-256'))).toEqual(['Pixel 9']);
		expect(names(await get('/v1/shop/products?q=SAMSUNG'))).toEqual(['Galaxy S']);
		expect(names(await get('/v1/shop/products?q=fast%20phone'))).toEqual(['Pixel 9']);
		expect(names(await get('/v1/shop/products?q=secret'))).toEqual([]);
		expect(names(await get(`/v1/shop/products?category=phones&sort=name`))).toEqual(['Galaxy S', 'Pixel 9']);
		expect(names(await get(`/v1/shop/products?category=${ids.android.id}`))).toEqual(['Pixel 9']);
		expect(names(await get('/v1/shop/products?category=nothing'))).toEqual([]);
		expect(names(await get('/v1/shop/products?brand=acme'))).toEqual(['Pixel 9']);
		expect(names(await get('/v1/shop/products?brand=nobody'))).toEqual([]);
		expect(names(await get('/v1/shop/products?minPrice=5000&maxPrice=80000&sort=price_asc'))).toEqual([
			'Bestseller',
			'Pixel 9',
		]);
		expect(names(await get('/v1/shop/products?inStock=true&sort=price_desc'))).toEqual(['Pixel 9', 'Bestseller', 'Clear case']);
		expect(names(await get(`/v1/shop/products?attr.${ids.ram.id}=12`))).toEqual(['Galaxy S']);
		expect(names(await get(`/v1/shop/products?attr.${ids.colour.id}=Black,Blue&sort=name`))).toEqual(['Galaxy S', 'Pixel 9']);
		expect(names(await get(`/v1/shop/products?attr.${ids.fiveG.id}=true`))).toEqual(['Pixel 9']);
		expect(names(await get('/v1/shop/products?attr.att_none=1'))).toEqual([]);
		expect(names(await get('/v1/shop/products?grade=used'))).toEqual(['Pixel 9']);
		expect(names(await get('/v1/shop/products?sort=top')).at(0)).toBe('Bestseller');
		expect(names(await get('/v1/shop/products?sort=rating')).at(0)).toBe('Bestseller');
		expect((await get('/v1/shop/products?sort=random')).status).toBe(422);
		expect((await get('/v1/shop/products?minPrice=abc')).status).toBe(422);
		expect((await get('/v1/shop/products?limit=49')).status).toBe(400);
		expect((await get('/v1/shop/products?cursor=eyJrIjoiYSJ9')).status).toBe(400);
	});

	it('pages through a listing without skipping or repeating', async () => {
		for (const sort of ['newest', 'price_asc', 'price_desc', 'top', 'rating', 'name']) {
			/** @type {string[]} */
			const seen = [];
			let next = null;
			let pages = 0;
			do {
				const answer = await get(`/v1/shop/products?sort=${sort}&limit=1${next ? `&cursor=${next}` : ''}`);
				expect(answer.status).toBe(200);
				if (next) expect(answer.json.facets).toBeNull();
				seen.push(...names(answer));
				next = answer.json.next;
				pages += 1;
			} while (next && pages < 10);
			expect(seen.sort()).toEqual(['Bestseller', 'Clear case', 'Galaxy S', 'Pixel 9']);
		}
	});

	it('shows images from the public address and the page size', async () => {
		await shop.setting('catalog', 'pageSize', 2);
		const data = await shop.db();
		await data
			.collection('products')
			.updateOne(
				{ websiteId: shop.websiteId, id: ids.case.id },
				{ $set: { media: [{ key: `ecommerce/products/${ids.case.id}/a b.png`, type: 'image/png', size: 1, alt: '' }] } },
			);
		const answer = await get('/v1/shop/products?q=case');
		expect(answer.json.items[0].image).toBe(`https://cdn.shop.example.com/ecommerce/products/${ids.case.id}/a%20b.png`);
		expect((await get('/v1/shop/products')).json.items).toHaveLength(2);
		const config = await shop.visitor('GET', '/v1/widget/config');
		expect(config.json.settings.catalog).toMatchObject({
			productUrl: '/products/{slug}',
			categoryUrl: '/categories/{slug}',
			pageSize: 2,
		});
	});
});

describe('the product page', () => {
	it('gives the page of an active product by slug or id', async () => {
		const page = await get('/v1/shop/products/pixel-9');
		expect(page.status).toBe(200);
		expect(page.json).toMatchObject({
			id: ids.pixel.id,
			name: 'Pixel 9',
			kind: 'physical',
			price: 70000,
			compareAtPrice: 75000,
			inStock: true,
			brand: { id: ids.acme.id, slug: 'acme', name: 'Acme' },
			booking: null,
			seo: { title: 'Pixel 9', description: 'Fast phone' },
		});
		expect(page.json.breadcrumb.map((/** @type {any} */ c) => c.name)).toEqual(['Phones', 'Android']);
		expect(page.json.breadcrumb[1].url).toBe('https://shop.example.com/categories/android');
		expect(page.json.specs.map((/** @type {any} */ s) => [s.name, s.value, s.unit])).toEqual([
			['Note', 'Nice', ''],
			['RAM', 8, 'GB'],
			['Colour', 'Black', ''],
			['5G', true, ''],
		]);
		expect(page.json.variants).toEqual([
			{
				id: ids.pixel.variants[0].id,
				name: '128 GB',
				sku: 'PX-128',
				options: { Storage: '128 GB' },
				price: 70000,
				compareAtPrice: 75000,
				inStock: true,
				grade: { key: 'new', label: 'New', description: 'Sealed box' },
			},
			{
				id: ids.pixel.variants[1].id,
				name: '256 GB',
				sku: 'PX-256',
				options: { Storage: '256 GB' },
				price: 80000,
				compareAtPrice: null,
				inStock: false,
				grade: { key: 'used', label: 'Used', description: 'Light marks' },
			},
		]);
		expect((await get(`/v1/shop/products/${ids.case.id}`)).json.media[0]).toMatchObject({
			alt: 'Clear case',
			type: 'image/png',
		});
		expect((await get('/v1/shop/products/secret-phone')).status).toBe(404);
		expect((await get('/v1/shop/products/prd_nothing')).status).toBe(404);
	});
});

describe('categories and brands', () => {
	it('gives the category tree with counts of active products', async () => {
		const answer = await get('/v1/shop/categories');
		expect(answer.json.items.map((/** @type {any} */ c) => [c.name, c.count])).toEqual([
			['Phones', 2],
			['Cases', 1],
		]);
		const phones = answer.json.items[0];
		expect(phones).toMatchObject({
			description: 'Phones text',
			url: 'https://shop.example.com/categories/phones',
			image: null,
		});
		expect(phones.children.map((/** @type {any} */ c) => [c.name, c.count])).toEqual([['Android', 1]]);
	});

	it('shows category images, brand logos and pages of products without a category', async () => {
		const data = await shop.db();
		const image = { key: 'ecommerce/categories/x/a.png', type: 'image/png', size: 1, alt: 'Alt' };
		await data.collection('categories').updateOne({ websiteId: shop.websiteId, id: ids.cases.id }, { $set: { image } });
		await data.collection('brands').updateOne({ websiteId: shop.websiteId, id: ids.acme.id }, { $set: { logo: image } });
		const cases = (await get('/v1/shop/categories')).json.items[1];
		expect(cases.image).toEqual({ url: 'https://cdn.shop.example.com/ecommerce/categories/x/a.png', alt: 'Alt' });
		expect((await get('/v1/shop/brands')).json.items[0].logo.alt).toBe('Alt');
		const page = await get('/v1/shop/products/bestseller');
		expect(page.json).toMatchObject({ breadcrumb: [], brand: null });
		await data.collection('brands').updateOne({ websiteId: shop.websiteId, id: ids.acme.id }, { $set: { logo: null } });
	});

	it('gives brands with counts', async () => {
		expect((await get('/v1/shop/brands')).json.items).toEqual([
			{ id: ids.acme.id, slug: 'acme', name: 'Acme', description: '', logo: null, count: 1 },
		]);
	});
});
