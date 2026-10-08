/**
 * The catalog's staff routes (PLAN 0.8.8 Catalog): categories, brands, attributes, products with variants and stock,
 * images in the merchant's storage and serial numbers, through the server token and the admin widget's ticket.
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS } from '../core/model.js';
import { ALL, STORAGE, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
/** @type {string} */
let staff;

beforeAll(async () => {
	shop = await readyShop({ features: ALL.filter((feature) => feature !== 'multi_location') });
	staff = await shop.ticket(['catalog.edit']);
	await shop.list('grades', [
		{ key: 'new', label: 'New', description: 'Sealed' },
		{ key: 'used_a', label: 'Used A', returnDays: 3 },
	]);
});
afterAll(async () => shop.product.close());

/** @param {string} method @param {string} path @param {unknown} [body] */
const api = (method, path, body) => shop.api(method, path, body);

/** The bucket answers HEAD with this file. @param {{ type?: string, size?: number, exists?: boolean }} [file] */
const bucket = ({ type = 'image/png', size = 2000, exists = true } = {}) =>
	shop.responders.set(STORAGE, (call) => {
		if (call.method !== 'HEAD') return { status: 204 };
		return exists ? { status: 200, headers: { 'content-length': String(size), 'content-type': type } } : { status: 404 };
	});

describe('categories, brands and attributes', () => {
	it('nests categories with free slugs, refuses cycles and moves branches', async () => {
		const phones = await api('POST', '/v1/categories', { name: 'Phones', description: 'All phones', seo: { title: 'Phones' } });
		expect(phones.status).toBe(201);
		expect(phones.json).toMatchObject({
			slug: 'phones',
			path: [],
			parentId: null,
			image: null,
			seo: { title: 'Phones', description: '' },
		});
		const again = await api('POST', '/v1/categories', { name: 'Phones' });
		expect(again.json.slug).toBe('phones-2');
		expect((await api('POST', '/v1/categories', { name: 'X', slug: 'phones' })).status).toBe(409);
		const android = await api('POST', '/v1/categories', { name: 'Android', parentId: phones.json.id });
		expect(android.json.path).toEqual([phones.json.id]);
		const pixel = await api('POST', '/v1/categories', { name: 'Pixel', parentId: android.json.id });
		expect(pixel.json.path).toEqual([phones.json.id, android.json.id]);
		expect((await api('PATCH', `/v1/categories/${phones.json.id}`, { parentId: pixel.json.id })).status).toBe(422);
		expect((await api('PATCH', `/v1/categories/${phones.json.id}`, { parentId: phones.json.id })).status).toBe(422);
		expect((await api('POST', '/v1/categories', { name: 'Y', parentId: 'cat_nothing' })).status).toBe(422);
		expect((await api('POST', '/v1/categories', { name: 'Y', parentId: 5 })).status).toBe(422);
		const moved = await api('PATCH', `/v1/categories/${android.json.id}`, { parentId: again.json.id });
		expect(moved.json.path).toEqual([again.json.id]);
		expect((await api('GET', `/v1/categories/${pixel.json.id}`)).json.path).toEqual([again.json.id, android.json.id]);
		expect((await shop.admin(staff, 'GET', '/v1/admin/categories')).json.items).toHaveLength(4);
		expect((await api('DELETE', `/v1/categories/${android.json.id}`)).status).toBe(409);
		expect((await api('DELETE', `/v1/categories/${pixel.json.id}`)).status).toBe(204);
		expect((await api('GET', `/v1/categories/${pixel.json.id}`)).status).toBe(404);
		const renamed = await api('PATCH', `/v1/categories/${again.json.id}`, { name: 'Mobiles', slug: '' });
		expect(renamed.json.slug).toBe('mobiles');
		expect((await api('PATCH', `/v1/categories/${again.json.id}`, { slug: 'phones' })).status).toBe(409);
		expect((await api('PATCH', `/v1/categories/${again.json.id}`, { name: '', seo: 'x' })).json.errors).toHaveLength(2);
		expect((await api('POST', '/v1/categories', [1])).status).toBe(422);
		const top = await api('PATCH', `/v1/categories/${android.json.id}`, { parentId: null, sort: 2 });
		expect(top.json).toMatchObject({ path: [], sort: 2 });
	});

	it('keeps brands and attributes and refuses deleting what products use', async () => {
		const brand = await api('POST', '/v1/brands', { name: 'Acme Phones', description: 'Good' });
		expect(brand.json).toMatchObject({ slug: 'acme-phones', logo: null });
		expect((await api('PATCH', `/v1/brands/${brand.json.id}`, { name: 'Acme' })).json.name).toBe('Acme');
		expect((await api('GET', `/v1/brands/${brand.json.id}`)).json.slug).toBe('acme-phones');
		expect((await api('POST', '/v1/brands', { name: 'Other', slug: 'acme-phones' })).status).toBe(409);
		expect((await api('POST', '/v1/brands', {})).status).toBe(422);
		expect((await api('PATCH', `/v1/brands/${brand.json.id}`, { slug: 'Bad Slug' })).status).toBe(422);
		expect((await api('POST', '/v1/brands', 7)).status).toBe(422);
		expect((await shop.admin(staff, 'GET', '/v1/admin/brands')).json.items).toHaveLength(1);
		const ram = await api('POST', '/v1/attributes', {
			name: 'RAM',
			type: 'number',
			unit: 'GB',
			filterable: true,
			comparable: true,
		});
		expect(ram.status).toBe(201);
		expect((await api('POST', '/v1/attributes', { name: 'Colour', type: 'choice' })).status).toBe(422);
		expect((await api('POST', '/v1/attributes', { name: 'Bad', type: 'date', filterable: 'yes' })).json.errors).toHaveLength(2);
		const colour = await api('POST', '/v1/attributes', {
			name: 'Colour',
			type: 'choice',
			choices: ['Black', 'Blue'],
			filterable: true,
		});
		expect(colour.json.choices).toEqual(['Black', 'Blue']);
		expect(
			(await api('PATCH', `/v1/attributes/${colour.json.id}`, { choices: ['Black', 'Blue', 'Green'] })).json.choices,
		).toHaveLength(3);
		expect((await api('PATCH', `/v1/attributes/${colour.json.id}`, { choices: ['A', 'A'] })).status).toBe(422);
		expect((await api('GET', '/v1/attributes')).json.items).toHaveLength(2);
		const gone = await api('POST', '/v1/attributes', { name: 'Gone', type: 'boolean' });
		expect((await api('DELETE', `/v1/attributes/${gone.json.id}`)).status).toBe(204);
		expect((await api('PATCH', `/v1/attributes/${gone.json.id}`, { name: 'x' })).status).toBe(404);
		// in use
		const used = await shop.seedProduct({ brandId: brand.json.id, specs: { [ram.json.id]: 4 } });
		expect((await api('DELETE', `/v1/brands/${brand.json.id}`)).status).toBe(409);
		expect((await api('DELETE', `/v1/attributes/${ram.json.id}`)).status).toBe(409);
		expect((await api('PATCH', `/v1/attributes/${ram.json.id}`, { type: 'text' })).status).toBe(409);
		expect((await api('PATCH', `/v1/attributes/${ram.json.id}`, { unit: 'GiB' })).json.unit).toBe('GiB');
		await (await shop.db()).collection(COLLECTIONS.products).deleteOne({ websiteId: shop.websiteId, id: used.id });
		const spare = await api('POST', '/v1/brands', { name: 'Spare' });
		expect((await api('DELETE', `/v1/brands/${spare.json.id}`)).status).toBe(204);
		expect((await api('GET', `/v1/brands/${spare.json.id}`)).status).toBe(404);
	});

	it('refuses tickets without the permission', async () => {
		const other = await shop.ticket(['csv.run']);
		expect((await shop.admin(other, 'GET', '/v1/admin/products')).status).toBe(403);
	});
});

describe('products', () => {
	it('creates a product with variants and keeps price and stock right', async () => {
		const category = (await api('GET', '/v1/categories')).json.items[0];
		const brand = (await api('GET', '/v1/brands')).json.items[0];
		const ram = (await api('GET', '/v1/attributes')).json.items.find((/** @type {any} */ a) => a.name === 'RAM');
		const created = await api('POST', '/v1/products', {
			name: 'Pixel 9',
			status: 'active',
			summary: 'A phone',
			description: 'Line one\r\n\r\nLine two',
			categoryIds: [category.id],
			brandId: brand.id,
			tags: ['phone', 'phone', '5g'],
			specs: { [ram.id]: 8 },
			options: [{ name: 'Storage', values: ['128 GB', '256 GB'] }],
			variants: [
				{ sku: 'PX9-128', options: { Storage: '128 GB' }, price: 70000, compareAtPrice: 80000, stock: 2, grade: 'new' },
				{ sku: 'PX9-256', options: { Storage: '256 GB' }, price: 80000, stock: 0 },
			],
			returnDays: 7,
		});
		expect(created.status).toBe(201);
		const p = created.json;
		expect(p).toMatchObject({
			slug: 'pixel-9',
			price: 70000,
			inStock: true,
			tags: ['phone', '5g'],
			description: 'Line one\n\nLine two',
		});
		expect(p.publishedAt).toBeTruthy();
		expect((await api('POST', '/v1/products', { name: 'Copy', price: 1, sku: 'PX9-128' })).status).toBe(409);
		expect((await api('POST', '/v1/products', { name: 'Copy', price: 1, slug: 'pixel-9' })).status).toBe(409);
		expect((await shop.admin(staff, 'GET', `/v1/admin/products/${p.slug}`)).json.id).toBe(p.id);
		const [first, second] = p.variants;
		const patched = await api('PATCH', `/v1/products/${p.id}`, {
			variants: [
				{ id: first.id, price: 65000 },
				{ id: second.id, stock: 99, active: false },
			],
		});
		expect(patched.status).toBe(200);
		expect(patched.json).toMatchObject({ price: 65000, inStock: true });
		expect(patched.json.variants[1].stock).toBe(0);
		const stock = await api('POST', `/v1/products/${p.id}/stock`, {
			changes: [
				{ variantId: first.id, adjust: -2 },
				{ variantId: second.id, set: 5 },
			],
		});
		expect(stock.json.variants.map((/** @type {any} */ v) => v.stock)).toEqual([0, 5]);
		expect(stock.json.inStock).toBe(false);
		expect((await api('POST', `/v1/products/${p.id}/stock`, { changes: [{ variantId: first.id, adjust: -1 }] })).status).toBe(
			409,
		);
		expect((await api('POST', `/v1/products/${p.id}/stock`, { changes: [{ variantId: 'var_x', set: 1 }] })).status).toBe(422);
		expect(
			(await api('POST', `/v1/products/${p.id}/stock`, { changes: [{ variantId: first.id, set: 1, locationId: 'loc_1' }] }))
				.status,
		).toBe(422);
		expect((await api('POST', '/v1/products/prd_nothing/stock', { changes: [{ variantId: first.id, set: 1 }] })).status).toBe(
			404,
		);
		const doc = await (await shop.db()).collection(COLLECTIONS.products).findOne({ websiteId: shop.websiteId, id: p.id });
		expect(doc?.inStock).toBe(false);
		// a new variant and a third option value
		const grown = await shop.admin(staff, 'PATCH', `/v1/admin/products/${p.id}`, {
			options: [{ name: 'Storage', values: ['128 GB', '256 GB', '512 GB'] }],
			variants: [
				{ id: first.id },
				{ id: second.id },
				{ sku: 'PX9-512', options: { Storage: '512 GB' }, price: 90000, stock: 1 },
			],
		});
		expect(grown.status).toBe(200);
		expect(grown.json).toMatchObject({ inStock: true, price: 65000 });
		expect(grown.json.variants).toHaveLength(3);
	});

	it('keeps single-variant products simple and checks every field', async () => {
		const simple = await api('POST', '/v1/products', { name: 'Charger', price: 1500, sku: 'CH-1', stock: 4 });
		expect(simple.json).toMatchObject({ status: 'draft', publishedAt: null, kind: 'physical', trackStock: true, price: 1500 });
		const id = simple.json.id;
		const active = await api('PATCH', `/v1/products/${id}`, { status: 'active', price: 1400, compareAtPrice: null, cost: 700 });
		expect(active.json).toMatchObject({ price: 1400, status: 'active' });
		expect(active.json.publishedAt).toBeTruthy();
		const renamed = await api('PATCH', `/v1/products/${id}`, { name: 'Fast charger', slug: '' });
		expect(renamed.json.slug).toBe('fast-charger');
		expect((await api('PATCH', `/v1/products/${id}`, { slug: 'pixel-9' })).status).toBe(409);
		expect((await api('PATCH', `/v1/products/${id}`, { sku: 'PX9-128' })).status).toBe(409);
		expect((await api('PATCH', '/v1/products/prd_nothing', { name: 'x' })).status).toBe(404);
		expect((await api('GET', '/v1/products/no-such-slug')).status).toBe(404);
		const pixel = (await api('GET', '/v1/products/pixel-9')).json;
		expect((await api('PATCH', `/v1/products/${pixel.id}`, { price: 1 })).status).toBe(422);
		const errors = await api('POST', '/v1/products', {
			kind: 'thing',
			status: 'gone',
			summary: 'x'.repeat(600),
			categoryIds: ['cat_none'],
			brandId: 'brd_none',
			tags: 'x',
			specs: { att_none: 1 },
			price: -1,
			trackStock: 'yes',
			seo: { title: 'x'.repeat(300) },
			returnDays: 4000,
		});
		expect(errors.status).toBe(422);
		const paths = errors.json.errors.map((/** @type {any} */ e) => e.path);
		for (const path of [
			'/name',
			'/kind',
			'/status',
			'/summary',
			'/categoryIds',
			'/brandId',
			'/tags',
			'/specs/att_none',
			'/price',
			'/trackStock',
			'/seo/title',
			'/returnDays',
		])
			expect(paths).toContain(path);
		expect((await api('POST', '/v1/products', 'x')).status).toBe(400);
		expect((await api('POST', '/v1/products', [])).status).toBe(422);
		const digital = await api('POST', '/v1/products', {
			name: 'E-book',
			kind: 'digital',
			price: 500,
			digital: { licenceKeys: true, downloadLimit: 3 },
		});
		expect(digital.json).toMatchObject({
			trackStock: false,
			inStock: true,
			digital: { files: [], licenceKeys: true, downloadLimit: 3 },
			booking: null,
		});
		const booking = await api('POST', '/v1/products', {
			name: 'Repair',
			kind: 'booking',
			price: 2000,
			booking: { durationMinutes: 45 },
		});
		expect(booking.json).toMatchObject({ booking: { durationMinutes: 45 }, digital: null });
		expect((await api('POST', '/v1/products', { name: 'Repair', kind: 'booking', price: 2000 })).status).toBe(422);
		const serial = await api('POST', '/v1/products', { name: 'Used phone', price: 2000, serialized: true, grade: 'used_a' });
		expect(serial.json).toMatchObject({ serialized: true });
		expect(serial.json.variants[0].grade).toBe('used_a');
		expect((await api('POST', '/v1/products', { name: 'Bad grade', price: 1, grade: 'mint' })).status).toBe(422);
	});

	it('lists products with search, filters and pages', async () => {
		const all = await api('GET', '/v1/products?limit=2');
		expect(all.json.items).toHaveLength(2);
		expect(all.json.hasMore).toBe(true);
		const next = await api('GET', `/v1/products?limit=2&cursor=${all.json.nextCursor}`);
		expect(next.json.items[0].id).not.toBe(all.json.items[0].id);
		expect((await api('GET', '/v1/products?cursor=eyJrIjoiYSJ9')).status).toBe(400);
		expect((await api('GET', '/v1/products?q=px9-512')).json.items.map((/** @type {any} */ i) => i.name)).toEqual(['Pixel 9']);
		expect(
			(await api('GET', '/v1/products?status=draft')).json.items.every((/** @type {any} */ i) => i.status === 'draft'),
		).toBe(true);
		expect((await api('GET', '/v1/products?kind=digital')).json.items.map((/** @type {any} */ i) => i.name)).toEqual([
			'E-book',
		]);
		const pixel = (await api('GET', '/v1/products/pixel-9')).json;
		const category = (await api('GET', `/v1/categories/${pixel.categoryIds[0]}`)).json;
		expect(
			(await api('GET', `/v1/products?category=${category.slug}`)).json.items.map((/** @type {any} */ i) => i.name),
		).toEqual(['Pixel 9']);
		expect((await api('GET', '/v1/products?category=nothing')).json.items).toEqual([]);
		expect((await api('GET', '/v1/products?brand=acme-phones')).json.items).toHaveLength(1);
		expect((await api('GET', '/v1/products?brand=nobody')).json.items).toHaveLength(0);
		const low = await shop.admin(staff, 'GET', '/v1/admin/products?lowStock=true');
		expect(low.json.items.map((/** @type {any} */ i) => i.name)).toContain('Pixel 9');
		expect(low.json.items[0]).toHaveProperty('stock');
	});

	it('deletes products that are in no order', async () => {
		const item = await api('POST', '/v1/products', { name: 'Old case', price: 100 });
		const data = await shop.db();
		await data.collection(COLLECTIONS.orders).insertOne({ id: createId('ord'), lines: [{ productId: item.json.id }] });
		expect((await api('DELETE', `/v1/products/${item.json.id}`)).status).toBe(409);
		await data.collection(COLLECTIONS.orders).deleteMany({ websiteId: shop.websiteId, 'lines.productId': item.json.id });
		await data
			.collection(COLLECTIONS.products)
			.updateOne(
				{ websiteId: shop.websiteId, id: item.json.id },
				{ $set: { media: [{ key: `ecommerce/products/${item.json.id}/a.png`, type: 'image/png', size: 1, alt: '' }] } },
			);
		bucket();
		const before = shop.callsTo(STORAGE).length;
		expect((await shop.admin(staff, 'DELETE', `/v1/admin/products/${item.json.id}`)).status).toBe(204);
		expect(
			shop
				.callsTo(STORAGE)
				.slice(before)
				.map((c) => c.method),
		).toEqual(['DELETE']);
		expect((await api('GET', `/v1/products/${item.json.id}`)).status).toBe(404);
	});
});

describe('images', () => {
	it('uploads, attaches, orders and removes product images', async () => {
		const item = await api('POST', '/v1/products', { name: 'Case', price: 500, stock: 3 });
		const id = item.json.id;
		/** @param {Record<string, unknown>} body */
		const upload = (body) => api('POST', '/v1/catalog/uploads', { for: 'product', id, type: 'image/png', size: 2000, ...body });
		expect((await upload({ for: 'order' })).status).toBe(422);
		expect((await upload({ type: 'image/svg+xml' })).status).toBe(422);
		expect((await upload({ size: 10_000_000 })).status).toBe(422);
		expect((await upload({ id: 'prd_none' })).status).toBe(404);
		const first = await upload({});
		expect(first.json.upload).toMatchObject({
			method: 'PUT',
			headers: { 'content-type': 'image/png', 'content-length': '2000' },
		});
		expect(first.json.key).toMatch(new RegExp(`^ecommerce/products/${id}/[a-z0-9]+\\.png$`));
		bucket();
		const attached = await api('POST', `/v1/products/${id}/media`, { key: first.json.key, alt: 'Front' });
		expect(attached.json.media[0]).toMatchObject({ key: first.json.key, type: 'image/png', size: 2000, alt: 'Front' });
		expect(attached.json.media[0].url).toContain(STORAGE);
		expect((await api('POST', `/v1/products/${id}/media`, { key: 'ecommerce/products/prd_other/a.png' })).status).toBe(422);
		expect((await api('POST', `/v1/products/${id}/media`, { key: first.json.key, alt: 'x'.repeat(300) })).status).toBe(422);
		const second = await upload({ type: 'image/webp' });
		bucket({ exists: false });
		expect((await api('POST', `/v1/products/${id}/media`, { key: second.json.key })).status).toBe(422);
		bucket({ type: 'text/html' });
		expect((await api('POST', `/v1/products/${id}/media`, { key: second.json.key })).status).toBe(422);
		shop.responders.set(STORAGE, () => ({ status: 500 }));
		expect((await api('POST', `/v1/products/${id}/media`, { key: second.json.key })).status).toBe(502);
		bucket({ type: 'image/webp' });
		const both = await shop.admin(staff, 'POST', `/v1/admin/products/${id}/media`, { key: second.json.key });
		expect(both.json.media).toHaveLength(2);
		const swapped = await api('PUT', `/v1/products/${id}/media`, {
			items: [{ key: second.json.key, alt: 'Back' }, { key: first.json.key }],
		});
		expect(swapped.json.media.map((/** @type {any} */ m) => m.alt)).toEqual(['Back', 'Front']);
		expect((await api('PUT', `/v1/products/${id}/media`, { items: [{ key: first.json.key }] })).status).toBe(422);
		expect(
			(
				await api('PUT', `/v1/products/${id}/media`, {
					items: [{ key: second.json.key, alt: 'x'.repeat(300) }, { key: first.json.key }],
				})
			).status,
		).toBe(422);
		expect((await api('DELETE', `/v1/products/${id}/media?key=nothing`)).status).toBe(404);
		const removed = await api('DELETE', `/v1/products/${id}/media?key=${encodeURIComponent(second.json.key)}`);
		expect(removed.json.media.map((/** @type {any} */ m) => m.key)).toEqual([first.json.key]);
		const listed = await api('GET', '/v1/products?q=case');
		expect(listed.json.items[0].image).toContain(STORAGE);
		// at most 20 images
		const data = await shop.db();
		await data.collection(COLLECTIONS.products).updateOne(
			{ websiteId: shop.websiteId, id },
			{
				$set: {
					media: Array.from({ length: 20 }, (_, i) => ({
						key: `ecommerce/products/${id}/${i}.png`,
						type: 'image/png',
						size: 1,
						alt: '',
					})),
				},
			},
		);
		expect((await api('POST', `/v1/products/${id}/media`, { key: first.json.key })).status).toBe(409);
	});

	it('sets and removes category images and brand logos', async () => {
		const category = (await api('GET', '/v1/categories')).json.items[0];
		const brand = (await api('GET', '/v1/brands')).json.items[0];
		bucket();
		const one = await api('POST', '/v1/catalog/uploads', { for: 'category', id: category.id, type: 'image/jpeg', size: 100 });
		const two = await shop.admin(staff, 'POST', '/v1/admin/catalog/uploads', {
			for: 'category',
			id: category.id,
			type: 'image/jpeg',
			size: 100,
		});
		bucket({ type: 'image/jpeg' });
		expect(
			(await api('PUT', `/v1/categories/${category.id}/image`, { key: one.json.key, alt: 'Phones' })).json.image,
		).toMatchObject({
			key: one.json.key,
			alt: 'Phones',
		});
		const before = shop.callsTo(STORAGE).length;
		await shop.admin(staff, 'PUT', `/v1/admin/categories/${category.id}/image`, { key: two.json.key });
		expect(
			shop
				.callsTo(STORAGE)
				.slice(before)
				.map((c) => c.method),
		).toEqual(['HEAD', 'DELETE']);
		expect((await api('GET', `/v1/categories/${category.id}`)).json.image.url).toContain(STORAGE);
		expect((await api('DELETE', `/v1/categories/${category.id}/image`)).json).toEqual({ image: null });
		expect((await api('DELETE', `/v1/categories/${category.id}/image`)).json).toEqual({ image: null });
		const logo = await api('POST', '/v1/catalog/uploads', { for: 'brand', id: brand.id, type: 'image/avif', size: 100 });
		bucket({ type: 'image/avif' });
		expect((await api('PUT', `/v1/brands/${brand.id}/logo`, { key: logo.json.key })).json.logo.key).toBe(logo.json.key);
		expect((await api('GET', '/v1/brands')).json.items[0].logo.url).toContain(STORAGE);
		expect((await shop.admin(staff, 'DELETE', `/v1/admin/brands/${brand.id}/logo`)).json).toEqual({ logo: null });
		expect((await api('PUT', '/v1/brands/brd_none/logo', { key: logo.json.key })).status).toBe(404);
	});
});

describe('serials', () => {
	it('records, finds and marks serial numbers', async () => {
		const item = (await api('GET', '/v1/products/used-phone')).json;
		const variantId = item.variants[0].id;
		const add = (/** @type {unknown} */ serials, extra = {}) =>
			api('POST', '/v1/serials', { productId: item.id, variantId, serials, ...extra });
		expect((await add([])).status).toBe(422);
		expect((await add(['bad serial!'])).status).toBe(422);
		expect((await add(['A1', 'A1'])).status).toBe(422);
		expect((await api('POST', '/v1/serials', { productId: item.id, variantId: 'var_none', serials: ['A1'] })).status).toBe(422);
		expect((await add(['A1'], { locationId: 'loc_none' })).status).toBe(422);
		const added = await add(['IMEI-0001', 'IMEI-0002', 'IMEI-0003']);
		expect(added.status).toBe(201);
		expect(added.json.items[0]).toMatchObject({ serial: 'IMEI-0001', status: 'in_stock', orderId: null });
		expect((await add(['IMEI-0001'])).status).toBe(409);
		const found = await shop.admin(staff, 'GET', '/v1/admin/serials?q=imei-000&limit=2');
		expect(found.json.items.map((/** @type {any} */ s) => s.serial)).toEqual(['IMEI-0001', 'IMEI-0002']);
		const rest = await api('GET', `/v1/serials?q=imei&limit=2&cursor=${found.json.nextCursor}`);
		expect(rest.json.items.map((/** @type {any} */ s) => s.serial)).toEqual(['IMEI-0003']);
		expect((await api('GET', '/v1/serials?cursor=eyJrIjpbMSwiYSJdfQ')).status).toBe(400);
		const target = added.json.items[1];
		expect((await api('PATCH', `/v1/serials/${target.id}`, { status: 'sold' })).status).toBe(422);
		expect((await api('PATCH', `/v1/serials/${target.id}`, { status: 'faulty' })).json.status).toBe('faulty');
		expect((await api('GET', `/v1/serials?status=faulty&productId=${item.id}&variantId=${variantId}`)).json.items).toHaveLength(
			1,
		);
		await (
			await shop.db()
		)
			.collection(COLLECTIONS.serials)
			.updateOne({ websiteId: shop.websiteId, id: added.json.items[2].id }, { $set: { status: 'sold' } });
		expect((await api('PATCH', `/v1/serials/${added.json.items[2].id}`, { status: 'in_stock' })).status).toBe(409);
		expect((await api('DELETE', `/v1/serials/${added.json.items[2].id}`)).status).toBe(409);
		expect((await shop.admin(staff, 'DELETE', `/v1/admin/serials/${target.id}`)).status).toBe(204);
		expect((await api('DELETE', `/v1/serials/${target.id}`)).status).toBe(404);
	});
});

describe('CSV without locations and other edges', () => {
	it('imports stock per variant and new drafts, and refuses SKU and slug clashes', async () => {
		const exported = (await api('GET', '/v1/csv/products')).text;
		expect(exported.split('\r\n')[0]).not.toContain('stock@');
		const pixel = (await api('GET', '/v1/products/pixel-9')).json;
		const done = await api('POST', '/v1/csv/products', {
			csv: 'name,slug,status,sku,price,stock\nPixel 9,pixel-9,,PX9-256,,6\nDraft thing,,draft,DT-1,2,1',
			dryRun: false,
		});
		expect(done.json).toMatchObject({ created: 1, updated: 1, errors: [] });
		const after = (await api('GET', '/v1/products/pixel-9')).json;
		expect(after.variants.map((/** @type {any} */ v) => v.stock)).toEqual([
			pixel.variants[0].stock,
			6,
			pixel.variants[2].stock,
		]);
		expect((await api('GET', '/v1/products/draft-thing')).json).toMatchObject({ status: 'draft', publishedAt: null });
		const clash = await api('POST', '/v1/csv/products', {
			csv: 'name,slug,sku,price\nA,a,PX9-128,1\nA,a,CH-1,1\nX,pixel-9,CH-1,1',
		});
		expect(clash.json.errors.map((/** @type {any} */ e) => e.message)).toEqual([
			'These SKUs belong to different products.',
			'Another product already uses this slug.',
		]);
	});

	it('handles odd names, bodies and records', async () => {
		const odd = await api('POST', '/v1/products', { name: '***', price: 1 });
		expect(odd.json.slug).toMatch(/^[a-z0-9]+$/);
		expect((await api('POST', '/v1/serials', [1])).status).toBe(422);
		const used = (await api('GET', '/v1/products/used-phone')).json;
		expect(
			(await api('POST', '/v1/serials', { productId: used.id, variantId: used.variants[0].id, serials: [5] })).status,
		).toBe(422);
		const page = await api('GET', '/v1/serials?limit=1');
		expect((await api('GET', `/v1/serials?limit=1&cursor=${page.json.nextCursor}`)).json.items).toHaveLength(1);
		expect((await api('POST', `/v1/products/${used.id}/media`, { key: 5 })).status).toBe(422);
		expect((await api('PUT', `/v1/products/${used.id}/media`, { items: 'x' })).status).toBe(422);
		expect((await api('PUT', `/v1/products/${used.id}/media`, { items: [5] })).status).toBe(422);
		// deleting a category with products, a category with an image and a brand with a logo
		const holder = await api('POST', '/v1/categories', { name: 'Holder' });
		const inside = await api('POST', '/v1/products', { name: 'Inside', price: 1, categoryIds: [holder.json.id] });
		expect((await api('DELETE', `/v1/categories/${holder.json.id}`)).status).toBe(409);
		await api('PATCH', `/v1/products/${inside.json.id}`, { categoryIds: [] });
		const data = await shop.db();
		const image = { key: `ecommerce/categories/${holder.json.id}/a.png`, type: 'image/png', size: 1, alt: '' };
		await data
			.collection(COLLECTIONS.categories)
			.updateOne({ websiteId: shop.websiteId, id: holder.json.id }, { $set: { image } });
		bucket();
		const before = shop.callsTo(STORAGE).length;
		expect((await api('DELETE', `/v1/categories/${holder.json.id}`)).status).toBe(204);
		const brand = await api('POST', '/v1/brands', { name: 'Logo brand' });
		await data
			.collection(COLLECTIONS.brands)
			.updateOne(
				{ websiteId: shop.websiteId, id: brand.json.id },
				{ $set: { logo: { ...image, key: `ecommerce/brands/${brand.json.id}/a.png` } } },
			);
		expect((await api('DELETE', `/v1/brands/${brand.json.id}`)).status).toBe(204);
		expect(
			shop
				.callsTo(STORAGE)
				.slice(before)
				.map((c) => c.method),
		).toEqual(['DELETE', 'DELETE']);
	});
});
