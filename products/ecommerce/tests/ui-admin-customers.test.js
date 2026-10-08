// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mountCustomersAdmin } from '../ui/customers-admin.js';
import {
	answer,
	buttonIn,
	change,
	choose,
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
	type,
} from './ui-admin-helpers.js';

beforeEach(resetPage);
afterEach(resetPage);

const AT = '2026-10-01T10:00:00.000Z';
/** @param {Record<string, unknown>} [over] */
const customer = (over = {}) => ({
	userId: 'u1',
	name: 'Ana',
	email: 'ana@example.com',
	phone: '0300',
	blocked: false,
	blockedReason: '',
	rtoCount: 2,
	orderCount: 3,
	note: 'VIP',
	totalSpent: 500000,
	totalSpentText: 'PKR 5,000.00',
	ordersPlaced: 3,
	...over,
});

/** @param {Record<string, any>} [routes] @param {string[]} [features] */
const start = (routes = {}, features = ['checkout', 'reviews', 'reports', 'csv']) =>
	mountWith(mountCustomersAdmin, {
		features,
		routes: {
			'GET /v1/admin/customers': () =>
				answer(200, {
					items: [customer(), customer({ userId: 'u2', name: '', email: '', blocked: true, rtoCount: 0, phone: '' })],
					nextCursor: null,
					hasMore: false,
				}),
			...routes,
		},
	});

describe('customers admin: customers', () => {
	it('lists, filters and manages customers', async () => {
		/** @type {any[]} */
		const patches = [];
		const { host, root, server } = await start({
			'GET /v1/admin/customers/u1': () =>
				answer(200, {
					...customer(),
					recentOrders: [{ id: 'ord_1', number: 'SO-1', statusLabel: 'Delivered', totalText: 'PKR 10.00', placedAt: AT }],
				}),
			'GET /v1/admin/customers/u2': () => problem(404, 'There is no such customer.'),
			'PATCH /v1/admin/customers/u1': (/** @type {any} */ call) => {
				patches.push(call.body);
				if (call.body.blocked === true && !call.body.blockedReason) return problem(422, 'Give the reason for blocking.');
				const blocked = call.body.blocked ?? false;
				return answer(200, {
					...customer({
						blocked,
						blockedReason: blocked ? call.body.blockedReason : '',
						rtoCount: call.body.resetRto ? 0 : 2,
					}),
					recentOrders: [],
				});
			},
		});
		expect(host.getAttribute('data-ss-mounted')).toBe('customers-admin');
		const panel = panelOf(root, 'customers');
		expect(textOf(panel)).toContain('ana@example.com · 0300 · 3 orders · PKR 5,000.00 · 2 parcels returned');
		expect(textOf(panel)).toContain('u2');
		type(fieldIn(panel, 'Search'), 'ana');
		await submit(fieldIn(panel, 'Search'));
		await change(fieldIn(panel, 'Blocked'), 'true');
		expect(Object.fromEntries(server.last('GET /v1/admin/customers')?.url.searchParams ?? [])).toEqual({
			q: 'ana',
			blocked: 'true',
		});
		await click(buttonIn(panel, 'Open'));
		expect(textOf(panel)).toContain('SO-1');
		await click(buttonIn(panel, 'Block'));
		expect(statuses(panel)).toContain('Give the reason for blocking.');
		type(fieldIn(panel, 'Reason for blocking'), 'Fraud');
		await click(buttonIn(panel, 'Block'));
		expect(statuses(panel)).toContain('Blocked: this customer cannot order.');
		expect(textOf(panel)).toContain('Blocked because');
		expect(textOf(panel)).toContain('No orders yet.');
		await click(buttonIn(panel, 'Unblock'));
		expect(statuses(panel)).toContain('Unblocked.');
		type(fieldIn(panel, 'Only staff see this note'), 'Gold');
		await click(buttonIn(panel, 'Save'));
		await click(buttonIn(panel, 'Reset returned parcels'));
		expect(statuses(panel)).toContain('Returned parcels reset.');
		expect(shows(panel, 'Reset returned parcels')).toBe(false);
		expect(patches.slice(1)).toEqual([
			{ blocked: true, blockedReason: 'Fraud' },
			{ blocked: false },
			{ note: 'Gold' },
			{ resetRto: true },
		]);
		const loads = server.all('GET /v1/admin/customers').length;
		await click(buttonIn(panel, 'Back'));
		expect(server.all('GET /v1/admin/customers').length).toBe(loads + 1);
		await click(buttonIn(panel, 'Open', 1));
		expect(statuses(panel)).toContain('There is no such customer.');
		await click(buttonIn(panel, 'Back'));
		expect(shows(panel, 'Open')).toBe(true);
	});

	it('shows only switched-on tabs', async () => {
		const { root } = await start({}, ['reviews']);
		expect(root.querySelector('[data-tab="customers"]')).toBeNull();
		expect(root.querySelector('[data-tab="reviews"]')).not.toBeNull();
	});
});

describe('customers admin: reviews', () => {
	it('moderates reviews', async () => {
		const review = {
			id: 'rev_1',
			productId: 'prd_1',
			userId: 'u1',
			name: 'Ana',
			rating: 4,
			title: 'Good',
			body: 'Works well',
			reply: '',
			status: 'pending',
			createdAt: AT,
		};
		const { root, server } = await start({
			'GET /v1/admin/reviews': () =>
				answer(200, {
					items: [review, { ...review, id: 'rev_2', status: 'approved', rating: 7 }],
					nextCursor: null,
					hasMore: false,
				}),
			'POST /v1/admin/reviews/rev_1/approve': () => answer(200, { ...review, status: 'approved' }),
			'POST /v1/admin/reviews/rev_1/reject': () => answer(200, { ...review, status: 'rejected' }),
			'POST /v1/admin/reviews/rev_1/reply': (/** @type {any} */ call) =>
				call.body.reply.length > 5
					? problem(422, 'The reply is at most 2000 characters.')
					: answer(200, { ...review, reply: call.body.reply }),
			'DELETE /v1/admin/reviews/rev_1': () => answer(204),
		});
		const panel = await openTab(root, 'reviews');
		expect(server.last('GET /v1/admin/reviews')?.url.searchParams.get('status')).toBe('pending');
		expect(textOf(panel)).toContain('★★★★☆ Good');
		expect(textOf(panel)).toContain('Waiting · Ana · prd_1');
		await click(buttonIn(panel, 'Approve'));
		expect(textOf(panel)).toContain('Approved · Ana');
		expect(statuses(panel)).toContain('Saved.');
		await click(buttonIn(panel, 'Reject'));
		expect(shows(panel, 'Approve')).toBe(true);
		type(fieldIn(panel, 'Reply (shown under the review)'), 'Thanks!');
		await click(buttonIn(panel, 'Save reply'));
		expect(statuses(panel)).toContain('The reply is at most 2000 characters.');
		type(fieldIn(panel, 'Reply (shown under the review)'), 'Ta');
		await click(buttonIn(panel, 'Save reply'));
		expect(fieldIn(panel, 'Reply (shown under the review)').value).toBe('Ta');
		await click(buttonIn(panel, 'Delete'));
		await click(buttonIn(panel, 'Confirm delete'));
		expect(panel.querySelectorAll('.rows > li')).toHaveLength(1);
		await change(fieldIn(panel, 'Status'), '');
		expect(server.last('GET /v1/admin/reviews')?.url.searchParams.get('status')).toBeNull();
	});
});

describe('customers admin: reports and CSV', () => {
	it('runs reports and downloads them as CSV', async () => {
		const { root, server, saved } = await start({
			'GET /v1/admin/reports/sales': (/** @type {any} */ call) =>
				call.url.searchParams.get('by') === 'city'
					? answer(200, {
							from: AT,
							to: AT,
							currency: 'PKR',
							by: 'city',
							totals: { orders: 0, units: 0, revenue: 0, discount: 0 },
							rows: [],
						})
					: answer(200, {
							from: AT,
							to: AT,
							currency: 'PKR',
							by: 'product',
							totals: { orders: 2, units: 3, revenue: 300000, discount: 1000 },
							rows: [
								{ key: 'prd_1', name: 'Phone', units: 3, revenue: 300000, discount: 1000 },
								{ key: '', name: '', units: 1, revenue: 100, discount: 0 },
							],
						}),
			'GET /v1/admin/reports/stock-age': () =>
				answer(200, {
					rows: [
						{
							productId: 'prd_1',
							name: 'Phone',
							stock: 4,
							publishedAt: AT,
							lastSoldAt: null,
							daysListed: 10,
							daysSinceSale: 10,
						},
						{
							productId: 'prd_2',
							name: 'Case',
							stock: 1,
							publishedAt: AT,
							lastSoldAt: AT,
							daysListed: 3,
							daysSinceSale: 1,
						},
					],
				}),
			'GET /v1/admin/reports/returns': () =>
				answer(200, {
					from: AT,
					to: AT,
					rows: [
						{ productId: 'prd_1', name: 'Phone', sold: 4, claimed: 1, rate: 0.25 },
						{ productId: 'prd_2', name: 'Case', sold: 0, claimed: 1, rate: null },
					],
				}),
			'GET /v1/admin/reports/margin': () => problem(403, 'no'),
		});
		const panel = await openTab(root, 'reports');
		await change(fieldIn(panel, 'From'), '2026-09-01');
		await change(fieldIn(panel, 'To'), '2026-09-30');
		await click(buttonIn(panel, 'Show'));
		expect(Object.fromEntries(server.last('GET /v1/admin/reports/sales')?.url.searchParams ?? [])).toEqual({
			by: 'product',
			from: '2026-09-01',
			to: '2026-09-30',
		});
		expect(textOf(panel)).toContain('2 orders · 3 units · PKR 3,000.00');
		expect(textOf(panel)).toContain('None');
		await click(buttonIn(panel, 'Download CSV'));
		expect(saved[0]?.name).toBe('report-sales_product.csv');
		expect(saved[0]?.text).toContain('Phone,3,3000.00,10.00');
		await change(fieldIn(panel, 'Report'), 'sales_city');
		await click(buttonIn(panel, 'Show'));
		expect(statuses(panel)).toContain('Nothing in this period.');
		expect(shows(panel, 'Download CSV')).toBe(false);
		await change(fieldIn(panel, 'Report'), 'stock_age');
		await click(buttonIn(panel, 'Show'));
		expect(server.last('GET /v1/admin/reports/stock-age')?.url.search).toBe('');
		expect(textOf(panel)).toContain('2026-10-01');
		await change(fieldIn(panel, 'Report'), 'return_rate');
		await click(buttonIn(panel, 'Show'));
		expect(textOf(panel)).toContain('25 %');
		await change(fieldIn(panel, 'Report'), 'margin');
		await click(buttonIn(panel, 'Show'));
		expect(statuses(panel)).toContain('You are not allowed to do this.');
		expect(buttonIn(panel, 'Show').disabled).toBe(true);
	});

	it('shows margin totals', async () => {
		const { root, saved } = await start(
			{
				'GET /v1/admin/reports/margin': () =>
					answer(200, {
						from: AT,
						to: AT,
						currency: 'PKR',
						totals: { units: 1, revenue: 1000, cost: 600, margin: 400 },
						rows: [{ productId: 'prd_1', name: 'Phone', units: 1, revenue: 1000, cost: 600, margin: 400 }],
					}),
			},
			['reports'],
		);
		const panel = panelOf(root, 'reports');
		await change(fieldIn(panel, 'Report'), 'margin');
		await click(buttonIn(panel, 'Show'));
		expect(textOf(panel)).toContain('Sales PKR 10.00 · cost PKR 6.00 · margin PKR 4.00');
		await click(buttonIn(panel, 'Download CSV'));
		expect(saved[0]?.text).toContain('Phone,1,10.00,6.00,4.00');
	});

	it('exports and imports CSV files', async () => {
		/** @type {any[]} */
		const imports = [];
		let check = () =>
			answer(200, {
				dryRun: true,
				rows: 2,
				created: 1,
				updated: 0,
				errors: [{ line: 3, path: '/price', message: 'Give a price.' }],
			});
		const { root, server, saved } = await start({
			'GET /v1/admin/csv/products': () => new Response('﻿name\r\nPhone\r\n', { status: 200 }),
			'GET /v1/admin/csv/orders': () => problem(422, 'More than 10000 orders: choose shorter dates.'),
			'POST /v1/admin/csv/products': (/** @type {any} */ call) => {
				imports.push(call.body);
				return call.body.dryRun ? check() : answer(200, { dryRun: false, rows: 2, created: 1, updated: 1, errors: [] });
			},
		});
		const panel = await openTab(root, 'csv');
		await click(buttonIn(panel, 'Export products'));
		expect(saved[0]).toEqual({ name: 'products.csv', text: '﻿name\r\nPhone\r\n' });
		expect(statuses(panel)).toContain('products.csv is ready.');
		await change(fieldIn(panel, 'From'), '2026-09-01');
		await click(buttonIn(panel, 'Export orders'));
		expect(server.last('GET /v1/admin/csv/orders')?.url.searchParams.get('from')).toBe('2026-09-01T00:00:00.000Z');
		expect(statuses(panel)).toContain('More than 10000 orders: choose shorter dates.');
		// import
		await click(buttonIn(panel, 'Check the file'));
		expect(statuses(panel)).toContain('Pick a CSV file first.');
		const file = /** @type {any} */ ({ name: 'p.csv', type: 'text/csv', size: 10, text: async () => 'name,price\r\nMug,\r\n' });
		await choose(fieldIn(panel, 'CSV file'), [file]);
		await click(buttonIn(panel, 'Check the file'));
		expect(statuses(panel)).toContain('1 problems in 2 rows. Fix them and check again.');
		expect(textOf(panel)).toContain('Give a price.');
		expect(shows(panel, 'Import')).toBe(false);
		check = () => answer(200, { dryRun: true, rows: 2, created: 1, updated: 1, errors: [] });
		await click(buttonIn(panel, 'Check the file'));
		expect(statuses(panel)).toContain('2 rows are fine: 1 new and 1 changed products.');
		await click(buttonIn(panel, 'Import'));
		expect(imports.at(-1)).toEqual({ csv: 'name,price\r\nMug,\r\n', dryRun: false });
		expect(statuses(panel)).toContain('Imported: 1 new and 1 changed products.');
		expect(shows(panel, 'Import')).toBe(false);
		await click(buttonIn(panel, 'Check the file'));
		server.routes['POST /v1/admin/csv/products'] = () => problem(422, '1 problems in the file: nothing was imported.');
		await click(buttonIn(panel, 'Import'));
		expect(statuses(panel)).toContain('1 problems in the file: nothing was imported.');
		await click(buttonIn(panel, 'Check the file'));
		expect(statuses(panel)).toContain('1 problems in the file: nothing was imported.');
		await choose(fieldIn(panel, 'CSV file'), [file]);
		expect(shows(panel, 'Import')).toBe(false);
		server.routes['GET /v1/admin/csv/products'] = () => {
			throw new Error('offline');
		};
		await click(buttonIn(panel, 'Export products'));
		expect(statuses(panel)).toContain('The shop cannot be reached right now. Please try again.');
		server.routes['GET /v1/admin/csv/products'] = () => new Response('oops', { status: 500 });
		await click(buttonIn(panel, 'Export products'));
		expect(statuses(panel)).toContain('Something went wrong. Please try again.');
	});

	it('cannot fetch files while signed out', async () => {
		const { root, server } = await mountWith(mountCustomersAdmin, { features: ['csv'], ticket: null });
		const panel = panelOf(root, 'csv');
		await click(buttonIn(panel, 'Export products'));
		expect(statuses(panel)).toContain('Signed out. Sign in again to keep working.');
		expect(server.calls).toHaveLength(0);
	});
});
