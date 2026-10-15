/**
 * Automatic landing pages and SEO copy (PLAN E43): every category and brand (and grade) combination with enough
 * products and variants in stock is a landing page without a record (a stored one wins), in the listing reads and the
 * sitemaps, with its copy from the patterns; stored pages set to Automatic need the variants too (SG-10); the defaults
 * keep today's pages. Saving a product or an attribute writes its empty SEO copy with the merchant's AI (marked as AI
 * copy); formula copy is never stored, the patterns fill the answers on every read (G6). With AI copy one automatic
 * landing page is written as a record.
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { comboKey, comboStock, isAutomatic, stockOf } from '../core/landings.js';
import { AI, ORIGIN, readyShop } from './helpers.js';

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

/** A variant in stock (or not). @param {string | null} grade @param {number} [stock] @param {number} [price] */
const variant = (grade, stock = 4, price = 5000) => ({
	id: createId('var'),
	sku: '',
	options: {},
	price,
	compareAtPrice: null,
	cost: null,
	stock,
	locations: {},
	grade,
	active: true,
});

/** @param {string} query */
const listing = (query) => api('GET', `/v1/seo/listing?${query}`);
const sitemap = async () => (await shop.api('GET', '/v1/seo/sitemap.xml')).text;
/** @param {string} category @param {string} brand @param {string} [grade] */
const pageOf = (category, brand, grade) =>
	`${ORIGIN}/categories/${category}?brand=${brand}${grade ? `&amp;grade=${grade}` : ''}</loc>`;

beforeAll(async () => {
	shop = await readyShop();
	ids.clothing = await api('POST', '/v1/categories', { name: 'Clothing' });
	ids.dresses = await api('POST', '/v1/categories', { name: 'Dresses', parentId: ids.clothing.id });
	ids.alpha = await api('POST', '/v1/brands', { name: 'Alpha' });
	ids.beta = await api('POST', '/v1/brands', { name: 'Beta' });
	await shop.list('grades', [
		{ key: 'a', label: 'Grade A' },
		{ key: 'b', label: 'Grade B' },
	]);
	const dress = { categoryIds: [ids.dresses.id], brandId: ids.alpha.id };
	await shop.seedProduct({ ...dress, name: 'Alpha one', variants: [variant('a'), variant('a', 2, 4000)] });
	await shop.seedProduct({ ...dress, name: 'Alpha two', variants: [variant('b'), variant('b', 0)] });
	await shop.seedProduct({
		categoryIds: [ids.dresses.id],
		brandId: ids.beta.id,
		name: 'Beta only',
		variants: [variant(null), variant(null), variant(null)],
	});
});

afterAll(async () => shop?.product.close());

describe('the stock of combinations (E43)', () => {
	it('adds products once and variants per grade, up the category tree', () => {
		const rows = [
			{ _id: { p: 'p1', g: 'a' }, c: ['c2'], b: 'b1', n: 2, min: 400 },
			{ _id: { p: 'p1', g: 'b' }, c: ['c2'], b: 'b1', n: 1, min: 300 },
			{ _id: { p: 'p2', g: null }, c: ['c1'], b: null, n: 1, min: null },
		];
		const table = comboStock(rows, (id) => (id === 'c2' ? ['c1'] : []));
		expect(table.get(comboKey({ categoryId: 'c2', brandId: 'b1', grade: null }))).toEqual({
			products: 1,
			variants: 3,
			minPrice: 300,
			lastmod: null,
		});
		expect(table.get(comboKey({ categoryId: 'c1', brandId: null, grade: null }))).toEqual({
			products: 2,
			variants: 4,
			minPrice: 300,
			lastmod: null,
		});
		expect(table.get(comboKey({ categoryId: 'c1', brandId: 'b1', grade: 'a' }))).toEqual({
			products: 1,
			variants: 2,
			minPrice: 400,
			lastmod: null,
		});
		expect(table.has('||')).toBe(false);
		expect(stockOf(rows)).toEqual({ products: 2, variants: 4, minPrice: 300, lastmod: null });
		expect(stockOf([])).toEqual({ products: 0, variants: 0, minPrice: null, lastmod: null });
		// the newest content change of the products in stock dates the page (G8.4)
		const at = [new Date('2026-10-01T00:00:00Z'), new Date('2026-10-03T00:00:00Z')];
		const dated = rows.map((row, index) => ({ ...row, at: at[index % 2] }));
		expect(stockOf(dated).lastmod).toEqual(at[1]);
		expect(comboStock(dated, () => []).get(comboKey({ categoryId: 'c2', brandId: null, grade: null }))?.lastmod).toEqual(at[1]);
		const pair = { categoryId: 'c', brandId: 'b', grade: null };
		expect(isAutomatic('off', pair)).toBe(false);
		expect(isAutomatic('category_brand', pair)).toBe(true);
		expect(isAutomatic('category_brand', { ...pair, grade: 'a' })).toBe(false);
		expect(isAutomatic('category_brand_grade', { ...pair, grade: 'a' })).toBe(true);
		expect(isAutomatic('category_brand', { ...pair, brandId: null })).toBe(false);
	});
});

describe('automatic landing pages (E43)', () => {
	it('keeps today’s pages while auto is off', async () => {
		const head = await listing(`category=${ids.dresses.slug}&brand=${ids.alpha.slug}`);
		expect(head).toMatchObject({ robots: 'noindex, follow', landing: null, h1: 'Dresses Alpha' });
		expect(await sitemap()).not.toContain('?brand=');
	});

	it('indexes every category and brand with enough products and variants in stock, and lists them', async () => {
		await shop.setting('landing_pages', 'auto', 'category_brand');
		await shop.setting(
			'landing_pages',
			'autoDescription',
			'Shop {brand} {category}: {products} designs, {variants} in stock, from {price}.',
		);
		const head = await listing(`category=${ids.dresses.slug}&brand=${ids.alpha.slug}`);
		expect(head).toMatchObject({
			h1: 'Dresses Alpha',
			title: 'Dresses Alpha | Shop',
			description: 'Shop Alpha Dresses: 2 designs, 3 in stock, from USD 40.00.',
			robots: 'index, follow',
			canonical: `${ORIGIN}/categories/${ids.dresses.slug}?brand=${ids.alpha.slug}`,
			landing: { id: null, automatic: true, indexed: true, inStock: 2, inStockVariants: 3 },
		});
		// one product of Beta: not enough
		expect(await listing(`category=${ids.dresses.slug}&brand=${ids.beta.slug}`)).toMatchObject({
			robots: 'noindex, follow',
			landing: null,
		});
		// a grade is not a combination of category_brand; other filters never are
		expect((await listing(`category=${ids.dresses.slug}&brand=${ids.alpha.slug}&grade=a`)).robots).toBe('noindex, follow');
		expect((await listing(`category=${ids.dresses.slug}&brand=${ids.alpha.slug}&minPrice=1`)).landing).toBeNull();
		const map = await sitemap();
		expect(map).toContain(pageOf(ids.dresses.slug, ids.alpha.slug));
		// the category above counts the products below it
		expect(map).toContain(pageOf(ids.clothing.slug, ids.alpha.slug));
		expect(map).not.toContain(`brand=${ids.beta.slug}`);
	});

	it('takes the grades with category_brand_grade and the merchant’s thresholds', async () => {
		await shop.setting('landing_pages', 'auto', 'category_brand_grade');
		expect((await listing(`category=${ids.dresses.slug}&brand=${ids.alpha.slug}&grade=a`)).robots).toBe('noindex, follow');
		await shop.setting('landing_pages', 'autoMinProducts', 1);
		await shop.setting('landing_pages', 'autoMinInStockVariants', 2);
		const graded = await listing(`category=${ids.dresses.slug}&brand=${ids.alpha.slug}&grade=a`);
		expect(graded).toMatchObject({ h1: 'Dresses Alpha Grade A', robots: 'index, follow', landing: { inStockVariants: 2 } });
		const map = await sitemap();
		expect(map).toContain(pageOf(ids.dresses.slug, ids.alpha.slug, 'a'));
		// grade b has one variant in stock
		expect(map).not.toContain('grade=b');
		expect(map).toContain(pageOf(ids.dresses.slug, ids.beta.slug));
		await shop.setting('landing_pages', 'autoMinProducts', 2);
		await shop.setting('landing_pages', 'autoMinInStockVariants', 3);
		await shop.setting('landing_pages', 'auto', 'category_brand');
	});

	it('lets a stored landing page win, judged by the products and variants in stock (SG-10)', async () => {
		const stored = await api('POST', '/v1/landings', {
			categoryId: ids.dresses.id,
			brandId: ids.alpha.id,
			h1: 'Alpha dresses',
			indexable: 'no',
		});
		expect(stored).toMatchObject({ inStock: 2, inStockVariants: 3, indexed: false });
		const head = await listing(`category=${ids.dresses.slug}&brand=${ids.alpha.slug}`);
		expect(head).toMatchObject({
			h1: 'Alpha dresses',
			robots: 'noindex, follow',
			landing: { id: stored.id, automatic: false },
		});
		expect(await sitemap()).not.toContain(pageOf(ids.dresses.slug, ids.alpha.slug));
		// Automatic: enough products and variants in stock
		await api('PATCH', `/v1/landings/${stored.id}`, { indexable: 'auto' });
		await shop.setting('landing_pages', 'landingMinProducts', 2);
		expect((await api('GET', `/v1/landings/${stored.id}`)).indexed).toBe(true);
		// once indexed, it stays indexed while it has products, below the numbers too (G7.7)
		await shop.setting('landing_pages', 'autoMinInStockVariants', 4);
		expect((await api('GET', `/v1/landings/${stored.id}`)).indexed).toBe(true);
		expect((await api('GET', '/v1/landings')).items[0]).toMatchObject({ inStock: 2, inStockVariants: 3, indexed: true });
		await shop.setting('landing_pages', 'autoMinInStockVariants', 3);
		await shop.setting('landing_pages', 'landingMinProducts', 3);
		await api('DELETE', `/v1/landings/${stored.id}`);
	});

	it('leaves out hidden brands', async () => {
		await api('PATCH', `/v1/brands/${ids.alpha.id}`, { status: 'hidden' });
		expect(await sitemap()).not.toContain(`brand=${ids.alpha.slug}`);
		expect((await listing(`category=${ids.dresses.slug}&brand=${ids.alpha.slug}`)).landing).toBeNull();
		await api('PATCH', `/v1/brands/${ids.alpha.id}`, { status: 'active' });
	});
});

describe('SEO copy when saving (E43)', () => {
	it('writes nothing while autoSeo is off', async () => {
		const item = await api('POST', '/v1/products', { name: 'Plain tee', summary: 'Soft cotton.', price: 100 });
		expect(item.seo).toMatchObject({ title: '', description: '' });
	});

	it('stores nothing without the merchant’s AI: the patterns fill the answers on every read (G6)', async () => {
		await shop.setting('seo', 'autoSeo', 'on_save');
		await shop.setting('seo', 'productTitle', '{name} by {brand}');
		const item = await api('POST', '/v1/products', {
			name: 'Linen shirt',
			status: 'active',
			summary: 'Cool linen for summer.',
			brandId: ids.beta.id,
			price: 100,
			seo: { description: 'Kept as typed.' },
		});
		expect(item.seo).toMatchObject({ title: '', description: 'Kept as typed.', source: 'merchant' });
		expect(item.faqs).toEqual([]);
		expect((await api('GET', `/v1/seo/products/${item.slug}`)).title).toBe('Linen shirt by Beta | Shop');
		// never stale: a new name shows on the next read
		await api('PATCH', `/v1/products/${item.id}`, { name: 'Linen shirt II' });
		expect((await api('GET', `/v1/products/${item.id}`)).seo.title).toBe('');
		expect((await api('GET', `/v1/seo/products/${item.slug}`)).title).toBe('Linen shirt II by Beta | Shop');
		expect(shop.callsTo(AI)).toHaveLength(0);
		await shop.setting('landing_pages', 'attributeDescription', '{name} in {unit}.');
		const sleeve = await api('POST', '/v1/attributes', { name: 'Sleeve', unit: 'cm', categoryId: ids.dresses.id });
		expect(sleeve.seo).toMatchObject({ title: '', description: '', faqs: [] });
	});

	it('asks the merchant’s AI when AI copy is on and keeps its copy marked as AI copy; nothing when it fails', async () => {
		await shop.connect('ai', { baseUrl: AI, apiKey: 'sk-test-123456', model: 'm' });
		/** @type {any[]} */
		const asked = [];
		shop.responders.set(AI, (call) => {
			asked.push(JSON.parse(call.body));
			return {
				status: 200,
				body: {
					choices: [
						{
							message: {
								content: JSON.stringify({
									seoTitle: 'Wool coat for winter',
									seoDescription: 'A warm wool coat.',
									title: 'What is a hem?',
									description: 'The folded edge.',
									faqs: [{ question: 'Is it warm?', answer: 'Yes.' }],
								}),
							},
						},
					],
				},
			};
		});
		const coat = await api('POST', '/v1/products', { name: 'Wool coat', price: 100 });
		expect(coat.seo).toMatchObject({ title: 'Wool coat for winter', description: 'A warm wool coat.', source: 'ai' });
		expect((await api('GET', `/v1/products/${coat.id}`)).seo.source).toBe('ai');
		expect(coat.faqs).toEqual([{ question: 'Is it warm?', answer: 'Yes.' }]);
		expect(asked[0].messages[1].content).toContain('Name: Wool coat');
		const hem = await api('POST', '/v1/attributes', { name: 'Hem' });
		expect(hem.seo).toMatchObject({ title: 'What is a hem?', description: 'The folded edge.' });
		shop.responders.set(AI, () => ({ status: 500, body: {} }));
		const cap = await api('POST', '/v1/products', { name: 'Wool cap', summary: 'Warm.', brandId: ids.beta.id, price: 100 });
		expect(cap.seo).toMatchObject({ title: '', description: '', source: null });
		expect(cap.faqs).toEqual([]);
		// AI copy off: the key is never used
		await shop.switchOn((await on()).filter((feature) => feature !== 'ai_copy'));
		const before = shop.callsTo(AI).length;
		await api('POST', '/v1/products', { name: 'Wool scarf', price: 100 });
		expect(shop.callsTo(AI)).toHaveLength(before);
		await shop.switchOn([...(await on()), 'ai_copy']);
		await shop.setting('seo', 'autoSeo', 'off');
	});

	it('writes one automatic landing page with AI copy when a product is saved (autoCopy ai)', async () => {
		shop.responders.set(AI, () => ({
			status: 200,
			body: {
				choices: [
					{
						message: {
							content: JSON.stringify({
								h1: 'Alpha dresses',
								title: 'Alpha dresses online',
								description: 'Every Alpha dress.',
								intro: 'Light and easy.',
								faqs: [],
							}),
						},
					},
				],
			},
		}));
		const alpha = await api('POST', '/v1/products', {
			name: 'Alpha three',
			status: 'active',
			categoryIds: [ids.dresses.id],
			brandId: ids.alpha.id,
			price: 100,
		});
		// autoCopy formula: nothing written
		expect((await api('GET', '/v1/landings')).items).toEqual([]);
		await shop.setting('landing_pages', 'autoCopy', 'ai');
		await api('PATCH', `/v1/products/${alpha.id}`, { summary: 'Saved again.' });
		const [written] = (await api('GET', '/v1/landings')).items;
		expect(written).toMatchObject({
			categoryId: ids.dresses.id,
			brandId: ids.alpha.id,
			grade: null,
			h1: 'Alpha dresses',
			title: 'Alpha dresses online',
			indexable: 'auto',
			indexed: true,
		});
		await api('PATCH', `/v1/products/${alpha.id}`, { summary: 'And again.' });
		expect((await api('GET', '/v1/landings')).items).toHaveLength(1);
		expect((await listing(`category=${ids.dresses.slug}&brand=${ids.alpha.slug}`)).landing).toMatchObject({
			id: written.id,
			automatic: false,
		});
	});
});

/**
 * The features on now.
 * @returns {Promise<string[]>}
 */
const on = async () =>
	(await api('GET', '/v1/features')).features
		.filter((/** @type {any} */ feature) => feature.on)
		.map((/** @type {any} */ feature) => String(feature.key));
