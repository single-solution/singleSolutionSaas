/**
 * The catalog of PLAN 0.8.10 E1–E9 and E13 through the API: category and brand status, content and scope; the
 * featured flag, stock states and staff filters with counts; rich descriptions; product videos; size charts; photo sizes
 * and variant galleries; attributes per category on variants with several values and the generator; listings where one
 * variant must match every filter, with page numbers and totals; stock display and sold out; URL templates and slug
 * history. Visitor reads are made with the browser token and with the server token (K3), as stores render pages.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL, STORAGE, readyShop } from './helpers.js';

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
/** The merchant's server rendering a page (K3): the server token on a visitor route. @param {string} path */
const server = (path) => shop.api('GET', path);
/** @param {any} answer */
const names = (answer) => answer.json.items.map((/** @type {any} */ item) => item.name);

/** The bucket answers HEAD with this file. @param {{ type?: string, size?: number, exists?: boolean }} [file] */
const bucket = ({ type = 'image/png', size = 2000, exists = true } = {}) =>
	shop.responders.set(STORAGE, (call) => {
		if (call.method !== 'HEAD') return { status: 204 };
		return exists ? { status: 200, headers: { 'content-length': String(size), 'content-type': type } } : { status: 404 };
	});

beforeAll(async () => {
	shop = await readyShop({ features: ALL.filter((feature) => feature !== 'multi_location') });
	await shop.list('grades', [
		{
			key: 'a-plus',
			label: 'A+',
			description: 'Like new',
			color: '#16a34a',
			condition: 'refurbished',
			warrantyTime: { amount: 90, unit: /** @type {const} */ ('days') },
		},
		{ key: 'b', label: 'B', description: 'Light marks', categoryIds: [] },
	]);
	await shop.connectStorage({ publicBaseUrl: 'https://cdn.shop.example.com' });
	await shop.setting('catalog', 'productUrl', '/{category}/{slug}');
	await shop.setting('catalog', 'categoryUrl', '/{path}');
	ids.clothes = await api('POST', '/v1/categories', { name: 'Clothes', icon: 'shirt' });
	ids.dresses = await api('POST', '/v1/categories', { name: 'Dresses', parentId: ids.clothes.id });
	ids.soon = await api('POST', '/v1/categories', { name: 'Winter', status: 'coming_soon' });
	ids.secret = await api('POST', '/v1/categories', { name: 'Secret', status: 'hidden' });
	ids.below = await api('POST', '/v1/categories', { name: 'Below secret', parentId: ids.secret.id });
	ids.brand = await api('POST', '/v1/brands', { name: 'Maison', categoryIds: [ids.clothes.id] });
	ids.gone = await api('POST', '/v1/brands', { name: 'Gone', status: 'hidden' });
	ids.color = await api('POST', '/v1/attributes', {
		name: 'Color',
		slug: 'color',
		type: 'choice',
		on: 'variant',
		multiple: true,
		choices: [
			{ value: 'red', label: 'Red' },
			{ value: 'blue', label: 'Blue' },
			{ value: 'green', label: 'Green' },
		],
		show: { filter: true },
		sort: 1,
	});
	ids.size = await api('POST', '/v1/attributes', {
		name: 'Size',
		type: 'choice',
		on: 'variant',
		choices: ['S', 'M'],
		show: { filter: true },
		sort: 2,
		categoryIds: [ids.clothes.id],
	});
	ids.fabric = await api('POST', '/v1/attributes', {
		name: 'Fabric',
		type: 'choice',
		choices: ['Silk', 'Cotton'],
		multiple: true,
		show: { filter: true },
		sort: 3,
	});
});
afterAll(async () => shop.product.close());

describe('E1 category and brand status, content and scope', () => {
	it('keeps status, icon, content and FAQs, and hides products of hidden and coming-soon categories and brands', async () => {
		const updated = await api('PATCH', `/v1/categories/${ids.clothes.id}`, {
			content: { summary: 'Everything to wear', bullets: [{ text: 'Free returns', icon: 'truck' }, 'Made here'] },
			faqs: [{ question: 'Sizes?', answer: 'S to XL.' }],
		});
		expect(updated).toMatchObject({
			icon: 'shirt',
			status: 'active',
			content: {
				summary: 'Everything to wear',
				bullets: [
					{ text: 'Free returns', icon: 'truck' },
					{ text: 'Made here', icon: '' },
				],
			},
			faqs: [{ question: 'Sizes?', answer: 'S to XL.' }],
			typeKey: null,
		});
		expect((await shop.api('PATCH', `/v1/categories/${ids.clothes.id}`, { status: 'gone' })).status).toBe(422);
		expect((await shop.api('PATCH', `/v1/categories/${ids.clothes.id}`, { content: { bullets: 'x' } })).status).toBe(422);
		expect((await shop.api('PATCH', `/v1/categories/${ids.clothes.id}`, { faqs: [{ question: '' }] })).status).toBe(422);
		expect((await shop.api('PATCH', `/v1/categories/${ids.clothes.id}`, { sizeChartId: 'szc_none' })).status).toBe(422);
		expect((await shop.api('POST', '/v1/brands', { name: 'X', categoryIds: ['cat_none'] })).status).toBe(422);
		expect((await shop.api('POST', '/v1/brands', { name: 'X', status: 'maybe' })).status).toBe(422);

		ids.shown = await api('POST', '/v1/products', {
			name: 'Shown dress',
			status: 'active',
			categoryIds: [ids.dresses.id],
			price: 100,
			stock: 1,
		});
		ids.winter = await api('POST', '/v1/products', {
			name: 'Winter coat',
			status: 'active',
			categoryIds: [ids.soon.id],
			price: 100,
			stock: 1,
		});
		ids.hiddenItem = await api('POST', '/v1/products', {
			name: 'Under secret',
			status: 'active',
			categoryIds: [ids.below.id],
			price: 100,
			stock: 1,
		});
		ids.goneItem = await api('POST', '/v1/products', {
			name: 'Gone brand',
			status: 'active',
			brandId: ids.gone.id,
			price: 100,
			stock: 1,
		});
		const listed = names(await get('/v1/shop/products'));
		expect(listed).toContain('Shown dress');
		expect(listed).not.toContain('Winter coat');
		expect(listed).not.toContain('Under secret');
		expect(listed).not.toContain('Gone brand');
		expect((await get(`/v1/shop/products/${ids.winter.slug}`)).status).toBe(404);
		expect((await get(`/v1/shop/products/${ids.goneItem.slug}`)).status).toBe(404);

		const tree = (await get('/v1/shop/categories')).json.items;
		expect(tree.map((/** @type {any} */ node) => node.name)).toEqual(['Clothes']);
		expect(tree[0]).toMatchObject({ status: 'active', icon: 'shirt', content: { summary: 'Everything to wear' }, count: 1 });
		const withSoon = (await get('/v1/shop/categories?include=coming_soon')).json.items;
		expect(withSoon.map((/** @type {any} */ node) => [node.name, node.status])).toEqual([
			['Clothes', 'active'],
			['Winter', 'coming_soon'],
		]);
		const brands = (await get('/v1/shop/brands')).json.items;
		expect(brands.map((/** @type {any} */ brand) => brand.name)).toEqual(['Maison']);
		expect((await get(`/v1/shop/brands?category=${ids.dresses.slug}`)).json.items).toHaveLength(1);
		expect((await get(`/v1/shop/brands?category=${ids.soon.id}`)).json.items).toHaveLength(0);
		expect((await shop.api('GET', '/v1/shop/products')).status).toBe(200);
	});
});

describe('E2 featured flag and staff filters', () => {
	it('filters by featured, stock state, photos, several brands and grades, with counts', async () => {
		ids.featured = await api('POST', '/v1/products', {
			name: 'Featured gown',
			status: 'active',
			featured: true,
			categoryIds: [ids.dresses.id],
			brandId: ids.brand.id,
			options: [{ name: 'Size', values: ['S', 'M'] }],
			variants: [
				{ options: { Size: 'S' }, price: 500, stock: 2, grade: 'a-plus' },
				{ options: { Size: 'M' }, price: 700, stock: 0, grade: 'b' },
			],
		});
		expect(ids.featured).toMatchObject({ featured: true, stockState: 'partial', grades: ['a-plus', 'b'], priceMax: 700 });
		expect(names(await get('/v1/shop/products?featured=1'))).toEqual(['Featured gown']);
		const rows = await api('GET', '/v1/products?featured=1');
		expect(rows.items[0]).toMatchObject({ featured: true, stockState: 'partial', grades: ['a-plus', 'b'], mediaCount: 0 });
		expect((await api('GET', '/v1/products?stockState=partial,out')).items.map((/** @type {any} */ p) => p.name)).toEqual([
			'Featured gown',
		]);
		expect((await api('GET', `/v1/products?brand=${ids.brand.slug},${ids.gone.id}`)).items).toHaveLength(2);
		expect((await api('GET', '/v1/products?grade=b')).items).toHaveLength(1);
		expect((await api('GET', '/v1/products?hasMedia=1')).items).toHaveLength(0);
		expect((await api('GET', '/v1/products?featured=0')).items.length).toBeGreaterThan(1);
		expect(await api('GET', '/v1/products/count?featured=1')).toEqual({ count: 1, capped: false });
		const byGrade = await api('GET', '/v1/products/counts?by=grade');
		expect(byGrade.groups).toMatchObject({ 'a-plus': 1, b: 1, none: 4 });
		expect(byGrade.total).toBe(5);
		const byState = await api('GET', '/v1/products/counts?by=stockState');
		expect(byState.groups).toMatchObject({ partial: 1, full: 4 });
		expect((await api('GET', '/v1/products/counts?by=featured')).groups).toMatchObject({ true: 1 });
		const byCategory = await api('GET', '/v1/products/counts?by=category');
		expect(byCategory.groups).toMatchObject({ [ids.dresses.id]: 2, none: 1 });
		const ticket = await shop.ticket(['catalog.edit']);
		expect((await shop.admin(ticket, 'GET', '/v1/admin/products/counts?by=grade')).json.groups['a-plus']).toBe(1);
	});
});

describe('E3 rich descriptions', () => {
	it('cleans the HTML and derives the plain description', async () => {
		const item = await api('PATCH', `/v1/products/${ids.shown.id}`, {
			descriptionHtml:
				'<h3 class="x">Fit</h3><p onclick="bad()">Soft <b>silk</b> &amp; <a href="javascript:alert(1)">more</a> <a href="/care">care</a></p><script>bad()</script><ul><li>One</li></ul>',
		});
		expect(item.descriptionHtml).toBe(
			'<h3>Fit</h3><p>Soft <strong>silk</strong> &#38; <a>more</a> <a href="/care">care</a></p><ul><li>One</li></ul>',
		);
		expect(item.description).toBe('Fit\n\nSoft silk & more care\n\nOne');
		const page = (await get(`/v1/shop/products/${ids.shown.slug}`)).json;
		expect(page.descriptionHtml).toBe(item.descriptionHtml);
		expect((await shop.api('PATCH', `/v1/products/${ids.shown.id}`, { descriptionHtml: 'x'.repeat(20_001) })).status).toBe(422);
		const cleared = await api('PATCH', `/v1/products/${ids.shown.id}`, { descriptionHtml: '' });
		expect(cleared).toMatchObject({ descriptionHtml: '', description: '' });
	});
});

describe('E4 product video and E6 photos', () => {
	it('uploads and keeps a video, takes YouTube ids and https addresses', async () => {
		const id = ids.shown.id;
		const upload = await api('POST', '/v1/catalog/uploads', { for: 'product', id, type: 'video/mp4', size: 5_000_000 });
		// a video file is named by the product too (G14)
		expect(upload.key).toMatch(new RegExp(`^ecommerce/products/${id}/${ids.shown.slug}-[a-z0-9]{10}\\.mp4$`));
		expect(
			(await shop.api('POST', '/v1/catalog/uploads', { for: 'category', id: ids.clothes.id, type: 'video/mp4', size: 5 }))
				.status,
		).toBe(422);
		expect(
			(await shop.api('POST', '/v1/catalog/uploads', { for: 'product', id, type: 'video/webm', size: 300_000_000 })).status,
		).toBe(422);
		bucket({ type: 'video/mp4', size: 5_000_000 });
		const saved = await api('PATCH', `/v1/products/${id}`, { video: { kind: 'file', key: upload.key } });
		expect(saved.video).toMatchObject({ kind: 'file', key: upload.key, type: 'video/mp4', size: 5_000_000 });
		expect(saved.video.url).toContain('cdn.shop.example.com');
		expect((await get(`/v1/shop/products/${ids.shown.slug}`)).json.video).toMatchObject({ kind: 'file', type: 'video/mp4' });
		bucket({ type: 'image/png' });
		const second = await api('POST', '/v1/catalog/uploads', { for: 'product', id, type: 'video/webm', size: 10 });
		expect((await shop.api('PATCH', `/v1/products/${id}`, { video: { kind: 'file', key: second.key } })).status).toBe(422);
		bucket({ exists: false });
		expect((await shop.api('PATCH', `/v1/products/${id}`, { video: { kind: 'file', key: second.key } })).status).toBe(422);
		expect(
			(await shop.api('PATCH', `/v1/products/${id}`, { video: { kind: 'file', key: 'ecommerce/products/other/a.mp4' } }))
				.status,
		).toBe(422);
		const youtube = await api('PATCH', `/v1/products/${id}`, {
			video: { kind: 'youtube', id: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
		});
		expect(youtube.video).toEqual({ kind: 'youtube', id: 'dQw4w9WgXcQ' });
		expect((await get(`/v1/shop/products/${ids.shown.slug}`)).json.video).toEqual({
			kind: 'youtube',
			id: 'dQw4w9WgXcQ',
			url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
		});
		expect(
			(await api('PATCH', `/v1/products/${id}`, { video: { kind: 'url', url: 'https://v.example.com/a.mp4' } })).video,
		).toEqual({
			kind: 'url',
			url: 'https://v.example.com/a.mp4',
		});
		expect(
			(await shop.api('PATCH', `/v1/products/${id}`, { video: { kind: 'url', url: 'http://v.example.com/a' } })).status,
		).toBe(422);
		expect((await api('PATCH', `/v1/products/${id}`, { video: null })).video).toBeNull();
	});

	it('keeps photo sizes, variant photos and card images', async () => {
		const id = ids.featured.id;
		bucket();
		const keys = [];
		for (let index = 0; index < 4; index += 1)
			keys.push((await api('POST', '/v1/catalog/uploads', { for: 'product', id, type: 'image/webp', size: 2000 })).key);
		const [main, thumb, red, blue] = keys;
		const photo = await api('POST', `/v1/products/${id}/media`, {
			key: main,
			alt: 'Gown',
			sizes: { thumb },
			width: 1200,
			height: 1600,
			blur: 'data:image/webp;base64,UklGRg==',
		});
		expect(photo.media[0]).toMatchObject({ key: main, sizes: { thumb }, width: 1200, height: 1600 });
		bucket({ exists: false });
		expect((await shop.api('POST', `/v1/products/${id}/media`, { key: red, sizes: { card: blue } })).status).toBe(422);
		bucket();
		expect((await shop.api('POST', `/v1/products/${id}/media`, { key: red, blur: 'data:text/html,<b>' })).status).toBe(422);
		expect((await shop.api('POST', `/v1/products/${id}/media`, { key: red, sizes: { huge: blue } })).status).toBe(422);
		const product = await api('GET', `/v1/products/${id}`);
		const [small, medium] = product.variants;
		const withPhotos = await api('PATCH', `/v1/products/${id}`, {
			variants: [
				{ id: small.id, media: [{ key: red, alt: 'Red' }] },
				{ id: medium.id, media: [{ key: blue }, { key: main }] },
			],
		});
		expect(withPhotos.variants[0].media[0]).toMatchObject({ key: red, alt: 'Red', type: 'image/png', size: 2000 });
		expect(withPhotos.variants[0].media[0].url).toContain('cdn.shop.example.com');
		expect(withPhotos.variants[1].media[1]).toMatchObject({ key: main, type: 'image/png', alt: 'Gown' });
		expect(
			(
				await shop.api('PATCH', `/v1/products/${id}`, {
					variants: [{ id: small.id, media: [{ key: 'ecommerce/products/x/a.png' }] }, { id: medium.id }],
				})
			).status,
		).toBe(422);
		expect(
			(
				await shop.api('PATCH', `/v1/products/${id}`, {
					variants: [
						{ id: small.id, media: Array.from({ length: 25 }, (_, n) => ({ key: `ecommerce/products/${id}/${n}.png` })) },
						{ id: medium.id },
					],
				})
			).status,
		).toBe(422);
		const card = (await get('/v1/shop/products?featured=1')).json.items[0];
		expect(card.cardImages.map((/** @type {any} */ image) => image.alt)).toEqual(['Red', 'Featured gown']);
		expect(card.image).toContain(main.split('/').pop());
		const page = (await get(`/v1/shop/products/${ids.featured.slug}`)).json;
		expect(page.media[0]).toMatchObject({ width: 1200, height: 1600, blur: 'data:image/webp;base64,UklGRg==' });
		expect(page.media[0].sizes.thumb).toContain(thumb.split('/').pop());
		expect(page.variants[1].media).toHaveLength(2);
		// removing a product photo also removes it from the variants
		const removed = await shop.api('DELETE', `/v1/products/${id}/media?key=${encodeURIComponent(main)}`);
		expect(removed.status).toBe(200);
		expect((await api('GET', `/v1/products/${id}`)).variants[1].media.map((/** @type {any} */ file) => file.key)).toEqual([
			blue,
		]);
	});
});

describe('E5 size charts', () => {
	it('creates charts, resolves the product, brand and category chart, and refuses deleting a used one', async () => {
		const chart = await api('POST', '/v1/size-charts', {
			name: 'Dresses',
			unit: 'in',
			columns: [
				{ key: 'bust', label: 'Bust' },
				{ key: 'waist', label: 'Waist' },
			],
			rows: [{ size: 'S', values: { bust: 34, waist: '28' } }],
			convertTo: 'cm',
			advice: 'Runs small.',
		});
		expect(chart).toMatchObject({
			unit: 'in',
			rows: [{ size: 'S', label: 'S', values: { bust: '34', waist: '28' } }],
			active: true,
		});
		expect((await shop.api('POST', '/v1/size-charts', { name: 'X', columns: [] })).status).toBe(422);
		expect(
			(
				await shop.api('POST', '/v1/size-charts', {
					name: 'X',
					columns: [{ key: 'a', label: 'A' }],
					rows: [{ size: 'S', values: { b: 1 } }],
				})
			).status,
		).toBe(422);
		const brandChart = await api('POST', '/v1/size-charts', { name: 'Brand', unit: 'cm', columns: [{ key: 'a', label: 'A' }] });
		await api('PATCH', `/v1/categories/${ids.clothes.id}`, { sizeChartId: chart.id });
		expect((await get(`/v1/shop/products/${ids.shown.slug}`)).json.sizeChart).toMatchObject({
			id: chart.id,
			convertTo: 'cm',
			advice: 'Runs small.',
		});
		await api('PATCH', `/v1/brands/${ids.brand.id}`, { sizeChartId: brandChart.id });
		expect((await get(`/v1/shop/products/${ids.featured.slug}`)).json.sizeChart).toMatchObject({
			id: brandChart.id,
			unit: 'cm',
		});
		await api('PATCH', `/v1/products/${ids.featured.id}`, { sizeChartId: chart.id });
		expect((await get(`/v1/shop/products/${ids.featured.slug}`)).json.sizeChart.id).toBe(chart.id);
		expect((await get(`/v1/shop/products/${ids.featured.slug}`)).json.hideSizeGuide).toBe(false);
		// the product's own choice of none: no chart, and the answer says the merchant chose it
		await api('PATCH', `/v1/products/${ids.featured.id}`, { hideSizeGuide: true });
		const hidden = (await get(`/v1/shop/products/${ids.featured.slug}`)).json;
		expect(hidden.sizeChart).toBeNull();
		expect(hidden.hideSizeGuide).toBe(true);
		// a product with no chart anywhere has none, but did not choose it
		const plain = await api('POST', '/v1/products', { name: 'Plain mug', status: 'active', price: 100, stock: 1 });
		expect((await get(`/v1/shop/products/${plain.slug}`)).json).toMatchObject({ sizeChart: null, hideSizeGuide: false });
		await api('DELETE', `/v1/products/${plain.id}`);
		expect((await shop.api('PATCH', `/v1/products/${ids.featured.id}`, { sizeChartId: 'szc_none' })).status).toBe(422);
		const used = await api('GET', `/v1/size-charts/${chart.id}`);
		expect(used.uses).toEqual({ products: 1, brands: 0, categories: 1 });
		expect((await shop.api('DELETE', `/v1/size-charts/${chart.id}`)).status).toBe(409);
		expect((await api('PATCH', `/v1/size-charts/${brandChart.id}`, { active: false })).active).toBe(false);
		expect((await api('GET', '/v1/size-charts')).items).toHaveLength(2);
		const spare = await api('POST', '/v1/size-charts', { name: 'Spare', columns: [{ key: 'a', label: 'A' }] });
		expect((await shop.api('DELETE', `/v1/size-charts/${spare.id}`)).status).toBe(204);
		expect((await shop.api('GET', `/v1/size-charts/${spare.id}`)).status).toBe(404);
		const ticket = await shop.ticket(['catalog.edit']);
		expect((await shop.admin(ticket, 'GET', '/v1/admin/size-charts')).json.items).toHaveLength(2);
	});
});

describe('E7 attributes on variants and the generator', () => {
	it('derives options from variant attributes, allows the same options with other grades, and generates variants', async () => {
		expect(ids.color).toMatchObject({
			slug: 'color',
			on: 'variant',
			multiple: true,
			choices: [{ value: 'red', label: 'Red' }, expect.anything(), expect.anything()],
		});
		expect(ids.size.slug).toBe('size');
		expect((await shop.api('POST', '/v1/attributes', { name: 'Color', slug: 'color' })).status).toBe(409);
		expect((await shop.api('POST', '/v1/attributes', { name: 'Flag', type: 'yes_no', on: 'variant' })).status).toBe(422);
		expect(
			(await shop.api('POST', '/v1/attributes', { name: 'Visible', visibility: { when: 'brands', ids: ['brd_none'] } }))
				.status,
		).toBe(422);
		expect(
			(await shop.api('POST', '/v1/attributes', { name: 'Visible', visibility: { when: 'grades', ids: ['zz'] } })).status,
		).toBe(422);
		expect(
			(
				await shop.api('POST', '/v1/attributes', {
					name: 'Visible',
					visibility: { when: 'attribute', attributeId: 'att_none', value: 'x' },
				})
			).status,
		).toBe(422);
		const visible = await api('POST', '/v1/attributes', {
			name: 'Battery',
			visibility: { when: 'grades', ids: ['b'] },
			show: { card: 'chips' },
			seo: { title: 'Battery health', body: 'What it means.', faqs: [{ question: 'Q', answer: 'A' }] },
		});
		expect(visible).toMatchObject({ visibility: { when: 'grades', ids: ['b'] }, show: { card: 'chips' }, active: true });

		const item = await api('POST', '/v1/products', {
			name: 'Printed scarf',
			status: 'active',
			categoryIds: [ids.clothes.id],
			specs: { [ids.fabric.id]: ['Silk', 'Cotton'] },
			variants: [
				{ attributes: { [ids.color.id]: ['red', 'blue'], [ids.size.id]: 'S' }, price: 1000, stock: 1, grade: 'a-plus' },
				{ attributes: { [ids.color.id]: ['red', 'blue'], [ids.size.id]: 'S' }, price: 800, stock: 1, grade: 'b' },
			],
		});
		expect(item.options).toEqual([
			{ name: 'Color', values: ['Red, Blue'] },
			{ name: 'Size', values: ['S'] },
		]);
		expect(item.variants[0].options).toEqual({ Color: 'Red, Blue', Size: 'S' });
		expect(
			(
				await shop.api('POST', '/v1/products', {
					name: 'Twins',
					variants: [
						{ attributes: { [ids.size.id]: 'S' }, price: 1 },
						{ attributes: { [ids.size.id]: 'S' }, price: 2 },
					],
				})
			).status,
		).toBe(422);
		expect(
			(await shop.api('POST', '/v1/products', { name: 'Bad', variants: [{ attributes: { [ids.size.id]: 'XL' }, price: 1 }] }))
				.status,
		).toBe(422);
		expect(
			(
				await shop.api('POST', '/v1/products', {
					name: 'Bad',
					variants: [{ attributes: { [ids.fabric.id]: 'Silk' }, price: 1 }],
				})
			).status,
		).toBe(422);
		expect((await shop.api('POST', '/v1/products', { name: 'Bad', specs: { [ids.color.id]: 'red' } })).status).toBe(422);

		const setup = await api('PATCH', `/v1/products/${item.id}`, {
			attributeSetup: [
				{ attributeId: ids.color.id, values: ['green'], customValues: ['Ochre'], defaultValue: 'green' },
				{ attributeId: ids.size.id, values: ['S', 'M'] },
			],
		});
		expect(setup.attributeSetup[0]).toEqual({
			attributeId: ids.color.id,
			values: ['green'],
			customValues: ['Ochre'],
			defaultValue: 'green',
		});
		expect(
			(await shop.api('PATCH', `/v1/products/${item.id}`, { attributeSetup: [{ attributeId: ids.size.id, values: ['XL'] }] }))
				.status,
		).toBe(422);
		expect(
			(
				await shop.api('PATCH', `/v1/products/${item.id}`, {
					attributeSetup: [{ attributeId: ids.size.id, values: ['S'], defaultValue: 'M' }],
				})
			).status,
		).toBe(422);
		const generated = await api('POST', `/v1/products/${item.id}/variants/generate`, { price: 1200, stock: 2 });
		expect(generated.added).toBe(4);
		expect(generated.product.variants).toHaveLength(6);
		expect(generated.product.options[0].values).toEqual(['Red, Blue', 'Green', 'Ochre']);
		expect((await api('POST', `/v1/products/${item.id}/variants/generate`, { price: 1200 })).added).toBe(0);
		expect((await shop.api('POST', `/v1/products/${item.id}/variants/generate`, {})).status).toBe(422);
		expect((await shop.api('POST', `/v1/products/${item.id}/variants/generate`, { price: -1 })).status).toBe(422);
		const many = await api('POST', '/v1/products/variants/generate', { ids: [item.id, 'prd_none'] });
		expect(many).toEqual({
			results: [
				{ id: item.id, added: 0 },
				{ id: 'prd_none', error: 'There is no such product.', code: 'not_found' },
			],
			added: 0,
		});
		expect((await shop.api('POST', '/v1/products/variants/generate', { ids: [] })).status).toBe(422);
		ids.scarf = await api('GET', `/v1/products/${item.id}`);
		expect((await shop.api('PATCH', `/v1/attributes/${ids.size.id}`, { on: 'product' })).status).toBe(409);
		expect((await shop.api('DELETE', `/v1/attributes/${ids.size.id}`)).status).toBe(409);
	});
});

describe('E8 listing and filtering', () => {
	it('matches one variant on every filter, filters several values, pages and counts', async () => {
		const color = `attr.color`;
		expect(names(await get(`/v1/shop/products?${color}=green`))).toEqual(['Printed scarf']);
		expect(names(await get(`/v1/shop/products?${color}=red&grade=b&maxPrice=900`))).toEqual(['Printed scarf']);
		// red only exists at 1000 and 800, green at 1200: no single variant is green and under 900
		expect(names(await get(`/v1/shop/products?${color}=green&maxPrice=900`))).toEqual([]);
		expect(names(await get(`/v1/shop/products?attr.fabric=Silk`))).toEqual(['Printed scarf']);
		expect(names(await get(`/v1/shop/products?grade=a-plus,b&inStock=1`)).sort()).toEqual(['Featured gown', 'Printed scarf']);
		expect(names(await get(`/v1/shop/products?brand=${ids.brand.slug},nothing`))).toEqual(['Featured gown']);
		const counted = (await get('/v1/shop/products?count=1&limit=2')).json;
		expect(counted).toMatchObject({ total: 3, capped: false, hasMore: true });
		const second = (await get('/v1/shop/products?page=2&limit=2&count=1')).json;
		expect(second).toMatchObject({ page: 2, total: 3, facets: null });
		expect(second.items).toHaveLength(1);
		const cheapFirst = names(await get('/v1/shop/products?sort=price_asc'));
		expect(cheapFirst[0]).toBe('Shown dress');
		shop.advance(60_000);
		await api('PATCH', `/v1/products/${ids.scarf.id}`, { tags: ['silk'] });
		expect(names(await get('/v1/shop/products?sort=updated'))[0]).toBe('Printed scarf');
		expect(names(await get('/v1/shop/products?sort=sold_asc'))).toHaveLength(3);
		const paged = (await get('/v1/shop/products?sort=price_asc&limit=1')).json;
		expect(paged).toMatchObject({ hasMore: true, nextCursor: expect.any(String) });
		expect(paged).not.toHaveProperty('next');
		expect(names(await get(`/v1/shop/products?sort=price_asc&limit=1&cursor=${paged.nextCursor}`))).toEqual(['Featured gown']);
		expect((await get('/v1/shop/products?page=0')).status).toBe(422);
		const card = (await get('/v1/shop/products?q=scarf')).json.items[0];
		expect(card).toMatchObject({ price: 800, priceMax: 1200, featured: false });
		const facets = (await get('/v1/shop/products')).json.facets;
		const colors = facets.attributes.find((/** @type {any} */ a) => a.slug === 'color');
		expect(colors.values.map((/** @type {any} */ v) => [v.value, v.label, v.count])).toEqual([
			['blue', 'Blue', 1],
			['green', 'Green', 1],
			['Ochre', 'Ochre', 1],
			['red', 'Red', 1],
		]);
		expect(facets.price).toEqual({ min: 100, max: 1200 });
		// a deal by id: products of its scope; an unknown deal matches nothing
		const deal = await api('POST', '/v1/deals', {
			name: 'Gowns',
			type: 'percent',
			value: 10,
			scope: { productIds: [ids.featured.id] },
		});
		expect(names(await get(`/v1/shop/products?deal=${deal.id}`))).toEqual(['Featured gown']);
		expect(names(await get('/v1/shop/products?deal=nothing'))).toEqual([]);
		const everything = await api('POST', '/v1/deals', { name: 'All', type: 'percent', value: 5 });
		expect(names(await get(`/v1/shop/products?deal=${everything.id}`))).toHaveLength(3);
	});

	it('lists for a deal only the products its cards show it on: live now, its scope and its conditions (SF-4, PR-6)', async () => {
		for (const deal of (await api('GET', '/v1/deals?limit=100')).items) await api('DELETE', `/v1/deals/${deal.id}`);
		/**
		 * The products listed for a deal made alone, and the cards that show it.
		 * @param {Record<string, unknown>} body
		 */
		const both = async (body) => {
			const deal = await api('POST', '/v1/deals', { name: 'Check', type: 'percent', value: 10, ...body });
			const listed = names(await get(`/v1/shop/products?deal=${deal.slug || deal.id}`)).sort();
			const cards = (await get('/v1/shop/products?limit=60')).json.items;
			const shown = cards
				.filter((/** @type {any} */ card) => card.deal?.id === deal.id)
				.map((/** @type {any} */ card) => card.name)
				.sort();
			await api('DELETE', `/v1/deals/${deal.id}`);
			return { listed, shown };
		};
		const all = ['Featured gown', 'Printed scarf', 'Shown dress'];
		const weekday = new Date(shop.now()).getUTCDay();
		/** @type {Array<[Record<string, unknown>, string[]]>} */
		const cases = [
			[{}, all],
			[{ conditions: { rules: [{ field: 'grades', values: ['b'] }] } }, ['Featured gown', 'Printed scarf']],
			[{ conditions: { rules: [{ field: 'attribute', attributeId: ids.color.id, values: ['green'] }] } }, ['Printed scarf']],
			[{ conditions: { rules: [{ field: 'attribute', attributeId: ids.fabric.id, values: ['Silk'] }] } }, ['Printed scarf']],
			[{ conditions: { rules: [{ field: 'attribute', attributeId: ids.color.id, values: ['red'], op: 'not_in' }] } }, all],
			[{ conditions: { priceRange: { min: 1_000, max: null } } }, ['Printed scarf']],
			[{ conditions: { priceRange: { min: null, max: 600 } } }, ['Featured gown', 'Shown dress']],
			[
				{
					conditions: {
						match: 'any',
						rules: [{ field: 'products', values: [ids.scarf.id] }],
						groups: [{ match: 'all', rules: [{ field: 'brands', values: [ids.brand.id] }] }],
					},
				},
				['Featured gown', 'Printed scarf'],
			],
			[{ conditions: { rules: [{ field: 'categories', values: [ids.dresses.id] }] } }, ['Featured gown', 'Shown dress']],
			[
				{
					scope: { categoryIds: [ids.clothes.id] },
					conditions: { rules: [{ field: 'grades', values: ['a-plus'], op: 'not_in' }] },
				},
				all,
			],
			[{ conditions: { groups: [{ match: 'any', rules: [] }], minQuantity: 2, cartTotal: 99_999 } }, all],
			[{ conditions: { paymentMethods: ['cod'] }, slug: 'cod-days' }, all],
			// not live now: none, as the cart would not give them
			[{ active: false }, []],
			[{ endsAt: new Date(shop.now() - 60_000).toISOString() }, []],
			[{ days: [(weekday + 1) % 7] }, []],
			[{ timeFrom: '00:00', timeTo: '00:01' }, []],
		];
		for (const [body, expected] of cases) {
			const { listed, shown } = await both(body);
			expect(listed, JSON.stringify(body)).toEqual(expected);
			expect(shown, JSON.stringify(body)).toEqual(expected);
		}
		// while Deals is off no deal lists anything
		const deal = await api('POST', '/v1/deals', { name: 'Off', type: 'percent', value: 10 });
		await shop.switchOn(ALL.filter((feature) => feature !== 'multi_location' && feature !== 'deals'));
		expect(names(await server(`/v1/shop/products?deal=${deal.id}`))).toEqual([]);
		await shop.switchOn(ALL.filter((feature) => feature !== 'multi_location'));
		expect(names(await get(`/v1/shop/products?deal=${deal.id}`)).sort()).toEqual(all);
		await api('DELETE', `/v1/deals/${deal.id}`);
	});
});

describe('E9 stock display and sold out', () => {
	it('tells shoppers what the setting allows and keeps sold-out variants shown but not sold', async () => {
		const slug = ids.featured.slug;
		expect((await get(`/v1/shop/products/${slug}`)).json.variants.map((/** @type {any} */ v) => v.stockLeft)).toEqual([
			null,
			null,
		]);
		await shop.setting('catalog', 'showStock', 'low');
		await shop.setting('catalog', 'lowStockShown', 1);
		expect((await get(`/v1/shop/products/${slug}`)).json.variants.map((/** @type {any} */ v) => v.stockLeft)).toEqual([
			null,
			0,
		]);
		await shop.setting('catalog', 'showStock', 'always');
		expect((await get(`/v1/shop/products/${slug}`)).json.variants.map((/** @type {any} */ v) => v.stockLeft)).toEqual([2, 0]);
		const [small] = ids.featured.variants;
		const marked = await api('POST', `/v1/products/${ids.featured.id}/stock`, {
			changes: [{ variantId: small.id, soldOut: true }],
		});
		expect(marked).toMatchObject({ inStock: false, stockState: 'out' });
		expect(marked.variants[0]).toMatchObject({ soldOut: true, stock: 2 });
		const page = (await get(`/v1/shop/products/${slug}`)).json;
		expect(page.variants[0]).toMatchObject({ soldOut: true, inStock: false, stockLeft: 0 });
		const quote = await shop.visitor('POST', '/v1/shop/cart/quote', {
			body: { lines: [{ productId: ids.featured.id, variantId: small.id, quantity: 1 }] },
		});
		expect(quote.json.lines[0].problems[0].code).toBe('out_of_stock');
		expect(quote.json.lines[0].url).toBe(`https://shop.example.com/dresses/${slug}`);
		expect(
			(await shop.api('POST', `/v1/products/${ids.featured.id}/stock`, { changes: [{ variantId: small.id, soldOut: 'yes' }] }))
				.status,
		).toBe(422);
		expect(
			(await shop.api('POST', `/v1/products/${ids.featured.id}/stock`, { changes: [{ variantId: small.id }] })).status,
		).toBe(422);
		const back = await api('POST', `/v1/products/${ids.featured.id}/stock`, {
			changes: [{ variantId: small.id, soldOut: false, adjust: 1 }],
		});
		expect(back.variants[0]).toMatchObject({ soldOut: false, stock: 3 });
		const activity = await api('GET', `/v1/activity?target=${ids.featured.id}&action=product.stock_changed`);
		expect(activity.items.map((/** @type {any} */ entry) => entry.detail)).toEqual(['S: 2 → 3, S: for sale', 'S: sold out']);
		await shop.setting('catalog', 'showStock', 'none');
	});
});

describe('E13 URL templates and slug history', () => {
	it('builds links from the templates, finds old slugs and moves retired products to their category', async () => {
		const card = (await get(`/v1/shop/products?q=gown`)).json.items[0];
		expect(card.url).toBe(`https://shop.example.com/dresses/${ids.featured.slug}`);
		await shop.setting('catalog', 'productUrl', '/{categoryPath}/{brand}/{slug}');
		await shop.setting('catalog', 'variantQuery', 'grade={grade}&{attributes}');
		const page = (await server(`/v1/shop/products/${ids.featured.slug}`)).json;
		expect(page.url).toBe(`https://shop.example.com/clothes/dresses/maison/${ids.featured.slug}`);
		expect(page.variants[0].url).toBe(`${page.url}?grade=a-plus`);
		const scarf = (await get(`/v1/shop/products/${ids.scarf.slug}`)).json;
		expect(scarf.variants[0].url).toBe(`https://shop.example.com/clothes/${ids.scarf.slug}?grade=a-plus&color=red&size=S`);
		expect(page.breadcrumb.map((/** @type {any} */ c) => c.url)).toEqual([
			'https://shop.example.com/clothes',
			'https://shop.example.com/clothes/dresses',
		]);

		const renamed = await api('PATCH', `/v1/products/${ids.featured.id}`, { slug: 'evening-gown' });
		expect(renamed.previousSlugs).toEqual([ids.featured.slug]);
		const moved = await get(`/v1/shop/products/${ids.featured.slug.toUpperCase()}`);
		expect(moved.json).toEqual({
			moved: { kind: 'product', slug: 'evening-gown', url: 'https://shop.example.com/clothes/dresses/maison/evening-gown' },
		});
		expect((await get('/v1/shop/products/EVENING-GOWN')).json.name).toBe('Featured gown');
		const again = await api('PATCH', `/v1/products/${ids.featured.id}`, { slug: ids.featured.slug });
		expect(again.previousSlugs).toEqual(['evening-gown']);
		const category = await api('PATCH', `/v1/categories/${ids.dresses.id}`, { slug: 'gowns' });
		expect(category.previousSlugs).toEqual(['dresses']);
		expect((await shop.api('GET', '/v1/seo/categories/dresses')).json.moved).toEqual({
			kind: 'category',
			slug: 'gowns',
			url: 'https://shop.example.com/clothes/gowns',
		});

		await api('PATCH', `/v1/products/${ids.shown.id}`, { status: 'archived' });
		expect((await get(`/v1/shop/products/${ids.shown.slug}`)).status).toBe(404);
		await shop.setting('catalog', 'retiredUrl', 'category');
		expect((await get(`/v1/shop/products/${ids.shown.slug}`)).json).toEqual({
			moved: { kind: 'category', slug: 'gowns', url: 'https://shop.example.com/clothes/gowns' },
		});
		expect((await shop.api('GET', `/v1/seo/products/${ids.shown.slug}`)).json.moved.slug).toBe('gowns');
		await api('PATCH', `/v1/products/${ids.shown.id}`, { status: 'active' });
	});

	it('moves a retired product to its replacement, and answers each product’s own address (SEO audit G9)', async () => {
		const featured = (await server(`/v1/shop/products/${ids.featured.slug}`)).json;
		// the product answer's own address: a website's route that finds it by another path sends shoppers there
		expect((await server(`/v1/seo/products/${ids.featured.slug.toUpperCase()}`)).json.url).toBe(featured.url);
		const old = await shop.seedProduct({ name: 'Old gown', status: 'archived', categoryIds: [ids.dresses.id] });
		const older = await shop.seedProduct({ name: 'Older gown', status: 'archived', replacedBy: old.id });
		expect((await api('PATCH', `/v1/products/${old.id}`, { replacedBy: ids.featured.id })).replacedBy).toBe(ids.featured.id);
		const toFeatured = { moved: { kind: 'product', slug: ids.featured.slug, url: featured.url } };
		expect((await get(`/v1/shop/products/${old.slug}`)).json).toEqual(toFeatured);
		expect((await server(`/v1/seo/products/${old.slug}`)).json).toEqual(toFeatured);
		// through an archived replacement: one hop to the active one, never a chain
		expect((await get(`/v1/shop/products/${older.slug}`)).json).toEqual(toFeatured);
		// itself, a product that does not exist or a wrong id: refused
		for (const replacedBy of [old.id, 'prd_00000000000000000000000000', 'gown'])
			expect((await shop.api('PATCH', `/v1/products/${old.id}`, { replacedBy })).json.errors?.[0]?.path, replacedBy).toBe(
				'/replacedBy',
			);
		// a replacement shoppers cannot see leads on to the category (retiredUrl), else nowhere
		await api('PATCH', `/v1/products/${old.id}`, { replacedBy: older.id });
		expect((await get(`/v1/shop/products/${old.slug}`)).json.moved).toMatchObject({ kind: 'category', slug: 'gowns' });
		await shop.setting('catalog', 'retiredUrl', 'none');
		expect((await get(`/v1/shop/products/${old.slug}`)).status).toBe(404);
		expect((await shop.api('GET', `/v1/seo/products/${older.slug}`)).status).toBe(404);
		// an active product with a replacement is itself; deleting a replacement clears the links to it
		await api('PATCH', `/v1/products/${old.id}`, { replacedBy: ids.featured.id, status: 'active' });
		expect((await get(`/v1/shop/products/${old.slug}`)).json.name).toBe('Old gown');
		const spare = await shop.seedProduct({ name: 'Spare gown' });
		await api('PATCH', `/v1/products/${older.id}`, { replacedBy: spare.id });
		await api('DELETE', `/v1/products/${spare.id}`);
		expect((await api('GET', `/v1/products/${older.id}`)).replacedBy).toBeNull();
	});
});
