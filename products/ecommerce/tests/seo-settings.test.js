/**
 * Catalog SEO and feed settings of the re-audit (SG-2, SG-3, SG-5, SG-7, SG-20–SG-24, SG-31): free delivery in feeds
 * and structured data, title and description patterns with the name in titles, paged listings, glossary patterns,
 * feed titles, descriptions, identifiers and item groups, and the SEO reads' rate window. Every default keeps the
 * earlier output.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createId } from '@ss/contracts';
import { feedGroupId, feedRows, googleItem, metaLine } from '../core/feeds.js';
import { fillTemplate, fillTitle, pageName, patternText, shippingFee } from '../core/seo.js';
import { createRoutes } from '../server/routes.js';
import { ALL, ORIGIN, readyShop } from './helpers.js';

/** @typedef {import('../core/model.js').ProductRecord} ProductRecord */
/** @typedef {import('../core/model.js').VariantRecord} VariantRecord */

/** @param {Partial<VariantRecord>} [input] @returns {VariantRecord} */
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

describe('patterns, shipping and feed rows', () => {
	it('fills patterns, dropping empty brackets and separators left over', () => {
		expect(fillTemplate('{brand} {name} ({options})', { brand: '', name: 'Suit', options: '' })).toBe('Suit');
		expect(fillTemplate('{name} - {variant} | {brand}', { name: 'Suit', variant: '', brand: 'Maison' })).toBe('Suit - Maison');
		expect(fillTemplate('| {name} -', { name: 'A-B / C' })).toBe('A-B / C');
		expect(fillTitle('{name} | {business}', { name: 'Fan', business: 'Store' })).toBe('Fan | Store');
		expect(fillTitle('{name} · {storeName}', { name: 'Fan', business: 'Store' })).toBe('Fan · Store');
		expect(fillTitle('{name} | {business}', { name: 'Fan', business: '' })).toBe('Fan');
		expect(pageName('{brand} {name}', { name: 'Fan', brand: 'Royal', storeName: 'S' })).toBe('Royal Fan');
		expect(pageName('', { name: 'Fan', storeName: 'S' })).toBe('Fan');
		expect(pageName('{brand}', { name: 'Fan', storeName: 'S' })).toBe('Fan');
		expect(patternText('', { name: 'Fan' })).toBe('');
		expect(patternText('Browse {name} at {storeName}.', { name: 'Fans', storeName: 'S' })).toBe('Browse Fans at S.');
	});

	it('ships items free from the free-delivery amount (SG-2)', () => {
		expect(shippingFee({ fee: 250 }, 100_000)).toBe(250);
		expect(shippingFee({ fee: 250, freeOver: 0 }, 100_000)).toBe(250);
		expect(shippingFee({ fee: 250, freeOver: 5000 }, 4999)).toBe(250);
		expect(shippingFee({ fee: 250, freeOver: 5000 }, 5000)).toBe(0);
	});

	/** @type {ProductRecord} */
	const product = /** @type {any} */ ({
		id: 'prd_0123456789abcdef01234567',
		name: 'Lawn Suit',
		kind: 'physical',
		summary: '',
		description: 'A long description.',
		seo: { title: '', description: 'Short SEO copy.' },
		trackStock: true,
		variants: [
			variant({ id: 'var_76543210fedcba9876543210', options: { Size: 'M', Colour: 'Maroon' }, price: 6000 }),
			variant({ options: { Size: 'L', Colour: 'Green' }, price: 4000 }),
			variant({ options: { Size: 'S', Colour: 'Blue' }, price: 0 }),
		],
	});
	const context = {
		link: 'https://shop.example/p',
		image: 'https://cdn.example/i.jpg',
		brand: 'Maison',
		productType: 'Suits',
		currency: 'PKR',
		condition: () => /** @type {const} */ ('new'),
		skuAs: /** @type {const} */ ('none'),
		includeOutOfStock: true,
		shipping: { fee: 250, freeOver: 5000, country: 'PK' },
	};

	it('keeps the earlier rows by default, leaves out free variants and ships from the free amount', () => {
		const rows = feedRows(product, context);
		const first = /** @type {import('../core/feeds.js').FeedRow} */ (rows[0]);
		expect(rows.map((row) => row.title)).toEqual(['Lawn Suit - M / Maroon', 'Lawn Suit - L / Green']);
		expect(rows.map((row) => row.shipping)).toEqual(['0.00 PKR', '2.50 PKR']);
		expect(rows[0]).toMatchObject({ description: 'A long description.', itemGroupId: product.id, identifierExists: '' });
		expect(googleItem(first)).not.toContain('identifier_exists');
		expect(googleItem(first)).toContain('<g:price>0.00 PKR</g:price></g:shipping>');
		const single = feedRows({ ...product, variants: [variant({ price: 500 })] }, context);
		expect(single[0]).toMatchObject({ title: 'Lawn Suit', itemGroupId: '' });
	});

	it('takes the title pattern, the SEO description, identifier_exists and legacy item groups (SG-3, SG-22–SG-24)', () => {
		const rows = feedRows(product, {
			...context,
			title: '{brand} {name} ({options})',
			description: 'seo',
			identifierExists: 'no',
			itemId: 'legacy',
		});
		const first = /** @type {import('../core/feeds.js').FeedRow} */ (rows[0]);
		expect(first).toMatchObject({
			id: '0123456789abcdef01234567_76543210fedcba9876543210',
			itemGroupId: '0123456789abcdef01234567',
			title: 'Maison Lawn Suit (M / Maroon)',
			description: 'Short SEO copy.',
			identifierExists: 'no',
		});
		expect(googleItem(first)).toContain('<g:identifier_exists>no</g:identifier_exists>');
		expect(metaLine(first)).toContain(',0123456789abcdef01234567,');
		const single = feedRows(
			{ ...product, variants: [variant({ sku: 'X' })] },
			{ ...context, itemId: 'legacy', skuAs: 'mpn', identifierExists: 'no' },
		);
		expect(single[0]).toMatchObject({ itemGroupId: '0123456789abcdef01234567', identifierExists: '', mpn: 'X' });
		expect(
			feedRows({ ...product, seo: { ...product.seo, description: '' } }, { ...context, description: 'seo' })[0],
		).toMatchObject({
			description: 'A long description.',
		});
		expect(feedGroupId('prd_new', true, 'legacy')).toBe('prd_new');
		expect(feedGroupId('prd_new', false, 'variant')).toBe('');
	});
});

describe('SEO and feed settings through the API', () => {
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

	beforeAll(async () => {
		shop = await readyShop({ features: ALL.filter((feature) => feature !== 'multi_location') });
		ids.home = await api('POST', '/v1/categories', { name: 'Home' });
		ids.fans = await api('POST', '/v1/categories', { name: 'Fans', parentId: ids.home.id });
		ids.royal = await api('POST', '/v1/brands', { name: 'Royal' });
		ids.sweep = await api('POST', '/v1/attributes', { name: 'Sweep', type: 'choice', unit: 'in', choices: ['48', '56', '60'] });
		ids.fan = await api('POST', '/v1/products', {
			name: 'Deluxe Fan',
			status: 'active',
			categoryIds: [ids.fans.id],
			brandId: ids.royal.id,
			summary: 'A quiet fan.',
			media: [],
			options: [{ name: 'Size', values: ['48', '56'] }],
			variants: [
				{ sku: 'F-48', options: { Size: '48' }, price: 900_000, stock: 5 },
				{ sku: 'F-56', options: { Size: '56' }, price: 1_200_000, stock: 5 },
			],
		});
	});
	afterAll(async () => shop.product.close());

	it('keeps titles and descriptions by default and fills the patterns with the name in titles (SG-5, SG-21)', async () => {
		const product = await api('GET', `/v1/seo/products/${ids.fan.slug}`);
		expect(product).toMatchObject({ title: 'Deluxe Fan | Shop', description: 'A quiet fan.' });
		const category = await api('GET', `/v1/seo/categories/${ids.fans.slug}`);
		expect(category.title).toBe('Fans | Shop');
		await shop.setting('seo', 'brandName', 'Royal Store');
		await shop.setting('seo', 'productTitle', '{brand} {name}');
		await shop.setting('seo', 'categoryTitle', 'Shop {name}');
		await shop.setting('seo', 'productDescription', '{brand} {name} in {category}, at {storeName}.');
		await shop.setting('seo', 'categoryDescription', 'Browse {name} ({category}) at {storeName}.');
		expect(await api('GET', `/v1/seo/products/${ids.fan.slug}`)).toMatchObject({
			title: 'Royal Deluxe Fan | Royal Store',
			description: 'Royal Deluxe Fan in Fans, at Royal Store.',
		});
		expect(await api('GET', `/v1/seo/categories/${ids.fans.slug}`)).toMatchObject({
			title: 'Shop Fans | Royal Store',
			description: 'Browse Fans (Home) at Royal Store.',
		});
		expect(await api('GET', `/v1/seo/listing?category=${ids.fans.slug}`)).toMatchObject({
			title: 'Shop Fans | Royal Store',
			description: 'Browse Fans (Home) at Royal Store.',
		});
		// a brand listing keeps its own head
		expect((await api('GET', `/v1/seo/listing?category=${ids.fans.slug}&brand=${ids.royal.slug}`)).title).toBe(
			'Fans Royal | Royal Store',
		);
	});

	it('indexes pages after the first, or not with the first page as canonical (SG-21)', async () => {
		const second = await api('GET', `/v1/seo/listing?category=${ids.fans.slug}&page=2`);
		expect(second).toMatchObject({ robots: 'index, follow', canonical: `${ORIGIN}/categories/fans?page=2` });
		await shop.setting('seo', 'pagedListings', 'noindex');
		expect(await api('GET', `/v1/seo/listing?category=${ids.fans.slug}&page=2`)).toMatchObject({
			robots: 'noindex, follow',
			canonical: `${ORIGIN}/categories/fans`,
		});
		expect((await api('GET', `/v1/seo/listing?category=${ids.fans.slug}`)).robots).toBe('index, follow');
	});

	it('gives glossary pages without copy the patterns and lists them in the sitemap (SG-20)', async () => {
		await shop.setting('landing_pages', 'attributeUrl', '/glossary/{slug}');
		const plain = await api('GET', `/v1/seo/attributes/${ids.sweep.slug}`);
		expect(plain).toMatchObject({ title: 'Sweep | Royal Store', description: '' });
		// once the address is set, every active attribute's page is in the sitemap, with or without its own text
		expect((await shop.api('GET', '/v1/seo/sitemap.xml')).text).toContain(`<loc>${ORIGIN}/glossary/sweep</loc>`);
		await shop.setting('landing_pages', 'attributeTitle', 'What is {name}?');
		await shop.setting('landing_pages', 'attributeDescription', '{name} ({unit}): {values}. Browse at {storeName}.');
		expect(await api('GET', `/v1/seo/attributes/${ids.sweep.slug}`)).toMatchObject({
			title: 'What is Sweep? | Royal Store',
			description: 'Sweep (in): 48, 56, 60. Browse at Royal Store.',
		});
		expect((await shop.api('GET', '/v1/seo/sitemap.xml')).text).toContain(`<loc>${ORIGIN}/glossary/sweep</loc>`);
	});

	it('ships free from the free-delivery amount in feeds and structured data (SG-2)', async () => {
		await shop.setting('delivery_zones', 'defaultFee', 25_000);
		await shop.setting('delivery_zones', 'defaultFreeOver', 1_000_000);
		const jsonLd = JSON.parse((await api('GET', `/v1/seo/products/${ids.fan.slug}`)).jsonLd)['@graph'][0];
		expect(jsonLd.hasVariant.map((/** @type {any} */ v) => v.offers.shippingDetails.shippingRate.value)).toEqual([
			'250.00',
			'0.00',
		]);
		shop.responders.set(`${ORIGIN}/.well-known/business.json`, () => ({
			status: 200,
			body: { version: 1, name: 'Shop', country: 'PK', timeZone: 'UTC' },
		}));
		await shop.dashboard(await shop.adminSession(), 'POST', `/v1/dashboard/websites/${shop.websiteId}/business/refresh`);
		await shop.setting('feeds', 'items', 'all');
		const google = (await shop.api('GET', '/v1/feeds/products.xml')).text;
		expect(google).toContain('<g:price>250.00 USD</g:price></g:shipping>');
		expect(google).toContain('<g:price>0.00 USD</g:price></g:shipping>');
		expect(google).toContain('<title>Deluxe Fan - 48</title>');
		expect(google).not.toContain('identifier_exists');
	});

	it('takes the feed title pattern, SEO descriptions and identifier_exists (SG-3, SG-22, SG-23)', async () => {
		await api('PATCH', `/v1/products/${ids.fan.id}`, { seo: { description: 'Quiet and strong.' } });
		await shop.setting('feeds', 'itemTitle', '{brand} {name} ({options})');
		await shop.setting('feeds', 'itemDescription', 'seo');
		await shop.setting('feeds', 'identifierExists', 'no');
		const google = (await shop.api('GET', '/v1/feeds/products.xml')).text;
		expect(google).toContain('<title>Royal Deluxe Fan (48)</title>');
		expect(google).toContain('<description>Quiet and strong.</description>');
		expect(google).toContain('<g:identifier_exists>no</g:identifier_exists>');
		const csv = (await shop.api('GET', '/v1/feeds/products.csv')).text;
		expect(csv).toContain('Royal Deluxe Fan (56),Quiet and strong.,');
	});

	it('gives the SEO reads the merchant server’s own window (SG-31)', () => {
		const routes = createRoutes(shop.product);
		/** @param {string} method @param {string} path */
		const limitOf = (method, path) =>
			[routes.find((route) => route.method === method && route.path === path)?.rateLimit].flat()[0]?.limit;
		for (const path of ['/v1/seo/products/:ref', '/v1/seo/categories/:ref', '/v1/seo/listing', '/v1/seo/sitemap.xml'])
			expect(limitOf('GET', path)).toBe(3000);
		expect(limitOf('GET', '/v1/seo/attributes/:slug')).toBe(3000);
		expect(limitOf('GET', '/v1/policies')).toBe(3000);
		expect(limitOf('POST', '/v1/landings')).toBe(600);
	});
});
