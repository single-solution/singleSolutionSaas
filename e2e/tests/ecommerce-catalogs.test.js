/**
 * PLAN 0.8.10 build phase 3, Ecommerce's "done when": catalogs of three kinds of shop, clothing, lighting and
 * phones (variant attributes with several values, grades per category, variant galleries, size charts, video, rich
 * text, landing pages) are written through the API with the Portal-issued server tokens and read back through
 * server-token shop reads (K3, as the shops render their pages); product links come out as `/{category}/{slug}`;
 * robots, JSON-LD and sitemaps match the fixtures; Atlas Search falls back to the basic search where the database is
 * not Atlas (the in-process replica set), and the website's search state says the index is missing. Ecommerce runs
 * against the REAL Portal; the merchant's S3 bucket is a fake in this process. Atlas Search itself needs MongoDB
 * Atlas and is not reachable here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProductInstance, manifest, strings } from '@ss/product-ecommerce/product';
import { createRoutes } from '@ss/product-ecommerce/routes';
import { startSystem } from './helpers.js';

const SHOP = 'https://ecommerce-catalogs.test';
const BUCKET = 'https://bucket.catalogs.test';
/** Three kinds of shop: clothing, lighting and phones. */
const STORES = /** @type {const} */ (['apparel.example.com', 'lighting.example.com', 'devices.example.com']);

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
	const m = await sys.merchant('shops@catalogs.test', [...STORES]);
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
				accessKeyId: 'AKIACATALOGS',
				secretAccessKey: 'catalogs-secret-0123456789',
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

const [APPAREL, LIGHTING, DEVICES] = STORES;
/** @type {Record<string, any>} */
const ids = {};

describe('Ecommerce catalogs on the real Portal', () => {
	it('writes a clothing catalog: variant attributes with several values, a size chart, video and rich text', async () => {
		await configure(APPAREL, {
			'catalog.productUrl': '/{category}/{slug}',
			'catalog.categoryUrl': '/{slug}',
			'catalog.variantQuery': '{attributes}',
		});
		const women = await write(APPAREL, 'POST', '/v1/categories', { name: 'Women', slug: 'women' });
		const dresses = await write(APPAREL, 'POST', '/v1/categories', {
			name: 'Dresses',
			slug: 'dresses',
			parentId: women.id,
			content: { summary: 'Dresses for every day.', bullets: [{ text: 'Free alterations', icon: 'scissors' }] },
			faqs: [{ question: 'Do they run small?', answer: 'Order one size up.' }],
		});
		const brand = await write(APPAREL, 'POST', '/v1/brands', { name: 'Maison', slug: 'maison', categoryIds: [women.id] });
		const color = await write(APPAREL, 'POST', '/v1/attributes', {
			name: 'Color',
			slug: 'color',
			type: 'choice',
			on: 'variant',
			multiple: true,
			show: { filter: true },
			choices: [
				{ value: 'red', label: 'Red' },
				{ value: 'gold', label: 'Gold' },
			],
			seo: { title: 'Colors', description: 'How we name our colors.', body: 'Red is red.' },
		});
		const size = await write(APPAREL, 'POST', '/v1/attributes', {
			name: 'Size',
			slug: 'size',
			type: 'choice',
			on: 'variant',
			choices: ['S', 'M'],
			show: { filter: true },
		});
		const chart = await write(APPAREL, 'POST', '/v1/size-charts', {
			name: 'Dresses',
			unit: 'in',
			columns: [{ key: 'bust', label: 'Bust' }],
			rows: [
				{ size: 'S', values: { bust: '34' } },
				{ size: 'M', values: { bust: '36' } },
			],
			convertTo: 'cm',
			advice: 'Order one size up.',
		});
		await write(APPAREL, 'PATCH', `/v1/categories/${dresses.id}`, { sizeChartId: chart.id });
		const dress = await write(APPAREL, 'POST', '/v1/products', {
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
				{ attributes: { [color.id]: ['red', 'gold'], [size.id]: 'S' }, price: 1_250_000, stock: 3 },
				{ attributes: { [color.id]: ['red', 'gold'], [size.id]: 'M' }, price: 1_250_000, stock: 0 },
			],
		});
		expect(dress.options).toEqual([
			{ name: 'Color', values: ['Red, Gold'] },
			{ name: 'Size', values: ['S', 'M'] },
		]);
		const landing = await write(APPAREL, 'POST', '/v1/landings', {
			categoryId: dresses.id,
			brandId: brand.id,
			h1: 'Maison dresses',
			description: 'Every Maison dress.',
			indexable: 'yes',
		});
		Object.assign(ids, { dress, dresses, landing, chart });

		// read back through the server-token shop reads (K3)
		const page = await serverCall(APPAREL, 'GET', '/v1/shop/products/embroidered-dress');
		expect(page.status).toBe(200);
		expect(page.json).toMatchObject({
			url: 'https://apparel.example.com/dresses/embroidered-dress',
			featured: true,
			descriptionHtml: '<p>Hand <strong>embroidered</strong>.</p>',
			video: { kind: 'youtube', id: 'dQw4w9WgXcQ' },
			sizeChart: { id: chart.id, unit: 'in', convertTo: 'cm', advice: 'Order one size up.' },
			faqs: [{ question: 'Lined?', answer: 'Yes.' }],
		});
		expect(page.json.variants[0].attributes.map((/** @type {any} */ a) => [a.slug, a.label])).toEqual([
			['color', 'Red, Gold'],
			['size', 'S'],
		]);
		expect(page.json.variants[0].url).toBe('https://apparel.example.com/dresses/embroidered-dress?color=red&size=S');
		const listing = await serverCall(APPAREL, 'GET', '/v1/shop/products?attr.color=gold&inStock=1&count=1');
		expect(listing.json).toMatchObject({ total: 1, items: [{ url: 'https://apparel.example.com/dresses/embroidered-dress' }] });
		expect((await serverCall(APPAREL, 'GET', '/v1/shop/products?attr.size=M&inStock=1')).json.items).toEqual([]);
		const tree = (await serverCall(APPAREL, 'GET', '/v1/shop/categories')).json.items;
		expect(tree[0].children[0]).toMatchObject({
			name: 'Dresses',
			content: { summary: 'Dresses for every day.' },
			url: 'https://apparel.example.com/dresses',
		});
	});

	it('writes a lighting catalog: generated variants with their own photo galleries', async () => {
		await configure(LIGHTING, { 'catalog.productUrl': '/{category}/{slug}', 'catalog.categoryUrl': '/{slug}' });
		const lights = await write(LIGHTING, 'POST', '/v1/categories', { name: 'Pendant lights', slug: 'pendant-lights' });
		const brand = await write(LIGHTING, 'POST', '/v1/brands', { name: 'Lumen', slug: 'lumen' });
		const width = await write(LIGHTING, 'POST', '/v1/attributes', {
			name: 'Width',
			slug: 'width',
			type: 'choice',
			on: 'variant',
			choices: ['30 cm', '45 cm'],
			show: { filter: true },
		});
		const finish = await write(LIGHTING, 'POST', '/v1/attributes', {
			name: 'Finish',
			slug: 'finish',
			type: 'choice',
			on: 'variant',
			choices: ['White', 'Bronze'],
			show: { card: 'image', filter: true },
		});
		const light = await write(LIGHTING, 'POST', '/v1/products', {
			name: 'Lumen 300',
			slug: 'lumen-300',
			status: 'active',
			categoryIds: [lights.id],
			brandId: brand.id,
			variants: [{ attributes: { [width.id]: '30 cm', [finish.id]: 'White' }, price: 1_500_000, stock: 4 }],
			attributeSetup: [
				{ attributeId: width.id, values: ['30 cm', '45 cm'] },
				{ attributeId: finish.id, values: ['White', 'Bronze'] },
			],
		});
		const generated = await write(LIGHTING, 'POST', `/v1/products/${light.id}/variants/generate`, {
			price: 1_650_000,
			stock: 2,
		});
		expect(generated.added).toBe(3);
		const variants = generated.product.variants;
		/** @type {Record<string, string>} */
		const photos = {};
		for (const variant of variants) photos[variant.id] = await upload(LIGHTING, light.id, 'image/webp');
		const galleries = await write(LIGHTING, 'PATCH', `/v1/products/${light.id}`, {
			variants: variants.map((/** @type {any} */ variant) => ({
				id: variant.id,
				media: [{ key: photos[variant.id], alt: variant.options.Finish, width: 800, height: 800 }],
			})),
		});
		expect(galleries.variants.every((/** @type {any} */ variant) => variant.media[0].type === 'image/webp')).toBe(true);
		await write(LIGHTING, 'POST', '/v1/landings', {
			categoryId: lights.id,
			brandId: brand.id,
			h1: 'Lumen pendant lights',
			indexable: 'auto',
		});
		Object.assign(ids, { light, lights });

		const card = (await serverCall(LIGHTING, 'GET', '/v1/shop/products?brand=lumen')).json.items[0];
		expect(card).toMatchObject({
			url: 'https://lighting.example.com/pendant-lights/lumen-300',
			price: 1_500_000,
			priceMax: 1_650_000,
		});
		expect(card.cardImages.map((/** @type {any} */ image) => image.alt)).toEqual(['White', 'Bronze', 'White', 'Bronze']);
		const page = (await serverCall(LIGHTING, 'GET', '/v1/shop/products/LUMEN-300')).json;
		expect(page.variants).toHaveLength(4);
		expect(page.variants.every((/** @type {any} */ variant) => variant.media.length === 1)).toBe(true);
	});

	it('writes a phones catalog: an item type, grades per category with their own conditions, unit numbers and warranty', async () => {
		await configure(DEVICES, {
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
			'landing_pages.gradeUrl': '/grades/{key}',
		});
		// the IMEI is this shop's own unit field: 15 digits with a Luhn check digit, two per dual-SIM phone
		const imei = await write(DEVICES, 'POST', '/v1/attributes', {
			name: 'IMEI',
			on: 'unit',
			multiple: true,
			required: true,
			format: { chars: 'digits', minLength: 15, maxLength: 15, checkDigit: 'luhn', ignoreSpaces: true },
			show: { shopper: true, invoice: true, packingSlip: true },
		});
		expect(imei).toMatchObject({ on: 'unit', maxValues: 2, format: { checkDigit: 'luhn' } });
		// its used phones: options, grades, a package, own warranty days and IMEIs typed at packing, needed before dispatch
		await configure(DEVICES, {
			'list.item_types': [
				{
					key: 'used_phone',
					name: 'Used phone',
					kind: 'physical',
					elements: {
						variants: true,
						grades: true,
						parcel: true,
						warranty: true,
						units: { fieldIds: [imei.id], capture: 'packing', requiredBefore: 'shipped' },
					},
				},
			],
		});
		const phones = await write(DEVICES, 'POST', '/v1/categories', { name: 'Phones', slug: 'phones', typeKey: 'used_phone' });
		const brand = await write(DEVICES, 'POST', '/v1/brands', { name: 'Pixel', slug: 'pixel' });
		const phone = await write(DEVICES, 'POST', '/v1/products', {
			name: 'Pixel 8 Pro',
			slug: 'pixel-8-pro',
			status: 'active',
			categoryIds: [phones.id],
			brandId: brand.id,
			options: [{ name: 'Storage', values: ['128 GB'] }],
			variants: [
				{ options: { Storage: '128 GB' }, price: 15_000_000, stock: 2, grade: 'a-plus' },
				{ options: { Storage: '128 GB' }, price: 12_000_000, stock: 3, grade: 'b', warrantyDays: 60 },
			],
		});
		await write(DEVICES, 'POST', '/v1/landings', {
			brandId: brand.id,
			facet: { field: 'grade', value: 'a-plus' },
			h1: 'A+ Pixel phones',
			indexable: 'yes',
		});
		Object.assign(ids, { phone, phones });

		expect(phone).toMatchObject({ typeKey: null, type: { key: 'used_phone', kind: 'physical' } });
		const page = (await serverCall(DEVICES, 'GET', '/v1/shop/products/pixel-8-pro')).json;
		expect(page.url).toBe('https://devices.example.com/phones/pixel-8-pro');
		expect(page.type).toEqual({ key: 'used_phone', kind: 'physical' });
		expect(page.variants.map((/** @type {any} */ v) => [v.grade.key, v.grade.condition, v.warrantyDays, v.stockLeft])).toEqual([
			['a-plus', 'refurbished', 90, 2],
			['b', 'used', 60, 3],
		]);
		const graded = (await serverCall(DEVICES, 'GET', '/v1/shop/products?grade=a-plus,b&count=1')).json;
		expect(graded.total).toBe(1);
		expect(graded.facets.grades.map((/** @type {any} */ g) => g.key)).toEqual(['a-plus', 'b']);
	});

	it('answers robots and JSON-LD that match the fixtures', async () => {
		const dress = (await serverCall(APPAREL, 'GET', '/v1/seo/products/embroidered-dress')).json;
		expect(dress).toMatchObject({
			canonical: 'https://apparel.example.com/dresses/embroidered-dress',
			robots: 'index, follow',
		});
		const group = nodeOf(dress.jsonLd, 'ProductGroup');
		expect(group.hasVariant.map((/** @type {any} */ v) => v.offers.availability)).toEqual([
			'https://schema.org/InStock',
			'https://schema.org/OutOfStock',
		]);
		// the questions are the page's to show; FAQ markup only with the seo setting faqMarkup (Google shows no FAQ results)
		expect(nodeOf(dress.jsonLd, 'FAQPage')).toBeUndefined();
		const shown = (await serverCall(APPAREL, 'GET', '/v1/shop/products/embroidered-dress')).json;
		expect(shown.faqs[0].question).toBe('Lined?');
		const phone = (await serverCall(DEVICES, 'GET', '/v1/seo/products/pixel-8-pro')).json;
		expect(nodeOf(phone.jsonLd, 'ProductGroup').hasVariant.map((/** @type {any} */ v) => v.offers.itemCondition)).toEqual([
			'https://schema.org/RefurbishedCondition',
			'https://schema.org/UsedCondition',
		]);
		const landing = (await serverCall(APPAREL, 'GET', '/v1/seo/listing?category=dresses&brand=maison')).json;
		expect(landing).toMatchObject({
			h1: 'Maison dresses',
			robots: 'index, follow',
			canonical: 'https://apparel.example.com/dresses?brand=maison',
		});
		expect(nodeOf(landing.jsonLd, 'CollectionPage').name).toBe('Maison dresses');
		const filtered = (await serverCall(APPAREL, 'GET', '/v1/seo/listing?category=dresses&attr.color=red')).json;
		expect(filtered.robots).toBe('noindex, follow');
		const category = (await serverCall(APPAREL, 'GET', '/v1/seo/listing?category=dresses')).json;
		expect(category).toMatchObject({
			robots: 'index, follow',
			faqs: [{ question: 'Do they run small?', answer: 'Order one size up.' }],
		});
		// a product marked noindex says so and leaves the sitemap
		await write(LIGHTING, 'PATCH', `/v1/products/${ids.light.id}`, { seo: { noindex: true } });
		expect((await serverCall(LIGHTING, 'GET', '/v1/seo/products/lumen-300')).json.robots).toBe('noindex, follow');
	});

	it('serves sitemaps of what the shops list, with /{category}/{slug} product links', async () => {
		const apparel = (await serverCall(APPAREL, 'GET', '/v1/seo/sitemap.xml')).json;
		expect(apparel).toContain('<loc>https://apparel.example.com/dresses/embroidered-dress</loc>');
		expect(apparel).toContain('<loc>https://apparel.example.com/dresses?brand=maison</loc>');
		expect(apparel).toContain('<loc>https://apparel.example.com/women</loc>');
		const lighting = (await serverCall(LIGHTING, 'GET', '/v1/seo/sitemap.xml')).json;
		expect(lighting).not.toContain('lumen-300');
		await write(LIGHTING, 'PATCH', `/v1/products/${ids.light.id}`, { seo: { noindex: false } });
		const listed = (await serverCall(LIGHTING, 'GET', '/v1/seo/sitemap.xml')).json;
		expect(listed).toContain('<loc>https://lighting.example.com/pendant-lights/lumen-300</loc>');
		expect((listed.match(/<image:image>/g) ?? []).length).toBe(4);
		const devices = (await serverCall(DEVICES, 'GET', '/v1/seo/sitemap.xml')).json;
		expect(devices).toContain('<loc>https://devices.example.com/phones/pixel-8-pro</loc>');
		expect(devices).toContain('<loc>https://devices.example.com/?brand=pixel&amp;grade=a-plus</loc>');
		expect(devices).toContain('<loc>https://devices.example.com/grades/a-plus</loc>');
		const grade = (await serverCall(DEVICES, 'GET', '/v1/seo/grades/a-plus')).json;
		expect(grade).toMatchObject({ canonical: 'https://devices.example.com/grades/a-plus', robots: 'index, follow' });
		// a renamed product keeps its old link working through `moved` (the store answers 308)
		await write(APPAREL, 'PATCH', `/v1/products/${ids.dress.id}`, { slug: 'hand-embroidered-dress' });
		const moved = await serverCall(APPAREL, 'GET', '/v1/shop/products/embroidered-dress');
		expect(moved.json).toEqual({
			moved: {
				kind: 'product',
				slug: 'hand-embroidered-dress',
				url: 'https://apparel.example.com/dresses/hand-embroidered-dress',
			},
		});
	});

	it('falls back to the basic search where Atlas Search is not available', async () => {
		await configure(DEVICES, { 'catalog.search': 'atlas' });
		const found = await serverCall(DEVICES, 'GET', '/v1/shop/products?q=pixel');
		expect(found.status).toBe(200);
		expect(found.json.items.map((/** @type {any} */ item) => item.name)).toEqual(['Pixel 8 Pro']);
		const cookie = await sys.adminSession(await sys.owner(), stores[DEVICES]?.websiteId ?? '');
		const state = await sys.dashboard(cookie, 'GET', `/v1/dashboard/websites/${stores[DEVICES]?.websiteId}/search-index`);
		expect(state.status).toBe(200);
		expect(state.json).toMatchObject({ search: 'atlas', state: { missing: true } });
	});
});
