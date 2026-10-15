// @vitest-environment jsdom
/* global window */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	ALL,
	ATTRIBUTES,
	BRANDS,
	CATEGORIES,
	confirmDialog,
	detailOf,
	dialogOf,
	hasDialog,
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
	checkIn,
	choose,
	click,
	fieldIn,
	invalid,
	openTab,
	problem,
	resetPage,
	shows,
	statuses,
	textOf,
	TEXTS,
	tick,
	type,
} from './ui-admin-helpers.js';

beforeEach(resetPage);
afterEach(resetPage);

/** Type in a list's search box. @param {HTMLElement} panel @param {string} text */
const search = (panel, text) => {
	const box = fieldIn(panel, 'Search');
	box.value = text;
	box.dispatchEvent(new window.Event('input'));
};

describe('catalog admin: categories', () => {
	it('lists the tree with status dots, filters it and shows a category', async () => {
		const { root, server } = await start(ALL);
		const panel = await openTab(root, 'categories');
		expect(server.last('GET /v1/admin/products/counts')?.url.searchParams.get('by')).toBe('category');
		expect([...panel.querySelectorAll('li.item .figure')].map((node) => node.textContent)).toEqual([
			'0 products',
			'5 products',
			'1 products',
			'0 products',
		]);
		expect(rowsOf(panel)).toEqual(['Audio', 'Phones', 'Android', 'Lost']);
		expect([...panel.querySelectorAll('li.item .dot')].map((node) => node.getAttribute('aria-label'))).toEqual([
			'Coming soon',
			'Active',
			'Hidden',
			'Active',
		]);
		expect(/** @type {HTMLElement} */ (panel.querySelectorAll('li.item')[2]).style.paddingLeft).toBe('24px');
		expect(textOf(panel)).toContain('phones · 1 subcategories');
		// the first category opens by itself
		expect(textOf(detailOf(panel))).toContain('Coming soon');
		expect(textOf(detailOf(panel))).toContain('Products0');
		expect(textOf(detailOf(panel))).toContain('noindex');
		await change(fieldIn(panel, 'Status'), 'hidden');
		expect(rowsOf(panel)).toEqual(['Android']);
		await change(fieldIn(panel, 'Status'), '');
		search(panel, 'PHO');
		expect(rowsOf(panel)).toEqual(['Phones']);
		search(panel, 'zzz');
		expect(statuses(panel)).toContain('Nothing matches.');
		search(panel, '');
		await pick(panel, 'Phones');
		expect(panel.querySelector('.split')?.getAttribute('data-view')).toBe('detail');
		const detail = textOf(detailOf(panel));
		for (const part of [
			'Products5',
			'Subcategories1',
			'Icon namephone',
			'Item typeUsed phone',
			'mobiles',
			'Fast (bolt)',
			'Unlocked?Yes.',
		])
			expect(detail).toContain(part);
		await click(buttonIn(detailOf(panel), 'Back'));
		expect(panel.querySelector('.split')?.getAttribute('data-view')).toBe('list');
		await pick(panel, 'Android');
		expect(textOf(detailOf(panel))).toContain('Item typePhysical goods');
		await pick(panel, 'Lost');
		expect(textOf(detailOf(panel))).toContain('Item typeAs its parent category');
		// a list that cannot be read
		resetPage();
		const uncounted = await start(['catalog'], { 'GET /v1/admin/products/counts': () => problem(403, 'forbidden') });
		const plain = await openTab(uncounted.root, 'categories');
		expect(textOf(plain.querySelector('li.item .figure') ?? plain)).toBe('0 products');
		resetPage();
		const denied = await start(['catalog'], { 'GET /v1/admin/categories': () => problem(403, 'forbidden') });
		expect(statuses(await openTab(denied.root, 'categories'))).toContain('You are not allowed to do this.');
		resetPage();
		const empty = await start(['catalog'], { 'GET /v1/admin/categories': () => answer(200, { items: [] }) });
		const none = await openTab(empty.root, 'categories');
		expect(statuses(none)).toContain('No categories yet.');
		expect(textOf(detailOf(none))).toContain('No categories yet.');
	});

	it('creates and edits categories with status, icon, content, FAQs, size chart, Google category, serials and SEO', async () => {
		/** @type {any[]} */
		const bodies = [];
		const { root, server } = await start([...ALL, 'feeds'], {
			'GET /v1/admin/categories': () =>
				answer(200, { items: CATEGORIES.map((item) => (item.id === 'cat_b' ? { ...item, googleCategory: '1604' } : item)) }),
			'POST /v1/admin/categories': (/** @type {any} */ call) => {
				bodies.push(call.body);
				return call.body.name
					? answer(201, { ...CATEGORIES[0], id: 'cat_n', name: call.body.name, parentId: call.body.parentId })
					: invalid('/name');
			},
			'PATCH /v1/admin/categories/cat_b': (/** @type {any} */ call) => answer(200, { ...CATEGORIES[0], ...call.body }),
		});
		const panel = await openTab(root, 'categories');
		await pick(panel, 'Phones');
		expect(textOf(detailOf(panel))).toContain('Google product category1604');
		await click(buttonIn(panel, 'New category'));
		await submitDialog(root);
		expect(statuses(dialogOf(root))).toContain(TEXTS['problem.field.name']);
		const dialog = dialogOf(root);
		type(fieldIn(dialog, 'Name'), 'Cables');
		await change(fieldIn(dialog, 'Inside'), 'cat_b');
		type(fieldIn(dialog, 'Sort order'), 'x');
		await submitDialog(root);
		expect(bodies[1]).toEqual({
			name: 'Cables',
			slug: '',
			parentId: 'cat_b',
			status: 'active',
			icon: '',
			sort: 0,
			description: '',
			content: { summary: '', bullets: [] },
			faqs: [],
			seo: {
				title: '',
				description: '',
				canonicalUrl: '',
				ogImage: '',
				noindex: false,
				nofollow: false,
				focusKeyword: '',
				titleMode: 'template',
			},
			typeKey: null,
			sizeChartId: null,
			googleCategory: '',
		});
		expect(hasDialog(root)).toBe(false);
		// edit Phones: its parent cannot be itself or below it
		await pick(panel, 'Phones');
		await click(buttonIn(detailOf(panel), 'Edit'));
		const edit = dialogOf(root);
		expect([...fieldIn(edit, 'Inside').options].map((/** @type {any} */ o) => o.value)).toEqual(['', 'cat_a', 'cat_x']);
		expect(textOf(edit)).toContain('Earlier addresses still lead here: mobiles');
		expect(fieldIn(edit, 'Item type').value).toBe('used_phone');
		expect([...fieldIn(edit, 'Item type').options].map((/** @type {any} */ o) => o.value)).toEqual([
			'',
			'physical',
			'digital',
			'service',
			'used_phone',
		]);
		await change(fieldIn(edit, 'Status'), 'coming_soon');
		type(fieldIn(edit, 'Icon name'), 'mobile');
		await change(fieldIn(edit, 'Item type'), 'physical');
		await change(fieldIn(edit, 'Size chart'), 'szc_2');
		type(fieldIn(edit, 'Google product category (empty = as above it)'), ' 267 ');
		type(fieldIn(edit, 'Summary'), 'Best phones');
		await click(buttonIn(edit, 'Remove', 0));
		await click(buttonIn(edit, 'Add a bullet'));
		type(fieldIn(edit, 'Bullet 2'), 'Cheap');
		type(fieldIn(edit, 'Icon of bullet 2'), 'tag');
		await click(buttonIn(edit, 'Add a bullet'));
		await click(buttonIn(edit, 'Remove', 2));
		type(fieldIn(edit, 'Answer 1'), 'Always.');
		type(fieldIn(edit, 'Canonical address'), '/phones');
		await submitDialog(root);
		expect(server.last('PATCH /v1/admin/categories/cat_b')?.body).toMatchObject({
			status: 'coming_soon',
			icon: 'mobile',
			typeKey: 'physical',
			sizeChartId: 'szc_2',
			googleCategory: '267',
			content: {
				summary: 'Best phones',
				bullets: [
					{ text: 'Light', icon: '' },
					{ text: 'Cheap', icon: 'tag' },
				],
			},
			faqs: [{ question: 'Unlocked?', answer: 'Always.' }],
			seo: { canonicalUrl: '/phones' },
		});
		// add a subcategory: its parent is the open category
		await click(buttonIn(detailOf(panel), 'Add subcategory'));
		expect(fieldIn(dialogOf(root), 'Inside').value).toBe('cat_b');
		/** @type {HTMLElement} */ (
			[...dialogOf(root).querySelectorAll('button')].find((node) => node.textContent === 'Cancel')
		).click();
		expect(hasDialog(root)).toBe(false);
	});

	it('uploads and removes a category image and deletes categories', async () => {
		const { root, server } = await start(['catalog'], {
			'DELETE /v1/admin/categories/cat_a': () => problem(409, 'conflict'),
			'DELETE /v1/admin/categories/cat_c': () => answer(204),
			'POST /v1/admin/catalog/uploads': () =>
				answer(200, { key: 'ecommerce/categories/cat_a/x.png', upload: { url: 'https://bucket.example/cat' } }),
			'PUT /cat': () => answer(200),
			'PUT /v1/admin/categories/cat_a/image': () =>
				answer(200, { image: { key: 'x', url: 'https://cdn.example/x.png', alt: 'Audio' } }),
			'DELETE /v1/admin/categories/cat_a/image': () => answer(200, { image: null }),
		});
		const panel = await openTab(root, 'categories');
		const detail = () => detailOf(panel);
		expect(detail().querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/a.png');
		await choose(fieldIn(detail(), 'Upload an image'), []);
		await choose(fieldIn(detail(), 'Upload an image'), [new window.File(['x'], 'x.png', { type: 'image/png' })]);
		expect(server.last('PUT /v1/admin/categories/cat_a/image')?.body).toEqual({
			key: 'ecommerce/categories/cat_a/x.png',
			alt: 'Audio',
		});
		expect(detail().querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/x.png');
		// the listed category keeps its new image
		await pick(panel, 'Phones');
		await pick(panel, 'Audio');
		expect(detail().querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/x.png');
		await click(buttonIn(detail(), 'Remove image'));
		expect(detail().querySelector('.thumbs img')).toBeNull();
		expect(shows(detail(), 'Remove image')).toBe(false);
		await pick(panel, 'Phones');
		await pick(panel, 'Audio');
		expect(detail().querySelector('.thumbs img')).toBeNull();
		resetPage();
		const again = await start(['catalog'], {
			'DELETE /v1/admin/categories/cat_a/image': () => problem(403, 'forbidden'),
			'PUT /v1/admin/categories/cat_a/image': () => invalid('/key'),
			'POST /v1/admin/catalog/uploads': () => answer(200, { key: 'k', upload: { url: 'https://bucket.example/cat' } }),
			'PUT /cat': () => answer(200),
			'DELETE /v1/admin/categories/cat_a': () => problem(409, 'conflict'),
			'DELETE /v1/admin/categories/cat_c': () => answer(204),
		});
		const list = await openTab(again.root, 'categories');
		await click(buttonIn(detailOf(list), 'Remove image'));
		expect(statuses(detailOf(list))).toContain('You are not allowed to do this.');
		expect(buttonIn(detailOf(list), 'Remove image').disabled).toBe(true);
		await choose(fieldIn(detailOf(list), 'Upload an image'), [new window.File(['x'], 'x.png', { type: 'image/png' })]);
		expect(statuses(detailOf(list))).toContain(TEXTS['problem.validation_failed']);
		again.server.routes['PUT /cat'] = () => answer(500);
		await choose(fieldIn(detailOf(list), 'Upload an image'), [new window.File(['x'], 'x.png', { type: 'image/png' })]);
		expect(statuses(detailOf(list))).toContain('The file could not be uploaded. Please try again.');
		again.server.routes['POST /v1/admin/catalog/uploads'] = () => problem(503, 'storage_not_connected');
		await choose(fieldIn(detailOf(list), 'Upload an image'), [new window.File(['x'], 'x.png', { type: 'image/png' })]);
		expect(statuses(detailOf(list))).toContain(TEXTS['problem.storage_not_connected']);
		// delete: refused, then done
		await menu(detailOf(list), 'Delete');
		await confirmDialog(again.root, 'Audio');
		expect(statuses(dialogOf(again.root))).toContain(TEXTS['problem.conflict']);
		/** @type {HTMLElement} */ (
			[...dialogOf(again.root).querySelectorAll('button')].find((node) => node.textContent === 'Cancel')
		).click();
		await pick(list, 'Android');
		again.server.routes['GET /v1/admin/categories'] = () =>
			answer(200, { items: CATEGORIES.filter((item) => item.id !== 'cat_c') });
		await menu(detailOf(list), 'Delete');
		await confirmDialog(again.root, 'Android');
		expect(hasDialog(again.root)).toBe(false);
		expect(rowsOf(list)).toEqual(['Audio', 'Phones', 'Lost']);
	});
});

describe('catalog admin: brands and locations', () => {
	it('lists brands with their product counts and edits them with status, categories, size chart and SEO', async () => {
		const { root, server } = await start(ALL, {
			'POST /v1/admin/brands': (/** @type {any} */ call) => answer(201, { id: 'brd_3', ...call.body, logo: null }),
			'PATCH /v1/admin/brands/brd_2': (/** @type {any} */ call) => answer(200, { ...BRANDS[1], ...call.body }),
		});
		const panel = await openTab(root, 'brands');
		expect(rowsOf(panel)).toEqual(['Acme', 'Zed']);
		expect(textOf(panel)).toContain('2 products');
		expect(textOf(detailOf(panel))).toContain('All categories');
		await pick(panel, 'Zed');
		const detail = textOf(detailOf(panel));
		for (const part of ['Hidden', 'Products0', 'Phones', 'Shirts', 'Zed phones']) expect(detail).toContain(part);
		expect(detailOf(panel).querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/l.png');
		search(panel, 'ac');
		expect(rowsOf(panel)).toEqual(['Acme']);
		search(panel, 'zz');
		expect(statuses(panel)).toContain('Nothing matches.');
		search(panel, '');
		await pick(panel, 'Zed');
		await click(buttonIn(detailOf(panel), 'Edit'));
		const dialog = dialogOf(root);
		await change(fieldIn(dialog, 'Status'), 'active');
		await tick(checkIn(dialog, 'Audio'), true);
		await change(fieldIn(dialog, 'Size chart'), '');
		type(fieldIn(dialog, 'Social sharing image'), 'https://cdn.example/s.png');
		await submitDialog(root);
		expect(server.last('PATCH /v1/admin/brands/brd_2')?.body).toEqual({
			name: 'Zed',
			slug: 'zed',
			status: 'active',
			description: '',
			categoryIds: ['cat_a', 'cat_b'],
			seo: {
				title: 'Zed phones',
				description: '',
				canonicalUrl: '',
				ogImage: 'https://cdn.example/s.png',
				noindex: false,
				nofollow: false,
				focusKeyword: '',
				titleMode: 'template',
			},
			sizeChartId: null,
		});
		await click(buttonIn(panel, 'New brand'));
		type(fieldIn(dialogOf(root), 'Name'), 'Nova');
		await submitDialog(root);
		expect(server.last('POST /v1/admin/brands')?.body).toMatchObject({ name: 'Nova', status: 'active', categoryIds: [] });
		expect(server.last('POST /v1/admin/brands')?.body.sizeChartId).toBeNull();
		resetPage();
		const plain = await start(['catalog'], {
			'POST /v1/admin/brands': (/** @type {any} */ call) => answer(201, { id: 'brd_3', ...call.body }),
		});
		const brands = await openTab(plain.root, 'brands');
		await click(buttonIn(brands, 'New brand'));
		type(fieldIn(dialogOf(plain.root), 'Name'), 'Nova');
		await submitDialog(plain.root);
		expect(plain.server.last('POST /v1/admin/brands')?.body.sizeChartId).toBeUndefined();
		resetPage();
		const denied = await start(['catalog'], {
			'GET /v1/admin/brands': () => problem(403, 'forbidden'),
			'GET /v1/admin/products/counts': () => problem(403, 'forbidden'),
		});
		expect(statuses(await openTab(denied.root, 'brands'))).toContain('You are not allowed to do this.');
		resetPage();
		const empty = await start(['catalog'], { 'GET /v1/admin/brands': () => answer(200, { items: [] }) });
		expect(statuses(await openTab(empty.root, 'brands'))).toContain('No brands yet.');
	});

	it('lists, creates, edits and deletes stock locations', async () => {
		const { root, server } = await start(ALL, {
			'POST /v1/admin/locations': (/** @type {any} */ call) => answer(201, { id: 'loc_9', ...call.body }),
			'PATCH /v1/admin/locations/loc_2': (/** @type {any} */ call) => answer(200, { id: 'loc_2', ...call.body }),
			'DELETE /v1/admin/locations/loc_1': () => problem(409, 'conflict'),
		});
		const panel = await openTab(root, 'locations');
		expect(rowsOf(panel)).toEqual(['Shop', 'Store room']);
		expect(textOf(panel)).toContain('Pickup');
		expect(textOf(detailOf(panel))).toContain('Shoppers can pick up hereYes');
		await click(buttonIn(panel, 'New location'));
		type(fieldIn(dialogOf(root), 'Name'), 'Depot');
		await tick(checkIn(dialogOf(root), 'Shoppers can pick up here'), true);
		await submitDialog(root);
		expect(server.last('POST /v1/admin/locations')?.body).toEqual({ name: 'Depot', sort: 0, pickup: true });
		await pick(panel, 'Store room');
		await click(buttonIn(detailOf(panel), 'Edit'));
		type(fieldIn(dialogOf(root), 'Sort order'), '3');
		await submitDialog(root);
		expect(server.last('PATCH /v1/admin/locations/loc_2')?.body).toEqual({ name: 'Store room', sort: 3, pickup: false });
		search(panel, 'shop');
		expect(rowsOf(panel)).toEqual(['Shop']);
		search(panel, 'nothing');
		expect(statuses(panel)).toContain('Nothing matches.');
		search(panel, '');
		await pick(panel, 'Shop');
		await menu(detailOf(panel), 'Delete');
		expect(textOf(dialogOf(root))).toContain('A location that still holds stock cannot be deleted.');
		await confirmDialog(root, 'Shop');
		expect(statuses(dialogOf(root))).toContain(TEXTS['problem.conflict']);
		resetPage();
		const denied = await start(['catalog', 'multi_location'], { 'GET /v1/admin/locations': () => problem(403, 'forbidden') });
		expect(statuses(await openTab(denied.root, 'locations'))).toContain('You are not allowed to do this.');
		resetPage();
		const empty = await start(['catalog', 'multi_location'], { 'GET /v1/admin/locations': () => answer(200, { items: [] }) });
		expect(statuses(await openTab(empty.root, 'locations'))).toContain('No locations yet.');
	});
});

describe('catalog admin: attributes', () => {
	it('shows every attribute field and filters by where values live', async () => {
		const { root } = await start(ALL);
		const panel = await openTab(root, 'attributes');
		expect(rowsOf(panel)).toEqual(ATTRIBUTES.map((item) => item.name));
		expect(textOf(panel)).toContain('Number');
		expect(textOf(panel)).toContain('in · On the product page · Shoppers can filter by it');
		await change(fieldIn(panel, 'Values are on'), 'variant');
		expect(rowsOf(panel)).toEqual(['Storage', 'Bands']);
		const detail = textOf(detailOf(panel));
		for (const part of [
			'On variants',
			'Filter nameattr.storage',
			'Where values showAs chips · Shoppers can filter by it',
			'Categories (none = all)Phones',
			'For brands: Acme',
			'64 GB',
			'How much fits',
			'Bytes.',
			'Q?A.',
		])
			expect(detail).toContain(part);
		await pick(panel, 'Bands');
		expect(textOf(detailOf(panel))).toContain('Inactive');
		expect(textOf(detailOf(panel))).toContain('For grades: Grade A');
		await change(fieldIn(panel, 'Values are on'), '');
		search(panel, 'tag');
		expect(rowsOf(panel)).toEqual(['Tags']);
		await pick(panel, 'Tags');
		expect(textOf(detailOf(panel))).toContain('When Color is Red');
		search(panel, 'zzz');
		expect(statuses(panel)).toContain('Nothing matches.');
		search(panel, 'screen');
		expect(textOf(detailOf(panel))).toContain('Always');
		resetPage();
		const denied = await start(['catalog'], { 'GET /v1/admin/attributes': () => problem(403, 'forbidden') });
		expect(statuses(await openTab(denied.root, 'attributes'))).toContain('You are not allowed to do this.');
		resetPage();
		const empty = await start(['catalog'], { 'GET /v1/admin/attributes': () => answer(200, { items: [] }) });
		expect(statuses(await openTab(empty.root, 'attributes'))).toContain('No fields yet.');
	});

	it('creates and edits attributes: choices, categories, visibility, card display and glossary', async () => {
		const { root, server } = await start(ALL, {
			'POST /v1/admin/attributes': (/** @type {any} */ call) => answer(201, { id: 'att_9', ...call.body }),
			'PATCH /v1/admin/attributes/att_5': (/** @type {any} */ call) =>
				call.body.multiple ? problem(409, 'conflict') : answer(200, { ...ATTRIBUTES[4], ...call.body }),
		});
		const panel = await openTab(root, 'attributes');
		await pick(panel, 'Storage');
		await click(buttonIn(detailOf(panel), 'Edit'));
		let dialog = dialogOf(root);
		expect(fieldIn(dialog, 'Value 1').value).toBe('64');
		expect(fieldIn(dialog, 'Label 1 (empty = value)').value).toBe('64 GB');
		expect(checkIn(dialog, 'Acme').checked).toBe(true);
		await click(buttonIn(dialog, 'Add a choice'));
		type(fieldIn(dialog, 'Value 3'), '256');
		await click(buttonIn(dialog, 'Add a choice'));
		await click(buttonIn(dialog, 'Remove', 0));
		await change(fieldIn(dialog, 'Show it'), 'grades');
		await tick(checkIn(dialog, 'Grade A'), true);
		await change(fieldIn(dialog, 'On product cards'), 'image');
		type(fieldIn(dialog, 'Glossary text'), 'More bytes.');
		await tick(checkIn(dialog, 'Takes several values'), true);
		await submitDialog(root);
		expect(statuses(dialog)).toContain(TEXTS['problem.conflict']);
		await tick(checkIn(dialog, 'Takes several values'), false);
		await submitDialog(root);
		expect(server.last('PATCH /v1/admin/attributes/att_5')?.body).toEqual({
			name: 'Storage',
			slug: 'storage',
			type: 'choice',
			on: 'variant',
			unit: '',
			sort: 4,
			min: null,
			max: null,
			decimals: 0,
			dates: 'any',
			format: null,
			required: false,
			requiredAt: null,
			// a variant field shows in the places variants have (no compare)
			show: { page: false, filter: true, chat: false, card: 'image', feeds: 'none', jsonLd: 'none' },
			multiple: false,
			active: true,
			choices: [
				{ value: '128', label: '128 GB' },
				{ value: '256', label: '256' },
			],
			categoryId: null,
			categoryIds: ['cat_b'],
			visibility: { when: 'grades', ids: ['a'] },
			seo: { title: 'Storage', description: 'How much fits', body: 'More bytes.', faqs: [{ question: 'Q?', answer: 'A.' }] },
		});
		// a new text attribute shown when another attribute has a value
		await click(buttonIn(panel, 'New field'));
		dialog = dialogOf(root);
		expect(textOf(dialog).includes('Add a choice')).toBe(true);
		expect(shows(dialog, 'Add a choice')).toBe(false);
		type(fieldIn(dialog, 'Name'), 'Finish');
		await change(fieldIn(dialog, 'Show it'), 'attribute');
		await change(fieldIn(dialog, 'Field'), 'att_2');
		type(fieldIn(dialog, 'Has the value'), 'Red');
		await tick(checkIn(dialog, 'Phones'), true);
		await change(fieldIn(dialog, 'Definition for'), 'cat_b');
		await submitDialog(root);
		expect(server.last('POST /v1/admin/attributes')?.body).toMatchObject({
			name: 'Finish',
			type: 'text',
			on: 'product',
			choices: [],
			categoryId: 'cat_b',
			categoryIds: ['cat_b'],
			visibility: { when: 'attribute', attributeId: 'att_2', value: 'Red' },
			active: true,
			// a new product field shows on the page and in Chat
			show: { page: true, chat: true, filter: false, compare: false, card: 'none', feeds: 'none', jsonLd: 'none' },
		});
		await click(buttonIn(panel, 'New field'));
		dialog = dialogOf(root);
		type(fieldIn(dialog, 'Name'), 'Size');
		await change(fieldIn(dialog, 'Type'), 'choice');
		expect(shows(dialog, 'Add a choice')).toBe(true);
		await change(fieldIn(dialog, 'Show it'), 'brands');
		await tick(checkIn(dialog, 'Zed'), true);
		await submitDialog(root);
		expect(server.last('POST /v1/admin/attributes')?.body).toMatchObject({
			type: 'choice',
			choices: [],
			visibility: { when: 'brands', ids: ['brd_2'] },
		});
		await click(buttonIn(panel, 'New field'));
		type(fieldIn(dialogOf(root), 'Name'), 'Plain');
		await submitDialog(root);
		expect(server.last('POST /v1/admin/attributes')?.body.visibility).toEqual({ when: 'always' });
	});
});

/**
 * Whether a field or checkbox with this label shows (not inside a hidden part).
 * @param {ParentNode} scope @param {string} text
 */
const labelShown = (scope, text) =>
	[...scope.querySelectorAll('label')].some((label) => label.textContent === text && !label.closest('[hidden]'));

describe('catalog admin: fields of units, orders and customers (dynamic model §2)', () => {
	it('builds a unit field with a format it tries live, and an order field asked at checkout', async () => {
		const { root, server } = await start(ALL, {
			'POST /v1/admin/attributes': (/** @type {any} */ call) => answer(201, { id: 'att_9', ...call.body }),
		});
		const panel = await openTab(root, 'attributes');
		await click(buttonIn(panel, 'New field'));
		let dialog = dialogOf(root);
		type(fieldIn(dialog, 'Name'), 'IMEI');
		await change(fieldIn(dialog, 'Values are on'), 'unit');
		// a unit's places only: no product page, filters or glossary
		expect(labelShown(dialog, 'Shown to the shopper (order fields: asked at checkout)')).toBe(true);
		expect(labelShown(dialog, 'On the product page')).toBe(false);
		expect(labelShown(dialog, 'Glossary text')).toBe(false);
		await tick(checkIn(dialog, 'Check a format'), true);
		await change(fieldIn(dialog, 'Characters'), 'digits');
		await change(fieldIn(dialog, 'Shortest'), '15');
		await change(fieldIn(dialog, 'Longest'), '15');
		await change(fieldIn(dialog, 'Check digit'), 'luhn');
		await tick(checkIn(dialog, 'Spaces are dropped'), true);
		await change(fieldIn(dialog, 'Try a value'), '490154203237519');
		expect(statuses(dialog)).toContain('490154203237519 does not match the format of this field. Its check digit is wrong.');
		await change(fieldIn(dialog, 'Try a value'), '4901 5420 3237 518');
		expect(statuses(dialog)).toContain('490154203237518 matches.');
		await change(fieldIn(dialog, 'Shortest'), '20');
		expect(statuses(dialog)).toContain('Fix the format first: check its lengths, starts and pattern.');
		await change(fieldIn(dialog, 'Shortest'), '15');
		await tick(checkIn(dialog, 'Takes several values'), true);
		expect(fieldIn(dialog, 'Most values').getAttribute('max')).toBe('2');
		type(fieldIn(dialog, 'Most values'), '2');
		await tick(checkIn(dialog, 'Required'), true);
		await tick(checkIn(dialog, 'Shown to the shopper (order fields: asked at checkout)'), true);
		await tick(checkIn(dialog, 'On invoices'), true);
		await submitDialog(root);
		expect(server.last('POST /v1/admin/attributes')?.body).toMatchObject({
			name: 'IMEI',
			on: 'unit',
			type: 'text',
			multiple: true,
			maxValues: 2,
			required: true,
			requiredAt: null,
			format: {
				chars: 'digits',
				minLength: 15,
				maxLength: 15,
				startsWith: [],
				mask: '',
				checkDigit: 'luhn',
				ignoreSpaces: true,
				upperCase: false,
			},
			show: { shopper: true, invoice: true, packingSlip: false },
			visibility: { when: 'always' },
			seo: { title: '', description: '', body: '', faqs: [] },
		});
		await click(buttonIn(panel, 'New field'));
		dialog = dialogOf(root);
		type(fieldIn(dialog, 'Name'), 'Gift message');
		await change(fieldIn(dialog, 'Values are on'), 'order');
		expect(labelShown(dialog, 'Categories (none = all)')).toBe(false);
		expect(labelShown(dialog, 'Required by')).toBe(false);
		await tick(checkIn(dialog, 'Required'), true);
		expect(labelShown(dialog, 'Required by')).toBe(true);
		await change(fieldIn(dialog, 'Required by'), 'checkout');
		await tick(checkIn(dialog, 'Shown to the shopper (order fields: asked at checkout)'), true);
		await submitDialog(root);
		expect(server.last('POST /v1/admin/attributes')?.body).toMatchObject({
			on: 'order',
			required: true,
			requiredAt: 'checkout',
			categoryId: null,
			categoryIds: [],
			show: { shopper: true, invoice: false, packingSlip: false },
		});
		// a customer field is never required
		await click(buttonIn(panel, 'New field'));
		dialog = dialogOf(root);
		await change(fieldIn(dialog, 'Values are on'), 'customer');
		expect(labelShown(dialog, 'Required')).toBe(false);
	});
});

describe('catalog admin: attributes per category (E45)', () => {
	it('shows the category an attribute is the definition for, and names it with it in pickers', async () => {
		const fabric = (/** @type {string} */ id, /** @type {string | null} */ categoryId) => ({
			id,
			name: 'Fabric',
			slug: 'fabric',
			type: 'text',
			unit: '',
			choices: [],
			show: { filter: false, compare: false, card: 'none' },
			sort: 0,
			categoryId,
			categoryIds: [],
			on: 'product',
			multiple: false,
			visibility: { when: 'always', ids: [], attributeId: null, value: null },
			active: true,
			seo: { title: '', description: '', body: '', faqs: [] },
		});
		const { root } = await start(ALL, {
			'GET /v1/admin/attributes': () => answer(200, { items: [fabric('att_f1', null), fabric('att_f2', 'cat_b')] }),
		});
		const panel = await openTab(root, 'attributes');
		// two rows named Fabric: the one for every category, then the one for Phones (its category in the row)
		const rows = /** @type {HTMLElement[]} */ ([...panel.querySelectorAll('li.item')]);
		expect(textOf(/** @type {HTMLElement} */ (rows[1]))).toContain('fabric · Phones');
		await click(/** @type {HTMLElement} */ (rows[1]));
		expect(textOf(detailOf(panel))).toContain('Definition forPhones');
		await click(/** @type {HTMLElement} */ (rows[0]));
		expect(textOf(detailOf(panel))).toContain('Definition forEvery category');
		await click(buttonIn(detailOf(panel), 'Edit'));
		const dialog = dialogOf(root);
		expect(fieldIn(dialog, 'Definition for').value).toBe('');
		await change(fieldIn(dialog, 'Show it'), 'attribute');
		const options = [...fieldIn(dialog, 'Field').querySelectorAll('option')].map((option) => option.textContent);
		expect(options).toContain('Fabric (Phones)');
	});
});

describe('catalog admin: logos and deletions', () => {
	it('uploads a brand logo and deletes a brand, an attribute and a location', async () => {
		const { root, server } = await start(ALL, {
			'POST /v1/admin/catalog/uploads': () =>
				answer(200, { key: 'ecommerce/brands/brd_1/l.png', upload: { url: 'https://bucket.example/logo' } }),
			'PUT /logo': () => answer(200),
			'PUT /v1/admin/brands/brd_1/logo': () =>
				answer(200, { logo: { key: 'l', url: 'https://cdn.example/new.png', alt: 'Acme' } }),
			'DELETE /v1/admin/brands/brd_1': () => answer(204),
			'DELETE /v1/admin/attributes/att_1': () => answer(204),
			'DELETE /v1/admin/locations/loc_2': () => answer(204),
		});
		const brands = await openTab(root, 'brands');
		expect(textOf(detailOf(brands))).toContain('Logo');
		await choose(fieldIn(detailOf(brands), 'Upload an image'), [new window.File(['x'], 'l.png', { type: 'image/png' })]);
		expect(server.last('PUT /v1/admin/brands/brd_1/logo')?.body).toEqual({ key: 'ecommerce/brands/brd_1/l.png', alt: 'Acme' });
		await pick(brands, 'Zed');
		await pick(brands, 'Acme');
		expect(detailOf(brands).querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/new.png');
		server.routes['GET /v1/admin/brands'] = () => answer(200, { items: [BRANDS[1]] });
		await menu(detailOf(brands), 'Delete');
		await confirmDialog(root, 'Acme');
		expect(rowsOf(brands)).toEqual(['Zed']);
		const attributes = await openTab(root, 'attributes');
		server.routes['GET /v1/admin/attributes'] = () => answer(200, { items: ATTRIBUTES.slice(1) });
		await menu(detailOf(attributes), 'Delete');
		await confirmDialog(root, 'Screen');
		expect(rowsOf(attributes)[0]).toBe('Color');
		const locations = await openTab(root, 'locations');
		await pick(locations, 'Store room');
		server.routes['GET /v1/admin/locations'] = () =>
			answer(200, { items: [{ id: 'loc_1', name: 'Shop', pickup: true, sort: 0 }] });
		await menu(detailOf(locations), 'Delete');
		await confirmDialog(root, 'Store room');
		expect(rowsOf(locations)).toEqual(['Shop']);
		expect(hasDialog(root)).toBe(false);
	});
});
