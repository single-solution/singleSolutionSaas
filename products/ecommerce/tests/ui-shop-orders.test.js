// @vitest-environment jsdom
/* global window */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountMyOrders } from '../ui/my-orders.js';
import {
	$,
	$$,
	buttonOf,
	click,
	configOf,
	fail,
	flush,
	makeShop,
	ok,
	place,
	resetPage,
	setValue,
	submit,
	text,
	textOf,
} from './ui-shop-helpers.js';

beforeEach(resetPage);
afterEach(() => {
	resetPage();
	vi.restoreAllMocks();
});

/** @param {string} id @param {string} number */
const row = (id, number) => ({
	id,
	number,
	status: 'placed',
	statusLabel: 'Placed',
	total: 210000,
	currency: 'PKR',
	placedAt: '2026-10-01T10:00:00.000Z',
	itemCount: 3,
	image: null,
});

/** @param {Record<string, unknown>} [over] */
const detail = (over = {}) => ({
	id: 'ord_1',
	number: 'SO-1',
	status: 'placed',
	statusLabel: 'Placed',
	role: 'awaiting_confirmation',
	placedAt: '2026-10-01T10:00:00.000Z',
	lines: [
		{
			id: 'oln_1',
			productId: 'prd_1',
			variantId: 'var_1',
			kind: 'physical',
			name: 'Phone',
			variantName: 'Blue',
			gradeLabel: 'Like new',
			image: null,
			unitPrice: 100000,
			quantity: 2,
			discount: 0,
			tax: 0,
			total: 200000,
			booking: null,
			downloads: [],
			downloadsLeft: null,
			licenceKeys: [],
		},
		{
			id: 'oln_2',
			productId: 'prd_2',
			variantId: 'var_2',
			kind: 'digital',
			name: 'E-book',
			variantName: '',
			gradeLabel: '',
			image: null,
			unitPrice: 1000,
			quantity: 1,
			discount: 0,
			tax: 0,
			total: 1000,
			booking: { start: '2026-10-09T05:00:00.000Z', end: '2026-10-09T05:30:00.000Z' },
			downloads: [{ file: 'book.pdf', name: 'The book', type: 'application/pdf', size: 10 }],
			downloadsLeft: 2,
			licenceKeys: ['KEY-1'],
		},
	],
	totals: { subtotal: 201000, discount: 1000, delivery: 20000, tax: 500, total: 220000, currency: 'PKR', taxIncluded: false },
	promotions: { couponCode: '', pointsRedeemed: 0, pointsValue: 0 },
	address: {
		name: 'Ana',
		phone: '+92',
		line1: '1 Road',
		line2: '',
		city: 'Lahore',
		area: '',
		postalCode: '',
		country: '',
		notes: '',
	},
	delivery: { method: 'delivery', zone: 'z1', fee: 20000, locationId: null, locationName: '' },
	payment: { method: 'cod', state: 'unpaid', advance: 0, paid: 0, refunded: 5000, payUrl: null, payBy: null },
	history: [{ at: '2026-10-01T10:00:00.000Z', status: 'placed', label: 'Placed' }],
	shipment: { courier: 'Fast', trackingNumber: 'T1', trackingUrl: 'https://track.example.com/T1' },
	note: 'Ring twice',
	canCancel: true,
	...over,
});

/**
 * @param {ReturnType<typeof makeShop>} fake
 * @param {Record<string, any>} [settings]
 */
const mountOrders = async (fake, settings = {}) => {
	const host = place('my_orders');
	await mountMyOrders({ host, config: configOf(['checkout'], settings), shop: fake.shop, win: window });
	await flush();
	return host;
};

describe('my orders', () => {
	it('asks a guest to sign in, then lists orders with Load more', async () => {
		const fake = makeShop({
			features: ['checkout'],
			routes: {
				'GET /v1/shop/orders': (call) =>
					call.query.cursor === 'c1'
						? ok({ items: [row('ord_2', 'SO-2')], nextCursor: null })
						: ok({ items: [row('ord_1', 'SO-1')], nextCursor: 'c1' }),
			},
		});
		const host = await mountOrders(fake);
		expect(textOf(host)).toContain(text('orders.signIn'));
		fake.identify('s1');
		await flush();
		expect(textOf(host)).toContain(text('orders.open', { number: 'SO-1' }));
		expect(textOf(host)).toContain('PKR 2,100.00');
		await click(buttonOf(host, text('orders.more')));
		expect(textOf(host)).toContain(text('orders.open', { number: 'SO-2' }));
		expect(buttonOf(host, text('orders.more')).hidden).toBe(true);
	});

	it('shows the empty list and errors', async () => {
		const empty = makeShop({ signIn: 's1', routes: { 'GET /v1/shop/orders': () => ok({ items: [], nextCursor: null }) } });
		expect(textOf(await mountOrders(empty))).toContain(text('orders.empty'));
		resetPage();
		const broken = makeShop({ signIn: 's1' });
		expect(textOf(await mountOrders(broken))).toContain(text('orders.error'));
	});

	it('shows an order: lines, downloads, payment, delivery, history, invoice and cancel', async () => {
		let cancel = fail(409, 'move_not_allowed');
		let download = fail(403, 'download_not_allowed');
		const fake = makeShop({
			signIn: 's1',
			features: ['checkout', 'invoices'],
			routes: {
				'GET /v1/shop/orders': () => ok({ items: [row('ord_1', 'SO-1')], nextCursor: null }),
				'GET /v1/shop/orders/ord_1': () => ok(detail()),
				'POST /v1/shop/orders/ord_1/cancel': () => cancel,
				'GET /v1/shop/orders/ord_1/downloads/oln_2/book.pdf': () => download,
			},
			documents: {
				'/v1/shop/orders/ord_1/invoice': { ok: true, status: 200, text: '<html>invoice</html>' },
			},
		});
		const host = await mountOrders(fake);
		await click(buttonOf(host, text('orders.open', { number: 'SO-1' })));
		const page = textOf(host);
		for (const part of [
			text('orders.number', { number: 'SO-1' }),
			'Phone (Blue)',
			text('cart.grade', { grade: 'Like new' }),
			text('orders.lineAmount', { quantity: 2, price: 'PKR 1,000.00', total: 'PKR 2,000.00' }),
			text('orders.downloadsLeft', { count: 2 }),
			'KEY-1',
			text('orders.paymentLine', { method: text('checkout.method.cod'), state: text('orders.payment.unpaid') }),
			text('orders.refunded', { amount: 'PKR 50.00' }),
			'Ana, 1 Road, Lahore',
			text('orders.shipment', { courier: 'Fast', tracking: 'T1' }),
			text('orders.note', { note: 'Ring twice' }),
			text('orders.discount'),
			text('cart.tax'),
		])
			expect(page).toContain(part);
		expect($(host, 'a[href="https://track.example.com/T1"]').textContent).toBe(text('orders.track'));
		await click(buttonOf(host, text('orders.download', { name: 'The book' })));
		expect(textOf(host)).toContain(text('orders.problem.download_not_allowed'));
		download = ok({ url: 'https://files.example.com/book.pdf', expiresAt: '' });
		await click(buttonOf(host, text('orders.download', { name: 'The book' })));
		expect(fake.went).toEqual(['https://files.example.com/book.pdf']);

		// invoice: opened in a new window, or a link when the browser blocks it
		const created = vi.fn(() => 'blob:invoice');
		Object.assign(window.URL, { createObjectURL: created });
		const open = vi
			.spyOn(window, 'open')
			.mockReturnValueOnce(/** @type {any} */ ({}))
			.mockReturnValueOnce(null);
		await click(buttonOf(host, text('orders.invoice')));
		expect(open).toHaveBeenCalledWith('blob:invoice', '_blank');
		await click(buttonOf(host, text('orders.invoice')));
		expect($(host, 'a[href="blob:invoice"]').textContent).toBe(text('orders.openInvoice'));

		// cancel: confirm, refused, then done
		await click(buttonOf(host, text('orders.cancel')));
		await click(buttonOf(host, text('orders.cancelNo')));
		expect(textOf(host)).not.toContain(text('orders.cancelConfirm'));
		await click(buttonOf(host, text('orders.cancel')));
		await click(buttonOf(host, text('orders.cancelYes')));
		expect(textOf(host)).toContain(text('orders.problem.move_not_allowed'));
		cancel = ok({ order: detail({ statusLabel: 'Cancelled', role: 'cancelled', canCancel: false }) });
		await click(buttonOf(host, text('orders.cancel')));
		await click(buttonOf(host, text('orders.cancelYes')));
		expect(textOf(host)).toContain(text('orders.placed', { date: '', status: 'Cancelled' }).split('·')[1]?.trim() ?? '');
		expect(() => buttonOf(host, text('orders.cancel'))).toThrow();
		await click(buttonOf(host, text('orders.back')));
		expect(textOf(host)).toContain(text('orders.title'));
	});

	it('shows a failed invoice, a pickup order and a waiting payment', async () => {
		let pay = fail(503, 'payments_unavailable');
		const waiting = detail({
			role: 'awaiting_payment',
			delivery: { method: 'pickup', zone: '', fee: 0, locationId: 'loc_1', locationName: 'Main shop' },
			address: null,
			shipment: null,
			note: '',
			canCancel: false,
			lines: [detail().lines[0]],
			totals: { subtotal: 200000, discount: 0, delivery: 0, tax: 500, total: 200000, currency: 'PKR', taxIncluded: true },
			payment: {
				method: 'online',
				state: 'pending',
				advance: 0,
				paid: 0,
				refunded: 0,
				payUrl: null,
				payBy: '2026-10-02T10:00:00.000Z',
			},
		});
		const fake = makeShop({
			signIn: 's1',
			features: ['checkout', 'invoices'],
			routes: {
				'GET /v1/shop/orders': () => ok({ items: [row('ord_1', 'SO-1')], nextCursor: null }),
				'GET /v1/shop/orders/ord_1': () => ok(waiting),
				'POST /v1/shop/orders/ord_1/pay': () => pay,
			},
			documents: {},
		});
		const host = await mountOrders(fake);
		await click(buttonOf(host, text('orders.open', { number: 'SO-1' })));
		expect(textOf(host)).toContain(text('orders.pickupAt', { name: 'Main shop' }));
		expect(textOf(host)).toContain(text('cart.taxIncluded'));
		await click(buttonOf(host, text('orders.invoice')));
		expect(textOf(host)).toContain(text('orders.invoiceFailed'));
		await click(buttonOf(host, text('success.retry')));
		expect(textOf(host)).toContain(text('checkout.problem.payments_unavailable'));
		pay = ok({
			order: { ...waiting, payment: { ...waiting.payment, payUrl: 'https://pay.example.com/1' } },
			next: { kind: 'done' },
		});
		await click(buttonOf(host, text('success.retry')));
		expect($(host, 'a[href="https://pay.example.com/1"]').textContent).toBe(text('success.pay'));
		pay = ok({ order: waiting, next: { kind: 'pay', url: 'https://pay.example.com/2' } });
		fake.routes['GET /v1/shop/orders/ord_1'] = () => ok(waiting);
		await click(buttonOf(host, text('orders.back')));
		await click(buttonOf(host, text('orders.open', { number: 'SO-1' })));
		await click(buttonOf(host, text('success.retry')));
		expect(fake.went).toEqual(['https://pay.example.com/2']);
	});

	it('hides the invoice without the runtime document call and shows missing orders', async () => {
		const fake = makeShop({
			signIn: 's1',
			features: ['checkout', 'invoices'],
			routes: {
				'GET /v1/shop/orders': () => ok({ items: [row('ord_1', 'SO-1'), row('ord_9', 'SO-9')], nextCursor: null }),
				'GET /v1/shop/orders/ord_1': () =>
					ok(
						detail({
							delivery: { method: 'delivery', zone: '', fee: 0, locationId: null, locationName: '' },
							address: null,
							shipment: { courier: 'Fast', trackingNumber: 'T1', trackingUrl: '' },
							totals: { ...detail().totals, discount: 0, tax: 0 },
						}),
					),
				'GET /v1/shop/orders/ord_9': () => fail(500, 'internal_error'),
			},
		});
		const host = await mountOrders(fake);
		await click(buttonOf(host, text('orders.open', { number: 'SO-1' })));
		expect(() => buttonOf(host, text('orders.invoice'))).toThrow();
		expect($(host, 'a[href=""]')).toBeNull();
		await click(buttonOf(host, text('orders.back')));
		await click(buttonOf(host, text('orders.open', { number: 'SO-9' })));
		expect(textOf(host)).toContain(text('orders.error'));
		await click(buttonOf(host, text('orders.back')));
		fake.routes['GET /v1/shop/orders/ord_9'] = () => fail(404, 'not_found');
		await click(buttonOf(host, text('orders.open', { number: 'SO-9' })));
		expect(textOf(host)).toContain(text('orders.notFound'));
		fake.identify(null);
		await flush();
		expect(textOf(host)).toContain(text('orders.signIn'));
	});
});

describe('returns', () => {
	const RETURNABLE = {
		orderId: 'ord_1',
		number: 'SO-1',
		deliveredAt: '2026-10-01T10:00:00.000Z',
		lines: [
			{
				lineId: 'oln_1',
				productId: 'prd_1',
				name: 'Phone',
				variantName: 'Blue',
				image: null,
				quantity: 2,
				claimable: 2,
				return: { days: 7, until: '2026-10-08T10:00:00.000Z', open: true },
				warranty: { days: 365, until: '2027-10-01T10:00:00.000Z', open: true },
			},
			{
				lineId: 'oln_3',
				productId: 'prd_3',
				name: 'Case',
				variantName: '',
				image: null,
				quantity: 1,
				claimable: 1,
				return: { days: 0, until: null, open: false },
				warranty: { days: 30, until: '2026-10-31T10:00:00.000Z', open: true },
			},
			{
				lineId: 'oln_4',
				productId: 'prd_4',
				name: 'Gone',
				variantName: '',
				image: null,
				quantity: 1,
				claimable: 0,
				return: { days: 7, until: null, open: true },
				warranty: { days: 0, until: null, open: false },
			},
		],
	};
	const claim = (/** @type {string} */ id, over = {}) => ({
		id,
		reference: `R-${id}`,
		orderId: 'ord_1',
		orderNumber: 'SO-1',
		kind: 'return',
		lines: [],
		reason: 'Broken',
		status: 'requested',
		refundAmount: 0,
		history: [{ at: '2026-10-02T10:00:00.000Z', status: 'requested', note: '' }],
		createdAt: '2026-10-02T10:00:00.000Z',
		...over,
	});

	/** @param {Record<string, any>} routes */
	const delivered = (routes) =>
		makeShop({
			signIn: 's1',
			features: ['checkout', 'returns'],
			routes: {
				'GET /v1/shop/orders': () => ok({ items: [row('ord_1', 'SO-1')], nextCursor: null }),
				'GET /v1/shop/orders/ord_1': () => ok(detail({ role: 'delivered', canCancel: false })),
				...routes,
			},
		});

	it('lists my claims with Load more and their errors', async () => {
		const fake = delivered({
			'GET /v1/shop/returns': (/** @type {any} */ call) =>
				call.query.cursor === 'r1'
					? ok({
							items: [
								claim('2', {
									kind: 'warranty',
									status: 'refunded',
									refundAmount: 5000,
									history: [{ at: '2026-10-03T10:00:00.000Z', status: 'refunded', note: 'Refunded in full' }],
								}),
							],
							nextCursor: null,
						})
					: ok({ items: [claim('1')], nextCursor: 'r1' }),
		});
		const host = await mountOrders(fake);
		expect(textOf(host)).toContain(text('returns.claim', { reference: 'R-1', number: 'SO-1' }));
		await click(buttonOf(host, text('returns.more')));
		expect(textOf(host)).toContain(text('returns.refunded', { amount: 'PKR 50.00' }));
		expect(textOf(host)).toContain('Refunded in full');
		expect(textOf(host)).toContain(text('returns.status.refunded'));
		resetPage();
		const none = await mountOrders(delivered({ 'GET /v1/shop/returns': () => ok({ items: [], nextCursor: null }) }));
		expect(textOf(none)).toContain(text('returns.noClaims'));
		resetPage();
		const broken = await mountOrders(delivered({}));
		expect(textOf(broken)).toContain(text('returns.listError'));
	});

	it('claims items with photos uploaded to storage', async () => {
		/** @type {any} */
		let claimAnswer = fail(422, 'not_returnable');
		let photoAnswer = fail(503, 'storage_not_connected');
		const fake = delivered({
			'GET /v1/shop/returns': () => ok({ items: [], nextCursor: null }),
			'GET /v1/shop/orders/ord_1/returnable': () => ok(RETURNABLE),
			'POST /v1/shop/returns/photos': () => photoAnswer,
			'POST /v1/shop/returns': () => claimAnswer,
		});
		const put = vi.spyOn(window, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
		const host = await mountOrders(fake, { returns: { maxPhotos: 1, photoMaxMb: 1 } });
		await click(buttonOf(host, text('orders.open', { number: 'SO-1' })));
		await click(buttonOf(host, text('orders.claim')));
		const form = () => $(host, 'form.box');
		expect($$(host, 'form.box select')).toHaveLength(2);
		await submit(form());
		expect(textOf(host)).toContain(text('returns.chooseItems'));
		await setValue($(host, '#ss-claim-oln_1'), '2');
		await submit(form());
		expect(textOf(host)).toContain(text('returns.reasonNeeded'));
		$(host, '#ss-claim-reason').value = ' Screen broken ';
		const photos = $(host, '#ss-claim-photos');
		const png = new window.File(['x'], 'a.png', { type: 'image/png' });
		const gif = new window.File(['x'], 'a.gif', { type: 'image/gif' });
		Object.defineProperty(photos, 'files', { configurable: true, value: [png, png] });
		await submit(form());
		expect(textOf(host)).toContain(text('returns.tooManyPhotos', { max: 1 }));
		Object.defineProperty(photos, 'files', { configurable: true, value: [gif] });
		await submit(form());
		expect(textOf(host)).toContain(text('returns.photoInvalid', { mb: 1 }));
		Object.defineProperty(photos, 'files', { configurable: true, value: [png] });
		await submit(form());
		expect(textOf(host)).toContain(text('returns.problem.storage_not_connected'));
		photoAnswer = ok(
			{
				upload: { method: 'PUT', url: 'https://storage.example.com/up', headers: { 'content-type': 'image/png' } },
				key: 'returns/u/p1.png',
				expiresAt: '',
			},
			201,
		);
		put.mockResolvedValueOnce(new Response(null, { status: 403 }));
		await submit(form());
		expect(textOf(host)).toContain(text('returns.uploadFailed'));
		put.mockRejectedValueOnce(new Error('offline'));
		await submit(form());
		expect(textOf(host)).toContain(text('returns.uploadFailed'));
		await submit(form());
		expect(put).toHaveBeenLastCalledWith('https://storage.example.com/up', {
			method: 'PUT',
			headers: { 'content-type': 'image/png' },
			body: png,
		});
		expect(fake.all('POST /v1/shop/returns').at(-1)?.body).toEqual({
			orderId: 'ord_1',
			kind: 'return',
			lines: [{ lineId: 'oln_1', quantity: 2 }],
			reason: 'Screen broken',
			photos: ['returns/u/p1.png'],
		});
		expect(textOf(host)).toContain(text('returns.problem.not_returnable'));
		// warranty lists the case too
		await setValue($(host, '#ss-claim-kind'), 'warranty');
		expect($(host, '#ss-claim-oln_3')).not.toBeNull();
		await setValue($(host, '#ss-claim-oln_3'), '1');
		Object.defineProperty(photos, 'files', { configurable: true, value: [] });
		claimAnswer = ok(claim('9'), 201);
		await submit(form());
		expect(fake.all('POST /v1/shop/returns').at(-1)?.body.kind).toBe('warranty');
		expect(textOf(host)).toContain(text('returns.sent', { reference: 'R-9' }));
	});

	it('says when nothing can be claimed or the lines cannot be read', async () => {
		const fake = delivered({
			'GET /v1/shop/returns': () => ok({ items: [], nextCursor: null }),
			'GET /v1/shop/orders/ord_1/returnable': () => ok({ ...RETURNABLE, lines: [RETURNABLE.lines[2]] }),
		});
		const host = await mountOrders(fake);
		await click(buttonOf(host, text('orders.open', { number: 'SO-1' })));
		expect($(host, '#ss-claim-photos')).toBeNull();
		await click(buttonOf(host, text('orders.claim')));
		expect(textOf(host)).toContain(text('returns.none'));
		fake.routes['GET /v1/shop/orders/ord_1/returnable'] = () => fail(500, 'internal_error');
		await click(buttonOf(host, text('orders.claim')));
		expect(textOf(host)).toContain(text('returns.error'));
		fake.routes['GET /v1/shop/orders/ord_1/returnable'] = () => ok(RETURNABLE);
		fake.routes['POST /v1/shop/returns'] = () => fail(500, 'internal_error');
		await click(buttonOf(host, text('orders.claim')));
		await setValue($(host, '#ss-claim-oln_1'), '1');
		$(host, '#ss-claim-reason').value = 'Bad';
		await submit($(host, 'form.box'));
		expect(textOf(host)).toContain(text('returns.failed'));
	});
});
