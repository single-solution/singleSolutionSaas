/**
 * Landing pages by any field (PLAN 0.8.10 dynamic model phase 6, §6): a landing page names a category, a brand and a
 * facet — a grade or one value of a field shoppers filter by — automatic pages take the field `autoFacet` with
 * `category_brand_facet`, `landingUrl` takes `{facet}` and
 * `{value}`, and `GET /v1/seo/listing` reads `attr.<slug>=` as a facet.
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkLanding, comboKey, comboOfKey, comboStock, isAutomatic, landingFor, landingLink } from '../core/landings.js';
import { ORIGIN, readyShop } from './helpers.js';

describe('landing facets', () => {
	it('checks a facet: grade or a field’s slug and one value', () => {
		expect(checkLanding({ categoryId: 'cat_1', facet: { field: 'color', value: 'Red' } }, null)).toMatchObject({
			ok: true,
			value: { categoryId: 'cat_1', brandId: null, facet: { field: 'color', value: 'Red' } },
		});
		expect(checkLanding({ facet: { field: 'grade', value: 'a' } }, null)).toMatchObject({ ok: true });
		expect(checkLanding({ brandId: 'brd_1', facet: { field: 'size', value: 42 } }, null)).toMatchObject({
			value: { facet: { field: 'size', value: '42' } },
		});
		expect(checkLanding({ categoryId: 'cat_1' }, null)).toMatchObject({ value: { facet: null } });
		for (const facet of [
			'red',
			{ field: 'Color', value: 'x' },
			{ field: 'color', value: '' },
			{ field: 'color', value: 'x'.repeat(101) },
		])
			expect(checkLanding({ categoryId: 'cat_1', facet }, null)).toMatchObject({ ok: false, errors: [{ path: '/facet' }] });
		expect(checkLanding({ facet: null }, null)).toMatchObject({ ok: false, errors: [{ path: '/categoryId' }] });
		expect(checkLanding({ grade: 'a', categoryId: 'cat_1' }, null)).toMatchObject({ ok: true, value: { facet: null } });
	});

	it('keys combinations by category, brand and facet value, and reads the keys back', () => {
		const facet = { field: 'size', value: 'Blue / Large | 2=3' };
		const key = comboKey({ categoryId: 'c', brandId: 'b', facet });
		expect(key.split('|')).toHaveLength(3);
		expect(comboOfKey(key)).toEqual({ categoryId: 'c', brandId: 'b', facet });
		expect(comboOfKey(comboKey({ categoryId: 'c', brandId: null, facet: null }))).toEqual({
			categoryId: 'c',
			brandId: null,
			facet: null,
		});
		const pair = { categoryId: 'c', brandId: 'b', facet: null };
		const colored = { ...pair, facet: { field: 'color', value: 'red' } };
		expect(isAutomatic({ auto: 'category_brand' }, pair)).toBe(true);
		expect(isAutomatic({ auto: 'category_brand' }, colored)).toBe(false);
		expect(isAutomatic({ auto: 'category_brand_facet', autoFacet: 'color' }, colored)).toBe(true);
		expect(isAutomatic({ auto: 'category_brand_facet', autoFacet: 'grade' }, colored)).toBe(false);
		expect(isAutomatic({ auto: 'category_brand_facet', autoFacet: '' }, colored)).toBe(false);
		expect(isAutomatic({ auto: 'off' }, pair)).toBe(false);
		const stored = /** @type {any} */ ([{ categoryId: 'c', brandId: 'b', facet: { field: 'color', value: 'red' } }]);
		expect(landingFor(stored, colored)).toBe(stored[0]);
		expect(landingFor(stored, pair)).toBeNull();
	});

	it('counts a product once per value of the facet field, several values each', () => {
		const rows = [
			{ _id: { p: 'p1', g: ['red', 'blue'] }, c: ['c1'], b: 'b1', n: 2, min: 400 },
			{ _id: { p: 'p1', g: ['green'] }, c: ['c1'], b: 'b1', n: 1, min: 300 },
			{ _id: { p: 'p2', g: 5 }, c: ['c1'], b: 'b1', n: 1, min: 100 },
		];
		const table = comboStock(rows, () => [], { field: 'color' });
		/** @param {string | null} value */
		const of = (value) =>
			table.get(comboKey({ categoryId: 'c1', brandId: 'b1', facet: value ? { field: 'color', value } : null }));
		expect(of(null)).toMatchObject({ products: 2, variants: 4, minPrice: 100 });
		expect(of('red')).toMatchObject({ products: 1, variants: 2, minPrice: 400 });
		expect(of('5')).toMatchObject({ products: 1, variants: 1 });
		expect(comboStock(rows, () => []).size).toBe(3);
	});

	it('fills {facet} with the listing parameter and {value}, leaving out empty pairs', () => {
		const values = { categoryUrl: 'https://s.example/phones', category: 'phones', brand: 'acme' };
		expect(landingLink('', { ...values, facet: null }, 's.example')).toBe('https://s.example/phones?brand=acme');
		expect(landingLink('', { ...values, facet: { field: 'grade', value: 'a' } }, 's.example')).toBe(
			'https://s.example/phones?brand=acme&grade=a',
		);
		expect(landingLink('', { ...values, facet: { field: 'color', value: 'dark red' } }, 's.example')).toBe(
			'https://s.example/phones?brand=acme&attr.color=dark%20red',
		);
		expect(landingLink('', { ...values, brand: '', facet: null }, 's.example')).toBe('https://s.example/phones');
		expect(
			landingLink('/l/{category}/{brand}/{value}', { ...values, facet: { field: 'color', value: 'red' } }, 's.example'),
		).toBe('https://s.example/l/phones/acme/red');
	});
});

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
/** @param {string} query */
const listing = (query) => api('GET', `/v1/seo/listing?${query}`);
const sitemap = async () => (await shop.api('GET', '/v1/seo/sitemap.xml')).text;

/** A variant in stock of a color. @param {string} color @param {number} [stock] */
const variant = (color, stock = 4) => ({
	id: createId('var'),
	sku: '',
	options: {},
	price: 5000,
	compareAtPrice: null,
	cost: null,
	stock,
	locations: {},
	grade: null,
	active: true,
	attributes: { [ids.color.id]: color },
});

describe('landing pages by a field (API)', () => {
	beforeAll(async () => {
		shop = await readyShop();
		ids.chairs = await api('POST', '/v1/categories', { name: 'Chairs' });
		ids.acme = await api('POST', '/v1/brands', { name: 'Acme' });
		ids.color = await api('POST', '/v1/attributes', {
			name: 'Color',
			slug: 'color',
			type: 'choice',
			on: 'variant',
			choices: [
				{ value: 'red', label: 'Red' },
				{ value: 'blue', label: 'Blue' },
			],
			show: { filter: true },
		});
		ids.hidden = await api('POST', '/v1/attributes', { name: 'Supplier', slug: 'supplier', type: 'text', on: 'product' });
		const chair = { categoryIds: [ids.chairs.id], brandId: ids.acme.id };
		await shop.seedProduct({ ...chair, name: 'Red one', variants: [variant('red'), variant('red')] });
		await shop.seedProduct({ ...chair, name: 'Red two', variants: [variant('red'), variant('blue', 0)] });
		await shop.seedProduct({ ...chair, name: 'Blue one', variants: [variant('blue')] });
		await shop.setting('landing_pages', 'auto', 'category_brand_facet');
		await shop.setting('landing_pages', 'autoFacet', 'color');
	});
	afterAll(async () => shop?.product.close());

	it('makes automatic pages of each value of autoFacet with enough in stock', async () => {
		const head = await listing(`category=${ids.chairs.slug}&brand=${ids.acme.slug}&attr.color=red`);
		expect(head).toMatchObject({
			h1: 'Chairs Acme Red',
			robots: 'index, follow',
			canonical: `${ORIGIN}/categories/${ids.chairs.slug}?brand=${ids.acme.slug}&attr.color=red`,
			landing: { id: null, automatic: true, inStock: 2, inStockVariants: 3 },
		});
		// one product in blue: too few; two values or another filter: not a landing page
		expect((await listing(`category=${ids.chairs.slug}&brand=${ids.acme.slug}&attr.color=blue`)).landing).toBeNull();
		expect((await listing(`category=${ids.chairs.slug}&brand=${ids.acme.slug}&attr.color=red,blue`)).landing).toBeNull();
		expect((await listing(`category=${ids.chairs.slug}&brand=${ids.acme.slug}&attr.color=red&minPrice=1`)).robots).toBe(
			'noindex, follow',
		);
		const map = await sitemap();
		expect(map).toContain(`${ORIGIN}/categories/${ids.chairs.slug}?brand=${ids.acme.slug}&amp;attr.color=red</loc>`);
		expect(map).toContain(`${ORIGIN}/categories/${ids.chairs.slug}?brand=${ids.acme.slug}</loc>`);
		expect(map).not.toContain('attr.color=blue');
	});

	it('stores a landing page by a field, refusing a field shoppers do not filter by', async () => {
		const stored = await api('POST', '/v1/landings', {
			categoryId: ids.chairs.id,
			facet: { field: 'color', value: 'blue' },
			h1: 'Blue chairs',
			indexable: 'yes',
		});
		expect(stored).toMatchObject({
			facet: { field: 'color', value: 'blue' },
			url: `${ORIGIN}/categories/${ids.chairs.slug}?attr.color=blue`,
			inStock: 1,
			inStockVariants: 1,
			indexed: true,
		});
		expect(await listing(`category=${ids.chairs.slug}&attr.color=blue`)).toMatchObject({
			h1: 'Blue chairs',
			robots: 'index, follow',
			landing: { id: stored.id, automatic: false },
		});
		expect((await api('GET', '/v1/landings?facet=color&value=blue')).items.map((/** @type {any} */ l) => l.id)).toEqual([
			stored.id,
		]);
		const again = await shop.api('POST', '/v1/landings', {
			categoryId: ids.chairs.id,
			facet: { field: 'color', value: 'blue' },
		});
		expect(again.status).toBe(409);
		const staffOnly = await shop.api('POST', '/v1/landings', { facet: { field: 'supplier', value: 'x' } });
		expect(staffOnly.status).toBe(422);
		expect(staffOnly.json.errors[0].path).toBe('/facet/field');
		expect(await sitemap()).toContain(`?attr.color=blue</loc>`);
	});
});
