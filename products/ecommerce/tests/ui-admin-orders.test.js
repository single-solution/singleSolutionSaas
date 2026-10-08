// @vitest-environment jsdom
/* global window */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountOrdersAdmin } from '../ui/orders-admin.js';
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
/** @param {Record<string, unknown>} [over] */
const summary = (over = {}) => ({
	id: 'ord_1',
	number: 'SO2026-1',
	status: 'confirmed',
	statusLabel: 'Confirmed',
	role: 'open',
	customer: { userId: 'u1', name: 'Ana', email: 'ana@example.com', phone: '0300' },
	city: 'Lahore',
	itemCount: 2,
	total: 250000,
	totalText: 'PKR 2,500.00',
	currency: 'PKR',
	payment: { method: 'cod', state: 'unpaid' },
	shipment: null,
	placedAt: AT,
	createdAt: AT,
	updatedAt: AT,
	...over,
});
/** @param {Record<string, unknown>} [over] */
const detail = (over = {}) => ({
	...summary(),
	lines: [
		{
			id: 'oln_1',
			kind: 'physical',
			name: 'Phone',
			variantName: 'Red',
			gradeLabel: 'A',
			sku: 'P-1',
			quantity: 2,
			unitPrice: 100000,
			total: 200000,
			serials: ['S1'],
		},
		{
			id: 'oln_2',
			kind: 'digital',
			name: 'Ebook',
			variantName: '',
			gradeLabel: '',
			sku: '',
			quantity: 1,
			unitPrice: 50000,
			total: 50000,
			serials: [],
		},
	],
	totals: { subtotal: 250000, discount: 1000, delivery: 0, tax: 500, total: 250000, currency: 'PKR', taxIncluded: true },
	promotions: { couponCode: 'SAVE' },
	payment: { method: 'online', state: 'paid', paid: 250000, refunded: 1000, refundable: 249000 },
	address: {
		name: 'Ana',
		phone: '0300',
		line1: 'Street 1',
		line2: '',
		city: 'Lahore',
		area: '',
		postalCode: '',
		country: 'PK',
		notes: '',
	},
	shipment: {
		courier: 'Fast',
		trackingNumber: 'TN1',
		trackingUrl: 'https://track.example/TN1',
		status: 'In transit',
		booked: true,
	},
	history: [
		{ at: AT, from: null, to: 'awaiting_confirmation', fromLabel: '', toLabel: 'Awaiting confirmation', by: 'Ana', note: '' },
		{
			at: AT,
			from: 'awaiting_confirmation',
			to: 'confirmed',
			fromLabel: 'Awaiting confirmation',
			toLabel: 'Confirmed',
			by: 'Sam',
			note: 'ok',
		},
	],
	note: 'Ring twice',
	staffNote: 'VIP',
	customerFlags: { blocked: true, blockedReason: 'Fraud', rtoCount: 2, orderCount: 5, note: 'Careful' },
	nextStatuses: [
		{ key: 'packed', label: 'Packed', role: 'packed' },
		{ key: 'dispatched', label: 'Dispatched', role: 'shipped' },
		{ key: 'cancelled', label: 'Cancelled', role: 'cancelled' },
	],
	...over,
});

const FEATURES = ['checkout', 'returns', 'bulk_actions', 'invoices', 'grades_serials', 'courier_apis'];
const SETTINGS = {
	orders: {
		statuses: [
			{ key: 'confirmed', label: 'Confirmed' },
			{ key: 'packed', label: 'Packed' },
		],
		couriers: [{ key: 'fast', name: 'Fast' }],
	},
};

/** @param {Record<string, any>} [routes] @param {string[]} [features] @param {Record<string, any>} [settings] */
const start = (routes = {}, features = FEATURES, settings = SETTINGS) =>
	mountWith(mountOrdersAdmin, {
		features,
		settings,
		routes: {
			'GET /v1/admin/orders': (/** @type {any} */ call) =>
				call.url.searchParams.get('cursor')
					? answer(200, {
							items: [summary({ id: 'ord_2', number: 'SO2026-2', status: 'packed', statusLabel: 'Packed' })],
							nextCursor: null,
							hasMore: false,
						})
					: answer(200, { items: [summary()], nextCursor: 'c', hasMore: true }),
			'GET /v1/admin/orders/ord_1': () => answer(200, detail()),
			...routes,
		},
	});

describe('orders admin: orders', () => {
	it('lists orders with filters and moves them in bulk', async () => {
		/** @type {any[]} */
		const moves = [];
		const { host, root, server } = await start({
			'POST /v1/admin/orders/bulk-move': (/** @type {any} */ call) => {
				moves.push(call.body);
				return moves.length === 1
					? answer(200, {
							moved: 1,
							results: [
								{ id: 'ord_1', ok: true },
								{ id: 'ord_2', ok: false, code: 'move_not_allowed', detail: 'Not from packed.' },
							],
						})
					: problem(403, 'no');
			},
		});
		expect(host.getAttribute('data-ss-mounted')).toBe('orders-admin');
		const panel = panelOf(root, 'orders');
		expect(textOf(panel)).toContain('Order SO2026-1 · Confirmed');
		expect(textOf(panel)).toContain('Cash on delivery · Unpaid');
		await click(buttonIn(panel, 'Load more'));
		type(fieldIn(panel, 'Search'), 'ana');
		await change(fieldIn(panel, 'Status'), 'packed');
		await change(fieldIn(panel, 'Payment'), 'paid');
		await change(fieldIn(panel, 'Paid by'), 'online');
		await change(fieldIn(panel, 'From'), '2026-10-01');
		await change(fieldIn(panel, 'To'), '2026-10-02');
		await submit(fieldIn(panel, 'Search'));
		expect(Object.fromEntries(server.last('GET /v1/admin/orders')?.url.searchParams ?? [])).toEqual({
			q: 'ana',
			status: 'packed',
			paymentState: 'paid',
			paymentMethod: 'online',
			from: '2026-10-01T00:00:00.000Z',
			to: '2026-10-03T00:00:00.000Z',
		});
		// bulk
		await click(buttonIn(panel, 'Move selected'));
		expect(statuses(panel)).toContain('Select at least one first.');
		const pick = /** @type {HTMLInputElement} */ (panel.querySelector('input[aria-label="Select SO2026-1"]'));
		await tick(pick, true);
		await tick(pick, false);
		await tick(pick, true);
		const to = fieldIn(panel, 'Move to');
		to.dispatchEvent(new window.Event('focus'));
		await change(to, 'packed');
		type(fieldIn(panel, 'Note (optional)'), 'batch');
		await click(buttonIn(panel, 'Move selected'));
		expect(moves[0]).toEqual({ ids: ['ord_1'], to: 'packed', note: 'batch' });
		expect(statuses(panel)).toContain('Moved 1 of 2 orders.');
		expect(textOf(panel)).toContain('ord_2: Not from packed.');
		await tick(/** @type {HTMLInputElement} */ (panel.querySelector('input[aria-label="Select SO2026-1"]')), true);
		await click(buttonIn(panel, 'Move selected'));
		expect(statuses(panel)).toContain('You are not allowed to do this.');
		expect(buttonIn(panel, 'Move selected').disabled).toBe(true);
	});

	it('filters by role and offers seen statuses without flow settings', async () => {
		const { root, server } = await start({}, ['checkout', 'bulk_actions'], {});
		expect(root.querySelector('[data-tab="returns"]')).toBeNull();
		const panel = panelOf(root, 'orders');
		await change(fieldIn(panel, 'Status'), 'shipped');
		expect(server.last('GET /v1/admin/orders')?.url.searchParams.get('role')).toBe('shipped');
		expect([...fieldIn(panel, 'Move to').options].map((/** @type {any} */ o) => o.value)).toEqual(['confirmed']);
		await click(buttonIn(panel, 'Load more'));
		fieldIn(panel, 'Move to').dispatchEvent(new window.Event('focus'));
		expect([...fieldIn(panel, 'Move to').options].map((/** @type {any} */ o) => o.value)).toEqual(['confirmed', 'packed']);
	});

	it('shows an order and moves it with serials and a shipment', async () => {
		/** @type {any[]} */
		const moves = [];
		let reply = () => answer(200, { ...detail({ status: 'packed', statusLabel: 'Packed' }), warnings: ['Message not sent.'] });
		const { root, server } = await start({
			'POST /v1/admin/orders/ord_1/move': (/** @type {any} */ call) => {
				moves.push(call.body);
				return reply();
			},
		});
		const panel = panelOf(root, 'orders');
		await click(buttonIn(panel, 'Open'));
		const text = textOf(panel);
		for (const part of [
			'Order SO2026-1 · Confirmed',
			'Phone · Red · A',
			'PKR 1,000.00',
			'S1',
			'Blocked: Fraud',
			'Careful',
			'Ring twice',
			'TN1',
			'Awaiting confirmation → Confirmed · Sam · ok',
			'SAVE',
		])
			expect(text).toContain(part);
		expect(panel.querySelector('a')?.getAttribute('href')).toBe('https://track.example/TN1');
		// packed: serials per unit of physical lines
		expect(panel.querySelector('input[aria-label="Serial number 1 of Phone"]')).not.toBeNull();
		type(panel.querySelector('input[aria-label="Serial number 2 of Phone"]'), 'S2');
		type(fieldIn(panel, 'Note (optional)'), 'boxed');
		await click(buttonIn(panel, 'Move'));
		expect(moves[0]).toEqual({ to: 'packed', note: 'boxed', serials: { oln_1: ['S1', 'S2'] }, shipment: null, updatedAt: AT });
		expect(statuses(panel)).toContain('Moved to Packed. Message not sent.');
		// shipped: courier and tracking number, then booking
		await change(fieldIn(panel, 'Move to'), 'dispatched');
		expect(panel.querySelector('input[aria-label="Serial number 1 of Phone"]')).toBeNull();
		await click(buttonIn(panel, 'Move'));
		expect(moves[1].shipment).toBeNull();
		await change(fieldIn(panel, 'Move to'), 'dispatched');
		await change(fieldIn(panel, 'Courier'), 'fast');
		type(fieldIn(panel, 'Tracking number'), ' T9 ');
		await click(buttonIn(panel, 'Move'));
		expect(moves[2].shipment).toEqual({ courier: 'fast', trackingNumber: 'T9' });
		await change(fieldIn(panel, 'Move to'), 'dispatched');
		await change(fieldIn(panel, 'Courier'), 'fast');
		await tick(checkIn(panel, 'Book with the courier API'), true);
		await click(buttonIn(panel, 'Move'));
		expect(moves[3].shipment).toEqual({ book: true, courier: 'fast' });
		await change(fieldIn(panel, 'Move to'), 'dispatched');
		await tick(checkIn(panel, 'Book with the courier API'), true);
		await change(fieldIn(panel, 'Courier'), '');
		await click(buttonIn(panel, 'Move'));
		expect(moves[4].shipment).toEqual({ book: true });
		reply = () => problem(409, 'The order changed meanwhile; reload it and try again.');
		await click(buttonIn(panel, 'Move'));
		expect(statuses(panel)).toContain('The order changed meanwhile; reload it and try again.');
		const lists = server.all('GET /v1/admin/orders').length;
		await click(buttonIn(panel, 'Back'));
		expect(server.all('GET /v1/admin/orders').length).toBe(lists + 1);
	});

	it('edits the note and address, refunds and opens documents', async () => {
		window.URL.createObjectURL = vi.fn(() => 'blob:doc');
		window.URL.revokeObjectURL = vi.fn();
		let refund = () =>
			answer(201, {
				order: detail({ payment: { method: 'online', state: 'refunded', paid: 250000, refunded: 250000, refundable: 0 } }),
				refund: {},
			});
		const { root, server, opened, host } = await start({
			'PATCH /v1/admin/orders/ord_1': (/** @type {any} */ call) =>
				call.body.address?.city === ''
					? problem(422, 'This field is required.')
					: answer(200, detail({ staffNote: call.body.staffNote ?? 'VIP' })),
			'POST /v1/admin/orders/ord_1/refunds': () => refund(),
			'GET /v1/admin/orders/ord_1/invoice': () => new Response('<h1>Invoice</h1>', { status: 200 }),
			'GET /v1/admin/orders/ord_1/packing-slip': () => problem(403, 'no'),
		});
		const panel = panelOf(root, 'orders');
		await click(buttonIn(panel, 'Open'));
		type(fieldIn(panel, 'Only staff see this note'), 'Gold');
		await click(buttonIn(panel, 'Save note'));
		expect(server.last('PATCH /v1/admin/orders/ord_1')?.body).toEqual({ staffNote: 'Gold' });
		expect(statuses(panel)).toContain('Saved.');
		type(fieldIn(panel, 'City'), '');
		await click(buttonIn(panel, 'Save address'));
		expect(statuses(panel)).toContain('This field is required.');
		type(fieldIn(panel, 'City'), 'Karachi');
		await click(buttonIn(panel, 'Save address'));
		expect(server.last('PATCH /v1/admin/orders/ord_1')?.body.address).toMatchObject({ city: 'Karachi', line1: 'Street 1' });
		server.routes['PATCH /v1/admin/orders/ord_1'] = () => problem(500, 'Down.');
		await click(buttonIn(panel, 'Save note'));
		expect(statuses(panel)).toContain('Down.');
		// documents
		await click(buttonIn(panel, 'Invoice'));
		expect(opened).toEqual(['blob:doc']);
		await click(buttonIn(panel, 'Packing slip'));
		expect(statuses(panel)).toContain('You are not allowed to do this.');
		server.routes['GET /v1/admin/orders/ord_1/packing-slip'] = () => new Response('not json', { status: 500 });
		await click(buttonIn(panel, 'Invoice'));
		expect(opened).toHaveLength(2);
		// refunds
		expect(textOf(panel)).toContain('Up to PKR 2,490.00 can be refunded.');
		type(fieldIn(panel, 'Amount (PKR)'), 'x');
		await click(buttonIn(panel, 'Refund'));
		expect(statuses(panel)).toContain('Check the amounts and numbers you typed.');
		type(fieldIn(panel, 'Amount (PKR)'), '10');
		type(fieldIn(panel, 'Reason'), 'damaged');
		refund = () => problem(422, 'Give a reason of at most 500 characters.');
		await click(buttonIn(panel, 'Refund'));
		expect(statuses(panel)).toContain('Give a reason of at most 500 characters.');
		refund = () =>
			answer(201, {
				order: detail({ payment: { method: 'online', state: 'refunded', paid: 250000, refunded: 250000, refundable: 0 } }),
				refund: {},
			});
		await click(buttonIn(panel, 'Refund'));
		expect(server.last('POST /v1/admin/orders/ord_1/refunds')?.body).toEqual({ amount: 1000, reason: 'damaged' });
		expect(statuses(panel)).toContain('PKR 10.00 refunded.');
		expect(shows(panel, 'Refund')).toBe(false);
		host.remove();
	});

	it('shows a shipped order without moves or address edits, and a missing order', async () => {
		const { root, server } = await start(
			{
				'GET /v1/admin/orders/ord_1': () =>
					answer(
						200,
						detail({
							role: 'delivered',
							nextStatuses: [],
							payment: { method: 'cod', state: 'paid', paid: 250000, refunded: 0, refundable: 0 },
							shipment: { courier: 'Fast', trackingNumber: 'TN1', trackingUrl: 'javascript:alert(1)', status: '' },
							customerFlags: undefined,
							totals: {
								subtotal: 1000,
								discount: 0,
								delivery: 200,
								tax: 0,
								total: 1200,
								currency: 'USD',
								taxIncluded: true,
							},
							promotions: undefined,
						}),
					),
			},
			['checkout'],
			{},
		);
		const panel = panelOf(root, 'orders');
		await click(buttonIn(panel, 'Open'));
		expect(textOf(panel)).toContain('Street 1, Lahore, PK');
		expect(textOf(panel)).toContain('USD 10.00');
		expect(panel.querySelector('a')).toBeNull();
		expect(shows(panel, 'Move')).toBe(false);
		expect(shows(panel, 'Invoice')).toBe(false);
		await click(buttonIn(panel, 'Back'));
		server.routes['GET /v1/admin/orders/ord_1'] = () => problem(404, 'There is no such order.');
		await click(buttonIn(panel, 'Open'));
		expect(statuses(panel)).toContain('There is no such order.');
		server.routes['GET /v1/admin/orders/ord_1'] = () =>
			answer(
				200,
				detail({
					address: null,
					shipment: null,
					nextStatuses: [{ key: 'packed', label: 'Packed', role: 'packed' }],
					lines: [],
				}),
			);
		await click(buttonIn(panel, 'Back'));
		await click(buttonIn(panel, 'Open'));
		expect(textOf(panel)).not.toContain('Delivery address');
		expect(panel.querySelector('input[aria-label^="Serial number"]')).toBeNull();
		expect(fieldIn(panel, 'Move to').value).toBe('packed');
	});

	it('takes a typed courier key when the settings list none', async () => {
		/** @type {any[]} */
		const moves = [];
		const { root } = await start(
			{
				'POST /v1/admin/orders/ord_1/move': (/** @type {any} */ call) => {
					moves.push(call.body);
					return answer(200, { ...detail(), warnings: [] });
				},
			},
			['checkout'],
			{},
		);
		const panel = panelOf(root, 'orders');
		await click(buttonIn(panel, 'Open'));
		await change(fieldIn(panel, 'Move to'), 'dispatched');
		type(fieldIn(panel, 'Courier'), 'fast');
		type(fieldIn(panel, 'Tracking number'), 'T1');
		expect(textOf(panel)).not.toContain('Book with the courier API');
		await click(buttonIn(panel, 'Move'));
		expect(moves[0].shipment).toEqual({ courier: 'fast', trackingNumber: 'T1' });
		await change(fieldIn(panel, 'Move to'), 'packed');
		await click(buttonIn(panel, 'Move'));
		expect(moves[1].serials).toEqual({});
	});
});

/** @param {Record<string, unknown>} [over] */
const claim = (over = {}) => ({
	id: 'ret_1',
	reference: 'R-ABC123',
	orderId: 'ord_1',
	orderNumber: 'SO2026-1',
	userId: 'u1',
	kind: 'return',
	lines: [{ lineId: 'oln_1', quantity: 1, serials: ['S1'], name: 'Phone', variantName: 'Red', sku: 'P-1', bought: 2 }],
	reason: 'Broken',
	photos: [
		{ key: 'p1', type: 'image/png', size: 1, url: 'https://cdn.example/p1.png' },
		{ key: 'p2', type: 'image/png', size: 1, url: null },
	],
	status: 'requested',
	refundAmount: 0,
	refundId: null,
	restockedAt: null,
	history: [{ at: AT, status: 'requested', by: 'Ana', note: '' }],
	actions: ['approve', 'reject'],
	order: {
		id: 'ord_1',
		number: 'SO2026-1',
		customer: { name: 'Ana', email: 'ana@example.com' },
		currency: 'PKR',
		total: 250000,
	},
	refundable: 100000,
	refundsOnline: true,
	createdAt: AT,
	updatedAt: AT,
	...over,
});

describe('orders admin: returns', () => {
	it('lists claims and moves, refunds and restocks them', async () => {
		/** @type {any[]} */
		const posts = [];
		let next = claim({ status: 'approved', actions: ['reject', 'receive', 'refund', 'close', 'restock'] });
		const { root, server } = await start({
			'GET /v1/admin/returns': () => answer(200, { items: [claim()], nextCursor: null, hasMore: false }),
			'GET /v1/admin/returns/ret_1': () => answer(200, claim()),
			'GET /v1/admin/returns/ret_2': () => problem(404, 'No such claim.'),
			'POST /v1/admin/returns/ret_1/approve': (/** @type {any} */ call) => {
				posts.push(call.body);
				return answer(200, next);
			},
			'POST /v1/admin/returns/ret_1/reject': () => problem(422, 'Add a note for the shopper.'),
			'POST /v1/admin/returns/ret_1/refund': (/** @type {any} */ call) => {
				posts.push(call.body);
				return answer(
					200,
					claim({
						status: 'refunded',
						refundAmount: 50000,
						refundable: 0,
						actions: ['close', 'restock'],
						refundsOnline: false,
					}),
				);
			},
			'POST /v1/admin/returns/ret_1/restock': () =>
				answer(200, claim({ status: 'closed', restockedAt: AT, actions: [], order: null, history: [] })),
		});
		const panel = await openTab(root, 'returns');
		expect(textOf(panel)).toContain('Claim R-ABC123 · order SO2026-1');
		expect(textOf(panel)).toContain('Return · Requested');
		await change(fieldIn(panel, 'Status'), 'requested');
		await change(fieldIn(panel, 'Kind'), 'return');
		expect(Object.fromEntries(server.last('GET /v1/admin/returns')?.url.searchParams ?? [])).toEqual({
			status: 'requested',
			kind: 'return',
		});
		await click(buttonIn(panel, 'Open'));
		expect(textOf(panel)).toContain('1 of 2');
		expect(textOf(panel)).toContain('Ana · ana@example.com');
		expect(panel.querySelectorAll('.thumbs img')).toHaveLength(1);
		expect(shows(panel, 'Refund')).toBe(false);
		await click(buttonIn(panel, 'Reject'));
		expect(statuses(panel)).toContain('Add a note for the shopper.');
		type(fieldIn(panel, "Shopper's note"), 'Fine');
		await click(buttonIn(panel, 'Approve'));
		expect(posts[0]).toEqual({ note: 'Fine' });
		expect(statuses(panel)).toContain('Approved.');
		expect(textOf(panel)).toContain('Refunds go back through the online payment.');
		type(fieldIn(panel, 'Amount (PKR)'), '0');
		await click(buttonIn(panel, 'Refund'));
		expect(statuses(panel)).toContain('Check the amounts and numbers you typed.');
		type(fieldIn(panel, 'Amount (PKR)'), '500');
		await click(buttonIn(panel, 'Refund'));
		expect(posts[1]).toEqual({ amount: 50000, note: '' });
		expect(statuses(panel)).toContain('PKR 500.00 refunded.');
		expect(textOf(panel)).toContain('PKR 500.00');
		await click(buttonIn(panel, 'Put back in stock'));
		expect(statuses(panel)).toContain('Put back in stock.');
		expect(shows(panel, 'Put back in stock')).toBe(false);
		await click(buttonIn(panel, 'Back'));
		server.routes['GET /v1/admin/returns'] = () =>
			answer(200, { items: [claim({ id: 'ret_2' })], nextCursor: null, hasMore: false });
		await change(fieldIn(panel, 'Kind'), '');
		await click(buttonIn(panel, 'Open'));
		expect(statuses(panel)).toContain('There is no such order.'.replace('There is no such order.', 'No such claim.'));
		await click(buttonIn(panel, 'Back'));
		next = claim();
		expect(next.id).toBe('ret_1');
	});
});
