/**
 * Catalog SEO, feeds, llms.txt and policies (PLAN 0.8.8, 0.4.10): the server-token answers the merchant's site serves
 * on its own domain, and the pure builders behind them.
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csvCell, feedMoney, feedRows, googleItem, metaLine } from '../core/feeds.js';
import { gradeCondition } from '../core/grades.js';
import { listShown } from '../core/promotions.js';
import { buildLlmsTxt, markdownText, MAX_LLMS_CHARS, treeOrder } from '../core/llms.js';
import { COLLECTIONS } from '../core/model.js';
import {
	clip,
	escapeXml,
	feedItemId,
	fillTitle,
	metaDescription,
	scriptJson,
	robotsOf,
	sitemapEntry,
	sitemapFileUrl,
	sitemapFiles,
	sitemapIndex,
} from '../core/seo.js';
import { DOMAIN, ORIGIN, readyShop, storedBrand, storedCategory } from './helpers.js';

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
	attributes: {},
	media: [],
	soldOut: false,
	warrantyDays: null,
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

	it('writes sitemap entries, indexes and page addresses', () => {
		expect(sitemapEntry({ loc: 'https://a.example/p?x=1&y=2', lastmod: new Date('2026-01-02T03:04:05Z') })).toBe(
			'<url><loc>https://a.example/p?x=1&amp;y=2</loc><lastmod>2026-01-02T03:04:05.000Z</lastmod></url>\n',
		);
		expect(sitemapEntry({ loc: 'https://a.example/', lastmod: 'not a date' })).toBe(
			'<url><loc>https://a.example/</loc></url>\n',
		);
		expect(sitemapEntry({ loc: 'https://a.example/', lastmod: null })).not.toContain('lastmod');
		expect(
			sitemapIndex([
				{ loc: 'https://a.example/s.xml?page=1', lastmod: null },
				{ loc: 'https://a.example/s.xml?page=2', lastmod: new Date('2026-01-02T03:04:05Z') },
			]),
		).toContain(
			'<sitemap><loc>https://a.example/s.xml?page=1</loc></sitemap>\n<sitemap><loc>https://a.example/s.xml?page=2</loc><lastmod>2026-01-02T03:04:05.000Z</lastmod></sitemap>\n',
		);
		expect(sitemapEntry({ loc: 'https://a.example/', lastmod: null, images: ['https://c.example/a&b.jpg'] })).toBe(
			'<url><loc>https://a.example/</loc><image:image><image:loc>https://c.example/a&amp;b.jpg</image:loc></image:image></url>\n',
		);
		expect(sitemapFileUrl('/sitemap.xml', 'a.example', 'products-2')).toBe('https://a.example/sitemap.xml?file=products-2');
		expect(sitemapFileUrl('sitemap.php?x=1', 'a.example', 'categories')).toBe(
			'https://a.example/sitemap.php?x=1&file=categories',
		);
		expect(sitemapFileUrl('https://cdn.example/map.xml', 'a.example', 'landings')).toBe(
			'https://cdn.example/map.xml?file=landings',
		);
		expect(sitemapFileUrl('', 'a.example', 'categories')).toBe('https://a.example/sitemap.xml?file=categories');
		expect(robotsOf(undefined)).toBe('index, follow');
		expect(robotsOf({ noindex: true, nofollow: true })).toBe('noindex, nofollow');
	});

	it('names the files of a sitemap index, the home page always in the first', () => {
		expect(sitemapFiles({ landings: 0, products: 2500, size: 1000 })).toEqual([
			'categories',
			'products-1',
			'products-2',
			'products-3',
		]);
		expect(sitemapFiles({ landings: 2, products: 0, size: 1000 })).toEqual(['categories', 'landings']);
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
			variant({ id: 'var_a', options: { Color: 'Red' }, price: 900, compareAtPrice: 1200, sku: 'SKU-A', grade: 'a' }),
			variant({ id: 'var_b', options: { Color: 'Blue' }, stock: 0, sku: 'SKU-B' }),
			variant({ id: 'var_c', active: false }),
		],
	});
	const context = {
		link: 'https://shop.example/p',
		image: 'https://cdn.example/i.jpg',
		brand: 'Brand',
		productType: 'Phones > Android',
		currency: 'USD',
		condition: (/** @type {VariantRecord} */ v) =>
			gradeCondition(product, v, new Map([['a', /** @type {any} */ ({ condition: 'refurbished' })]])),
		skuAs: /** @type {const} */ ('mpn'),
		includeOutOfStock: true,
		shown: listShown,
		now: Date.parse('2026-10-05T10:00:00Z'),
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
		// a variant's own GTIN and MPN come before the SKU sent as one (G5.6)
		const coded = {
			...product,
			variants: [
				{ ...variant({ id: 'var_g', sku: 'SKU-G' }), gtin: '4006381333931', mpn: 'MX-100' },
				variant({ id: 'var_h' }),
			],
		};
		expect(feedRows(coded, { ...context, skuAs: 'gtin' }).map((row) => [row.gtin, row.mpn])).toEqual([
			['4006381333931', 'MX-100'],
			['', ''],
		]);
		expect(feedRows(coded, { ...context, skuAs: 'mpn' })[0]).toMatchObject({ gtin: '4006381333931', mpn: 'MX-100' });
		const [withCodes] = feedRows(coded, { ...context, skuAs: 'none', identifierExists: 'no' });
		expect(withCodes).toMatchObject({ identifierExists: '' });
		expect(googleItem(/** @type {any} */ (withCodes))).toContain('<g:gtin>4006381333931</g:gtin><g:mpn>MX-100</g:mpn>');
		expect(metaLine(/** @type {any} */ (withCodes))).toContain(',Brand,4006381333931,MX-100,,prd_1,');
		const single = feedRows({ ...product, variants: [variant({ id: 'var_s' })], description: 'Long' }, context);
		expect(single[0]).toMatchObject({ itemGroupId: '', title: 'Phone', description: 'Long' });
		// E17: imported feed ids, the Google category, the grade label, shipping, whole units, variant links and photos
		const legacy = feedRows(
			{
				...product,
				id: 'prd_0123456789abcdef01234567',
				variants: [
					{
						...variant({ id: 'var_76543210fedcba9876543210', price: 1250, grade: 'a' }),
						feedId: '0123456789abcdef01234567_76543210fedcba9876543210',
					},
					variant({ id: 'var_new' }),
				],
			},
			{
				...context,
				googleCategory: '267',
				gradeLabel: (v) => (v.grade ? 'Grade A' : ''),
				shipping: { fee: 250, country: 'US' },
				wholeUnits: true,
				variantLink: (v) => `https://shop.example/p?v=${v.id}`,
				variantImage: (v) => (v.grade ? 'https://cdn.example/v.jpg' : ''),
			},
		);
		expect(legacy[0]).toMatchObject({
			id: '0123456789abcdef01234567_76543210fedcba9876543210',
			googleCategory: '267',
			customLabels: ['Grade A', '', '', '', ''],
			shipping: '3 USD',
			shippingCountry: 'US',
			price: '13 USD',
			link: 'https://shop.example/p?v=var_76543210fedcba9876543210',
			image: 'https://cdn.example/v.jpg',
		});
		expect(legacy[1]).toMatchObject({ id: 'var_new', customLabels: ['', '', '', '', ''], image: 'https://cdn.example/i.jpg' });
		// field values the merchant sends (`show.feeds`): the grade label keeps custom label 0, the first value wins a column
		const [labelled] = feedRows(product, {
			...context,
			gradeLabel: () => 'Grade A',
			values: () =>
				[
					{ target: 'custom_label_0', name: 'Season', value: 'Summer' },
					{ target: 'custom_label_2', name: 'Season', value: 'Summer' },
					{ target: 'color', name: 'Color', value: 'Red' },
					{ target: 'color', name: 'Shade', value: 'Dark red' },
					{ target: 'material', name: 'Material', value: 'Cotton' },
					{ target: 'size', name: 'Size', value: 'M' },
					{ target: 'pattern', name: 'Pattern', value: 'x'.repeat(150) },
				].map((entry) => ({ ...entry, values: [entry.value], raw: [entry.value] })),
		});
		expect(labelled).toMatchObject({
			customLabels: ['Grade A', '', 'Summer', '', ''],
			color: 'Red',
			material: 'Cotton',
			size: 'M',
			pattern: 'x'.repeat(100),
		});
		const labelledItem = googleItem(/** @type {any} */ (labelled));
		expect(labelledItem).toContain('<g:color>Red</g:color><g:material>Cotton</g:material><g:size>M</g:size>');
		expect(labelledItem).toContain('<g:custom_label_0>Grade A</g:custom_label_0><g:custom_label_2>Summer</g:custom_label_2>');
		expect(metaLine(/** @type {any} */ (labelled))).toContain(',Red,Cotton,M,');
		const item = googleItem(/** @type {any} */ (legacy[0]));
		expect(item).toContain('<g:google_product_category>267</g:google_product_category>');
		expect(item).toContain('<g:custom_label_0>Grade A</g:custom_label_0>');
		expect(item).toContain('<g:shipping><g:country>US</g:country><g:price>3 USD</g:price></g:shipping>');
		expect(feedItemId(/** @type {any} */ ({ id: 'var_y' }))).toBe('var_y');
		expect(feedItemId(/** @type {any} */ ({ id: 'var_y', feedId: '' }))).toBe('var_y');
		expect(feedItemId(/** @type {any} */ ({ id: 'var_y', feedId: 'old_1' }))).toBe('old_1');
		expect(feedMoney(1050, 'EUR', false)).toBe('10.50 EUR');
		expect(feedMoney(1050, 'EUR', true)).toBe('11 EUR');
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
		// Meta gets the regular price and the sale price in their own columns (G4)
		expect(metaLine(/** @type {any} */ (row))).toBe(
			'var_a,Phone - Red,Summary,in stock,refurbished,12.00 USD,9.00 USD,,https://shop.example/p,https://cdn.example/i.jpg,,Brand,,SKU-A,,prd_1,,,,,,,,,,,,,\r\n',
		);
		// a variant's package weight goes out as its shipping weight when its item type has packages
		expect(row?.shippingWeight).toBe('');
		const parcel = { weightG: 180, lengthMm: null, widthMm: null, heightMm: null };
		const weighed = {
			...product,
			variants: product.variants.map((variant) => ({ ...variant, parcel })),
		};
		const [heavy] = feedRows(/** @type {any} */ (weighed), { ...context, parcels: true });
		expect(googleItem(/** @type {any} */ (heavy))).toContain('<g:shipping_weight>180 g</g:shipping_weight>');
		expect(metaLine(/** @type {any} */ (heavy))).toContain(',180 g,');
		expect(feedRows(/** @type {any} */ (weighed), context)[0]?.shippingWeight).toBe('');
		expect(metaLine(/** @type {any} */ ({ ...row, inStock: false, condition: '', salePrice: '' }))).toContain(
			'out of stock,new,12.00 USD,,',
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
			storedCategory({
				id: 'cat_root',
				slug: 'phones',
				name: 'Phones',
				parentId: null,
				path: [],
				description: 'Every phone we sell.',
				seo: { title: '', description: '' },
				image: null,
				sort: 0,
			}),
			storedCategory({
				id: 'cat_android',
				slug: 'android',
				name: 'Android',
				parentId: 'cat_root',
				path: ['cat_root'],
				description: '',
				seo: { title: 'Android phones', description: 'Android phones, new and used.' },
				image: { key: 'ecommerce/categories/cat_android/a.jpg', type: 'image/jpeg', size: 10, alt: '' },
				sort: 0,
			}),
		]);
		await data
			.collection(COLLECTIONS.brands)
			.insertOne(storedBrand({ id: 'brd_1', slug: 'acme', name: 'Acme', description: '', logo: null }));
		phone = await shop.seedProduct({
			slug: 'acme-phone',
			name: 'Acme </script> Phone',
			summary: 'A good phone.',
			categoryIds: ['cat_android'],
			brandId: 'brd_1',
			sold: 9,
			rating: { average: 4.36, count: 3 },
			media: [{ key: 'ecommerce/products/p/1.jpg', type: 'image/jpeg', size: 10, alt: '' }],
			options: [{ name: 'Color', values: ['Red', 'Blue'] }],
			variants: [
				variant({ options: { Color: 'Red' }, price: 25000, compareAtPrice: 30000, sku: 'AP-R', grade: 'b' }),
				variant({ options: { Color: 'Blue' }, price: 26000, stock: 0, sku: 'AP-B' }),
			],
		});
		ebook = await shop.seedProduct({ slug: 'ebook', name: 'Ebook', kind: 'digital', trackStock: false, stock: 0, price: 500 });
		await shop.seedProduct({ slug: 'hidden', name: 'Hidden', status: 'draft' });
	});
	afterAll(async () => shop.product.close());

	it('answers a product page: title, description, canonical, image and JSON-LD', async () => {
		await shop.list('grades', [{ key: 'b', label: 'Grade B', condition: 'refurbished' }]);
		const byId = await shop.api('GET', `/v1/seo/products/${phone.id}`);
		expect(byId.status).toBe(200);
		const bySlug = await shop.api('GET', '/v1/seo/products/acme-phone');
		expect(bySlug.json).toEqual(byId.json);
		const answer = byId.json;
		expect(answer.title).toMatch(/^Acme <\/script> Phone \| /);
		// a summary under 50 characters gives way to the product's facts (G6)
		expect(answer.description).toBe('Acme </script> Phone by Acme — Android. USD 250.00 – USD 260.00. In stock: Red.');
		expect(answer.canonical).toBe(`${ORIGIN}/products/acme-phone`);
		expect(answer.image).toMatch(/^https:\/\//);
		expect(answer.jsonLd).not.toContain('</script>');
		const graph = JSON.parse(answer.jsonLd)['@graph'];
		const [node, crumbs] = graph;
		expect(answer.robots).toBe('index, follow');
		expect(node).toMatchObject({
			'@type': 'ProductGroup',
			name: 'Acme </script> Phone',
			productGroupID: phone.id,
			brand: { '@type': 'Brand', name: 'Acme' },
			aggregateRating: { ratingValue: 4.4, reviewCount: 3 },
		});
		// what the variants vary by comes only from a variant field mapped to a schema.org property, never from the
		// option's English name (E34): the option Color without such a field names none
		expect(node.variesBy).toBeUndefined();
		expect(node.hasVariant).toHaveLength(2);
		expect(node.hasVariant[0]).toMatchObject({
			'@type': 'Product',
			name: 'Acme </script> Phone - Red',
			sku: 'AP-R',
		});
		expect(node.hasVariant[0].color).toBeUndefined();
		expect(node.hasVariant[0].offers).toMatchObject({
			price: '250.00',
			priceCurrency: 'USD',
			availability: 'https://schema.org/InStock',
			itemCondition: 'https://schema.org/RefurbishedCondition',
		});
		expect(node.hasVariant[1].offers).toMatchObject({
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
		expect(node['@type']).toBe('Product');
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
		const graph = JSON.parse(android.jsonLd)['@graph'];
		const [page, list] = graph;
		const crumbs = graph.find((/** @type {any} */ node) => node['@type'] === 'BreadcrumbList');
		expect(page).toMatchObject({ '@type': 'CollectionPage', name: 'Android' });
		expect(list).toMatchObject({
			'@type': 'ItemList',
			itemListElement: [{ position: 1, url: `${ORIGIN}/products/acme-phone` }],
		});
		expect(crumbs.itemListElement.map((/** @type {any} */ step) => step.name).slice(1)).toEqual(['Phones', 'Android']);
		const root = (await shop.api('GET', '/v1/seo/categories/cat_root')).json;
		expect(root).toMatchObject({ title: 'Phones', description: 'Every phone we sell.', image: null });
		expect((await shop.api('GET', '/v1/seo/categories/none')).status).toBe(404);
	});

	it('serves the sitemap of active products and categories', async () => {
		const answer = await shop.api('GET', '/v1/seo/sitemap.xml');
		expect(answer.status).toBe(200);
		expect(answer.headers.get('content-type')).toContain('application/xml');
		expect(answer.text).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image=');
		expect(answer.text).toContain(`<loc>${ORIGIN}/products/acme-phone</loc><lastmod>`);
		expect(answer.text).toContain('<image:image><image:loc>https://');
		expect(answer.text).toContain(`<loc>${ORIGIN}/categories/android</loc>`);
		expect(answer.text).not.toContain('hidden');
		// the home page, the categories and the products
		expect(answer.text).toContain(`<url><loc>${ORIGIN}/</loc></url>`);
		expect((answer.text.match(/<url>/g) ?? []).length).toBe(5);
		expect((await shop.api('GET', '/v1/seo/sitemaps/categories')).status).toBe(200);
		expect((await shop.api('GET', '/v1/seo/sitemaps/nothing')).status).toBe(404);
	});

	it('serves the Google and Meta feeds', async () => {
		const google = await shop.api('GET', '/v1/feeds/products.xml');
		expect(google.status).toBe(200);
		expect(google.text).toContain('xmlns:g="http://base.google.com/ns/1.0"');
		expect(google.text).toContain('<title>Acme &lt;/script&gt; Phone - Red</title>');
		expect(google.text).toContain('<g:product_type>Phones &gt; Android</g:product_type>');
		expect(google.text).toContain('<g:sale_price>250.00 USD</g:sale_price>');
		// the grade's own condition, the same in structured data and feeds
		expect(google.text).toContain('<g:condition>refurbished</g:condition>');
		expect(google.text).toContain('<g:brand>Acme</g:brand>');
		expect(google.text).not.toContain('Ebook');
		const csv = await shop.api('GET', '/v1/feeds/products.csv');
		expect(csv.headers.get('content-type')).toContain('text/csv');
		const lines = csv.text.trim().split('\r\n');
		expect(lines[0]).toBe(
			'id,title,description,availability,condition,price,sale_price,sale_price_effective_date,link,image_link,additional_image_link,brand,gtin,mpn,identifier_exists,item_group_id,color,material,size,pattern,gender,age_group,google_product_category,shipping_weight,custom_label_0,custom_label_1,custom_label_2,custom_label_3,custom_label_4',
		);
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
		await shop.list('policies', [
			{ key: 'shipping', title: 'Delivery', text: '' },
			{ key: 'returns', title: 'Returns', text: 'Returns within 14 days.' },
		]);
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
		// a merchant's own llms.txt is served as written (G16)
		const own = '# Our shop\n\n> Hand-written for assistants.\n';
		await shop.setting('llms_txt', 'custom', own);
		const written = await shop.api('GET', '/v1/llms.txt');
		expect(written.text).toBe(own);
		expect(written.headers.get('content-type')).toContain('text/plain');
		await shop.setting('llms_txt', 'custom', '');
		expect((await shop.api('GET', '/v1/llms.txt')).text).toContain('# ');
	});

	it('answers the policies to visitors and the server', async () => {
		// the merchant's list: renamed, reordered, one added, one without text (E27)
		await shop.list('policies', [
			{ key: 'warranty', title: 'Repairs', text: '{business} repairs within {warrantyDays} days ({warrantyMonths} months).' },
			{ key: 'shipping', title: 'Shipping', text: 'Ships in 2 days.' },
			{ key: 'returns', title: 'Returns', text: 'Returns within 14 days.' },
			{ key: 'gift-cards', title: 'Gift cards', text: 'Gift cards never expire.' },
			{ key: 'privacy', title: 'Privacy', text: '' },
		]);
		await shop.setting('returns', 'warrantyDays', 90);
		const server = await shop.api('GET', '/v1/policies');
		expect(server.json).toEqual({
			format: 'text',
			policies: [
				{ key: 'warranty', title: 'Repairs', text: 'Shop repairs within 90 days (3 months).' },
				{ key: 'shipping', title: 'Shipping', text: 'Ships in 2 days.' },
				{ key: 'returns', title: 'Returns', text: 'Returns within 14 days.' },
				{ key: 'gift-cards', title: 'Gift cards', text: 'Gift cards never expire.' },
			],
		});
		await shop.setting('llms_txt', 'policies', true);
		expect((await shop.api('GET', '/v1/llms.txt')).text).toContain('- Gift cards: Gift cards never expire.');
		// keys are page names: one a page address cannot carry is refused
		await expect(shop.list('policies', [{ key: 'Gift Cards', title: 'Gift cards', text: '' }])).rejects.toThrow(/422/);
		const visitor = await shop.visitor('GET', '/v1/shop/policies');
		expect(visitor.json).toEqual(server.json);
		expect(DOMAIN).toBe(new URL(ORIGIN).host);
		await shop.setting('checkout', 'policyFormat', 'html');
		await shop.list('policies', [
			{ key: 'privacy', title: 'Privacy', text: '<p onclick="x()">We <b>never</b> sell data.</p><script>bad()</script>' },
		]);
		const html = (await shop.api('GET', '/v1/policies')).json;
		expect(html).toEqual({
			format: 'html',
			policies: [{ key: 'privacy', title: 'Privacy', text: '<p>We <strong>never</strong> sell data.</p>' }],
		});
		const llms = (await shop.api('GET', '/v1/llms.txt')).text;
		expect(llms).not.toContain('<p>');
		await shop.setting('checkout', 'policyFormat', 'text');
	});

	it('splits a large sitemap into files behind an index', async () => {
		const data = await shop.db();
		await shop.setting('seo', 'sitemapSize', 1000);
		// categories without products listed too (the merchant asks for it)
		await shop.setting('seo', 'emptyCategories', 'index');
		const docs = Array.from({ length: 1001 }, (_, index) =>
			storedCategory({
				id: `cat_bulk${String(index).padStart(6, '0')}`,
				slug: `bulk-${index}`,
				name: `Bulk ${index}`,
				parentId: null,
				path: [],
				description: '',
				seo: { title: '', description: '' },
				image: null,
				sort: 1,
			}),
		);
		await data.collection(COLLECTIONS.categories).insertMany(docs);
		const index = await shop.api('GET', '/v1/seo/sitemap.xml');
		expect(index.text).toContain('<sitemapindex');
		expect(index.text).toContain(`<loc>${ORIGIN}/sitemap.xml?file=categories</loc>`);
		expect(index.text).toContain(`<loc>${ORIGIN}/sitemap.xml?file=products-1</loc>`);
		const categories = await shop.api('GET', '/v1/seo/sitemaps/categories');
		// the home page and every category
		expect((categories.text.match(/<url>/g) ?? []).length).toBe(1004);
		const products = await shop.api('GET', '/v1/seo/sitemaps/products-1.xml');
		expect(products.text).toContain('/products/acme-phone');
		expect((await shop.api('GET', '/v1/seo/sitemaps/products-2')).status).toBe(404);
		expect((await shop.api('GET', '/v1/seo/sitemaps/landings')).status).toBe(404);
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
		const page = await shop.api('GET', '/v1/seo/sitemaps/products-1');
		expect(page.text).toContain('/products/bulk-product-299</loc>');
		const answer = (await shop.api('GET', '/v1/seo/products/bulk-product-1')).json;
		const [node] = JSON.parse(answer.jsonLd)['@graph'];
		expect(node.brand).toBeUndefined();
		expect(node.aggregateRating).toBeUndefined();
	}, 120_000);
});
