/**
 * Catalog SEO of PLAN 0.8.10 E10 and E14–E17 through the API: grades with their own conditions in structured data and
 * feeds; Atlas Search with the basic search answering when the index is missing (and Overview's state); landing pages,
 * listing heads and glossary pages; SEO fields, FAQ, shipping, return policy and review nodes, default description and
 * image, llms-full.txt and IndexNow on save; feed options.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AI, ALL, GROWTH, ORIGIN, readyShop } from './helpers.js';

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
/** @param {string} jsonLd @param {string} type */
const node = (jsonLd, type) => JSON.parse(jsonLd)['@graph'].find((/** @type {any} */ entry) => entry['@type'] === type);

beforeAll(async () => {
	shop = await readyShop({ features: ALL.filter((feature) => feature !== 'multi_location'), business: { country: 'US' } });
	await shop.list('grades', [
		{
			key: 'mint',
			label: 'Mint',
			condition: 'refurbished',
			video: 'dQw4w9WgXcQ',
			seo: { body: 'Like new.', title: 'Mint grade' },
		},
		{ key: 'fair', label: 'Fair', description: 'Marks', categoryIds: [] },
		{ key: 'old', label: 'Old', active: false },
	]);
	ids.phones = await api('POST', '/v1/categories', { name: 'Phones', faqs: [{ question: 'Unlocked?', answer: 'Yes.' }] });
	ids.acme = await api('POST', '/v1/brands', { name: 'Acme', seo: { description: 'Acme phones.' } });
	ids.battery = await api('POST', '/v1/attributes', { name: 'Battery', seo: { description: 'How long it lasts.' } });
	ids.phone = await api('POST', '/v1/products', {
		name: 'Acme One',
		status: 'active',
		categoryIds: [ids.phones.id],
		brandId: ids.acme.id,
		faqs: [{ question: 'Charger included?', answer: 'No.' }],
		seo: { title: 'Acme One phone', focusKeyword: 'acme one' },
		options: [{ name: 'Color', values: ['Black', 'White'] }],
		variants: [
			{ sku: 'A1-B', options: { Color: 'Black' }, price: 50000, stock: 5, grade: 'mint' },
			{ sku: 'A1-W', options: { Color: 'White' }, price: 45000, stock: 5, grade: 'fair' },
		],
	});
	ids.other = await api('POST', '/v1/products', {
		name: 'Acme Two',
		status: 'active',
		categoryIds: [ids.phones.id],
		brandId: ids.acme.id,
		price: 30000,
		stock: 0,
	});
});
afterAll(async () => shop.product.close());

describe('E10 grades and E16 structured data', () => {
	it('writes each variant with its grade condition, return policy, reviews and FAQs', async () => {
		await shop.setting('delivery_zones', 'defaultFee', 25000);
		await shop.setting('returns', 'returnDays', 14);
		await shop.setting('seo', 'faqMarkup', true);
		const data = await shop.db();
		await data.collection('reviews').insertOne({
			id: 'rev_1',
			productId: ids.phone.id,
			userId: 'usr_1',
			orderId: 'ord_1',
			name: 'Sam J.',
			rating: 5,
			title: 'Great',
			body: 'Works well.',
			status: 'approved',
			reply: '',
		});
		const answer = await api('GET', `/v1/seo/products/${ids.phone.slug}`);
		expect(answer).toMatchObject({
			robots: 'index, follow',
			focusKeyword: 'acme one',
			canonical: `${ORIGIN}/products/acme-one`,
		});
		expect(answer.title).toMatch(/^Acme One phone \| /);
		const group = node(answer.jsonLd, 'ProductGroup');
		expect(group.hasVariant.map((/** @type {any} */ v) => v.offers.itemCondition)).toEqual([
			'https://schema.org/RefurbishedCondition',
			'https://schema.org/UsedCondition',
		]);
		// the store's return window: the store-wide policy of the home page, by its @id (G5.5)
		expect(group.hasVariant[0].offers).toMatchObject({
			hasMerchantReturnPolicy: { '@id': `${ORIGIN}/#return_policy` },
		});
		// shipping details need the delivery days (G5.4)
		expect(group.hasVariant[0].offers.shippingDetails).toBeUndefined();
		expect(group.review).toEqual([
			{
				'@type': 'Review',
				name: 'Great',
				reviewBody: 'Works well.',
				datePublished: '2026-10-05',
				author: { '@type': 'Person', name: 'Sam J.' },
				reviewRating: { '@type': 'Rating', ratingValue: 5, bestRating: 5, worstRating: 1 },
			},
		]);
		expect(node(answer.jsonLd, 'FAQPage').mainEntity[0]).toMatchObject({ name: 'Charger included?' });
		// a reviewer is named as the reviews widget shows them, never by their full name (EN-2)
		await data
			.collection('reviews')
			.updateOne({ websiteId: shop.websiteId, id: 'rev_1' }, { $set: { name: 'Sam Jordan Lee' } });
		const full = node((await api('GET', `/v1/seo/products/${ids.phone.slug}`)).jsonLd, 'ProductGroup');
		expect(full.review[0].author).toEqual({ '@type': 'Person', name: 'Sam Jordan Lee' });
		await shop.setting('reviews', 'nameFormat', 'first_initial');
		const short = node((await api('GET', `/v1/seo/products/${ids.phone.slug}`)).jsonLd, 'ProductGroup');
		expect(short.review[0].author).toEqual({ '@type': 'Person', name: 'Sam L.' });
		expect(JSON.stringify(short)).not.toContain('Jordan');
		const shown = await shop.visitor('GET', `/v1/shop/products/${ids.phone.id}/reviews`);
		expect(shown.json.items[0].name).toBe('Sam L.');
		await shop.setting('reviews', 'nameFormat', 'full');
		await shop.setting('returns', 'returnDays', 0);
		// no returns: the store-wide policy says so, and the items point to it
		const none = node((await api('GET', `/v1/seo/products/${ids.phone.slug}`)).jsonLd, 'ProductGroup');
		expect(none.hasVariant[0].offers.hasMerchantReturnPolicy).toEqual({ '@id': `${ORIGIN}/#return_policy` });
		expect(node((await api('GET', '/v1/seo/site')).jsonLd, 'OnlineStore').hasMerchantReturnPolicy.returnPolicyCategory).toBe(
			'https://schema.org/MerchantReturnNotPermitted',
		);
		const page = (await shop.visitor('GET', `/v1/shop/products/${ids.phone.slug}`)).json;
		expect(page.variants[0].grade).toMatchObject({
			key: 'mint',
			condition: 'refurbished',
			videoUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
		});
		expect(page.variants[1].grade.videoUrl).toBeNull();
		await shop.setting('feeds', 'items', 'all');
		const google = await shop.api('GET', '/v1/feeds/products.xml');
		expect(google.text).toContain('<g:condition>refurbished</g:condition>');
		expect(google.text).toContain('<g:condition>used</g:condition>');
	});

	it('follows the SEO fields: canonical, social image, robots, defaults', async () => {
		await shop.setting('seo', 'defaultDescription', 'The best phones in town.');
		await shop.setting('seo', 'defaultImage', 'https://cdn.example.com/default.jpg');
		// a product with no description of its own is described by its facts (G6), else by the default description
		const facts = await api('GET', `/v1/seo/products/${ids.other.slug}`);
		expect(facts).toMatchObject({ description: 'Acme Two by Acme — Phones. USD 300.00.' });
		await shop.setting('seo', 'productDescription', '');
		const plain = await api('GET', `/v1/seo/products/${ids.other.slug}`);
		expect(plain).toMatchObject({ description: 'The best phones in town.', image: 'https://cdn.example.com/default.jpg' });
		await api('PATCH', `/v1/products/${ids.other.id}`, {
			seo: { canonicalUrl: '/phones/acme-two', ogImage: 'https://cdn.example.com/two.jpg', noindex: true, nofollow: true },
		});
		expect(await api('GET', `/v1/seo/products/${ids.other.slug}`)).toMatchObject({
			canonical: `${ORIGIN}/phones/acme-two`,
			image: 'https://cdn.example.com/two.jpg',
			robots: 'noindex, nofollow',
		});
		expect((await shop.api('PATCH', `/v1/products/${ids.other.id}`, { seo: { canonicalUrl: 'javascript:x' } })).status).toBe(
			422,
		);
		expect((await shop.api('PATCH', `/v1/products/${ids.other.id}`, { seo: 'x' })).status).toBe(422);
		const sitemap = (await shop.api('GET', '/v1/seo/sitemap.xml')).text;
		expect(sitemap).not.toContain('acme-two');
		const category = await api('GET', `/v1/seo/categories/${ids.phones.slug}`);
		expect(node(category.jsonLd, 'FAQPage').mainEntity[0].name).toBe('Unlocked?');
		expect(node(category.jsonLd, 'ItemList').itemListElement).toHaveLength(2);
	});
});

describe('E14 Atlas Search', () => {
	it('falls back to the basic search where Atlas is not available and says the index is missing', async () => {
		expect(await shop.product.searchState.get(shop.websiteId)).toBeNull();
		await shop.setting('catalog', 'search', 'atlas');
		const found = await shop.visitor('GET', '/v1/shop/products?q=acme&count=1');
		expect(found.status).toBe(200);
		expect(found.json.items.map((/** @type {any} */ item) => item.name).sort()).toEqual(['Acme One', 'Acme Two']);
		expect(found.json.total).toBe(2);
		const state = await shop.product.searchState.get(shop.websiteId);
		expect(state).toMatchObject({ missing: true });
		// the stage passed the tenant guard (K11): the database refused it, not the guard
		expect(state?.message).not.toMatch(/tenant/);
		const chat = await shop.api('GET', '/v1/chat/products?q=one');
		expect(chat.json.items.map((/** @type {any} */ item) => item.name)).toEqual(['Acme One']);
		// a second failure writes nothing new; the listing without words never asks Atlas
		expect((await shop.visitor('GET', '/v1/shop/products')).json.items).toHaveLength(2);
		await shop.setting('catalog', 'search', 'basic');
	});
});

describe('E15 landing pages, listing heads and glossary pages', () => {
	it('keeps landing pages and judges them indexable on read', async () => {
		expect((await shop.api('POST', '/v1/landings', { h1: 'Nothing' })).status).toBe(422);
		expect((await shop.api('POST', '/v1/landings', { categoryId: 'cat_none' })).status).toBe(422);
		expect((await shop.api('POST', '/v1/landings', { brandId: 'brd_none' })).status).toBe(422);
		expect((await shop.api('POST', '/v1/landings', { grade: 'zz' })).status).toBe(422);
		const landing = await api('POST', '/v1/landings', {
			categoryId: ids.phones.id,
			brandId: ids.acme.id,
			h1: 'Acme phones',
			title: 'Buy Acme phones',
			description: 'Every Acme phone.',
			intro: 'Acme makes phones.',
			faqs: [{ question: 'Warranty?', answer: 'One year.' }],
		});
		expect(landing).toMatchObject({
			indexable: 'auto',
			url: `${ORIGIN}/categories/phones?brand=acme`,
			inStock: 1,
			indexed: false,
		});
		expect((await shop.api('POST', '/v1/landings', { categoryId: ids.phones.id, brandId: ids.acme.id })).status).toBe(409);
		await shop.setting('landing_pages', 'landingMinProducts', 1);
		expect((await api('GET', `/v1/landings/${landing.id}`)).indexed).toBe(true);
		const graded = await api('POST', '/v1/landings', { grade: 'mint', indexable: 'yes', h1: 'Mint phones' });
		expect(graded.url).toBe(`${ORIGIN}/?grade=mint`);
		expect((await api('GET', `/v1/landings?brand=${ids.acme.id}`)).items).toHaveLength(1);
		expect((await api('GET', '/v1/landings?q=mint')).items).toHaveLength(1);
		expect((await api('PATCH', `/v1/landings/${graded.id}`, { indexable: 'no' })).indexed).toBe(false);
		expect((await shop.api('PATCH', `/v1/landings/${graded.id}`, { indexable: 'maybe' })).status).toBe(422);
		expect((await shop.api('DELETE', `/v1/categories/${ids.phones.id}`)).status).toBe(409);
		ids.landing = landing;
		ids.graded = graded;
		const ticket = await shop.ticket(['catalog.edit']);
		expect((await shop.admin(ticket, 'GET', '/v1/admin/landings')).json.items).toHaveLength(2);
	});

	it('answers listing heads: index for a category and an indexable landing, noindex for other filters', async () => {
		const category = await api('GET', `/v1/seo/listing?category=${ids.phones.slug}`);
		expect(category).toMatchObject({
			h1: 'Phones',
			robots: 'index, follow',
			canonical: `${ORIGIN}/categories/phones`,
			landing: null,
		});
		expect(category.faqs).toEqual([{ question: 'Unlocked?', answer: 'Yes.' }]);
		expect(node(category.jsonLd, 'ItemList').itemListElement).toHaveLength(2);
		expect((await api('GET', `/v1/seo/listing?category=${ids.phones.slug}&page=2`)).canonical).toBe(
			`${ORIGIN}/categories/phones?page=2`,
		);
		const landing = await api('GET', `/v1/seo/listing?category=${ids.phones.slug}&brand=acme`);
		expect(landing).toMatchObject({
			h1: 'Acme phones',
			description: 'Every Acme phone.',
			intro: 'Acme makes phones.',
			robots: 'index, follow',
			canonical: `${ORIGIN}/categories/phones?brand=acme`,
			landing: { id: ids.landing.id, indexed: true },
		});
		expect(landing.title).toMatch(/^Buy Acme phones/);
		const filtered = await api('GET', `/v1/seo/listing?category=${ids.phones.slug}&brand=acme&inStock=1`);
		expect(filtered).toMatchObject({ robots: 'noindex, follow', landing: null });
		expect((await api('GET', '/v1/seo/listing?grade=mint')).robots).toBe('noindex, follow');
		expect((await api('GET', '/v1/seo/listing?brand=acme')).description).toBe('Acme phones.');
		expect((await shop.api('GET', '/v1/seo/listing?category=nothing')).status).toBe(404);
	});

	it('serves glossary pages and lists them with indexable landings in the sitemap', async () => {
		const unlisted = await api('GET', `/v1/seo/attributes/${ids.battery.slug}`);
		expect(unlisted).toMatchObject({
			name: 'Battery',
			canonical: null,
			robots: 'noindex, follow',
			description: 'How long it lasts.',
		});
		await shop.setting('landing_pages', 'attributeUrl', '/glossary/{slug}');
		await shop.setting('landing_pages', 'gradeUrl', '/grades/{key}');
		const attribute = await api('GET', `/v1/seo/attributes/${ids.battery.slug}`);
		expect(attribute).toMatchObject({ canonical: `${ORIGIN}/glossary/battery`, robots: 'index, follow' });
		expect(node(attribute.jsonLd, 'DefinedTerm').name).toBe('Battery');
		const grade = await api('GET', '/v1/seo/grades/mint');
		expect(grade).toMatchObject({
			label: 'Mint',
			condition: 'refurbished',
			canonical: `${ORIGIN}/grades/mint`,
			body: 'Like new.',
		});
		expect(grade.title).toMatch(/^Mint grade/);
		expect((await shop.api('GET', '/v1/seo/grades/old')).status).toBe(404);
		expect((await shop.api('GET', '/v1/seo/attributes/nothing')).status).toBe(404);
		const sitemap = (await shop.api('GET', '/v1/seo/sitemap.xml')).text;
		expect(sitemap).toContain(`<loc>${ORIGIN}/categories/phones?brand=acme</loc>`);
		expect(sitemap).toContain(`<loc>${ORIGIN}/glossary/battery</loc>`);
		expect(sitemap).toContain(`<loc>${ORIGIN}/grades/mint</loc>`);
		expect(sitemap).not.toContain('grade=mint');
		expect((await shop.api('GET', '/v1/seo/sitemaps/landings')).text).toContain('/glossary/battery');
	});

	it('suggests landing copy with the AI key', async () => {
		await shop.connect('ai', { baseUrl: AI, apiKey: 'sk-test-123456', model: 'm' });
		shop.responders.set(AI, () => ({
			status: 200,
			body: {
				choices: [
					{
						message: {
							content:
								'{"h1":"Acme phones","intro":"Strong phones.\\n\\nGreat value.","faqs":[{"question":"Q?","answer":"A."},{"question":""}]}',
						},
					},
				],
			},
		}));
		const answer = await api('POST', `/v1/landings/${ids.landing.id}/ai-copy`, { fields: ['h1', 'intro', 'faqs'] });
		expect(answer.suggestions).toEqual({ h1: 'Acme phones', intro: 'Strong phones.\n\nGreat value.' });
		expect((await shop.api('POST', `/v1/landings/${ids.landing.id}/ai-copy`, { fields: ['price'] })).status).toBe(422);
		const prompt = JSON.parse(shop.callsTo(AI).at(-1)?.body ?? '{}');
		expect(JSON.stringify(prompt)).toContain('Brand: Acme');
		shop.responders.set(AI, () => ({
			status: 200,
			body: { choices: [{ message: { content: '{"faqs":[{"question":"Q?","answer":"A."}]}' } }] },
		}));
		expect((await api('POST', `/v1/products/${ids.phone.id}/ai-copy`, { fields: ['faqs'] })).suggestions).toEqual({
			faqs: [{ question: 'Q?', answer: 'A.' }],
		});
		expect((await shop.api('DELETE', `/v1/landings/${ids.graded.id}`)).status).toBe(204);
	});
});

describe('E16 llms-full.txt and IndexNow', () => {
	it('lists every product in stock by category with grades and price ranges, while switched on', async () => {
		expect((await shop.api('GET', '/v1/llms-full.txt')).status).toBe(404);
		await shop.setting('llms_txt', 'full', true);
		const text = (await shop.api('GET', '/v1/llms-full.txt')).text;
		expect(text).toContain(`## [Phones](${ORIGIN}/categories/phones)`);
		expect(text).toContain('Grades: Mint, Fair');
		expect(text).toContain(`- [Acme One](${ORIGIN}/products/acme-one): USD 450.00 – USD 500.00`);
		expect(text).not.toContain('Acme Two');
	});

	it('sends saved product and category pages to Growth when asked', async () => {
		await api('PATCH', `/v1/products/${ids.phone.id}`, { summary: 'Updated' });
		await shop.flush();
		expect(shop.callsTo(GROWTH)).toHaveLength(0);
		await shop.setting('seo', 'indexNowOnSave', true);
		await api('PATCH', `/v1/products/${ids.phone.id}`, { summary: 'Again' });
		await api('PATCH', `/v1/categories/${ids.phones.id}`, { description: 'All phones' });
		await shop.flush();
		expect(shop.callsTo(GROWTH)).toHaveLength(0);
		await shop.paste('growth');
		await api('PATCH', `/v1/products/${ids.phone.id}`, { summary: 'Once more' });
		await api('PATCH', `/v1/categories/${ids.phones.id}`, { description: 'Every phone' });
		await shop.flush();
		const sent = shop.callsTo(GROWTH).map((call) => ({ path: call.path, body: JSON.parse(call.body) }));
		expect(sent).toEqual([
			{ path: '/v1/indexnow', body: { urls: [`${ORIGIN}/products/acme-one`] } },
			{ path: '/v1/indexnow', body: { urls: [`${ORIGIN}/categories/phones`] } },
		]);
	});
});

describe('E17 feed options', () => {
	it('sends imported feed ids, the Google category, grade labels, shipping and whole units', async () => {
		const data = await shop.db();
		await data.collection('products').insertOne({
			...(await data
				.collection('products')
				.findOne({ websiteId: shop.websiteId, id: ids.phone.id }, { projection: { _id: 0, websiteId: 0, merchantId: 0 } })),
			id: 'prd_0123456789abcdef01234567',
			slug: 'imported',
			name: 'Imported phone',
			feedGroupId: '0123456789abcdef01234567',
			variants: [
				{
					id: 'var_76543210fedcba9876543210',
					feedId: '0123456789abcdef01234567_76543210fedcba9876543210',
					sku: 'IMP',
					options: {},
					price: 12345,
					compareAtPrice: null,
					cost: null,
					stock: 1,
					locations: {},
					grade: 'mint',
					active: true,
					attributes: {},
					media: [],
					soldOut: false,
					warrantyDays: null,
				},
			],
			options: [],
			media: [{ key: 'ecommerce/products/x/1.jpg', type: 'image/jpeg', size: 1, alt: '' }],
		});
		await shop.setting('feeds', 'items', 'all');
		await shop.setting('feeds', 'googleCategory', '267');
		await shop.setting('feeds', 'gradeLabel', true);
		const business = shop.responders.get(`${ORIGIN}/.well-known/business.json`);
		shop.responders.set(`${ORIGIN}/.well-known/business.json`, () => ({
			status: 200,
			body: { version: 1, name: 'Shop', country: 'GB', timeZone: 'UTC' },
		}));
		await shop.dashboard(await shop.adminSession(), 'POST', `/v1/dashboard/websites/${shop.websiteId}/business/refresh`);
		const format = await shop.api('PUT', '/v1/format', { wholeUnits: true });
		expect(format.status).toBe(200);
		const google = (await shop.api('GET', '/v1/feeds/products.xml')).text;
		expect(google).toContain('<g:id>0123456789abcdef01234567_76543210fedcba9876543210</g:id>');
		// the imported group id reaches the feed (it was not read with the feed's fields)
		expect(google).toContain('<g:item_group_id>0123456789abcdef01234567</g:item_group_id>');
		expect(google).toContain('<g:google_product_category>267</g:google_product_category>');
		expect(google).toContain('<g:custom_label_0>Mint</g:custom_label_0>');
		expect(google).toContain('<g:price>123 USD</g:price>');
		expect(google).toContain('<g:shipping><g:country>GB</g:country><g:price>250 USD</g:price></g:shipping>');
		const csv = (await shop.api('GET', '/v1/feeds/products.csv')).text;
		expect(csv).toContain(',267,,Mint,,,,\r\n');
		if (business) shop.responders.set(`${ORIGIN}/.well-known/business.json`, business);
	});
});
