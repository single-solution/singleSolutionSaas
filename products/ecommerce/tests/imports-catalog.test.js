/**
 * The catalog's part of the import (PLAN 0.8.10 K10, Migration steps 3 and 5) through the real routes with the
 * `import` feature on: dry runs that report every refusal and write nothing, real runs and re-runs that change
 * nothing, finish (category paths, products' derived values, idempotent), prune, the verification sums, imported
 * records read back through the shop and staff routes, storage keys of any folder kept on later edits (CA-5), drafts
 * without variants (CA-2), and no event, message or IndexNow call from an import.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FINISH_PAGE } from '../adapters/imports.js';
import { ALL, GROWTH, NOTIFY, STORAGE, readyShop } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;

/** An imported id: the prefix and a 24-digit hex number. @param {string} prefix @param {number} n */
const idOf = (prefix, n) => `${prefix}_${n.toString(16).padStart(24, '0')}`;

const ID = Object.freeze({
	chart: idOf('szc', 1),
	clothes: idOf('cat', 1),
	dresses: idOf('cat', 2),
	evening: idOf('cat', 3),
	brand: idOf('brd', 1),
	other: idOf('brd', 2),
	colour: idOf('att', 1),
	landing: idOf('lnd', 1),
	dress: idOf('prd', 1),
	shell: idOf('prd', 2),
	red: idOf('var', 1),
	blue: idOf('var', 2),
	unit: idOf('ser', 1),
	sold: idOf('ser', 2),
	deal: idOf('deal', 1),
	bundle: idOf('bnd', 1),
	order: idOf('ord', 1),
	line: idOf('oln', 1),
});

/** Keys the store's own uploader made, outside the product's folders (Migration "Storage"). */
const KEY = Object.freeze({
	photo: 'uploads/2024/05/dress-main.webp',
	thumb: 'uploads/2024/05/dress-main-thumb.webp',
	variant: 'uploads/variants/2024/dress-red.webp',
	video: 'uploads/video-1715000000.mp4',
	banner: 'offers/summer.webp',
	logo: 'uploads/brands/maison.png',
});

/**
 * The records of one import, in the order the importer sends them (Migration steps 3 and 5).
 * @type {Record<'size_charts' | 'categories' | 'brands' | 'attributes' | 'landings' | 'products' | 'serials' | 'deals'
 *   | 'bundles', any[]>}
 */
const RECORDS = {
	size_charts: [
		{
			id: ID.chart,
			name: 'Dresses',
			unit: 'cm',
			columns: [
				{ key: 'chest-width', label: 'Chest width' },
				{ key: 'length', label: 'Length' },
			],
			rows: [{ size: 'm', label: 'M', values: { 'chest-width': '96', length: '120' } }],
			fitAdvice: 'Runs small.',
			notes: '',
			active: true,
			createdAt: '2023-02-01T09:00:00.000Z',
		},
	],
	categories: [
		// a child before its parent: the path is derived in finish
		{
			id: ID.dresses,
			slug: 'dresses',
			name: 'Dresses',
			parentId: ID.clothes,
			description: '',
			seo: { title: 'Dresses', description: '' },
			image: null,
			sort: 2,
			status: 'active',
			sizeChartId: ID.chart,
			previousSlugs: ['frocks'],
			createdAt: '2023-03-01T10:00:00.000Z',
		},
		{
			id: ID.clothes,
			slug: 'clothes',
			name: 'Clothes',
			parentId: null,
			image: { key: 'uploads/categories/clothes.webp', type: 'image/webp', size: 1200, alt: 'Clothes' },
			sort: 1,
			status: 'active',
			createdAt: '2023-03-01T10:00:00.000Z',
		},
	],
	brands: [
		{
			id: ID.brand,
			slug: 'maison',
			name: 'Maison',
			description: 'Made in small runs.',
			logo: { key: KEY.logo, type: 'image/png', size: 900, alt: 'Maison' },
			status: 'active',
			categoryIds: [ID.clothes],
		},
	],
	attributes: [
		{
			id: ID.colour,
			slug: 'colour',
			name: 'Colour',
			type: 'choice',
			choices: [
				{ value: 'red', label: 'Red' },
				{ value: 'blue', label: 'Blue' },
			],
			unit: '',
			filterable: true,
			comparable: false,
			sort: 1,
			categoryIds: [],
			on: 'variant',
			multiple: false,
			visibility: { when: 'always', ids: [], attributeId: null, value: null },
			card: 'chips',
			active: true,
		},
	],
	landings: [
		{
			id: ID.landing,
			categoryId: ID.clothes,
			brandId: ID.brand,
			grade: null,
			h1: 'Maison clothes',
			title: 'Maison clothes',
			description: 'Every Maison piece.',
			intro: '',
			faqs: [],
			indexable: 'auto',
		},
	],
	products: [
		{
			id: ID.dress,
			slug: 'linen-dress',
			name: 'Linen dress',
			kind: 'physical',
			status: 'active',
			summary: 'A summer dress.',
			description: 'Light linen.',
			categoryIds: [ID.dresses],
			brandId: ID.brand,
			tags: ['summer'],
			media: [
				{
					key: KEY.photo,
					type: 'image/webp',
					size: 5000,
					alt: 'Linen dress',
					sizes: { thumb: KEY.thumb },
					width: 1200,
					height: 1600,
				},
			],
			specs: {},
			options: [],
			variants: [
				{
					id: ID.red,
					sku: 'LD-RED',
					options: {},
					price: 4500,
					compareAtPrice: 5000,
					cost: 2000,
					stock: 3,
					locations: {},
					grade: null,
					active: true,
					attributes: { [ID.colour]: 'red' },
					media: [{ key: KEY.variant, type: 'image/webp', size: 3000, alt: 'Red' }],
					soldOut: false,
					warrantyDays: null,
				},
				{
					id: ID.blue,
					sku: 'LD-BLUE',
					options: {},
					price: 4000,
					compareAtPrice: null,
					cost: null,
					stock: 0,
					locations: {},
					grade: null,
					active: true,
					attributes: { [ID.colour]: 'blue' },
				},
			],
			trackStock: true,
			serialized: false,
			digital: null,
			booking: null,
			seo: { title: '', description: '' },
			featured: true,
			video: { kind: 'file', key: KEY.video, type: 'video/mp4', size: 900000 },
			previousSlugs: ['linen-frock'],
			returnDays: null,
			warrantyDays: null,
			sold: 12,
			rating: { average: 4.5, count: 2 },
			publishedAt: '2023-04-01T08:00:00.000Z',
			createdAt: '2023-04-01T08:00:00.000Z',
		},
		// a shell without variants (CA-2): stored as a draft
		{ id: ID.shell, slug: 'shell', name: 'Coming later', status: 'active', variants: [] },
	],
	serials: [
		{
			id: ID.unit,
			productId: ID.dress,
			variantId: ID.red,
			serial: 'SN 0001',
			status: 'in_stock',
			orderId: null,
			lineId: null,
			locationId: null,
		},
		{
			id: ID.sold,
			productId: ID.dress,
			variantId: ID.red,
			serial: 'SN 0002',
			status: 'sold',
			orderId: ID.order,
			lineId: ID.line,
			locationId: null,
		},
	],
	deals: [
		{
			id: ID.deal,
			name: 'Summer',
			description: '',
			type: 'percent',
			value: 10,
			scope: { productIds: [ID.dress], categoryIds: [], brandIds: [] },
			startsAt: '2024-06-01T00:00:00.000Z',
			endsAt: null,
			limit: 100,
			used: 37,
			priority: 0,
			active: true,
			slug: 'summer',
			banner: { key: KEY.banner, type: 'image/webp', size: 2000, alt: 'Summer' },
		},
	],
	bundles: [
		{
			id: ID.bundle,
			name: 'Two dresses',
			type: 'bundle',
			items: [{ productId: ID.dress, quantity: 2 }],
			price: 8000,
			limit: null,
			used: 4,
			active: true,
		},
	],
};

/** @param {unknown[]} records */
const ndjson = (records) => `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;

/**
 * POST /v1/import/:collection (NDJSON, server token).
 * @param {string} collection @param {unknown[]} records @param {{ dryRun?: boolean }} [options]
 */
const send = async (collection, records, { dryRun = false } = {}) => {
	const answer = await shop.api('POST', `/v1/import/${collection}${dryRun ? '?dryRun=1' : ''}`, ndjson(records), {
		'content-type': 'application/x-ndjson',
	});
	expect(answer.status).toBe(200);
	return answer.json;
};

/** @param {string} method @param {string} path @param {unknown} [body] */
const api = async (method, path, body) => {
	const answer = await shop.api(method, path, body);
	if (answer.status >= 300) throw new Error(`${method} ${path}: ${answer.status} ${answer.text}`);
	return answer.json;
};

/** A stored record without the database's own fields and the import's time. @param {string} collection @param {string} id */
const stored = async (collection, id) => {
	const found = await (await shop.db()).collection(collection).findOne({ websiteId: shop.websiteId, id });
	if (!found) return null;
	return Object.fromEntries(Object.entries(found).filter(([name]) => name !== '_id' && name !== 'updatedAt'));
};

/** @param {string} collection */
const count = async (collection) => (await shop.db()).collection(collection).countDocuments({ websiteId: shop.websiteId });

/** The bucket answers HEAD for new uploads with an image. */
const bucket = () =>
	shop.responders.set(STORAGE, (call) =>
		call.method === 'HEAD'
			? { status: 200, headers: { 'content-length': '2000', 'content-type': 'image/webp' } }
			: { status: 204 },
	);

beforeAll(async () => {
	shop = await readyShop({ features: ALL.filter((feature) => feature !== 'multi_location') });
	await shop.list('grades', [{ key: 'a-plus', label: 'A+', description: 'Like new' }]);
	await shop.setting('catalog', 'mediaBaseUrl', 'https://cdn.shop.example.com');
	// IndexNow on save would call Growth: an import never does
	await shop.paste('growth');
	await shop.setting('seo', 'indexNowOnSave', true);
	bucket();
});

afterAll(async () => shop.product.close());

describe('dry run', () => {
	it('reports every refusal by line and field, and writes nothing', async () => {
		const dry = await send(
			'categories',
			[
				RECORDS.categories[1],
				{ ...RECORDS.categories[0], isActive: true, websiteId: 'web_0123456789abcdef', path: [] },
				{ id: idOf('cat', 9), slug: 'long', name: 'x'.repeat(121) },
				{ id: idOf('cat', 10), slug: 'clothes', name: 'Twin' },
				{ id: idOf('cat', 11), slug: 'bad-parent', name: 'Bad parent', parentId: 'clothes' },
				{ id: idOf('brd', 12), slug: 'wrong-prefix', name: 'Wrong prefix', createdAt: '2999-01-01T00:00:00Z' },
			],
			{ dryRun: true },
		);
		expect(dry).toMatchObject({ inserted: 1, updated: 0, dryRun: true });
		const failed = Object.fromEntries(
			dry.failed.map((/** @type {any} */ row) => [row.line, row.errors.map((/** @type {any} */ e) => e.path)]),
		);
		expect(failed).toEqual({
			2: ['/isActive', '/websiteId', '/path', '/sizeChartId'],
			3: ['/name'],
			4: ['/slug'],
			5: ['/parentId'],
			6: ['/id', '/createdAt'],
		});
		const messages = dry.failed.flatMap((/** @type {any} */ row) => row.errors.map((/** @type {any} */ e) => e.message));
		expect(messages).toContain('isActive is not a field of a category.');
		expect(messages).toContain("websiteId is the token's website: leave it out.");
		expect(messages).toContain('path is derived by the shop: leave it out.');
		expect(messages).toContain(`Another category (${ID.clothes}) already uses this slug.`);
		expect(messages).toContain('There is no size chart szc_000000000000000000000001.');

		const products = await send(
			'products',
			[
				{ ...RECORDS.products[1], price: 100, sku: 'X' },
				{
					...RECORDS.products[0],
					description: 'y'.repeat(20_001),
					categoryIds: [ID.dresses],
					variants: [{ ...RECORDS.products[0].variants[1], forceOutOfStock: true }],
				},
			],
			{ dryRun: true },
		);
		expect(products.inserted).toBe(0);
		expect(products.failed[0].errors.map((/** @type {any} */ e) => e.path)).toEqual(['/price', '/sku']);
		// text over the limit is refused, never cut (IMP-31); the categories are not imported yet
		expect(products.failed[1].errors.map((/** @type {any} */ e) => e.path)).toEqual(
			expect.arrayContaining(['/variants/0/forceOutOfStock', '/description', '/categoryIds']),
		);
		for (const collection of ['categories', 'products']) expect(await count(collection)).toBe(0);
		const status = await api('GET', '/v1/import/status');
		expect(status.collections).toMatchObject({ categories: 0, products: 0, size_charts: 0 });
	});
});

describe('import', () => {
	it('imports every collection in order and a re-run changes nothing', async () => {
		const eventsBefore = (await api('GET', '/v1/events')).items.length;
		const callsBefore = shop.callsTo(NOTIFY).length + shop.callsTo(GROWTH).length;
		for (const [collection, records] of Object.entries(RECORDS)) {
			const answer = await send(collection, records);
			expect({ collection, ...answer }).toEqual({
				collection,
				inserted: records.length,
				updated: 0,
				failed: [],
				dryRun: false,
			});
		}
		// what a save derives from the record alone; the given numbers, times and keys as given
		const dress = /** @type {any} */ (await stored('products', ID.dress));
		expect(dress).toMatchObject({
			price: 4000,
			priceMax: 4500,
			inStock: true,
			stockState: 'partial',
			grades: [],
			sold: 12,
			rating: { average: 4.5, count: 2 },
			previousSlugs: ['linen-frock'],
			options: [{ name: 'Colour', values: ['Red', 'Blue'] }],
			video: { kind: 'file', key: KEY.video, type: 'video/mp4', size: 900000 },
			merchantId: expect.any(String),
		});
		expect(dress.media[0]).toEqual(RECORDS.products[0].media[0]);
		expect(dress.variants[0]).toMatchObject({
			id: ID.red,
			stock: 3,
			options: { Colour: 'Red' },
			media: [{ key: KEY.variant }],
		});
		expect(dress.createdAt.toISOString()).toBe('2023-04-01T08:00:00.000Z');
		expect(dress.publishedAt.toISOString()).toBe('2023-04-01T08:00:00.000Z');
		expect(await stored('products', ID.shell)).toMatchObject({ status: 'draft', variants: [], stockState: 'none', price: 0 });
		expect(await stored('serials', ID.sold)).toMatchObject({ status: 'sold', orderId: ID.order, lineId: ID.line });
		expect(await stored('deals', ID.deal)).toMatchObject({ used: 37, limit: 100, banner: { key: KEY.banner } });
		expect(await stored('bundles', ID.bundle)).toMatchObject({ used: 4, items: [{ productId: ID.dress, quantity: 2 }] });
		// the child came first: its path waits for finish
		expect(await stored('categories', ID.dresses)).toMatchObject({ path: [], previousSlugs: ['frocks'] });

		const before = await Promise.all([stored('products', ID.dress), stored('categories', ID.clothes)]);
		for (const [collection, records] of Object.entries(RECORDS))
			expect(await send(collection, records)).toMatchObject({ inserted: 0, updated: records.length, failed: [] });
		expect(await Promise.all([stored('products', ID.dress), stored('categories', ID.clothes)])).toEqual(before);

		// no message, event, alert or IndexNow call; one activity entry per call, no product activity
		expect(shop.callsTo(NOTIFY).length + shop.callsTo(GROWTH).length).toBe(callsBefore);
		expect((await api('GET', '/v1/events')).items.length).toBe(eventsBefore);
		expect((await api('GET', '/v1/activity?action=import.products')).items).toHaveLength(2);
		expect((await api('GET', '/v1/activity?action=product.created')).items).toHaveLength(0);
	});

	it('refuses slugs, SKUs, variant ids, serials, landing combinations and deal slugs another record holds', async () => {
		const merchant = await shop.seedProduct({ slug: 'own-dress', sku: 'OWN-1' });
		const clash = await send(
			'products',
			[
				{
					...RECORDS.products[0],
					id: idOf('prd', 3),
					slug: 'own-dress',
					variants: [
						{ ...RECORDS.products[0].variants[0], sku: 'OWN-1' },
						{ ...RECORDS.products[0].variants[1], id: idOf('var', 9), sku: 'LD-BLUE' },
					],
				},
				{ ...RECORDS.products[1], id: idOf('prd', 4), slug: 'shell' },
				{
					id: idOf('prd', 5),
					slug: 'plain',
					name: 'Plain',
					status: 'draft',
					variants: [{ id: idOf('var', 20), price: 100 }],
				},
			],
			{ dryRun: true },
		);
		expect(clash.inserted).toBe(1);
		expect(clash.failed.map((/** @type {any} */ row) => row.errors.map((/** @type {any} */ e) => e.message))).toEqual([
			[
				`Another product (${merchant.id}) already uses this slug.`,
				`Another product (${ID.dress}) already has this variant id.`,
				`Another product (${merchant.id}) already uses the SKU OWN-1.`,
				`Another product (${ID.dress}) already uses the SKU LD-BLUE.`,
			],
			[`Another product (${ID.shell}) already uses this slug.`],
		]);
		const serial = await send(
			'serials',
			[
				{ ...RECORDS.serials[0], id: idOf('ser', 3) },
				{ ...RECORDS.serials[0], id: idOf('ser', 4), serial: 'SN 9', variantId: idOf('var', 99) },
				{ ...RECORDS.serials[0], id: idOf('ser', 5), serial: 'SN 9', productId: idOf('prd', 99) },
			],
			{ dryRun: true },
		);
		expect(serial.failed.map((/** @type {any} */ row) => row.errors[0].message)).toEqual([
			`Another unit (${ID.unit}) already has this serial number.`,
			`The product has no variant ${idOf('var', 99)}.`,
			`There is no product ${idOf('prd', 99)}.`,
		]);
		expect(serial.failed[2].errors[1].message).toBe(`Another unit (${idOf('ser', 4)}) already has this serial number.`);
		const landing = await send('landings', [{ ...RECORDS.landings[0], id: idOf('lnd', 2) }], { dryRun: true });
		expect(landing.failed[0].errors[0].path).toBe('/categoryId');
		const deal = await send(
			'deals',
			[
				{ ...RECORDS.deals[0], id: idOf('deal', 2), scope: { productIds: [idOf('prd', 99)] } },
				{ ...RECORDS.deals[0], id: idOf('deal', 3), slug: '', scope: {} },
			],
			{ dryRun: true },
		);
		expect(deal.inserted).toBe(1);
		expect(deal.failed[0].errors.map((/** @type {any} */ e) => e.message)).toEqual([
			`Another deal (${ID.deal}) already uses this slug.`,
			`There is no product ${idOf('prd', 99)}.`,
		]);
		const bundle = await send('bundles', [{ ...RECORDS.bundles[0], items: [{ productId: idOf('prd', 98), quantity: 1 }] }], {
			dryRun: true,
		});
		expect(bundle.failed[0].errors).toEqual([{ path: '/items', message: `There is no product ${idOf('prd', 98)}.` }]);
		await (await shop.db()).collection('products').deleteOne({ websiteId: shop.websiteId, id: merchant.id });
	});
});

describe('finish', () => {
	it('derives the category paths and the products’ values, and a second run changes nothing', async () => {
		await (
			await shop.db()
		)
			.collection('products')
			.updateOne({ websiteId: shop.websiteId, id: ID.dress }, { $set: { price: 1, stockState: 'full' } });
		// the re-run already placed the dresses under the stored clothes
		expect((await stored('categories', ID.dresses))?.path).toEqual([ID.clothes]);
		const gowns = idOf('cat', 4);
		const evening = { id: ID.evening, slug: 'evening', name: 'Evening', parentId: gowns };
		await send('categories', [
			evening,
			{ id: gowns, slug: 'gowns', name: 'Gowns', parentId: ID.dresses },
			{ id: idOf('cat', 20), slug: 'lost', name: 'Lost', parentId: idOf('cat', 21) },
		]);
		expect((await stored('categories', ID.evening))?.path).toEqual([]);
		const first = await api('POST', '/v1/import/finish');
		expect(first).toMatchObject({
			finished: true,
			categoriesChecked: 5,
			categoriesChanged: 1,
			categoryProblems: { orphans: [idOf('cat', 20)], cycles: [], tooDeep: [] },
			productsChecked: 2,
			productsChanged: 1,
			next: null,
			more: false,
		});
		expect((await stored('categories', ID.evening))?.path).toEqual([ID.clothes, ID.dresses, gowns]);
		// no order line or review was moved: the old shop's sold count and rating stay
		expect(await stored('products', ID.dress)).toMatchObject({
			price: 4000,
			stockState: 'partial',
			sold: 12,
			rating: { average: 4.5, count: 2 },
		});
		expect(first.productsSoldRatingUpdated).toBe(0);
		const second = await api('POST', '/v1/import/finish');
		expect(second).toMatchObject({ categoriesChanged: 0, productsChanged: 0, more: false });
		// a re-import keeps a path whose parent is already stored
		await send('categories', [evening]);
		expect((await stored('categories', ID.evening))?.path).toEqual([ID.clothes, ID.dresses, gowns]);
	});

	it('answers the sums ss-import verify compares', async () => {
		const status = await api('GET', '/v1/import/status');
		expect(status.totals).toMatchObject({
			products: 2,
			'products.active': 1,
			'products.draft': 1,
			variants: 2,
			'variants.active': 2,
			'stock.units': 3,
			'serials.in_stock': 1,
			'serials.sold': 1,
			'serials.faulty': 0,
			'deals.used': 37,
			'bundles.used': 4,
		});
		expect(status.imported).toMatchObject({ products: 2, categories: 5, serials: 2 });
	});
});

describe('prune', () => {
	it('removes imported records the source no longer has', async () => {
		await send('brands', [{ id: ID.other, slug: 'other', name: 'Other' }]);
		const dry = await api('POST', '/v1/import/brands/prune?dryRun=1', { keep: [ID.brand] });
		expect(dry).toMatchObject({ removed: 1, keys: [ID.other], dryRun: true });
		expect(await api('POST', '/v1/import/brands/prune', { keep: [ID.brand] })).toMatchObject({ removed: 1 });
		expect(await stored('brands', ID.other)).toBeNull();
		expect(await stored('brands', ID.brand)).not.toBeNull();
	});
});

describe('reads', () => {
	it('shows imported records to shoppers and staff', async () => {
		const page = await shop.visitor('GET', '/v1/shop/products/linen-dress');
		expect(page.status).toBe(200);
		expect(page.json).toMatchObject({
			id: ID.dress,
			name: 'Linen dress',
			brand: { id: ID.brand, slug: 'maison' },
			breadcrumb: [{ id: ID.clothes }, { id: ID.dresses }],
			sizeChart: { id: ID.chart, columns: [{ key: 'chest-width' }, { key: 'length' }] },
		});
		expect(page.json.media[0]).toMatchObject({
			url: `https://cdn.shop.example.com/${KEY.photo}`,
			sizes: { thumb: `https://cdn.shop.example.com/${KEY.thumb}` },
		});
		const moved = await shop.visitor('GET', '/v1/shop/products/linen-frock');
		expect(moved.json.moved).toMatchObject({ kind: 'product', slug: 'linen-dress' });
		expect((await shop.visitor('GET', '/v1/shop/products/shell')).status).toBe(404);
		const staff = await api('GET', `/v1/products/${ID.shell}`);
		expect(staff).toMatchObject({ id: ID.shell, status: 'draft', variants: [] });
		const deal = await api('GET', `/v1/deals/${ID.deal}`);
		expect(deal).toMatchObject({ used: 37, slug: 'summer', banner: { key: KEY.banner } });
		const categories = await shop.visitor('GET', '/v1/shop/categories');
		expect(categories.status).toBe(200);
	});
});

describe('storage keys (CA-5)', () => {
	it('keeps the keys a product or variant holds on edits and takes new keys only from its folder', async () => {
		const folder = `ecommerce/products/${ID.dress}/`;
		const kept = await shop.api('PATCH', `/v1/products/${ID.dress}`, {
			variants: [
				{ id: ID.red, media: [{ key: KEY.variant }, { key: `${folder}new.webp` }, { key: KEY.photo }] },
				{ id: ID.blue },
			],
			video: { kind: 'file', key: KEY.video },
		});
		expect(kept.status).toBe(200);
		const after = /** @type {any} */ (await stored('products', ID.dress));
		expect(after.variants[0].media.map((/** @type {any} */ file) => [file.key, file.type])).toEqual([
			[KEY.variant, 'image/webp'],
			[`${folder}new.webp`, 'image/webp'],
			[KEY.photo, 'image/webp'],
		]);
		expect(after.video).toEqual(RECORDS.products[0].video);
		const foreign = await shop.api('PATCH', `/v1/products/${ID.dress}`, {
			variants: [{ id: ID.red, media: [{ key: KEY.variant }, { key: 'uploads/other/new.webp' }] }, { id: ID.blue }],
		});
		expect(foreign.status).toBe(422);
		expect(foreign.json.errors[0].path).toBe('/variants/0/media/1/key');
		const video = await shop.api('PATCH', `/v1/products/${ID.dress}`, { video: { kind: 'file', key: 'uploads/other.mp4' } });
		expect(video.status).toBe(422);

		// rearranging photos sends their sizes back: held ones pass, a new foreign one does not
		const arranged = await shop.api('PUT', `/v1/products/${ID.dress}/media`, {
			items: [{ key: KEY.photo, alt: 'Linen dress, front', sizes: { thumb: KEY.thumb } }],
		});
		expect(arranged.status).toBe(200);
		const sizes = await shop.api('PUT', `/v1/products/${ID.dress}/media`, {
			items: [{ key: KEY.photo, sizes: { thumb: 'uploads/other-thumb.webp' } }],
		});
		expect(sizes.status).toBe(422);

		// files an import kept in other folders may be shared: removing them from a record never deletes them
		expect((await shop.api('DELETE', `/v1/products/${ID.dress}/media?key=${encodeURIComponent(KEY.photo)}`)).status).toBe(200);
		expect((await shop.api('DELETE', `/v1/brands/${ID.brand}/logo`)).status).toBe(200);
		expect((await stored('brands', ID.brand))?.logo).toBeNull();
		const deleted = shop.callsTo(STORAGE).filter((call) => call.method === 'DELETE');
		expect(deleted.filter((call) => /uploads/.test(call.url))).toEqual([]);

		// a deal keeps its imported banner on edits; a new one is uploaded to the deal's own folder
		expect((await shop.api('PATCH', `/v1/deals/${ID.deal}`, { name: 'Summer sale' })).status).toBe(200);
		const banner = await shop.api('PATCH', `/v1/deals/${ID.deal}`, { banner: { key: 'offers/autumn.webp', alt: '' } });
		expect(banner.status).toBe(422);
		const shared = await shop.api('PATCH', `/v1/deals/${ID.deal}`, { banner: { key: 'ecommerce/deals/autumn.webp', alt: '' } });
		expect(shared.status).toBe(422);
		const own = await shop.api('PATCH', `/v1/deals/${ID.deal}`, {
			banner: { key: `ecommerce/deals/${ID.deal}/autumn.webp`, alt: '' },
		});
		expect(own.status).toBe(200);
	});
});

describe('drafts without variants (CA-2)', () => {
	it('stay off sale until they have a variant', async () => {
		const active = await shop.api('PATCH', `/v1/products/${ID.shell}`, { status: 'active' });
		expect(active.status).toBe(422);
		expect(active.json.errors[0]).toMatchObject({ path: '/status' });
		expect((await shop.api('PATCH', `/v1/products/${ID.shell}`, { name: 'Coming soon' })).status).toBe(200);
		const bulk = await api('POST', '/v1/products/bulk', { ids: [ID.shell], action: 'status', status: 'active' });
		expect(bulk).toMatchObject({ matched: 1, changed: 0 });
		const first = await api('PATCH', `/v1/products/${ID.shell}`, { price: 1500, stock: 2 });
		expect(first.variants).toHaveLength(1);
		const live = await api('PATCH', `/v1/products/${ID.shell}`, { status: 'active' });
		expect(live).toMatchObject({ status: 'active' });
	});
});

describe('large catalogs', () => {
	/**
	 * Every page of a finish, following next while more.
	 * @returns {Promise<Array<Record<string, any>>>}
	 */
	const finishAll = async () => {
		const pages = [];
		/** @type {string | null} */
		let next = null;
		do {
			const page = await api('POST', `/v1/import/finish${next === null ? '' : `?after=${encodeURIComponent(next)}`}`);
			pages.push(page);
			next = page.more ? page.next : null;
		} while (next !== null);
		return pages;
	};
	/** @param {Array<Record<string, any>>} pages @param {string} name */
	const sum = (pages, name) => pages.reduce((total, page) => total + page[name], 0);

	it('finishes in pages of at most 200 records, and a second run changes nothing', async () => {
		const data = await shop.db();
		const products = Array.from({ length: 501 }, (_, i) => ({
			id: idOf('prd', 1000 + i),
			slug: `bulk-${i}`,
			name: 'Bulk',
			status: 'draft',
			trackStock: true,
			variants: [],
		}));
		const categories = Array.from({ length: 250 }, (_, i) => ({
			id: idOf('cat', 10_000 + i),
			slug: `bulk-${i}`,
			name: 'Bulk',
			parentId: null,
			path: [idOf('cat', 1)],
		}));
		await data.collection('products').insertMany(products);
		await data.collection('categories').insertMany(categories);
		const first = await finishAll();
		// 255 categories, 503 products' prices, then the orders' steps (503 products' sold and rating): 200 records a page
		expect(first.map((page) => page.categoriesChecked + page.productsChecked)).toEqual([200, 200, 200, 158, 0, 0, 0]);
		expect(first.slice(0, -1).every((page) => page.more === true && typeof page.next === 'string')).toBe(true);
		expect(first.at(-1)).toMatchObject({ more: false, next: null });
		expect(first[0]?.next).toBe(`categories:${idOf('cat', 10_000 + 194)}`);
		expect(first[1]?.categoryProblems).toMatchObject({ cycles: [], tooDeep: [] });
		expect(first[2]?.categoryProblems).toBeUndefined();
		expect([sum(first, 'categoriesChecked'), sum(first, 'categoriesChanged')]).toEqual([255, 250]);
		expect([sum(first, 'productsChecked'), sum(first, 'productsChanged')]).toEqual([503, 501]);
		expect((await stored('categories', idOf('cat', 10_100)))?.path).toEqual([]);
		const second = await finishAll();
		expect(second).toHaveLength(7);
		expect([sum(second, 'categoriesChanged'), sum(second, 'productsChanged')]).toEqual([0, 0]);
		// a page starts where the last one stopped; another after is refused
		const page = await shop.api('POST', `/v1/import/finish?after=${encodeURIComponent(String(first[2]?.next))}`);
		expect(page.json).toMatchObject({ categoriesChecked: 0, productsChecked: 158, more: true });
		expect(page.json.next).toMatch(/^sold:[0-9a-f]{24}$/);
		for (const after of ['nothing:1', 'customers:not-an-id', 'counters:1', `products:${'x'.repeat(201)}`]) {
			const refused = await shop.api('POST', `/v1/import/finish?after=${encodeURIComponent(after)}`);
			expect(refused.status, after).toBe(422);
			expect(String(refused.json.type).split('/').pop()).toBe('validation_failed');
		}
		await data.collection('products').deleteMany({ websiteId: shop.websiteId, slug: /^bulk-/ });
		await data.collection('categories').deleteMany({ websiteId: shop.websiteId, slug: /^bulk-/ });
	});

	it('leaves a tree beyond the product’s limit alone', async () => {
		const data = await shop.db();
		const categories = Array.from({ length: 5001 }, (_, i) => ({
			id: idOf('cat', 10_000 + i),
			slug: `bulk-${i}`,
			name: 'Bulk',
			parentId: null,
			path: [],
		}));
		await data.collection('categories').insertMany(categories);
		const [first] = await finishAll();
		expect(first).toMatchObject({ categoriesChecked: 0, categoriesChanged: 0, categoryProblems: { tooMany: true } });
		await data.collection('categories').deleteMany({ websiteId: shop.websiteId, slug: /^bulk-/ });
	});
});

describe('the README examples', () => {
	it('import as they are, in the order the README gives', async () => {
		const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
		const block = /## Import — catalog[\s\S]*?```json\n([\s\S]*?)```/.exec(readme)?.[1] ?? '';
		const records = block
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		/** @type {Record<string, string>} */
		const byPrefix = {
			szc: 'size_charts',
			cat: 'categories',
			brd: 'brands',
			att: 'attributes',
			lnd: 'landings',
			prd: 'products',
			ser: 'serials',
			deal: 'deals',
			bnd: 'bundles',
		};
		expect(records.map((record) => byPrefix[record.id.split('_')[0]])).toEqual(Object.keys(RECORDS));
		const fresh = await readyShop({ features: ALL.filter((feature) => feature !== 'multi_location') });
		for (const record of records) {
			const answer = await fresh.api('POST', `/v1/import/${byPrefix[record.id.split('_')[0]]}`, ndjson([record]), {
				'content-type': 'application/x-ndjson',
			});
			expect({ id: record.id, ...answer.json }).toEqual({ id: record.id, inserted: 1, updated: 0, failed: [], dryRun: false });
		}
		const page = await fresh.visitor('GET', '/v1/shop/products/linen-dress');
		expect(page.json).toMatchObject({ id: records[5].id, price: 4500 });
		await fresh.product.close();
	});

	it('say how finish pages, which numbers it keeps and how national phones are read', () => {
		const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
		expect(readme).toContain(`one call works on at most ${FINISH_PAGE} records and answers \`more\` and \`next\``);
		expect(readme).toContain('call again with `?after=<next>`');
		expect(readme).not.toContain('catalog: { categories');
		expect(readme).toContain('a product with none keeps the given numbers');
		expect(readme).toContain('keeps the given numbers where there is nothing to derive');
		expect(readme).toContain('the `checkout.defaultCallingCode` setting, else the business.json country');
	});
});
