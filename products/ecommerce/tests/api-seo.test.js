/**
 * The SEO area's API as schemas/api.json describes it: landing pages through the catalog admin widget's twins (with
 * catalog.edit only), every landing answer with its times, the default social image made absolute, and a listing head
 * of a renamed category answering moved. Every answer is checked against the description by the helper's `call()`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AI, ALL, ORIGIN, readyShop } from './helpers.js';

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
	ids.phones = await api('POST', '/v1/categories', { name: 'Phones' });
	ids.acme = await api('POST', '/v1/brands', { name: 'Acme' });
	ids.phone = await api('POST', '/v1/products', {
		name: 'Acme One',
		status: 'active',
		categoryIds: [ids.phones.id],
		brandId: ids.acme.id,
		price: 50000,
		stock: 4,
	});
});
afterAll(async () => shop.product.close());

describe('landing pages', () => {
	it('answers the same landing page with its times on create, read and change (server token)', async () => {
		const created = await shop.api('POST', '/v1/landings', { categoryId: ids.phones.id, h1: 'Phones' });
		expect(created.status).toBe(201);
		expect(created.json).toMatchObject({
			categoryId: ids.phones.id,
			brandId: null,
			facet: null,
			h1: 'Phones',
			faqs: [],
			indexable: 'auto',
			url: `${ORIGIN}/categories/phones`,
			inStock: 1,
			indexed: false,
		});
		expect(created.json.createdAt).toBe(created.json.updatedAt);
		expect(await api('GET', `/v1/landings/${created.json.id}`)).toEqual(created.json);
		shop.advance(60_000);
		const changed = await api('PATCH', `/v1/landings/${created.json.id}`, { indexable: 'yes' });
		expect(changed).toMatchObject({ indexable: 'yes', indexed: true, createdAt: created.json.createdAt });
		expect(Date.parse(changed.updatedAt)).toBeGreaterThan(Date.parse(created.json.updatedAt));
		expect((await api('GET', '/v1/landings')).items).toEqual([changed]);
		expect((await shop.api('DELETE', `/v1/landings/${created.json.id}`)).status).toBe(204);
	});

	it('creates, reads, changes, suggests copy for and deletes one through the catalog admin widget', async () => {
		const ticket = await shop.ticket(['catalog.edit']);
		const created = await shop.admin(ticket, 'POST', '/v1/admin/landings', {
			categoryId: ids.phones.id,
			brandId: ids.acme.id,
			h1: 'Acme phones',
			faqs: [{ question: 'Warranty?', answer: 'One year.' }],
		});
		expect(created.status).toBe(201);
		const landing = created.json;
		expect(landing).toMatchObject({
			brandId: ids.acme.id,
			faqs: [{ question: 'Warranty?', answer: 'One year.' }],
			url: `${ORIGIN}/categories/phones?brand=acme`,
		});
		expect(
			(await shop.admin(ticket, 'POST', '/v1/admin/landings', { brandId: ids.acme.id, categoryId: ids.phones.id })).status,
		).toBe(409);
		const read = await shop.admin(ticket, 'GET', `/v1/admin/landings/${landing.id}`);
		expect(read.json).toEqual(landing);
		const changed = await shop.admin(ticket, 'PATCH', `/v1/admin/landings/${landing.id}`, {
			title: 'Buy Acme phones',
			faqs: [],
		});
		expect(changed.json).toMatchObject({ id: landing.id, title: 'Buy Acme phones', faqs: [], h1: 'Acme phones' });
		expect(
			(await shop.admin(ticket, 'PATCH', `/v1/admin/landings/${landing.id}`, { categoryId: null, brandId: null })).status,
		).toBe(422);

		await shop.connect('ai', { baseUrl: AI, apiKey: 'sk-test-123456', model: 'm' });
		shop.responders.set(AI, () => ({
			status: 200,
			body: { choices: [{ message: { content: '{"title":"Acme phones for less","description":"Every Acme phone."}' } }] },
		}));
		const suggested = await shop.admin(ticket, 'POST', `/v1/admin/landings/${landing.id}/ai-copy`, {
			fields: ['title', 'description'],
		});
		expect(suggested.json).toEqual({ suggestions: { title: 'Acme phones for less', description: 'Every Acme phone.' } });
		expect((await api('GET', `/v1/landings/${landing.id}`)).title).toBe('Buy Acme phones');

		const reader = await shop.ticket(['orders.read']);
		expect((await shop.admin(reader, 'GET', '/v1/admin/landings')).status).toBe(403);
		expect((await shop.admin(ticket, 'DELETE', `/v1/admin/landings/${landing.id}`)).status).toBe(204);
		expect((await shop.admin(ticket, 'GET', `/v1/admin/landings/${landing.id}`)).status).toBe(404);
	});
});

describe('heads', () => {
	it('takes the share picture of the website’s Brand and look (the Portal) for a page without its own', async () => {
		await shop.setting('seo', 'defaultImage', 'https://cdn.example.com/images/default.jpg');
		expect((await api('GET', `/v1/seo/products/${ids.phone.slug}`)).image).toBe('https://cdn.example.com/images/default.jpg');
		expect((await api('GET', `/v1/seo/categories/${ids.phones.slug}`)).image).toBe(
			'https://cdn.example.com/images/default.jpg',
		);
		await shop.setting('seo', 'defaultImage', '');
		expect((await api('GET', `/v1/seo/products/${ids.phone.slug}`)).image).toBeNull();
	});

	it('answers moved for the listing of a renamed category', async () => {
		await api('PATCH', `/v1/categories/${ids.phones.id}`, { slug: 'mobiles' });
		expect(await api('GET', '/v1/seo/listing?category=phones&page=2')).toEqual({
			moved: { kind: 'category', slug: 'mobiles', url: `${ORIGIN}/categories/mobiles` },
		});
		expect(await api('GET', '/v1/seo/listing?category=mobiles')).toMatchObject({
			h1: 'Phones',
			canonical: `${ORIGIN}/categories/mobiles`,
			robots: 'index, follow',
			landing: null,
		});
	});
});
