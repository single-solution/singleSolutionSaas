// @vitest-environment jsdom
/* global window */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { columnKey } from '../ui/admin-charts.js';
import {
	ALL,
	CHARTS,
	ROW,
	confirmDialog,
	detailOf,
	dialogOf,
	hasDialog,
	menu,
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
	openTab,
	problem,
	resetPage,
	shows,
	statuses,
	submit,
	textOf,
	tick,
	type,
} from './ui-admin-helpers.js';

beforeEach(resetPage);
afterEach(resetPage);

/** A control by its accessible label. @param {ParentNode} scope @param {string} label @returns {any} */
const labelled = (scope, label) => {
	const found = scope.querySelector(`[aria-label="${label}"]`);
	if (!found) throw new Error(`no control ${label}`);
	return found;
};

describe('catalog admin: size charts', () => {
	it('lists charts with their uses, shows one and edits columns, rows, fit advice and notes', async () => {
		const { root, server } = await start(ALL, {
			'PATCH /v1/admin/size-charts/szc_1': (/** @type {any} */ call) => answer(200, { ...CHARTS[0], ...call.body }),
			'POST /v1/admin/size-charts': (/** @type {any} */ call) => answer(201, { id: 'szc_9', ...call.body, uses: undefined }),
			'DELETE /v1/admin/size-charts/szc_1': () =>
				problem(409, 'Products, brands or categories use this size chart: change them first.'),
		});
		const panel = await openTab(root, 'charts');
		expect(rowsOf(panel)).toEqual(['Shirts', 'Shoes']);
		expect(textOf(panel)).toContain('2 products · 1 brands · 0 categories');
		expect(textOf(panel)).toContain('Inches');
		const detail = textOf(detailOf(panel));
		for (const part of ['SizeChestWaist', 'Small3630', 'M40', 'Runs small.', 'Measured flat.']) expect(detail).toContain(part);
		await pick(panel, 'Shoes');
		expect(textOf(detailOf(panel))).toContain('No sizes yet.');
		expect(textOf(detailOf(panel))).toContain('Inactive');
		await pick(panel, 'Shirts');
		await click(buttonIn(detailOf(panel), 'Edit'));
		const dialog = dialogOf(root);
		expect(fieldIn(dialog, 'Column 1').value).toBe('Chest');
		expect(labelled(dialog, 'Row 1, Waist').value).toBe('30');
		await click(buttonIn(dialog, 'Add a column'));
		const hip = fieldIn(dialog, 'Column 3');
		hip.value = 'Hip';
		hip.dispatchEvent(new window.Event('change', { bubbles: true }));
		type(labelled(dialog, 'Row 1, Hip'), '38');
		await click(labelled(dialog, 'Remove column 2'));
		await click(buttonIn(dialog, 'Add a size'));
		type(labelled(dialog, 'Size of row 3'), 'L');
		await click(buttonIn(dialog, 'Add a size'));
		await click(labelled(dialog, 'Remove row 2'));
		await change(fieldIn(dialog, 'Unit'), 'cm');
		type(fieldIn(dialog, 'Fit advice'), 'True to size.');
		await tick(checkIn(dialog, 'Active'), false);
		await submitDialog(root);
		expect(server.last('PATCH /v1/admin/size-charts/szc_1')?.body).toEqual({
			name: 'Shirts',
			unit: 'cm',
			active: false,
			columns: [
				{ key: 'chest', label: 'Chest' },
				{ key: 'hip', label: 'Hip' },
			],
			rows: [
				{ size: 'S', label: 'Small', values: { chest: '36', hip: '38' } },
				{ size: 'L', label: 'L', values: {} },
			],
			fitAdvice: 'True to size.',
			notes: 'Measured flat.',
		});
		// a new chart needs a column; keys come from the labels
		await click(buttonIn(panel, 'New size chart'));
		const fresh = dialogOf(root);
		type(fieldIn(fresh, 'Name'), 'Hats');
		await submitDialog(root);
		expect(statuses(fresh)).toContain('Give the chart at least one column.');
		await click(buttonIn(fresh, 'Add a column'));
		type(fieldIn(fresh, 'Column 1'), '2 Head');
		await click(buttonIn(fresh, 'Add a column'));
		type(fieldIn(fresh, 'Column 2'), '2 Head');
		await submitDialog(root);
		expect(server.last('POST /v1/admin/size-charts')?.body.columns).toEqual([
			{ key: 'c_2_head', label: '2 Head' },
			{ key: 'c_2_head_2', label: '2 Head' },
		]);
		// delete is refused while the chart is used
		await pick(panel, 'Shirts');
		await menu(detailOf(panel), 'Delete');
		expect(textOf(dialogOf(root))).toContain('A size chart that products, brands or categories use cannot be deleted.');
		await confirmDialog(root, 'Shirts');
		expect(statuses(dialogOf(root))).toContain('Products, brands or categories use this size chart: change them first.');
		server.routes['DELETE /v1/admin/size-charts/szc_1'] = () => answer(204);
		server.routes['GET /v1/admin/size-charts'] = () => answer(200, { items: [CHARTS[1]] });
		await submitDialog(root);
		expect(rowsOf(panel)).toEqual(['Shoes']);
		resetPage();
		const denied = await start(['catalog', 'size_charts'], { 'GET /v1/admin/size-charts': () => problem(403, 'no') });
		expect(statuses(await openTab(denied.root, 'charts'))).toContain('You are not allowed to do this.');
		resetPage();
		const empty = await start(['catalog', 'size_charts'], { 'GET /v1/admin/size-charts': () => answer(200, { items: [] }) });
		const none = await openTab(empty.root, 'charts');
		expect(statuses(none)).toContain('No size charts yet.');
		const search = fieldIn(none, 'Search');
		search.value = 'x';
		search.dispatchEvent(new window.Event('input'));
		expect(statuses(none)).toContain('No size charts yet.');
	});

	it('makes column keys from labels', () => {
		const taken = new Set(['chest']);
		expect(columnKey('Chest', taken)).toBe('chest_2');
		expect(columnKey('Taille (cm)', taken)).toBe('taille_cm');
		expect(columnKey('Épaule', taken)).toBe('epaule');
		expect(columnKey('', taken)).toBe('c');
		expect(columnKey('2', taken)).toBe('c_2');
	});
});

describe('catalog admin: landing pages', () => {
	const LANDINGS = [
		{
			id: 'lnd_1',
			categoryId: 'cat_b',
			brandId: 'brd_1',
			grade: 'a',
			h1: 'Acme phones, grade A',
			title: 'Buy Acme phones',
			description: 'Graded phones',
			intro: 'Tested.',
			faqs: [{ question: 'Tested?', answer: 'Yes.' }],
			indexable: 'auto',
			url: 'https://shop.example/phones?brand=acme&grade=a',
			inStock: 4,
			indexed: true,
		},
		{
			id: 'lnd_2',
			categoryId: null,
			brandId: 'brd_2',
			grade: null,
			h1: '',
			title: '',
			description: '',
			intro: '',
			faqs: [],
			indexable: 'no',
			url: 'https://shop.example/?brand=zed',
			inStock: 0,
			indexed: false,
		},
	];

	it('lists landing pages with their address, stock and indexing, filters and edits them', async () => {
		/** @type {any[]} */
		const posts = [];
		const { root, server } = await start(ALL, {
			'GET /v1/admin/landings': () => answer(200, { items: LANDINGS }),
			'PATCH /v1/admin/landings/lnd_1': (/** @type {any} */ call) => answer(200, { ...LANDINGS[0], ...call.body }),
			'POST /v1/admin/landings': (/** @type {any} */ call) => {
				posts.push(call.body);
				return posts.length === 1
					? problem(409, 'A landing page for this category, brand and grade already exists.')
					: answer(201, { ...LANDINGS[1], id: 'lnd_3', ...call.body });
			},
		});
		const panel = await openTab(root, 'landings');
		expect(rowsOf(panel)).toEqual(['Acme phones, grade A', 'Zed']);
		expect(textOf(panel)).toContain('4 in stock');
		expect(textOf(panel)).toContain('https://shop.example/?brand=zed');
		expect([...panel.querySelectorAll('li.item .dot')].map((node) => node.getAttribute('aria-label'))).toEqual([
			'Indexed',
			'Not indexed',
		]);
		const detail = detailOf(panel);
		for (const part of [
			'Phones · Acme · Grade A',
			'Products in stock4',
			'Auto (when enough products are in stock)',
			'Tested?Yes.',
			'Tested.',
		])
			expect(textOf(detail)).toContain(part);
		expect(detail.querySelector('a')?.getAttribute('href')).toBe('https://shop.example/phones?brand=acme&grade=a');
		// filters go to the server
		await change(fieldIn(panel, 'Category'), 'cat_b');
		await change(fieldIn(panel, 'Brand'), 'brd_1');
		await change(fieldIn(panel, 'Grade'), 'a');
		type(fieldIn(panel, 'Search'), 'acme');
		await submit(fieldIn(panel, 'Search'));
		expect(Object.fromEntries(server.last('GET /v1/admin/landings')?.url.searchParams ?? [])).toEqual({
			q: 'acme',
			category: 'cat_b',
			brand: 'brd_1',
			grade: 'a',
		});
		await click(buttonIn(detailOf(panel), 'Edit'));
		const dialog = dialogOf(root);
		type(fieldIn(dialog, 'Heading (H1)'), 'Acme phones');
		await change(fieldIn(dialog, 'Search engines index it'), 'yes');
		await click(buttonIn(dialog, 'Add a question'));
		type(fieldIn(dialog, 'Question 2'), 'Warranty?');
		type(fieldIn(dialog, 'Answer 2'), 'A year.');
		await click(buttonIn(dialog, 'Add a question'));
		await click(buttonIn(dialog, 'Remove', 2));
		await submitDialog(root);
		expect(server.last('PATCH /v1/admin/landings/lnd_1')?.body).toEqual({
			categoryId: 'cat_b',
			brandId: 'brd_1',
			grade: 'a',
			h1: 'Acme phones',
			title: 'Buy Acme phones',
			description: 'Graded phones',
			intro: 'Tested.',
			faqs: [
				{ question: 'Tested?', answer: 'Yes.' },
				{ question: 'Warranty?', answer: 'A year.' },
			],
			indexable: 'yes',
		});
		await click(buttonIn(panel, 'New landing page'));
		const fresh = dialogOf(root);
		await submitDialog(root);
		expect(statuses(fresh)).toContain('Pick a category, a brand or a grade.');
		await change(fieldIn(fresh, 'Brand'), 'brd_2');
		await submitDialog(root);
		expect(statuses(fresh)).toContain('A landing page for this category, brand and grade already exists.');
		await submitDialog(root);
		expect(posts[1]).toMatchObject({ categoryId: null, brandId: 'brd_2', grade: null, indexable: 'auto' });
		expect(hasDialog(root)).toBe(false);
	});

	it('suggests copy with AI, applies it and deletes landing pages', async () => {
		let ai = () => problem(503, 'Connect your AI provider first (Connections).');
		const { root, server } = await start(ALL, {
			'GET /v1/admin/landings': () => answer(200, { items: LANDINGS }),
			'POST /v1/admin/landings/lnd_1/ai-copy': () => ai(),
			'PATCH /v1/admin/landings/lnd_1': (/** @type {any} */ call) =>
				call.body.h1 === 'Fail' ? problem(422, 'This text has at most 200 characters.') : answer(200, LANDINGS[0]),
			'DELETE /v1/admin/landings/lnd_1': () => answer(204),
		});
		const panel = await openTab(root, 'landings');
		await menu(detailOf(panel), 'Write with AI');
		const dialog = dialogOf(root);
		await tick(checkIn(dialog, 'Introduction'), false);
		await click(buttonIn(dialog, 'Suggest'));
		expect(statuses(dialog)).toContain('Connect your AI provider first (Connections).');
		expect(server.last('POST /v1/admin/landings/lnd_1/ai-copy')?.body).toEqual({
			fields: ['h1', 'title', 'description', 'faqs'],
		});
		await submitDialog(root);
		expect(statuses(dialog)).toContain('Tick at least one suggestion to apply.');
		ai = () =>
			answer(200, {
				suggestions: { h1: 'Fail', title: 'T', description: 'D', intro: 'I', faqs: [{ question: 'Q', answer: 'A' }] },
			});
		await click(buttonIn(dialog, 'Suggest'));
		await tick(checkIn(dialog, 'Apply: Meta description'), false);
		await submitDialog(root);
		expect(statuses(dialog)).toContain('This text has at most 200 characters.');
		type(fieldIn(dialog, 'Heading'), 'Acme phones');
		await submitDialog(root);
		expect(server.last('PATCH /v1/admin/landings/lnd_1')?.body).toEqual({
			h1: 'Acme phones',
			title: 'T',
			intro: 'I',
			faqs: [{ question: 'Q', answer: 'A' }],
		});
		await menu(detailOf(panel), 'Delete');
		await confirmDialog(root, 'Acme phones, grade A');
		expect(hasDialog(root)).toBe(false);
		// without AI copy there is no suggestion entry, and failures show
		resetPage();
		const plain = await start(['catalog', 'landing_pages'], { 'GET /v1/admin/landings': () => problem(403, 'no') }, {});
		const denied = await openTab(plain.root, 'landings');
		expect(statuses(denied)).toContain('You are not allowed to do this.');
		expect(() => fieldIn(denied, 'Grade')).toThrow();
		resetPage();
		const empty = await start(['catalog', 'landing_pages'], {
			'GET /v1/admin/landings': () => answer(200, { items: [{ ...LANDINGS[1], brandId: null, grade: 'x' }] }),
		});
		const one = await openTab(empty.root, 'landings');
		expect(rowsOf(one)).toEqual(['x']);
		await menu(detailOf(one), 'Delete');
		expect(textOf(dialogOf(empty.root))).toContain('Delete x?');
		empty.server.routes['GET /v1/admin/landings'] = () => answer(200, { items: [] });
		/** @type {HTMLElement} */ (
			[...dialogOf(empty.root).querySelectorAll('button')].find((node) => node.textContent === 'Cancel')
		).click();
		await submit(fieldIn(one, 'Search'));
		expect(statuses(one)).toContain('No landing pages match.');
		expect(shows(one, 'New landing page')).toBe(true);
	});
});

describe('catalog admin: serial numbers', () => {
	const SERIAL = {
		id: 'ser_1',
		productId: 'prd_1',
		variantId: 'var_1',
		serial: 'IMEI1',
		status: 'in_stock',
		orderId: null,
		locationId: 'loc_1',
	};

	it('lists, filters, marks and deletes serial numbers', async () => {
		/** @type {any[]} */
		let items = [
			SERIAL,
			{ ...SERIAL, id: 'ser_4', serial: 'IMEI4', status: 'sold', orderId: 'ord_1', locationId: null },
			{ ...SERIAL, id: 'ser_5', serial: 'IMEI5', status: 'faulty', productId: 'prd_x', variantId: 'var_x' },
		];
		const { root, server } = await start(ALL, {
			'GET /v1/admin/serials': (/** @type {any} */ call) =>
				call.url.searchParams.get('cursor')
					? answer(200, { items: [{ ...SERIAL, id: 'ser_9', serial: 'IMEI9' }], nextCursor: null, hasMore: false })
					: answer(200, { items, nextCursor: 'IMEI5', hasMore: true }),
			'PATCH /v1/admin/serials/ser_1': (/** @type {any} */ call) => {
				items = items.map((item) => (item.id === 'ser_1' ? { ...item, status: call.body.status } : item));
				return answer(200, { ...SERIAL, status: call.body.status });
			},
			'PATCH /v1/admin/serials/ser_5': () => problem(409, 'This unit was sold: it changes through its order or return.'),
			'DELETE /v1/admin/serials/ser_1': () => problem(409, 'This unit was sold: it cannot be deleted.'),
			'GET /v1/admin/products/prd_x': () => problem(404, 'There is no such product.'),
		});
		const panel = await openTab(root, 'serials');
		expect(rowsOf(panel)).toEqual(['IMEI1', 'IMEI4', 'IMEI5']);
		expect(textOf(panel)).toContain('ord_1');
		const detail = () => textOf(detailOf(panel));
		for (const part of ['In stock', 'ProductPhone', 'VariantRed', 'LocationShop']) expect(detail()).toContain(part);
		await click(buttonIn(detailOf(panel), 'Mark faulty'));
		expect(server.last('PATCH /v1/admin/serials/ser_1')?.body).toEqual({ status: 'faulty' });
		expect(detail()).toContain('Back in stock');
		await pick(panel, 'IMEI4');
		expect(detail()).toContain('Orderord_1');
		expect(shows(detailOf(panel), 'Mark faulty')).toBe(false);
		expect(/** @type {HTMLElement} */ (detailOf(panel).querySelector('.more')).hidden).toBe(true);
		await pick(panel, 'IMEI5');
		expect(detail()).toContain('Productprd_x');
		await click(buttonIn(detailOf(panel), 'Back in stock'));
		expect(statuses(detailOf(panel))).toContain('This unit was sold: it changes through its order or return.');
		await pick(panel, 'IMEI1');
		await menu(detailOf(panel), 'Delete');
		await confirmDialog(root, 'IMEI1');
		expect(statuses(dialogOf(root))).toContain('This unit was sold: it cannot be deleted.');
		server.routes['DELETE /v1/admin/serials/ser_1'] = () => answer(204);
		await submitDialog(root);
		expect(hasDialog(root)).toBe(false);
		await click(buttonIn(panel, 'Load more'));
		expect(rowsOf(panel)).toContain('IMEI9');
		type(fieldIn(panel, 'Search'), 'IME');
		await submit(fieldIn(panel, 'Search'));
		await change(fieldIn(panel, 'Status'), 'faulty');
		expect(Object.fromEntries(server.last('GET /v1/admin/serials')?.url.searchParams ?? [])).toEqual({
			q: 'IME',
			status: 'faulty',
			limit: '50',
		});
		server.routes['GET /v1/admin/serials'] = () => answer(200, { items: [], nextCursor: null, hasMore: false });
		await change(fieldIn(panel, 'Status'), 'sold');
		expect(statuses(panel)).toContain('No serial numbers match.');
		server.routes['GET /v1/admin/serials'] = () => problem(403, 'no');
		await change(fieldIn(panel, 'Status'), '');
		expect(statuses(panel)).toContain('You are not allowed to do this.');
	});

	it('adds serial numbers for a product variant', async () => {
		let added = () => problem(409, 'These serial numbers are already recorded: A1.');
		const { root, server } = await start(ALL, {
			'GET /v1/admin/serials': () => answer(200, { items: [SERIAL], nextCursor: null, hasMore: false }),
			'POST /v1/admin/serials': () => added(),
			'GET /v1/admin/products/prd_x': () => problem(404, 'There is no such product.'),
		});
		const panel = await openTab(root, 'serials');
		await click(buttonIn(panel, 'Add serial numbers'));
		const dialog = dialogOf(root);
		await submitDialog(root);
		expect(statuses(dialog)).toContain('Pick the product and its variant.');
		type(fieldIn(dialog, 'Find a product'), 'pho');
		await click(buttonIn(dialog, 'Find'));
		expect(server.last('GET /v1/admin/products')?.url.searchParams.get('q')).toBe('pho');
		await change(fieldIn(dialog, 'Product'), 'prd_1');
		expect([...fieldIn(dialog, 'Variant').options].map((/** @type {any} */ o) => o.textContent)).toEqual(['Red', 'Blue']);
		await change(fieldIn(dialog, 'Location'), 'loc_1');
		type(fieldIn(dialog, 'Serial numbers (one per line)'), 'A1\nA2, A3');
		await submitDialog(root);
		expect(statuses(dialog)).toContain('These serial numbers are already recorded: A1.');
		expect(server.last('POST /v1/admin/serials')?.body).toEqual({
			productId: 'prd_1',
			variantId: 'var_1',
			serials: ['A1', 'A2', 'A3'],
			locationId: 'loc_1',
		});
		await change(fieldIn(dialog, 'Location'), '');
		added = () => answer(201, { items: [{ id: 'ser_2' }, { id: 'ser_3' }] });
		await submitDialog(root);
		expect(server.last('POST /v1/admin/serials')?.body.locationId).toBeUndefined();
		expect(statuses(panel)).toContain('2 serial numbers added.');
		// a product that is gone, and a search that is not allowed
		await click(buttonIn(panel, 'Add serial numbers'));
		const again = dialogOf(root);
		server.routes['GET /v1/admin/products'] = () =>
			answer(200, { items: [{ ...ROW, id: 'prd_x' }], nextCursor: null, hasMore: false });
		await click(buttonIn(again, 'Find'));
		await change(fieldIn(again, 'Product'), 'prd_x');
		expect(statuses(again)).toContain('This product is no longer there.');
		await change(fieldIn(again, 'Product'), '');
		server.routes['GET /v1/admin/products'] = () => problem(403, 'no');
		await click(buttonIn(again, 'Find'));
		expect(statuses(again)).toContain('You are not allowed to do this.');
		expect(product().id).toBe('prd_1');
	});
});
