// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	ALL,
	BRANDS,
	CATEGORIES,
	CHARTS,
	detailOf,
	dialogOf,
	menu,
	pick,
	rowsOf,
	start,
	submitDialog,
} from './ui-admin-catalog-data.js';
import {
	answer,
	buttonIn,
	change,
	click,
	fieldIn,
	openTab,
	panelOf,
	problem,
	resetPage,
	textOf,
	type,
} from './ui-admin-helpers.js';

beforeEach(resetPage);
afterEach(resetPage);

/** The query of the last call of a route. @param {any} server @param {string} key */
const lastQuery = (server, key) => Object.fromEntries(server.last(key)?.url.searchParams ?? []);

describe('catalog admin: fresh details and links between sections', () => {
	it('reads a category, brand, size chart and landing page again when it opens', async () => {
		const landing = {
			id: 'lnd_1',
			categoryId: 'cat_b',
			brandId: null,
			grade: null,
			h1: 'Phones',
			title: '',
			description: '',
			intro: '',
			faqs: [],
			indexable: 'auto',
			url: 'https://shop.example/phones',
			inStock: 1,
			indexed: false,
		};
		const { root, server } = await start(ALL, {
			'GET /v1/admin/categories/cat_a': () => answer(200, { ...CATEGORIES[1], name: 'Audio gear' }),
			'GET /v1/admin/categories/cat_b': () => problem(403, 'forbidden'),
			'GET /v1/admin/brands/brd_1': () => answer(200, { ...BRANDS[0], description: 'Fresh makers' }),
			'GET /v1/admin/size-charts/szc_1': () => answer(200, { ...CHARTS[0], uses: { products: 9, brands: 0, categories: 0 } }),
			'GET /v1/admin/landings': () => answer(200, { items: [landing] }),
			'GET /v1/admin/landings/lnd_1': () => answer(200, { ...landing, inStock: 7, indexed: true }),
		});
		const categories = await openTab(root, 'categories');
		expect(server.last('GET /v1/admin/categories/cat_a')).toBeTruthy();
		expect(textOf(detailOf(categories))).toContain('Audio gear');
		// the row follows the fresh record, its tree place kept
		expect(rowsOf(categories)).toEqual(['Audio gear', 'Phones', 'Android', 'Lost']);
		// a refused read shows the list's record
		await pick(categories, 'Phones');
		expect(textOf(detailOf(categories))).toContain('Great phones');
		const brands = await openTab(root, 'brands');
		expect(textOf(detailOf(brands))).toContain('Fresh makers');
		const charts = await openTab(root, 'charts');
		expect(textOf(detailOf(charts))).toContain('9 products · 0 brands · 0 categories');
		const landings = await openTab(root, 'landings');
		expect(textOf(detailOf(landings))).toContain('Products in stock7');
		expect(textOf(landings)).toContain('7 in stock');
		expect(detailOf(landings).querySelector('.badge')?.textContent).toBe('Indexed');
	});

	it("opens a product's serial numbers from its detail, filtered by product and variant", async () => {
		const { root, server } = await start(ALL, {
			'GET /v1/admin/serials': () =>
				answer(200, {
					items: [
						{ id: 'ser_1', productId: 'prd_1', variantId: 'var_1', serial: 'SN-1', status: 'in_stock', orderId: null },
					],
					nextCursor: null,
					hasMore: false,
				}),
			'POST /v1/admin/serials': () => answer(201, { items: [{ id: 'ser_2' }] }),
		});
		await menu(detailOf(panelOf(root, 'products')), 'Serial numbers of this product');
		const serials = panelOf(root, 'serials');
		expect(serials.hasAttribute('hidden')).toBe(false);
		expect(root.querySelector('[data-section="serials"]')?.getAttribute('aria-current')).toBe('true');
		expect(textOf(serials)).toContain('Product Phone');
		expect(lastQuery(server, 'GET /v1/admin/serials')).toEqual({ productId: 'prd_1', limit: '50' });
		const variant = fieldIn(serials, 'Variant');
		expect([...variant.options].map((/** @type {any} */ o) => o.textContent)).toEqual(['All variants', 'Red', 'Blue']);
		await change(variant, 'var_2');
		expect(lastQuery(server, 'GET /v1/admin/serials')).toEqual({ productId: 'prd_1', variantId: 'var_2', limit: '50' });
		// adding serial numbers starts from the filtered product and variant
		await click(buttonIn(serials, 'Add serial numbers'));
		const dialog = dialogOf(root);
		expect(fieldIn(dialog, 'Product').value).toBe('prd_1');
		expect(fieldIn(dialog, 'Variant').value).toBe('var_2');
		type(fieldIn(dialog, 'Serial numbers (one per line)'), 'B1');
		await submitDialog(root);
		expect(server.last('POST /v1/admin/serials')?.body).toEqual({ productId: 'prd_1', variantId: 'var_2', serials: ['B1'] });
		// the chip removes the filter
		await click(
			/** @type {HTMLElement} */ (serials.querySelector('button[aria-label="Show the serial numbers of every product"]')),
		);
		expect(lastQuery(server, 'GET /v1/admin/serials')).toEqual({ limit: '50' });
		expect(textOf(serials)).not.toContain('Product Phone');
		expect(() => fieldIn(serials, 'Variant')).toThrow();
		// once the section is built, opening another product's serials filters it again
		await openTab(root, 'products');
		await menu(detailOf(panelOf(root, 'products')), 'Serial numbers of this product');
		expect(lastQuery(server, 'GET /v1/admin/serials')).toEqual({ productId: 'prd_1', limit: '50' });
		await click(buttonIn(serials, 'Add serial numbers'));
		expect(fieldIn(dialogOf(root), 'Variant').value).toBe('var_1');
		// without grades and serials there is no such entry
		resetPage();
		const plain = await start(['catalog']);
		const opener = /** @type {HTMLElement} */ (detailOf(panelOf(plain.root, 'products')).querySelector('.more > button'));
		opener.click();
		expect(textOf(detailOf(panelOf(plain.root, 'products')))).not.toContain('Serial numbers of this product');
	});
});
