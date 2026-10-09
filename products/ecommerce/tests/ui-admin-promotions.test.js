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

const AT = '2026-10-01T10:00:00.000Z';
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

/** @param {string} path @param {any[]} items */
const listOf = (path, items) => ({
	[`GET ${path}`]: () => answer(200, { items, nextCursor: null, hasMore: false }),
});

/** @param {Record<string, any>} [routes] @param {string[]} [features] */
const start = (routes = {}, features = ['coupons', 'deals', 'bundles', 'loyalty']) =>
	mountWith(mountPromotionsAdmin, {
		features,
		routes: {
			...listOf('/v1/admin/coupons', [
				COUPON,
				{ ...COUPON, id: 'cpn_2', code: 'SHIP', type: 'free_delivery', limit: null, active: false },
				{ ...COUPON, id: 'cpn_3', code: 'FLAT', type: 'fixed', value: 2000 },
			]),
			...listOf('/v1/admin/deals', [DEAL, { ...DEAL, id: 'deal_2', type: 'percent', value: 15, active: true }]),
			...listOf('/v1/admin/bundles', [
				BUNDLE,
				{ ...BUNDLE, id: 'bnd_2', name: 'B2G1', type: 'buy_x_get_y', buy: 2, get: 1, value: 100, price: null, items: [] },
			]),
			...listOf('/v1/admin/categories', [
				{ id: 'cat_1', name: 'Phones' },
				{ id: 'cat_2', name: 'Audio' },
			]),
			...listOf('/v1/admin/brands', [{ id: 'brd_1', name: 'Acme' }]),
			'GET /v1/admin/products': (/** @type {any} */ call) =>
				answer(200, {
					items: call.url.searchParams.get('q') === 'none' ? [] : [{ id: 'prd_3', name: 'Case' }],
					nextCursor: null,
					hasMore: false,
				}),
			...routes,
		},
	});

describe('promotions admin: coupons', () => {
	it('lists, edits, creates and deletes coupons', async () => {
		/** @type {any[]} */
		const bodies = [];
		const { host, root, server } = await start({
			'PATCH /v1/admin/coupons/cpn_1': (/** @type {any} */ call) => {
				bodies.push(call.body);
				return bodies.length === 1 ? problem(422, 'code is 3 to 40 characters.') : answer(200, COUPON);
			},
			'POST /v1/admin/coupons': (/** @type {any} */ call) => {
				bodies.push(call.body);
				return answer(201, { ...COUPON, ...call.body, id: 'cpn_9' });
			},
			'DELETE /v1/admin/coupons/cpn_1': () => answer(204),
		});
		expect(host.getAttribute('data-ss-mounted')).toBe('promotions-admin');
		const panel = panelOf(root, 'coupons');
		const text = textOf(panel);
		expect(text).toContain('10 % off · Used 3 of 100 · Active');
		expect(text).toContain('Free delivery · Used 3 of ∞ · Off');
		expect(text).toContain('PKR 20.00');
		type(fieldIn(panel, 'Search'), 'SA');
		await submit(fieldIn(panel, 'Search'));
		await change(fieldIn(panel, 'Shown'), 'true');
		expect(Object.fromEntries(server.last('GET /v1/admin/coupons')?.url.searchParams ?? [])).toEqual({
			q: 'SA',
			active: 'true',
		});
		// edit
		await click(buttonIn(panel, 'Edit'));
		expect(textOf(panel)).toContain('Edit SAVE10');
		expect(fieldIn(panel, 'Percent off').value).toBe('10');
		expect(fieldIn(panel, 'Largest discount (PKR, optional)').value).toBe('500.00');
		expect(textOf(panel)).toContain('Phones');
		expect(textOf(panel)).toContain('prd_1');
		// scope pickers: products by search, categories by name, remove a chip
		type(fieldIn(panel, 'Search', 0), 'ca');
		await click(buttonIn(panel, 'Find', 0));
		await click(buttonIn(panel, 'Case'));
		type(fieldIn(panel, 'Search', 0), 'none');
		await click(buttonIn(panel, 'Find', 0));
		expect(textOf(panel)).toContain('Nothing matches.');
		type(fieldIn(panel, 'Search', 1), 'aud');
		fieldIn(panel, 'Search', 1).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a' }));
		fieldIn(panel, 'Search', 1).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
		await click(buttonIn(panel, 'Find', 1));
		await click(buttonIn(panel, 'Audio'));
		await click(buttonIn(panel, 'Audio'));
		await click(/** @type {HTMLButtonElement} */ (panel.querySelector('button[aria-label="Remove Phones"]')));
		type(fieldIn(panel, 'Uses per customer (empty = no limit)'), '1.5');
		await click(buttonIn(panel, 'Save'));
		expect(statuses(panel)).toContain('Check the amounts and numbers you typed.');
		type(fieldIn(panel, 'Uses per customer (empty = no limit)'), '');
		type(fieldIn(panel, 'Ends'), '2026-12-31T23:00');
		await click(buttonIn(panel, 'Save'));
		expect(statuses(panel)).toContain('code is 3 to 40 characters.');
		await click(buttonIn(panel, 'Save'));
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
		expect(statuses(panel)).toContain('Saved.');
		// new fixed coupon
		await click(buttonIn(panel, 'New coupon'));
		type(fieldIn(panel, 'Code'), ' new5 ');
		await change(fieldIn(panel, 'Type'), 'fixed');
		type(fieldIn(panel, 'Amount off (PKR)'), '5');
		type(fieldIn(panel, 'Total uses (empty = no limit)'), '');
		await tick(checkIn(panel, 'Active'), false);
		await click(buttonIn(panel, 'Save'));
		expect(bodies[2]).toMatchObject({
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
		await click(buttonIn(panel, 'New coupon'));
		await change(fieldIn(panel, 'Type'), 'free_delivery');
		type(fieldIn(panel, 'Code'), 'SHIPFREE');
		await click(buttonIn(panel, 'Save'));
		expect(bodies[3]).toMatchObject({ type: 'free_delivery', value: 0 });
		await click(buttonIn(panel, 'New coupon'));
		await click(buttonIn(panel, 'Back'));
		// delete
		await click(buttonIn(panel, 'Edit'));
		await click(buttonIn(panel, 'Delete'));
		await click(buttonIn(panel, 'Confirm delete'));
		expect(statuses(panel)).toContain('Deleted.');
		server.routes['DELETE /v1/admin/coupons/cpn_1'] = () => problem(404, 'No such coupon.');
		await click(buttonIn(panel, 'Edit'));
		await click(buttonIn(panel, 'Delete'));
		await click(buttonIn(panel, 'Confirm delete'));
		expect(statuses(panel)).toContain('No such coupon.');
	});

	it('generates a batch of codes and downloads them', async () => {
		let reply = () => problem(422, 'prefix is up to 30 characters.');
		const { root, server, saved } = await start({ 'POST /v1/admin/coupons/batch': () => reply() }, ['coupons']);
		expect(root.querySelector('nav.sections')?.hasAttribute('hidden')).toBe(true);
		const panel = panelOf(root, 'coupons');
		await click(buttonIn(panel, 'Generate codes'));
		expect(() => fieldIn(panel, 'Code')).toThrow();
		type(fieldIn(panel, 'Code prefix'), 'VIP');
		type(fieldIn(panel, 'How many'), '2');
		type(fieldIn(panel, 'Percent off'), '5');
		type(fieldIn(panel, 'Largest discount (PKR, optional)'), 'abc');
		await click(buttonIn(panel, 'Generate'));
		expect(statuses(panel)).toContain('Check the amounts and numbers you typed.');
		type(fieldIn(panel, 'Largest discount (PKR, optional)'), '');
		await click(buttonIn(panel, 'Generate'));
		expect(statuses(panel)).toContain('prefix is up to 30 characters.');
		reply = () => answer(201, { created: 2, codes: ['VIPAAAA1111', 'VIPBBBB2222'] });
		await click(buttonIn(panel, 'Generate'));
		expect(server.last('POST /v1/admin/coupons/batch')?.body).toMatchObject({
			prefix: 'VIP',
			count: 2,
			coupon: { type: 'percent', value: 5, maxDiscount: null },
		});
		expect(statuses(panel)).toContain('2 coupons made.');
		expect(textOf(panel)).toContain('VIPAAAA1111, VIPBBBB2222');
		await click(buttonIn(panel, 'Download codes'));
		expect(saved[0]?.name).toBe('coupon-codes.csv');
		expect(saved[0]?.text).toContain('VIPBBBB2222');
		await click(buttonIn(panel, 'Back'));
		expect(shows(panel, 'Generate codes')).toBe(true);
	});

	it('takes typed ids when the catalog cannot be read', async () => {
		/** @type {any[]} */
		const bodies = [];
		const { root } = await start(
			{
				'GET /v1/admin/products': () => problem(403, 'no'),
				'GET /v1/admin/categories': () => problem(403, 'no'),
				'GET /v1/admin/brands': () => problem(403, 'no'),
				'POST /v1/admin/deals': (/** @type {any} */ call) => {
					bodies.push(call.body);
					return answer(201, call.body);
				},
			},
			['deals'],
		);
		const panel = panelOf(root, 'deals');
		expect(textOf(panel)).toContain('PKR 50.00 · Used 0 of ∞ · Off');
		expect(textOf(panel)).toContain('15 % off');
		await click(buttonIn(panel, 'New deal'));
		type(fieldIn(panel, 'Name'), 'Flash');
		type(fieldIn(panel, 'Percent, or amount in PKR'), '20');
		type(fieldIn(panel, 'Search', 0), 'prd_7');
		await click(buttonIn(panel, 'Find', 0));
		type(fieldIn(panel, 'Search', 2), 'brd_7');
		await click(buttonIn(panel, 'Find', 2));
		type(fieldIn(panel, 'Priority'), '1.5');
		await click(buttonIn(panel, 'Save'));
		expect(statuses(panel)).toContain('Check the amounts and numbers you typed.');
		type(fieldIn(panel, 'Priority'), '');
		await click(buttonIn(panel, 'Save'));
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
		await click(buttonIn(panel, 'Edit'));
		expect(fieldIn(panel, 'Percent, or amount in PKR').value).toBe('50.00');
		type(fieldIn(panel, 'Percent, or amount in PKR'), 'x');
		await click(buttonIn(panel, 'Save'));
		expect(statuses(panel)).toContain('Check the amounts and numbers you typed.');
		type(fieldIn(panel, 'Percent, or amount in PKR'), '60');
		await click(buttonIn(panel, 'Save'));
		expect(server.last('PATCH /v1/admin/deals/deal_1')?.body).toMatchObject({
			type: 'fixed',
			value: 6000,
			priority: 2,
			description: 'Fall',
		});
		await click(buttonIn(panel, 'Edit', 1));
		expect(fieldIn(panel, 'Percent, or amount in PKR').value).toBe('15');
	});

	it('edits bundles and buy X get Y', async () => {
		/** @type {any[]} */
		const bodies = [];
		const { root } = await start({
			'PATCH /v1/admin/bundles/bnd_1': (/** @type {any} */ call) => {
				bodies.push(call.body);
				return answer(200, BUNDLE);
			},
			'PATCH /v1/admin/bundles/bnd_2': (/** @type {any} */ call) => {
				bodies.push(call.body);
				return problem(422, 'buy is a whole number from 1 to 100.');
			},
			'POST /v1/admin/bundles': (/** @type {any} */ call) => {
				bodies.push(call.body);
				return answer(201, call.body);
			},
		});
		const panel = await openTab(root, 'bundles');
		expect(textOf(panel)).toContain('Bundle · Used 1 of ∞ · Active');
		expect(textOf(panel)).toContain('Buy X get Y');
		await click(buttonIn(panel, 'Edit'));
		expect(fieldIn(panel, 'Bundle price (PKR)').value).toBe('3000.00');
		type(panel.querySelector('input[aria-label="Quantity of prd_2"]'), '3');
		type(fieldIn(panel, 'Search', 0), 'ca');
		await click(buttonIn(panel, 'Find', 0));
		await click(buttonIn(panel, 'Case'));
		await click(buttonIn(panel, 'Case'));
		await click(buttonIn(panel, 'Remove'));
		type(fieldIn(panel, 'Bundle price (PKR)'), 'zz');
		await click(buttonIn(panel, 'Save'));
		expect(statuses(panel)).toContain('Check the amounts and numbers you typed.');
		type(fieldIn(panel, 'Bundle price (PKR)'), '');
		type(fieldIn(panel, 'Percent off'), '10');
		await click(buttonIn(panel, 'Save'));
		expect(bodies[0]).toMatchObject({
			type: 'bundle',
			items: [
				{ productId: 'prd_2', quantity: 3 },
				{ productId: 'prd_3', quantity: 1 },
			],
			price: null,
			value: 10,
		});
		await click(buttonIn(panel, 'Edit', 1));
		expect(fieldIn(panel, 'Buy').value).toBe('2');
		expect(fieldIn(panel, 'Percent off what they get (100 = free)').value).toBe('100');
		type(fieldIn(panel, 'Percent off what they get (100 = free)'), '');
		await click(buttonIn(panel, 'Save'));
		expect(bodies[1]).toMatchObject({ type: 'buy_x_get_y', buy: 2, get: 1, value: 100 });
		expect(statuses(panel)).toContain('buy is a whole number from 1 to 100.');
		type(fieldIn(panel, 'Percent off what they get (100 = free)'), '50');
		await click(buttonIn(panel, 'Save'));
		expect(bodies[2].value).toBe(50);
		await click(buttonIn(panel, 'Back'));
		await click(buttonIn(panel, 'New bundle'));
		await change(fieldIn(panel, 'Type'), 'buy_x_get_y');
		type(fieldIn(panel, 'Name'), 'B1G1');
		type(fieldIn(panel, 'Total uses (empty = no limit)'), 'x1');
		await click(buttonIn(panel, 'Save'));
		expect(bodies[3]).toMatchObject({ name: 'B1G1', buy: 1, get: 1, limit: null });
		await click(buttonIn(panel, 'New bundle'));
		type(fieldIn(panel, 'Search', 0), 'ca');
		await click(buttonIn(panel, 'Find', 0));
		await click(buttonIn(panel, 'Case'));
		type(fieldIn(panel, 'Bundle price (PKR)'), '25');
		await click(buttonIn(panel, 'Save'));
		expect(bodies[4]).toMatchObject({ type: 'bundle', price: 2500, items: [{ productId: 'prd_3', quantity: 1 }] });
		expect(bodies[4].value).toBeUndefined();
	});

	it('adds typed product ids to a bundle when products cannot be read', async () => {
		/** @type {any[]} */
		const bodies = [];
		const { root } = await start(
			{
				'GET /v1/admin/products': () => problem(403, 'no'),
				'POST /v1/admin/bundles': (/** @type {any} */ call) => {
					bodies.push(call.body);
					return answer(201, call.body);
				},
			},
			['bundles'],
		);
		const panel = panelOf(root, 'bundles');
		await click(buttonIn(panel, 'New bundle'));
		type(fieldIn(panel, 'Search', 0), 'prd_5');
		await click(buttonIn(panel, 'Find', 0));
		await click(buttonIn(panel, 'Find', 0));
		type(fieldIn(panel, 'Search', 0), '');
		await click(buttonIn(panel, 'Find', 0));
		type(fieldIn(panel, 'Name'), 'Pair');
		type(fieldIn(panel, 'Bundle price (PKR)'), '9');
		await click(buttonIn(panel, 'Save'));
		expect(bodies[0].items).toEqual([{ productId: 'prd_5', quantity: 1 }]);
	});
});

describe('promotions admin: loyalty', () => {
	it('looks up an account and adjusts points', async () => {
		const account = {
			userId: 'u 1',
			balance: 120,
			value: 1200,
			currency: 'PKR',
			lots: [{ id: 'l1', points: 150, left: 120, earnedAt: AT, expiresAt: null, orderId: 'ord_1' }],
			history: [{ at: AT, kind: 'earn', points: 150, orderId: 'ord_1', note: '' }],
			expiringSoon: [{ points: 20, expiresAt: AT }],
		};
		let adjust = () => answer(200, { ...account, balance: 130 });
		const { root, server } = await start(
			{
				'GET /v1/admin/loyalty/accounts/u%201': () => answer(200, account),
				'GET /v1/admin/loyalty/accounts/nobody': () => problem(403, 'no'),
				'POST /v1/admin/loyalty/accounts/u%201/adjust': () => adjust(),
			},
			['loyalty'],
		);
		const panel = panelOf(root, 'loyalty');
		await submit(fieldIn(panel, 'User id'));
		expect(server.calls.filter((call) => call.path.includes('loyalty'))).toHaveLength(0);
		type(fieldIn(panel, 'User id'), 'nobody');
		await submit(fieldIn(panel, 'User id'));
		expect(statuses(panel)).toContain('You are not allowed to do this.');
		type(fieldIn(panel, 'User id'), 'u 1');
		await submit(fieldIn(panel, 'User id'));
		expect(textOf(panel)).toContain('120 points (worth PKR 12.00)');
		expect(textOf(panel)).toContain('20 points expire on');
		expect(textOf(panel)).toContain('Earned');
		await click(buttonIn(panel, 'Change points'));
		expect(statuses(panel)).toContain('Check the amounts and numbers you typed.');
		type(fieldIn(panel, 'Points'), '10');
		type(fieldIn(panel, 'Note'), 'Gift');
		await click(buttonIn(panel, 'Change points'));
		expect(server.last('POST /v1/admin/loyalty/accounts/u%201/adjust')?.body).toEqual({ points: 10, note: 'Gift' });
		expect(statuses(panel)).toContain('Points changed.');
		expect(textOf(panel)).toContain('130 points');
		adjust = () => problem(422, 'The balance is 130 points; at most that many can be taken.');
		type(fieldIn(panel, 'Points'), '-500');
		await click(buttonIn(panel, 'Change points'));
		expect(statuses(panel)).toContain('The balance is 130 points; at most that many can be taken.');
	});
});
