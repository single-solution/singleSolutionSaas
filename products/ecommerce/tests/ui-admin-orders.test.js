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
	invalid,
	mountWith,
	panelOf,
	problem,
	resetPage,
	SERVER_ENGLISH,
	shows,
	statuses,
	submit,
	textOf,
	TEXTS,
	tick,
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
			warrantyDays: 365,
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
			warrantyDays: 0,
		},
	],
	totals: { subtotal: 250000, discount: 1000, delivery: 0, tax: 500, total: 250000, currency: 'PKR', taxIncluded: true },
	promotions: { couponCode: 'SAVE', pointsRedeemed: 20, pointsEarned: 25 },
	payment: { method: 'online', state: 'paid', paid: 250000, refunded: 1000, refundable: 249000, advance: 5000 },
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

const FEATURES = ['checkout', 'returns', 'bulk_actions', 'invoices', 'grades_serials', 'courier_apis', 'csv'];
const SETTINGS = {
	orders: {
		statuses: [
			{ key: 'confirmed', label: 'Confirmed' },
			{ key: 'packed', label: 'Packed' },
		],
		couriers: [{ key: 'fast', name: 'Fast' }],
	},
};

/** Counts answers by the `by` parameter. @param {any} call */
const counts = (call) => {
	const by = call.url.searchParams.get('by');
	/** @type {Record<string, Record<string, number>>} */
	const groups = {
		status: { confirmed: 1, packed: 1 },
		role: { open: 1, packed: 1 },
		paymentState: { unpaid: 2 },
		paymentMethod: { cod: 2 },
	};
	return answer(200, { total: 2, groups: groups[by] ?? {} });
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
							items: [
								summary({ id: 'ord_2', number: 'SO2026-2', status: 'packed', statusLabel: 'Packed', role: 'packed' }),
							],
							nextCursor: null,
							hasMore: false,
						})
					: answer(200, { items: [summary()], nextCursor: 'c', hasMore: true }),
			'GET /v1/admin/orders/ord_1': () => answer(200, detail()),
			'GET /v1/admin/orders/ord_2': () => answer(200, detail({ id: 'ord_2', number: 'SO2026-2' })),
			'GET /v1/admin/orders/count': () => answer(200, { count: 2, capped: false }),
			'GET /v1/admin/orders/counts': counts,
			'GET /v1/admin/returns': () => answer(200, { items: [], nextCursor: null, hasMore: false }),
			...routes,
		},
	});

/** The query of the last call to a route. @param {any} server @param {string} key */
const paramsOf = (server, key) => Object.fromEntries(server.last(key)?.url.searchParams ?? []);

describe('orders admin: the list', () => {
	it('lists orders with counts, filters them and opens the first', async () => {
		const { host, root, server } = await start();
		expect(host.getAttribute('data-ss-mounted')).toBe('orders-admin');
		const panel = panelOf(root, 'orders');
		const row = rowOf(panel, 'ord_1');
		expect(textOf(row)).toContain('SO2026-1');
		expect(textOf(row)).toContain('PKR 2,500.00');
		expect(textOf(row)).toContain('Confirmed · Ana · Lahore');
		expect(textOf(row)).toContain('Cash on delivery · Unpaid');
		expect(row.getAttribute('aria-current')).toBe('true');
		// the first order opens by itself, without leaving the list on a narrow widget
		expect(textOf(detailOf(panel))).toContain('Order SO2026-1');
		expect(panel.querySelector('.split')?.getAttribute('data-view')).toBe('list');
		expect(listCount(panel)).toBe('2');
		expect(chipCount(panel, '')).toBe('2');
		expect(chipCount(panel, 'packed')).toBe('1');
		expect(fieldIn(panel, 'Stage').options[1].textContent).toBe('Awaiting payment (0)');
		expect(fieldIn(panel, 'Payment').options[0].textContent).toBe('All (2)');
		expect(fieldIn(panel, 'Paid by').options[1].textContent).toBe('Cash on delivery (2)');
		// load more, then pick the second order
		await click(buttonIn(panel, 'Load more'));
		expect(rowsOf(panel)).toHaveLength(2);
		await openRow(panel, 'ord_2');
		expect(textOf(detailOf(panel))).toContain('Order SO2026-2');
		expect(panel.querySelector('.split')?.getAttribute('data-view')).toBe('detail');
		await click(buttonIn(panel, 'Back'));
		expect(panel.querySelector('.split')?.getAttribute('data-view')).toBe('list');
		rowOf(panel, 'ord_1').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a' }));
		rowOf(panel, 'ord_1').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
		// filters: search, status chip, stage, payment, method and days
		type(fieldIn(panel, 'Search'), 'ana');
		await submit(fieldIn(panel, 'Search'));
		await click(chipOf(panel, 'packed'));
		await click(chipOf(panel, 'packed'));
		expect(chipOf(panel, 'packed').getAttribute('aria-pressed')).toBe('true');
		await change(fieldIn(panel, 'Stage'), 'packed');
		await change(fieldIn(panel, 'Payment'), 'paid');
		await change(fieldIn(panel, 'Paid by'), 'online');
		await change(fieldIn(panel, 'From'), '2026-10-01');
		await change(fieldIn(panel, 'To'), '2026-10-02');
		const filters = {
			q: 'ana',
			status: 'packed',
			role: 'packed',
			paymentState: 'paid',
			paymentMethod: 'online',
			from: '2026-10-01T00:00:00.000Z',
			to: '2026-10-03T00:00:00.000Z',
		};
		expect(paramsOf(server, 'GET /v1/admin/orders')).toEqual(filters);
		expect(paramsOf(server, 'GET /v1/admin/orders/count')).toEqual(filters);
		const byField = (/** @type {string} */ by) =>
			Object.fromEntries(
				server
					.all('GET /v1/admin/orders/counts')
					.filter((call) => call.url.searchParams.get('by') === by)
					.at(-1)?.url.searchParams ?? [],
			);
		expect(byField('status')).toEqual({ ...filters, status: undefined, by: 'status' });
		expect(byField('role').role).toBeUndefined();
		expect(byField('paymentState').paymentState).toBeUndefined();
		expect(byField('paymentMethod')).toMatchObject({ paymentState: 'paid', by: 'paymentMethod' });
		// the open order stays open while it is in the list
		expect(server.last('GET /v1/admin/orders/ord_1')).toBeDefined();
		expect(rowOf(panel, 'ord_1').getAttribute('aria-current')).toBe('true');
	});

	it('moves the selected orders and exports the filtered orders', async () => {
		/** @type {any[]} */
		const moves = [];
		const { root, server, saved } = await start({
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
					: problem(403, 'forbidden');
			},
			'GET /v1/admin/csv/orders': () => new Response('number\r\nSO2026-1\r\n', { status: 200 }),
		});
		const panel = panelOf(root, 'orders');
		await click(buttonIn(panel, 'Move selected'));
		expect(statuses(panel)).toContain('Select at least one first.');
		expect(hasDialog(root)).toBe(false);
		const pick = /** @type {HTMLInputElement} */ (panel.querySelector('input[aria-label="Select SO2026-1"]'));
		pick.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ' }));
		pick.click();
		await tick(pick, false);
		await tick(pick, true);
		expect(rowOf(panel, 'ord_1').getAttribute('aria-current')).toBe('true');
		await click(buttonIn(panel, 'Move selected'));
		const dialog = dialogOf(root);
		expect(textOf(dialog)).toContain('1 orders selected.');
		await change(fieldIn(dialog, 'Move to'), 'packed');
		type(fieldIn(dialog, 'Note (optional)'), 'batch');
		await submitDialog(root);
		expect(moves[0]).toEqual({ ids: ['ord_1'], to: 'packed', note: 'batch' });
		expect(hasDialog(root)).toBe(false);
		expect(statuses(panel)).toContain('Moved 1 of 2 orders.');
		expect(textOf(panel)).toContain(`ord_2: ${TEXTS['problem.move_not_allowed']}`);
		// select all shown, then a refusal stays in the dialog
		await click(buttonIn(panel, 'Load more'));
		await tick(checkIn(panel, 'Select all shown'), true);
		await tick(checkIn(panel, 'Select all shown'), false);
		await tick(checkIn(panel, 'Select all shown'), true);
		await click(buttonIn(panel, 'Move selected'));
		expect(textOf(dialogOf(root))).toContain('2 orders selected.');
		await submitDialog(root);
		expect(moves[1].ids).toEqual(['ord_1', 'ord_2']);
		expect(dialogStatus(root)).toBe('You are not allowed to do this.');
		await click(buttonIn(dialogOf(root), 'Cancel'));
		// CSV of the orders the filters match
		await click(chipOf(panel, 'confirmed'));
		await change(fieldIn(panel, 'From'), '2026-10-01');
		await pickMenu(panel, 'Export these orders (CSV)');
		expect(paramsOf(server, 'GET /v1/admin/csv/orders')).toEqual({ status: 'confirmed', from: '2026-10-01T00:00:00.000Z' });
		expect(saved).toEqual([{ name: 'orders.csv', text: 'number\r\nSO2026-1\r\n' }]);
		expect(statuses(panel)).toContain('orders.csv is ready.');
		server.routes['GET /v1/admin/csv/orders'] = () => problem(403, 'forbidden');
		await pickMenu(panel, 'Export these orders (CSV)');
		expect(statuses(panel)).toContain('You are not allowed to do this.');
	});

	it('uses roles without flow settings, hides failed counts and shows an empty list', async () => {
		const { root, server } = await start(
			{
				'GET /v1/admin/orders/count': () => problem(503, 'count_timeout'),
				'GET /v1/admin/orders/counts': () => problem(503, 'count_timeout'),
			},
			['checkout', 'bulk_actions'],
			{},
		);
		expect(root.querySelector('[data-section="returns"]')).toBeNull();
		const panel = panelOf(root, 'orders');
		expect(listCount(panel)).toBe('');
		expect(chipCount(panel, '')).toBe('');
		expect(() => fieldIn(panel, 'Stage')).toThrow();
		expect(fieldIn(panel, 'Payment').options[0].textContent).toBe('All');
		expect(menuEntries(panel)).not.toContain('Export these orders (CSV)');
		await click(chipOf(panel, 'shipped'));
		expect(paramsOf(server, 'GET /v1/admin/orders')).toEqual({ role: 'shipped' });
		await click(buttonIn(panel, 'Load more'));
		await tick(/** @type {HTMLInputElement} */ (panel.querySelector('input[aria-label="Select SO2026-1"]')), true);
		await click(buttonIn(panel, 'Move selected'));
		expect([...fieldIn(dialogOf(root), 'Move to').options].map((/** @type {any} */ o) => o.value)).toEqual([
			'confirmed',
			'packed',
		]);
		server.routes['GET /v1/admin/orders'] = () => answer(200, { items: [], nextCursor: null, hasMore: false });
		await click(chipOf(panel, ''));
		expect(statuses(panel)).toContain('No orders match.');
		expect(textOf(detailOf(panel))).toContain('No orders to show.');
		server.routes['GET /v1/admin/orders'] = () => problem(500, 'internal_error');
		await click(chipOf(panel, 'open'));
		expect(statuses(panel)).toContain(TEXTS['admin.failed']);
	});

	it('shows the website’s words for a refusal, never the server’s English (PLAN 0.4.10)', async () => {
		const { root, server } = await start();
		const panel = panelOf(root, 'orders');
		/** @type {Array<[() => Response, string | undefined]>} */
		const cases = [
			[() => problem(401, 'invalid_token'), TEXTS['admin.signedOut']],
			[() => problem(403, 'feature_off'), TEXTS['problem.feature_off']],
			[() => problem(403, 'forbidden'), TEXTS['admin.notAllowed']],
			[() => problem(429, 'rate_limited'), TEXTS['problem.rate_limited']],
			// the deepest named part of the path with a text: the conditions, not their group or match
			[() => invalid('/conditions/groups/0/match'), TEXTS['problem.field.conditions']],
			[() => problem(422, 'validation_failed'), TEXTS['problem.validation_failed']],
			[() => problem(500, 'teapot'), TEXTS['admin.failed']],
		];
		for (const [reply, text] of cases) {
			server.routes['GET /v1/admin/orders'] = reply;
			await submit(fieldIn(panel, 'Search'));
			expect(statuses(panel)).toContain(text);
			expect(textOf(root)).not.toContain(SERVER_ENGLISH);
		}
	});

	it('shows money and dates by the Format and picks days in the business time zone', async () => {
		const { root, server } = await mountWith(mountOrdersAdmin, {
			features: ['checkout'],
			settings: SETTINGS,
			format: { locale: 'en-GB', currencyDisplay: 'custom', currencySymbol: 'Rs', wholeUnits: true, times: 'business' },
			timeZone: 'Asia/Karachi',
			routes: {
				'GET /v1/admin/orders': () => answer(200, { items: [summary()], nextCursor: null, hasMore: false }),
				'GET /v1/admin/orders/ord_1': () => answer(200, detail()),
			},
		});
		const panel = panelOf(root, 'orders');
		expect(textOf(rowOf(panel, 'ord_1'))).toContain('Confirmed · Ana · Lahore · 1 Oct 2026, 15:00');
		expect(textOf(rowOf(panel, 'ord_1'))).toContain('Rs 2,500');
		await change(fieldIn(panel, 'From'), '2026-10-01');
		await change(fieldIn(panel, 'To'), '2026-10-02');
		expect(server.last('GET /v1/admin/orders')?.url.searchParams.get('from')).toBe('2026-09-30T19:00:00.000Z');
		expect(server.last('GET /v1/admin/orders')?.url.searchParams.get('to')).toBe('2026-10-02T19:00:00.000Z');
	});
});

describe('orders admin: one order', () => {
	it('shows the order in a grid and cards with its claims', async () => {
		const { root, server } = await start({
			'GET /v1/admin/returns': () =>
				answer(200, {
					items: [{ id: 'ret_1', reference: 'R-ABC', kind: 'return', status: 'approved', orderNumber: 'SO2026-1' }],
					nextCursor: null,
					hasMore: false,
				}),
		});
		const pane = detailOf(panelOf(root, 'orders'));
		const text = textOf(pane);
		for (const part of [
			'Order SO2026-1',
			'Confirmed',
			'Phone · Red · A',
			'365 days',
			'None',
			'S1',
			'PKR 2,490.00',
			'PKR 50.00',
			'Blocked: Fraud',
			'Careful',
			'Ring twice',
			'VIP',
			'TN1',
			'In transit',
			'Awaiting confirmation → Confirmed · Sam · ok',
			'SAVE',
			'Points used20',
			'Points earned25',
			'Return claims',
			'R-ABC · Return',
		])
			expect(text).toContain(part);
		expect(server.last('GET /v1/admin/returns')?.url.searchParams.get('orderId')).toBe('ord_1');
		expect(pane.querySelector('a')?.getAttribute('href')).toBe('https://track.example/TN1');
		expect(shows(pane, 'Move to Packed')).toBe(true);
		expect(shows(pane, 'Refund')).toBe(true);
		expect(menuEntries(pane)).toEqual([
			'Move to Dispatched',
			'Edit delivery address',
			'Edit staff note',
			'Invoice',
			'Packing slip',
			'Move to Cancelled',
		]);
		expect(pane.querySelector('.menu button.danger')?.textContent).toBe('Move to Cancelled');
	});

	it('moves an order with serial numbers, a shipment or a typed confirmation', async () => {
		/** @type {any[]} */
		const moves = [];
		let reply = () =>
			answer(200, {
				...detail({ status: 'packed', statusLabel: 'Packed', role: 'packed' }),
				warnings: [SERVER_ENGLISH],
				warningCodes: [{ code: 'refund_by_hand', values: { amount: 25000 } }],
			});
		const { root } = await start({
			'POST /v1/admin/orders/ord_1/move': (/** @type {any} */ call) => {
				moves.push(call.body);
				return reply();
			},
		});
		const panel = panelOf(root, 'orders');
		const pane = detailOf(panel);
		// packing: one serial number per unit of the lines that take them
		await click(buttonIn(pane, 'Move to Packed'));
		let dialog = dialogOf(root);
		expect(textOf(dialog)).toContain('Warranty: 365 days');
		expect(dialog.querySelector('input[aria-label="Serial number 1 of Ebook"]')).toBeNull();
		type(dialog.querySelector('input[aria-label="Serial number 1 of Phone"]'), '');
		type(dialog.querySelector('input[aria-label="Serial number 2 of Phone"]'), 'S2');
		await submitDialog(root);
		expect(dialogStatus(root)).toBe('Phone: give one serial number per unit, or leave them all empty.');
		type(dialog.querySelector('input[aria-label="Serial number 1 of Phone"]'), ' S1 ');
		type(fieldIn(dialog, 'Note (optional)'), 'boxed');
		await submitDialog(root);
		expect(moves[0]).toEqual({ to: 'packed', note: 'boxed', serials: { oln_1: ['S1', 'S2'] }, shipment: null, updatedAt: AT });
		// a warning in the website's words, with its amount in the order's currency (PLAN 0.4.10)
		expect(statuses(pane)).toContain(
			`Moved to Packed. ${TEXTS['ordersAdmin.warning.refund_by_hand']?.replace('{amount}', 'PKR 250.00')}`,
		);
		expect(statuses(pane)).not.toContain(SERVER_ENGLISH);
		expect(textOf(rowOf(panel, 'ord_1'))).toContain('Packed');
		// all empty: the line is left out
		await click(buttonIn(pane, 'Move to Packed'));
		dialog = dialogOf(root);
		type(dialog.querySelector('input[aria-label="Serial number 1 of Phone"]'), '');
		await submitDialog(root);
		expect(moves[1].serials).toEqual({});
		// shipping: courier and tracking number, then booking
		await pickMenu(pane, 'Move to Dispatched');
		await submitDialog(root);
		expect(moves[2].shipment).toBeNull();
		await pickMenu(pane, 'Move to Dispatched');
		dialog = dialogOf(root);
		await change(fieldIn(dialog, 'Courier'), 'fast');
		type(fieldIn(dialog, 'Tracking number'), ' T9 ');
		await submitDialog(root);
		expect(moves[3].shipment).toEqual({ courier: 'fast', trackingNumber: 'T9' });
		await pickMenu(pane, 'Move to Dispatched');
		dialog = dialogOf(root);
		await change(fieldIn(dialog, 'Courier'), 'fast');
		await tick(checkIn(dialog, 'Book with the courier API'), true);
		expect(() => fieldIn(dialog, 'Tracking number')).toThrow();
		await submitDialog(root);
		expect(moves[4].shipment).toEqual({ book: true, courier: 'fast' });
		await pickMenu(pane, 'Move to Dispatched');
		await tick(checkIn(dialogOf(root), 'Book with the courier API'), true);
		await submitDialog(root);
		expect(moves[5].shipment).toEqual({ book: true });
		// cancelling asks for the order number
		await pickMenu(pane, 'Move to Cancelled');
		dialog = dialogOf(root);
		expect(textOf(dialog)).toContain('Order SO2026-1 will be cancelled');
		expect(/** @type {HTMLButtonElement} */ (dialog.querySelector('button[type="submit"]')).disabled).toBe(true);
		expect((await confirmDialog(root, 'SO2026-1')).disabled).toBe(false);
		reply = () => problem(409, 'conflict');
		await submitDialog(root);
		expect(moves[6]).toMatchObject({ to: 'cancelled', serials: {}, shipment: null });
		expect(dialogStatus(root)).toBe(TEXTS['problem.conflict']);
	});

	it('asks what the move needs: notes for staff and the shopper, the dispatch video and whether items go back', async () => {
		/** @type {any[]} */
		const moves = [];
		/** @type {any[]} */
		const edits = [];
		// a shipped order (each answer leaves it so, to try every move)
		const shipped = () =>
			answer(
				200,
				detail({
					status: 'dispatched',
					statusLabel: 'Dispatched',
					role: 'shipped',
					nextStatuses: [
						{ key: 'delivered', label: 'Delivered', role: 'delivered', needs: ['note', 'reason'], options: {} },
						{ key: 'returned', label: 'Returned', role: 'returned_to_origin', needs: [], options: { restock: 'ask' } },
					],
				}),
			);
		const { root } = await start({
			'GET /v1/admin/orders/ord_1': shipped,
			'POST /v1/admin/orders/ord_1/move': (/** @type {any} */ call) => {
				moves.push(call.body);
				return shipped();
			},
			'PATCH /v1/admin/orders/ord_1': (/** @type {any} */ call) => {
				edits.push(call.body);
				return shipped();
			},
		});
		const pane = detailOf(panelOf(root, 'orders'));
		// both notes needed
		await click(buttonIn(pane, 'Move to Delivered'));
		let dialog = dialogOf(root);
		await submitDialog(root);
		expect(dialogStatus(root)).toBe(TEXTS['ordersAdmin.needsNote']);
		type(fieldIn(dialog, TEXTS['ordersAdmin.moveNoteRequired'] ?? ''), 'Left at the door');
		await submitDialog(root);
		expect(dialogStatus(root)).toBe(TEXTS['ordersAdmin.needsShopperNote']);
		type(fieldIn(dialog, TEXTS['ordersAdmin.shopperNoteRequired'] ?? ''), ' Left with your neighbor ');
		await submitDialog(root);
		expect(moves[0]).toEqual({
			to: 'delivered',
			note: 'Left at the door',
			shopperNote: 'Left with your neighbor',
			serials: {},
			shipment: null,
			updatedAt: AT,
		});
		// a move that asks whether the items go back in stock sends the answer
		await pickMenu(pane, 'Move to Returned');
		dialog = dialogOf(root);
		await tick(checkIn(dialog, TEXTS['ordersAdmin.restockAsk'] ?? ''), true);
		await submitDialog(root);
		expect(moves[1]).toMatchObject({ to: 'returned', restock: true });
		expect(moves[1].shopperNote).toBeUndefined();
		// the dispatch video of a shipped order is replaced
		await pickMenu(pane, TEXTS['ordersAdmin.replaceVideo'] ?? '');
		dialog = dialogOf(root);
		await submitDialog(root);
		expect(dialogStatus(root)).toBe(TEXTS['ordersAdmin.videoAddress']);
		type(fieldIn(dialog, TEXTS['ordersAdmin.videoAddress'] ?? ''), ' https://youtu.be/dQw4w9WgXcQ ');
		await submitDialog(root);
		expect(edits).toEqual([{ video: 'https://youtu.be/dQw4w9WgXcQ' }]);
	});

	it('asks for the dispatch video when packing as the move says', async () => {
		/** @type {any[]} */
		const moves = [];
		const { root } = await start(
			{
				'GET /v1/admin/orders/ord_1': () =>
					answer(
						200,
						detail({
							nextStatuses: [
								{ key: 'packed', label: 'Packed', role: 'packed', needs: [], options: { video: 'required' } },
							],
						}),
					),
				'POST /v1/admin/orders/ord_1/move': (/** @type {any} */ call) => {
					moves.push(call.body);
					return answer(200, detail({ status: 'packed', role: 'packed', nextStatuses: [] }));
				},
			},
			FEATURES.filter((feature) => feature !== 'grades_serials'),
		);
		const pane = detailOf(panelOf(root, 'orders'));
		await click(buttonIn(pane, 'Move to Packed'));
		type(fieldIn(dialogOf(root), TEXTS['ordersAdmin.videoRequired'] ?? ''), 'https://youtu.be/dQw4w9WgXcQ');
		await submitDialog(root);
		expect(moves[0]).toMatchObject({ to: 'packed', video: 'https://youtu.be/dQw4w9WgXcQ' });
	});

	it('checks typed serial numbers as IMEIs and saves them later', async () => {
		/** @type {any[]} */
		const patches = [];
		const typed = detail({
			lines: [
				{ ...detail().lines[0], serials: [], serialized: true, warrantyDays: null },
				{ ...detail().lines[0], id: 'oln_3', name: 'Case', quantity: 1, serials: ['C1'], serialized: false },
			],
			nextStatuses: [{ key: 'packed', label: 'Packed', role: 'packed' }],
		});
		const { root } = await start(
			{
				'GET /v1/admin/orders/ord_1': () => answer(200, typed),
				'PATCH /v1/admin/orders/ord_1': (/** @type {any} */ call) => {
					patches.push(call.body);
					return patches.length === 1
						? invalid('/serials/l1')
						: answer(200, detail({ lines: [{ ...typed.lines[0], serials: call.body.serials.oln_1 }], nextStatuses: [] }));
				},
			},
			FEATURES,
			{ ...SETTINGS, catalog: { serialMode: 'typed', serialCheck: 'imei' } },
		);
		const pane = detailOf(panelOf(root, 'orders'));
		expect(textOf(pane)).toContain('Missing');
		expect(shows(pane, 'Type serial numbers')).toBe(true);
		expect(menuEntries(pane)).toContain('Refund');
		await click(buttonIn(pane, 'Type serial numbers'));
		const dialog = dialogOf(root);
		expect(textOf(dialog)).toContain('They can be typed at packing or later');
		expect(dialog.querySelector('input[aria-label="Serial number 1 of Case"]')).toBeNull();
		await submitDialog(root);
		expect(dialogStatus(root)).toBe('Type or change the serial numbers of at least one item first.');
		type(dialog.querySelector('input[aria-label="Serial number 1 of Phone"]'), '490154203237518');
		type(dialog.querySelector('input[aria-label="Serial number 2 of Phone"]'), '490154203237519');
		await submitDialog(root);
		expect(dialogStatus(root)).toBe('490154203237519 is not an IMEI: 15 digits ending in its check digit.');
		type(dialog.querySelector('input[aria-label="Serial number 2 of Phone"]'), '356938035643809');
		await submitDialog(root);
		expect(dialogStatus(root)).toBe(TEXTS['problem.field.serials']);
		await submitDialog(root);
		expect(patches[1]).toEqual({ serials: { oln_1: ['490154203237518', '356938035643809'] } });
		expect(statuses(pane)).toContain('Serial numbers saved.');
		expect(shows(pane, 'Type serial numbers')).toBe(false);
		expect(menuEntries(pane)).toContain('Type serial numbers');
		// typing again with nothing changed is refused
		await pickMenu(pane, 'Type serial numbers');
		expect(dialogOf(root).querySelector('input[placeholder="Unit 2"]')).not.toBeNull();
		await submitDialog(root);
		expect(dialogStatus(root)).toBe('Type or change the serial numbers of at least one item first.');
	});

	it('edits the note and address, refunds and opens documents', async () => {
		window.URL.createObjectURL = vi.fn(() => 'blob:doc');
		window.URL.revokeObjectURL = vi.fn();
		let refund = () => invalid('/reason');
		const { root, server, opened, host } = await start({
			'PATCH /v1/admin/orders/ord_1': (/** @type {any} */ call) =>
				call.body.address?.city === ''
					? invalid('/address/phone')
					: answer(200, detail({ staffNote: call.body.staffNote ?? 'VIP' })),
			'POST /v1/admin/orders/ord_1/refunds': () => refund(),
			'GET /v1/admin/orders/ord_1/invoice': () => new Response('<h1>Invoice</h1>', { status: 200 }),
			'GET /v1/admin/orders/ord_1/packing-slip': () => problem(403, 'forbidden'),
		});
		const pane = detailOf(panelOf(root, 'orders'));
		await pickMenu(pane, 'Edit staff note');
		expect(fieldIn(dialogOf(root), 'Only staff see this note').value).toBe('VIP');
		type(fieldIn(dialogOf(root), 'Only staff see this note'), 'Gold');
		await submitDialog(root);
		expect(server.last('PATCH /v1/admin/orders/ord_1')?.body).toEqual({ staffNote: 'Gold' });
		expect(statuses(pane)).toContain('Saved.');
		expect(textOf(pane)).toContain('Gold');
		await pickMenu(pane, 'Edit delivery address');
		type(fieldIn(dialogOf(root), 'City'), '');
		await submitDialog(root);
		expect(dialogStatus(root)).toBe(TEXTS['problem.field.address']);
		type(fieldIn(dialogOf(root), 'City'), 'Karachi');
		await submitDialog(root);
		expect(server.last('PATCH /v1/admin/orders/ord_1')?.body.address).toMatchObject({ city: 'Karachi', line1: 'Street 1' });
		server.routes['PATCH /v1/admin/orders/ord_1'] = () => problem(500, 'internal_error');
		await pickMenu(pane, 'Edit staff note');
		await submitDialog(root);
		expect(dialogStatus(root)).toBe(TEXTS['admin.failed']);
		await click(buttonIn(dialogOf(root), 'Cancel'));
		// documents
		await pickMenu(pane, 'Invoice');
		expect(opened).toEqual(['blob:doc']);
		expect(statuses(pane)).toContain('Invoice opened in a new tab.');
		await pickMenu(pane, 'Packing slip');
		expect(statuses(pane)).toContain('You are not allowed to do this.');
		// refunds
		await click(buttonIn(pane, 'Refund'));
		expect(textOf(dialogOf(root))).toContain('Up to PKR 2,490.00 can be refunded.');
		type(fieldIn(dialogOf(root), 'Amount (PKR)'), 'x');
		await submitDialog(root);
		expect(dialogStatus(root)).toBe('Check the amounts and numbers you typed.');
		type(fieldIn(dialogOf(root), 'Amount (PKR)'), '10');
		type(fieldIn(dialogOf(root), 'Reason'), 'damaged');
		await submitDialog(root);
		expect(dialogStatus(root)).toBe(TEXTS['problem.field.reason']);
		refund = () =>
			answer(201, {
				order: detail({ payment: { method: 'online', state: 'refunded', paid: 250000, refunded: 250000, refundable: 0 } }),
				refund: {},
				// from a server without the warnings' codes: as it wrote them
				warnings: ['Return by hand.'],
			});
		await submitDialog(root);
		expect(server.last('POST /v1/admin/orders/ord_1/refunds')?.body).toEqual({ amount: 1000, reason: 'damaged' });
		expect(statuses(pane)).toContain('PKR 10.00 refunded. Return by hand.');
		expect(shows(pane, 'Refund')).toBe(false);
		host.remove();
	});

	it('shows a delivered order without moves, and a missing order', async () => {
		const { root, server } = await start(
			{
				'GET /v1/admin/orders/ord_1': () =>
					answer(
						200,
						detail({
							role: 'delivered',
							nextStatuses: [],
							note: '',
							staffNote: '',
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
				'GET /v1/admin/orders/ord_2': () => problem(404, 'not_found'),
			},
			['checkout'],
			{},
		);
		const panel = panelOf(root, 'orders');
		const pane = detailOf(panel);
		expect(textOf(pane)).toContain('Street 1, Lahore, PK');
		expect(textOf(pane)).toContain('USD 10.00');
		expect(textOf(pane)).not.toContain('Notes');
		expect(pane.querySelector('a')).toBeNull();
		expect(pane.querySelector('.detail-head button.secondary:not(.icon)')).toBeNull();
		expect(menuEntries(pane)).toEqual(['Edit staff note']);
		await click(buttonIn(panel, 'Load more'));
		await openRow(panel, 'ord_2');
		expect(statuses(pane)).toContain(TEXTS['problem.not_found']);
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
		await openRow(panel, 'ord_1');
		expect(textOf(pane)).not.toContain('Delivery address');
		await click(buttonIn(pane, 'Move to Packed'));
		expect(dialogOf(root).querySelector('input[aria-label^="Serial number"]')).toBeNull();
	});

	it('shows the history in the website’s words for who and what the server wrote itself (PLAN 0.4.10)', async () => {
		/** @param {string} from @param {string} to @param {Record<string, unknown>} entry */
		const moved = (from, to, entry) => ({ at: AT, from, to, fromLabel: from, toLabel: to, ...entry });
		const history = [
			{
				at: AT,
				from: null,
				to: 'awaiting_confirmation',
				fromLabel: '',
				toLabel: 'Awaiting confirmation',
				by: 'guest',
				note: '',
			},
			moved('Awaiting confirmation', 'Cancelled', { by: 'system', note: SERVER_ENGLISH, reason: 'expired' }),
			moved('Confirmed', 'Cancelled', { by: 'shopper', note: SERVER_ENGLISH, reason: 'shopper' }),
			moved('Confirmed', 'Confirmed', { by: 'Sam', note: SERVER_ENGLISH, kind: 'edited' }),
			// a staff member's own words stay as typed
			moved('Shipped', 'Returned to origin', { by: 'Sam', note: 'Refused at the door', reason: 'rto' }),
			// what the server writes as a code, with its values; the server token by the website's words, and a member of
			// the staff by their name even when it is one of those words
			moved('Awaiting payment', 'Confirmed', { by: 'system', note: SERVER_ENGLISH, code: 'payment_confirmed' }),
			moved('Delivered', 'Delivered', {
				by: 'Server',
				byKind: 'server',
				note: SERVER_ENGLISH,
				kind: 'refund',
				code: 'refunded_recorded',
				values: { amount: 25000, reason: 'Scratched' },
			}),
			moved('Delivered', 'Delivered', {
				by: 'system',
				byKind: 'staff',
				note: SERVER_ENGLISH,
				kind: 'payment',
				code: 'payment_recorded_reference',
				values: { amount: 1000, reference: 'TRX-1' },
			}),
			moved('Delivered', 'Refunded', { by: 'Server', byKind: 'user', note: 'Asked by phone' }),
		];
		const { root } = await start({ 'GET /v1/admin/orders/ord_1': () => answer(200, detail({ history })) });
		const text = textOf(detailOf(panelOf(root, 'orders')));
		for (const part of [
			`Awaiting confirmation · ${TEXTS['ordersAdmin.by.guest']}`,
			`Awaiting confirmation → Cancelled · ${TEXTS['ordersAdmin.by.system']} · ${TEXTS['ordersAdmin.historyNote.expired']}`,
			`Confirmed → Cancelled · ${TEXTS['ordersAdmin.by.shopper']} · ${TEXTS['ordersAdmin.historyNote.shopper']}`,
			`Confirmed → Confirmed · Sam · ${TEXTS['ordersAdmin.historyNote.edited']}`,
			'Shipped → Returned to origin · Sam · Refused at the door',
			`Awaiting payment → Confirmed · ${TEXTS['ordersAdmin.by.system']} · ${TEXTS['ordersAdmin.historyNote.payment_confirmed']}`,
			`Delivered → Delivered · ${TEXTS['ordersAdmin.by.server']} · ${TEXTS['ordersAdmin.historyNote.refunded_recorded']
				?.replace('{amount}', 'PKR 250.00')
				.replace('{reason}', 'Scratched')}`,
			`Delivered → Delivered · system · ${TEXTS['ordersAdmin.historyNote.payment_recorded_reference']
				?.replace('{amount}', 'PKR 10.00')
				.replace('{reference}', 'TRX-1')}`,
			'Delivered → Refunded · Server · Asked by phone',
		])
			expect(text).toContain(part);
		expect(text).not.toContain(SERVER_ENGLISH);
	});

	it('takes a typed courier key when the settings list none', async () => {
		/** @type {any[]} */
		const moves = [];
		const { root } = await start(
			{
				'POST /v1/admin/orders/ord_1/move': (/** @type {any} */ call) => {
					moves.push(call.body);
					return answer(200, { ...detail() });
				},
			},
			['checkout'],
			{},
		);
		const pane = detailOf(panelOf(root, 'orders'));
		await pickMenu(pane, 'Move to Dispatched');
		const dialog = dialogOf(root);
		type(fieldIn(dialog, 'Courier'), 'fast');
		type(fieldIn(dialog, 'Tracking number'), 'T1');
		expect(textOf(dialog)).not.toContain('Book with the courier API');
		await submitDialog(root);
		expect(moves[0].shipment).toEqual({ courier: 'fast', trackingNumber: 'T1' });
		expect(statuses(pane)).toContain('Moved to Confirmed.');
		await click(buttonIn(pane, 'Move to Packed'));
		expect(dialogOf(root).querySelector('input[aria-label^="Serial number"]')).toBeNull();
		await submitDialog(root);
		expect(moves[1].serials).toEqual({});
	});

	it('drops a late answer for an order no longer shown', async () => {
		/** @type {(value: Response) => void} */
		let release = () => {};
		const { root } = await start({
			'GET /v1/admin/orders/ord_2': () => new Promise((resolve) => (release = resolve)),
		});
		const panel = panelOf(root, 'orders');
		await click(buttonIn(panel, 'Load more'));
		await openRow(panel, 'ord_2');
		expect(textOf(detailOf(panel))).toContain('Loading…');
		await openRow(panel, 'ord_1');
		release(answer(200, detail({ id: 'ord_2', number: 'SO2026-2' })));
		await click(buttonIn(panel, 'Back'));
		expect(textOf(detailOf(panel))).toContain('Order SO2026-1');
		expect(textOf(detailOf(panel))).not.toContain('Order SO2026-2');
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
		deliveredAt: AT,
	},
	refundable: 100000,
	refundsOnline: true,
	createdAt: AT,
	updatedAt: AT,
	...over,
});

describe('orders admin: returns', () => {
	/** @param {Record<string, any>} [routes] */
	const startReturns = async (routes = {}) => {
		const mounted = await start({
			'GET /v1/admin/returns': () =>
				answer(200, {
					items: [claim(), claim({ id: 'ret_2', reference: 'R-2', refundAmount: 5000 })],
					nextCursor: null,
					hasMore: false,
				}),
			'GET /v1/admin/returns/count': () => answer(200, { count: 100000, capped: true }),
			'GET /v1/admin/returns/counts': () => answer(200, { total: 2, groups: { requested: 2 } }),
			'GET /v1/admin/returns/ret_1': () => answer(200, claim()),
			'GET /v1/admin/returns/ret_2': () => problem(404, 'not_found'),
			...routes,
		});
		await click(/** @type {HTMLElement} */ (mounted.root.querySelector('[data-section="returns"]')));
		return { ...mounted, panel: panelOf(mounted.root, 'returns') };
	};

	it('lists claims with counts and filters, and narrows to an order or a customer', async () => {
		const { panel, server } = await startReturns();
		expect(textOf(rowOf(panel, 'ret_1'))).toContain('R-ABC123');
		expect(textOf(rowOf(panel, 'ret_1'))).toContain('Order SO2026-1 · Return · Requested');
		expect(textOf(rowOf(panel, 'ret_2'))).toContain('PKR 50.00');
		expect(listCount(panel)).toBe('100000+');
		expect(chipCount(panel, 'requested')).toBe('2');
		expect(chipCount(panel, 'closed')).toBe('0');
		const pane = detailOf(panel);
		expect(textOf(pane)).toContain('Claim R-ABC123');
		await click(chipOf(panel, 'requested'));
		await change(fieldIn(panel, 'Kind'), 'return');
		expect(paramsOf(server, 'GET /v1/admin/returns')).toEqual({ status: 'requested', kind: 'return' });
		expect(paramsOf(server, 'GET /v1/admin/returns/counts')).toEqual({ kind: 'return', by: 'status' });
		await pickMenu(pane, 'Claims of this order');
		expect(paramsOf(server, 'GET /v1/admin/returns')).toMatchObject({ orderId: 'ord_1' });
		expect(textOf(panel.querySelector('ul.chips') ?? panel)).toContain('Order SO2026-1');
		await pickMenu(pane, 'Claims of this customer');
		expect(paramsOf(server, 'GET /v1/admin/returns')).toMatchObject({ userId: 'u1' });
		expect(paramsOf(server, 'GET /v1/admin/returns').orderId).toBeUndefined();
		expect(textOf(panel)).toContain('Claims of Ana · ana@example.com');
		await click(/** @type {HTMLElement} */ (panel.querySelector('button[aria-label="Show all claims"]')));
		expect(paramsOf(server, 'GET /v1/admin/returns').userId).toBeUndefined();
		await openRow(panel, 'ret_2');
		expect(statuses(pane)).toContain(TEXTS['problem.not_found']);
	});

	it('moves, refunds and restocks a claim, and rejects it with its reference', async () => {
		/** @type {any[]} */
		const posts = [];
		const { root, panel } = await startReturns({
			'POST /v1/admin/returns/ret_1/approve': (/** @type {any} */ call) => {
				posts.push(call.body);
				return answer(200, claim({ status: 'approved', actions: ['reject', 'receive', 'refund', 'close', 'restock'] }));
			},
			'POST /v1/admin/returns/ret_1/reject': () => invalid('/note'),
			'POST /v1/admin/returns/ret_1/receive': () =>
				answer(200, claim({ status: 'received', actions: ['reject', 'refund', 'close', 'restock'], userId: '' })),
			'POST /v1/admin/returns/ret_1/refund': (/** @type {any} */ call) => {
				posts.push(call.body);
				return answer(200, {
					...claim({
						status: 'refunded',
						refundAmount: 50000,
						refundable: 0,
						actions: ['close', 'restock'],
						refundsOnline: false,
					}),
					warnings: [SERVER_ENGLISH],
					warningCodes: [{ code: 'refund_by_hand', values: { amount: 50000 } }],
				});
			},
			'POST /v1/admin/returns/ret_1/restock': () =>
				answer(
					200,
					claim({ status: 'refunded', restockedAt: AT, refundable: 0, actions: ['close'], order: null, history: [] }),
				),
			'POST /v1/admin/returns/ret_1/close': () =>
				answer(200, claim({ status: 'closed', actions: [], order: null, photos: [] })),
		});
		const pane = detailOf(panel);
		expect(textOf(pane)).toContain('1 of 2');
		expect(textOf(pane)).toContain('Ana · ana@example.com');
		expect(pane.querySelectorAll('.thumbs img')).toHaveLength(1);
		expect(shows(pane, 'Approve')).toBe(true);
		// reject: last in the More menu, with a note and the reference
		await pickMenu(pane, 'Reject');
		expect(textOf(dialogOf(root))).toContain('A rejected claim cannot be moved again.');
		await confirmDialog(root, 'R-ABC123');
		await submitDialog(root);
		expect(dialogStatus(root)).toBe(TEXTS['problem.field.note']);
		await click(buttonIn(dialogOf(root), 'Cancel'));
		// approve
		await click(buttonIn(pane, 'Approve'));
		type(fieldIn(dialogOf(root), 'Note for the shopper (optional)'), 'Fine');
		await submitDialog(root);
		expect(posts[0]).toEqual({ note: 'Fine' });
		expect(statuses(pane)).toContain('Approved.');
		expect(textOf(rowOf(panel, 'ret_1'))).toContain('Approved');
		expect(shows(pane, 'Mark received')).toBe(true);
		expect(shows(pane, 'Refund')).toBe(true);
		expect(menuEntries(pane)).toEqual([
			'Put back in stock',
			'Close',
			'Claims of this order',
			'Claims of this customer',
			'Reject',
		]);
		await click(buttonIn(pane, 'Mark received'));
		await submitDialog(root);
		expect(statuses(pane)).toContain('Marked received.');
		expect(menuEntries(pane)).not.toContain('Claims of this customer');
		// refund
		await click(buttonIn(pane, 'Refund'));
		expect(textOf(dialogOf(root))).toContain('Refunds go back through the online payment.');
		type(fieldIn(dialogOf(root), 'Amount (PKR)'), '0');
		await submitDialog(root);
		expect(dialogStatus(root)).toBe('Check the amounts and numbers you typed.');
		type(fieldIn(dialogOf(root), 'Amount (PKR)'), '500');
		await submitDialog(root);
		expect(posts[1]).toEqual({ amount: 50000, note: '' });
		expect(statuses(pane)).toContain(
			`PKR 500.00 refunded. ${TEXTS['ordersAdmin.warning.refund_by_hand']?.replace('{amount}', 'PKR 500.00')}`,
		);
		expect(statuses(pane)).not.toContain(SERVER_ENGLISH);
		expect(textOf(pane)).toContain('The refund is recorded; pay it back yourself.');
		// restock, then close
		await click(buttonIn(pane, 'Put back in stock'));
		expect(textOf(dialogOf(root))).toContain('This is done once per claim.');
		await submitDialog(root);
		expect(statuses(pane)).toContain('Put back in stock.');
		expect(shows(pane, 'Put back in stock')).toBe(false);
		await click(buttonIn(pane, 'Close'));
		await submitDialog(root);
		expect(statuses(pane)).toContain('Closed.');
		expect(pane.querySelector('.detail-head .actions > button')).toBeNull();
	});

	it('marks a warranty claim replaced or repaired, and shows its history in the website’s words (E33)', async () => {
		/** @type {any[]} */
		const posts = [];
		const received = claim({
			kind: 'warranty',
			status: 'received',
			actions: ['reject', 'replace', 'repair', 'refund', 'close', 'restock'],
			history: [
				{ at: AT, status: 'requested', by: 'shopper', note: '' },
				{ at: AT, status: 'received', by: 'Sam', note: 'restocked' },
				{ at: AT, status: 'received', by: 'Server', byKind: 'server', note: 'restocked', code: 'restocked' },
			],
		});
		const exchange = claim({ id: 'ret_2', reference: 'R-2', kind: 'exchange', status: 'replaced' });
		const { root, panel } = await startReturns({
			'GET /v1/admin/returns': () => answer(200, { items: [received, exchange], nextCursor: null, hasMore: false }),
			'GET /v1/admin/returns/ret_1': () => answer(200, received),
			'POST /v1/admin/returns/ret_1/replace': (/** @type {any} */ call) => {
				posts.push(call.body);
				return answer(200, claim({ kind: 'warranty', status: 'replaced', actions: ['restock'] }));
			},
		});
		expect(textOf(rowOf(panel, 'ret_2'))).toContain('Exchange · Replaced');
		const pane = detailOf(panel);
		expect(textOf(pane)).toContain(`Requested · ${TEXTS['ordersAdmin.by.shopper']}`);
		expect(textOf(pane)).toContain(`Received · Sam · ${TEXTS['ordersAdmin.historyNote.restocked']}`);
		expect(textOf(pane)).toContain(
			`Received · ${TEXTS['ordersAdmin.by.server']} · ${TEXTS['ordersAdmin.historyNote.restocked']}`,
		);
		expect(textOf(pane)).not.toContain('· restocked');
		// replace and repair first (they end the claim), the rest in the More menu
		expect(shows(pane, 'Mark replaced')).toBe(true);
		expect(shows(pane, 'Mark repaired')).toBe(true);
		expect(menuEntries(pane)).toEqual([
			'Refund',
			'Put back in stock',
			'Close',
			'Claims of this order',
			'Claims of this customer',
			'Reject',
		]);
		await click(buttonIn(pane, 'Mark repaired'));
		expect(dialogOf(root).querySelector('h3')?.textContent).toBe('Mark repaired');
		await click(buttonIn(dialogOf(root), 'Cancel'));
		await click(buttonIn(pane, 'Mark replaced'));
		type(fieldIn(dialogOf(root), 'Note for the shopper (optional)'), 'A new unit is on its way');
		await submitDialog(root);
		expect(posts).toEqual([{ note: 'A new unit is on its way' }]);
		expect(statuses(pane)).toContain('Marked replaced.');
		expect(pane.querySelector('.detail-head .badge')?.textContent).toBe('Replaced');
		expect(textOf(rowOf(panel, 'ret_1'))).toContain('Warranty · Replaced');
	});

	it('refuses claim actions the ticket does not allow', async () => {
		const { root, panel } = await startReturns({
			'GET /v1/admin/returns/ret_1': () =>
				answer(200, claim({ status: 'approved', actions: ['refund', 'restock', 'close'], refundable: 0 })),
			'POST /v1/admin/returns/ret_1/restock': () => problem(409, 'conflict'),
			'POST /v1/admin/returns/ret_1/refund': () => problem(403, 'forbidden'),
		});
		const pane = detailOf(panel);
		expect(shows(pane, 'Refund')).toBe(false);
		await click(buttonIn(pane, 'Put back in stock'));
		await submitDialog(root);
		expect(dialogStatus(root)).toBe(TEXTS['problem.conflict']);
	});
});
