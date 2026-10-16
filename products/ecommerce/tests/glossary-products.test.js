/**
 * Glossary pages that list their products: a field's page (`GET /v1/seo/attributes/:slug`) and a grade's page
 * (`GET /v1/seo/grades/:key`), with `products=1`, list the products that carry the value, paged, in the cards of the
 * shop listing. A website draws a glossary page and its products from one answer.
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
/** @param {{ items: Array<{ name: string }> }} page */
const names = (page) => page.items.map((item) => item.name);

beforeAll(async () => {
	shop = await readyShop({ features: ALL.filter((feature) => feature !== 'multi_location') });
	await shop.list('grades', [
		{ key: 'a', label: 'Grade A', description: 'Like new' },
		{ key: 'b', label: 'Grade B', description: 'Light marks' },
	]);
	ids.phones = await api('POST', '/v1/categories', { name: 'Phones' });
	ids.watches = await api('POST', '/v1/categories', { name: 'Watches' });
	ids.storage = await api('POST', '/v1/attributes', {
		name: 'Storage',
		type: 'choice',
		choices: [
			{ value: '64', label: '64 GB' },
			{ value: '128', label: '128 GB' },
		],
		show: { filter: true },
	});
	ids.color = await api('POST', '/v1/attributes', {
		name: 'Color',
		type: 'choice',
		on: 'variant',
		choices: ['Black', 'Red'],
		show: { filter: true },
	});
	// a field only staff see: its products are never told
	ids.cost = await api('POST', '/v1/attributes', { name: 'Supplier code', type: 'text', show: { filter: false } });
	/** @param {string} name @param {Record<string, unknown>} more */
	const product = (name, more) =>
		api('POST', '/v1/products', {
			name,
			status: 'active',
			categoryIds: [ids.phones.id],
			...(more.variants ? {} : { price: 1000, stock: 3 }),
			...more,
		});
	ids.one = await product('Phone One', {
		specs: { [ids.storage.id]: '128', [ids.cost.id]: 'X1' },
		options: [{ name: 'Color', values: ['Black'] }],
		variants: [
			{
				sku: 'ONE-B',
				options: { Color: 'Black' },
				price: 1000,
				stock: 3,
				grade: 'a',
				attributes: { [ids.color.id]: 'Black' },
			},
		],
	});
	shop.advance(1000);
	ids.two = await product('Phone Two', {
		specs: { [ids.storage.id]: '64' },
		options: [{ name: 'Color', values: ['Red'] }],
		variants: [
			{ sku: 'TWO-R', options: { Color: 'Red' }, price: 900, stock: 3, grade: 'b', attributes: { [ids.color.id]: 'Red' } },
		],
	});
	shop.advance(1000);
	ids.three = await product('Phone Three', {});
	shop.advance(1000);
	ids.watch = await product('Watch', { categoryIds: [ids.watches.id], specs: { [ids.storage.id]: '128' } });
	shop.advance(1000);
	ids.draft = await product('Draft phone', { status: 'draft', specs: { [ids.storage.id]: '128' } });
});
afterAll(async () => shop.product.close());

describe('a field glossary page lists its products', () => {
	it('leaves the products out unless asked, and lists those that carry the field in the cards of the listing', async () => {
		expect(await api('GET', '/v1/seo/attributes/storage')).not.toHaveProperty('products');
		const page = (await api('GET', '/v1/seo/attributes/storage?products=1')).products;
		// newest first, as the listing: the products with a value of the field, active ones only
		expect(names(page)).toEqual(['Watch', 'Phone Two', 'Phone One']);
		expect(page).toMatchObject({ nextCursor: null, hasMore: false, facets: null });
		// the cards are the listing's own
		const listed = await shop.visitor('GET', `/v1/shop/products?attr.storage=64,128`);
		expect(page.items).toEqual(listed.json.items);
		expect(page.items[1]).toMatchObject({
			id: ids.two.id,
			price: 900,
			category: { id: ids.phones.id, slug: 'phones', name: 'Phones' },
		});
	});

	it('narrows to one value, and to the field’s own category page', async () => {
		expect(names((await api('GET', '/v1/seo/attributes/storage?products=1&value=128')).products)).toEqual([
			'Watch',
			'Phone One',
		]);
		expect(names((await api('GET', '/v1/seo/attributes/storage?products=1&value=64')).products)).toEqual(['Phone Two']);
		expect(names((await api('GET', '/v1/seo/attributes/storage?products=1&value=256')).products)).toEqual([]);
		// a field on the variants
		expect(names((await api('GET', '/v1/seo/attributes/color?products=1')).products)).toEqual(['Phone Two', 'Phone One']);
		expect(names((await api('GET', '/v1/seo/attributes/color?products=1&value=Red')).products)).toEqual(['Phone Two']);
		// with a category: only its products (and those of the categories below it)
		const phones = await api('GET', `/v1/seo/attributes/${ids.phones.slug}/storage?products=1`);
		expect(names(phones.products)).toEqual(['Phone Two', 'Phone One']);
		expect(phones.category).toMatchObject({ id: ids.phones.id });
		expect(names((await api('GET', `/v1/seo/attributes/${ids.watches.slug}/storage?products=1&value=128`)).products)).toEqual([
			'Watch',
		]);
	});

	it('pages like the listing, with totals, sorts and each card’s variants', async () => {
		const first = (await api('GET', '/v1/seo/attributes/storage?products=1&limit=2&count=1')).products;
		expect(names(first)).toEqual(['Watch', 'Phone Two']);
		expect(first).toMatchObject({ hasMore: true, total: 3, capped: false });
		const second = (await api('GET', `/v1/seo/attributes/storage?products=1&limit=2&cursor=${first.nextCursor}`)).products;
		expect(names(second)).toEqual(['Phone One']);
		expect(second).toMatchObject({ nextCursor: null, hasMore: false });
		expect(names((await api('GET', '/v1/seo/attributes/storage?products=1&page=2&limit=2')).products)).toEqual(['Phone One']);
		expect(names((await api('GET', '/v1/seo/attributes/storage?products=1&sort=name')).products)).toEqual([
			'Phone One',
			'Phone Two',
			'Watch',
		]);
		const withVariants = (await api('GET', '/v1/seo/attributes/storage?products=1&value=64&variants=1')).products;
		expect(withVariants.items[0].variants).toHaveLength(1);
		expect((await shop.api('GET', '/v1/seo/attributes/storage?products=1&sort=zzz')).status).toBe(422);
	});

	it('never tells the products of a field only staff see', async () => {
		expect((await api('GET', '/v1/seo/attributes/supplier-code?products=1')).products.items).toEqual([]);
	});
});

describe('a grade glossary page lists its products', () => {
	it('lists the products with a variant of the grade, for a category too', async () => {
		expect(await api('GET', '/v1/seo/grades/a')).not.toHaveProperty('products');
		expect(names((await api('GET', '/v1/seo/grades/a?products=1')).products)).toEqual(['Phone One']);
		expect(names((await api('GET', '/v1/seo/grades/b?products=1')).products)).toEqual(['Phone Two']);
		expect(names((await api('GET', `/v1/seo/grades/${ids.phones.slug}/a?products=1`)).products)).toEqual(['Phone One']);
		expect(names((await api('GET', `/v1/seo/grades/${ids.watches.slug}/a?products=1`)).products)).toEqual([]);
		const page = (await api('GET', '/v1/seo/grades/a?products=1&count=1')).products;
		expect(page).toMatchObject({ total: 1, hasMore: false });
		expect(page.items[0]).toMatchObject({ grades: ['Grade A'], category: { slug: 'phones' } });
	});
});
