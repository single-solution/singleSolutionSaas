// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mountCatalogAdmin } from '../ui/catalog-admin.js';
import {
	ALL,
	ROW,
	detailOf,
	dialogOf,
	hasDialog,
	lists,
	pick,
	product,
	rowsOf,
	start,
	submitDialog,
} from './ui-admin-catalog-data.js';
import {
	answer,
	buttonIn,
	change,
	checkIn,
	click,
	fieldIn,
	invalid,
	mountWith,
	panelOf,
	problem,
	resetPage,
	SERVER_ENGLISH,
	statuses,
	submit,
	textOf,
	TEXTS,
	tick,
	type,
} from './ui-admin-helpers.js';

beforeEach(resetPage);
afterEach(resetPage);

/** The query of the last product list call. @param {any} server */
const lastQuery = (server) => Object.fromEntries(server.last('GET /v1/admin/products')?.url.searchParams ?? []);

describe('catalog admin: the product list', () => {
	it('lists products with status chips, the total, Load more and the signed-out line', async () => {
		const { host, root, server, tickets } = await start();
		expect(host.getAttribute('data-ss-mounted')).toBe('catalog-admin');
		const panel = panelOf(root, 'products');
		expect(rowsOf(panel)).toEqual(['Phone']);
		expect(textOf(panel)).toContain('USD 1,250.00');
		// the opened product refreshes its row (3 units of its active variants)
		expect(textOf(panel)).toContain('3 in stock · Featured · P-1, P-2');
		expect(textOf(panel)).toContain('2 products');
		// the chips show the counts by status (without the status filter)
		const chips = [...panel.querySelectorAll('.chipbar button')].map((node) => node.textContent);
		expect(chips).toEqual(['All2', 'Active1', 'Draft1', 'Archived0']);
		// the first product opens by itself in the detail pane
		expect(textOf(detailOf(panel))).toContain('Phone');
		expect(panel.querySelector('li.item')?.getAttribute('aria-current')).toBe('true');
		await click(buttonIn(panel, 'Load more'));
		expect(rowsOf(panel)).toEqual(['Phone', 'Case']);
		expect(textOf(panel)).toContain('Stock not tracked');
		expect(server.last('GET /v1/admin/products')?.url.searchParams.get('cursor')).toBe('c2');
		// a status chip filters, and so does the search
		await click(/** @type {HTMLElement} */ ([...panel.querySelectorAll('.chipbar button')][2]));
		expect(lastQuery(server)).toEqual({ status: 'draft' });
		expect(server.last('GET /v1/admin/products/counts')?.url.searchParams.get('status')).toBeNull();
		type(fieldIn(panel, 'Search'), 'pho');
		await submit(fieldIn(panel, 'Search'));
		expect(lastQuery(server)).toEqual({ q: 'pho', status: 'draft' });
		expect(server.last('GET /v1/admin/products')?.headers.authorization).toBe('Bearer t1');
		tickets.emit(false);
		expect(statuses(root)).toContain('Signed out. Sign in again to keep working.');
		tickets.emit(true);
		expect(statuses(root)).not.toContain('Signed out. Sign in again to keep working.');
	});

	it('filters by category, brands, grades, featured, stock state, photos, low stock and kind', async () => {
		const { root, server } = await start();
		const panel = panelOf(root, 'products');
		await click(buttonIn(panel, 'Filters'));
		const dialog = dialogOf(root);
		const category = /** @type {HTMLSelectElement} */ (fieldIn(dialog, 'Category'));
		expect([...category.options].map((o) => o.textContent)).toEqual(['All', 'Audio', 'Phones', '— Android', 'Lost']);
		expect(textOf(dialog)).toContain('Some variants in stock1');
		expect(textOf(dialog)).toContain('Acme2');
		expect([...fieldIn(dialog, 'Featured').options].map((/** @type {any} */ o) => o.textContent)).toEqual([
			'Any',
			'Featured (1)',
			'Not featured (1)',
		]);
		await change(category, 'cat_b');
		await change(fieldIn(dialog, 'Kind'), 'digital');
		await change(fieldIn(dialog, 'Featured'), '1');
		await change(fieldIn(dialog, 'Photos'), '0');
		await tick(checkIn(dialog, 'Low stock only'), true);
		await tick(checkIn(dialog, 'Acme2'), true);
		await tick(checkIn(dialog, 'Zed0'), true);
		await tick(checkIn(dialog, 'Grade A1'), true);
		await tick(checkIn(dialog, 'Out of stock1'), true);
		await tick(checkIn(dialog, 'Some variants in stock1'), true);
		await submitDialog(root);
		expect(hasDialog(root)).toBe(false);
		expect(lastQuery(server)).toEqual({
			category: 'cat_b',
			brand: 'brd_1,brd_2',
			grade: 'a',
			featured: '1',
			stockState: 'partial,out',
			hasMedia: '0',
			lowStock: 'true',
			kind: 'digital',
		});
		// the counts by stock state leave their own filter out
		const counts = server.all('GET /v1/admin/products/counts').map((call) => Object.fromEntries(call.url.searchParams));
		expect(counts.find((query) => query.by === 'stockState')).toBeTruthy();
		expect(buttonIn(panel, 'Filters10').textContent).toBe('Filters10');
		await click(buttonIn(panel, 'Clear filters'));
		expect(lastQuery(server)).toEqual({});
		expect(panel.querySelector('button.secondary')?.textContent).not.toBe('Clear filters');
	});

	it("orders and filters by the SEO score while SEO is on, and shows each row's score (E42)", async () => {
		const { root, server } = await start([...ALL, 'seo'], {
			'GET /v1/admin/products': () => answer(200, { items: [{ ...ROW, seoScore: 44 }], nextCursor: null, hasMore: false }),
			// the open product's row follows its detail
			'GET /v1/admin/products/prd_1': () => answer(200, product({ seo: { ...product().seo, score: 44, checks: [] } })),
		});
		const panel = panelOf(root, 'products');
		expect(textOf(panel)).toContain('SEO 44/100');
		await click(buttonIn(panel, 'Filters'));
		const dialog = dialogOf(root);
		await change(fieldIn(dialog, 'Order'), 'seo_score');
		await change(fieldIn(dialog, 'SEO score'), '50');
		expect([...fieldIn(dialog, 'SEO score').options].map((/** @type {any} */ o) => o.textContent)).toEqual([
			'Any',
			'Below 50',
			'Below 80',
		]);
		await submitDialog(root);
		expect(lastQuery(server)).toEqual({ sort: 'seo_score', seoBelow: '50' });
		// counts take the filter, not the order
		const count = Object.fromEntries(server.last('GET /v1/admin/products/count')?.url.searchParams ?? []);
		expect(count).toEqual({ seoBelow: '50' });
		expect(buttonIn(panel, 'Filters2').textContent).toBe('Filters2');
		await click(buttonIn(panel, 'Clear filters'));
		expect(lastQuery(server)).toEqual({});
		// without SEO there is neither
		resetPage();
		const plain = await start();
		await click(buttonIn(panelOf(plain.root, 'products'), 'Filters'));
		expect(() => fieldIn(dialogOf(plain.root), 'Order')).toThrow();
	});

	it('shows not allowed, unreachable, empty and failed answers', async () => {
		const denied = await start(['catalog'], { 'GET /v1/admin/products': () => problem(403, 'forbidden') });
		expect(statuses(denied.root)).toContain('You are not allowed to do this.');
		const sections = /** @type {HTMLElement} */ (denied.root.querySelector('nav.sections'));
		expect([...sections.querySelectorAll('[data-section]')].map((node) => node.getAttribute('data-section'))).toEqual([
			'products',
			'categories',
			'brands',
			'attributes',
		]);
		// a narrow widget picks its section from the select; the list marks the same one
		const choose = /** @type {HTMLSelectElement} */ (sections.querySelector('select'));
		choose.value = 'brands';
		choose.dispatchEvent(new Event('change'));
		expect(denied.root.querySelector('[data-panel="brands"]')?.hasAttribute('hidden')).toBe(false);
		expect(sections.querySelector('[aria-current="true"]')?.getAttribute('data-section')).toBe('brands');
		resetPage();
		const down = await start(['catalog'], {
			'GET /v1/admin/products': () => {
				throw new Error('offline');
			},
		});
		expect(statuses(down.root)).toContain('The shop cannot be reached right now. Please try again.');
		resetPage();
		const out = await mountWith(mountCatalogAdmin, { features: ['catalog'], routes: lists(), ticket: null });
		expect(statuses(out.root)).toContain('Signed out. Sign in again to keep working.');
		resetPage();
		const empty = await start(['catalog'], {
			'GET /v1/admin/products': () => answer(200, { items: [], nextCursor: null, hasMore: false }),
			'GET /v1/admin/products/count': () => answer(200, { count: 10000, capped: true }),
			'GET /v1/admin/products/counts': () => problem(403, 'forbidden'),
			'GET /v1/admin/categories': () => problem(403, 'forbidden'),
		});
		const panel = panelOf(empty.root, 'products');
		expect(statuses(panel)).toContain('No products match.');
		expect(textOf(panel)).toContain('More than 10000 products');
		expect(textOf(detailOf(panel))).toContain('No products match.');
		resetPage();
		const plain = await start(['catalog'], {
			'GET /v1/admin/products': () => answer(500, { errors: [{ message: 'Bad thing.' }] }),
		});
		expect(statuses(plain.root)).toContain(TEXTS['admin.failed']);
		resetPage();
		const nothing = await start(['catalog'], {
			'GET /v1/admin/products': () => answer(500, null),
			'GET /v1/admin/products/count': () => answer(500, null),
		});
		expect(statuses(nothing.root)).toContain('Something went wrong. Please try again.');
		resetPage();
		// Load more failing, and a product whose detail cannot be read
		const later = await start(['catalog'], {
			'GET /v1/admin/products': (/** @type {any} */ call) =>
				call.url.searchParams.get('cursor')
					? problem(500, 'internal_error')
					: answer(200, { items: [ROW, { ...ROW, id: 'prd_3', name: 'Gone' }], nextCursor: 'c2', hasMore: true }),
			'GET /v1/admin/products/prd_3': () => problem(404, 'not_found'),
		});
		const list = panelOf(later.root, 'products');
		await click(buttonIn(list, 'Load more'));
		expect(statuses(list)).toContain(TEXTS['admin.failed']);
		await pick(list, 'Gone');
		expect(statuses(detailOf(list))).toContain(TEXTS['problem.not_found']);
	});

	it('changes the selected products in bulk', async () => {
		/** @type {any[]} */
		const sent = [];
		let reply = () => answer(200, { matched: 1, changed: 1, missing: [] });
		const { root } = await start(ALL, {
			'POST /v1/admin/products/bulk': (/** @type {any} */ call) => {
				sent.push(call.body);
				return reply();
			},
		});
		const panel = panelOf(root, 'products');
		await click(buttonIn(panel, 'Select'));
		expect(textOf(panel)).toContain('0 selected');
		await click(buttonIn(panel, 'Change'));
		expect(statuses(panel)).toContain('Select at least one first.');
		const box = () => /** @type {HTMLInputElement} */ (panel.querySelector('input[aria-label="Select Phone"]'));
		await tick(box(), true);
		await tick(box(), false);
		await click(buttonIn(panel, 'Select all shown'));
		expect(textOf(panel)).toContain('1 selected');
		// a click on the checkbox's label selects without opening the row
		await click(/** @type {HTMLElement} */ (box().parentElement));
		expect(textOf(panel)).toContain('0 selected');
		await click(/** @type {HTMLElement} */ (box().parentElement));
		expect(textOf(panel)).toContain('1 selected');
		await click(buttonIn(panel, 'Change'));
		await change(fieldIn(dialogOf(root), 'Status'), 'archived');
		await submitDialog(root);
		expect(statuses(panel)).toContain('Changed 1 of 1 products.');
		// the selection is cleared after a change
		expect(textOf(panel)).toContain('0 selected');
		await click(buttonIn(panel, 'Select all shown'));
		await click(buttonIn(panel, 'Change'));
		let dialog = dialogOf(root);
		await change(fieldIn(dialog, 'Change'), 'price');
		type(fieldIn(dialog, 'By (−10 = 10 less)'), 'x');
		await submitDialog(root);
		expect(statuses(dialog)).toContain('Check the amounts and numbers you typed.');
		type(fieldIn(dialog, 'By (−10 = 10 less)'), '−10');
		await submitDialog(root);
		await click(buttonIn(panel, 'Select all shown'));
		await click(buttonIn(panel, 'Change'));
		dialog = dialogOf(root);
		await change(fieldIn(dialog, 'Change'), 'price');
		await change(fieldIn(dialog, 'Change prices'), 'fixed');
		type(fieldIn(dialog, 'By (−10 = 10 less)'), '-2.50');
		await submitDialog(root);
		await click(buttonIn(panel, 'Select all shown'));
		await click(buttonIn(panel, 'Change'));
		dialog = dialogOf(root);
		await change(fieldIn(dialog, 'Change'), 'stock');
		type(fieldIn(dialog, 'Units'), '1.5');
		await submitDialog(root);
		expect(statuses(dialog)).toContain('Check the amounts and numbers you typed.');
		type(fieldIn(dialog, 'Units'), '5');
		await change(fieldIn(dialog, 'Location'), 'loc_2');
		await submitDialog(root);
		await click(buttonIn(panel, 'Select all shown'));
		await click(buttonIn(panel, 'Change'));
		dialog = dialogOf(root);
		await change(fieldIn(dialog, 'Change'), 'add_category');
		await change(fieldIn(dialog, 'Category'), 'cat_c');
		reply = () => invalid('/categoryId');
		await submitDialog(root);
		expect(statuses(dialog)).toContain(TEXTS['problem.field.categoryId']);
		expect(sent).toEqual([
			{ ids: ['prd_1'], action: 'status', status: 'archived' },
			{ ids: ['prd_1'], action: 'price', price: { mode: 'percent', value: -10 } },
			{ ids: ['prd_1'], action: 'price', price: { mode: 'fixed', value: -250 } },
			{ ids: ['prd_1'], action: 'stock', stock: 5, locationId: 'loc_2' },
			{ ids: ['prd_1'], action: 'add_category', categoryId: 'cat_c' },
		]);
		await click(buttonIn(panel, 'Done'));
		expect(panel.querySelector('input[aria-label="Select Phone"]')).toBeNull();
	});

	it('generates the variants of the selected products', async () => {
		/** @type {any[]} */
		const sent = [];
		const { root } = await start(['catalog', 'variants'], {
			'POST /v1/admin/products/variants/generate': (/** @type {any} */ call) => {
				sent.push(call.body);
				return call.body.price === 100
					? invalid('/ids')
					: answer(200, {
							results: [
								{ id: 'prd_1', added: 3 },
								{ id: 'prd_9', error: SERVER_ENGLISH, code: 'not_found' },
								{ id: 'prd_8', error: SERVER_ENGLISH, code: 'validation_failed', path: '/variants/3/price' },
							],
							added: 3,
						});
			},
		});
		const panel = panelOf(root, 'products');
		await click(buttonIn(panel, 'Select'));
		await click(buttonIn(panel, 'Generate variants'));
		expect(statuses(panel)).toContain('Select at least one first.');
		await click(buttonIn(panel, 'Select all shown'));
		await click(buttonIn(panel, 'Generate variants'));
		const dialog = dialogOf(root);
		type(fieldIn(dialog, "Price of new variants (empty = the product's lowest)"), 'abc');
		await submitDialog(root);
		expect(statuses(dialog)).toContain('Check the amounts and numbers you typed.');
		type(fieldIn(dialog, "Price of new variants (empty = the product's lowest)"), '1');
		await submitDialog(root);
		expect(statuses(dialog)).toContain(TEXTS['problem.field.ids']);
		type(fieldIn(dialog, "Price of new variants (empty = the product's lowest)"), '');
		type(fieldIn(dialog, 'Stock of each new variant'), '2');
		await submitDialog(root);
		expect(sent.at(-1)).toEqual({ ids: ['prd_1'], stock: 2 });
		// why a product got none, in the website's words for the problem or its field (PLAN 0.4.10)
		expect(statuses(panel)).toContain(
			`3 variants added. prd_9: ${TEXTS['problem.not_found']} prd_8: ${TEXTS['problem.field.price']}`,
		);
		expect(statuses(panel)).not.toContain(SERVER_ENGLISH);
	});

	it('filters with fewer features and counts not allowed, and sets stock in bulk without locations', async () => {
		/** @type {any[]} */
		const sent = [];
		const { root, server } = await start(
			['catalog', 'bulk_actions'],
			{
				'GET /v1/admin/brands': () => answer(200, { items: [] }),
				'GET /v1/admin/products/counts': () => problem(403, 'forbidden'),
				'POST /v1/admin/products/bulk': (/** @type {any} */ call) => {
					sent.push(call.body);
					return answer(200, { matched: 1, changed: 0, missing: [] });
				},
			},
			{},
		);
		const panel = panelOf(root, 'products');
		expect([...panel.querySelectorAll('.chipbar button')].map((node) => node.textContent)).toEqual([
			'All0',
			'Active0',
			'Draft0',
			'Archived0',
		]);
		await click(buttonIn(panel, 'Filters'));
		const dialog = dialogOf(root);
		expect(() => fieldIn(dialog, 'Kind')).toThrow();
		expect(textOf(dialog)).not.toContain('Brands');
		expect(textOf(dialog)).not.toContain('Grades');
		expect([...fieldIn(dialog, 'Featured').options].map((/** @type {any} */ o) => o.textContent)).toEqual([
			'Any',
			'Featured (0)',
			'Not featured (0)',
		]);
		expect(server.all('GET /v1/admin/products/counts').map((call) => call.url.searchParams.get('by'))).not.toContain('grade');
		await submitDialog(root);
		expect(lastQuery(server)).toEqual({});
		await click(buttonIn(panel, 'Select'));
		await click(buttonIn(panel, 'Select all shown'));
		await click(buttonIn(panel, 'Change'));
		await change(fieldIn(dialogOf(root), 'Change'), 'remove_category');
		await submitDialog(root);
		await click(buttonIn(panel, 'Select all shown'));
		await click(buttonIn(panel, 'Change'));
		await change(fieldIn(dialogOf(root), 'Change'), 'stock');
		expect(() => fieldIn(dialogOf(root), 'Location')).toThrow();
		type(fieldIn(dialogOf(root), 'Units'), '4');
		await submitDialog(root);
		expect(sent).toEqual([
			{ ids: ['prd_1'], action: 'remove_category', categoryId: 'cat_a' },
			{ ids: ['prd_1'], action: 'stock', stock: 4 },
		]);
		expect(statuses(panel)).toContain('Changed 0 of 1 products.');
	});
});
