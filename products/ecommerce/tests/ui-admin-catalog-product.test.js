// @vitest-environment jsdom
/* global document, window */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	ALL,
	ROW,
	confirmDialog,
	detailOf,
	dialogOf,
	hasDialog,
	menu,
	product,
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
	panelOf,
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

/** An input of the panel by its accessible label. @param {ParentNode} scope @param {string} label @returns {any} */
const labelled = (scope, label) => {
	const found = scope.querySelector(`[aria-label="${label}"]`);
	if (!found) throw new Error(`no control ${label}`);
	return found;
};

describe('catalog admin: a product', () => {
	it('shows the detail: facts, variants, photos, video, the description built safely, specs, FAQs and SEO', async () => {
		const { root } = await start(ALL, {
			'GET /v1/admin/products/prd_1': () =>
				answer(
					200,
					product({
						descriptionHtml:
							'<p>Long <b>text</b><script>alert(1)</script><a href="javascript:x">bad</a><a href="/ok">ok</a></p>',
					}),
				),
		});
		const detail = detailOf(panelOf(root, 'products'));
		const text = textOf(detail);
		for (const part of [
			'PKR 1,250.00 – PKR 1,260.00',
			'Some variants in stock',
			'2 (1 on sale)',
			'old-phone',
			'Shirts',
			'As its categories say',
			'YouTube video dQw4w9WgXcQ',
			'Storage64, 256',
			'Box?Charger included.',
			'Robotsnofollow',
			'Dual SIMYes',
			'TagsX',
			'2 at Shop, 1 at Store room',
		])
			expect(text).toContain(part);
		expect([...detail.querySelectorAll('.badge')].map((node) => node.textContent)).toEqual([
			'Active',
			'Featured',
			'On sale',
			'Off sale',
		]);
		const rich = /** @type {HTMLElement} */ (detail.querySelector('.rich'));
		expect(rich.querySelector('strong')?.textContent).toBe('text');
		expect(rich.querySelector('script')).toBeNull();
		expect([...rich.querySelectorAll('a')].map((node) => node.getAttribute('href'))).toEqual([null, '/ok']);
		expect(detail.querySelectorAll('.thumbs figure')).toHaveLength(2);
	});

	it('edits a product: fields, specs, setup, options, variants, kinds, SEO, FAQs, save and cancel', async () => {
		/** @type {any[]} */
		const patches = [];
		const { root } = await start(ALL, {
			'GET /v1/admin/products/prd_1': () =>
				answer(
					200,
					product({
						variants: [product().variants[0], { ...product().variants[1], attributes: { att_6: ['b1', 'b2'] } }],
						descriptionHtml: '',
						description: 'One\n\nTwo & <three>',
					}),
				),
			'PATCH /v1/admin/products/prd_1': (/** @type {any} */ call) => {
				patches.push(call.body);
				return patches.length === 1 ? invalid('/slug') : answer(200, product({ name: 'Phone 2' }));
			},
		});
		const panel = panelOf(root, 'products');
		await click(buttonIn(detailOf(panel), 'Edit'));
		const editor = detailOf(panel);
		expect(textOf(editor)).toContain('Edit Phone');
		expect(textOf(editor)).toContain('Earlier addresses still lead here: old-phone');
		expect(fieldIn(editor, 'Name').value).toBe('Phone');
		expect(fieldIn(editor, 'Tags (comma separated)').value).toBe('new, hot');
		expect(fieldIn(editor, 'Screen (in)').value).toBe('6.1');
		expect(checkIn(editor, 'Featured product').checked).toBe(true);
		expect(checkIn(editor, 'X').checked).toBe(true);
		expect(fieldIn(editor, 'Description (HTML)').value).toBe('<p>One</p>\n<p>Two &amp; &lt;three&gt;</p>');
		expect(labelled(editor, 'Grade of Red').value).toBe('a');
		expect(labelled(editor, 'Warranty days of Red').value).toBe('30');
		expect(labelled(editor, 'Blue is sold out').checked).toBe(true);
		expect(labelled(editor, 'Bands of Blue').value).toBe('b1, b2');
		expect(textOf(editor)).toContain('2 at Shop, 1 at Store room');
		// specs and the kind
		await change(fieldIn(editor, 'Colour'), '');
		await change(fieldIn(editor, 'Dual SIM'), 'false');
		type(fieldIn(editor, 'Model'), 'X1');
		await tick(checkIn(editor, 'Y'), true);
		await change(fieldIn(editor, 'Kind'), 'digital');
		expect(fieldIn(editor, 'Downloads allowed (0 = no limit)').value).toBe('0');
		await change(fieldIn(editor, 'Kind'), 'booking');
		type(fieldIn(editor, 'Duration in minutes'), '30');
		// the attribute setup: another attribute, its values and its default
		await change(fieldIn(editor, 'Attribute'), 'att_1');
		await click(buttonIn(editor, 'Set up'));
		type(fieldIn(editor, 'Values it uses (comma separated)'), '5, 6.5');
		type(fieldIn(editor, 'Picked first', 1), '5');
		await tick(checkIn(editor, '128 GB'), true);
		await click(buttonIn(editor, 'Set up'));
		// variants: a third value makes a new row with stock per location
		type(fieldIn(editor, 'Option 1 values (comma separated)'), 'Red, Blue, Green');
		await click(buttonIn(editor, 'Make variants from the options'));
		type(labelled(editor, 'Stock at Shop'), '4');
		type(labelled(editor, 'Price of Green'), '99.5');
		type(labelled(editor, 'Was price of Green'), 'abc');
		await change(labelled(editor, 'Storage of Green'), '128');
		await click(buttonIn(editor, 'Save'));
		expect(statuses(editor)).toContain('Check the amounts and numbers you typed.');
		type(labelled(editor, 'Was price of Green'), '');
		type(fieldIn(editor, 'Return days (empty = default)'), '1.5');
		await click(buttonIn(editor, 'Save'));
		expect(patches).toHaveLength(0);
		type(fieldIn(editor, 'Return days (empty = default)'), '');
		type(labelled(editor, 'Warranty days of Green'), '1.5');
		await click(buttonIn(editor, 'Save'));
		expect(patches).toHaveLength(0);
		type(labelled(editor, 'Warranty days of Green'), '');
		// the rest of the form
		type(fieldIn(editor, 'Focus keyword'), 'mobile');
		await tick(checkIn(editor, 'Keep out of search results (noindex)'), true);
		await click(buttonIn(editor, 'Add a question'));
		type(fieldIn(editor, 'Question 2'), 'Warranty?');
		type(fieldIn(editor, 'Answer 2'), 'One year.');
		await click(buttonIn(editor, 'Add a question'));
		await change(fieldIn(editor, 'Serial number per unit (captured when packed)'), 'yes');
		await change(fieldIn(editor, 'Size chart'), '');
		await tick(checkIn(editor, 'Hide the size guide'), true);
		await tick(checkIn(editor, 'Featured product'), false);
		await click(buttonIn(editor, 'Save'));
		expect(statuses(editor)).toContain(TEXTS['problem.field.slug']);
		const body = patches[0];
		expect(body.specs).toEqual({ att_1: 6.1, att_3: false, att_4: 'X1', att_7: ['x', 'y'] });
		expect(body.kind).toBe('booking');
		expect(body.booking).toEqual({ durationMinutes: 30 });
		expect(body.returnDays).toBeNull();
		expect(body.featured).toBe(false);
		expect(body.serialized).toBe(true);
		expect(body.sizeChartId).toBeNull();
		expect(body.hideSizeGuide).toBe(true);
		expect(body.descriptionHtml).toBe('<p>One</p>\n<p>Two &amp; &lt;three&gt;</p>');
		expect(body.seo).toMatchObject({ title: 'Phone', focusKeyword: 'mobile', noindex: true, nofollow: true });
		expect(body.faqs).toEqual([
			{ question: 'Box?', answer: 'Charger included.' },
			{ question: 'Warranty?', answer: 'One year.' },
		]);
		expect(body.attributeSetup).toEqual([
			{ attributeId: 'att_5', values: ['64', '128'], customValues: ['256'], defaultValue: '64' },
			{ attributeId: 'att_1', values: [5, 6.5], customValues: [], defaultValue: 5 },
		]);
		expect(body.options).toEqual([{ name: 'Colour', values: ['Red', 'Blue', 'Green'] }]);
		expect(body.variants[2]).toEqual({
			sku: '',
			options: {},
			attributes: { att_5: '128' },
			price: 9950,
			compareAtPrice: null,
			cost: null,
			active: true,
			soldOut: false,
			warrantyDays: null,
			grade: null,
			media: [],
			locations: { loc_1: 4, loc_2: 0 },
		});
		expect(body.variants[0]).toMatchObject({
			id: 'var_1',
			options: { Colour: 'Red' },
			attributes: {},
			price: 125000,
			compareAtPrice: 130000,
			cost: 100000,
			grade: 'a',
			warrantyDays: 30,
			media: [{ key: 'ecommerce/products/prd_1/a.jpg', alt: 'front' }],
		});
		expect(body.variants[1]).toMatchObject({ id: 'var_2', attributes: { att_6: ['b1', 'b2'] }, soldOut: true, options: {} });
		expect(body.variants[0].stock).toBeUndefined();
		// remove a row and a setup attribute, then save
		await click(buttonIn(editor, 'Remove', 2));
		await click(buttonIn(editor, 'Remove'));
		await change(fieldIn(editor, 'Kind'), 'digital');
		await tick(checkIn(editor, 'Give a licence key per unit'), true);
		type(fieldIn(editor, 'Description (HTML)'), '');
		await click(buttonIn(editor, 'Save'));
		expect(patches[1].variants).toHaveLength(2);
		expect(patches[1].attributeSetup).toHaveLength(1);
		expect(patches[1].digital).toEqual({ licenceKeys: true, downloadLimit: 0 });
		expect(patches[1]).toMatchObject({ descriptionHtml: '', description: '' });
		// back in the detail with the saved product
		expect(statuses(detailOf(panel))).toContain('Saved.');
		expect(textOf(panel)).toContain('Phone 2');
		await click(buttonIn(detailOf(panel), 'Edit'));
		await click(buttonIn(detailOf(panel), 'Cancel'));
		expect(shows(detailOf(panel), 'Stock')).toBe(true);
	});

	it('creates a product without variants, with the single price and stock', async () => {
		/** @type {any[]} */
		const posts = [];
		let created = false;
		const { root } = await start(['catalog'], {
			'GET /v1/admin/products': () =>
				answer(200, {
					items: created ? [{ ...ROW, id: 'prd_9', name: 'Mug' }, ROW] : [ROW],
					nextCursor: null,
					hasMore: false,
				}),
			'GET /v1/admin/products/prd_9': () => answer(200, product({ id: 'prd_9', name: 'Mug', options: [], media: [] })),
			'POST /v1/admin/products': (/** @type {any} */ call) => {
				posts.push(call.body);
				created = true;
				return answer(201, product({ id: 'prd_9', name: 'Mug', options: [], media: [] }));
			},
		});
		const panel = panelOf(root, 'products');
		await click(buttonIn(panel, 'New product'));
		const editor = detailOf(panel);
		expect(textOf(editor)).toContain('New product');
		expect(editor.querySelector('[aria-current="true"]')).toBeNull();
		type(fieldIn(editor, 'Name'), 'Mug');
		type(labelled(editor, 'Price of Default'), '');
		await click(buttonIn(editor, 'Save'));
		expect(statuses(editor)).toContain('Check the amounts and numbers you typed.');
		type(labelled(editor, 'Price of Default'), '0');
		type(labelled(editor, 'Stock of Default'), '7');
		type(fieldIn(editor, 'Description (HTML)'), '<p>Big</p>');
		await tick(checkIn(editor, 'Track stock'), false);
		await click(buttonIn(editor, 'Save'));
		expect(posts[0]).toMatchObject({
			name: 'Mug',
			kind: 'physical',
			status: 'draft',
			trackStock: false,
			descriptionHtml: '<p>Big</p>',
			variants: [{ sku: '', options: {}, price: 0, compareAtPrice: null, cost: null, active: true, soldOut: false, stock: 7 }],
		});
		expect(posts[0].options).toBeUndefined();
		expect(posts[0].serialized).toBeUndefined();
		expect(posts[0].variants[0].media).toBeUndefined();
		// the new product opens in the list
		expect(panel.querySelector('li.item[aria-current="true"] .name')?.textContent).toBe('Mug');
		expect(textOf(detailOf(panel))).toContain('Mug');
		// cancelling a new product goes back to the open one
		await click(buttonIn(panel, 'New product'));
		await click(buttonIn(detailOf(panel), 'Cancel'));
		expect(textOf(detailOf(panel))).toContain('Mug');
	});

	it('changes stock and sold out in the Stock dialog', async () => {
		let reply = () => answer(200, product({ name: 'Restocked' }));
		const { root, server } = await start(ALL, { 'POST /v1/admin/products/prd_1/stock': () => reply() });
		const detail = detailOf(panelOf(root, 'products'));
		await click(buttonIn(detail, 'Stock'));
		const dialog = dialogOf(root);
		expect(textOf(dialog)).toContain('2 at Shop, 1 at Store room');
		await submitDialog(root);
		expect(statuses(dialog)).toContain('Type units or change Sold out first.');
		type(labelled(dialog, 'Units of Red'), '1.5');
		await submitDialog(root);
		expect(statuses(dialog)).toContain('Check the amounts and numbers you typed.');
		type(labelled(dialog, 'Units of Red'), '2');
		await change(labelled(dialog, 'How to change Red'), 'set');
		await change(labelled(dialog, 'Location of Red'), 'loc_2');
		await tick(labelled(dialog, 'Blue is sold out'), false);
		reply = () => problem(409, 'conflict');
		await submitDialog(root);
		expect(statuses(dialog)).toContain(TEXTS['problem.conflict']);
		reply = () => answer(200, product({ name: 'Restocked' }));
		await submitDialog(root);
		expect(server.last('POST /v1/admin/products/prd_1/stock')?.body).toEqual({
			changes: [
				{ variantId: 'var_1', set: 2, locationId: 'loc_2' },
				{ variantId: 'var_2', soldOut: false },
			],
		});
		expect(hasDialog(root)).toBe(false);
		const next = detailOf(panelOf(root, 'products'));
		expect(statuses(next)).toContain('Stock changed.');
		expect(textOf(next)).toContain('Restocked');
		// without stock tracking the dialog says so
		resetPage();
		const plain = await start(['catalog'], {
			'GET /v1/admin/products/prd_1': () => answer(200, product({ trackStock: false, variants: [product().variants[0]] })),
			'POST /v1/admin/products/prd_1/stock': () => answer(200, product()),
		});
		await click(buttonIn(detailOf(panelOf(plain.root, 'products')), 'Stock'));
		expect(textOf(dialogOf(plain.root))).toContain('Stock is not tracked for this product');
		type(labelled(dialogOf(plain.root), 'Units of Red'), '-1');
		await submitDialog(plain.root);
		expect(plain.server.last('POST /v1/admin/products/prd_1/stock')?.body).toEqual({
			changes: [{ variantId: 'var_1', adjust: -1 }],
		});
	});

	it('suggests copy with AI and applies the ticked suggestions', async () => {
		let ai = () => problem(503, 'ai_not_connected');
		const { root, server } = await start(ALL, {
			'POST /v1/admin/products/prd_1/ai-copy': () => ai(),
			'PATCH /v1/admin/products/prd_1': (/** @type {any} */ call) =>
				call.body.summary === 'Fail' ? invalid('/summary') : answer(200, product({ summary: 'AI summary' })),
		});
		await menu(detailOf(panelOf(root, 'products')), 'Write with AI');
		const dialog = dialogOf(root);
		await tick(checkIn(dialog, 'Questions and answers'), false);
		await click(buttonIn(dialog, 'Suggest'));
		expect(statuses(dialog)).toContain(TEXTS['problem.ai_not_connected']);
		expect(server.last('POST /v1/admin/products/prd_1/ai-copy')?.body).toEqual({
			fields: ['summary', 'description', 'seoTitle', 'seoDescription'],
		});
		await submitDialog(root);
		expect(statuses(dialog)).toContain('Tick at least one suggestion to apply.');
		ai = () =>
			answer(200, {
				suggestions: {
					summary: 'AI summary',
					description: 'Para one\n\nPara <two>',
					seoTitle: 'AI title',
					seoDescription: 'AI meta',
					faqs: [{ question: 'Q1', answer: 'A1' }],
				},
			});
		await click(buttonIn(dialog, 'Suggest'));
		expect(statuses(dialog)).toContain('Check the suggestions, change them if needed, then apply.');
		expect(fieldIn(dialog, 'Summary').value).toBe('AI summary');
		await tick(checkIn(dialog, 'Apply: Meta description'), false);
		type(fieldIn(dialog, 'Page title'), 'Better title');
		type(fieldIn(dialog, 'Summary'), 'Fail');
		await submitDialog(root);
		expect(statuses(dialog)).toContain(TEXTS['problem.field.summary']);
		type(fieldIn(dialog, 'Summary'), 'AI summary');
		await submitDialog(root);
		expect(server.last('PATCH /v1/admin/products/prd_1')?.body).toEqual({
			summary: 'AI summary',
			descriptionHtml: '<p>Para one</p>\n<p>Para &lt;two&gt;</p>',
			faqs: [{ question: 'Q1', answer: 'A1' }],
			seo: { title: 'Better title' },
		});
		expect(statuses(detailOf(panelOf(root, 'products')))).toContain('Suggestions applied.');
		// only the description and the meta description
		await menu(detailOf(panelOf(root, 'products')), 'Write with AI');
		ai = () => answer(200, { suggestions: { seoDescription: 'Meta only' } });
		await click(buttonIn(dialogOf(root), 'Suggest'));
		await submitDialog(root);
		expect(server.last('PATCH /v1/admin/products/prd_1')?.body).toEqual({ seo: { description: 'Meta only' } });
	});

	it('generates variants from the detail and from the editor (saving first)', async () => {
		let patch = () => problem(409, 'conflict');
		const { root, server } = await start(ALL, {
			'POST /v1/admin/products/prd_1/variants/generate': (/** @type {any} */ call) =>
				call.body.price === 100 ? problem(409, 'conflict') : answer(200, { added: 2, product: product() }),
			'PATCH /v1/admin/products/prd_1': () => patch(),
		});
		const panel = panelOf(root, 'products');
		await menu(detailOf(panel), 'Generate variants');
		let dialog = dialogOf(root);
		expect(textOf(dialog)).toContain('A variant is added for every missing combination of the set-up values.');
		expect(() => fieldIn(dialog, 'Stock of each new variant')).toThrow();
		type(fieldIn(dialog, "Price of new variants (empty = the product's lowest)"), 'x');
		await submitDialog(root);
		expect(statuses(dialog)).toContain('Check the amounts and numbers you typed.');
		type(fieldIn(dialog, "Price of new variants (empty = the product's lowest)"), '1');
		await submitDialog(root);
		expect(statuses(dialog)).toContain(TEXTS['problem.conflict']);
		type(fieldIn(dialog, "Price of new variants (empty = the product's lowest)"), '');
		await submitDialog(root);
		expect(server.last('POST /v1/admin/products/prd_1/variants/generate')?.body).toEqual({ price: null });
		expect(statuses(detailOf(panel))).toContain('2 variants added.');
		// from the editor: the product is saved first
		await click(buttonIn(detailOf(panel), 'Edit'));
		await click(buttonIn(detailOf(panel), 'Generate variants'));
		dialog = dialogOf(root);
		expect(textOf(dialog)).toContain('The product is saved first');
		await submitDialog(root);
		expect(statuses(dialog)).toContain(TEXTS['problem.conflict']);
		type(labelled(detailOf(panel), 'Price of Red'), 'x');
		await submitDialog(root);
		expect(statuses(dialog)).toContain('Check the amounts and numbers you typed.');
		type(labelled(detailOf(panel), 'Price of Red'), '1250');
		patch = () => answer(200, product());
		const before = server.all('POST /v1/admin/products/prd_1/variants/generate').length;
		await submitDialog(root);
		expect(server.all('POST /v1/admin/products/prd_1/variants/generate')).toHaveLength(before + 1);
		expect(statuses(detailOf(panel))).toContain('2 variants added.');
		// without variant values to generate from there is no menu entry
		resetPage();
		const none = await start(ALL, { 'GET /v1/admin/products/prd_1': () => answer(200, product({ attributeSetup: [] })) });
		const opener = /** @type {HTMLElement} */ (detailOf(panelOf(none.root, 'products')).querySelector('.more > button'));
		opener.click();
		expect(textOf(detailOf(panelOf(none.root, 'products')).querySelector('.menu') ?? document.body)).not.toContain(
			'Generate variants',
		);
	});

	it('deletes a product behind a typed confirmation', async () => {
		let reply = () => problem(409, 'conflict');
		const { root, server } = await start(ALL, { 'DELETE /v1/admin/products/prd_1': () => reply() });
		const panel = panelOf(root, 'products');
		await menu(detailOf(panel), 'Delete');
		const dialog = dialogOf(root);
		expect(textOf(dialog)).toContain('Delete Phone?');
		const submit = /** @type {HTMLButtonElement} */ (dialog.querySelector('button[type="submit"]'));
		expect(submit.disabled).toBe(true);
		await confirmDialog(root, 'Phone');
		expect(statuses(dialog)).toContain(TEXTS['problem.conflict']);
		reply = () => answer(204);
		const lists = server.all('GET /v1/admin/products').length;
		await submitDialog(root);
		expect(hasDialog(root)).toBe(false);
		expect(server.all('GET /v1/admin/products')).toHaveLength(lists + 1);
		// Escape closes a dialog
		await menu(detailOf(panel), 'Delete');
		dialogOf(root).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(hasDialog(root)).toBe(false);
	});
});

describe('catalog admin: other product shapes', () => {
	it('shows a bare booking product', async () => {
		const bare = {
			...product(),
			kind: 'booking',
			status: 'archived',
			featured: false,
			summary: '',
			description: '',
			descriptionHtml: '',
			specs: {},
			attributeSetup: undefined,
			faqs: undefined,
			previousSlugs: undefined,
			stockState: undefined,
			updatedAt: undefined,
			video: null,
			returnDays: null,
			warrantyDays: 30,
			serialized: true,
			hideSizeGuide: true,
			booking: { durationMinutes: 45 },
			priceMax: 125000,
			trackStock: false,
			media: [{ key: 'ecommerce/products/prd_1/a.jpg', type: 'image/jpeg', size: 1, alt: '', url: null }],
			variants: [{ ...product().variants[0], soldOut: true, grade: 'zz' }],
		};
		const { root } = await start(ALL, { 'GET /v1/admin/products/prd_1': () => answer(200, bare) });
		const detail = detailOf(panelOf(root, 'products'));
		const text = textOf(detail);
		for (const part of [
			'Archived',
			'Booking',
			'Stock not tracked',
			'Warranty days30',
			'Size guide hidden',
			'Duration in minutes45',
			'No video.',
			'zz',
			'Sold out',
		])
			expect(text).toContain(part);
		expect(text).not.toContain('Return days');
		expect(text).toContain('ecommerce/products/prd_1/a.jpg');
		expect(text).toContain('Nothing here yet.');
		expect([...detail.querySelectorAll('.card h4')].map((node) => node.textContent)).not.toContain('Specs');
		// a product with its plain description and no size chart of its own
		resetPage();
		const plain = await start(ALL, {
			'GET /v1/admin/products/prd_1': () =>
				answer(200, product({ descriptionHtml: '', description: 'Plain words', sizeChartId: null, serialized: false })),
		});
		const next = textOf(detailOf(panelOf(plain.root, 'products')));
		expect(next).toContain('Plain words');
		expect(next).toContain('From its brand or category');
		expect(next).toContain('Serial number per unit (captured when packed)No');
	});

	it('edits variant attributes of each kind, without multi-location stock or a grades list', async () => {
		const attributes = [
			{ id: 'att_w', name: 'Weight', type: 'number', unit: 'g', choices: [], sort: 0, on: 'variant' },
			{
				id: 'att_c',
				name: 'Colours',
				type: 'choice',
				unit: '',
				choices: [
					{ value: 'red', label: 'Red' },
					{ value: 'blue', label: 'Blue' },
				],
				sort: 1,
				on: 'variant',
				multiple: true,
			},
			{ id: 'att_t', name: 'Material', type: 'text', unit: '', choices: [], sort: 2, on: 'variant' },
			{ id: 'att_n', name: 'Notes', type: 'text', unit: '', choices: [], sort: 3, multiple: true },
			{ id: 'att_s', name: 'Fit', type: 'choice', unit: '', choices: ['Slim', 'Loose'], sort: 4, multiple: true },
		];
		const shaped = product({
			attributeSetup: [{ attributeId: 'att_c', values: ['red'], customValues: ['green'], defaultValue: null }],
			specs: { att_n: ['soft', 'warm'], att_s: 'Slim' },
			options: [],
			variants: [
				{
					...product().variants[0],
					options: { Colours: 'Red', Weight: '100 g' },
					locations: {},
					attributes: { att_w: 100, att_c: ['red', 'green'], att_t: 'Cotton' },
				},
			],
		});
		let generated = () => answer(200, { added: 1, product: shaped });
		const { root, server } = await start(
			['catalog', 'variants', 'returns', 'grades_serials'],
			{
				'GET /v1/admin/attributes': () => answer(200, { items: attributes }),
				'GET /v1/admin/products/prd_1': () => answer(200, shaped),
				'PATCH /v1/admin/products/prd_1': () => answer(200, shaped),
				'POST /v1/admin/products/prd_1/variants/generate': () => generated(),
			},
			{},
		);
		const panel = panelOf(root, 'products');
		await click(buttonIn(detailOf(panel), 'Edit'));
		const editor = detailOf(panel);
		const label = 'Red / 100 g';
		expect(labelled(editor, `Weight of ${label}`).value).toBe('100');
		expect([...labelled(editor, `Colours of ${label}`).selectedOptions].map((/** @type {any} */ o) => o.value)).toEqual([
			'red',
			'green',
		]);
		expect(fieldIn(editor, 'Notes (comma separated)').value).toBe('soft, warm');
		expect(checkIn(editor, 'Slim').checked).toBe(true);
		type(labelled(editor, `Weight of ${label}`), '');
		type(labelled(editor, `Material of ${label}`), '');
		for (const option of labelled(editor, `Colours of ${label}`).options) option.selected = false;
		type(labelled(editor, `Grade of ${label}`), 'b');
		type(fieldIn(editor, 'Notes (comma separated)'), '');
		await tick(checkIn(editor, 'Slim'), false);
		await click(buttonIn(editor, 'Add a variant'));
		type(labelled(editor, 'Stock of Default'), '3');
		type(labelled(editor, 'Weight of Default'), '250');
		type(labelled(editor, 'Material of Default'), 'Wool');
		await click(buttonIn(editor, 'Save'));
		const body = server.last('PATCH /v1/admin/products/prd_1')?.body;
		expect(body.specs).toEqual({});
		expect(body.variants[0]).toMatchObject({ attributes: {}, options: { Colours: 'Red', Weight: '100 g' } });
		expect(body.variants[0].grade).toBe('b');
		expect(body.variants[1]).toMatchObject({ attributes: { att_w: 250, att_t: 'Wool' }, options: {}, stock: 3 });
		expect(body.attributeSetup).toEqual([
			{ attributeId: 'att_c', values: ['red'], customValues: ['green'], defaultValue: null },
		]);
		// Generate with stock for each new variant
		await click(buttonIn(detailOf(panel), 'Edit'));
		await click(buttonIn(detailOf(panel), 'Generate variants'));
		const dialog = dialogOf(root);
		type(fieldIn(dialog, 'Stock of each new variant'), '-1');
		await submitDialog(root);
		expect(statuses(dialog)).toContain('Check the amounts and numbers you typed.');
		type(fieldIn(dialog, 'Stock of each new variant'), '');
		generated = () => problem(409, 'conflict');
		await submitDialog(root);
		expect(server.last('POST /v1/admin/products/prd_1/variants/generate')?.body).toEqual({ price: null, stock: 0 });
		expect(statuses(dialog)).toContain(TEXTS['problem.conflict']);
		/** @type {HTMLElement} */ ([...dialog.querySelectorAll('button')].find((node) => node.textContent === 'Cancel')).click();
		// options of a product with variant attributes still make rows
		await click(buttonIn(detailOf(panel), 'Add an option'));
		type(fieldIn(detailOf(panel), 'Option 1 name'), 'Size');
		type(fieldIn(detailOf(panel), 'Option 1 values (comma separated)'), 'S');
		await click(buttonIn(detailOf(panel), 'Make variants from the options'));
		expect(labelled(detailOf(panel), 'Price of S')).toBeTruthy();
	});
});
