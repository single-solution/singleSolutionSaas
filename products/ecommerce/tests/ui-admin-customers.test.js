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
	invalid,
	mountWith,
	openTab,
	panelOf,
	problem,
	resetPage,
	SERVER_ENGLISH,
	shows,
	statuses,
	submit,
	textOf,
	TEXTS,
	type,
} from './ui-admin-helpers.js';
import {
	chipCount,
	chipOf,
	confirmDialog,
	detailOf,
	dialogOf,
	dialogStatus,
	hasDialog,
	listCount,
	menuEntries,
	openRow,
	pickMenu,
	rowOf,
	rowsOf,
	submitDialog,
} from './ui-admin-screens.js';

beforeEach(resetPage);
afterEach(resetPage);

const AT = '2026-10-01T10:00:00.000Z';
/** @param {Record<string, unknown>} [over] */
const customer = (over = {}) => ({
	userId: 'u1',
	name: 'Ana',
	email: 'ana@example.com',
	phone: '+12025550143',
	blocked: false,
	blockedReason: '',
	rtoCount: 2,
	orderCount: 3,
	note: 'VIP',
	totalSpent: 500000,
	totalSpentText: 'USD 5,000.00',
	ordersPlaced: 3,
	createdAt: AT,
	updatedAt: AT,
	...over,
});

/** @param {Record<string, any>} [routes] @param {string[]} [features] */
const start = (routes = {}, features = ['checkout', 'reviews', 'reports', 'csv', 'returns']) =>
	mountWith(mountCustomersAdmin, {
		features,
		settings: { orders: { statuses: [{ key: 'delivered', label: 'Delivered' }] } },
		routes: {
			'GET /v1/admin/customers': () =>
				answer(200, {
					items: [
						customer(),
						customer({ userId: 'u2', name: '', email: '', blocked: true, rtoCount: 0, phone: '', createdAt: null }),
						customer({ userId: 'u3', name: 'Bo', rtoCount: 0 }),
					],
					nextCursor: null,
					hasMore: false,
				}),
			'GET /v1/admin/customers/count': () => answer(200, { count: 3, capped: false }),
			'GET /v1/admin/customers/counts': () => answer(200, { total: 3, groups: { true: 1, false: 1, none: 1 } }),
			'GET /v1/admin/customers/u1': () =>
				answer(200, {
					...customer(),
					recentOrders: [
						{ id: 'ord_1', number: 'SO-1', statusLabel: 'Delivered', total: 1000, currency: 'USD', placedAt: AT },
					],
				}),
			'GET /v1/admin/customers/u2': () => problem(404, 'not_found'),
			'GET /v1/admin/returns': () =>
				answer(200, {
					items: [
						{
							id: 'ret_1',
							reference: 'R-1',
							orderNumber: 'SO-1',
							kind: 'warranty',
							kindLabel: 'Warranty',
							status: 'requested',
							statusLabel: 'Requested',
							role: 'requested',
						},
					],
					nextCursor: null,
					hasMore: false,
				}),
			...routes,
		},
	});

describe('customers admin: customers', () => {
	it('lists customers with counts and filters them', async () => {
		const { host, root, server } = await start();
		expect(host.getAttribute('data-ss-mounted')).toBe('customers-admin');
		const panel = panelOf(root, 'customers');
		expect(textOf(rowOf(panel, 'u1'))).toContain('ana@example.com · +12025550143 · 3 orders · 2 packages returned');
		expect(textOf(rowOf(panel, 'u1'))).toContain('USD 5,000.00');
		expect(rowOf(panel, 'u1').querySelector('.dot.warning')).not.toBeNull();
		expect(rowOf(panel, 'u2').querySelector('.dot.danger')).not.toBeNull();
		expect(rowOf(panel, 'u3').querySelector('.dot.neutral')?.getAttribute('aria-label')).toBe('Can order');
		expect(textOf(rowOf(panel, 'u2'))).toContain('u2');
		expect(listCount(panel)).toBe('3');
		expect(chipCount(panel, 'true')).toBe('1');
		expect(chipCount(panel, 'false')).toBe('2');
		type(fieldIn(panel, 'Search'), 'ana');
		await submit(fieldIn(panel, 'Search'));
		await click(chipOf(panel, 'true'));
		expect(Object.fromEntries(server.last('GET /v1/admin/customers')?.url.searchParams ?? [])).toEqual({
			q: 'ana',
			blocked: 'true',
		});
		expect(Object.fromEntries(server.last('GET /v1/admin/customers/counts')?.url.searchParams ?? [])).toEqual({
			q: 'ana',
			by: 'blocked',
		});
		server.routes['GET /v1/admin/customers/counts'] = () => problem(403, 'forbidden');
		await click(chipOf(panel, 'false'));
		expect(chipCount(panel, 'true')).toBe('');
		await openRow(panel, 'u2');
		expect(statuses(detailOf(panel))).toContain(TEXTS['problem.not_found']);
	});

	it('shows a customer and blocks, unblocks, notes and resets them', async () => {
		/** @type {any[]} */
		const patches = [];
		const { root, server } = await start({
			'PATCH /v1/admin/customers/u1': (/** @type {any} */ call) => {
				patches.push(call.body);
				if (call.body.blocked === true && !call.body.blockedReason) return invalid('/blockedReason');
				if (call.body.blocked === false && patches.length === 3) return problem(500, 'internal_error');
				const blocked = call.body.blocked ?? false;
				return answer(200, {
					...customer({
						blocked,
						blockedReason: blocked ? call.body.blockedReason : '',
						rtoCount: call.body.resetRto ? 0 : 2,
						note: call.body.note ?? '',
					}),
					recentOrders: [],
				});
			},
		});
		const panel = panelOf(root, 'customers');
		const pane = detailOf(panel);
		for (const part of [
			'Ana',
			'ana@example.com',
			'u1',
			'USD 5,000.00',
			'SO-1',
			'Delivered',
			'USD 10.00',
			'VIP',
			'Customer since',
		])
			expect(textOf(pane)).toContain(part);
		expect(server.last('GET /v1/admin/returns')?.url.searchParams.get('userId')).toBe('u1');
		expect(textOf(pane)).toContain('R-1 · Order SO-1 · Warranty');
		expect(menuEntries(pane)).toEqual(['Reset returned packages', 'Add address', 'Edit tags']);
		// block with a reason
		await click(buttonIn(pane, 'Block'));
		expect(textOf(dialogOf(root))).toContain('A blocked customer cannot order');
		await submitDialog(root);
		expect(dialogStatus(root)).toBe(TEXTS['problem.field.blockedReason']);
		type(fieldIn(dialogOf(root), 'Reason for blocking'), 'Fraud');
		await submitDialog(root);
		expect(hasDialog(root)).toBe(false);
		expect(statuses(pane)).toContain('Blocked: this customer cannot order.');
		expect(textOf(pane)).toContain('Blocked because');
		expect(textOf(pane)).toContain('No orders yet.');
		expect(rowOf(panel, 'u1').querySelector('.dot.danger')).not.toBeNull();
		// unblock (a failure shows in the detail)
		await click(buttonIn(pane, 'Unblock'));
		expect(statuses(pane)).toContain(TEXTS['admin.failed']);
		await click(buttonIn(pane, 'Unblock'));
		expect(statuses(pane)).toContain('Unblocked.');
		// note
		await click(buttonIn(pane, 'Edit note'));
		type(fieldIn(dialogOf(root), 'Only staff see this note'), '');
		await submitDialog(root);
		expect(textOf(pane)).toContain('No staff note.');
		// reset the returned packages
		await pickMenu(pane, 'Reset returned packages');
		expect(textOf(dialogOf(root))).toContain('Set the 2 returned packages back to 0.');
		await submitDialog(root);
		expect(statuses(pane)).toContain('Returned packages reset.');
		expect(menuEntries(pane)).toEqual(['Add address', 'Edit tags']);
		expect(patches).toEqual([
			{ blocked: true, blockedReason: '' },
			{ blocked: true, blockedReason: 'Fraud' },
			{ blocked: false },
			{ blocked: false },
			{ note: '' },
			{ resetRto: true },
		]);
	});

	it('adds a customer, sorts the newest first, keeps addresses, marks a loyalty member and deletes (E46, E47)', async () => {
		const added = customer({ id: 'cus_n1', userId: '', guest: true, name: 'Nia', ordersPlaced: 0, orderCount: 0, rtoCount: 0 });
		/** @type {any[]} */
		const calls = [];
		/** @param {Record<string, unknown>} over */
		const detailOf_ = (over) => answer(200, { ...added, addresses: [], recentOrders: [], ...over });
		const { root, server } = await start(
			{
				'GET /v1/admin/customers': () => answer(200, { items: [added], nextCursor: null, hasMore: false }),
				'GET /v1/admin/customers/cus_n1': () => detailOf_({}),
				'POST /v1/admin/customers': (/** @type {any} */ call) => {
					calls.push(['POST', call.body]);
					return call.body.phone ? answer(201, { ...added, addresses: [], recentOrders: [] }) : invalid('/phone');
				},
				'PUT /v1/admin/customers/cus_n1/addresses': (/** @type {any} */ call) => {
					calls.push(['PUT', call.body]);
					return detailOf_({ addresses: call.body.addresses });
				},
				'PATCH /v1/admin/customers/cus_n1': (/** @type {any} */ call) => {
					calls.push(['PATCH', call.body]);
					return detailOf_({ loyaltyMember: call.body.loyaltyMember });
				},
				'DELETE /v1/admin/customers/cus_n1': () => {
					calls.push(['DELETE']);
					return answer(204, null);
				},
			},
			['checkout', 'loyalty'],
		);
		const panel = panelOf(root, 'customers');
		// the newest first
		await change(fieldIn(panel, 'Order'), 'newest');
		expect(server.last('GET /v1/admin/customers')?.url.searchParams.get('sort')).toBe('newest');
		// add a customer without an account, with opening points
		await click(buttonIn(panel, 'Add customer'));
		await submitDialog(root);
		expect(dialogStatus(root)).not.toBe('');
		type(fieldIn(dialogOf(root), 'Full name'), 'Nia');
		type(fieldIn(dialogOf(root), 'Phone'), '+15550001234');
		type(fieldIn(dialogOf(root), 'Opening loyalty points'), '50');
		await submitDialog(root);
		expect(hasDialog(root)).toBe(false);
		expect(calls.at(-1)).toEqual(['POST', { name: 'Nia', phone: '+15550001234', points: 50, loyaltyMember: false }]);
		const pane = detailOf(panel);
		expect(textOf(pane)).toContain('No addresses kept.');
		expect(textOf(pane)).toContain('Loyalty memberNo');
		// an address
		await pickMenu(pane, 'Add address');
		type(fieldIn(dialogOf(root), 'Address'), '1 Main Street');
		type(fieldIn(dialogOf(root), 'City'), 'Springfield');
		await submitDialog(root);
		expect(calls.at(-1)).toEqual([
			'PUT',
			{
				addresses: [
					{
						name: 'Nia',
						phone: '+12025550143',
						line1: '1 Main Street',
						line2: '',
						city: 'Springfield',
						area: '',
						region: '',
						postalCode: '',
						country: '',
						notes: '',
					},
				],
			},
		]);
		expect(textOf(pane)).toContain('Nia, +12025550143, 1 Main Street, Springfield');
		// a loyalty member
		await pickMenu(pane, 'Mark as loyalty member');
		expect(calls.at(-1)).toEqual(['PATCH', { loyaltyMember: true }]);
		expect(statuses(pane)).toContain('Marked as a loyalty member.');
		expect(menuEntries(pane)).toContain('Remove from loyalty members');
		// delete a customer without orders
		await pickMenu(pane, 'Delete customer');
		expect(textOf(dialogOf(root))).toContain('Nia and their loyalty points are deleted for good.');
		await submitDialog(root);
		expect(calls.at(-1)).toEqual(['DELETE']);
	});

	it('shows only switched-on sections, and no claims without returns', async () => {
		const { root, server } = await start({}, ['checkout', 'reviews']);
		expect(root.querySelector('[data-section="reports"]')).toBeNull();
		expect(root.querySelector('[data-section="reviews"]')).not.toBeNull();
		expect(textOf(detailOf(panelOf(root, 'customers')))).toContain('Ana');
		expect(server.all('GET /v1/admin/returns')).toHaveLength(0);
		const other = await start({}, ['reviews']);
		expect(other.root.querySelector('[data-section="customers"]')).toBeNull();
	});

	it('opens a guest by customer id and lists no claims for them (K-6)', async () => {
		const guest = customer({ id: 'cus_g1', userId: '', guest: true, name: 'Gail' });
		/** @type {any[]} */
		const patches = [];
		const { root, server } = await start({
			'GET /v1/admin/customers': () => answer(200, { items: [guest], nextCursor: null, hasMore: false }),
			'GET /v1/admin/customers/cus_g1': () => answer(200, { ...guest, recentOrders: [] }),
			'PATCH /v1/admin/customers/cus_g1': (/** @type {any} */ call) => {
				patches.push(call.body);
				return answer(200, { ...guest, note: call.body.note, recentOrders: [] });
			},
		});
		const panel = panelOf(root, 'customers');
		expect(rowOf(panel, 'cus_g1')).not.toBeNull();
		const pane = detailOf(panel);
		expect(textOf(pane)).toContain('Guest (no account)');
		expect(server.all('GET /v1/admin/returns')).toHaveLength(0);
		await click(buttonIn(pane, 'Edit note'));
		type(fieldIn(dialogOf(root), 'Only staff see this note'), 'Calls at night');
		await submitDialog(root);
		expect(patches).toEqual([{ note: 'Calls at night' }]);
		expect(textOf(pane)).toContain('Calls at night');
	});

	it('shows the customer fields and edits them', async () => {
		const rules = { choices: [], unit: '', min: null, max: null, decimals: 0, dates: 'any', multiple: false, maxValues: 1 };
		const customerFields = [
			{
				...rules,
				id: 'att_tax',
				name: 'Tax ID',
				type: 'text',
				format: null,
				required: false,
				requiredAt: null,
				shopper: false,
				active: true,
			},
			{
				...rules,
				id: 'att_vip',
				name: 'Trade account',
				type: 'yes_no',
				format: null,
				required: false,
				requiredAt: null,
				shopper: false,
				active: true,
			},
		];
		const kept = customer({ id: 'cus_g1', userId: '', guest: true, name: 'Gail', customerFields, fields: { att_tax: 'TX-1' } });
		const { root, server } = await start({
			'GET /v1/admin/customers': () => answer(200, { items: [kept], nextCursor: null, hasMore: false }),
			'GET /v1/admin/customers/cus_g1': () => answer(200, { ...kept, recentOrders: [] }),
			'PATCH /v1/admin/customers/cus_g1': (/** @type {any} */ call) =>
				answer(200, { ...kept, fields: { att_tax: 'TX-1', att_vip: call.body.fields.att_vip }, recentOrders: [] }),
		});
		const pane = detailOf(panelOf(root, 'customers'));
		expect(textOf(pane)).toContain('Tax IDTX-1');
		expect(textOf(pane)).toContain(`Trade account${TEXTS['catalogAdmin.notSet']}`);
		await pickMenu(pane, 'Edit fields');
		await change(fieldIn(dialogOf(root), 'Trade account'), 'true');
		await submitDialog(root);
		expect(server.last('PATCH /v1/admin/customers/cus_g1')?.body).toEqual({ fields: { att_tax: 'TX-1', att_vip: true } });
		expect(textOf(pane)).toContain('Trade accountYes');
	});

	it('shows an empty list', async () => {
		const { root } = await start({
			'GET /v1/admin/customers': () => answer(200, { items: [], nextCursor: null, hasMore: false }),
		});
		const panel = panelOf(root, 'customers');
		expect(statuses(panel)).toContain('No customers match.');
		expect(textOf(detailOf(panel))).toContain('No customers to show.');
	});
});

describe('customers admin: reviews', () => {
	const review = {
		id: 'rev_1',
		productId: 'prd_1',
		userId: 'u1',
		orderId: 'ord_1',
		name: 'Ana',
		rating: 4,
		title: 'Good',
		body: 'Works well',
		reply: '',
		status: 'pending',
		createdAt: AT,
		updatedAt: AT,
	};

	it('moderates reviews with counts, replies, filters by product and deletes', async () => {
		let reviews = [
			{ ...review, productName: 'Phone' },
			{ ...review, id: 'rev_2', title: '', status: 'approved', rating: 7, reply: 'Thanks', productName: '' },
		];
		const { root, server } = await start({
			'GET /v1/admin/reviews': () => answer(200, { items: reviews, nextCursor: null, hasMore: false }),
			'GET /v1/admin/reviews/count': () => answer(200, { count: 2, capped: false }),
			'GET /v1/admin/reviews/counts': () => answer(200, { total: 2, groups: { pending: 1, approved: 1 } }),
			'POST /v1/admin/reviews/rev_1/approve': () => answer(200, { ...review, status: 'approved' }),
			'POST /v1/admin/reviews/rev_1/reject': () => problem(403, 'forbidden'),
			'POST /v1/admin/reviews/rev_1/reply': (/** @type {any} */ call) =>
				call.body.reply.length > 5
					? invalid('/reply')
					: answer(200, { ...review, status: 'approved', reply: call.body.reply }),
			'DELETE /v1/admin/reviews/rev_1': () => {
				reviews = reviews.filter((item) => item.id !== 'rev_1');
				return answer(204);
			},
		});
		const panel = await openTab(root, 'reviews');
		expect(server.last('GET /v1/admin/reviews')?.url.searchParams.get('status')).toBe('pending');
		expect(chipOf(panel, 'pending').getAttribute('aria-pressed')).toBe('true');
		expect(chipCount(panel, 'pending')).toBe('1');
		expect(chipCount(panel, 'rejected')).toBe('0');
		expect(listCount(panel)).toBe('2');
		expect(textOf(rowOf(panel, 'rev_1'))).toContain('Good');
		expect(textOf(rowOf(panel, 'rev_1'))).toContain('★★★★☆');
		expect(textOf(rowOf(panel, 'rev_1'))).toContain('Waiting · Ana · Phone');
		expect(textOf(rowOf(panel, 'rev_2'))).toContain('★★★★★');
		expect(textOf(rowOf(panel, 'rev_2'))).toContain('Approved · Ana · prd_1');
		const pane = detailOf(panel);
		expect(textOf(pane)).toContain('Works well');
		expect(textOf(pane)).toContain('No reply yet.');
		expect(textOf(pane)).toContain('4/5');
		expect(textOf(pane)).toContain('Phone (prd_1)');
		// moderation
		await click(buttonIn(pane, 'Reject'));
		expect(statuses(pane)).toContain('You are not allowed to do this.');
		await click(buttonIn(pane, 'Approve'));
		expect(statuses(pane)).toContain('Saved.');
		expect(shows(pane, 'Approve')).toBe(false);
		expect(textOf(rowOf(panel, 'rev_1'))).toContain('Approved · Ana · Phone');
		// reply
		await pickMenu(pane, 'Reply');
		type(fieldIn(dialogOf(root), 'Reply (shown under the review)'), 'Thanks!');
		await submitDialog(root);
		expect(dialogStatus(root)).toBe(TEXTS['problem.field.reply']);
		type(fieldIn(dialogOf(root), 'Reply (shown under the review)'), 'Ta');
		await submitDialog(root);
		expect(textOf(pane)).toContain('Ta');
		expect(menuEntries(pane)).toContain('Edit reply');
		// the product's reviews, then all of them again
		await pickMenu(pane, 'Reviews of this product');
		expect(server.last('GET /v1/admin/reviews')?.url.searchParams.get('productId')).toBe('prd_1');
		expect(server.last('GET /v1/admin/reviews/counts')?.url.searchParams.get('productId')).toBe('prd_1');
		expect(textOf(panel)).toContain('Product Phone');
		await click(/** @type {HTMLElement} */ (panel.querySelector('button[aria-label="Show the reviews of all products"]')));
		expect(server.last('GET /v1/admin/reviews')?.url.searchParams.get('productId')).toBeNull();
		// delete, behind the typed confirmation
		await click(chipOf(panel, ''));
		expect(server.last('GET /v1/admin/reviews')?.url.searchParams.get('status')).toBeNull();
		await openRow(panel, 'rev_1');
		await pickMenu(detailOf(panel), 'Delete review');
		expect((await confirmDialog(root, 'delete')).disabled).toBe(false);
		await submitDialog(root);
		expect(rowsOf(panel)).toHaveLength(1);
		expect(textOf(detailOf(panel))).toContain('Thanks');
		expect(shows(detailOf(panel), 'Approve')).toBe(false);
	});

	it('shows no reviews', async () => {
		const { root } = await start(
			{ 'GET /v1/admin/reviews': () => answer(200, { items: [], nextCursor: null, hasMore: false }) },
			['reviews'],
		);
		const panel = panelOf(root, 'reviews');
		expect(statuses(panel)).toContain('No reviews match.');
		expect(textOf(detailOf(panel))).toContain('No reviews to show.');
	});
});

describe('customers admin: reports and CSV', () => {
	it('runs reports and downloads them as CSV', async () => {
		const { root, server, saved } = await start({
			'GET /v1/admin/reports/groupings': () =>
				answer(200, {
					items: [
						{ key: 'product', label: 'Product', kind: 'built_in' },
						{ key: 'city', label: 'City', kind: 'built_in' },
						{ key: 'payment_method', label: 'Payment method', kind: 'built_in' },
						{ key: 'field:att_1', label: 'Material', kind: 'field' },
					],
				}),
			'GET /v1/admin/reports/sales': (/** @type {any} */ call) =>
				call.url.searchParams.get('by') === 'field:att_1'
					? answer(200, {
							from: AT,
							to: AT,
							currency: 'USD',
							by: 'field:att_1',
							totals: { orders: 0, units: 0, revenue: 0, discount: 0 },
							rows: [],
						})
					: answer(200, {
							from: AT,
							to: AT,
							currency: 'USD',
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
			'GET /v1/admin/reports/margin': () => problem(403, 'forbidden'),
		});
		const panel = await openTab(root, 'reports');
		await change(fieldIn(panel, 'Report'), 'sales');
		// the groupings come from the server: built-in ones in the widget's words, fields by name (E12)
		expect([...fieldIn(panel, 'Group by').options].map((/** @type {any} */ o) => o.textContent)).toEqual([
			'Product',
			'City',
			'Payment method',
			'Material',
		]);
		await change(fieldIn(panel, 'From'), '2026-09-01');
		await change(fieldIn(panel, 'To'), '2026-09-30');
		await click(buttonIn(panel, 'Show'));
		expect(Object.fromEntries(server.last('GET /v1/admin/reports/sales')?.url.searchParams ?? [])).toEqual({
			by: 'product',
			from: '2026-09-01',
			to: '2026-09-30',
		});
		expect(textOf(panel.querySelector('.facts') ?? panel)).toContain('Orders2Units3SalesUSD 3,000.00DiscountUSD 10.00');
		expect(textOf(panel)).toContain('None');
		await click(buttonIn(panel, 'Download CSV'));
		expect(saved[0]?.name).toBe('report-sales.csv');
		expect(saved[0]?.text).toContain('Phone,3,3000.00,10.00');
		await change(fieldIn(panel, 'Group by'), 'field:att_1');
		await click(buttonIn(panel, 'Show'));
		expect(Object.fromEntries(server.last('GET /v1/admin/reports/sales')?.url.searchParams ?? []).by).toBe('field:att_1');
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
						currency: 'USD',
						totals: { units: 1, revenue: 1000, cost: 600, margin: 400 },
						rows: [{ productId: 'prd_1', name: 'Phone', units: 1, revenue: 1000, cost: 600, margin: 400 }],
					}),
			},
			['reports'],
		);
		const panel = panelOf(root, 'reports');
		await change(fieldIn(panel, 'Report'), 'margin');
		await click(buttonIn(panel, 'Show'));
		expect(textOf(panel.querySelector('.facts') ?? panel)).toBe('SalesUSD 10.00CostUSD 6.00MarginUSD 4.00');
		await click(buttonIn(panel, 'Download CSV'));
		expect(saved[0]?.text).toContain('Phone,1,10.00,6.00,4.00');
	});

	it('shows shop health and checks again (E41)', async () => {
		let attention = 2;
		const { root, server } = await start(
			{
				'GET /v1/admin/reports/health': () =>
					answer(200, {
						attention,
						checks: [
							{
								key: 'products_without_photos',
								status: attention ? 'attention' : 'ok',
								count: attention ? 3 : 0,
								link: null,
							},
							{ key: 'variants_low_stock', status: attention ? 'attention' : 'ok', count: attention ? 2 : 0, link: null },
							{ key: 'business_name', status: 'ok', count: 0, link: null },
							{ key: 'pixel_ids', status: 'skipped', count: 0, link: null },
						],
					}),
			},
			['reports'],
		);
		const panel = panelOf(root, 'reports');
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(textOf(panel)).toContain('Shop health');
		expect(textOf(panel)).toContain('Active products without photos3Needs attention');
		expect(textOf(panel)).toContain('Variants low on stock2Needs attention');
		expect(textOf(panel)).toContain('Business name missing (Website settings)0OK');
		expect(textOf(panel)).toContain("Badly formed tag ids in Growth (paste Growth's token in Connections to check)Not checked");
		expect(statuses(panel)).not.toContain('All clear: nothing needs fixing.');
		attention = 0;
		await click(buttonIn(panel, 'Check again'));
		expect(server.all('GET /v1/admin/reports/health')).toHaveLength(2);
		expect(statuses(panel)).toContain('All clear: nothing needs fixing.');
		expect(textOf(panel)).toContain('Active products without photos0OK');
	});

	it('says why shop health cannot be read', async () => {
		const { root } = await start({ 'GET /v1/admin/reports/health': () => problem(403, 'forbidden') }, ['reports']);
		const panel = panelOf(root, 'reports');
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(statuses(panel)).toContain('You are not allowed to do this.');
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
				errors: [
					{ line: 2, path: '/categories', message: SERVER_ENGLISH, code: 'unknown_category', values: { category: 'mugs' } },
					// the product check names the field
					{ line: 3, path: '/variants/0/price', message: SERVER_ENGLISH, code: 'invalid' },
					// from a server without the codes: the column's field
					{ line: 3, path: '/stock', message: SERVER_ENGLISH },
				],
			});
		const { root, server, saved } = await start({
			'GET /v1/admin/csv/products': () => new Response('﻿name\r\nPhone\r\n', { status: 200 }),
			'GET /v1/admin/csv/orders': () => invalid('/from'),
			'POST /v1/admin/csv/products': (/** @type {any} */ call) => {
				imports.push(call.body);
				return call.body.dryRun ? check() : answer(200, { dryRun: false, rows: 2, created: 1, updated: 1, errors: [] });
			},
		});
		const panel = await openTab(root, 'csv');
		expect(panel.querySelectorAll('.masonry > .card')).toHaveLength(4);
		await click(buttonIn(panel, 'Export products'));
		expect(saved[0]).toEqual({ name: 'products.csv', text: '﻿name\r\nPhone\r\n' });
		expect(statuses(panel)).toContain('products.csv is ready.');
		await change(fieldIn(panel, 'From'), '2026-09-01');
		await change(fieldIn(panel, 'Status'), 'delivered');
		await click(buttonIn(panel, 'Export orders'));
		expect(Object.fromEntries(server.last('GET /v1/admin/csv/orders')?.url.searchParams ?? [])).toEqual({
			from: '2026-09-01T00:00:00.000Z',
			status: 'delivered',
		});
		expect(statuses(panel)).toContain(TEXTS['problem.validation_failed']);
		// import
		await click(buttonIn(panel, 'Check the file'));
		expect(statuses(panel)).toContain('Pick a CSV file first.');
		const file = /** @type {any} */ ({ name: 'p.csv', type: 'text/csv', size: 10, text: async () => 'name,price\r\nMug,\r\n' });
		await choose(fieldIn(panel, 'CSV file'), [file]);
		await click(buttonIn(panel, 'Check the file'));
		expect(statuses(panel)).toContain('3 problems in 2 rows. Fix them and check again.');
		// every problem in the website's words, never the server's English (PLAN 0.4.10)
		for (const words of [
			TEXTS['customersAdmin.csvProblem.unknown_category']?.replace('{category}', 'mugs'),
			TEXTS['problem.field.price'],
			TEXTS['problem.field.stock'],
		])
			expect(textOf(panel)).toContain(words);
		expect(textOf(panel)).not.toContain(SERVER_ENGLISH);
		expect(shows(panel, 'Import')).toBe(false);
		check = () => answer(200, { dryRun: true, rows: 2, created: 1, updated: 1, errors: [] });
		await click(buttonIn(panel, 'Check the file'));
		expect(statuses(panel)).toContain('2 rows are fine: 1 new and 1 changed products.');
		await click(buttonIn(panel, 'Import'));
		expect(imports.at(-1)).toEqual({ csv: 'name,price\r\nMug,\r\n', dryRun: false });
		expect(statuses(panel)).toContain('Imported: 1 new and 1 changed products.');
		expect(shows(panel, 'Import')).toBe(false);
		await click(buttonIn(panel, 'Check the file'));
		server.routes['POST /v1/admin/csv/products'] = () => invalid('/csv/2/price');
		await click(buttonIn(panel, 'Import'));
		expect(statuses(panel)).toContain(TEXTS['problem.field.price']);
		await click(buttonIn(panel, 'Check the file'));
		expect(statuses(panel)).toContain(TEXTS['problem.field.price']);
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

	it('cannot fetch files while signed out, and has no status filter without the flow', async () => {
		const { root, server } = await mountWith(mountCustomersAdmin, { features: ['csv'], ticket: null });
		const panel = panelOf(root, 'csv');
		expect(() => fieldIn(panel, 'Status')).toThrow();
		await click(buttonIn(panel, 'Export products'));
		expect(statuses(panel)).toContain('Signed out. Sign in again to keep working.');
		expect(server.calls).toHaveLength(0);
	});
});
