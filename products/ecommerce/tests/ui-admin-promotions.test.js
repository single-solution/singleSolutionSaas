// @vitest-environment jsdom
/* global window */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mountPromotionsAdmin } from '../ui/promotions-admin.js';
import {
	answer,
	buttonIn,
	change,
	checkIn,
	click,
	fieldIn,
	invalid,
	mountWith,
	openTab,
	panelOf,
	problem,
	resetPage,
	shows,
	statuses,
	submit,
	textOf,
	TEXTS,
	tick,
	type,
} from './ui-admin-helpers.js';
import {
	chipOf,
	confirmDialog,
	detailOf,
	dialogOf,
	dialogStatus,
	hasDialog,
	menuEntries,
	openRow,
	pickMenu,
	rowOf,
	submitDialog,
} from './ui-admin-screens.js';

beforeEach(resetPage);
afterEach(resetPage);

const AT = '2026-10-01T10:00:00.000Z';
const LATER = '2099-01-01T00:00:00.000Z';
const SCOPE = { productIds: ['prd_1'], categoryIds: ['cat_1'], brandIds: [] };
const COUPON = {
	id: 'cpn_1',
	code: 'SAVE10',
	type: 'percent',
	value: 10,
	maxDiscount: 50000,
	minSubtotal: 100000,
	scope: SCOPE,
	startsAt: AT,
	endsAt: null,
	limit: 100,
	used: 3,
	perCustomer: 1,
	firstOrderOnly: true,
	active: true,
};
const DEAL = {
	id: 'deal_1',
	name: 'Autumn',
	description: 'Fall',
	type: 'fixed',
	value: 5000,
	scope: SCOPE,
	startsAt: null,
	endsAt: null,
	limit: null,
	used: 0,
	priority: 2,
	active: false,
};
const BUNDLE = {
	id: 'bnd_1',
	name: 'Kit',
	type: 'bundle',
	items: [
		{ productId: 'prd_1', quantity: 1 },
		{ productId: 'prd_2', quantity: 2 },
	],
	price: 300000,
	buy: 0,
	get: 0,
	scope: { productIds: [], categoryIds: [], brandIds: [] },
	getScope: { productIds: [], categoryIds: [], brandIds: [] },
	value: 0,
	startsAt: null,
	endsAt: null,
	limit: null,
	used: 1,
	active: true,
};
const COUPONS = [
	COUPON,
	{ ...COUPON, id: 'cpn_2', code: 'SHIP', type: 'free_delivery', maxDiscount: null, limit: null, active: false, scope: null },
	{ ...COUPON, id: 'cpn_3', code: 'FLAT', type: 'fixed', value: 2000, endsAt: AT },
	{ ...COUPON, id: 'cpn_4', code: 'SOON', startsAt: LATER },
	{ ...COUPON, id: 'cpn_5', code: 'GONE', used: 100 },
];
const DEALS = [DEAL, { ...DEAL, id: 'deal_2', type: 'percent', value: 15, active: true }];
const BUNDLES = [
	BUNDLE,
	{
		...BUNDLE,
		id: 'bnd_2',
		name: 'B2G1',
		type: 'buy_x_get_y',
		buy: 2,
		get: 1,
		value: 100,
		price: null,
		items: [],
		scope: SCOPE,
	},
	{ ...BUNDLE, id: 'bnd_3', name: 'Pct', price: null, value: 10 },
];

/** A list route and a read route for each item. @param {string} path @param {any[]} items */
const offers = (path, items) => ({
	[`GET ${path}`]: () => answer(200, { items, nextCursor: null, hasMore: false }),
	...Object.fromEntries(items.map((item) => [`GET ${path}/${item.id}`, () => answer(200, item)])),
});

/** @param {Record<string, any>} [routes] @param {string[]} [features] */
const start = (routes = {}, features = ['coupons', 'deals', 'bundles', 'loyalty']) =>
	mountWith(mountPromotionsAdmin, {
		features,
		routes: {
			...offers('/v1/admin/coupons', COUPONS),
			...offers('/v1/admin/deals', DEALS),
			...offers('/v1/admin/bundles', BUNDLES),
			'GET /v1/admin/categories': () =>
				answer(200, {
					items: [
						{ id: 'cat_1', name: 'Phones' },
						{ id: 'cat_2', name: 'Audio' },
					],
					nextCursor: null,
					hasMore: false,
				}),
			'GET /v1/admin/brands': () => answer(200, { items: [{ id: 'brd_1', name: 'Acme' }], nextCursor: null, hasMore: false }),
			'GET /v1/admin/products': (/** @type {any} */ call) => {
				const ids = /** @type {string | null} */ (call.url.searchParams.get('ids'));
				/** @type {Record<string, string>} */
				const named = { prd_1: 'Phone X', prd_2: 'Charger' };
				const items = ids
					? ids
							.split(',')
							.filter((id) => named[id])
							.map((id) => ({ id, name: named[id] }))
					: call.url.searchParams.get('q') === 'none'
						? []
						: [{ id: 'prd_3', name: 'Case' }];
				return answer(200, { items, nextCursor: null, hasMore: false });
			},
			...routes,
		},
	});

describe('promotions admin: coupons', () => {
	it('lists coupons with their state and shows one read fresh', async () => {
		const { host, root, server } = await start();
		expect(host.getAttribute('data-ss-mounted')).toBe('promotions-admin');
		const panel = panelOf(root, 'coupons');
		expect(textOf(rowOf(panel, 'cpn_1'))).toContain('10 % off');
		expect(textOf(rowOf(panel, 'cpn_1'))).toContain('Active · Used 3 of 100');
		expect(textOf(rowOf(panel, 'cpn_2'))).toContain('Free delivery');
		expect(textOf(rowOf(panel, 'cpn_2'))).toContain('Off · Used 3 of ∞');
		expect(textOf(rowOf(panel, 'cpn_3'))).toContain('USD 20.00');
		expect(textOf(rowOf(panel, 'cpn_3'))).toContain('Ended');
		expect(textOf(rowOf(panel, 'cpn_3'))).toContain('ends ');
		expect(rowOf(panel, 'cpn_4').querySelector('.dot.warning')?.getAttribute('aria-label')).toBe('Scheduled');
		expect(rowOf(panel, 'cpn_5').querySelector('.dot.warning')?.getAttribute('aria-label')).toBe('Used up');
		expect(server.last('GET /v1/admin/coupons/cpn_1')).toBeDefined();
		const pane = detailOf(panel);
		for (const part of ['SAVE10', 'Percent off', 'USD 500.00', 'USD 1,000.00', 'Phones', 'Phone X', 'Total uses100', 'Used3'])
			expect(textOf(pane)).toContain(part);
		// product names are read by id once
		expect(server.all('GET /v1/admin/products').map((call) => call.url.searchParams.get('ids'))).toEqual(['prd_1']);
		type(fieldIn(panel, 'Search'), 'SA');
		await submit(fieldIn(panel, 'Search'));
		await click(chipOf(panel, 'true'));
		expect(Object.fromEntries(server.last('GET /v1/admin/coupons')?.url.searchParams ?? [])).toEqual({
			q: 'SA',
			active: 'true',
		});
		await openRow(panel, 'cpn_2');
		expect(textOf(detailOf(panel))).toContain('Everything in the shop.');
		expect(shows(detailOf(panel), 'Turn on')).toBe(true);
		server.routes['GET /v1/admin/coupons/cpn_3'] = () => problem(404, 'not_found');
		await openRow(panel, 'cpn_3');
		expect(statuses(detailOf(panel))).toContain(TEXTS['problem.not_found']);
	});

	it('edits, turns off, duplicates, creates and deletes coupons', async () => {
		/** @type {any[]} */
		const bodies = [];
		const listed = [...COUPONS];
		const { root, server } = await start({
			'GET /v1/admin/coupons': () => answer(200, { items: listed, nextCursor: null, hasMore: false }),
			'GET /v1/admin/coupons/cpn_9': () => answer(200, listed.at(-1)),
			'PATCH /v1/admin/coupons/cpn_1': (/** @type {any} */ call) => {
				bodies.push(call.body);
				return bodies.length === 1 ? invalid('/code') : answer(200, { ...COUPON, ...call.body });
			},
			'POST /v1/admin/coupons': (/** @type {any} */ call) => {
				bodies.push(call.body);
				listed.push({ ...COUPON, ...call.body, id: 'cpn_9' });
				return answer(201, listed.at(-1));
			},
			'DELETE /v1/admin/coupons/cpn_1': () => answer(204),
		});
		const panel = panelOf(root, 'coupons');
		const pane = detailOf(panel);
		// edit in a dialog
		await click(buttonIn(pane, 'Edit'));
		let dialog = dialogOf(root);
		expect(textOf(dialog)).toContain('Edit SAVE10');
		expect(fieldIn(dialog, 'Percent off').value).toBe('10');
		expect(fieldIn(dialog, 'Largest discount (USD, optional)').value).toBe('500.00');
		expect(textOf(dialog)).toContain('Phones');
		// scope pickers: products by search, categories by name, remove a chip
		type(fieldIn(dialog, 'Search', 0), 'ca');
		await click(buttonIn(dialog, 'Find', 0));
		await click(buttonIn(dialog, 'Case'));
		type(fieldIn(dialog, 'Search', 0), 'none');
		await click(buttonIn(dialog, 'Find', 0));
		expect(textOf(dialog)).toContain('Nothing matches.');
		type(fieldIn(dialog, 'Search', 1), 'aud');
		fieldIn(dialog, 'Search', 1).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a' }));
		fieldIn(dialog, 'Search', 1).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
		await click(buttonIn(dialog, 'Find', 1));
		await click(buttonIn(dialog, 'Audio'));
		await click(/** @type {HTMLButtonElement} */ (dialog.querySelector('button[aria-label="Remove Phones"]')));
		type(fieldIn(dialog, 'Uses per customer (empty = no limit)'), '1.5');
		await submitDialog(root);
		expect(dialogStatus(root)).toBe('Check the amounts and numbers you typed.');
		type(fieldIn(dialog, 'Uses per customer (empty = no limit)'), '');
		type(fieldIn(dialog, 'Ends'), '2026-12-31T23:00');
		await submitDialog(root);
		expect(dialogStatus(root)).toBe(TEXTS['problem.field.code']);
		await submitDialog(root);
		expect(hasDialog(root)).toBe(false);
		expect(bodies[1]).toMatchObject({
			code: 'SAVE10',
			type: 'percent',
			value: 10,
			maxDiscount: 50000,
			minSubtotal: 100000,
			perCustomer: null,
			firstOrderOnly: true,
			scope: { productIds: ['prd_1', 'prd_3'], categoryIds: ['cat_2'], brandIds: [] },
			limit: 100,
			active: true,
		});
		expect(bodies[1].startsAt).toBe(AT);
		expect(bodies[1].endsAt).toBe(new Date('2026-12-31T23:00').toISOString());
		expect(statuses(pane)).toContain('Saved.');
		// turn off and on
		await click(buttonIn(pane, 'Turn off'));
		expect(bodies[2]).toEqual({ active: false });
		expect(statuses(pane)).toContain('Turned off.');
		expect(textOf(rowOf(panel, 'cpn_1'))).toContain('Off');
		server.routes['PATCH /v1/admin/coupons/cpn_1'] = () => problem(403, 'forbidden');
		await click(buttonIn(pane, 'Turn on'));
		expect(statuses(pane)).toContain('You are not allowed to do this.');
		// duplicate: a new coupon with the same fields and no code
		await pickMenu(pane, 'Duplicate');
		dialog = dialogOf(root);
		expect(textOf(dialog)).toContain('New coupon');
		expect(fieldIn(dialog, 'Code').value).toBe('');
		type(fieldIn(dialog, 'Code'), 'COPY10');
		await submitDialog(root);
		expect(bodies[3]).toMatchObject({ code: 'COPY10', type: 'percent', value: 10 });
		expect(server.last('GET /v1/admin/coupons/cpn_9')).toBeDefined();
		expect(rowOf(panel, 'cpn_9').getAttribute('aria-current')).toBe('true');
		expect(textOf(detailOf(panel))).toContain('COPY10');
		// new fixed and free-delivery coupons
		await click(buttonIn(panel, 'New coupon'));
		dialog = dialogOf(root);
		type(fieldIn(dialog, 'Code'), ' new5 ');
		await change(fieldIn(dialog, 'Type'), 'fixed');
		type(fieldIn(dialog, 'Amount off (USD)'), '5');
		type(fieldIn(dialog, 'Total uses (empty = no limit)'), '');
		await tick(checkIn(dialog, 'Active'), false);
		await submitDialog(root);
		expect(bodies[4]).toMatchObject({
			code: 'new5',
			type: 'fixed',
			value: 500,
			maxDiscount: null,
			minSubtotal: 0,
			firstOrderOnly: false,
			active: false,
			limit: null,
			startsAt: null,
		});
		expect(statuses(panel)).toContain('Saved.');
		await click(buttonIn(panel, 'New coupon'));
		await change(fieldIn(dialogOf(root), 'Type'), 'free_delivery');
		type(fieldIn(dialogOf(root), 'Code'), 'SHIPFREE');
		await submitDialog(root);
		expect(bodies[5]).toMatchObject({ type: 'free_delivery', value: 0 });
		// delete, behind the typed code
		await openRow(panel, 'cpn_1');
		await pickMenu(detailOf(panel), 'Delete');
		dialog = dialogOf(root);
		expect(textOf(dialog)).toContain('Delete SAVE10');
		expect((await confirmDialog(root, 'SAVE1')).disabled).toBe(true);
		await confirmDialog(root, 'SAVE10');
		server.routes['DELETE /v1/admin/coupons/cpn_1'] = () => problem(404, 'not_found');
		await submitDialog(root);
		expect(dialogStatus(root)).toBe(TEXTS['problem.not_found']);
		server.routes['DELETE /v1/admin/coupons/cpn_1'] = () => answer(204);
		server.routes['GET /v1/admin/coupons'] = () => answer(200, { items: COUPONS.slice(1), nextCursor: null, hasMore: false });
		await submitDialog(root);
		expect(rowOf(panel, 'cpn_1')).toBeNull();
		expect(textOf(detailOf(panel))).toContain('SHIP');
	});

	it('generates a batch of codes and downloads them', async () => {
		let reply = () => invalid('/prefix');
		const { root, server, saved } = await start({ 'POST /v1/admin/coupons/batch': () => reply() }, ['coupons']);
		expect(root.querySelector('nav.sections')?.hasAttribute('hidden')).toBe(true);
		const panel = panelOf(root, 'coupons');
		await pickMenu(panel, 'Generate codes');
		const dialog = dialogOf(root);
		expect(() => fieldIn(dialog, 'Code')).toThrow();
		type(fieldIn(dialog, 'Code prefix'), 'VIP');
		type(fieldIn(dialog, 'How many'), '2');
		type(fieldIn(dialog, 'Percent off'), '5');
		type(fieldIn(dialog, 'Largest discount (USD, optional)'), 'abc');
		await submitDialog(root);
		expect(dialogStatus(root)).toBe('Check the amounts and numbers you typed.');
		type(fieldIn(dialog, 'Largest discount (USD, optional)'), '');
		await submitDialog(root);
		expect(dialogStatus(root)).toBe(TEXTS['problem.field.prefix']);
		reply = () => answer(201, { created: 2, codes: ['VIPAAAA1111', 'VIPBBBB2222'] });
		await submitDialog(root);
		expect(server.last('POST /v1/admin/coupons/batch')?.body).toMatchObject({
			prefix: 'VIP',
			count: 2,
			coupon: { type: 'percent', value: 5, maxDiscount: null },
		});
		const result = dialogOf(root);
		expect(textOf(result)).toContain('2 coupons made.');
		expect(textOf(result)).toContain('VIPAAAA1111, VIPBBBB2222');
		await submitDialog(root);
		expect(saved[0]?.name).toBe('coupon-codes.csv');
		expect(saved[0]?.text).toContain('VIPBBBB2222');
		expect(hasDialog(root)).toBe(false);
	});

	it('takes typed ids when the catalog cannot be read', async () => {
		/** @type {any[]} */
		const bodies = [];
		const { root } = await start(
			{
				'GET /v1/admin/products': () => problem(403, 'forbidden'),
				'GET /v1/admin/categories': () => problem(403, 'forbidden'),
				'GET /v1/admin/brands': () => problem(403, 'forbidden'),
				'POST /v1/admin/deals': (/** @type {any} */ call) => {
					bodies.push(call.body);
					return answer(201, { ...DEAL, ...call.body, id: 'deal_9' });
				},
			},
			['deals'],
		);
		const panel = panelOf(root, 'deals');
		expect(textOf(rowOf(panel, 'deal_1'))).toContain('USD 50.00');
		expect(textOf(rowOf(panel, 'deal_1'))).toContain('Off · Used 0 of ∞');
		expect(textOf(rowOf(panel, 'deal_2'))).toContain('15 % off');
		expect(textOf(detailOf(panel))).toContain('cat_1');
		await click(buttonIn(panel, 'New deal'));
		const dialog = dialogOf(root);
		type(fieldIn(dialog, 'Name'), 'Flash');
		type(fieldIn(dialog, 'Percent, or amount in USD'), '20');
		type(fieldIn(dialog, 'Search', 0), 'prd_7');
		await click(buttonIn(dialog, 'Find', 0));
		type(fieldIn(dialog, 'Search', 2), 'brd_7');
		await click(buttonIn(dialog, 'Find', 2));
		type(fieldIn(dialog, 'Priority'), '1.5');
		await submitDialog(root);
		expect(dialogStatus(root)).toBe('Check the amounts and numbers you typed.');
		type(fieldIn(dialog, 'Priority'), '');
		await submitDialog(root);
		expect(bodies[0]).toMatchObject({
			name: 'Flash',
			type: 'percent',
			value: 20,
			priority: 0,
			scope: { productIds: ['prd_7'], categoryIds: [], brandIds: ['brd_7'] },
		});
	});
});

describe('promotions admin: deals and bundles', () => {
	it('edits a fixed deal', async () => {
		const { root, server } = await start({
			'PATCH /v1/admin/deals/deal_1': (/** @type {any} */ call) => answer(200, { ...DEAL, ...call.body }),
		});
		const panel = await openTab(root, 'deals');
		const pane = detailOf(panel);
		for (const part of ['Autumn', 'Amount off', 'USD 50.00', 'Priority2', 'Fall', 'No limit'])
			expect(textOf(pane)).toContain(part);
		await click(buttonIn(pane, 'Edit'));
		expect(fieldIn(dialogOf(root), 'Percent, or amount in USD').value).toBe('50.00');
		type(fieldIn(dialogOf(root), 'Percent, or amount in USD'), 'x');
		await submitDialog(root);
		expect(dialogStatus(root)).toBe('Check the amounts and numbers you typed.');
		type(fieldIn(dialogOf(root), 'Percent, or amount in USD'), '60');
		await submitDialog(root);
		expect(server.last('PATCH /v1/admin/deals/deal_1')?.body).toMatchObject({
			type: 'fixed',
			value: 6000,
			priority: 2,
			description: 'Fall',
		});
		expect(textOf(pane)).toContain('USD 60.00');
		await pickMenu(pane, 'Duplicate');
		expect(fieldIn(dialogOf(root), 'Name').value).toBe('Autumn');
		await openRow(panel, 'deal_2');
		await click(buttonIn(detailOf(panel), 'Edit'));
		expect(fieldIn(dialogOf(root), 'Percent, or amount in USD').value).toBe('15');
	});

	it('sets conditions on the values of the shop’s fields, keeping the deal’s other conditions', async () => {
		const OTHER = {
			match: 'any',
			rules: [{ field: 'brands', op: 'in', values: ['brd_1'] }],
			groups: [],
			priceRange: null,
			minQuantity: 2,
			cartTotal: 0,
			paymentMethods: [],
		};
		const { root, server } = await start({
			'GET /v1/admin/attributes': () =>
				answer(200, {
					items: [
						{ id: 'atr_1', slug: 'material', name: 'Material', on: 'product' },
						{ id: 'atr_2', slug: 'tier', name: 'Tier', on: 'customer' },
					],
				}),
			'PATCH /v1/admin/deals/deal_1': (/** @type {any} */ call) => answer(200, { ...DEAL, ...call.body }),
		});
		const panel = await openTab(root, 'deals');
		await click(buttonIn(detailOf(panel), 'Edit'));
		const dialog = dialogOf(root);
		// the fields the shop has are offered by their key (a customer field is not a field of products)
		expect([...dialog.querySelectorAll('#ss-deal-fields option')].map((option) => option.getAttribute('value'))).toEqual([
			'material',
		]);
		await click(buttonIn(dialog, 'Add a condition on a field'));
		type(fieldIn(dialog, 'Field (its slug or id)'), 'material');
		type(fieldIn(dialog, 'Values (separated by commas)'), 'wool, silk');
		await submitDialog(root);
		expect(server.last('PATCH /v1/admin/deals/deal_1')?.body).toMatchObject({
			conditions: {
				match: 'all',
				rules: [{ field: 'material', op: 'in', values: ['wool', 'silk'] }],
				minQuantity: 0,
			},
		});
		// a deal with other conditions keeps them, and shows its field conditions to change or remove
		server.routes['GET /v1/admin/deals/deal_1'] = () =>
			answer(200, {
				...DEAL,
				conditions: {
					...OTHER,
					rules: [...OTHER.rules, { field: 'attribute', attributeId: 'atr_1', op: 'not_in', values: ['wool'] }],
				},
			});
		await openRow(panel, 'deal_2');
		await openRow(panel, 'deal_1');
		await click(buttonIn(detailOf(panel), 'Edit'));
		const again = dialogOf(root);
		expect(fieldIn(again, 'Field (its slug or id)').value).toBe('atr_1');
		expect(fieldIn(again, 'Values (separated by commas)').value).toBe('wool');
		await click(buttonIn(again, 'Remove', 0));
		await submitDialog(root);
		expect(server.last('PATCH /v1/admin/deals/deal_1')?.body).toMatchObject({
			conditions: { match: 'any', rules: [{ field: 'brands', op: 'in', values: ['brd_1'] }], minQuantity: 2 },
		});
	});

	it('uploads, describes and removes a deal’s banner', async () => {
		const KEY = 'ecommerce/deals/deal_1/abc.png';
		/** @param {string} key */
		const word = (key) => String(TEXTS[key]);
		const { root, server } = await start({
			'POST /v1/admin/deals/deal_1/banner/upload': (/** @type {any} */ call) =>
				answer(200, {
					key: KEY,
					upload: { method: 'PUT', url: 'https://bucket.example/up', headers: { 'content-type': call.body.type } },
				}),
			'PUT /up': () => answer(200),
			'PATCH /v1/admin/deals/deal_1': (/** @type {any} */ call) => answer(200, { ...DEAL, ...call.body }),
		});
		const panel = await openTab(root, 'deals');
		const pane = detailOf(panel);
		expect(textOf(pane)).toContain(word('promotionsAdmin.noBanner'));
		await click(buttonIn(pane, word('promotionsAdmin.saveBanner')));
		expect(statuses(pane)).toContain(word('promotionsAdmin.bannerPick'));
		const picker = /** @type {HTMLInputElement} */ (fieldIn(pane, word('promotionsAdmin.bannerFile')));
		Object.defineProperty(picker, 'files', {
			configurable: true,
			value: [new window.File(['x'], 'b.png', { type: 'image/png' })],
		});
		type(fieldIn(pane, word('promotionsAdmin.bannerAlt')), ' Autumn sale ');
		server.routes['PUT /up'] = () => answer(403);
		await click(buttonIn(pane, word('promotionsAdmin.saveBanner')));
		expect(statuses(pane)).toContain(word('admin.uploadFailed'));
		server.routes['PUT /up'] = () => answer(200);
		await click(buttonIn(pane, word('promotionsAdmin.saveBanner')));
		expect(server.last('POST /v1/admin/deals/deal_1/banner/upload')?.body).toEqual({ type: 'image/png', size: 1 });
		expect(server.last('PUT /up')?.headers['content-type']).toBe('image/png');
		expect(server.last('PATCH /v1/admin/deals/deal_1')?.body).toEqual({
			banner: { key: KEY, alt: 'Autumn sale', type: 'image/png', size: 1 },
		});
		expect(textOf(pane)).toContain(word('promotionsAdmin.bannerFileName').replace('{name}', 'abc.png'));
		expect(statuses(pane)).toContain(word('promotionsAdmin.bannerSaved'));
		// without a file, Save changes the alternative text
		type(fieldIn(pane, word('promotionsAdmin.bannerAlt')), 'Fall');
		await click(buttonIn(pane, word('promotionsAdmin.saveBanner')));
		expect(server.last('PATCH /v1/admin/deals/deal_1')?.body).toEqual({
			banner: { key: KEY, alt: 'Fall', type: 'image/png', size: 1 },
		});
		server.routes['PATCH /v1/admin/deals/deal_1'] = () => invalid('/banner');
		await click(buttonIn(pane, word('promotionsAdmin.removeBanner')));
		expect(statuses(pane).join(' ')).not.toContain(word('promotionsAdmin.bannerRemoved'));
		server.routes['PATCH /v1/admin/deals/deal_1'] = (/** @type {any} */ call) => answer(200, { ...DEAL, ...call.body });
		await click(buttonIn(pane, word('promotionsAdmin.removeBanner')));
		expect(server.last('PATCH /v1/admin/deals/deal_1')?.body).toEqual({ banner: null });
		expect(textOf(pane)).toContain(word('promotionsAdmin.noBanner'));
		expect(statuses(pane)).toContain(word('promotionsAdmin.bannerRemoved'));
		server.routes['POST /v1/admin/deals/deal_1/banner/upload'] = () => problem(503, 'storage_not_connected');
		const again = /** @type {HTMLInputElement} */ (fieldIn(pane, word('promotionsAdmin.bannerFile')));
		Object.defineProperty(again, 'files', {
			configurable: true,
			value: [new window.File(['x'], 'b.png', { type: 'image/png' })],
		});
		await click(buttonIn(pane, word('promotionsAdmin.saveBanner')));
		expect(statuses(pane)).toContain(word('problem.storage_not_connected'));
	});

	it('edits bundles and buy X get Y', async () => {
		/** @type {any[]} */
		const bodies = [];
		const { root, server } = await start({
			'PATCH /v1/admin/bundles/bnd_1': (/** @type {any} */ call) => {
				bodies.push(call.body);
				return answer(200, BUNDLE);
			},
			'PATCH /v1/admin/bundles/bnd_2': (/** @type {any} */ call) => {
				bodies.push(call.body);
				return bodies.length === 2 ? invalid('/buy') : answer(200, BUNDLES[1]);
			},
			'POST /v1/admin/bundles': (/** @type {any} */ call) => {
				bodies.push(call.body);
				return answer(201, { ...BUNDLE, ...call.body, id: 'bnd_9' });
			},
		});
		const panel = await openTab(root, 'bundles');
		expect(textOf(rowOf(panel, 'bnd_1'))).toContain('USD 3,000.00');
		expect(textOf(rowOf(panel, 'bnd_2'))).toContain('Buy 2 get 1 at 100 % off');
		expect(textOf(rowOf(panel, 'bnd_3'))).toContain('10 % off');
		const pane = detailOf(panel);
		expect(textOf(pane)).toContain('Products in the bundle');
		expect(textOf(pane)).toContain('Charger');
		expect(server.last('GET /v1/admin/products')?.url.searchParams.get('ids')).toBe('prd_1,prd_2');
		await click(buttonIn(pane, 'Edit'));
		let dialog = dialogOf(root);
		expect(fieldIn(dialog, 'Bundle price (USD)').value).toBe('3000.00');
		type(dialog.querySelector('input[aria-label="Quantity of Charger"]'), '3');
		type(fieldIn(dialog, 'Search', 0), 'ca');
		await click(buttonIn(dialog, 'Find', 0));
		await click(buttonIn(dialog, 'Case'));
		await click(buttonIn(dialog, 'Case'));
		await click(buttonIn(dialog, 'Remove'));
		type(fieldIn(dialog, 'Bundle price (USD)'), 'zz');
		await submitDialog(root);
		expect(dialogStatus(root)).toBe('Check the amounts and numbers you typed.');
		type(fieldIn(dialog, 'Bundle price (USD)'), '');
		type(fieldIn(dialog, 'Percent off'), '10');
		await submitDialog(root);
		expect(bodies[0]).toMatchObject({
			type: 'bundle',
			items: [
				{ productId: 'prd_2', quantity: 3 },
				{ productId: 'prd_3', quantity: 1 },
			],
			price: null,
			value: 10,
		});
		await openRow(panel, 'bnd_2');
		expect(textOf(detailOf(panel))).toContain('Buy from');
		expect(textOf(detailOf(panel))).toContain('Phones');
		await click(buttonIn(detailOf(panel), 'Edit'));
		dialog = dialogOf(root);
		expect(fieldIn(dialog, 'Buy').value).toBe('2');
		expect(fieldIn(dialog, 'Percent off what they get (100 = free)').value).toBe('100');
		type(fieldIn(dialog, 'Percent off what they get (100 = free)'), '');
		await submitDialog(root);
		expect(bodies[1]).toMatchObject({ type: 'buy_x_get_y', buy: 2, get: 1, value: 100 });
		expect(dialogStatus(root)).toBe(TEXTS['problem.validation_failed']);
		type(fieldIn(dialog, 'Percent off what they get (100 = free)'), '50');
		await submitDialog(root);
		expect(bodies[2].value).toBe(50);
		await click(buttonIn(panel, 'New bundle'));
		dialog = dialogOf(root);
		await change(fieldIn(dialog, 'Type'), 'buy_x_get_y');
		type(fieldIn(dialog, 'Name'), 'B1G1');
		type(fieldIn(dialog, 'Total uses (empty = no limit)'), 'x1');
		await submitDialog(root);
		expect(bodies[3]).toMatchObject({ name: 'B1G1', buy: 1, get: 1, limit: null });
		await click(buttonIn(panel, 'New bundle'));
		dialog = dialogOf(root);
		type(fieldIn(dialog, 'Search', 0), 'ca');
		await click(buttonIn(dialog, 'Find', 0));
		await click(buttonIn(dialog, 'Case'));
		type(fieldIn(dialog, 'Bundle price (USD)'), '25');
		await submitDialog(root);
		expect(bodies[4]).toMatchObject({ type: 'bundle', price: 2500, items: [{ productId: 'prd_3', quantity: 1 }] });
		expect(bodies[4].value).toBeUndefined();
	});

	it('adds typed product ids to a bundle when products cannot be read', async () => {
		/** @type {any[]} */
		const bodies = [];
		const { root } = await start(
			{
				'GET /v1/admin/products': () => problem(403, 'forbidden'),
				'POST /v1/admin/bundles': (/** @type {any} */ call) => {
					bodies.push(call.body);
					return answer(201, { ...BUNDLE, ...call.body, id: 'bnd_9' });
				},
			},
			['bundles'],
		);
		const panel = panelOf(root, 'bundles');
		await click(buttonIn(panel, 'New bundle'));
		const dialog = dialogOf(root);
		type(fieldIn(dialog, 'Search', 0), 'prd_5');
		await click(buttonIn(dialog, 'Find', 0));
		await click(buttonIn(dialog, 'Find', 0));
		type(fieldIn(dialog, 'Search', 0), '');
		await click(buttonIn(dialog, 'Find', 0));
		type(fieldIn(dialog, 'Name'), 'Pair');
		type(fieldIn(dialog, 'Bundle price (USD)'), '9');
		await submitDialog(root);
		expect(bodies[0].items).toEqual([{ productId: 'prd_5', quantity: 1 }]);
	});

	it('shows an empty list', async () => {
		const { root } = await start(
			{ 'GET /v1/admin/bundles': () => answer(200, { items: [], nextCursor: null, hasMore: false }) },
			['bundles'],
		);
		const panel = panelOf(root, 'bundles');
		expect(statuses(panel)).toContain('No bundles match.');
		expect(textOf(detailOf(panel))).toContain('No bundles to show. Make one with New bundle.');
		expect(menuEntries(panel)).toEqual([]);
	});
});

describe('promotions admin: loyalty', () => {
	const account = () => ({
		userId: 'u 1',
		balance: 120,
		value: 1200,
		currency: 'USD',
		lots: [{ id: 'l1', points: 150, left: 120, earnedAt: AT, expiresAt: null, orderId: 'ord_1' }],
		history: [{ at: AT, kind: 'earn', points: 150, orderId: 'ord_1', note: '' }],
		expiringSoon: [{ points: 20, expiresAt: AT }],
	});

	it('looks up an account and adjusts points', async () => {
		const account = {
			userId: 'u 1',
			balance: 120,
			value: 1200,
			currency: 'USD',
			lots: [{ id: 'l1', points: 150, left: 120, earnedAt: AT, expiresAt: null, orderId: 'ord_1' }],
			history: [{ at: AT, kind: 'earn', points: 150, orderId: 'ord_1', note: '' }],
			expiringSoon: [{ points: 20, expiresAt: AT }],
		};
		let adjust = () => answer(200, { ...account, balance: 130, expiringSoon: undefined });
		const { root, server } = await start(
			{
				'GET /v1/admin/loyalty/accounts/u%201': () => answer(200, account),
				'GET /v1/admin/loyalty/accounts/nobody': () => problem(403, 'forbidden'),
				'POST /v1/admin/loyalty/accounts/u%201/adjust': () => adjust(),
			},
			['loyalty'],
		);
		const panel = panelOf(root, 'loyalty');
		await submit(fieldIn(panel, 'Customer or user id'));
		expect(server.calls.filter((call) => call.path.includes('loyalty'))).toHaveLength(0);
		type(fieldIn(panel, 'Customer or user id'), 'nobody');
		await submit(fieldIn(panel, 'Customer or user id'));
		expect(statuses(panel)).toContain('You are not allowed to do this.');
		type(fieldIn(panel, 'Customer or user id'), 'u 1');
		await submit(fieldIn(panel, 'Customer or user id'));
		expect(textOf(panel)).toContain('Balance120 points');
		expect(textOf(panel)).toContain('WorthUSD 12.00');
		expect(textOf(panel)).toContain('20 points');
		expect(textOf(panel)).toContain('Earned');
		await click(buttonIn(panel, 'Change points'));
		await submitDialog(root);
		expect(dialogStatus(root)).toBe('Check the amounts and numbers you typed.');
		type(fieldIn(dialogOf(root), 'Points'), '10');
		type(fieldIn(dialogOf(root), 'Note'), 'Gift');
		await submitDialog(root);
		expect(server.last('POST /v1/admin/loyalty/accounts/u%201/adjust')?.body).toEqual({ points: 10, note: 'Gift' });
		expect(statuses(panel)).toContain('Points changed.');
		expect(textOf(panel)).toContain('130 points');
		adjust = () => invalid('/points');
		await click(buttonIn(panel, 'Change points'));
		type(fieldIn(dialogOf(root), 'Points'), '-500');
		await submitDialog(root);
		expect(dialogStatus(root)).toBe(TEXTS['problem.field.points']);
	});

	it('adjusts a guest’s points by their customer id (K-6)', async () => {
		const guest = { ...account(), userId: null, customerId: 'cus_g1' };
		const { root, server } = await start(
			{
				'GET /v1/admin/loyalty/accounts/cus_g1': () => answer(200, guest),
				'POST /v1/admin/loyalty/accounts/cus_g1/adjust': () => answer(200, { ...guest, balance: 125 }),
			},
			['loyalty'],
		);
		const panel = panelOf(root, 'loyalty');
		type(fieldIn(panel, 'Customer or user id'), 'cus_g1');
		await submit(fieldIn(panel, 'Customer or user id'));
		expect(textOf(panel)).toContain('cus_g1');
		await click(buttonIn(panel, 'Change points'));
		type(fieldIn(dialogOf(root), 'Points'), '5');
		await submitDialog(root);
		expect(server.last('POST /v1/admin/loyalty/accounts/cus_g1/adjust')?.body).toEqual({ points: 5, note: '' });
		expect(textOf(panel)).toContain('125 points');
	});
});
