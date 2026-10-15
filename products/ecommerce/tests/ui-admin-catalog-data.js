/* global window */
/**
 * Fixtures and finders of the catalog admin widget tests (jsdom): the catalog's lists, a product row and a whole
 * product, mounting the widget with a fake server, and finders for list rows, the detail pane, More menus and dialogs.
 * @module
 */
import { mountCatalogAdmin } from '../ui/catalog-admin.js';
import { answer, click, flush, mountWith } from './ui-admin-helpers.js';

export const ALL = Object.freeze([
	'catalog',
	'variants',
	'multi_location',
	'grades_serials',
	'digital_goods',
	'bookings',
	'ai_copy',
	'bulk_actions',
	'returns',
	'size_charts',
	'landing_pages',
]);

export const CATEGORIES = [
	{
		id: 'cat_b',
		name: 'Phones',
		slug: 'phones',
		parentId: null,
		path: [],
		sort: 1,
		description: 'All phones',
		seo: { title: '', description: '' },
		image: null,
		status: 'active',
		icon: 'phone',
		content: {
			summary: 'Great phones',
			bullets: [
				{ text: 'Fast', icon: 'bolt' },
				{ text: 'Light', icon: '' },
			],
		},
		faqs: [{ question: 'Unlocked?', answer: 'Yes.' }],
		sizeChartId: null,
		typeKey: 'used_phone',
		previousSlugs: ['mobiles'],
	},
	{
		id: 'cat_a',
		name: 'Audio',
		slug: 'audio',
		parentId: null,
		path: [],
		sort: 0,
		description: '',
		seo: { title: 't', description: 'd', canonicalUrl: '/audio', noindex: true },
		image: { key: 'k', url: 'https://cdn.example/a.png', alt: 'a' },
		status: 'coming_soon',
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
		status: 'hidden',
		typeKey: 'physical',
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
export const BRANDS = [
	{ id: 'brd_1', name: 'Acme', slug: 'acme', description: 'Makers', logo: null, status: 'active', categoryIds: [], seo: {} },
	{
		id: 'brd_2',
		name: 'Zed',
		slug: 'zed',
		description: '',
		logo: { key: 'l', url: 'https://cdn.example/l.png', alt: 'Zed' },
		status: 'hidden',
		categoryIds: ['cat_b'],
		sizeChartId: 'szc_1',
		seo: { title: 'Zed phones' },
	},
];
export const ATTRIBUTES = [
	{
		id: 'att_1',
		name: 'Screen',
		on: 'product',
		type: 'number',
		unit: 'in',
		choices: [],
		min: null,
		max: null,
		decimals: 1,
		show: { page: true, filter: true, compare: false },
		sort: 0,
	},
	{
		id: 'att_2',
		name: 'Color',
		type: 'choice',
		unit: '',
		choices: [
			{ value: 'Red', label: 'Red' },
			{ value: 'Blue', label: 'Blue' },
		],
		on: 'product',
		show: { page: true, filter: false, compare: true },
		sort: 1,
	},
	{ id: 'att_3', name: 'Dual SIM', on: 'product', type: 'yes_no', unit: '', choices: [], show: { page: true }, sort: 2 },
	{ id: 'att_4', name: 'Model', on: 'product', type: 'text', unit: '', choices: [], show: { page: true }, sort: 3 },
	{
		id: 'att_5',
		name: 'Storage',
		slug: 'storage',
		type: 'choice',
		unit: '',
		choices: [
			{ value: '64', label: '64 GB' },
			{ value: '128', label: '128 GB' },
		],
		show: { filter: true, compare: true, card: 'chips' },
		sort: 4,
		on: 'variant',
		multiple: false,
		active: true,
		categoryIds: ['cat_b'],
		visibility: { when: 'brands', ids: ['brd_1'], attributeId: null, value: null },
		seo: { title: 'Storage', description: 'How much fits', body: 'Bytes.', faqs: [{ question: 'Q?', answer: 'A.' }] },
	},
	{
		id: 'att_6',
		name: 'Bands',
		slug: 'bands',
		type: 'text',
		unit: '',
		choices: [],
		show: { filter: false, compare: false },
		sort: 5,
		on: 'variant',
		multiple: true,
		active: false,
		visibility: { when: 'grades', ids: ['a'], attributeId: null, value: null },
	},
	{
		id: 'att_7',
		name: 'Tags',
		slug: 'tags',
		type: 'choice',
		unit: '',
		choices: [
			{ value: 'x', label: 'X' },
			{ value: 'y', label: 'Y' },
		],
		show: { filter: false, compare: false },
		sort: 6,
		on: 'product',
		multiple: true,
		active: true,
		visibility: { when: 'attribute', ids: [], attributeId: 'att_2', value: 'Red' },
	},
];
export const LOCATIONS = [
	{ id: 'loc_1', name: 'Shop', pickup: true, sort: 0 },
	{ id: 'loc_2', name: 'Store room', pickup: false, sort: 1 },
];
export const CHARTS = [
	{
		id: 'szc_1',
		name: 'Shirts',
		unit: 'in',
		convertTo: 'cm',
		columns: [
			{ key: 'chest', label: 'Chest', unit: '' },
			{ key: 'waist', label: 'Waist', unit: '' },
		],
		rows: [
			{ size: 'S', label: 'Small', values: { chest: '36', waist: '30' } },
			{ size: 'M', label: 'M', values: { chest: '40' } },
		],
		advice: 'Runs small.',
		notes: 'Measured flat.',
		active: true,
		uses: { products: 2, brands: 1, categories: 0 },
	},
	{
		id: 'szc_2',
		name: 'Shoes',
		unit: 'EU',
		convertTo: '',
		columns: [{ key: 'foot', label: 'Foot', unit: 'cm' }],
		rows: [],
		advice: '',
		notes: '',
		active: false,
		uses: { products: 0, brands: 0, categories: 0 },
	},
];
export const ROW = {
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
	featured: true,
	stockState: 'partial',
	grades: ['a'],
	mediaCount: 2,
};

/** @param {Record<string, unknown>} [over] */
export const product = (over = {}) => ({
	id: 'prd_1',
	slug: 'phone',
	name: 'Phone',
	kind: 'physical',
	status: 'active',
	featured: true,
	summary: 'Nice',
	description: 'Long',
	descriptionHtml: '<p>Long <strong>text</strong></p>',
	categoryIds: ['cat_b'],
	brandId: 'brd_1',
	tags: ['new', 'hot'],
	specs: { att_1: 6.1, att_2: 'Red', att_3: true, att_7: ['x'] },
	attributeSetup: [{ attributeId: 'att_5', values: ['64'], customValues: ['256'], defaultValue: '64' }],
	options: [{ name: 'Color', values: ['Red', 'Blue'] }],
	variants: [
		{
			id: 'var_1',
			sku: 'P-1',
			options: { Color: 'Red' },
			price: 125000,
			compareAtPrice: 130000,
			cost: 100000,
			stock: 3,
			locations: { loc_1: 2, loc_2: 1 },
			grade: 'a',
			active: true,
			soldOut: false,
			warrantyDays: 30,
			attributes: {},
			media: [{ key: 'ecommerce/products/prd_1/a.jpg', alt: 'front', url: 'https://cdn.example/a.jpg' }],
		},
		{
			id: 'var_2',
			sku: 'P-2',
			options: { Color: 'Blue' },
			price: 126000,
			compareAtPrice: null,
			cost: null,
			stock: 1,
			locations: {},
			grade: null,
			active: false,
			soldOut: true,
			warrantyDays: null,
		},
	],
	trackStock: true,
	typeKey: null,
	type: { key: 'used_phone', kind: 'physical' },
	digital: null,
	booking: null,
	seo: {
		title: 'Phone',
		description: 'A phone',
		focusKeyword: 'phone',
		nofollow: true,
		titleMode: 'as_written',
		source: 'ai',
	},
	faqs: [{ question: 'Box?', answer: 'Charger included.' }],
	sizeChartId: 'szc_1',
	hideSizeGuide: false,
	video: { kind: 'youtube', id: 'dQw4w9WgXcQ' },
	returnDays: 7,
	warrantyDays: null,
	price: 125000,
	priceMax: 126000,
	stockState: 'partial',
	previousSlugs: ['old-phone'],
	updatedAt: '2026-10-01T10:00:00.000Z',
	media: [
		{
			key: 'ecommerce/products/prd_1/a.jpg',
			type: 'image/jpeg',
			size: 10,
			alt: 'front',
			url: 'https://cdn.example/a.jpg',
			width: 800,
			height: 600,
		},
		{ key: 'ecommerce/products/prd_1/b.jpg', type: 'image/jpeg', size: 10, alt: 'back', url: null },
	],
	...over,
});

/** @param {Record<string, any>} [routes] */
export const lists = (routes = {}) => ({
	'GET /v1/admin/categories': () => answer(200, { items: CATEGORIES }),
	'GET /v1/admin/brands': () => answer(200, { items: BRANDS }),
	'GET /v1/admin/attributes': () => answer(200, { items: ATTRIBUTES }),
	'GET /v1/admin/locations': () => answer(200, { items: LOCATIONS }),
	'GET /v1/admin/size-charts': () => answer(200, { items: CHARTS }),
	'GET /v1/admin/products': (/** @type {any} */ call) =>
		call.url.searchParams.get('cursor')
			? answer(200, {
					items: [{ ...ROW, id: 'prd_2', name: 'Case', trackStock: false, skus: [], featured: false, status: 'draft' }],
					nextCursor: null,
					hasMore: false,
				})
			: answer(200, { items: [ROW], nextCursor: 'c2', hasMore: true }),
	'GET /v1/admin/products/count': () => answer(200, { count: 2, capped: false }),
	'GET /v1/admin/products/counts': (/** @type {any} */ call) => {
		const by = call.url.searchParams.get('by');
		/** @type {Record<string, Record<string, number>>} */
		const groups = {
			status: { active: 1, draft: 1 },
			stockState: { partial: 1, out: 1 },
			brand: { brd_1: 2 },
			grade: { a: 1, none: 1 },
			featured: { true: 1, false: 1 },
			category: { cat_b: 5, cat_c: 1, none: 1 },
		};
		return answer(200, { total: 2, groups: groups[by] ?? {} });
	},
	'GET /v1/admin/products/prd_1': () => answer(200, product()),
	...routes,
});

/** The merchant's item type of phones: units picked from stock, numbered by the IMEI field. */
export const USED_PHONE = Object.freeze({
	key: 'used_phone',
	name: 'Used phone',
	kind: 'physical',
	active: true,
	elements: {
		variants: true,
		grades: true,
		units: { fieldIds: ['att_imei'], capture: 'stock', requiredBefore: 'packed' },
		chart: true,
		parcel: true,
		warranty: true,
		downloads: false,
		licenceKeys: false,
		slots: false,
	},
	fieldIds: null,
});

export const SETTINGS = { catalog: { grades: [{ key: 'a', label: 'Grade A' }], types: [USED_PHONE] } };

/** @param {readonly string[]} [features] @param {Record<string, any>} [routes] @param {Record<string, any>} [settings] */
export const start = (features = ALL, routes = {}, settings = SETTINGS) =>
	mountWith(mountCatalogAdmin, { features: [...features], settings, routes: lists(routes) });

/** The names of a list's rows. @param {ParentNode} panel */
export const rowsOf = (panel) => [...panel.querySelectorAll('li.item .name')].map((node) => node.textContent ?? '');

/** Pick a row by its name. @param {ParentNode} panel @param {string} name */
export const pick = async (panel, name) => {
	const row = [...panel.querySelectorAll('li.item')].find((node) => node.querySelector('.name')?.textContent === name);
	if (!row) throw new Error(`no row ${name}`);
	await click(/** @type {HTMLElement} */ (row));
};

/** The detail pane of a panel. @param {ParentNode} panel */
export const detailOf = (panel) => /** @type {HTMLElement} */ (panel.querySelector('.detail-pane'));

/** Choose an entry of the More menu in a scope. @param {ParentNode} scope @param {string} label */
export const menu = async (scope, label) => {
	const opener = /** @type {HTMLElement | null} */ (scope.querySelector('.more > button'));
	if (!opener) throw new Error('no More menu');
	opener.click();
	const entry = [...scope.querySelectorAll('.more [role="menuitem"]')].find((node) => node.textContent === label);
	if (!entry) throw new Error(`no menu entry ${label}`);
	/** @type {HTMLElement} */ (entry).click();
	await flush();
};

/** The open dialog (the last one). @param {ParentNode} root */
export const dialogOf = (root) => {
	const found = [...root.querySelectorAll('form.dialog')].at(-1);
	if (!found) throw new Error('no dialog');
	return /** @type {HTMLFormElement} */ (found);
};

/** Whether a dialog is open. @param {ParentNode} root */
export const hasDialog = (root) => root.querySelector('form.dialog') !== null;

/** Submit the open dialog. @param {ParentNode} root */
export const submitDialog = async (root) => {
	dialogOf(root).dispatchEvent(new window.Event('submit', { cancelable: true }));
	await flush();
};

/** Type the confirmation of a dialog and submit it. @param {ParentNode} root @param {string} text */
export const confirmDialog = async (root, text) => {
	const form = dialogOf(root);
	const typed = /** @type {HTMLInputElement} */ (form.querySelector('input[autocomplete="off"]'));
	typed.value = text;
	typed.dispatchEvent(new window.Event('input'));
	await submitDialog(root);
};
