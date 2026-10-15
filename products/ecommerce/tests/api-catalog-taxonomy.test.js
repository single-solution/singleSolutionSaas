/**
 * The catalog's taxonomy routes as their API description says (schemas/api.json): categories, brands, attributes,
 * stock locations, serial numbers, size charts, category images and brand logos, through the catalog admin widget's
 * ticket (the twins of the server routes) and the server token. Every answer is checked against the description by
 * the test helper; these tests also check that a record answers the same members whether it was just written or read
 * back (no write stamps).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STORAGE, UNIT_TYPES, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
/** @type {string} */
let staff;

beforeAll(async () => {
	shop = await readyShop();
	staff = await shop.ticket(['catalog.edit']);
	await shop.list('item_types', UNIT_TYPES);
	await shop.list('grades', [
		{ key: 'new', label: 'New', description: 'Sealed' },
		{ key: 'used_a', label: 'Used A' },
	]);
});
afterAll(async () => shop.product.close());

/** @param {string} method @param {string} path @param {unknown} [body] */
const admin = (method, path, body) => shop.admin(staff, method, path, body);
/** @param {string} method @param {string} path @param {unknown} [body] */
const api = (method, path, body) => shop.api(method, path, body);

/** The bucket answers HEAD with an image of this type. @param {string} type */
const bucket = (type) =>
	shop.responders.set(STORAGE, (call) =>
		call.method === 'HEAD' ? { status: 200, headers: { 'content-length': '2000', 'content-type': type } } : { status: 204 },
	);

/** @param {Record<string, unknown>} record */
const noStamps = (record) => {
	expect(record).not.toHaveProperty('createdAt');
	expect(record).not.toHaveProperty('updatedAt');
};

describe('size charts, categories and brands through the admin widget', () => {
	it('answers full records, the same when written and when read back', async () => {
		const chart = await admin('POST', '/v1/admin/size-charts', {
			name: 'Shirts',
			unit: 'cm',
			columns: [{ key: 'chest', label: 'Chest' }],
			rows: [{ size: 'M', values: { chest: 96 } }],
			advice: 'Fits true to size.',
		});
		expect(chart.status).toBe(201);
		expect(chart.json).toMatchObject({
			name: 'Shirts',
			unit: 'cm',
			rows: [{ size: 'M', label: 'M', values: { chest: '96' } }],
			notes: '',
			active: true,
			uses: { products: 0, brands: 0, categories: 0 },
		});
		expect((await admin('GET', `/v1/admin/size-charts/${chart.json.id}`)).json).toEqual(chart.json);

		const phones = await admin('POST', '/v1/admin/categories', {
			name: 'Phones',
			description: 'Every phone.\nNew and used.',
			seo: { title: 'Phones', canonicalUrl: '/phones', noindex: true },
			status: 'coming_soon',
			icon: 'phone',
			content: { summary: 'Why buy here', bullets: ['Fast delivery', { text: 'Warranty', icon: 'shield' }] },
			faqs: [{ question: 'Are they new?', answer: 'Some are used.' }],
			sizeChartId: chart.json.id,
			typeKey: 'numbered',
		});
		expect(phones.status).toBe(201);
		expect(phones.json).toMatchObject({
			slug: 'phones',
			parentId: null,
			path: [],
			sort: 0,
			seo: { title: 'Phones', description: '', canonicalUrl: '/phones', ogImage: '', noindex: true, nofollow: false },
			status: 'coming_soon',
			content: {
				summary: 'Why buy here',
				bullets: [
					{ text: 'Fast delivery', icon: '' },
					{ text: 'Warranty', icon: 'shield' },
				],
			},
			sizeChartId: chart.json.id,
			typeKey: 'numbered',
			image: null,
			previousSlugs: [],
		});
		const read = (await admin('GET', `/v1/admin/categories/${phones.json.id}`)).json;
		expect(read).toEqual(phones.json);
		noStamps(read);
		expect((await api('GET', '/v1/categories')).json.items).toEqual([phones.json]);
		expect((await admin('GET', `/v1/admin/size-charts/${chart.json.id}`)).json.uses).toEqual({
			products: 0,
			brands: 0,
			categories: 1,
		});

		const android = await admin('POST', '/v1/admin/categories', { name: 'Android', parentId: phones.json.id });
		expect(android.json).toMatchObject({ parentId: phones.json.id, path: [phones.json.id], status: 'active' });
		const renamed = await admin('PATCH', `/v1/admin/categories/${android.json.id}`, { slug: 'android-phones', sort: 3 });
		expect(renamed.json).toMatchObject({ slug: 'android-phones', sort: 3, previousSlugs: ['android'] });
		noStamps(renamed.json);
		expect((await admin('DELETE', `/v1/admin/categories/${phones.json.id}`)).status).toBe(409);
		expect((await admin('DELETE', `/v1/admin/categories/${android.json.id}/image`)).json).toEqual({ image: null });
		expect((await admin('DELETE', `/v1/admin/categories/${android.json.id}`)).status).toBe(204);

		const brand = await admin('POST', '/v1/admin/brands', {
			name: 'Acme',
			categoryIds: [phones.json.id],
			status: 'hidden',
			seo: { focusKeyword: 'acme phones' },
			sizeChartId: chart.json.id,
		});
		expect(brand.status).toBe(201);
		expect(brand.json).toMatchObject({
			slug: 'acme',
			description: '',
			status: 'hidden',
			categoryIds: [phones.json.id],
			seo: { focusKeyword: 'acme phones', noindex: false },
			sizeChartId: chart.json.id,
			logo: null,
		});
		expect((await admin('GET', `/v1/admin/brands/${brand.json.id}`)).json).toEqual(brand.json);
		const changed = await admin('PATCH', `/v1/admin/brands/${brand.json.id}`, { status: 'active', sizeChartId: null });
		expect(changed.json).toMatchObject({ status: 'active', sizeChartId: null, categoryIds: [phones.json.id] });
		noStamps(changed.json);

		const upload = await admin('POST', '/v1/admin/catalog/uploads', {
			for: 'brand',
			id: brand.json.id,
			type: 'image/webp',
			size: 2000,
		});
		bucket('image/webp');
		const logo = await admin('PUT', `/v1/admin/brands/${brand.json.id}/logo`, {
			key: upload.json.key,
			alt: 'Acme logo',
			width: 120,
			height: 40,
		});
		expect(logo.json.logo).toMatchObject({
			key: upload.json.key,
			type: 'image/webp',
			size: 2000,
			alt: 'Acme logo',
			width: 120,
		});
		expect(logo.json.logo.url).toContain(STORAGE);
		expect((await api('GET', `/v1/brands/${brand.json.id}`)).json.logo).toMatchObject({ key: upload.json.key, height: 40 });
		expect((await admin('DELETE', `/v1/admin/brands/${brand.json.id}`)).status).toBe(204);

		expect((await admin('DELETE', `/v1/admin/size-charts/${chart.json.id}`)).status).toBe(409);
		const patched = await admin('PATCH', `/v1/admin/size-charts/${chart.json.id}`, { active: false, notes: 'Measured flat.' });
		expect(patched.json).toMatchObject({ active: false, notes: 'Measured flat.', uses: { categories: 1 } });
		noStamps(patched.json);
		expect((await admin('PATCH', `/v1/admin/categories/${phones.json.id}`, { sizeChartId: null })).json.sizeChartId).toBe(null);
		expect((await admin('DELETE', `/v1/admin/size-charts/${chart.json.id}`)).status).toBe(204);
		expect((await admin('DELETE', `/v1/admin/categories/${phones.json.id}`)).status).toBe(204);
	});
});

describe('attributes, locations and serials through the admin widget', () => {
	it('answers full attributes with their choices, visibility and glossary', async () => {
		const brand = (await api('POST', '/v1/brands', { name: 'Visible brand' })).json;
		const color = await admin('POST', '/v1/admin/attributes', {
			name: 'Color',
			type: 'choice',
			choices: ['Black', { value: 'blue', label: 'Blue' }],
			on: 'variant',
			multiple: true,
			show: { card: 'chips' },
			visibility: { when: 'brands', ids: [brand.id] },
		});
		expect(color.status).toBe(201);
		expect(color.json).toMatchObject({
			slug: 'color',
			choices: [
				{ value: 'Black', label: 'Black' },
				{ value: 'blue', label: 'Blue' },
			],
			unit: '',
			show: { filter: false, compare: false, card: 'chips' },
			categoryIds: [],
			on: 'variant',
			multiple: true,
			visibility: { when: 'brands', ids: [brand.id], attributeId: null, value: null },
			active: true,
			seo: { title: '', description: '', body: '', faqs: [] },
		});
		const grade = await admin('POST', '/v1/admin/attributes', {
			name: 'Battery health',
			type: 'number',
			unit: '%',
			visibility: { when: 'grades', ids: ['used_a'] },
		});
		const shade = await admin('POST', '/v1/admin/attributes', {
			name: 'Shade',
			visibility: { when: 'attribute', attributeId: color.json.id, value: 'blue' },
			seo: { title: 'Shades', body: 'What a shade is.', faqs: [{ question: 'Why?', answer: 'Because.' }] },
		});
		expect(shade.json.visibility).toEqual({ when: 'attribute', ids: [], attributeId: color.json.id, value: 'blue' });
		const listed = (await admin('GET', '/v1/admin/attributes')).json.items;
		expect(listed).toEqual(expect.arrayContaining([color.json, grade.json, shade.json]));
		listed.forEach(noStamps);
		const patched = await admin('PATCH', `/v1/admin/attributes/${grade.json.id}`, {
			show: { filter: true },
			visibility: 'always',
		});
		expect(patched.json).toMatchObject({ show: { filter: true }, unit: '%', visibility: { when: 'always', ids: [] } });
		expect((await api('GET', '/v1/attributes')).json.items).toContainEqual(patched.json);
		expect((await admin('DELETE', `/v1/admin/attributes/${shade.json.id}`)).status).toBe(204);
	});

	it('keeps stock locations and serial numbers', async () => {
		const floor = await admin('POST', '/v1/admin/locations', { name: 'Shop floor', pickup: true });
		expect(floor.status).toBe(201);
		expect(floor.json).toEqual({ id: floor.json.id, name: 'Shop floor', pickup: true, sort: 0 });
		const back = await admin('PATCH', `/v1/admin/locations/${floor.json.id}`, { sort: 2 });
		expect(back.json).toEqual({ ...floor.json, sort: 2 });
		expect((await admin('GET', '/v1/admin/locations')).json.items).toEqual([back.json]);

		const item = await shop.seedProduct({ name: 'Used phone', typeKey: 'numbered' });
		const variantId = /** @type {string} */ (item.variants[0]?.id);
		const added = await admin('POST', '/v1/admin/serials', {
			productId: item.id,
			variantId,
			serials: [' SN-1 ', 'SN-2'],
			locationId: floor.json.id,
		});
		expect(added.status).toBe(201);
		expect(added.json.items).toEqual([
			{
				id: added.json.items[0].id,
				productId: item.id,
				variantId,
				serial: 'SN-1',
				values: {},
				keys: ['num:SN-1'],
				status: 'in_stock',
				orderId: null,
				lineId: null,
				locationId: floor.json.id,
			},
			expect.objectContaining({ serial: 'SN-2', locationId: floor.json.id }),
		]);
		const page = await api('GET', `/v1/serials?productId=${item.id}`);
		expect(page.json).toEqual({ items: added.json.items, nextCursor: null, hasMore: false });
		const faulty = await admin('PATCH', `/v1/admin/serials/${added.json.items[1].id}`, { status: 'faulty' });
		expect(faulty.json).toEqual({ ...added.json.items[1], status: 'faulty' });
		expect((await api('DELETE', `/v1/serials/${added.json.items[0].id}`)).status).toBe(204);
		expect((await admin('DELETE', `/v1/admin/serials/${added.json.items[1].id}`)).status).toBe(204);
		expect((await admin('DELETE', `/v1/admin/locations/${floor.json.id}`)).status).toBe(204);
	});
});

describe('category images', () => {
	it('sets a category image through the server route and reads it back with its address', async () => {
		const category = (await api('POST', '/v1/categories', { name: 'Tablets' })).json;
		const upload = await api('POST', '/v1/catalog/uploads', {
			for: 'category',
			id: category.id,
			type: 'image/png',
			size: 2000,
		});
		bucket('image/png');
		const set = await api('PUT', `/v1/categories/${category.id}/image`, { key: upload.json.key, alt: 'Tablets' });
		expect(set.json).toEqual({
			image: { key: upload.json.key, type: 'image/png', size: 2000, alt: 'Tablets', url: expect.stringContaining(STORAGE) },
		});
		const read = (await admin('GET', `/v1/admin/categories/${category.id}`)).json;
		expect(read.image).toMatchObject({ key: upload.json.key, alt: 'Tablets' });
		expect((await admin('DELETE', `/v1/admin/categories/${category.id}/image`)).json).toEqual({ image: null });
		expect((await api('GET', `/v1/categories/${category.id}`)).json.image).toBe(null);
	});
});
