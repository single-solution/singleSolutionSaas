/**
 * Thin pages and sitemap quality (SEO audit G7, G8, phase S7): an empty category without its own text is not indexed
 * (the seo setting `emptyCategories`), a glossary page without its own text is neither indexed nor in the sitemap, a
 * listing answers how many products it has and a 404 for an empty filter result or a page past the end, a landing page
 * once indexed stays indexed while it has any product (in stock or not), product `lastmod` follows content changes only
 * (never a stock change that leaves it on sale), and the sitemap lists the home page and dates the files of its index.
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SITEMAP_FILE_SIZE } from '../core/limits.js';
import { COLLECTIONS } from '../core/model.js';
import { ORIGIN, readyShop, storedAttribute, storedBrand, storedCategory } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;

/** Fifty words and more: a category's own text. */
const LONG_TEXT = Array.from({ length: 55 }, (_, index) => `word${index}`).join(' ');

beforeAll(async () => {
	shop = await readyShop({ features: ['catalog', 'checkout', 'seo', 'landing_pages', 'grades_serials', 'bulk_actions'] });
	const data = await shop.db();
	await data
		.collection(COLLECTIONS.categories)
		.insertMany([
			storedCategory({ id: 'cat_light', slug: 'lighting', name: 'Lighting' }),
			storedCategory({ id: 'cat_lamps', slug: 'lamps', name: 'Lamps', parentId: 'cat_light', path: ['cat_light'] }),
			storedCategory({ id: 'cat_empty', slug: 'empty', name: 'Empty' }),
			storedCategory({ id: 'cat_guide', slug: 'guide', name: 'Guide', content: { summary: LONG_TEXT, bullets: [] } }),
		]);
	await data.collection(COLLECTIONS.brands).insertOne(storedBrand({ id: 'brd_acme', slug: 'acme', name: 'Acme' }));
	/** A variant in stock (an automatic landing page needs three of them, LANDING_MIN_VARIANTS). */
	const piece = () => ({
		id: createId('var'),
		sku: '',
		options: {},
		price: 1000,
		compareAtPrice: null,
		cost: null,
		stock: 10,
		locations: {},
		grade: null,
		active: true,
	});
	for (const [index, name] of ['Lamp A', 'Lamp B', 'Lamp C'].entries())
		await shop.seedProduct({
			slug: name.toLowerCase().replace(' ', '-'),
			name,
			categoryIds: ['cat_lamps'],
			brandId: index < 2 ? 'brd_acme' : null,
			// Acme has three variants in stock in all: two on Lamp A, one on Lamp B
			variants: index === 0 ? [piece(), piece()] : [piece()],
			publishedAt: new Date(Date.UTC(2026, 9, 1 + index)),
		});
	await data.collection(COLLECTIONS.attributes).insertMany([
		storedAttribute({ id: 'att_color', name: 'Color', slug: 'color' }),
		storedAttribute({
			id: 'att_material',
			name: 'Material',
			slug: 'material',
			seo: { title: '', description: '', body: 'What each material means for your lamp.', faqs: [] },
		}),
	]);
	await shop.list('grades', [
		{ key: 'mint', label: 'Mint', description: 'Like new.' },
		{ key: 'fair', label: 'Fair', seo: { title: '', description: '', body: 'Fair items show marks of use.', faqs: [] } },
	]);
	await shop.setting('landing_pages', 'attributeUrl', '/glossary/{slug}');
	await shop.setting('landing_pages', 'gradeUrl', '/grades/{key}');
	await shop.setting('catalog', 'pageSize', 2);
});
afterAll(async () => shop.product.close());

/** @param {string} path */
const read = async (path) => {
	const answer = await shop.api('GET', path);
	if (answer.status !== 200) throw new Error(`${path}: ${answer.status} ${answer.text}`);
	return answer;
};
/** The addresses of the sitemap. */
const locs = async () => [...(await read('/v1/seo/sitemap.xml')).text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

describe('empty categories', () => {
	it('are not indexed nor in the sitemap unless they have their own text, or the merchant says so', async () => {
		expect((await read('/v1/seo/categories/empty')).json.robots).toBe('noindex, follow');
		expect((await read('/v1/seo/listing?category=empty')).json).toMatchObject({ robots: 'noindex, follow', status: 200 });
		// a category whose products are in the one below it, and one with its own text, are indexed
		expect((await read('/v1/seo/categories/lighting')).json.robots).toBe('index, follow');
		expect((await read('/v1/seo/categories/guide')).json.robots).toBe('index, follow');
		const listed = await locs();
		expect(listed).toEqual(
			expect.arrayContaining([`${ORIGIN}/categories/lighting`, `${ORIGIN}/categories/lamps`, `${ORIGIN}/categories/guide`]),
		);
		expect(listed).not.toContain(`${ORIGIN}/categories/empty`);
		await shop.setting('seo', 'emptyCategories', 'index');
		expect((await read('/v1/seo/categories/empty')).json.robots).toBe('index, follow');
		expect(await locs()).toContain(`${ORIGIN}/categories/empty`);
		await shop.setting('seo', 'emptyCategories', 'noindex');
	});
});

describe('glossary pages', () => {
	it('are indexed and listed only with their own text', async () => {
		expect((await read('/v1/seo/attributes/color')).json.robots).toBe('noindex, follow');
		expect((await read('/v1/seo/attributes/material')).json.robots).toBe('index, follow');
		expect((await read('/v1/seo/grades/mint')).json.robots).toBe('noindex, follow');
		expect((await read('/v1/seo/grades/fair')).json.robots).toBe('index, follow');
		const listed = await locs();
		expect(listed).toEqual(expect.arrayContaining([`${ORIGIN}/glossary/material`, `${ORIGIN}/grades/fair`]));
		expect(listed).not.toContain(`${ORIGIN}/glossary/color`);
		expect(listed).not.toContain(`${ORIGIN}/grades/mint`);
	});
});

describe('listing counts and statuses', () => {
	it('answers its total, and 404 for an empty filter result or a page past the end', async () => {
		expect((await read('/v1/seo/listing?category=lamps')).json).toMatchObject({ total: 3, empty: false, status: 200 });
		expect((await read('/v1/seo/listing?category=lamps&page=2')).json).toMatchObject({ total: 3, status: 200 });
		expect((await read('/v1/seo/listing?category=lamps&page=3')).json).toMatchObject({
			total: 3,
			status: 404,
			robots: 'noindex, follow',
		});
		expect((await read('/v1/seo/listing?category=lamps&limit=3&page=2')).json.status).toBe(404);
		expect((await read('/v1/seo/listing?category=lamps&minPrice=999999')).json).toMatchObject({
			total: 0,
			empty: true,
			status: 404,
		});
		// filters it cannot read, and brands that do not exist, are not a page either
		expect((await read('/v1/seo/listing?category=lamps&minPrice=abc')).json.status).toBe(404);
		expect((await read('/v1/seo/listing?category=lamps&brand=nobody')).json.status).toBe(404);
		expect((await read('/v1/seo/listing?category=lamps&brand=acme')).json).toMatchObject({ total: 2, status: 200 });
		// an empty category is a page (not indexed); a search finding nothing is a page too
		expect((await read('/v1/seo/listing?category=empty')).json).toMatchObject({ total: 0, empty: true, status: 200 });
		expect((await read('/v1/seo/listing?category=lamps&q=nothing-like-this')).json).toMatchObject({
			empty: true,
			status: 200,
		});
	});
});

describe('landing pages once indexed', () => {
	it('stay indexed while they have any product, in stock or not, and leave the index once empty', async () => {
		await shop.setting('landing_pages', 'auto', 'category_brand');
		const page = () => read('/v1/seo/listing?category=lamps&brand=acme').then((answer) => answer.json);
		expect(await page()).toMatchObject({ robots: 'index, follow', landing: { automatic: true, indexed: true } });
		const data = await shop.db();
		await data
			.collection(COLLECTIONS.products)
			.updateMany(
				{ websiteId: shop.websiteId, brandId: 'brd_acme' },
				{ $set: { 'variants.$[].stock': 0, inStock: false, stockState: 'out' } },
			);
		// out of stock: still the automatic page it was, still indexed and in the sitemap
		expect(await page()).toMatchObject({ robots: 'index, follow', landing: { automatic: true, indexed: true } });
		expect(await locs()).toContain(`${ORIGIN}/categories/lamps?brand=acme`);
		await data
			.collection(COLLECTIONS.products)
			.updateMany({ websiteId: shop.websiteId, brandId: 'brd_acme' }, { $set: { status: 'archived' } });
		expect(await page()).toMatchObject({ robots: 'noindex, follow', landing: null });
		expect(await locs()).not.toContain(`${ORIGIN}/categories/lamps?brand=acme`);
		// back in stock, it has to reach the numbers again
		await data
			.collection(COLLECTIONS.products)
			.updateMany(
				{ websiteId: shop.websiteId, brandId: 'brd_acme' },
				{ $set: { status: 'active', 'variants.$[].stock': 1, inStock: true, stockState: 'full' } },
			);
		await data
			.collection(COLLECTIONS.products)
			.updateOne({ websiteId: shop.websiteId, slug: 'lamp-a' }, { $set: { 'variants.$[].stock': 0 } });
		expect(await page()).toMatchObject({ robots: 'noindex, follow', landing: null });
		// what was remembered goes with the catalog
		await data.collection(COLLECTIONS.landingIndex).insertOne({ key: 'cat_x||', at: new Date() });
		const remembered = await data.collection(COLLECTIONS.landingIndex).countDocuments({ websiteId: shop.websiteId });
		expect(remembered).toBe(1);
		await shop.setting('landing_pages', 'auto', 'off');
	});
});

describe('sitemap dates', () => {
	it('dates a product by its last content change, never by a stock change that leaves it on sale', async () => {
		const made = (await shop.api('POST', '/v1/products', { name: 'Desk Lamp', status: 'active', price: 4500, stock: 3 })).json;
		/** The product's lastmod in the sitemap. */
		const lastmod = async () =>
			new RegExp(`<loc>${ORIGIN}/products/desk-lamp</loc><lastmod>([^<]+)</lastmod>`).exec(
				(await read('/v1/seo/sitemap.xml')).text,
			)?.[1];
		const first = await lastmod();
		expect(first).toBe(new Date(shop.now()).toISOString());
		shop.advance(86_400_000);
		const variantId = made.variants[0].id;
		await shop.api('POST', `/v1/products/${made.id}/stock`, { changes: [{ variantId, set: 2 }] });
		expect(await lastmod()).toBe(first);
		shop.advance(86_400_000);
		await shop.api('PATCH', `/v1/products/${made.id}`, { summary: 'A lamp for your desk.' });
		expect(await lastmod()).toBe(new Date(shop.now()).toISOString());
		// sold out: its availability changed
		shop.advance(86_400_000);
		await shop.api('POST', `/v1/products/${made.id}/stock`, { changes: [{ variantId, set: 0 }] });
		expect(await lastmod()).toBe(new Date(shop.now()).toISOString());
	});

	it('lists the home page, and dates each file of a sitemap index by its newest page', async () => {
		expect((await locs())[0]).toBe(`${ORIGIN}/`);
		const data = await shop.db();
		// more addresses than one file holds (SITEMAP_FILE_SIZE)
		await data.collection(COLLECTIONS.categories).insertMany(
			Array.from({ length: SITEMAP_FILE_SIZE }, (_, index) =>
				storedCategory({
					id: `cat_bulk${String(index).padStart(6, '0')}`,
					slug: `bulk-${index}`,
					name: `Bulk ${index}`,
					content: { summary: LONG_TEXT, bullets: [] },
				}),
			),
		);
		const index = (await read('/v1/seo/sitemap.xml')).text;
		expect(index).toContain('<sitemapindex');
		expect(index).toMatch(
			new RegExp(`<sitemap><loc>${ORIGIN}/sitemap.xml\\?file=categories</loc><lastmod>[^<]+</lastmod></sitemap>`),
		);
		expect(index).toContain(
			`<sitemap><loc>${ORIGIN}/sitemap.xml?file=products-1</loc><lastmod>${new Date(shop.now()).toISOString()}</lastmod></sitemap>`,
		);
		expect((await read('/v1/seo/sitemaps/categories')).text).toContain(`<url><loc>${ORIGIN}/</loc></url>`);
	}, 120_000);

	it('forgets the landing pages indexed before with the catalog', async () => {
		const done = await shop.api('POST', '/v1/data/delete-all', { scope: 'catalog', confirm: 'DELETE catalog' });
		expect(done.json.deleted).toMatchObject({ landings: 0, landing_index: 1 });
		expect(await (await shop.db()).collection(COLLECTIONS.landingIndex).countDocuments({ websiteId: shop.websiteId })).toBe(0);
	});
});
