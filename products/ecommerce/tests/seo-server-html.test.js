/**
 * The server HTML core for merchants who use the widgets (SEO audit G3, phase S8): with `?html=1` the product and listing
 * answers carry plain, cleaned HTML (no script, no event attribute) that the website prints into the widget's place, so
 * search engines read the name as the page's h1, the price, the availability, the breadcrumb, the description, specs and
 * questions — and on a listing the product links with their prices and the page links — before any script runs; the
 * widget then takes the place over.
 */
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSnippets } from '../core/snippets.js';
import { COLLECTIONS } from '../core/model.js';
import { BASE, ORIGIN, readyShop, storedAttribute, storedCategory } from './helpers.js';

/** @type {Awaited<ReturnType<typeof readyShop>>} */
let shop;

beforeAll(async () => {
	shop = await readyShop({ features: ['catalog', 'checkout'] });
	const data = await shop.db();
	await data.collection(COLLECTIONS.categories).insertOne(storedCategory({ id: 'cat_lamps', slug: 'lamps', name: 'Lamps' }));
	await data
		.collection(COLLECTIONS.attributes)
		.insertOne(storedAttribute({ id: 'att_watts', name: 'Power', slug: 'power', type: 'number', unit: 'W' }));
	await shop.seedProduct({
		slug: 'desk-lamp',
		name: 'Desk Lamp',
		categoryIds: ['cat_lamps'],
		price: 4500,
		specs: { att_watts: 9 },
		descriptionHtml: '<p onclick="steal()">A <strong>bright</strong> lamp.</p><script>alert(1)</script>',
		description: 'A bright lamp.',
		faqs: [{ question: 'Bulb included?', answer: 'Yes.' }],
		media: [{ key: 'ecommerce/products/p/lamp.jpg', type: 'image/jpeg', size: 10, alt: 'The lamp', width: 1200, height: 900 }],
		publishedAt: new Date(Date.UTC(2026, 9, 3)),
	});
	await shop.seedProduct({
		slug: 'floor-lamp',
		name: 'Floor <Lamp> & "co"',
		categoryIds: ['cat_lamps'],
		price: 9900,
		stock: 0,
		publishedAt: new Date(Date.UTC(2026, 9, 2)),
	});
	await shop.seedProduct({
		slug: 'wall-lamp',
		name: 'Wall Lamp',
		categoryIds: ['cat_lamps'],
		price: 2500,
		publishedAt: new Date(Date.UTC(2026, 9, 1)),
	});
	await shop.setting('catalog', 'pageSize', 2);
});
afterAll(async () => shop.product.close());

/** @param {string} path */
const read = async (path) => {
	const answer = await shop.api('GET', path);
	if (answer.status !== 200) throw new Error(`${path}: ${answer.status} ${answer.text}`);
	return answer.json;
};

/**
 * The page a snippet serves: the answer's html in the widget's place, read as a browser reads it before any script.
 * @param {string} html @param {string} widget
 */
const served = (html, widget) =>
	new JSDOM(`<!doctype html><html><body><div data-ss-ecommerce="${widget}">${html}</div></body></html>`).window.document;

describe('the product page core', () => {
	it('gives the name as h1, the price, availability, breadcrumb links, photo, description, specs and questions', async () => {
		const head = await read('/v1/seo/products/desk-lamp?html=1');
		const page = served(head.html, 'product_page');
		expect(page.querySelectorAll('h1')).toHaveLength(1);
		expect(page.querySelector('h1')?.textContent).toBe('Desk Lamp');
		expect([...page.querySelectorAll('nav a')].map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
			['Shop', `${ORIGIN}/`],
			['Lamps', `${ORIGIN}/categories/lamps`],
		]);
		const text = page.body.textContent ?? '';
		expect(text).toContain('USD 45.00');
		expect(text).toContain('In stock');
		expect(page.querySelector('img')?.outerHTML).toMatch(/alt="The lamp" width="1200" height="900"/);
		expect(page.querySelector('img')?.getAttribute('src')).toMatch(/^https:\/\/shop\.example\.com\/media\//);
		expect(page.querySelector('strong')?.textContent).toBe('bright');
		expect([...page.querySelectorAll('dt')].map((term) => term.textContent)).toEqual(['Power', 'Bulb included?']);
		expect(text).toContain('9 W');
	});

	it('prints nothing that runs: no script, no event attribute, the merchant’s text escaped', async () => {
		const head = await read('/v1/seo/products/desk-lamp?html=1');
		expect(head.html).not.toMatch(/<script|onclick|javascript:/i);
		const odd = await read('/v1/seo/products/floor-lamp?html=1');
		expect(odd.html).toContain('<h1>Floor &lt;Lamp&gt; &amp; &quot;co&quot;</h1>');
		expect(served(odd.html, 'product_page').body.textContent).toContain('Out of stock');
	});

	it('is left out unless asked for', async () => {
		expect((await read('/v1/seo/products/desk-lamp')).html).toBeUndefined();
		expect((await read('/v1/seo/listing?category=lamps')).html).toBeUndefined();
	});
});

describe('the listing grid core', () => {
	it('lists the products of the page as links with their prices, and links the pages', async () => {
		const first = served((await read('/v1/seo/listing?category=lamps&html=1')).html, 'product_grid');
		expect([...first.querySelectorAll('li a')].map((link) => link.getAttribute('href'))).toEqual([
			`${ORIGIN}/products/desk-lamp`,
			`${ORIGIN}/products/floor-lamp`,
		]);
		expect(first.body.textContent).toContain('USD 99.00');
		expect([...first.querySelectorAll('nav a')].map((link) => [link.getAttribute('rel'), link.getAttribute('href')])).toEqual([
			['next', `${ORIGIN}/categories/lamps?page=2`],
		]);
		const second = served((await read('/v1/seo/listing?category=lamps&page=2&html=1')).html, 'product_grid');
		expect([...second.querySelectorAll('li a')].map((link) => link.textContent)).toEqual(['Wall Lamp']);
		expect([...second.querySelectorAll('nav a')].map((link) => [link.getAttribute('rel'), link.getAttribute('href')])).toEqual([
			['prev', `${ORIGIN}/categories/lamps`],
		]);
	});
});

describe('the snippets', () => {
	it('print the core into the widget’s place, before any script runs', () => {
		const snippets = createSnippets({ base: BASE, widgets: [], permissions: [] });
		expect(snippets.productMeta).toContain('/v1/seo/products/${encodeURIComponent(slug)}?html=1');
		expect(snippets.productMeta).toContain(
			'<div data-ss-ecommerce="product_page" data-product={slug} dangerouslySetInnerHTML={{ __html: seo.html }} />',
		);
		expect(snippets.listingPage).toContain("html: '1'");
		expect(snippets.listingPage).toContain('dangerouslySetInnerHTML={{ __html: head.html }}');
	});
});
