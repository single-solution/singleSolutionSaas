/**
 * Storefront reads of the re-audit (SF-1, SF-3, SF-6, SF-7): policies with every placeholder, headings and contact
 * links; the default size chart; cards with their variants; Atlas Search that finds nothing because its index is
 * missing or still building answers with the basic search.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanHtml, htmlToText } from '../core/catalog-content.js';
import { fillPolicies } from '../core/policies.js';
import { resolveSizeChart } from '../core/size-charts.js';
import { createCatalogSearch } from '../server/catalog-search.js';
import { ALL, readyShop } from './helpers.js';

describe('rich text, policies and size charts (core)', () => {
	it('keeps h2 headings and mailto: and tel: links, never other schemes (SF-1)', () => {
		expect(
			cleanHtml(
				'<h2>Who we are</h2><p><a href="mailto:help@shop.example.com" target="_blank">Mail</a> <a href="tel:+92 300 1234567">Call</a> <a href="javascript:alert(1)">x</a> <a href="tel:abc">y</a></p>',
			),
		).toBe(
			'<h2>Who we are</h2><p><a href="mailto:help@shop.example.com">Mail</a> <a href="tel:+92 300 1234567">Call</a> <a>x</a> <a>y</a></p>',
		);
		expect(cleanHtml('<h2> </h2>')).toBe('');
		expect(htmlToText('<h2>Title</h2>Text')).toBe('Title\nText');
	});

	it('fills every placeholder, with one or two braces, and leaves other text in braces (SF-1)', () => {
		const values = {
			returnDays: 14,
			warrantyDays: 180,
			business: 'A & B',
			email: 'help@shop.example.com',
			phone: '+92 300 1234567',
			address: '1 Main St',
			deliveryFee: 'Rs 250',
			freeDeliveryOver: 'Rs 5,000',
		};
		const text = fillPolicies(
			{
				policyFormat: 'text',
				policyReturns:
					'{{returnDays}} days, {warrantyMonths} months at {business}. {email} {phone} {address} {deliveryFee} {freeDeliveryOver} {other} {{other}}',
			},
			values,
		);
		expect(text.policies.returns).toBe(
			'14 days, 6 months at A & B. help@shop.example.com +92 300 1234567 1 Main St Rs 250 Rs 5,000 {other} {{other}}',
		);
		const html = fillPolicies({ policyFormat: 'html', policyTerms: '<h2>{{business}}</h2><p>{phone}</p>' }, values);
		expect(html.policies.terms).toBe('<h2>A &amp; B</h2><p>+92 300 1234567</p>');
		expect(fillPolicies({ policyPrivacy: '{email}' }, { returnDays: 0, warrantyDays: 0, business: 'S' }).policies).toEqual({});
	});

	it('shows the default chart when nothing else names one (SF-3)', () => {
		const chart = /** @type {any} */ ({ id: 'szc_d', name: 'Default' });
		const charts = new Map([['szc_d', chart]]);
		const categories = new Map([['cat_1', { path: [], sizeChartId: null }]]);
		expect(resolveSizeChart({ categoryIds: ['cat_1'] }, null, categories, charts)).toBeNull();
		expect(resolveSizeChart({ categoryIds: ['cat_1'] }, null, categories, charts, 'szc_d')).toBe(chart);
		expect(resolveSizeChart({ categoryIds: [] }, null, categories, charts, 'szc_d')).toBe(chart);
		expect(resolveSizeChart({ categoryIds: [], hideSizeGuide: true }, null, categories, charts, 'szc_d')).toBeNull();
		expect(resolveSizeChart({ categoryIds: [] }, null, categories, charts, 'szc_gone')).toBeNull();
	});
});

describe('Atlas Search that finds nothing (SF-7)', () => {
	/**
	 * A search on a scripted database: the search answers `found`, the index probe `probe`, and the website has
	 * `active` active products.
	 * @param {{ found: any[], probe: any[], active: boolean }} script
	 */
	const harness = ({ found, probe, active }) => {
		/** @type {any[][]} */
		const states = [];
		/** @type {any[][]} */
		const pipelines = [];
		const product = /** @type {any} */ ({ searchState: { set: async (/** @type {any[]} */ ...args) => states.push(args) } });
		const empty = { find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }) };
		const data = /** @type {any} */ ({
			websiteId: 'web_1',
			collection: (/** @type {string} */ name) =>
				name === 'products'
					? {
							aggregate: (/** @type {any[]} */ pipeline) => {
								pipelines.push(pipeline);
								return { toArray: async () => (pipelines.length === 1 ? [{ items: found }] : probe) };
							},
							findOne: async () => (active ? { id: 'prd_1' } : null),
						}
					: empty,
		});
		const site = /** @type {any} */ ({ websiteId: 'web_1', values: async () => ({ searchIndex: 'idx' }), ctx: {} });
		const search = createCatalogSearch(product);
		/** @param {number} [skip] */
		const run = (skip = 0) => search.run(site, data, 'fan', { match: { websiteId: 'web_1' }, sort: null, skip, limit: 10 });
		return { run, states, pipelines };
	};

	it('answers with the basic search and says the index is missing when the index finds no active product', async () => {
		const { run, states, pipelines } = harness({ found: [], probe: [], active: true });
		expect(await run()).toEqual({ ok: false });
		expect(states).toEqual([['web_1', true, 'the index found no product (missing, misnamed or still building)']]);
		expect(pipelines[1]?.[0]).toEqual({
			$search: {
				index: 'idx',
				compound: {
					filter: [{ equals: { path: 'websiteId', value: 'web_1' } }, { equals: { path: 'status', value: 'active' } }],
				},
			},
		});
	});

	it('keeps a real "nothing found", and never asks again past the first page or when results came', async () => {
		const ready = harness({ found: [], probe: [{ id: 'prd_1' }], active: true });
		expect(await ready.run()).toMatchObject({ ok: true, items: [] });
		expect(ready.states).toEqual([['web_1', false]]);
		const none = harness({ found: [], probe: [], active: false });
		expect(await none.run()).toMatchObject({ ok: true, items: [] });
		const later = harness({ found: [], probe: [], active: true });
		expect(await later.run(20)).toMatchObject({ ok: true });
		expect(later.pipelines).toHaveLength(1);
		const hits = harness({ found: [{ id: 'prd_1' }], probe: [], active: true });
		expect(await hits.run()).toMatchObject({ ok: true, items: [{ id: 'prd_1' }] });
		expect(hits.pipelines).toHaveLength(1);
	});
});

describe('storefront reads through the API', () => {
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
		ids.brand = await api('POST', '/v1/brands', { name: 'Maison' });
		ids.color = await api('POST', '/v1/attributes', {
			name: 'Color',
			type: 'choice',
			choices: ['red', 'gold'],
			variant: true,
		});
		ids.chart = await api('POST', '/v1/size-charts', {
			name: 'Standard',
			unit: 'in',
			columns: [{ key: 'bust', label: 'Bust' }],
			rows: [{ size: 'S', values: { bust: '34' } }],
		});
		ids.suit = await api('POST', '/v1/products', {
			name: 'Lawn Suit',
			status: 'active',
			brandId: ids.brand.id,
			options: [{ name: 'Size', values: ['S', 'M'] }],
			variants: [
				{ sku: 'S', options: { Size: 'S' }, price: 9000, compareAtPrice: 10_000, stock: 2 },
				{ sku: 'M', options: { Size: 'M' }, price: 12_000, stock: 0 },
			],
		});
		ids.hidden = await api('POST', '/v1/products', {
			name: 'Plain Scarf',
			status: 'active',
			hideSizeGuide: true,
			price: 500,
			stock: 1,
		});
	});
	afterAll(async () => shop.product.close());

	it('fills policies with business contacts and delivery amounts, as HTML with headings and contact links (SF-1)', async () => {
		await shop.setting('returns', 'returnDays', 14);
		await shop.setting('delivery_zones', 'defaultFee', 25_000);
		await shop.setting('delivery_zones', 'defaultFreeOver', 1_000_000);
		await shop.setting('checkout', 'policyFormat', 'html');
		await shop.setting(
			'checkout',
			'policyReturns',
			'<h2>Returns</h2><p>{{returnDays}} days. Delivery {deliveryFee}, free from {freeDeliveryOver}. <a href="mailto:{email}">Write</a></p>',
		);
		const answer = await api('GET', '/v1/policies');
		expect(answer.format).toBe('html');
		expect(answer.returns).toBe(
			'<h2>Returns</h2><p>14 days. Delivery USD 250.00, free from USD 10,000.00. <a href="mailto:hello@shop.example.com">Write</a></p>',
		);
		await shop.setting('delivery_zones', 'defaultFreeOver', 0);
		expect((await api('GET', '/v1/policies')).returns).toContain('free from .');
	});

	it('shows the default size chart, never on a product that hides its guide, and keeps it from deletion (SF-3)', async () => {
		expect((await shop.visitor('GET', `/v1/shop/products/${ids.suit.slug}`)).json.sizeChart).toBeNull();
		await shop.setting('size_charts', 'defaultChartId', ids.chart.id);
		expect((await shop.visitor('GET', `/v1/shop/products/${ids.suit.slug}`)).json.sizeChart).toMatchObject({
			id: ids.chart.id,
			name: 'Standard',
		});
		expect((await shop.visitor('GET', `/v1/shop/products/${ids.hidden.slug}`)).json.sizeChart).toBeNull();
		expect((await shop.api('DELETE', `/v1/size-charts/${ids.chart.id}`)).status).toBe(409);
		await shop.setting('size_charts', 'defaultChartId', '');
		expect((await shop.api('DELETE', `/v1/size-charts/${ids.chart.id}`)).status).toBe(204);
	});

	it('gives cards their variants when asked, and the brand slug (SF-6)', async () => {
		const plain = (await shop.visitor('GET', '/v1/shop/products?q=lawn')).json.items[0];
		expect(plain.variants).toBeUndefined();
		expect(plain.brand).toEqual({ id: ids.brand.id, name: 'Maison', slug: 'maison' });
		const card = (await shop.visitor('GET', '/v1/shop/products?q=lawn&variants=1')).json.items[0];
		expect(card.variants).toEqual([
			expect.objectContaining({ options: { Size: 'S' }, price: 9000, compareAtPrice: 10_000, inStock: true, grade: null }),
			expect.objectContaining({ options: { Size: 'M' }, price: 12_000, compareAtPrice: null, inStock: false }),
		]);
		expect(card.variants[0].url).toBe(card.url);
		expect(card.variants[0]).not.toHaveProperty('stock');
	});
});
