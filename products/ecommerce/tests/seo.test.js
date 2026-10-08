/**
 * Catalog SEO, feeds, llms.txt and policies (PLAN 0.8.8, 0.4.10): the server-token answers the merchant's site serves
 * on its own domain, and the pure builders behind them.
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csvCell, feedRows, googleItem, metaLine } from '../core/feeds.js';
import { buildLlmsTxt, markdownText, MAX_LLMS_CHARS, treeOrder } from '../core/llms.js';
import { COLLECTIONS } from '../core/model.js';
import {
	clip,
	conditionOf,
	escapeXml,
	fillTitle,
	metaDescription,
	scriptJson,
	sitemapEntry,
	sitemapIndex,
	sitemapPageUrl,
	sitemapSlice,
} from '../core/seo.js';
import { DOMAIN, ORIGIN, readyShop } from './helpers.js';

/** @typedef {import('../core/model.js').ProductRecord} ProductRecord */
/** @typedef {import('../core/model.js').VariantRecord} VariantRecord */

/**
 * A variant.
 * @param {Partial<VariantRecord>} [input]
 * @returns {VariantRecord}
 */
const variant = (input = {}) => ({
	id: createId('var'),
	sku: '',
	options: {},
	price: 1000,
	compareAtPrice: null,
	cost: null,
	stock: 5,
	locations: {},
	grade: null,
	active: true,
	...input,
});

describe('core/seo', () => {
	it('escapes XML and drops characters XML cannot hold', () => {
		expect(escapeXml(`a<b>&"c"'d'\u0001`)).toBe('a&lt;b&gt;&amp;&quot;c&quot;&apos;d&apos;');
		expect(escapeXml(null)).toBe('');
	});

	it('writes JSON-LD that can never close its script element', () => {
		const text = scriptJson({ name: '</script><script>alert(1)</script> & \u2028\u2029' });
		expect(text).not.toContain('<');
		expect(text).not.toContain('>');
		expect(text).not.toContain('&');
		expect(JSON.parse(text).name).toBe('</script><script>alert(1)</script> & \u2028\u2029');
	});

	it('cuts text at a word and fills titles', () => {
		expect(clip('  short  text ', 50)).toBe('short text');
		expect(clip('one two three four five six', 15)).toBe('one two three…');
		expect(clip('abcdefghijklmnopqrstuvwxyz', 10)).toBe('abcdefghi…');
		expect(clip(undefined, 5)).toBe('');
		expect(fillTitle('{name} | {business}', { name: 'Phone', business: 'Shop' })).toBe('Phone | Shop');
		expect(fillTitle('', { name: 'Phone', business: 'Shop' })).toBe('Phone');
		expect(fillTitle('   ', { name: 'Phone', business: 'Shop' })).toBe('Phone');
		expect(metaDescription('', '  ', 'Third')).toBe('Third');
		expect(metaDescription(undefined, null)).toBe('');
	});

	it('gives conditions only to physical goods', () => {
		expect(conditionOf({ kind: 'physical' }, { grade: 'a' }, 'refurbished')).toBe('refurbished');
		expect(conditionOf({ kind: 'physical' }, { grade: null }, 'used')).toBe('new');
		expect(conditionOf({ kind: 'digital' }, { grade: 'a' }, 'used')).toBe('');
	});

	it('writes sitemap entries, indexes and page addresses', () => {
		expect(sitemapEntry({ loc: 'https://a.example/p?x=1&y=2', lastmod: new Date('2026-01-02T03:04:05Z') })).toBe(
			'<url><loc>https://a.example/p?x=1&amp;y=2</loc><lastmod>2026-01-02T03:04:05.000Z</lastmod></url>\n',
		);
		expect(sitemapEntry({ loc: 'https://a.example/', lastmod: 'not a date' })).toBe(
			'<url><loc>https://a.example/</loc></url>\n',
		);
		expect(sitemapEntry({ loc: 'https://a.example/', lastmod: null })).not.toContain('lastmod');
		expect(sitemapIndex(['https://a.example/s.xml?page=1'])).toContain(
			'<sitemap><loc>https://a.example/s.xml?page=1</loc></sitemap>',
		);
		expect(sitemapPageUrl('/sitemap.xml', 'a.example', 2)).toBe('https://a.example/sitemap.xml?page=2');
		expect(sitemapPageUrl('sitemap.php?x=1', 'a.example', 3)).toBe('https://a.example/sitemap.php?x=1&page=3');
		expect(sitemapPageUrl('https://cdn.example/map.xml', 'a.example', 1)).toBe('https://cdn.example/map.xml?page=1');
		expect(sitemapPageUrl('', 'a.example', 1)).toBe('https://a.example/sitemap.xml?page=1');
	});

	it('splits categories and products over sitemap pages', () => {
		expect(sitemapSlice({ categories: 3, products: 4, page: 1, size: 5 })).toEqual({
			pages: 2,
			categories: { skip: 0, limit: 3 },
			products: { skip: 0, limit: 2 },
		});
		expect(sitemapSlice({ categories: 3, products: 4, page: 2, size: 5 })).toEqual({
			pages: 2,
			categories: { skip: 0, limit: 0 },
			products: { skip: 2, limit: 2 },
		});
		expect(sitemapSlice({ categories: 7, products: 1, page: 1, size: 5 })).toEqual({
			pages: 2,
			categories: { skip: 0, limit: 5 },
			products: { skip: 0, limit: 0 },
		});
		expect(sitemapSlice({ categories: 0, products: 0, page: 1 }).pages).toBe(1);
	});
});

describe('core/feeds and core/llms', () => {
	/** @type {ProductRecord} */
	const product = /** @type {any} */ ({
		id: 'prd_1',
		name: 'Phone',
		kind: 'physical',
		summary: 'Summary',
		description: '',
		trackStock: true,
		variants: [
			variant({ id: 'var_a', options: { Colour: 'Red' }, price: 900, compareAtPrice: 1200, sku: 'SKU-A', grade: 'a' }),
			variant({ id: 'var_b', options: { Colour: 'Blue' }, stock: 0, sku: 'SKU-B' }),
			variant({ id: 'var_c', active: false }),
		],
	});
	const context = {
		link: 'https://shop.example/p',
		image: 'https://cdn.example/i.jpg',
		brand: 'Brand',
		productType: 'Phones > Android',
		currency: 'USD',
		graded: /** @type {const} */ ('refurbished'),
		skuAs: /** @type {const} */ ('mpn'),
		includeOutOfStock: true,
	};

	it('makes one row per active variant', () => {
		const rows = feedRows(product, context);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			id: 'var_a',
			itemGroupId: 'prd_1',
			title: 'Phone - Red',
			description: 'Summary',
			price: '12.00 USD',
			salePrice: '9.00 USD',
			inStock: true,
			condition: 'refurbished',
			mpn: 'SKU-A',
			gtin: '',
		});
		expect(rows[1]).toMatchObject({ inStock: false, condition: 'new', salePrice: '' });
		expect(feedRows(product, { ...context, includeOutOfStock: false, skuAs: 'gtin' })).toEqual([
			expect.objectContaining({ id: 'var_a', gtin: 'SKU-A', mpn: '' }),
		]);
		const single = feedRows({ ...product, variants: [variant({ id: 'var_s' })], description: 'Long' }, context);
		expect(single[0]).toMatchObject({ itemGroupId: '', title: 'Phone', description: 'Long' });
	});

	it('writes Google items and Meta lines', () => {
		const [row] = feedRows(product, context);
		const item = googleItem(/** @type {any} */ ({ ...row, title: 'A & <B>' }));
		expect(item).toContain('<g:id>var_a</g:id>');
		expect(item).toContain('<title>A &amp; &lt;B&gt;</title>');
		expect(item).toContain('<g:availability>in_stock</g:availability>');
		expect(item).not.toContain('<g:gtin>');
		const out = googleItem(/** @type {any} */ ({ ...row, inStock: false }));
		expect(out).toContain('out_of_stock');
		expect(metaLine(/** @type {any} */ (row))).toBe(
			'var_a,Phone - Red,Summary,in stock,refurbished,9.00 USD,https://shop.example/p,https://cdn.example/i.jpg,Brand,prd_1\r\n',
		);
		expect(metaLine(/** @type {any} */ ({ ...row, inStock: false, condition: '', salePrice: '' }))).toContain(
			'out of stock,new,12.00 USD',
		);
		expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
	});

	it('writes llms.txt within its bounds', () => {
		const text = buildLlmsTxt({
			name: 'Shop [best]',
			description: 'We sell\nphones.',
			home: 'https://shop.example/',
			categories: [{ name: 'Phones', url: 'https://shop.example/c/phones (new)', description: 'All phones', depth: 1 }],
			products: [{ name: 'Phone', url: 'https://shop.example/p/phone', price: 'USD 10.00', summary: '' }],
			policies: [
				{ title: 'Returns', text: '30 days.' },
				{ title: 'Terms', text: '  ' },
			],
			headings: { categories: 'Categories', products: 'Products', policies: 'Policies' },
		});
		expect(text).toBe(
			[
				'# Shop \\[best\\]',
				'',
				'> We sell phones.',
				'',
				'- [Shop \\[best\\]](https://shop.example/)',
				'',
				'## Categories',
				'',
				'  - [Phones](https://shop.example/c/phones%20%28new%29): All phones',
				'',
				'## Products',
				'',
				'- [Phone](https://shop.example/p/phone): USD 10.00',
				'',
				'## Policies',
				'',
				'- Returns: 30 days.',
				'',
			].join('\n'),
		);
		const empty = buildLlmsTxt({
			name: 'Shop',
			description: '',
			home: 'https://shop.example/',
			categories: [],
			products: [],
			policies: [],
			headings: { categories: 'C', products: 'P', policies: 'X' },
		});
		expect(empty).toBe('# Shop\n\n- [Shop](https://shop.example/)\n');
		const huge = buildLlmsTxt({
			name: 'Shop',
			description: '',
			home: 'https://shop.example/',
			categories: [],
			products: Array.from({ length: 2000 }, (_, index) => ({
				name: `Product ${index} ${'x'.repeat(60)}`,
				url: `https://shop.example/p/${index}`,
				price: 'USD 1.00',
				summary: 'y'.repeat(100),
			})),
			policies: [],
			headings: { categories: 'C', products: 'P', policies: 'X' },
		});
		expect(huge.length).toBeLessThanOrEqual(MAX_LLMS_CHARS + 1);
		expect(markdownText('a\\b')).toBe('a\\\\b');
	});

	it('orders categories as a tree', () => {
		const ordered = treeOrder([
			{ id: 'c2', parentId: null, name: 'B', sort: 0 },
			{ id: 'c3', parentId: 'c1', name: 'Child', sort: 0 },
			{ id: 'c1', parentId: null, name: 'A', sort: 0 },
			{ id: 'c4', parentId: 'gone', name: 'Orphan', sort: 5 },
		]);
		expect(ordered.map((category) => [category.id, category.depth])).toEqual([
			['c1', 0],
			['c3', 1],
			['c2', 0],
			['c4', 0],
		]);
	});
});

describe('SEO, feeds, llms.txt and policies routes', () => {
	/** @type {Awaited<ReturnType<typeof readyShop>>} */
	let shop;
	/** @type {ProductRecord} */
	let phone;
	/** @type {ProductRecord} */
	let ebook;

	beforeAll(async () => {
		shop = await readyShop();
		const data = await shop.db();
		await data.collection(COLLECTIONS.categories).insertMany([
			{
				id: 'cat_root',
				slug: 'phones',
				name: 'Phones',
				parentId: null,
				path: [],
				description: 'Every phone we sell.',
				seo: { title: '', description: '' },
				image: null,
				sort: 0,
			},
			{
				id: 'cat_android',
				slug: 'android',
				name: 'Android',
				parentId: 'cat_root',
				path: ['cat_root'],
				description: '',
				seo: { title: 'Android phones', description: 'Android phones, new and used.' },
				image: { key: 'ecommerce/categories/cat_android/a.jpg', type: 'image/jpeg', size: 10, alt: '' },
				sort: 0,
			},
		]);
		await data
			.collection(COLLECTIONS.brands)
			.insertOne({ id: 'brd_1', slug: 'acme', name: 'Acme', description: '', logo: null });
		phone = await shop.seedProduct({
			slug: 'acme-phone',
			name: 'Acme </script> Phone',
			summary: 'A good phone.',
			categoryIds: ['cat_android'],
			brandId: 'brd_1',
			sold: 9,
			rating: { average: 4.36, count: 3 },
			media: [{ key: 'ecommerce/products/p/1.jpg', type: 'image/jpeg', size: 10, alt: '' }],
			options: [{ name: 'Colour', values: ['Red', 'Blue'] }],
			variants: [
				variant({ options: { Colour: 'Red' }, price: 25000, compareAtPrice: 30000, sku: 'AP-R', grade: 'b' }),
				variant({ options: { Colour: 'Blue' }, price: 26000, stock: 0, sku: 'AP-B' }),
			],
		});
		ebook = await shop.seedProduct({ slug: 'ebook', name: 'Ebook', kind: 'digital', trackStock: false, stock: 0, price: 500 });
		await shop.seedProduct({ slug: 'hidden', name: 'Hidden', status: 'draft' });
	});
	afterAll(async () => shop.product.close());

	it('answers a product page: title, description, canonical, image and JSON-LD', async () => {
		await shop.setting('seo', 'gradedCondition', 'refurbished');
		const byId = await shop.api('GET', `/v1/seo/products/${phone.id}`);
		expect(byId.status).toBe(200);
		const bySlug = await shop.api('GET', '/v1/seo/products/acme-phone');
		expect(bySlug.json).toEqual(byId.json);
		const answer = byId.json;
		expect(answer.title).toMatch(/^Acme <\/script> Phone \| /);
		expect(answer.description).toBe('A good phone.');
		expect(answer.canonical).toBe(`${ORIGIN}/products/acme-phone`);
		expect(answer.image).toMatch(/^https:\/\//);
		expect(answer.jsonLd).not.toContain('</script>');
		const graph = JSON.parse(answer.jsonLd)['@graph'];
		const [node, crumbs] = graph;
		expect(node).toMatchObject({
			'@type': 'Product',
			name: 'Acme </script> Phone',
			brand: { '@type': 'Brand', name: 'Acme' },
			aggregateRating: { ratingValue: 4.4, reviewCount: 3 },
		});
		expect(node.itemCondition).toBeUndefined();
		expect(node.offers).toHaveLength(2);
		expect(node.offers[0]).toMatchObject({
			price: '250.00',
			priceCurrency: 'USD',
			availability: 'https://schema.org/InStock',
			itemCondition: 'https://schema.org/RefurbishedCondition',
			sku: 'AP-R',
			name: 'Red',
		});
		expect(node.offers[1]).toMatchObject({
			availability: 'https://schema.org/OutOfStock',
			itemCondition: 'https://schema.org/NewCondition',
		});
		expect(crumbs.itemListElement.map((/** @type {any} */ step) => step.name)).toEqual([
			expect.any(String),
			'Phones',
			'Android',
			'Acme </script> Phone',
		]);
		expect(crumbs.itemListElement[0].item).toBe(`${ORIGIN}/`);
	});

	it('answers a single-variant digital product without condition or rating', async () => {
		await shop.setting('seo', 'titleTemplate', '{name}');
		const answer = (await shop.api('GET', `/v1/seo/products/${ebook.slug}`)).json;
		expect(answer.title).toBe('Ebook');
		expect(answer.image).toBeNull();
		const [node, crumbs] = JSON.parse(answer.jsonLd)['@graph'];
		expect(node.offers).toMatchObject({ '@type': 'Offer', price: '5.00', availability: 'https://schema.org/InStock' });
		expect(node.offers.itemCondition).toBeUndefined();
		expect(node.aggregateRating).toBeUndefined();
		expect(crumbs.itemListElement).toHaveLength(2);
		expect((await shop.api('GET', '/v1/seo/products/hidden')).json.type).toMatch(/not_found$/);
		expect((await shop.api('GET', `/v1/seo/products/${'x'.repeat(201)}`)).status).toBe(404);
	});

	it('answers a category page', async () => {
		const android = (await shop.api('GET', '/v1/seo/categories/android')).json;
		expect(android).toMatchObject({
			title: 'Android phones',
			description: 'Android phones, new and used.',
			canonical: `${ORIGIN}/categories/android`,
		});
		expect(android.image).toMatch(/^https:\/\//);
		const [page, crumbs] = JSON.parse(android.jsonLd)['@graph'];
		expect(page).toMatchObject({ '@type': 'CollectionPage', name: 'Android' });
		expect(crumbs.itemListElement.map((/** @type {any} */ step) => step.name).slice(1)).toEqual(['Phones', 'Android']);
		const root = (await shop.api('GET', '/v1/seo/categories/cat_root')).json;
		expect(root).toMatchObject({ title: 'Phones', description: 'Every phone we sell.', image: null });
		expect((await shop.api('GET', '/v1/seo/categories/none')).status).toBe(404);
	});

	it('serves the sitemap of active products and categories', async () => {
		const answer = await shop.api('GET', '/v1/seo/sitemap.xml');
		expect(answer.status).toBe(200);
		expect(answer.headers.get('content-type')).toContain('application/xml');
		expect(answer.text).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
		expect(answer.text).toContain(`<loc>${ORIGIN}/products/acme-phone</loc><lastmod>`);
		expect(answer.text).toContain(`<loc>${ORIGIN}/categories/android</loc>`);
		expect(answer.text).not.toContain('hidden');
		expect((answer.text.match(/<url>/g) ?? []).length).toBe(4);
		expect((await shop.api('GET', '/v1/seo/sitemap.xml?page=1')).text).toBe(answer.text);
		expect((await shop.api('GET', '/v1/seo/sitemap.xml?page=2')).status).toBe(404);
		expect((await shop.api('GET', '/v1/seo/sitemap.xml?page=0')).status).toBe(400);
	});

	it('serves the Google and Meta feeds', async () => {
		const google = await shop.api('GET', '/v1/feeds/products.xml');
		expect(google.status).toBe(200);
		expect(google.text).toContain('xmlns:g="http://base.google.com/ns/1.0"');
		expect(google.text).toContain('<title>Acme &lt;/script&gt; Phone - Red</title>');
		expect(google.text).toContain('<g:product_type>Phones &gt; Android</g:product_type>');
		expect(google.text).toContain('<g:sale_price>250.00 USD</g:sale_price>');
		expect(google.text).toContain('<g:condition>used</g:condition>');
		expect(google.text).toContain('<g:brand>Acme</g:brand>');
		expect(google.text).not.toContain('Ebook');
		const csv = await shop.api('GET', '/v1/feeds/products.csv');
		expect(csv.headers.get('content-type')).toContain('text/csv');
		const lines = csv.text.trim().split('\r\n');
		expect(lines[0]).toBe('id,title,description,availability,condition,price,link,image_link,brand,item_group_id');
		expect(lines).toHaveLength(3);
		expect(lines[2]).toContain('out of stock');

		await shop.setting('feeds', 'items', 'all');
		await shop.setting('feeds', 'includeOutOfStock', false);
		await shop.setting('feeds', 'skuAs', 'mpn');
		const all = await shop.api('GET', '/v1/feeds/products.xml');
		expect(all.text).toContain('Ebook');
		expect(all.text).toContain('<g:mpn>AP-R</g:mpn>');
		expect(all.text).not.toContain('AP-B');
		expect(all.text.match(/<item>/g)).toHaveLength(2);
	});

	it('serves llms.txt with categories, top products and policies', async () => {
		await shop.setting('llms_txt', 'description', 'Phones and books.');
		await shop.setting('checkout', 'policyReturns', 'Returns within 14 days.');
		const answer = await shop.api('GET', '/v1/llms.txt');
		expect(answer.status).toBe(200);
		expect(answer.headers.get('content-type')).toContain('text/plain');
		expect(answer.text).toContain('> Phones and books.');
		expect(answer.text).toContain(`- [Phones](${ORIGIN}/categories/phones): Every phone we sell.`);
		expect(answer.text).toContain(`  - [Android](${ORIGIN}/categories/android): Android phones, new and used.`);
		expect(answer.text).toContain(`- [Acme </script> Phone](${ORIGIN}/products/acme-phone): USD 250.00 — A good phone.`);
		expect(answer.text.indexOf('Acme')).toBeLessThan(answer.text.indexOf('Ebook'));
		expect(answer.text).toContain('- Returns: Returns within 14 days.');
		await shop.setting('llms_txt', 'products', 0);
		await shop.setting('llms_txt', 'policies', false);
		const bare = (await shop.api('GET', '/v1/llms.txt')).text;
		expect(bare).not.toContain('## Products');
		expect(bare).not.toContain('## Policies');
	});

	it('answers the policies to visitors and the server', async () => {
		await shop.setting('checkout', 'policyShipping', 'Ships in 2 days.');
		const server = await shop.api('GET', '/v1/policies');
		expect(server.json).toEqual({ shipping: 'Ships in 2 days.', returns: 'Returns within 14 days.', privacy: '', terms: '' });
		const visitor = await shop.visitor('GET', '/v1/shop/policies');
		expect(visitor.json).toEqual(server.json);
		expect(DOMAIN).toBe(new URL(ORIGIN).host);
	});

	it('splits a large sitemap into pages behind an index', async () => {
		const data = await shop.db();
		const docs = Array.from({ length: 50_001 }, (_, index) => ({
			id: `cat_bulk${String(index).padStart(6, '0')}`,
			slug: `bulk-${index}`,
			name: `Bulk ${index}`,
			parentId: null,
			path: [],
			description: '',
			seo: { title: '', description: '' },
			image: null,
			sort: 1,
		}));
		await data.collection(COLLECTIONS.categories).insertMany(docs);
		const index = await shop.api('GET', '/v1/seo/sitemap.xml');
		expect(index.text).toContain('<sitemapindex');
		expect(index.text).toContain(`<loc>${ORIGIN}/sitemap.xml?page=2</loc>`);
		const second = await shop.api('GET', '/v1/seo/sitemap.xml?page=2');
		expect((second.text.match(/<url>/g) ?? []).length).toBe(50_005 - 50_000);
		expect(second.text).toContain('/products/');
	}, 120_000);

	it('writes many products in pieces', async () => {
		const data = await shop.db();
		const at = new Date('2026-10-01T00:00:00Z');
		await data.collection(COLLECTIONS.products).insertMany(
			Array.from({ length: 300 }, (_, index) => ({
				...phone,
				id: `prd_bulk${String(index).padStart(6, '0')}`,
				slug: `bulk-product-${index}`,
				name: `Bulk ${index}`,
				brandId: 'brd_missing',
				categoryIds: [],
				rating: { average: 0, count: 0 },
				variants: [variant({ price: 100 + index })],
				updatedAt: at,
			})),
		);
		const google = await shop.api('GET', '/v1/feeds/products.xml');
		expect(google.text.match(/<item>/g)).toHaveLength(302);
		expect(google.text).toContain('<title>Bulk 299</title>');
		const page = await shop.api('GET', '/v1/seo/sitemap.xml?page=2');
		expect(page.text).toContain('/products/bulk-product-299</loc>');
		const answer = (await shop.api('GET', '/v1/seo/products/bulk-product-1')).json;
		const [node] = JSON.parse(answer.jsonLd)['@graph'];
		expect(node.brand).toBeUndefined();
		expect(node.aggregateRating).toBeUndefined();
	}, 120_000);
});
