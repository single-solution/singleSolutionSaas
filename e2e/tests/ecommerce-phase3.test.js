/**
 * PLAN 0.8.10 build phase 3, Ecommerce's "done when": SB-, CT- and IM-like fixture catalogs (variant attributes with
 * several values, grades per category, variant galleries, size charts, video, rich text, landing pages) are written
 * through the API with the Portal-issued server tokens and read back through server-token shop reads (K3, as the stores
 * render their pages); product links come out as `/{category}/{slug}`; robots, JSON-LD and sitemaps match the
 * fixtures; Atlas Search falls back to the basic search where the database is not Atlas (the in-process replica set),
 * and the website's search state says the index is missing. Ecommerce runs against the REAL Portal; the merchant's
 * S3 bucket is a fake in this process. Atlas Search itself needs MongoDB Atlas and is not reachable here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProductInstance, manifest, strings } from '@ss/product-ecommerce/product';
import { createRoutes } from '@ss/product-ecommerce/routes';
import { startSystem } from './helpers.js';

const SHOP = 'https://ecommerce-phase3.test';
const BUCKET = 'https://bucket.phase3.test';
/** The three stores: clothing (SB-like), fans (CT-like) and phones (IM-like). */
const STORES = /** @type {const} */ (['sisters.example.com', 'fans.example.com', 'mobiles.example.com']);

/** @type {Record<string, string>} */
const TYPES = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', mp4: 'video/mp4' };

/** @type {import('./helpers.js').System} */
let sys;
/** @type {Record<string, { websiteId: string, tokens: { browser: string, server: string } }>} */
const stores = {};

/**
 * The merchant's S3 bucket: every upload and test works; HEAD answers a file of the key's type.
 * @param {Request} request
 */
const bucket = async (request) => {
	if (request.method !== 'HEAD') return new Response(null, { status: 200 });
	const extension = new URL(request.url).pathname.split('.').pop() ?? '';
	return new Response(null, {
		status: 200,
		headers: { 'content-type': TYPES[extension] ?? 'application/octet-stream', 'content-length': '2048' },
	});
};

beforeAll(async () => {
	sys = await startSystem({
		unit: { createProductInstance, createRoutes, manifest, strings, url: SHOP, handlers: { [BUCKET]: bucket } },
	});
	await sys.connect();
	const m = await sys.merchant('stores@phase3.test', [...STORES]);
	await sys.addCredits(m.merchantId, 100);
	const support = await sys.admin('support');
	for (const [index, domain] of STORES.entries()) {
		const websiteId = m.websiteIds[index] ?? '';
		await sys.addProduct(m.merchantId, websiteId);
		stores[domain] = { websiteId, tokens: await sys.tokens(m.merchantId, websiteId) };
		await sys.switchFeatures(
			await sys.adminSession(support.client, websiteId),
			websiteId,
			manifest.features.map((feature) => feature.key).filter((key) => key !== 'multi_location'),
		);
		const cookie = await sys.adminSession(await sys.owner(), websiteId);
		await sys.connectDatabase(cookie, websiteId);
		const storage = await sys.dashboard(cookie, 'PUT', `/v1/dashboard/websites/${websiteId}/connections/storage`, {
			value: {
				endpoint: BUCKET,
				region: 'auto',
				bucket: 'shop',
				accessKeyId: 'AKIAPHASE3',
				secretAccessKey: 'phase3-secret-0123456789',
			},
		});
		expect(storage.json).toMatchObject({ status: 'connected' });
	}
});
afterAll(async () => {
	await sys?.stop();
});

/**
 * A call of a store's server with its server token (no Origin): staff routes and, for visitor routes, the pages it
 * renders (K3).
 * @param {string} domain @param {string} method @param {string} path @param {unknown} [body]
 */
const serverCall = async (domain, method, path, body) =>
	sys.call(method, path, { token: stores[domain]?.tokens.server, ...(body === undefined ? {} : { body }) });

/** @param {string} domain @param {string} method @param {string} path @param {unknown} [body] */
const write = async (domain, method, path, body) => {
	const answer = await serverCall(domain, method, path, body);
	expect(answer.status, `${method} ${path}: ${JSON.stringify(answer.json)}`).toBeLessThan(300);
	return answer.json;
};

/** Save settings and lists through the settings API (K1). @param {string} domain @param {Record<string, unknown>} values */
const configure = async (domain, values) => {
	for (const [key, value] of Object.entries(values)) {
		const path = key.startsWith('list.') ? `/v1/lists/${key.slice(5)}` : `/v1/settings/${key}`;
		await write(domain, 'PUT', path, { value });
	}
};

/** An upload made for a product (the bucket keeps it). @param {string} domain @param {string} id @param {string} type */
const upload = async (domain, id, type) =>
	String((await write(domain, 'POST', '/v1/catalog/uploads', { for: 'product', id, type, size: 2048 })).key);

/** @param {string} jsonLd @param {string} type */
const nodeOf = (jsonLd, type) => JSON.parse(jsonLd)['@graph'].find((/** @type {any} */ node) => node['@type'] === type);

const [SB, CT, IM] = STORES;
/** @type {Record<string, any>} */
const ids = {};

describe('Ecommerce phase 3 on the real Portal', () => {
	it('writes an SB-like clothing catalog: variant attributes with several values, a size chart, video and rich text', async () => {
		await configure(SB, {
			'catalog.productUrl': '/{category}/{slug}',
			'catalog.categoryUrl': '/{slug}',
			'catalog.variantQuery': '{attributes}',
		});
		const women = await write(SB, 'POST', '/v1/categories', { name: 'Women', slug: 'women' });
		const dresses = await write(SB, 'POST', '/v1/categories', {
			name: 'Dresses',
			slug: 'dresses',
			parentId: women.id,
			content: { summary: 'Dresses for every day.', bullets: [{ text: 'Free alterations', icon: 'scissors' }] },
			faqs: [{ question: 'Do they run small?', answer: 'Order one size up.' }],
		});
		const brand = await write(SB, 'POST', '/v1/brands', { name: 'Maison', slug: 'maison', categoryIds: [women.id] });
		const colour = await write(SB, 'POST', '/v1/attributes', {
			name: 'Colour',
			slug: 'colour',
			type: 'choice',
			on: 'variant',
			multiple: true,
			filterable: true,
			choices: [
				{ value: 'red', label: 'Red' },
				{ value: 'gold', label: 'Gold' },
			],
			seo: { title: 'Colours', description: 'How we name our colours.', body: 'Red is red.' },
		});
		const size = await write(SB, 'POST', '/v1/attributes', {
			name: 'Size',
			slug: 'size',
			type: 'choice',
			on: 'variant',
			choices: ['S', 'M'],
			filterable: true,
		});
		const chart = await write(SB, 'POST', '/v1/size-charts', {
			name: 'Dresses',
			unit: 'in',
			columns: [{ key: 'bust', label: 'Bust' }],
			rows: [
				{ size: 'S', values: { bust: '34' } },
				{ size: 'M', values: { bust: '36' } },
			],
			fitAdvice: 'Order one size up.',
		});
		await write(SB, 'PATCH', `/v1/categories/${dresses.id}`, { sizeChartId: chart.id });
		const dress = await write(SB, 'POST', '/v1/products', {
			name: 'Embroidered dress',
			slug: 'embroidered-dress',
			status: 'active',
			featured: true,
			categoryIds: [dresses.id],
			brandId: brand.id,
			descriptionHtml: '<p>Hand <strong>embroidered</strong>.</p><script>x()</script>',
			video: { kind: 'youtube', id: 'https://youtu.be/dQw4w9WgXcQ' },
			faqs: [{ question: 'Lined?', answer: 'Yes.' }],
			variants: [
				{ attributes: { [colour.id]: ['red', 'gold'], [size.id]: 'S' }, price: 1_250_000, stock: 3 },
				{ attributes: { [colour.id]: ['red', 'gold'], [size.id]: 'M' }, price: 1_250_000, stock: 0 },
			],
		});
		expect(dress.options).toEqual([
			{ name: 'Colour', values: ['Red, Gold'] },
			{ name: 'Size', values: ['S', 'M'] },
		]);
		const landing = await write(SB, 'POST', '/v1/landings', {
			categoryId: dresses.id,
			brandId: brand.id,
			h1: 'Maison dresses',
			description: 'Every Maison dress.',
			indexable: 'yes',
		});
		Object.assign(ids, { sbDress: dress, sbDresses: dresses, sbLanding: landing, sbChart: chart });

		// read back through the server-token shop reads (K3)
		const page = await serverCall(SB, 'GET', '/v1/shop/products/embroidered-dress');
		expect(page.status).toBe(200);
		expect(page.json).toMatchObject({
			url: 'https://sisters.example.com/dresses/embroidered-dress',
			featured: true,
			descriptionHtml: '<p>Hand <strong>embroidered</strong>.</p>',
			video: { kind: 'youtube', id: 'dQw4w9WgXcQ' },
			sizeChart: { id: chart.id, unit: 'in', fitAdvice: 'Order one size up.' },
			faqs: [{ question: 'Lined?', answer: 'Yes.' }],
		});
		expect(page.json.variants[0].attributes.map((/** @type {any} */ a) => [a.slug, a.label])).toEqual([
			['colour', 'Red, Gold'],
			['size', 'S'],
		]);
		expect(page.json.variants[0].url).toBe('https://sisters.example.com/dresses/embroidered-dress?colour=red&size=S');
		const listing = await serverCall(SB, 'GET', '/v1/shop/products?attr.colour=gold&inStock=1&count=1');
		expect(listing.json).toMatchObject({ total: 1, items: [{ url: 'https://sisters.example.com/dresses/embroidered-dress' }] });
		expect((await serverCall(SB, 'GET', '/v1/shop/products?attr.size=M&inStock=1')).json.items).toEqual([]);
		const tree = (await serverCall(SB, 'GET', '/v1/shop/categories')).json.items;
		expect(tree[0].children[0]).toMatchObject({
			name: 'Dresses',
			content: { summary: 'Dresses for every day.' },
			url: 'https://sisters.example.com/dresses',
		});
	});

	it('writes a CT-like fans catalog: generated variants with their own photo galleries', async () => {
		await configure(CT, { 'catalog.productUrl': '/{category}/{slug}', 'catalog.categoryUrl': '/{slug}' });
		const fans = await write(CT, 'POST', '/v1/categories', { name: 'Ceiling fans', slug: 'ceiling-fans' });
		const brand = await write(CT, 'POST', '/v1/brands', { name: 'Breeze', slug: 'breeze' });
		const sweep = await write(CT, 'POST', '/v1/attributes', {
			name: 'Sweep',
			slug: 'sweep',
			type: 'choice',
			on: 'variant',
			choices: ['48 in', '56 in'],
			filterable: true,
		});
		const finish = await write(CT, 'POST', '/v1/attributes', {
			name: 'Finish',
			slug: 'finish',
			type: 'choice',
			on: 'variant',
			choices: ['White', 'Bronze'],
			card: 'image',
			filterable: true,
		});
		const fan = await write(CT, 'POST', '/v1/products', {
			name: 'Breeze 3000',
			slug: 'breeze-3000',
			status: 'active',
			categoryIds: [fans.id],
			brandId: brand.id,
			variants: [{ attributes: { [sweep.id]: '48 in', [finish.id]: 'White' }, price: 1_500_000, stock: 4 }],
			attributeSetup: [
				{ attributeId: sweep.id, values: ['48 in', '56 in'] },
				{ attributeId: finish.id, values: ['White', 'Bronze'] },
			],
		});
		const generated = await write(CT, 'POST', `/v1/products/${fan.id}/variants/generate`, { price: 1_650_000, stock: 2 });
		expect(generated.added).toBe(3);
		const variants = generated.product.variants;
		/** @type {Record<string, string>} */
		const photos = {};
		for (const variant of variants) photos[variant.id] = await upload(CT, fan.id, 'image/webp');
		const galleries = await write(CT, 'PATCH', `/v1/products/${fan.id}`, {
			variants: variants.map((/** @type {any} */ variant) => ({
				id: variant.id,
				media: [{ key: photos[variant.id], alt: variant.options.Finish, width: 800, height: 800 }],
			})),
		});
		expect(galleries.variants.every((/** @type {any} */ variant) => variant.media[0].type === 'image/webp')).toBe(true);
		await write(CT, 'POST', '/v1/landings', {
			categoryId: fans.id,
			brandId: brand.id,
			h1: 'Breeze ceiling fans',
			indexable: 'auto',
		});
		Object.assign(ids, { ctFan: fan, ctFans: fans });

		const card = (await serverCall(CT, 'GET', '/v1/shop/products?brand=breeze')).json.items[0];
		expect(card).toMatchObject({
			url: 'https://fans.example.com/ceiling-fans/breeze-3000',
			price: 1_500_000,
			priceMax: 1_650_000,
		});
		expect(card.cardImages.map((/** @type {any} */ image) => image.alt)).toEqual(['White', 'Bronze', 'White', 'Bronze']);
		const page = (await serverCall(CT, 'GET', '/v1/shop/products/BREEZE-3000')).json;
		expect(page.variants).toHaveLength(4);
		expect(page.variants.every((/** @type {any} */ variant) => variant.media.length === 1)).toBe(true);
	});

	it('writes an IM-like phones catalog: grades per category with their own conditions, serials and warranty', async () => {
		await configure(IM, {
			'catalog.productUrl': '/{category}/{slug}',
			'catalog.categoryUrl': '/{slug}',
			'catalog.showStock': 'always',
			'list.grades': [
				{ key: 'brand-new', label: 'Brand new', condition: 'new', warrantyDays: 365 },
				{
					key: 'a-plus',
					label: 'A+',
					condition: 'refurbished',
					warrantyDays: 90,
					seo: { title: 'A+ phones', body: 'Like new.' },
				},
				{ key: 'b', label: 'B', condition: 'used', warrantyDays: 30 },
			],
			'grades_serials.serialMode': 'typed',
			'grades_serials.serialCheck': 'imei',
			'landing_pages.gradeUrl': '/grades/{key}',
		});
		const phones = await write(IM, 'POST', '/v1/categories', { name: 'Phones', slug: 'phones', requiresSerial: true });
		const brand = await write(IM, 'POST', '/v1/brands', { name: 'Pixel', slug: 'pixel' });
		const phone = await write(IM, 'POST', '/v1/products', {
			name: 'Pixel 8 Pro',
			slug: 'pixel-8-pro',
			status: 'active',
			categoryIds: [phones.id],
			brandId: brand.id,
			serialized: null,
			options: [{ name: 'Storage', values: ['128 GB'] }],
			variants: [
				{ options: { Storage: '128 GB' }, price: 15_000_000, stock: 2, grade: 'a-plus' },
				{ options: { Storage: '128 GB' }, price: 12_000_000, stock: 3, grade: 'b', warrantyDays: 60 },
			],
		});
		await write(IM, 'POST', '/v1/landings', { brandId: brand.id, grade: 'a-plus', h1: 'A+ Pixel phones', indexable: 'yes' });
		Object.assign(ids, { imPhone: phone, imPhones: phones });

		const page = (await serverCall(IM, 'GET', '/v1/shop/products/pixel-8-pro')).json;
		expect(page.url).toBe('https://mobiles.example.com/phones/pixel-8-pro');
		expect(page.variants.map((/** @type {any} */ v) => [v.grade.key, v.grade.condition, v.warrantyDays, v.stockLeft])).toEqual([
			['a-plus', 'refurbished', 90, 2],
			['b', 'used', 60, 3],
		]);
		const graded = (await serverCall(IM, 'GET', '/v1/shop/products?grade=a-plus,b&count=1')).json;
		expect(graded.total).toBe(1);
		expect(graded.facets.grades.map((/** @type {any} */ g) => g.key)).toEqual(['a-plus', 'b']);
	});

	it('answers robots and JSON-LD that match the fixtures', async () => {
		const dress = (await serverCall(SB, 'GET', '/v1/seo/products/embroidered-dress')).json;
		expect(dress).toMatchObject({
			canonical: 'https://sisters.example.com/dresses/embroidered-dress',
			robots: 'index, follow',
		});
		const group = nodeOf(dress.jsonLd, 'ProductGroup');
		expect(group.hasVariant.map((/** @type {any} */ v) => v.offers.availability)).toEqual([
			'https://schema.org/InStock',
			'https://schema.org/OutOfStock',
		]);
		expect(nodeOf(dress.jsonLd, 'FAQPage').mainEntity[0].name).toBe('Lined?');
		const phone = (await serverCall(IM, 'GET', '/v1/seo/products/pixel-8-pro')).json;
		expect(nodeOf(phone.jsonLd, 'ProductGroup').hasVariant.map((/** @type {any} */ v) => v.offers.itemCondition)).toEqual([
			'https://schema.org/RefurbishedCondition',
			'https://schema.org/UsedCondition',
		]);
		const landing = (await serverCall(SB, 'GET', '/v1/seo/listing?category=dresses&brand=maison')).json;
		expect(landing).toMatchObject({
			h1: 'Maison dresses',
			robots: 'index, follow',
			canonical: 'https://sisters.example.com/dresses?brand=maison',
		});
		expect(nodeOf(landing.jsonLd, 'CollectionPage').name).toBe('Maison dresses');
		const filtered = (await serverCall(SB, 'GET', '/v1/seo/listing?category=dresses&attr.colour=red')).json;
		expect(filtered.robots).toBe('noindex, follow');
		const category = (await serverCall(SB, 'GET', '/v1/seo/listing?category=dresses')).json;
		expect(category).toMatchObject({
			robots: 'index, follow',
			faqs: [{ question: 'Do they run small?', answer: 'Order one size up.' }],
		});
		// a product marked noindex says so and leaves the sitemap
		await write(CT, 'PATCH', `/v1/products/${ids.ctFan.id}`, { seo: { noindex: true } });
		expect((await serverCall(CT, 'GET', '/v1/seo/products/breeze-3000')).json.robots).toBe('noindex, follow');
	});

	it('serves sitemaps of what the stores list, with /{category}/{slug} product links', async () => {
		const sb = (await serverCall(SB, 'GET', '/v1/seo/sitemap.xml')).json;
		expect(sb).toContain('<loc>https://sisters.example.com/dresses/embroidered-dress</loc>');
		expect(sb).toContain('<loc>https://sisters.example.com/dresses?brand=maison</loc>');
		expect(sb).toContain('<loc>https://sisters.example.com/women</loc>');
		const ct = (await serverCall(CT, 'GET', '/v1/seo/sitemap.xml')).json;
		expect(ct).not.toContain('breeze-3000');
		await write(CT, 'PATCH', `/v1/products/${ids.ctFan.id}`, { seo: { noindex: false } });
		const listed = (await serverCall(CT, 'GET', '/v1/seo/sitemap.xml')).json;
		expect(listed).toContain('<loc>https://fans.example.com/ceiling-fans/breeze-3000</loc>');
		expect((listed.match(/<image:image>/g) ?? []).length).toBe(4);
		const im = (await serverCall(IM, 'GET', '/v1/seo/sitemap.xml')).json;
		expect(im).toContain('<loc>https://mobiles.example.com/phones/pixel-8-pro</loc>');
		expect(im).toContain('<loc>https://mobiles.example.com/?brand=pixel&amp;grade=a-plus</loc>');
		expect(im).toContain('<loc>https://mobiles.example.com/grades/a-plus</loc>');
		const grade = (await serverCall(IM, 'GET', '/v1/seo/grades/a-plus')).json;
		expect(grade).toMatchObject({ canonical: 'https://mobiles.example.com/grades/a-plus', robots: 'index, follow' });
		// a renamed product keeps its old link working through `moved` (the store answers 308)
		await write(SB, 'PATCH', `/v1/products/${ids.sbDress.id}`, { slug: 'hand-embroidered-dress' });
		const moved = await serverCall(SB, 'GET', '/v1/shop/products/embroidered-dress');
		expect(moved.json).toEqual({
			moved: {
				kind: 'product',
				slug: 'hand-embroidered-dress',
				url: 'https://sisters.example.com/dresses/hand-embroidered-dress',
			},
		});
	});

	it('falls back to the basic search where Atlas Search is not available', async () => {
		await configure(IM, { 'catalog.search': 'atlas' });
		const found = await serverCall(IM, 'GET', '/v1/shop/products?q=pixel');
		expect(found.status).toBe(200);
		expect(found.json.items.map((/** @type {any} */ item) => item.name)).toEqual(['Pixel 8 Pro']);
		const cookie = await sys.adminSession(await sys.owner(), stores[IM]?.websiteId ?? '');
		const state = await sys.dashboard(cookie, 'GET', `/v1/dashboard/websites/${stores[IM]?.websiteId}/search-index`);
		expect(state.status).toBe(200);
		expect(state.json).toMatchObject({ search: 'atlas', state: { missing: true } });
	});
});
