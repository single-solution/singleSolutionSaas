// @vitest-environment jsdom
/**
 * The customers admin widget's tools the API had before the widget used them: the sales summary, sell-through and
 * oldest stock reports, the customers CSV export, a review set back to waiting, and the opened-by-me marker with its
 * filter on customers.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mountCustomersAdmin } from '../ui/customers-admin.js';
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
	textOf,
	TEXTS,
	tick,
} from './ui-admin-helpers.js';
import { detailOf, menuEntries, pickMenu } from './ui-admin-screens.js';

beforeEach(resetPage);
afterEach(resetPage);

const AT = '2026-10-01T10:00:00.000Z';
const customer = {
	id: 'cus_1',
	userId: 'u1',
	name: 'Ana',
	email: 'ana@example.com',
	phone: '+12025550143',
	blocked: false,
	blockedReason: '',
	rtoCount: 0,
	orderCount: 1,
	note: '',
	totalSpent: 1000,
	totalSpentText: 'USD 10.00',
	ordersPlaced: 1,
	createdAt: AT,
	updatedAt: AT,
};

/** @param {Record<string, any>} [routes] @param {string[]} [features] */
const start = (routes = {}, features = ['checkout', 'reviews', 'reports', 'csv']) =>
	mountWith(mountCustomersAdmin, {
		features,
		settings: { orders: { statuses: [{ key: 'delivered', label: 'Delivered', role: 'delivered' }] } },
		routes: {
			'GET /v1/admin/customers': () => answer(200, { items: [customer], nextCursor: null, hasMore: false }),
			'GET /v1/admin/customers/count': () => answer(200, { count: 1, capped: false }),
			'GET /v1/admin/customers/counts': () => answer(200, { total: 1, groups: { false: 1 } }),
			'GET /v1/admin/customers/cus_1': () => answer(200, { ...customer, recentOrders: [] }),
			'POST /v1/admin/customers/cus_1/seen': () => answer(200, { seen: true }),
			...routes,
		},
	});

/** The query of the last call to a route. @param {any} server @param {string} key */
const paramsOf = (server, key) => Object.fromEntries(server.last(key)?.url.searchParams ?? []);

describe('customers admin: the opened-by-me marker', () => {
	it('marks a customer opened, and shows only the ones this staff member has not opened', async () => {
		const { root, server } = await start();
		expect(server.all('POST /v1/admin/customers/cus_1/seen')).toHaveLength(1);
		const panel = panelOf(root, 'customers');
		await tick(checkIn(panel, 'Only customers I have not opened'), true);
		expect(paramsOf(server, 'GET /v1/admin/customers')).toEqual({ unseen: 'true' });
		expect(paramsOf(server, 'GET /v1/admin/customers/count')).toEqual({ unseen: 'true' });
		expect(paramsOf(server, 'GET /v1/admin/customers/counts')).toEqual({ unseen: 'true', by: 'blocked' });
	});
});

describe('customers admin: reports the API has', () => {
	it('shows the sales summary with its days, sell-through and the oldest stock, and downloads them', async () => {
		const { root, server, saved } = await start({
			'GET /v1/admin/reports/summary': () =>
				answer(200, {
					from: AT,
					to: AT,
					currency: 'USD',
					statuses: null,
					orders: 3,
					total: 450000,
					goods: 420000,
					delivery: 30000,
					fees: 500,
					discount: 1000,
					refunded: 2000,
					units: 5,
					days: [
						{ day: '2026-09-30', orders: 1, total: 150000 },
						{ day: '2026-10-01', orders: 2, total: 300000 },
					],
				}),
			'GET /v1/admin/reports/sell-through': () =>
				answer(200, {
					from: AT,
					to: AT,
					rows: [
						{ productId: 'prd_1', name: 'Lamp', sold: 3, stock: 1, rate: 0.75 },
						{ productId: 'prd_2', name: 'Chair', sold: 0, stock: 0, rate: null },
					],
				}),
			'GET /v1/admin/reports/oldest-stock': () =>
				answer(200, {
					rows: [
						{
							productId: 'prd_2',
							variantId: 'var_2',
							name: 'Chair',
							variantName: 'Blue / Large',
							sku: 'CH-2',
							grade: null,
							stock: 4,
							since: '2026-06-01T08:00:00.000Z',
							days: 122,
						},
					],
				}),
		});
		const panel = await openTab(root, 'reports');
		// the summary comes first
		expect(fieldIn(panel, 'Report').value).toBe('summary');
		await change(fieldIn(panel, 'From'), '2026-09-30');
		await click(buttonIn(panel, 'Show'));
		expect(paramsOf(server, 'GET /v1/admin/reports/summary')).toEqual({ from: '2026-09-30' });
		expect(textOf(panel.querySelector('.facts') ?? panel)).toBe(
			'Orders3Units5SalesUSD 4,500.00GoodsUSD 4,200.00DeliveryUSD 300.00FeesUSD 5.00DiscountUSD 10.00RefundedUSD 20.00',
		);
		expect(textOf(panel.querySelector('table') ?? panel)).toContain('2026-10-01');
		await click(buttonIn(panel, 'Download CSV'));
		expect(saved.at(-1)).toEqual({
			name: 'report-summary.csv',
			text: expect.stringContaining('2026-10-01,2,3000.00'),
		});
		await change(fieldIn(panel, 'Report'), 'sell_through');
		await click(buttonIn(panel, 'Show'));
		expect(textOf(panel)).toContain('75 %');
		expect(textOf(panel)).toContain('Sell-through');
		// oldest stock is now: no date range
		await change(fieldIn(panel, 'Report'), 'oldest_stock');
		expect(() => fieldIn(panel, 'From')).toThrow();
		await click(buttonIn(panel, 'Show'));
		expect(server.last('GET /v1/admin/reports/oldest-stock')?.url.search).toBe('');
		expect(textOf(panel)).toContain('Blue / Large');
		expect(textOf(panel)).toContain('2026-06-01');
		await click(buttonIn(panel, 'Download CSV'));
		expect(saved.at(-1)?.text).toContain('Chair,Blue / Large,CH-2,4,2026-06-01,122');
		server.routes['GET /v1/admin/reports/oldest-stock'] = () => problem(422, 'validation_failed');
		await click(buttonIn(panel, 'Show'));
		expect(statuses(panel)).toContain(TEXTS['problem.validation_failed']);
		expect(shows(panel, 'Download CSV')).toBe(false);
	});
});

describe('customers admin: CSV of customers', () => {
	it('exports the customers, and only with Cart and checkout', async () => {
		const { root, saved, server } = await start({
			'GET /v1/admin/csv/customers': () => new Response('name\r\nAna\r\n', { status: 200 }),
		});
		const panel = await openTab(root, 'csv');
		await click(buttonIn(panel, 'Export customers'));
		expect(saved).toEqual([{ name: 'customers.csv', text: 'name\r\nAna\r\n' }]);
		expect(statuses(panel)).toContain('customers.csv is ready.');
		server.routes['GET /v1/admin/csv/customers'] = () => problem(403, 'forbidden');
		await click(buttonIn(panel, 'Export customers'));
		expect(statuses(panel)).toContain(TEXTS['admin.notAllowed']);
		resetPage();
		const without = await start({}, ['csv']);
		expect(shows(panelOf(without.root, 'csv'), 'Export customers')).toBe(false);
	});
});

describe('customers admin: a review back to waiting', () => {
	it('sets an approved review back to waiting', async () => {
		const review = {
			id: 'rev_1',
			productId: 'prd_1',
			productName: 'Lamp',
			userId: 'u1',
			orderId: 'ord_1',
			name: 'Ana',
			rating: 5,
			title: 'Bright',
			body: 'Very bright',
			reply: '',
			status: 'approved',
			createdAt: AT,
			updatedAt: AT,
		};
		let reply = () => problem(404, 'not_found');
		const { root, server } = await start({
			'GET /v1/admin/reviews': () => answer(200, { items: [review], nextCursor: null, hasMore: false }),
			'GET /v1/admin/reviews/count': () => answer(200, { count: 1, capped: false }),
			'GET /v1/admin/reviews/counts': () => answer(200, { total: 1, groups: { approved: 1 } }),
			'POST /v1/admin/reviews/rev_1/pending': () => reply(),
		});
		const panel = await openTab(root, 'reviews');
		await click(/** @type {HTMLElement} */ (panel.querySelector('.chipbar button[data-value=""]')));
		const pane = detailOf(panel);
		await pickMenu(pane, 'Back to waiting');
		expect(server.all('POST /v1/admin/reviews/rev_1/pending')).toHaveLength(1);
		expect(statuses(pane)).toContain(TEXTS['problem.not_found']);
		reply = () => answer(200, { ...review, productName: undefined, status: 'pending' });
		await pickMenu(pane, 'Back to waiting');
		expect(statuses(pane)).toContain('Saved.');
		expect(pane.querySelector('.detail-head .badge')?.textContent).toBe('Waiting');
		// a waiting review is not set back again
		expect(menuEntries(pane)).not.toContain('Back to waiting');
		expect(textOf(pane)).toContain('Lamp');
	});
});
