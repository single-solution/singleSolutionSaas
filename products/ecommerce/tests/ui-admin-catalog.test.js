// @vitest-environment jsdom
/* global window */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mountCatalogAdmin } from '../ui/catalog-admin.js';
import {
	BASE,
	answer,
	buttonIn,
	change,
	checkIn,
	choose,
	click,
	fieldIn,
	flush,
	mountWith,
	openTab,
	panelOf,
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

const ALL = [
	'catalog',
	'variants',
	'multi_location',
	'grades_serials',
	'digital_goods',
	'bookings',
	'ai_copy',
	'bulk_actions',
	'returns',
];
const CATEGORIES = [
	{
		id: 'cat_b',
		name: 'Phones',
		slug: 'phones',
		parentId: null,
		path: [],
		sort: 1,
		description: '',
		seo: { title: '', description: '' },
		image: null,
	},
	{
		id: 'cat_a',
		name: 'Audio',
		slug: 'audio',
		parentId: null,
		path: [],
		sort: 0,
		description: '',
		seo: { title: 't', description: 'd' },
		image: { key: 'k', url: 'https://cdn.example/a.png', alt: 'a' },
	},
	{
		id: 'cat_c',
		name: 'Android',
		slug: 'android',
		parentId: 'cat_b',
		path: ['cat_b'],
		sort: 0,
		description: '',
		seo: { title: '', description: '' },
		image: null,
	},
	{
		id: 'cat_x',
		name: 'Lost',
		slug: 'lost',
		parentId: 'cat_gone',
		path: ['cat_gone'],
		sort: 0,
		description: '',
		seo: { title: '', description: '' },
		image: null,
	},
];
const BRANDS = [{ id: 'brd_1', name: 'Acme', slug: 'acme', description: '', logo: null }];
const ATTRIBUTES = [
	{ id: 'att_1', name: 'Screen', type: 'number', unit: 'in', choices: [], filterable: true, comparable: false, sort: 0 },
	{
		id: 'att_2',
		name: 'Colour',
		type: 'choice',
		unit: '',
		choices: ['Red', 'Blue'],
		filterable: false,
		comparable: true,
		sort: 1,
	},
	{ id: 'att_3', name: 'Dual SIM', type: 'boolean', unit: '', choices: [], filterable: false, comparable: false, sort: 2 },
	{ id: 'att_4', name: 'Model', type: 'text', unit: '', choices: [], filterable: false, comparable: false, sort: 3 },
];
const LOCATIONS = [
	{ id: 'loc_1', name: 'Shop', pickup: true, sort: 0 },
	{ id: 'loc_2', name: 'Store room', pickup: false, sort: 1 },
];
const ROW = {
	id: 'prd_1',
	slug: 'phone',
	name: 'Phone',
	kind: 'physical',
	status: 'active',
	price: 125000,
	inStock: true,
	stock: 4,
	trackStock: true,
	variantCount: 2,
	skus: ['P-1', 'P-2'],
	image: null,
};
/** @param {Record<string, unknown>} [over] */
const product = (over = {}) => ({
	id: 'prd_1',
	slug: 'phone',
	name: 'Phone',
	kind: 'physical',
	status: 'active',
	summary: 'Nice',
	description: 'Long',
	categoryIds: ['cat_b'],
	brandId: 'brd_1',
	tags: ['new', 'hot'],
	specs: { att_1: 6.1, att_2: 'Red', att_3: true },
	options: [{ name: 'Colour', values: ['Red', 'Blue'] }],
	variants: [
		{
			id: 'var_1',
			sku: 'P-1',
			options: { Colour: 'Red' },
			price: 125000,
			compareAtPrice: 130000,
			cost: 100000,
			stock: 3,
			locations: { loc_1: 2, loc_2: 1 },
			grade: 'a',
			active: true,
		},
		{
			id: 'var_2',
			sku: 'P-2',
			options: { Colour: 'Blue' },
			price: 126000,
			compareAtPrice: null,
			cost: null,
			stock: 1,
			locations: {},
			grade: null,
			active: false,
		},
	],
	trackStock: true,
	serialized: true,
	digital: null,
	booking: null,
	seo: { title: 'Phone', description: 'A phone' },
	returnDays: 7,
	warrantyDays: null,
	media: [
		{ key: 'ecommerce/products/prd_1/a.jpg', type: 'image/jpeg', size: 10, alt: 'front', url: 'https://cdn.example/a.jpg' },
		{ key: 'ecommerce/products/prd_1/b.jpg', type: 'image/jpeg', size: 10, alt: 'back', url: null },
	],
	...over,
});

/** @param {Record<string, any>} [routes] */
const lists = (routes = {}) => ({
	'GET /v1/admin/categories': () => answer(200, { items: CATEGORIES }),
	'GET /v1/admin/brands': () => answer(200, { items: BRANDS }),
	'GET /v1/admin/attributes': () => answer(200, { items: ATTRIBUTES }),
	'GET /v1/admin/locations': () => answer(200, { items: LOCATIONS }),
	'GET /v1/admin/products': (/** @type {any} */ call) =>
		call.url.searchParams.get('cursor')
			? answer(200, {
					items: [{ ...ROW, id: 'prd_2', name: 'Case', trackStock: false, skus: [] }],
					nextCursor: null,
					hasMore: false,
				})
			: answer(200, { items: [ROW], nextCursor: 'c2', hasMore: true }),
	...routes,
});

const SETTINGS = { catalog: { grades: [{ key: 'a', label: 'Grade A' }] } };

/** @param {string[]} [features] @param {Record<string, any>} [routes] @param {Record<string, any>} [settings] */
const start = (features = ALL, routes = {}, settings = SETTINGS) =>
	mountWith(mountCatalogAdmin, { features, settings, routes: lists(routes) });

describe('catalog admin: products', () => {
	it('lists products with filters, Load more and the signed-out line', async () => {
		const { host, root, server, tickets } = await start();
		expect(host.getAttribute('data-ss-mounted')).toBe('catalog-admin');
		const panel = panelOf(root, 'products');
		expect(textOf(panel)).toContain('Phone');
		expect(textOf(panel)).toContain('PKR 1,250.00');
		expect(textOf(panel)).toContain('4 in stock');
		await click(buttonIn(panel, 'Load more'));
		expect(textOf(panel)).toContain('Stock not tracked');
		type(fieldIn(panel, 'Search'), 'pho');
		await submit(fieldIn(panel, 'Search'));
		await change(fieldIn(panel, 'Status'), 'active');
		await change(fieldIn(panel, 'Category'), 'cat_b');
		await change(fieldIn(panel, 'Brand'), 'brd_1');
		await tick(checkIn(panel, 'Low stock only'), true);
		const last = server.last('GET /v1/admin/products')?.url.searchParams;
		expect(Object.fromEntries(last ?? [])).toEqual({
			q: 'pho',
			status: 'active',
			category: 'cat_b',
			brand: 'brd_1',
			lowStock: 'true',
		});
		expect(server.last('GET /v1/admin/products')?.headers.authorization).toBe('Bearer t1');
		const category = /** @type {HTMLSelectElement} */ (fieldIn(panel, 'Category'));
		expect([...category.options].map((o) => o.textContent)).toEqual(['All', 'Audio', 'Phones', '— Android', 'Lost']);
		tickets.emit(false);
		expect(statuses(root)).toContain('Signed out. Sign in again to keep working.');
		tickets.emit(true);
		expect(statuses(root)).not.toContain('Signed out. Sign in again to keep working.');
	});

	it('shows not allowed, unreachable and signed-out answers', async () => {
		const denied = await start(['catalog'], { 'GET /v1/admin/products': () => problem(403, 'no') });
		expect(statuses(denied.root)).toContain('You are not allowed to do this.');
		expect(denied.root.querySelector('[role="tablist"]')?.hasAttribute('hidden')).toBe(false);
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
			'GET /v1/admin/categories': () => problem(403, 'no'),
		});
		expect(statuses(empty.root)).toContain('No products match.');
		resetPage();
		const plain = await start(['catalog'], {
			'GET /v1/admin/products': () => answer(500, { errors: [{ message: 'Bad thing.' }] }),
		});
		expect(statuses(plain.root)).toContain('Bad thing.');
		resetPage();
		const nothing = await start(['catalog'], { 'GET /v1/admin/products': () => answer(500, null) });
		expect(statuses(nothing.root)).toContain('Something went wrong. Please try again.');
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
		await click(buttonIn(panel, 'Apply to selected'));
		expect(statuses(panel)).toContain('Select at least one first.');
		const pick = /** @type {HTMLInputElement} */ (panel.querySelector('input[aria-label="Select Phone"]'));
		await tick(pick, true);
		await tick(pick, false);
		await tick(pick, true);
		await change(fieldIn(panel, 'Status', 1), 'archived');
		await click(buttonIn(panel, 'Apply to selected'));
		expect(statuses(panel)).toContain('Changed 1 of 1 products.');
		await tick(/** @type {HTMLInputElement} */ (panel.querySelector('input[aria-label="Select Phone"]')), true);
		await change(fieldIn(panel, 'Change'), 'price');
		type(fieldIn(panel, 'Percent (−10 = 10 % less)'), '-10');
		await click(buttonIn(panel, 'Apply to selected'));
		await tick(/** @type {HTMLInputElement} */ (panel.querySelector('input[aria-label="Select Phone"]')), true);
		await change(fieldIn(panel, 'Change'), 'stock');
		type(fieldIn(panel, 'Units'), '5');
		await change(fieldIn(panel, 'Location'), 'loc_2');
		await click(buttonIn(panel, 'Apply to selected'));
		await tick(/** @type {HTMLInputElement} */ (panel.querySelector('input[aria-label="Select Phone"]')), true);
		await change(fieldIn(panel, 'Change'), 'add_category');
		await change(fieldIn(panel, 'Category', 1), 'cat_c');
		reply = () => problem(422, 'Pick an existing category.');
		await click(buttonIn(panel, 'Apply to selected'));
		expect(statuses(panel)).toContain('Pick an existing category.');
		expect(sent).toEqual([
			{ ids: ['prd_1'], action: 'status', status: 'archived' },
			{ ids: ['prd_1'], action: 'price', price: { mode: 'percent', value: -10 } },
			{ ids: ['prd_1'], action: 'stock', stock: 5, locationId: 'loc_2' },
			{ ids: ['prd_1'], action: 'add_category', categoryId: 'cat_c' },
		]);
	});

	it('edits a product: fields, variants, AI copy, save and back', async () => {
		/** @type {any[]} */
		const patches = [];
		let ai = () => answer(200, { suggestions: { summary: 'AI summary', seoTitle: 'AI title' } });
		const { root, server } = await start(ALL, {
			'GET /v1/admin/products/prd_1': () => answer(200, product()),
			'PATCH /v1/admin/products/prd_1': (/** @type {any} */ call) => {
				patches.push(call.body);
				return patches.length === 1
					? problem(422, 'Another product already uses this slug.')
					: answer(200, product({ name: 'Phone 2' }));
			},
			'POST /v1/admin/products/prd_1/ai-copy': () => ai(),
		});
		const panel = panelOf(root, 'products');
		await click(buttonIn(panel, 'Edit'));
		expect(textOf(panel)).toContain('Edit Phone');
		expect(fieldIn(panel, 'Name').value).toBe('Phone');
		expect(fieldIn(panel, 'Tags (comma separated)').value).toBe('new, hot');
		expect(fieldIn(panel, 'Screen (in)').value).toBe('6.1');
		expect(textOf(panel)).toContain('2 at Shop, 1 at Store room');
		expect(/** @type {HTMLSelectElement} */ (panel.querySelector('select[aria-label="Grade of Red"]')).value).toBe('a');
		// AI copy fills the fields
		await click(buttonIn(panel, 'Write with AI'));
		expect(fieldIn(panel, 'Summary').value).toBe('AI summary');
		expect(fieldIn(panel, 'Page title').value).toBe('AI title');
		expect(statuses(panel)).toContain('Suggestions are filled in. Check them, then save.');
		ai = () => problem(503, 'Connect your AI provider first (Connections).');
		await click(buttonIn(panel, 'Write with AI'));
		expect(statuses(panel)).toContain('Connect your AI provider first (Connections).');
		// specs and the kind
		await change(fieldIn(panel, 'Colour'), '');
		await change(fieldIn(panel, 'Dual SIM'), 'false');
		type(fieldIn(panel, 'Model'), 'X1');
		await change(fieldIn(panel, 'Kind'), 'digital');
		expect(shows(panel, 'Save')).toBe(true);
		expect(fieldIn(panel, 'Downloads allowed (0 = no limit)').value).toBe('0');
		await change(fieldIn(panel, 'Kind'), 'booking');
		type(fieldIn(panel, 'Duration in minutes'), '30');
		// variants: a third value makes a new row with stock per location
		type(fieldIn(panel, 'Option 1 values (comma separated)'), 'Red, Blue, Green');
		await click(buttonIn(panel, 'Make variants from the options'));
		type(panel.querySelector('input[aria-label="Stock at Shop"]'), '4');
		type(panel.querySelector('input[aria-label="Price of Green"]'), '99.5');
		type(panel.querySelector('input[aria-label="Was price of Green"]'), 'abc');
		await click(buttonIn(panel, 'Save'));
		expect(statuses(panel)).toContain('Check the amounts and numbers you typed.');
		type(panel.querySelector('input[aria-label="Was price of Green"]'), '');
		type(fieldIn(panel, 'Return days (empty = default)'), '1.5');
		await click(buttonIn(panel, 'Save'));
		expect(patches).toHaveLength(0);
		type(fieldIn(panel, 'Return days (empty = default)'), '');
		await click(buttonIn(panel, 'Save'));
		expect(statuses(panel)).toContain('Another product already uses this slug.');
		const body = patches[0];
		expect(body.specs).toEqual({ att_1: 6.1, att_3: false, att_4: 'X1' });
		expect(body.kind).toBe('booking');
		expect(body.booking).toEqual({ durationMinutes: 30 });
		expect(body.returnDays).toBeNull();
		expect(body.options).toEqual([{ name: 'Colour', values: ['Red', 'Blue', 'Green'] }]);
		expect(body.variants[2]).toEqual({
			sku: '',
			options: { Colour: 'Green' },
			price: 9950,
			compareAtPrice: null,
			cost: null,
			active: true,
			grade: null,
			locations: { loc_1: 4, loc_2: 0 },
		});
		expect(body.variants[0]).toMatchObject({ id: 'var_1', price: 125000, compareAtPrice: 130000, cost: 100000, grade: 'a' });
		expect(body.variants[0].stock).toBeUndefined();
		// remove a row, then save
		await click(buttonIn(panel, 'Remove', 2));
		await change(fieldIn(panel, 'Kind'), 'digital');
		await tick(checkIn(panel, 'Give a licence key per unit'), true);
		await click(buttonIn(panel, 'Save'));
		expect(patches[1].variants).toHaveLength(2);
		expect(patches[1].digital).toEqual({ licenceKeys: true, downloadLimit: 0 });
		expect(statuses(panel)).toContain('Saved.');
		expect(textOf(panel)).toContain('Edit Phone 2');
		const lists = server.all('GET /v1/admin/products').length;
		await click(buttonIn(panel, 'Back'));
		expect(server.all('GET /v1/admin/products').length).toBe(lists + 1);
	});

	it('creates a product without variants, with the single price and stock', async () => {
		/** @type {any[]} */
		const posts = [];
		const { root } = await start(['catalog'], {
			'POST /v1/admin/products': (/** @type {any} */ call) => {
				posts.push(call.body);
				return answer(
					201,
					product({
						id: 'prd_9',
						name: 'Mug',
						options: [],
						variants: [{ ...product().variants[0], options: {}, locations: {} }],
						media: [],
					}),
				);
			},
		});
		const panel = panelOf(root, 'products');
		await click(buttonIn(panel, 'New product'));
		expect(textOf(panel)).toContain('New product');
		type(fieldIn(panel, 'Name'), 'Mug');
		type(panel.querySelector('input[aria-label="Price of Default"]'), '');
		await click(buttonIn(panel, 'Save'));
		expect(statuses(panel)).toContain('Check the amounts and numbers you typed.');
		type(panel.querySelector('input[aria-label="Price of Default"]'), '0');
		type(panel.querySelector('input[aria-label="Stock of Default"]'), '7');
		await tick(checkIn(panel, 'Track stock'), false);
		await click(buttonIn(panel, 'Save'));
		expect(posts[0]).toMatchObject({
			name: 'Mug',
			kind: 'physical',
			status: 'draft',
			trackStock: false,
			variants: [{ sku: '', options: {}, price: 0, compareAtPrice: null, cost: null, active: true, stock: 7 }],
		});
		expect(posts[0].options).toBeUndefined();
		expect(posts[0].serialized).toBeUndefined();
		expect(textOf(panel)).toContain('Edit Mug');
		expect(textOf(panel)).toContain('Change stock');
		await click(buttonIn(panel, 'Back'));
		expect(textOf(panel)).toContain('Phone');
	});

	it('handles images, stock changes, deletion and a missing product', async () => {
		let stock = () => answer(200, product({ name: 'Restocked' }));
		/** @type {any[]} */
		const puts = [];
		const { root, server } = await start(ALL, {
			'GET /v1/admin/products/prd_1': () => answer(200, product()),
			'GET /v1/admin/products/prd_2': () => problem(404, 'There is no such product.'),
			'POST /v1/admin/products/prd_1/stock': () => stock(),
			'PUT /v1/admin/products/prd_1/media': (/** @type {any} */ call) => {
				puts.push(call.body);
				return answer(200, { media: call.body.items.map((/** @type {any} */ item) => ({ ...item, url: null })) });
			},
			'DELETE /v1/admin/products/prd_1/media': (/** @type {any} */ call) =>
				call.url.searchParams.get('key')?.endsWith('b.jpg')
					? answer(200, { media: [product().media[0]] })
					: problem(404, 'The product has no such image.'),
			'POST /v1/admin/catalog/uploads': (/** @type {any} */ call) =>
				call.body.type === 'image/gif'
					? problem(422, 'Images are JPEG, PNG, WebP or AVIF.')
					: answer(200, {
							key: 'ecommerce/products/prd_1/c.png',
							upload: { method: 'PUT', url: 'https://bucket.example/up', headers: { 'content-type': call.body.type } },
						}),
			'PUT /up': () => answer(200),
			'POST /v1/admin/products/prd_1/media': () =>
				answer(200, { media: [...product().media, { key: 'c', url: 'https://cdn.example/c.png', alt: '' }] }),
			'DELETE /v1/admin/products/prd_1': () => answer(204),
		});
		const panel = panelOf(root, 'products');
		await click(buttonIn(panel, 'Edit'));
		// images
		await click(buttonIn(panel, 'Later'));
		await click(buttonIn(panel, 'Earlier'));
		await click(buttonIn(panel, 'Later'));
		type(fieldIn(panel, 'Text of image 1'), 'rear');
		await click(buttonIn(panel, 'Save order and texts'));
		expect(puts[0].items).toEqual([
			{ key: 'ecommerce/products/prd_1/b.jpg', alt: 'rear' },
			{ key: 'ecommerce/products/prd_1/a.jpg', alt: 'front' },
		]);
		await click(buttonIn(panel, 'Remove', 2));
		await click(buttonIn(panel, 'Confirm remove'));
		expect(panel.querySelectorAll('.thumbs figure')).toHaveLength(1);
		await click(buttonIn(panel, 'Remove', 2));
		await click(buttonIn(panel, 'Confirm remove'));
		expect(statuses(panel)).toContain('The product has no such image.');
		const picker = fieldIn(panel, 'Add images');
		await choose(picker, [new window.File(['x'], 'c.png', { type: 'image/png' })]);
		expect(panel.querySelectorAll('.thumbs figure')).toHaveLength(3);
		expect(server.last('PUT /up')?.headers['content-type']).toBe('image/png');
		await choose(picker, [new window.File(['x'], 'c.gif', { type: 'image/gif' })]);
		expect(statuses(panel)).toContain('Images are JPEG, PNG, WebP or AVIF.');
		server.routes['PUT /up'] = () => answer(403);
		await choose(picker, [new window.File(['x'], 'c.png', { type: 'image/png' })]);
		expect(statuses(panel)).toContain('The file could not be uploaded. Please try again.');
		server.routes['PUT /up'] = () => {
			throw new Error('offline');
		};
		await choose(picker, [new window.File(['x'], 'c.png', { type: 'image/png' })]);
		expect(statuses(panel)).toContain('The file could not be uploaded. Please try again.');
		server.routes['PUT /up'] = () => answer(200);
		server.routes['POST /v1/admin/products/prd_1/media'] = () => problem(422, 'The file has not been uploaded.');
		await choose(picker, [new window.File(['x'], 'c.png', { type: 'image/png' })]);
		expect(statuses(panel)).toContain('The file has not been uploaded.');
		server.routes['PUT /v1/admin/products/prd_1/media'] = () => problem(422, 'List every image of the product once.');
		await click(buttonIn(panel, 'Save order and texts'));
		expect(statuses(panel)).toContain('List every image of the product once.');
		// stock
		await click(buttonIn(panel, 'Change stock'));
		expect(statuses(panel)).toContain('Check the amounts and numbers you typed.');
		type(fieldIn(panel, 'Units'), '-2');
		await change(fieldIn(panel, 'Location'), 'loc_2');
		await change(fieldIn(panel, 'How'), 'set');
		await click(buttonIn(panel, 'Change stock'));
		expect(server.last('POST /v1/admin/products/prd_1/stock')?.body).toEqual({
			changes: [{ variantId: 'var_1', set: -2, locationId: 'loc_2' }],
		});
		expect(statuses(panel)).toContain('Stock changed.');
		expect(textOf(panel)).toContain('Edit Restocked');
		stock = () => problem(409, 'Stock cannot go below 0.');
		type(fieldIn(panel, 'Units'), '-20');
		await click(buttonIn(panel, 'Change stock'));
		expect(statuses(panel)).toContain('Stock cannot go below 0.');
		// delete
		server.routes['DELETE /v1/admin/products/prd_1'] = () => problem(409, 'This product is in orders: archive it instead.');
		await click(buttonIn(panel, 'Delete'));
		await click(buttonIn(panel, 'Confirm delete'));
		expect(statuses(panel)).toContain('This product is in orders: archive it instead.');
		server.routes['DELETE /v1/admin/products/prd_1'] = () => answer(204);
		await click(buttonIn(panel, 'Delete'));
		await click(buttonIn(panel, 'Confirm delete'));
		expect(textOf(panel)).toContain('New product');
		// a product that is gone
		server.routes['GET /v1/admin/products'] = () =>
			answer(200, { items: [{ ...ROW, id: 'prd_2' }], nextCursor: null, hasMore: false });
		await submit(fieldIn(panel, 'Search'));
		await click(buttonIn(panel, 'Edit'));
		expect(statuses(panel)).toContain('There is no such product.');
	});

	it('adds licence keys and files to a digital product', async () => {
		const digital = product({
			kind: 'digital',
			options: [],
			variants: [{ ...product().variants[0], options: {}, locations: {} }],
			trackStock: false,
			digital: {
				files: [{ key: 'ecommerce/digital/prd_1/manual.pdf', type: 'application/pdf', size: 2048, alt: '' }],
				licenceKeys: true,
				downloadLimit: 3,
			},
			media: [],
		});
		let keys = () => answer(200, { added: 2, available: 5 });
		const { root, server } = await start(['catalog', 'digital_goods'], {
			'GET /v1/admin/products/prd_1': () => answer(200, digital),
			'POST /v1/admin/products/prd_1/licences': () => keys(),
			'POST /v1/admin/products/prd_1/files': (/** @type {any} */ call) =>
				answer(200, {
					file: { name: call.body.name, type: call.body.type, size: call.body.size },
					upload: { url: 'https://bucket.example/file' },
				}),
			'PUT /file': () => answer(200),
		});
		const panel = panelOf(root, 'products');
		await click(buttonIn(panel, 'Edit'));
		expect(textOf(panel)).toContain('manual.pdf (2 KB)');
		expect(textOf(panel)).not.toContain('Change stock');
		type(fieldIn(panel, 'Licence keys (one per line)'), 'K1\n\nK2\n');
		await click(buttonIn(panel, 'Add licence keys'));
		expect(server.last('POST /v1/admin/products/prd_1/licences')?.body).toEqual({ keys: ['K1', 'K2'] });
		expect(statuses(panel)).toContain('2 keys added; 5 available.');
		keys = () => problem(422, 'keys is a list of licence keys.');
		await click(buttonIn(panel, 'Add licence keys'));
		expect(statuses(panel)).toContain('keys is a list of licence keys.');
		const picker = fieldIn(panel, 'Add a file');
		await choose(picker, []);
		await choose(picker, [new window.File(['abc'], 'My Guide.pdf', { type: '' })]);
		expect(server.last('POST /v1/admin/products/prd_1/files')?.body).toEqual({
			name: 'My-Guide.pdf',
			type: 'application/octet-stream',
			size: 3,
		});
		expect(statuses(panel)).toContain('My-Guide.pdf uploaded.');
		await choose(picker, [new window.File(['abc'], '...', { type: 'text/plain' })]);
		expect(server.last('POST /v1/admin/products/prd_1/files')?.body.name).toBe('file');
		server.routes['PUT /file'] = () => answer(500);
		await choose(picker, [new window.File(['abc'], 'a.txt', { type: 'text/plain' })]);
		expect(statuses(panel)).toContain('The file could not be uploaded. Please try again.');
		server.routes['POST /v1/admin/products/prd_1/files'] = () =>
			problem(503, 'Connect storage in the product dashboard first.');
		await choose(picker, [new window.File(['abc'], 'a.txt', { type: 'text/plain' })]);
		expect(statuses(panel)).toContain('Connect storage in the product dashboard first.');
	});
});

describe('catalog admin: lists', () => {
	it('edits the category tree with images', async () => {
		/** @type {any[]} */
		const bodies = [];
		const { root, server } = await start(['catalog'], {
			'POST /v1/admin/categories': (/** @type {any} */ call) => {
				bodies.push(call.body);
				return call.body.name
					? answer(201, { ...CATEGORIES[0], id: 'cat_n', name: call.body.name })
					: problem(422, 'Give the category a name.');
			},
			'PATCH /v1/admin/categories/cat_a': (/** @type {any} */ call) => answer(200, { ...CATEGORIES[1], ...call.body }),
			'DELETE /v1/admin/categories/cat_a': () => problem(409, 'Products are in this category: move them first.'),
			'DELETE /v1/admin/categories/cat_c': () => answer(204),
			'POST /v1/admin/catalog/uploads': () =>
				answer(200, { key: 'ecommerce/categories/cat_a/x.png', upload: { url: 'https://bucket.example/cat' } }),
			'PUT /cat': () => answer(200),
			'PUT /v1/admin/categories/cat_a/image': () =>
				answer(200, { image: { key: 'x', url: 'https://cdn.example/x.png', alt: 'Audio' } }),
			'DELETE /v1/admin/categories/cat_a/image': () => answer(200, { image: null }),
		});
		const panel = await openTab(root, 'categories');
		const names = [...panel.querySelectorAll('.rows strong')].map((node) => node.textContent);
		expect(names).toEqual(['Audio', 'Phones', 'Android', 'Lost']);
		await click(buttonIn(panel, 'New category'));
		await click(buttonIn(panel, 'Save'));
		expect(statuses(panel)).toContain('Give the category a name.');
		type(fieldIn(panel, 'Name'), 'Cables');
		await change(fieldIn(panel, 'Inside'), 'cat_b');
		type(fieldIn(panel, 'Sort order'), 'x');
		await click(buttonIn(panel, 'Save'));
		expect(bodies[1]).toEqual({
			name: 'Cables',
			slug: '',
			parentId: 'cat_b',
			description: '',
			seo: { title: '', description: '' },
			sort: 0,
		});
		expect(statuses(panel)).toContain('Saved.');
		await click(buttonIn(panel, 'Close'));
		await click(buttonIn(panel, 'Edit'));
		expect(fieldIn(panel, 'Page title').value).toBe('t');
		const parents = [...fieldIn(panel, 'Inside').options].map((/** @type {any} */ o) => o.value);
		expect(parents).not.toContain('cat_a');
		expect(panel.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/a.png');
		type(fieldIn(panel, 'Meta description'), 'New text');
		await click(buttonIn(panel, 'Save'));
		expect(server.last('PATCH /v1/admin/categories/cat_a')?.body.seo).toEqual({ title: 't', description: 'New text' });
		await choose(fieldIn(panel, 'Upload an image'), []);
		await choose(fieldIn(panel, 'Upload an image'), [new window.File(['x'], 'x.png', { type: 'image/png' })]);
		expect(server.last('PUT /v1/admin/categories/cat_a/image')?.body).toEqual({
			key: 'ecommerce/categories/cat_a/x.png',
			alt: 'Audio',
		});
		expect(panel.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/x.png');
		await click(buttonIn(panel, 'Remove image'));
		expect(panel.querySelector('.thumbs img')).toBeNull();
		server.routes['DELETE /v1/admin/categories/cat_a/image'] = () => problem(403, 'no');
		await click(buttonIn(panel, 'Remove image'));
		expect(statuses(panel)).toContain('You are not allowed to do this.');
		expect(buttonIn(panel, 'Remove image').disabled).toBe(true);
		server.routes['PUT /v1/admin/categories/cat_a/image'] = () =>
			problem(422, 'The file is not an image of an allowed type and size.');
		await choose(fieldIn(panel, 'Upload an image'), [new window.File(['x'], 'x.png', { type: 'image/png' })]);
		expect(statuses(panel)).toContain('The file is not an image of an allowed type and size.');
		server.routes['PUT /cat'] = () => answer(500);
		await choose(fieldIn(panel, 'Upload an image'), [new window.File(['x'], 'x.png', { type: 'image/png' })]);
		expect(statuses(panel)).toContain('The file could not be uploaded. Please try again.');
		server.routes['POST /v1/admin/catalog/uploads'] = () => problem(503, 'Connect your storage first (Connections).');
		await choose(fieldIn(panel, 'Upload an image'), [new window.File(['x'], 'x.png', { type: 'image/png' })]);
		expect(statuses(panel)).toContain('Connect your storage first (Connections).');
		await click(buttonIn(panel, 'Delete'));
		await click(buttonIn(panel, 'Confirm delete'));
		expect(statuses(panel)).toContain('Products are in this category: move them first.');
		await click(buttonIn(panel, 'Edit', 2));
		await click(buttonIn(panel, 'Delete'));
		await click(buttonIn(panel, 'Confirm delete'));
		expect(statuses(panel)).toContain('Deleted.');
		server.routes['GET /v1/admin/categories'] = () => problem(403, 'no');
		await click(buttonIn(panel, 'New category'));
		type(fieldIn(panel, 'Name'), 'X');
		await click(buttonIn(panel, 'Save'));
		expect(statuses(panel)).toContain('You are not allowed to do this.');
	});

	it('edits brands, attributes and locations', async () => {
		const { root, server } = await start(ALL, {
			'POST /v1/admin/brands': (/** @type {any} */ call) => answer(201, { id: 'brd_2', ...call.body, logo: null }),
			'POST /v1/admin/attributes': (/** @type {any} */ call) => answer(201, { id: 'att_9', ...call.body }),
			'PATCH /v1/admin/attributes/att_2': (/** @type {any} */ call) => answer(200, { ...ATTRIBUTES[1], ...call.body }),
			'POST /v1/admin/locations': (/** @type {any} */ call) => answer(201, { id: 'loc_9', ...call.body }),
		});
		let panel = await openTab(root, 'brands');
		expect(textOf(panel)).toContain('Acme');
		await click(buttonIn(panel, 'New brand'));
		type(fieldIn(panel, 'Name'), 'Zed');
		await click(buttonIn(panel, 'Save'));
		expect(server.last('POST /v1/admin/brands')?.body).toEqual({ name: 'Zed', slug: '', description: '' });
		expect(textOf(panel)).toContain('Upload an image');

		panel = await openTab(root, 'attributes');
		expect(textOf(panel)).toContain('Number · in · Shoppers can filter by it');
		await click(buttonIn(panel, 'New attribute'));
		type(fieldIn(panel, 'Name'), 'Size');
		await change(fieldIn(panel, 'Type'), 'choice');
		type(fieldIn(panel, 'Choices (comma separated)'), 'S, M,, L');
		await tick(checkIn(panel, 'Shoppers can filter by it'), true);
		await click(buttonIn(panel, 'Save'));
		expect(server.last('POST /v1/admin/attributes')?.body).toEqual({
			name: 'Size',
			type: 'choice',
			choices: ['S', 'M', 'L'],
			unit: '',
			sort: 0,
			filterable: true,
			comparable: false,
		});
		await click(buttonIn(panel, 'Close'));
		await click(buttonIn(panel, 'Edit', 1));
		await change(fieldIn(panel, 'Type'), 'text');
		await click(buttonIn(panel, 'Save'));
		expect(server.last('PATCH /v1/admin/attributes/att_2')?.body.choices).toEqual([]);

		panel = await openTab(root, 'locations');
		expect(textOf(panel)).toContain('Shoppers can pick up here');
		await click(buttonIn(panel, 'New location'));
		type(fieldIn(panel, 'Name'), 'Depot');
		await tick(checkIn(panel, 'Shoppers can pick up here'), true);
		await click(buttonIn(panel, 'Save'));
		expect(server.last('POST /v1/admin/locations')?.body).toEqual({ name: 'Depot', sort: 0, pickup: true });
	});

	it('lists, marks and adds serial numbers', async () => {
		const serial = { id: 'ser_1', productId: 'prd_1', variantId: 'var_1', serial: 'IMEI1', status: 'in_stock', orderId: null };
		let added = () => answer(201, { items: [{ id: 'ser_2' }, { id: 'ser_3' }] });
		const { root, server } = await start(ALL, {
			'GET /v1/admin/serials': () =>
				answer(200, {
					items: [
						serial,
						{ ...serial, id: 'ser_4', serial: 'IMEI4', status: 'sold', orderId: 'ord_1' },
						{ ...serial, id: 'ser_5', serial: 'IMEI5', status: 'faulty' },
					],
					nextCursor: null,
					hasMore: false,
				}),
			'PATCH /v1/admin/serials/ser_1': (/** @type {any} */ call) => answer(200, { ...serial, status: call.body.status }),
			'PATCH /v1/admin/serials/ser_5': () => problem(409, 'This unit was sold.'),
			'DELETE /v1/admin/serials/ser_1': () => answer(204),
			'DELETE /v1/admin/serials/ser_5': () => problem(409, 'This unit was sold: it cannot be deleted.'),
			'GET /v1/admin/products/prd_1': () => answer(200, product()),
			'GET /v1/admin/products/prd_x': () => problem(404, 'There is no such product.'),
			'POST /v1/admin/serials': () => added(),
		});
		const panel = await openTab(root, 'serials');
		expect(textOf(panel)).toContain('IMEI4');
		expect(textOf(panel)).toContain('Sold · prd_1 · ord_1');
		await click(buttonIn(panel, 'Mark faulty'));
		expect(server.last('PATCH /v1/admin/serials/ser_1')?.body).toEqual({ status: 'faulty' });
		await click(buttonIn(panel, 'Back in stock', 1));
		expect(statuses(panel)).toContain('This unit was sold.');
		await click(buttonIn(panel, 'Delete', 1));
		await click(buttonIn(panel, 'Confirm delete'));
		expect(statuses(panel)).toContain('This unit was sold: it cannot be deleted.');
		await click(buttonIn(panel, 'Delete'));
		await click(buttonIn(panel, 'Confirm delete'));
		expect(textOf(panel)).not.toContain('IMEI1');
		type(fieldIn(panel, 'Search'), 'IME');
		await submit(fieldIn(panel, 'Search'));
		await change(fieldIn(panel, 'Status'), 'faulty');
		expect(Object.fromEntries(server.last('GET /v1/admin/serials')?.url.searchParams ?? [])).toEqual({
			q: 'IME',
			status: 'faulty',
			limit: '50',
		});
		// add many
		type(fieldIn(panel, 'Find a product'), 'pho');
		await click(buttonIn(panel, 'Find'));
		await change(fieldIn(panel, 'Product'), 'prd_1');
		expect([...fieldIn(panel, 'Variant').options].map((/** @type {any} */ o) => o.textContent)).toEqual(['Red', 'Blue']);
		await change(fieldIn(panel, 'Location'), 'loc_1');
		type(fieldIn(panel, 'Serial numbers (one per line)'), 'A1\nA2, A3');
		added = () => problem(409, 'These serial numbers are already recorded: A1.');
		await click(buttonIn(panel, 'Add serial numbers'));
		expect(statuses(panel)).toContain('These serial numbers are already recorded: A1.');
		added = () => answer(201, { items: [{ id: 'ser_2' }, { id: 'ser_3' }] });
		await click(buttonIn(panel, 'Add serial numbers'));
		expect(server.last('POST /v1/admin/serials')?.body).toEqual({
			productId: 'prd_1',
			variantId: 'var_1',
			serials: ['A1', 'A2', 'A3'],
			locationId: 'loc_1',
		});
		expect(statuses(panel)).toContain('2 serial numbers added.');
		await change(fieldIn(panel, 'Location'), '');
		await click(buttonIn(panel, 'Add serial numbers'));
		expect(server.last('POST /v1/admin/serials')?.body.locationId).toBeUndefined();
		await change(fieldIn(panel, 'Product'), '');
		server.routes['GET /v1/admin/products'] = () =>
			answer(200, { items: [{ ...ROW, id: 'prd_x' }], nextCursor: null, hasMore: false });
		await click(buttonIn(panel, 'Find'));
		await change(fieldIn(panel, 'Product'), 'prd_x');
		expect(statuses(panel)).toContain('There is no such product.');
		server.routes['GET /v1/admin/products'] = () => problem(403, 'no');
		await click(buttonIn(panel, 'Find'));
		expect(statuses(panel)).toContain('You are not allowed to do this.');
		await flush();
		expect(BASE).toContain('https://');
	});
});
