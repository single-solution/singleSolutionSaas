/**
 * Catalog SEO and feed settings of the re-audit (SG-2, SG-3, SG-5, SG-7, SG-20–SG-24, SG-31): free delivery in feeds
 * and structured data, title and description patterns with the name in titles, paged listings, glossary patterns,
 * feed titles, descriptions, identifiers and item groups, and the SEO reads' rate window. Every default keeps the
 * earlier output.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createId } from '@ss/contracts';
import { feedRows, googleItem, metaLine } from '../core/feeds.js';
import { listShown } from '../core/promotions.js';
import { feedGroupId, fillTemplate, fillTitle, pageName, patternText, shippingFee } from '../core/seo.js';
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
	warrantyTime: null,
	...input,
});

describe('patterns, shipping and feed rows', () => {
	it('fills patterns, dropping empty brackets and separators left over', () => {
		expect(fillTemplate('{brand} {name} ({options})', { brand: '', name: 'Suit', options: '' })).toBe('Suit');
		expect(fillTemplate('{name} - {variant} | {brand}', { name: 'Suit', variant: '', brand: 'Maison' })).toBe('Suit - Maison');
		expect(fillTemplate('| {name} -', { name: 'A-B / C' })).toBe('A-B / C');
		expect(fillTitle('{name} | {business}', { name: 'Lamp', business: 'Store' })).toBe('Lamp | Store');
		expect(fillTitle('{name} · {storeName}', { name: 'Lamp', business: 'Store' })).toBe('Lamp · Store');
		expect(fillTitle('{name} | {business}', { name: 'Lamp', business: '' })).toBe('Lamp');
		expect(pageName('{brand} {name}', { name: 'Lamp', brand: 'Nova', storeName: 'S' })).toBe('Nova Lamp');
		expect(pageName('', { name: 'Lamp', storeName: 'S' })).toBe('Lamp');
		expect(pageName('{brand}', { name: 'Lamp', storeName: 'S' })).toBe('Lamp');
		expect(patternText('', { name: 'Lamp' })).toBe('');
		expect(patternText('Browse {name} at {storeName}.', { name: 'Lamps', storeName: 'S' })).toBe('Browse Lamps at S.');
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
		name: 'Linen Shirt',
		kind: 'physical',
		summary: '',
		description: 'A long description.',
		seo: { title: '', description: 'Short SEO copy.' },
		trackStock: true,
		variants: [
			variant({ id: 'var_76543210fedcba9876543210', options: { Size: 'M', Color: 'Maroon' }, price: 6000 }),
			variant({ options: { Size: 'L', Color: 'Green' }, price: 4000 }),
			variant({ options: { Size: 'S', Color: 'Blue' }, price: 0 }),
		],
	});
	const context = {
		link: 'https://shop.example/p',
		image: 'https://cdn.example/i.jpg',
		brand: 'Maison',
		productType: 'Shirts',
		currency: 'GBP',
		condition: () => /** @type {const} */ ('new'),
		skuAs: /** @type {const} */ ('none'),
		includeOutOfStock: true,
		shipping: { fee: 250, freeOver: 5000, country: 'GB' },
		shown: listShown,
		now: Date.parse('2026-10-05T10:00:00Z'),
	};

	it('keeps the earlier rows by default, leaves out free variants and ships from the free amount', () => {
		const rows = feedRows(product, context);
		const first = /** @type {import('../core/feeds.js').FeedRow} */ (rows[0]);
		expect(rows.map((row) => row.title)).toEqual(['Linen Shirt - M / Maroon', 'Linen Shirt - L / Green']);
		expect(rows.map((row) => row.shipping)).toEqual(['0.00 GBP', '2.50 GBP']);
		expect(rows[0]).toMatchObject({ description: 'A long description.', itemGroupId: product.id, identifierExists: '' });
		expect(googleItem(first)).not.toContain('identifier_exists');
		expect(googleItem(first)).toContain('<g:price>0.00 GBP</g:price></g:shipping>');
		const single = feedRows({ ...product, variants: [variant({ price: 500 })] }, context);
		expect(single[0]).toMatchObject({ title: 'Linen Shirt', itemGroupId: '' });
	});

	it('takes the title pattern, the SEO description, identifier_exists and imported feed ids (SG-3, SG-22–SG-24)', () => {
		// the ids the shop's earlier feed used, kept by an import
		const imported = {
			...product,
			feedGroupId: '0123456789abcdef01234567',
			variants: product.variants.map((each, index) =>
				index === 0 ? { ...each, feedId: '0123456789abcdef01234567_76543210fedcba9876543210' } : each,
			),
		};
		const rows = feedRows(imported, {
			...context,
			title: '{brand} {name} ({options})',
			description: 'seo',
			identifierExists: 'no',
		});
		const first = /** @type {import('../core/feeds.js').FeedRow} */ (rows[0]);
		expect(first).toMatchObject({
			id: '0123456789abcdef01234567_76543210fedcba9876543210',
			itemGroupId: '0123456789abcdef01234567',
			title: 'Maison Linen Shirt (M / Maroon)',
			description: 'Short SEO copy.',
			identifierExists: 'no',
		});
		expect(googleItem(first)).toContain('<g:identifier_exists>no</g:identifier_exists>');
		expect(metaLine(first)).toContain(',0123456789abcdef01234567,');
		// a variant without one keeps its own id; the imported group is sent on a single variant too
		expect(rows[1]).toMatchObject({ id: product.variants[1]?.id, itemGroupId: '0123456789abcdef01234567' });
		const single = feedRows(
			{ ...imported, variants: [variant({ sku: 'X' })] },
			{ ...context, skuAs: 'mpn', identifierExists: 'no' },
		);
		expect(single[0]).toMatchObject({ itemGroupId: '0123456789abcdef01234567', identifierExists: '', mpn: 'X' });
		expect(
			feedRows({ ...product, seo: { ...product.seo, description: '' } }, { ...context, description: 'seo' })[0],
		).toMatchObject({
			description: 'A long description.',
		});
		expect(feedGroupId(/** @type {any} */ ({ id: 'prd_new' }), true)).toBe('prd_new');
		expect(feedGroupId(/** @type {any} */ ({ id: 'prd_new' }), false)).toBe('');
		expect(feedGroupId(/** @type {any} */ ({ id: 'prd_new', feedGroupId: 'g1' }), false)).toBe('g1');
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
		ids.lamps = await api('POST', '/v1/categories', { name: 'Lamps', parentId: ids.home.id });
		ids.nova = await api('POST', '/v1/brands', { name: 'Nova' });
		ids.height = await api('POST', '/v1/attributes', {
			name: 'Height',
			type: 'choice',
			unit: 'cm',
			choices: ['48', '56', '60'],
		});
		ids.lamp = await api('POST', '/v1/products', {
			name: 'Deluxe Lamp',
			status: 'active',
			categoryIds: [ids.lamps.id],
			brandId: ids.nova.id,
			summary: 'A warm lamp.',
			media: [],
			options: [{ name: 'Size', values: ['48', '56'] }],
			variants: [
				{ sku: 'L-48', options: { Size: '48' }, price: 900_000, stock: 5 },
				{ sku: 'L-56', options: { Size: '56' }, price: 1_200_000, stock: 5 },
			],
		});
	});
	afterAll(async () => shop.product.close());

	it('keeps titles and descriptions by default and fills the patterns with the name in titles (SG-5, SG-21)', async () => {
		const product = await api('GET', `/v1/seo/products/${ids.lamp.slug}`);
		expect(product).toMatchObject({
			title: 'Deluxe Lamp | Shop',
			description: 'Deluxe Lamp by Nova — Lamps. USD 9,000.00 – USD 12,000.00. In stock: 48, 56.',
		});
		const category = await api('GET', `/v1/seo/categories/${ids.lamps.slug}`);
		expect(category.title).toBe('Lamps | Shop');
		await shop.setting('seo', 'brandName', 'Nova Store');
		await shop.setting('seo', 'productTitle', '{brand} {name}');
		await shop.setting('seo', 'categoryTitle', 'Shop {name}');
		await shop.setting('seo', 'productDescription', '{brand} {name} in {category}, at {storeName}.');
		await shop.setting('seo', 'categoryDescription', 'Browse {name} ({category}) at {storeName}.');
		expect(await api('GET', `/v1/seo/products/${ids.lamp.slug}`)).toMatchObject({
			title: 'Nova Deluxe Lamp | Nova Store',
			description: 'Nova Deluxe Lamp in Lamps, at Nova Store.',
		});
		expect(await api('GET', `/v1/seo/categories/${ids.lamps.slug}`)).toMatchObject({
			title: 'Shop Lamps | Nova Store',
			description: 'Browse Lamps (Home) at Nova Store.',
		});
		expect(await api('GET', `/v1/seo/listing?category=${ids.lamps.slug}`)).toMatchObject({
			title: 'Shop Lamps | Nova Store',
			description: 'Browse Lamps (Home) at Nova Store.',
		});
		// a brand listing keeps its own head
		expect((await api('GET', `/v1/seo/listing?category=${ids.lamps.slug}&brand=${ids.nova.slug}`)).title).toBe(
			'Lamps Nova | Nova Store',
		);
	});

	it('indexes pages after the first or not, each with its own address as canonical (SG-21, G7)', async () => {
		// one product a page, and a second lamp: page 2 has a product
		await shop.setting('catalog', 'pageSize', 1);
		const desk = await api('POST', '/v1/products', {
			name: 'Desk Lamp',
			status: 'active',
			categoryIds: [ids.lamps.id],
			price: 900,
			stock: 1,
		});
		const second = await api('GET', `/v1/seo/listing?category=${ids.lamps.slug}&page=2`);
		expect(second).toMatchObject({ robots: 'index, follow', canonical: `${ORIGIN}/categories/lamps?page=2` });
		await shop.setting('seo', 'pagedListings', 'noindex');
		expect(await api('GET', `/v1/seo/listing?category=${ids.lamps.slug}&page=2`)).toMatchObject({
			robots: 'noindex, follow',
			canonical: `${ORIGIN}/categories/lamps?page=2`,
		});
		expect((await api('GET', `/v1/seo/listing?category=${ids.lamps.slug}`)).robots).toBe('index, follow');
		await shop.setting('catalog', 'pageSize', 24);
		await shop.setting('seo', 'pagedListings', 'index');
		await api('PATCH', `/v1/products/${desk.id}`, { status: 'archived' });
	});

	it('gives glossary pages without copy the patterns, not indexed nor in the sitemap (SG-20, G7.2)', async () => {
		await shop.setting('landing_pages', 'attributeUrl', '/glossary/{slug}');
		const plain = await api('GET', `/v1/seo/attributes/${ids.height.slug}`);
		expect(plain).toMatchObject({ title: 'Height | Nova Store', description: '', robots: 'noindex, follow' });
		// a page made only from patterns is thin: listed once it has text of its own
		expect((await shop.api('GET', '/v1/seo/sitemap.xml')).text).not.toContain(`<loc>${ORIGIN}/glossary/height</loc>`);
		await shop.setting('landing_pages', 'attributeTitle', 'What is {name}?');
		await shop.setting('landing_pages', 'attributeDescription', '{name} ({unit}): {values}. Browse at {storeName}.');
		expect(await api('GET', `/v1/seo/attributes/${ids.height.slug}`)).toMatchObject({
			title: 'What is Height? | Nova Store',
			description: 'Height (cm): 48, 56, 60. Browse at Nova Store.',
		});
		await api('PATCH', `/v1/attributes/${ids.height.id}`, {
			seo: { body: 'Height is measured from the floor to the top of the shade.' },
		});
		expect((await api('GET', `/v1/seo/attributes/${ids.height.slug}`)).robots).toBe('index, follow');
		expect((await shop.api('GET', '/v1/seo/sitemap.xml')).text).toContain(`<loc>${ORIGIN}/glossary/height</loc>`);
	});

	it('ships free from the free-delivery amount in feeds (SG-2); structured data waits for delivery days (G5)', async () => {
		await shop.list('delivery_zones', [
			{
				key: 'everywhere',
				name: 'Everywhere',
				rates: [{ key: 'standard', name: 'Standard', price: 25_000, freeOver: 1_000_000 }],
			},
		]);
		const jsonLd = JSON.parse((await api('GET', `/v1/seo/products/${ids.lamp.slug}`)).jsonLd)['@graph'][0];
		expect(jsonLd.hasVariant.map((/** @type {any} */ v) => v.offers.shippingDetails)).toEqual([undefined, undefined]);
		shop.responders.set(`${ORIGIN}/.well-known/business.json`, () => ({
			status: 200,
			body: { version: 1, name: 'Shop', country: 'US', timeZone: 'UTC' },
		}));
		await shop.dashboard(await shop.adminSession(), 'POST', `/v1/dashboard/websites/${shop.websiteId}/business/refresh`);
		await shop.setting('feeds', 'items', 'all');
		const google = (await shop.api('GET', '/v1/feeds/products.xml')).text;
		expect(google).toContain('<g:price>250.00 USD</g:price></g:shipping>');
		expect(google).toContain('<g:price>0.00 USD</g:price></g:shipping>');
		expect(google).toContain('<title>Deluxe Lamp - 48</title>');
		expect(google).not.toContain('identifier_exists');
	});

	it('takes the feed title pattern, SEO descriptions and identifier_exists (SG-3, SG-22, SG-23)', async () => {
		await api('PATCH', `/v1/products/${ids.lamp.id}`, { seo: { description: 'Warm and bright.' } });
		await shop.setting('feeds', 'itemTitle', '{brand} {name} ({options})');
		await shop.setting('feeds', 'itemDescription', 'seo');
		await shop.setting('feeds', 'identifierExists', 'no');
		const google = (await shop.api('GET', '/v1/feeds/products.xml')).text;
		expect(google).toContain('<title>Nova Deluxe Lamp (48)</title>');
		expect(google).toContain('<description>Warm and bright.</description>');
		expect(google).toContain('<g:identifier_exists>no</g:identifier_exists>');
		const csv = (await shop.api('GET', '/v1/feeds/products.csv')).text;
		expect(csv).toContain('Nova Deluxe Lamp (56),Warm and bright.,');
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
