/**
 * Low stock by the merchant's level (PLAN E44): a sellable variant with 1 to `lowStock` units on a product that tracks
 * stock and is not archived drives the staff list's `lowStock=1`, its counts, and the variant counts by stock
 * (`counts?by=variantStock`) a dashboard or a bell shows. Shop health (E41): its checks with counts and links, the
 * payment methods shoppers can use, and Growth's tag ids only while Growth's token is pasted.
 */
import { createId } from '@ss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countsForStock, staffFilter, stockEventOf, variantStockCounts } from '../core/catalog-query.js';
import { HEALTH_CHECKS, badTagIds, healthOf, isPublicAddress, paymentMethodsOn } from '../core/health.js';
import { GROWTH, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;
/** @type {string} */
let staff;

/**
 * A variant with its stock.
 * @param {number} stock @param {{ active?: boolean, soldOut?: boolean }} [more]
 */
const variant = (stock, { active = true, soldOut = false } = {}) => ({
	id: createId('var'),
	sku: '',
	options: {},
	price: 1000,
	compareAtPrice: null,
	cost: null,
	stock,
	locations: {},
	grade: null,
	active,
	...(soldOut ? { soldOut: true } : {}),
});

beforeAll(async () => {
	shop = await readyShop();
	staff = await shop.ticket(['catalog.edit']);
	await shop.seedProduct({ name: 'Stocky dress', variants: [variant(1), variant(2), variant(0), variant(5)] });
	await shop.seedProduct({ name: 'Stocky forced', variants: [variant(2, { soldOut: true })] });
	await shop.seedProduct({ name: 'Stocky archived', status: 'archived', variants: [variant(1)] });
	await shop.seedProduct({ name: 'Stocky service', trackStock: false, variants: [variant(1)] });
	await shop.seedProduct({ name: 'Stocky hidden size', variants: [variant(1, { active: false }), variant(9)] });
});

afterAll(async () => {
	await shop?.product.close();
});

describe('low stock (E44)', () => {
	it('builds the filter and the counts of variants', () => {
		expect(staffFilter({ lowStock: '1' }, { categoryIds: null, brandIds: null, lowStock: 2 })).toEqual({
			$and: [
				{
					trackStock: true,
					status: { $ne: 'archived' },
					variants: { $elemMatch: { active: true, soldOut: { $ne: true }, stock: { $gt: 0, $lte: 2 } } },
				},
			],
		});
		expect(
			variantStockCounts([
				{ _id: 'low', n: 2 },
				{ _id: 'other', n: 9 },
			]),
		).toEqual({ out: 0, low: 2, in: 0 });
	});

	it('calls a drop into 1 to lowStock low and a drop to 0 out, nothing else (the stock events)', () => {
		expect(stockEventOf(5, 2, 2)).toBe('stock.low');
		expect(stockEventOf(3, 1, 2)).toBe('stock.low');
		expect(stockEventOf(2, 1, 2)).toBeNull(); // already low
		expect(stockEventOf(5, 3, 2)).toBeNull(); // still above
		expect(stockEventOf(1, 0, 2)).toBe('stock.out');
		expect(stockEventOf(9, 0, 2)).toBe('stock.out');
		expect(stockEventOf(0, 2, 2)).toBeNull(); // a rise
		expect(stockEventOf(2, 2, 2)).toBeNull();
		expect(stockEventOf(5, 1, 0)).toBeNull(); // level 0: never low
		expect(stockEventOf(1, 0, 0)).toBe('stock.out');
		const product = { trackStock: true, status: /** @type {const} */ ('active') };
		const offered = { active: true, soldOut: false };
		expect(countsForStock(product, offered)).toBe(true);
		expect(countsForStock({ ...product, status: 'draft' }, offered)).toBe(true);
		expect(countsForStock({ ...product, status: 'archived' }, offered)).toBe(false);
		expect(countsForStock({ ...product, trackStock: false }, offered)).toBe(false);
		expect(countsForStock(product, { ...offered, active: false })).toBe(false);
		expect(countsForStock(product, { ...offered, soldOut: true })).toBe(false);
	});

	it('counts sellable variants with 1 to lowStock units on products not archived', async () => {
		await shop.setting('catalog', 'lowStock', 2);
		const list = await shop.api('GET', '/v1/products?q=Stocky&lowStock=1');
		expect(list.json.items.map((/** @type {any} */ item) => item.name)).toEqual(['Stocky dress']);
		expect((await shop.api('GET', '/v1/products/count?q=Stocky&lowStock=1')).json).toEqual({ count: 1, capped: false });
		expect((await shop.api('GET', '/v1/products/counts?q=Stocky&lowStock=1&by=status')).json).toEqual({
			total: 1,
			groups: { active: 1 },
		});
		// the dress: 1 and 2 low, 0 out, 5 in; the forced variant out; archived, untracked and offered-no-more left out
		expect((await shop.api('GET', '/v1/products/counts?q=Stocky&by=variantStock')).json).toEqual({
			total: 6,
			groups: { out: 2, low: 2, in: 2 },
		});
		expect((await shop.admin(staff, 'GET', '/v1/admin/products/counts?q=Stocky&by=variantStock')).json.groups.low).toBe(2);
	});

	it('finds nothing low at level 0', async () => {
		await shop.setting('catalog', 'lowStock', 0);
		expect((await shop.api('GET', '/v1/products/count?q=Stocky&lowStock=1')).json.count).toBe(0);
		expect((await shop.api('GET', '/v1/products/counts?q=Stocky&by=variantStock')).json).toEqual({
			total: 6,
			groups: { out: 2, in: 4 },
		});
		await shop.setting('catalog', 'lowStock', 3);
	});
});

describe('shop health (E41)', () => {
	it('judges the business name, the address, the payment methods and the tag ids', () => {
		expect(isPublicAddress('shop.example.com')).toBe(true);
		for (const domain of ['localhost', 'shop.localhost', 'shop.test', '127.0.0.1', '[::1]', 'intranet', 'shop.local:3000'])
			expect(isPublicAddress(domain), domain).toBe(false);
		expect(
			badTagIds({
				features: [
					{ key: 'meta_pixel', on: true, values: { pixelId: 'abc' } },
					{ key: 'google_tags', on: true, values: { ga4Id: ' G-ABCD1234 ', adsId: 'AW-1', gtmId: '' } },
					{ key: 'tiktok_pixel', on: false, values: { pixelId: 'bad' } },
				],
			}),
		).toEqual(['meta_pixel.pixelId', 'google_tags.adsId']);
		expect(badTagIds(null)).toEqual([]);
		const none = { cod: false, offered: ['online', 'bank_transfer', 'pickup'], paymentsConnected: false, bankManual: false };
		expect(paymentMethodsOn({ ...none, pickup: false })).toEqual([]);
		expect(paymentMethodsOn({ ...none, pickup: true, bankManual: true })).toEqual(['bank_transfer', 'pickup']);
		expect(paymentMethodsOn({ ...none, cod: true, paymentsConnected: true, pickup: false })).toEqual([
			'cod',
			'online',
			'bank_transfer',
		]);
		const clean = { sameTitles: 0, sameDescriptions: 0, longTitles: 0, canonicalElsewhere: 0, emptyCategories: 0 };
		const ready = {
			storage: true,
			bankReady: true,
			staffAlerted: true,
			adminUrl: true,
			feeds: true,
			missingIdentifiers: true,
			glossaryWithoutText: 0,
		};
		const health = healthOf({
			facets: { active: [{ n: 3 }], noPhotos: [], archivedFeatured: [{ n: 1 }], variants: [{ _id: 'low', n: 4 }] },
			taxonomy: clean,
			business: { name: 'shop.example.com', country: null, logo: 'https://shop.example.com/logo.png', phone: '+12025550143' },
			domain: 'shop.example.com',
			paymentMethods: [],
			badTags: null,
			shortLived: true,
			deliveryDays: false,
			setup: ready,
		});
		expect(health.checks.map((check) => check.key)).toEqual([...HEALTH_CHECKS]);
		/** @type {Record<string, string>} */
		const states = Object.fromEntries(health.checks.map((check) => [check.key, `${check.status} ${check.count}`]));
		expect(states).toMatchObject({
			no_products: 'ok 0',
			products_without_photos: 'ok 0',
			images_short_lived: 'attention 1',
			archived_featured: 'attention 1',
			variants_out_of_stock: 'ok 0',
			variants_low_stock: 'attention 4',
			business_name: 'attention 1',
			business_country: 'attention 1',
			business_logo: 'ok 0',
			business_phone: 'ok 0',
			website_address: 'ok 0',
			delivery_days: 'attention 1',
			payment_methods: 'attention 1',
			pixel_ids: 'skipped 0',
		});
		expect(health.attention).toBe(7);
		// without storage the image check is skipped; with the public address it is ok
		const skipped = {
			facets: {},
			taxonomy: clean,
			business: { name: 'Shop', country: 'US', logo: null, phone: null },
			domain: 'shop.example.com',
			paymentMethods: ['cod'],
			badTags: [],
			deliveryDays: null,
			setup: ready,
		};
		const imagesOf = (/** @type {boolean | null} */ shortLived) =>
			healthOf({ ...skipped, shortLived }).checks.find((check) => check.key === 'images_short_lived');
		expect(imagesOf(null)).toEqual({ key: 'images_short_lived', status: 'skipped', count: 0, link: null });
		expect(imagesOf(false)).toMatchObject({ status: 'ok', count: 0 });
		// without delivery zones there are no delivery days to ask for
		expect(healthOf({ ...skipped, shortLived: false }).checks.find((check) => check.key === 'delivery_days')).toEqual({
			key: 'delivery_days',
			status: 'skipped',
			count: 0,
			link: null,
		});
	});

	it('answers the checks with counts and links for the server and the reports widget', async () => {
		await shop.seedProduct({ name: 'Stocky old favourite', status: 'archived', featured: true });
		const health = await shop.api('GET', '/v1/reports/health');
		expect(health.status).toBe(200);
		/** @type {Record<string, any>} */
		const byKey = Object.fromEntries(health.json.checks.map((/** @type {any} */ check) => [check.key, check]));
		// four active products without photos; the dress and the forced variant out and low by level 3
		expect(byKey.products_without_photos).toEqual({
			key: 'products_without_photos',
			status: 'attention',
			count: 4,
			link: '/v1/products?status=active&hasMedia=0',
		});
		expect(byKey.archived_featured).toMatchObject({ status: 'attention', count: 1 });
		expect(byKey.variants_out_of_stock).toMatchObject({ status: 'attention', count: 2 });
		expect(byKey.variants_low_stock).toMatchObject({ status: 'attention', count: 2, link: '/v1/products?lowStock=1' });
		expect(byKey.business_name).toMatchObject({ status: 'ok', link: 'https://shop.example.com/.well-known/business.json' });
		// business.json gives no country and no logo, and the delivery days are not set
		expect(byKey.business_country).toMatchObject({ status: 'attention', count: 1 });
		expect(byKey.business_logo).toMatchObject({ status: 'attention', count: 1 });
		expect(byKey.delivery_days).toEqual({ key: 'delivery_days', status: 'attention', count: 1, link: null });
		expect(byKey.website_address.status).toBe('ok');
		expect(byKey.payment_methods.status).toBe('ok');
		// Growth's token is not pasted: its tag ids are not read
		expect(byKey.pixel_ids).toEqual({ key: 'pixel_ids', status: 'skipped', count: 0, link: null });
		expect(shop.callsTo(GROWTH)).toHaveLength(0);
		// storage is connected without a public address of the images (G1)
		expect(byKey.images_short_lived).toEqual({ key: 'images_short_lived', status: 'attention', count: 1, link: null });
		// no description and no brand or GTIN on the four active products, no phone, and staff alerts to nobody and nowhere
		expect(byKey.short_descriptions).toMatchObject({ status: 'attention', count: 4 });
		expect(byKey.missing_identifiers).toMatchObject({ status: 'attention', count: 4 });
		expect(byKey.business_phone).toMatchObject({ status: 'attention', count: 1 });
		expect(byKey.staff_alerts).toMatchObject({ status: 'attention', count: 1 });
		expect(byKey.admin_url).toMatchObject({ status: 'attention', count: 1 });
		expect(health.json.checks.filter((/** @type {any} */ check) => check.status === 'attention')).toHaveLength(13);
		expect(health.json.attention).toBe(13);
		const reader = await shop.ticket(['reports.read']);
		expect((await shop.admin(reader, 'GET', '/v1/admin/reports/health')).json).toEqual(health.json);
		expect((await shop.admin(await shop.ticket(['catalog.edit']), 'GET', '/v1/admin/reports/health')).status).toBe(403);
	});

	it('finds no payment method shoppers can use, and reads badly formed tag ids with the Growth token', async () => {
		await shop.setting('checkout', 'paymentMethods', ['pickup']);
		await shop.setting('cod', 'enabled', false);
		const byKey = async () =>
			Object.fromEntries(
				(await shop.api('GET', '/v1/reports/health')).json.checks.map((/** @type {any} */ check) => [check.key, check]),
			);
		expect((await byKey()).payment_methods).toMatchObject({ status: 'attention', count: 1 });
		const data = await shop.db();
		await data.collection('locations').insertOne({ id: 'loc_pickup', name: 'Shop', pickup: true, sort: 0 });
		expect((await byKey()).payment_methods.status).toBe('ok');
		await shop.paste('growth');
		shop.responders.set(`${GROWTH}/v1/settings`, () => ({
			status: 200,
			body: { features: [{ key: 'meta_pixel', name: 'Meta pixel', on: true, schema: {}, values: { pixelId: 'not-digits' } }] },
		}));
		expect((await byKey()).pixel_ids).toEqual({ key: 'pixel_ids', status: 'attention', count: 1, link: null });
		shop.responders.set(`${GROWTH}/v1/settings`, () => ({ status: 503, body: {} }));
		expect((await byKey()).pixel_ids.status).toBe('skipped');
		await shop.setting('checkout', 'paymentMethods', ['online', 'bank_transfer', 'pickup']);
		await shop.setting('cod', 'enabled', true);
	});
});
